# CodeMap

在 VS Code 里同时看清**项目版图**和**架构执行流**：零配置扫出目录领地，再用 AI 把业务理解落成可跳转的架构图。点击节点直接用原生 LSP 打开文件和行；选中代码可以让架构图 AI 追影响。Cursor、Claude Code、Codex 也能通过本机 MCP 读同一张图。

## 两种地图

| | 项目地图 Project Map | 架构图 Architecture Map |
| --- | --- | --- |
| 输入 | 当前工作区目录，无需配置 | `codemap/` 节点库，可由 AI 从仓库和文档生成 |
| 粒度 | 目录、模块、文件领地 | L0 总览、并行 L1、函数级执行流 |
| 适合 | 刚打开陌生仓库，先看边界和归属 | 对齐业务、追一条调用链、改动前看影响 |

## 三步开始

1. 打开任意文件夹。按 `⇧⌘M`（Windows / Linux：`Ctrl+Shift+M`），或点活动栏 CodeMap 图标，立刻看到零配置项目地图。
2. 按 `⇧⌘Y`（Windows / Linux：`Ctrl+Shift+Y`）打开架构图，点 **「初始化 `codemap/` 并用 AI 建图」**。AI 读仓库和文档，在 `review_gate` 对齐业务理解，再生成 L0、并行 L1 和函数执行图，并在展示 `✦ 提议` 预览前自动修正拓扑规则。
3. 点任意节点或步骤，在原生 VS Code 编辑器打开对应文件和行。选中代码，右键 **「用架构图 AI 分析选中代码」** 追影响。

## 内置四模式 AI

| 模式 | 做什么 |
| --- | --- |
| 问答 Ask | 对着现有地图和代码提问，不改节点库 |
| 调整 Adjust | 在已有图上改节点、边和执行步骤 |
| 新建 Build | 从仓库和文档新建 L0、L1 与函数执行图 |
| 需求 Requirement | 把一段需求拆成待确认的架构变更，先出 `✦ 提议` |

## 零配置模型

CodeMap 会自动读取本机 `~/.claude/settings.json` 和 `~/.codex/config.toml` 里已有的模型配置。也可以在 **CodeMap：AI 与模型设置** 里添加自定义 OpenAI 或 Anthropic 兼容服务。密钥只写入 VS Code `SecretStorage`，不明文落盘。

## 外部 AI

运行 **CodeMap：连接外部 AI (Cursor / Claude Code / Codex MCP)**。桥接只监听 `127.0.0.1`，使用一次性 bearer token，把当前地图提供给 Cursor、Claude Code 或 Codex。可在设置里关闭 `codemap.mcp.enabled`。

## 命令、快捷键与设置

| 命令 | 快捷键 | 作用 |
| --- | --- | --- |
| CodeMap: Open Project Map | `Ctrl+Shift+M` / `⇧⌘M` | 打开项目地图 |
| CodeMap: Open Architecture Map | `Ctrl+Shift+Y` / `⇧⌘Y` | 打开架构图 |
| CodeMap：初始化架构图节点库 (codemap/) | — | 创建并可交给 AI 建图 |
| CodeMap：AI 与模型设置 | — | 选择模型与供应商 |
| CodeMap：用架构图 AI 分析选中代码 | 编辑器右键 | 追选区的架构影响 |
| CodeMap：连接外部 AI | 侧边栏溢出菜单 | 配置本机 MCP |

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `codemap.libraryPath` | `""` | 节点库相对或绝对路径，例如 `codemap`；可写入 `.vscode/settings.json` 共享 |
| `codemap.defaultSurface` | `panel` | 新地图打开到编辑区 `panel` 或侧边栏 `sidebar` |
| `codemap.followCursor` | `false` | 地图是否跟随当前光标 |
| `codemap.agent.maxParallel` | `3` | AI 任务并行数，范围 1–8 |
| `codemap.mcp.enabled` | `true` | 是否启用 `127.0.0.1` MCP 桥接 |

## 安全

- 密钥和 token 不写明文，只进 VS Code `SecretStorage`。
- 读取工作区以外的目录前，必须先给出显式只读授权。
- MCP 只绑定 `127.0.0.1`，并使用一次性 bearer token。

## English

CodeMap is a Project Territory Map plus an Architecture Map. Open any folder with `Ctrl+Shift+M` (`⇧⌘M` on macOS) for a zero-config territory view. Open the Architecture Map with `Ctrl+Shift+Y` (`⇧⌘Y`), initialize `codemap/`, and let the built-in AI align business understanding at `review_gate`, then build L0, parallel L1, and function execution graphs. Click a node to jump to the file and line with native VS Code LSP. Select code and use **Ask Architecture Map AI About Selection** to trace impact.

The assistant has four modes: Ask, Adjust, Build, and Requirement. It detects `~/.claude/settings.json` and `~/.codex/config.toml`, and can store custom OpenAI or Anthropic provider keys in VS Code `SecretStorage`. **Connect External AI** exposes the map to Cursor, Claude Code, and Codex on a `127.0.0.1` loopback MCP bridge with an ephemeral bearer token. No secret is stored in plaintext, and reads outside the workspace require an explicit read-only grant.
