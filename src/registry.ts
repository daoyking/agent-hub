/**
 * 引擎注册表（Engine Registry）
 *
 * 设计原则（见设计方案 §3.2）：
 *  - 一个引擎 = 一条 ACP 启动命令，不进业务代码。
 *  - 新增 agent 的边际成本 = 加一条记录。
 *  - 用户可用 ~/.agentbd/engines.json 覆盖/追加（对应 acpx 的 config.json 思路）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type EngineSpec = {
  /** 引擎 id（CLI 里用的名字） */
  id: string;
  /** 显示名 */
  label: string;
  /** 上游厂商 */
  vendor: string;
  /** 可执行文件；默认取 process.execPath（node）之外的原生命令 */
  command: string;
  args: string[];
  /**
   * 追加 env。可以是函数（**懒求值**）——agnes 的密钥要从钥匙串读，
   * 不能让每次 `agentbd engines` 之类的命令都去碰 keychain。
   */
  env?: Record<string, string> | (() => Record<string, string>);
  /** 接入方式：acp=原生 ACP；acp-adapter=npx 适配器；acp-service=起本地服务再连 wss（agnesd） */
  channel: 'acp' | 'acp-adapter' | 'acp-service';
  /** channel=acp-service 专用：如何把服务拉起并连上 ACP */
  service?: {
    /** 监听端口注入到该 env 变量名（agnesd: AGNES_PORT） */
    portEnv: string;
    /** 会话密钥注入到该 env 变量名，连 wss 时以 ?token= 携带 */
    secretEnv: string;
    /** ACP WebSocket 路径（默认 /acp） */
    path?: string;
    /** 从 stdout 抓 TLS 证书指纹的前缀（用于 pin，防本地代理劫持） */
    fingerprintPrefix?: string;
  };
  /** 认证提示（doctor 会打印） */
  authHint?: string;
  /** 备注 */
  note?: string;
};

const WORKBUDDY_CODEBUDDY =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 适配器启动方式解析：优先用项目内 pin 好的二进制，其次回退 npx。
 *
 * 为什么这么做（实测教训）：直接 npx 首次运行要下载，25s 握手超时必然失败，
 * doctor 会呈现"引擎坏了"的假象。acpx 也是这么处理版本 pin 的（设计方案 §5.1）。
 */
export function resolveAdapter(bin: string, pkg: string, version: string): { command: string; args: string[] } {
  const local = path.join(PROJECT_ROOT, 'node_modules', '.bin', bin);
  if (existsSync(local)) return { command: local, args: [] };
  return { command: 'npx', args: ['-y', `${pkg}@${version}`] };
}

const CLAUDE_ADAPTER = resolveAdapter('claude-agent-acp', '@agentclientprotocol/claude-agent-acp', '0.81.0');
const CODEX_ADAPTER = resolveAdapter('codex-acp', '@agentclientprotocol/codex-acp', '1.13.0');

/** P0 的 5 个引擎：全部在本机实测握手成功（2026-09-23） */
/**
 * 定位 agnesd 二进制。**不能硬编码 /Applications/AgnesCode.app**：
 * 应用可能被移动过位置，或处于 AppTranslocation（未正式安装，从 ~/Downloads
 * 或挂载卷直接运行时 macOS 会把包挪进 /private/var/folders/…/T/AppTranslocation/
 * <uuid>/d/，此时 /Applications 下的路径直接不存在——doctor 报 ENOENT）。
 * 按「已知候选 → mdfind → AppTranslocation glob」顺序找，取第一个存在的。
 */
function resolveAgnesd(): string {
  const rel = 'Contents/Resources/bin/agnesd';
  const candidates = [
    '/Applications/AgnesCode.app/' + rel,
    path.join(os.homedir(), 'Applications/AgnesCode.app', rel),
  ];
  for (const c of candidates) if (existsSync(c)) return c;

  // AppTranslocation 兜底：从当前运行的 AgnesCode 进程反推，比 Spotlight 可靠
  // （AppTranslocation 里的包**没被 Spotlight 索引**，mdfind 必然查不到）。
  try {
    const ps = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8', timeout: 3000 }).stdout ?? '';
    const m = ps.match(/\S*AppTranslocation\/\S*\/d\/AgnesCode\.app\//);
    if (m) {
      const p = m[0] + rel;
      if (existsSync(p)) return p;
    }
  } catch { /* ps 不可用 → 继续扫盘 */ }

  // 扫 /private/var/folders/<xx>/<user>/T/AppTranslocation/*/d/
  try {
    for (const base of readdirSync('/private/var/folders', { withFileTypes: true })) {
      if (!base.isDirectory()) continue;
      const perUser = path.join('/private/var/folders', base.name);
      for (const u of readdirSync(perUser, { withFileTypes: true })) {
        if (!u.isDirectory()) continue;
        const trans = path.join(perUser, u.name, 'T', 'AppTranslocation');
        if (!existsSync(trans)) continue;
        for (const app of readdirSync(trans, { withFileTypes: true })) {
          if (!app.isDirectory()) continue;
          const p = path.join(trans, app.name, 'd', 'AgnesCode.app', rel);
          if (existsSync(p)) return p;
        }
      }
    }
  } catch { /* 无权限/结构变化 → 返回候选路径，由 spawn 报 ENOENT */ }

  return candidates[0]!;
}

export const BUILTIN_ENGINES: EngineSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    command: CLAUDE_ADAPTER.command,
    args: CLAUDE_ADAPTER.args,
    channel: 'acp-adapter',
    authHint: '复用 ~/.claude 登录态；失败先跑 `claude login`',
    note: '本机 pin 的 ACP 适配器；未安装则回退 npx（首跑需下载）',
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    command: CODEX_ADAPTER.command,
    args: CODEX_ADAPTER.args,
    channel: 'acp-adapter',
    authHint: '复用 ~/.codex/auth.json；失败先跑 `codex login`',
    note: '本机 pin 的 ACP 适配器；备选通道 `codex app-server`',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    vendor: 'Google',
    command: 'gemini',
    args: ['--acp'],
    channel: 'acp',
    authHint: 'authMethods: oauth-personal / gemini-api-key / vertex-ai / gateway',
    note: '原生 ACP（--acp）',
  },
  {
    id: 'codebuddy',
    label: 'WorkBuddy 内置 CodeBuddy',
    vendor: 'Tencent',
    // 目标文件是 node 脚本，用 node 显式执行，避免依赖 shebang/PATH
    command: process.execPath,
    args: [WORKBUDDY_CODEBUDDY, '--acp'],
    channel: 'acp',
    authHint: 'authMethods: iOA / internal / external / selfhosted（国内版需 internal）',
    note: 'WorkBuddy.app 自带内核，GUI 无需参与；缺失时回退 npx @tencent-ai/codebuddy-code',
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    vendor: 'Alibaba',
    command: 'qoder',
    args: ['--acp'],
    channel: 'acp',
    authHint: 'authMethods: qodercli-login',
    note: '原生 ACP；额外支持 session list/fork/resume',
  },
  {
    id: 'agnes',
    label: 'Agnes Code (agnesd)',
    vendor: 'Agnes',
    command: resolveAgnesd(),
    args: ['agent'],
    channel: 'acp-service',
    service: {
      portEnv: 'AGNES_PORT',
      secretEnv: 'AGNES_SERVER__SECRET_KEY',
      path: '/acp',
      fingerprintPrefix: 'GOOSED_CERT_FINGERPRINT=',
    },
    authHint: 'provider/model 与 GUI 同源（~/.agnes/config/config.yaml 的 active_provider）；真实回合需要该 provider 的密钥',
    env: () => ({ ...agnesDefaults(), ...agnesSecretEnv() }),
    note: 'agnesd = goose-server 1.62.6 fork：本地 HTTPS + wss://…/acp?token=（非 stdio，实测 2026-09-23）',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'SST',
    command: 'opencode',
    args: ['acp'],
    channel: 'acp',
    authHint: '复用 ~/.local/share/opencode 的 provider 凭证（opencode auth list）',
    note: '原生 ACP（`opencode acp`，v2.0.16 实测）；多 provider 聚合',
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    vendor: 'Oh My Pi',
    command: 'omp',
    args: ['acp'],
    channel: 'acp',
    authHint: '复用 omp 自己的 provider 凭证（omp auth）',
    note: '原生 ACP（`omp acp`，oh-my-pi 18.3.0 实测）；能力最全：含 fork/resume/addDirs',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    vendor: 'OpenClaw',
    command: 'openclaw',
    args: ['acp'],
    channel: 'acp',
    authHint: '需要 openclaw gateway 在跑（launchd ai.openclaw.gateway，:18790）；凭证走 gateway',
    note: '原生 ACP bridge（`openclaw acp`，2026.8.1）；背靠 gateway，非独立进程',
  },
];

/* --------------------- Agnes 凭据（钥匙串 → provider env） --------------------- */

/**
 * AgnesCode 的密钥库 service 名。**两个都要看**：
 *  - 新版 `com.agnes.code.secrets`（keyring 迁移后的目标）
 *  - 旧版 `agnes`（迁移源）
 * 实测（2026-09-25）：迁移只搬了 1 个条目（`AGNES_AI_API_KEY`），用户自定义
 * provider 的 key（如 `CUSTOM_AGNESHUB_API_KEY`）**留在了旧 service**；而新版
 * agnesd 只读新 service → agnesd 拿不到 key，ACP 层把失败统一包装成
 * "Authentication required"（-32000），极具误导性。
 * 两个 service 都读并按 provider 声明的 api_key_env 补 env，绕开这个迁移缺口。
 *
 * 注意：补上 key 之后仍可能认证失败，**别把它当万能钥匙**。实测（2026-09-25）
 * 钥匙齐全时 apihub 的真实响应是 403 "Failed to pre-consume quota, remaining:
 * $0.001942, required: $0.010800"——账户余额不足，而 ACP 仍报同一句
 * "Authentication required"。排查顺序：先看 ~/.agnes/state/logs/server/ 下的
 * agnesd 日志（那里有真实 HTTP 状态与 body），再动 provider 配置。

 * provider 的 key（如 `CUSTOM_AGNESHUB_API_KEY`）**留在了旧 service**；而新版
 * agnesd 只读新 service → session/prompt 直接报 "Authentication required"。
 * 两个 service 都读并按 provider 声明的 api_key_env 补 env，绕开这个迁移缺口。
 */
const AGNES_KEYRING_SERVICES = ['com.agnes.code.secrets', 'agnes'];

function keychainSecrets(service: string): Record<string, string> {
  // 优先尝试 -w（直接 stdout 打印密码）
  const resW = spawnSync(
    'security',
    ['find-generic-password', '-s', service, '-a', 'secrets', '-w'],
    { encoding: 'utf8', timeout: 2000 },
  );
  if (resW.status === 0 && resW.stdout?.trim()) {
    try {
      const j = JSON.parse(resW.stdout.trim()) as unknown;
      if (j && typeof j === 'object') return j as Record<string, string>;
    } catch {}
  }

  // 若 -w 触发权限确认或挂起，尝试 -g（非交互模式，密码通常在 stderr 打印）
  const resG = spawnSync(
    'security',
    ['find-generic-password', '-s', service, '-a', 'secrets', '-g'],
    { encoding: 'utf8', timeout: 2000 },
  );
  const stderr = resG.stderr || '';
  const m = stderr.match(/password:\s*(?:0x[0-9a-fA-F]+\s+)?"(.*)"/);
  if (m) {
    try {
      const raw = m[1].replace(/\\134/g, '\\');
      const j = JSON.parse(raw) as unknown;
      if (j && typeof j === 'object') return j as Record<string, string>;
    } catch {}
  }

  return {}; // 未授权/条目不存在 → 静默（authHint 会提示）
}

/** 自定义 provider 定义（~/.agnes/config/custom_providers/<name>.json） */
function readCustomProvider(provider: string): {
  api_key_env?: string;
  models?: Array<{ name: string }>;
} | null {
  try {
    return JSON.parse(
      readFileSync(path.join(os.homedir(), '.agnes/config/custom_providers', `${provider}.json`), 'utf8'),
    ) as { api_key_env?: string; models?: Array<{ name: string }> };
  } catch {
    return null;
  }
}

/**
 * 当前 active_provider 需要的密钥 env + 钥匙串补齐。
 * shell 已给的 env 一律尊重（不覆盖）；读不到 secret 就返回空（由 agnesd 报错，
 * 上层 doctor 会显示 authHint）。
 */
function agnesSecretEnv(): Record<string, string> {
  const provider = process.env.AGNES_DEFAULT_PROVIDER ?? activeProvider();
  const keyEnv = provider === 'agnes' ? 'AGNES_AI_API_KEY' : readCustomProvider(provider)?.api_key_env;
  if (!keyEnv || process.env[keyEnv]) return {};
  const secrets = AGNES_KEYRING_SERVICES.reduce<Record<string, string>>(
    (acc, svc) => Object.assign(acc, keychainSecrets(svc)),
    {},
  );
  const out: Record<string, string> = {};
  if (secrets[keyEnv]) out[keyEnv] = secrets[keyEnv]!;
  // 自定义 provider 常需要额外 header（goose 读 OPENAI_CUSTOM_HEADERS）
  if (provider !== 'agnes' && secrets.OPENAI_CUSTOM_HEADERS) {
    out.OPENAI_CUSTOM_HEADERS = secrets.OPENAI_CUSTOM_HEADERS;
  }
  return out;
}

/** config.yaml 的 active_provider（GUI 里选的 provider，agentbd 与它保持一致） */
function activeProvider(): string {
  try {
    const yaml = readFileSync(path.join(os.homedir(), '.agnes/config/config.yaml'), 'utf8');
    return yaml.match(/^active_provider:\s*(\S+)/m)?.[1] ?? 'agnes';
  } catch {
    return 'agnes';
  }
}

/**
 * agnes 默认 provider/model——与 AgnesCode GUI 同源：
 * 读 ~/.agnes/config/config.yaml 的 active_provider；若指向自定义 provider
 * （custom_providers/*.json），模型取其 model 清单（优先 pro 档）。
 * shell 里的 AGNES_DEFAULT_* 仍可覆盖（见 engineEnv 的合并顺序）。
 */
function agnesDefaults(): Record<string, string> {
  let provider = 'agnes';
  let model = 'auto';
  try {
    const yaml = readFileSync(path.join(os.homedir(), '.agnes/config/config.yaml'), 'utf8');
    const m = yaml.match(/^active_provider:\s*(\S+)/m);
    if (m) provider = m[1];
  } catch { /* 无配置 → 内置 agnes */ }
  if (provider !== 'agnes') {
    try {
      const file = path.join(os.homedir(), '.agnes/config/custom_providers', `${provider}.json`);
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const names: string[] = (j.models ?? []).map((x: { name: string }) => x.name);
      model = names.find((n) => n === 'agnes-2.5-pro') ?? names.find((n) => n.includes('-pro')) ?? names[0] ?? 'auto';
    } catch { model = 'auto'; }
  }
  return { AGNES_DEFAULT_PROVIDER: provider, AGNES_DEFAULT_MODEL: model };
}

/** 供 doctor 做「环境可见性」检查：macOS GUI 进程看不到 brew 目录是经典坑 */
export const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  `${process.env.HOME}/.volta/bin`,
  `${process.env.HOME}/.local/bin`,
  `${process.env.HOME}/.bun/bin`,
];

export function buildPath(): string {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const merged = [...current];
  for (const dir of EXTRA_PATH_DIRS) {
    if (dir && !merged.includes(dir)) merged.push(dir);
  }
  return merged.join(':');
}

export function engineEnv(spec: EngineSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.PATH = buildPath();
  const specEnv = typeof spec.env === 'function' ? spec.env() : (spec.env ?? {});
  // spec.env 是「默认值」，shell/调用方环境可覆盖（否则用户传的
  // AGNES_DEFAULT_PROVIDER 会被静态默认值吃掉）
  return { ...specEnv, ...env };
}

export function findEngine(id: string, engines: EngineSpec[] = loadEngines()): EngineSpec | undefined {
  return engines.find((e) => e.id === id || e.label === id);
}

/* --------------------------- 用户自定义引擎 --------------------------- */

export const ENGINES_FILE = path.join(os.homedir(), '.agentbd', 'engines.json');

/**
 * 合并内置清单 + `~/.agentbd/engines.json`（设计原则：新增 agent 的边际成本 = 加一条记录）。
 *
 * 文件格式（裸数组或 {engines:[…]} 均可）：
 *   [{ "id": "my-agent", "label": "My Agent", "vendor": "Me",
 *      "command": "node", "args": ["/path/agent.mjs"], "channel": "acp" }]
 *
 * 语义：同 id → 字段级覆盖内置（只写要改的字段）；新 id → 追加（需 command）。
 * 坏文件不崩：读失败/JSON 出错时静默退回内置清单。
 */
export function loadEngines(): EngineSpec[] {
  const out = BUILTIN_ENGINES.map((e) => ({ ...e }));
  let list: unknown;
  try {
    if (!existsSync(ENGINES_FILE)) return out;
    const raw = JSON.parse(readFileSync(ENGINES_FILE, 'utf8')) as unknown;
    list = Array.isArray(raw) ? raw : (raw as { engines?: unknown })?.engines;
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const spec = item as Partial<EngineSpec>;
    if (typeof spec.id !== 'string' || !spec.id) continue;
    const i = out.findIndex((e) => e.id === spec.id);
    if (i >= 0) out[i] = { ...out[i]!, ...spec } as EngineSpec;
    else if (typeof spec.command === 'string') {
      out.push({ label: spec.id, vendor: 'custom', args: [], channel: 'acp', ...spec } as EngineSpec);
    }
  }
  return out;
}
