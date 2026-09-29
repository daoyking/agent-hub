/**
 * 免费模型清单：数据源是 GitHub 上的 LiteLLM 定价表
 * （BerriAI/litellm 的 `model_prices_and_context_window.json`，main 分支 raw 文件）。
 * 选它而不是别的清单，是因为本项目的 litellm 网关就是按这张表路由的，模型名能直接对上。
 *
 * 「免费」的判定：**input_cost_per_token 与 output_cost_per_token 都是数值 0**。
 * 这个判定有三个坑，全部在 pickFreeModels 里挡住了：
 *
 * 1. 表里第一条是 `sample_spec`——一份**文档占位符**，它的 provider 写着
 *    "one of https://docs.litellm.ai/docs/providers"、mode 写着 "one of: chat, embedding…"，
 *    而 input_cost_per_token 恰好是 `0.0`。只按成本过滤就会凭空多出一个"免费模型"。
 * 2. 有的条目只有 input=0、output 字段缺失（如 perplexity 的 online 搜索模型）。
 *    缺失是「未知」不是「免费」，必须两个都是**数值** 0 才算。
 * 3. 零成本里混着 `azure_ai` / `sagemaker` / `vertex_ai` 这类——**模型标价 0，
 *    但托管它的云要钱**。混在一起报"免费"是不诚实的，故单列 self-hosted 一类。
 *
 * 缓存：定价表约 3MB，本机实测下载要 ~35s，所以默认缓存 24h，
 * 并带 ETag 条件请求（304 就当没变，不重下 3MB）。写入走"临时文件 + rename"，
 * 避免像实测中那样被超时截断的下载**污染**已有缓存。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const PRICES_FILE = path.join(homedir(), '.agentbd', 'model-prices.json');
export const PRICES_META_FILE = path.join(homedir(), '.agentbd', 'model-prices.meta.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 真·本机跑，不产生任何云端账单 */
const LOCAL_PROVIDERS = new Set([
  'ollama', 'lm_studio', 'lmstudio', 'vllm', 'llamacpp', 'llama_cpp', 'jan',
  'localai', 'oobabooga', 'lemonade', 'llamafile', 'my-llama-cpp',
]);
/** 标价 0，但要自己付托管费（云上开一个推理实例）——不能算「白用」 */
const HOSTED_BILLING = new Set([
  'azure_ai', 'sagemaker', 'vertex_ai', 'vertex_ai-lama_models', 'fireworks_ai',
  'together_ai', 'together', 'baseten', 'deepinfra', 'replicate', 'cerebras',
]);

/**
 * - `local`：本机自跑，不花钱也不需要 key
 * - `free-tier`：厂商给的免费额度（要 key，有速率/额度限制）
 * - `self-hosted`：模型标价 0，但云托管要自付
 */
export type FreeKind = 'local' | 'free-tier' | 'self-hosted';

export interface FreeModel {
  id: string;
  provider: string;
  mode: string;
  kind: FreeKind;
  maxInput?: number;
  maxOutput?: number;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** 纯函数：定价表 → 免费模型列表。抽出来是为了能脱离网络直接测。 */
export function pickFreeModels(raw: Record<string, unknown>): FreeModel[] {
  const out: FreeModel[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const m = value as Record<string, unknown>;
    const provider = typeof m.litellm_provider === 'string' ? m.litellm_provider.trim() : '';
    // 坑 1：占位符。provider 含空格或 URL 的都不是真 provider，一律丢掉。
    if (id === 'sample_spec' || !provider || /\s|:\/\//.test(provider)) continue;
    // 坑 2：两个成本都必须是**数值** 0。缺字段 = 未知，不能当免费。
    const cin = m.input_cost_per_token;
    const cout = m.output_cost_per_token;
    if (!isNum(cin) || !isNum(cout) || cin !== 0 || cout !== 0) continue;
    const mode = typeof m.mode === 'string' && !/one of/i.test(m.mode) ? m.mode : 'chat';
    const maxIn = isNum(m.max_input_tokens) ? m.max_input_tokens : isNum(m.max_tokens) ? m.max_tokens : undefined;
    out.push({
      id,
      provider,
      mode,
      kind: LOCAL_PROVIDERS.has(provider) ? 'local' : HOSTED_BILLING.has(provider) ? 'self-hosted' : 'free-tier',
      maxInput: maxIn,
      maxOutput: isNum(m.max_output_tokens) ? m.max_output_tokens : undefined,
    });
  }
  return out;
}

/**
 * **只读本地缓存**，不发起任何网络请求。给面板用：
 * 面板轮询不能等 30~40 秒的下载，更不该让每次请求都去碰网。
 * 没有缓存就返回 null，由调用方决定是否后台预热。
 */
export async function loadCachedFreeModels(): Promise<FreeModelReport | null> {
  const cached = await readCache();
  if (!cached) return null;
  return {
    models: pickFreeModels(cached.raw),
    totalInTable: Object.keys(cached.raw).length,
    fetchedAt: cached.meta.fetchedAt,
    cached: true,
    stale: ageOf(cached.meta.fetchedAt) >= CACHE_TTL_MS,
  };
}

export interface FreeModelReport {
  models: FreeModel[];
  totalInTable: number;
  fetchedAt: string;
  cached: boolean;
  /** 展示的是可能过期的数据（拉取失败，只能用旧缓存） */
  stale: boolean;
  note?: string;
}

interface Meta {
  fetchedAt: string;
  etag?: string;
}

const ageOf = (fetchedAt: string): number => Date.now() - (Date.parse(fetchedAt) || 0);

/** 校验下载来的东西是不是一份完整的定价表（被截断的 JSON 在这里被挡住） */
function validTable(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x as object).length > 500;
}

async function readCache(): Promise<{ raw: Record<string, unknown>; meta: Meta } | null> {
  try {
    const [rawTxt, metaTxt] = await Promise.all([
      readFile(PRICES_FILE, 'utf8'),
      readFile(PRICES_META_FILE, 'utf8').catch(() => '{}'),
    ]);
    const raw: unknown = JSON.parse(rawTxt);
    if (!validTable(raw)) return null;
    return { raw, meta: JSON.parse(metaTxt) as Meta };
  } catch {
    return null;
  }
}

async function writeCache(raw: Record<string, unknown>, meta: Meta): Promise<void> {
  await mkdir(path.dirname(PRICES_FILE), { recursive: true });
  const tmp = `${PRICES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(raw), 'utf8'); // 先写临时文件
  await rename(tmp, PRICES_FILE); // 再原子替换：截断的下载不会污染好缓存
  await writeFile(PRICES_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * 取免费模型清单。缓存 24h；`refresh: true` 强制重拉（带 ETag，304 就不重下 3MB）。
 * 拉取失败但有缓存 → 返回缓存并标 `stale`，而不是让命令直接失败。
 */
export async function loadFreeModels(
  opts: { refresh?: boolean; onProgress?: (s: string) => void } = {},
): Promise<FreeModelReport> {
  const say = opts.onProgress ?? (() => {});
  const cached = await readCache();
  const isFresh = cached ? ageOf(cached.meta.fetchedAt) < CACHE_TTL_MS : false;
  if (cached && isFresh && !opts.refresh) {
    return {
      models: pickFreeModels(cached.raw),
      totalInTable: Object.keys(cached.raw).length,
      fetchedAt: cached.meta.fetchedAt,
      cached: true,
      stale: false,
    };
  }

  // 实测 3MB 在本机要 ~35s，所以给足超时，并明确告诉用户在干什么。
  // 有 etag 时其实只是条件请求（可能秒回 304），别再报"要下 3MB"吓人。
  say(
    cached?.meta.etag
      ? '正在校验定价表是否更新（ETag 条件请求，不会重下 3MB）…'
      : `正在拉取定价表（约 3MB，本机实测 30~40 秒）: ${PRICES_URL}`,
  );
  try {
    const headers: Record<string, string> = cached?.meta.etag ? { 'If-None-Match': cached.meta.etag } : {};
    const res = await fetch(PRICES_URL, { headers, signal: AbortSignal.timeout(180_000) });
    if (res.status === 304 && cached) {
      const meta: Meta = { fetchedAt: new Date().toISOString(), etag: cached.meta.etag };
      await writeCache(cached.raw, meta);
      say('远端未变化（304），沿用本地缓存');
      return {
        models: pickFreeModels(cached.raw),
        totalInTable: Object.keys(cached.raw).length,
        fetchedAt: meta.fetchedAt,
        cached: true,
        stale: false,
        note: '304 未变化',
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: unknown = await res.json();
    if (!validTable(raw)) {
      throw new Error(`内容不像定价表（只有 ${Object.keys((raw as object) ?? {}).length} 个键），已丢弃，未覆盖本地缓存`);
    }
    const meta: Meta = { fetchedAt: new Date().toISOString(), etag: res.headers.get('etag') ?? undefined };
    await writeCache(raw, meta);
    return { models: pickFreeModels(raw), totalInTable: Object.keys(raw).length, fetchedAt: meta.fetchedAt, cached: false, stale: false };
  } catch (e) {
    if (cached) {
      const days = Math.max(1, Math.round(ageOf(cached.meta.fetchedAt) / 86_400_000));
      return {
        models: pickFreeModels(cached.raw),
        totalInTable: Object.keys(cached.raw).length,
        fetchedAt: cached.meta.fetchedAt,
        cached: true,
        stale: true,
        note: `拉取失败（${(e as Error).message}），显示 ${days} 天前的缓存`,
      };
    }
    throw new Error(
      `拉取定价表失败：${(e as Error).message}\n` +
        `  数据源 ${PRICES_URL}\n` +
        `  首次使用必须联网下载约 3MB；也可以手动放一份到 ${PRICES_FILE}。`,
    );
  }
}

export interface FreeSummary {
  total: number;
  byKind: Record<FreeKind, number>;
  byMode: Record<string, number>;
  chat: number;
}

export function summarize(models: FreeModel[]): FreeSummary {
  const byKind: Record<FreeKind, number> = { local: 0, 'free-tier': 0, 'self-hosted': 0 };
  const byMode: Record<string, number> = {};
  for (const m of models) {
    byKind[m.kind] += 1;
    byMode[m.mode] = (byMode[m.mode] ?? 0) + 1;
  }
  return { total: models.length, byKind, byMode, chat: byMode['chat'] ?? 0 };
}
