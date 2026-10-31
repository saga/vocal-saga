# 翻译流水线默认采纳机制审查与修复报告（2026-10-31）

## 结论

本轮检查发现，代码已经部分采用“默认采纳、事后纠正”，但状态持久化、记忆合并、文档约束仍有冲突。尤其是用户拒绝可能在重新分析后复活、用户修改的译名可能没有进入 TranslationBrief，以及文风档案完整度可能成为运行门槛。这些问题会造成界面显示已修改、实际翻译却继续使用旧值的情况。

本轮已直接在两个仓库的 `main` 分支修复一批核心问题，并同步了部分界面语义。下文区分已提交修复与仍需验证/继续处理的事项，避免把未完成项描述为已完成。

## 发现与修复

### P1 — Context Graph 重新分析覆盖用户决定

**问题：** 重新分析清理节点/关系时，旧逻辑只看 `status='candidate'` 或 `adoptionSource='model-default'`。用户拒绝的记录仍可能保留 `model-default` 来源标记，因此可能被清理并在新一轮分析中重新创建。

**已修改：**
- 清理条件改为删除候选项，以及仍处于 confirmed 状态的 model-default 项。
- rejected 项不再因其历史 adoptionSource 为 model-default 而被删除。
- 用户 review 操作同步更新 adoptionSource：拒绝写入 `user-rejected`，确认写入 `user-confirmed`，避免状态与来源分离。

**待验证：** 节点、关系各自的“拒绝 → 重新分析 → 仍拒绝且不进入上下文”回归测试。

### P1 — 中文文学编辑档案拒绝后自动复活

**问题：** 用户拒绝档案后，下一次译文完成触发刷新时，原逻辑只保护 confirmed 档案，模型生成的新档案可能重新写成 confirmed。

**已修改：** 同一 source revision 下，只要当前档案为 rejected，自动刷新即记录 skipped 事件并退出；不会自动重新启用。用户主动修改/重新启用仍可通过正常记忆编辑流程完成。

**待验证：** rejected 档案在后续 run 和新译文保存后仍保持 rejected 的回归测试。

### P1 — 用户修改的实体译名未被 TranslationBrief 识别

**问题：** TranslationBrief 只把 `user-confirmed` 视为用户显式决定，漏掉 `user-modified`。已有 Context Graph 映射时，用户新译名可能被旧值覆盖。

**已修改：**
- `user-confirmed` 与 `user-modified` 均作为用户决定参与实体映射优先级。
- Extension 编辑实体别名时改用 `user-modified`，不再错误标记成 user-confirmed。

**待验证：** Context Graph 已有旧映射、用户修改实体目标译名后，构造 TranslationBrief 并确认最终映射是用户新值的集成测试。

### P1 — 不完整文风字段成为翻译门槛

**问题：** readiness 要求五个文风字段和至少一条 style rule 全部非空，模型少输出一个字段就可能阻止整本书翻译。

**已修改：**
- `styleGuideReady` 只检查 Context Graph 分析完成且版本匹配。
- 文风字段缺失仍保留在 `styleMissingFields` 和 coverage 诊断中，不再阻止翻译。
- 分析 schema 不再强制五项字段非空或至少一条规则。

**边界保留：** 原文版本、分析版本、语言方向、真实运行状态、必要来源数据和未来章节隔离仍是数据正确性约束，不能因自动化而放宽。

### P1 — Context Graph Prompt 仍要求候选审批语义

**已修改：** Prompt 改为输出当前最佳判断，区分原文事实、推断和不确定性；不把推断伪装成确定事实，也不因不确定而省略所有有用观察；明确未来章节信息不得泄漏到当前批次。

### P2 — Extension 显示过时的审批语义

**已修改：**
- 实体 `model-default` 来源显示为“自动采纳”。
- `user-modified` 显示为“用户已修改”。
- openQuestions 从“待确认”改为“待观察”。
- 人物特征提示改为自动采纳并说明不确定性。
- 声音锚点缺少归属证据时不再显示“只能保留为候选”，而是作为低置信度参考。
- 审校区文案调整为纯文风建议自动应用、用户事后可修改。

## 续做记录（2026-10-31）

### 已完成的代码修复

1. **Extension 删除操作同步拒绝 Context Graph：**
   - 删除人物时，先读取服务端 Context Graph，按规范名/显式别名定位对应节点，并将节点及其关联边通过现有 review API 持久化为 `rejected`。
   - 删除实体映射时，同样先持久拒绝匹配节点，再删除 LiteraryMemory 投影。
   - 删除人物关系时，按 subject、object 和 predicate 精确定位边；缺少端点或旧图谱关系无法唯一定位时不做宽泛拒绝，避免误伤其他人物的关系。
   - 图谱拒绝失败时不执行本地删除，并在界面显示原因。
   - 主要提交：`saga/fanyi-extension` `68fb145aedd6c7223f8298747aa5aa9409fdadf3`；关系匹配安全收紧：`9112f2bdd41a8476119a19c2b1fb1cc7237eb20ba`。

2. **Reviewer 文风修改真正进入自动采纳链路：**
   - `literary.ts` 不再把纯文风修订固定退回原稿；只有存在对应、来源/译文证据校验通过的 style finding，完整修订才作为当前 Reviewer 结果返回。
   - `translationAgent.ts` 对非中文单语编辑路径，将有对应 `proposedTranslation` 的文风修订与 finding 原子保存为 Run 候选，并继续沿用服务端 Run 最终化的自动采纳事务。
   - 中文目标语言仍按“中文单语编辑 → 双语准确性/术语复核”顺序执行；只有双语复核完成后才更新 Run 候选，不会把未复核的中文润色直接写入最终译文。
   - 新增 `selectVerifiedStyleReviewCandidates`，并在 `local-agent-service/tests/context-graph-workflow.test.mjs` 增加回归测试：无对应 finding 的改写不应用，中文单语编辑不会绕过双语复核。
   - 主要提交：`48060fff12992b4f6a31d1efed0296fcb5f1939a`、`6c51e773eb3ca310cb8f519bbd5e01d363cf786b`、`162fb34d7572617872ffd64215b8396611e0363e`、`f88a50293a50c4993caa121e63064d8f8b3804f7`。

### 文档同步

已同步更新：
- `vocal-saga`: `docs/TRANSLATION_PIPELINE.md`、ADR-0001、ADR-0005、`local-agent-service/AGENTS.md`、`local-agent-service/README.md`。
- `vocal-saga`: 中文文学编辑计划，明确“自动编辑、自动复核、服务端自动采纳、用户事后纠正”。
- `fanyi-extension`: `AGENTS.md` 和 `README.md`，删除“API/CLI 候选必须等待显式 /accept”的旧流程描述。
- ADR-0004、ADR-0006、ADR-0007 已检查；其当前决策与默认采纳原则一致。

### 仍需验证

1. **基础 CI 已通过。** `vocal-saga` 的 CI run `41165483572` 已通过共享模块检查、主项目类型检查/单测、Local Agent Service 类型检查/单测、fiction quality regression fixtures 和 library build；Local Agent Service 独立 CI run `41165483574` 也已通过。`fanyi-extension` 删除回归测试 CI run `41165321715` 已通过 Vitest、Chrome/Firefox 构建。
2. **Extension 删除路径需要端到端验证。** 覆盖人物删除、实体删除、关系删除、服务端返回 409（Run 正在执行）、图谱不存在/旧图谱缺少 predicate、重新打开文档后 rejected 状态仍生效。
3. **Reviewer 自动应用需要集成验证。** 至少验证非中文目标语言 style-only finding 自动保存并自动采纳；中文单语编辑经双语复核后自动采纳；双语复核失败时保留原候选；用户较新的手工修改不被自动采纳覆盖。
4. **真实模型质量仍需样本评估。** 代码路径自动化不等于编辑质量已证明。需要用代表性小说片段检查过度润色、人物声音漂移、原文事实增删和语义偏移。

## 尚未完成或需要进一步验证

以上第 1-4 项是验证工作，不是已经完成的代码功能。不得把新增测试文件等同于测试已通过，也不得把 Reviewer 自动生成的修订等同于文学质量已通过人工评估。

## 统一设计规则

- 模型当前最佳结果默认参与后续翻译；不需要用户逐项确认。
- 用户修改和拒绝具有更高优先级，自动分析不得覆盖。
- 证据不完整影响置信度、范围和约束强度，不成为人工审批门槛。
- `model-default`、`user-modified`、`user-confirmed`、`user-rejected` 必须区分；机器默认采纳不能伪装成人工确认。
- 只有来源版本错误、不可替代输入缺失、数据损坏或执行无法继续等技术异常才阻断正常流程。
- 未来章节隔离、来源绑定、译文写回位置和用户明确拒绝必须保留为硬约束。
- UI 中的“删除”必须有持久化语义，不能只从一个展示投影中移除。
- 所有自动应用必须保留来源、版本和可回滚记录；不静默覆盖用户修订。

## 第二轮续做：全书记忆默认采纳与删除回归（2026-10-31）

### 新发现

此前代码只完成了译文候选自动采纳和部分人物声音档案的 model-default 支持，但 translationContextDelta.ts 合并实体/关系时仍将新增记录写成 suggested。这导致 UI/文档所述“默认采纳”与后续批次实际读取的记忆状态不一致。

### 已提交修复

1. **全书记忆实体/关系默认采纳：**
   - 通过来源片段与引文校验的新增实体和关系，写入 reviewStatus='confirmed'、confirmationSource='model-default'。
   - 目标译名置信度仍单独记录；单一片段证据仍是 candidate 置信度，不会因为默认采纳变成强制术语。
   - 对已有的同名、同译名旧候选，提升为 model-default；已有用户确认/修改保持不变。
   - 对用户明确拒绝的实体/关系不再追加别名或证据、不恢复状态，防止后续分析复活。
   - Project Store 对 model-default 实体/关系增加来源证据存在性检查；缺少有效 evidenceRefs 时降级为 suggested。
   - 更新 Run 完成事件的状态策略与注释，消除“模型记录仍是 suggested”的旧语义。
   - 主要提交：4fe522372ba12898f78ca3e794ebbc9aa06d9813、76d2ca65ba3a0f47bd10ffc9fb0ccf38ffb7aeb1、324fa15edeb7d043cd4c0708a562626c4a1da403。

2. **新增回归测试：**
   - 实际译文只有一处目标表面时，实体仍默认采纳，但 targetConfidence 保持 candidate。
   - 新关系默认采纳为 model-default。
   - 用户拒绝的关系不因新 delta 复活。
   - 已存在的旧 suggested 实体提升为 model-default。
   - 用户拒绝的实体不因新 delta 复活。
   - 测试文件：local-agent-service/tests/translation-context-delta.test.mjs。
   - 提交：0e247cbb2bb0b7cd3f962fe63ad2c8028d49e4f5。

3. **Extension 删除路径：**
   - 人物删除现在等待 LiteraryMemory revision 写入完成，不再把持久化动作作为 fire-and-forget。
   - 新增独立 Vitest 回归文件，覆盖实体删除同步拒绝节点和关联边、服务端拒绝时不删除本地实体、关系精确匹配、端点不明确时不按 predicate 宽泛拒绝。
   - 提交：78b5e4cee00099c1bf15343257c2952206bd9e74、1b19323f6768b219157a97027b7a90acf61d2f2c。

### CI 状态

- fanyi-extension：新增删除回归测试的 GitHub Actions CI 已通过，run 41165321715。
- vocal-saga：CI run `41165483572`、Local Agent Service run `41165483574`、最新 Context Graph cleanup CI run `41165746126` 和 Local Agent Service run `41165746003` 均已完成并通过；覆盖主项目和 Local Agent Service 类型检查、单测、共享模块检查、fiction quality fixtures、API route manifest、book-scan benchmark 和 library build。
- 上一轮 vocal-saga 基础 CI（run 41164972117）及 Local Agent Service CI（run 41164972116）均已通过。

### 尚未完成

- 等待本轮 vocal-saga 最新 CI 完成，若失败则根据日志修复。
- 仍需端到端验证真实 Context Graph 的“拒绝 → 重新分析 → 不复活”，以及 LiteraryMemory 与图谱的跨存储一致性。
- 仍需使用真实小说样本评估人物声音漂移、事实增删和过度润色；fixture 回归通过不等于真实文学质量达标。
### 第三轮续做：Context Graph 重新分析清理边界

- 将 Context Graph 文件头部过时的“模型事实保持候选直到人工审核”改为“来源校验后默认采纳，用户决定优先，置信度控制使用强度”。
- 将重新分析前的清理 SQL 抽取为 `clearReplaceableModelGeneratedContextGraphItems`，便于独立测试。
- 修复潜在的端点完整性问题：重新分析清理模型默认节点时，如果仍被用户确认/拒绝的关系边引用，节点必须保留，否则会留下无法完整呈现的用户决定。
- 新增 `document-context-graph.test.mjs` 回归测试，覆盖模型默认节点/边清理、用户拒绝节点/边保留、用户确认关系引用的模型默认端点保留，以及相关 evidence 保留。
- 提交：`cc35fe7e03aab09fd8307330575f6d39adc1fce3`、`85e4a3580787d328fe5a6c426f7ef8558eaa25e6`。
- 验证：Local Agent Service CI run `41165746003` 通过；vocal-saga 完整 CI run `41165746126` 通过全部步骤，包括共享模块检查、类型检查、主项目单测、Local Agent Service 类型检查/单测、fiction quality fixtures 和 library build。
- Extension 人物删除专项回归 CI run `41165681322` 通过。

## 第四轮续做：删除一致性、弱关系语义与并发写入（2026-10-31）

### 新发现

1. **删除 LiteraryMemory 投影与拒绝 Context Graph 记录不是同一事务。** 如果先拒绝图谱、再保存记忆失败，会出现图谱已拒绝但 UI 仍显示旧人物的部分成功状态；反过来只删除 UI 投影也会在后续图谱刷新时复活。
2. **关系端点无法唯一定位时，删除不能退化为按 predicate 全局拒绝。** 但也不能因此连 LiteraryMemory 投影都不保存；安全行为是只跳过无法可靠定位的图谱边，仍保存用户明确删除后的记忆 revision。
3. **普通记忆编辑与删除存在异步写入竞态。** 删除操作如果在较早的记忆写入尚未完成时先生成快照，或者删除完成后被较晚到达的旧快照覆盖，可能重新出现已删除实体。
4. **图谱共同出现关系的语义过强。** 原文引文同时提到两个人，只能证明二者在该段共同出现，不能证明亲属、阵营、动机或具体行为。即使图谱边状态是模型默认采纳，也不能将其作为已核实剧情事实。
5. **已拒绝实体必须从所有下游投影排除。** 仅在人物/声音上下文中过滤不够；如果 TranslationBrief 的 canonical name mapping 仍携带该实体，拒绝记录仍可能进入翻译提示。

### 已提交修复

- vocal-saga 的 /context-graph/review batch API 支持同时提交 items 和更新后的 memory。图谱状态、LiteraryMemory revision、项目事件在同一 SQLite 写事务中提交；记忆验证或写入失败会回滚全部图谱决定。
- fanyi-extension 人物、实体、关系删除统一使用该原子接口；当没有可安全匹配的图谱项时，使用 LiteraryMemory-only 写入，不按模糊 predicate 扩大拒绝范围。
- 将普通记忆编辑和删除纳入同一串行队列。删除先等待已有编辑完成，再基于最新资料生成快照并排队提交，避免较早的异步保存覆盖删除结果。新增并发回归测试。
- TranslationBrief 在实体进入任何后续投影前过滤 reviewStatus=rejected，防止已拒绝实体继续成为 canonical mapping。
- voiceContext 只在关系两端实体都进入当前可见上下文时输出该关系，避免孤立端点关系泄漏。
- Context Graph 的共同出现关系统一标记为 kind=observed-association、confidence=candidate；翻译 Prompt 明确说明它只是弱连续性线索，不代表具体关系或剧情事实。
- 更新 vocal-saga/local-agent-service/AGENTS.md 与 fanyi-extension/AGENTS.md，保持默认采纳、用户拒绝持久化、事务边界和自动修正原则一致。

### 回归验证

- vocal-saga：Local Agent Service CI run 41167502941 通过；完整 CI run 41167502938 通过。新增图谱共同出现关系弱语义测试随这两组 CI 通过。
- fanyi-extension：最新 CI run 41167653389 通过；此前串行队列实现的中间提交曾因删除 helper 在队列内部再次等待同一队列而超时，已修复该自等待死锁。修复后的 run 41167611763、41167629485 和最终并发回归 run 41167653389 均通过。
- 相关改动均直接提交到两个仓库的 main 分支。

### 当前结论

删除动作现在覆盖服务端图谱事实、LiteraryMemory revision 和扩展端异步写入顺序；共同出现关系不会再被提示词当成已经证实的剧情关系。剩余风险主要在真实长篇样本中的语义质量与跨章节回归覆盖，不是本轮已发现的事务或并发缺陷。后续抽样应重点检查：用户拒绝后重新分析是否仍保持拒绝、关系端点仅出现一端时是否不泄漏、以及模型默认实体译名是否始终保持候选置信度而不被误当作受保护术语。


## 第五轮：跨阶段状态生命周期与 Run 最终化审查（2026-10-31）

### 审查范围

本轮从项目创建、Run 快照、跨批次上下文增量、LiteraryMemory 合并、候选持久化、自动采纳、服务重启恢复和用户事后修改/拒绝逐段检查两个仓库。重点不再是单个 API 是否正确，而是同一项状态能否在后续阶段保持一致。

### 新发现与修复

1. **P1 — 用户删除后仍可能被下一批 context_delta 重新创建。**
   - 之前扩展删除会物理移除 LiteraryMemory 的 entity/relation 投影，并拒绝当前 Context Graph node/edge。
   - 但后续 mergeTranslationContextDeltasIntoMemory 在找不到旧投影时，会把同名实体/同一关系三元组作为新项插回去；如果图谱中原本没有对应 edge，图谱拒绝也无法覆盖这个路径。
   - 修复：增加隐藏 LiteraryBookMemory.rejectedItems tombstone。删除实体时保存规范名、kind 和 aliases；删除关系时保存 subject/predicate/object；人物删除同时保存 profile canonical name 与被连带删除的关系。Extension sanitize/merge、服务端 sanitize 和跨批次 delta merge 都保留 tombstone，并在活动投影生成前过滤同一项。用户明确重新编辑该项时清除对应 tombstone。保留上限提高到每个项目最近 2,000 条。
   - 新增服务端 context delta 回归测试、服务端 sanitize 测试、扩展 sanitize/merge 测试。

2. **P1 — 旧 Run 延迟采纳可能覆盖更新的 Agent 译文。**
   - 之前 acceptCandidates 只保护同来源版本的 manual edit；较早 Run 的候选如果晚于较新 Run 完成采纳，仍可能覆盖较新的 Agent 结果。
   - 修复：采纳时在同一 SQLite 事务内校验 Run 的 source revision 仍是当前版本；对同一 segment/source hash，任何 rowid 更新的 accepted result 都优先，不限于 manual。记录区分 preservedManualSegmentIds 与 preservedNewerAcceptedSegmentIds。

3. **P1 — Run 创建时存在快照竞态。**
   - 旧实现先读取原文 revision、Prompt 和 LiteraryMemory，再获取写锁创建 Run；期间如果用户修改记忆或 Prompt，Run 可能静默绑定旧快照。
   - 修复：在 BEGIN IMMEDIATE 后重新校验当前 source revision、LiteraryMemory revision，以及隐式选择的最新 Prompt。快照准备期间发生变化时返回 409，不创建 Run。增加竞态回归测试。

4. **P1 — Run 自动采纳与项目记忆合并之间存在窗口。**
   - 旧顺序先 finishRun 并采纳候选，再异步合并 context_delta。此时 Run 已成为 completed，下一轮可以启动并读取尚未更新的 LiteraryMemory。
   - 修复：Run 保持 running，先在 SQLite 写事务中读取最新 LiteraryMemory、合并本轮 source-ordered context_delta 并保存 revision；该事务完成后才调用 finishRun，再自动采纳候选。awaiting_acceptance 也被视为未完成最终化状态，不能启动下一轮 Run。
   - 记忆合并读取的是事务内最新状态，保留期间发生的用户决定和 tombstone。

5. **P1 — 服务重启可能留下永久 awaiting_acceptance。**
   - 旧恢复逻辑只处理 queued/running；如果进程在 finishRun 后、自动采纳前退出，Run 会长期停在 awaiting_acceptance，而新 Run 又无法安全开始。
   - 修复：启动恢复时扫描 awaiting_acceptance Run，幂等合并尚未持久化的 context_delta，然后自动执行候选采纳；恢复结果写入项目事件。新增重启回归测试，验证重建 Store 后候选自动变成 accepted。

### 其他已核对的生命周期约束

- 用户确认/修改/拒绝仍由服务端持久化状态决定，Extension 的 UI 投影不是事实来源。
- model-default 的目标译名保持 evidence-scoped candidate confidence；不会仅因默认采纳就升级为用户确认或强制术语。
- observed-association 仅代表原文共同出现，是弱连续性提示，不作为具体剧情关系。
- Context Graph 删除、LiteraryMemory revision 和项目事件在同一 SQLite 事务中提交。
- Extension 普通记忆编辑和删除使用同一串行队列，避免旧异步写入覆盖删除。
- 质量修复仍创建独立 selected-ID Run；采纳时沿用 source revision 和 newer accepted result 保护。

### CI 与回归验证

- vocal-saga Local Agent Service CI：run 41169580648 通过。
- vocal-saga 完整 CI：run 41169580569 通过。
- 自动恢复 pending acceptance 的回归测试：run 41169454269、41169454290 均通过。
- fanyi-extension tombstone sanitize/merge、删除队列与人物 profile canonical name 回归：run 41169295959、41169284808、41169270511、41168943342 均通过。
- 中间提交曾暴露 TypeScript 类型错误、Run 锁测试断言过时，以及配对评测未完成 Run 最终化的问题；均已根据 CI 失败日志修正。不能把这些中间失败误报为最终通过。

### 当前结论与剩余边界

本轮已修复数据生命周期中最容易造成用户决定丢失的路径：删除复活、旧 Run 覆盖新译文、Run 快照陈旧、记忆合并竞态和重启后采纳停滞。两个仓库的最新代码 CI 均通过。

仍需通过真实长篇样本验证文学质量本身：人物声音跨章节稳定性、语义事实保真、文风修订是否过度改写，以及用户拒绝后经历多轮全书重分析是否仍保持抑制。CI 的合成回归只能证明确定性状态规则，不能替代真实小说的盲审。

## 第六轮：中文单语编辑的双语验证与回退闭环（2026-10-31）

### 发现

中文单语编辑本身不接收原文，必须经过后续 Accuracy/Terminology Reviewer 对照原文验证。旧实现把单语编辑临时放入内存 translations map，再执行双语复核；成功路径会更新候选，但未覆盖片段或 Reviewer 整体异常时，内存 map 仍可能保留未验证编辑，导致后续 context delta/记忆构建有机会消费 provisional text。另一个风险是候选保存逻辑不显式要求 `reviewedIds` 覆盖，验证边界依赖 Reviewer 输出对象的形状。

### ADR 决策

ADR-0007 新增决策 14：双语复核成功覆盖的编辑保留；覆盖但没有修改时保留中文编辑；未覆盖、缺失、空/无效结果、补审失败或复核调用失败时，按 segment 自动退回第一道翻译阶段的初译。部分覆盖独立处理。未经双语复核的编辑不得进入 Run 候选、context delta 或 LiteraryMemory。全程不增加用户确认动作。

### 代码修改

- 新增 `resolveBilingualVerifiedChineseEdits`，显式按 `reviewedIds`、`missingIds` 和完整非空译文确定每个 segment 的验证结果。
- 双语 Reviewer 候选保存前先执行验证过滤；覆盖成功的候选使用 Reviewer 最终文本，未覆盖片段立即把 translations map 恢复为初译。
- Reviewer 调用整体失败时，所有本批中文单语 provisional edits 自动恢复初译；原先保存的初译候选不被改写。
- 双语审校返回部分结果时，只保留明确覆盖的 segment；补审失败不会让未覆盖的 segment 沿用 provisional edit。
- 新增回归测试覆盖：成功但未修改、成功并修订、未覆盖、补审失败、空结果、整个双语复核失败。

### 验证边界

本轮修改已提交到 `main`，但需要等待 GitHub Actions 对 TypeScript、Local Agent Service 测试和完整 CI 的实际结果。CI 通过后仍应对真实 EPUB 做抽样，确认候选、context delta 和最终译文使用的是同一份双语复核结果，而不是只验证 helper 的单元逻辑。

### 第六轮补充：Finding 与候选状态同步

继续沿真实持久化路径检查后发现，`markChineseEditorialFindingsReviewed` 通过 `finding.editorialMode === 'chinese-monolingual'` 识别待验证编辑，但 style-review 写入 finding 时没有保存该字段。结果是候选文本可能已被双语复核更新，Finding 却仍停留在 pending，旧的自动更新分支不会执行。现已在保存 style finding 时写入 `editorialMode`。

另外，双语复核可能明确将编辑改回第一道初译。此时不能只把译文回退而遗留 pending finding。现已增加 `reverted` 结果：事务内将候选恢复为初译、将 Finding 标记为 dismissed，并记录 `automatic-bilingual-review-reverted`；这代表机器依据原文自动否决该编辑，不伪装成人工点击。新增 Store 集成测试验证回退后 Finding 不再 pending，且候选仍是初译。

新增代码回归覆盖了双语复核成功且不改动、成功并修订、审校改回初译、未覆盖、空结果、补审失败、整体审校失败，以及候选保存被取消/拒绝的分支。GitHub Actions 已确认 helper 回归和 Store 回退集成测试通过。包含本轮全部代码与文档的完整 validate workflow run 41170760281 已通过：shared translation modules、TypeScript typecheck、单元测试、Local Agent Service typecheck/测试、fiction quality regression fixtures 和 library build 全部成功。
