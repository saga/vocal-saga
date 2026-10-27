# Project Hail Mary 翻译流水线检查报告

- 项目：`5d9ba4bb-fcf7-4d69-9726-abee381fcb5c`（epub，6196 段）
- 数据来源：`~/.vocal-saga-local-agent/documents/5d9ba4bb-.../project.sqlite`（含 WAL）、`~/.vocal-saga-local-agent/logs/local-agent.log`
- 时间窗口：2026-10-27 20:45–20:59（本地时间，UTC+8；DB 内为 UTC）
- 规模：280 条事件、12 个翻译批次、24 次审校、2 次审计

---

## 一、结论摘要

| # | 级别 | 问题 | 影响 |
|---|---|---|---|
| 1 | **P0** | 自动返工把"未翻译"当成"缺译缺陷"，且**固定从全书开头**取前 100 段重译 | 用户只点"翻译下三页"（序号 216–295），系统静默追加翻译序号 0–99 并自动采纳，多花约 15 万 token |
| 2 | **P0** | 质量审计把 `category='accuracy'` 硬过滤掉 | 7 条 must-fix 准确性发现全部进不了审计报告/指标（`accuracyReviewFindingCount` 恒为 0） |
| 3 | **P0** | 审校发现没有生命周期，`status` 永远是 `pending` | 59 条发现里 6 条其实已修复、1 条真没修，界面无法区分，审校队列永久脏 |
| 4 | **P1** | 术语保护全程为 0（`protections=0`），正文实体没进记忆 | 译名漂移检测是空转，`terminologyDriftCount=0` 是假阴性 |
| 5 | **P1** | 记忆里的风格指南状态是 `candidate`，被 `voiceContext` 整体丢弃 | 用户编辑但未"确认"的风格指南对翻译完全不生效，且无任何提示 |
| 6 | **P1** | 数字校验 100% 误报（`Chapter 1` → `第一章`） | 29/29 条全是噪声，污染审计 |
| 7 | **P2** | token 统计：缓存被重复计算 + 审校/预处理不入账 | 显示值 147K，实际约 230K，双向失真 |
| 8 | **P2** | 日志文件用 `'\\n'` 字面量分隔 | 592KB 全文**一行**，`tail -f` 无法使用（即此前"日志格式不标准"的根因） |

**没有问题的部分**（避免过度归因）：无超时、无 `run.failed`、12 批次输出结构全部合法（`malformedOutput=0`、`unexpectedOutputId=0`）、审校漏 id 时自动重试成功、自动采纳未覆盖人工修订、预处理正确遵守 `knowledgeBoundary` 未泄漏后文人物。

---

## 二、实际发生了什么（时间线）

| 时间 | 事件 |
|---|---|
| 20:45:18 | 保存 epub，切分为 6196 段 |
| 20:45:47 | 全书预处理启动（strategy B，5 个阶段） |
| 20:49:26 | 预处理完成：**6 characters**（Rocky / Stratt / Dimitri / Leclerc / Yáo / 叙述者）、**4 entities**（Astrophage / Taumoeba / Project Hail Mary / Erid）、9 关系 |
| 20:49:44 | 记忆 v2 保存：styleGuide 完整（5 个维度 + 10 条 rules + 7 条 avoid），**entities 仍为 0** |
| 20:50:06 | 运行 `375fb614` 启动：**序号 216–295**（80 段 / 5 批 / 2 并发） |
| 20:50:20–20:54:43 | 5 批初译 + 10 次审校（其中 review-4 漏了 1 个 id，触发重试） |
| 20:55:31 | 完成 → **7ms 内自动采纳 80 段** → 审计 1 → **自动排返工** |
| 20:55:31 | 运行 `e427db1e` 启动（`parent_run_id=375fb614`）：**序号 0–99**（100 段 / 7 批） |
| 20:59:38 | 完成 → 自动采纳 100 段 → 审计 2 → 拒绝第二轮返工（`automatic-repair-pass-limit`） |
| 20:59:39 | 结束，记忆 v4 保存（entities 4，全是版权页实体） |

覆盖率从 1.3%（80/6196）变成 2.9%（180/6196），但**已译区域是 0–99 和 216–295，中间 100–215 是空洞**。

---

## 三、逐项证据与根因

### P0-1 自动返工把"未翻译"当"缺译"，且从全书开头取 100 段

**证据**

审计 1 的指标：

```
sourceSegmentCount: 6196
translatedSegmentCount: 80
missingTranslationCount: 6116          ← 98.7% 的"发现"都是这个
repairableFindingCount: 6151           ← = 6116 + 6 + 29
```

`quality-audit.auto-repair-scheduled`：

```json
{ "segmentCount": 100, "maximumAutomaticPasses": 1, "findingType": "missing-translation" }
```

`quality-repair.planned` 的 `segmentIds` = `epub-title` + `text-part0001-html-00001` … `00099`，即**全书最前面 100 段**，与父运行的范围（216–295）毫无交集。

**根因**（两处叠加）

1. `qualityAudit.ts:1321-1331` —— `missing` 是对**整本书**求差集，与本次运行范围无关：

```ts
const missing = segments.filter((segment) => !translations.get(segment.id)?.trim())
```

2. `translationAgent.ts:2140-2160` —— 取 `slice(0, 100)`，因为 `findings` 是按序号顺序排列的，所以永远是"书首前 100 段"：

```ts
const missingFindings = ...filter(f => f.type === 'missing-translation' && f.repairable === true)
  .slice(0, 100);
```

**后果**

- 任何一本没译完的书，**每次用户运行都会额外触发一次从书首开始的 100 段翻译**，用户完全不被告知。
- 用户读在 216–295，系统却在 0–99 里插译文，造成 100–215 的空洞。
- 代码注释写的是"只自动返工确定性缺译"（`translationAgent.ts:2131`），语义上应指"本次运行声明要做、但没产出译文的片段"，实现却变成了"全书所有还没译的片段"。**注释与实现不一致**。

**建议**

- `missing` 只对 `run.segments` 求差集；无 `runId` 的审计不要把 missing 标成 `repairable`。
- 返工范围必须限制在父运行 scope ∪ 空集合内，禁止跨范围取材。
- 若确实要"补全前文"，应作为用户显式动作（"从当前位置向前补 100 段"），而不是运行结束的副作用。

---

### P0-2 审计把 accuracy 发现整体丢弃

**证据**

`review_findings` 表里本次两轮共有 **7 条 `category='accuracy' / priority='must_fix'`**：

```
375fb614  00229 / 00241 / 00258 / 00287
e427db1e  00005 / 00097 / 00098
```

但审计 2 的报告 `findings` 只有：

```
missing-translation       6016
numeric-token-mismatch      29
style-review                21
character-voice-review       2
```

`accuracyReviewFindingCount: 0`、`repairableFindingCount` 里也不含它们。

**根因**：`qualityAudit.ts:462` SQL 里写死了只取 style：

```sql
WHERE rf.run_id = ? AND tr.source_revision_id = ? AND rf.category = 'style'
```

下游 `qualityAudit.ts:1347` 的 `finding.category === 'accuracy' ? 'accuracy-review'` 分支因此是死代码。

**后果**

- 最高严重级别的问题在审计、指标、返工计划、`auto-disposition` 里**全部不可见**。
- 与 P0-3、P1-4 叠加：`auto-disposition` 因此敢说"剩余发现都是非阻塞的"。

**建议**：去掉该过滤，或在 `metrics` 里单独开 `accuracyReviewFindingCount`，两者不要共用一条 SQL。

---

### P0-3 审校发现没有生命周期

**证据**：`review_findings` 共 59 行，`status` 全部为 `pending`。其中 6 条实际已经修好——例如 `00241`：

```
finding:     初译"多睡了一会儿"属于无依据的具体化
result 98260265 (accepted=0): …加上我又多睡了一会儿。
result ea1adb37 (accepted=1): …加上我又多休息了一会儿。   ← 审校建议已落地
```

真正**没有**修好的只有 1 条，`00229`：

```
原文 "not too rich"（不太腻）→ 初译"一点也不腻"（完全否定）
finding.reason 末句：本机未返回长度合规的完整修正译文，因此没有自动覆盖
accepted 结果只有 1 条，仍是"一点也不腻"
```

**根因**：修好译文的那条路径（审校给出 `proposedTranslation` → 落新结果 → 采纳）**没有回写 finding 状态**；而 `00229` 这条因为"修正译文长度不合规"被静默放弃，也没有标记为 `unresolved`。

**后果**：审校面板会永久堆积 59 条"待处理"，用户无法判断哪些还要管；`00229` 这类真问题被埋在 58 条噪声里。

**建议**：修好即 `status='resolved'` 并记录 `resolvedByResultId`；放弃则 `status='deferred'` + 原因。UI 只展示 `pending`。

---

### P1-1 术语保护全程为 0，漂移检测空转

**证据**（日志，每个批次 × 2 次，共 24 次）

```
[canonical-terms 20:50:06] protections=0 · candidates=0 · conflicting=0
[context-graph 20:50:06] bundle · firstOrdinal=216 · knowledgeBoundary=215
                         · mappings=0 (strong=0) · nodes=0
                         · excluded(nameNotVisible=10, ...)
```

- `excluded(nameNotVisible=10)` —— 图里的 10 个候选（6 人物 + 4 实体）**每一次都被排除**，因为它们在当前批次之前没出现过。这个行为本身是对的（防止剧透式锁名）。
- 但 `nodes=0` 意味着**人物/实体/关系列表在任何批次里都是空的**：`contextGraph.characters=[]`、`entities=[]`、`relationships=[]`。
- 记忆里最终只有 4 个实体，全部来自版权页：`Charlie Chaplin / Andy Weir / Ballantine Books / Penguin Random House LLC`；`characterCount=0`、`characterVoices=0`、`relationships=0`。
- 预处理识别出的 Rocky / Stratt / Astrophage 等**从未进入 `literary_memory`**（记忆保存事件在预处理完成后 18 秒发生，`entities: 0`）。

**后果**：`terminologyFindings` 与 `entityMentionDriftFindings` 都以 `memory.entities` 为基准，而记忆里只有版权页实体 → **`terminologyDriftCount=0`、`entityMentionDriftCount=0` 是"没有可比对象"，不是"译名一致"**。这正是 Yabu / Minowara 那类问题查不出来的结构性原因。

**建议**：预处理完成时应把 `context_graph_nodes` 的 character/entity 以 `suggested` 身份并入记忆（保持"不覆盖 confirmed"策略），否则整条术语链路没有输入。当前只能靠翻译自己的 `context_delta` 反哺，而它只会从已译正文里学到版权页噪声。

---

### P1-2 风格指南卡在 `candidate`，被 voice 通道整体丢弃

**证据**

- 记忆里 styleGuide 内容完整：`narrativeVoice / register / rhythm / dialogue / diction / rules(10) / avoid(7)`。
- 但每个批次的 brief 里：

```json
"contextGraph": { "styleGuide": { ... 9 项 ... }, "sourceStatus": "machine-applied", "styleGuideReady": true }
"voiceContext": { "styleGuide": {}, "styleGuideStatus": "candidate", ... }
```

**根因**：`voiceContext.ts:586`

```ts
styleGuide: memory.styleGuideStatus === 'confirmed' ? memory.styleGuide : {},
```

记忆侧 `styleGuideStatus` 是 `candidate`（图导入时只置为候选），于是 voice 通道返回空对象，但**仍然把 `styleGuideStatus: 'candidate'` 发给模型**。

**后果**

- 同一份风格指南通过两条通道下发：图通道（生效，`machine-applied`）和记忆通道（永久为空）。语义不一致，难以排查。
- 用户手动编辑风格指南但没点"确认"时，翻译完全不使用它，**且没有任何提示**——这与"截图上只有两个是填好的"的体感一致：填了也白填。

**建议**：要么把"从图导入"直接置 `confirmed`（用户已通过点导入表达意图），要么在 UI 明确标注"候选态不参与翻译"。

---

### P1-3 数字校验 100% 误报

**证据**：29 条 `numeric-token-mismatch`，全部长这样：

```
segment: text-part0002-html-00026   chapter: Contents
sourceExcerpt: Chapter 1
explanation: 原文与译文中的数字序列不同…
译文: 第一章
```

`Chapter 1..29` → `第一章..第二十九章`，阿拉伯数字转中文数字，启发式未做归一化。数量从审计 1 的 6 条涨到审计 2 的 29 条，正好等于本轮新增的章标题数量。

**建议**：比对前把 `一二三四五六七八九十百零〇两` 归一化为阿拉伯数字；`kind='heading'` 的短片段可整体跳过。

---

### P1-4 `auto-disposition` 谎报"剩余发现非阻塞"

**证据**

```json
{ "auditId": "75ec834b...", "findingCount": 6068,
  "automaticRepairSkipped": "automatic-repair-pass-limit",
  "remainingFindingsAreNonBlocking": true }
```

此时库里躺着 3 条 `accuracy / must_fix`。因为 P0-2 把它们过滤掉了，代码"看不到"它们，于是无条件写 `true`（`translationAgent.ts:2166`）。

**建议**：`remainingFindingsAreNonBlocking` 应由 `findings.some(f => f.severity === 'must-fix')` 推导，不要硬编码。

---

### P2-1 token 统计双向失真

**证据**

单次初译（`model.usage`）：

```
inputTokens 10925 · cacheReadTokens 6784 · cacheCreationTokens 4141
6784 + 4141 = 10925   ← 5 次调用全部精确相等
```

说明网关的 `input_tokens` **已包含缓存部分**。而 `usage.ts:80`：

```ts
const totalInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
```

→ `totalInputTokens` 恰好是真实值的 2 倍（135,762 = 2 × 67,881），`totalTokens` 随之翻倍。

同时 `run.finished.usage` 只累加初译（日志里 `[literary-review]` 明明打印了 token，但 `model.usage` 事件只有 `translationAgent.ts:1014` 一处产出）：

| 环节 | 调用数 | 真实 in | 真实 out |
|---|---|---|---|
| run1 初译 | 5 | 67,881 | 10,970 |
| run1 审校 | 11 | 98,975 | 52,255 |
| run2 初译 | 7 | 74,690 | 9,304 |
| run2 审校 | 15 | 129,616 | 49,079 |
| 预处理 | 5 阶段 | 167,910（累计） | 40,621 |

run1 显示 `totalTokens: 146,732`，真实约 **230,081**；run2 显示 `158,684`，真实约 **262,689**。**审校成本（占一半以上）完全没有入账**，`translationAgent.ts:2127` 的注释"审校/预处理各自有 model.usage 事件"与代码不符。

**建议**：`totalInputTokens = inputTokens + cacheCreationTokens`（或直接用 `inputTokens`）；审校与预处理补发 `model.usage`。

---

### P2-2 日志文件是一整行

**证据**

```
文件 592,486 字节 · 真实换行 0 个 · 字面 "\n" 5,099 个
```

**根因**：`src/log.ts:33`

```ts
fs.appendFileSync(file, line + '\\n', { encoding: 'utf8' });   // ← 写的是反斜杠 + n
```

应为 `'\n'`。终端输出正常（`console.info` 自带换行），只有落盘文件坏掉，所以 `tail -f local-agent.log` 会看到一条 592KB 的长行。

附带两个可维护性问题：

- 时间戳只有 `HH:MM:SS`，**没有日期**，文件跨 9 天，无法定位某次运行。
- 文件里至少混有 **两个服务进程**（`pid=5506` 与 `pid=68074`）的输出，时间戳不单调（`20:56:26 SIGINT` 之后又出现 `20:45:03` 的启动行），排查时极易误判。

**建议**：`'\n'`；时间戳加 `YYYY-MM-DD`；日志文件按 pid 或按日分片。

---

### P2-3 模型记录与实际情况不符

- `translation_runs.model` 两行都是 `auto`，实际全部使用 `glm-5.3-flash`（`model.usage` 12/12 一致）。
- 审校事件里记录的 `taskProfiles.translation.model = "deepseek-v4.1-flash"`，与实跑的 `glm-5.3-flash` 也不一致——声明值、解析值、实跑值三者没有对齐。

**建议**：`model.usage` 增加 `requestedModel` / `resolvedModel` 两字段，并把 `resolvedModel` 回写运行行。

---

### P2-4 记忆版本号恒为 2

`projectStore.ts:1087` 与 `:1130` 都把 `version` 写死成 `2`，本次 4 个修订全是 `version=2`。任何"回滚到第 N 版"的逻辑都无法工作。

---

## 四、修复优先级建议

| 顺序 | 改动 | 文件 | 工作量 |
|---|---|---|---|
| 1 | 返工范围限定在父运行 scope；无 runId 时 missing 不标 `repairable` | `translationAgent.ts:2140`、`qualityAudit.ts:1321` | 小 |
| 2 | 去掉 `category='style'` 过滤，accuracy 发现进审计 | `qualityAudit.ts:462` | 极小 |
| 3 | 审校发现状态回写（resolved / deferred） | 审校落库处 + `review_findings` | 中 |
| 4 | 预处理实体并入记忆（suggested，不覆盖 confirmed） | 图完成回调 | 中 |
| 5 | 数字校验归一化中文数字 | `qualityAudit.ts` numericFindings | 小 |
| 6 | `remainingFindingsAreNonBlocking` 改为推导 | `translationAgent.ts:2166` | 极小 |
| 7 | `totalInputTokens` 去重；审校/预处理补 `model.usage` | `usage.ts:80`、审校/图路径 | 小 |
| 8 | `log.ts:33` 改 `'\n'`；时间戳加日期 | `log.ts` | 极小 |

第 1、2、8 项各自只需改几行，收益最大，建议先做。

---

## 五、复现方式

```bash
# 复制含 WAL 的项目库（只拷 .sqlite 会读到旧快照）
P=~/.vocal-saga-local-agent/documents/5d9ba4bb-fcf7-4d69-9726-abee381fcb5c
mkdir -p /tmp/hm && cp $P/project.sqlite* /tmp/hm/

sqlite3 /tmp/hm/project.sqlite "
  select run_id, status, parent_run_id, finished_at from translation_runs;
  select run_id, category, priority, status, count(*) from review_findings group by 1,2,3,4;
  select event_type, payload_json from project_events
   where event_type in ('quality-repair.planned','quality-audit.auto-disposition');
"

# 日志（注意：整文件只有一行，必须按字面 \n 切分）
python3 -c "
raw=open('$HOME/.vocal-saga-local-agent/logs/local-agent.log',encoding='utf-8').read()
print('\n'.join(l for l in raw.split(chr(92)+'n') if 'canonical-terms' in l))"
```

## 代码复核结论与修订记录（2026-10-27）

### 已证实并修复

1. **P0：局部 Run 触发全书范围自动返工。** 自动审计可以报告全书缺译，但返工选择没有和父 Run 的片段集合相交，随后按原文顺序取前 100 项。这会把某一章节的局部任务扩展为书首的其它章节。现改为：全书覆盖率继续照常审计，自动返工只选择父 Run 范围内且每个片段 ID 都在该范围内的确定性缺译，100 段上限保留。
2. **P0：质量审计只查询 style Reviewer findings。** SQL 将准确性和术语发现过滤掉了，与下游 accuracy-review / reviewer-terminology-review 映射及对应指标不一致。已移除 category 过滤，并增加三类发现均进入审计报告的测试。
3. **P0：Reviewer finding 状态没有随已采纳修订收敛。** 发现一直保持 pending，即便同一个 Run 已采纳了与该 finding 的 proposedTranslation 完全相同的候选译文。现只在候选确实被采纳、且文本精确匹配建议时，将准确性/术语发现标为 resolved；不匹配的发现仍为 pending，风格建议仍走用户显式处理流程。
4. **P1：英文/中文章节序号比较不一致。** 普通数字解析会识别 Chapter 1 的 1，却不会把第一章当成数量词，导致相同章节序号被误报。现增加严格的章节标题序号识别；相同序号不报差异，不同序号继续报错，并增加回归测试。
5. **P1：自动 disposition 把所有剩余发现硬编码为非阻塞。** 现按本 Run 范围内 must-fix 发现数量计算并记录，不再不加区分地写入 true。
6. **P2：文件日志使用字面量反斜杠-n，不是真换行。** 已修正为实际换行，并把只有时分秒的时间戳改为含日期的可排序本地时间；增加文件级回归测试。

### 需要修正或暂不照单全收的判断

- **文学记忆 revision 的 version = 2 不是已证实的缺陷。** 该字段与 revision UUID、fingerprint 和 created_at 分开存储；同一代码中的分析上下文也使用 version: 2。现有证据更符合数据结构/schema 版本，而不是递增的历史修订编号，所以没有改成猜测性的递增值。
- **不能通过自动把 Style Guide / Context Graph 候选升级为 confirmed 来“修复未生效”。** 服务端明确要求模型提出的记忆先是 candidate；候选与已确认规则具有不同的翻译约束权重。Graph 中的建议映射和 LiteraryMemory 中的用户确认映射也不是同一种信任状态。报告指出两套数据的审计覆盖存在缺口，值得后续单独设计“候选映射的复核提示”，但不能直接写入已确认记忆或让候选静默成为强制规范。
- **原报告关于 Token 双重累加的判断证据不足，已撤回对应统计改动。** 五次样本中 `input_tokens` 恰好等于 `cache_read_input_tokens + cache_creation_input_tokens` 是值得调查的异常，但仅凭数值相等不能证明字段包含关系。CodeBuddy [状态栏文档](https://www.codebuddy.cn/docs/cli/statusline) 明确说当前请求用量遵循 Claude Code 协议，普通输入、缓存写入、缓存读取互不重叠，计算上下文长度时三者相加；[Agent SDK 更新记录](https://app.unpkg.com/%40tencent-ai/agent-sdk%400.3.200/files/cli/CHANGELOG.md) 也说明 input/cacheRead/cacheWrite 应互不相交并相加得到总输入。因此保留 `totalInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens`，并新增测试落实该口径。样本中的等式应作为需要核对原始 result 事件/SDK 版本的观察项，不能用作擅自改口径的依据。另已为初译、文学审校（含缺失 ID 的补审）和 Context Graph 工作流调用补充独立 `model.usage` 事件，且事件记录 `requestedModel`、`effectiveModel` 与可取得的 `resolvedModels`；按阶段可对账，但不能把分阶段事件简单等同于 `run.finished.usage`。
- **模型记录的歧义已部分修正，但不能把请求模型名直接改写成单一实跑模型。** WorkBuddy 的 assistant message 会报告实际 `model`，并可在 `modelUsage` 中报告本次调用涉及的模型；当前初译、审校和 Context Graph 的 `model.usage` 事件因此记录 `requestedModel`、`effectiveModel` 和可用的 `resolvedModels`，单一实跑模型明确时再记录 `resolvedModel`。没有可靠的模型回报时仍保留配置/运行时默认信息，而不是推测。`translation_runs.model` 不被强制覆盖，因为一个 Run 可能使用 fallback 或多个模型。\n- **Context Graph 实体未进入 LiteraryMemory 的问题不宜通过直接合并状态来解决。** 审计目前的 canonical-name 漂移主要依据已确认实体/人物画像；Graph 的候选建议不应被当成已确认规范名。下一步若要提升覆盖率，应新增显式标记为候选、只产生 review 级 finding 的审计路径，并验证语言、来源证据和别名可见性，而不是改变确认规则。

上述结论区分了可由代码路径直接证明的问题和仍需要更多运行证据/独立设计的假设。已新增回归测试覆盖本次确认的行为边界。

### 本次变更验证记录

- `fanyi-extension` 文档工作区 UI 变更通过其 CI；准确性/术语修订不再显示文风专用的采纳/忽略按钮。
- `local-agent-service` 在包含模型元数据传播、审校/Context Graph usage 事件、Token 分项统计及回归测试的代码提交上，专用 CI 已通过（运行记录：[Local Agent Service](https://github.com/saga/vocal-saga/actions/runs/40515865367)；随后仅更新测试 fixture 和本分析报告）。
- `vocal-saga` 根 CI 的 5 个扩展端失败在 `main` 基线提交上也可复现：page cache key 版本断言、两个路由的 source 默认值、旧 `/api/translate/url` 路由断言和翻译历史 source language 断言。它们与本次 `local-agent-service` 改动无直接关系，但仍应另行修正以恢复总 CI。