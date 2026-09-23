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

export async function listTranscripts(limit = 20): Promise<Array<{ file: string; engine: string; sessionId: string; prompt: string; ts: string }>> {
  try {
    const files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit);
    const out = [];
    for (const f of files) {
      const full = path.join(SESSION_DIR, f);
      const first = (await readFile(full, 'utf8')).split('\n', 1)[0];
      try {
        const meta = JSON.parse(first);
        out.push({ file: full, engine: meta.engine, sessionId: meta.sessionId, prompt: meta.prompt, ts: meta.ts });
      } catch {
        out.push({ file: full, engine: '?', sessionId: '?', prompt: '?', ts: '' });
      }
    }
    return out;
  } catch {
    return [];
  }
}
