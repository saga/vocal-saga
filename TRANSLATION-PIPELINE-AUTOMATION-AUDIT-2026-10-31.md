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

1. **尚未执行本地测试。** 本轮通过 GitHub 文件接口提交代码，当前没有在仓库工作目录运行 `npm test`、`tsc --noEmit` 或 `vite build`。新增回归测试已经提交，但不能宣称测试通过。
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
