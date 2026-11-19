# 连接外部 AI

[连接外部 AI](command:codemap.mcp.setup)

这条命令把当前 CodeMap 通过 MCP 提供给 Cursor、Claude Code 和 Codex。桥接只监听 `127.0.0.1`，并使用一次性 bearer token。

不需要外部连接时，把 `codemap.mcp.enabled` 设为 `false`。读取工作区以外的目录前，CodeMap 会要求单独的只读授权。
