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
  const yes = await onAsk(req);
  const chosen = yes ? allowOnce : rejectOnce;
  if (chosen) return { action: 'select', optionId: chosen, reason: yes ? 'user-allow' : 'user-deny' };
  return { action: 'cancel', reason: yes ? 'user-allow/no-option' : 'user-deny/no-option' };
}
