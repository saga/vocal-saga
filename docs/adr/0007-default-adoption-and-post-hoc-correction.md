# ADR-0007：文学记忆默认采纳与事后修正

- 状态：Accepted
- 日期：2026-10-31
- 适用范围：Context Graph、LiteraryMemory、TranslationBrief、中文文学编辑档案、人物/关系/声音记忆及 Extension 编辑器
- 取代：ADR-0006 中的证据门槛激活策略；修订 ADR-0004 中的人工确认策略
- 核心目标：Human 只负责启动和事后调整，不负责逐项批准模型分析结果。

## 背景

过去的实现把“模型结果没有经过人工确认”误当成“系统不应该使用该结果”。这导致人物关系、人物声音、声音锚点和中文文学编辑档案即使已经生成，也可能停留在 candidate，或在 TranslationBrief 中被过滤，要求用户逐项点击确认。

这把用户变成了流水线调度员，也让全书分析的价值无法进入翻译。模型分析不可避免存在不确定性，但不确定性本身不是暂停任务或等待人工点击的理由。

## 决策

1. **默认采纳。** 模型生成的有效结构化结果默认进入工作状态，并参与后续翻译、上下文构建和自动审校。未明确拒绝的结果不等待用户确认。
2. **采纳不等于事实证明。** 默认采纳表示“系统采用当前最佳判断作为工作默认值”，不表示用户审核过，也不表示模型已经证明其绝对正确。默认结果可以是软提示，也可以按具体数据类型参与译名/关系消歧；不得把来源不明的推断伪装成不可覆盖的硬约束。
3. **状态、来源和证据质量分离。**
   - Adoption：accepted、user-modified、rejected。
   - Provenance：model-default、user-modified、evidence-verified、user-confirmed、legacy-unknown。
   - Evidence：verified、partial、unverified、stale。
   - 为兼容旧数据，运行态 confirmed 可以表示已采纳；不得据此推断 confirmationSource=user-confirmed。
4. **证据不是审批门槛。** 原文引文、segment ID、证据覆盖和模型置信度用于追溯、诊断和质量评估，不用于要求用户确认。证据不完整时仍默认采纳；能验证多少就记录多少，不得伪造验证结果。
5. **显式用户决定优先。** 用户修改后以 user-modified 保存并覆盖模型默认值；用户明确拒绝后进入 rejected，后续自动分析不得静默重新激活同一条被拒绝内容。用户可在编辑器中直接修改，不需要先点击“确认”。
6. **自动更新。** 中文文学编辑档案和机器生成的文风/人物画像在新样本到来后自动更新并启用，不再生成需要人工接受的 pending update。已有旧版 pending update 在读取/迁移时自动提升为当前版本。用户修改过的档案优先于机器更新。
7. **不确定性不阻断。** 关系方向、称谓、说话人、人物动机或剧情解释即使存在不确定性，也采用模型当前最佳判断并保留依据；不新增审批页、确认按钮或等待状态。原文出现明确反证时，以当前原文为准，后续分析可更新默认判断。
8. **保留真正的数据边界。** 默认采纳不取消以下保护：
   - 未来章节信息不得泄漏到较早章节；
   - 原文版本变化后，旧版本引文/锚点不得冒充当前证据；
   - 声音锚点必须仍有当前来源片段和可用译文，否则自动失效；
   - 用户明确拒绝和用户修改不得被机器覆盖；
   - 结构损坏、必需输入缺失、任务不可执行等技术异常仍可暂停。
9. **时间边界与人工审批严格区分。** 不允许未来章节揭示的身份、关系或剧情反转提前进入早期 TranslationBrief，这是知识边界，不是要求用户确认。对于人物译名，只有在较早译文已经建立该目标，或当前可见上下文足以确定时才可作为稳定 canonical mapping；否则仍可把模型当前判断作为普通翻译建议，而不能把未来揭示变成早期强约束。
10. **服务端负责状态合并。** Local Agent 是持久化与 TranslationBrief 的权威；Extension 只负责展示、编辑和拒绝。服务端必须在 sanitize、merge、save、read 和 Run snapshot 中保留 provenance、用户覆盖和拒绝状态。
11. **删除使用持久化 tombstone。** 用户删除实体或关系时，除删除可见投影外，还必须写入隐藏的 `rejectedItems` tombstone；Context Graph、LiteraryMemory、TranslationBrief、跨批次 context delta merge 均以 tombstone 为否决依据。模型后续再次提出同一名称/别名或同一关系三元组时不得重新激活。只有用户明确编辑/重新建立该项，才可清除对应 tombstone。
12. **Run 快照与最终化必须串行。** Run 创建时在 SQLite 写锁内重新校验原文、Prompt 和 LiteraryMemory revision；Run 保持 running 直到 context delta 与 LiteraryMemory 合并事务提交，再进入 awaiting_acceptance 并自动采纳。awaiting_acceptance 阶段阻止新 Run。服务重启时自动恢复这一最终化，不要求用户点击 accept。
13. **旧候选不得覆盖新结果。** 采纳候选时必须校验 Run 的 source revision 仍是当前版本；对同一 segment/source hash，任何比候选更新的 accepted result（不只 manual）都优先。

## 后果

- 人物、关系、称谓、声音、锚点和中文文学编辑档案不再要求逐项人工确认。
- 证据不足不会阻断翻译，也不会因为缺少固定数量的证据而停留在候选审批队列。
- 机器结果以 model-default 标记；用户编辑与用户拒绝有更高优先级。
- TranslationBrief 仍按当前章节可见范围过滤信息，避免未来剧情泄漏。
- UI 从“确认并应用”转为直接编辑、停用或拒绝；不需要人工审批队列。
- 质量审计应统计机器默认采纳、用户修改、用户拒绝和证据失效，而不是统计用户确认点击数。

## 验收标准

- 没有用户拒绝的模型关系、人物声音、声音锚点和中文文学编辑档案默认参与后续工作。
- 只有模型来源的结果必须标记 model-default，不得标成 user-confirmed。
- 证据为空、部分有效或低于旧门槛时，不触发人工确认，也不阻断翻译。
- 用户修改后 provenance 为 user-modified，机器重新分析不得覆盖该修改。
- 用户拒绝后该项不再自动激活。
- 删除后 tombstone 在 Extension sanitize/merge、服务端 sanitize、context delta merge 和 TranslationBrief 生成中持续生效；重新分析不能复活。
- Run 创建快照与原文/Prompt/记忆 revision 一致；运行结束前完成记忆合并，重启后自动完成 pending acceptance。
- 较旧 Run 的候选不能覆盖更新的 accepted Agent/imported/manual 译文；旧原文 revision 的候选拒绝采纳。
- 旧版中文文学编辑档案 pending update 自动升级为当前生效版本。
- 原文版本变化会使过期引文和声音锚点失效，但不会把普通证据不足重新变成审批任务。
- 未来章节身份、别名、剧情事实不会进入早期 TranslationBrief。
- 服务端和 Extension 的测试覆盖默认采纳、用户修改、用户拒绝、旧数据迁移、自动更新、来源版本变化和时间边界。
