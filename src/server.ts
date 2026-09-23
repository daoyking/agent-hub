/**
 * P1 Web UI 服务端 —— 127.0.0.1 本地面板。
 *
 * 事件模型与 CLI 完全同源（bus.runTurn → NormalizedEvent），
 * UI 只是把 `cli.renderEvent` 的 ANSI 行换成组件：
 *   GET  /            单页面板（src/ui.html，无构建步骤）
 *   GET  /api/state   引擎 + 服务灯 + MCP 清单（一次聚合）
 *   GET  /events      SSE：状态刷新 + ask 回合的实时事件
 *   POST /api/ask     {engine,prompt,cwd?,approval?,withMcp?} → runTurn
 *   POST /api/refresh 重新 L1 探测服务 + 重扫 MCP
 *
 * 安全边界：只绑 127.0.0.1；无鉴权（本机单用户）；不落任何新状态。
 */

import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { BUILTIN_ENGINES, findEngine } from './registry.ts';
import { runTurn } from './bus.ts';
import { discover, probeService, loadManifest } from './services.ts';
import { scanMcp, toAcpMcpServers } from './mcphub.ts';
import type { LocalService } from './services.ts';
import type { NormalizedEvent } from './normalize.ts';

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

export type ServerState = {
  engines: Array<{ id: string; label: string; vendor: string; channel: string }>;
  services: Array<{
    id: string;
    ports: number[];
    managed: string;
    lamp: string;
    detail: string;
    mcp?: string;
  }>;
  mcp: Array<{
    name: string;
    transport: string;
    target: string;
    agents: string[];
    serviceId?: string;
    serviceLamp?: string;
  }>;
  at: number;
};

const sseClients = new Set<ServerResponse>();

function broadcast(payload: Record<string, unknown>): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function gatherState(): Promise<ServerState> {
  const probed: LocalService[] = await Promise.all(
    (await discover()).map(async (s) => ({ ...s, health: await probeService(s, 'l1') })),
  );
  const manifest = await loadManifest();
  const declared = new Set(manifest.services.map((x) => x.id));
  const services = probed
    .filter((s) => declared.has(s.id) || (s.managed !== 'unmanaged' && s.ports.length > 0))
    .map((s) => ({
      id: s.id,
      ports: s.ports,
      managed: String(s.managed),
      lamp: s.health?.lamp ?? 'unknown',
      detail: s.health?.detail ?? '',
      mcp: s.mcp?.url,
    }));
  const mcp = (await scanMcp(probed)).map((e) => ({
    name: e.name,
    transport: e.transport,
    target: e.target,
    agents: e.agents,
    serviceId: e.serviceId,
    serviceLamp: e.serviceLamp,
  }));
  return {
    engines: BUILTIN_ENGINES.map((e) => ({
      id: e.id,
      label: e.label,
      vendor: e.vendor,
      channel: e.channel,
    })),
    services,
    mcp,
    at: Date.now(),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function handleAsk(body: Record<string, unknown>): Promise<void> {
  const engineId = String(body.engine ?? '');
  const prompt = String(body.prompt ?? '');
  const spec = findEngine(engineId);
  if (!spec || !prompt) {
    broadcast({
      k: 'ask.error',
      error: `engine/prompt 缺失（可用: ${BUILTIN_ENGINES.map((e) => e.id).join(', ')}）`,
    });
    return;
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : process.cwd();
  const approval = body.approval === 'auto' || body.approval === 'deny' ? body.approval : 'guard';

  let mcpServers: acp.McpServer[] | undefined;
  if (body.withMcp === true) {
    const probed = await Promise.all(
      (await discover()).map(async (s) => ({ ...s, health: await probeService(s, 'l1') })),
    );
    mcpServers = toAcpMcpServers(await scanMcp(probed));
    broadcast({ k: 'notice', level: 'info', text: `注入 ${mcpServers.length} 个 MCP server` });
  }

  try {
    const result = await runTurn({
      spec,
      cwd,
      prompt,
      approval,
      mcpServers,
      onEvent: (ev: NormalizedEvent) => broadcast({ k: 'ask.event', engine: spec.id, ev }),
    });
    broadcast({ k: 'ask.done', engine: spec.id, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /Provider not set|AGNES_AI_API_KEY/.test(msg)
      ? 'agnes 缺 AGNES_AI_API_KEY：打开 AgnesCode GUI（登录态会同步 key）后重试'
      : '';
    broadcast({ k: 'ask.error', engine: spec.id, error: hint ? `${msg}\n${hint}` : msg });
  }
}

export async function startServer(opts: {
  port: number;
  host: string;
}): Promise<{ url: string; server: Server }> {
  const uiHtml = await readFile(UI_FILE, 'utf8');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(uiHtml);
        } else if (req.method === 'GET' && url.pathname === '/api/state') {
          json(res, 200, await gatherState());
        } else if (req.method === 'GET' && url.pathname === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ k: 'hello', at: Date.now() })}\n\n`);
          sseClients.add(res);
          req.on('close', () => sseClients.delete(res));
        } else if (req.method === 'POST' && url.pathname === '/api/ask') {
          const body = await readBody(req);
          json(res, 202, { accepted: true });
          void handleAsk(body);
        } else if (req.method === 'POST' && url.pathname === '/api/refresh') {
          const state = await gatherState();
          json(res, 200, state);
          broadcast({ k: 'state', state });
        } else {
          res.writeHead(404).end();
        }
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  const ping = setInterval(() => broadcast({ k: 'ping', at: Date.now() }), 25000);
  ping.unref?.();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  return { url: `http://${opts.host}:${opts.port}`, server };
}