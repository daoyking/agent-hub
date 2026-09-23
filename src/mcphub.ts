/**
 * MCP Hub —— 把「本地服务」与「所有 agent」接在一起的那根线。
 *
 * 为什么这是关键（实测发现）：`browseros-neo`（http://127.0.0.1:9010/mcp，一个本地服务）
 * 在 ~/.claude.json 和 ~/.codex/config.toml 里各配了一遍；每多接一个 agent 就多一份副本，
 * 且**服务没起时不会有任何提示，只在用的时候静默失败**。
 *
 * 本模块做三件事：
 *  1. 扫描所有 agent 的 MCP 配置 → 归一去重（同一 target 只出现一次，记录 usedBy）
 *  2. 与本地服务关联（按 URL 端口）→ 服务红灯时给出"这个 MCP 现在必挂"的结论
 *  3. 输出 ACP `session/new` 的 mcpServers → 一份配置喂所有引擎
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { LocalService } from './services.ts';

export type McpEntry = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  target: string;
  agents: string[];
  /** 关联到的本地服务 id（按 URL 端口匹配） */
  serviceId?: string;
  /** 关联服务的可用性（down 时该 MCP 必然不可用） */
  serviceLamp?: string;
  raw: Record<string, unknown>;
};

type Source = { agent: string; file: string; keys: string[]; format: 'json' | 'toml' | 'dir' };

export const MCP_SOURCES: Source[] = [
  { agent: 'claude', file: '~/.claude.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'codex', file: '~/.codex/config.toml', keys: ['mcp_servers'], format: 'toml' },
  { agent: 'cursor', file: '~/.cursor/mcp.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'gemini', file: '~/.gemini/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'qwen', file: '~/.qwen/settings.json', keys: ['mcpServers', 'mcp'], format: 'json' },
  { agent: 'iflow', file: '~/.iflow/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'qoder', file: '~/.qoder/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'codebuddy', file: '~/.codebuddy/mcp.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'workbuddy', file: '~/.workbuddy/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'trae', file: '~/.trae-cn/mcps', keys: ['mcpServers'], format: 'dir' },
  { agent: 'trae-global', file: '~/.trae/mcps', keys: ['mcpServers'], format: 'dir' },
  { agent: 'opencode', file: '~/.config/opencode/opencode.json', keys: ['mcp'], format: 'json' },
  { agent: 'junie', file: '~/.junie/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'kiro', file: '~/.kiro/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'continue', file: '~/.continue/config.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'roo', file: '~/.roo/settings.json', keys: ['mcpServers'], format: 'json' },
  { agent: 'openhands', file: '~/.openhands/settings.json', keys: ['mcpServers'], format: 'json' },
];

const expand = (p: string): string => p.replace(/^~/, homedir());

export function normalizeJsonServers(raw: unknown, agent: string, sink: McpEntry[]): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : undefined;
    const command = typeof o.command === 'string' ? o.command : Array.isArray(o.command) ? String(o.command[0]) : undefined;
    const args = Array.isArray(o.args) ? o.args.map(String) : Array.isArray(o.command) ? o.command.slice(1).map(String) : [];
    const declared = typeof o.type === 'string' ? o.type : undefined;
    const transport: McpEntry['transport'] = url ? (declared === 'sse' || url.includes('/sse') ? 'sse' : 'http') : 'stdio';
    const target = url ?? [command, ...args].filter(Boolean).join(' ');
    if (!target) continue;
    sink.push({ name, transport, target, agents: [agent], raw: o });
  }
}


/** codex 的 TOML 用轻量解析：只认 [mcp_servers.NAME] 段落里的键值 */
export function normalizeTomlServers(text: string, agent: string, sink: McpEntry[]): void {
  let current: string | null = null;
  const acc: Record<string, Record<string, unknown>> = {};
  for (const line of text.split('\n')) {
    const sec = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      current = sec[1]!.replace(/^"|"$/g, '');
      acc[current] = {};
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let val: unknown = kv[2]!;
    if (typeof val === 'string' && /^".*"$/.test(val)) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\[.*\]$/.test(String(val))) {
      val = String(val)
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    }
    acc[current]![key] = val;
  }
  normalizeJsonServers(acc, agent, sink);
}

export async function scanMcp(services: LocalService[] = []): Promise<McpEntry[]> {
  const found: McpEntry[] = [];

  for (const src of MCP_SOURCES) {
    const file = expand(src.file);
    try {
      if (src.format === 'json') {
        const d = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        for (const key of src.keys) normalizeJsonServers(d[key], src.agent, found);
      } else if (src.format === 'toml') {
        normalizeTomlServers(await readFile(file, 'utf8'), src.agent, found);
      } else {
        const entries = await readdir(file, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const inner = await readdir(path.join(file, e.name)).catch(() => [] as string[]);
          for (const f of inner.filter((x) => x.endsWith('.json'))) {
            try {
              const d = JSON.parse(await readFile(path.join(file, e.name, f), 'utf8')) as Record<string, unknown>;
              for (const key of src.keys) normalizeJsonServers(d[key], src.agent, found);
            } catch {
              /* 单个坏文件不影响整体 */
            }
          }
        }
      }
    } catch {
      /* 配置不存在是常态，不是错误 */
    }
  }

  // 归一去重：同一 target 只保留一条，合并 usedBy
  const byTarget = new Map<string, McpEntry>();
  for (const e of found) {
    const key = `${e.transport}:${e.target}`;
    const hit = byTarget.get(key);
    if (hit) {
      const a = e.agents[0]!;
      if (!hit.agents.includes(a)) hit.agents.push(a);
    } else {
      byTarget.set(key, { ...e, agents: [...e.agents] });
    }
  }

  // 与本地服务关联：URL 端口 → 服务；服务红灯 ⇒ 这个 MCP 必然不可用
  const out = [...byTarget.values()];
  for (const e of out) {
    if (!/^https?:/.test(e.target)) continue;
    let port: number | undefined;
    try {
      const u = new URL(e.target);
      port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    } catch {
      continue;
    }
    const svc = services.find((s) => s.ports.includes(port!));
    if (svc) {
      e.serviceId = svc.id;
      e.serviceLamp = svc.health?.lamp;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 转成 ACP `session/new` 的 mcpServers —— 一份配置喂所有引擎 */
export function toAcpMcpServers(entries: McpEntry[], only?: string[]): acp.McpServer[] {
  const picked = only?.length ? entries.filter((e) => only.includes(e.name)) : entries;
  return picked.map((e): acp.McpServer => {
    if (e.transport === 'stdio') {
      const [command, ...args] = e.target.split(' ').filter(Boolean);
      const env = Object.entries((e.raw.env as Record<string, unknown>) ?? {})
        .filter(([, v]) => typeof v === 'string')
        .map(([name, value]) => ({ name, value: String(value) }));
      return { name: e.name, command: command!, args, env };
    }
    const headers = Array.isArray(e.raw.headers)
      ? (e.raw.headers as Array<{ name: string; value: string }>)
      : Object.entries((e.raw.headers as Record<string, unknown>) ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    return { type: e.transport, name: e.name, url: e.target, headers };
  });
}
