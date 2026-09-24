/**
 * 引擎注册表（Engine Registry）
 *
 * 设计原则（见设计方案 §3.2）：
 *  - 一个引擎 = 一条 ACP 启动命令，不进业务代码。
 *  - 新增 agent 的边际成本 = 加一条记录。
 *  - 用户可用 ~/.agentbd/engines.json 覆盖/追加（对应 acpx 的 config.json 思路）。
 */

import { existsSync, readFileSync } from 'node:fs';
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
  env?: Record<string, string>;
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
    command: '/Applications/AgnesCode.app/Contents/Resources/bin/agnesd',
    args: ['agent'],
    channel: 'acp-service',
    service: {
      portEnv: 'AGNES_PORT',
      secretEnv: 'AGNES_SERVER__SECRET_KEY',
      path: '/acp',
      fingerprintPrefix: 'GOOSED_CERT_FINGERPRINT=',
    },
    authHint: 'provider/model 与 GUI 同源（~/.agnes/config/config.yaml 的 active_provider）；真实回合需要已配置的 provider',
    env: {
      // 实测：不注入这两个 env，session/prompt 报 "Provider not set"
      // （desktop 启动 agnesd 时同样注入；这里从 config.yaml 活读，用户在 GUI
      //  里切换 provider（如自定义 apihub provider）后 agentbd 自动保持一致）
      ...agnesDefaults(),
    },
    note: 'agnesd = goose-server 1.62.6 fork：本地 HTTPS + wss://…/acp?token=（非 stdio，实测 2026-09-23）',
  },
];

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
  // spec.env 是「默认值」，shell/调用方环境可覆盖（否则用户传的
  // AGNES_DEFAULT_PROVIDER 会被静态默认值吃掉）
  return { ...(spec.env ?? {}), ...env };
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
