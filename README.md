# agentbd —— 多 agent + 本地服务 统一总线（P0）

把本机所有 AI 编码 agent（Claude Code / Codex / Gemini CLI / **WorkBuddy 内置 CodeBuddy** / Qoder …）
收敛到**同一条 ACP 总线 + 同一套事件模型**上；再把它们依赖的**本地服务**（launchd 守护、HTTP 网关、
MCP 配置）拉进同一个面板。UI 只认统一事件与灯，不认引擎/服务差异。

- 设计依据：`docs/DESIGN.md`（聚合方案与可行性分析）
- 协议：Agent Client Protocol v1（`@agentclientprotocol/sdk@1.5.0`）
- 运行时：**Node 原生执行 TypeScript**（v22.6+ 类型擦除，无需构建步骤）

## 快速开始

```bash
cd ~/Projects/agent-hub
node src/cli.ts engines                 # 列出引擎
node src/cli.ts doctor                  # 握手探测 + 能力报告（升级引擎后必跑）
node src/cli.ts ask claude --cwd /tmp --auto "用一句话解释 ACP"
node src/cli.ts ask claude --cwd /tmp "重构这个函数"      # TTY 下逐条交互授权
node src/cli.ts ask claude --cwd /tmp --json "..." | jq . # NDJSON 事件流（给 UI 用）
node src/cli.ts sessions                # 历史 transcript

node src/cli.ts services                # 本地服务健康灯（L1 端口 / L2 接口 / L3 语义，--l3 才跑贵的）
node src/cli.ts services init           # 从现场生成清单骨架 ~/.agentbd/services.json（再手工校准）
node src/cli.ts services restart <id>   # up / down / restart / logs / probe <id>
node src/cli.ts mcp                     # 统一 MCP 视图（跨 agent 去重 + 关联本地服务灯）
node src/cli.ts ask claude --with-mcp "..."  # 把 MCP Hub 清单注入该引擎会话（一份配置喂所有引擎）
```

## 目录结构（对应设计方案的分层）

| 文件 | 层 | 职责 |
|---|---|---|
| `src/registry.ts` | L1 适配器 | 引擎表（一条记录 = 接一个 agent）；PATH 注入；适配器 pin/npx 回退 |
| `src/transport.ts` | L1 | spawn + NDJSON 流 + stderr 捕获 + 三级退出 |
| `src/doctor.ts` | 运维 | 只做 initialize 的能力探测（适配器漂移的哨兵） |
| `src/normalize.ts` | **L2 归一化** | ACP `session/update` → 统一事件模型；工具风险分级 |
| `src/policy.ts` | L2 审批 | auto / guard / deny 三模式，统一审批语义 |
| `src/bus.ts` | L2 核心 | 会话生命周期：initialize → session/new → prompt → 事件流 → usage |
| `src/sessions.ts` | L2 持久化 | JSONL transcript（P1 迁 SQLite 可直接导入） |
| `src/services.ts` | **服务层** | launchd/lsof 发现 + L1/L2/L3 三级探针 + 假活判定 + 生命周期 + 健康缓存 |
| `src/mcphub.ts` | **MCP Hub** | 扫 17 个 agent 的 MCP 配置 → 归一去重 → 关联服务灯 → 转 `acp.McpServer[]` |
| `src/cli.ts` | L3 外壳（P0 形态） | 命令 + 事件渲染（P1 换成 Web/Tauri 组件） |

## P0 已验证结论（2026-09-23）

### 1. `doctor`：6/6 引擎握手成功

| 引擎 | 耗时 | 能力（真实协商结果） | 认证方式 |
|---|---|---|---|
| claude | 1768ms | `loadSession` `session.subagents` `session.fork/list/delete/close/resume` `prompt.image/embeddedContext` | (none，复用 ~/.claude) |
| codex | 5849ms | 同上 + `prompt.image` | api-key / chat-gpt |
| gemini | 1855ms | `loadSession` `prompt.image/audio/embeddedContext` | oauth-personal / api-key / vertex / gateway |
| codebuddy（WorkBuddy 内置） | 1694ms | `loadSession` `prompt.image/embeddedContext` **`delegateTools`** | iOA / internal / external / selfhosted |
| qoder | 1987ms | 最丰富：`session.fork/resume/list/delete/close` | qodercli-login |
| **agnes（agnesd，acp-service 通道）** | **81ms** | `loadSession` `session.list/close` `prompt.image/audio/embeddedContext` | agnes-provider（见 P1 节的 key 说明） |

> 这张表就是设计方案 §5.2「能力不对称」的实证：**不做 capability gating 的 UI 一定会点了报错**。

### 2. `ask`：跨引擎统一事件流跑通

claude 实测（同一份代码同时驱动 5 个引擎）：

```
(无输出) → 用量 0/1000000 → "pong" → 用量 25974/1000000 → 用量 25974/200000 · $0.1276155
── stop=end_turn · 7299ms · in=25424 out=9 · $0.1276155 · 审批 0 次
```

codebuddy 实测（同一份代码，含思考流与 raw 兜底）：

```
thought.delta ×N（引擎的思考过程被正确归一化）
raw[session_info_update] ×N（未映射的更新走 raw 兜底，不丢信息）
用量 0/168000 tokens
msg.delta "pong"  → stop=end_turn · 18571ms
```

### 3. 踩到的真实坑（已修 / 已记录）

1. **npx 适配器首跑下载 → 25s 握手超时**，doctor 呈现"引擎坏了"的假象。
   已修：`resolveAdapter()` 优先用 `node_modules/.bin` 里 pin 好的二进制，npx 仅作回退。
2. **`session_info_update` / 未知更新不能丢**：已纳入归一化 + `raw` 兜底通道。
3. **qoder 本轮失败的真实原因**是账号额度：
   `{"pricingUrl":"https://qoder.com/pricing?client=qoder"}` —— 不是总线问题，
   而这恰好证明统一面板的价值：**各家额度/订阅状态第一次能被集中看见**。
4. **MAC 上 GUI 进程 PATH 坑**：`buildPath()` 强制注入 `/opt/homebrew/bin`、`~/.volta/bin` 等。

## P0 服务层 + MCP Hub 实测（2026-09-23）

### 4. `services`：本地服务灯

```
🟢 com.litellm.gateway.service  :8001    L1 8001 · L2 HTTP 200 (1816ms)
🔴 browseros-neo                :9010    L1 9010 未监听
🟢 ai.openclaw.gateway          :18790   L1 18790 · L2 HTTP 200 (12ms)
⚪ com.hermes.gateway.service   :9527    L1 在听，但未声明 L2 路径（假活风险未知）
汇总 🔴 8 个服务 · 结论年龄 2s（整体可信度由最陈旧数据决定）
```

- **假活（fake-alive）规则落地**：端口在听 ≠ 服务好（本机实测 litellm 8001 曾"端口通但 HTTP 永不答"）
  → 所以 L2 必看；未声明 L2 路径的老实显示 `unknown/⚪`，绝不冒充绿灯。
- `launchctl bootstrap` 在 agent 侧必失败（调用进程不在 Aqua 会话）→ `lifecycle()` 失败**如实报错**，不伪装成功。
- 默认只列清单声明过的 + 有端口的 launchd 作业；`--all` 才显示全部裸监听（本机 39 个）。
- 健康缓存 `~/.agentbd/health.json` 带新鲜度，聚合灯取**最老**那条结论的年龄。

### 5. `mcp`：统一 MCP 视图（服务层与 agent 层的接缝）

```
browseros-neo   http  http://127.0.0.1:9010/mcp   claude,codex,cursor,opencode → 服务 browseros-neo [red]
zai-mcp-server  stdio npx -y @z_ai/mcp-server     claude,codex
共 4 个 MCP；其中 1 个指向本地服务。
🔴 1 个 MCP 指向的服务当前不可用（这些 MCP 在任意 agent 里都会挂）
```

- 扫 17 个配置源（`~/.claude.json`、`~/.codex/config.toml`、cursor、opencode、trae…）→ **同一 target 只记一条**，
  右侧列出谁在用——"哪个服务挂了会连累谁"第一次变成一行查询。
- `ask claude --with-mcp` 实测：4 个 MCP 注入 `session/new`，死的 browseros-neo 只出一条黄色告警、
  不炸会话 → `stop=end_turn · 5425ms · $0.070`（deny 模式）。

## P1 已验证结论（2026-09-23）

### 6. Agnes 适配器：逆向 `agnesd` 的 TCP 传输（设计里"传输未公开"已破）

`agnesd` 不是 stdio——它是 goose-server 1.62.6 fork，起**本地 HTTPS + WebSocket**：

```
spawn: agnesd agent  env=AGNES_PORT:<空闲端口>, AGNES_SERVER__SECRET_KEY:<random32>
stdout: GOOSED_CERT_FINGERPRINT=<sha256>   ← 抓下来 pin，防本地代理劫持
连接:   wss://127.0.0.1:<port>/acp?token=<secret>   帧 = 一条 JSON-RPC（必须 text frame！）
桥接:   WS frame ↔ acp.ndJsonStream → bus/doctor 完全无感（新增 channel: acp-service）
```

- `doctor agnes` → `✔ PASS agnes 125ms · agnes 1.62.6`（全量 **6/6**）。
- 踩坑实录：① `ws` 默认发 binary frame，server 直接忽略（`Ignoring binary message`）→ 必须 `.toString()`；
  ② 不注入 `AGNES_DEFAULT_PROVIDER/MODEL` 时会话建得起来但 prompt 报 `Provider not set`；
  ③ 真实回合还差 `AGNES_AI_API_KEY`——**全机持久化位置（服务端 config/keyring/config.yaml）均为 null**，
  desktop 只在内存里注入登录 accessToken。→ 打开 AgnesCode GUI 登录一次即可同步写入，之后 `ask agnes` 即通；
  适配器已对这个错误给出可操作提示（不用翻 stderr 猜）。

### 7. MCP Hub 从"只读视图"变成可写 + 工具级探针

```
$ agentbd mcp probe
✔ node_repl               144ms  4 tools      js, js_add_node_module_dir, js_reset, turn_ended
✔ zai-mcp-server         1589ms  8 tools      ui_to_artifact, extract_text_from_screenshot, …
✘ browseros-neo             8ms  0 tools      fetch failed        ← 服务红灯，如实报
⊘ computer-use               0ms  0 tools      (配置里 enabled=false)
2/4 个 MCP 握手成功
```

- **两盏灯分开报**：L1 端口灯 ≠ MCP 协议灯（`initialize → tools/list` 真握手才算数）。
- `mcp add <name> --url <url> [--agents claude,codex]` / `mcp add <name> <cmd...>` 实测 roundtrip：
  写进 `~/.claude.json`（2-space JSON）与 `~/.codex/config.toml`（`[mcp_servers.x]` 段编辑）→
  重扫可见 → `mcp remove` 后与 `.agentbd.bak` 备份逐字节比对仅差 EOF 空行。
- 安全约束：只动 MCP key、写前必备份、tmp+rename 原子写、不存在的配置文件不代建、dir 型源拒写。

### 8. Web 面板：`agentbd serve`（SSE，零构建）

```
$ agentbd serve --port 7787
agentbd 面板已启动: http://127.0.0.1:7787
GET /api/state → engines×6 · services×9（带灯）· mcp×4（带服务灯）
POST /api/ask {engine:"claude",prompt:"只回复两个字母：OK"} 经 SSE 收流:
  ask.event(msg.delta…) → ask.done{stopReason:end_turn, 8742ms, $0.142, transcript 已落盘}
```

- 侧栏三块：引擎 / 服务灯 / MCP（服务灯直接显示在 MCP 上），主区 ask 输入框 + 实时事件流。
- 事件模型与 CLI **同源**（`bus.runTurn → NormalizedEvent`），UI 只是把 ANSI 行换成组件；
  面板只绑 `127.0.0.1`，不落任何新状态（transcript 仍进 `~/.agentbd/sessions/`）。
- `src/ui.html` 原生 HTML+JS+EventSource，无打包步骤（Tauri 壳留给下一步）。

## 安全边界（P0 已实现）

- `AGENTBD_DEPTH` 守卫：**禁止 agent 套 agent**（Agnes/WorkBuddy 内部也会拉起别的 agent，会翻倍消耗）。
- client `fs` 能力白名单：`fs/read_text_file`、`fs/write_text_file` 只允许在 `--cwd` 根目录内活动。
- 诚实能力声明：P0 未实现 ACP 终端 → `terminal: false`（而不是宣告后报错）。
- 审批三模式 + 每条审批留痕（`result.approvals`）。

## 本地数据与 CI 说明

所有运行时状态都在 **`~/.agentbd/`（仓库之外，永不入库）**：

| 文件 | 内容 |
|---|---|
| `sessions/*.jsonl` | 每次 `ask` 的统一事件 transcript（含用量/审批留痕） |
| `health.json` | 服务健康缓存，带 `at` 时间戳，聚合灯取最老一条的年龄 |
| `services.json` | 服务清单（`services init` 生成骨架 + 手工校准，含 L2/L3 探针声明） |

- `--json` 事件流里不含任何凭据：凭证只由各引擎自己从 Keychain / 自己的配置读取。
- **CI 跑不了 `doctor`**：它要的是本机已登录的引擎（claude/codex/gemini/codebuddy/qoder）
  和真实 spawn。CI 里只能跑 `npm run typecheck`；`doctor`/`ask` 属于本机自检命令。

## 下一步

1. 等 AgnesCode GUI 同步 `AGNES_AI_API_KEY` 后端到端验 `ask agnes`（transport/doctor 已完成，只差 key）。
2. Web 面板加 Tauri 壳 + 审批中心（guard 模式的 y/N 目前只在 CLI 里交互）。
3. MCP Hub 继续补全：dir 型源（trae）写回、per-MCP tool 级缓存与调用统计。
4. transcript 迁 SQLite + 会话恢复（`session/load`，引擎均支持）；用量/成本看板 + 预算护栏；
   对接 `~/.omh`（oh-my-hermes）已有服务清单。
