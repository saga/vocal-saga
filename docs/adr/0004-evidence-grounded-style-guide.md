# ADR-0004：全书文风基准与中文文学编辑档案自动应用

- 状态：Accepted（由 ADR-0007 修订）
- 日期：2026-10-20，2026-10-31 修订
- 相关组件：Context Graph、LiteraryMemory、TranslationBrief、中文文学编辑档案与 Extension 编辑器
- 关联决策：[ADR-0007：文学记忆默认采纳与事后修正](0007-default-adoption-and-post-hoc-correction.md)

## 背景

全书文风和中文文学编辑档案会持续影响后续章节翻译。旧实现把档案是否可用绑定到用户确认状态，导致模型分析已经完成，却因为用户没有点击确认而不能进入 TranslationBrief。新样本产生的 profile update 也需要用户再次接受。

## 决策

1. Context Graph 文风继续使用显式、版本化的分维度契约：叙述声音、语域、节奏与句法、对白特征、措辞与词汇、规则建议、避免项。
2. 观察性描述和规范性建议分开保存。证据引用用于追溯，不作为人工审批门槛；字段不完整时保留已有观察，不要求用户补齐表单。
3. **机器生成的 style guide 默认应用。** 来源明确为 Context Graph 的 style-only 数据，在 styleGuideAutoDisabled !== true 时自动进入 TranslationBrief。没有明确来源范围的任意自由文本不得被误当成 style-only 内容注入，以避免剧情事实泄漏。
4. **中文 Literary Editorial Profile 默认应用。** 档案从已采纳译文中归纳，生成后立即启用；后续新样本产生的版本自动替换机器默认版本，不再创建等待人工接受的 pending update。
5. 用户可直接编辑档案，编辑后 provenance 为 user-modified；用户修改优先于后续机器生成。用户也可以明确停用或拒绝档案。
6. 机器默认应用标记为 model-default；不得显示为 user-confirmed。旧版 pending update 在迁移时自动提升为当前版本。
7. style guide 与中文编辑档案只提供语言表达和风格参考，不应携带或泄漏未来章节剧情事实。TranslationBrief 仍执行章节时间边界。
8. 提升分析 Schema、提示词或持久化语义时必须更新对应分析/策略版本；旧结果按兼容策略读取，旧 pending update 自动采纳，不要求用户再次点击。

## 后果

- 用户不需要确认全书文风或中文编辑档案。
- 新的中文编辑档案版本自动应用；用户可在编辑器中直接修改。
- 证据不足只影响追溯信息，不阻断档案应用。
- 用户修改和停用优先于模型自动更新。
- 自由文本来源不明时不会自动作为风格提示注入，避免把剧情事实误当风格规则。

## 验收标准

- Context Graph style guide 在未停用时自动进入 TranslationBrief。
- 中文文学编辑档案生成后自动启用，新版本自动替换机器默认旧版本。
- Extension 可直接编辑档案并持久化 user-modified。
- 用户拒绝/停用不会被机器更新覆盖。
- 未来章节的剧情内容不会通过 style guide 或 profile 泄漏到早期章节。
