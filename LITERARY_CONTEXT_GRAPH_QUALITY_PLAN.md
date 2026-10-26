# 文学翻译预处理与实体译名质量改进计划（合并版）

**状态：** 已实施主要代码修改并完成专用验证；本文同时记录实施范围、剩余限制与验收结果。  
**适用项目：** \`Shogun\`（项目 ID：\`4fa564de-b0ec-485d-88dc-562ad1bf66d3\`，数据快照见 \`entity-style-quality-plan.md\`）。  
**涉及仓库：** \`saga/vocal-saga\` 与 \`saga/fanyi-extension\`。  
**目标原则：** 能由服务端确定性完成的就自动完成；人工操作只保留给真实歧义、用户偏好和不可安全自动决定的冲突。自动化不能将机器推断伪装成人工确认，也不能覆盖用户已接受的译文。

## 1. 合并后的结论

两份分析有不同证据层级，需以项目数据库快照修正此前对文风问题的初步判断。

| 问题 | 合并后的根因判断 | 优先级 |
|---|---|---|
| 全书文风表只显示“叙述声音”和“规则” | 该 Shogun 项目的 Context Graph 元数据实际已有全部五个维度；截图中的 LiteraryMemory 是较早的一份部分导入结果。问题核心是一次性手动复制、空值固化、字符上限不一致、没有版本/差异提示，而不是当前图谱必然缺字段。 | P0 |
| 文风修改后已有译文未变旧 | \`projectStore.ts\` 的 Context Graph fingerprint 目前只把 \`narrativeStyle\` 和 \`styleRules\` 两个元数据字段纳入哈希，另外四个维度和 \`styleAvoid\` 的变化可能未触发 stale。 | P0 |
| \`God→上帝\`、\`Japan→日本\`、\`England→英格兰\` 等普通项进入实体表 | 没有“是否值得成为书籍专属映射”的入库闸门。有效原文引文不等于需要长期保存的专名，也不等于目标译名正确。 | P0 |
| 多个名称合成一条实体 | Context Graph 与动态 \`context_delta\` 验证记录主要检查字符串和证据，没有强制“一条记录只对应一个来源名称和一个目标”。复合清单可能变成强制规范映射。 | P0 |
| \`Achiko→achi子\` | 目标译名缺少目标语言形态质量检查；已有旧记忆即使是机器生成/来源不明，也可能因 \`reviewStatus=confirmed\` 而压过后来更合理的新建议。 | P0 |
| 扩展与本机服务规则不一致 | 扩展的旧文学分析路径会仅凭 \`segmentId + quote\` 可验证就自动确认实体；主服务的 Project/Run 路径则有不同的证据、时间边界和映射权威规则。 | P1 |

\`entity-style-quality-plan.md\` 报告的数据库快照显示：Context Graph 的五个文风字段均有数据；\`literary_memory_revisions\` 的当前文风记忆仍是较早的另一份数据，\`register/rhythm/dialogue/diction/avoid\` 为空。图谱长度分别约为 626、618、615、1000、733 字，规则 8 条、avoid 6 条，而扩展的 \`sanitizeLiteraryMemory()\` 和服务端 \`voiceContext.ts\` 都把五个描述字段限制在 500 字。因此即使重新导入，内容仍可能被截断。该报告还称当前 \`translation_results\` 中未找到 \`achi子\`、全角斜杠和“英吉利人”等污染样本，意味着脏元数据已存在，但这份快照中尚未观察到这些模式污染已接受译文；应优先清理元数据，避免后续污染。

这些具体数据库数据来自另一份分析报告。本计划把它们作为该项目快照的证据，不将它们泛化为所有项目必然相同的状态。

## 2. 架构原则：一个事实来源，分开证据、质量和权威

### 2.1 Local Agent Service 是唯一业务规则所有者

实体筛选、复合名称规范化、目标译名检查、目标置信升级、Context Graph 版本与动态上下文合并，都应以 \`vocal-saga/local-agent-service\` 为权威。扩展负责展示、编辑用户偏好、呈现诊断和同步状态，不能另写一套不同的实体分类与自动升级算法。

扩展仍可做格式防御和 UI 校验，但不应仅凭一段原文引用就自行将服务端候选提升为强制映射。旧的 \`/api/translate/document/literary/analyze\` 路径必须复用服务端规范策略，或者在确认已无合法调用方后移除/限制；不能让它继续绕开 Project/Run 的实体质量规则。

### 2.2 不能混用的三个判断

1. **Source evidence verified：** 原文引文与稳定 segment ID 相符，只能证明这条名称/观察在原文中出现。
2. **Target quality accepted / translation corroborated：** 目标译名形态合格，且在独立的已接受译文或有明确规范依据的目标语言规则中获得支持。
3. **User confirmed：** 用户明确确认或手工编辑。只有这类记录才能显示为“用户已确认”。

建议运行时权威顺序如下：

| 来源/状态 | 使用方式 |
|---|---|
| \`user-confirmed\` | 最高优先级。除非用户主动编辑/撤销，不自动覆盖。 |
| \`translation-corroborated\` | 经目标质量检查，并由不同原文片段中的已接受译文独立佐证，可作为自动规范映射。 |
| \`run-canonical\` | 本次全书预处理选定的临时规范名，防止并行批次和后续批次各自命名；只限本次 Run，不伪装为永久确认。 |
| \`evidence-verified\` | 引文有效，但目标译名正确性尚未建立；不应单独成为强制映射。 |
| \`candidate\` | 仅供参考。 |
| \`legacy-unknown\` | 旧数据来源不明，不能仅凭旧 \`reviewStatus=confirmed\` 自动获得最高权威。 |

不要直接复用现有 \`candidate/confirmed\` 二态来表示所有机器和用户状态。如果短期兼容需要保留 \`reviewStatus\`，则用独立的 \`activationSource/targetQualityStatus\` 字段表达机器状态；UI 按真实来源显示，不把自动激活说成用户确认。

### 2.3 不按“目标译名相同”机械合并实体

\`England\`、\`English\` 和 \`English / England\` 不应仅因模型给了相同目标字符串就合成同一实体；它们可能分别指国家、语言、民族/国民形容词。相同目标可以是错误译名或模型合并造成的假象。

只在来源名称/别名、实体类型和原文共指证据都兼容时合并；对复数、拼写变体等情况先做受限标准化，并验证共指。不能用目标字符串相同、子串包含或宽泛语义相似度单独合并，以免把不同概念误合并。

## 3. P0：文风基准采用版本化自动同步，而不是一次性手动导入

### 3.1 代码问题

- \`local-agent-service/src/documents/contextGraph.ts\` 已有五维文风缺失检查和定向补全；不要在没有新证据时再复制一套模型分析。
- \`local-agent-service/src/documents/voiceContext.ts\` 将五维文风字段统一截断至 500 字，并将缺失字段序列化为空字符串。
- \`fanyi-extension/src/entrypoints/utils/document/literary.ts\` 对同样的五个字段也用 500 字限制；图谱实际允许的上限为 1000。规则长度是 240，但 avoid 在扩展侧只有 100。
- \`fanyi-extension/src/entrypoints/document/useLiteraryMemoryEditor.ts\` 中的 \`importContextGraphStyleGuide()\` 是一次性复制，只覆盖非空字段，然后把整份记忆变成 candidate。没有记录其来源图谱 revision/analysisVersion，也没有后续变化检测。
- \`fanyi-extension/src/entrypoints/document/App.vue\` 显示“候选·尚未注入”，并要求先导入再点击确认；完整且可验证的机器文风因此仍依赖手工的两步操作。
- \`local-agent-service/src/documents/projectStore.ts\` 的 \`contextGraphFingerprint()\` 目前仅对 \`narrativeStyle\`、\`styleRules\` 两个 meta 字段取值；其他文风字段改变未必导致已有译文变 stale。

### 3.2 建议实现

1. 把图谱文风视为机器生成的版本化基准，而不是一次性拷贝。记录源 revision、analysis version、内容 fingerprint 和生成时间。服务端在构建 TranslationBrief 时直接读取当前有效的图谱文风，确保初译及两类 Reviewer 使用相同快照。
2. 对用户编辑的风格覆盖与机器基准保留来源信息。可以采用“机器基准 + 用户覆盖”的合并视图；若为控制迁移范围继续使用一个 \`styleGuide\` 对象，也必须增加来源/版本字段和可区分的系统应用状态。刷新图谱时不得默默覆盖明确的用户编辑。
3. 完整且通过服务端校验的机器文风默认自动应用，不要求用户先点击“载入建议”再“确认并注入”。用户仍可编辑、停用、撤销或恢复上一个基准。UI 应区分“自动应用”和“用户确认”，不能把自动应用显示为“已确认”。
4. 旧记忆若缺少来源元数据，先把非空字段作为 legacy 值保留，自动用当前图谱补齐空白字段，并记录差异；不要因为缺字段就把整份记忆归零。对图谱中有更新且与旧值冲突的字段，按来源和用户编辑状态决定保留哪一项，并在 UI 提供可回滚差异，而不是要求逐字段手工确认。
5. 空字段不要在持久化/TranslationBrief 中固化为无意义的 \`''\`。序列化时省略无值字段，或使用明确的 null/empty 语义；“avoid 为空”属于合法情况，不触发无根据的补写。
6. 统一长度限制：五个描述字段至少允许与 Context Graph 一致的 1000 字；rules/avoid 使用一致的单项长度与条数限制。不要让扩展层或 voiceContext 再把已完整的字段悄悄截断。
7. 修改 \`contextGraphFingerprint()\`，把五个描述字段、rules、avoid、分析版本和相关来源版本完整纳入 hash；对会影响 TranslationBrief 的其他图谱元数据也检查 fingerprint 覆盖。版本变化可以将相关译文标记为 stale，但绝不能自动覆盖用户已接受的译文。

### 3.3 验收

- 对当前 Shogun 快照，刷新后机器基准能补齐旧记忆里缺失的语域、节奏、对白、措辞和 avoid；已有非空内容及用户编辑都有来源记录和回滚能力。
- 1000 字的对白描述、733 字的措辞描述不会在服务端或扩展端被截断。
- 五维描述及 rules/avoid 任一变化都会改变相关 fingerprint；stale 译文只提示/排入重译范围，不静默覆盖人工接受内容。
- 正常翻译路径无需用户先导入再确认，机器状态也不会显示为人工确认。
- 无有效文风图谱或分析失败时，明确记录缺失原因；不伪造完整，也不因可选的 avoid 为空而阻断翻译。

## 4. P0：实体译名表必须只保留对全书一致性有价值的条目

### 4.1 入库策略

在 \`vocal-saga/local-agent-service\` 新增一个版本化的纯函数策略模块，例如 \`canonicalEntityPolicy.ts\`。它统一负责实体类别归一、是否值得持久化为书籍专属规范项、目标译名形态检查与候选 disposition。Context Graph、\`translationContextDelta\`、记忆合并及旧文学分析端点都调用同一策略。

不得把“原文出现了这个词”或“模型输出了 target”当成实体入库的充分条件。筛选应组合以下证据：

- **实体类型**：使用服务端规范枚举，不直接保存模型任意 \`kind\` 字符串。将 \`country/place\` 归一到 place，将 \`clan/dynasty/faction/group/organization\` 归一到 organization，将 \`work/artifact\` 保留为明确类型，将 \`language/term/deity\` 等根据定义归一到 concept 或 other。扩展端现有类型也需兼容这些分类。
- **标准翻译可得性**：标准地名、普通词汇、语言名、民族/国民称谓、度量单位、普通头衔通常不需要书籍专属映射。用版本化词典与确定性词法规则组合，而不是只写几个名字的黑名单。
- **全书重要性**：考虑名称出现次数、跨章节分布、专名形式和上下文重要性。频次不能是唯一标准：只出现一次但确有独特意义的虚构氏族/人物仍可能需要保留。
- **译名歧义与书内约定**：只有可能发生翻译漂移、名称变体需要统一、或作品明确赋予特殊概念含义的项目才应该进入长期规范表。
- **可验证来源**：每一项仍需验证 source evidence。目标译名质量是另一个独立门槛。

示例处理：

| 候选 | 默认处理 | 例外 |
|---|---|---|
| \`Japan → 日本\`、\`England → 英格兰\` | 由普通翻译处理，不进入书籍专属表 | 作品存在特定异名/特殊约定或语义冲突时保留 |
| \`God → 上帝\` | 普通宗教通名不自动进表 | 特定神祇或有助于避免书中概念混同，且有跨章节证据时保留 |
| \`the Queen\`、\`Heir\`、\`the Emperor\` | 普通角色称谓不作为独立通用实体 | 原文证据证明它稳定指向同一角色时，可作为该角色的可见称谓/别名 |
| \`longitude\`、\`pigeon\` 等普通词 | 不进规范实体表 | 成为作品专属术语或关键对象时另行判断 |
| \`Minowara\`、专有氏族/组织/人物 | 保留并建立单一规范名 | 不得因现实历史原型而替换原文专名 |
| \`the Black Ships\` 等历史/作品内专名 | 候选保留，使用证据与重要性判断 | 不因为可直译就自动过滤 |

不能简单要求“非人物 kind 必须是 place/organization 才保留”。这会误杀作品、器物和具有专有含义的概念。反过来，也不能让模型填写任意的 \`kind\` 就绕开筛选。

### 4.2 一条记录必须对应一个名称

当前 \`contextGraph.ts\` 的实体保存和 \`translationContextDelta.ts\` 的 \`canonicalSource\` 验证没有充分防止复合清单。新增共用的 compound-name validator：

1. 优先识别具有清单语义的分隔符模式，例如带空格的 \` / \`、全角 \`／\`、\` | \`；不要拆分 \`AC/DC\`、\`OS/2\` 这类真实组合名。逗号需有明确清单形态才可拆，避免把姓/名格式误拆。
2. 源名称被拆成多个部分时，每个部分都必须能在所引用的原文证据中单独定位。目标串包含多项时，只有源/目标数量一致、配对顺序可验证时才允许自动分拆成独立映射。
3. 若分隔符仅出现在目标侧（例如 \`Sire → 船长（敬称）／大人\`），该目标不能作为一个规范译名。尝试一次局部结构化修复；失败时拒绝该映射而不是整段译文。
4. 如果源/目标项数不一致、某项没有独立证据或含义无法可靠配对，不允许把整串保存在实体表。记录 \`compound-name-rejected\` 诊断，让本批其他翻译继续。
5. 拆分后逐项通过 entityWorthMapping 与 target quality 策略。拆开不意味着自动保存。例如 \`England / Netherlands / Spain / Portugal / France\` 拆成五项后，标准国名默认仍不进入书籍专属表。
6. Prompt 明确规定“一条 entity 只能包含一个 canonical source name 和一个 target translation；多个术语必须分别列项”。Prompt 是减少脏输出的第一道防线，服务端验证才是最终保障。

### 4.3 目标译名质量检查

新增服务端 \`isValidCanonicalTarget()\` / \`canonicalTargetQuality()\`，先支持当前主要方向 English/Romanized Japanese → Chinese，按类型和目标语言判断，而不是粗暴禁止全部拉丁字母。

- 对中文人名，\`achi子\` 这类未经规则支持的中英混合形式属于可疑目标；不允许它只凭引文有效就成为强映射。
- 对目标侧存在分隔符清单、明显解释性括注、源文残留、无意义混合脚本或空/纯符号/纯数字的情况，拒绝强规范化。书名引号等合法包装可做安全规范化，而不是把所有引号一概判错。
- 品牌、产品型号、缩写，以及用户明确要求保留原文写法的名字可以通过类型/白名单策略合法保留；不使用“只要目标有拉丁字母就拒绝”的规则。
- 对可修复异常自动进行一次名称级定向修复，不重译整章；修复后仍不合格则保持 candidate/不启用强映射，记录诊断并继续翻译。
- 目标形式合格不等于语义正确；强映射仍需用户确认或独立已接受译文佐证。对 \`Achiko\`，报告所述新图谱建议 \`阿千\` 可作为重新评估候选，但不能仅凭一个新模型结果就宣称绝对正确。

### 4.4 类型和重复项规范化

把模型自由填写的 \`kind\` 归一成固定枚举，并在落库/记忆合并前执行相同的 policy。增加重复项处理，但不要按“target 相同”直接合并：

- 只有 source/alias 的关系、类型和证据均支持共指时才折叠重复项。
- \`England\` 与 \`English\` 不能因为目标字符串一样就合并；相同 target 可能是错误映射的症状。
- \`Council\` 与 \`the Council of Regents\` 也不能只因子串关系而自动合并；需有证据证明是同一组织的变体/别名。
- 合并前若发现同一 source 有不同 target，按权威状态处理，不依据数组顺序任意选一个。

## 5. P0/P1：修复旧记忆权威与新图谱更新

这一步针对 \`Achiko→achi子\` 等已经保存的脏映射。

1. 对当前 source revision 重新分析时，不能只新增/更新模型本次重新产生的节点；要对旧 Context Graph 节点做版本化 reconcile。未再出现、已失效或质量检查拒绝的旧节点应标为 inactive/superseded，或在重建快照中排除，不能继续作为运行时强映射。
2. 对旧 LiteraryMemory 做非破坏性迁移：保留原始记录、创建可回滚的规范化版本；不静默删除历史记录，不修改已接受译文。
3. 如果实体是明确的 \`user-confirmed\`，尊重用户固定译名。若是 \`legacy-unknown\`、\`evidence-verified\` 或其他机器来源，则重新经过目标质量和当前图谱证据检查。像 \`achi子\` 这种不合格的机器旧目标自动降级/停用，不再强制注入。
4. 当前图谱如果有新的目标建议（例如 \`Achiko → 阿千\`），把它当作新候选；通过质量检查后可作为 run-canonical 使用，待多段接受译文佐证后再升级为 translation-corroborated。若证据充足且已有目标质量通过的独立佐证，则自动更新机器映射；用户确认的旧目标不被静默替换。
5. 对旧版 Context Graph 分析版本升级，不只是提升 version 常量。需要确定旧 node/edge/meta 的重建或过期策略，否则旧脏节点可能残留并继续参与检索。
6. 对 \`context_delta\` 自动规范化：若当前 TranslationBrief 已将源名称保护为规范项，后续保存的候选 metadata 不得又写入冲突目标；必须由服务端统一归一或将冲突 candidate 标为 suppressed。

## 6. 跨仓库具体落点

### \`vocal-saga/local-agent-service\`（权威逻辑）

- \`src/documents/contextGraph.ts\`：标准化实体 kind、入库 worth gate、单项名称/目标检查、目标质量、旧节点 reconcile；增加各类 drop/suppress 诊断。
- \`src/documents/contextGraphWorkflow.ts\`：明确排除常见通名/标准地名，强调虚构专名和单项 entity 契约；确保五维文风结果结构稳定。
- 新模块 \`src/documents/canonicalEntityPolicy.ts\`（建议名）：实体类型归一、低价值实体识别、复合清单拆分/合法性、目标译名形态质量及自动 disposition。让 Context Graph、动态 context delta、brief 和记忆更新调用同一实现。
- \`src/documents/translationContextDelta.ts\`：动态候选应用相同的实体价值、compound-name 和 target-quality 门槛。
- \`src/documents/translationAgent.ts\`：\`buildCanonicalTermProtections()\` 不为非法/复合目标建立 marker；context delta 的目标与本次有效映射保持一致。
- \`src/documents/translationBrief.ts\`：区分用户确认、机器佐证、run-canonical 与 candidate；只检索当前可见、有效且非低价值的映射。
- \`src/documents/voiceContext.ts\`：文风字段长度和空值序列化修正。
- \`src/documents/projectStore.ts\`：fingerprint 覆盖全部五维文风、rules、avoid 和相关分析/来源版本。
- 测试：\`tests/document-context-graph.test.mjs\`、\`tests/translation-context-delta.test.mjs\`、\`tests/document-agent-prompt.test.mjs\`、\`tests/translation-brief.test.mjs\`，并增加跨批次/运行级集成测试。

### \`fanyi-extension\`（状态与编辑 UI）

- \`src/entrypoints/utils/document/literary.ts\`：将文风长度上限从 500 调整到与服务端一致的 1000；将 avoid 的上限与服务端对齐；兼容新的机器状态与来源元数据。
- \`src/entrypoints/document/useLiteraryMemoryEditor.ts\`：从一次性导入改成版本可见的差异同步；不重复实现服务端实体筛选策略；保留手动编辑/撤销及差异回滚。
- \`src/entrypoints/document/useContextGraph.ts\`、\`src/entrypoints/document/App.vue\`：显示图谱文风版本/更新状态、机器自动应用与用户确认的区别；低价值条目折叠，展示被过滤的计数和可展开诊断，而不是把普通名词表铺满 UI。
- \`src/entrypoints/document/useDocumentTranslation.ts\`：检查旧文学分析路径。它不得在本地服务已判定目标无效/候选状态时，仅凭 quote 验证就把实体提升成强映射；应消费服务端返回的 activation/disposition，或收敛到统一 Project/Run API。
- 测试：\`src/__tests__/literaryMemory.test.ts\`、\`src/__tests__/document.test.ts\` 与文风导入/Context Graph UI 的测试。

## 7. 存量数据和 stale 策略

- 对 Shogun 项目当前数据，先只读 dry-run 输出：低价值实体、复合 source、复合 target、目标形态可疑、旧版本节点和不同权威等级的数量。dry-run 不改数据库。
- 通过版本化迁移/重分析重建当前可用的规范候选。机器生成且不合格的旧 mapping 可以自动降级或从运行时视图排除，但保留审计及恢复信息；用户确认的项不由自动迁移修改。
- 对已经接受的译文不做批量原地改写。指纹变化只使相关段落 stale，让统一 Run 在用户启动/继续时重新生成候选；已有结果与人工修订继续保留。
- 报告中的当前快照称 \`translation_results\` 未发现这些异常目标，因此应把本次改动视为污染预防与元数据修复，不必假设已经需要整本重译。不过，执行迁移前仍需对实际数据库重新做一次只读检查，不能将旧报告的零命中当作永久事实。
- 标准实体过滤与低价值旧项不应依赖固定项目 ID；对所有项目按 source revision、目标语言、policy version 执行同样的兼容逻辑。

## 8. 推荐实施顺序

### 第 1 阶段：文风自动同步和 fingerprint（P0）

修复空值固化和长度限制；加完整的 style metadata fingerprint；把机器基准与用户覆盖的来源区分开；增加扩展中的旧版本/更新提示；机器基准完整时默认自动应用，不再依赖手工导入与确认。

### 第 2 阶段：服务端实体策略（P0）

实现单一的 \`canonicalEntityPolicy\`，统一 kind 归一、低价值实体过滤、单项名称校验、目标形态检查。先接入 Context Graph，再接入动态 \`context_delta\` 与 TranslationBrief。Prompt 规则同步修改，但 Prompt 不能代替服务端门槛。

### 第 3 阶段：旧记忆与图谱 reconcile（P0/P1）

加入 dry-run 与可回滚迁移。对 \`Achiko → achi子\` 这类机器来源且格式不合格的映射自动降级；允许新图谱的合格候选在本 Run 中使用，但不自动覆盖 user-confirmed 项。

### 第 4 阶段：动态元数据和扩展统一（P1）

确保 context delta 不重新引入已过滤实体或冲突目标；扩展 UI 只显示服务端 disposition 与机器状态，移除/限制仅凭 quote 就确认目标译名的第二套逻辑。

### 第 5 阶段：质量回归集与验收（P1）

增加确定性测试、跨批次集成测试和实际数据 dry-run。测试不依赖某一次模型输出恰巧正确；对“需要局部修复”的情况检查重试有界，并确保元数据验证失败不会丢失翻译结果。

## 9. 回归测试与验收矩阵

| 场景 | 预期 |
|---|---|
| 当前图谱文风完整、LiteraryMemory 只有叙述声音和 rules | 自动补齐缺失字段，显示图谱版本和差异，不要求用户手动两步导入 |
| 文风字段大于 500 字 | voiceContext、扩展 sanitize 与 UI 都不截断已允许的内容 |
| 修改 rhythm/dialogue/diction/avoid | fingerprint 改变，相关结果按 stale 规则处理 |
| \`God/Japan/England\` 以普通通名/常见国家含义出现 | 不作为书籍专属实体映射强制注入 |
| 特定神祇/作品内专有名、\`Minowara\` 等虚构氏族 | 通过类型/重要性/证据检查后仍能保留 |
| \`the Queen\`、\`Heir\` 作为一般称谓 | 不独立成为强映射；若证据证明是某人物的稳定称谓，作为该人物的可见别名处理 |
| \`Dozo / neh / Ingeles\` | 不再作为一条实体保存；逐项验证后仅保留值得跨章节统一的术语 |
| 五个国名的 slash 清单 | 源/目标数量一致时先拆项，再过滤标准地名；不得保存为复合名称 |
| \`Sire → 船长（敬称）／大人\` | 目标质量检查拒绝复合目标，尝试一次局部修复，失败则不激活 mapping |
| \`AC/DC\`、\`OS/2\` | 不因包含斜杠被误拆 |
| \`Achiko → achi子\` | 机器候选被目标质量检查拦截，不升级成强映射；自动尝试一次名称级修复 |
| \`Achiko → 阿千\` | 字符形态检查可通过，但语义权威仍需当前运行证据/独立接受译文佐证 |
| 新图谱与旧 \`legacy-unknown\` 冲突 | 新的合格候选可在本 Run 使用；旧目标降级/保留审计，不冒充用户确认 |
| 新图谱与 \`user-confirmed\` 冲突 | 用户固定目标优先，系统提示差异但不覆盖 |
| 两个实体目标相同但源名只是语义相关（如 England/English） | 不按目标相同自动合并 |
| Context Graph 重分析未再产出旧脏节点 | 旧节点被标为过期/停用，不再参与运行时检索 |
| 实体 metadata 修复失败 | 记录诊断并继续保存可用翻译，不能使整本 Run 失败 |

## 10. 完成标准

1. 服务端为实体规范化与质量分级提供唯一实现；Context Graph、context delta、TranslationBrief 和旧端点使用相同策略。
2. 文风基准能自动同步到当前源版本并进入翻译上下文，长度与 fingerprint 一致，系统自动应用不冒充用户确认。
3. 实体表主要保留真正需要跨章节统一的专名/术语；通用词、标准地名、合并清单和低质量混合脚本目标不会成为强映射。
4. 机器生成的错误历史映射自动降级并可回滚，已确认的用户选择与已接受译文不被静默覆盖。
5. 两个仓库的相关单测、Local Agent Service 测试/typecheck/route manifest/book-scan 基准和扩展 Vitest/生产 build 按可运行范围实际执行；报告所有通过与失败，不将未执行检查写成通过。

**关键取舍：** 不要为追求实体表“整洁”而把所有疑似项交给用户逐条确认；也不要为追求自动化而把所有有引文的字符串都变成强规范。正确路径是服务端自动过滤低价值项、自动修复结构格式错误、自动提升真正经过独立验证的映射，对无法确定的机器候选降级并继续翻译。


## 11. 实施记录与验证结果（2026-10-26）

### 11.1 已实施

**服务端唯一策略。** 新增 `local-agent-service/src/documents/canonicalEntityPolicy.ts`，由 Context Graph、动态 `context_delta`、TranslationBrief 映射筛选、Reviewer 专名保护和旧文学分析端点复用。它负责 kind 归一、低价值实体过滤、复合名称识别/拆分、目标译名形态校验和目标冲突判断。

**文风版本与长度。** 五个核心文风字段在 `voiceContext.ts` 与扩展 `literary.ts` 中的上限对齐到 1000 字；rules/avoid 的字段数量与单项长度也对齐。缺失字段不再序列化为空字符串。Context Graph 状态返回 source revision、分析版本、文风完整度、缺失字段和更新时间；`projectStore.ts` 的文学 Run fingerprint 纳入全部五维、rules、avoid 及分析身份信息。

**文风自动应用。** 当前版本的全书文风完整时，服务端直接在 TranslationBrief 中将其作为机器基准注入初译和 Reviewer，不再要求用户先“载入”再“确认”。扩展自动补齐编辑面板中缺失的字段，记录机器来源版本和 source revision；用户编辑或明确确认的文风不会被静默覆盖，并提供停用/恢复机器基准的入口。机器自动应用不会显示为“用户已确认”。

**实体降噪与清单修复。** Context Graph 现在只保留符合专名价值策略的实体候选，普通国家名、普通称谓、单次词汇和常见概念不再默认进入长期规范表。一条实体只允许一个源名和一个目标；成对清单只有在源/目标数相符且每个源项都有独立原文证据时才拆分。无法配对的组合被拒绝，不阻断该批译文。模型给同一来源提出互相冲突的规范目标时，不再按输出顺序随机择一；机器候选映射被置为不可用并记录诊断。真实名称如 `AC/DC`、`OS/2` 不因斜杠被机械拆分。

**目标译名质量。** 中文目标会拒绝目标侧多译名斜杠串、解释性括注、源名称原样残留和异常混合脚本姓名（如 `achi子`）。不合格目标不能生成强制 masking/restore 映射。扩展的实体表默认折叠由服务端标注的低价值、复合名称和目标格式异常历史记录，仍保留记录，并允许用户展开检查或编辑；未执行破坏性批量删除或直接改写已接受译文。

**证据与权威来源。** 源文 quote 验证通过不再等价于目标译名已经正确或用户已经确认。Project/Run 映射只把明确 `user-confirmed` 作为用户权威；机器候选需要符合目标质量和实体价值策略，动态译名仍通过独立已接受译文佐证升级。扩展旧文学分析路径也应用相同的实体目标筛选，不再单凭 segment/quote 就自动确认目标译名。机器运行级候选不会伪装成永久确认。

### 11.2 关键文件

- 服务端策略：`local-agent-service/src/documents/canonicalEntityPolicy.ts`
- Context Graph：`local-agent-service/src/documents/contextGraph.ts`、`contextGraphWorkflow.ts`
- TranslationBrief 与目标记忆：`translationBrief.ts`、`translationContextDelta.ts`、`translationAgent.ts`、`voiceContext.ts`
- 文风 fingerprint：`local-agent-service/src/documents/projectStore.ts`
- 旧文学分析 endpoint：`local-agent-service/src/literary.ts`
- 扩展记忆模型：`src/entrypoints/utils/document/literary.ts`
- 扩展文风同步和实体 UI：`src/entrypoints/document/useLiteraryMemoryEditor.ts`、`useContextGraph.ts`、`App.vue`
- 回归测试：`local-agent-service/tests/canonical-entity-policy.test.mjs`、`translation-context-delta.test.mjs`、`context-graph-workflow.test.mjs`、`document-agent-prompt.test.mjs`、`translation-brief.test.mjs`，以及扩展 `src/__tests__/literaryMemory.test.ts`、`document.test.ts`。

### 11.3 验证结果

- **Local Agent Service 专用工作流通过**：[run 40303845779](https://github.com/saga/vocal-saga/actions/runs/40303845779)。249 项服务端测试、TypeScript 类型检查、API route manifest drift 检查与 deterministic book-scan benchmark 均成功。
- **扩展 CI 通过**：[run 40302936718](https://github.com/saga/fanyi-extension/actions/runs/40302936718)。另外，新增长文风字段与 provenance 测试所在的 [run 40302255307](https://github.com/saga/fanyi-extension/actions/runs/40302255307) 也通过。
- **vocal-saga 仓库通用 CI 仍未通过**：[最新对应 run 40303845800](https://github.com/saga/vocal-saga/actions/runs/40303845800)。失败来自既有的网页翻译测试：页面缓存测试仍断言 `page-v3`（实现已是 `page-v4`）、URL 路由对 `auto` target 的默认值断言、旧 `/api/translate/url` 路由测试，以及翻译历史语言字段断言。这些文件/路径不属于本次文学文档翻译修改范围；没有把通用 CI 描述为通过。
- 本次没有连接用户本机的 Shogun SQLite 数据库，所以没有对现存实体表执行迁移，也没有批量改写用户已经接受的译文。当前实现会在新 Context Graph 重分析时重新构建机器候选，运行时过滤不合格的旧映射，并在扩展 UI 中折叠低价值/异常记录。执行任何存量迁移前，仍需对目标项目做只读 dry-run 核对实际数据。

### 11.4 保留的边界

- 目标形态检查是确定性防线，不是语义翻译正确性的证明。对于未被用户确认的个人名，目标译名仍需要独立接受译文佐证才适合形成跨 Run 强规范。
- `bookSpecificMeaning` 只允许跨章节重复且有具体意义说明的特殊概念作为例外；它不能让一次性普通词汇、标准国名或普通宗教通名绕过筛选。
- 所有元数据候选的过滤和自动修复都不能使正文译文丢失或阻断整本翻译。强规范冲突保留诊断，已接受译文与明确用户确认始终优先。
