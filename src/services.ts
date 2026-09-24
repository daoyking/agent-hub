/**
 * 本地服务聚合层（Local Service Registry）。
 *
 * 方法论直接沿用你已有的 `local-service-lifecycle` 技能，全部落到代码里：
 *  - 三级健康探针：L1 TCP / L2 HTTP(+响应体校验) / L3 语义（昂贵，手动触发）
 *  - 假活判定：L1/L2 绿但 L3 红 → amber，绝不能显示绿
 *  - 端口归属校验：端口在听 ≠ 我们的服务在听（用完整 cmdline 匹配，判不了就放行）
 *  - 本地请求不走代理（Node fetch 默认不理 env 代理，天然满足）
 *  - L3 贵 → 不随启动自动全量跑（阿姆达尔定律：并行收益被最长探针限制）
 *  - 缓存必须带新鲜度，聚合年龄取最老那条
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const SERVICES_FILE = path.join(homedir(), '.agentbd', 'services.json');
const LAUNCH_AGENTS = path.join(homedir(), 'Library', 'LaunchAgents');
const UID = process.getuid?.() ?? 501;

export type Health = {
  l1: 'up' | 'down' | 'unknown';
  l2: 'ok' | 'fail' | 'skipped';
  l3: 'ok' | 'fail' | 'skipped';
  /** 综合灯：green 可用 / amber 假活或降级 / red 不可用 / unknown 未测 */
  lamp: 'green' | 'amber' | 'red' | 'unknown';
  detail: string;
  /** 结论年龄（毫秒）——聚合取最老，见技能 §3.5 */
  at: number;
  ms?: number;
};

export type LocalService = {
  id: string;
  label: string;
  /** launchd = 有 plist 且已加载；plist_only = 有 plist 未加载；unmanaged = 只有进程 */
  managed: 'launchd' | 'plist-only' | 'unmanaged';
  plist?: string;
  pid?: number;
  ports: number[];
  /** 完整命令行（不是 lsof 的进程名）——归属校验必须用它 */
  cmdline?: string;
  /** 归属校验期望的特征正则；缺失则"判不了就放行" */
  expectCmdline?: string;
  ownerMatched?: boolean;
  logPath?: string;
  mcp?: { url?: string; stdio?: string; name: string };
  l2?: { path: string; expect?: string; expectStatus?: number };
  l3?: { url?: string; expect?: string; timeoutMs?: number };
  notes?: string;
  health?: Health;
};

/** 已知服务的探测提示：端口 → L2 路径/期望体（可按实测校准） */
const L2_HINTS: Record<number, { path: string; expect?: string }> = {
  11434: { path: '/api/tags', expect: '"models"' },
  8001: { path: '/health' },
  18790: { path: '/health' },
  9010: { path: '/mcp' },
  8000: { path: '/api/health' },
  8080: { path: '/health' },
  3000: { path: '/api/health' },
};

export type Discovery = {
  plists: Array<{ label: string; args: string[]; logPath?: string; errPath?: string; runAtLoad: boolean; keepAlive: boolean; loaded: boolean }>;
  listeners: Array<{ pid: number; name: string; ports: number[]; cmdline: string }>;
};

async function lsofListeners(): Promise<Discovery['listeners']> {
  let out = '';
  try {
    ({ stdout: out } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { maxBuffer: 8 * 1024 * 1024 }));
  } catch (e) {
    // lsof 在有输出时也可能非 0 退出
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const byPid = new Map<number, { name: string; ports: Set<number> }>();
  let pid = 0;
  let name = '';
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0]!;
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') name = val;
    else if (tag === 'n') {
      const m = /:(\d+)$/.exec(val);
      if (m && pid) {
        const rec = byPid.get(pid) ?? { name, ports: new Set<number>() };
        rec.ports.add(Number(m[1]));
        byPid.set(pid, rec);
      }
    }
  }
  const listeners: Discovery['listeners'] = [];
  for (const [p, rec] of byPid) {
    listeners.push({ pid: p, name: rec.name, ports: [...rec.ports].sort((a, b) => a - b), cmdline: await cmdlineOf(p) });
  }
  return listeners;
}

/** 完整命令行 —— 技能 §3.0：进度特征要照完整命令行写，不能只用进程名 */
export async function cmdlineOf(pid: number): Promise<string> {
  try {
    const { stdout } = await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function plists(): Promise<Discovery['plists']> {
  const out: Discovery['plists'] = [];
  let files: string[] = [];
  try {
    files = (await readdir(LAUNCH_AGENTS)).filter((f) => f.endsWith('.plist'));
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(LAUNCH_AGENTS, f);
    try {
      const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', full]);
      const d = JSON.parse(stdout) as Record<string, unknown>;
      const label = String(d.Label ?? f.replace(/\.plist$/, ''));
      out.push({
        label,
        args: (d.ProgramArguments as string[]) ?? (d.Program ? [String(d.Program)] : []),
        logPath: d.StandardOutPath as string | undefined,
        errPath: d.StandardErrorPath as string | undefined,
        runAtLoad: Boolean(d.RunAtLoad),
        keepAlive: Boolean(d.KeepAlive),
        loaded: await launchdState(label),
      });
    } catch {
      // plist 解析失败不该拖垮整体（技能：doctor 类命令可能因无关小错整体中止）
    }
  }
  return out;
}

/** 读 launchd 状态是允许的；写（bootstrap）在 agent 侧会因不在 Aqua 会话而失败（技能 §2） */
export async function launchdState(label: string): Promise<boolean> {
  try {
    const { stdout } = await exec('launchctl', ['print', `gui/${UID}/${label}`], { maxBuffer: 4 * 1024 * 1024 });
    return /state = running|job state = running/.test(stdout);
  } catch {
    return false;
  }
}


// ─────────────────────────── 探测（三级） ───────────────────────────

export async function tcpProbe(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * L2：真发 HTTP 请求。
 * 技能 §3.8 的两类探针假活在这里被结构性排除：
 *  - 状态码与响应体分离取（不把 expect 当请求体发出去）
 *  - 计时从请求之前开始
 */
export async function httpProbe(
  url: string,
  opts: { expect?: string; expectStatus?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; ms: number; detail: string; body: string }> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const body = await res.text().catch(() => '');
    const ms = Date.now() - t0;
    let ok = true;
    let detail = `HTTP ${res.status}`;
    if (opts.expectStatus !== undefined && res.status !== opts.expectStatus) {
      ok = false;
      detail += ` ≠ 期望 ${opts.expectStatus}`;
    }
    if (ok && opts.expect) {
      try {
        if (!new RegExp(opts.expect).test(body)) {
          ok = false;
          detail += ` 响应体未匹配 /${opts.expect}/`;
        }
      } catch {
        // 正则编译失败 → 判不了就放行（技能 §3.8）
        detail += ' (expect 正则无效，已放行)';
      }
    }
    // 技能 §3.2：耗时 ≈ timeout ⇒ 是被砍，不是慢
    if (!ok && ms >= timeoutMs * 0.95) detail += ' ⚠耗时≈timeout，疑似被砍';
    return { ok, status: res.status, ms, detail, body: body.slice(0, 4000) };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.name : String(err);
    const cut = ms >= timeoutMs * 0.95;
    return { ok: false, status: 0, ms, detail: `${msg}${cut ? ' ⚠耗时≈timeout，疑似被砍' : ''}`, body: '' };
  }
}

export type ProbeLevel = 'l1' | 'l2' | 'l3';

export async function probeService(svc: LocalService, level: ProbeLevel): Promise<Health> {
  const at = Date.now();
  const port = svc.ports[0];
  const h: Health = { l1: 'unknown', l2: 'skipped', l3: 'skipped', lamp: 'unknown', detail: '', at };

  if (port === undefined) {
    h.detail = '未声明端口';
    return h;
  }
  const t0 = Date.now();
  const up = await tcpProbe(port);
  h.ms = Date.now() - t0;
  h.l1 = up ? 'up' : 'down';
  if (!up) {
    h.lamp = 'red';
    h.detail = `L1 ${port} 未监听`;
    return h;
  }

  // L1 通过还不够：先确认端口是"我们"在听（技能 §3.0）
  if (svc.expectCmdline && svc.cmdline !== undefined) {
    try {
      svc.ownerMatched = new RegExp(svc.expectCmdline).test(svc.cmdline);
      if (!svc.ownerMatched) {
        h.lamp = 'amber';
        h.detail = `端口 ${port} 被其它进程占用（cmdline 未匹配 /${svc.expectCmdline}/）`;
        return h;
      }
    } catch {
      svc.ownerMatched = undefined; // 判不了就放行
    }
  }

  if (level === 'l1') {
    h.lamp = 'green';
    h.detail = `L1 ${port} 在听`;
    return h;
  }

  const l2 = svc.l2 ?? L2_HINTS[port];
  if (!l2) {
    h.l2 = 'skipped';
    h.lamp = 'unknown';
    h.detail = `L1 在听，但未声明 L2 路径（假活风险未知）`;
    return h;
  }
  const url = /^https?:/.test(l2.path) ? l2.path : `http://127.0.0.1:${port}${l2.path.startsWith('/') ? '' : '/'}${l2.path}`;
  const r2 = await httpProbe(url, { expect: l2.expect, timeoutMs: 6000 });
  h.l2 = r2.ok ? 'ok' : 'fail';

  if (level === 'l2') {
    // 端口通但接口不答 = 假活 → amber（技能 §3）
    h.lamp = r2.ok ? 'green' : 'amber';
    h.detail = `L1 ${port} · L2 ${r2.detail} (${r2.ms}ms)`;
    return h;
  }

  // L3：语义探针很贵 → 只在显式要求时跑
  if (svc.l3?.url) {
    const r3 = await httpProbe(svc.l3.url, { expect: svc.l3.expect, timeoutMs: svc.l3.timeoutMs ?? 120000 });
    h.l3 = r3.ok ? 'ok' : 'fail';
    h.lamp = r3.ok ? 'green' : 'amber';
    h.detail = `L2 ${r2.detail} · L3 ${r3.detail} (${r3.ms}ms)`;
  } else {
    h.lamp = 'amber';
    h.detail = `L2 ${r2.detail} · L3 未声明（data_plane: unverified）`;
  }
  return h;
}

// ─────────────────────────── 发现与合并 ───────────────────────────

export async function discover(): Promise<LocalService[]> {
  const [pl, ls, man] = await Promise.all([plists(), lsofListeners(), loadManifest()]);
  const services = new Map<string, LocalService>();
  const claimed = new Set<number>();

  // ① launchd 作业 → 用 ProgramArguments 里的路径型 token 去完整 cmdline 找进程
  // 可执行文件（args[0]）足够具体时，只认它：防止参数里的路径 token（如
  // omh-menubar 的 --hermes-home /Users/jindy/.hermes）张冠李戴到别的服务进程上。
  const GENERIC_EXE = new Set(['/usr/bin/python3', '/usr/bin/env', '/bin/sh', '/bin/bash', '/bin/zsh']);
  for (const p of pl) {
    const tokens = p.args.filter((a) => a.length > 8 && a.includes('/'));
    const exe = p.args[0] ?? '';
    const exeSpecific = exe.length > 8 && exe.includes('/') && !GENERIC_EXE.has(exe);
    // 可执行文件具体但没匹配到 → 进程没在监听（不为别的端口认领）；只有通用 exe 才回退任意 token
    const hit = exeSpecific
      ? ls.find((l) => l.cmdline?.includes(exe))
      : ls.find((l) => l.cmdline && tokens.some((t) => l.cmdline.includes(t)));
    services.set(p.label, {
      id: p.label,
      label: p.label,
      managed: p.loaded ? 'launchd' : 'plist-only',
      plist: path.join(LAUNCH_AGENTS, `${p.label}.plist`),
      pid: hit?.pid,
      ports: hit?.ports ?? [],
      cmdline: hit?.cmdline,
      logPath: p.logPath,
    });
    if (hit) claimed.add(hit.pid);
  }

  // ② 其余监听进程 → unmanaged（技能 §5：未托管服务会反复死）
  for (const l of ls) {
    if (claimed.has(l.pid)) continue;
    services.set(`pid-${l.pid}`, {
      id: `pid-${l.pid}`,
      label: `${l.name} (pid ${l.pid})`,
      managed: 'unmanaged',
      pid: l.pid,
      ports: l.ports,
      cmdline: l.cmdline,
    });
  }

  // ③ 用户清单：按 id / 端口 覆盖或补充（探测配置、归属特征、MCP 绑定）
  for (const m of man.services) {
    const byId = m.id ? services.get(m.id) : undefined;
    const byPort = [...services.values()].find((s) => m.ports?.some((p) => s.ports.includes(p)));
    const target = byId ?? byPort;
    if (target) {
      // 清单是"身份/探针配置"的权威（稳定 id、label、expectCmdline、l2/l3）；
      // 现场是"运行时"的权威（pid、完整 cmdline、活着的端口）。
      const runtime = {
        pid: target.pid,
        cmdline: target.cmdline,
        ports: target.ports.length ? target.ports : (m.ports ?? []),
      };
      const managed = target.managed !== 'unmanaged' ? target.managed : (m.managed ?? 'unmanaged');
      const oldKey = target.id;
      Object.assign(target, m, runtime, { managed });
      if (oldKey !== target.id) services.delete(oldKey); // pid-49288 → ollama 这类改名要换 key
      services.set(target.id, target);
    } else if (m.ports?.length) {
      services.set(m.id!, { ...m, managed: m.managed ?? 'unmanaged' });
    }
  }

  return [...services.values()].sort((a, b) => (a.ports[0] ?? 99999) - (b.ports[0] ?? 99999));
}

/** 从现场发现生成一份可校准的清单骨架（技能 §3.7b：声明的动作必须实测过） */
const INTERESTING = /(ollama|litellm|browseros|codebuddy|hermes|openclaw|anythingllm|mcp|gateway|qoder|agnes|goose)/i;

export async function initManifest(): Promise<string> {
  const list = await discover();
  const existing = await loadManifest(); // 重新 init 不能冲掉手工校准/种子条目
  const services: LocalService[] = list
    .filter((s) => s.ports.length > 0)
    .filter(
      (s) =>
        s.managed !== 'unmanaged' ||
        s.ports.some((p) => !!L2_HINTS[p]) ||
        INTERESTING.test(`${s.label} ${s.cmdline ?? ''}`),
    )
    .map((s) => {
      const port = s.ports[0]!;
      const head = s.cmdline?.split(' ').slice(0, 2).join(' ') ?? '';
      const l2 = s.ports.map((p) => L2_HINTS[p]).find(Boolean);
      return {
        id: s.id,
        label: s.label,
        managed: s.managed,
        plist: s.plist,
        ports: s.ports,
        expectCmdline: head ? head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : undefined,
        logPath: s.logPath,
        l2: l2 ? { ...l2 } : undefined,
        notes: '',
      };
    });
  for (const old of existing.services) {
    if (!services.some((x) => x.id === old.id)) services.push(old);
  }
  await saveManifest({ services });
  return SERVICES_FILE;
}

// ─────────────────────────── 生命周期 ───────────────────────────

/**
 * 注意（技能 §2）：launchctl bootstrap 在 agent 侧几乎必失败
 * （"Bootstrap failed: 5: Input/output error" —— 调用进程不在 Aqua GUI 会话里）。
 * 因此失败时明确报告原因，不伪装成功。
 */
export async function lifecycle(
  svc: LocalService,
  action: 'up' | 'down' | 'restart',
): Promise<{ ok: boolean; detail: string }> {
  const tryExec = async (cmd: string, args: string[]) => {
    try {
      const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, detail: (stdout + stderr).trim().slice(0, 600) };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { ok: false, detail: (err.stderr || err.message || '').trim().slice(0, 600) };
    }
  };

  const down = async (): Promise<{ ok: boolean; detail: string }> => {
    if (svc.managed !== 'unmanaged') {
      const r = await tryExec('launchctl', ['kill', 'SIGTERM', `gui/${UID}/${svc.id}`]);
      if (r.ok) return { ok: true, detail: `launchctl kill SIGTERM → ${svc.id}` };
    }
    if (svc.pid) {
      try {
        process.kill(svc.pid, 'SIGTERM');
        return { ok: true, detail: `SIGTERM → pid ${svc.pid}` };
      } catch (e) {
        return { ok: false, detail: `kill 失败: ${(e as Error).message}` };
      }
    }
    return { ok: false, detail: '没有可用的停止手段（无 launchd 标签也无 pid）' };
  };

  const up = async (): Promise<{ ok: boolean; detail: string }> => {
    if (svc.managed !== 'unmanaged') {
      const r = await tryExec('launchctl', ['kickstart', '-k', `gui/${UID}/${svc.id}`]);
      if (r.ok) return { ok: true, detail: `launchctl kickstart → ${svc.id}` };
      if (svc.plist) {
        const b = await tryExec('launchctl', ['bootstrap', `gui/${UID}`, svc.plist]);
        if (b.ok) return { ok: true, detail: `launchctl bootstrap → ${svc.plist}` };
        return {
          ok: false,
          detail: `launchctl 两条路径均失败：${r.detail} | ${b.detail}\n（技能 §2：agent 侧 bootstrap 会因不在 Aqua GUI 会话被拒，需由 GUI 上下文执行）`,
        };
      }
      return { ok: false, detail: `launchctl kickstart 失败: ${r.detail}` };
    }
    if (!svc.cmdline) return { ok: false, detail: '未托管且没有启动命令（请在清单里补 cmdline/plist）' };
    // 未托管服务：detached + setsid，避免被调用会话回收（技能 §1）
    const { openSync } = await import('node:fs');
    const { spawn } = await import('node:child_process');
    const logDir = path.join(homedir(), '.agentbd', 'logs');
    await mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${svc.id.replace(/[^A-Za-z0-9._-]+/g, '_')}.log`);
    const fd = openSync(logFile, 'a');
    const child = spawn('/bin/sh', ['-lc', svc.cmdline], { detached: true, stdio: ['ignore', fd, fd], cwd: homedir() });
    child.unref();
    return { ok: true, detail: `已 detached 启动（新会话组），pid=${child.pid}, log=${logFile}` };
  };

  if (action === 'up') return up();
  if (action === 'down') return down();
  const d = await down();
  await new Promise((r) => setTimeout(r, 800));
  const u = await up();
  return { ok: u.ok, detail: `down: ${d.detail}\nup: ${u.detail}` };
}

export async function tailLog(svc: LocalService, lines = 30): Promise<string> {
  if (!svc.logPath) return '(未声明日志路径)';
  try {
    const { stdout } = await exec('tail', ['-n', String(lines), svc.logPath]);
    return stdout;
  } catch (e) {
    return `读取日志失败: ${(e as Error).message}`;
  }
}

// ─────────────────────── 健康缓存（必须带新鲜度） ───────────────────────

const HEALTH_CACHE = path.join(homedir(), '.agentbd', 'health.json');

/** 技能 §3.5：读取要防御式校验，任一条不合法整批丢弃；并按当前清单剪枝 */
export async function loadHealthCache(
  validIds: string[] = [],
): Promise<{ ageMs: number; entries: Record<string, Health> }> {
  try {
    const d = JSON.parse(await readFile(HEALTH_CACHE, 'utf8')) as { at: number; entries: Record<string, Health> };
    if (typeof d?.at !== 'number' || typeof d?.entries !== 'object' || d.entries === null) throw new Error('bad shape');
    const entries: Record<string, Health> = {};
    for (const [k, v] of Object.entries(d.entries)) {
      if (validIds.length && !validIds.includes(k)) continue; // 剪枝：删掉的服务不参与聚合
      if (v && typeof v.lamp === 'string' && typeof v.at === 'number') entries[k] = v;
      else throw new Error('bad entry');
    }
    return { ageMs: Date.now() - d.at, entries };
  } catch {
    return { ageMs: Number.POSITIVE_INFINITY, entries: {} };
  }
}

export async function saveHealthCache(entries: Record<string, Health>): Promise<void> {
  await mkdir(path.dirname(HEALTH_CACHE), { recursive: true });
  await writeFile(HEALTH_CACHE, JSON.stringify({ at: Date.now(), entries }, null, 2), 'utf8');
}

/** 聚合灯：整体可信度由最陈旧的数据决定（技能 §3.5） */
export function aggregateLamp(xs: Health[]): { lamp: Health['lamp']; oldestMs: number } {
  if (xs.length === 0) return { lamp: 'unknown', oldestMs: 0 };
  const oldestMs = Date.now() - Math.min(...xs.map((h) => h.at));
  if (xs.some((h) => h.lamp === 'red')) return { lamp: 'red', oldestMs };
  if (xs.some((h) => h.lamp === 'amber')) return { lamp: 'amber', oldestMs };
  if (xs.every((h) => h.lamp === 'green')) return { lamp: 'green', oldestMs };
  return { lamp: 'unknown', oldestMs };
}

// ─────────────────────────── 服务清单 ───────────────────────────

type Manifest = { services: LocalService[] };

export async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(SERVICES_FILE, 'utf8');
    const d = JSON.parse(raw) as Manifest;
    if (!Array.isArray(d.services)) throw new Error('bad shape');
    return d;
  } catch {
    return { services: [] };
  }
}

export async function saveManifest(m: Manifest): Promise<void> {
  await mkdir(path.dirname(SERVICES_FILE), { recursive: true });
  await writeFile(SERVICES_FILE, JSON.stringify(m, null, 2), 'utf8');
}
