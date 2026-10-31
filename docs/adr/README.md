# Architecture Decision Records

本目录记录影响本地翻译系统边界、数据契约和运行行为的架构决策。实现修改应遵循仍处于 Accepted 状态的 ADR；如果决定改变，先更新对应 ADR，再同步架构文档、代码与测试。

| ADR | 状态 | 决策 |
|---|---|---|
| [ADR-0001：统一本地翻译管线与初译上下文增量](0001-unified-local-translation-context-delta.md) | Accepted | 阅读页、Agent Workspace、CLI 和项目 API 共享一个 Run executor；文学初译生成有证据的 context_delta，以冻结波次动态更新后续批次上下文，所有自动生成记录保持候选态。 |
| [ADR-0002：本地翻译全流程审计账本与原始来源保全](0002-local-translation-audit-ledger-and-source-preservation.md) | Accepted | 原始文件、分段原文、逐次模型调用输入输出、审校/重试/修订和状态转换必须可回溯；设置页展示服务实际数据路径。 |
| [ADR-0003：服务端项目权威与扩展离线副本](0003-server-authoritative-project-state.md) | Accepted | Local Agent 服务 SQLite 是已存在项目的权威数据源；扩展打开/恢复时从服务发现项目并刷新译文、运行和记忆，扩展本地记录只作同步副本与离线恢复，不得自动覆盖已有服务端状态。 |
| [ADR-0004：全书文风基准采用分维度、可审阅的分析契约](0004-evidence-grounded-style-guide.md) | Accepted | 全书文风按七个维度分析、持久化和映射；完整且版本匹配的机器文风可按策略自动应用，用户编辑/确认优先，机器应用不冒充用户确认。 |
| [ADR-0005：文学翻译必须先完成当前版本的全书预处理](0005-literary-preprocessing-before-translation.md) | Accepted | 文学翻译模型调用前必须完成当前原文版本、分析版本和语言方向匹配的全书预处理；扩展做 UI 前置检查，服务端 executeRun 做最终门禁；失败时 fail closed。 |
| [ADR-0006：基于可核验原文证据自动激活人物声音画像](0006-evidence-verified-character-voice-activation.md) | Accepted | 人物声音画像满足多片段、多维度的当前版本原文证据门槛后自动激活；证据失效自动降级；不放宽人物关系和声音锚点门槛。 |
