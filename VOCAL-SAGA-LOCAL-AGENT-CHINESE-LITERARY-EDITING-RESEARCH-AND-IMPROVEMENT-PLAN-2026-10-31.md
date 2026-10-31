# vocal-saga Local Agent Service：中文文学编辑能力研究与完整改进方案

- 日期：2026-10-31
- 研究对象：`saga/vocal-saga`，重点为 `local-agent-service`
- 检查分支：`main`
- 检查快照：`8019f319bff8faa04df90dd1c33e2b4d915f6712`
- 文档性质：代码静态审查 + 外部项目/论文研究 + 目标架构与实施路线
- 本次范围：提出方案并记录研究，不修改运行代码；本次未在本地执行 npm test / typecheck，所有实现状态均以仓库代码和已有测试为依据。

## 1. 结论摘要

vocal-saga 已经具备相当完整的文学翻译基础设施：项目级 TranslationBrief、全书扫描、文学记忆 revision、Context Graph、人物声音档案、独立 Accuracy / Terminology Review、Style Review、批次并发、候选与 finding 持久化、全书质量审计，以及 Workbuddy/CodeBuddy 与 OpenCode 运行时。

因此，不应再新建一套平行的“中文润色流水线”，也不应该引入一组彼此讨论、重复读取全书的多 Agent。真正需要补齐的是现有 Style Review 与“中文文学编辑”之间的能力差异：

1. **当前 Style Review 不是严格意义上的中文单语编辑。** `buildLiteraryReviewPrompt()` 同时向模型提供 `source` 和 `draft`，要求对照原文修订。它可以检查中文表达，但模型始终受到英文原文句法、措辞和结构的影响，不能独立判断中文文本作为中文文学作品是否自然。
2. **已有中文规则主要是编辑检查清单，还不是作品级编辑规范。** 规则已经覆盖代词、助词、英文语序、翻译腔、冗余、词汇和节奏，但尚未形成一套可证据追溯、可持续积累、区分作者声音与译者中文表达的 Editorial Profile。
3. **现有质量审计更擅长确定性问题，不足以证明文学编辑真的改善了文本。** 漏译、术语、数字、重复片段等可以做程序化检查；中文自然度、作者声音、文学节奏和修辞保留不能只靠字符串规则或单一 LLM 分数验收。
4. **当前代码已经有候选和人工采纳机制，应继续复用。** 风格修改不应自动覆盖已采纳译文；编辑稿、理由、原稿和审校结果应能追溯、比较和回退。
5. **推荐把中文文学编辑做成现有文学审校工作流中的一个明确子流程，而不是再增加一套独立 Agent 平台。** 对中文目标语言采用“中文单语编辑 → 双语忠实度复核”的顺序；复用现有 Style Review 和 Accuracy Review 两个模型任务，不默认增加第三次模型调用。非中文目标语言维持当前路径。

最终定位应是：**Chinese Literary Editing for Translated Works**，面向小说、散文、回忆录、传记、文学纪实、文学随笔等中文译稿编辑，而不是只针对中文原创网文，也不是泛化的“去 AI 味”。

---

## 2. 当前 local-agent-service 基线

### 2.1 已有模块和能力

| 现有模块 | 当前职责 | 本方案的处理 |
|---|---|---|
| `src/documents/bookScan.ts` | 全书结构、章节、对白、重复片段和候选实体扫描 | 复用；增加编辑画像的证据采样输入，不另做一套扫描器 |
| `src/documents/contextGraph.ts` / `contextGraphWorkflow.ts` | 全书实体、关系、章节摘要和知识边界 | 复用；编辑时只注入当前批次允许看到的上下文 |
| `src/documents/translationBrief.ts` | 固定 source / prompt / memory revision 的批次上下文快照 | 继续作为统一上下文契约；为单语编辑构建经过脱敏的目标语视图 |
| `src/documents/voiceContext.ts` | 人物声音、关系规则、对白锚点和相邻章节上下文 | 复用；新增 target-only 投影，避免把英文原文和来源引文泄漏给中文编辑器 |
| `src/literary.ts` | 文学分析、声音画像稳定化、Accuracy / Style Reviewer Prompt 与结构化输出 | 复用执行器和 schema 思路；拆分中文单语编辑 Prompt 与双语审校 Prompt 的输入契约 |
| `src/documents/translationAgent.ts` | 分批翻译、审校调度、并发、取消、候选和事件持久化 | 在现有两个 Reviewer 任务之间调整中文分支顺序，不建立平行调度系统 |
| `src/documents/qualityAudit.ts` | 全书缺失、术语、数字、重复表达和 Reviewer finding 审计 | 增加文学编辑前后对照指标与编辑质量报告，不把审美分数当作确定性事实 |
| `src/agents/taskProfiles.ts` | translation / accuracyReview / styleReview / literaryAnalysis / contextGraph 模型任务配置 | 继续复用；可增加 `chineseLiteraryEdit` profile，也可在第一阶段沿用 `styleReview` profile，避免无必要的 UI 配置膨胀 |
| `skills/fiction-translation/SKILL.md` | 文学翻译工作流约束、证据门槛、上下文边界和人工采纳 | 扩展为适用于文学类作品的编辑契约；不要把编辑流程限制为小说 |
| SQLite Project Store | Run、source revision、memory revision、候选、findings、events、audit | 继续作为唯一事实来源；不另建编辑数据库 |

### 2.2 当前已经实现的关键机制

代码检查确认以下能力已经存在，不应重复开发：

- 文学项目以 source revision、Prompt revision、literary memory revision 固定一次 Run 的输入边界。
- 每批使用 TranslationBrief；初译和 Reviewer 可以共享同一份有界上下文快照。
- 人物画像和声音锚点必须经过来源证据校验；确认画像不能被后续模型分析静默覆盖。
- Reviewer 分为 `accuracy` 和 `style` 两种 focus。
- 中文目标语言的 Style Review 已经注入 Chinese Literary Editing 规则。
- Style finding 必须提供当前 source / draft 中可定位的引文；没有证据的 finding 会被丢弃。
- 风格修改以 `proposedTranslation` / pending finding 形式保存，不会仅因模型返回了 `finalTranslation` 就覆盖初译。
- Accuracy / Terminology finding 使用 must-fix 语义；style finding 是 optional。
- 批次 Session 按 project、run、role、batch 隔离；翻译和审校不依赖隐式会话历史。
- Reviewer 有独立并发预算、取消检查、缺失片段补审和事件记录。
- 全书质量审计会明确区分确定性检查和启发式提示；候选返工使用独立 Run，不直接覆盖已采纳文本。

### 2.3 现有中文编辑计划的不足

根目录已有 `CHINESE-LITERARY-EDITING-PLAN.md`，其主要决策是将中文编辑作为 Style Review 的一个维度，不增加 Pipeline Stage 和模型调用。这个决策避免了重复工作流，方向正确。

但它目前解决的是“让现有双语 Style Reviewer 多检查几类中文表达”，并没有解决“让模型先独立以中文读者/中文编辑的视角阅读译文”。现有 Prompt 明确要求“对照原文”，并同时传入 source、draft、glossary、voiceContext 和 Context Graph。因此它并不是真正的 monolingual editing。

建议保留原计划关于“不新增平行流水线、不增加无意义 Agent、不自动采纳风格修改”的原则，但升级内部执行语义。

---

## 3. 外部项目和行业研究

### 3.1 最值得借鉴的开源项目

#### A. TransAgents：文学翻译团队的职责分工

- 仓库：[minghao-wu/transagents](https://github.com/minghao-wu/transagents)
- 论文：[Harnessing Multi-Agent Collaboration for Translating Ultra-Long Literary Texts](https://direct.mit.edu/tacl/article/doi/10.1162/TACL.a.25/132121/Perhaps-Beyond-Human-Translation-Harnessing-Multi)
- 论文预印本：[arXiv:2405.11804](https://arxiv.org/abs/2405.11804)

TransAgents 模拟翻译公司的工作职责，包括 Senior Editor、Junior Editor、Translator、Localization Specialist 和 Proofreader；工作分成 Preparation 与 Execution 两个阶段。Preparation 形成团队和翻译指南，Execution 执行翻译、本地化、校对和质量检查。

**适合借鉴：**
- 先建立作品级翻译/编辑规范，再开始大规模执行。
- 把翻译、目标语言表达、本地化、校对和质量判断区分为不同职责。
- 长篇作品的质量不能只在每个独立片段内判断。

**不建议照搬：**
- 不需要引入 CEO、Junior Editor 等大量 Agent 角色。
- 不要让多个 Agent 反复总结同一本书，制造重复上下文和高额调用。
- 论文中的多 Agent 结果不能直接视为对当前英文→中文项目的效果保证。

#### B. Rainman Translate Book：全书分块和自动恢复

- 仓库：[deusyu/translate-book](https://github.com/deusyu/translate-book)

该项目将 PDF / DOCX / EPUB 转换、切块、并行翻译、manifest hash 校验、断点恢复、邻近片段上下文和合并输出组织为完整流程。

**适合借鉴：**
- chunk manifest 与源内容 hash 绑定，避免复用过期片段。
- 每个 chunk 使用隔离上下文，避免单个长会话积累历史导致漂移。
- 对输出进行 1:1 source/output 完整性检查。
- 将可恢复性和格式完整性作为流水线契约。

这些能力在 vocal-saga 已经有较成熟的对应实现，不建议为此替换现有 Project Store 或批次调度。

#### C. Chinese WebNovel Skills：中文表达检查清单的参考

- 仓库：[tance-mang/chinese-webnovel-skills](https://github.com/tance-mang/chinese-webnovel-skills)

它是面向中文原创网文写作的多 Skill 工具包，包含对白、去套路化表达、节奏、人物、连续性和校对等能力。

**适合借鉴：**
- 中文对白的自然度和人物差异。
- 对“套路化表达”和机械化修辞的检查。
- 中文标点、语体和本地表达习惯。

**不适合直接复用：**
- 它的核心目标是商业网文创作和平台留存，不是文学翻译。
- “爽点”“黄金三章”“留存诊断”等规则不能应用到 Proust、文学小说、回忆录或散文。
- 不应把它的去 AI 味、节奏或情绪规则当成通用中文文学标准。

#### D. Humanities Writing Companion：审稿与盲读流程

- 仓库：[tizzy916/humanities-writing-companion](https://github.com/tizzy916/humanities-writing-companion)

它提供人文学科写作的研究、规划、修订、对抗性审读、盲读检查等 Skill 组织方式。

**适合借鉴：**
- 将“作者/编辑修改”和“读者盲读检查”分开。
- 让审稿意见定位到具体文本，不只输出笼统评价。
- 将检查项组织成可复用的 Skill 和工作流。

它并不是文学翻译编辑器，适合作为流程组织参考。

### 3.2 重要学术研究

#### A. Literary translation evaluation：不能只看 MQM 或自动分数

- 论文：[How Good Are LLMs for Literary Translation, Really?](https://aclanthology.org/2025.naacl-long.548/)
- 数据集：LITEVAL-CORPUS，超过 2,000 条译文、13,000 多个句子，包含四种语言组合。

研究指出，文学翻译评价中，评价标准越复杂并不一定越可靠；专业评审的经验也会显著影响判断。研究中，复杂 MQM 方案对文学译文的区分效果不理想，BWS（Best-Worst Scaling）等相对偏好判断更能识别专业人类译文。常规自动指标也难以衡量文学创造性和作者声音。

**对 vocal-saga 的影响：**
- 机器可以做错误筛查和候选排序，但不能用 BLEU、COMET、字符差异或一个 LLM 总分证明文学质量。
- 对中文自然度和文学效果，应使用匿名 A/B 偏好比较。
- 对原文忠实度，应单独做双语检查，不能把目标语自然度和原文准确性混成一个分数。

#### B. LiTransProQA：以专业编辑问题构建评估表

- 论文：[LiTransProQA](https://arxiv.org/abs/2505.05423)
- 代码：[NL2G/LiTransProQA](https://github.com/NL2G/LiTransProQA)

研究构建了由专业文学译者和研究者参与筛选的问题集合，覆盖六类内容：
1. Grammar & Linguistics
2. Literary Devices
3. Cultural Understanding, Context & Adaptation
4. Tone & Authorial Voice
5. Consistency & Coherence
6. General Equivalence

它使用问题逐项判断，而不是让模型凭空给一个笼统的“文学质量分”。论文也指出，专业译者参与的权重和判断对评估有帮助，LLM 评价仍低于经验丰富的专业译者。

**对 vocal-saga 的影响：**
- 建立固定、可版本化的 Literary Editing Rubric。
- 每个问题应对应可定位的证据、风险和建议。
- 评估问题应由编辑原则和人工经验制定，不要让模型每次自行发明评分标准。
- 可将 YES / NO / MAYBE 的问题判断改为“有问题 / 无明显问题 / 证据不足”，再映射为 finding，不直接把它变成质量真值。

#### C. Extending CREAMT：文学译后编辑的生产力研究

- 论文：[Extending CREAMT: Leveraging Large Language Models for Literary Translation Post-Editing](https://arxiv.org/abs/2504.03045)

研究与四位专业文学译者合作，比较 GPT-4、GPT-3.5、文学适配 Mistral 和人工翻译/编辑。实验使用 UniOr-PET / PET 记录编辑时间、插入删除和编辑过程，并允许查看前后文。

研究显示，LLM 译后编辑在该实验中有明显效率收益；但研究样本只有四位译者、一个相对资源充足的语言组合和较短文学摘录，且部分质量判断使用自动指标。因此不能把其结论直接外推为所有语言对、所有文学体裁都能由 AI 达到出版质量。

**对 vocal-saga 的影响：**
- 应记录编辑时间、修改量、保留率和撤销率，而不只记录模型响应时间。
- 编辑 UI/结果应能对照原稿、编辑稿和上下文。
- 需要测量“改动是否值得”，不是越多修改越好。

#### D. Long-context literary translation：段落级上下文很重要

- 论文：[Large language models effectively leverage document-level context for literary translation, but critical errors persist](https://arxiv.org/abs/2304.03245)

研究比较了段落级与句子级翻译，发现文档级上下文可以改善翻译质量和一致性，但仍存在严重错误，需要人工介入以保护作者声音。

**对 vocal-saga 的影响：**
- 中文编辑不能只收到孤立句子。
- 至少要提供当前完整段落，以及有限的相邻中文译文；必要时提供本章已确认的目标语风格样本。
- 上下文必须遵循当前 source revision 和章节时间边界，不能把未来剧情或全书总结随意注入。

#### E. Better Literary Translation：英文→中文专门模型的新进展

- 论文：[Better Literary Translation: A Multi-Aspect Data Generation and LLM Training Approach](https://aclanthology.org/2026.acl-industry.22/)
- 预印本：[arXiv:2606.05924](https://arxiv.org/abs/2606.05924)

这是本次研究中与英文→中文方向最直接相关的新工作。论文提出将文学翻译质量拆成表达流畅度和文学效果两个维度，使用不同模块迭代优化，再通过 SFT 和奖励模型训练得到 LitMT-8B / LitMT-14B。论文报告它们在 MetaphorTrans 英译中基准上达到 67.25 / 69.07 CEA100，与 Claude Sonnet 4.5 的 68.43 接近；在 O. Henry 域外集合上也有结果。

**重要限制：**
- 这是文学翻译模型研究，不是已经验证的“中文译稿编辑模型”。
- 基准重点包含隐喻和明喻句，不能代表完整长篇小说、人物声音、篇章节奏和全书一致性。
- 论文的训练骨干和评估方案不能等同于模型权重已经可直接在 vocal-saga 使用。本次未验证到可直接集成的官方模型发布仓库或稳定推理包。
- 论文的模型结果应作为模型选型 benchmark 候选，而不是直接替换现有 Workbuddy/CodeBuddy Provider。

#### F. Creativity Bias：LLM Judge 对文学创造性的偏差

- 论文：[Creativity Bias: How Machine Evaluation Struggles with Creativity in Literary Translations](https://arxiv.org/abs/2605.13596)

该研究指出，自动评价指标和 LLM-as-a-judge 对文学创造性的判断与专业评审可能存在明显偏差，可能惩罚非惯常但合理的创造性译法。

**对 vocal-saga 的影响：**
- 不允许“模型不喜欢某个表达”就自动改写。
- 不把风格偏好升级为 must-fix。
- 对隐喻、反讽、留白、有意重复和非常规句式，宁可标记“需要判断”，也不要强行归一化。

### 3.3 对上一轮项目清单的纠正

上一轮回答提到的 `cli1980/manuscript-studio` 和 `alejandrojlamas/verbaloom`，本次没有取得足够可靠的 GitHub 仓库证据，不能把它们作为 vocal-saga 的依赖或架构基础。本报告不据此提出代码复用。后续只应基于可验证仓库、论文或实际代码进行集成判断。

---

## 4. 目标能力定义

### 4.1 编辑目标

输入是已经完成初译的中文文学文本。编辑器需要判断并适度改善：

- 中文句法和语序是否自然。
- 是否保留英文从句、被动句、名词化和嵌套定语的机械痕迹。
- 代词和所属表达是否不必要地重复。
- 助词、虚词和连接词是否僵硬或堆叠。
- 词语搭配是否自然、准确、有语境依据。
- 句子长短、停顿、段落衔接是否保留原文节奏。
- 人物对白是否有区别，叙述声音是否稳定。
- 隐喻、反讽、象征、双关、留白和有意重复是否被磨平。
- 是否把冷峻、克制、粗粝、幽默或意识流统一改成“优美、顺滑、简洁”的 AI 文风。

### 4.2 非目标

- 不把文学作品统一改成中文网文风格。
- 不以“去 AI 味”作为没有定义的目标。
- 不机械删除“我、他、的、地、得”。
- 不以句子变短、字数减少、形容词增加或词汇华丽作为成功指标。
- 不重写作者的叙事结构，不擅自补充心理、背景、情绪和意象。
- 不把所有英语文化表达一律本土化，也不把所有表达一律异化。
- 不允许编辑阶段绕过实体译名、来源版本、候选采纳和取消恢复机制。
- 不将文学编辑能力扩展到普通网页翻译和技术文档翻译。

### 4.3 质量原则

按以下顺序判断：

1. 不改变作品事实、人物关系、叙述视角、时间、否定、因果和歧义。
2. 保留原作者的叙述声音、文学手法和作品的文体特征。
3. 确保中文自然、成熟、符合目标读者的阅读习惯。
4. 改善节奏、衔接、搭配和局部表达。
5. 只有在确实改善时才修改；不修改也是合格结果。

“忠实”不是逐词保留英文语序，“自然”也不是把原文改写成另一位中文作者的作品。

---

## 5. 推荐架构：两个视角、两个既有 Reviewer 任务

### 5.1 核心设计

对中文文学翻译，建议将现有两个 Reviewer 任务重排为：

**初译 → 中文单语文学编辑 → 双语忠实度/术语复核 → 候选与 finding 持久化 → 全书质量审计**

关键是：中文编辑阶段不接收英文 source 文本；双语复核阶段再重新引入 source。

这不是新增一条独立 Pipeline，而是将当前 Style Review 的职责明确化，并把现有 Accuracy Review 放到编辑之后。

| 步骤 | 输入 | 主要职责 | 输出 |
|---|---|---|---|
| 初译 | source + TranslationBrief | 产生初译和 context_delta | 初译 |
| 中文单语编辑 | draft + 中文前后文 + 目标语编辑画像 | 以中文读者/编辑视角判断是否需要编辑 | 编辑候选 + 目标语 finding |
| 双语复核 | source + 初译 + 编辑候选 + glossary/实体规则 | 检查编辑候选有没有改变原意、遗漏、增译、术语漂移或人物关系 | 通过的编辑候选，或修复后的候选 + 双语 finding |
| 质量审计 | 当前 source revision + 最终候选/已采纳文本 | 完整性、术语、数字、重复、编辑记录和质量指标 | Quality Audit |

这样可以复用现有两个模型调用：
- 原 Style Review 任务承担中文单语编辑。
- 原 Accuracy Review 任务承担编辑后的双语忠实度复核。
- 不增加默认模型调用数量。
- 中文以外的语言仍然使用原有 Style Review + Accuracy Review 逻辑。

注意：中文路径需要把两个 Reviewer 串行化，因为 Accuracy Review 必须看到中文编辑候选；当前实现中 Style Review 有 detached/独立调度机制，不能继续让两个任务并行后各自读取同一份初译。并发仍按现有 reviewer concurrency budget 控制，只改变单个批次的依赖顺序。

### 5.2 中文单语编辑的输入边界

单语编辑器只能看到：

- 当前批次中文 draft。
- 当前批次的段落结构、稳定 segment ID 和片段类型。
- 当前章节相邻的已采纳中文译文（有界）。
- 作品级中文 Editorial Profile。
- 已确认的中文人物称谓、目标语人物声音描述。
- 已采纳的中文风格样本。
- 已确认的标点、语体、地域用语和格式约定。
- 服务端保护的规范名 token（必须原样保留）。

不得看到：

- 英文 source 原文。
- 英文原文引文。
- 直接包含 sourceQuote 的 voice evidence。
- 未经确认的英文术语候选及其推断性说明。
- 未来章节摘要、超出当前时间边界的剧情事实。
- 能间接还原原文句法的逐句对照表。

因此，需要为现有 `voiceContext` 构建一个 **target-only projection**。不能直接把当前完整 voiceContext 原样传给单语编辑器，因为其中包含 source 名称、source evidence 和 voice anchor 的 source 侧文本。

目标语上下文可以保留：
- 人物的规范中文名。
- 已确认的人物中文表达特点。
- 已采纳的中文对白样本。
- 当前场景中由已有证据确认的说话人/听话人 ID。
- 人物关系的中文称谓和语域约束。

如果说话人归属不确定，编辑器只能不做声线推断，不得创造口头禅或方言。

### 5.3 中文编辑输出契约

建议为中文编辑建立独立的结构化输出 schema，概念如下：

```json
{
  "results": [
    {
      "id": "stable-segment-id",
      "editedText": "完整的中文编辑候选",
      "decision": "edited",
      "findings": [
        {
          "dimension": "chinese_literary_editing",
          "editingAspect": "syntax",
          "targetExcerpt": "译文中可定位的连续片段",
          "reason": "具体说明为什么读起来不自然",
          "suggestion": "说明调整方向",
          "confidence": "medium"
        }
      ]
    }
  ]
}
```

`decision` 可取 `unchanged`、`edited`、`needs_human_review`。模型必须返回每个输入 ID 的结果；没有必要修改时，`editedText` 必须与 draft 完全一致。

与当前双语 finding 不同，单语编辑 finding 不应该要求 sourceExcerpt，因为编辑器根本没有看到 source。它应引用当前中文 draft 的 `targetExcerpt`。后续双语复核才负责 source/draft 对照证据。

服务端校验：
- 只接受当前批次的 segment ID。
- 每个 ID 只能出现一次。
- 不能漏段、增加段或改变 segment ID。
- 保护 token 必须完整保留，不能拆分或变更。
- 输出必须是完整文本，不允许只返回局部 patch 后由服务端猜测拼接。
- 单段长度、输出总长度和 JSON 结构有上限。
- 空结果、重复 ID、未知 ID、模型截断和不合法结构均不能覆盖初译。
- 编辑器不能自行把 finding 标记为用户确认或已采纳。

### 5.4 双语复核输入与职责

Accuracy Review 在中文编辑之后执行，收到：

- source 原文。
- 初译 draft。
- 中文编辑候选 editedText。
- glossary / confirmed entity mapping。
- 同一份 run 固定的 TranslationBrief 和时间边界。
- 需要时的前后文和人物关系证据。

它必须以 source 为最终事实依据，判断 editedText 是否：
- 漏掉原文信息。
- 增加原文没有的信息。
- 改变时态、否定、视角、人物关系和指代。
- 改变语气强度或抹掉原文歧义。
- 破坏已确认的人名、称谓、术语。
- 错误处理隐喻、文化表达、双关和修辞。

初译只作为辅助参考，不是正确答案。若编辑候选语义忠实，则保留编辑候选；若存在明确错误，只做有证据的必要修复。双语复核不应借机重新进行一轮泛化润色。

### 5.5 为什么不建议只在一个 Prompt 中写“先读中文，再看原文”

如果同一请求同时提供 source 和 draft，即使 Prompt 要求模型先忽略 source、只看中文，模型实际上仍然可以看到原文。它不是独立的中文盲读。

如果只是想低成本做一个“目标语优先”的审读，可以保留当前单次双语 Style Review；但如果产品要明确承诺“中文文学编辑”，就应使用真正不含 source 文本的单语输入。

本方案通过复用当前 Style Review 和 Accuracy Review 两个任务完成，不默认增加总模型调用次数。

---

## 6. Editorial Profile：作品级编辑规范

### 6.1 不要把所有规则塞进通用 Prompt

建议在现有 Literary Memory / Style Guide 机制上，增加一个有版本、有证据来源的 `literaryEditorialProfile` 概念，或在现有 styleGuide 中以明确字段扩展；先检查 schema 是否已有等价字段，避免出现第二套重复记忆。

建议至少包含：

| 维度 | 内容 |
|---|---|
| Work Type | 小说、散文、回忆录、传记、文学纪实、随笔等 |
| Source Author Voice | 原作者的句法、叙述距离、节奏、修辞倾向 |
| Narrative Mode | 第一/第三人称、自由间接引语、意识流、全知/限知视角 |
| Chinese Register | 目标中文语体、地域用语、时代感和正式程度 |
| Sentence Rhythm | 长短句倾向、段落长度、停顿、重复方式 |
| Diction | 词汇密度、口语/书面语比例、意象和抽象表达习惯 |
| Dialogue Style | 人物对白的语气、称谓、直接程度和区别 |
| Literary Devices | 隐喻、反讽、象征、双关、留白、反复 |
| Editing Boundaries | 明确不能改变的文体特点和高风险表达 |
| Accepted Examples | 用户已采纳的原译/编辑稿片段，带 segment ID 和 revision |
| Evidence | 对应 source revision、segment ID、可核验片段和分析依据 |
| Status | candidate / confirmed / rejected |
| Version | profile revision、生成模型、Prompt 版本、来源版本 |

### 6.2 区分三种声音

不能把“作者声音”直接等同于“中文译文风格”。建议显式区分：

1. **Source Author Voice**：从英文原文观察到的作者表达特征，例如长句、意识流、冷峻、幽默、反讽、留白。
2. **Chinese Target Voice**：已经形成的中文译文表达习惯，例如中文叙述语域、用词、句法、节奏和人物对白。
3. **Editorial Policy**：用户对这本书的编辑偏好，例如“尽量克制，不增加文学辞藻”“保留长句，不为了流畅拆碎”等。

第一类由原文分析产生；第二类应优先从已采纳的中文译文和用户修改中学习；第三类是用户明确选择或确认的规则。

这三类信息不能互相覆盖。尤其不能用模型对英文原文的分析，直接生成一套强制中文文风。

### 6.3 自动建立 Profile

建议尽量自动化：

1. 复用 BookScan 的章节和样本选择。
2. 按全书开头、中段、结尾和代表性章节选取样本。
3. 读取原文样本，抽取 Source Author Voice。
4. 读取已有译文样本，抽取 Chinese Target Voice。
5. 对比同类样本，识别跨章节稳定特点与局部例外。
6. 将每条规则绑定来源 segment ID 和证据，不允许无证据规则进入 confirmed 状态。
7. 初次生成 profile 为 candidate；可直接作为弱提示自动运行。
8. 在首批编辑结果中显示 profile 的简短摘要和代表性前后对照，用户可一次性确认或修改。
9. 后续只有在新证据与已确认规则冲突时才提出 profile 更新建议，不自动覆盖确认内容。

用户不应该每章都手动配置编辑偏好。人工介入集中在作品开始时确认少量全书级规则，以及最终决定是否采纳编辑候选。

---

## 7. 中文文学编辑的具体规则体系

建议建立一个有版本的 rubric，而不是只在 Prompt 中堆砌形容词。

### 7.1 句法与翻译腔

- 英文语序、关系从句、嵌套定语、被动结构、名词化、介词结构。
- 英文连接词和逻辑关系在中文中是否显得机械。
- 主语、宾语和所属关系是否需要中文语境中的省略或调整。
- 是否出现不自然的抽象名词堆叠。
- 是否因逐词对应造成中文搭配错误。

### 7.2 代词、虚词与冗余

- “我、你、他、她”等是否不必要地重复。
- “我的、他的、她的”等所属关系是否可以在不丢失指代的情况下自然省略。
- “的、地、得”是否使用正确，是否存在虚词堆叠。
- “进行、发生、存在、做出”等空泛动词是否有更准确的表达。
- 是否重复表达同一个意思。

注意：代词和“的、地、得”只能作为检查入口，不能成为计数优化目标。

### 7.3 词汇和语体

- 词语搭配是否自然。
- 词义是否符合当前上下文，而不是词典中的第一个释义。
- 语体是否与人物身份、叙述者距离和时代背景一致。
- 是否擅自现代化、古典化、网络化或过度书面化。
- 是否把粗粝、平实、冷峻、幽默的表达改成同一种“优美中文”。

### 7.4 节奏、段落和叙述声音

- 长句是否有必要保留。
- 是否把有意的长句拆成机械短句。
- 是否把有意的短句扩写成解释。
- 段落停顿、重复和递进是否仍然有效。
- 是否抹掉意识流、自由间接引语、内心独白和叙述视角。
- 是否增加原文没有的心理解释。

### 7.5 文学手法和文化表达

- 隐喻、明喻、象征、双关、反讽、典故和文化负载表达。
- 不能仅因为中文不常见就删除陌生表达。
- 不确定时可以提出两个可选译法并解释取舍，不应自作主张。
- 不能把所有文化表达都归化，也不能机械保留所有异化表达。

### 7.6 人物对白

- 区分人物身份、关系、情绪距离和场景变化。
- 不同人物不能被改成同一种“聪明、完整、流畅”的 AI 说话方式。
- 不得为了制造人物个性而添加口头禅、方言、粗口、语气词。
- 对说话人归属不确定的对白，不得套用人物声音档案。

---

## 8. 运行时、并发和成本设计

### 8.1 保持现有运行时

- 默认仍使用 Workbuddy/CodeBuddy SDK。
- OpenCode 继续作为可选 Runtime。
- 使用当前 `runAgentJson` 与 JSON Schema 输出。
- 禁用与翻译无关的工具能力；文学编辑只是结构化文本处理，不需要 Shell、MCP 或文件系统 Agent 工具。
- 继续使用 task profile 配置模型、thinking 和 effort。
- 不引入新数据库，不使用 Agent transcript 作为项目事实来源。

### 8.2 模型策略

模型选择应由真实中文文学编辑样本决定，而不是只看排行榜或上下文窗口。

建议建立三档：

| 档位 | 任务 | 选择依据 |
|---|---|---|
| Strong Editor | 作品初次编辑、复杂隐喻、意识流、人物声音 | 中文文学编辑 A/B 偏好、忠实度和修改克制 |
| Balanced Editor | 普通章节批量编辑 | 质量达到 Strong Editor 可接受范围，延迟和成本更低 |
| Local Candidate | 本地模型试验、隐私/离线场景 | 在本地机器上的真实质量、内存和速度 |

模型测试候选：
- 当前 Workbuddy/CodeBuddy 可用的高能力模型，作为实际生产基线。
- Claude / GPT 等高能力模型，作为外部质量对照。
- Qwen 系列本地模型，作为本地候选。
- LitMT-8B / LitMT-14B 作为英文→中文文学翻译研究候选；在权重、许可、推理格式和实际编辑能力验证之前，不作为生产依赖。
- DRT 等隐喻翻译研究模型可用于对照实验，但不应误认为它们是完整文学编辑器。

模型评测至少包括：
- 目标语单语自然度。
- 文学表达和作者声音保留。
- 是否过度修改。
- 双语忠实度。
- 人物对白差异。
- 对隐喻、反讽和留白的处理。
- 每段耗时、失败率和输出结构可靠性。

### 8.3 自动化调度

- 只对文学类文档、目标语言为中文的 Run 启用中文编辑分支。
- 普通网页翻译、技术文档、非中文目标语言不受影响。
- 按现有 batch 和 reviewer concurrency budget 调度。
- 单个批次中先中文编辑、后双语复核；不同批次仍可按现有有界并发执行。
- 编辑阶段失败时保留初译，不得因为编辑失败让整个已完成翻译丢失。
- Accuracy Review 失败时保留编辑候选和 finding，Run 状态按现有失败/部分完成协议表达，不把“未复核”标记为“已通过”。
- 取消 Run 后，迟到的编辑或复核结果不能写入。
- 缺失 segment 继续走现有 missing retry，不允许编辑器自行补段。

---

## 9. 编辑候选、差异和采纳机制

### 9.1 不要静默覆盖译文

中文文学编辑是风格优化，默认必须保持候选状态。建议复用现有 finding/candidate 生命周期：

- 原始译文保留。
- 编辑候选单独保存。
- 每个 finding 记录具体编辑维度、原文或目标语证据、修改理由。
- 双语复核状态单独记录。
- 用户采纳后形成新的 accepted translation revision。
- 用户拒绝后保留拒绝原因，避免相同规则在后续重复提出。
- 用户手动改过的译文不能被后续 Run 覆盖。

### 9.2 差异展示

UI 不需要引入复杂的编辑器，优先支持：
- 原译文 / 编辑候选并排或行内 diff。
- 修改理由和 editingAspect。
- “未修改”明确显示，不把无变化误判为模型失败。
- 双语忠实度复核结果。
- 采纳、拒绝、恢复原文。
- 按章节查看修改率和高频问题。

### 9.3 自动采纳策略

第一阶段不建议默认自动采纳风格修改。可以在未来增加明确的自动采纳策略，但必须满足：
- 当前 source / prompt / memory revision 未变化。
- 保护 token、segment ID、输出完整性验证全部通过。
- 双语复核通过。
- 没有高风险文学手法或人物声音 finding。
- 编辑策略允许自动采纳。
- 仍然创建可回退的 accepted revision，并保留完整编辑轨迹。

默认策略应为“自动编辑、自动复核、自动生成候选、用户批量采纳”，而不是逐句让用户点击，也不是模型直接覆盖原稿。

---

## 10. 评估体系：如何证明编辑真的变好

这是本方案中优先级最高的质量工程工作。没有可靠评估，Prompt 越写越长只会增加主观修改。

### 10.1 建立 Literary Editing Evaluation Corpus

第一批语料建议 100–200 个段落，来源包括：
- 公版英文文学作品及其公开中文译本（核对译本使用许可）。
- 用户有权处理的真实项目段落。
- 专门构造的失败样本：翻译腔、重复代词、助词堆叠、过度拆句、人物对白同质化、隐喻误改、叙述视角偏移等。

每个样本保存：
- source text。
- initial Chinese draft。
- 可选人工编辑版本。
- 文本类型和章节位置。
- 需要保护的语义/文学特征。
- 预期可修改点和明确不可修改点。
- 人工评价和争议说明。

不要只建立“错误文本 → 标准答案”的单参考数据。文学表达可能有多个有效译法，语料应包含多种可接受表达。

### 10.2 双轨评估

**轨道 A：中文单语盲评**

评审只看中文版本，不看英文原文，不知道哪个是初译、哪个是 AI 编辑稿。

采用随机顺序 A/B 或 Best-Worst Scaling，评估：
- 中文自然度。
- 文学表达。
- 叙述声音。
- 人物对白。
- 节奏和段落。
- 是否过度润色。
- 总体阅读偏好。

**轨道 B：双语忠实度审校**

评审同时看英文 source 和中文候选，检查：
- 语义和事实。
- 信息遗漏/增加。
- 语气、视角、时态、否定。
- 文化表达、隐喻、双关。
- 人物关系和指代。
- 作品风格和修辞效果。

两个轨道结果分开报告，不能用中文自然度高抵消误译，也不能用字面忠实度高抵消中文明显不自然。

### 10.3 关键指标

| 指标 | 说明 | 目标方向 |
|---|---|---|
| Blind Preference Win Rate | 中文盲评中编辑稿优于初译的比例 | 上升 |
| Fidelity Regression Rate | 编辑后新增的忠实度问题比例 | 下降，目标为零严重回归 |
| Critical Error Rate | 新增误译、漏译、增译、视角/否定错误 | 下降 |
| Unchanged Rate | 原稿无需修改而保持不变的比例 | 不预设越低越好 |
| Edit Acceptance Rate | 用户采纳编辑候选比例 | 上升，但不能单独作为质量真值 |
| Revert Rate | 用户采纳后又恢复原稿的比例 | 下降 |
| Over-edit Rate | 人工判断为不必要或破坏原风格的修改比例 | 下降 |
| Style Consistency | 跨章节中文语体和人物声音一致性 | 上升 |
| Model Failure Rate | JSON、截断、缺失 ID、保护 token 失败 | 下降 |
| Latency / Cost | 每 100 段耗时、调用数和可获得的成本 | 可控 |

不要以平均改动字数、句子变短比例、代词减少比例或词汇多样性作为核心成功指标。

### 10.4 LLM-as-a-Judge 的使用边界

可以用独立评审模型做批量初筛、A/B 排序和争议样本定位，但需要：
- 使用固定版本的 rubric。
- 盲化候选身份和模型名称。
- 固定输入长度、上下文和评分尺度。
- 定期抽取样本交给人工评审。
- 统计模型评审与人工判断的一致性。
- 不让编辑模型自己给自己的结果打分并直接通过。
- 对文学创造性、隐喻、反讽和留白，不将 LLM 分数作为自动采纳依据。

LiTransProQA 的专业问题清单可以作为 rubric 设计参考，但需要针对英文→中文和本项目文体重新校准。

---

## 11. 分阶段实施计划

### Phase 0：冻结边界和基准（先做）

目标：防止重复造轮子，确认现有 Style Review、Accuracy Review、候选和质量审计的实际数据契约。

任务：
1. 明确中文文学编辑只适用于 literary document + zh target。
2. 记录现有 Reviewer 的输入、输出、事件、finding、candidate 和并发关系。
3. 为现有 Style Review Prompt 增加回归测试，确保非中文和普通文本不受影响。
4. 准备第一批公开/授权段落和失败样本。
5. 定义编辑 Rubric 与 A/B 盲评模板。

完成标准：
- 有明确的 as-is 流程图和输入输出契约。
- 已有功能不重复实现。
- 可以比较当前 Style Review 和新编辑分支。

### Phase 1：真正的中文单语编辑（核心功能）

目标：把中文文学编辑从“看着英文原文润色”改成真正的中文目标语编辑。

任务：
1. 增加 target-only voiceContext 投影。
2. 构建不含 source 的中文编辑 Prompt。
3. 增加结构化编辑输出 schema。
4. 将现有 Style Review 任务在中文文学 Run 中改为中文单语编辑。
5. 将 Accuracy Review 调整为在编辑候选之后执行。
6. Accuracy Review 同时看到初译和编辑候选，但以 source 为最终依据。
7. 复用当前批次、Run、Session、并发和取消协议。
8. 复用现有 finding/candidate 采纳机制，不覆盖已采纳译文。
9. 为中文编辑阶段增加明确的事件名和统计信息。

完成标准：
- 单语编辑模型输入中不存在 source 原文和 source quote。
- 编辑器严格按 segment ID 返回完整结果。
- 编辑结果通过后续双语复核。
- 编辑阶段失败时初译仍然可用。
- 风格候选保持 pending，未自动覆盖用户文本。
- 默认模型调用总数不超过现有两个 Reviewer 任务。

### Phase 2：作品级 Editorial Profile

目标：让每本书的编辑风格逐步形成，而不是每批重新发明中文风格。

任务：
1. 复用 BookScan 选取全书代表性样本。
2. 分析 Source Author Voice。
3. 从已采纳中文译文中分析 Chinese Target Voice。
4. 保存用户明确确认的 Editorial Policy。
5. Profile 记录证据、来源 revision、状态和版本。
6. 为单语编辑构建有界 target-only Profile。
7. 新证据冲突时生成建议，不覆盖 confirmed Profile。

完成标准：
- 不同作品能够形成不同编辑规范。
- Profile 的每条关键规则都能追溯到来源或用户决定。
- 未来章节不会泄漏进当前批次。
- 用户无需逐章重复配置。

### Phase 3：全书编辑质量报告

目标：把逐段编辑升级为全书可审计质量改进。

任务：
1. 扩展 Quality Audit，报告编辑前后版本和 revision。
2. 汇总修改率、未修改率、采纳率、拒绝率、撤销率。
3. 汇总 editingAspect、章节分布和高风险问题。
4. 报告双语复核未执行、失败和通过的数量。
5. 支持针对特定 finding / segment 创建窄范围 repair Run。
6. 确保所有 repair 都保留旧版本和人工修改。

完成标准：
- 报告区分“发现问题”“提出修改”“复核通过”“用户采纳”。
- 无审校数据时不能显示为质量通过。
- 任何修改都能追溯到 source、Prompt、Profile 和 Run revision。

### Phase 4：模型 A/B 与自动路由

目标：用真实样本选模型，而不是凭模型名称选模型。

任务：
1. 对现有主力模型、外部强模型和本地候选运行同一语料。
2. 对输出做中文单语盲评和双语忠实度评估。
3. 记录时延、失败率、修改率和用户采纳率。
4. 建立按任务/作品类型路由的配置。
5. 只有在本地模型质量达到设定门槛后，才允许其作为默认编辑模型。

完成标准：
- 有可重复的 benchmark 报告。
- 模型升级后可运行回归测试。
- 自动路由不会因模型不可用而静默切换到未验证模型。

### Phase 5：可选模型适配

只有在已经积累足够的人工采纳/拒绝数据后再考虑：
- 建立高质量的中文编辑偏好数据。
- 区分忠实度错误、中文表达错误和纯风格偏好。
- 先做 prompt / few-shot / reranker 对照。
- 再评估 LoRA / SFT / preference optimization。
- 不要用模型自己生成的编辑稿作为唯一训练标签。
- 不要在未核对许可和版权边界的情况下使用商业作品训练数据。

---

## 12. 需要修改的代码位置（建议清单）

| 文件 | 计划修改 |
|---|---|
| `local-agent-service/src/literary.ts` | 新增中文单语编辑 Prompt、schema、结果校验；增加 target-only 编辑上下文构建；保留现有双语 Review |
| `local-agent-service/src/documents/voiceContext.ts` | 增加 target-only voice projection，严格移除 sourceQuote / anchor.source 等源文本 |
| `local-agent-service/src/documents/translationAgent.ts` | 中文文学 Run 的两个 Reviewer 串行：先中文编辑，后双语 Accuracy Review；复用现有并发、取消、持久化和重试 |
| `local-agent-service/src/documents/translationBrief.ts` | 为单语编辑构建有界目标语上下文；继续固定 revision 和 context hash |
| `local-agent-service/src/documents/qualityAudit.ts` | 增加编辑前后质量指标、审校状态和候选/采纳状态统计 |
| `local-agent-service/src/agents/taskProfiles.ts` | 首期可复用 styleReview profile；如果配置确实需要独立模型，再增加 chineseLiteraryEdit profile |
| `local-agent-service/skills/fiction-translation/SKILL.md` | 更新工作流契约，区分中文单语编辑和双语忠实度复核；扩展适用文本类型 |
| `local-agent-service/tests/chinese-literary-editing.test.mjs` | 从 Prompt 字符串断言扩展到输入脱敏、结构校验、候选状态和双语复核 |
| `local-agent-service/tests/document-agent-prompt.test.mjs` | 验证中文编辑器不接收 source，Accuracy Reviewer 接收 editedText |
| `local-agent-service/tests/fiction-quality-baseline.test.mjs` | 加入文学编辑前后对照语料与负例 |
| `local-agent-service/tests/translation-context-delta.test.mjs` / 新增测试 | 确保编辑不会破坏 source ID、context delta、实体译名和 revision 边界 |

不建议：
- 新增一套与 Project Store 平行的文学编辑数据库。
- 新建一个 unrestricted Literary Agent。
- 新增 CEO / Editor / Critic / Judge 等大量独立 Agent。
- 把中文文学编辑塞进普通网页翻译 Prompt。
- 把所有现有 Style Review 逻辑整体替换掉，导致非中文路径回归。
- 仅靠一个巨型 Prompt 解决 Profile、证据、版本、评价和采纳问题。

---

## 13. 自动化验收矩阵

| 场景 | 预期行为 |
|---|---|
| 中文文学译文，中文自然且忠实 | 原样保留，不强制修改 |
| 中文文学译文有英文语序 | 单语编辑提出有依据的调整，双语复核确认 |
| 中文编辑删除了必要信息 | 双语复核发现，拒绝该编辑或恢复必要信息 |
| 中文编辑增加心理解释 | 双语复核发现增译，不允许自动采纳 |
| 原文是意识流长句 | 不因句子长就拆句 |
| 原文有意重复 | 不因重复就删除 |
| 人物声音证据不足 | 不强行套用人物画像，不创造口头禅 |
| 隐喻有多种合理译法 | 可以提出备选和理由，不把非常规表达直接判错 |
| 规范名 token 被编辑器破坏 | 服务端校验失败，保留初译 |
| 编辑器漏回一个 segment | 结构验证失败，补审或保留初译 |
| Reviewer 超时或失败 | 状态显示未完成/失败，不能显示为通过 |
| Run 被取消 | 丢弃迟到结果，不写候选 |
| source revision 改变 | 旧 Run / 旧 Profile 不得用于新 source revision |
| 非中文目标语言 | 保持现有流程，不注入中文编辑规则 |
| 普通网页/技术文档 | 不触发中文文学编辑 |

---

## 14. 推荐最终决策

建议批准以下架构决策：

1. 中文文学编辑是 local-agent-service 文学翻译能力，不是普通翻译的全局润色开关。
2. 不新增平行 Pipeline，不新增多 Agent 团队。
3. 对中文文学 Run，复用当前两个 Reviewer 模型任务：Style Review 改为不看 source 的中文单语编辑，Accuracy Review 在其后对 edited candidate 做双语忠实度/术语复核。
4. 单语编辑使用 target-only 上下文，必须从 voiceContext 中移除 source 原文、source quote 和源语言 anchor。
5. 建立版本化 Editorial Profile，区分 Source Author Voice、Chinese Target Voice 和用户 Editorial Policy。
6. 编辑结果是候选，不静默覆盖已采纳译文；后续双语复核失败时保留初译。
7. 质量评估采用中文单语盲评 + 双语忠实度复核双轨制，LLM Judge 只用于辅助，人工抽样校准。
8. 先用现有模型和真实样本建立基准，暂不 Fine-tune，也不依赖尚未确认可部署的 LitMT 权重。
9. 所有自动化步骤均由 local-agent-service 负责，扩展只负责展示状态、diff 和采纳动作；SQLite Project Store 继续作为事实来源。
10. 第一阶段重点是“真正单语编辑 + 双语复核”，不要同时扩大到诗歌专门编辑、自动出版、模型训练或新的编辑器产品。

**建议实施顺序：Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4。** Phase 1 是核心功能；Phase 2 让它真正理解每本书；Phase 3/4 建立质量闭环。Phase 5 暂缓。

---

## 15. 参考资料

### GitHub 项目
- [TransAgents](https://github.com/minghao-wu/transagents) — 多角色长篇文学翻译工作流。
- [Rainman Translate Book](https://github.com/deusyu/translate-book) — 全书分块、并行、manifest 校验和恢复。
- [Chinese WebNovel Skills](https://github.com/tance-mang/chinese-webnovel-skills) — 中文对白、去套路化表达和网文工作流参考。
- [Humanities Writing Companion](https://github.com/tizzy916/humanities-writing-companion) — 修订、对抗审稿和盲读工作流。
- [LiTransProQA](https://github.com/NL2G/LiTransProQA) — 文学翻译评价问题集与评估方法。

### 论文
- [TransAgents — TACL 2025](https://direct.mit.edu/tacl/article/doi/10.1162/TACL.a.25/132121/Perhaps-Beyond-Human-Translation-Harnessing-Multi)
- [How Good Are LLMs for Literary Translation, Really? — NAACL 2025](https://aclanthology.org/2025.naacl-long.548/)
- [LiTransProQA — arXiv 2025](https://arxiv.org/abs/2505.05423)
- [Extending CREAMT — arXiv 2025](https://arxiv.org/abs/2504.03045)
- [Large language models effectively leverage document-level context for literary translation, but critical errors persist](https://arxiv.org/abs/2304.03245)
- [Creativity Bias: How Machine Evaluation Struggles with Creativity in Literary Translations](https://arxiv.org/abs/2605.13596)
- [Better Literary Translation: A Multi-Aspect Data Generation and LLM Training Approach — ACL Industry 2026](https://aclanthology.org/2026.acl-industry.22/)
- [DRT: Deep Reasoning Translation via Long Chain-of-Thought](https://arxiv.org/abs/2412.17498)

### 仓库内相关设计
- [CHINESE-LITERARY-EDITING-PLAN.md](CHINESE-LITERARY-EDITING-PLAN.md)
- [docs/TRANSLATION_PIPELINE.md](docs/TRANSLATION_PIPELINE.md)
- [local-agent-service/skills/fiction-translation/SKILL.md](local-agent-service/skills/fiction-translation/SKILL.md)
- [local-agent-service/README.md](local-agent-service/README.md)
- [docs/TRANSLATION_PIPELINE_EFFECTIVENESS_CHECKLIST.md](docs/TRANSLATION_PIPELINE_EFFECTIVENESS_CHECKLIST.md)


---

## 16. 实施进展（2026-10-31）

本报告的 Phase 1 核心代码已开始落地，提交在 `main`：

- `src/literary.ts`
  - 新增 `buildChineseLiteraryEditingPrompt`。
  - 新增 `buildChineseTargetOnlyVoiceContext`，剔除源语言名称、原文证据、关系、章节摘要和 source-side anchors。
  - 只保留已确认中文风格规范、目标语人物声音、已批准中文对白和 TranslationBrief 已按来源版本/ordinal 过滤的已采纳中文例句。
  - 新增 `isChineseLiteraryFindingGrounded`；编辑 finding 必须以中文 draft 的 `targetExcerpt` 为证据。
  - 原稿未改变时不产生空洞风格 finding。
  - 双语审校可同时收到初译 `initialDraft` 和待核验的编辑版 `draft`。
- `src/documents/translationAgent.ts`
  - 中文文学 Run 先执行单语编辑，再执行双语 Accuracy / Terminology Review。
  - 编辑候选仅在当前批次内传递给后续双语复核，不提前写入 accepted translation。
  - 非中文目标语言保留既有审校顺序。
  - 双语复核完成后才标记中文编辑候选为 verified/corrected。
- `src/documents/projectStore.ts`
  - 新增 `markChineseEditorialFindingsReviewed`，在事务中更新编辑建议的双语复核状态和最终候选。
  - `setReviewFindingDisposition(action='apply')` 拒绝尚未完成双语复核的中文单语编辑建议。
- 测试
  - 新增单语输入不包含 source、source-side memory、章节标题的回归测试。
  - 新增 target excerpt grounding 和 target-only memory projection 测试。
  - 新增“未完成双语复核不得采纳”的 Project Store 测试。
- 文档
  - 更新 `fiction-translation` Skill、`docs/TRANSLATION_PIPELINE.md` 和本地 Agent 有效性检查清单。

### 自动化验证

截至本报告更新时，GitHub Actions 的 Local Agent Service 工作流在提交 `00640658a4b60108c9a9b54df18f9516a094e49b` 上已通过：
- local-agent-service tests
- TypeScript typecheck
- API route manifest check
- deterministic book-scan benchmark

随后加入的 accepted Chinese examples target-only 投影、用户编辑过的 styleGuide 保留逻辑，也已在提交 `958a41a` 的 Local Agent Service 工作流中通过。根仓库 CI 的另一个工作流还会执行 fanyi-extension 跨仓库测试；此前失败的用例位于 `.cross-sync/fanyi-extension`，涉及 page cache fingerprint 版本、source language 默认值及旧 URL 路由断言，与本次 local-agent-service 中文编辑改动无关。不要把该根 CI 失败误报为 local-agent-service 测试失败。

### 尚未完成的后续阶段

- Phase 2：从已采纳中文译文自动形成独立、可确认的 Chinese Target Voice / Editorial Policy；目前只复用已有 styleGuide、characterVoices 和 accepted examples，不引入新数据库。
- Phase 3：扩展全书质量审计，统计编辑建议数、verified/corrected 数、采纳/拒绝/撤销、过度编辑和双语复核失败率。
- Phase 4：建立 100–200 段的中文文学编辑 A/B 盲评语料，并对主力模型和本地模型进行可重复评测。
- Phase 5：积累人工偏好数据后再评估 SFT / LoRA / preference optimization；当前不做模型微调。


---

## 17. Phase 2 实施进展：作品级 Chinese Editorial Profile（2026-10-31）

Phase 2 的第一版已落地，直接复用现有 BookScan、LiteraryMemory revision 和 Project Store；没有新增数据库表或独立 Agent。

### 自动生成流程

1. 用户采纳译文，或文学 Run 完成后，服务检查当前 source revision 的 accepted translation ledger。
2. 已采纳片段达到最低样本门槛后，使用 `planBookSamples` 在已采纳片段集合内抽样，覆盖章节/位置/对白等代表性片段。
3. 原文只在本机参与确定性抽样；档案分析模型收到的只有中文已采纳译文和 segment ID。
4. 模型生成候选 `chineseEditorialProfile`：叙述声音、语域、节奏、对白、词汇、规则、避免事项和逐条 target-side evidence。
5. Project Store 对每条 targetExcerpt 核验：segment 必须属于当前 source revision，必须有当前 source hash 对应的 accepted translation，引用必须实际存在于该中文译文。
6. 候选保存为新的 LiteraryMemory revision。候选不会进入 Prompt。
7. 用户通过新增 review API 明确确认或拒绝。只有 confirmed profile 才能进入后续 TranslationBrief、中文单语编辑和翻译上下文。

### 本阶段代码

- 新增 `local-agent-service/src/documents/chineseEditorialProfile.ts`
  - 只从当前 revision 的 accepted translations 取样。
  - 复用 `planBookSamples`，抽样最多 24 段。
  - 发送给模型的输入只有中文目标语样本和 segment ID；原文不进入 Prompt。
  - 结构化输出要求 profile 和 observations；每条观察必须能回指实际中文样本。
  - 按样本 fingerprint 幂等，避免相同样本重复调用。
  - 最低样本量不足时记录 skipped 事件；分析失败不影响译文采纳。
  - 不覆盖用户已确认的 profile。
- 更新 `voiceContext.ts`
  - LiteraryMemory 保存版本化 `chineseEditorialProfile`。
  - 仅在 profile 已确认时，将其目标语风格字段投影到 voiceContext。
- 更新 `translationBrief.ts`
  - 只接受当前 source revision 下、具有至少三个不同证据片段的 confirmed profile。
- 更新 `projectStore.ts`
  - 校验 profile 的 source revision、accepted target text、source hash 和 target excerpt。
  - 证据失效时将 confirmed 降级为 candidate。
- 更新 `projectRoutes.ts`
  - 新增明确的 confirm/reject review API。
  - 用户采纳译文或应用文学 finding 后自动排队档案分析。
- 更新 `translationAgent.ts`
  - 完成/部分完成的文学 Run 自动检查是否需要生成档案。
- 更新 `api-route-manifest.json` 与 `openapi.json`。
- 新增测试
  - target-only profile 投影。
  - candidate 不进入 voiceContext。
  - accepted target evidence 被篡改后 confirmed 自动降级。
  - 单语编辑器只收到目标语 profile，不收到 source-side 资料。

### 当前 API

`GET /api/documents/projects/{projectId}/literary-memory` 可读取当前 profile 和历史 memory revisions。

`POST /api/documents/projects/{projectId}/literary-memory/chinese-editorial-profile/review`

请求体：

```json
{ "action": "confirm" }
```

或：

```json
{ "action": "reject" }
```

确认必须满足当前来源版本与至少三个不同 accepted target-evidence segment 的要求。

### 已知边界与下一步

- Phase 2 目前保护 confirmed profile，不会自动覆盖它；新增样本 fingerprint 变化后仍需补上独立的 pending-update/suggestion 展示与确认流程，才能完整覆盖“新证据冲突只生成建议”的情况。
- 目前服务端 API 已可确认/拒绝，尚未在 fanyi-extension 的 Literary Memory UI 中增加 profile 卡片、证据查看和确认按钮。
- Profile 的分析提示词和输出结构已有自动测试，但真实模型质量仍需通过 Phase 4 的中文盲评验证。
- Phase 3 下一步：把 profile revision、单语编辑 finding、双语复核状态、用户采纳/拒绝/撤销汇总进全书 Quality Audit；建立可审计的 before/after 指标。
