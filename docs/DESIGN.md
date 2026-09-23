# 多 Agent 聚合桌面 · 设计方案与可行性分析

> 目标：把本机所有 AI agent（Claude Code / Codex / Gemini CLI / WorkBuddy / Agnes Code /
> TRAE SOLO CN(TraeWork CN) / Qoder / Cline …）聚合进一个桌面外壳。
> 版本：2026-09-23 实地勘察 + P0 实证版。

## 0. 结论

**可行，但"聚合桌面"必须拆成三件事，可行性差别极大：**

| 聚合层次 | 含义 | 可行性 | 依据 |
|---|---|---|---|
| ① 内核聚合（事件流） | 一个外壳驱动所有 agent 的 agent loop，统一渲染对话/工具/审批 | **很高** | ACP 协议 + 各家 headless CLI；本机 5/5 引擎实测握手成功 |
| ② 界面聚合（原生窗格） | 把各家 GUI 塞进一个 Tab | **中等** | 仅 VS Code 内核的（TRAE）可 `serve-web` 内嵌；Electron 壳之间无法互嵌 |
| ③ 资产聚合（会话/记忆/技能/密钥/用量） | 统一历史、MCP、Skills、Key、账单 | **中高，需自建** | 各家格式不同，必须做归一化层 |

**核心判断：不要聚合 GUI，要聚合 agent 内核 + 事件流。**

## 1. 现场勘察（本机实证）

### 1.1 已安装资产

```
/Applications: AgnesCode  WorkBuddy  TRAE SOLO CN  Cline  Orca  Omnigent  OpenWorker  ccgui
PATH CLI:      claude 2.1.112 · codex-cli 0.155.1 · gemini 0.46.0 · opencode v2.0.14 · qoder 1.1.34
~/ 配置:       238 个点目录，agent 相关 ≥ 60 个
已有编排资产:   Orca（worktree+终端+编排 CLI）、ccgui、~/.agents/skills/orchestration
```

### 1.2 三家"闭源 App"的真实底牌（方案成败的分水岭）

| App | 勘察事实 | 可编程面 |
|---|---|---|
| **WorkBuddy** (com.tencent.workbuddy.mac) | GUI=Electron，但 `Resources/app.asar.unpacked/cli/` **完整内置 CodeBuddy CLI 2.137.1**：`bin/codebuddy`、`dist/codebuddy.js`、`dist/codebuddy-headless.js`、`dist/web-ui/`，含官方文档 `docs/cn/cli/acp.md`（写明 `codebuddy --acp`）；代码含 `acpAgentManager/acpHost/acpBroadcastService` | **一等公民**：不碰 GUI，直接驱动自带内核 |
| **Agnes Code** (com.agnes.code 1.0.60) | `Resources/bin/agnesd` 为 275MB Rust 二进制，`strings` 含 `crates/goose/src/acp/server.rs`、`session_type IN ('user','acp')`、`'ACP Session'`，并注册 `claude-acp/codex-acp/copilot-acp/pi-acp/amp-acp`；子命令 `agent`(agent server) / `mcp` / `keyring-migrate` | **可接**：goose 内核 + ACP server，但传输协议未公开 → 需自写适配器 |
| **TRAE SOLO CN / TraeWork CN** (cn.trae.solo.app 0.1.66) | VS Code fork（`dataFolderName: .trae-cn`、`win32NameVersion: TraeWork CN`）；`bin/{code,marscode,trae-solo-cn}`；main.js 含 `serve-web`/`tunnel`/`--status`/`extensionHost`；**无任何 `acp` 字符串** | **仅界面级**：`serve-web` + webview 内嵌；拿不到它的 agent loop |

### 1.3 协议生态（可复用的轮子）

- **ACP v1**（Zed 主导，JetBrains 参与）：`initialize / authenticate / session/new|load|prompt|cancel` +
  `session/update`（消息/思考/工具/计划）+ `session/request_permission` + `fs/*` + `terminal/*` + `elicitation/*`。
- **官方 registry 41 个 agent**（`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`），
  已覆盖需求内几乎所有：`claude-acp` `codex-acp` `gemini` `cline` `codebuddy-code`(腾讯官方) `cursor`
  `github-copilot-cli` `qwen-code` `opencode` `goose` `factory-droid` `kimi` …
- 可复用：`@agentclientprotocol/sdk@1.5.0`（TS）、`acpx@0.19.2`（多 agent ACP CLI，自带 friendly-name registry）、
  `@agentclientprotocol/claude-agent-acp@0.81.0`、`@agentclientprotocol/codex-acp@1.13.0`。
- 本机已有 Orca 提供 worktree/终端/编排，**PTY 生命周期不必自研**。


## 2. 架构（ACP 为中心的三层结构）

```
L3 外壳（P1: Web+SSE → P2: Tauri 2）
   统一对话面 / 原生终端面(node-pty) / Web 内嵌面(TRAE serve-web) / 窗口代理面(兜底)
   侧栏：会话历史 · 任务 Inbox · 用量账单 · MCP/Skills · 审批中心
        │  WebSocket + JSON-RPC（UI 自身亦可实现为 ACP Client）
L2 Agent Bus（常驻 daemon；本仓库当前形态 = CLI）
   Registry · Session Mgr · Event Normalizer · Permission Broker
   Workspace(worktree) · MCP Hub · Skills Sync · Usage/Metering
        │  ACP over stdio (JSON-RPC 2.0)
L1 适配器
   A类 原生 ACP：gemini --acp · qoder --acp · codebuddy --acp(WorkBuddy内置)
   B类 ACP 适配器：claude-agent-acp · codex-acp（pin 本地二进制）
   C类 headless 事件流：claude -p --output-format stream-json · codex exec --json / app-server
   D类 PTY 兜底（无结构化）
   E类 界面级：TRAE serve-web / 原生 App 窗口代理
```

### 2.1 统一事件模型（归一化层 = 真正的工作量）

ACP 只统一"形状"，不统一"语义"（实测：Qoder 有 `session/fork`，Gemini 无；CodeBuddy 有 `delegateTools`）。
外壳只认这一套：

```ts
type NormalizedEvent =
  | { k: 'user.delta';    text: string }
  | { k: 'msg.delta';     text: string }
  | { k: 'thought.delta'; text: string }
  | { k: 'tool.call';     id; name; title; kind; status; risk: 'low'|'high'; locations }
  | { k: 'tool.result';   id; status; ok; output? }
  | { k: 'plan';          steps: {title; status:'pending'|'doing'|'done'}[] }
  | { k: 'session.info';  title?; updatedAt? }
  | { k: 'mode';          modeId }
  | { k: 'commands';      commands: string[] }
  | { k: 'usage';         used; size; costUsd? }
  | { k: 'notice';        level; text }
  | { k: 'raw';           update; payload };   // 兜底：不丢信息，unknown 不报错
```

- **风险分级**驱动审批策略：`read/search/think/fetch → low`；`edit/delete/move/execute/switch_mode/other → high`。
- **能力协商**：`initialize` 结果存为 `EngineProfile`，UI 据此显隐按钮。
- **降级链**：ACP → headless JSON → PTY；同一会话模型可切换通道。

### 2.2 接入矩阵

| 目标 | 通道 | 优先级 | 备注 |
|---|---|---|---|
| Claude Code | ACP 适配器 / `-p stream-json` 备 | P0 | hooks/plugins/skills 原样保留；成本字段最完整 |
| Codex | ACP 适配器 / `codex app-server`(完整 JSON-RPC) 备 | P0 | app-server 保真度最高 |
| Gemini CLI | 原生 ACP | P0 | 顺手白拿 |
| **WorkBuddy** | 驱动内置 `codebuddy --acp` | P0 | 已实测通过，GUI 不参与 |
| **Agnes Code** | `agnesd agent` + wss `/acp?token=`（自建 acp-service 通道） | **P0 已接入** | goose 内核；doctor PASS，真实回合待 GUI 同步 key |
| **TRAE SOLO CN** | `serve-web` → webview；复用其 `~/.trae-cn/mcps`、`skills` | P2 | **不支持内核级统一**，UI 需视觉隔离 |
| Cline / OpenWorker / Omnigent / ccgui | 各自 CLI/ACP | P1 | Cline 有 `cline --acp` |
| 其余 30+ 家 | 照抄 registry `distribution` | P2 | 加一条 = 一个 JSON 条目 |

## 3. 分阶段

- **P0（已完成）** `agentbd` 总线：registry / doctor / normalize / policy / bus / sessions + CLI；
  **服务层**（launchd+lsof 发现、L1/L2/L3 探针、假活判定、生命周期、健康缓存）；
  **MCP Hub**（17 个配置源归一去重 → 关联服务灯 → `--with-mcp` 注入任意引擎）。
  验收：同一份代码驱动 5 引擎握手成功；claude 与 codebuddy 完成真实 prompt 轮次并落盘；
  服务面板 8 个服务出灯，MCP 视图点名"服务红 ⇒ 引用它的 MCP 全挂"的因果链。
- **P1（核心已完成，2026-09-23）**：
  ✅ **Agnes 适配器**——逆向出 `agnesd` 的 TLS+WebSocket 传输（`wss://…/acp?token=`、
  证书指纹 pin、text frame 约束），新增 `acp-service` 通道，doctor 6/6；
  真实回合仅差 `AGNES_AI_API_KEY`（本机持久层为 null，等 GUI 登录同步）。
  ✅ **Web UI**——`agentbd serve`：`/api/state` 聚合 + `/events` SSE + `POST /api/ask`，
  服务灯/MCP 视图进侧栏，事件模型与 CLI 同源；已实测 claude 回合经面板完成。
  ✅ **MCP Hub 可写**——`mcp add/remove` 回写 JSON/TOML 配置源（备份+原子写）+
  `mcp probe` 工具级握手（stdio + Streamable HTTP）。
  ⬜ 待办：Tauri 壳、审批中心、Skills 分发、用量看板、transcript SQLite、`session/load` 恢复。
- **P2** TRAE serve-web 内嵌；桥接 Orca（worktree 隔离 + 编排）；任务 Inbox；多 agent DAG。
- **P3** ACP over WebSocket 远程接入；团队共享 skills/MCP 模板。

## 4. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | 适配器漂移（acp 适配器/CLI 迭代快） | pin 版本 + `agentbd doctor` 启动自检（已实现） |
| 2 | 能力不对称导致 UI 点了报错 | `EngineProfile` capability gating（已实现） |
| 3 | agent 套 agent（Agnes/WorkBuddy 自身会拉起别的 agent） | `AGENTBD_DEPTH` 守卫（已实现） |
| 4 | 权限放大 → 安全黑洞 | 凭证只进 Keychain；审批三模式 + 留痕；`fs` 白名单限定 `--cwd`（已实现） |
| 5 | 闭源 GUI 逆向合规风险 | 只走官方 CLI/公开二进制接口，不逆 IPC；TRAE 老实走 `serve-web` |
| 6 | 成本失控（实测一句 "pong" $0.1276 / 2.5 万 input tokens） | 统一用量看板 + 预算护栏（P1）；`--deny` 演练模式 |
| 7 | macOS GUI 进程 PATH 缺 brew 目录 | `buildPath()` 强制注入（已实现） |
| 8 | 同一 repo 多引擎并发写冲突 | worktree 隔离（复用 Orca） |

## 5. 实证记录（2026-09-23）

```
doctor:  6/6 PASS（agnes 为 acp-service 通道：wss 桥接 81ms）
  claude    1768ms  claude-agent-acp 0.81.0  caps: loadSession session.subagents session.fork/list/...
  codex     5849ms  codex-acp 1.13.0         auth: api-key, chat-gpt
  gemini    1855ms  gemini-cli 0.46.0        caps: loadSession prompt.image/audio/embeddedContext
  codebuddy 1694ms  (WorkBuddy 内置)          caps: ... delegateTools
  qoder     1987ms  qoder-cli 1.1.34         caps: 最丰富 session.fork/resume/list/delete/close
  agnes       81ms  agnes 1.62.6（agnesd = goose-server fork，TLS+wss /acp?token=）

ask:
  claude    → pong · 7299ms · in=25424 out=9 · $0.1276155 · transcript 已落盘
  codebuddy → pong · 18571ms · thought.delta×N + raw[session_info_update]×N 正确归一化
  qoder     → 账号额度不足 {"pricingUrl":"https://qoder.com/pricing?client=qoder"}（引擎侧问题，非总线）
  gemini    → 未配置 API key（引擎侧问题，非总线）

services（默认 L2，2026-09-23）:
  com.litellm.gateway :8001   L1 在听 · L2 HTTP 200 (1816ms)      🟢
  ai.openclaw.gateway :18790  L1 在听 · L2 HTTP 200 (12ms)         🟢
  browseros-neo       :9010   L1 未监听（声明了但没起）            🔴
  hermes/anythingllm  :9527   L1 在听 · 未声明 L2 → unknown ⚪（不冒充绿）
  汇总 8 服务 · 结论年龄 2s

mcp（17 源归一后 4 条）:
  browseros-neo http://127.0.0.1:9010/mcp ← claude,codex,cursor,opencode → 服务灯 🔴
  ask claude --with-mcp → 4 个 MCP 注入 session/new，死服务只告警不炸会话
                          stop=end_turn · 5425ms · $0.070

mcp probe（工具级，P1）:
  ✔ node_repl 144ms 4 tools · ✔ zai-mcp-server 1589ms 8 tools
  ✘ browseros-neo fetch failed（服务红）· ⊘ computer-use enabled=false → 2/4 握手成功
  mcp add/remove roundtrip：~/.claude.json + ~/.codex/config.toml 写入→重扫→移除→与备份比对 ✅

serve（Web 面板，P1）:
  GET /api/state → engines×6 · services×9（灯）· mcp×4（带服务灯）
  POST /api/ask claude → SSE ask.event×8 → ask.done end_turn · 8742ms · $0.142 · transcript 落盘
```

> 后两条恰好说明聚合器的产品价值：**各家额度/订阅/凭据状态第一次能被集中看见**。
