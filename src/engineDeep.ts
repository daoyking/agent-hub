/**
 * 引擎「回合可用性」缓存（`agentbd doctor --deep` 的产物）。
 *
 * 为什么需要单独一层：面板的引擎灯来自 **ACP 握手**，那只能证明"协议通"。
 * 实测 qwen 握手 ✔ 但真实回合报 `Use Qwen Code CLI to authenticate first`——
 * 面板却亮绿灯，用户要等 ask 失败才发现。
 *
 * 为什么不每次面板请求都探：真跑一回合 = 一次模型调用，面板 4s 轮询一次，
 * 既慢又花钱。所以由 `doctor --deep` **主动测量并落盘**，面板只读缓存，
 * 零成本地把"握手 OK 但回合不通"显示出来。
 *
 * 缓存会过期（默认 24h）：过期的结论比没有结论更危险——引擎可能后来修好了。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ENGINE_DEEP_FILE = path.join(homedir(), '.agentbd', 'engine-deep.json');

/** 结论有效期：超过就当"没测过"（unknown），不拿旧结论误导 */
export const DEEP_TTL_MS = Number(process.env.AGENTBD_DEEP_TTL_MS ?? 24 * 3600_000);

export type EngineDeepEntry = { id: string; ok: boolean; detail: string; at: number };
export type EngineDeepFile = { at: number; entries: Record<string, EngineDeepEntry> };

export async function saveEngineDeep(
  results: Array<{ id: string; ok: boolean; detail: string }>,
): Promise<void> {
  const entries: Record<string, EngineDeepEntry> = {};
  const at = Date.now();
  for (const r of results) entries[r.id] = { ...r, at };
  await mkdir(path.dirname(ENGINE_DEEP_FILE), { recursive: true });
  await writeFile(ENGINE_DEEP_FILE, JSON.stringify({ at, entries }, null, 2), 'utf8');
}

export async function loadEngineDeep(): Promise<Map<string, EngineDeepEntry>> {
  try {
    const f = JSON.parse(await readFile(ENGINE_DEEP_FILE, 'utf8')) as EngineDeepFile;
    const now = Date.now();
    const out = new Map<string, EngineDeepEntry>();
    for (const [id, e] of Object.entries(f.entries ?? {})) {
      if (now - (e.at ?? 0) <= DEEP_TTL_MS) out.set(id, e);
    }
    return out;
  } catch {
    return new Map(); // 没跑过 --deep（正常情况）
  }
}
