# 文学翻译预处理与实体记忆质量改进计划

**状态：** 研究与实施计划，尚未修改本计划以外的业务代码。  
**范围：** `saga/vocal-saga/local-agent-service` 与 `saga/fanyi-extension`。  
**目标：** 把全书文风补全、实体候选筛选、复合名称拆分、目标译名质量校验和记忆状态升级尽可能自动化；不要求用户逐项确认普通实体，也不让有问题的模型输出变成长期强约束。

## 1. 结论

目前不是一个单纯的 Prompt 问题，而是几个层次同时缺少门槛：

1. **文风界面可以导入旧的、不完整的预处理结果。** Local Agent 当前的 Context Graph 分析路径已经检查五个核心文风维度，并在缺失时定向补全；补全后仍缺字段会失败而不是标记完成。但扩展的“载入预处理文风建议”只要预处理概览里任一字段非空就可用，既不检查当前来源版本、分析版本，也不检查文风是否完整。导入函数只覆盖非空字段，所以旧概览里的“叙述声音 + 规则”可以进入编辑器，而语域、节奏、对白、措辞仍然为空。
2. **实体记忆是一个过宽的捕获网。** 服务端检查候选名称、目标译名是否非空，以及引用的原文证据是否真实，但没有充分判断它是不是值得跨章节持久化的专名/术语，也没有检查目标译名本身是否合理。于是普通名称、常见词、词汇例子甚至模型组合出来的多个名称，都可能成为长期记忆条目。
3. **实体名字段没有“必须是一项”的结构约束。** `translationContextDelta.ts` 和 Context Graph 实体落库逻辑将 `name/canonicalSource` 当作普通字符串保留。像 `Dozo / neh / Ingeles` 这样的清单只要整体被模型包装成一条名称，并且引用能在原文中找到，就可能作为单个实体保存。现在没有可靠的分拆与配对规则。
4. **名称目标缺少语言形态质量检查。** `Achiko → achi子` 这类混合拉丁字母与中文字符的目标译名不会仅因格式异常而被拒绝。只要目标非空、证据引用合法，候选便可能进入记忆；主服务与扩展侧旧分析路径的自动激活条件也不一致。
5. **“证据可验证”和“译名可信”混用。** 记忆模型有 `evidence-verified`、`user-confirmed`、`legacy-unknown` 的来源字段，但运行时的 `reviewStatus=confirmed` 本身仍可能使旧的 `legacy-unknown` 项获得强映射。扩展旧分析路径的 `autoConfirmLiteraryMemory()` 主要验证引用的 segment ID 与原文 quote，不等于验证 target 翻译正确。原文确实出现“Achiko”，并不能证明“achi子”就是正确译名。

## 2. 代码证据和职责边界

### 2.1 全书文风

- [Local Agent：Context Graph 分析与文风补全](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/contextGraph.ts)。当前代码有 `findMissingStyleFields()`、`styleRepairUsed` 和 `styleFieldCoverage`；核心维度包括 `narrativeStyle`、`styleRegister`、`styleRhythm`、`styleDialogue`、`styleDiction`，以及非空的 `styleRules`。`styleAvoid` 可以为空，这是合理的，不应为了填满表单臆造风格缺点。
- [Extension：全书文风编辑面板](https://github.com/saga/fanyi-extension/blob/main/src/entrypoints/document/App.vue#L467-L517)。导入按钮只检查概览是否“全部为空”，没有检查当前图谱版本与完整性。
- [Extension：导入文风候选](https://github.com/saga/fanyi-extension/blob/main/src/entrypoints/document/useLiteraryMemoryEditor.ts#L513-L565)。`importContextGraphStyleGuide()` 对空字段采取“不覆盖”的策略，但也因此不会修复缺失字段；它仍会将状态设为 `candidate`。

截图里“候选·尚未注入”本身表示当前记忆文风尚未进入翻译上下文，不一定是错误；真正需要修复的是：不完整/陈旧的预处理概览仍能被导入，以及正常翻译过度依赖人工点击导入、确认才能用上可验证的文风信息。

### 2.2 实体和名称候选

- [Local Agent：全书实体候选落库](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/contextGraph.ts)。`data.entities` 当前主要经过字段清理、证据验证和候选条数限制后保存。引文需要出现在对应样本中，但名称是否是复合清单、普通词或高价值书籍专名，并未在落库前得到确定性判定。
- [Local Agent：动态上下文增量](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationContextDelta.ts)。`validateTranslationContextDelta()` 会验证 `canonicalSource` 在证据引用中出现，并验证实体提及与实际译文有关，但没有将斜杠清单拆成多项，也没有目标语言形态质量校验。
- [Extension：文学记忆类型和清理](https://github.com/saga/fanyi-extension/blob/main/src/entrypoints/utils/document/literary.ts)。`sanitizeLiteraryMemory()` 保留名称与目标字符串，不做复合名称拆分、标准实体降噪或目标译名形态验证。
- [Extension：旧文学分析路径](https://github.com/saga/fanyi-extension/blob/main/src/entrypoints/document/useDocumentTranslation.ts)。此路径对返回的记忆调用 `autoConfirmLiteraryMemory()`。该函数能验证证据引用是否对应本批原文，但引用真实不能证明目标译名语义正确。
- 扩展的 Local Agent 文档约束明确规定：长文翻译的 Context Graph、证据、动态增量合并和规范记忆应以 Local Agent Service 为权威；扩展不应维护第二套候选提取/合并算法。因此修复应以服务端确定性规范化和质量策略为主，扩展只负责呈现机器状态、编辑用户设置和发起明确的重分析动作。

## 3. 设计原则

### 3.1 把“普通翻译”与“需要持久化的规范项”分开

普通词和常见国家名称应该由正常翻译处理，不必占据每本书的“实体译名表”。该表应优先保存那些确实会导致持续漂移或需要作品内约定的项目，例如虚构氏族 `Minowara`、虚构人物、别名、特殊称谓、书内专有组织、带历史变体的地点或反复出现且有专门含义的术语。

- `Japan → 日本`、`England → 英格兰` 这类有标准常见译法的地名，默认不作为书籍专属规范条目；如果原文存在 `Yedo/Edo` 等需要作品内区别或特殊约定的变体，则应保留。
- `God → 上帝` 默认属于普通宗教词汇处理，不应该仅因为大写或单次出现就成为强规范实体。若书中确实围绕特定神祇、信仰或术语区别反复使用，并且普通翻译可能造成概念合并，再允许登记为概念型记忆。
- 不要用只维护几个例子的硬编码黑名单解决问题。使用版本化的标准地名/实体词典、实体类型、全书出现分布、上下文重要性和是否存在目标译名歧义组成确定性筛选策略。词典只负责判断是否需要“项目专属映射”，不替代实际翻译。

### 3.2 规范候选分层，不将“来源有效”当作“译名正确”

建议统一采用以下语义：

| 状态/来源 | 含义 | 能否强制覆盖模型 |
|---|---|---|
| `user-confirmed` | 用户明确确认或编辑该规范映射 | 可以，优先级最高 |
| `translation-corroborated` | 不同原文片段中多个已接受译文稳定使用同一目标译名，且通过形态/冲突检查 | 可以，作为自动规范 |
| `evidence-verified` | 原文 quote 与 segment ID 真实对应，但译名尚未充分佐证 | 不应单独强制 |
| `run-canonical` | 本次全书预处理为本次 Run 选定的临时目标名，避免同波次/跨批次漂移 | 仅本 Run 内强制；不能升级为永久确认 |
| `candidate` | 原文证据与候选已保存，译名仍待佐证 | 只作软提示 |
| `legacy-unknown` | 历史记录没有可靠的确认来源 | 不应因 `reviewStatus=confirmed` 就自动获得最高权威 |

这不是增加人工审批关卡，而是让服务端按证据自动决定约束强度。对来源不明的历史项目，保留记录和历史译文，但降低其运行时权威；只在新的译文得到独立佐证后自动升级。用户明确确认的记录不被重写或降级。

### 3.3 实体名称必须是一项；清单要拆开或拒绝保存

在模型输出落库前增加共享的名称字段规范化器，并应用于 Context Graph、`translation_context_delta` 和旧式文学分析接口：

1. 识别 ` / `、`／`、` | ` 等清单分隔符，但不能见到任何斜杠就机械拆分，避免破坏 `AC/DC`、`OS/2` 以及作品中的真实组合名。
2. 对源名称与目标译名都能拆出相同数量的非空项，且每个源名称都能在证据原文中独立定位时，才按位置配对拆成多条候选。例如五个国家名称与五个译名可以先拆成五项。
3. 如果数量不相等、目标译名含义无法配对，或者源项在证据中不能独立定位，则不保存成一个“复合实体”；执行一次定向结构化修复或记录非阻塞诊断，并继续其他翻译。
4. 拆分后，每一项仍要经过标准实体/低价值词过滤。拆开不等于一定进入记忆；`England/Netherlands/Spain/Portugal/France` 很可能会全部被归类为标准地名，而不是五个书籍专属映射。
5. `Dozo / neh / Ingeles` 这一类词汇清单不能因为一段引用里同时出现，就当作一个实体。应先拆项，再根据词汇是否重复、是否具有作品专属含义、目标译名是否稳定决定是否持久化。

### 3.4 目标译名的自动质量检查

新增服务端 `canonicalTargetQuality` 校验器，至少支持本次主要目标方向 English/Romanized Japanese → Chinese，并留下语言扩展接口。

- 对中文目标中的人物名，像 `achi子` 这种拉丁字母与汉字混杂的无解释形式应判为可疑，不允许直接升为强映射；对模型生成的全拉丁原名未变化、源文片段残留、明显的源词拆字、分隔符清单和异常大小写也应给出风险标记。
- 规则只针对名字/实体规范译名，不应用于普通译文或合法保留拉丁字母的品牌、型号、缩写。判定时需结合实体类型、目标语言、原文字符系统和可靠词典；不能看到任何拉丁字符就一概拒绝。
- 对可修复的可疑姓名，自动触发一次**针对名称的定向修复**：输入当前可见原文、全书已选规范名称、可见别名与目标语言约束，要求返回一个单一的中文译名，不重译整段/整章。修复后再次验证；若仍然异常，则不强制写入规范表，保留原文可译性并记录非阻塞诊断。
- 不根据模型自述或仅一次真实引文自动断言名字“正确”。至少要分开记录原文证据有效性、目标字符串形态是否合格、目标译名是否有独立译文佐证。

## 4. 分阶段修改计划

### P0 — 修复预处理文风的陈旧/不完整导入

**修改范围**

- `vocal-saga/local-agent-service/src/documents/contextGraph.ts`
- `fanyi-extension/src/entrypoints/document/useContextGraph.ts`
- `fanyi-extension/src/entrypoints/document/useLiteraryMemoryEditor.ts`
- `fanyi-extension/src/entrypoints/document/App.vue`

**实施内容**

1. 服务端的 Context Graph status DTO 显式提供当前 `analysisVersion`、源版本、`styleFieldCoverage`、`styleGuideReady` 和缺失字段集合；扩展不得从“至少有一个字段非空”推断预处理可用。
2. 完整性的最低门槛为五个核心描述字段非空、至少一条规则；`avoid` 允许为空。必须与当前 `sourceRevisionId`、目标语言和服务端分析版本匹配。
3. 当用户打开编辑面板或点击“载入预处理文风建议”而发现概览不匹配/不完整时，正常路径自动请求服务端重分析并轮询实际状态；分析失败时显示具体原因，不导入旧字段、不把旧数据冒充为当前建议。服务端仍是唯一预处理执行者。
4. 取消“先载入，再手动确认才能正常用”的必经步骤：完整且通过证据检查的机器文风基准可自动进入后续 TranslationBrief，标识为机器生效状态；UI 保留编辑、禁用和撤销入口。机器生效绝不显示成“用户已确认”。
5. 对已确认的用户自定义风格规则保留高优先级。新预处理结果不得静默覆盖用户编辑；应合并为候选，或在用户主动选择“使用最新分析”时替换。
6. 对风格内容只补齐缺失维度，不为了形式完整而凭空编造 `avoid` 或没有证据支持的事实。已有的服务端定向补全保留；增加有效样本证据覆盖诊断。

**验收**

- 点击导入不可能把旧版、旧来源或缺字段结果带入当前文风。
- 五个核心维度有内容才标记可用；`avoid=[]` 仍能正常通过。
- 正常开始翻译无需用户先点击“载入建议”和“确认并注入”两次。
- 用户可撤销机器风格基准或恢复之前的自定义版本，且来源/版本可追溯。

### P1 — 建立单一的实体注册策略与 slash 清单规范化

**修改范围**

- `vocal-saga/local-agent-service/src/documents/translationContextDelta.ts`
- `vocal-saga/local-agent-service/src/documents/translationAgent.ts`
- `vocal-saga/local-agent-service/src/documents/contextGraph.ts`
- 需要时更新 `vocal-saga/local-agent-service/src/documents/contextGraphWorkflow.ts`
- `fanyi-extension/src/entrypoints/utils/document/literary.ts`（仅为兼容/展示，不复制服务端筛选算法）

**实施内容**

1. 把“某个名称在原文出现”与“值得进入规范实体表”分开。保存前计算类别、全书出现次数/章节数、当前证据、标准翻译可用性及其是否具有书内专属含义。
2. 以版本化标准地名词典和常见实体规范表过滤低价值映射。命中标准译法且无特殊歧义的项默认不写入持久实体表；翻译仍照常发生。
3. 为复合清单建立共享规范化器。只有源项、目标项数量一致且每个源项都能被原文证据验证时自动拆分；不一致时做一次小范围修复，失败则拒绝持久化组合项，但不阻断译文保存。
4. 在 Context Graph 的实体阶段明确要求“一条记录只有一个 canonical name”，并限制将普通词/标准地名作为重要实体；不因证据合法就跳过重要性判断。
5. 在记忆合并时对新候选执行同一服务端策略，避免全书预处理过滤过的低价值实体随后从动态 `context_delta` 再次进入记忆。

**验收**

- `England / Netherlands / Spain / Portugal / France` 不再作为一个合并名称出现；拆分后，标准国家名一般不会进入书籍专属实体表。
- `Dozo / neh / Ingeles` 不再作为一个实体；无重复、无书中特殊意义的单词不自动成为长期映射。
- 真实的斜杠专名（例如 `AC/DC`、`OS/2`）不会被错误拆开。
- `Minowara` 等虚构氏族、专有组织、人物仍然能够以独立规范名保留，不会因标准实体过滤而漏掉。

### P1 — 名称目标质量检查和自动定向修复

**修改范围**

- `vocal-saga/local-agent-service/src/documents/translationContextDelta.ts`
- `vocal-saga/local-agent-service/src/documents/contextGraph.ts`
- `vocal-saga/local-agent-service/src/documents/translationAgent.ts`
- `vocal-saga/local-agent-service/tests/document-agent-prompt.test.mjs`
- `vocal-saga/local-agent-service/tests/translation-context-delta.test.mjs`
- `vocal-saga/local-agent-service/tests/document-context-graph.test.mjs`

**实施内容**

1. 对 `person/character` 类规范译名做目标语言形态检查。中文译名不应无解释地出现 `achi子` 这样的中英混合残片。
2. 发现低风险可修复问题时，自动执行一次只针对名称的修复调用；不需要用户打开人物管理，也不重跑整本书。
3. 如果目标仍然不合格，不将它升级成 `auto` 或 `confirmed`，而是保留候选/源文回退和诊断事件。该异常不应令整本 Run 失败。
4. 将名称源、目标、目标字符形态、目标出现次数、来源证据 ID、修复次数与最终 disposition 写入结构化诊断；默认 UI 不展示大量日志，只在问题面板可查看。

**验收**

- `Achiko → achi子` 被质量检查拦截，并尝试自动生成一个合法中文专名目标；没有合格结果时不形成强规范映射。
- 不误伤一般译文中的拉丁字母、品牌、产品型号或用户明确要求保留的源文名称。
- 正确性校验仅影响记忆/规范表的入库强度，不会丢失初译结果。

### P2 — 统一记忆权威与历史记录升级规则

**修改范围**

- `vocal-saga/local-agent-service/src/documents/translationContextDelta.ts`
- `vocal-saga/local-agent-service/src/documents/translationBrief.ts`
- `vocal-saga/local-agent-service/src/documents/projectStore.ts`（如需增加显式权威字段）
- `fanyi-extension/src/entrypoints/utils/document/literary.ts`
- `fanyi-extension/src/entrypoints/document/useDocumentTranslation.ts`（仅限其仍需支持的旧路径）

**实施内容**

1. 把“证据引用验证通过”记录为来源事实，不自动等同于“目标译名正确”或“用户已确认”。
2. 将运行权威与确认来源拆开：用户确认最高；机器候选需要目标形态验证和不同片段的已接受译文佐证才能自动升为可强制映射；只验证到原文 quote 的项目保持弱约束。
3. `legacy-unknown` 既不自动删除，也不自动覆盖为用户确认。读取旧数据时以较低运行权威参与翻译，保留历史目标和可回滚记录；只有新证据足够时才自动升级。
4. 主服务负责规范化、分拆、过滤及自动升格；扩展不重复实现这些规则。旧分析端点必须复用相同的服务端规则，或在主路径明确不再使用时被限制到其既定非 Project/Run 场景，避免两套语义。
5. 不让普通 `candidate` 覆盖强映射；同一来源名称出现多个强目标时，不按数组顺序选择，而是记录冲突、沿用已确认项或在无法判定时退回弱约束。

**验收**

- `legacy-unknown` 不会仅因旧 `reviewStatus=confirmed` 而在每批次强制覆盖译文。
- `evidence-verified`、`translation-corroborated` 和 `user-confirmed` 的 UI 标签、持久化值与运行时优先级一致。
- 用户明确确认的译名和人工编辑从不被自动重写。
- 同一本书的初译、两类 Reviewer 与后续批次使用同一份服务端规范映射。

### P3 — 回归集、审计与旧记忆清理

新增跨两个仓库的稳定回归夹具，不依赖一次线上模型调用的偶然结果：

| 场景 | 预期 |
|---|---|
| 核心文风字段缺失，服务端重分析 | 定向修复后完整才可用；失败明确暴露，不能标记完成 |
| 扩展缓存包含旧版本或只有两个字段的文风概览 | 自动重分析/补全；不得导入陈旧概览 |
| `God/Japan/England` 标准含义单次出现 | 正常翻译，但默认不生成书籍专属实体映射 |
| `God` 在作品中作为重要宗教概念反复出现 | 可根据显著性与歧义规则保留为概念候选，而不是一律黑名单 |
| 带空格的 slash 清单，源/目标项数量一致 | 拆成配对项，再逐项执行标准实体过滤 |
| slash 清单数量不一致 | 不保存组合项，执行一次局部修复并记录诊断 |
| `AC/DC`、`OS/2` 等真实组合名 | 不拆分 |
| `Achiko → achi子` | 目标质量检查拒绝自动升格并触发名称级修复 |
| 单条有效原文引用、错误目标译名 | 只能证明原文证据有效，不得仅凭此将错误目标设为强规范 |
| 两条不同原文段落持续采用相同合格目标译名 | 满足其余规则后自动升为 `translation-corroborated` |
| 用户确认译名与自动候选冲突 | 用户确认优先，候选被记录而不替换 |
| 旧记录的来源为 `legacy-unknown` | 读入时弱约束，保留可回滚历史，不冒充用户确认 |

同时在 Context Graph 输出审计、TranslationBrief diagnostics 和 `translation.context-delta.parsed` 事件中记录简明计数：过滤的标准实体数、拒绝的复合名称数、目标质量可疑数、修复成功/失败数、机器升级数和因权威冲突未启用的映射数。UI 显示汇总和可展开例子，不把完整原文/译文无差别写入日志。

## 5. 实施顺序与验收门槛

推荐先完成 **P0 文风状态正确性**，再完成 **实体分拆与质量门槛**，最后统一历史数据的权威语义。理由是 P0 能立即修复截图里最直接的错误；P1 会改变进入长期记忆的候选，需要服务端和扩展的测试一起更新；P2 涉及旧数据的运行权威，必须保留兼容性和回滚路径。

每一阶段均须遵守以下约束：

- Local Agent Service 是本地 Project/Run 管线的唯一事实来源；不要在扩展端复制实体筛选、名称规范化或记忆自动升级算法。
- 译文生成成功与实体元数据失败隔离。元数据修复/质量检查不能导致已完成的译文丢失。
- 不自动覆盖用户已接受/人工修改的译文；不静默删除历史实体记录。低价值旧项可从运行时强规范表中降级/隐藏，保留原始记录和审计。
- 自动修复有界：实体列表/名称修复失败不能无限循环或停止整本翻译；只有来源版本错配、存储完整性故障或真正无法消解的用户固定规范冲突才需要暴露人工问题。
- 每项关键规则都要有服务端单元测试和跨批次集成测试；扩展侧测试按钮状态、陈旧概览、记忆展示与状态标签。最后执行 Local Agent Service 的测试、类型检查、路由清单检查和确定性扫描基准，并执行扩展相关 Vitest 测试。必须报告实际测试结果，不将未运行的检查写成通过。

## 6. 最终产品行为

目标不是把更多表格填满，而是让表格更小、更可靠：

- 完整的机器文风基准自动生效，用户可以撤销或调整；不再通过手动“载入 + 确认”才能进入正常翻译。
- 通用常见名称由正常翻译处理，不占用全书专属实体映射；只有有助于跨章一致性的条目才长期保留。
- 一个实体一条规范记录；清单自动拆分，有歧义的清单自动修复或安全忽略，不把组合字符串当成一个名字。
- 自动生成的中文人名不允许出现明显混合脚本残片；可修复问题自动重试，不可修复的候选不获得强制权威。
- 机器证据、目标译名质量和用户确认是不同维度。可靠候选自动升级，来源不明旧数据不会再被误当作权威，用户确认始终优先。
