/**
 * P2-4 多机/团队维度 —— hub-spoke 汇总 + 共享预算池。
 *
 * 拓扑：一台机器常驻 `agentbd serve --host 0.0.0.0 --token <共享密钥>` 当 hub；
 * 其他机器（spoke）`agentbd team join <hub-url> token=…` 后：
 *   - `agentbd team report` 把本机今日/本月用量 POST 到 hub（可挂 crontab 定时）；
 *   - 预算护栏 checkBudget 会把 hub 汇总纳入「共享池」限额（team.json 里的
 *     sharedDailyTokens / sharedMonthlyTokens），超限在任意一台机器上都会被拦截；
 *   - `agentbd team list` 看全队每台机器的用量。
 *
 * 安全边界：hub 必须 --token（server.ts 拒绝无 token 的非回环绑定）；
 * 上报内容只有聚合用量（轮次/tokens/成本），不含 prompt 原文。
 * hub 不可达时预算检查 fail-open（本机限额仍然生效）并打 warn。
 */

import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './sessions.ts';

export const TEAM_FILE = path.join(ROOT, 'team.json');

export type TeamConfig = {
  /** hub 地址，如 http://192.168.1.10:7787 */
  hub?: string;
  /** 共享密钥（hub serve --token 同一个） */
  token?: string;
  /** 本机在团队视图里的显示名（默认 hostname） */
  name?: string;
  /** 共享池限额：全队今日 tokens 合计上限 */
  sharedDailyTokens?: number;
  /** 共享池限额：全队本月 tokens 合计上限 */
  sharedMonthlyTokens?: number;
};

/** 上报/汇总用的单机器用量条目 */
export type TeamMachine = {
  machine: string;
  name: string;
  at: number;
  today: { turns: number; tokens: number; costUsd: number };
  month: { turns: number; tokens: number; costUsd: number };
};

export function machineName(): string {
  return os.hostname().replace(/\.(local|lan)$/, '');
}

export async function loadTeamConfig(): Promise<TeamConfig> {
  try {
    return JSON.parse(await readFile(TEAM_FILE, 'utf8')) as TeamConfig;
  } catch {
    return {};
  }
}

export async function saveTeamConfig(cfg: TeamConfig): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const tmp = `${TEAM_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  await rename(tmp, TEAM_FILE);
}

export async function clearTeamConfig(): Promise<void> {
  await rm(TEAM_FILE, { force: true });
}

/** 从 hub 拉全队汇总（spoke/CLI 侧用）；4s 超时，失败抛错由调用方决定 fail-open/closed */
export async function fetchTeam(hub: string, token?: string): Promise<{ machines: TeamMachine[]; at: number }> {
  const res = await fetch(`${hub.replace(/\/+$/, '')}/api/team`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`hub 返回 ${res.status}`);
  return (await res.json()) as { machines: TeamMachine[]; at: number };
}

/** 把本机用量上报到 hub */
export async function postReport(hub: string, token: string | undefined, entry: TeamMachine): Promise<void> {
  const res = await fetch(`${hub.replace(/\/+$/, '')}/api/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`hub 返回 ${res.status}`);
}
