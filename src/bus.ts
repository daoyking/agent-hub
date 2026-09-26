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
import { realpathSync } from 'node:fs';
import { launch, explainStderr } from './transport.ts';
import type { EngineSpec } from './registry.ts';
import { normalize, toApprovalRequest } from './normalize.ts';
import type { NormalizedEvent, ApprovalRequest } from './normalize.ts';
import { decide } from './policy.ts';
import type { ApprovalMode } from './policy.ts';
import { createTranscript } from './sessions.ts';
import { checkBudget } from './budget.ts';
import { indexTranscriptFile } from './store.ts';
import { notify } from './notify.ts';

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
/**
 * 会话根目录约束：agent 只能读写 `--cwd` 内的文件。
 *
 * **必须用 realpath 解析符号链接**。只做 `path.relative` 的字符串判断能被
 * 符号链接绕过：cwd 里放一个 `escape -> /etc` 的软链，agent 请求
 * `<cwd>/escape/passwd`，字符串上"在根内"就放行了，实际读的是 /etc/passwd。
 * 实测确认过这条绕过路径。
 *
 * 两段校验：
 *   1. 字符串层：挡 `..` 和绝对路径（快，且能给出可读的拒绝理由）
 *   2. 真实路径层：resolve 软链后重新判断（root 本身也要 resolve，
 *      否则 cwd 自己就是软链时两边算法不一致）
 * 任一层不通过就抛错——**fail-closed**。
 */
export function assertInside(root: string, target: string): void {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(target);

  const rel = path.relative(rootAbs, resolved);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(`拒绝越界访问: ${resolved} 不在会话根 ${root} 内`);
  }

  // 目标可能还不存在（写入新文件），realpath 失败时退回 dirname 再试
  const realOf = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      try {
        return path.join(realpathSync.native(path.dirname(p)), path.basename(p));
      } catch {
        return p;
      }
    }
  };
  const realRoot = realOf(rootAbs);
  const realTarget = realOf(resolved);
  const relReal = path.relative(realRoot, realTarget);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(
      `拒绝越界访问: ${resolved} 解析到 ${realTarget}，在会话根 ${realRoot} 外` +
        `（疑似符号链接逃逸）`,
    );
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

/**
 * 引擎失败分类与降级决策（**纯函数，无 I/O**，单测见 scripts/failover-test.mjs）。
 *
 * 背景：agnesd（goose fork）把多种上游失败统一映射成 ACP -32000
 * "Authentication required"，客户端只看得到这一句，真实原因藏在
 * ~/.agnes/state/logs/server/**-agnesd.log 里。实测（2026-09-25）两类：
 *  - 余额类（换模型可解）：403 `insufficient_user_quota` / `Failed to pre-consume
 *    quota`。agnes-2.0-flash 不做预扣校验，所以降级后能跑。
 *  - 速率类（只能等）：`Rate limit exceeded ... for free users`——与余额无关，
 *    是免费额度的**时间窗**限制，充值也解不掉（那是 Token Plan 订阅档位）。
 *    实测同一分钟内 3 次调用有 1 次成功。
 */

/** 降级模型链：余额类失败时按顺序降级（都不可用则原样抛错） */
export const GENERIC_MODEL_FALLBACKS: Record<string, string[]> = {
  agnes: ['agnes-2.0-flash', 'agnes-2.5-flash'],
};

/**
 * 速率限制退避（秒）。
 *
 * 实测（2026-09-25）apihub 免费额度的速率窗口**远长于预期**：8s → 20s → 45s
 * 三次退避累计 ~73s 仍全部 Rate limit，而同一分钟里偶发能成功一次。说明窗口
 * 不是秒级、也不是分钟级的小闸门，很可能按**请求量/小时**计。
 * 因此默认只做一次短退避（够覆盖瞬时抖动），不把 CLI 挂几分钟；
 * 想长等就显式调 AGENTBD_RATE_RETRIES。
 */
export const RATE_LIMIT_BACKOFF_SEC = [8, 20, 45, 60] as const;

export function rateLimitMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.AGENTBD_RATE_RETRIES ?? '1') + 1;
}

export function isRateLimited(msg: string): boolean {
  return /rate limit/i.test(msg);
}

export function isAuthOrQuotaFailure(msg: string): boolean {
  return (
    isRateLimited(msg) ||
    /Authentication required|insufficient_user_quota|pre-consume quota|Invalid token|\b40[13]\b/i.test(msg)
  );
}

/**
 * 识别「软失败」：引擎**没有抛异常**，但把上游错误写进正文后正常收尾。
 *
 * 实测 agnesd（goose fork）的两种措辞：
 *   "Ran into this error: Rate limit exceeded: …"
 *   "Ran into this error: Authentication error: …"
 * 这种回合 stopReason 仍是 end_turn，CLI/UI 看起来像成功，**必须特判**，
 * 否则失败会被静默当成正常结果返回。
 */
export function softFailureOf(text: string): string | undefined {
  if (!/Ran into this error/i.test(text)) return undefined;
  return text;
}

/** 取出下一档退避秒数（超出档位则用最后一档封顶） */
export function backoffSec(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), RATE_LIMIT_BACKOFF_SEC.length) - 1;
  return RATE_LIMIT_BACKOFF_SEC[i] ?? 60;
}

/** 选下一个降级模型（已试过的不再选；没有则 null = 该抛原始错误了） */
export function nextFallback(engineId: string, tried: ReadonlySet<string>): string | null {
  return (GENERIC_MODEL_FALLBACKS[engineId] ?? []).find((m) => !tried.has(m)) ?? null;
}

/** 重试耗尽时给用户看的错误：要说明「不是余额问题」并给出可操作出路 */
export function rateLimitExhaustedMsg(engineId: string, attempts: number, raw: string): string {
  return (
    `${engineId} 撞上 apihub 免费额度的速率限制（已重试 ${attempts} 次）。\n` +
    `这不是余额问题——充值也解不掉（需 Token Plan 订阅）。该限制按请求量计，` +
    `偶发可成功，密集调用必被限。三个选择：\n` +
    `  1) 隔几分钟再跑同一条命令（能否成功取决于窗口）\n` +
    `  2) 换引擎: agentbd ask <claude|codex|gemini|...> '...'\n` +
    `  3) 想多等几轮: AGENTBD_RATE_RETRIES=5 agentbd ask ...\n` +
    `原始错误: ${raw.split('\n')[0]}`
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const fallbacks = GENERIC_MODEL_FALLBACKS[opts.spec.id] ?? [];
  const triedModels = new Set<string>();
  // 记住原始模型，降级成功也不污染后续回合
  const originalModel = process.env.AGNES_MODEL ?? process.env.AGNES_DEFAULT_MODEL;
  let rateAttempts = 0;

  try {
    for (;;) {
      let result: TurnResult;
      let failure: string | undefined;
      try {
        result = await runTurnOnce(opts);
        // ⚠️ agnesd/goose 把上游失败写进**正文**再正常 end_turn，不是抛异常：
        //    "Ran into this error: Rate limit exceeded: ..." + stop=end_turn。
        //    不特判的话，失败回合会被当成成功结果返回给用户（CLI 还显示 stop=end_turn）。
        failure = softFailureOf(result.text);
        if (!failure) return result;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }

      if (!isAuthOrQuotaFailure(failure)) throw new Error(failure);

      // ① 速率限制：模型换也没用，原地退避重试
      if (isRateLimited(failure)) {
        rateAttempts++;
        if (rateAttempts >= rateLimitMaxAttempts()) {
          throw new Error(rateLimitExhaustedMsg(opts.spec.id, rateAttempts, failure));
        }
        const wait = backoffSec(rateAttempts);
        opts.onEvent?.({
          k: 'notice',
          level: 'warn',
          text: `${opts.spec.id} 触发免费额度速率限制，${wait}s 后重试（第 ${rateAttempts} 次）`,
        });
        await sleep(wait * 1000);
        continue;
      }

      // ② 余额/密钥类：换更便宜的模型
      const next = nextFallback(opts.spec.id, triedModels);
      if (!next) throw new Error(failure);
      triedModels.add(next);
      process.env.AGNES_MODEL = next;
      process.env.AGNES_DEFAULT_MODEL = next;
      opts.onEvent?.({
        k: 'notice',
        level: 'warn',
        text: `${opts.spec.id} 余额/密钥受限，自动降级到 ${next} 重试（原错误: ${failure.split('\n')[0]}）`,
      });
    }
  } finally {
    if (originalModel === undefined) {
      delete process.env.AGNES_MODEL;
      delete process.env.AGNES_DEFAULT_MODEL;
    } else {
      process.env.AGNES_MODEL = originalModel;
      process.env.AGNES_DEFAULT_MODEL = originalModel;
    }
  }
}

async function runTurnOnce(opts: RunTurnOptions): Promise<TurnResult> {
  assertNotNested();
  // 预算护栏：spawn 引擎之前拦截（超限直接拒跑；近限发 notice 告警，CLI/Web 同源可见）
  if (opts.budget !== 'off') {
    const st = await checkBudget();
    if (st.exceeded.length > 0) {
      // P2-2：拦截事件也发通知（后台 serve 触发的超限，前台无人看见）
      void notify('agentbd 预算超限', `已拦截本次调用：${st.exceeded.join('；')}`, {
        tag: 'budget:exceeded',
        minIntervalSec: 300,
      });
      throw new Error(
        `预算超限，已拦截本次调用：${st.exceeded.join('；')}。` +
          `查看: agentbd budget；调整: agentbd budget set dailyTokens=…；临时跳过: --no-budget`,
      );
    }
    for (const w of st.warnings) {
      opts.onEvent?.({ k: 'notice', level: 'warn', text: `预算告警: ${w}` });
      void notify('agentbd 预算告警', w, { tag: `budget:warn:${w.slice(0, 20)}`, minIntervalSec: 600 });
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

      // ② 认证：必须在 session/new **之前**完成。initialize 声明了 authMethods
      // 而客户端没先 authenticate 时，agent 会把会话标为未认证，后续 prompt 直接
      // 以 ACP `auth_required`（-32000 "Authentication required"）失败——这与
      // provider 的 key 是否有效无关（agnesd 的 agnes-provider 走 Keychain/账号态，
      // 凭证正常时无需交互）。需要交互输入的方式（浏览器 OAuth）失败则静默继续，
      // 让 prompt 报出真实原因。
      if (profile.authMethods.length > 0) {
        try {
          const r = await ctx.request('authenticate', { methodId: profile.authMethods[0]!.id });
          if (process.env.AGENTBD_DEBUG_AUTH) {
            console.error(`[auth] ${profile.authMethods[0]!.id} ok:`, JSON.stringify(r));
          }
        } catch (err) {
          if (process.env.AGENTBD_DEBUG_AUTH) {
            console.error(`[auth] ${profile.authMethods[0]!.id} 失败:`, err);
          }
        }
      }

      // ③ 建会话：new（默认） / load（恢复，重放历史） / resume（恢复，不重放）
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
