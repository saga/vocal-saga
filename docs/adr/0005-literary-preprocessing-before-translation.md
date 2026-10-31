# ADR-0005：文学翻译必须先完成当前版本的全书预处理

- 状态：Accepted
- 日期：2026-10-31
- 适用范围：Local Agent 文档项目中的文学模式（小说、散文、回忆录及其他文学类长文）
- 关联仓库：[vocal-saga](https://github.com/saga/vocal-saga)、[fanyi-extension](https://github.com/saga/fanyi-extension)
- 相关决策：[ADR-0003：服务端项目权威与扩展离线副本](0003-server-authoritative-project-state.md)、[ADR-0004：全书文风基准采用分维度、可审阅的分析契约](0004-evidence-grounded-style-guide.md)

## 背景

文学长文的翻译质量依赖跨章节人物、关系、实体、叙述风格和章节上下文。若在全书预处理尚未完成时就开始翻译，前面的批次可能缺少后续才建立的书籍级基准，造成同一本书不同批次使用不同上下文。预处理失败后再静默退化为逐章临时补充，也无法保证全书一致性。

Local Agent 已经拥有服务端 SQLite Context Graph、可恢复的预处理工作流和按批次构建的 TranslationBrief。问题不应通过扩展复制图谱或另建一套分析系统解决。

## 决策

1. **先完成全书预处理，再开始任何文学翻译模型调用。** 对同一个文学翻译操作，当前 source revision 的 Context Graph 必须先完成并通过 readiness 检查。技术文档模式不受此门禁影响。
2. **预处理结果必须属于本次翻译的准确输入版本。** readiness 必须同时匹配 sourceRevisionId、服务端当前 CONTEXT_GRAPH_ANALYSIS_VERSION、sourceLang 和 targetLang；不能把旧原文版本、旧分析版本或其他语言方向的结果用于当前 Run。
3. **完成状态不是单独的充分条件。** 必须有受支持的工作流策略（A 或 B）、大于零的有效分析样本、完整的五项必需文风基准（叙述声音、语域、节奏与句法、对白特征、措辞与词汇）及至少一条 style rule。B 工作流还必须完成 style、characters、entities、relationships、chapters 五个阶段。styleAvoid 可以为空；它不是强制字段。
4. **区分预处理完整性与用户确认。** styleGuideReady 表示服务端分析契约完整，不代表用户已经确认文风。符合版本和完整性要求的机器文风基准可按现有策略自动应用；明确的用户编辑/确认具有更高优先级。自动应用不得伪装成用户确认。中文 Literary Editorial Profile 仍遵循其独立的用户确认契约。
5. **扩展负责正常 UI 前置检查，服务端负责最终执行门禁。** 扩展从轻量 /context-graph/status 投影读取状态；来源、版本、语言、阶段或完整性未通过，以及状态读取失败时，文学翻译入口必须 fail closed，不创建新的翻译 Run。扩展不下载或复制图谱节点、证据和章节摘要。
6. **服务端门禁不可绕过。** executeRun 在 Run 进入 running、读取待翻译片段和调用翻译模型之前再次验证。旧版客户端或直接 API 调用可能先持久化一个 queued Run；服务端可以自动启动/等待匹配的 Context Graph，但在 readiness 通过前绝不进入翻译阶段或写入译文候选。Run 创建本身不等于翻译已经开始。
7. **预处理首次启动与失败恢复采用不同策略。** 对从未分析过的当前来源版本，扩展在建立项目后自动触发一次预处理并展示进度。失败、过期、版本/语言不匹配或完整性不足时，不无限自动重试；用户可在“人物与预处理”显式重新分析。服务端对直接 API Run 保留有限自动启动/等待和明确失败诊断。
8. **预处理失败必须 fail closed。** 不允许把全书预处理失败转换成警告后继续逐章文学翻译。旧的本地文学翻译路径也不得在全书分析失败、未确认完成或缺少可用书籍上下文时继续。
9. **保留可恢复性和历史。** 预处理 run、检查点、失败原因和事件保存在服务端项目 SQLite。重分析不能改写旧 Run 固定的 source/memory/TranslationBrief 快照，也不能覆盖已采纳译文或人工修订。

## 职责边界

- local-agent-service：Context Graph 运行、持久化、证据校验、readiness 计算、直接 API Run 的最终门禁、失败诊断和事件轨迹。
- fanyi-extension：新项目首次预处理触发、轻量状态轮询、用户显式重分析入口、文学 Run 的 UI readiness gate，以及翻译进度展示；不持有图谱事实、不实现第二套分析算法。
- 技术文档翻译：继续使用统一 Project/Run executor，但不要求 Context Graph 文学预处理。

## 后果

- 新文学翻译不会在缺少全书上下文时提前开始；预处理失败会明确阻止，而不是悄悄降低质量。
- 正常扩展路径会先显示全书预处理状态，readiness 通过后才允许开始/恢复/重译。
- 服务端仍能保护绕过扩展的调用方；此类调用可能产生 queued Run 记录，但不会提前调用翻译模型。
- 预处理会增加首次翻译前的等待时间，这是质量优先的明确取舍。
- 不引入第二份 Context Graph、扩展端全书记忆副本或新的并行 Agent 流水线。

## 验收标准

1. 当前原文版本、分析版本或语言方向不匹配时，文学 Run 不调用翻译模型。
2. 状态未知、预处理 queued/running/failed 或完整性不足时，扩展不创建文学翻译 Run。
3. B 策略缺少任一必需阶段时，服务端和扩展都拒绝 readiness。
4. 直接调用 Run API 时，服务端可持久化 queued Run，但在 Context Graph ready 前不得将 Run 设为 running、调用翻译模型或保存候选。
5. 预处理失败不会退化为逐章分析后继续文学翻译。
6. 技术模式不被 Context Graph 门禁阻断。
7. 既有 accepted translation、人工修订和旧 Run 快照在重新分析后保持不变。