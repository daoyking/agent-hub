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
  l1: 'up' | 'down' | 'unknown' | 'stopped' | 'idle';
  l2: 'ok' | 'fail' | 'skipped';
  l3: 'ok' | 'fail' | 'skipped';
  /** 综合灯：green 可用 / amber 假活或降级 / red 不可用 / grey 已停止 / idle 无从探测 / unknown 未测 */
  lamp: 'green' | 'amber' | 'red' | 'unknown' | 'grey' | 'idle';
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
  /** launchd 调度特征：只有 KeepAlive 才有"本该常驻"的资格，其余按需/定时 */
  keepAlive?: boolean;
  runAtLoad?: boolean;
  /** StartInterval（秒）——有值说明是定时任务，不在跑属正常 */
  startIntervalSec?: number;
  l2?: { path: string; expect?: string; expectStatus?: number };
  l3?: { url?: string; expect?: string; timeoutMs?: number };
  notes?: string;
  health?: Health;
};

/** 已知服务的探测提示：端口 → L2 路径/期望体（可按实测校准） */
/**
 * 端口 → L2 健康路径的默认提示。**每一条都是实测出来的**（对目标端口实际
 * 发过请求确认 200），不是照抄"常见约定"——很多端口的 `/health` 根本不存在，
 * 填了只会把好好的服务误判成假活。
 *
 * 覆盖不了是正常的：2026-09-25 实测本机 39 个有端口的服务里，只有 6 个
 * 是 HTTP 服务且能探到健康端点（其余是 gRPC / WebSocket / 仅 TCP 监听 /
 * 本地 socket，HTTP 探测对它们没有意义）。**L2 不是"补全"任务，是给
 * 「已经是 HTTP 服务」的那些补一个更确定的判据。** 想加某端口就在这里加一行，
 * 前提是先 curl 验证过。
 */
const L2_HINTS: Record<number, { path: string; expect?: string }> = {
  11434: { path: '/api/tags', expect: '"models"' },   // ollama（实测）
  18790: { path: '/health' },                          // openclaw gateway（实测）
  8080: { path: '/health' },                           // proxy_server（实测）
  8001: { path: '/health' },                           // litellm gateway（实测，当前已停止）
  9010: { path: '/mcp' },                              // browseros-neo mcp
  8000: { path: '/api/health' },
  3000: { path: '/api/health' },
};

export type Discovery = {
  plists: Array<{ label: string; args: string[]; logPath?: string; errPath?: string; runAtLoad: boolean; keepAlive: boolean; startInterval?: number; loaded: boolean }>;
  listeners: Array<{ pid: number; name: string; ports: number[]; cmdline: string }>;
};

/**
 * 从完整 cmdline 猜一个人类可读的服务名。
 *
 * 为什么不直接显示 `pid-12345` 或 lsof 的 `c` 字段：lsof 的进程名只有
 * `python` / `node` / `java` 这种**解释器名**，毫无信息量（本机一半服务都是
 * python/node）；pid 更糟——重启就变，无法当稳定标识。所以这里从 cmdline 里
 * 抠出真正的应用名。
 *
 * 优先级（先具体后笼统）：
 *   1. launchd label（已在 discover 里覆盖，天然最准）
 *   2. .app 路径 → 应用名（/Applications/Ollama.app/… → Ollama）
 *   3. 脚本/入口文件名去扩展名（.../chroma → chroma）
 *   4. npm 包名（node_modules/@scope/pkg → pkg）
 *   5. 解释器名兜底（python / node），并显式标注"（解释器）"提示别当服务名
 */
export function friendlyName(exe: string, cmdline?: string): string {
  const line = cmdline ?? '';
  // ⓪ 包管理器 shim 要**最先**判：node_modules/.bin/<name> 里的 `<name>`
  //    才是服务名；先撞 node_modules 分支会拿到目录名 ".bin"（毫无意义）。
  const npx = line.match(/node_modules\/\.bin\/([^\/\s]+)/);
  if (npx?.[1]) return npx[1];
  const shim = line.match(/\/(?:\.local\/bin|\.bun\/bin|volta\/bin)\/([^\/\s]+)/);
  if (shim?.[1]) return shim[1];
  // ① .app → 应用名。注意 .app 名**可以含空格**（"TRAE SOLO CN.app"），
  //    所以匹配到路径分隔符/引号/空白为止，不能用 \S+。
  //    排除**框架/运行时自带的伪 .app**——它们不是服务，是解释器的马甲：
  //      Python.app（CPython.framework 内）、Electron/Chromium/…/Helper.app
  const app = line.match(/([^\/\\"']+?)\.app(?=\/|[\s"']|$)/);
  if (app?.[1]?.trim()) {
    const n = app[1].trim();
    const RUNTIME = /^Python(\.framework)?$|^Electron(\.framework)?$|^Chromium$|^Node$|^OpenSSL$|^Perl$|^Ruby$/i;
    if (!RUNTIME.test(n)) return n;
  }
  // ② node_modules 包名（取 scope 后一段）
  const pkg = line.match(/node_modules\/(?:@[^/]+\/)?([^/\s]+)/);
  if (pkg?.[1]) return pkg[1];
  // ③ python -m module / uvicorn app:app
  const mod = line.match(/(?:^|\s)-m\s+([\w.]+)/) ?? line.match(/(?:^|\s)([\w-]+):[\w-]+\s*$/);
  if (mod?.[1]) return mod[1];
  // ④ 入口脚本名：带扩展名的绝对/相对路径。文件名是 index/main/cli 这类通用名时
  //     **上溯到父目录**取名（`packages/server/src/index.ts` → "server"），
  //     比回退到 "node（解释器）" 有信息量得多。
  const script =
    line.match(/(?:^|\s|\/)([^\/\s:]+\.(?:js|mjs|cjs|ts|py|sh))(?=\s|$)/) ??
    line.match(/(?:^|\s)((?:[^\/\s:]+\/)+[^\/\s:]+\.(?:js|mjs|cjs|ts|py|sh))(?=\s|$)/);
  let sawScriptFile = false;
  if (script?.[1]) {
    sawScriptFile = true;
    const file = script[1];
    if (!/^(index|main|cli|app|run|start|__main__|mod)(\.[a-z]+)?$/.test(file)) {
      return file.replace(/\.[^.]+$/, '');
    }
    // 通用文件名（index/main/cli…）→ 从 cmdline 里找回**完整的**那个 token 再上溯目录。
    // （上面的正则只捕获了 basename，目录信息在这里是拿不到的。）
    const full = line.split(/\s+/).find((t) => t.endsWith(file)) ?? file;
    if (full.includes('/')) {
      const dir = full.split('/');
      // 上溯找第一个"有信息量"的目录名：跳过 src/lib/dist/build/bin 等结构目录。
      // 但**不能越过家目录边界**——/Users/j/x/src/index.js 里的 "x" 跟服务身份无关，
      // 报 "x" 比老实报 "node（解释器）" 更误导：候选段必须位于 /Users/<name> 或
      // /home/<name> 之下才认。
      const SKIP = new Set(['.', '..', 'src', 'lib', 'dist', 'build', 'bin', 'out', 'packages', 'node_modules']);
      const homeIdx = dir.findIndex((d) => d.toLowerCase() === 'users' || d.toLowerCase() === 'home');
      // home/<name>/ 之下才算项目空间；再往上的首层（~/x）仍是用户目录，没信息量
      const minIdx = homeIdx >= 0 ? homeIdx + 3 : 0;
      for (let i = dir.length - 2; i >= minIdx; i--) {
        const seg = dir[i]!;
        if (!seg || SKIP.has(seg.toLowerCase())) continue;
        return seg;
      }
    } else if (file !== full) {
      // 多级相对路径：packages/server/src/index.ts → 取第一级
      return file.replace(/\.[^.]+$/, '');
    }
    // 单级相对路径（src/cli.ts）：目录全是 SKIP 里的结构目录，没法上溯。
    // 这种��况宁可报文件名（cli）也不要回退成 "node"——后者信息量为零。
    // 注意只对**相对路径**这么宽松：/Users/j/x/src/index.js 上溯失败是另一回事，
    // 那里报 "index" 仍不如老实说"没名字"。
    if (!full.startsWith('/')) return file.replace(/\.[^.]+$/, '');
  }
  // ④b 解释器之后的**可执行脚本**（`.../bin/python /x/chroma`）。
  //     要在**整个 cmdline 里**找第二个及以后的绝对路径（第一个是解释器本身），
  //     且末尾不能是 bin/xxx（那还是解释器，不是被解释的脚本）。
  //     注意：④ 已经处理过的入口脚本不要再捡一次（否则 /x/src/index.js 会被
  //     当成"可执行脚本"报成 index.js，绕过了④里的目录上溯判断）。
  const parts = line.split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.startsWith('/') || p.includes('=')) continue;
    if (sawScriptFile && p.endsWith(script![1]!)) continue;
    if (/(?:^|\/)(?:bin|sbin)\/[^/]+$/.test(p)) continue;
    return p.split('/').pop() || p;
  }

  // ⑤ 解释器兜底：裸 python/node/java 无法推断真实服务，如实标注而不是假装有名字。
  //    注意只有**整个 cmdline 就是解释器**（没带脚本）才算解释器；
  //    "node /x/whatever.js" 的服务名是 whatever.js，不是 node。
  const base = (exe.split('/').pop() ?? exe).trim();
  const INTERPRETER = /^(python[\d.]*|node|java|perl|ruby|php|dotnet|mono)$/i;
  if (INTERPRETER.test(base) && !/\.(?:js|mjs|cjs|ts|py|sh)(?=\s|$)/.test(line)) {
    return `${base}（解释器）`;
  }
  return base || 'unknown';
}

/**
 * lsof 的 `-F` 输出把非 ASCII 字节转义成 `\xNN`（中文/emoji 应用名会变成
 * 一串 `M-fM-5M-.M-eM-<M^U` 这样的乱码，ps 也有同样问题）。这里还原成 UTF-8。
 */
function unescapeLsof(s: string): string {
  if (!s.includes('\\x')) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'x') {
      const hex = s.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    // 非转义段按 UTF-8 字节并入
    for (const b of Buffer.from(s[i]!, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

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
    else if (tag === 'c') name = unescapeLsof(val);
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
    // LC_ALL/LANG 必须是 UTF-8：ps 在非 UTF-8 locale（如 LANG=zh_CN.GBK）
    // 下会把非 ASCII 字节转义成 \xNN，中文应用名就成了 M-fM-5M-.M-eM-<M^U。
    const { stdout } = await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
    return unescapeLsof(stdout.trim());
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
        startInterval: typeof d.StartInterval === 'number' ? d.StartInterval : undefined,
        loaded: await launchdState(label),
      });
    } catch {
      // plist 解析失败不该拖垮整体（技能：doctor 类命令可能因无关小错整体中止）
    }
  }
  return out;
}

/** 读 launchd 状态是允许的；写（bootstrap）在 agent 侧会因不在 Aqua 会话而失败（技能 §2） */
/**
 * 该 launchd label 是否**已注册**到当前用户的 gui 域。
 *
 * 踩过的坑：早先这里判断的是 `state = running`，即"当前进程是否在跑"，
 * 把「已注册但空闲」误判成「未注册」。后果是 `managed` 变成 plist-only，
 * 于是 lamp 判成 ⚫ 已停止——**掩盖真故障**：实测 v2ray-core（KeepAlive=false）
 * 注册着但进程不在 = 代理其实挂了，却显示成"你自己停的"。
 *
 * 现在以 `launchctl print` **是否成功**为准（能 print 出 path = 就已注册），
 * 运行与否交给健康探针去判——两件事分开。
 */
export async function launchdState(label: string): Promise<boolean> {
  try {
    await exec('launchctl', ['print', `gui/${UID}/${label}`], { maxBuffer: 4 * 1024 * 1024 });
    return true; // 能 print 出来 = 已注册（不管此刻在不在跑）
  } catch {
    return false; // "Could not find service" = 压根没注册
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

/** 进程存活探针：无端口服务（如菜单栏 UI）用 expectCmdline 在 ps 里找活口 */
async function processAlive(expectCmdline: string): Promise<boolean | undefined> {
  try {
    const re = new RegExp(expectCmdline);
    // 排除自身祖先链：调用方 shell 的 argv 里可能恰好含着 pattern（false positive）
    const skip = new Set<number>([process.pid]);
    let pp = process.ppid;
    for (let i = 0; i < 8 && pp > 1; i++) {
      skip.add(pp);
      const { stdout: ppo } = await exec('ps', ['-o', 'ppid=', '-p', String(pp)]);
      pp = parseInt(ppo.trim(), 10) || 1;
    }
    const { stdout } = await exec('ps', ['-wwaxo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.split('\n').some((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      return !!m && !skip.has(Number(m[1])) && re.test(m[2]);
    });
  } catch {
    return undefined; // 判不了就放行
  }
}

/**
 * 按服务分档选择探测级别。
 *
 * 为什么不能面板统一开 L2：L2 需要**声明探测路径**（manifest 的 l2 或
 * L2_HINTS 里的端口默认值），没声明的服务会被判成 `unknown`（"假活风险未知"）——
 * 那个判断对 `services --l2` 这种显式命令是对的，但对面板是噪音：本机 45 个
 * 服务只有 5 个配了 l2，统一开 L2 会让 28 个服务从 🟢 掉到 ⚪，**把真故障
 * 淹在里面**。
 *
 * 所以：声明了 l2 路径的升到 L2（能抓"端口在听但应用已死"的假活），
 * 其余保持 L1。实测两档并发都在 1s 左右，成本可接受。
 */
export function probeLevelFor(svc: LocalService): ProbeLevel {
  const port = svc.ports[0];
  const declared = !!svc.l2 || (port !== undefined && !!L2_HINTS[port]);
  return declared ? 'l2' : 'l1';
}

/** 按分档探测全部服务（面板/托盘用） */
export async function probeAll(list: LocalService[]): Promise<LocalService[]> {
  return Promise.all(list.map(async (s) => ({ ...s, health: await probeService(s, probeLevelFor(s)) })));
}

/**
 * 「已注册但进程不在」到底算不算故障——看 launchd 的**调度意图**。
 *
 * 实测（本机 5 个）：只有 KeepAlive=true 才意味着"本该常驻却没在跑"= 真故障。
 * 其余都是正常空闲：
 *   - StartInterval=3600/21600（GoogleUpdater / CleanMyMac Updater）→ 定时唤醒
 *   - RunAtLoad=false（hermes maintenance）→ 按需跑
 *   - 两者皆无（v2ray-core，KeepAlive=false）→ 用户想用时才起
 * 不区分就报红，等于**每台机器常驻 4 个假故障**——狼来了，灯就不敢信了。
 *
 * 返回 grey（非故障，detail 里说明为什么）或 red（真故障）。
 */
function notRunningVerdict(svc: LocalService): { lamp: 'grey' | 'red'; detail: string } {
  const unregistered = svc.managed === 'plist-only';
  if (unregistered) {
    return { lamp: 'grey', detail: 'plist 存在但未 launchctl load（已停止）' };
  }
  if (svc.keepAlive) {
    return { lamp: 'red', detail: 'KeepAlive=true 应当常驻，进程却不在（真故障）' };
  }
  if (svc.startIntervalSec) {
    const h = Math.round(svc.startIntervalSec / 360) / 10;
    return { lamp: 'grey', detail: `定时任务（每 ${h}h 唤醒），当前不在属正常` };
  }
  if (!svc.runAtLoad) {
    return { lamp: 'grey', detail: '按需运行（无 RunAtLoad/KeepAlive），不在属正常' };
  }
  return { lamp: 'grey', detail: 'RunAtLoad 启动后已退出（可能脚本跑完），非故障' };
}

export async function probeService(svc: LocalService, level: ProbeLevel): Promise<Health> {
  const at = Date.now();
  const port = svc.ports[0];
  const h: Health = { l1: 'unknown', l2: 'skipped', l3: 'skipped', lamp: 'unknown', detail: '', at };

  if (port === undefined) {
    // 无端口服务：有 expectCmdline 就退化为进程存活探针。
    // 与有端口分支**同一套判据**（之前这里漏了 grey，导致 plist-only 的守护型
    // 服务进程不在时一律报红，与"已停止"的语义打架）：
    //   进程在 → 🟢；进程不在 + plist-only（launchd 没加载）→ ⚫ 已停止；
    //   进程不在 + launchd（加载了却没进程）→ 🔴 真故障。
    if (svc.expectCmdline) {
      const alive = await processAlive(svc.expectCmdline);
      if (alive !== undefined) {
        if (alive) {
          h.l1 = 'up';
          h.lamp = 'green';
          h.detail = `进程存活（/${svc.expectCmdline}/ 匹配）· 无端口，无 L2 可探`;
        } else {
          const v = notRunningVerdict(svc);
          h.l1 = v.lamp === 'red' ? 'down' : 'stopped';
          h.lamp = v.lamp;
          h.detail = v.lamp === 'red' ? v.detail : `${v.detail}；/（${svc.expectCmdline}）无匹配`;
        }
        return h;
      }
    }
    // 无端口、也没配 expectCmdline → **无从探测**（不是"没测"，是"没法测"）。
    // 典型：纯 launchd 标签条目（dsh-web / alt-tab-macos / v2ray-core 这类守护型，
    // 不对外开端口，init 生成的骨架也没带 expectCmdline）。标成 idle 以区别于
    // 真正的 unknown，避免"⚪"既代表已停止又代表无从探测。
    h.l1 = 'idle';
    h.lamp = 'idle';
    h.detail = '无端口且未声明 expectCmdline（无从探测）';
    return h;
  }
  const t0 = Date.now();
  const up = await tcpProbe(port);
  h.ms = Date.now() - t0;
  h.l1 = up ? 'up' : 'down';
  if (!up) {
    // 「已停止」和「不健康」是两回事，混为一谈会让历史条目永远挂红灯：
    //  - plist-only：plist 在，但 launchd **没加载**它 → 服务本来就没在跑
    //    （比如换机器、主动 unload、或这个服务你已经不用了）→ grey 已停止
    //  - launchd：加载了却不监听 → 真的坏了/崩了 → red
    //  - unmanaged：没有 plist 可依据，无从判断是"停"还是"崩" → 保持 red
    const v = notRunningVerdict(svc);
    h.l1 = v.lamp === 'red' ? 'down' : 'stopped';
    h.lamp = v.lamp;
    h.detail = `L1 ${port} 未监听 · ${v.detail}`;
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
      keepAlive: p.keepAlive || undefined,
      runAtLoad: p.runAtLoad || undefined,
      startIntervalSec: p.startInterval,
      pid: hit?.pid,
      ports: hit?.ports ?? [],
      cmdline: hit?.cmdline,
      logPath: p.logPath,
    });
    if (hit) claimed.add(hit.pid);
  }

  // ② 其余监听进程 → unmanaged（技能 §5：未托管服务会反复死）
  //    id 用 pid 保持唯一（进程重启后会变，manifest 才能重新认领），
  //    但 label 给人类可读的名字——面板显示 label，不显示 pid-xxxx。
  for (const l of ls) {
    if (claimed.has(l.pid)) continue;
    const name = friendlyName(l.name, l.cmdline);
    services.set(`pid-${l.pid}`, {
      id: `pid-${l.pid}`,
      label: name,
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

/**
 * `services init` 要写进清单的筛选。
 *
 * 曾经这里是**白名单**（INTERESTING = ollama|litellm|hermes|… 的硬编码正则），
 * 白名单外的服务被静默丢弃——和面板/CLI 当初的过滤 bug 是同一个病：
 * 「用户看不见 ⇒ 等于不存在」。本机实测 39 个只写进 8 个。
 *
 * 现在反过来：**默认全量写入**，只排除明确的系统噪音（rapportd / ControlCenter
 * 这类开机自启、跟开发无关的）。这样清单 = 「我本机在跑什么」的如实快照，
 * 而不是「我恰好记得住的几个」。
 */
const SYSTEM_NOISE =
  /^(rapportd|ControlCe|ControlCenter|logioptio|logioptionsplus_agent|WeChat|mDNSResponder|distnoted|cfprefsd|sharingd|WiFiAgent|secd|handoffd|airportd|powerd|diskarbitrationd|trustd|securityd|opendirectoryd|notifyd|coredeletiond|lsd|backupd|cloudphotod|photolibraryd|mediaanalysisd|corespotlightd|knowledge-agent|Spotlight|NotificationCenter|Dock|Finder|SystemUIServer)$/i;

export async function initManifest(): Promise<string> {
  const list = await discover();
  const existing = await loadManifest(); // 重新 init 不能冲掉手工校准/种子条目
  const services: LocalService[] = list
    // 无端口的**托管**服务也写进来（launchd 守护型：dsh-web / alt-tab-macos 这类
    // 它们靠进程存活而非端口对外服务）。只过滤 unmanaged 且无端口的——那种
    // 基本是刚启动就退出的残留，记进去只会污染清单。
    .filter((s) => s.ports.length > 0 || s.managed !== 'unmanaged')
    .filter((s) => !SYSTEM_NOISE.test(s.label) || s.ports.some((p) => !!L2_HINTS[p]))
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
  // grey（已停止）和 idle（无从探测）、unknown（未测）都不是失败：
  // 只要剩下可判定的都绿就该是绿。
  // （旧实现用 every(green)，混进一个 grey 就掉到 unknown —— 等于让"停掉的旧服务"
  //  把整盏灯变成"未测"。）
  const assessed = xs.filter((h) => h.lamp !== 'grey' && h.lamp !== 'idle' && h.lamp !== 'unknown');
  if (assessed.length > 0 && assessed.every((h) => h.lamp === 'green')) {
    return { lamp: 'green', oldestMs };
  }
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
