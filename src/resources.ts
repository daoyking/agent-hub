/**
 * 资源阈值守卫（B 项，2026-09-28）
 *
 * 为什么不用 load average（本机实测结论，别再走回头路）：
 * macOS 的 load average 把**不可中断（uninterruptible）线程**也计入，
 * 不只是 CPU 运行队列。本机实验：只跑 3 个忙循环，load 就冲到 76~90，
 * 而 8 核机器 load=8 才等价于「CPU 满载」。所以拿 load 除 nproc 做节流
 * 会在毫无压力的时候误刹车。实测空闲时段 loadavg 也常年 11~16，更没法用。
 *
 * 采用的指标（都实测过速度与输出）：
 * - CPU%：`os.cpus()` 的 times 差值。零子进程，300ms 窗口足够准。
 * - 内存压力：`memory_pressure -Q` → "System-wide memory free percentage: 87%"，
 *   实测仅 6ms。这是 macOS 自己的压力口径（含压缩/回收能力），
 *   比 os.freemem()（只算空闲页）贴近「还能不能开新进程」。
 * - swap：`sysctl -n vm.swapusage`。free% 高但 swap 快满时，新进程照样会卡死。
 */

import { cpus, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';

export type Level = 'ok' | 'warn' | 'critical';

export type ResourceSnapshot = {
  /** 0-100，全体核心平均繁忙度 */
  cpuPct: number;
  /** 0-100，memory_pressure 的「系统级空闲百分比」；越低越紧张 */
  memFreePct: number;
  /** 0-100，swap 已用比例；无 swap 时为 0 */
  swapUsedPct: number;
  cores: number;
  /** 每个指标的来源，便于出问题时报「数据是哪儿来的」 */
  via: { cpu: string; mem: string; swap: string };
  at: number;
};

export const THRESHOLDS = {
  cpu: { warn: 78, critical: 92 },
  memFree: { warn: 18, critical: 8 }, // 注意是「空闲%」，低于阈值才糟
  swapUsed: { warn: 85, critical: 96 },
};

type CpuTimes = { busy: number; idle: number };

function cpuTimes(): CpuTimes {
  let busy = 0;
  let idle = 0;
  for (const c of cpus()) {
    busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
    idle += c.times.idle;
  }
  return { busy, idle };
}

/** CPU 繁忙度：两次采样差值。windowMs 是采样窗口，太小会抖。 */
export function sampleCpu(windowMs = 300): Promise<number> {
  const a = cpuTimes();
  return new Promise((resolve) => {
    setTimeout(() => {
      const b = cpuTimes();
      const db = b.busy - a.busy;
      const di = b.idle - a.idle;
      const total = db + di;
      resolve(total > 0 ? Math.max(0, Math.min(100, (100 * db) / total)) : 0);
    }, windowMs);
  });
}

function run(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (_err, out) => resolve(out ?? ''));
  });
}

/** macOS 口径的内存压力（空闲百分比）。命令不可用时退回 os.freemem 口径。 */
export async function sampleMemFree(): Promise<{ pct: number; via: string }> {
  const out = await run('memory_pressure', ['-Q']);
  const m = /free percentage:\s*([\d.]+)%/i.exec(out);
  if (m) return { pct: Math.max(0, Math.min(100, parseFloat(m[1]!))), via: 'memory_pressure -Q' };
  return { pct: (100 * freemem()) / totalmem(), via: 'os.freemem 兜底（偏乐观）' };
}

/** swap 已用比例。没开 swap 时返回 0。 */
export async function sampleSwap(): Promise<{ pct: number; via: string }> {
  const out = await run('sysctl', ['-n', 'vm.swapusage']);
  const used = /used\s*=\s*([\d.]+)M/i.exec(out);
  const total = /total\s*=\s*([\d.]+)M/i.exec(out);
  if (used && total) {
    const t = parseFloat(total[1]!);
    if (t > 0) return { pct: Math.max(0, Math.min(100, (100 * parseFloat(used[1]!)) / t)), via: 'vm.swapusage' };
  }
  return { pct: 0, via: 'vm.swapusage（无 swap）' };
}

export async function sampleResources(windowMs = 300): Promise<ResourceSnapshot> {
  const [cpuPct, mem, swap] = await Promise.all([sampleCpu(windowMs), sampleMemFree(), sampleSwap()]);
  return {
    cpuPct,
    memFreePct: mem.pct,
    swapUsedPct: swap.pct,
    cores: cpus().length,
    via: { cpu: 'os.cpus 差值', mem: mem.via, swap: swap.via },
    at: Date.now(),
  };
}

export type Assessment = { level: Level; reasons: string[] };

/**
 * 纯函数：把读数翻译成等级。**故意不采样**，这样阈值可以拿合成数据
 * 做确定性单测，不必真把机器压满。
 * 等级取各指标里最糟的一个（守门宁可保守）。
 */
export function assess(r: Pick<ResourceSnapshot, 'cpuPct' | 'memFreePct' | 'swapUsedPct'>): Assessment {
  const reasons: string[] = [];
  let level: Level = 'ok';
  const bump = (l: Level) => {
    if (l === 'critical' || (l === 'warn' && level !== 'critical')) level = l;
  };

  if (r.cpuPct >= THRESHOLDS.cpu.critical) {
    bump('critical');
    reasons.push(`CPU ${r.cpuPct.toFixed(0)}% ≥ ${THRESHOLDS.cpu.critical}%`);
  } else if (r.cpuPct >= THRESHOLDS.cpu.warn) {
    bump('warn');
    reasons.push(`CPU ${r.cpuPct.toFixed(0)}% ≥ ${THRESHOLDS.cpu.warn}%`);
  }

  if (r.memFreePct <= THRESHOLDS.memFree.critical) {
    bump('critical');
    reasons.push(`内存空闲 ${r.memFreePct.toFixed(0)}% ≤ ${THRESHOLDS.memFree.critical}%`);
  } else if (r.memFreePct <= THRESHOLDS.memFree.warn) {
    bump('warn');
    reasons.push(`内存空闲 ${r.memFreePct.toFixed(0)}% ≤ ${THRESHOLDS.memFree.warn}%`);
  }

  if (r.swapUsedPct >= THRESHOLDS.swapUsed.critical) {
    bump('critical');
    reasons.push(`swap 已用 ${r.swapUsedPct.toFixed(0)}% ≥ ${THRESHOLDS.swapUsed.critical}%`);
  } else if (r.swapUsedPct >= THRESHOLDS.swapUsed.warn) {
    bump('warn');
    reasons.push(`swap 已用 ${r.swapUsedPct.toFixed(0)}% ≥ ${THRESHOLDS.swapUsed.warn}%`);
  }

  return { level, reasons };
}

/** 带 TTL 的缓存采样：面板 5s 轮询 /api/state，别每次都开 300ms 窗口。 */
const TTL_MS = 4000;
let cache: { snap: ResourceSnapshot; at: number } | null = null;
let inflight: Promise<ResourceSnapshot> | null = null;

export async function getResources(fresh = false): Promise<ResourceSnapshot> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.snap;
  inflight ??= (async () => {
    const snap = await sampleResources();
    cache = { snap, at: Date.now() };
    inflight = null;
    return snap;
  })();
  return inflight;
}

/** 采样 + 判定一步到位（面板 /api/state 与 ask 闸门共用，避免重复采样）。 */
export async function readAssessment(): Promise<ResourceSnapshot & Assessment> {
  const snap = await getResources();
  return { ...snap, ...assess(snap) };
}

/**
 * 脏页拆解：回答「swap 高到底是历史遗留还是在持续换页」。
 *
 * 只看 memory_free% 会得出错误结论——它把 inactive（可回收文件缓存）也算成空闲。
 * 真正回不去的是 active + wired + compressor；这三项加起来逼近物理内存，
 * 就说明 swap 高是算术必然，不是泄漏，也无法「清理」，只能减少常驻脏页或重启。
 */
export type MemBreakdown = {
  totalGb: number;
  /** vm_stat 的口径单位，别写死 16KB——它是按机器读的 */
  pageSize: number;
  activeGb: number;
  inactiveGb: number;
  wiredGb: number;
  compressorGb: number;
  freeGb: number;
  /** 压缩器里装了多少逻辑数据（远大于 compressorGb，说明压缩在替你扛） */
  compressedLogicalGb: number;
  /** 自启动累计换页次数；两端都大 = 正在持续换页，不是历史遗留 */
  swapins: number;
  swapouts: number;
};

export async function sampleMemBreakdown(): Promise<MemBreakdown> {
  const [out, pageSz, total] = await Promise.all([
    run('vm_stat', []),
    run('sysctl', ['-n', 'vm.page_size']),
    run('sysctl', ['-n', 'hw.memsize']),
  ]);
  const pageSize = parseInt(pageSz, 10) || 16384;
  const gb = (label: string) => {
    const m = new RegExp(`${label}:\\s*(\\d+)\\.`).exec(out);
    return m ? (parseInt(m[1]!, 10) * pageSize) / 1073741824 : 0;
  };
  const ctr = (label: string) => {
    const m = new RegExp(`${label}:\\s*(\\d+)`).exec(out);
    return m ? parseInt(m[1]!, 10) : 0;
  };
  return {
    totalGb: (parseInt(total, 10) || 0) / 1073741824,
    pageSize,
    activeGb: gb('Pages active'),
    inactiveGb: gb('Pages inactive'),
    wiredGb: gb('Pages wired down'),
    compressorGb: gb('Pages occupied by compressor'),
    freeGb: gb('Pages free'),
    compressedLogicalGb: gb('Pages stored in compressor'),
    swapins: ctr('Swapins'),
    swapouts: ctr('Swapouts'),
  };
}

export type MemConsumer = { name: string; rssMb: number; procs: number; pids: number[] };

/** 常见解释器：光看二进制名没用（一个 node 跑着十个不同脚本），要按脚本分。 */
const RUNTIMES = /^(node|node2[0-9]|deno|bun|bunx|python|python3(?:\.\d+)?|Python|ruby|perl|java|php)$/;

/**
 * 按 App / 脚本聚合的内存排行（RSS 合计）。
 *
 * 两个坑都踩过，别再改回去：
 * 1. 不能按进程看。Electron/Chrome 一个 App 就是十几个 helper，单看最大的只有
 *    几百 MB，加起来才是真凶。
 * 2. 不能用「argv[0] 的 basename」命名。macOS 路径里常有空格
 *    （`~/Library/Application Support/...`），按空白切第一个 token 会切成
 *    `.../Library/Application`，于是 MarvisKnowledgebase 等三个不相干的常驻件
 *    被并成一个假的 "Application" 桶（实测 2.6GB，排第一却认不出来是谁）。
 *    所以主名取 `comm`（内核记的可执行文件路径，没有参数歧义），
 *    解释器再用 command 里的脚本名细分（取尾段：路径前缀被空格截断也无所谓，
 *    basename 只要尾巴是对的就行）。
 */
export async function sampleTopMemory(limit = 14): Promise<MemConsumer[]> {
  const [commOut, cmdOut] = await Promise.all([
    run('ps', ['ax', '-o', 'rss=,pid=,comm='], 3000),
    run('ps', ['ax', '-o', 'pid=,command='], 3000),
  ]);
  const scriptByPid = new Map<number, string>();
  for (const line of cmdOut.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cmd = m[2]!;
    const app = /\/([^/]+)\.app\//.exec(cmd);
    if (app) {
      scriptByPid.set(parseInt(m[1]!, 10), app[1]!);
      continue;
    }
    // 解释器：用脚本名命名。允许路径含空格——只取以脚本后缀结尾的那一段的尾巴。
    const scr = /([^\s]+)\.(mjs|cjs|js|py)(?=\s|$)/.exec(cmd);
    if (scr) {
      const tail = cmd.split(/\s+/).filter((t) => /\.(mjs|cjs|js|py)$/.test(t)).pop() ?? scr[0]!;
      scriptByPid.set(parseInt(m[1]!, 10), tail.split('/').pop()!);
    }
  }

  const byName = new Map<string, MemConsumer>();
  for (const line of commOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const rssMb = parseInt(m[1]!, 10) / 1024;
    const pid = parseInt(m[2]!, 10);
    const comm = m[3]!.trim();
    const base = comm.split('/').pop() ?? comm;
    const app = /\/([^/]+)\.app\//.exec(comm);
    let name = app ? app[1]! : base;
    if (!app && RUNTIMES.test(base)) name = scriptByPid.get(pid) ?? `${base}（未识别脚本）`;

    const cur = byName.get(name) ?? { name, rssMb: 0, procs: 0, pids: [] };
    cur.rssMb += rssMb;
    cur.procs += 1;
    if (cur.pids.length < 3) cur.pids.push(pid);
    byName.set(name, cur);
  }
  return [...byName.values()]
    .map((c) => ({ ...c, rssMb: Math.round(c.rssMb) }))
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, limit);
}
