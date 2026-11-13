# 专名译名漂移根因分析：agent memory 视角

> 日期：2026-11-14
> 范围：`local-agent-service` 文学翻译链路（Context Graph / Literary Memory / TranslationBrief / canonical term protection）
> 方法：**只读排查**，未修改任何代码；证据来自真实项目库与运行时事件
> 参考：[Anthropic, *Components of Agent Memory*](https://www.anthropic.com/research/components-of-agent-memory)
> 关联：`temp/translation-naming-consistency-plan.md`（Yabu → 薮 / 矢部 / 彌虎，同类问题，Phase 1–3 已规划但未实施）

---

## 0. 结论摘要

`Tennent` 时而译成「坦嫩特」、时而译成「坦南特」，**不是模型音译能力问题，而是记忆系统缺了两个组件**。

系统把专名当作「观察 / 候选」记录下来，却从来没有把「实际写进译文的那个中文名」捕获成一条**绑定决定**（binding decision）；也从来没有一个**离线整合**（dreaming）环节拿译文这份 ground truth 回头校验并纠正记忆。而每个翻译批次都是全新 session，波内并行批次互不可见 —— 于是每批都重新音译一次。

用 Anthropic 文章的框架说：**把「决定」当成「事实」来管了。** 现有 fail-closed 策略假设译名是需要外部验证的事实，怕把错误译名传播开；但专名的价值函数是**一致性优先** —— 一个不够好但全书统一的音译，远好于两个各自都合理的音译。文章说「Memory is, occasionally, a prediction」，这里预测错了对象：它记录了名字的线索，却没预测到这个名字会复现 89 次。

最讽刺的一点：代码里 `run-canonical` 这个状态的设计说明写的就是「避免首次出现、并行批次和后续批次各自重新命名」—— 为这个场景量身定做，而 `Tennent` 恰好拿不到。

---

## 1. 现象与数据证据

### 1.1 数据源

```
~/.vocal-saga-local-agent/documents/97fe5d63-f2e9-4f0f-a12b-18edfe0c2310/project.sqlite
```

涉及表：`source_segments`、`translation_results`、`translation_briefs`、`translation_runs`、
`literary_memory_revisions`、`context_graph_nodes`、`translation_context_deltas`、`project_events`。

### 1.2 出现频次与译名分布

| 项 | 数量 |
|---|---|
| 源文 `Tennent` | 85 个片段 |
| 源文 OCR 断字 `T ENNENT` | 4 个片段 |
| 译文 `坦嫩特` | 81 行（55 行 `accepted=1`） |
| 译文 `坦南特` | 41 行（34 行 `accepted=1`） |
| 译文 `特南特`（图谱建议值） | **0 行** |

两种译名合计 122 行译文、89 行已采纳，**没有一行是图谱里那个「confirmed」译名**。

### 1.3 同一次运行内就分叉

按 `run_id` 统计全部译文行（`嫩` = 坦嫩特，`南` = 坦南特）：

| run（前 8 位） | 嫩 | 南 | 说明 |
|---|---:|---:|---|
| `bfda9488` | 0 | 8 | 早期：全是坦南特 |
| `f95f312e` | 0 | 8 | 早期：全是坦南特 |
| `4aa3b4ce` | **19** | **25** | **同一次运行内混用** |
| `fd4a5758` | 60 | 0 | 后期：全是坦嫩特 |
| `78e58834` | 2 | 0 | 后期：全是坦嫩特 |

`4aa3b4ce` 的 19:25 是决定性证据：**不是跨 run 记忆过期，而是同一 run 的并行批次当场分叉**。

只看 `accepted=1` 的行同样成立（`4aa3b4ce` 为 14:22）。跨 run 从 100% 坦南特漂到 100% 坦嫩特，靠的是后续 run 数量慢慢「票决」出来，不是任何一次决策。

### 1.4 记忆库里存着什么

| 存储 | Tennent 记录 | 问题 |
|---|---|---|
| `context_graph_nodes` | `status=confirmed`、`suggestedTranslation=特南特`、`adoptionSource=model-default` | 这个 target 在全部 122 行译文里出现 **0 次**，是错的，且是模型默认采纳而非用户确认 |
| `literary_memory_revisions`（最新） | `target=坦嫩特`、`targetConfidence=corroborated`、`confirmationSource=model-default`、`targetEvidenceRefs` 长度 = **1** | 「corroborated」是模型自报，与实际独立佐证门槛（≥2 个不同 segmentId）不符 |
| `translation_briefs` | 共 43 份，**全部**在 `brief_json` 里提到 Tennent（含 `styleGuide` 叙述文本）；但只有 **15 份**真正注入了 `contextGraph.nameMappings` 条目，且 **15/15 全是 `sourceStatus=candidate`, `target=坦嫩特`** | 其余 28 份的 `nameMappings` 为空或不含该名字 |
| `project_events`（`canonical-terms.protected`） | 39 个事件，`mappingCount` 分布 1–6 | **无一保护 Tennent**；payload 只有 `mappingCount` / `protectedSegmentCount` / marker 诊断，**没有 `protectedSources`**，因此这种故障只能靠挖 SQLite 才能发现 |
| `literary_memory_revisions.openQuestions`（最新） | 6 条提到该名字，其中：①「候选译名存在冲突：Tennent 已有坦嫩特，新批次提出坦南特；需人工核对原文证据」；②「voiceContext.entities 与 nameMappings 中的候选映射作坦嫩特，但此前已采纳译文（recentExamples）连续使用坦南特……**本批按既有译文表面统一为坦南特**」 | 模型自己已经看出冲突并做过一次性临时决定，但该决定**只写进 openQuestion，没有落成任何可注入的状态**；下一个批次看不到它 |

对照组（说明机制本身没坏）：`Phillip→菲利普`(23)、`Alice→爱丽丝`(8)、`Hampson→汉普森`(5)、
`Andrew→安德鲁`(2) 等都拿到 `run-canonical` 并被正常保护。

---

## 2. 现有 memory 架构

```
                        ┌─────────────────────────────────────────────┐
   源文 segments ──────▶│ 全书预处理 (context graph / 图谱节点)        │
                        └──────────────┬──────────────────────────────┘
                                       │ suggestedTranslation (候选/已确认)
                        ┌──────────────▼──────────────────────────────┐
   每波结束 delta ─────▶│ literary_memory_revisions (entities/openQ)   │
                        └──────────────┬──────────────────────────────┘
                                       │ 合并 + 证据可见性闸门
                        ┌──────────────▼──────────────────────────────┐
                        │ translation_briefs (nameMappings/voiceContext)│
                        └──────────────┬──────────────────────────────┘
                                       │ sourceStatus 决定优先级
                        ┌──────────────▼──────────────────────────────┐
                        │ buildCanonicalTermProtections                 │
                        │ → __VSA_TERM_NNN__ 掩码（唯一确定性保障）    │
                        └──────────────┬──────────────────────────────┘
                                       │
                        ┌──────────────▼──────────────────────────────┐
                        │ 翻译批次（全新 session，并行波内互不可见）    │
                        └──────────────┬──────────────────────────────┘
                                       │
                              translation_results  ← ✗ 从不回流校验上游记忆
                                       ✗ 首次实际译名从不捕获为 binding decision
```

**四套存储、三个不同的 target**（`特南特` / `坦嫩特` / `坦南特`），没有单一真相源。
文章里「several agents wrote to a shared table of contract terms at the same time … agents had overwritten one another's work」导致 41/57 事实存活，与此处结构同源：多写入方 + 无权威裁决 + 无合并规则。

---

## 3. 代码级断点（逐条）

### 3.1 唯一确定性保障被 `candidate` 一票否决

`local-agent-service/src/documents/canonicalTermProtection.ts:80-99`

```ts
const priorityFor = (status: unknown): number => {
  if (status === 'confirmed-memory') return 4;
  if (status === 'confirmed') return 3;
  if (status === 'auto') return 2;
  if (status === 'run-canonical') return 1;
  return 0;                       // candidate → 0
};
const active = mappings.filter((mapping) => {
  if (priorityFor(sourceStatus) <= 0 || ...) return false;   // 直接丢弃
  ...
});
```

`canonicalTermProtection.ts:113` 还有「源文出现才注入」的过滤（`items.some(...)`），
`translationSchema.ts:114` 规定掩码必须逐字保留、服务端保存前替换回规范译名。
也就是说：**掩码是唯一能保证执行的手段，且注入层本来就很薄（像 index，不膨胀 prompt）**。
Tennent 的全部 15 条映射都是 `candidate`，因此 0 个掩码。

### 3.2 图谱闸门要求「此前已采纳译文用过该 target」→ 错误记忆死锁

`local-agent-service/src/documents/contextGraphBundle.ts:487-500`

```ts
// 人物的首次出现译名，在更早的已采纳译文确立该译法之前都只是暂定的。
if (!explicitUserConfirmation && characterLike) {
  const targetWasPreviouslyUsed = priorAcceptedTranslations.some((entry) =>
    ctx.quoteMentions(entry.source, row.name) && normalize(entry.target).includes(normalize(target)));
  if (!targetWasPreviouslyUsed) {
    nameMappingDiagnostics.graphNameMappingExcludedTargetNotPreviouslyAccepted++;
    return [];
  }
}
```

`特南特` 在译文中命中 0 次 → 这个节点**永远**无法满足晋升条件 → 永远不会被提升，
也永远不会被纠正。运行时诊断也印证了这一点：`translation-brief.ready` 事件里
`graphNameMappingExcludedTargetNotPreviouslyAccepted` 在部分 brief 达到 1–3。

设计初衷（防剧透、防身份反转提前泄漏）是合理的，但它把「译名」和「剧情事实」绑在同一条时间边界上评估了 —— 译名只是字符串，不含 role/traits，本不该受此约束。

### 3.3 文学记忆的佐证门槛拿不到真证据

`local-agent-service/src/documents/translationBrief.ts:471, 493-503`

```ts
const userConfirmedMapping = entity.reviewStatus === 'confirmed' && entity.confirmationSource === 'user-confirmed';
const targetRefs = Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : [];
const corroboratedTarget = entity.targetConfidence === 'corroborated' &&
  new Set(targetRefs.map((ref: any) => ref?.segmentId).filter(Boolean)).size >= 2;
...
sourceStatus: userConfirmedMapping ? 'confirmed-memory' : corroboratedTarget ? 'auto' : 'candidate',
```

实际 `targetEvidenceRefs` 只有 1 个 → 降回 `candidate`。且这些 ref 来自模型自己写的 delta，
**不是** `translation_results(accepted=1)` 里真实出现过的中文表面。

### 3.4 冲突只记 openQuestion，不合并成决议

`local-agent-service/src/documents/translationContextDelta.ts:715-719`

```ts
if (mergeName(prior.target) !== mergeName(candidate.targetProposal)) {
  summary.entityTargetConflicts++;
  addOpenQuestion(context, '候选译名存在冲突：“' + candidate.canonicalSource + '”已有“' +
    text(prior.target, 80) + '”，新批次提出“' + candidate.targetProposal + '”；需人工核对原文证据。');
  return;   // 不写入决定，也不仲裁
}
```

这正是库里那条 openQuestion 的来源。反过来看，`canonicalTermProtection.ts:152-178` 的
`normalizeContextDeltaCanonicalTargets()` 说明设计者**已经知道**「决定应该压过候选 observation」，
但它是保护生成**之后**的下游校正 —— 上游根本没有决定时，它无事可做。

### 3.5 运行结束只合并 delta，不做离线整合

`local-agent-service/src/documents/translationRun.ts:502`（literary 模式调用）、`646-700`

```ts
const runDeltas = store.listTranslationContextDeltas(projectId, runId)...;
const merged = mergeTranslationContextDeltasIntoMemory(currentMemory.memory, runDeltas);
if (merged.changed) { const saved = store.saveLiteraryMemory(projectId, merged.memory); ... }
```

`statusPolicy: 'validated model-default records are active; user decisions are never overwritten; target confidence remains evidence-scoped'`。
**没有**拿 `translation_results` 校验实体 target、**没有**纠正 0 命中的图谱建议、
**没有**合并冲突、**没有**把高价值条目提升到注入层。这就是文章说的 dreaming 缺口。

### 3.6 每批都是新 session，波内互不可见

- `local-agent-service/src/agents/workbuddy.ts:316-323`：`taskProfile || persistSession || sessionId` 走 `queryWorkbuddyRaw()`（一次性 CLI）；只有显式 `sessionId/resume` 才续会话。翻译批次带 `taskProfile`，因此**无会话历史**。
- `local-agent-service/src/documents/translationRun.ts:555-576`：波内冻结 `freeze-within-wave; merge-in-source-order-between-waves`，`priorDeltas` 只取 `firstOrdinal < waveFirstOrdinal` 的增量 —— 同一波并行批次互相看不到对方刚写的 delta。

结果：**每一个批次都在独立地、从零开始音译同一个名字**。这与文章里 CL-Bench 的设定完全一致：
> "Claude started each question in a fresh session, with one exception: it could retrieve files from a memory directory that persisted from one session to the next."

唯一的连续性就是持久化记忆目录。所以记忆错一次，就一直错下去。

### 3.7 prompt 明确告诉模型「别把 candidate 当真」

`local-agent-service/src/documents/voiceContext.ts:285`

```ts
'entities 中 targetConfidence=candidate 的目标译名只是弱参考，不能被视为已确认译名或强制约束；...'
```

`translationSchema.ts:110-112` 同样把 candidate 定为「只作暂定线索」，并要求遵循
`confirmed / confirmed-memory / run-canonical / auto` 的规范映射。
文章原话：
> "Loading a note also doesn't guarantee that Claude acts on it: our documentation on Claude Code warns that longer instruction files reduce adherence."

即便把候选译名塞进 prompt，也不能保证模型遵守；只有掩码是确定性的。

---

## 4. 对照 Anthropic《Components of Agent Memory》

文章定义：
> "By 'agent memory,' we mean knowledge that Claude gains from experience … and that it retains between sessions, saved as context it can read later."

并明确排除 weights、in-context learning、compaction。**本项目的翻译批次恰好落在「跨 session、只能靠持久化上下文」这一档**，所以文章结论可直接对照。

| 文章组件 / 结论 | 本项目现状 | 判定 |
|---|---|---|
| 即时捕获 salient events（"tag salient events in a session log as they happen"） | 捕获的是模型提议的 `targetProposal` / 图谱 `suggestedTranslation`；真正显著的事件 —— **「某个中文字符串已被写入译文」** —— 从未被捕获为决定 | ❌ 缺失 |
| 用 transcript 作 ground truth 校验（"The transcript gave Claude a ground truth to validate its memory against."） | `translation_results(accepted=1)` 从不回流；`targetEvidenceRefs` 来自模型自报 | ❌ 缺失 |
| Dreaming / 离线整合：纠正错误 note、合并冲突、构建表示、提升高价值条目 | `commitRunContextMemory()` 只做 delta 合并；冲突进 `openQuestions` 就结束 | ❌ 缺失 |
| 单一真相源 / 避免并发覆盖（合同 wiki：共享表被互相覆盖，41/57 → 改为一页一主体后 57/57） | 图谱 / 文学记忆 / delta / voiceContext 四套存储，三个不同 target，无裁决者 | ❌ 缺失 |
| 注入层保持小而精（Claude Code `MEMORY.md` 只加载前 200 行 / 25 KB 作 index） | `buildCanonicalTermProtections` 已按「源文出现才注入」过滤，机制正确；只是没有内容可注入 | ✅ 已有，可直接复用 |
| Salience 判断（"Memory is, occasionally, a prediction"） | 按「是否值得做 canonical 实体」判断 salience，未按「这个名字会复现多少次」判断 —— 预测错了对象 | ⚠️ 偏差 |
| "a note that's wrong from the start … can be read, and trusted, by Claude in a later session" | `特南特` 正是这样一条从一开始就错、却标 `confirmed` 的 note | ✅ 完全命中 |

文章里 Pokémon 那个例子的因果链几乎逐字对应：错误的 PokéCenter 位置 note → 三次走回旧路线 → "I'm going to stop rather than keep looping"；dreaming 拿 session transcript 一校验就改对了。此处：**错误的图谱 note → 因「此前译文未用过」被排除 → 于是译文里永远不出现它 → 于是永远不满足排除条件**，比文章里那条更糟，是一个自锁循环。

---

## 5. 根因归纳

1. **分类错误**：把「约定（decision）」当「事实（fact）」做证据门槛。事实需要独立佐证；约定只需要「定一次、之后照做」。专名属于后者。
2. **价值函数错配**：fail-closed 优化的是「不传播错误译名」，但读者代价主要来自「同一人物两个名字」。一致性优先，且首次决定是可撤销的（用户确认永远可覆盖）。
3. **ground truth 未接入**：`translation_results` 是系统里唯一确定发生的事件，却完全没进入记忆写入回路；`targetConfidence=corroborated` 是模型对自己输出的评价，不是证据。
4. **无写入时机的分工**：文章主张「in-session 快速捕获 + offline 慢速整合」。本项目只有前者（且捕获错对象），没有后者。
5. **并发可见性缺口放大一切**：波内冻结 + one-shot session，让「没有决定」从「偶发不一致」升级成「必然不一致」。

---

## 6. 改进方案（按优先级）

### P0 — 止血：run 级命名决定表（最小改动，2 处）

目标：立刻止住**同一 run 内**的漂移。对应已有 plan 的 Phase 2 / Phase 3。

1. 新建 `run_name_decisions` 表（`run_id, normalized_source, target, decided_ordinal`，`INSERT OR IGNORE`，**首次写入即锁定**）。
   - run 开始时预计算一次，解析顺序：
     `用户确认 > 已采纳译文实际用过的 target（多数，平局取最早 ordinal） > 文学记忆 entity（须带真实译文证据） > 图谱 suggestedTranslation（仅当存在对齐的真实译文证据）`。
   - **只含 name → 译名，不含 role / traits / 关系**，因此不受剧情时间边界约束，也不会泄漏后文身份反转。
   - `特南特` 这类 0 命中的图谱 target 必须被排除（可加断言/诊断计数）。
2. 每批 brief 把它作为 `sourceStatus: 'run-canonical'` 注入 `contextGraph.nameMappings`。
   已有的 `buildCanonicalTermProtections`（`canonicalTermProtection.ts:113`）会自动只在源文出现该名字时生成掩码，
   第一批和并行批次立即被覆盖，注入层仍然很小。
3. 同时修 `contextGraphBundle.ts:493-500`：图谱 target 在真实译文中 0 命中时，**回退到真实译文 target**，而不是整条丢弃。

> 复用现有机制，不新增 LLM 调用、不新增状态类型、不改 prompt 合同（`translationSchema.ts:112` 已经写明 `run-canonical` 的语义）。

### P1 — 结构性修复：加 dreaming（防跨 run 复发）

在 `commitRunContextMemory()`（`translationRun.ts:502`）之后增加一步离线整合，输入是 `translation_results(accepted=1)` + `source_segments`（就是文章说的 transcript ground truth）：

- 对已知源名扫描其中文表面；出现 >1 个 target 就按「用户确认 > 已采纳片段多数 > 最早 ordinal」定唯一 canonical。
- 写回 `literary_memory_revisions`：`targetEvidenceRefs` **必须**来自真实译文片段、`confirmationSource='consolidated'`、`targetConfidence` 由真实证据数决定。
- 修正图谱里 0 命中的 `suggestedTranslation`（`特南特 → 实际决定`），并留审计事件。
- 少数派译文进 `review_findings` 供一键统一，**不静默改写译文**。
- 把无冲突的 `consolidated` 条目提升到注入层（文章的 "float notes to the top of the memory hierarchy"），但保持 index 级体积。

### P2 — 让证据成为真证据 + 可观测性

- `translationBrief.ts:494-495` 的 `corroborated` 改查实际译文片段，而非 delta 自报；新增 `consolidated` 视为强来源。
- `canonical-terms.protected` 事件补 `protectedSources`（实际保护了哪些源名）和 `visibleButUnprotectedNames`（本批源文出现、却因 candidate 未保护的名字）。
  本次故障若有后者，日志里一眼可见，不必挖 SQLite。
- run 结束时输出一条 `translation.naming.consolidated` 汇总事件（冲突数、决定、被纠正的记忆条目）。

### P3 — 验收测试

1. 无先例名字在**首次出现批次**就拿到 protection（`protectedSources` 含该名字）。
2. 同一波两个并行批次输出同一译名。
3. 图谱里 0 命中的错误 note 被整合纠正，且下个 run 不再出现。
4. 回归：candidate 仍 fail-closed、不泄漏未来别名/剧情、用户确认优先级最高、`run-canonical` 不与项目确认译名冲突时按现有 `priorityFor` 处理。
5. 用 1.2 / 1.3 的 SQL 做数据回归：`4aa3b4ce` 这类混用 run 在新逻辑下应为 0。

### 风险与回滚

- 主要风险：把错误译名提升为 run canonical 后扩散到全书。缓解 —— 用户确认始终优先（现有 `priorityFor` 已保证）；`consolidated` 必须附真实译文 refs；所有决定与纠正都写事件、可审计、可回退；少数派译文不自动改写。
- 改动集中在 `local-agent-service`，可整体 revert，不影响 Worker 端与缓存链路。

---

## 7. 明确不做

| 不做 | 理由 |
|---|---|
| 全局放开 `candidate` 门槛 | 文章：「Injected memories use up valuable tokens, and an incorrect note can be carried into every session.」错误 note 会被带进每个 session（`特南特` 就是活例子） |
| 靠持久会话 / compaction 解决 | 文章明确把 in-context learning 和 compaction 排除在 agent memory 之外；且 `taskProfile` 本就 one-shot，持久会话会破坏 prompt cache 与并行度 |
| 把全量名词表塞进每个 prompt | 「longer instruction files reduce adherence」；应复用现有「源文出现才注入」的 index 式薄层 |
| 每批加一次「命名」模型调用 | 决定是确定性的（查表 + `INSERT OR IGNORE`），不需要 LLM |
| 静默改写历史译文 | 一致性修复必须可见、可选、可回滚 |

---

## 8. 附录：复现 SQL

```sql
-- 源文出现形态
SELECT CASE WHEN text LIKE '%T ENNENT%' THEN 'T ENNENT' ELSE 'Tennent' END AS form, COUNT(*)
FROM source_segments WHERE text LIKE '%Tennent%' OR text LIKE '%T ENNENT%' GROUP BY 1;

-- 译名分布
SELECT CASE WHEN translation_text LIKE '%坦嫩特%' THEN '坦嫩特'
            WHEN translation_text LIKE '%坦南特%' THEN '坦南特'
            WHEN translation_text LIKE '%特南特%' THEN '特南特' END AS variant,
       COUNT(*) n, SUM(CASE WHEN accepted=1 THEN 1 ELSE 0 END) accepted
FROM translation_results
WHERE translation_text LIKE '%坦嫩特%' OR translation_text LIKE '%坦南特%' OR translation_text LIKE '%特南特%'
GROUP BY 1;

-- 同 run 内分叉
SELECT substr(run_id,1,8) run,
       SUM(translation_text LIKE '%坦嫩特%') nen,
       SUM(translation_text LIKE '%坦南特%') nan
FROM translation_results
WHERE translation_text LIKE '%坦嫩特%' OR translation_text LIKE '%坦南特%'
GROUP BY run_id ORDER BY MIN(created_at);

-- brief 里的映射状态（注意：brief_json 里提到名字 ≠ 有 nameMappings 条目）
SELECT json_extract(m.value,'$.sourceStatus') st, json_extract(m.value,'$.target') tgt, COUNT(*) n
FROM translation_briefs b, json_each(b.brief_json,'$.contextGraph.nameMappings') m
WHERE json_extract(m.value,'$.source')='Tennent' GROUP BY 1,2;

-- 图谱节点 vs 真实译文
SELECT name, status, json_extract(attributes_json,'$.suggestedTranslation') suggested,
       json_extract(attributes_json,'$.adoptionSource') adoption
FROM context_graph_nodes WHERE name LIKE '%ennent%';
SELECT COUNT(*) FROM translation_results WHERE translation_text LIKE '%特南特%';

-- 冲突被写进 openQuestions 而不是决定
SELECT value FROM literary_memory_revisions r, json_each(r.memory_json,'$.openQuestions')
WHERE r.rowid=(SELECT MAX(rowid) FROM literary_memory_revisions)
  AND (value LIKE '%ennent%' OR value LIKE '%坦嫩特%' OR value LIKE '%坦南特%');
```

---

## 9. 状态

- 本报告为**只读诊断**，未改动任何代码或数据。
- 结论已同步到 `.workbuddy-ai/memory/2026-11-13.md`。
- 建议按 **P0 → P1** 落地：P0 单独做就能止住同一 run 内的漂移，P1 才解决跨 run 反复与错误记忆自锁。
