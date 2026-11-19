# Changelog

## 0.1.0

- 零配置项目地图：打开文件夹即可查看目录与模块领地。
- 架构图节点库 `codemap/`：L0、并行 L1 与函数级执行流。
- 点击节点或步骤，用原生 VS Code LSP 打开对应文件和行。
- 内置四模式 AI：问答 Ask、调整 Adjust、新建 Build、需求 Requirement。
- 自动识别 `~/.claude/settings.json` 与 `~/.codex/config.toml`；自定义供应商密钥写入 `SecretStorage`。
- 本机 `127.0.0.1` MCP 桥接，供 Cursor、Claude Code、Codex 读取当前地图。
- 新增命令：初始化节点库、AI 与模型设置、分析选中代码、连接外部 AI。
- 新增工作区设置：`codemap.libraryPath`、`codemap.defaultSurface`、`codemap.followCursor`、`codemap.agent.maxParallel`、`codemap.mcp.enabled`。
