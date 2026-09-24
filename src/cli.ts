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
import { BUILTIN_ENGINES, loadEngines, findEngine, ENGINES_FILE } from './registry.ts';
import type { EngineSpec } from './registry.ts';
import { probe } from './doctor.ts';
import { runTurn } from './bus.ts';
import type { ApprovalMode } from './policy.ts';
import type { ApprovalRequest, NormalizedEvent, DiffEntry } from './normalize.ts';
import { listTranscripts, resolveResume, aggregateStats } from './sessions.ts';
import { loadBudget, saveBudget, checkBudget, hasAnyLimit, BUDGET_FILE } from './budget.ts';
import type { BudgetLimits } from './budget.ts';
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
import { probeMcpEntriesCached } from './mcpprobe.ts';
import type { McpProbeResult } from './mcpprobe.ts';
import { syncIndex, dbInfo, queryToolStats } from './store.ts';
import { addMcp, removeMcp } from './mcpwrite.ts';
import type { McpWriteSpec } from './mcpwrite.ts';
import { startServer } from './server.ts';
import { serveInstall, serveUninstall, serveStatus } from './serveinstall.ts';
import {
  TEAM_FILE,
  loadTeamConfig,
  saveTeamConfig,
  clearTeamConfig,
  fetchTeam,
  postReport,
  machineName,
} from './team.ts';
import type { TeamMachine } from './team.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

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
  noBudget: boolean;
  refresh: boolean;
  /** launchd socket activation 传入的监听 fd（serve 内部用） */
  fd?: number;
  /** serve 空闲自退分钟数 */
  idleMin: number;
  /** serve 团队 hub 模式的共享密钥（非回环绑定必填） */
  token?: string;
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
    noBudget: false,
    refresh: false,
    idleMin: 10,
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
    else if (a === '--no-budget') flags.noBudget = true;
    else if (a === '--refresh') flags.refresh = true;
    else if (a === '--fd') flags.fd = Number(argv[++i]);
    else if (a === '--idle') flags.idleMin = Number(argv[++i]);
    else if (a === '--token') flags.token = argv[++i];
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
/** 文件改动的 CLI 摘要：前缀/后缀裁剪的行级微 diff（红删绿增） */
function renderDiffSummary(d: DiffEntry): string {
  const oldLines = (d.oldText ?? '').split('\n');
  const newLines = d.newText.split('\n');
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  )
    suf++;
  const del = oldLines.slice(pre, oldLines.length - suf);
  const add = newLines.slice(pre, newLines.length - suf);
  const head = `\x1b[35m📝 ${d.path}  -${del.length}/+${add.length}\x1b[0m\n`;
  const body =
    del.map((l) => `\x1b[31m- ${l}\x1b[0m\n`).join('') + add.map((l) => `\x1b[32m+ ${l}\x1b[0m\n`).join('');
  return head + body;
}


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
      if (ev.diffs) for (const d of ev.diffs) process.stderr.write(renderDiffSummary(d));
      break;
    case 'tool.result':
      process.stderr.write(`\x1b[32m✔ ${ev.id} ${ev.ok ? 'ok' : 'failed'}\x1b[0m\n`);
      if (ev.diffs) for (const d of ev.diffs) process.stderr.write(renderDiffSummary(d));
      break;
    case 'terminal.create':
      process.stderr.write(`\x1b[33m$ ${ev.command} ${ev.args.join(' ')}\x1b[0m\x1b[2m · ${ev.cwd ?? ''}\x1b[0m\n`);
      break;
    case 'terminal.output':
      if (!opts.quiet) process.stderr.write(`\x1b[2m${ev.chunk}\x1b[0m`);
      break;
    case 'terminal.exit':
      process.stderr.write(`\x1b[2m[终端退出 code=${ev.exitCode ?? '-'}${ev.signal ? ` signal=${ev.signal}` : ''}]\x1b[0m\n`);
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
  for (const e of loadEngines()) {
    console.log(`${e.id.padEnd(12)} ${e.vendor.padEnd(12)} ${e.channel.padEnd(14)} ${e.label}`);
  }
}

async function cmdDoctor(targets: string[], flags: Flags): Promise<void> {
  const specs: EngineSpec[] =
    targets.length > 0
      ? targets.map((t) => findEngine(t) ?? ({ id: t, label: t, vendor: 'custom', command: t, args: [], channel: 'acp' } as EngineSpec))
      : loadEngines();

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
    console.error(`未知引擎: ${engineId}（可用: ${loadEngines().map((e) => e.id).join(', ')}）`);
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
      budget: flags.noBudget ? 'off' : undefined,
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

async function cmdStats(flags: Flags): Promise<void> {
  // —— 工具级调用统计（SQLite events 表 GROUP BY；含引擎自己接的 MCP 工具）——
  if (flags._[0] === 'tools') {
    await syncIndex();
    const rows = await queryToolStats();
    if (rows === null) {
      console.error('SQLite 不可用（需要 Node ≥ 22.13），无法做工具级统计');
      process.exitCode = 1;
      return;
    }
    if (rows.length === 0) {
      console.log('(还没有 tool.call 事件——先跑几轮 ask)');
      return;
    }
    console.log('工具级调用统计（按调用次数排序）\n');
    console.log('engine      工具                           调用   最近调用');
    for (const r of rows.slice(0, 50)) {
      console.log(
        `${r.engine.padEnd(11)} ${r.tool.padEnd(30)} ${String(r.calls).padStart(5)}  ${r.lastTs ? new Date(r.lastTs).toLocaleString() : '-'}`,
      );
    }
    return;
  }

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
  console.log('\n工具级: agentbd stats tools');
}

async function cmdDb(flags: Flags): Promise<void> {
  const sub = flags._[0] ?? 'info';
  if (sub === 'import') {
    // 显式全量导入（幂等）；日常读路径会自动增量索引，这条用于迁移验收
    const r = await syncIndex();
    const info = await dbInfo();
    console.log(
      `索引完成：新增 ${r.indexed} / 共 ${r.total} 个 jsonl → turns=${info.turns} events=${info.events}（${info.file}）`,
    );
    return;
  }
  if (sub !== 'info') {
    console.error(`未知子命令: ${sub}（可用: info / import）`);
    process.exitCode = 2;
    return;
  }
  const info = await dbInfo();
  if (flags.json) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  console.log(`SQLite 索引库: ${info.file}`);
  if (!info.available) {
    console.log('状态: 不可用（node:sqlite 需要 Node ≥ 22.13；读路径已自动降级 jsonl 扫描）');
    return;
  }
  console.log(`状态: 可用 · turns=${info.turns} · events=${info.events} · ${(info.bytes / 1024).toFixed(1)} KiB`);
  console.log('（jsonl 仍是写入源，本库是读模型；agentbd db import 可手动全量重建索引）');
}

async function cmdBudget(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'set') {
    const limits = await loadBudget();
    let n = 0;
    for (const kv of args.slice(1)) {
      const m = kv.match(/^(dailyUsd|monthlyUsd|dailyTokens|monthlyTokens|warnAt)=(\d+(?:\.\d+)?)$/);
      if (!m) {
        console.error(`无法识别: ${kv}（形如 dailyUsd=5 dailyTokens=100000 warnAt=0.8）`);
        process.exitCode = 2;
        return;
      }
      limits[m[1] as keyof BudgetLimits] = Number(m[2]);
      n++;
    }
    if (n === 0) {
      console.error('用法: agentbd budget set dailyUsd=5 dailyTokens=100000 warnAt=0.8');
      process.exitCode = 2;
      return;
    }
    await saveBudget(limits);
    console.log(`已保存 → ${BUDGET_FILE}`);
  } else if (sub === 'clear') {
    await saveBudget({});
    console.log('已清空全部限额');
  } else if (sub !== undefined) {
    console.error(`未知子命令: ${sub}（可用: set / clear，或不带参数查看）`);
    process.exitCode = 2;
    return;
  }

  const st = await checkBudget();
  if (!hasAnyLimit(st.limits)) {
    console.log('未设限额（agentbd budget set dailyTokens=100000 dailyUsd=5 …）');
  } else {
    console.log('限额:');
    if (st.limits.dailyTokens) console.log(`  今日 tokens   ≤ ${st.limits.dailyTokens}`);
    if (st.limits.dailyUsd) console.log(`  今日成本      ≤ $${st.limits.dailyUsd}`);
    if (st.limits.monthlyTokens) console.log(`  本月 tokens   ≤ ${st.limits.monthlyTokens}`);
    if (st.limits.monthlyUsd) console.log(`  本月成本      ≤ $${st.limits.monthlyUsd}`);
    console.log(`  告警阈值      ${Math.round((st.limits.warnAt ?? 0.8) * 100)}%`);
  }
  console.log(
    `用量: 今日 ${st.today.turns} 轮 · ${st.today.tokens} tok · $${st.today.costUsd.toFixed(4)}` +
      ` ｜ 本月 ${st.month.turns} 轮 · ${st.month.tokens} tok · $${st.month.costUsd.toFixed(4)}`,
  );
  for (const w of st.warnings) console.log(`\x1b[33m⚠ ${w}\x1b[0m`);
  for (const e of st.exceeded) console.log(`\x1b[31m✘ 超限: ${e}\x1b[0m`);
  if (st.exceeded.length > 0) console.log('（超限状态下 ask 会被拦截；--no-budget 可临时跳过）');
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
    const results: McpProbeResult[] = await probeMcpEntriesCached(entries, { refresh: flags.refresh });
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
      console.log(`${icon} ${r.name.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${tools.length} tools${r.cached ? '（缓存）' : ''}\x1b[0m`);
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

/* ------------------------------ P2-4 多机/团队 ------------------------------ */

const execAsync = promisify(execFile);

function parseKV(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i > 0) out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

function fmtTok(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function printTeamTable(machines: TeamMachine[]): void {
  console.log(`${'机器'.padEnd(18)} ${'今日 tokens'.padStart(12)} ${'今日成本'.padStart(10)} ${'本月 tokens'.padStart(12)}  最近上报`);
  let tToday = 0;
  let tMonth = 0;
  for (const m of machines) {
    tToday += m.today?.tokens ?? 0;
    tMonth += m.month?.tokens ?? 0;
    const ago = Math.round((Date.now() - m.at) / 60000);
    console.log(
      `${(m.name || m.machine).padEnd(18)} ${fmtTok(m.today?.tokens ?? 0).padStart(12)} ${('$' + (m.today?.costUsd ?? 0).toFixed(3)).padStart(10)} ${fmtTok(m.month?.tokens ?? 0).padStart(12)}  ${ago}min 前`,
    );
  }
  console.log(`${'─'.repeat(70)}\n${'合计'.padEnd(18)} ${fmtTok(tToday).padStart(12)} ${''.padStart(10)} ${fmtTok(tMonth).padStart(12)}`);
}

async function cmdTeam(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'join') {
    const hub = args[1];
    if (!hub?.startsWith('http')) throw new Error('用法: agentbd team join <http://hub:7787> token=… [name=…] [sharedDailyTokens=…]');
    const kv = parseKV(args.slice(2));
    const cfg = {
      hub: hub.replace(/\/+$/, ''),
      token: kv.token,
      name: kv.name ?? machineName(),
      sharedDailyTokens: kv.sharedDailyTokens ? Number(kv.sharedDailyTokens) : undefined,
      sharedMonthlyTokens: kv.sharedMonthlyTokens ? Number(kv.sharedMonthlyTokens) : undefined,
    };
    await fetchTeam(cfg.hub, cfg.token); // 先验证连通再落配置
    await saveTeamConfig(cfg);
    console.log(`已加入团队: hub=${cfg.hub} name=${cfg.name}`);
    if (cfg.sharedDailyTokens || cfg.sharedMonthlyTokens)
      console.log(`共享池限额: 今日 ${fmtTok(cfg.sharedDailyTokens ?? 0)} · 本月 ${fmtTok(cfg.sharedMonthlyTokens ?? 0)}（全队合计，超限在任意机器拦截）`);
    console.log('上报本机用量: agentbd team report（可挂 crontab 每小时跑）');
  } else if (sub === 'leave') {
    await clearTeamConfig();
    console.log('已退出团队（本地配置已删除）');
  } else if (sub === 'report') {
    const cfg = await loadTeamConfig();
    if (!cfg.hub) throw new Error('未加入团队（agentbd team join <hub> token=…）');
    const st = await checkBudget();
    const entry: TeamMachine = {
      machine: machineName(),
      name: cfg.name ?? machineName(),
      at: Date.now(),
      today: st.today,
      month: st.month,
    };
    await postReport(cfg.hub, cfg.token, entry);
    console.log(`已上报到 ${cfg.hub}: 今日 ${st.today.turns} 轮 / ${fmtTok(st.today.tokens)} tokens`);
  } else if (sub === 'list') {
    const cfg = await loadTeamConfig();
    if (cfg.hub) {
      const t = await fetchTeam(cfg.hub, cfg.token);
      printTeamTable(t.machines);
    } else {
      const { queryTeamReports } = await import('./store.ts');
      const st = await checkBudget();
      const self: TeamMachine = { machine: machineName(), name: cfg.name ?? machineName(), at: Date.now(), today: st.today, month: st.month };
      const reports = ((await queryTeamReports()) ?? []).filter((r) => r.machine !== self.machine);
      printTeamTable([self, ...reports]);
    }
    const b = await checkBudget();
    if (b.team) console.log(`共享池: 今日 ${fmtTok(b.team.todayTokens)} tokens · ${b.team.machines} 台机器`);
  } else if (sub === 'status') {
    const cfg = await loadTeamConfig();
    console.log(`配置: ${TEAM_FILE}${cfg.hub ? '' : '（未加入团队）'}`);
    if (cfg.hub) {
      console.log(`  hub=${cfg.hub} name=${cfg.name} token=${cfg.token ? '***已配置' : '（无）'}`);
      try {
        const t = await fetchTeam(cfg.hub, cfg.token);
        console.log(`  连通性: ✅ hub 在线，${t.machines.length} 台机器在册`);
      } catch (e) {
        console.log(`  连通性: ❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    console.log('用法: agentbd team join <hub> token=… | report | list | status | leave');
  }
}

/* ------------------------------ P2-3 桌面壳 ------------------------------ */

const SHELL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell');
const PANEL_APP = path.join(homedir(), 'Applications', 'agentbd-panel.app');

async function cmdPanel(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const exists = await access(PANEL_APP).then(() => true, () => false);
  const build = async (): Promise<void> => {
    console.log('编译 Swift WebView 壳（swiftc，约 30s）…');
    const { stdout } = await execAsync('bash', [path.join(SHELL_DIR, 'build.sh'), PANEL_APP]);
    process.stdout.write(stdout);
  };
  if (sub === 'build' || sub === 'install') {
    await build();
    console.log(`已生成: ${PANEL_APP}`);
    if (sub === 'install') {
      await execAsync('osascript', [
        '-e',
        `tell application "System Events" to make login item at end with properties {path:"${PANEL_APP}", hidden:false}`,
      ]);
      console.log('已加入登录项（开机自启，托盘常驻红绿灯）');
    }
    console.log('启动: open ~/Applications/agentbd-panel.app');
  } else if (sub === 'open') {
    if (!exists) await build();
    await execAsync('open', [PANEL_APP]);
  } else if (sub === 'uninstall') {
    await execAsync('osascript', [
      '-e',
      `tell application "System Events" to delete (every login item whose path is "${PANEL_APP}")`,
    ]).catch(() => {});
    const { rm } = await import('node:fs/promises');
    await rm(PANEL_APP, { recursive: true, force: true });
    console.log('已卸载桌面壳');
  } else {
    console.log(`App: ${exists ? PANEL_APP : '(未构建)'}`);
    if (exists) {
      try {
        const { stdout } = await execAsync('osascript', [
          '-e',
          'tell application "System Events" to get the name of every login item',
        ]);
        console.log(`登录项: ${stdout.includes('agentbd-panel') ? '✅ 已注册（开机自启）' : '未注册（agentbd panel install 注册）'}`);
      } catch {
        /* 查不到就跳过 */
      }
    }
    console.log('子命令: panel build（编译）· panel install（编译+登录项）· panel open · panel uninstall');
  }
}

async function cmdServe(flags: Flags): Promise<void> {
  // —— launchd 按需唤醒安装：不用时系统里没有 agentbd 进程 ——
  const sub = flags._[0];
  if (sub === 'install' || sub === 'uninstall' || sub === 'status') {
    try {
      if (sub === 'install') await serveInstall(flags.port, flags.idleMin, flags.host, flags.token);
      else if (sub === 'uninstall') await serveUninstall();
      else await serveStatus();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  try {
    const { url, server } = await startServer({
      port: flags.port,
      host: flags.host,
      activateFd: flags.fd,
      idleExitMs: flags.fd !== undefined ? flags.idleMin * 60_000 : undefined,
      token: flags.token,
    });
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
  agentbd mcp probe [name] [--json] [--refresh] 工具级探针（结果缓存 2min，--refresh 强制真探）
  agentbd mcp add <name> --url <url> [--agents a,b]   写回各 agent 配置（先备份 .agentbd.bak）
  agentbd mcp add <name> <command...> [--agents a,b]  同上（stdio 型）
  agentbd mcp remove <name> [--agents a,b]      从各 agent 配置移除

  【Web 面板（P1）】
  agentbd serve [--port 7787] [--host 127.0.0.1]       本地面板：服务灯 + MCP + ask（SSE 实时）
                                                       guard 高风险 → 页面内审批（/api/approve）
  agentbd serve install [--port 7787] [--idle 10]      launchd 按需唤醒：零常驻，开页面自动拉起
  agentbd serve uninstall / status                     卸载 / 查看安装状态
  agentbd panel build / install / open                 P2-3 桌面壳：Swift WKWebView + 托盘红绿灯

  【多机/团队（P2-4）】
  agentbd serve --host 0.0.0.0 --token <密钥>           hub 模式：LAN 可达 + Bearer 鉴权（必填）
  agentbd team join <http://hub:7787> token=… [name=…] [sharedDailyTokens=…]
                                                       spoke 加入团队（共享池限额可选）
  agentbd team report / list / status / leave          上报本机用量 / 全队视图 / 连通性 / 退出


  【Agent 层】
  agentbd engines                               列出已注册引擎
  agentbd doctor [engine...]                    ACP 握手探测 + 能力报告
  agentbd ask <engine> <prompt...>              单轮任务（统一事件流）
        --cwd DIR / --guard|--auto|--deny / --json / --timeout N
        --with-mcp                            把 MCP Hub 的清单注入该引擎会话
        --resume [last|<sessionId>]           续接已有会话（session/load 恢复，cwd 取原会话）
        --no-budget                           临时跳过预算护栏
  agentbd sessions                              历史 transcript
  agentbd stats                                 用量看板（轮次/tokens/成本，按引擎聚合，SQLite 索引）
  agentbd stats tools                           工具级调用统计（tool.call 事件 GROUP BY）
  agentbd db info / db import                   SQLite 索引库状态 / 手动全量重建索引（幂等）
  agentbd budget                                预算护栏：查看限额 + 今日/本月用量
  agentbd budget set dailyTokens=100000 dailyUsd=5 [monthlyTokens=… warnAt=0.8]
  agentbd budget clear                          清空限额

引擎: ${loadEngines().map((e) => e.id).join(', ')}
自定义引擎: ${ENGINES_FILE}（同 id 覆盖内置字段，新 id 追加）
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
      return cmdStats(flags);
    case 'budget':
      return cmdBudget(flags._);
    case 'db':
      return cmdDb(flags);
    case 'services':
      return cmdServices(flags);
    case 'mcp':
      return cmdMcp(flags);
    case 'serve':
      return cmdServe(flags);
    case 'team':
      return cmdTeam(flags._);
    case 'panel':
      return cmdPanel(flags._);
    default:
      console.log(HELP);
  }
}

await main();


