#!/usr/bin/env node
/**
 * agentbd CLI —— P0 的可验证入口。
 *
 *   agentbd engines                       列出引擎
 *   agentbd doctor [engine...]            握手探测（升级后必跑）
 *   agentbd ask <engine> <prompt...>      单轮任务，流式打印统一事件
 *   agentbd sessions                      查看历史 transcript
 *
 * 用法示例：
 *   node src/cli.ts doctor
 *   node src/cli.ts ask gemini --cwd /tmp "用一句话说明 ACP 是什么"
 */

import { createInterface } from 'node:readline/promises';
import type * as acp from '@agentclientprotocol/sdk';
import { BUILTIN_ENGINES, findEngine } from './registry.ts';
import type { EngineSpec } from './registry.ts';
import { probe } from './doctor.ts';
import { runTurn } from './bus.ts';
import type { ApprovalMode } from './policy.ts';
import type { ApprovalRequest, NormalizedEvent } from './normalize.ts';
import { listTranscripts, resolveResume, aggregateStats } from './sessions.ts';
import {
  discover,
  probeService,
  lifecycle,
  tailLog,
  initManifest,
  saveHealthCache,
  loadManifest,
  aggregateLamp,
  SERVICES_FILE,
} from './services.ts';
import type { Health, ProbeLevel } from './services.ts';
import { scanMcp, toAcpMcpServers, MCP_SOURCES } from './mcphub.ts';
import { probeMcpEntry } from './mcpprobe.ts';
import type { McpProbeResult } from './mcpprobe.ts';
import { addMcp, removeMcp } from './mcpwrite.ts';
import type { McpWriteSpec } from './mcpwrite.ts';
import { startServer } from './server.ts';

type Flags = {
  cwd: string;
  json: boolean;
  approval: ApprovalMode;
  timeoutMs: number;
  quiet: boolean;
  probeLevel: ProbeLevel;
  withMcp: boolean;
  all: boolean;
  agents: string[];
  url?: string;
  port: number;
  host: string;
  resume?: string;
  _: string[];
};

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    cwd: process.cwd(),
    json: false,
    approval: 'guard',
    timeoutMs: 300000,
    quiet: false,
    probeLevel: 'l2',
    withMcp: false,
    all: false,
    agents: [],
    port: 7787,
    host: '127.0.0.1',
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--cwd') flags.cwd = argv[++i]!;
    else if (a === '--json') flags.json = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--auto') flags.approval = 'auto';
    else if (a === '--deny') flags.approval = 'deny';
    else if (a === '--guard') flags.approval = 'guard';
    else if (a === '--timeout') flags.timeoutMs = Number(argv[++i]!) * 1000;
    else if (a === '--l1') flags.probeLevel = 'l1';
    else if (a === '--l2') flags.probeLevel = 'l2';
    else if (a === '--l3') flags.probeLevel = 'l3';
    else if (a === '--with-mcp') flags.withMcp = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--agents')
      flags.agents = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--url') flags.url = argv[++i];
    else if (a === '--port') flags.port = Number(argv[++i]);
    else if (a === '--host') flags.host = argv[++i]!;
    else if (a === '--resume') {
      const v = argv[i + 1];
      if (v && !v.startsWith('-')) { flags.resume = v; i++; }
      else flags.resume = 'last';
    } else flags._.push(a);
  }
  return flags;
}

function shortCapabilities(caps: Record<string, unknown>): string {
  const keys: string[] = [];
  if (caps.loadSession) keys.push('loadSession');
  const sc = caps.sessionCapabilities as Record<string, unknown> | undefined;
  if (sc) keys.push(...Object.keys(sc).map((k) => `session.${k}`));
  const pc = caps.promptCapabilities as Record<string, unknown> | undefined;
  if (pc) keys.push(...Object.keys(pc).map((k) => `prompt.${k}`));
  if (caps.delegateToolsSupport) keys.push('delegateTools');
  return keys.length ? keys.join(' ') : '-';
}

/** 把统一事件渲染成人类可读的行 —— P1 的 UI 就是把这里换成组件 */
function renderEvent(ev: NormalizedEvent, opts: { json: boolean; quiet: boolean }): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(ev) + '\n');
    return;
  }
  switch (ev.k) {
    case 'msg.delta':
      if (!opts.quiet) process.stdout.write(ev.text);
      break;
    case 'thought.delta':
      if (!opts.quiet) process.stderr.write(`\x1b[2m${ev.text}\x1b[0m`);
      break;
    case 'tool.call':
      process.stderr.write(`\n\x1b[36m▸ ${ev.name} [${ev.kind}/${ev.status}] ${ev.title}\x1b[0m\n`);
      break;
    case 'tool.result':
      process.stderr.write(`\x1b[32m✔ ${ev.id} ${ev.ok ? 'ok' : 'failed'}\x1b[0m\n`);
      break;
    case 'plan':
      process.stderr.write(
        `\x1b[35m📋 计划: ${ev.steps.map((s) => `${s.status === 'done' ? '✔' : s.status === 'doing' ? '▶' : '·'}${s.title}`).join(' | ')}\x1b[0m\n`,
      );
      break;
    case 'notice':
      process.stderr.write(`\x1b[33m◆ ${ev.text}\x1b[0m\n`);
      break;
    case 'usage':
      process.stderr.write(`\x1b[2m用量 ${ev.used}/${ev.size} tokens${ev.costUsd ? ` · $${ev.costUsd}` : ''}\x1b[0m\n`);
      break;
    case 'session.info':
      break;
    case 'raw':
      if (!opts.quiet) process.stderr.write(`\x1b[2m[${ev.update}]\x1b[0m\n`);
      break;
    default:
      break;
  }
}

async function cmdEngines(): Promise<void> {
  console.log('id           vendor       channel        label');
  for (const e of BUILTIN_ENGINES) {
    console.log(`${e.id.padEnd(12)} ${e.vendor.padEnd(12)} ${e.channel.padEnd(14)} ${e.label}`);
  }
}

async function cmdDoctor(targets: string[], flags: Flags): Promise<void> {
  const specs: EngineSpec[] =
    targets.length > 0
      ? targets.map((t) => findEngine(t) ?? ({ id: t, label: t, vendor: 'custom', command: t, args: [], channel: 'acp' } as EngineSpec))
      : BUILTIN_ENGINES;

  const results = await Promise.all(specs.map((s) => probe(s, flags.cwd)));
  let bad = 0;
  for (const r of results) {
    const info = r.profile?.agentInfo;
    const head = `${r.ok ? '\x1b[32m✔ PASS\x1b[0m' : '\x1b[31m✘ FAIL\x1b[0m'} ${r.engine.padEnd(11)} ${String(r.ms).padStart(6)}ms`;
    console.log(`${head}  ${info?.name ?? ''} ${info?.version ?? ''}`);
    if (r.ok && r.profile) {
      console.log(`         caps: ${shortCapabilities(r.profile.capabilities)}`);
      const auth = r.profile.authMethods.map((m) => m.id).join(', ') || '(none)';
      console.log(`         auth: ${auth}`);
    } else {
      bad++;
      console.log(`         ${(r.error ?? '').split('\n').slice(0, 6).join('\n         ')}`);
    }
  }
  console.log(`\n${results.length - bad}/${results.length} 个引擎可用`);
  if (bad > 0) process.exitCode = 1;
}

async function askInteractive(req: ApprovalRequest): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `\n\x1b[33m⚠ ${req.risk} 风险操作需要授权\x1b[0m\n  工具: ${req.tool} (${req.kind})\n  描述: ${req.title}\n  输入: ${JSON.stringify(req.rawInput ?? {}).slice(0, 300)}\n  允许? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function cmdAsk(flags: Flags): Promise<void> {
  const [engineId, ...promptParts] = flags._;
  if (!engineId || promptParts.length === 0) {
    console.error('用法: agentbd ask <engine> <prompt...> [--cwd DIR] [--auto|--guard|--deny] [--json]');
    process.exitCode = 2;
    return;
  }
  const spec = findEngine(engineId);
  if (!spec) {
    console.error(`未知引擎: ${engineId}（可用: ${BUILTIN_ENGINES.map((e) => e.id).join(', ')}）`);
    process.exitCode = 2;
    return;
  }

  const interactive = flags.approval === 'guard' && process.stdin.isTTY === true;

  // 续接会话（P1 session/load）：cwd 以原会话为准，恢复目标来自 transcript
  let resume: { sessionId: string; cwd: string } | undefined;
  if (flags.resume) {
    const target = await resolveResume(spec.id, flags.resume);
    if (!target) {
      console.error(`未找到可恢复的会话: ${flags.resume}（用 \`agentbd sessions\` 查看，或先跑一轮 ask）`);
      process.exitCode = 2;
      return;
    }
    if (target.engine !== spec.id) {
      console.error(`该 session 属于 ${target.engine}，与引擎 ${spec.id} 不匹配（恢复不能跨引擎）`);
      process.exitCode = 2;
      return;
    }
    resume = { sessionId: target.sessionId, cwd: target.cwd };
    if (!flags.json && flags.cwd !== target.cwd) {
      process.stderr.write(`\x1b[2m[恢复] cwd 以原会话为准: ${target.cwd}（忽略 --cwd ${flags.cwd}）\x1b[0m\n`);
    }
  }
  const cwd = resume?.cwd ?? flags.cwd;

  let mcpServers: acp.McpServer[] | undefined;
  if (flags.withMcp) {
    const svcs = await Promise.all((await discover()).map(async (s) => ({ ...s, health: await probeService(s, 'l1') })));
    const entries = await scanMcp(svcs);
    mcpServers = toAcpMcpServers(entries);
    if (!flags.json) {
      const dead = entries.filter((e) => e.serviceLamp === 'red');
      process.stderr.write(`\x1b[2m[${spec.id}] 注入 ${mcpServers.length} 个 MCP server\x1b[0m\n`);
      if (dead.length) {
        process.stderr.write(`\x1b[33m⚠ 其中 ${dead.length} 个指向不可用的本地服务，将在会话里静默失败: ${dead.map((d) => d.name).join(', ')}\x1b[0m\n`);
      }
    }
  }
  if (!flags.json) {
    process.stderr.write(
      `\x1b[2m[${spec.id}] 会话开始 · cwd=${cwd} · 审批=${flags.approval}${interactive ? '(交互)' : ''}` +
        `${resume ? ` · 恢复=${resume.sessionId}` : ''}\x1b[0m\n`,
    );
  }

  try {
    const result = await runTurn({
      spec,
      cwd,
      prompt: promptParts.join(' '),
      resume,
      approval: interactive ? 'guard' : flags.approval,
      onAsk: interactive ? askInteractive : undefined,
      onEvent: (ev) => renderEvent(ev, { json: flags.json, quiet: flags.quiet }),
      timeoutMs: flags.timeoutMs,
      mcpServers,
    });

    if (flags.json) {
      process.stdout.write(JSON.stringify({ type: 'result', ...result }, null, 2) + '\n');
    } else {
      process.stderr.write(`\n\n\x1b[2m── stop=${result.stopReason} · ${result.durationMs}ms`);
      if (result.usage) process.stderr.write(` · in=${result.usage.inputTokens} out=${result.usage.outputTokens}`);
      if (result.costUsd !== undefined) process.stderr.write(` · $${result.costUsd}`);
      process.stderr.write(` · 审批 ${result.approvals.length} 次`);
      process.stderr.write(`\nsession=${result.sessionId}\ntranscript=${result.transcript ?? '-'}\x1b[0m\n`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function cmdSessions(): Promise<void> {
  const rows = await listTranscripts(20);
  if (rows.length === 0) {
    console.log('(还没有 transcript)');
    return;
  }
  for (const r of rows) {
    console.log(
      `${new Date(r.ts).toLocaleString()}  ${r.engine.padEnd(10)} ${String(r.sessionId).padEnd(38)} ${String(r.prompt).slice(0, 40)}`,
    );
  }
  console.log('\n续接: agentbd ask <engine> <prompt> --resume last（或上面的 sessionId）');
}

async function cmdStats(): Promise<void> {
  const s = await aggregateStats();
  if (s.scanned === 0) {
    console.log('(还没有 transcript)');
    return;
  }
  console.log(`扫描 ${s.scanned} 个 transcript · 共 ${s.total.turns} 轮 · ${s.total.tokens} tokens · $${s.total.costUsd.toFixed(4)}\n`);
  console.log('engine      轮次     tokens        成本        最近活动');
  for (const r of s.byEngine) {
    console.log(
      `${r.engine.padEnd(11)} ${String(r.turns).padStart(4)} ${String(r.tokens).padStart(12)} $${r.costUsd.toFixed(4).padStart(9)}  ${r.lastTs ? new Date(r.lastTs).toLocaleString() : '-'}`,
    );
  }
}

const LAMP_ICON: Record<string, string> = { green: '🟢', amber: '🟡', red: '🔴', unknown: '⚪' };

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return '未知';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}min`;
}

async function cmdServices(flags: Flags): Promise<void> {
  const sub = flags._[0] ?? 'list';

  if (sub === 'init') {
    const p = await initManifest();
    console.log(`已生成清单骨架: ${p}\n请手工校准 expectCmdline / l2.expect / l3（技能 §3.7b：声明必须实测过）`);
    return;
  }

  const list = await discover();

  if (sub === 'up' || sub === 'down' || sub === 'restart') {
    const key = flags._[1];
    const svc = list.find((s) => s.id === key) ?? list.find((s) => s.ports.includes(Number(key)));
    if (!svc) {
      console.error(`未找到服务: ${key}（用 \`agentbd services\` 看 id）`);
      process.exitCode = 2;
      return;
    }
    const r = await lifecycle(svc, sub);
    console.log(`${r.ok ? '✔' : '✘'} ${sub} ${svc.id}\n${r.detail}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'logs') {
    const key = flags._[1];
    const svc = list.find((s) => s.id === key) ?? list.find((s) => s.ports.includes(Number(key)));
    if (!svc) {
      console.error(`未找到服务: ${key}`);
      process.exitCode = 2;
      return;
    }
    console.log(await tailLog(svc, 40));
    return;
  }

  // list / probe
  const only = sub === 'probe' ? flags._[1] : undefined;
  const declared = new Set((await loadManifest()).services.map((x) => x.id));
  const targets = (only ? list.filter((s) => s.id === only || s.ports.includes(Number(only))) : list).filter(
    (s) => flags.all || declared.has(s.id) || (s.managed !== 'unmanaged' && s.ports.length > 0),
  );
  if (targets.length === 0) {
    console.log('(没有发现服务；先跑 `agentbd services init`)');
    return;
  }

  const results = await Promise.all(targets.map(async (s) => [s, await probeService(s, flags.probeLevel)] as const));
  const entries: Record<string, Health> = {};
  for (const [s, h] of results) entries[s.id] = h;
  await saveHealthCache(entries);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          level: flags.probeLevel,
          at: Date.now(),
          services: results.map(([s, h]) => ({ ...s, cmdline: s.cmdline?.slice(0, 200), health: h })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  console.log(`本地服务（探测级别 ${flags.probeLevel.toUpperCase()}）`);
  for (const [s, h] of results) {
    const port = s.ports.length ? s.ports.map((p) => `:${p}`).join(',') : '-';
    const mcpTag = s.mcp?.url ? ' [mcp]' : '';
    console.log(`${LAMP_ICON[h.lamp]} ${s.id.padEnd(34)} ${port.padEnd(14)} ${String(s.managed).padEnd(11)}${mcpTag}`);
    console.log(`     ${h.detail}`);
  }
  const agg = aggregateLamp(results.map(([, h]) => h));
  console.log(
    `\n汇总 ${LAMP_ICON[agg.lamp]} ${results.length} 个服务 · 结论年龄 ${fmtAge(agg.oldestMs)}（整体可信度由最陈旧数据决定）`,
  );
}

async function cmdMcp(flags: Flags): Promise<void> {
  const sub = flags._[0] ?? 'list';
  const arg = flags._[1];

  // —— 工具级探针：证明 MCP 协议真能说话（不是端口开着就算数）——
  if (sub === 'probe') {
    const probed = await Promise.all(
      (await discover()).map(async (s) => ({ ...s, health: await probeService(s, 'l1') })),
    );
    let entries = await scanMcp(probed);
    if (arg) entries = entries.filter((e) => e.name === arg);
    const results: McpProbeResult[] = await Promise.all(entries.map((e) => probeMcpEntry(e)));
    if (flags.json) {
      process.stdout.write(JSON.stringify({ at: Date.now(), results }, null, 2) + '\n');
      return;
    }
    if (results.length === 0) {
      console.log('(没有匹配的 MCP)');
      return;
    }
    console.log('MCP 工具级探针（initialize → tools/list）\n');
    for (const r of results) {
      const icon = r.ok ? '\x1b[32m✔' : r.skipped ? '\x1b[2m⊘' : '\x1b[31m✘';
      const tools = r.tools ?? [];
      console.log(`${icon} ${r.name.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${tools.length} tools\x1b[0m`);
      if (r.ok && tools.length) console.log(`      ${tools.slice(0, 8).join(', ')}${tools.length > 8 ? ' …' : ''}`);
      if (r.skipped) console.log(`      (${r.error})`);
      else if (!r.ok) console.log(`      ${r.error}`);
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`\n${okCount}/${results.length} 个 MCP 握手成功`);
    if (okCount < results.length) process.exitCode = 1;
    return;
  }

  // —— 写回：add 到各 agent 配置源（先备份，原子写）——
  if (sub === 'add') {
    const name = arg;
    const [command, ...rest] = flags._.slice(2);
    if (!name || (!flags.url && !command)) {
      console.error(
        '用法: agentbd mcp add <name> --url <url> [--agents claude,codex]\n      agentbd mcp add <name> <command...> [--agents claude,codex]',
      );
      process.exitCode = 2;
      return;
    }
    const agents = flags.agents.length ? flags.agents : ['claude', 'codex'];
    const spec: McpWriteSpec | undefined = flags.url
      ? { kind: 'http', url: flags.url, type: flags.url.includes('/sse') ? 'sse' : 'http' }
      : command
        ? { kind: 'stdio', command, args: rest }
        : undefined;
    if (!spec) return;
    const out = await addMcp(name, spec, agents);
    if (flags.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return;
    }
    for (const o of out) {
      const icon = o.action === 'absent' || o.action === 'skipped' ? '·' : '✔';
      console.log(`${icon} ${o.agent.padEnd(12)} ${o.action.padEnd(8)} ${o.detail ?? o.file}`);
    }
    return;
  }

  if (sub === 'remove') {
    const name = arg;
    if (!name) {
      console.error('用法: agentbd mcp remove <name> [--agents claude,codex]');
      process.exitCode = 2;
      return;
    }
    const out = await removeMcp(name, flags.agents);
    if (flags.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return;
    }
    if (out.length === 0) {
      console.log(`(所有配置源里都没有 ${name})`);
      return;
    }
    for (const o of out) console.log(`✔ ${o.agent.padEnd(12)} ${o.action} ${o.file}`);
    return;
  }

  // —— list（默认）——
  // 先做一次便宜的 L1 探测：MCP 的灯取决于它背后那个本地服务活没活
  const probed = await Promise.all(
    (await discover()).map(async (s) => ({ ...s, health: await probeService(s, 'l1') })),
  );
  const entries = await scanMcp(probed);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n');
    return;
  }
  if (entries.length === 0) {
    console.log('(没扫到任何 MCP 配置)');
    return;
  }
  console.log('统一 MCP 视图（同一目标只记一次，右侧是使用者）\n');
  for (const e of entries) {
    const link = e.serviceId ? ` → 服务 ${e.serviceId}${e.serviceLamp ? ` [${e.serviceLamp}]` : ''}` : '';
    console.log(`${e.name.padEnd(20)} ${e.transport.padEnd(5)} ${e.target.slice(0, 46).padEnd(48)} ${e.agents.join(',')}${link}`);
  }
  const local = entries.filter((e) => e.serviceId);
  const dead = local.filter((e) => e.serviceLamp === 'red');
  console.log(`\n共 ${entries.length} 个 MCP；其中 ${local.length} 个指向本地服务。`);
  if (dead.length) {
    console.log(`🔴 ${dead.length} 个 MCP 指向的服务当前不可用（这些 MCP 在任意 agent 里都会挂）：`);
    for (const d of dead) console.log(`   - ${d.name} → ${d.target}`);
  }
  console.log(`\n提示：\`agentbd ask <engine> --with-mcp ...\` 会把上面这份清单注入该引擎的会话（一份配置喂所有引擎）。`);
  console.log('子命令: `mcp probe` 工具级握手 · `mcp add/remove` 写回各 agent 配置');
}

async function cmdServe(flags: Flags): Promise<void> {
  try {
    const { url, server } = await startServer({ port: flags.port, host: flags.host });
    console.log(`agentbd 面板已启动: ${url}`);
    console.log('  GET  /            单页面板（引擎 + 服务灯 + MCP）');
    console.log('  GET  /events      SSE 事件流（含审批请求）');
    console.log('  GET  /api/state   聚合状态   POST /api/ask {engine,prompt,withMcp,resume}');
    console.log('  GET  /api/stats   用量看板   POST /api/approve {id,allow}  审批');
    console.log('  Ctrl+C 退出');
    const shutdown = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {}); // 常驻
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const HELP = `agentbd 0.1.0 —— 多 agent + 本地服务 统一总线（P0 总线 + 服务层 + MCP Hub；P1 面板/写回/agnes）
用法:
  【服务层】
  agentbd services [--l1|--l2|--l3] [--all] [--json]  本地服务健康（L1端口/L2接口/L3语义）；--all 含未声明的裸监听
  agentbd services init                        从现场发现生成清单骨架 ~/.agentbd/services.json
  agentbd services probe <id> [--l3]            单服务复测（L3 很贵，只手动触发）
  agentbd services up|down|restart <id>         生命周期（launchd 优先，未托管走 detached spawn）
  agentbd services logs <id>                    看服务日志尾部

  【MCP 接线】
  agentbd mcp [--json]                          统一 MCP 视图（跨所有 agent 去重 + 关联本地服务）
  agentbd mcp probe [name] [--json]             工具级探针（initialize → tools/list，stdio/http）
  agentbd mcp add <name> --url <url> [--agents a,b]   写回各 agent 配置（先备份 .agentbd.bak）
  agentbd mcp add <name> <command...> [--agents a,b]  同上（stdio 型）
  agentbd mcp remove <name> [--agents a,b]      从各 agent 配置移除

  【Web 面板（P1）】
  agentbd serve [--port 7787] [--host 127.0.0.1]       本地面板：服务灯 + MCP + ask（SSE 实时）
                                                       guard 高风险 → 页面内审批（/api/approve）

  【Agent 层】
  agentbd engines                               列出已注册引擎
  agentbd doctor [engine...]                    ACP 握手探测 + 能力报告
  agentbd ask <engine> <prompt...>              单轮任务（统一事件流）
        --cwd DIR / --guard|--auto|--deny / --json / --timeout N
        --with-mcp                            把 MCP Hub 的清单注入该引擎会话
        --resume [last|<sessionId>]           续接已有会话（session/load 恢复，cwd 取原会话）
  agentbd sessions                              历史 transcript
  agentbd stats                                 用量看板（轮次/tokens/成本，按引擎聚合）

引擎: ${BUILTIN_ENGINES.map((e) => e.id).join(', ')}
清单: ${SERVICES_FILE}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.shift() ?? 'help';
  const flags = parseArgs(argv);
  switch (cmd) {
    case 'engines':
      return cmdEngines();
    case 'doctor':
      return cmdDoctor(flags._, flags);
    case 'ask':
      return cmdAsk(flags);
    case 'sessions':
      return cmdSessions();
    case 'stats':
      return cmdStats();
    case 'services':
      return cmdServices(flags);
    case 'mcp':
      return cmdMcp(flags);
    case 'serve':
      return cmdServe(flags);
    default:
      console.log(HELP);
  }
}

await main();


