/**
 * 归一化层（Normalization）—— 整个聚合器真正的核心。
 *
 * ACP 只统一"形状"，不统一"语义"：实测 Qoder 有 session/fork，Gemini 没有；
 * CodeBuddy 声明 mainAgentSupport:false。所以外壳只认下面这一个事件模型，
 * 引擎差异全部收敛在这里（见设计方案 §3.2）。
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { SessionUpdate, ToolKind, ToolCallStatus } from '@agentclientprotocol/sdk';

export type Risk = 'low' | 'high';

export type NormalizedEvent =
  | { k: 'user.delta'; text: string; messageId?: string | null }
  | { k: 'msg.delta'; text: string; messageId?: string | null }
  | { k: 'thought.delta'; text: string; messageId?: string | null }
  | {
      k: 'tool.call';
      id: string;
      name: string;
      title: string;
      kind: ToolKind;
      status: ToolCallStatus;
      risk: Risk;
      rawInput?: unknown;
      locations: string[];
    }
  | {
      k: 'tool.result';
      id: string;
      status: ToolCallStatus;
      ok: boolean;
      output?: string;
      rawOutput?: unknown;
    }
  | { k: 'plan'; steps: Array<{ title: string; status: 'pending' | 'doing' | 'done' }> }
  | { k: 'session.info'; title?: string | null; updatedAt?: string | null }
  | { k: 'mode'; modeId: string }
  | { k: 'commands'; commands: string[] }
  | { k: 'usage'; used: number; size: number; costUsd?: number }
  | { k: 'notice'; level: string; text: string }
  | { k: 'raw'; update: string; payload: unknown };

/** 工具类别 → 风险等级：审批策略引擎的唯一输入 */
export function riskOf(kind: ToolKind | undefined | null): Risk {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
    case 'fetch':
      return 'low';
    case 'edit':
    case 'delete':
    case 'move':
    case 'execute':
    case 'switch_mode':
    case 'other':
    default:
      return 'high';
  }
}

function textFromContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: string; text?: string };
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  if (c.type === 'resource_link') return `[resource] ${(content as { uri?: string }).uri ?? ''}`;
  if (c.type === 'image') return '[image]';
  if (c.type === 'audio') return '[audio]';
  if (c.type === 'resource') return '[embedded resource]';
  return '';
}

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 把一条 ACP `session/update` 映射成统一事件；无法映射的走 raw 兜底（不丢信息） */
export function normalize(update: SessionUpdate): NormalizedEvent | null {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return { k: 'user.delta', text: textFromContent(update.content), messageId: update.messageId };
    case 'agent_message_chunk':
      return { k: 'msg.delta', text: textFromContent(update.content), messageId: update.messageId };
    case 'agent_thought_chunk':
      return { k: 'thought.delta', text: textFromContent(update.content), messageId: update.messageId };

    case 'tool_call':
      return {
        k: 'tool.call',
        id: update.toolCallId,
        name: update.name ?? update.title,
        title: update.title,
        kind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        risk: riskOf(update.kind),
        rawInput: update.rawInput,
        locations: (update.locations ?? []).map((l) => l.path),
      };

    case 'tool_call_update': {
      const status = update.status ?? 'in_progress';
      const isResult = status === 'completed' || status === 'failed';
      return {
        k: isResult ? 'tool.result' : 'tool.call',
        id: update.toolCallId,
        name: update.name ?? update.title ?? update.toolCallId,
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? 'other',
        status,
        risk: riskOf(update.kind),
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        output: stringify(update.rawOutput),
        ok: status !== 'failed',
        locations: (update.locations ?? []).map((l) => l.path),
      } as NormalizedEvent;
    }

    case 'plan':
      return {
        k: 'plan',
        steps: (update.entries ?? []).map((e) => ({
          title: e.content,
          status: e.status === 'in_progress' ? 'doing' : e.status === 'completed' ? 'done' : 'pending',
        })),
      };

    case 'current_mode_update':
      return { k: 'mode', modeId: update.currentModeId };

    case 'session_info_update':
      return { k: 'session.info', title: update.title, updatedAt: update.updatedAt };

    case 'available_commands_update':
      return { k: 'commands', commands: (update.availableCommands ?? []).map((c) => c.name) };

    case 'usage_update':
      return { k: 'usage', used: update.used, size: update.size, costUsd: update.cost?.amount ?? undefined };

    case 'notice':
      return {
        k: 'notice',
        level: String(update.severity ?? 'info'),
        text: update.description ? `${update.title} — ${update.description}` : update.title,
      };

    default:
      return {
        k: 'raw',
        update: (update as { sessionUpdate: string }).sessionUpdate,
        payload: update,
      };
  }
}

/** 审批决策的输入形状，供策略引擎与 UI 共用 */
export type ApprovalRequest = {
  sessionId: string;
  toolCallId: string;
  tool: string;
  title: string;
  kind: ToolKind;
  risk: Risk;
  options: Array<{ optionId: string; name: string; kind: string }>;
  rawInput?: unknown;
};

export function toApprovalRequest(params: acp.RequestPermissionRequest): ApprovalRequest {
  const kind = params.toolCall.kind ?? 'other';
  return {
    sessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    tool: params.toolCall.name ?? params.toolCall.title ?? 'unknown',
    title: params.toolCall.title ?? '',
    kind,
    risk: riskOf(kind),
    options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    rawInput: params.toolCall.rawInput,
  };
}
