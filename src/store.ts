/**
 * SQLite 索引层（P1）：jsonl transcript 仍是写入源，SQLite 是读模型/索引。
 *
 * 设计约束：
 *  - 写路径不变（append-only jsonl，崩溃安全）；回合结束 / 读路径触发增量索引
 *    （turns.file 有 UNIQUE 约束，INSERT OR IGNORE 保证幂等，重复导入安全）。
 *  - `node:sqlite` 需要 Node ≥ 22.13（23.4+ 免 flag）；动态 import + 降级：
 *    老 Node 上 store 不可用，sessions/stats 自动回退 jsonl 扫描，功能不缺。
 *  - 索引失败绝不影响 ask 主流程（调用方 catch 吞掉）。
 */

import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// 与 sessions.ts 的 ROOT/SESSION_DIR 同值；这里独立定义避免 ESM 循环依赖的 TDZ 坑
const ROOT = path.join(homedir(), '.agentbd');
const SESSION_DIR = path.join(ROOT, 'sessions');
export const DB_FILE = path.join(ROOT, 'agentbd.db');

type DatabaseSync = import('node:sqlite').DatabaseSync;

let db: DatabaseSync | null | undefined;

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT UNIQUE NOT NULL,
  engine TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  prompt TEXT,
  approval TEXT,
  started_at INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at);
CREATE INDEX IF NOT EXISTS idx_turns_engine ON turns(engine);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  ts INTEGER,
  k TEXT NOT NULL,
  ev TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_k ON events(k);
CREATE TABLE IF NOT EXISTS team_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_reports_machine ON team_reports(machine, at);
`;

/** 打开（并初始化）数据库；不可用时返回 null（调用方走降级路径） */
async function getDb(): Promise<DatabaseSync | null> {
  if (db !== undefined) return db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(ROOT, { recursive: true });
    const d = new DatabaseSync(DB_FILE);
    d.exec(SCHEMA);
    db = d;
  } catch {
    db = null; // 老 Node / 编译缺 sqlite：整体降级，不影响主流程
  }
  return db;
}

export async function storeAvailable(): Promise<boolean> {
  return (await getDb()) !== null;
}

type JsonlRow = {
  type?: string;
  ts?: number;
  k?: string;
  engine?: string;
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  approval?: string;
  ev?: { k?: string; used?: number; costUsd?: number } & Record<string, unknown>;
  raw?: unknown;
};

/**
 * 把单个 transcript 索引进库（幂等：已索引的文件直接跳过）。
 * 返回 true = 本次新写入。
 */
export async function indexTranscriptFile(file: string): Promise<boolean> {
  const d = await getDb();
  if (!d) return false;
  const raw = await readFile(file, 'utf8');
  const rows: JsonlRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as JsonlRow);
    } catch {
      /* 跳过坏行，与 jsonl 读路径同规 */
    }
  }
  const meta = rows.find((r) => r.type === 'meta');
  if (!meta) return false;

  // 与 sessions.aggregateStats 同口径：tokens/cost 取文件内最后一条 usage 快照
  let tokens = 0;
  let costUsd = 0;
  for (const r of rows) {
    if (r.type === 'ev' && (r.k === 'usage' || r.ev?.k === 'usage')) {
      const ev = r.ev ?? (r as { used?: number; costUsd?: number });
      if (typeof ev.used === 'number') tokens = ev.used;
      if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
    }
  }

  d.exec('BEGIN');
  try {
    const ins = d
      .prepare(
        `INSERT OR IGNORE INTO turns (file, engine, session_id, cwd, prompt, approval, started_at, tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file,
        String(meta.engine ?? '?'),
        String(meta.sessionId ?? ''),
        String(meta.cwd ?? ''),
        String(meta.prompt ?? ''),
        String(meta.approval ?? ''),
        typeof meta.ts === 'number' ? meta.ts : Date.now(),
        tokens,
        costUsd,
      );
    if (Number(ins.changes) === 0) {
      d.exec('COMMIT');
      return false; // 已索引过
    }
    const turnId = Number(ins.lastInsertRowid);
    const evStmt = d.prepare('INSERT INTO events (turn_id, ts, k, ev, raw) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) {
      if (r.type !== 'ev' || !r.k) continue;

      evStmt.run(
        turnId,
        typeof r.ts === 'number' ? r.ts : null,
        r.k,
        r.ev === undefined ? null : JSON.stringify(r.ev),
        r.raw === undefined ? null : JSON.stringify(r.raw),
      );
    }
    d.exec('COMMIT');
    return true;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 已回滚 */
    }
    throw err;
  }
}
/**
 * 增量索引：只解析还没进库的 jsonl（SELECT file 比对），已索引的零成本跳过。
 * 读路径（sessions/stats/budget）每次都先调它，保证 SQLite 永远跟得上写路径。
 */
export async function syncIndex(): Promise<{ indexed: number; total: number }> {
  const d = await getDb();
  if (!d) return { indexed: 0, total: 0 };
  let files: string[] = [];
  try {
    files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  const known = new Set(
    (d.prepare('SELECT file FROM turns').all() as Array<{ file: string }>).map((r) => r.file),
  );
  let indexed = 0;
  for (const f of files) {
    const full = path.join(SESSION_DIR, f);
    if (known.has(full)) continue;
    try {
      if (await indexTranscriptFile(full)) indexed++;
    } catch {
      /* 单个坏文件不影响整体 */
    }
  }
  return { indexed, total: files.length };
}

/* ------------------------------ 读模型 ------------------------------ */

export type TurnRow = {
  file: string;
  engine: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  ts: string;
};

/** sessions 列表（按时间倒序）；store 不可用返回 null → 调用方降级 jsonl */
export async function queryTranscripts(limit = 20): Promise<TurnRow[] | null> {
  const d = await getDb();
  if (!d) return null;
  const rows = d
    .prepare(
      `SELECT file, engine, session_id AS sessionId, prompt, cwd, started_at AS startedAt
       FROM turns ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ file: string; engine: string; sessionId: string; prompt: string; cwd: string; startedAt: number }>;
  return rows.map((r) => ({ ...r, ts: new Date(r.startedAt).toISOString() }));
}

export type StatsRow = { engine: string; turns: number; tokens: number; costUsd: number; lastTs: number };

/** 用量聚合（since = 时间窗下界，预算护栏的今日/本月用）；不可用返回 null */
export async function queryStats(since?: number): Promise<{ byEngine: StatsRow[]; scanned: number } | null> {
  const d = await getDb();
  if (!d) return null;
  const byEngine = d
    .prepare(
      `SELECT engine, COUNT(*) AS turns, COALESCE(SUM(tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS costUsd, MAX(started_at) AS lastTs
       FROM turns ${since !== undefined ? 'WHERE started_at >= ?' : ''}
       GROUP BY engine ORDER BY lastTs DESC`,
    )
    .all(...(since !== undefined ? [since] : [])) as StatsRow[];
  const scanned = (d.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n;
  return { byEngine, scanned };
}

export type ToolStatRow = { engine: string; tool: string; calls: number; lastTs: number };

/**
 * 工具级调用统计（events 表 GROUP BY）——MCP/内置工具谁在被真用，一看便知。
 * 数据来源是 ask 回合里经过总线的 tool.call 事件（含引擎自己接的 MCP）。
 */
export async function queryToolStats(since?: number): Promise<ToolStatRow[] | null> {
  const d = await getDb();
  if (!d) return null;
  return d
    .prepare(
      `SELECT t.engine AS engine, json_extract(e.ev, '$.name') AS tool,
              COUNT(*) AS calls, MAX(e.ts) AS lastTs
       FROM events e JOIN turns t ON t.id = e.turn_id
       WHERE e.k = 'tool.call' AND json_extract(e.ev, '$.name') IS NOT NULL
       ${since !== undefined ? 'AND t.started_at >= ?' : ''}
       GROUP BY t.engine, tool ORDER BY calls DESC, lastTs DESC`,
    )
    .all(...(since !== undefined ? [since] : [])) as ToolStatRow[];
}

/* ------------------------------ P2-4 团队上报 ------------------------------ */

import type { TeamMachine } from './team.ts';

/** hub 侧：存一条 spoke 上报（payload 为 TeamMachine JSON） */
export async function insertTeamReport(entry: TeamMachine): Promise<boolean> {
  const d = await getDb();
  if (!d) return false;
  d.prepare('INSERT INTO team_reports (machine, at, payload) VALUES (?, ?, ?)').run(
    entry.machine,
    entry.at,
    JSON.stringify(entry),
  );
  return true;
}

/** hub 侧：每台 spoke 取最新一条上报（按机器分组，at 最大者） */
export async function queryTeamReports(): Promise<TeamMachine[] | null> {
  const d = await getDb();
  if (!d) return null;
  const rows = d
    .prepare(
      `SELECT payload FROM team_reports t
       WHERE at = (SELECT MAX(at) FROM team_reports WHERE machine = t.machine)
       GROUP BY machine ORDER BY at DESC`,
    )
    .all() as Array<{ payload: string }>;
  const out: TeamMachine[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as TeamMachine);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export async function dbInfo(): Promise<{
  file: string;
  available: boolean;
  turns: number;
  events: number;
  bytes: number;
}> {
  const d = await getDb();
  if (!d) return { file: DB_FILE, available: false, turns: 0, events: 0, bytes: 0 };
  const turns = (d.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n;
  const events = (d.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const bytes = await stat(DB_FILE)
    .then((s) => s.size)
    .catch(() => 0);
  return { file: DB_FILE, available: true, turns, events, bytes };
}
