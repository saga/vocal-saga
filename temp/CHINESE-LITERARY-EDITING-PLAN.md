# 中文文学编辑（Chinese Literary Editing）实施计划

- 状态：已实施，待本地 CI / 测试环境验证
- 实施分支：`main`
- 适用范围：`local-agent-service` 的文学类文档翻译
- 核心决策：扩展现有 Literary Style Review，不新增 Pipeline Stage，不增加 LLM 调用

## 1. 背景与目标

当前译文可能在语义准确、人物名称统一的前提下，仍然保留英文句法痕迹或不符合自然中文表达的习惯。例如不必要地重复“我”“我的”，连续堆叠“的、地、得”，机械保留英文关系从句、被动句和多层定语结构等。

本能力命名为 **Chinese Literary Editing（中文文学编辑）**，不是中文小说编辑。适用作品包括小说、散文、回忆录、传记、文学纪实、文学随笔等。目标不是统一成某种小说腔，而是让译文符合中文文学阅读习惯，同时保留作品自身的语体、叙述声音和修辞。

## 2. 现有 Pipeline 检查结论

检查了以下实现：

- `docs/TRANSLATION_PIPELINE.md`
- `local-agent-service/src/documents/translationAgent.ts`
- `local-agent-service/src/literary.ts`
- `local-agent-service/src/documents/translationBrief.ts`
- `local-agent-service/src/documents/voiceContext.ts`
- `local-agent-service/tests/document-agent-prompt.test.mjs`
- `local-agent-service/tests/literary-voice.test.mjs`

当前本地文学翻译已经具有以下结构：

1. 初始翻译使用项目级 TranslationBrief。
2. Accuracy / Terminology Review 检查误译、漏译、实体译名等问题。
3. 现有 Style Review 检查人物声音、叙述声音、语域、节奏和翻译腔。
4. 两类 Reviewer 复用同一个批次的来源版本、上下文快照、人物声音和术语边界。
5. 文风修订作为可选候选及 finding 保存，不静默覆盖初译；准确性和术语修订遵循现有 must-fix 机制。
6. Style Review 已有独立的任务配置、缺失片段补审、事件记录和并发调度。

因此，中文文学编辑并不是一个缺失的 Pipeline Stage，而是现有 Style Review 的能力缺口。再增加独立阶段会造成重复上下文、额外模型调用和多轮编辑互相覆盖。

## 3. 架构决策

### 3.1 合并位置

将中文文学编辑纳入现有 `style-review` / `buildLiteraryReviewPrompt()`：

- 不新增 Pipeline Stage。
- 不新增 Reviewer 服务或 Agent。
- 不增加模型调用。
- 不修改 Accuracy / Terminology Review 的职责。
- 不修改 TranslationBrief、分块、调度、缓存、持久化和取消恢复协议。
- 中文编辑与人物声音、叙述风格、语域、节奏在同一次 Style Review 中协同判断。

逻辑职责独立，运行阶段复用。中文文学编辑是 Style Review 的一个明确子任务，不是额外流水线节点。

### 3.2 语言范围

仅当目标语言为中文（`zh`、`zh-CN`、`zh-TW` 等 zh 前缀形式）时，注入中文文学编辑规则。其他目标语言保持原有 Style Review Prompt，不受中文规则影响。

### 3.3 编辑原则

优先级：

1. 原文语义、信息完整性、叙述视角和时间关系。
2. 已确认的术语、人物名称和称谓。
3. 作品自身的叙述声音、人物声音和文体。
4. 自然、成熟的中文表达。
5. 局部简洁和节奏优化。

不得为了中文顺口而改变前四项。

## 4. 编辑范围

| 维度 | 编辑内容 |
|---|---|
| 代词 | 删除不必要的“我、你、他、她、它”及所属表达；保留必要指代 |
| 助词 | 检查“的、地、得”及虚词堆叠；按语义和节奏调整 |
| 句法 | 清理英文语序、关系从句、嵌套定语、被动句、名词化和介词结构 |
| 翻译腔 | 改善僵硬连接词、不自然搭配和逐词对应表达 |
| 冗余 | 处理重复意思、空泛动词和不必要的程度副词 |
| 词汇 | 改善动词、形容词、副词及词语搭配，不追求华丽 |
| 节奏 | 调整长短句、停顿、衔接和段落阅读节奏 |
| 文体 | 保留作品的叙述视角、语体、人物声音、修辞和有意重复 |

不以代词/助词绝对数量、句子长度或所谓“文学感”作为优化目标。省略和重组必须有上下文依据。

## 5. Prompt 与结果契约

现有输入已包含原文、初译、片段类型、前文上下文、TranslationBrief、术语、Context Graph 和人物声音上下文，不需要新增上下文构建路径。

中文规则仅注入中文目标语言的 Style Review Prompt。Accuracy Review 不注入中文润色规则。

中文文学编辑 finding 使用：

- `category: style`
- `dimension: chinese_literary_editing`
- `editingAspect: pronoun | particle | syntax | translationese | redundancy | diction | rhythm | register`
- `sourceExcerpt` / `draftExcerpt`：必须能在当前原文和初译中定位
- `reason` / `suggestion`：说明具体问题和编辑方向

中文编辑结果仍遵循现有 Style Review 的候选机制：保存 finding 和待采纳修订建议，不静默覆盖已接受译文。无证据、纯个人偏好或原文已经自然准确时，不创建 finding。

## 6. 实施内容

- [x] 扩展 Style Review Prompt，加入中文文学编辑规则。
- [x] 将中文编辑限定在中文目标语言。
- [x] 扩展 style finding 的 dimension，增加 `chinese_literary_editing`。
- [x] 增加受控的 `editingAspect` 字段。
- [x] 保持现有准确性审校、人物声音审校、候选保存和审计机制。
- [ ] 在可运行的本地环境执行完整测试与 TypeScript 检查。
- [ ] 使用真实文学段落做前后对照和人工验收。

## 7. 验收标准

1. 中文 Style Review 明确检查代词、助词、英文句法残留、翻译腔、冗余、词汇和节奏。
2. 非中文目标语言不会收到中文专属规则。
3. Accuracy Review 不执行纯语言润色。
4. 人物声音、叙述风格和有意重复仍受保护。
5. 中文编辑 finding 必须有原文和初译的可定位证据。
6. 文风候选仍需按现有机制采纳，不自动覆盖用户已接受文本。
7. 不增加 Pipeline Stage、Agent 或 LLM 调用。
8. 不改变批次上下文、缓存、并发、恢复和持久化契约。

## 8. 非目标

- 不做机械的“我 / 的 / 地 / 得”删除器。
- 不把所有作品统一改成小说腔、散文化或华丽文风。
- 不自动拆分所有长句。
- 不引入独立中文润色模型或额外的二次润色调用。
- 不对非中文目标语言套用中文语法规则。
- 不把文风建议提升为准确性 must-fix。
