# 用 AI 建架构图

[初始化节点库](command:codemap.codemap.initLibrary)

初始化 `codemap/` 之后，用 AI 建图。它会阅读仓库和文档，在 `review_gate` 对齐业务理解，再生成 L0、并行 L1 和函数执行图。展示 `✦ 提议` 预览之前，会先自动修正拓扑规则。

[AI 与模型设置](command:codemap.agent.openSettings)

已有的 Claude 与 Codex 本机配置会被自动识别。自定义 OpenAI 或 Anthropic 供应商的密钥只保存在 VS Code `SecretStorage`。
