/**
 * 引擎注册表（Engine Registry）
 *
 * 设计原则（见设计方案 §3.2）：
 *  - 一个引擎 = 一条 ACP 启动命令，不进业务代码。
 *  - 新增 agent 的边际成本 = 加一条记录。
 *  - 用户可用 ~/.agentbd/engines.json 覆盖/追加（对应 acpx 的 config.json 思路）。
 */

import { existsSync } from 'node:fs';
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
    authHint: '复用 ~/.agnes/config/config.yaml 的 active_provider；缺失先在 Agnes GUI 里配好',
    env: {
      // 实测：不注入这两个 env，session/prompt 报 "Provider not set"
      // （desktop 启动 agnesd 时同样注入，见 app bundle 的 AGNES_DEFAULT_PROVIDER/MODEL）
      AGNES_DEFAULT_PROVIDER: 'agnes',
      AGNES_DEFAULT_MODEL: 'auto',
    },
    note: 'agnesd = goose-server 1.62.6 fork：本地 HTTPS + wss://…/acp?token=（非 stdio，实测 2026-09-23）',
  },
];

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
  return { ...env, ...(spec.env ?? {}) };
}

export function findEngine(id: string, engines: EngineSpec[] = BUILTIN_ENGINES): EngineSpec | undefined {
  return engines.find((e) => e.id === id || e.label === id);
}
