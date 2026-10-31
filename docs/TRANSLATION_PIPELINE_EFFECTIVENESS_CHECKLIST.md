# Local Agent Service 翻译 Pipeline 有效性审查 Checklist

- 状态：待执行（这是审查计划，不代表下列项目已经通过）
- 范围：`local-agent-service` 的文档/EPUB/PDF/小说翻译及其上下文、审校、持久化、恢复和质量审计链路
- 目标：查找“代码或 Prompt 看起来已经实现，实际运行中却没有生效”的问题；优先验证端到端行为，不以函数存在、提示词存在或单元测试数量作为完成依据。
- 工作原则：先审计、记录证据与风险，再决定修复；本 Checklist 本身不授权同时改造其他 Pipeline。
- 相关设计文档：[统一翻译 Pipeline](TRANSLATION_PIPELINE.md)、[结构化文档翻译接口](STRUCTURED_DOCUMENT_TRANSLATION.md)。
- 相关实现：`local-agent-service/src/documents/`；主要测试位于 `local-agent-service/tests/`。

## 如何判定一项检查通过

每项必须沿着“来源/配置 → 实际调用路径 → 运行时上下文 → 模型输出 → 服务端校验/后处理 → 持久化 → 下游读取/UI 显示”追踪。至少记录：

- **调用点证据**：哪个入口、函数和配置实际触发此逻辑；分支、默认值或旧路径是否会绕开它。
- **运行时证据**：轨迹/事件能否证明这次运行真正用了对应版本、上下文、规则或校正器。
- **行为测试**：有效输入应产生预期结果；无效、冲突、缺失、过期和边界输入不能错误通过。
- **持久化/恢复测试**：结果写入后重新加载、重启、重试或走另一个入口，行为仍一致。
- **结论**：通过 / 失败 / 有条件通过 / 未验证，并附代码位置、测试名或运行事件；“Prompt 写了要求”本身不是通过证据。

## P0：统一入口与真实执行路径

- [ ] 阅读页、Agent Workspace、CLI、Project API 的初译都调用同一个项目级 Run 执行器；不存在绕过它的第二套翻译循环。
- [ ] “当前页 / 下一页 / 下一 N 页 / 章节 / 显式片段 / 全书 / 待更新片段 / 强制重译”等 scope 转换成预期的 source segment IDs；空当前页、重复请求和边界页均有测试。
- [ ] 所有入口都真正经过 `startProjectTranslationRun → executeRun → processBatch`（以当前代码实际函数名为准）；没有某入口跳过 TranslationBrief、统一 Prompt、术语保护或保存校验。
- [ ] 文学模式、普通文档模式、审校开关和各类 Prompt 配置都选择了正确 Pipeline 分支；默认值、缺省配置和历史项目升级没有静默走旧策略。
- [ ] 停止、取消、暂停、失败恢复和重新运行在模型调用前后都有状态检查；迟到的模型响应不能覆盖取消状态、人工修改或更晚的结果。
- [ ] 部分成功语义一致：一个批次失败不能抹掉其他成功片段；Run 的 completed / partial / failed 与真实片段状态一致。

## P0：原文解析、分段和预处理

主要检查：`ingest.ts`、`bookScan.ts`、`contextGraph.ts`。

- [ ] TXT / Markdown / HTML / EPUB / PDF 的解析结果、章节边界、标题、对话、列表、页码和结构元数据真实进入 Run；解析完成不等于正文已正确抽取。
- [ ] 来源版本、稳定 segment ID、ordinal、source hash 和 contextPath 在首次导入、恢复、重新导入及文件变化后保持一致；不把旧版本的证据或译文匹配到新版本。
- [ ] 全书预处理确实完成了计划中的样本选择、分析、证据验证和持久化；队列/运行状态不能只显示完成而实际保存零项或只保存部分项。
- [ ] 文学模式的正常扩展路径先读取轻量 Context Graph readiness DTO；状态未知、请求失败、source revision / analysis version / 语言方向不匹配时，不创建开始/重译/重试/恢复 Run。
- [ ] 首次未分析的当前 source revision 会自动触发一次预处理；failed / stale / language mismatch 不会被轮询无限重试，显式重新分析可创建新的可追踪 run。
- [ ] readiness 不只看 status=completed：验证策略 A/B、sampleCount > 0、styleGuideReady、五项必需文风字段和至少一条 style rule；B 策略还必须具备 style / characters / entities / relationships / chapters 五个完成检查点。
- [ ] 直接 API/旧客户端先创建 queued Run 时，服务端 executeRun 在进入 running、读取待译片段、调用翻译模型和写入候选前再次校验；预处理未 ready 时不得产生任何翻译模型调用。
- [ ] 预处理失败不会退化为旧的逐章文学分析后继续翻译；技术文档模式不受文学 Context Graph readiness 门禁影响。

- [ ] 分析模型的每个实体、人物、别名、关系、章节摘要都校验了证据确实出自允许的原文片段；无效、越界、空证据、错 ID、截断引文有明确拒绝计数或事件。
- [ ] 源语言与目标语言来自当前项目/Prompt 配置；更改语言后会重做或使旧分析失效，不能把中文旧译名错误复用于其他目标语言。
- [ ] 规范名称映射的状态含义明确：有证据的自动规范译名、人工修改、候选、拒绝不能在扩展与服务端合并时被互相降级、升级或覆盖。
- [ ] 别名在当前批首次出现时，映射不会因为“尚未在更早片段出现”而被错误过滤；但仅在未来章节出现的身份信息仍不能泄漏到前文。
- [ ] 同一名称存在多个译名、一个别名链接多个实体、长名称与短别名重叠、普通词与专名冲突时，有确定性冲突策略；不能依据数组顺序任意选择。
- [ ] 预处理结果进入阅读器记忆与 SQLite 时没有因异步时序、旧快照覆盖新快照、合并条件或序列化而丢失。

## P0：TranslationBrief 与上下文边界

主要检查：`translationBrief.ts`、`voiceContext.ts`、`contextGraph.ts`。

- [ ] 每个真实初译批次都构建并使用当前 Run 的 TranslationBrief；并确认缺失 brief、加载失败和旧数据兼容路径不会静默绕过核心规则。
- [ ] 初译、术语/准确性 Reviewer、人物声音 Reviewer、局部重试和质量修复使用同一来源版本、Prompt revision、记忆 revision、目标语言和对应的规范术语策略。
- [ ] Brief 中的 glossary、Context Graph、voiceContext 和 precedingSegments 是实际发给模型的内容，不只是诊断摘要里的计数；检查实际序列化 payload 与最终 runner 参数。
- [ ] Brief 的 hash 与 fingerprint 覆盖所有影响输出的内容和策略版本；字段改变但 hash 不变、hash 改变却未导致旧候选失效等情况都有回归测试。
- [ ] 上下文长度预算在序列化前按结构裁剪；不会生成无效 JSON、截断半个实体，也不会因加上必需规则后实际超预算。
- [ ] 知识边界遵守原文 ordinal：未来章节支持的实体、身份揭示、关系、声音锚点、例句和摘要不能进入更早批次；有显式的前后章节反例测试。
- [ ] 前文只用于消歧，不会被加入可翻译 IDs 或要求模型重复输出；当前片段、前文和整章摘要的范围明确。
- [ ] Context Graph 及动态记忆的筛选依据当前片段中的真实名称/别名，不采用任意子串匹配；短姓名、单字母别名、大小写、所有格、标点与 Unicode 均有边界测试。
- [ ] 候选、自动激活映射、已确认映射、拒绝项及旧版 memory 字段在每个消费者中含义一致；不存在某个 Prompt 把候选当事实、另一个 Prompt 却漏掉已生效规则的情况。

## P0：Prompt 与模型 Runtime

主要检查：`translationAgent.ts`、`literary.ts`、`agents/runner.ts` 及配置入口。

- [ ] 文学初译、普通翻译、两类 Reviewer、缺失片段重试和修复流程使用了各自预期的 Prompt；没有因角色/模式分支或默认参数漏掉 mandatory contract。
- [ ] 自定义 system/user Prompt 无法覆盖主机侧不可协商的结构契约、安全边界、术语保护或 ID 完整性；确认 systemPrompt 拼接顺序、模板替换和空模板分支的真实效果。
- [ ] `{{CONTENT}}` / `{{CONTENT_JSON}}`、用户自定义模板、空模板和格式错误模板都能得到完整 payload；不会把实际内容替换成预览文本、重复拼接或完全遗漏上下文。
- [ ] 每次调用将预期 system/user Prompt 与模型、Provider、Run ID、batch ID 和 session scope 绑定；SDK / CLI 的隐式会话历史不会注入旧原文、旧译名或其他批次内容。
- [ ] Provider fallback、模型重试和超时恢复不会切换到绕过统一 Prompt / 输出校验的旧执行路径；fallback 后仍使用同一批源 IDs 和同一规范映射版本。
- [ ] 结构化输出 schema 在运行时真实传入 Provider；另外核实本地 JSON 解析与 schema 校验，不能只依赖 Provider 的 JSON mode。
- [ ] Prompt 版本、策略版本和实际运行版本可观测，日志不记录不必要的完整原文、译文或密钥。

## P0：模型输出、规范化与候选保存

主要检查：`translationAgent.ts`、`projectStore.ts`。

- [ ] 输出按输入 segment ID 精确匹配；重复 ID、未知 ID、缺失 ID、空译文、错误类型、超长字段与额外文本都有确定处理。
- [ ] 解析失败、部分返回和重试只重试允许的片段；最终 Run 状态和 missing IDs 真实反映尚未成功的片段，不把部分输出误报为完整成功。
- [ ] 所有确定性校正都发生在最终候选保存前，而不只是写在 Prompt 中；验证初译、Reviewer 替换候选、批量修复与恢复导入不会绕过校正器。
- [ ] 规范名称、数字、占位符、代码片段、结构标签、链接和其他要求保留的 token 有独立校验；模型删掉或改写保护 token 时，不能静默保存损坏输出。
- [ ] 标记保护有来源边界：只保护当前原文中确实出现的、唯一且无冲突的映射；不能把短别名误命中更长实体名、普通词、其他名称或无关语境。
- [ ] 规范译名恢复是可重复、无二次替换副作用的；多映射、相互包含译名、译名本身包含其他术语、标记重排/重复/缺失都有测试。
- [ ] 无法自动安全纠正时必须报告冲突或失败，而不是猜一个目标；事件可指出受影响的 segment IDs 和失败原因。
- [ ] `saveCandidate`、接受译文、手工修改、自动同步及批次结束事件之间的一致性已验证；后台校正结果确实是 UI 最后读取和展示的结果。

## P0：审校 Pipeline 与修复链路

主要检查：`translationAgent.ts`、`literary.ts`、`qualityAudit.ts)。

- [ ] 术语/准确性 Reviewer 和人物声音 Reviewer 都实际调用；开关关闭时行为有清晰定义，不会 UI 显示已审校但服务端未执行。
- [ ] Reviewer 收到本批原文、初译、同版本 TranslationBrief、规范译名映射及有限前文；没有只在初译阶段注入术语，而 Reviewer 阶段漏掉。
- [ ] Reviewer 的输出 ID、finding 类别、严重度、证据引用和修订译文均做独立验证；发现了问题不代表有效修订已产生或已保存。
- [ ] 只有满足策略的 must-fix finding 才会产生修订候选；建议、风格偏好或非必要改写不会无条件覆盖初译/人工修改。
- [ ] Reviewer 返回完整替换译文时仍执行规范名称保护和结构校验；Reviewer 不能把规范化后的名称重新改写为另一种译法。
- [ ] 局部修复只重做对应片段，保留未涉及片段和人工修订；修复后重新跑必要的术语、结构与一致性验证。
- [ ] 角色画像、关系语言规则、声音锚点和对白样例确实影响相关片段；只把相关且通过状态/证据校验的记忆注入，不能因相同人物名就注入不适用场景的声音规则。
- [ ] 声音建议、审校 findings、译文候选和最终采纳状态分开存储；UI 标签不应把“生成 finding”展示成“已完成修订”。

## P1：动态记忆、别名与跨批一致性

主要检查：`translationContextDelta.ts`、`translationBrief.ts`、`voiceContext.ts`、`projectStore.ts`。

- [ ] context_delta 中人物/实体、别名、mention、关系、open question 和 conflict 分别校验；一个字段失败不会静默丢失其他合法字段或让整体失去诊断。
- [ ] 引文必须出自本次允许的源片段；target_surface 必须是对应实际译文中的连续字符串；证据有效但译文没有对应落点时不能入库为有效 mention。
- [ ] context_delta 只影响规则规定的后续 wave/batch，不能回头修改同一 wave 已冻结的 Brief；合并顺序以 source ordinal 为准，不以异步完成速度为准。
- [ ] 动态候选与全书候选冲突时，有来源顺序、状态、证据和人工修改优先级；同一实体不会因不同 batch 的模型输出在记忆表中不断换名。
- [ ] aliases 合并不会错误合并不同实体，也不会留下同一实体多个互相冲突的规范译名；名称规范化对空白、标点、撇号、连字符、大小写和中文字符的处理明确。
- [ ] 自动生效的只是满足规定证据门槛且不冲突的规范名称；“有一段引文”不能自动升级人物关系、隐含身份、剧情推断或角色声音为事实。
- [ ] 拒绝或删除一个映射后，它不会从旧 memory revision、缓存 Brief、Reader IndexedDB、UI 快照或旧 session 中复活；新 revision 已传播到所有下游消费者。

## P0：SQLite 持久化、缓存与恢复一致性

主要检查：`projectStore.ts` 与所有调用保存/读取方法的入口。

- [ ] source revision、Prompt revision、memory revision、Context Graph、策略/Prompt policy version、scope 与翻译策略进入正确的 run fingerprint；所有会影响结果的输入变化都会使旧非手工译文过期。
- [ ] 版本升级后，老项目、老 memory JSON、旧 Brief snapshot 和旧 run 有明确兼容/迁移/失效策略；不能因为字段仍可解析就继续复用错误结果。
- [ ] 旧译文失效只作用于规定的来源/非手工候选；已采纳人工修改不被自动覆盖。人工修改与模型候选同一时间到达时有确定优先级。
- [ ] 服务重启后，从 SQLite 恢复的状态与重启前的最新持久化状态一致；不依赖 SDK session、进程内 Map 或 UI 内存维持必要记忆。
- [ ] Reader、Agent Workspace、CLI 和 API 从相同项目状态读取；IndexedDB / SQLite 同步不会让旧副本覆盖新 revision 或把已经过期译文重新标成有效。
- [ ] 失败发生在译文保存、上下文增量保存、事件写入或审校保存时，事务边界和部分成功语义符合设计；辅助记忆保存失败不会谎报整批成功，也不会无故丢弃有效译文。
- [ ] 取消与并发场景中，迟到 worker、重试 worker 和审校候选不能提交过期写入；Run 恢复不会重复计数、跳过失败片段或重复套用后处理。

## P1：质量审计、质量基线与报告有效性

主要检查：`qualityAudit.ts`、`bookScan.ts` 与质量 fixtures。

- [ ] 全书质量审计实际读取当前 source revision、当前译文版本和当前规范译名，不混合不同 Run、旧人工修改或旧 source hash。
- [ ] 术语不一致、漏译/空译、重复表达、原文覆盖、格式损坏及候选译名冲突有可复现的规则、定位和负例；不能把单纯字符串差异误判为质量问题。
- [ ] 审计只发现问题时不会宣称已修复；自动修复会创建受控的新 Run/候选，并经过结构、术语和必要审校，结果能被追踪。
- [ ] 质量评估的 before/after 使用可比范围、稳定样本与相同评估规则；指标提升不以少翻译、删除内容或绕过审校换取。
- [ ] 黄金样本既有 failure-control，也有正确结果和边界反例；至少覆盖本次暴露的“the King / King / 大王 / 国王”类型的跨段、跨批一致性问题。
- [ ] 报告给出的计数、严重度、被修复数与持久化状态相符；无数据、部分数据、解析失败与评估失败不能显示成质量达标。

## P1：日志、轨迹、API 与失败可诊断性

- [ ] 关键阶段都有持久化事件：preprocessing、brief ready、prompt ready、model request/response、结构验证、规范化校正、review、candidate save、memory merge、audit 与 Run finalization。
- [ ] 事件能说明实际采用哪个 Pipeline/policy version、Brief hash、规范映射数量、冲突数、token 保护/恢复结果、失败 segment IDs 和重试原因；不需要依赖读完整原文/译文才能知道规则是否生效。
- [ ] UI 显示的进度、预处理状态、规范译名数量、审校数量和 Run 结果与服务器持久化事件及 SQLite 查询一致；不能用“模型调用成功”代替“翻译已正确保存”。
- [ ] 错误类别可区分输入验证、来源/证据失败、模型失败、输出格式失败、术语保护失败、持久化失败、取消和过期 Run；失败不会只写到 console 后丢失。
- [ ] API 与 CLI 的验证、权限、错误语义及运行状态一致；没有未验证的替代入口、无保护的手工修改端点或绕过当前 source revision 的 API 调用。

## 回归测试最低要求

- [ ] **同一实体跨段**：同一来源名称出现多次，所有输出必须用唯一规范译名。
- [ ] **别名**：完整名称、短名称、大小写/标点变体均统一；别名首次出现于当前批也必须生效。
- [ ] **防误匹配**：短名不能匹配更长的其他实体名、普通词或仅部分字符串；长短名称有包含关系时按明确实体边界决定。
- [ ] **目标冲突**：一个 source/alias 对应两个不同 target 时安全排除/报告冲突，不按无稳定性的迭代顺序选值。
- [ ] **候选优先级**：已确认或人工修改不能被自动候选覆盖；有证据的自动规范映射能够纠正未确认的早期候选。
- [ ] **强制执行而不是 Prompt 暗示**：伪造模型输出故意删改必需 token、输出竞争译名或忽略规则，服务端仍能阻止不一致结果入库。
- [ ] **Reviewer 回归**：Reviewer 试图改写规范称谓、遗漏 ID、返回无效 finding 或只修一部分，结果仍满足统一契约。
- [ ] **历史译文失效**：更改实体映射或 Pipeline policy 后，旧非手工译文失效并可批量重译；人工修订按规则保留。
- [ ] **持久化/重启**：自动映射、译文候选、记忆 revision 和校正后的译文写入后，刷新 UI、重启服务、走 CLI/API 后保持一致。
- [ ] **部分失败与取消**：一部分成功、一部分失败、token 丢失、取消时模型仍在执行等情况下，不报假成功、不丢失已保存结果、不让迟到写入覆盖新结果。
- [ ] **模式与入口矩阵**：文学/非文学、不同 Reviewer 开关、Prompt 模板、Provider fallback、阅读页/Workspace/CLI/API 都至少有代表性集成测试。
- [ ] **质量基线**：新增规则对已知正确样本不造成回归；质量报告与确定性检查能暴露故意构造的失败样本。

## 执行记录

审查时为每一项附上结果和证据；不允许仅把勾选框全部打勾作为报告。

| 字段 | 记录 |
|---|---|
| 检查日期 / Commit | 待填写 |
| 检查人 / 执行者 | 待填写 |
| 测试命令与结果 | 待填写 |
| 发现的问题 | 待填写（关联文件、函数、测试或事件） |
| 修复 Commit | 待填写 |
| 复验结果 | 待填写 |

### 问题记录模板

对每个失败项使用以下结构记录：

- **ID / 优先级**：
- **表面上已经实现的行为**：
- **实际断点**：未调用 / 上下文未传入 / 状态被降级 / 输出未校验 / 后处理未执行 / 保存后被覆盖 / 缓存未失效 / UI 读错副本 / 测试没有覆盖（可多选）。
- **证据**：文件、函数、运行事件、输入/输出对照。
- **复现用例**：
- **预期行为与实际行为**：
- **修复范围**：
- **防回归测试**：
- **修复后复验**：


## 中文单语文学编辑专项检查

主要检查：`literary.ts`、`translationAgent.ts`、`projectStore.ts`、`voiceContext.ts`。

- [ ] 中文文学 Run 的 Style Review 输入只包含 segment ID、中文 draft、片段类型和目标语言上下文；模型请求 payload 中不存在 source、sourceExcerpt、英文名称/别名、源语言 glossary、Context Graph 原文证据或 preceding source segments。
- [ ] `target-only` voice projection 只保留已确认中文 styleGuide、中文人物名、中文人物声音描述、已批准中文对白锚点，以及 TranslationBrief 已按当前来源版本和 ordinal 筛选出的 accepted Chinese examples。
- [ ] 中文编辑 finding 的 `targetExcerpt` 必须逐字连续存在于当前中文 draft；不能以模型自报理由代替证据。原稿不变时不得产生无意义的风格候选。
- [ ] 编辑输出必须返回完整 segment ID 集合和完整段落；未知/重复/缺失 ID、空文本、超长文本、保护 token 丢失或结构错误均不能覆盖初译。
- [ ] 中文编辑阶段失败时保留初译并继续执行双语 Reviewer；编辑成功后，Accuracy / Terminology Review 必须收到原文、初译对照和编辑候选。
- [ ] 双语 Reviewer 以 source 为忠实度依据，能够发现编辑造成的漏译、增译、否定/视角/指代/时间关系变化及术语漂移；初译只用于变化比较。
- [ ] 只有双语 Reviewer 已覆盖该 segment 且 Run 仍可写入时，中文编辑 finding 才能从 `bilingualReviewStatus=pending` 更新为 `verified` 或 `corrected`。
- [ ] `setReviewFindingDisposition(action=apply)` 必须拒绝尚未完成双语复核的中文单语编辑建议；dismiss 仍可用。
- [ ] 双语复核失败、超时、取消或漏段时，编辑候选保持 pending，不能误报为已验证或允许采纳。
- [ ] 非中文目标语言继续使用原 Style Review；普通网页翻译和技术文档翻译不触发中文文学编辑。
- [ ] A/B 评估分别覆盖中文单语盲评与双语忠实度复核；LLM Judge 不得单独决定文学创造性、作者声音或自动采纳。


## 作品级 Chinese Editorial Profile 专项检查

主要检查：`chineseEditorialProfile.ts`、`voiceContext.ts`、`translationBrief.ts`、`projectStore.ts`、`projectRoutes.ts`。

- [ ] 档案样本只从当前 source revision 的已采纳译文选取；未采纳候选、旧 source hash 和其他 revision 不进入样本。
- [ ] BookScan 可在本机读取原文用于抽样，但档案分析模型 Prompt 只包含中文已采纳译文和 segment ID；不得发送原文、源语言人名、source quote、glossary 或 Context Graph。
- [ ] 样本选择覆盖不同章节/位置；样本数量不足时记录 skipped 事件，不生成空洞档案。
- [ ] 每条档案观察必须引用对应 accepted translation 中真实存在的连续 targetExcerpt，且至少来自三个不同 segment。
- [ ] 候选档案以 LiteraryMemory revision 保存；candidate 不得进入 Translator、中文单语 Editor 或 Accuracy Reviewer 的上下文。
- [ ] 用户确认必须走明确 review API；确认时检查当前 source revision、accepted translation、source hash 和 target excerpt。无效证据不能维持 confirmed。
- [ ] confirmed 档案只注入目标语风格字段，不注入样本正文、剧情事实、原文、源语言名称或来源引文。
- [ ] source revision 改变后旧档案不得继续作为 confirmed Profile 注入；旧 Run 的 Brief 不被新 revision 改写。
- [x] 新增 accepted translations 触发档案刷新时，不覆盖用户已确认的档案；相同样本 fingerprint 不重复调用模型。新结果进入 pendingUpdate。
- [x] pendingUpdate 必须记录 basedOnFingerprint；基础档案版本变化后，拒绝基于旧 fingerprint 的更新候选。
- [x] accept-update 才递增 profileVersion 并切换运行档案；reject-update 清除候选且继续使用旧版本。
- [x] Extension sanitizer、memory merge 与 UI 必须保留待更新档案；待更新档案不能进入编辑 Prompt。
- [ ] 模型调用失败、JSON 不合规、证据不足或持久化失败均不影响已经采纳的译文。


## 中文文学编辑质量闭环专项检查

主要检查：`translationAgent.ts`、`qualityAudit.ts`、`projectStore.ts`。

- [ ] 每个中文单语编辑批次都记录 reviewed、edited、unchanged、uncovered 和 finding 数；事件必须与实际输入 segment IDs 对应。
- [ ] 全书审计能区分“编辑器检查过”“编辑器提出变化”“双语复核通过/修正”“用户采纳/拒绝”，不能将这些阶段合并成一个成功数。
- [ ] Edit rate 与 unchanged rate 以 reviewed segment 为分母；没有执行编辑的 Run 显示 null/0 状态，不显示成 100% unchanged。
- [ ] 双语复核 pending、verified、corrected 分开计数；缺失复核不得被当作 verified。
- [ ] 用户 applied、dismissed、pending 分开统计；acceptance rate 只在已决策 finding 中计算。
- [ ] 已采纳编辑建议随后被人工修改时记录为 manually overridden，不擅自将其等同于 over-edit 或翻译错误。
- [ ] Quality Audit 报告 profile 的状态、source revision、analysis version、sample fingerprint 和证据数。
- [ ] 审计选定 Run 与 source revision 固定；跨 Run 汇总不得把同一 segment 的重复尝试简单累加为独立样本。


## 当前统一规则：默认采纳、事后纠正（2026-10-31，优先于本文旧描述）

- 模型产生的当前最佳结果在通过来源/结构完整性校验后默认参与后续翻译；不得要求用户逐项确认人物、实体、关系、声音、文风或普通审校发现。
- `model-default` 是机器默认采纳，不是用户确认。用户修改、确认和拒绝必须分别记录；`user-modified` 与 `user-confirmed` 均优先于机器默认结果。
- 用户拒绝/删除必须持久化，重新分析、记忆刷新、TranslationBrief 合并不得自动恢复。不得仅删除 UI 或 LiteraryMemory 投影而让 Context Graph 原记录继续注入。
- 证据不完整只影响置信度、可用范围和约束强度，不得仅因文风字段、画像维度、关系证据覆盖不完整而阻断翻译。
- 保留原文版本、语言方向、来源绑定、未来章节隔离、译文写回位置和数据完整性等硬约束。只有缺少不可替代输入、数据损坏或执行无法继续等技术异常才暂停。
- 自动应用必须保留来源与版本记录，且不得覆盖用户修改；用户可以事后修改或拒绝。
- 任何旧段落中要求“候选必须人工确认”“证据完整后才能启用”“风格字段必须齐全”的规则均已被本节取代。
