/**
 * 审批策略（Permission Broker 的 P0 版本）。
 *
 * 设计方案 §5.4 的落点：审批语义必须统一，否则聚合器 = 权限放大器。
 * 三种模式：
 *   auto    —— 全部放行但逐条记录（默认在非交互场景使用，等价于"我现在信任这个引擎"）
 *   guard   —— 低风险（read/search/think/fetch）放行，高风险（edit/execute/delete/...）交给 onAsk
 *   deny    —— 全部拒绝（用于只读巡检 / 成本护栏演练）
 */

import type { ApprovalRequest } from './normalize.ts';

export type ApprovalMode = 'auto' | 'guard' | 'deny';
export type ApprovalDecision =
  | { action: 'select'; optionId: string; reason: string }
  | { action: 'cancel'; reason: string };

export type ApprovalSink = (req: ApprovalRequest, decision: ApprovalDecision) => void;

function pickOption(req: ApprovalRequest, kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const hit = req.options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  return undefined;
}

export async function decide(
  req: ApprovalRequest,
  mode: ApprovalMode,
  onAsk?: (req: ApprovalRequest) => Promise<boolean>,
): Promise<ApprovalDecision> {
  if (mode === 'deny') {
    return { action: 'cancel', reason: 'mode=deny' };
  }

  const allowOnce = pickOption(req, ['allow_once', 'allow_always']);
  const rejectOnce = pickOption(req, ['reject_once', 'reject_always']);

  if (mode === 'auto' || req.risk === 'low') {
    if (allowOnce) return { action: 'select', optionId: allowOnce, reason: `auto/${req.risk}` };
    if (rejectOnce) return { action: 'select', optionId: rejectOnce, reason: 'no-allow-option' };
    return { action: 'cancel', reason: 'no-usable-option' };
  }

  // guard + 高风险 → 交给上层（交互式 y/N）
  if (!onAsk) {
    return rejectOnce
      ? { action: 'select', optionId: rejectOnce, reason: 'guard/no-ask-handler' }
      : { action: 'cancel', reason: 'guard/no-ask-handler' };
  }

  // onAsk 自身也可能出问题（stdin 非 TTY / 已关闭会抛；TTY 卡住会永不返回）。
  // 这两种都必须**拒绝**：异常若冒泡出 decide()，ACP 的 request_permission
  // handler 就以错误结束，引擎收到什么不确定（部分 agent 会当作协议错误后
  // 继续执行）——那等于「审批挂了 = 放行」，是最危险的失败方向。
  // 加超时同理：没有人应答时默认拒绝，而不是无限期挂起整个回合。
  const reply = await withTimeout(onAsk(req), askTimeoutMs(), 'timeout');
  const yes = reply.ok ? reply.value === true : false;
  const reason = !reply.ok
    ? `user-ask-${reply.reason}` // timeout / error
    : yes
      ? 'user-allow'
      : 'user-deny';
  const chosen = yes ? allowOnce : rejectOnce;
  if (chosen) return { action: 'select', optionId: chosen, reason };
  return { action: 'cancel', reason: `${reason}/no-option` };
}

/**
 * 审批等待上限：默认 10 分钟。Web 侧自己另有 2 分钟超时，这里兜 CLI 交互。
 * **调用时读** env（不是模块加载时）——单测要能改，运行时也允许调整。
 */
function askTimeoutMs(): number {
  const v = Number(process.env.AGENTBD_ASK_TIMEOUT_MS ?? 10 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
}

type AskResult = { ok: true; value: boolean } | { ok: false; reason: 'timeout' | 'error' };

function withTimeout(p: Promise<boolean>, ms: number, onFail: 'timeout'): Promise<AskResult> {
  return new Promise<AskResult>((resolve) => {
    // 故意不 unref：这是审批等待的兜底定时器，进程在等待期间就该保持存活。
    // unref 后事件循环无其他活干会直接静默退出，看起来像"卡住"。
    const t = setTimeout(() => resolve({ ok: false, reason: onFail }), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve({ ok: true, value: v });
      },
      (err) => {
        clearTimeout(t);
        // 记录原始异常再拒绝——排查时能看到真正的失败原因
        if (process.env.AGENTBD_DEBUG_AUTH) {
          console.error('[approval] onAsk 异常，已按拒绝处理:', err);
        }
        resolve({ ok: false, reason: 'error' });
      },
    );
  });
}
