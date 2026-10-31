# Yabu 角色卡片已存在但翻译结果不一致 — 分析报告

> 仅分析，不修改代码。基于 `vocal-saga` 仓库 `local-agent-service` 与相关文档。

## 一、现象

已有 `Yabu` 角色卡片，统一译名设定为 `薮`，但实际译文出现 `矢部`、`彌虎` 等不同写法，甚至同一段落内同一角色被译成不同名字，无法保持一致。

## 二、系统里「名称统一」不是靠提示，而是靠「确定性 masking」

名称能否被强制统一，取决于 `buildCanonicalTermProtections()`（`local-agent-service/src/documents/translationAgent.ts:330`）能否把源文中的 `Yabu` 替换为 `__VSA_TERM_000__` 这类占位符，翻译完成后再把占位符确定性地还原为统一译名 `薮`。只有还原步骤是确定性的，才能保证全文一致。

而这个保护**只对** `contextGraph.nameMappings` 中 `sourceStatus` 为 `confirmed` / `confirmed-memory` / `auto` 的映射生效（`translationAgent.ts:334-340`）。测试也明确固定了这一行为：

- `candidate` 映射 → `[]`，不强制（`tests/document-agent-prompt.test.mjs` "candidate-only..."）。
- 冲突 target → `[]`，不强制。

## 三、Yabu 卡片大概率仍处于「候选」状态

卡片里显示：

- `register · 置信度未评估`
- `角色定位（默认弱提示；标记已核实后增强）`
- `人物特征（默认弱提示；标记已核实后增强）`

这与 Context Graph 桥接的角色档案一致：`docs/character-confidence-analysis.md` 明确指出，由 Context Graph 桥接进来的角色画像 `status = 'candidate'`、`confidence = 0.55`（硬编码），并非 confirmed。候选映射在服务端被视为**只读参考、不得强制**。

## 四、即便卡片看起来"已确认"，还可能被以下机制排除

1. **两套存储不自动同步**  
   - 项目文学记忆（`memory.entities` / `characterVoices`）与 Context Graph 节点（SQLite `context_graph_nodes`）是两套。卡片可能是项目记忆里的 entity confirmed，但 Context Graph 节点仍为 candidate → `nameMappings.sourceStatus` 仍为 candidate。

2. **候选映射需要"先例"**  
   `contextGraph.ts:1488-1496`：非 confirmed 的节点，只有在**此前已接受的译文**里确实用过该 target（`targetWasPreviouslyUsed`）才会出现在 nameMappings；否则被 `graphNameMappingExcludedTargetNotPreviouslyAccepted` 排除。首次翻译 Yabu 时，没有先例 → 映射不会出现。

3. **时间边界（knowledge boundary）**  
   `buildProjectContextGraphBundle`（`contextGraph.ts:1241`）要求节点证据的 `MAX(ordinal) <= firstOrdinal - 1`。如果 Yabu 的规范名/别名只在当前或后续片段出现，映射不会注入；别名若仅后文出现也会被 `graphNameMappingExcludedAliasBoundary` 剔除。

4. **运行模式与挂载**  
   `buildUserPrompt`（`translationAgent.ts:648-649`）仅在 `translationMode === 'literary'` 时注入 `contextGraph` 与 `voiceContext`，且 `termProtections` 仅 literary 模式构建。非 literary 模式下，卡片信息根本不会进入 prompt。

5. **字符预算裁剪**  
   `contextGraph.ts:1541`：nameMappings 超过 8500 字符会被 `pop()`；`voiceContext` 也有 9000 字符预算。映射可能被裁掉。

6. **voiceContext 只是弱提示**  
   即使 characterVoice 被注入，`targetName` 只出现在 voiceContext.entities/characterVoices 里作为参考；prompt 约束写明 candidate 译名"不能被视为已确认译名或强制约束"。LLM 仍可自由音译。

## 五、为什么同一段落会出现「矢部」和「彌虎」两种译名

没有 masking 时，LLM 对每个片段独立生成译名，且训练数据中 Yabu 存在多种音译（薮 / 矢部 / 彌虎）。系统**故意**不对 candidate 映射强制（避免错误传播），所以不一致是弱约束下的预期行为，而非 bug。

## 六、要获得一致性需要满足的条件（仅分析，不改代码）

- Context Graph 节点状态需为 `confirmed`（通过 `reviewContextGraphItem`，且有原文证据）；
- 或映射 `sourceStatus` 为 `auto`（需至少两个不同片段的已接受译文表面独立佐证）；
- 运行需为 literary 模式且 contextGraph 正确挂载；
- 首次出现处需满足时间边界与别名可见性；
- 项目记忆 entity 的 confirmed 状态不会自动同步为 Context Graph confirmed，需分别确认。

## 七、结论

**卡片存在 ≠ 映射被强制**；强制链路是 `contextGraph.nameMappings` 的 confirmed/auto 映射 → `buildCanonicalTermProtections` → masking/restore。Yabu 卡片大概率卡在 candidate 阶段，因此译文仍由 LLM 自由发挥，产生不一致。
