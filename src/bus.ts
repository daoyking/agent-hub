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
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { launch, explainStderr } from './transport.ts';
import type { EngineSpec } from './registry.ts';
import { normalize, toApprovalRequest } from './normalize.ts';
import type { NormalizedEvent, ApprovalRequest } from './normalize.ts';
import { decide } from './policy.ts';
import type { ApprovalMode } from './policy.ts';
import { createTranscript } from './sessions.ts';
import { checkBudget } from './budget.ts';
import { indexTranscriptFile } from './store.ts';

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

/**
 * P2：ACP terminal/* 能力——agent 的 shell 命令由客户端（我们）代跑。
 *
 * 实现要点：
 *  - 每个终端一个 Map 条目：子进程 + 滚动输出缓冲 + 退出状态 + waiters；
 *  - outputByteLimit：超限从头部截断（注意不能劈开 UTF-16 代理对）；
 *  - guard 审批模式下 terminal/create 视同高危 execute，走同一审批管线；
 *  - stdout/stderr 每个 chunk 发 terminal.output 事件，UI 终端卡片实时滚动；
 *  - 回合结束（finally）兜底 SIGKILL 全部存活终端，杜绝泄漏。
 */
type Term = {
  proc: ChildProcess;
  out: string;
  truncated: boolean;
  limit: number;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  waiters: Array<() => void>;
};

const TERM_DEFAULT_LIMIT = 1024 * 1024; // 1MB 滚动缓冲

class TerminalRegistry {
  private terms = new Map<string, Term>();

  create(
    params: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; outputByteLimit?: number | null },
    onChunk: (id: string, chunk: string) => void,
    onExit: (id: string, exitCode: number | null, signal: string | null) => void,
  ): string {
    const id = randomUUID();
    // 容错：有的 agent 把整串命令塞进 command（args 为空），直接 spawn 会 ENOENT。
    // 此时回退 shell 解释；命令执行本身已被审批管线把关，shell 不扩大风险面。
    const args = params.args ?? [];
    const useShell = args.length === 0 && /\s/.test(params.command.trim());
    const proc = useShell
      ? spawn(params.command, { shell: true, cwd: params.cwd, env: { ...process.env, ...(params.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(params.command, args, { cwd: params.cwd, env: { ...process.env, ...(params.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const t: Term = {
      proc,
      out: '',
      truncated: false,
      limit: params.outputByteLimit && params.outputByteLimit > 0 ? params.outputByteLimit : TERM_DEFAULT_LIMIT,
      exited: false,
      exitCode: null,
      signal: null,
      waiters: [],
    };
    const append = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      t.out += chunk;
      if (t.out.length > t.limit) {
        t.out = t.out.slice(t.out.length - t.limit);
        // 截断点不能落在代理对中间：丢掉开头孤立的后半代理
        if (t.out.length > 0 && (t.out.charCodeAt(0) & 0xfc00) === 0xdc00) t.out = t.out.slice(1);
        t.truncated = true;
      }
      onChunk(id, chunk);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('error', (err) => append(Buffer.from(`[spawn error] ${err.message}\n`)));
    // exit 与 close 双挂：spawn 失败（ENOENT）时只有 close 没有 exit，缺一个就会挂死 wait_for_exit
    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      t.exited = true;
      t.exitCode = code;
      t.signal = signal;
      onExit(id, code, signal);
      for (const w of t.waiters.splice(0)) w();
    };
    proc.on('exit', finish);
    proc.on('close', finish);
    this.terms.set(id, t);
    return id;
  }

  get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new Error(`未知终端: ${id}（可能已被 release）`);
    return t;
  }

  async waitExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const t = this.get(id);
    if (!t.exited) await new Promise<void>((res) => t.waiters.push(res));
    return { exitCode: t.exitCode, signal: t.signal };
  }

  kill(id: string): void {
    const t = this.get(id);
    if (!t.exited) t.proc.kill('SIGTERM');
  }

  release(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.exited) t.proc.kill('SIGKILL');
    this.terms.delete(id);
  }

  /** 回合收尾：全杀，防泄漏 */
  disposeAll(): void {
    for (const t of this.terms.values()) if (!t.exited) t.proc.kill('SIGKILL');
    this.terms.clear();
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
  const terms = new TerminalRegistry();

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
    })
    // ---- ACP terminal/*（P2）：agent 的 shell 命令由总线代跑并全程可视 ----
    .onRequest('terminal/create', async (ctx) => {
      const p = ctx.params;
      if (p.cwd) assertInside(opts.cwd, p.cwd);
      // 终端创建 = 任意命令执行，视同高危 execute 走审批管线（guard 弹审批，auto 放行，deny 拒绝）
      const req: ApprovalRequest = {
        sessionId: p.sessionId,
        toolCallId: `terminal:${randomUUID()}`,
        tool: 'terminal',
        title: `$ ${p.command} ${(p.args ?? []).join(' ')}`.trim(),
        kind: 'execute',
        risk: 'high',
        options: [
          { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
          { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
        ],
        rawInput: { command: p.command, args: p.args, cwd: p.cwd },
      };
      const decision = await decide(req, opts.approval, opts.onAsk);
      approvals.push({ request: req, action: decision.action, reason: decision.reason });
      opts.onEvent?.({
        k: 'notice',
        level: decision.action === 'cancel' ? 'warn' : 'info',
        text: `终端命令${decision.action === 'cancel' ? '被拒绝' : '已批准'} · ${req.title} (${decision.reason})`,
      });
      if (decision.action === 'cancel') throw new Error('用户拒绝了终端命令');
      const id = terms.create(
        {
          command: p.command,
          args: p.args,
          cwd: p.cwd ?? opts.cwd,
          env: Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])),
          outputByteLimit: p.outputByteLimit,
        },
        (tid, chunk) => opts.onEvent?.({ k: 'terminal.output', id: tid, chunk }),
        (tid, exitCode, signal) => opts.onEvent?.({ k: 'terminal.exit', id: tid, exitCode, signal }),
      );
      opts.onEvent?.({ k: 'terminal.create', id, command: p.command, args: p.args ?? [], cwd: p.cwd ?? opts.cwd });
      return { terminalId: id };
    })
    .onRequest('terminal/output', async (ctx) => {
      const t = terms.get(ctx.params.terminalId);
      return {
        output: t.out,
        truncated: t.truncated,
        exitStatus: t.exited ? { exitCode: t.exitCode, signal: t.signal } : null,
      };
    })
    .onRequest('terminal/wait_for_exit', async (ctx) => terms.waitExit(ctx.params.terminalId))
    .onRequest('terminal/kill', async (ctx) => {
      terms.kill(ctx.params.terminalId);
      return {};
    })
    .onRequest('terminal/release', async (ctx) => {
      terms.release(ctx.params.terminalId);
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
          // P2：完整实现 terminal/*（create/output/wait_for_exit/kill/release，见 TerminalRegistry）
          terminal: true,
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

      // 回合落库索引（P1 SQLite 读模型）；失败绝不影响回合本身
      if (transcript) await indexTranscriptFile(transcript.file).catch(() => {});

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
    terms.disposeAll();
    agent.dispose();
  }
}
