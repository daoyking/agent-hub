# Agent 目录（Agent Catalog）

来自 [deepseek-ai/awesome-deepseek-agent](https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/README.zh-CN.md)
的 23 个工具，**按 agentbd 能否真正驱动**分类。

> ⚠️ **不要把 23 条全塞进 `engines.json`。** agentbd 的引擎模型是
> 「一条记录 = 一条 ACP 启动命令」。没有 ACP 的工具塞进去只会得到一排
> ⚫ 灰灯（未安装）或 🔴 红灯（装了但握手失败）——正是本项目这几个月一直在
> 消灭的"假信号"。所以下面按**实测结论**分类。

## ✅ 已接入且实测通过（10 个内置引擎）

| id | 工具 | 启动方式 | 备注 |
|---|---|---|---|
| `claude` | Claude Code | `claude-agent-acp` | 官方适配器 |
| `codex` | Codex | `codex-acp` | 官方适配器 |
| `gemini` | Gemini CLI | `gemini --acp` | 原生 ACP |
| `qoder` | Qoder CLI | `qoder --acp` | 原生 ACP |
| `codebuddy` | WorkBuddy/CodeBuddy | 内置内核 `--acp` | 原生 ACP |
| `agnes` | Agnes Code | `agnesd agent` | acp-service（HTTPS+wss） |
| `opencode` | OpenCode | `opencode acp` | 原生 ACP |
| `openclaw` | OpenClaw | `openclaw acp` | gateway-backed |
| `omp` | Oh My Pi | `omp acp` | 原生 ACP，能力最全（fork/resume） |
| `qwen` | Qwen Code | `qwen --acp` | 原生 ACP（qwen-code 0.24.6 实测），与 gemini-cli 同源 |

## ❌ 已实测确认**无 ACP**（装了才知道，别再猜）

| 工具 | 怎么验的 | 结论 |
|---|---|---|
| GitHub Copilot CLI | `npm i -g @github/copilot` 装好后查 `--help` + 扫二进制 | `--help` **无 acp 子命令**；二进制里 5 处 "acp" 全是随机字节误匹配（无 `agent-client-protocol` 字样）→ **无 ACP** |
| Crush | 查上游源码 `cmd/crush/main.go` + README | main.go **0 处 acp**，README 也不提 → **无原生 ACP**（本机 brew 下载持续超时未装成，但源码证据已足够） |

## 🟡 特殊说明

| 工具 | 说明 |
|---|---|---|
| Hermes | 本机跑着 gateway（:65359），但那是**服务网关**不是 ACP agent，无法直接当引擎用 |

装完后这样加（id/args 按实际 `--help` 校正）：

```jsonc
// ~/.agentbd/engines.json
[
  { "id": "crush", "label": "Crush", "vendor": "Charm", "command": "crush",
    "args": ["acp"], "channel": "acp" }
]
```

## ❌ 无 ACP 通道（桌面包 / 聊天机器人 / MCP 服务）

| 工具 | 形态 | 为什么加不进来 |
|---|---|---|
| Cherry Studio | 桌面客户端 | GUI 应用，无 headless ACP |
| Cline | VS Code 扩展 | 编辑器扩展（`code-sidecar` 在本机跑着，但没对外 ACP 端点） |
| Kilo Code | CLI + 扩展 | 编辑器侧为主，CLI 无 ACP |
| GitHub Copilot（VS Code 内） | 编辑器扩展 | 同 Cline |
| LobeHub | 平台 | 编排平台，非单 agent CLI |
| AstrBot | 机器人框架 | 消息平台接入，无终端 agent |
| nanobot | 轻量智能体 | 框架，未见 ACP |
| DeepSeek-TUI / Reasonix / Deep Code | Rust 终端 agent | **未在本机安装，ACP 支持未验证** |
| Oh My Pi（Pi） | 终端框架 | `pi --help` **无 acp 子命令**（`omp` 才是它的 ACP 分支） |
| LangCLI | Claude Code 兼容层 | 兼容 API 而非协议 |

## 📌 结论与建议

- **8 个已接入**，覆盖了 awesome 列表里绝大多数「终端可驱动」的工具；
- 列表里剩下的多数是**桌面应用 / 编辑器扩展 / 聊天机器人**，与 agentbd 的
  「终端 agent 总线」定位不符，硬加只会制造噪音；
- 想扩充的话，正确路径是**先装 → `agentbd doctor` 验证 → 再写进 engines.json**，
  而不是反过来。新增引擎的边际成本就是加一条记录（README 设计原则）。

### 怎么验证一个新工具能不能接

```bash
<tool> --help | grep -i acp        # 有 acp 子命令？
strings $(command -v <tool>) | grep -c agent-client-protocol
# 装好后直接加 engines.json 跑 agentbd doctor，握手结果就是结论
```

### 安装 qwen-code 时的 npm 警告（**不用管**）

```
npm warn install-scripts Run `npm install -g --allow-scripts=@qwen-code/audio-capture`
  to allow these scripts once, …
```

**这是良性的，别改全局 npm 配置。** 三条实测依据：

1. **预编译产物本来就在包里**——`@qwen-code/audio-capture@0.24.6` 自带
   `prebuilds/darwin-arm64`（688K）。`install.js` 跑的 `node-gyp-build` 只是
   **定位**这个已存在的二进制，不是编译它。脚本跳过 = 少跑一次定位而已。
2. **上游明确设计成非致命**——install.js 注释原文：
   *"A failed or impossible build is intentionally NON-FATAL: voice input falls
   back to the SoX/arecord recorder, so installing the CLI must never break for
   this optional capability"*。失败路径只打印一行
   `voice input will fall back to SoX/arecord`。
3. **只影响语音输入**——麦克风原生后端，与 agentbd 的用法（ACP 驱动做编程任务）
   无关。qwen 握手正常、能力完整（loadSession/resume/list，auth: openai）。

真要用语音输入且 SoX/arecord 也不可用时，再单独装：
`npm i -g --allow-scripts=@qwen-code/audio-capture`

> 本机 npm 已配 `allow-scripts=context-mode,better-sqlite3`（白名单制）。
> 那是**有意的安全策略**——不要为了消掉一条警告就把它全局放开。
