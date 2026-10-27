# Project Hail Mary 流水线性能分析（log 视角）

- 数据：`project_events`（280 条）+ `~/.vocal-saga-local-agent/logs/local-agent.log`
- 窗口：2026-10-27 20:45–20:59（本地时间，UTC+8）
- 对象：`375fb614`（用户点击，80 段 / 5 批）、`e427db1e`（自动返工，100 段 / 7 批）、预处理 `18b93ff1`

---

## 一、一句话结论

**翻译只占 17% 的墙钟时间，剩下 83% 全在审校；而审校慢的原因不是模型慢，是排队 + 把 1159 个字符的版权页切成了 4 个批次、审了 8 次。**

| | run1 `375fb614` | run2 `e427db1e` |
|---|---|---|
| 总时长 | 324.2s | 247.6s |
| 翻译阶段 | 54.5s（17%） | 48.8s（20%） |
| 翻译完成后到结束 | **269.7s** | **198.7s** |
| 审校模型时间合计 | 521.5s | 419.8s |
| 审校实际并发 | **1.68**（配置允许 4） | **1.76** |
| 审校排队等待合计 | 267.3s | 281.9s |

会话池 6 个，实际只创建了 4 个（`[pool] 新建会话 · slot=0..3`），因为任何时刻最多只有 2 个翻译批次 + 2 个审校任务。

---

## 二、时间到底花在哪

### 2.1 翻译阶段已经打满，没有优化空间

| run | 波次 | 各批模型耗时 | 波次墙钟 | 合计 |
|---|---|---|---|---|
| run1 | 3 波（2+2+1） | 13.9 / 16.0 ‖ 17.4 / 19.8 ‖ 18.6 | 16.0 + 19.8 + 18.6 | **54.4s** |
| run2 | 4 波（2+2+2+1） | 9.5 / 16.9 ‖ 6.2 / 8.8 ‖ 11.9 / 13.5 ‖ 9.5 | 16.9 + 8.8 + 13.5 + 9.5 | **48.7s** |

模型时间总和 85.7s，墙钟 54.4s → 并发 1.57（上限 2）。波次屏障只浪费 2s（b2 比 b1 早 2s 完成，要等它）。
**翻译侧没有可优化的东西**，不要再调 `translationConcurrency`。

### 2.2 审校：24 次调用，串行排队

| run1 | 耗时 | | run2 | 耗时 |
|---|---|---|---|---|
| review-1 / 2 | 45.7 / 53.8s | | review-1 / 2 | 37.8 / 17.3s |
| style-review-1 / 2 | 28.3 / 36.8s | | style-review-1 / 2 | 34.3 / 12.0s |
| review-3 / 4 | 57.2 / 72.2s | | review-3 / 4 | 12.5 / 23.0s |
| style-review-3 / 4 | 49.3 / 50.5s | | style-review-3 / 4 | 5.6 / 26.0s |
| review-5 | 80.2s | | review-5 / 6 | 52.4 / 36.1s |
| style-review-5 | 47.5s | | style-review-5 / 6 | 40.4 / 41.0s |
| | | | review-7 | 42.7s |
| | | | style-review-7 | 38.7s |

两个事实：

1. **同一批次内 accuracy → style 严格串行**（`translationAgent.ts:1751` 的 `await runStyleReview()`）。run1 每批固定 74–128s。
2. **审校槽位只有 2 条**：批次 3/4/5 翻完之后干等，`review.batchContext.ready` 比 `batch.translation.completed` 晚 56.5s / 68.8s / **142.0s**。run2 的批次 7 等了 **117.3s**。

排队合计 549s，几乎等于两个 run 的总时长。

### 2.3 根因：按「16 段」切批，而不是按「字符」

| 批次 | 段数 | 原文字符数 | 审校耗时 |
|---|---|---|---|
| run2 b2 | 16 | **281** | 17.3 + 12.0 = 29.3s |
| run2 b3 | 16 | **157** | 12.5 + 5.6 = 18.1s |
| run2 b4 | 16 | **296** | 23.0 + 26.0 = 49.0s |
| run2 b7 | **4** | **425** | 42.7 + 38.7 = 81.4s |
| run1 b5 | 16 | 2870 | 80.2 + 47.5 = 127.7s |

`maxBatchSegments = 16`（`projectStore.ts:62`），`maxBatchSourceChars = 8000`。实际每批只用掉 **157–2870 字符，平均 1200，占预算的 15%**。

版权页那 1159 个字符（`All rights reserved.` 这类短行）被切成 4 批，触发 **8 次审校、177.8s**，占 run2 全部耗时的 **72%**。而它只是版权页。

---

## 三、可以省掉的 7 处耗时（按收益排序）

### ① 改成按字符切批 —— 单项收益最大

run2 的 100 段原文合计只有 4580 字符，被切成 7 批；run1 的 80 段合计 8955 字符，切成 5 批。

**改法**：`maxBatchSegments` 由 16 提到 40–48，让 `maxBatchSourceChars`（8000）成为真正的约束；或直接按累计字符数切，段数只作安全上限（防 JSON 过长）。

| | 现在 | 改后（目标 4000 字符/批） |
|---|---|---|
| run1 批次数 | 5 | 3 |
| run2 批次数 | 7 | **2** |
| run2 审校次数 | 14 | 4 |
| run2 预计墙钟 | 247.6s | **~110s** |

风险：单批输出变长，JSON 截断概率上升。建议保留 `maxBatchSegments` 硬上限 40，并对 `output` 截断做重试（已有 `chunkMissingTranslationItems` 机制可复用）。

### ② 把 accuracy 与 style 两次审校合并成一次调用

两者输入完全相同（原文 + 初译 + 同一份 brief，各 8.2–9.3K chars），只是评分维度不同。现在是串行两次往返。

- 审校调用数：10 → 5（run1）、14 → 7（run2）
- 每批审校时间：74–128s → 约 60–80s（一次调用同时出两类 finding）
- 审校 token：约减半（run1 98,975 in / 52,255 out → 约 55K / 30K）

**代价**：style review 目前审的是「accuracy 修正后」的文本（run1 b2：review 输出 12:51:14.722，修正结果 12:51:14.724，style 输入 12:51:14.727）。合并后 style 只能审初稿。折中方案：保留串行，但只在 accuracy **确实产生了修正**时才重审该批次的 style，否则并行。

### ③ 自动返工整轮（`e427db1e`）

100 段、7 批、247.6s、约 178K token —— 全是用户没要求的内容（详见 `project-hail-mary-pipeline-analysis.md` P0-1）。
**直接省掉整轮**。

### ④ 审校排队 549s

即便不改切批，也可以让审校槽位真正用满：当前 `reviewConcurrency = 4` 但永远凑不齐 4 个可审批次（翻译一次只产出 2 个）。而 `translationConcurrency = poolSize - reviewConcurrency = 2`。

**改法**：把预算反过来分配 —— 翻译 4 / 审校 2（`poolSize 6`），翻译先跑满 4 批，审校再消费；或把 `LOCAL_AGENT_POOL_SIZE` 提到 8 并保持 4/4。

### ⑤ 预处理 5 阶段串行 + 共享会话，输入 token 二次膨胀

| 阶段 | 完成时间 | 耗时 | 累计输入 token |
|---|---|---|---|
| style | 20:46:43 | 56s | 15,761 |
| characters | 20:47:21 | 38s | 42,080 |
| entities | 20:48:05 | 44s | 75,748 |
| relationships | 20:48:40 | 35s | 118,184 |
| chapters | 20:49:25 | 45s | **167,910** |

`contextGraph.ts:965` 的 `for (const stage of CONTEXT_GRAPH_WORKFLOW_STAGES)` 严格串行，且每阶段都把 `aggregate`（前面所有阶段的输出）拼进 prompt，共享同一个 workflow session → 第 5 阶段一次要读 16.8 万 token。

合计 219s、约 419K 输入 token。style / characters / entities / relationships 之间没有强依赖，若改成 4 个独立并行调用（各自只带基础样本 + 前序摘要），预计 **~60s、输入 token 降到 1/3**。

这一项在用户视角是「打开新书后要等 2 分 40 秒才能开始翻译」。

### ⑥ 采纳时机：首屏延迟 = 整个 run

`translations.accepted` 在 `run.finished` 之后才发（run1：12:55:31.152 → 采纳 12:55:31.153，7ms）。也就是说用户点完「翻译下三页」，要等 **324s** 才能看到第一段译文，尽管第一批译文在 12:50:22 就好了。

审校修正本来就是在 run 中途落库并采纳的（`ea1adb37` 于 12:51:14 落库、accepted=1），说明「先采纳初稿、后续被修正版替换」的机制已经存在。

**改法**：`batch.completed` 时立即采纳该批候选，审校继续在后台跑；修正结果按现有路径覆盖。首屏从 324s 降到 **~35s**。

### ⑦ 重复计算的小项（单项几十毫秒，但每天都在跑）

| 现象 | 次数 | 说明 |
|---|---|---|
| `[canonical-terms] protections=0 · candidates=0 · conflicting=0` | 24 次/run | 同一批扫 3 遍（prompt 构建、review 前、review 后），结果全 0 |
| `[voice-context] built · … chars=1377` | 5–7 次/run | 5 个连续批次输出完全相同（同一 memory revision + 同一 wave），可缓存 |
| `literary memory validated` | 同一秒 7 次 | 同一 revision 重复校验 |
| `quality_audits.report_json` | 2.24MB / 次 | 每次 run 都全书写一份，6016 条 missing 各带 240 字 excerpt；全书译完约 230 页 → 100+ 次 → **200MB+** |
| `[agent] 已等待 30s · 已收文本 0 字` | 24 条 | 流式文本始终为 0，说明 SDK 侧没有真正流式输出，心跳纯噪声 |

---

## 四、不该动的地方（避免过度优化）

- **翻译并发 2**：模型时间 85.7s / 墙钟 54.4s，已经 1.57/2，波次屏障只浪费 2s。改大反而破坏 `freeze-within-wave` 的一致性。
- **审校 retry**：run1 review-4 漏了 1 个 id，补审只花 18.3s，这个重试是净收益。
- **`knowledgeBoundary` 过滤**：导致 `mappings=0`，但那是防剧透的正确行为，不是性能问题。
- **单批 16 段的 JSON 校验**：`malformedOutput=0`、`unexpectedOutputId=0`，输出结构很稳，不要为了提速去掉校验。

---

## 五、改动清单与预期收益

| 顺序 | 改动 | 位置 | 预期收益 | 风险 |
|---|---|---|---|---|
| 1 | `maxBatchSegments` 16 → 40（让字符数成为约束） | `projectStore.ts:62`、`:83` 范围 4–24 → 4–48 | run2 247s → ~110s | 低（有截断重试） |
| 2 | 去掉自动返工 / 限定 scope | `translationAgent.ts:2140` | 省掉整轮 247s + 178K token | 低 |
| 3 | 两审校合并，或仅在产生修正时串行 | `translationAgent.ts:1751` | 每批 −30~50s，token 减半 | 中（style 审初稿） |
| 4 | 池子分配 4 译 / 2 审，或池子提到 8 | `translationAgent.ts:172-177` | 排队 549s → ~150s | 中（内存/进程数） |
| 5 | 预处理阶段并行化 | `contextGraph.ts:965` | 219s → ~60s，token −2/3 | 中（需重做 prompt 组装） |
| 6 | 按批采纳 | `translationAgent.ts:2058` | 首屏 324s → 35s | 中（译文会二次变动） |
| 7 | 缓存 canonical-terms / voice-context，审计报告瘦身 | 各处 | 每次 run 数十 ms + DB 不再膨胀 | 低 |

只做 1 + 2，用户体感就从 **「点一下等 9 分钟、结果还多翻了 100 段」** 变成 **「等 2 分钟、只翻我要的那 3 页」**。
