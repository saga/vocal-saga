# Yabu 译名不一致 — 修改实现 Plan（仅规划，不改代码）

> 仓库：`vocal-saga`（Cloudflare Workers + local-agent-service）  
> 范围：local-agent-service 翻译链路（Context Graph / 文学记忆 / TranslationBrief / canonical term protection）  
> 状态：规划文档，尚未实施。

## 1. 问题与目标

### 1.1 现象
角色卡片中 `Yabu → 薮` 已存在，但实际译文出现 `矢部`、`彌虎` 等不同写法，同一段落内同一角色被译成不同名字，无法保持一致。

### 1.2 目标
- 对已确认的专名映射，在**首次出现**时即可稳定输出统一译名。
- 消除同一运行内同一专名的多译名漂移。
- 保证“卡片存在”与“翻译强制统一”之间的链路可观测、可审计。
- 不破坏现有时间边界/证据约束，避免错误传播。

## 2. 根因（基于代码与日志）

1. **候选 ≠ 强制**：`buildCanonicalTermProtections()`（`translationAgent.ts:330`）只处理 `sourceStatus ∈ {confirmed, confirmed-memory, auto}` 的映射；`candidate` 映射被过滤（测试已固定）。
2. **Context Graph 节点状态为 candidate**：`Yabu` 节点 `status='candidate'`，`suggestedTranslation=薮`，故 `nameMappings.sourceStatus='candidate'`，仅 advisory。
3. **时间边界**：`buildProjectContextGraphBundle` 要求节点证据 `MAX(ordinal) ≤ firstOrdinal-1`。Yabu 证据序号 `1707–13383`，在首次出现批次不可见 → 映射不注入。
4. **候选映射需要先例**：非 confirmed 节点要求此前已接受译文包含 target；首次翻译无先例 → `targetNotPreviouslyAccepted` 排除。
5. **两套存储不同步**：项目记忆 entity `reviewStatus=confirmed` 但 `targetConfidence=candidate`、`targetEvidenceRefs=[]`；Context Graph 节点仍 candidate。确认一个不自动同步另一个。
6. **voiceContext 只是弱提示**：character voice `status=candidate`，`targetName` 仅参考，不强制；prompt 明确 candidate 译名不可作为强制规范。
7. **无 masking 时 LLM 自由音译**：训练数据存在多种音译，无确定性占位符还原，导致漂移。

## 3. 实现方案（分阶段）

### Phase 0：可观测性（已完成部分）
- [x] 新增 `translation-chain-dump.mjs`（只读链路输出）。
- [x] 补充运行时日志：context-graph bundle、canonical-terms、translation-brief、translateBatch、validateLiteraryMemory、voice-context。
- [x] 日志落盘到 `${DATA_DIR}/logs/local-agent.log`（支持 `LOCAL_AGENT_LOG_FILE` 覆盖）。

### Phase 1：状态同步与证据升级（核心）
目标：让 Yabu 的 Context Graph 节点和项目记忆 entity 在证据充分时可升级为 confirmed/auto，从而进入强映射。

改动点：
1. `validateLiteraryMemoryAgainstProject`（`projectStore.ts`）：entity 的 targetEvidenceRefs 目前不校验 target 是否出现在已接受译文；增加 target 校验逻辑，与 voiceAnchor 的 `targetValid` 一致。通过后将 `targetConfidence` 升为 `corroborated`/`confirmed`。
2. Context Graph 节点确认流程：`reviewContextGraphItem` 已支持 confirmed；需在 UI/Agent 侧提供“一键确认 Yabu 节点”路径（已有 API）。
3. 同步：当 project memory entity 被确认时，同步更新对应 context graph node status（或提供明确映射），避免两套状态不一致。
4. 日志：记录升级/降级原因（已部分完成）。

测试：
- entity targetEvidenceRefs 为空时 targetConfidence 保持 candidate。
- 有 ≥2 个不同片段的已接受译文包含 target 时升级为 corroborated。
- confirmed 节点在 bundle 中 sourceStatus=confirmed，且不受 targetNotPreviouslyAccepted 排除。

### Phase 2：首次出现即可用的映射
目标：解决“首次出现无先例导致映射不注入”。

改动点：
1. 对 `status=confirmed` 的 Context Graph 节点，`buildProjectContextGraphBundle` 已不要求 priorAcceptedTranslations；确保 confirmed 节点在首次出现批次也注入（需证据 max ordinal ≤ boundary；首次出现时 boundary = firstOrdinal-1，证据若全部在当前/后续则仍不可见）。
2. 对“规范名首次出现”的映射，允许使用当前批次内可见的证据作为 sourceStatus=confirmed-memory（需新状态或扩展 auto 的定义），但必须不泄漏后续章节事实。
3. 或：在 run 开始时预计算 confirmed 节点的“名称→译名”表（不受时间边界）作为 glossary，但仅限 confirmed，且不包含 role/traits 等剧情信息。

测试：
- confirmed 节点在 name first occurrence 批次中 nameMappings 包含该映射。
- 不包含 future alias / future evidence。
- candidate 节点行为不变（仍需先例）。

### Phase 3：确定性一致性保障
目标：即使映射未注入，也能避免同一运行内漂移。

改动点：
1. 扩展 canonical term protection：对 `status=confirmed` 的 project memory entity，即使 context graph 映射未注入，也生成 protection（需 careful: 仅 confirmed，且 source 可见）。或新增 “run-local canonical name table”。
2. 在 `translateBatch` 中，若 term 未被 protection 覆盖，记录 warning（日志已加 protectedTerms=0）；可选触发 retry/normalization。
3. Reviewer 阶段：`protectCanonicalReviewSegments` 已 mask draft；确保 confirmed 映射的 target 在 reviewer 输出中保持一致。

测试：
- confirmed entity 在无 context graph 映射时仍生成 protection。
- candidate entity 不生成 protection。
- marker count 校验通过。

### Phase 4：UI/流程
- 提供“确认 Yabu 节点”操作与状态展示（已有 review API）。
- 在角色卡片上显示 `targetConfidence` 与 `targetEvidenceRefs`，明确 candidate/corroborated/confirmed。
- 在翻译运行前预检：若关键专名映射为 candidate，提示用户确认。

## 4. 风险与回滚

- 风险：放宽时间边界或自动升级可能泄漏后续剧情/错误译名。
- 缓解：仅 confirmed 节点放宽；candidate 保持严格；所有变更保留 contextDiagnostics 计数与日志。
- 回滚：所有改动集中在 local-agent-service；可通过 git revert；日志/chain-dump 不影响运行。

## 5. 验收标准

- 对 Shogun 项目，Yabu 在首次出现批次的 `contextGraph.nameMappings` 包含 `Yabu→薮`（status confirmed/confirmed-memory/auto）。
- `buildCanonicalTermProtections` 输出包含 Yabu protection，`protectedTerms>0`。
- 同一运行内 Yabu 译名全部为 `薮`（无 `矢部`/`彌虎`）。
- chain-dump 输出中 `termProtectionActive=true`，`memoryConfirmedEntities` 包含 Yabu 且 `targetConfidence` 升级。
- 现有 181+ 测试通过，新增测试覆盖上述场景。

## 7. 低级未翻译英文单词错误（如 `Again → again`）

### 7.1 现象
原文：
> “Again, please excuse me,” she said. “Does Omi-san detail the cargo?”

译文：
> “again，请恕我再多问一句，”她说，“小美濃様有没有提到船上装的什么货？”

句首单词 `Again` 未被翻译，直接以小写 `again` 残留在译文，属于低级遗漏。

### 7.2 可能根因
1. 模型在处理句首大写短词时，偶发将其当作“可保留的英文 token”而非待翻译内容。
2. 输出校验只检查 ID/重复/格式，**没有检查译文是否仍含源语言单词**。
3. Prompt 合同未明确“所有源语词汇必须翻译，专名除外”。
4. Reviewer 未把“残留源语单词”作为明确失败条件。
5. canonical term protection 只覆盖专名映射，普通词汇无保护与校验。

### 7.3 解决方案（实现计划）

#### 7.3.1 Prompt 合同强化
- 在 `MANDATORY_TRANSLATION_CONTRACT` / `LITERARY_TRANSLATION_CONTRACT` 增加明确条款：
  - 所有源语词汇必须翻译为目标语；不得原样保留英文单词（专名映射中的术语除外）。
  - 若源文含大写句首单词，必须完整翻译其语义。

#### 7.3.2 输出校验与重试
- 在 `parseTranslations` 或 `translateBatch` 后增加 `untranslatedSourceTokenCheck`：
  - 检测译文中的英文单词 token（尤其大写/句首）是否在源文出现且未被 canonical protection 覆盖。
  - 若发现残留，标记该 segment 为失败并触发有界重试（现有 retry 机制），重试 prompt 附带“请翻译所有英文单词”。
- 重试上限保持现有有界重试，避免无限循环。

#### 7.3.3 Reviewer 检查
- 在 Reviewer prompt/contract 中增加检查项：译文不得包含未映射的源语单词；发现时必须修正。

#### 7.3.4 可观测性
- 在 `batch.prompt.ready` 事件与日志中增加 `untranslatedTokenCount`。
- 在 chain-dump 中可选增加“残留源语单词”检测摘要。

#### 7.3.5 不做的事
- 不引入针对特定单词（如 Again）的硬编码替换（避免 fallback/特例）。
- 不在 Worker 端做全文后处理清洗（保持边界）。

### 7.4 验收标准
- 类似 `Again` 的句首单词不再残留为 `again`。
- 新增测试：含句首大写单词的 segment，译文残留源语 token 时触发重试并最终无残留。
- 现有 181+ 测试通过。

## 8. 不实施的内容（避免过度设计）

- 不对 candidate 映射强制（保持现有设计，避免错误传播）。
- 不引入新的 fallback 翻译路径（原则：没有用的功能直接删掉，不做 fallback）。
- 不在 Worker 端扩展长文档流程（边界：Cloud vs Local Agent）。
- 不对特定单词做硬编码替换。
