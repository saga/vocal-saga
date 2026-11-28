# local-agent-service 小说翻译运行分析（2026-11-28）

范围：本机日志 `~/.vocal-saga-local-agent/logs/local-agent.log`、项目库
`~/.vocal-saga-local-agent/documents/a27037b9-60a6-4117-bada-1961d781d9be/project.sqlite`。
只读分析，未改代码。配套 zip：`local-agent-run-bundle-2026-11-28.zip`。

## 1. 结论

**慢不是本地调度或数据库慢，而是模型调用本身慢，且大部分生成 token 没进译文。**

最新主 run `51bd31b6`（391 段 / 25 批）墙钟 **1399s（23m19s）**，最终 `partial`：390 段采纳、1 段失败。
随后质量审计自动建了修复 run `dde482b0`，**只为 1 段**又花了 **109s**（含一次审校）。
本地 prompt 组装、事件落库、轮询都在毫秒级：同一秒内完成 `batch ready → model 开始`，
服务端轮询最慢 78ms。时间几乎全在 WorkBuddy SDK/模型的往返和生成上。

四个最值钱的发现：

1. **翻译的 thinking 开销爆炸**：translation profile 是 `thinkingMode=enabled` + `thinkingBudgetTokens=8192`。
   翻译 27 次调用输出 **479,095 token**，但最终返回的 JSON 只有 **66,269 字符**；
   按中文约 1.5 char/token 估算，真正译文约 4 万 token，**90%+ 输出是思考/工具过程**，不是译文。
2. **命名依赖波次 barrier 造成空转**：25 批被切成 7 波；第 3 波结束后为等首用译名审校，
   空等 **159s** 才开第 4 波。第 1 波只有 2 批（并发 4 → 2 槽闲置），第 4 波只有 3 批。
3. **审校扩容太晚**：`review.drain.expanded` 在 `translationWall=1347s`、22/25 个审校已完成后才把并发 2→8，
   当时只剩 3 个待审；尾段仍多花约 52s。审校并发全程被压在 2。
4. **结构化输出漏 ID**：3 个批次出现 `batch.partial`（缺 1、1、3 段），其中 1 段直到主 run 结束仍未补回，
   触发自动修复 run。一次超时调用白等 **180s** 后重试。

## 2. 关键数据

| 项 | 值 |
|---|---|
| 主 run | `51bd31b6-4af2-452f-8421-4f8c0514b63d`，`partial`，390/391 采纳 |
| 主 run 墙钟 | 1399s（15:23:35 → 15:46:54） |
| 翻译 | 27 次调用（25 批 + 2 次重试），并发上限 **4**；中位 **101s**，最大 **163s**，另有一次 **180s 超时** |
| 审校 | 25 次调用，并发 2；中位 **47.3s**，最大 **115.8s**；findings 1–7 / 批 |
| 波次 | 7 波：`[2,4,4,3,4,4,4]`；第 3→4 波 barrier 等 **159s** |
| token | 输入 812,836；输出 596,141；cache read 54,336（**翻译 0/27 命中，审校 4/25**） |
| 实际译文 | 27,990 中文字符 / 390 段（avg 72 字/段） |
| 自动修复 | `dde482b0`，1 段，109s；输入 23,445、输出 13,662 token |
| 轮询 | 约 74 次/分钟，23 分钟约 1,700 次 `GET /runs/:id`；服务端最慢 78ms |
| 全书覆盖 | 3,245 段源文，仅 728 段已采纳译文；本次 run 外仍有 **2,516 段未翻译** |

对照上一 run `ceaadd68`（336 段 / 930s）：本次每段墙钟 2.77s → **3.58s（+29%）**；
翻译每次调用中位 66s → **101s（+53%）**，输出 token/段 849 → **1,281（+51%）**。
配置未变（同一 prompt revision，thinking 已启用），变慢来自模型侧输出变长/上游排队，而非代码回归。

## 3. 问题清单（按影响排序）

### P0 — 翻译 thinking 预算是最大的时间与 token 浪费

`prompt config.taskProfiles.translation`：

```json
{ "model": "hy4flash", "fallbackModel": "hy4flash-free",
  "thinkingMode": "enabled", "thinkingBudgetTokens": 8192, "effort": "low" }
```

- 27 次调用输出 479,095 token，最终 JSON 响应 66,269 字符；**约 92% 输出未进入译文**。
- 调用耗时与输出 token 强相关：同一波内 72s→82s→101s，输出 14k→16k→20k token；
  末期 136s / 28.5k token。生成被拉长，不是本地阻塞。
- `hy4flash` 是配置里指定的主模型，**不是 fallback**；审计里的 `requestedModel=glm-5.3-flash`
  是池默认模型，与真正生效的 profile 模型不是一回事（现有日志字段仍容易误导）。

**建议**：翻译 profile 改 `thinkingMode: adaptive` 或 `disabled`，做 A/B 同段对比确认质量后落地；
只保留文学审校的 adaptive。按当前 token 结构，这是唯一能把 run 时间砍半量级的改动。

### P0 — 波次 barrier 与尾段扩容浪费槽位

- `buildRunNameDependencyWaves()` 只在确有首用名依赖时切波，但本次 7 波里有 5 波候选数为 0/1；
  第 3→4 波仍为等待审校结算空等 159s。
- 第 1 波 2 批、第 4 波 3 批，配置并发 4，分别空转 2 / 1 个槽。
- `review.drain.expanded` 只在翻译排空后触发（2→8），此时仅剩 3 个待审，收益有限；
  翻译尾段 4 个槽陆续空出来时审校仍固定 2。

**建议**：把扩容条件从「翻译排空」改成「`reviewLimiter.pending() > reviewConcurrency`
且 `translationLimiter` 有空槽」；barrier 只对真正有未决首用名的批次做局部等待，不等待整波审校。

### P1 — 结构化输出漏段，导致 partial + 自动修复

- `batch.partial`：b2 缺 1 段、b9 缺 1 段、b17 缺 3 段；重试后仅剩 1 段失败。
- b2 第一次调用 **180s 超时**（`LOCAL_AGENT_TIMEOUT_MS` 默认 180s），重试再花 120s+。
- 1 段修复 run 仍走完整链路：12,243 字符 brief（其中 preceding 4 段 3,407 字符）、1 次翻译 73s、
  1 次审校 35s，以及一次 63s 的 `chinese-editorial-profile` 分析，共 109s。

**建议**：对 `missingIds` 做确定性小批次补译（不带 preceding 4 段和完整 contextGraph），
不要起完整 run；把翻译超时从 180s 降到与实测 P95 相符的 ~150s，让漏段更快进入重试。

### P1 — 翻译 prompt cache 完全没命中

翻译 27/27 次 `cacheReadTokens=0`，审校 4/25 次命中（共 54,336）。
每批翻译都带 5,180 字符系统指令 + 4.7k–9.3k 字符 contextGraph + 3.7k–4.6k 字符 voiceContext +
4 段 preceding，输入约 14k token，却没有任何缓存复用。自动修复 1 段也要 13,262 字符 prompt。

**建议**：确认 translation taskProfile 的 CLI 参数是否禁用了 cache（与 adaptive 审校对比）；
把静态系统指令/风格约束放在 prompt 最前面，动态段落放尾部；给补译/修复路径一套短 prompt。

### P2 — 轮询与审计噪声

23 分钟约 1,700 次 `GET /runs/:id`，全部 200、最慢 78ms，不构成瓶颈，但淹没日志、
让真正异常（超时、partial）不显眼。可在无状态变化时用更长间隔或 SSE；至少对「静默轮询」单独归档。

### P2 — 全书覆盖缺口

项目 3,245 段中仅 728 段（22%）有已采纳译文。本次 run 只覆盖用户选中的 391 段（ch03–ch06），
`outOfScopeMissingTranslationCount=2516`。这是 run scope 设计，不是 bug，
但用户若以为「全书翻译完成」会误判；建议在 UI 上明确「本次范围 / 全书进度」。

## 4. 明确不是问题的点

- 本地 CPU/SQLite：brief 组装、事件落库、状态读取都在同一秒或毫秒级完成。
- 网络轮询：1,700 次请求最慢 78ms。
- 模型 fallback：`hy4flash` 是用户配置的主模型，fallback 是 `hy4flash-free`，本次没有触发回退。
- 审校本身：25 批全部完成，findings 均有 revised，无失败。

## 5. 证据索引（zip 内）

- `logs/local-agent.log`：完整原始日志（含 15:23–15:49 全部 run）。
- `logs/run-51bd31b6-15-23-to-15-49.txt`：主 run + 修复 run 的日志切片。
- `db/project.sqlite`：项目库一致性快照（所有表）。
- `json/runs.json`：run 元数据与结果计数。
- `json/events.json`：主 run 全部事件（含 usage / partial / barrier / drain）。
- `json/usage-summary.json`：按阶段聚合的 token、耗时、缓存命中。
- `json/config-snapshot.json`：prompt config、taskProfiles、.env 关键项。
- `text/poll-summary.txt`：轮询汇总。
- `MANIFEST.txt`：文件清单与 SHA-256。

## 6. 状态

只读诊断，未修改任何代码或配置。建议先做 P0（thinking + barrier/扩容），
再跑一次相同 391 段范围对比墙钟和 token；预期 run 时间可从 ~23 分钟降到 10–15 分钟量级。
