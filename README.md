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
| `src/sessions.ts` | L2 持久化 | JSONL transcript（写入源）+ SQLite 读模型（`src/store.ts`） |
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
  ③ ~~真实回合还差 `AGNES_AI_API_KEY`~~ → 已破，见下节「Agnes API key 接入真相」（零 env 可跑）。

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

### 9. Agnes API key 接入真相：自定义 provider + `requiresAuth: true`

用户的 key 属 **API-hub 型**（`apihub.agnes-ai.cn/v1` → 200 模型列表；`api-agnes-code.*` → 401 `000501`，
不是账号会话 token）。正路是注册自定义 provider：

```
ACP 扩展方法 _agnes/unstable/providers/custom/update
  → custom_agneshub（engine=openai_compatible, apiUrl=https://apihub.agnes-ai.cn/v1, 6 个模型）
  → 关键：必须 requiresAuth: true，否则 apiKey 被静默丢弃（apiKeySet:false）
config.yaml active_provider: custom_agneshub（GUI 与 agentbd 同源）
```

- **零 env `ask agnes` 全通**：回复真实内容、stop=end_turn、transcript 落盘、用量可读。
- 弯路清单（勿重复）：config.yaml 直写不进运行时；`AGNES_AI_API_KEY`/`AGNES_API_URL`/`OPENAI_API_KEY`
  env 注入对 custom provider 无效；`config/save` 拒绝任意字段名；`OPENAI_CUSTOM_HEADERS` 能存进
  secret store 但运行时不合并；`env_vars[].default` 不进请求，且写坏类型会让 provider 加载失败。
- **事故教训**：custom provider JSON（`~/.agnes/config/custom_providers/*.json`）只能由 ACP 方法改——
  手工 `JSON.parse→stringify` 重写曾与服务端写入竞态，把刚注册的 apiKey 状态抹掉（全线 401），
  重新 `custom/update` 后恢复。

### 10. 会话恢复：`ask --resume`（session/load）

```
$ agentbd ask agnes '记住暗号：ORCA-77。只回复：已记住'      → 已记住   (session 20260923_18)
$ agentbd ask agnes '刚才的暗号？' --resume last             → ORCA-77  (同 session，跨进程恢复)
```

- `--resume last|<sessionId>`：从本地 transcript 解析目标（`sessions.resolveResume`），cwd 以原会话为准；
  引擎不匹配直接报错（恢复不跨引擎）。
- bus 层按能力选路：`caps.loadSession` → `session/load`（agnes），
  否则 `caps.sessionCapabilities.resume` → `session/resume`（qoder）；都没有则报错。
- `attachSession` 在 sdk d.ts 里标 private 但 JS 公开；load/resume 响应体无 sessionId，手动并入。

### 11. Web 审批中心 + 用量看板

```
POST /api/ask {engine, prompt, approval:"guard"}  → 高风险工具 → SSE approval.request {id, tool, risk}
POST /api/approve {id, allow}                     → {decided:true} → 引擎继续 → ask.done
GET  /api/stats / agentbd stats                   → 轮次/tokens/成本，按引擎聚合（扫 transcript 末条 usage）
```

- E2E：guard 模式让 claude 写 `/tmp` 文件 → SSE 收到 `approval.request(a1, Bash, high)` →
  `approve allow` → 文件落盘、`ask.done`；120s 未决自动拒绝（`approval.timeout`）。
- UI：审批条内嵌事件流（允许/拒绝按钮）、侧栏「用量」面板、ask 表单带续接输入框。
- `agentbd stats`：27 transcripts · 17.3 万 tokens · $0.47（claude 计费，agnes 未返回成本）。

### 12. 预算护栏：看板的闭环（能看 → 能限）

```
$ agentbd budget set dailyTokens=100000 dailyUsd=5 [monthlyTokens=… warnAt=0.8]
$ agentbd budget                 → 限额 + 今日/本月用量 + 超限/告警状态
$ agentbd ask agnes …            → 超限: "预算超限，已拦截本次调用：今日 tokens …"（spawn 前就拒，exit=1）
$ agentbd ask … --no-budget      → 临时跳过
```

- 限额存 `~/.agentbd/budget.json`（原子写）；`runTurn` 在 **spawn 引擎之前**检查，CLI/Web 同源生效；
  近限（默认 80%）发 notice 告警（SSE 直接可见），Web 用量面板顶部有预算灯（超限变红）。
- 口径：tokens 全引擎有效；costUsd 只对回传成本的引擎（claude）累计——agnes 要限请用 tokens。
- E2E：`dailyTokens=1` → ask 被拦截（exit=1）→ `budget clear` → ask 恢复（真实 OK 回合）。

### 13. SQLite 索引层 + 工具级统计 + probe 缓存（2026-09-23）

```
$ agentbd db import      → 新增 29 / 共 29 个 jsonl → turns=29 events=369（幂等，重跑新增 0）
$ agentbd stats          → SQL 聚合全量（不再受 500 文件截断）
$ agentbd stats tools    → tool.call 事件 GROUP BY：engine × 工具 × 调用次数
$ agentbd mcp probe      → 第二次 0ms（缓存）；--refresh 强制真探
```

- **jsonl 仍是写入源**（append-only 崩溃安全），`~/.agentbd/agentbd.db` 只是读模型/索引：
  写路径一行未改，回合结束 `indexTranscriptFile` 增量入库；读路径（sessions/stats/budget）
  每次先 `syncIndex()`（SELECT file 比对，只解析新文件）再 SQL 查询——索引永远跟得上写。
- **降级设计**：`node:sqlite` 动态 import，Node < 22.13 或索引失败时自动回退 jsonl 扫描，
  功能不缺；索引失败绝不影响 ask 主流程。
- `stats tools` 顺带完成了「MCP 调用统计」的可达部分：引擎自己接的 MCP 工具调用
  会以 tool.call 事件经过总线，全部落 events 表可聚合。
- probe 缓存：成功的 tools/list 缓存 2min（`~/.agentbd/mcp-probe-cache.json`，原子写），
  **失败结果不缓存**（立即重试）；`--refresh` 绕过。
- 两项原计划经实测**不适用**（勿再排期）：
  - trae dir 写回：`~/.trae-cn/mcps/s_*` 是 workspace 级**工具缓存**（Exec.json 工具描述），
    不是 MCP server 配置——没有可写标的，dir 型源维持拒写；
  - `~/.omh` 对接：manifest.json 是 oh-my-hermes 的 skill profile 元数据、targets.json 是
    hermes target 注册表，**没有带端口的服务清单**，无可对接内容。

### 14. launchd 按需唤醒：`serve install`（2026-09-23）

解决「面板要好用又不想养一个常驻进程」——**零常驻开销**方案：

```
$ agentbd serve install    # 写 plist + launchctl bootstrap，完成
$ curl http://127.0.0.1:7787/api/stats   # 首个连接 → launchd 自动拉起进程 → HTTP 200
$ agentbd serve status     # state=not running（未在跑，等待首个连接拉起）
$ agentbd serve uninstall  # 一键还原
```

- 机制：plist 声明 `Sockets.Listeners` + `inetdCompatibility.Wait=true` →
  **launchd 内核态持有 7787 监听 socket**，有连接才 bootstrap 本进程，
  监听 fd 出现在 stdin（fd 0），Node `server.listen({fd:0})` 接管——纯 Node，无原生依赖。
- **空闲自退**：无活跃连接持续 `--idle` 分钟（默认 10）自动退出，下次连接再拉起；
  SSE 长连接算活跃，所以面板开着不会被掐，关掉浏览器 10 分钟后进程归零。
- 实测：冷启动首请求 ~1.2s；空闲 18s（测试档）后进程退出、再连即重启 ✔。
- 冲突保护：install 前检查端口占用，已有手动 `serve` 在跑会拒绝并提示。
- 日志：`~/.agentbd/serve.{out,err}.log`；plist：`~/Library/LaunchAgents/ai.agentbd.serve.plist`。


## 安全边界（P0 已实现）

- `AGENTBD_DEPTH` 守卫：**禁止 agent 套 agent**（Agnes/WorkBuddy 内部也会拉起别的 agent，会翻倍消耗）。
- client `fs` 能力白名单：`fs/read_text_file`、`fs/write_text_file` 只允许在 `--cwd` 根目录内活动。
- 诚实能力声明：P0 未实现 ACP 终端 → `terminal: false`（而不是宣告后报错）。
- 审批三模式 + 每条审批留痕（`result.approvals`）。

## 本地数据与 CI 说明

所有运行时状态都在 **`~/.agentbd/`（仓库之外，永不入库）**：

| 文件 | 内容 |
|---|---|
| `sessions/*.jsonl` | 每次 `ask` 的统一事件 transcript（含用量/审批留痕）——**写入源** |
| `agentbd.db` | SQLite 读模型/索引（turns + events 表，由 jsonl 增量构建，删了可随时 `db import` 重建） |
| `budget.json` | 预算限额（dailyUsd/monthlyUsd/dailyTokens/monthlyTokens/warnAt） |
| `mcp-probe-cache.json` | MCP tools/list 探针结果缓存（TTL 2min，只缓存成功结果） |
| `health.json` | 服务健康缓存，带 `at` 时间戳，聚合灯取最老一条的年龄 |
| `services.json` | 服务清单（`services init` 生成骨架 + 手工校准，含 L2/L3 探针声明） |

- `--json` 事件流里不含任何凭据：凭证只由各引擎自己从 Keychain / 自己的配置读取。
- **CI 跑不了 `doctor`**：它要的是本机已登录的引擎（claude/codex/gemini/codebuddy/qoder）
  和真实 spawn。CI 里只能跑 `npm run typecheck`；`doctor`/`ask` 属于本机自检命令。

## 下一步

**P1 已收官（2026-09-23）**：清单项全部完成或查明关闭——AgnesCode 接入（§9）、会话恢复（§10）、
审批中心（§11）、预算护栏（§12）、SQLite 索引 + tool 统计 + probe 缓存（§13）、launchd 按需唤醒（§14）、
服务大盘治理（幽灵条目/端口笔误/裸奔 plist 清除 + 发现逻辑修复 + 进程存活探针，8 服务全绿）。
trae dir 写回与 `~/.omh` 对接经实测不适用，明确关闭（§13）。

**P2 进行中**：

- ✅ **P2-1 全量 ACP（2026-09-24）**：`terminal/*` 能力面完整接入（`TerminalRegistry`：create/output/
  wait_for_exit/kill/release，1MB 滚动缓冲 + 整串 command 的 shell 回退 + spawn 失败 close 兜底）；
  终端创建视同高危 execute 走审批管线（guard 弹审批 / auto 放行 / deny 拦截）；stdout/stderr 经
  总线事件实时推送。归一化层新增 `terminal.create/output/exit` 事件 + tool.call/result 携带
  `diffs`（ACP ToolCallContent type=diff 提取）。CLI 渲染终端输出与行级微 diff（前后缀裁剪），
  Web 面板新增终端卡片（实时滚动）、plan 时间线卡片、diff 红绿卡片。回归夹具：
  `scripts/fake-acp-agent.mjs`（不接模型的受控 ACP agent，一条 prompt 打全 plan/terminal/diff）。
  面板上限 = ACP 协议全集，至此达成。

- ✅ **P2-2 告警通知（2026-09-24）**：`src/notify.ts`——macOS 系统通知（osascript，零依赖）+ 可选
  webhook 双通道，配置在 `~/.agentbd/notify.json`（`enabled`/`webhook`/`minIntervalSec`，缺文件默认开），
  同 tag 去抖防刷屏，通知失败绝不影响业务。三个触发点：审批挂起/超时（server.ts，面板关着也知道
  有决策在等）、预算超限拦截与近限告警（bus.ts，CLI/ serve 同源）、服务红灯迁移与恢复
  （server.ts 2 分钟 L1 watcher，首轮建档不轰炸）。注意：launchd 按需唤醒模式下 serve 空闲退出后
  红灯 watcher 随之停止，要持续监控请常驻 `agentbd serve`。
- ✅ **P2-3 桌面壳（2026-09-24）**：`shell/AgentbdPanel.swift`——纯 Swift 的 WKWebView 包装
  （选 Swift 而非 Tauri：本机已有 Xcode 工具链，系统 WebView 够用，壳不增加功能只做分发）。
  `agentbd panel build/install/open`：编译进 `~/Applications/agentbd-panel.app`，install 加登录项
  开机自启。托盘红绿灯（30s 轮询 /api/state 取最差一档），与 launchd 按需唤醒协同：
  serve 空闲时进程数为 0，壳的首次连接自动拉起后端（1.5s 重试抹平冷启动）。
- ✅ **P2-4 多机/团队（2026-09-24）**：hub-spoke 汇总 + 共享预算池。hub 侧
  `agentbd serve --host 0.0.0.0 --token <密钥>`（非回环绑定无 token 拒绝启动；/api/* 与 /events
  全部 Bearer 鉴权，SSE 走 ?token=）；spoke 侧 `agentbd team join <hub> token=…`（连通后才落
  ~/.agentbd/team.json），`team report` 上报聚合用量（只有轮次/tokens/成本，不含 prompt 原文，
  存 hub 的 team_reports 表），`team list` 看全队视图。共享池限额（sharedDailyTokens/
  sharedMonthlyTokens）在 checkBudget 内判定：超限在**任意一台**机器的 ask 前拦截；
  hub 不可达 fail-open（本机限额仍生效）。关键修复：hub 自身 HTTP handler 用
  `checkBudget({skipTeam:true})`，否则 hub 指向自身时 /api/team 无限自指递归。

**P2 已收官**（P2-1 全量 ACP · P2-2 告警通知 · P2-3 桌面壳 · P2-4 多机/团队）。

