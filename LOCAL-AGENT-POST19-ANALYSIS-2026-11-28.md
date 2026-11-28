# local-agent-service 19 点后运行分析（2026-11-28）

范围：本机 `~/.vocal-saga-local-agent/logs/local-agent.log` 与项目 `a27037b9`（《The Republic of Memory》）。
按**本地时间 19:00 之后启动**筛选，只有 2 个 run；日志里 97fe5d63 项目的 19:04–19:14 条目属于 11-10，已排除。
只读分析，未改代码。配套证据包：`local-agent-run-bundle-post19-2026-11-28.zip`。

## 1. 结论

- **速度有提升，但幅度有限**：每段墙钟 3.58s → 2.77s / 2.56s（−23% / −29%）；翻译调用中位 101s → 83.8s / 81.4s（−17% / −19%）。瓶颈仍是模型生成，不是本地调度。
- **两次 run 都 completed，无段级失败**：386/386、236/236 全部采纳；但一次 180s 超时、一次结构化输出漏段后重试成功。
- **翻译质量整体可用且审校有效**：must-fix 全部按建议落地（典型误译被纠正）；规范译名冲突 0，新 run 未引入人名漂移。
- **有 1 个真实状态 bug**：d33d5309 的质量门禁被判 `blocked`，原因是 1 条 must-fix 审校记录仍是 `pending`；但对应译文**实际已修正并被采纳**，属于 finding 闭环未持久化，误报阻塞。
- 翻译缓存仍是 0 命中；全书覆盖仅 41.6%，剩余 1,894 段未译（范围外）。

## 2. 运行数据

| 项 | 基线 51bd31b6（15:23） | 6717f7a6（19:24） | d33d5309（19:45） |
|---|---:|---:|---:|
| 段数 / 状态 | 391 / partial（390 采纳） | 386 / completed | 236 / completed |
| 墙钟 | 1399s | 1069s | 605s |
| 秒/段 | 3.58 | 2.77（−23%） | 2.56（−29%） |
| 翻译调用 | 27（中位 101.0s） | 25（中位 83.8s） | 16（中位 81.4s） |
| 翻译输出 token/段 | 1284 | 1020（−21%） | 1054（−18%） |
| 审校调用（中位） | 25（47.3s） | 25（42.3s） | 15（50.4s） |
| 翻译缓存命中 | 0/27 | 0/25 | 0/16 |
| 审校缓存命中 | 4/25 | 1/25 | 0/15 |
| 波次 | 7（[2,4,4,3,4,4,4]） | 8（[1,2,4,4,4,4,4,2]） | 4（[4,4,4,3]） |
| 运行错误 | 1 段未完成 + 修复 run | 1 次 180s 超时，重试成功 | 1 次漏段，重试成功 |

配置变化（commit `355c090`，18:38）：thinking 仍 `enabled`，但移除 `thinkingBudgetTokens=8192`。
d33d5309 的 prompt revision 已不含该预算；6717f7a6 仍沿用旧 revision，但运行时已按新逻辑执行。
另一个变化：`review.translation.capacity.expanded` 在两次 run 的第 1 秒就把审校并发 2→4（pool=8），结束后才 2→8。

**速度判断**：预算移除 + 审校提前扩容 + 波次减少有贡献，但单次翻译仍需 80–85s，输出 token/段仍约 1,000。
之前预估“砍半到 10–15 分钟”只对更大 run 成立；本次 236 段 10 分钟、386 段 17.8 分钟，属于渐进改善而非数量级变化。

## 3. 运行错误

| 时间 | run | 现象 | 结果 |
|---|---|---|---|
| 19:37:09 | 6717f7a6 | b19 调用 180s 超时（`LOCAL_AGENT_TIMEOUT_MS` 默认），触发重试 | 重试成功，386/386 采纳；净损失约 180s |
| 19:52:23 | d33d5309 | b9 结构化输出漏 1 个 ID（`batch.partial`），chunk 重试 | 236/236 采纳，run 正常 completed |
| 19:55:26 | d33d5309 | 审计 `qualityGateStatus=blocked` | 误报：finding #304（漏前引号）状态/应用状态仍 `pending`，但 11:55:20Z 的采纳译文已含引号 |

无崩溃、无 run 级 `partial`、无段级 `error`；`run_segments` 两次 run 均为全部 `accepted`、attempts=1。

## 4. 翻译质量

**审校闭环**：6717f7a6 的 73 条 finding（16 must-fix + 57 style）全部 `applied`；
d33d5309 的 51 条（13 must-fix + 38 style）中 50 条 `applied`、1 条状态滞后（见上）。
抽样核对：

- `starry as the stars`：初译“星光灿烂”→ 定稿“像群星一样古老”（混合语 star=old，纠正事实与反讽语气）。
- `Krovvy waste of talent`：初译把 Krovvy 当主语 → 定稿保留其为修饰词，语气恢复。
- `parreko but nanti parreko`：初译增译“先” → 定稿删去，保留悖论表达。

**命名一致性**：

- 两次 run 生成 21 / 20 条 `run-canonical` 决策，`correctedCount=0`、`minorityFindingCount=0`、审计 `canonicalNameMappingConflictCount=0`。
- 全书采纳译文中 `坦嫩特 / 坦南特 / 特南特` 命中均为 **0**；此前报告里的问题词未进入采纳译文。
- 两轮采纳译文中 `达米埃塔` 56 处、`行政当局` 42 处；`达米耶塔 / 行政部门` 命中 0。
- 全书范围内仍有旧 run `ceaadd68` 遗留的 `达米耶塔` 6 处、`行政部门` 2 处（ch01–ch02），**非本次产生**，其明细不在精简证据包内。
- 遗留小问题：`Lebanon / Damietta` 被标为 `person`、`Linda Cidade` 被标为 `place`，实体 kind 分类不可靠，但目前未造成译名冲突。

**审计指标**：

| 指标 | 15:48 | 19:42 | 19:55 |
|---|---:|---:|---:|
| 覆盖段数 / 覆盖率 | 729 / 22.5% | 1115 / 34.4% | 1351 / 41.6% |
| 术语漂移 | 2 | 2 | 3 |
| 英文残留 | 6 | 9 | 9 |
| 数字 token 不一致 | 22 | 36 | 58 |
| 规范名映射冲突 | 0 | 0 | 0 |
| 门禁 | — | passed | blocked（误报） |

数字不一致从 36 升到 58（1.8/100 段）值得抽查；英文残留主要是小说刻意保留的混合语（`Por que`、`ahora`、`cogged` 等），不应直接当错译。

## 5. 待改进（按优先级）

1. **修 must-fix 闭环**：采纳修复候选时同步更新 `review_findings.status` 与 `applicationStatus`，避免已修问题仍阻塞门禁。
2. **超时下调**：翻译 180s 超时实测偏长（P95 约 130s）；降到 ~150s 可少浪费 30s/次，并把漏段更早交给重试。
3. **翻译缓存**：两次 run 翻译 cache 仍 0/41；检查 CLI 参数与 prompt 静态前缀顺序（静态指令前置、动态段落后置）。
4. **审校并发交接太晚**：2→8 扩容发生在翻译 Wall 1030s / 556s、仅剩 1–2 个待审时；应在翻译剩余批次数 ≤ 审校并发时提前交接。
5. **旧章译名回填**：ch01–ch02 的 `达米耶塔`（6）、`行政部门`（2）仍留在采纳译文里；应做一次确定性回填，而不是等后续 run 偶然覆盖。
6. **全书进度**：41.6% 覆盖，UI 应区分“本次范围完成”与“全书完成”。

## 6. 证据索引（精简 zip）

证据包从 `event_id=917`（`run.planned`，6717f7a6，19:24:23.926Z）开始，**含该条及其后全部运行事件**；不再打包完整 SQLite。

- `json/events-from-917.json`：`event_id >= 917` 全量事件（含 payload），覆盖 6717f7a6 / d33d5309 及项目级事件。
- `json/runs-summary.json`：两轮 run 的元数据、counts、波次、并发交接、partial/失败、命名汇总。
- `json/usage-summary.json`：按 run/阶段聚合的 token、耗时、缓存命中。
- `json/translation-results.json`：两轮 run 的全部候选/采纳译文。
- `json/quality-audits-full.json`：两轮对应的完整质量审计报告。
- `json/review-findings.json`：全部 must-fix + 未闭环 finding + style 抽样。
- `json/naming.json`：规范名决策与译名命中。
- `json/translation-samples.json`：关键 must-fix 定稿译文与漏引号 case。
- `json/config-snapshot.json`：prompt 配置、关键 .env 项、相关提交。
- `logs/local-agent-post19.txt`：19:24:24 起至 19:56 的原始日志切片。
- `text/poll-summary.txt`：轮询汇总。
- `MANIFEST.txt`：SHA-256 清单。
