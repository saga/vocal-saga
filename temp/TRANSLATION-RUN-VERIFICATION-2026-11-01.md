# 最新运行日志核查报告（2026-11-01 08:56–09:17）

分析对象：

- 文件日志 `~/.vocal-saga-local-agent/logs/local-agent.log`（789 行 / 124 KB）
- 项目 `8f9a86bd-0478-4eed-bec1-83be72140bf4`（《À la recherche du temps perdu》）
- 服务在 **08:55:55 重启**，之后跑了 3 个 run：

| run | 时间 | 段数 | 批次 | 墙钟 | 秒/段 |
|---|---|---|---|---|---|
| `57745cfa` | 08:56:36 → 09:01:15 | 34 | 4 | 279s | 8.2 |
| `49dd39d4` | 09:01:25 → 09:11:56 | 128 | 14 | 632s | 4.9 |
| `e3b602c2` | 09:12:48 → 09:16:41 | 30 | 4 | 233s | 7.8 |

对照：修复前 `5034b08b` 是 38 段 / 386s / **10.2 秒每段**。

**本次没有修改任何代码。** 上一轮改动见 `TRANSLATION-SPEED-ANALYSIS-2026-11-01.md` 第 9 节。

---

## 1. 结论摘要

| 项 | 状态 |
|---|---|
| 9 个已修的日志/调度缺陷 | **全部验证通过**，无一回退 |
| 新增错误（失败/超时/丢弃/4xx/5xx） | **0 条**。三次 run 全部 `status=completed`，128/128、34/34、30/30 段全部采纳 |
| 速度 | 10.2 → 4.9–8.2 秒/段（**−20% ~ −52%**）；审校尾巴 284s → 72s（**−75%**） |
| 新的瓶颈 | **翻译阶段**：`49dd39d4` 里翻译独占 560s / 632s（89%），不再是审校 |
| 新发现 / 仍存的问题 | **11 条**（4.1–4.11）。其中 3 条是这次新查出来的结构性事实（4.9–4.11），会改变后续优化的优先级 |

三条最需要注意的新事实：

1. **文档翻译和审校根本不走会话池**（4.9）。`taskProfile` 一存在就走 `query()`，每次调用新起一个 CLI 进程；启动时预热的 4 个池槽位整场空转。`LOCAL_AGENT_POOL_SIZE` 不是进程上限，只是并发预算的除数。
2. **审校的缓存命中率只有 0–9.6%，翻译是 45–61%**（4.6）。同一份 brief 在审校侧几乎每批重新写一遍缓存。
3. **审校的出词速度是翻译的 1/2.8**（156–160 tok/s vs 54–58 tok/s，4.4）。审校是全项目唯一跑 `glm-5.3-flash` 且唯一 `effort=medium` 的任务，其余都是 deepseek/minimax + `low`。

---

## 2. 上一轮问题逐项核验

### 2.1 `run finished` 的 `[object Object]` —— 已修

```
[document-agent 09:11:56] run finished · … · status=completed · counts={"total":128,"accepted":128}
  · wall=632s · usage={"inputTokens":634221,"outputTokens":186494,"cacheReadTokens":258688,
  "cacheCreationTokens":375533,"totalInputTokens":1268442,"totalTokens":1454936,"numTurns":146}
```

三次 run 都输出了完整数字，`numTurns` 也回来了。

### 2.2 模型名说谎 —— 已修

翻译和审校现在各自报出真实模型，日志里能直接看出两个阶段跑在不同模型上：

```
[model 09:01:26] 文档初译 · 开始 · … workbuddy/deepseek-v4.1-flash · 模式=结构化 JSON · 输入=18,194 字符 · 工作流
[model 09:01:51] 准确性/术语审校 · 开始 · … workbuddy/glm-5.3-flash · 模式=JSON 对象 · 输入=20,158 字符 · 工作流
[document-agent 08:58:31] review done · … · model=glm-5.3-flash · durationMs=66096
```

`run started` / `run.context.ready` 里的 `effectiveModel` / `effectiveReviewModel` 也已落库。

### 2.3 文档翻译调用在文件日志里静默 —— 已修

`model` scope 从 0 行变成 **104 行**，每个批次都有"开始/完成/耗时/输出/token"：

```
[model 09:03:22] 文档初译 · 完成 · … · 耗时=61.0s · 输出=translations=12 · token in=40,563 cache=40,563 out=10,797
```

这条现在是**唯一可信的单次调用耗时来源**（原因见 4.2）。

### 2.4 审校并发被钉死 + 翻译排空后不切换 —— 已修

```
[document-agent 08:58:22] review drain · run=57745cfa… · 翻译已排空 · 审校并发 2 → 4 · 待审批次=4 · translationWall=106s
[document-agent 09:10:44] review drain · run=49dd39d4… · 翻译已排空 · 审校并发 2 → 4 · 待审批次=4 · translationWall=560s
[document-agent 09:15:15] review drain · run=e3b602c2… · 翻译已排空 · 审校并发 2 → 4 · 待审批次=2 · translationWall=148s
```

三次 run 全部触发。效果可以直接量出来：**翻译结束后的审校尾巴**

| run | 翻译墙钟 | 总墙钟 | 尾巴 | 尾巴占比 |
|---|---|---|---|---|
| `5034b08b`（修复前） | 102s | 386s | 284s | 74% |
| `57745cfa` | 106s | 279s | 173s | 62% |
| `49dd39d4` | 560s | 632s | 72s | 11% |
| `e3b602c2` | 148s | 233s | 85s | 36% |

`49dd39d4` 的尾巴只剩 11%——因为 14 个批次里大部分审校都在翻译期间并行做完了。

### 2.5 审校用量进审计账本 —— 已修

`project_events` 里 `model.usage` 现在有 `stage=review` 的记录，`run finished` 的合计也包含审校。`49dd39d4` 的 `numTurns=146`（19 次翻译 + 14 次审校 + 其他），说明两条路径都计入了。

### 2.6 `largestSections` 名不副实 —— 已修

```
[voice-context 08:56:38] built · entities=7 · … · recentExamples=3
  · largestSections=recentExamples:1498,entities:1386,chineseEditorialProfile:1154,constra…
```

现在是降序，占字节最多的字段排在最前。

### 2.7 `contextBudgetChars` 假装生效 —— 已修（改为可见）

```
[translation-brief 08:56:40] assembled · segments=7 · chars=18235 · … · 超建议预算=235（未裁剪）
```

超预算时明确标出来，不再让配置项无声失效。

### 2.8 短尾批合并 —— 逻辑生效，但本次没触发

14 批里 b13=5 段 / b14=3 段，看似该合并，实际拒绝是对的：

| | 段数 | 源字符 |
|---|---|---|
| b13 | 5 | 6,409 |
| b14 | 3 | 3,459 |
| 合并后 | 8 ≤ 16 ✓ | **9,868 > 8,000 ✗** |

`maxBatchSourceChars` 是硬上限，拒绝合并是正确的。这个优化只在"尾批又短又轻"时才生效。

### 2.9 稳定性 —— 全绿

三次 run 期间：`失败 / 超时 / 丢弃 / 空响应 / json-repair / 4xx / 5xx` **全部为 0**。上一轮出现过的 413 也没有复现。

---

## 3. 性能实测

### 3.1 各阶段耗时（`49dd39d4`，128 段 / 14 批 / 并发预算 2+2）

耗时取自 `[model] 完成 · 耗时=` 行（runner 墙钟，见 4.2 为什么不用 `durationMs`）：

| 阶段 | 调用数 | 累计墙钟 | 单次均值 | 单次最长 | 实际窗口 |
|---|---|---|---|---|---|
| 翻译 | **19**（14 批 + 5 次补译） | 842s | 44.3s | 62.9s | 560s（2 路） |
| 审校 | 14 | 1,021s | 72.9s | 101.4s | 605s（2→4 路） |
| 合计 | 33 | 1,863s | — | — | 632s（平均并行度 2.95） |

对照 `57745cfa`（34 段 / 4 批 / 279s）：翻译 187.5s（4 次，均 46.9s），审校 435.1s（4 次，均 108.8s，最长 173.5s），合计 622.6s / 279s = 并行度 2.23。

对照 `e3b602c2`（30 段 / 4 批 / 233s）：翻译 239.9s（4 次，均 60.0s），审校 291.7s（4 次，均 72.9s，最长 85.2s），合计 531.6s / 233s = 并行度 2.28。

三次的并行度依次是 2.23 / 2.95 / 2.28，**都没有超过 3**——而并发预算是 4（2 路翻译 + 2 路审校，排空后 2+4）。也就是说任何时刻平均有 1 个槽位是空的。

### 3.2 吞吐对比

| 指标 | 修复前 | 现在 |
|---|---|---|
| 秒/段（小 run） | 10.2 | 7.8 – 8.2 |
| 秒/段（128 段大 run） | — | **4.9** |
| 翻译后尾巴占比 | 74% | 11% – 62% |
| 每段输入 token | 约 1,600 | 4,954（含重试与多轮） |

### 3.3 出词速度与缓存命中（三次 run 完全一致，不是噪音）

出词速度 = 输出 token ÷ 该阶段累计墙钟；缓存命中 = `cacheReadTokens ÷ inputTokens`（数据取自 `project_events` 的 `model.usage`，按 `stage` 分组）：

| run | 阶段 | 输出 tok | 累计墙钟 | **tok/s** | input | cacheRead | **命中率** |
|---|---|---|---|---|---|---|---|
| `57745cfa` | 翻译 | 29,252 | 187.5s | **156** | 61,409 | 27,648 | **45.0%** |
| | 审校 | 25,281 | 435.1s | **58** | 63,413 | **0** | **0.0%** |
| `49dd39d4` | 翻译 | 131,384 | 842.0s | **156** | 395,969 | 235,776 | **59.5%** |
| | 审校 | 55,110 | 1,021.1s | **54** | 238,252 | 22,912 | **9.6%** |
| `e3b602c2` | 翻译 | 38,352 | 239.9s | **160** | 88,716 | 53,760 | **60.6%** |
| | 审校 | 16,630 | 291.7s | **57** | 64,336 | 4,928 | **7.7%** |

两个结论都很硬：

- **翻译稳定在 156–160 tok/s，审校稳定在 54–58 tok/s**，三次 run 六个样本零离散。差距 2.8 倍，与批次大小、输入长度无关——只可能来自模型或 thinking 配置。
- **审校缓存命中 0–9.6%，翻译 45–61%**。`57745cfa` 的审校 4 次调用 `cacheRead=0`，即 63,413 个输入 token 全部按新缓存写入计费。

---

## 4. 还存在的问题

### 4.1 翻译阶段变成新瓶颈，其中 25% 是空转（影响最大）

`49dd39d4` 的 632s 里，翻译占 560s。把每个批次的真实墙钟加起来是 **842s**，除以 2 路并行应该是 421s，实际用了 560s——**约 139s（25%）的槽位在空转**。

原因是**波次屏障**：`translationAgent.ts:2537` 的 `runWithConcurrency(wave, translationConcurrency, …)` 会等同一波里所有批次都结束才开下一波。两个批次耗时不等时，先完成的那个槽位就闲置：

```
01:01:26  b1 开始 → 01:01:51 完成（25.5s）
01:01:28  b2 开始 → 01:02:16 完成（48.5s）
          ↑ b1 的槽位从 01:01:51 空到 01:02:16，23s 白等
01:02:19  b3 / b4 才开始
```

这个屏障是有意的（同波批次必须看到同一份上下文快照，避免候选竞态流入）。**不建议直接删**，但它现在是大 run 的主要损耗项。

### 4.2 `model.usage.durationMs` 不可信（新发现，影响所有历史结论）

同一批次的三个耗时来源对不上：

| 批次 | `model.usage.durationMs` | `batch.model.response.durationMs` | `[model] 耗时` |
|---|---|---|---|
| b1 | 21,550 | 25,535 | 25.5s |
| b4 | **13,537** | **61,037** | **61.0s** |
| b5 补译 | 10,202 | 36,564 | 36.6s |
| b10 | **11,513** | **46,365** | — |

b4 的 `durationMs` 只有实际耗时的 **22%**。规律：`numTurns` 越多差得越远（b4 是 6 轮）。合理推断是 SDK 的 `duration_ms` 只覆盖最后一轮，多轮（工具调用往返）不计入。

**后果：任何基于 `model.usage.durationMs` 的汇总都严重低估真实耗时**（`49dd39d4` 的"610s 翻译耗时"实际是 842s）。上一份报告里的"模型耗时"列同样偏低。

`[model] 完成 · 耗时=` 这一行（runner 的墙钟）和 `batch.model.response.durationMs` 是一致的、可信的。**今后请以这两者为准。**

### 4.3 翻译重试率 36%，根因是规范词标记被丢弃（不是截断）

`49dd39d4` 的 14 个批次里有 **5 个**触发了补译。查 `canonical-terms.protected` 事件后，原因很明确——**模型没有逐字保留 `__VSA_TERM_NNN__` 标记，被服务端判定为不一致而丢弃**（`translationAgent.ts:1252` 的 `canonicalMarkerCountsMatch`）：

| 批次 | 受保护片段 | 被拒 | 拒绝率 | 补译耗时 |
|---|---|---|---|---|
| b5 | 9 | 2 | 22% | 36.6s |
| b7 | 7 | **7** | **100%** | 45.1s |
| b9 | 4 | 2 | 50% | 29.1s |
| b12 | 4 | 2 | 50% | 28.8s |
| b13 | 4 | 1 | 25% | 18.5s |
| **合计** | **69** | **14** | **20%** | **158.1s** |

代价：5 次额外调用、**158.1s 墙钟**，占翻译累计耗时（842s）的 **19%**。5 次补译的 `rejectedSegmentCount` 全部为 0——补译一次就能通过，说明不是模型能力问题，是首次调用没遵守标记约束。

b7 最典型：模型返回了 10 条译文（`audit.response.translations` 里 10 条 `translated_text` 都有内容，19–513 字不等），但 7 条把标记"翻译"掉了，只剩 3 条可用。**这不是截断，也不是提前收尾**——上一轮我猜的"输出被截断"是错的。

顺带发现一个会误导读日志的字段：`[model] 完成 · 输出=translations=N` 报的是**原始条数**，不是采纳数。b7 那行写 `translations=10`，实际只采纳 3 条。要判断是否触发补译只能看 `batch.partial` / `canonical-terms.protected`。

### 4.4 审校仍在 `glm-5.3-flash` 上（配置项，未改）

```
review: 14 calls, out=55,110, 累计墙钟 1,021s, models=glm-5.3-flash
translate: 19 calls, out=131,384, 累计墙钟 842s, models=deepseek-v4.1-flash
```

审校输出量只有翻译的 **42%**，累计耗时却是 **1.2 倍**（`57745cfa` 更极端，2.3 倍）。单次审校平均 72.9s、最长 101.4s（`57745cfa` 的 b4 到过 173.5s）。

按 3.3 的出词速度看更清楚：**审校 54–58 tok/s，翻译 156–160 tok/s，差 2.8 倍**。审校每次只产 3,900–6,300 个 token，却要 50–173 秒，时间主要花在"想"而不是"写"上。注意两个任务都开了 thinking（budget 都是 8192），**所以差异不来自 thinking 开关，只能来自模型本身和 effort**。

项目保存的 `prompt_revisions.config_json → taskProfiles` 实际值（唯一权威来源）：

| 任务 | model | thinkingMode | budget | effort |
|---|---|---|---|---|
| `translation` | `deepseek-v4.1-flash` | enabled | 8192 | **low** |
| `accuracyReview` | **`glm-5.3-flash`** | adaptive | 8192 | **medium** |
| `styleReview` | `deepseek-v4.1-flash` | adaptive | 8192 | medium |
| `literaryAnalysis` | `minimax-m3.1-flash` | adaptive | 8192 | medium |
| `contextGraph` | `minimax-m3.1-flash` | adaptive | 8192 | low |

**审校是唯一跑在 `glm-5.3-flash` 上的任务**，而且 effort 是全项目唯一为 `medium` 的（翻译是 `low`）。这两点叠加正好解释了 2.8 倍的出词速度差。看起来是历史遗留配置，不像有意选择。

顺带纠正上一轮的一处误判：`translation.thinkingMode` 是 `enabled`，但翻译实测 156 tok/s、45s/批，说明这个 thinking 预算并没有拖慢它。**所以不需要动翻译的 thinking 配置**——要动的是审校的模型和 effort。

### 4.5 `totalInputTokens` 双重计数 —— 现在可以确证了

三个 run 的合计里，`inputTokens` 与 `cacheReadTokens + cacheCreationTokens` **完全相等**：

| run | inputTokens | cacheRead + cacheCreation | 比值 |
|---|---|---|---|
| `57745cfa` | 124,822 | 27,648 + 97,174 = 124,822 | 1.000 |
| `49dd39d4` | 634,221 | 258,688 + 375,533 = 634,221 | 1.000 |
| `e3b602c2` | 153,052 | 58,688 + 94,364 = 153,052 | 1.000 |

33 次调用（`49dd39d4` 一个 run）已经全部吻合；把三次 run 的六个「run×stage」分组分别求和，49 次调用**一次例外都没有**。这说明网关的 `input_tokens` **已经包含**缓存部分，`summarizeTurnUsage` 再加一遍就翻倍了：`totalInputTokens=1,268,442` 是真实输入（634,221）的 2 倍。

上一轮我因为测试锁定而没改，现在有了 49 次调用的确定性证据。**建议改为**：`cacheRead + cacheCreation >= inputTokens` 时取前者，否则相加；同时更新 `server.test.mjs:801` 的断言（那个用例里 input=120、cache=3500，属于"互不重叠"，改成新规则后应断言 3,500 而不是 3,620）。

### 4.6 审校的缓存命中率只有 0–9.6%（修正上一轮的判断）

每批的 `contextGraph.styleGuide` 都是 **3,937 字符，逐字节相同**：

```
b1  styleGuide=3937   b6  styleGuide=3937   b11 styleGuide=3937
b2  styleGuide=3937   b7  styleGuide=3937   b12 styleGuide=3937
…
```

`49dd39d4` 一批就重复了 14 次，合计 **55,118 字符**。对 `b14`（3 段、3,459 源字符）来说，brief 15,633 字符里有 25% 是这一块。

**上一轮我建议"移到 system prompt 以吃到 prompt cache"，这个理由不成立**——按 3.3 的实测，翻译侧本来就有 45–61% 的缓存命中，重复内容已经被缓存吸收了一部分。真正的问题在审校侧：

| run | 审校 input | cacheRead | 命中率 |
|---|---|---|---|
| `57745cfa` | 63,413 | 0 | **0.0%** |
| `e3b602c2` | 64,336 | 4,928 | **7.7%** |
| `49dd39d4` | 238,252 | 22,912 | **9.6%** |

审校的输入几乎全部按"新写缓存"计费。`buildLiteraryReviewPrompt`（`literary.ts:428`）的 user prompt 顺序是 `目标语言 → 章节 → brief 元数据 → glossary → voiceContext → contextGraph → precedingSegments → segments`，看起来稳定内容在前，但 `chapterPath` / `knowledgeBoundaryOrdinal` 一变，后面整段前缀就作废；而审校只有 2 路并发，两个同前缀的调用很少重叠，缓存来不及被第二次调用读到。

**这条比 styleGuide 值钱得多**：把审校 prompt 里每批必变的小字段（`chapterPath`、`contextChars`、`precedingSegments`）挪到 prompt 末尾，理论上能把审校命中率拉到与翻译同级。

### 4.7 `/segments` 轮询仍逐条落盘

```
72  GET /api/documents/projects/:id/segments → 200
```

25 分钟 72 次（约每 21 秒一次），不在 `POLLING_PATH_PATTERNS` 里。上一轮因为 `request-log.test.mjs:26` 明确把它归为"one-off reads 要留在日志里"而没动。现在实际量级是每小时约 170 行。

### 4.8 批次大小极不均衡

同一个 run 里批次从 3 段到 16 段：

| 批次 | 段数 | 源字符 | brief |
|---|---|---|---|
| b1 | 16 | 2,924 | 14,225 |
| b8 | 7 | 8,000 | 17,060 |
| b14 | 3 | 3,459 | 15,633 |

b1 有 16 段却只有 2,924 源字符（短段落），b14 只有 3 段却要背 15,633 字符的 brief。按字符切分是合理的（`maxBatchSourceChars=8000`），但它导致**固定开销被重复得极不经济**：14 批的 user prompt 都在 18,130–28,691 字符之间，与源字符（2,924–8,000）几乎无关。b1 的 18,194 字符里只有 16% 是正文。

### 4.9 文档翻译根本不走会话池（本次最重要的发现）

启动日志里 4 个槽位各预热一次，之后整场 run **再没有任何池事件**：

```
[pool 08:55:55] 新建会话 · slot=0 · 槽位为空 · scope=通用槽位 · model=glm-5.3-flash · 101ms
[pool 08:55:55] 新建会话 · slot=1 … slot=2 … slot=3 …
（之后 789 行日志里 pool scope 归零）
```

原因在 `workbuddy.ts:233`：

```ts
// Task profiles must go through query() so thinking/effort/fallbackModel are honored.
if (taskProfile) {
  const result = await queryWorkbuddyRaw(agent, prompt, systemPrompt,
    buildWorkbuddyOptions(agent, undefined, taskProfile), requestId, ...);
  ...
}
```

文档初译（`translationAgent.ts:1216`）和审校（`literary.ts:621`）**都传了 taskProfile**，所以两者全部走 `queryWorkbuddyRaw`——每次调用新起一个 CLI 进程，预热好的 4 个会话一次都没被用过。

三个直接后果：

1. **`LOCAL_AGENT_POOL_SIZE` 不是进程上限，只是并发预算的除数。** 池里 4 个槽位躺着不动，实际并发的 CLI 子进程数 = `translationConcurrency + reviewConcurrency`，排空后能到 6，比 pool=4 还多。所以 P0-2 加大 pool 依然有效（它改变预算分配），但**不要指望它限制资源**。
2. **4 个预热进程纯属浪费。** 它们被 `connect()` 拉起后一直挂着，整场 run 零负载，只吃内存。
3. **每次调用都是冷启动。** 单次 boot 约 100ms（预热日志里的 `· 101ms`），相对于 45–73s 的调用可以忽略，所以这不是速度问题——但它解释了为什么"会话复用"在日志里看不到任何轮次累积（`numTurns=146` 是 SDK 报的轮内轮次，不是会话复用）。

**这条会影响 P0-2 的预期收益口径**：加大 pool 得到的是"更多并发 CLI 进程"，不是"更多复用会话"。收益是真的（`49dd39d4` 的 2 路翻译确实被卡住），但成本模型要按进程算。

### 4.10 `formatTurnUsageLog` 的 `cache=` 字段恒等于 `in=`

`usage.ts:98`：

```ts
const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
```

而网关返回的 `inputTokens` 本来就等于 `cacheRead + cacheCreation`（4.5 已用 49 次调用确证）。所以日志里每一行都是：

```
token in=40,563 cache=40,563 out=10,797
```

40 行样本，**无一例外**。这个字段看起来像"缓存命中 100%"，实际只是把 `in` 又印了一遍。要看真实命中率只能查 `project_events`（3.3 的表就是这么来的）。

**建议**：改成 `hit=<cacheRead> new=<cacheCreation>`，一行就能看出 4.6 那个 0–9.6% 的问题。

### 4.11 池槽位报的模型与实际调用无关

`新建会话 · model=glm-5.3-flash` 打印的是 `agent.model`（池的默认模型），而实际调用跑在 `deepseek-v4.1-flash` 上（4.9，池根本没参与）。这不是新 bug，但会让"看日志以为是 glm 在跑翻译"的人得出相反结论——和上一轮修掉的"模型名说谎"是同一类问题，只是这次发生在 `pool` scope。

---

## 5. 建议

### P0 —— 影响最大

1. **改 `accuracyReview` 的任务配置**（4.4 有完整对照表）。这是零代码改动、收益最大的一项：
   - `model`: `glm-5.3-flash` → `deepseek-v4.1-flash`（翻译和 `styleReview` 本来就用这个）
   - `effort`: `medium` → `low`（翻译是 `low`，审校是唯一 `medium`）
   
   依据是 3.3 的 2.8 倍出词速度差：审校 54–58 tok/s vs 翻译 156–160 tok/s。审校累计 1,021s 里绝大部分花在这两项差异上，改完估算降到 **约 300s**。
   **不要动 `translation.thinkingMode`**——翻译虽然也是 `enabled`，但实测并不慢（4.4）。
2. **把 `LOCAL_AGENT_POOL_SIZE` 从 4 提到 6（或 8）。** 它是并发预算的除数（不是进程上限，见 4.9）：pool=6 时 `translationConcurrency=4`、`reviewConcurrency=2`、排空后审校 6 路。`49dd39d4` 的翻译墙钟 560s 估算降到 **约 300s**，整体 632s → **约 400s**。代价是并发 CLI 子进程数从 6 涨到 8。

### P1 —— 修数据可信度

3. **`totalInputTokens` 双重计数**（4.5 已给出 49 次调用的确定性证据）。同时更新 `server.test.mjs:801` 的断言。
4. **`formatTurnUsageLog` 的 `cache=` 改成 `hit= / new=`**（4.10）。现在这个字段恒等于 `in=`，等于没印；改完一行就能看出 4.6 的问题。
5. **不要再用 `model.usage.durationMs` 做耗时统计**，改用 `batch.model.response.durationMs` 或 `[model] 耗时`。或者直接在 `summarizeTurnUsage` 里把 `durationMs` 标成 `lastTurnDurationMs`，避免误读。

### P2 —— 修缓存与重试

6. **调整审校 prompt 的字段顺序**（4.6）。把每批必变的 `chapterPath`、`contextChars`、`precedingSegments` 挪到 prompt 末尾，让 glossary / voiceContext / contextGraph 这些大块稳定内容留在前缀里。目标是把审校命中率从 0–9.6% 拉到与翻译同级的 45–60%。
7. **降低规范词标记的丢弃率**（4.3）。20% 的受保护片段被拒、补译吃掉 19% 的翻译时间。根因已知（模型没逐字保留 `__VSA_TERM_NNN__`），三个可选方向：
   - 把标记约束从"契约里的一句话"提到 system prompt 末尾再强调一次（当前只在 `MANDATORY_TRANSLATION_CONTRACT` 里出现一次）；
   - 标记改成更显眼的形状（如 `⟦1⟧`），减少被当成普通文本"顺手翻译"的概率；
   - 在 `canonical-terms.protected` 里补 `missingMarkerIds` 与丢失的标记本身，现在只有片段 id，无法判断是"整个标记消失"还是"标记数量对不上"。
8. **`/segments` 加入轮询汇总**（4.7）。每小时约 170 行噪音。

### P3 —— 结构性，需要设计决策

9. **波次屏障**（4.1）每波浪费 10–25% 的槽位。彻底解决要改成"连续调度 + 每批启动时快照上下文"，会动到上下文可见性语义，不适合顺手改。**先用 P0-2 加大并发缓解**，屏障的相对损耗会随并发数上升而下降。
10. **决定池子的去留**（4.9）。文档链路完全不使用池，4 个预热进程是纯开销。要么让带 taskProfile 的调用也能复用会话（需要 SDK 支持在同一会话上改 thinking/effort），要么干脆关掉文档链路的预热。

---

## 6. 实施记录（2026-11-01 09:40）

用户已自行改完 `accuracyReview` 的任务配置（`model=deepseek-v4.1-flash`、`effort=low`，见 4.4 对照表）。本节记录其余推荐项的落地情况。

### 6.1 已改代码

| 项 | 文件 | 改动 |
|---|---|---|
| P0-2 并发 | `.env` | `LOCAL_AGENT_POOL_SIZE` 4 → **8**；`TRANSLATION_CONCURRENCY` 4 → **6**（否则 pool=8 时翻译仍只有 4 路，白留 2 个槽位）。分配结果：翻译 6 + 审校 2，排空后审校 8 |
| P1-3 输入 token | `usage.ts` | 新增 `totalInputTokens()` = `max(input, cacheRead + cacheCreation)`；`summarizeTurnUsage` 改用它 |
| P1-4 缓存字段 | `usage.ts` | `formatTurnUsageLog` 的 `cache=` 拆成 `hit=` / `new=` |
| P1-5 耗时字段 | `usage.ts`、`literary.ts` | `TurnUsage.durationMs` → `lastTurnDurationMs`，注释写明只覆盖最后一轮；`literary-review` 日志改成 `sdkLastTurn=` |
| P2-6 审校前缀 | `literary.ts` | user prompt 重排：目标语言 → glossary → voiceContext → Context Graph → 章节 → brief 元数据 → 前文 → 待审校片段 |
| P2-7 标记丢弃 | `translationAgent.ts` | 新增 `describeCanonicalMarkerMismatch()`（逐标记 expected/actual）、`buildCanonicalMarkerReminder()`（把本批标记与次数追加到 user prompt 末尾）；`canonical-terms.protected` 增加 `droppedMarkerOccurrences` + `markerMismatches` |
| P2-8 轮询噪音 | `log.ts` | `POLLING_PATH_PATTERNS` 增加 `/projects/<id>/segments$`（锚定项目级路径，不吞 `/runs/<id>/segments`） |
| 文档 | `README.md`、`.env.example` | 新增「调用级计量与耗时口径」一节；并发分配改成两条式子；注明带 profile 的文档调用不进池 |

### 6.2 顺带修的测试缺陷

`tests/server.test.mjs` 的尾部有 **151 行整段重复**（9 个测试 + 分节注释，与 718–868 行逐字节相同），已删除重复副本。测试总数 43 → 34（该文件），全套仍全绿。

### 6.3 验证

- `npx tsc --noEmit` 干净
- `npm test` **332 项全通过**（含新增 5 项：包含式网关不重复计数、`hit/new` 日志格式、标记差异明细、标记提醒、审校 prompt 字段顺序；并发预算测试补了 pool=8 的断言）
- 备用端口启动冒烟：**8 个槽位全部预热成功、0 个失败**，`LOCAL_AGENT_POOL_SIZE=8` 已生效
- 函数级冒烟输出：

```
log   : token in=238,252 hit=22,912 new=215,340 out=55,110
sum   : {"inputTokens":238252,...,"totalInputTokens":238252,"totalTokens":293362,"lastTurnDurationMs":61037,"numTurns":14}
total : 238252 (旧实现 476,504)
remind: 【标记校验】本批 translated_text 必须逐字保留下列占位标记，出现次数不得减少：__VSA_TERM_000__×2。…
```

**改完需要重启本机服务**（`.env` 只在启动时读一次）。重启后 `plan.ready` 应显示 `tConc=6 / rConc=2 / drain=8`。

### 6.4 刻意没做

- **P3-9 波次屏障**：要改成"连续调度 + 每批启动时快照上下文"，会动上下文可见性语义，需要单独设计。
- **P3-10 池子去留**：让带 taskProfile 的调用复用会话需要 SDK 支持在同一会话上改 thinking/effort，不是本仓库能决定的。
- **翻译 payload 的字段顺序**（把 `segments` 挪到最后）没动：`buildUserPrompt` 的输出被多个测试当作 JSON 解析，收益也不如审校侧明确。

### 6.5 下一轮要看的数据

1. `review.drain.expanded` 的 `from/to` 是否变成 `2 → 8`，翻译墙钟是否从 560s 降到约 300s。
2. `canonical-terms.protected.rejectedSegmentCount` 是否从 20% 降下来（标记提醒是否有效）。
3. `hit=` 的实测值：审校是否从 0–9.6% 起来。**注意这一项可能不会因为字段重排而改善**——审校在排空后会同时开 8 路，8 个并发调用各自写自己的缓存，谁都读不到谁。顺序调整只对"同一条 lane 串行"的情形有效。
4. 审校换成 `deepseek-v4.1-flash` + `effort=low` 后，出词速度是否从 54–58 tok/s 提到 150+。

---

## 附录：三个 run 的完整数据

### `57745cfa`（34 段 / 4 批 / 279s）

| 批次 | 段数 | 源字符 | brief | 翻译 | 审校 |
|---|---|---|---|---|---|
| b1 | 6 | 6,749 | 13,121 | 46.8s | 66.1s |
| b2 | 7 | 7,041 | 18,235 | 52.6s | 95.2s |
| b3 | 6 | 7,774 | 13,341 | 43.0s | 100.3s |
| b4 | 15 | 6,794 | 17,076 | 45.1s | 173.5s |

`translationWall=106s`，`review.drain 2→4`，尾巴 173s。

### `49dd39d4`（128 段 / 14 批 / 632s）

`translationWall=560s`，`review.drain 2→4`（待审 4 批），尾巴 72s。
翻译 19 次调用（5 次补译），审校 14 次，`numTurns` 合计 146。

单次耗时（按完成顺序，`*` = 补译）：

```
翻译 25.5 48.5 47.4 61.0 58.0 62.9 36.6* 43.7 52.4 45.1* 46.4 59.4 29.1*
     48.5 52.6 28.8* 31.7 45.9 18.5*            → 842.0s / 19 次
审校 62.5 68.6 74.4 76.0 51.2 74.4 97.3 51.1 101.4 69.8 90.9 79.3 52.3 71.9
                                                  → 1,021.1s / 14 次
```

批次规模（`batch.prompt.ready`）：

| 批次 | 段数 | 源字符 | userPrompt | 批次 | 段数 | 源字符 | userPrompt |
|---|---|---|---|---|---|---|---|
| b1 | 16 | 2,924 | 18,194 | b8 | 7 | 8,000 | 25,804 |
| b2 | 8 | 6,888 | 18,130 | b9 | 6 | 7,884 | 25,026 |
| b3 | 10 | 7,403 | 23,980 | b10 | 11 | 7,335 | 27,820 |
| b4 | 12 | 7,712 | 25,017 | b11 | 6 | 6,873 | 22,282 |
| b5 | 16 | 6,510 | 22,781 | b12 | 6 | 7,889 | 24,425 |
| b6 | 12 | 7,347 | 28,691 | b13 | 5 | 6,409 | 21,527 |
| b7 | 10 | 6,885 | 24,965 | b14 | 3 | 3,459 | 19,715 |

（b1 有 16 段却只有 2,924 源字符，b8 只有 7 段却占满 8,000 字符——按字符切批的直接后果，见 4.8。）

### `e3b602c2`（30 段 / 4 批 / 233s）

| 批次 | 段数 | 源字符 | brief | 翻译 | 审校 |
|---|---|---|---|---|---|
| b1 | 13 | 7,016 | 17,166 | 45.9s | 52.0s |
| b2 | 6 | 6,508 | 13,742 | 61.8s | 70.6s |
| b3 | 4 | 6,703 | 15,811 | 58.7s | 83.9s |
| b4 | 7 | 7,835 | 17,650 | 73.5s | 85.2s |
| 合计 | 30 | 28,062 | — | **239.9s** | **291.7s** |

`translationWall=148s`（4 批 2 路，累计 239.9s → 理论 120s，实际 148s，屏障损耗 23%），`review.drain 2→4`（待审 2 批），尾巴 85s。

这是三次里尾巴占比最高的（36%）——只有 4 个批次，翻译排空时只剩 2 批待审，审校并行度从 2 提到 4 也吃不满，第 4 个槽位始终空着。

### 关键事件核对

| 事件 | `57745cfa` | `49dd39d4` | `e3b602c2` |
|---|---|---|---|
| `plan.ready` tConc / rConc / drain | 2 / 2 / 4 | 2 / 2 / 4 | 2 / 2 / 4 |
| `review.drain.expanded` | ✓ 106s | ✓ 560s | ✓ 148s |
| 翻译调用数 / 批次数 | 4 / 4 | 19 / 14 | 4 / 4 |
| `run finished` usage | ✓ | ✓ | ✓ |
| 错误 / 超时 / 丢弃 | 0 | 0 | 0 |
