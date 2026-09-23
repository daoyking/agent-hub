/**
 * MCP Hub 写回（P1）：`mcp add/remove` 落盘到各 agent 的配置源。
 *
 * 安全约束（不可妥协）：
 *  1. 只改 MCP 相关的 key（mcpServers / mcp_servers），绝不动配置文件其他部分；
 *  2. 每次写之前先备份 `<file>.agentbd.bak`（已存在则不覆盖——保留最初的原文）；
 *  3. 原子写（tmp + rename），写失败不留半截文件；
 *  4. 只更新「本来就存在」的配置文件——不替用户发明配置（dir 型源暂不支持写）。
 */

import { readFile, writeFile, copyFile, access, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { MCP_SOURCES } from './mcphub.ts';

const expand = (p: string): string => p.replace(/^~/, homedir());

export type McpWriteSpec =
  | { kind: 'http'; url: string; type?: 'http' | 'sse' }
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string> };

export type WriteOutcome = {
  agent: string;
  file: string;
  action: 'added' | 'updated' | 'removed' | 'absent' | 'skipped';
  detail?: string;
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function backupThenWrite(file: string, content: string): Promise<void> {
  const bak = `${file}.agentbd.bak`;
  if (!(await exists(bak))) await copyFile(file, bak).catch(() => {});
  const tmp = `${file}.agentbd.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

function toJsonValue(spec: McpWriteSpec): Record<string, unknown> {
  if (spec.kind === 'http') return { type: spec.type ?? 'http', url: spec.url };
  return { command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
}

function toTomlBlock(name: string, spec: McpWriteSpec): string {
  const q = (s: string) => JSON.stringify(s); // TOML basic string 与 JSON 字符串兼容
  const lines = [`[mcp_servers.${name}]`];
  if (spec.kind === 'http') {
    lines.push(`url = ${q(spec.url)}`);
    if (spec.type === 'sse') lines.push(`type = "sse"`);
  } else {
    lines.push(`command = ${q(spec.command)}`);
    lines.push(`args = [${spec.args.map(q).join(', ')}]`);
    if (spec.env && Object.keys(spec.env).length) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(spec.env)) lines.push(`${k} = ${q(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** 定位 TOML 中 `[mcp_servers.<name>]` 段（含其子表）的字符区间 [start, end) */
function findTomlSection(text: string, name: string): { start: number; end: number } | undefined {
  const head = `[mcp_servers.${name}]`;
  const lines = text.split('\n');
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (startLine < 0) {
      if (t === head) startLine = i;
    } else if (t.startsWith('[') && !t.startsWith(`[mcp_servers.${name}.`)) {
      return { start: offsetOf(lines, startLine), end: offsetOf(lines, i) };
    }
  }
  if (startLine < 0) return undefined;
  return { start: offsetOf(lines, startLine), end: text.length };
}

function offsetOf(lines: string[], idx: number): number {
  let off = 0;
  for (let i = 0; i < idx; i++) off += lines[i]!.length + 1;
  return off;
}

export async function addMcp(name: string, spec: McpWriteSpec, agents: string[]): Promise<WriteOutcome[]> {
  const out: WriteOutcome[] = [];
  for (const src of MCP_SOURCES) {
    if (!agents.includes(src.agent)) continue;
    const file = expand(src.file);
    if (src.format === 'dir') {
      out.push({ agent: src.agent, file, action: 'skipped', detail: 'dir 型配置暂不支持写回' });
      continue;
    }
    if (!(await exists(file))) {
      out.push({ agent: src.agent, file, action: 'absent', detail: '配置文件不存在（不替用户创建）' });
      continue;
    }
    const raw = await readFile(file, 'utf8');
    if (src.format === 'json') {
      const d = JSON.parse(raw) as Record<string, any>;
      const key = src.keys[0]!;
      const bucket = (d[key] ??= {}) as Record<string, unknown>;
      const existed = name in bucket;
      bucket[name] = toJsonValue(spec);
      await backupThenWrite(file, JSON.stringify(d, null, 2) + '\n');
      out.push({ agent: src.agent, file, action: existed ? 'updated' : 'added' });
    } else {
      const section = findTomlSection(raw, name);
      const block = toTomlBlock(name, spec);
      let next: string;
      if (section) {
        next = raw.slice(0, section.start) + block + raw.slice(section.end).replace(/^\n+/, '');
        out.push({ agent: src.agent, file, action: 'updated' });
      } else {
        const pad = raw.length && !raw.endsWith('\n') ? '\n' : '';
        next = raw + pad + (raw.trim() ? '\n' : '') + block;
        out.push({ agent: src.agent, file, action: 'added' });
      }
      await backupThenWrite(file, next);
    }
  }
  return out;
}

export async function removeMcp(name: string, agents?: string[]): Promise<WriteOutcome[]> {
  const out: WriteOutcome[] = [];
  for (const src of MCP_SOURCES) {
    if (agents && agents.length > 0 && !agents.includes(src.agent)) continue;
    const file = expand(src.file);
    if (src.format === 'dir' || !(await exists(file))) continue;
    const raw = await readFile(file, 'utf8');
    if (src.format === 'json') {
      const d = JSON.parse(raw) as Record<string, any>;
      let removed = false;
      for (const key of src.keys) {
        const bucket = d[key];
        if (bucket && typeof bucket === 'object' && name in bucket) {
          delete bucket[name];
          removed = true;
        }
      }
      if (!removed) continue;
      await backupThenWrite(file, JSON.stringify(d, null, 2) + '\n');
      out.push({ agent: src.agent, file, action: 'removed' });
    } else {
      const section = findTomlSection(raw, name);
      if (!section) continue;
      await backupThenWrite(
        file,
        (raw.slice(0, section.start) + raw.slice(section.end)).replace(/\n{3,}/g, '\n\n'),
      );
      out.push({ agent: src.agent, file, action: 'removed' });
    }
  }
  return out;
}