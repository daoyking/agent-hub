/**
 * 预算护栏（P1）：用量看板的闭环 —— 能看，还要能限。
 *
 * 限额存 `~/.agentbd/budget.json`（仓库之外），runTurn 在 spawn 引擎**之前**检查：
 * 超限直接抛错拦截（CLI/Web 同源生效），近限（默认 80%）发 notice 告警。
 *
 * 口径说明：tokens 全引擎有效（ACP usage 都有）；costUsd 只对回传成本的引擎
 * （目前是 claude）累计，agnes 不回传成本——usd 限额对它等于不设防，请配 tokens。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, aggregateStats } from './sessions.ts';
import { loadTeamConfig, fetchTeam, machineName } from './team.ts';

export const BUDGET_FILE = path.join(ROOT, 'budget.json');

export type BudgetLimits = {
  dailyUsd?: number;
  monthlyUsd?: number;
  dailyTokens?: number;
  monthlyTokens?: number;
  /** 告警阈值：用量/限额 ≥ 该比例时告警（默认 0.8） */
  warnAt?: number;
};

const LIMIT_KEYS = ['dailyUsd', 'monthlyUsd', 'dailyTokens', 'monthlyTokens', 'warnAt'] as const;

export async function loadBudget(): Promise<BudgetLimits> {
  try {
    const j = JSON.parse(await readFile(BUDGET_FILE, 'utf8')) as Record<string, unknown>;
    const out: BudgetLimits = {};
    for (const k of LIMIT_KEYS) {
      const v = j[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveBudget(limits: BudgetLimits): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const tmp = `${BUDGET_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(limits, null, 2) + '\n', 'utf8');
  await rename(tmp, BUDGET_FILE); // 原子写，与 repo 其他状态文件同规
}

export function hasAnyLimit(l: BudgetLimits): boolean {
  return Boolean(l.dailyUsd || l.monthlyUsd || l.dailyTokens || l.monthlyTokens);
}

export type BudgetStatus = {
  limits: BudgetLimits;
  today: { turns: number; tokens: number; costUsd: number };
  month: { turns: number; tokens: number; costUsd: number };
  /** 超限原因（人类可读）；非空 = 应拦截 */
  exceeded: string[];
  /** 近限告警（≥ warnAt 但未超限） */
  warnings: string[];
  /** P2-4：共享预算池汇总（配置了 team.hub + 共享限额时才有） */
  team?: { machines: number; todayTokens: number; monthTokens: number };
};

function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthStart(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const fmtTok = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;

export async function checkBudget(opts?: { skipTeam?: boolean }): Promise<BudgetStatus> {
  const limits = await loadBudget();
  const [todayS, monthS] = await Promise.all([
    aggregateStats(500, dayStart()),
    aggregateStats(500, monthStart()),
  ]);
  const today = { turns: todayS.total.turns, tokens: todayS.total.tokens, costUsd: todayS.total.costUsd };
  const month = { turns: monthS.total.turns, tokens: monthS.total.tokens, costUsd: monthS.total.costUsd };
  const exceeded: string[] = [];
  const warnings: string[] = [];
  const warnAt = limits.warnAt ?? 0.8;
  const chk = (label: string, used: number, limit: number | undefined, fmt: (n: number) => string): void => {
    if (!limit) return;
    if (used >= limit) exceeded.push(`${label} ${fmt(used)} ≥ 限额 ${fmt(limit)}`);
    else if (used >= limit * warnAt) warnings.push(`${label} ${fmt(used)} / ${fmt(limit)}（≥${Math.round(warnAt * 100)}%）`);
  };
  chk('今日 tokens', today.tokens, limits.dailyTokens, fmtTok);
  chk('今日成本', today.costUsd, limits.dailyUsd, fmtUsd);
  chk('本月 tokens', month.tokens, limits.monthlyTokens, fmtTok);
  chk('本月成本', month.costUsd, limits.monthlyUsd, fmtUsd);

  // P2-4 共享预算池：配了 team.hub + 共享限额时，把全队用量纳入判定。
  // hub 不可达 fail-open（本机限额仍然生效），只留一条 warning 提示。
  // skipTeam：hub 自己的 HTTP handler 必须跳过，否则 /api/team → checkBudget
  // → fetchTeam(自己) → /api/team 无限递归（hub 指向自身的场景）。
  let team: BudgetStatus['team'];
  if (!opts?.skipTeam) try {
    const cfg = await loadTeamConfig();
    if (cfg.hub && (cfg.sharedDailyTokens || cfg.sharedMonthlyTokens)) {
      const t = await fetchTeam(cfg.hub, cfg.token);
      const me = machineName();
      const others = t.machines.filter((m) => m.machine !== me);
      const teamToday = today.tokens + others.reduce((s, m) => s + (m.today?.tokens ?? 0), 0);
      const teamMonth = month.tokens + others.reduce((s, m) => s + (m.month?.tokens ?? 0), 0);
      team = { machines: t.machines.length, todayTokens: teamToday, monthTokens: teamMonth };
      chk('团队池·今日 tokens', teamToday, cfg.sharedDailyTokens, fmtTok);
      chk('团队池·本月 tokens', teamMonth, cfg.sharedMonthlyTokens, fmtTok);
    }
  } catch {
    warnings.push('团队池: hub 不可达，本次仅按本机限额判定（fail-open）');
  }
  return { limits, today, month, exceeded, warnings, team };
}
