# ADR-0006：基于可核验原文证据自动激活人物声音画像

- 状态：Accepted
- 日期：2026-10-31
- 适用范围：`local-agent-service` LiteraryMemory、人物声音画像与 TranslationBrief
- 关联决策：[ADR-0004：证据化全书文风基准](0004-evidence-grounded-style-guide.md)、[ADR-0005：文学翻译预处理门禁](0005-literary-preprocessing-before-translation.md)

## 背景

人物声音画像在翻译中很有价值，但逐个人物点击确认会把用户变成记忆管理人员。模型生成的画像又不能因为自报置信度高、字段完整或模型自行写入 `confirmed` 就直接成为强约束。需要一个服务端可重复执行、可审计、能在证据失效时自动降级的规则。

## 决策

1. **候选画像可以自动激活。** 对 `candidate` 人物声音画像，Local Agent 在保存 LiteraryMemory 时验证每条 evidence 的 segment ID 和连续原文引文是否属于当前 source revision。
2. **最低证据门槛。** 自动激活必须同时满足：
   - 至少 3 个不同 source segment 的引文通过服务端校验；
   - 证据覆盖至少 2 个不同声音维度；
   - 画像包含至少一个非空、可用于翻译的 voiceCore 观察；
   - 证据未被标记为截断；
   - 画像没有被用户拒绝。
3. **不使用模型自报置信度。** `confidence`、`confidenceSource=model_self_report` 及模型输出的状态声明不能替代以上证据门槛。
4. **来源明确区分。** 满足门槛的自动激活状态为 `confirmed`，来源标记为 `evidence-verified`；明确用户操作仍标记为 `user-confirmed`；历史无 provenance 的 confirmed 保留 `legacy-unknown`，不伪造历史。
5. **证据失效自动降级。** 当前原文版本变化、引用不再匹配、有效证据不足或画像变为截断时，机器激活的画像降为 `candidate`，不再作为强约束注入 TranslationBrief。
6. **不自动激活人物关系和对话规则。** 仅有 segment ID 列表不能证明关系方向、说话人归属或称谓语义。关系规则仍需更强的逐条原文引用或明确用户确认；本 ADR 不将它们一并升级。
7. **不自动批准声音锚点。** 声音锚点还必须同时绑定当前来源、已采纳译文和可信说话人归属；本 ADR 不改变既有锚点门槛。
8. **服务端是唯一验证边界。** Extension 可以展示证据和来源，但不得自行把候选写成 `evidence-verified`；所有自动激活与降级都在服务端完成。

## 后果

- 满足证据门槛的人物声音画像无需逐个点击确认即可进入后续翻译上下文。
- 证据稀疏、只覆盖单一维度、截断或原文引用失效的画像继续作为候选，不阻塞翻译 Run。
- 用户仍可编辑或拒绝画像；用户拒绝优先于自动证据激活。
- 人物关系、说话人归属和声音锚点不会因减少点击而放宽事实门槛。
- LiteraryMemory 保存事件会分别记录 evidence-verified 与 user-confirmed 人物数量，供审计和后续质量度量使用。

## 验收标准

- 三个不同 segment、至少两个维度、完整 voiceCore 且原文引文有效的候选画像自动变为 `confirmed/evidence-verified`。
- 证据只有两个 segment、只有一个维度、引用不匹配、画像截断或已拒绝时，不自动激活。
- 自动激活不依赖模型自报置信度。
- 原文版本变化后失效的机器证据会使画像降级；用户确认和历史来源状态按既有 provenance 规则处理。
- 关系规则和声音锚点仍执行各自的严格验证，不被人物画像自动激活连带放宽。
