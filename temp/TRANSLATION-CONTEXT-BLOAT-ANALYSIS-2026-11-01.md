# 翻译上下文膨胀分析报告

- 日期：2026-11-01
- 范围：`local-agent-service` 文学翻译的 TranslationBrief 组装与注入
- 触发问题：单批仅 5 个待译片段，`translation-brief assembled` 却报出 101,842 字符，`voice-context built` 报出 78,736 字符
- 原始诊断结论：**上下文已失控。10 万字符的 prompt 里，真正要翻译的原文只占 6.6%。**
- 后续状态：本报告第 8 节记录了基于证据实施的代码修改；原始统计仍代表修改前的历史运行。

本报告只做诊断，不含代码改动。所有数字来自本机 SQLite（`translation_briefs`、`project_events`）与 `~/.vocal-saga-local-agent/logs/local-agent.log`。

---

## 1. 摘要

| 指标 | 实测值 |
|---|---:|
| 待译片段（batch 1） | 5 段 / 6,901 字符 |
| TranslationBrief | 101,842 字符 |
| 实际 user prompt | 109,393 字符 |
| 其中原文 `segments` | 7,212 字符（**6.6%**） |
| 其中 `voiceContext.recentExamples` | 75,261 字符（**68.8%**） |
| 其中 `contextGraph.nameMappings` | 15,692 字符（14.3%） |
| 与原文相关的 nameMappings | 2 / 82 条 |
| 与原文相关的前文之外内容 | 78 / 82 条映射既不在本批也不在前 4 段 |

一句话归因：**`recentExamples` 无任何数量/字符上限，把同一章节此前已采纳的全部译文（134 段）整章回灌；`contextGraph.nameMappings` 又把全书 82 条实体映射整表注入，二者合计占 prompt 的 83%。**

---

## 2. 证据

### 2.1 字符构成（run `3bd43da3` / batch 1）

| 区块 | 字符 | 占 brief | 说明 |
|---|---:|---:|---|
| `voiceContext` | 78,736 | 77.3% | |
| ├ `recentExamples` | **75,261** | **73.9%** | 134 条，每条约 650 字符 |
| ├ `entities` | 970 | 1.0% | 只有 5 条，已做可见性过滤 |
| ├ `constraints` | 666 | 0.7% | 固定文案 |
| └ `chineseEditorialProfile` | 1,310 | 1.3% | |
| `contextGraph` | 20,185 | 19.8% | |
| ├ `nameMappings` | **15,692** | **15.4%** | 82 条 |
| └ `styleGuide` | 3,937 | 3.9% | status = `candidate`，origin = `legacy-unknown` |
| `precedingSegments` | 2,414 | 2.4% | 4 段，与 recentExamples 完全重复 |
| `contextDiagnostics` | 2,367 | 2.3% | 仅诊断用，不进 prompt |

### 2.2 recentExamples 的真实内容

- 134 条，`segmentId` 无重复，`source` 无重复（不是重复注入）。
- 全部来自同一章 `d3e211`，ordinal **11..144 连续无缺口**。
- 全部 `origin = agent`（机器自动采纳，非人工确认）。
- 该章当前 `accepted = 1` 的译文共 141 条 → 本次取 134 条，说明**选择数量直接等于"这一章已译完多少"**。

即：这不是"风格示例"，是"这一章前面半本书"。

### 2.3 nameMappings 的相关性

- 82 条映射，全部 `confirmationSource = model-default`（78 条 `sourceStatus = candidate`，4 条 `auto`），**0 条人工确认**。
- 只有 **2 条**出现在本批 5 段原文中。
- 加上前 4 段，仍有 **78 条**既不在本批也不在前文（`George Sand`、`rue Saint-Hilaire`、`Cathédrale de Chartres`、`Balbec`、`Golo`、`Barbe-Bleue` …）。
- `batch.prompt.ready` 的 `protectedCanonicalTermCount = 0` —— 这 82 条映射一次都没有触发 `__VSA_TERM_` 保护。

同一份记忆在两条路径上过滤不一致：`voiceContext.entities` 只留 5 条，`contextGraph.nameMappings` 留 82 条。

### 2.4 重复传入

唯一确认的重复：`precedingSegments` 的 4 段（`00141`–`00144`）**100% 同时出现在 `recentExamples` 中**，源文与译文完全相同，2,414 字符被发送两次。

其余无重复：prompt 中的 `translationBrief` 仅 406 字符元数据，`voiceContext` 只序列化一次。

---

## 3. 根因

### 根因 1（主因）：`recentExamples` 被设计成无上限

`local-agent-service/src/documents/translationBrief.ts:398-425`

```ts
// Select a compact, diverse set rather than injecting every historical match. ...
// Do not impose a fixed number/character budget on retrieved examples. Preserve every
// relevant, materially different accepted example; filter by relevance and source similarity,
// not by arbitrary context-size heuristics.
if (redundant && row.sharedNamedEntity === 0 && row.exactPhrase === 0) continue;
```

代码里明确写死了"不要设数量/字符预算"。唯一的淘汰条件是 **Jaccard ≥ 0.85 的冗余**，而连续段落之间的 Jaccard 远低于 0.85，因此全量保留。

### 根因 2：候选 SQL 的"同章节"分支把所有历史译文拉进来

`translationBrief.ts:345-371`

```ts
const candidateClauses = [
  's.ordinal >= ?',                                        // 最近 250 段
  ...(currentChapterParams.length ? ['s.context_path IN (...)'] : []),  // 同章节
  "tr.origin = 'manual'",
  ...candidateTerms.map(() => 'instr(lower(s.text), lower(?)) > 0'),
];
// ...
'ELSE 2 END, s.ordinal DESC LIMIT 1200'
```

`OR s.context_path IN (当前章)` 使"同章全部已采纳译文"无条件成为候选，只靠 `LIMIT 1200` 兜底。随后只按 `shared >= 2` 个词重叠过滤 —— 同一章同一文风的段落几乎必然满足。

### 根因 3：预算常量被硬编码为 100 万字符，`contextBudgetChars` 是空转旋钮

| 位置 | 内容 |
|---|---|
| `translationBrief.ts:14` | `export const MAX_TRANSLATION_BRIEF_CHARS = 1_000_000;` |
| `translationBrief.ts:749-752` | `// strategy.contextBudgetChars remains a legacy preference, not a hard ceiling.` → `const maxBriefChars = MAX_TRANSLATION_BRIEF_CHARS;` |
| `translationBrief.ts:1067` | 诊断里把 `contextBudgetChars` 记成 `maxBriefChars`（=1,000,000） |
| `projectStore.ts:77/89/111` | 策略字段默认 18,000，clamp 4,000–18,000 |
| `translationAgent.ts:1663` | `contextBudgetChars: strategy.contextBudgetChars` —— **只写进 `plan.ready` 事件，从不参与裁剪** |

后果：扩展 UI 上的"上下文预算"设置完全无效。诊断显示 `contextBudgetChars: 1000000`、`budgetTrimCount: 0`、`acceptedExamplesTrimmedByBudget: 0`。

### 根因 4：`nameMappings` 绕过了可见性过滤

`contextGraph.ts:2459-2466` 对图内候选有 `appearsInContext(row.name)` 过滤（43 条候选剔掉 40 条），但最终注入的 82 条来自**项目实体表整表**（`memoryEntityCandidates: 82` / `temporallyVisibleMemoryEntities: 82`），没有逐批的"本批是否出现"判断。

`voiceContext.entities` 有该判断（结果 5 条），`contextGraph.nameMappings` 没有（结果 82 条）。

### 根因 5：`precedingSegments` 与 `recentExamples` 没有互斥

`translationBrief.ts:721-723` 取最后 4 段作为前文，`recentExamples` 的选取范围包含这 4 段，二者未做差集。

### 二次效应：同一章越译越大

| run | batch | brief 字符 | nameMappings |
|---|---:|---:|---:|
| `23e4932f` | 1 | 37,335 | 24 |
| `23e4932f` | 14 | 44,831 | 72 |
| `3bd43da3` | 1 | 101,842 | 82 |
| `3bd43da3` | 2 | 104,639 | 82 |

单次 run 内 +20%；同章下一次 run 直接翻 2.4 倍。**后一批在为前一批的译文付费，且无上界。**

---

## 4. 成本实证

### 4.1 同任务，examples 32 → 134 导致审校 token 翻倍

| run | examples | brief 字符 | review input tokens |
|---|---:|---:|---:|
| `23e4932f` | 32 | 37k–47k | 24,711 – 27,864 |
| `3bd43da3` | 134 | 102k–105k | **49,035 / 51,520** |

审校任务本身、片段数量、模型均未变化，token 增加 1.9 倍全部来自 examples。

### 4.2 单批耗时与 token

| batch | 片段 | 原文字符 | user prompt | total input tokens | turns | 翻译耗时 | 审校耗时 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 6,901 | 109,393 | 101,910 | 4 | 55.3s | 51.2s |
| 2 | 2 | 2,404 | 107,584 | **208,326** | 6 | 7.7s | 31.9s |

关键异常：**batch 2 只有 2 段，input token 却是 5 段的 2 倍。** 原因是上下文按 agent turn 重复计费 —— 约 4 万 token 的 prompt 被读 6 遍。

7 个片段合计约 310k 翻译 input tokens + 100k 审校 input tokens，墙钟 ~107s。

---

## 5. 推荐修改

按收益/风险比排序。每条都给出验收指标。

### P0-1 给 `recentExamples` 设硬上限

- 位置：`translationBrief.ts:398-425`
- 改法：
  1. 增加 `MAX_ACCEPTED_EXAMPLES = 8` 与 `MAX_ACCEPTED_EXAMPLE_CHARS = 4000`。
  2. 现有 `scoredExamples` 已按 `score` 排序，直接在循环里累加字符数，超限即 `break`。
  3. 保留现有 Jaccard 去重逻辑（它是正交的，不冲突）。
- 不要做：不要按"来源相似度"重排 —— `score` 已经包含 `overlap*6 + exactPhrase*2 + sharedNamedEntity*3.2 + sameChapter*0.8 + recency`，是合理的排序依据。
- 验收：batch 1 的 brief 从 101,842 → 约 32,000（-69%）；review input tokens 从 50k → 约 18k。

### P0-2 `recentExamples` 与 `precedingSegments` 互斥

- 位置：`translationBrief.ts:402` 循环内
- 改法：`if (selectedPrecedingIds.has(row.segmentId)) continue;`
- 验收：4 段前文只出现一次，-2,414 字符。

### P0-3 `nameMappings` 按本批可见性裁剪

- 位置：`contextGraph.ts` 的 `nameMappings` 汇总处（当前 82 条来自实体表整表）
- 改法：复用 `voiceContext.entities` 已经在用的可见性判断（`appearsBefore(...) || items.some(...)`），与 `entities` 保持一致。
- 保守降级方案（若担心误伤专名保护）：保留全部映射用于 `__VSA_TERM_` 保护，但**注入 prompt 的 `nameMappings` 只保留本批可见的子集**。
- 验收：82 → 约 5 条，-15.3k 字符；`protectedCanonicalTermCount` 不变（当前为 0）。

### P1-1 让 `contextBudgetChars` 真正生效，或移除

- 现状：字段存在、UI 可调、被 clamp 到 18,000，但完全不参与裁剪，是纯空转旋钮。
- 两个选项：
  - A（推荐）：把它当作 `recentExamples` + `precedingSegments` + `nameMappings` 的软预算，超限时按 `score` 从低到高裁剪，并如实写 `budgetTrimCount`。
  - B（更省事）：从策略、UI、`plan.ready` 事件中删除该字段，避免误导。
- 不要做：保留字段但继续不生效。

### P1-2 短批次合并，削掉 per-turn 乘数

- 现象：2 段批次付 6 轮上下文（208k input tokens）。
- 改法：在 `buildBatches` 之后加一步合并——当某批 `sourceChars < 3000` 且相邻批合计仍低于 `maxBatchSourceChars` 时合并。或者限制单批最小片段数（如 ≥4，除非是末尾残批）。
- 验收：2 段级批次的 input token 降到 5 段批次以下。

### P2-1 审校侧不要重复携带全量 brief

- 现状：审校调用携带 `voiceContext`（78k）+ brief 元数据（107k JSON 快照），与翻译侧同量级。
- 改法：`review.audit.input` 的落库可以保留快照，但实际发给模型的 `voiceContext` 应复用裁剪后的版本（P0-1 完成后自动收敛）。
- 验收：review input tokens 与 translate 同比例下降。

### P2-2 区分"候选"与"已确认"的注入优先级

- 现状：82 条映射全部 `model-default`，`styleGuide` 为 `candidate` / `legacy-unknown`，却与人工确认内容同权注入。
- 改法：`candidate` 类映射只在原文命中时注入；`styleGuide` 在 `candidate` 状态下只注入 `narrativeStyle` 摘要，不注入全文（当前 3,937 字符）。
- 验收：未确认内容占比从 100% 降到接近 0（仅在命中时出现）。

---

## 6. 不要做的事

| 做法 | 为什么不行 |
|---|---|
| 把 `recentExamples` 全删 | 它是唯一提供"已采纳译文风格"的信号，删掉会退回纯 prompt 翻译。要限量，不要删除。 |
| 降低 `must_fix` 阈值来省审校成本 | 与本问题无关，且会放行误译。 |
| 把 `budgetTrimCount` 直接当成功指标 | 只有当裁剪发生在"低分项"上才有意义；按插入顺序裁会裁掉高分证据。 |
| 只调 `documentContextBudgetChars` 的 UI 默认值 | 该值当前不生效（根因 3），改了也没用。 |

---

## 7. 复现与验证方法

```bash
# 单批 brief 构成
sqlite3 ~/.vocal-saga-local-agent/documents/<projectId>/project.sqlite \
  "SELECT batch_index, brief_chars, json_array_length(source_segment_ids_json)
   FROM translation_briefs WHERE run_id='<runId>' ORDER BY batch_index;"

# recentExamples 数量与章节分布
sqlite3 ... "SELECT json_extract(brief_json,'$.contextDiagnostics.acceptedExamplesInjected'),
                    json_extract(brief_json,'$.contextDiagnostics.acceptedExamplesTrimmedByBudget')
             FROM translation_briefs WHERE run_id='<runId>';"

# 真实请求体量与 token
sqlite3 ... "SELECT json_extract(payload_json,'$.sourceChars'),
                    json_extract(payload_json,'$.userPromptChars')
             FROM project_events WHERE run_id='<runId>' AND event_type='batch.prompt.ready';"
```

修改后的验收：`acceptedExamplesInjected <= 8`、`acceptedExamplesTrimmedByBudget > 0`、`brief_chars < 40000`、`review input tokens < 20000`。

---

## 附录：数据来源

| 项目 | 值 |
|---|---|
| projectId | `8f9a86bd-0478-4eed-bec1-83be72140bf4` |
| 主分析 run | `3bd43da3-18b9-473a-bd10-87078b842c27`（2 批 / 7 段） |
| 对照 run | `23e4932f-5ae9-4fba-900f-3bc1b257b154`（14 批） |
| 源书 | À la recherche du temps perdu（fr → zh），章节 `d3e211` |
| 模型 | `glm-5.3-flash`，thinkingMode=enabled，effort=low |


---

## 8. 代码修改与复核结果（2026-11-01）

根据上述证据，已在 `main` 实施以下修改：

### 已实施

1. **限制历史译例注入**
   - `recentExamples` 最多 8 条。
   - 字符预算最高 4,000；实际预算为 `min(4,000, max(1,000, floor(contextBudgetChars × 25%)))`。
   - 继续使用原有相关性得分排序和 Jaccard 多样性去重；超预算时保留高分项，不按数据库返回顺序截断。
   - 预算按每条完整 JSON 译例计算，并预留数组分隔符/括号开销。

2. **消除 preceding 重复**
   - 已进入当前批次配置的 `precedingSegments` 的 segment ID，会从 `recentExamples` 中排除。
   - 增加 `acceptedExamplesExcludedAsPreceding` 诊断计数。

3. **让 contextBudgetChars 有实际作用**
   - 该设置现在控制可选历史译例预算，不再是完全空转的配置。
   - 明确它是软预算，不是整个 TranslationBrief 的硬截断值。当前原文、前文、术语、当前可见名称映射和有证据的人物声音信息不会为了满足该预算而被删除。
   - README 和架构文档已同步修正字段语义，避免把它描述成整个上下文的硬上限。

4. **补充诊断与回归测试**
   - 记录 `acceptedExampleBudgetChars`、`acceptedExampleChars`、`acceptedExamplesInjected`、`acceptedExamplesTrimmedByBudget` 和 `acceptedExamplesExcludedAsPreceding`。
   - 新增回归测试覆盖历史译例预算和 preceding 去重。
   - 更新 TranslationBrief policy version 为 `translation-brief-v10-bounded-examples`。

### 对原报告其他建议的复核

- **nameMappings：不重复修改。** 当前 main 的 `translationBrief.ts` 已在合并动态记忆和人物映射后，再按当前 batch + 配置 preceding segments 做最终过滤；`contextGraph.ts` 也有源文可见性过滤。原始 Bundle 中的 82 条全量映射属于旧运行行为。没有再添加数量 cap，避免误删当前上下文真正命中的专名。
- **styleGuide：不按旧 Bundle 的 legacy 状态推断当前行为。** 当前组装逻辑要求机器分析版本匹配且字段完整，或存在用户确认/编辑的 style guide，才会将其注入；旧的 `legacy-unknown` 数据不会仅凭存在就获得注入资格。
- **Reviewer：复用同一份 TranslationBrief。** 历史译例在 brief 构建阶段已被限制，翻译和 Reviewer 共用这份快照，因此无需另造一套 Reviewer 侧裁剪逻辑。
- **短批次合并：暂不实施。** batch 合并会改变原有章节边界、批次并发和失败重试粒度；目前的 token 统计说明多轮调用放大成本，但不足以证明合并批次不会损害运行语义。应先用新诊断数据确认上下文收敛后的实际请求轮数和 token，再单独评估。
- **不降低 Reviewer 的质量阈值，也不删除 recentExamples。** 历史译例仍提供已采纳译文的风格参考，只限制数量和体量。

### 预期验收

下一次运行应重点核对：

- `acceptedExamplesInjected <= 8`
- `acceptedExampleChars <= acceptedExampleBudgetChars <= 4000`
- `acceptedExamplesExcludedAsPreceding` 在前文也命中已采纳译文时大于 0
- `graphMappingsExcludedNotMentioned` 继续反映批次外映射的排除数量
- TranslationBrief 字符数和 Reviewer input tokens 应明显下降；具体降幅以新 Bundle 为准，不以旧数据推算为测试结果。

本次代码通过 GitHub 直接提交到 `main`。当前执行环境没有本地仓库，因此未在本地运行测试；GitHub Actions 的 Local Agent Service workflow 已在 commit `264125e1c759c2b587197788bc8f3e3ef236983b` 对应代码上通过：322 tests、TypeScript typecheck、API route manifest drift 检查和 deterministic book-scan benchmark 均成功。完整仓库 CI workflow 仍在执行中。
