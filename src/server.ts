/**
 * P1 Web UI 服务端 —— 127.0.0.1 本地面板。
 *
 * 事件模型与 CLI 完全同源（bus.runTurn → NormalizedEvent），
 * UI 只是把 `cli.renderEvent` 的 ANSI 行换成组件：
 *   GET  /            单页面板（src/ui.html，无构建步骤）
 *   GET  /api/state   引擎 + 服务灯 + MCP 清单（一次聚合）
 *   GET  /api/stats   用量看板（transcript 聚合：轮次/tokens/成本）
 *   GET  /events      SSE：状态刷新 + ask 回合的实时事件 + 审批请求
 *   POST /api/ask     {engine,prompt,cwd?,approval?,withMcp?,resume?} → runTurn
 *   POST /api/approve {id,allow} → 解除挂起的高风险审批（guard 模式）
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
import { resolveResume, aggregateStats } from './sessions.ts';
import { checkBudget } from './budget.ts';
import { notify } from './notify.ts';
import { machineName, loadTeamConfig } from './team.ts';
import type { TeamMachine } from './team.ts';
import { insertTeamReport, queryTeamReports } from './store.ts';
import type { LocalService } from './services.ts';
import type { NormalizedEvent } from './normalize.ts';
import type { ApprovalRequest } from './normalize.ts';

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

/**
 * Web 审批中心（P1）：guard 模式下高风险工具挂起 → SSE 广播 →
 * `POST /api/approve {id, allow}` 解除挂起。2 分钟无人响应按拒绝处理。
 */
type PendingAsk = {
  engine: string;
  req: ApprovalRequest;
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
};
let askSeq = 0;
const pendingAsks = new Map<string, PendingAsk>();

function askWeb(engine: string, req: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `a${++askSeq}`;
    const timer = setTimeout(() => {
      pendingAsks.delete(id);
      broadcast({ k: 'approval.timeout', id, engine });
      void notify('agentbd 审批超时', `${engine} · ${req.title || req.tool} · 2 分钟未响应已拒绝`, {
        tag: `approval-timeout:${engine}`,
        minIntervalSec: 120,
      });
      resolve(false);
    }, 120000);
    timer.unref?.();
    pendingAsks.set(id, {
      engine,
      req,
      resolve: (allow) => {
        clearTimeout(timer);
        pendingAsks.delete(id);
        resolve(allow);
      },
      timer,
    });
    broadcast({
      k: 'approval.request',
      id,
      engine,
      req: {
        tool: req.tool,
        kind: req.kind,
        title: req.title,
        risk: req.risk,
        rawInput: req.rawInput,
      },
    });
    // P2-2：审批挂起即通知（面板关着也能知道有决策在等），同引擎 30s 去抖
    void notify('agentbd 审批等待', `${engine} · ${req.risk}风险 · ${req.title || req.tool}`, {
      tag: `approval:${engine}`,
      minIntervalSec: 30,
    });
  });
}

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
  const cwd0 = typeof body.cwd === 'string' ? body.cwd : process.cwd();
  const approval = body.approval === 'auto' || body.approval === 'deny' ? body.approval : 'guard';

  // 续接会话：resume='last' 或字面 sessionId；cwd 以原会话为准（引擎按 cwd 归档）
  let cwd = cwd0;
  let resume: { sessionId: string; cwd: string } | undefined;
  if (typeof body.resume === 'string' && body.resume.trim()) {
    const target = await resolveResume(spec.id, body.resume.trim());
    if (!target) {
      broadcast({ k: 'ask.error', engine: spec.id, error: `未找到可恢复的会话: ${body.resume}（先跑一轮 ask 产生 transcript）` });
      return;
    }
    if (target.engine !== spec.id) {
      broadcast({ k: 'ask.error', engine: spec.id, error: `该 session 属于 ${target.engine}，与引擎 ${spec.id} 不匹配` });
      return;
    }
    resume = { sessionId: target.sessionId, cwd: target.cwd };
    cwd = target.cwd;
    broadcast({ k: 'notice', level: 'info', text: `恢复会话 ${target.sessionId} · cwd=${target.cwd}` });
  }

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
      resume,
      mcpServers,
      onAsk: (req) => askWeb(spec.id, req),
      onEvent: (ev: NormalizedEvent) => broadcast({ k: 'ask.event', engine: spec.id, ev }),
    });
    broadcast({ k: 'ask.done', engine: spec.id, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /Provider not set/.test(msg)
      ? 'agnes provider 未就绪：检查 ~/.agnes/config/config.yaml 的 active_provider 与 custom provider（README「agnes 接入」）'
      : '';
    broadcast({ k: 'ask.error', engine: spec.id, error: hint ? `${msg}\n${hint}` : msg });
  }
}

export async function startServer(opts: {
  port: number;
  host: string;
  /**
   * launchd socket activation（inetdCompatibility.Wait=true）：launchd 常驻持有监听
   * socket，首个连接到达才拉起本进程，并把监听 fd 放在 stdin（fd 0）——
   * 本进程用 listen({fd}) 接管，而不是自己绑端口。
   */
  activateFd?: number;
  /** 空闲自退：无活跃连接持续这么久就 exit(0)，launchd 会在下次连接时重新拉起 */
  idleExitMs?: number;
  /**
   * P2-4 团队 hub 模式：共享密钥。设置后所有 /api/* 与 /events 需
   * Authorization: Bearer <token>（/events 也接受 ?token=，EventSource 不能设头）。
   * 非回环绑定（--host 0.0.0.0）必须提供 token，否则拒绝启动。
   */
  token?: string;
}): Promise<{ url: string; server: Server }> {
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!LOOPBACK.has(opts.host) && !opts.token) {
    throw new Error(
      `绑定 ${opts.host} 是对局域网开放的，必须配 --token 共享密钥（团队 hub 模式）。` +
        `仅本机使用请保持默认 --host 127.0.0.1。`,
    );
  }
  const authed = (req: IncomingMessage, url: URL): boolean =>
    !opts.token ||
    req.headers.authorization === `Bearer ${opts.token}` ||
    url.searchParams.get('token') === opts.token;
  const uiHtml = await readFile(UI_FILE, 'utf8');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    void (async () => {
      try {
        if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
          if (!authed(req, url)) {
            json(res, 401, { error: 'unauthorized: 需要 Bearer token（agentbd serve --token）' });
            return;
          }
        }
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
        } else if (req.method === 'POST' && url.pathname === '/api/approve') {
          const body = await readBody(req);
          const id = String(body.id ?? '');
          const pending = pendingAsks.get(id);
          if (!pending) {
            json(res, 404, { error: `没有挂起的审批: ${id}` });
            return;
          }
          const allow = body.allow === true;
          pending.resolve(allow);
          json(res, 200, { decided: true, allow });
          broadcast({ k: 'approval.decided', id, engine: pending.engine, allow });
        } else if (req.method === 'POST' && url.pathname === '/api/report') {
          // P2-4 hub 侧：接收 spoke 用量上报（只有聚合数字，不含 prompt 原文）
          const body = await readBody(req);
          const entry = {
            machine: String(body.machine ?? 'unknown'),
            name: String(body.name ?? body.machine ?? 'unknown'),
            at: typeof body.at === 'number' ? body.at : Date.now(),
            today: (body.today ?? { turns: 0, tokens: 0, costUsd: 0 }) as TeamMachine['today'],
            month: (body.month ?? { turns: 0, tokens: 0, costUsd: 0 }) as TeamMachine['month'],
          } satisfies TeamMachine;
          await insertTeamReport(entry);
          json(res, 200, { stored: true });
        } else if (req.method === 'GET' && url.pathname === '/api/team') {
          // P2-4 hub 侧：全队视图 = 本机实时聚合 + 各 spoke 最新上报
          // （skipTeam：本 handler 若再走共享池检查会自指递归）
          const st = await checkBudget({ skipTeam: true });
          const self: TeamMachine = {
            machine: machineName(),
            name: (await loadTeamConfig()).name ?? machineName(),
            at: Date.now(),
            today: st.today,
            month: st.month,
          };
          const reports = (await queryTeamReports()) ?? [];
          json(res, 200, {
            machines: [self, ...reports.filter((r) => r.machine !== self.machine)],
            at: Date.now(),
          });
        } else if (req.method === 'GET' && url.pathname === '/api/stats') {
          json(res, 200, { ...(await aggregateStats()), budget: await checkBudget({ skipTeam: true }) });
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

  // P2-2 服务红灯 watcher：每 2 分钟 L1 探测一遍，灯色迁移时通知
  // （红 = 故障，红→绿 = 恢复也报一声）。低频 + unref，不挡空闲自退。
  // 注意：launchd 按需唤醒模式下 serve 空闲退出后 watcher 随之停止——
  // 要持续监控请常驻运行（agentbd serve，不装 plist）。
  const lampMem = new Map<string, string>();
  const svcWatch = setInterval(() => {
    void (async () => {
      try {
        const services = await discover();
        for (const s of services) {
          const h = await probeService(s, 'l1');
          const prev = lampMem.get(s.id);
          lampMem.set(s.id, h.lamp);
          if (prev === undefined) continue; // 首轮只建档，不通知
          if (h.lamp === 'red' && prev !== 'red') {
            void notify('agentbd 服务红灯', `${s.id} · ${h.detail}`.trim(), {
              tag: `svc:${s.id}`,
              minIntervalSec: 300,
            });
          } else if (h.lamp === 'green' && prev === 'red') {
            void notify('agentbd 服务恢复', `${s.id} 红灯转绿`, { tag: `svc:${s.id}`, minIntervalSec: 60 });
          }
        }
      } catch {
        /* watcher 失败静默，下轮再试 */
      }
    })();
  }, 120000);
  svcWatch.unref?.();

  // 空闲自退（launchd on-demand 配套）：无活跃连接持续 idleExitMs 就退出，
  // 监听 socket 仍在 launchd 手里，下次连接会自动拉起新进程。SSE 长连接算活跃。
  if (opts.idleExitMs && opts.idleExitMs > 0) {
    let active = 0;
    let lastActivity = Date.now();
    server.on('connection', (sock) => {
      active++;
      lastActivity = Date.now();
      sock.on('close', () => {
        active--;
        lastActivity = Date.now();
      });
    });
    const idleWatch = setInterval(() => {
      if (active === 0 && Date.now() - lastActivity >= opts.idleExitMs!) {
        process.exit(0);
      }
    }, Math.min(opts.idleExitMs, 30000));
    idleWatch.unref?.();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (opts.activateFd !== undefined) {
      server.listen({ fd: opts.activateFd }, () => resolve());
    } else {
      server.listen(opts.port, opts.host, () => resolve());
    }
  });
  const addr = server.address();
  const bound =
    addr && typeof addr === 'object'
      ? `http://${opts.host}:${addr.port}`
      : `http://${opts.host}:${opts.port}`;
  return { url: bound, server };
}