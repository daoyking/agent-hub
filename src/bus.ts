/**
 * Agent Bus 的最小可用内核：一次「会话 + 一轮 prompt」的完整生命周期。
 *
 * 这一段是全方案的中枢（设计方案 §3.2）：
 *   spawn agent → initialize（能力协商）→ session/new → session/prompt
 *   → session/update* 归一化 → 审批 broker → usage → stop
 *
 * 上层（CLI / P1 的 Web UI / P2 的桌面壳）都只依赖这里的事件流，不感知引擎差异。
 */

import * as acp from '@agentclientprotocol/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, explainStderr } from './transport.ts';
import type { EngineSpec } from './registry.ts';
import { normalize, toApprovalRequest } from './normalize.ts';
import type { NormalizedEvent, ApprovalRequest } from './normalize.ts';
import { decide } from './policy.ts';
import type { ApprovalMode } from './policy.ts';
import { createTranscript } from './sessions.ts';
import { checkBudget } from './budget.ts';

export type EngineProfile = {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  capabilities: Record<string, unknown>;
  authMethods: Array<{ id: string; name?: string }>;
};

export type ApprovalLog = { request: ApprovalRequest; action: string; reason: string };

export type TurnResult = {
  engine: string;
  sessionId: string;
  stopReason: string;
  text: string;
  approvals: ApprovalLog[];
  usage?: { totalTokens: number; inputTokens: number; outputTokens: number };
  costUsd?: number;
  durationMs: number;
  transcript?: string;
  profile: EngineProfile;
};

export type RunTurnOptions = {
  spec: EngineSpec;
  cwd: string;
  prompt: string;
  approval: ApprovalMode;
  onAsk?: (req: ApprovalRequest) => Promise<boolean>;
  onEvent?: (ev: NormalizedEvent) => void;
  /** 引擎可用的 MCP server（P1 的 MCP Hub 从这里注入，一份配置喂所有引擎） */
  mcpServers?: acp.McpServer[];
  timeoutMs?: number;
  /** false = 不落盘（doctor 用） */
  persist?: boolean;
  /**
   * 续接已有会话（P1 的 session/load 恢复）。
   * cwd 必须是原会话的 cwd（引擎按 cwd 归档）；由 resolveResume() 解析后传入。
   */
  resume?: { sessionId: string; cwd: string };
  /** 'off' = 跳过预算护栏（CLI --no-budget）。默认检查：超限拦截、近限告警。 */
  budget?: 'off';
};

/** 禁止 agent 套 agent：Agnes/WorkBuddy 自身也会拉起别的 agent，会翻倍消耗 */
function assertNotNested(): void {
  const depth = Number(process.env.AGENTBD_DEPTH ?? '0');
  if (depth >= 1) {
    throw new Error(
      `检测到嵌套调用（AGENTBD_DEPTH=${depth}）。agentbd 在总线层禁止 agent 自调用，` +
        `否则会出现双层面板与双份 token。若要刻意允许，请显式清除该环境变量。`,
    );
  }
}

/** 只允许 client fs 能力在会话根目录内活动 */
function assertInside(root: string, target: string): void {
  const resolved = path.resolve(target);
  const rel = path.relative(path.resolve(root), resolved);
  if (rel === '') return;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝越界访问: ${resolved} 不在会话根 ${root} 内`);
  }
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  assertNotNested();
  // 预算护栏：spawn 引擎之前拦截（超限直接拒跑；近限发 notice 告警，CLI/Web 同源可见）
  if (opts.budget !== 'off') {
    const st = await checkBudget();
    if (st.exceeded.length > 0) {
      throw new Error(
        `预算超限，已拦截本次调用：${st.exceeded.join('；')}。` +
          `查看: agentbd budget；调整: agentbd budget set dailyTokens=…；临时跳过: --no-budget`,
      );
    }
    for (const w of st.warnings) {
      opts.onEvent?.({ k: 'notice', level: 'warn', text: `预算告警: ${w}` });
    }
  }
  const t0 = Date.now();
  const approvals: ApprovalLog[] = [];
  let text = '';
  let costUsd: number | undefined;

  process.env.AGENTBD_DEPTH = String(Number(process.env.AGENTBD_DEPTH ?? '0') + 1);
  const agent = await launch(opts.spec, { cwd: opts.cwd });

  const app = acp
    .client({ name: 'agentbd' })
    .onRequest('session/request_permission', async (ctx) => {
      const req = toApprovalRequest(ctx.params);
      const decision = await decide(req, opts.approval, opts.onAsk);
      approvals.push({ request: req, action: decision.action, reason: decision.reason });
      opts.onEvent?.({
        k: 'notice',
        level: decision.action === 'cancel' ? 'warn' : 'info',
        text: `审批${decision.action === 'cancel' ? '拒绝' : '通过'} · ${req.risk}风险 · ${req.tool} (${decision.reason})`,
      });
      return decision.action === 'cancel'
        ? { outcome: { outcome: 'cancelled' as const } }
        : { outcome: { outcome: 'selected' as const, optionId: decision.optionId } };
    })
    .onRequest('fs/read_text_file', async (ctx) => {
      assertInside(opts.cwd, ctx.params.path);
      const raw = await readFile(ctx.params.path, 'utf8');
      if (ctx.params.line || ctx.params.limit) {
        const lines = raw.split('\n');
        const start = Math.max(0, (ctx.params.line ?? 1) - 1);
        const end = ctx.params.limit ? start + ctx.params.limit : undefined;
        return { content: lines.slice(start, end).join('\n') };
      }
      return { content: raw };
    })
    .onRequest('fs/write_text_file', async (ctx) => {
      assertInside(opts.cwd, ctx.params.path);
      await writeFile(ctx.params.path, ctx.params.content, 'utf8');
      return {};
    });

  try {
    return await app.connectWith(agent.stream, async (ctx) => {
      // ① 能力协商：把每个引擎的真实能力记下来，UI 靠它决定按钮显隐
      const init = await ctx.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'agentbd', version: '0.1.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          // P0 不实现 ACP 终端；诚实声明 false，而不是宣告后报错
          terminal: false,
        },
      });
      const profile: EngineProfile = {
        protocolVersion: init.protocolVersion,
        agentInfo: (init as { agentInfo?: { name?: string; version?: string } }).agentInfo,
        capabilities: (init.agentCapabilities ?? {}) as Record<string, unknown>,
        authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
      };

      // ② 建会话：new（默认） / load（恢复，重放历史） / resume（恢复，不重放）
      //   attachSession 在 d.ts 标 private 但 JS 层公开；load/resume 的响应体不带
      //   sessionId（schema 只有 modes/configOptions），必须手动并进来供路由与 prompt 使用。
      type AttachCtx = { attachSession: (resp: unknown) => acp.ActiveSession };
      let session: acp.ActiveSession;
      if (opts.resume) {
        const caps = profile.capabilities as {
          loadSession?: boolean;
          sessionCapabilities?: Record<string, unknown>;
        };
        const resumeParams = {
          sessionId: opts.resume.sessionId,
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
        };
        if (caps.loadSession === true) {
          const resp = await ctx.request('session/load', resumeParams);
          session = (ctx as unknown as AttachCtx).attachSession({
            sessionId: opts.resume.sessionId,
            ...(resp as Record<string, unknown>),
          });
        } else if (caps.sessionCapabilities?.resume === true) {
          const resp = await ctx.request('session/resume', resumeParams);
          session = (ctx as unknown as AttachCtx).attachSession({
            sessionId: opts.resume.sessionId,
            ...(resp as Record<string, unknown>),
          });
        } else {
          throw new Error(
            `${opts.spec.id} 不支持会话恢复（initialize 未声明 loadSession / session.resume 能力）`,
          );
        }
      } else {
        session = await ctx.buildSession({ cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] }).start();
      }
      const transcript =
        opts.persist === false
          ? undefined
          : await createTranscript({
              engine: opts.spec.id,
              sessionId: session.sessionId,
              cwd: opts.cwd,
              prompt: opts.prompt,
              approval: opts.approval,
            });

      // ③ 超时/取消护栏
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          void ctx.notify('session/cancel', { sessionId: session.sessionId }).catch(() => {});
        }, opts.timeoutMs);
        timer.unref?.();
      }

      // ④ 发 prompt（注意：不能先 await prompt 再读更新，否则死锁）
      const promptPromise = session.prompt(opts.prompt);
      let stopReason = 'end_turn';
      let usage: acp.Usage | null | undefined;

      for (;;) {
        const msg = await session.nextUpdate();
        if (msg.kind === 'stop') {
          stopReason = msg.stopReason;
          usage = msg.response.usage;
          break;
        }
        const ev = normalize(msg.update);
        if (!ev) continue;
        if (ev.k === 'msg.delta') text += ev.text;
        if (ev.k === 'usage' && ev.costUsd !== undefined) costUsd = ev.costUsd;
        if (transcript) await transcript.append(ev, msg.update);
        opts.onEvent?.(ev);
      }
      await promptPromise.catch(() => undefined);
      if (timer) clearTimeout(timer);
      session.dispose();

      return {
        engine: opts.spec.id,
        sessionId: session.sessionId,
        stopReason,
        text,
        approvals,
        usage: usage
          ? { totalTokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          : undefined,
        costUsd,
        durationMs: Date.now() - t0,
        transcript: transcript?.file,
        profile,
      } satisfies TurnResult;
    });
  } catch (err) {
    const hint = explainStderr(agent);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${opts.spec.id} 运行失败: ${msg}\n--- agent stderr ---\n${hint}`);
  } finally {
    process.env.AGENTBD_DEPTH = '0';
    agent.dispose();
  }
}
