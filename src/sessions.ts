/**
 * 会话持久化（P0 用 JSONL；设计方案 §3.2 提到的 SQLite 留到 P1）。
 *
 * 为什么先用 JSONL：P0 的目标是验证事件模型，不是验证数据库。
 * 落盘格式 = 每行 {ts, engine, sessionId, ev, raw}，天然就是"可回放的统一 transcript"，
 * P1 迁移 SQLite 时可直接导入。
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { NormalizedEvent } from './normalize.ts';

export const ROOT = path.join(homedir(), '.agentbd');
export const SESSION_DIR = path.join(ROOT, 'sessions');

export type TranscriptMeta = {
  engine: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  approval: string;
};

export type Transcript = {
  file: string;
  append: (ev: NormalizedEvent, raw?: unknown) => Promise<void>;
};

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
}

export async function createTranscript(meta: TranscriptMeta): Promise<Transcript> {
  await mkdir(SESSION_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SESSION_DIR, `${stamp}__${safeName(meta.engine)}__${safeName(meta.sessionId)}.jsonl`);
  await appendFile(file, JSON.stringify({ type: 'meta', ts: Date.now(), ...meta }) + '\n', 'utf8');
  return {
    file,
    append: async (ev, raw) => {
      const line = JSON.stringify({ type: 'ev', ts: Date.now(), k: ev.k, ev, raw });
      await appendFile(file, line + '\n', 'utf8');
    },
  };
}

export async function listTranscripts(
  limit = 20,
): Promise<Array<{ file: string; engine: string; sessionId: string; prompt: string; cwd: string; ts: string }>> {
  try {
    const files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit);
    const out = [];
    for (const f of files) {
      const full = path.join(SESSION_DIR, f);
      const first = (await readFile(full, 'utf8')).split('\n', 1)[0];
      try {
        const meta = JSON.parse(first);
        out.push({ file: full, engine: meta.engine, sessionId: meta.sessionId, prompt: meta.prompt, cwd: meta.cwd ?? '', ts: meta.ts });
      } catch {
        out.push({ file: full, engine: '?', sessionId: '?', prompt: '?', cwd: '', ts: '' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export type ResumeTarget = { sessionId: string; cwd: string; engine: string };

/**
 * `--resume` 解析：'last' = 该引擎最近一次会话；字面值 = sessionId（跨引擎不匹配时返回后由调用方报错）。
 * 返回 null 表示没找到（无 transcript / 引擎无历史）。
 */
export async function resolveResume(engineId: string, token: string): Promise<ResumeTarget | null> {
  const rows = await listTranscripts(200);
  const hit =
    token === 'last'
      ? rows.find((r) => r.engine === engineId)
      : rows.find((r) => r.sessionId === token);
  if (!hit || hit.engine === '?') return null;
  return { sessionId: hit.sessionId, cwd: hit.cwd || process.cwd(), engine: hit.engine };
}

export type StatsTotals = { turns: number; tokens: number; costUsd: number };
export type StatsEngineRow = StatsTotals & { engine: string; lastTs: number };
export type Stats = { total: StatsTotals; byEngine: StatsEngineRow[]; scanned: number; updatedAt: number };

/**
 * 用量看板数据：扫 transcript（meta + ev 两行结构）。
 * tokens/cost 取每个文件**最后一条** usage 事件（引擎发的是会话内累计快照，逐文件求和 ≈ 总处理量）。
 * `since`：只统计 meta.ts ≥ since 的会话（预算护栏的"今日/本月"窗口用）。
 */
export async function aggregateStats(limit = 500, since?: number): Promise<Stats> {
  const byEngine = new Map<string, StatsEngineRow>();
  let scanned = 0;
  let files: string[] = [];
  try {
    files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit);
  } catch {
    files = [];
  }
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(path.join(SESSION_DIR, f), 'utf8');
    } catch {
      continue;
    }
    scanned++;
    let engine = '?';
    let ts = 0;
    let tokens = 0;
    let cost = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line) as {
          type: string;
          ts?: number;
          engine?: string;
          k?: string;
          ev?: { k?: string; used?: number; costUsd?: number };
        };
        if (j.type === 'meta') {
          engine = j.engine ?? engine;
          ts = j.ts ?? ts;
        } else if (j.type === 'ev' && (j.ev?.k === 'usage' || j.k === 'usage')) {
          const ev = j.ev ?? (j as { used?: number; costUsd?: number });
          if (typeof ev.used === 'number') tokens = ev.used;
          if (typeof ev.costUsd === 'number') cost = ev.costUsd;
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    const row = byEngine.get(engine) ?? { engine, turns: 0, tokens: 0, costUsd: 0, lastTs: 0 };
    if (since !== undefined && ts < since) continue; // 窗口外：scanned 照计，但不入聚合
    row.turns += 1;
    row.tokens += tokens;
    row.costUsd += cost;
    row.lastTs = Math.max(row.lastTs, ts);
    byEngine.set(engine, row);
  }
  const byEngineSorted = [...byEngine.values()].sort((a, b) => b.lastTs - a.lastTs);
  const total: StatsTotals = {
    turns: byEngineSorted.reduce((s, r) => s + r.turns, 0),
    tokens: byEngineSorted.reduce((s, r) => s + r.tokens, 0),
    costUsd: byEngineSorted.reduce((s, r) => s + r.costUsd, 0),
  };
  return { total, byEngine: byEngineSorted, scanned, updatedAt: Date.now() };
}
