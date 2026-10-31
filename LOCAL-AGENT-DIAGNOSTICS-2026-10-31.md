# Local Agent Service 运行诊断报告

> 诊断日期：2026-10-31  
> 数据来源：用户提供的 \`local-agent-diagnostics-2026-10-31T08-45-03-107Z.tar.gz\`  
> 诊断范围：压缩包中最近更新的两个未归档 Document Project，以及与之对应的持久化 Run、Context Graph、审校和质量审计记录。  
> 限制：原始压缩包没有包含服务端日志、CodeBuddy/Workbuddy SDK transcript、操作系统退出原因或进程监控数据。因此可以确认“发生过服务重启和模型调用超时”，但不能从本包确定服务为何重启或 Workbuddy 为何未响应。

## 一、结论摘要

当前看到的主要问题不是 EPUB 解析或 Context Graph 全面失效，而是**长任务的运行连续性、Reviewer 超时，以及自动质量修复的范围控制**。

1. **Proust 项目出现至少三条由进程中断/服务重启恢复逻辑生成的失败记录（两条翻译 Run、一条 Context Graph Run）。** 一次 Context Graph 分析在五个阶段中完成三个后中断；两次自动质量修复 Run 也因 service restart 进入 failed。中断后的候选译文仍留在数据库，但没有进入 accepted 状态。
2. **局部翻译 Run 会触发全书缺译审计，并自动扩展为最多 100 段的补译 Run。** Proust 的两次普通 Run 分别只翻译 11 段和 21 段，结束后却各自启动了 100 段自动返工。若用户选择的是局部章节/片段，这会越过原 Run 的选择范围。
3. **Workbuddy Reviewer 多次达到 180 秒超时。** Proust 项目记录到 5 次 review.audit.failed / stage.warning；初译结果被保留，但对应批次没有完成审校。
4. **重启恢复事件中的计数不准确。** 恢复代码把失败 Run 的 candidate/accepted/failed/total 全部写成 0，但数据库中对应 Run 实际还保留 100 个 candidate，或 78 个 candidate 加 22 个 pending。事件时间线因此无法真实反映恢复前的工作量。
5. **最新状态并非所有项目都失败。** New Yorker 的 Context Graph 已完成，但该项目尚无翻译 Run；Proust 的最新 Context Graph 也已在重试后完成。真正未完成的是自动质量修复任务及其留下的候选段落。

优先级上，先处理“局部 Run 触发全书自动补译”和“Run 恢复/终态计数”两个控制面问题，再调查进程重启和 Provider 超时。不要仅通过加大并发或延长所有超时来处理。

## 二、压缩包为什么这么大

压缩包大小为 **11,890,253 bytes（约 11.3 MiB）**，解压后文件总量约 **52,922,345 bytes（约 50.5 MiB）**。它只包含两个项目，但每个项目 JSON 都导出了大量与当前故障判断无关的原始正文和派生表。

| 文件/内容 | 原始大小或记录量 | 问题 |
|---|---:|---|
| Proust 项目 JSON | 49,855,006 bytes | 占两个项目 JSON 总量的绝大部分 |
| New Yorker 项目 JSON | 3,047,164 bytes | 也包含原文与完整 Source Feature 行 |
| Proust Context Graph Source Features | 24,016,727 bytes | 7,366 行派生特征；诊断状态只需要总数与索引摘要 |
| Proust currentSourceSegments | 10,065,269 bytes | 导出整本书所有原文正文 |
| Proust qualityAudits | 8,352,221 bytes | 完整审计 JSON，包含数千条 finding 和原文摘录 |
| Proust project events | 4,317,170 bytes | 完整 payload 中包含 Reviewer input、audit 等大型嵌套对象 |
| Proust TranslationBriefs | 663,281 bytes | 导出完整 Brief JSON，而不是只保留 hash、字符数、批次和 segment IDs |
| macOS AppleDouble 元数据 | 6 个 \`._*\` 文件 | 每个 163 bytes；数量不大，但属于无用归档噪声 |

这些字段有重复内容，不能将行大小简单相加视为额外磁盘占用。核心问题是脚本同时导出原文、逐段派生特征、完整质量报告和完整事件 payload。它们有助于重建内容质量问题，但并不是判断当前运行状态的必要条件。

旧脚本还把完整 Prompt、LiteraryMemory、审校正文、译文候选和 source text 写入 JSON。对于需要分享给外部诊断工具的压缩包，这种默认行为过度采集了书稿和译文内容。

### 已修改的打包策略

已更新 \`local-agent-service/scripts/collect-diagnostics.mjs\`，同时更新了 \`local-agent-service/README.md\` 中的诊断包说明。

新版本改成**状态摘要优先，正文默认不导出**：

- 保留来源版本、片段数/长度统计和少量 segment metadata sample，不导出 source text。
- 保留 Prompt / LiteraryMemory revision ID、fingerprint、大小和有限的配置摘要，不导出完整 Prompt 或 Memory。
- 保留 Run scope（总数与少量 ID sample）、状态、错误、Run Segment 状态计数。
- 保留 translation result 数量、origin/provider/model 分布和文本长度，不导出译文。
- 保留 Reviewer 类别与状态分布，不导出 finding 的原文/译文摘录。
- 保留 TranslationBrief 的 hash、批次、字符数和 segment ID 数量，不导出 Brief JSON。
- Context Graph 只保留节点/边/证据/章节/source feature 的计数、分析阶段、耗时、invalid evidence 计数和版本信息。
- Quality Audit 只保留 metrics、finding 分类计数和少量 finding ID，不导出完整 findings。
- 事件时间线只保留诊断相关事件及安全字段，不保留嵌套的原始审校输入或原文 payload。
- 默认额外包含服务日志末尾最多 512 KiB 中筛选出的最多 180 行生命周期/异常/超时记录；可用 \`--no-logs\` 完全关闭。
- 使用 \`COPYFILE_DISABLE=1\` 调用 macOS tar，避免将 AppleDouble \`._*\` 元数据写入归档。

新包仍可能包含项目标题、segment ID、时间、Provider/Model 名称和错误消息，因此不是匿名数据；分享前仍需检查 README、summary 和日志摘录。

## 三、项目状态与故障证据

### 3.1 New Yorker：预处理成功，尚未开始翻译

项目：\`13294638-d68e-4373-b5d9-2a71a47a5d92\`  
标题：\`new yorker.2026.11.02\`

| 指标 | 结果 |
|---|---:|
| Source segments | 709 |
| Context Graph samples | 72 |
| Graph chapters | 9 |
| Graph characters / entities / relationships | 40 / 34 / 43 |
| Invalid evidence | 10 |
| Context Graph 状态 | completed |
| Translation Runs | 0 |
| Translation results / Review findings | 0 / 0 |

Context Graph Run \`32c29f13-1793-4447-bcf2-89bb0d85c932\` 从 08:35:59 到 08:43:41 完成，五个阶段均完成。运行时长约 461 秒。10 条证据因 \`quote-not-found-in-cited-sample\` 被判无效；关系候选处理时另有 21 条因缺少 endpoint 被丢弃。这说明来源证据校验在工作，并没有把所有模型输出无条件写入图谱。

需要注意：该项目在自己的 bookSummary 中被识别为《纽约客》综合性期刊，而非单一小说。72 个样本中生成 40 个角色候选、34 个实体和 43 条关系，后续翻译时应留意这种出版物的多栏目结构，不能将跨栏目出现的人物或实体关系误当成同一条连续叙事线。

**判断：** 该项目当前没有翻译错误证据，因为还没有创建翻译 Run。当前仅能确认预处理已完成。

### 3.2 Proust：Context Graph 最终完成，但翻译与自动修复被多次中断

项目：\`d871e550-d68d-425b-b0bb-1f6598c5f8da\`  
标题：Marcel Proust《追忆似水年华》多卷 EPUB

| 指标 | 结果 |
|---|---:|
| Source segments | 7,366 |
| Graph chapters | 43 |
| 最新 Context Graph samples | 72 |
| 最新 Graph characters / entities / relationships | 40 / 13 / 54 |
| 最新 Graph invalid evidence | 11 |
| Translation Runs | 4（2 completed，2 failed） |
| Translation results | 215 |
| Run Segment 状态 | 32 accepted、178 candidate、22 pending |
| Reviewer findings | 61（5 accuracy、1 terminology、55 style） |

Context Graph 有三次运行记录：

| Run ID | 时间（UTC） | 最终状态 | 说明 |
|---|---|---|---|
| \`4a2a7085-c84d-4666-a468-dbd43d392d0d\` | 10-30 10:09–10:17 | completed | 五个阶段完成 |
| \`8592a314-9270-416a-92e5-934e9559ff3d\` | 10-31 00:33–00:37 | failed | 只完成 style、entities、characters 三阶段；事件记录 service restart |
| \`ccdb6613-968b-428c-bb94-48b923f444e6\` | 10-31 08:26–08:35 | completed | 后续重新运行，五个阶段完成 |

最新图谱并非运行中状态。它的 11 条 invalid evidence 中，9 条引用未在指定采样片段中找到，2 条没有 evidence；这类内容应保持无效，不应进入强约束记忆。

## 四、主要问题分析

### P1：本机服务重启中断了长任务

证据：

- Translation Run \`db3804eb-ee28-4bc6-981e-1102858f8a1b\` 在 2026-10-30 12:40:57Z 以 \`recovery: service-restart\` 结束。
- Translation Run \`d5588ff1-adb5-48a6-98b8-29e073417522\` 在 2026-10-30 23:34:12Z 以相同原因结束。
- Context Graph Run \`8592a314-9270-416a-92e5-934e9559ff3d\` 在 2026-10-31 00:37:34Z 记录 \`process-interrupted\`。
- 两个翻译失败 Run 都属于自动质量修复（scope automation.kind = \`quality-audit-repair\`）。

这不是模型返回格式错误，而是持久化 Run 在进程恢复检查时发现仍处于 running/queued，于是被标记为 failed。候选结果仍在 SQLite 中，但任务没有被视为完成。

**根因尚不能确定。** 原始 bundle 的 README 明确说明没有收集服务日志和 SDK transcript，因此无法判断是用户手动重启、开发模式 watcher 重启、Node 崩溃、系统休眠/关机、OOM，还是其他进程退出原因。现在的新诊断包已加入有限的本机生命周期日志摘录，下一轮才能进一步定位。

### P1：局部 Run 触发了全书缺译自动修复，造成范围扩张

这是本次记录中最值得检查的调度行为。

两个成功的普通翻译 Run：

| Run ID | 原始 Run scope | 最终 accepted 段数 |
|---|---|---:|
| \`81469f74-6d18-46ee-be24-d0561f5a6364\` | 11 个指定 segment IDs | 11 |
| \`f0d669ba-c88b-4a74-b145-649b74f311aa\` | 21 个指定 segment IDs | 21 |

两个 Run 完成后均触发全书质量审计。审计按整个 7,366 段来源版本计算当前译文覆盖：

- 第一次审计：11 段已译，7,355 段缺译，覆盖率 0.1%。
- 第二次审计：累计 32 段已采纳，7,334 段缺译，覆盖率 0.4%。

随后各自自动创建 100 段质量修复 Run：

- \`db3804eb-ee28-4bc6-981e-1102858f8a1b\`：100 个 segment IDs，automation pass 1。
- \`d5588ff1-adb5-48a6-98b8-29e073417522\`：100 个 segment IDs，automation pass 1。

代码路径也印证了这条行为链：

- \`translationAgent.ts\` 在 completed/partial Run 后调用 \`runProjectQualityAudit(projectId)\`，该调用不传 runId，因此审计当前来源版本的全书覆盖情况。
- 然后将全书的 \`missing-translation\` findings 取前 100 条并创建 automatic repair Run。
- \`qualityAudit.ts\` 将这些 segment IDs 固定进新的 Run scope。

该策略可能是为了自动补齐尚未翻译内容，但它没有根据父 Run 的 scope 限制自动修复范围。因而用户只选择一个章节或一小组片段，也可能在任务结束后自动触发对其他片段的翻译。

**建议：** 在调度策略中明确区分“全书翻译 Run”和“局部 Run”。局部 Run 的全书审计可以保留，但不应默认启动全书缺译补译；自动补译范围应限制在父 Run scope，或由显式的全书自动补齐策略允许。若产品本来就希望每次局部翻译都逐步补齐整本书，应在 UI/状态里明确告知范围扩张，而不是悄悄发生。

### P1：两次自动修复 Run 失败后留下大量未采纳候选

持久化状态与失败终态如下：

| Run ID | Run status | Run Segment 状态 | 说明 |
|---|---|---|---|
| \`db3804eb-ee28-4bc6-981e-1102858f8a1b\` | failed | 78 candidate、22 pending | 进程重启中断 |
| \`d5588ff1-adb5-48a6-98b8-29e073417522\` | failed | 100 candidate | 进程重启中断 |

因此 Proust 当前 32 段 accepted 并不代表所有模型已生成文本都丢失。还有 178 个 candidate 和 22 个 pending。它们没有被自动采纳，不能直接等同于 accepted translation；需要根据现有恢复/用户操作机制重新处理，避免把“模型已生成”误报为“翻译已完成”。

### P2：Reviewer 调用发生 5 次 180 秒超时

Proust 记录到 5 个 \`review.audit.failed\`，全部是：

\`Workbuddy 调用超时（180s 内未返回）\`

对应 Run：

- \`f0d669ba-c88b-4a74-b145-649b74f311aa\`：4 次（batch 1、2、3、4）。
- \`d5588ff1-adb5-48a6-98b8-29e073417522\`：1 次（batch 2）。

每次之后都记录了 \`stage.warning\`，并明确说明“审校失败，已保留有效初译，不影响本批翻译候选”。因此这类失败不会自动抹掉初译，但会造成对应审校缺失；对于文学翻译，人物声音/文风审校没有完成时不能假定质量检查已通过。

目前配置中的普通请求 timeout 为 180,000 ms。超时原因可能与 Provider 响应时延、会话上下文、服务端并发或 SDK 调度有关；现有项目事件不足以区分这些可能性。需要结合新包中的服务日志以及 Workbuddy request/session 层的耗时和排队记录分析，不能直接认定是模型能力问题。

### P2：服务重启恢复事件把真实候选计数写成 0

两个失败翻译 Run 的 \`run.finished\` 事件 payload 都报告：

\`candidate: 0, accepted: 0, failed: 0, total: 0\`

但同一项目数据库中的 \`run_segments\` 显示：

- Run \`db3804eb...\`：78 candidate + 22 pending。
- Run \`d5588ff1...\`：100 candidate。

代码原因明确：\`projectStore.ts\` 的 \`recoverInterruptedRuns()\` 在发现没有既有终态事件时，硬编码写入零计数，而不是从 \`run_segments\` 汇总真实状态。

这会让事件时间线、诊断统计和可能依赖终态 counts 的 UI 显示不准确。它没有删除候选行，但掩盖了恢复前真实的工作量。

**建议：** 恢复 Run 时从数据库计算 candidate/accepted/pending/failed/total，并将状态行与终态事件在同一事务中保持一致。对已经存在的终态事件则继续采用当前的 reconciliation 逻辑。

## 五、目前不能据此得出的结论

- 无法确定三次中断是否由同一个根因引起。原始包缺少服务端日志和进程退出信息。
- 无法确认 Workbuddy 180 秒超时是 Provider 限流、模型排队、网络错误、SDK session 阻塞还是本机并发资源问题。
- New Yorker 项目没有 Translation Run，因此不能评价其译文质量。
- Proust 的全书覆盖率只有 0.4%，这是当前持久化 accepted 状态的覆盖率；它不意味着模型已经生成的所有文本都不存在，因为仍有大量 candidate/pending。
- invalid evidence 被校验拒绝是保护行为，不应仅凭 invalid count 就判断 Context Graph 整体失败。

## 六、建议处理顺序

| 优先级 | 建议 | 原因 |
|---|---|---|
| P1 | 局部 Run 不触发全书自动补译，或显式提示用户并限定 repair scope | 避免用户只翻译所选章节却自动翻译其他段落 |
| P1 | 修复 restart recovery 的 Run Segment 计数 | 保证 UI、事件流和诊断报告反映真实持久化状态 |
| P1 | 检查本机服务进程生命周期和重启来源 | 同一项目多次分析/修复被 process restart 中断 |
| P2 | 对 Reviewer 180s timeout 增加按阶段、批次、requestId 的耗时与队列指标 | 分辨 Provider 慢、并发拥塞与 SDK 调用卡住 |
| P2 | 对失败 Run 的 candidate/pending 提供明确的恢复策略和状态提示 | 候选不能隐式当成已完成，也不应丢失 |
| P3 | 对综合期刊/多栏目 EPUB 增加文档类型与栏目边界提示 | 防止跨栏目人物/实体被错误连成单一叙事关系 |

不要先把全局 timeout 一律调大，也不要先提高 Reviewer 并发。这会掩盖排队或资源问题，并可能放大超时任务的堆积。应先拿到服务日志，测量各阶段实际耗时和并发，再做针对性调整。

## 七、修改文件

本次已更新：

- \`local-agent-service/scripts/collect-diagnostics.mjs\`：改为紧凑诊断包，默认不导出书稿/译文/完整 Prompt/原始大型记录；增加有限服务日志摘录及 \`--no-logs\`。
- \`local-agent-service/README.md\`：同步新的诊断包字段、隐私边界和命令说明。

本报告先记录压缩包中的原始运行事实；后续发现的代码问题及整改状态统一列在 §8。

## 八、整改状态（2026-10-31）

根据本报告发现，已经将以下修复提交到 `main`：

| 问题 | 代码修改 | 保护规则 |
|---|---|---|
| 局部 Run 自动扩展到全书补译 | `translationAgent.ts` 只从全书审计结果中选取父 Run 成员的缺译段；新增 `getRunSegmentIds()` 读取不可变 Run 成员 | 局部 Run 不会因全书其它位置存在缺译而启动越界自动返工 |
| 自动返工入口缺少范围/类型门禁 | `qualityAudit.ts` 再次验证父 Run、来源版本、父 Run 状态、finding 类型及 segment membership | 自动返工仅接受父 Run 范围内的 repairable `missing-translation`；不接受术语/文风等其它 finding |
| 重启恢复事件计数写成 0 | `projectStore.ts` 在恢复时先把中断的 running segments 归为 pending，再按数据库实际状态汇总 counts | `run.finished` 的 total/candidate/accepted/failed/pending 等值与持久化状态一致 |
此外，Reviewer deadline 同时传递给 Workbuddy SDK 与 OpenCode 子进程；OpenCode 仍保留它自己的 SIGTERM→SIGKILL 有界终止流程。

| Reviewer 180 秒超时过短 | 新增 `LOCAL_AGENT_REVIEW_TIMEOUT_MS`，默认 300,000 ms；accuracy/style Reviewer 独立使用 | 普通 `LOCAL_AGENT_TIMEOUT_MS` 仍为 180,000 ms；Reviewer 超时仍会 interrupt 并丢弃不可信 Session，不会无限等待 |
| 新超时值无法在压缩包中追踪 | `collect-diagnostics.mjs` 允许列表增加 `timeoutMs` | 下一次诊断包可按 Run Plan / Reviewer Stage 看到实际 deadline |

新增了回归测试：

- `tests/document-run-recovery.test.mjs`：覆盖 running→pending、candidate 保留及真实恢复计数。
- `tests/quality-audit.test.mjs`：覆盖父 Run 范围内/范围外自动返工，以及禁止对非缺译 finding 自动返工。
- `tests/reviewer-timeout.test.mjs`：验证 Reviewer timeout 能穿透 `runAgentJson`，实际终止超时的 OpenCode 子进程。

**验证状态：** 本次编辑通过 GitHub Contents API 提交；当前执行环境无法从 GitHub 拉取仓库到本地，因此这里不声称 npm test 或 typecheck 已通过。仓库现有 GitHub Actions workflow 会在 `local-agent-service/**` 变更后执行 `npm test`、`npm run typecheck`、API manifest 检查和确定性扫描基准，需以该 workflow 实际结果为准。

**仍未确认的事项：** 本次诊断包没有操作系统退出原因或进程管理器日志，所以没有修改服务进程的 SIGTERM/SIGINT 生命周期，也没有声称已经找到重启的系统级根因。下一次运行新版 `diagnose:bundle` 后，检查 `service-log-excerpt.txt` 中的 signal、shutdown、uncaught、EADDRINUSE 和 Provider timeout 记录，再决定是否需要增加有界 graceful shutdown 或修正启动器/开发 watcher 行为。

