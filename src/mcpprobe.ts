/**
 * MCP 工具级探针（P1）：
 *   L1 证明「服务活着」，工具探针证明「MCP 协议真能说话」——
 *   两盏灯分开报，才不会出现「端口开着但 MCP 握手挂了」的假绿。
 *
 * 支持两种传输：
 *   - stdio：spawn + JSON-RPC ndjson（initialize → notifications/initialized → tools/list）
 *   - http/sse：MCP Streamable HTTP（POST JSON-RPC，Accept: application/json, text/event-stream，
 *               响应可能是 application/json 也可能是 SSE 帧；会话经 Mcp-Session-Id 头传递）
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { McpEntry } from './mcphub.ts';

export type McpProbeResult = {
  name: string;
  ok: boolean;
  ms: number;
  tools?: string[];
  protocolVersion?: string;
  error?: string;
  skipped?: boolean;
  /** true = 来自 tools/list 结果缓存（P1，TTL 2min，--refresh 绕过） */
  cached?: boolean;
};

const PROTOCOL = '2025-06-18';
const INIT = {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: 'agentbd-probe', version: '0.1.0' },
};

function skip(e: McpEntry, why: string): McpProbeResult {
  return { name: e.name, ok: false, ms: 0, skipped: true, error: why };
}

/* ------------------------------ stdio ------------------------------ */

async function probeStdio(e: McpEntry, timeoutMs: number): Promise<McpProbeResult> {
  const t0 = Date.now();
  const [command, ...args] = e.target.split(' ').filter(Boolean);
  if (!command) return skip(e, '缺少 command');
  const cwdRaw = typeof e.raw.cwd === 'string' ? e.raw.cwd : '.';
  const cwd = !cwdRaw || cwdRaw === '.' || !path.isAbsolute(cwdRaw) ? homedir() : cwdRaw;
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries((e.raw.env as Record<string, unknown>) ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }

  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout! });
  const pending = new Map<number, (v: unknown) => void>();
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-800)));

  const nextId = { n: 1 };
  const request = (method: string, params: unknown): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      const id = ++nextId.n;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, (v) => {
        clearTimeout(timer);
        const obj = v as Record<string, any>;
        if (obj && typeof obj === 'object' && obj.error) {
          reject(new Error(`${method}: ${JSON.stringify(obj.error).slice(0, 200)}`));
        } else resolve(obj ?? {});
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method: string, params: unknown) => {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  rl.on('line', (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const arr = Array.isArray(msg) ? msg : [msg];
    for (const m of arr as Record<string, any>[]) {
      if (typeof m?.id === 'number' && pending.has(m.id)) pending.get(m.id)!(m);
    }
  });

  try {
    const init = await request('initialize', INIT);
    notify('notifications/initialized', {});
    const tools = await request('tools/list', {});
    const names = Array.isArray(tools?.result?.tools)
      ? tools.result.tools.map((t: any) => String(t?.name))
      : [];
    return {
      name: e.name,
      ok: true,
      ms: Date.now() - t0,
      tools: names,
      protocolVersion:
        typeof init?.result?.protocolVersion === 'string' ? init.result.protocolVersion : PROTOCOL,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim() ? `${msg} · stderr: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : msg;
    return { name: e.name, ok: false, ms: Date.now() - t0, error: detail.slice(0, 500) };
  } finally {
    rl.close();
    child.kill('SIGKILL');
  }
}

/* ------------------------- http / sse ------------------------------ */

/** 解析响应：application/json 或 text/event-stream 的 data: 帧 */
function parseBody(contentType: string, body: string): unknown {
  if (contentType.includes('text/event-stream')) {
    const datas = body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    for (const d of datas) {
      try {
        const v = JSON.parse(d);
        if (v && typeof v === 'object' && 'id' in v) return v;
      } catch {
        /* 跳过非 JSON 帧 */
      }
    }
    throw new Error('SSE 帧里没有 JSON-RPC 响应');
  }
  return JSON.parse(body);
}

async function probeHttp(e: McpEntry, timeoutMs: number): Promise<McpProbeResult> {
  const t0 = Date.now();
  let sessionId: string | undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const [k, v] of Object.entries((e.raw.headers as Record<string, unknown>) ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }

  let nextId = 0;
  const post = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(e.target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const v = parseBody(res.headers.get('content-type') ?? '', text) as Record<string, any>;
    if (v && typeof v === 'object' && v.error) {
      throw new Error(`JSON-RPC error: ${JSON.stringify(v.error).slice(0, 200)}`);
    }
    return v;
  };

  try {
    const init = await post({ jsonrpc: '2.0', id: ++nextId, method: 'initialize', params: INIT });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const tools = await post({ jsonrpc: '2.0', id: ++nextId, method: 'tools/list', params: {} });
    const names = Array.isArray(tools?.result?.tools)
      ? tools.result.tools.map((t: any) => String(t?.name))
      : [];
    return {
      name: e.name,
      ok: true,
      ms: Date.now() - t0,
      tools: names,
      protocolVersion:
        typeof init?.result?.protocolVersion === 'string' ? init.result.protocolVersion : PROTOCOL,
    };
  } catch (err) {
    return {
      name: e.name,
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------ 入口 -------------------------------- */

export function probeMcpEntry(e: McpEntry, timeoutMs = 20000): Promise<McpProbeResult> {
  if (e.raw && e.raw.enabled === false) return Promise.resolve(skip(e, '配置里 enabled=false'));
  if (e.transport === 'stdio') return probeStdio(e, timeoutMs);
  return probeHttp(e, timeoutMs);
}

export async function probeMcpAll(entries: McpEntry[], timeoutMs = 20000): Promise<McpProbeResult[]> {
  return Promise.all(entries.map((e) => probeMcpEntry(e, timeoutMs)));
}

/* ------------------------- tools/list 结果缓存（P1） ------------------------- */

const CACHE_FILE = path.join(homedir(), '.agentbd', 'mcp-probe-cache.json');
const CACHE_TTL_MS = 120_000;

type ProbeCache = Record<string, { at: number; r: McpProbeResult }>;

async function readCache(): Promise<ProbeCache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as ProbeCache;
  } catch {
    return {};
  }
}

async function writeCache(c: ProbeCache): Promise<void> {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(c), 'utf8');
  await rename(tmp, CACHE_FILE); // 原子写，与 repo 其他状态文件同规
}

const cacheKey = (e: McpEntry): string => `${e.transport}:${e.target}`;

/**
 * 带缓存的批量探针：成功的 tools/list 结果缓存 2min（服务没重启工具表不会变），
 * 失败结果不缓存（下次立即重试）。`refresh` 强制全量真探。
 */
export async function probeMcpEntriesCached(
  entries: McpEntry[],
  opts: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<McpProbeResult[]> {
  const cache = opts.refresh ? {} : await readCache();
  const now = Date.now();
  const results: McpProbeResult[] = [];
  const misses: McpEntry[] = [];
  for (const e of entries) {
    const hit = cache[cacheKey(e)];
    if (hit && hit.r.ok && now - hit.at < CACHE_TTL_MS) {
      results.push({ ...hit.r, cached: true });
    } else {
      misses.push(e);
    }
  }
  const fresh = await Promise.all(misses.map((e) => probeMcpEntry(e, opts.timeoutMs ?? 20000)));
  for (const r of fresh) {
    results.push(r);
    if (r.ok) {
      const e = misses.find((m) => m.name === r.name);
      if (e) cache[cacheKey(e)] = { at: now, r };
    }
  }
  await writeCache(cache).catch(() => {});
  // 保持入参顺序
  const byName = new Map(results.map((r) => [r.name, r]));
  return entries.map((e) => byName.get(e.name)!).filter(Boolean);
}