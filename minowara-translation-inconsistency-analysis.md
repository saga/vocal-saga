# Minowara 译名分裂分析报告（米诺原 / 源氏）

项目：Shogun（`4fa564de-b0ec-485d-88dc-562ad1bf66d3`）
运行：`58cf7980-092b-4629-a8d2-931842efed52`，2026-10-26 06:33:04 → 06:40:19，模型 `glm-5.3-flash`
分析时间：2026-10-26

---

## 一、结论

不是"模型里没有这个词"，也不是模型随机抖动。是**同一波次的两个批次在完全隔离的上下文里各自给同一个专名起了名字**，而流水线没有在两者之间做仲裁。

- **s769（批次 1 最后一段）→ 米诺原**：模型把它当陌生音译名，按 Mi-no-wa-ra 硬译。
- **s770/772/774/775（批次 2）→ 源氏**：模型认出它是《幕府将军》里 Minamoto（源氏）的化名，主动"归化"成现实家族名。

分界线精确落在批次缝上，不是章节缝，也不是随机分布。

| 译名 | 段落 | 批次 |
|---|---|---|
| 米诺原 | s769 | 批次 1（s754–s769） |
| 源氏 | s770 / s772 / s774 / s775 | 批次 2（s770–s785） |
| 蓑原 / 美浓原 | 全书 0 处 | —— |

全书目前只译了 179 段，含 Minowara 的源段共 40 段、已译 5 段，所以问题才刚露头。

---

## 二、证据链

### 2.1 两个批次各自产出的实体候选（`translation_context_deltas`）

批次 1：

```json
{"canonicalSource":"Minowara","kind":"organization","targetProposal":"米诺原",
 "evidence":[{"segmentId":"s769","sourceQuote":"the Minowara, Fujimoto and Takashima"}],
 "reason":"武士家族名，本批音译，供后续核对统一。"}
```

批次 2：

```json
{"canonicalSource":"Minowara","kind":"other","targetProposal":"源氏",
 "evidence":[{"segmentId":"s770","sourceQuote":"the Minowara Shōguns dominated the realm"},
             {"segmentId":"s775","sourceQuote":"was descended from the Minowara"}],
 "reason":"本书虚构的古老半神家族之一，与高岛、藤本并列；按源氏一门的语感处理"}
```

两句 `reason` 直接说明了分裂性质：批次 1 明确知道自己在"音译"，批次 2 明确知道自己在"按源氏的语感处理"。**两个模型都在有意识地做选择，只是选择不同。**

### 2.2 两个批次的 brief 里都没有 Minowara

| 批次 | 段范围 | nameMappings 条数 | Minowara | glossary 条数 |
|---|---|---|---|---|
| 1 | s754–s769 | 27 | **无** | 0 |
| 2 | s770–s785 | 28 | **无** | 0 |
| 3 | s786–s788 | 36 | `Minowara→米诺原 [candidate]` | 0 |

批次 1、2 的提示词里没有任何一处提到这个名字该译成什么。既没有 `nameMappings`，也没有 `glossary.document_terms`（本次运行的术语表为空），也没有 `recentExamples`（该字段根本不在 brief 结构里）。

### 2.3 运行时序（`project_events`）

```
06:33:04.340  translation.context-wave.ready  waveIndex=1  memoryEntityCount=78
06:33:08.703  translation-brief.ready         batchIndex=1   ← 用同一份冻结记忆构建
06:33:09.346  translation-brief.ready         batchIndex=2   ← 用同一份冻结记忆构建
06:33:45.293  translation.context-delta.saved batchIndex=1   ← 米诺原 此刻才写入
06:34:03.951  translation.context-delta.saved batchIndex=2   ← 源氏 此刻才写入
06:34:03.987  translation.context-wave.ready  waveIndex=2  memoryEntityCount=87
06:34:04.323  translation-brief.ready         batchIndex=3   ← 才第一次看到 Minowara→米诺原
```

批次 2 的 brief 比批次 1 的产出**早 37 秒**生成，因此结构上不可能看到"米诺原"。

### 2.4 冲突被检测到，但只写进了一条没人看的记录

06:40:19 记忆落盘事件：

```json
{"addedEntities":2,"mergedEntities":1,"entityTargetConflicts":1,"addedOpenQuestions":2}
```

记忆里的冲突记录原文：

> 候选译名存在冲突："Minowara"已有"米诺原"，新批次提出"源氏"；需人工核对原文证据。

这条记录（`memory.openQuestions`）**不会出现在界面上**。扩展只在角色画像里渲染 `profile.openQuestions`（`App.vue:717`），项目级 `memory.openQuestions` 没有任何展示入口。所以冲突事实上是静默的。

---

## 三、五个分层原因

### 原因 1（结构性，主因）：同波次批次互相不可见

`translationAgent.ts:1932-1955`：

```ts
// 每一波最多 translationConcurrency 个批次并行。波次开始时冻结同一份上下文；
// 当前波的候选不允许竞态地流入同波其他批次，只在全部结束后供下一波使用。
for (let offset = 0; offset < batches.length; offset += translationConcurrency) { ... }
policy: 'freeze-within-wave; merge-in-source-order-between-waves'
```

`translationConcurrency` 默认 2（本次 `plan.ready` 里也是 2）。于是：

- 波 1 = 批次 1 + 批次 2，共享**同一份**记忆快照，谁也不知道谁；
- 只有波 2 的批次 3 才吃到波 1 的产物。

这个设计本身是为了防止竞态和"用后文污染前文"，方向没错，但代价是：**同一本书的相邻两批，在没有任何既有约定的情况下，必然各自发明译名**。批次数越多，分裂点越多。

### 原因 2（模型行为）：虚构专名被"归化"成现实名，没有规则禁止

`Minowara` 是 Clavell 为规避版权把 `Minamoto`（源氏）改写出来的名字。模型的知识库里有这层对应关系，于是批次 2 直接输出"源氏"。

但提示词里没有任何一条规则说"虚构专名必须音译、不得替换为现实世界的对应名称"。现有规则只有（`translationAgent.ts:116-137`）：

- 优先沿用**已确认**的专名；
- `candidate` 映射仅供参考；
- 头衔与人名分开处理；
- 不得原样保留源语言单词。

全是"有约定时怎么办"，没有"没约定时怎么造名字"。所以两个批次都合法地自由发挥。

### 原因 3：没有约定可用 —— 术语表为空，人物管理里也没有这个名字

- `glossary.document_terms` 本次运行 0 条（`filterGlossaryForBatch`，`translationBrief.ts:600`）。
- 记忆里 78 个实体，`Minowara` **一条都没有**（06:40 之前的历史版本全部无此条）。
- `context_graph_nodes` 里也查不到 Minowara / Minamoto 节点。

也就是说：这个专名在整个上下文体系里从未被登记过。用户现在在"人物管理"里看到的那条 `Minowara → 米诺原（suggested）`，**是这次运行结束后（06:40:19）才由流水线自己回写进去的**——即"模型的第一次自由发挥被自动固化成了候选规范"。

### 原因 4：即使现在去确认，首次出现的那一批仍然会漏

`translationBrief.ts:826-835`：

```ts
const explicitCanonicalMapping = entity.reviewStatus === 'confirmed' &&
  (entity.kind === 'person' ||
    ((!Array.isArray(entity.evidenceRefs) || entity.evidenceRefs.length === 0) && !evidence));
const evidenceVisible = explicitCanonicalMapping ||
  (entity.evidenceRefs.length
    ? visibleEvidenceRefs.length > 0      // 要求 ref.ordinal < firstOrdinal
    : ...);
if (!evidenceVisible) continue;
```

这条实体的 `kind` 是 `organization`，且带 `evidenceRefs: [s769]`。于是：

- 批次 3 之后（firstOrdinal ≥ 786）：769 < 786 成立 → 映射生效；
- **批次 1（firstOrdinal = 754）：769 < 754 不成立 → 映射被丢弃**。

只有 `kind === 'person'` 的已确认映射才享受"首次出现即生效"的豁免。组织/家族类名字没有。结果就是：用户在人物管理里把它改成"蓑原"，重译这一章时 **s769 依然会重新自由发挥**，后面几段才是蓑原——分裂点从批次缝变成了段落缝。

### 原因 5：候选映射不产生任何强制力，自我修复链断在第一步

- 批次 3 拿到的 `Minowara→米诺原` 状态是 `candidate`；
- `buildCanonicalTermProtections` 的 `priorityFor('candidate')` 返回 0（`translationAgent.ts:375-385`）→ 不生成 `__VSA_TERM__` 标记 → 无保护；
- 提示词明说 `candidate` 只是线索、不得当成强制规范（`translationAgent.ts:117/132`）。

升到 `auto` 需要 `targetConfidence === 'corroborated'`，即**至少两个不同段落**的目标译文表面独立佐证（`translationBrief.ts:842-851`）。Minowara 只有 s769 一个证据段 → 永远停在 candidate。

而唯一可能提供第二条佐证的批次 2 提案（源氏），在合并时被判为冲突直接丢弃（`translationContextDelta.ts:398-403`，保留先到的、只写 openQuestion）。**冲突处理掐死了自动升级路径。**

---

## 四、为什么"人物管理"没起作用

| 期望 | 实际 |
|---|---|
| 人物管理里确认译名 → 全书统一 | Minowara 从未被确认过，这次运行前库里没有这条 |
| 运行中发现问题 → 后续批次纠正 | 同波次批次隔离，纠正不了 |
| 冲突被检测 → 提示用户 | 检测到了，但只写进 `memory.openQuestions`，界面不展示 |
| 候选映射逐步升格为强规范 | 需要 2 段佐证；第二段佐证被冲突丢弃，升不上去 |

对比上次 Yabu 的问题：Yabu 是"**确认过的映射被别名闸门丢弃**"；Minowara 是"**从来没被确认过，且首次出现的批次没有豁免**"。两者是同一套 fail-closed 闸门在不同侧的失效。

---

## 五、这不是孤例

同一份记忆里已经积压了 5 条同类冲突（`memory.openQuestions`）：

```
"Osaka Castle" 已有"大阪"，新批次提出"大坂城"
"Minowara"     已有"米诺原"，新批次提出"源氏"
"Ikawa Jikkyu" 已有"井川峠"，新批次提出"井川实久"
"Yedo"         已有"京都"，新批次提出"江户"
"SHŌGUN"       已有"将军"，新批次提出"《幕府将军》"
```

其中 "Yedo 已有京都" 说明前文某批把 Yedo（江户）错译成了京都，且被固化下来。这些全是同一条路径的产物：**自由发挥 → 首个提案固化 → 后续批次不认 → 冲突静默入库**。

---

## 六、修复方向（按性价比排序，未改代码）

| 优先级 | 改动 | 说明 |
|---|---|---|
| P0 | 项目级 `openQuestions`（尤其实体译名冲突）在人物管理里可见，并提供"采纳哪一个"的一键操作 | 现在冲突检测完全白做；这是唯一能让用户介入的入口 |
| P0 | 跨波次之外，同波次也要有**命名预冻结**：第一批完成前，先用一次轻量分析（或首批串行）确定本波涉及的新专名 | 直接把"批次缝"这个分裂点消掉；成本是一次小调用或把并发降到 1 |
| P1 | 提示词补一条硬规则：**虚构专名一律音译，不得替换为现实世界的对应名**（源氏、德川这类归化要显式禁止） | 批次 2 的 `reason` 证明模型是主动归化，规则能直接压住 |
| P1 | 组织/家族类（`kind !== 'person'`）的已确认映射也享受"首次出现即生效"豁免 | 否则用户改了名字，重译首段还是错的 |
| P2 | 冲突发生时，若后到提案来自**更早的段落**（s770 > s769，不适用；但反向场景适用），应允许覆盖先到提案 | 目前"先到先得"与"源顺序"无关 |
| P2 | 单证据的 candidate 提供手动"升级为确认"的快捷入口 | 现状要求 2 段佐证，而 2 段佐证往往正是被冲突丢弃的那条 |

---

## 七、一句话回答用户的三个问题

1. **为什么出现"米诺原"**：批次 1 的提示词里没有任何该名字的约定，模型按读音硬译；这条自由发挥随后被流水线当作候选规范写回了人物管理。
2. **是模型里没有吗**：不是。模型两次都"知道"自己在做什么（`reason` 字段自述"本批音译"/"按源氏一门的语感处理"），缺的是**约定**和**禁止归化的规则**。
3. **为什么后面变成"源氏"**：批次 2 与批次 1 在同一波次并行、上下文互相隔离，模型独立地选择了归化到现实世界的源氏。
