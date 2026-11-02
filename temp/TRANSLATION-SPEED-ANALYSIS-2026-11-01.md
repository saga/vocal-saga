# 翻译运行日志分析（2026-11-01 08:13–08:22）

分析对象：

- 文件日志 `~/.vocal-saga-local-agent/logs/local-agent.log`（211 行 / 26,916 字节，08:13:07 → 08:22:28）
- 项目 `8f9a86bd-0478-4eed-bec1-83be72140bf4`（《À la recherche du temps perdu》EPUB）
  - `documents/8f9a86bd-…/project.sqlite` → `project_events` / `translation_briefs` / `run_segments`
- 覆盖两个 run：`723c0b97`（7 段 / 2 批）、`5034b08b`（38 段 / 4 批）

本次分析**未修改任何代码**。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| 上下文膨胀 bug 修好了吗？ | **修好了。** brief 从 101,842 字符降到 10,058–19,271 字符（−81% ~ −90%），`recentExamples` 从 134 条降到 2 条，voiceContext 从 78,736 降到 3,716–6,465。上限（`MAX_ACCEPTED_EXAMPLES=8` / `MAX_ACCEPTED_EXAMPLE_CHARS=4,000`）确实生效，诊断里 `acceptedExamplesTrimmedByBudget=142`（148 个候选只留 2 个）可以证明。 |
| 上一轮日志修复生效了吗？ | **生效。** 真实换行、`run started` / `review done` / `run finished`、轮询汇总（5,605 行 → 126 行）、`literary memory validated` 归零，全部落地。 |
| 最新日志有没有发现问题？ | **有，6 个新缺陷**，其中 2 个会让日志直接说谎（`[object Object]`、记录成错误的模型名），1 个让"为什么慢"完全无法从文件日志回答（文档翻译调用被整段静默）。 |
| 为什么还是慢？ | **瓶颈已经从"翻译"变成"审校"，而且审校跑在一台慢 3.4 倍的模型上、还被强制串行。** run `5034b08b` 386 秒里，翻译只占 102 秒，审校占 332 秒（86%）；所有翻译结束后还空转 284 秒（74%）在等审校。 |

一句话：**上下文不再膨胀了，现在是"审校串行 + 审校模型慢 + 每批固定开销重复 4 次"三重叠加。**

---

## 2. 上下文膨胀：确认已修复

### 2.1 修复前后对比

| 指标 | 修复前 `3bd43da3` | `723c0b97` b1 / b2 | `5034b08b` b1 / b2 / b3 / b4 |
|---|---|---|---|
| brief 字符 | 101,842 / 104,639 | 19,271 / 16,689 | 18,750 / 16,997 / 14,839 / 10,058 |
| `voiceContext` | 78,736 | 6,465 / 4,928 | 6,154 / 5,920 / 4,620 / 3,716 |
| `recentExamples` 条数 | 134 | 2 / 2 | 2 / 2 / 2 / 2 |
| `contextGraph` | 15,692 | 7,201 / 5,831 | 6,593 / 6,410 / 5,235 / 4,495 |
| `precedingSegments` | 2,414 | 5,147 / 5,602 | 5,415 / 4,183 / 4,344 / 1,362 |
| 翻译输入 token/批 | 49,035–51,520（2 段批） | 16,602 / 13,799 | 16,403 / 15,820 / 15,542 / 13,225 |

上限代码位置已核对：`translationBrief.ts:14-15`（`MAX_ACCEPTED_EXAMPLES = 8`、`MAX_ACCEPTED_EXAMPLE_CHARS = 4_000`）、`:788`（`exampleBudgetChars`）、`:431-438`（截断判定）。

### 2.2 但"膨胀"没有归零，只是换了形态

新的膨胀是**每批固定开销**，与批次里有几段无关：

| 字段 | 每批字符 | 性质 |
|---|---|---|
| `contextGraph.styleGuide` | 3,937 | **4 个批次逐字节相同** |
| `voiceContext.chineseEditorialProfile` | 1,106 | 逐字节相同 |
| `voiceContext.recentExamples` | 1,351–1,361 | 4 批几乎相同（同一批近期译文） |
| `contextGraph.constraints` | 258 | 逐字节相同 |
| `glossary` | 21 | 空（`document_terms: []`） |
| **合计固定开销** | **≈ 6,723** | |

以 b4 为例：7 段，brief 15,193 字符，其中 6,723（**44%**）是跨批完全重复的样板。4 个批次合计重复 ≈ 26,900 字符。

另外两个实测异常：

1. **`contextBudgetChars = 18000` 是死设置。** b1 的 brief 是 18,750 字符，超了 750，但诊断里所有 `*TrimmedByBudget` 全是 0。代码 `translationBrief.ts:1161-1164` 的注释明确写了"不要为了预算裁剪上下文"，所以这个配置项读进来、写进 `plan.ready`、然后完全不用。用户改它不会有任何效果。
2. **`nameMappings` 的可见性闸门算了但没生效。** 见下一节。

---

## 3. 新发现：`context-graph` 的可见性闸门与 brief 不一致

同一个批次（`5034b08b` b1），两处日志给出互相矛盾的答案：

```
[context-graph 08:15:32] bundle · firstOrdinal=159 · knowledgeBoundary=158
  · mappings=0 (strong=0, runCanonical=0, candidate=0) · nodes=0
  · excluded(nameNotVisible=40, evidenceNotVisible=1, ...)

[translation-brief 08:15:32] assembled · graphMappings=11 (strong=0)
```

`brief.contextDiagnostics` 里两套计数并存，正好暴露了原因：

| 管线 | 计数 | 结果 |
|---|---|---|
| 时间可见性闸门（`contextGraph.ts`，`bundle` 日志报的就是它） | 候选 43 − nameNotVisible 40 − evidenceNotVisible 1 − lowValue 2 | **0 条存活** |
| "本批没提到"过滤器（真正喂给 brief 的） | `graphMappingCandidatesBeforeBatchFilter=97` − `graphMappingsExcludedNotMentioned=86` | **11 条进入 prompt** |

也就是说：**闸门算出 0 条，brief 却带进去 11 条，2,100 字符。** 而且 `strongNameMappingsBeforeBudget = 0`——11 条全是 `sourceStatus: "candidate"`（未确认的猜测：Combray→贡布雷、Balbec→巴尔贝克、Théodore→西奥多……），`protectedTerms=0`。

在"零条强映射"的批次里塞 2.1k 字符的弱猜测，是当前 brief 里唯一还没被治理的浪费项。4 批合计 4,759 字符。

---

## 4. 日志缺陷：新日志暴露的 6 个问题

### 4.1 `run finished` 的用量被序列化成 `[object Object]`（严重）

```
run finished · … · status=completed · counts={"total":38,"accepted":38} · wall=386s · [object Object]
```

原因：`translationAgent.ts:2542` 用 `summarizeTurnUsage(takeRunUsage(runId))`，而 `summarizeTurnUsage`（`agents/usage.ts:78`）返回 `Record<string, unknown> | null`。`:2556` 用 `' · ' + finishedUsage` 字符串拼接，对象被强制转换。

后果：**run 级 token 总量、成本、`numTurns` 全部丢失。** 上一轮专门加这行就是为了回答"这次 run 花了多少"，现在它一个字都没输出。

修法：`JSON.stringify(finishedUsage ?? {})`，或复用已有的 `formatTurnUsageLog` 风格。

### 4.2 记录的模型名是错的（严重）

同一件事，三个地方三个答案：

| 位置 | 值 |
|---|---|
| `run started` | `model=auto` |
| `model.usage` / `batch.prompt.ready` | `model=glm-5.3-flash` |
| **实际执行**（`translation` taskProfile） | **`deepseek-v4.1-flash`** |

原因链：`translationAgent.ts:1037` `parseAgentModel('auto')` → `agent.model = 'glm-5.3-flash'`（`DEFAULT_WORKBUDDY_MODEL`）；`runner.ts:169-171` 在调用前把 `effectiveAgent.model` 换成 `taskProfile.model`；但 `model.usage`（`:1150`）、`batch.prompt.ready`（`:1086`）、`model.call.failed`（`:1161`）记录的都是**替换前**的 `agent.model`。

后果：**审计账本上写着 glm-5.3-flash，实际跑的是 deepseek-v4.1-flash。** 用户正在排查速度，看到的却是错的模型名——这条本身就会把人带偏。

修法：把 `effectiveAgent.model`（或 `taskProfile.model`）落到事件里，同时保留 `agent.model` 作为"请求模型"。

### 4.3 文档翻译调用在文件日志里完全静默（严重）

`runner.ts:39`：

```ts
function logModelStart(...) { if (isWorkflowManaged(sessionScope)) return; ... }
```

`logModelSuccess` / `logModelFailure` 同样。文档批次全部带 `sessionScope`（`document:…:run:…:bN`），因此**每一次翻译调用都没有"开始/完成/耗时/token"日志**。这就是为什么"为什么慢"必须去翻 SQLite 才能回答。

审校有 `[literary-review] token in=… out=…`（另一条路径），翻译一条都没有——同一个 run 里两个阶段的观测能力不对等。

### 4.4 `largestSections` 名不副实

`voiceContext.ts:773`：

```ts
const largestSections = Object.entries(sectionChars).slice(0, 6)…
```

按插入顺序取前 6 个，没有排序。所以每次都是同一组 editorial-profile 子字段：

```
largestSections=version:1,policyVersion:37,styleGuide:2,styleGuideStatus:11,styleGuideOrigin:16,chineseEditorialProfile:1106
```

而这一批 `chars=6465`，真正占大头的是 `recentExamples`(1,351) 和 `entities`(2,140)——**恰恰没被打印出来**。这行日志目前只能误导人。

修法：`.sort((a, b) => b[1] - a[1]).slice(0, 6)`。

### 4.5 `totalInputTokens` 双重计数

`usage.ts:80`：`totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens`。

但本机 provider 返回的 `cache_read_input_tokens` **恒等于** `input_tokens`（6 次审校调用无一例外）：

```
token in=11,987 cache=11,987 out=929
token in=17,483 cache=17,483 out=3,401
token in=16,440 cache=16,440 out=5,194   ← 全部 in == cache
```

按 `summarizeTurnUsage` 的算法，`totalInputTokens` 会是真实值的 2 倍（126,216 vs 实际 ~63,108）。这正是 4.1 那个 `[object Object]` 掩盖掉的数字。

修法：当 `cacheReadTokens >= inputTokens` 时按"已包含"处理，不要相加；或直接取 `Math.max(inputTokens, cacheRead + cacheCreation)`。

### 4.6 轮询汇总漏掉了 `/segments`

`POLLING_PATH_PATTERNS` 覆盖了 `/runs/:id`、`/events`、`/context-graph`，但 `GET /api/documents/projects/:id/segments` 在这次 9 分钟里被调了 **64 次**（约每 8 秒一次），全部逐条落盘。加上它，http scope 还能再降一半。

好消息：本次 **413 一个都没有**（上一轮 17 个），4xx/5xx 全零，`routeError` 的静默问题没有再复现。

---

## 5. 为什么还是慢

### 5.1 run `5034b08b` 的真实时间线（来自 `project_events`，非日志推算）

```
08:15:30.7  run 开始，38 段 / 4 批 / 并发 3 翻译 + 1 审校
08:15:32.3  b1 brief 就绪 → 翻译
08:15:33.4  b2 brief 就绪 → 翻译
08:15:35.2  b3 brief 就绪 → 翻译
08:16:24.9  b3 翻译完成（47.8s）→ 审校 b3 开始
08:16:28.9  b1 翻译完成（51.8s）
08:16:31.6  b2 翻译完成（54.5s）→ 翻译波次结束
08:16:33.1  b4 开始（等槽位等了 58s）
08:17:12.6  b4 翻译完成（37.6s）→ 全部翻译结束
08:18:01.0  b3 审校完成（96.1s）
08:18:45.0  b1 审校完成（44.0s）
08:20:40.9  b2 审校完成（115.9s）
08:21:56.9  b4 审校完成（76.0s）→ run 结束
```

| 阶段 | 墙钟 | 占 386s |
|---|---|---|
| 建 brief + 翻译 | 102s | 26% |
| **审校（完全串行）** | **332s** | **86%** |
| 翻译结束后仍在等审校 | **284s** | **74%** |

`723c0b97` 同构：109s 里翻译 43s、审校 95s（87%）。

### 5.2 三个叠加原因

**原因 A：审校并发被钉死为 1，池子里 3 个槽位闲着。**

`translationAgent.ts:1656-1658`：

```ts
reviewStrength === 'strong'
  ? Math.min(strategy.reviewConcurrency, CONFIGURED_REVIEW_CONCURRENCY)
  : 1,                                    // ← medium / weak 一律 1
```

项目配置 `reviewConcurrency: 2`（`projectStore.ts:86` 默认值也是 2），`LOCAL_AGENT_DOCUMENT_REVIEW_CONCURRENCY` 默认 4，poolSize=4——**全被这一个字面量 `1` 覆盖掉**。4 个审校任务只能一个接一个跑：96 + 44 + 116 + 76 = 332s。

这是"慢"的第一大项，而且是我上一轮引入 medium 强度时加的约束，属于**回归**。

**原因 B：审校跑在慢 3.4 倍的模型上。**

按输出 token 速率实测（同一次 run，同一台机器）：

| 阶段 | 模型 | 输出 token | 耗时 | 速率 |
|---|---|---|---|---|
| 翻译 b1 | deepseek-v4.1-flash | 10,286 | 51.8s | **199 tok/s** |
| 翻译 b2 | deepseek-v4.1-flash | 10,690 | 54.5s | **196 tok/s** |
| 翻译 b3 | deepseek-v4.1-flash | 9,345 | 47.8s | **195 tok/s** |
| 翻译 b4 | deepseek-v4.1-flash | 6,960 | 37.6s | **185 tok/s** |
| 审校 b1 | glm-5.3-flash | 2,640 | 44.0s | **60 tok/s** |
| 审校 b2 | glm-5.3-flash | 6,897 | 115.9s | **59 tok/s** |
| 审校 b3 | glm-5.3-flash | 5,194 | 96.1s | **54 tok/s** |
| 审校 b4 | glm-5.3-flash | 4,302 | 76.0s | **57 tok/s** |

翻译速率稳定在 ~195 tok/s，审校稳定在 ~57 tok/s。**同一个 provider、同一时刻、差 3.4 倍。** 因为 `accuracyReview.model = glm-5.3-flash`（项目配置），而 `translation.model = deepseek-v4.1-flash`。

审校输出量只有翻译的一半（平均 4,758 vs 9,320），却耗时 1.73 倍——完全由模型速率解释。

**原因 C：每次调用固定 4 个 turn，思考阶段零输出。**

所有 `model.usage` 的 `numTurns` 都是 **4**（`maxTurns = JSON_MODE_MAX_TURNS = 5`）。结构化调用走 `query()`，每个 turn 都是一次完整往返、重发全部 prompt。

同时心跳显示：

```
[agent 08:19:15] 调用仍在进行 · 已等待 30s · 事件 2 条 · 已收文本 0 字
[agent 08:19:45] 调用仍在进行 · 已等待 60s · 事件 2 条 · 已收文本 0 字
[agent 08:20:15] 调用仍在进行 · 已等待 90s · 事件 2 条 · 已收文本 0 字
```

审校 b2 前 90 秒**一个字符都没吐**，全在思考。项目配置 `translation.thinkingMode=enabled`、`thinkingBudgetTokens=8192`；`accuracyReview` 是 `adaptive` + `effort: medium`。8192 的思考预算配上慢模型，就是 30–90 秒的空转。

**原因 D（次要）：批次切得太碎，固定开销重复 4 次。**

`maxBatchSourceChars=8000`，普鲁斯特段落长，于是 38 段切成 4 批（11/7/13/7）。每批背 ~6,723 字符的固定样板（styleGuide + 编辑画像 + 近例），4 批重复 ≈ 26,900 字符。`723c0b97` 更极端：7 段切成 6+1，第 2 批只有 1 段，却仍然生成 16,689 字符的 brief、花 25.4 秒审校。

---

## 6. 推荐修改（按收益/成本排序）

### P0 —— 直接决定速度

1. **放开 medium 强度的审校并发。** 删掉 `translationAgent.ts:1656-1658` 的 `: 1`，改成 `Math.min(strategy.reviewConcurrency, CONFIGURED_REVIEW_CONCURRENCY)`。配合把 `LOCAL_AGENT_POOL_SIZE` 提到 6（`translationConcurrency` 仍可保持 3–4），审校 2 路并行：332s → ~190s，整 run 386s → ~240s。
2. **给 `accuracyReview` 换模型。** 实测 deepseek-v4.1-flash 比 glm-5.3-flash 快 3.4 倍，把 `accuracyReview.model` 从 `glm-5.3-flash` 改成 `deepseek-v4.1-flash`，审校 332s → ~100s。**这一项单独就能把总时长压到 ~150s。**
3. **审校关掉固定思考预算。** `accuracyReview.thinkingMode` 从 `adaptive` 改 `disabled`，或把 `effort` 降到 `low`；`translation.thinkingBudgetTokens` 从 8192 降到 2048。目标是消掉那 30–90 秒的零输出窗口。

### P1 —— 修日志说谎

4. `translationAgent.ts:2556` 把 `' · ' + finishedUsage` 改成 `' · ' + JSON.stringify(finishedUsage ?? {})`。
5. `model.usage` / `batch.prompt.ready` / `model.call.failed` 记录 `effectiveAgent.model`（即 `taskProfile.model`），并额外保留 `requestedModel` 字段；`run started` 里 `model=auto` 应解析成实际生效的模型。
6. 去掉 `runner.ts:39` 的 `if (isWorkflowManaged(sessionScope)) return;`，或至少保留 `logModelSuccess`（含耗时、输出字符数、token）。文档翻译是当前最需要观测的路径，恰恰被整段静默。
7. `usage.ts:80` 修 `totalInputTokens` 双重计数（provider 的 `cache_read == input` 时不要相加）。
8. `voiceContext.ts:773` 加 `.sort((a, b) => b[1] - a[1])`，让 `largestSections` 真的按大小排序。
9. `POLLING_PATH_PATTERNS` 增加 `/\/segments$/`。

### P2 —— 继续压上下文

10. **`nameMappings` 只注入 `strong`。** 当前 b1 是 11 条 `candidate`、2,100 字符、`strong=0`。按 `strongNameMappings` 过滤，或对 candidate 设上限（如 3 条 / 300 字符）。这一项能直接消掉 4,759 字符，且不损失任何已确认信息。
11. **把 `styleGuide` 移出 brief。** 3,937 字符、4 批逐字节相同，应作为 system prompt 的固定段（可被 prompt cache 命中），而不是放在每批的 brief JSON 里。
12. **合并过短的尾批。** `buildBatches` 结束时，若最后一批段数 < `maxBatchSegments / 3`，合并进前一批。`723c0b97` 的 6+1 就是典型：1 段批白花 16,689 字符 brief + 25.4 秒审校。
13. **`contextBudgetChars` 要么生效、要么删掉。** 现在它写进 `plan.ready`、用户能改、然后什么都不做（b1 18,750 > 18,000，`TrimmedByBudget` 全 0）。保留"不裁剪证据"的原则没问题，但那就别暴露这个配置项。

---

## 7. 不要做的事

- **不要再靠加大 `maxBatchSourceChars` 来提速。** 批次变大 → 单次输出变长 → 审校输出也变长，而审校是串行的，收益会被抵消。先修 P0-1 / P0-2。
- **不要为了压 token 去裁 `precedingSegments`。** 它现在是 1,362–5,415 字符（4 段），是唯一真正影响文气连贯的上下文；而固定样板（6,723）和弱映射（4,759）才是该砍的。
- **不要相信 `run finished` 那行里的用量。** 它是 `[object Object]`，在 4.1 修好之前，run 级 token 只能从 `project_events` 的 `model.usage` 汇总（且要注意 4.5 的双重计数）。

---

## 8. 复现方法

```bash
# 1. 文件日志（现在是真的按行写了）
wc -l ~/.vocal-saga-local-agent/logs/local-agent.log

# 2. run 时间线（权威）
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+
  "/.vocal-saga-local-agent/documents/8f9a86bd-0478-4eed-bec1-83be72140bf4/project.sqlite",{readOnly:true});
for(const r of db.prepare("SELECT created_at,event_type,payload_json FROM project_events WHERE run_id=? ORDER BY event_id").all(process.argv[1])){
  const p=JSON.parse(r.payload_json);
  console.log(r.created_at.slice(11,23), r.event_type, p.durationMs?p.durationMs+"ms":"");
}' 5034b08b-9a5e-417c-8923-70f958b63965

# 3. 每批 brief 的实际构成
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+
  "/.vocal-saga-local-agent/documents/8f9a86bd-0478-4eed-bec1-83be72140bf4/project.sqlite",{readOnly:true});
for(const r of db.prepare("SELECT batch_index,brief_chars,length(brief_json) n FROM translation_briefs WHERE run_id=? ORDER BY batch_index").all(process.argv[1]))
  console.log("b"+r.batch_index, "注入", r.brief_chars, "存储", r.n);' 5034b08b-9a5e-417c-8923-70f958b63965
```

`brief_chars`（注入 prompt 的部分）与 `length(brief_json)`（含 `contextDiagnostics`）相差约 5,150 字符，这是正常的：`serializedContext()`（`translationBrief.ts:727-744`）不包含 `contextDiagnostics`，诊断只落库不进 prompt。

---

## 附录：本次 run 的 token 汇总

| run | 阶段 | 调用数 | 输入 token | 输出 token | 模型耗时合计 |
|---|---|---|---|---|---|
| `723c0b97` | 翻译 | 2 | 30,401 | 8,706 | 50.6s |
| `723c0b97` | 审校 | 2 | 29,470 | 4,330 | 87.9s |
| `5034b08b` | 翻译 | 4 | 60,990 | 37,281 | 191.7s |
| `5034b08b` | 审校 | 4 | 63,108 | 19,033 | 332.0s |

注：审校的输入 token 取自文件日志 `[literary-review]`（`project_events` 里没有审校的 `model.usage`，这也是 4.3 那个静默问题的延伸——审校用量没有进审计账本）。按 4.5 的分析，若网关返回 `cache_read == input`，实际计入的 `totalInputTokens` 会是表中输入值的 2 倍。

---

## 9. 实施记录（2026-11-01 08:50 更新）

本节记录第 6 节建议的落地情况。**未改动项目已保存的 `taskProfiles`**（那是用户数据，见 9.3）。

### 9.1 已改代码

| 项 | 位置 | 改动 |
|---|---|---|
| 审校并发不再被钉死 | `translationAgent.ts:1699-1706` | medium/strong 都读 `strategy.reviewConcurrency`，不再对 medium 硬编码 `1` |
| 翻译排空后审校接管整个池 | `translationAgent.ts:2576-2594` | 新增 `review.drain.expanded` 事件与 `review drain` 日志；闸门提升到 `min(poolSize, LOCAL_AGENT_DOCUMENT_REVIEW_DRAIN_CONCURRENCY)`（后者默认 64 = 不额外限制） |
| 闸门可扩容 | `translationAgent.ts:297-345` | `createConcurrencyLimiter` 返回带 `setConcurrency` / `getConcurrency` / `pending` 的 `ConcurrencyLimiter`；扩容时立即唤醒排队者，缩容不打断在跑任务 |
| `run finished` 不再输出 `[object Object]` | `translationAgent.ts:2615-2621` | `usage=` + `JSON.stringify(finishedUsage)` |
| 模型名不再说谎 | `taskProfiles.ts:resolveEffectiveTaskModel` + `translationAgent.ts` 4 处 | `model.usage` / `batch.prompt.ready` / `model.call.failed` / `batch.model.response` 记实际生效模型，另存 `requestedModel`；`run started` 与 `run.context.ready` 增加 `effectiveModel` / `effectiveReviewModel` |
| 文档翻译调用不再静默 | `runner.ts:23-75` | 去掉 `isWorkflowManaged()` 的提前 return，只加 `· 工作流` 标记 |
| 审校用量进审计账本 | `literary.ts:706-720` + `translationAgent.ts:2160-2176` | `runLiteraryReview` 回传 `usage` / `model`，调用方写 `model.usage`（stage=review）；补审用量合并 |
| 审校日志补耗时/轮次/模型 | `literary.ts:625-634` | `literary-review` 行增加 `duration` / `turns` / `model` |
| `largestSections` 名实相符 | `voiceContext.ts:773-778` | 按字符数降序取前 6 |
| 短尾批合并 | `translationAgent.ts:mergeShortTailBatch` | 尾批 ≤ maxBatchSegments/3 且合并后不越段数上限、不越 `maxBatchSourceChars`、同章节时并回前一批 |
| `contextBudgetChars` 不再假装生效 | `translationBrief.ts:1200-1206` | 记录 `contextBudgetExcessChars`，超预算时日志追加 `超建议预算=N（未裁剪）` |

### 9.2 刻意没改

- **`totalInputTokens` 双重计数**：`summarizeTurnUsage` 的"相加"语义有测试锁定（`server.test.mjs:801`），且与 Anthropic 官方 `input_tokens` 不含缓存的口径一致。本机网关 `cache_read == input` 更像是网关侧报告口径问题，不在代码里猜。**读这个字段时要留意：本机实际输入量约为其一半。**
- **`/segments` 轮询不进汇总**：`request-log.test.mjs:26` 明确把它归为"one-off reads 要留在日志里"。9 分钟 64 行噪音，改不改由你定。
- **`nameMappings` 只注入 strong**：可见性闸门（`contextGraph.ts` 的 `nameNotVisible`）和 brief 的"本批未提及"过滤器是两个不同概念，无法确认 11 条 candidate 里哪些真的该丢。先把矛盾留成可观测数据，不赌语义。
- **`styleGuide` 移出 brief**：3,937 字符 × 每批，是当前最大的一块固定开销，但移动它会改变 prompt 结构，需要单独做质量对照，不适合和提速改动混在一起。

### 9.3 需要你手动改的两项（不是代码问题）

代码里的默认值本来就是快的，是这个项目**保存的 Prompt 修订**把它们覆盖了：

| 设置 | 当前保存值 | 建议值 | 影响 |
|---|---|---|---|
| `accuracyReview.model` | `glm-5.3-flash` | `deepseek-v4.1-flash` | 实测 57 tok/s → 195 tok/s，审校 332s → ~100s |
| `translation.thinkingMode` | `enabled`（budget 8192） | `disabled` | 消掉每次调用开头 30–90 秒的零输出窗口 |

改动位置：项目 → Prompt 设置 → 任务配置。会新建一条 prompt revision（旧修订保留可回滚）。

另外 `.env` 里 `LOCAL_AGENT_POOL_SIZE=4`，池子偏小。调到 6 可以让翻译 4 路 + 审校 2 路并行，而不是互相挤。

### 9.4 验证

```
npx tsc --noEmit          # 通过
npm test                  # 330 项全部通过（新增 4 项：闸门扩容 / 缩容不打断 / 尾批合并 / 生效模型解析）
```

服务在 8791 端口启动冒烟通过（`/health` 200，日志正常按行写入）。

### 9.5 关于"为什么不全部切到审校"的直接回答

因为原来的闸门是一个**在 run 计划阶段创建后就再也不变**的信号量：

```ts
const reviewLimiter = createConcurrencyLimiter(reviewConcurrency);  // 上限冻结在这里
```

`reviewConcurrency` 在计划阶段按「翻译要占几个槽」算出来，之后无论翻译是否结束，这个数字都不再更新。翻译全部完成后，4 个槽位里 3 个空着，闸门仍然只放 1 个审校进去——这不是调度策略的选择，是闸门没有"重新分配"的能力。

现在的行为：翻译排空那一刻把闸门抬到池宽，排队中的审校立刻并行，`review.drain.expanded` 事件和 `review drain` 日志都会记下 `from → to` 和待审批次数。
