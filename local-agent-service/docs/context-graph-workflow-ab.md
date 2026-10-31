# Context Graph 全书预处理：A/B 工作流

> 本文只定义 Context Graph 的 A/B 分析策略、阶段检查点和质量契约；它不单独决定何时允许翻译。文学翻译必须遵循根目录 [ADR-0005](../../docs/adr/0005-literary-preprocessing-before-translation.md)：当前 source revision 的 readiness 完整通过后才开始翻译模型调用，B 策略五个阶段均须完成。

## 背景

旧流程把文风、人物、实体、关系和章节摘要打包进一个结构化模型请求。模型只有在请求结束时才返回完整 JSON，长请求失败会丢失整批尚未提交的模型结果；此外，旧 Schema 没有将全部文风维度列为必填，因此模型可能只返回 `narrativeStyle` 和 `styleRules`，其余字段因缺失被服务端保存为空。

本实现保留原有单次模型调用为 **A 方案**，增加持久化分阶段执行的 **B 方案**。所有模型输出仍需经过本机证据校验；模型返回不等于事实被确认。

## 策略选择与 A/B 交替

默认 `LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY=ab`。为让旧版本升级后的第一次重分析直接获得阶段检查点，首次新 Run 采用 B；之后按最近一次策略交替：B、A、B、A……。策略与工作流版本写入 Run 的 `progress_json`，并追加 `context-graph.strategy.selected` 事件。完成事件记录策略、模型分析耗时、文风完整度、规则/证据计数以及每个 B 阶段的耗时和输出计数，便于比较运行耗时、阶段成功率和产出质量。

| 配置 | 行为 |
| --- | --- |
| `LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY=ab` 或未设置 | 按最近一次策略 A/B 交替 |
| `LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY=a` | 固定使用旧的单次调用 A |
| `LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY=b` | 固定使用分阶段 B |
| `LOCAL_AGENT_CONTEXT_GRAPH_STAGE_TIMEOUT_MS` | 覆盖 B 的单阶段超时；默认不超过 5 分钟，也不会超过 `LOCAL_AGENT_ANALYSIS_TIMEOUT_MS` |

如果最近一次 B 因故失败且至少有一个阶段检查点完整，下一次启动优先恢复这些检查点，避免为遵守 A/B 轮换而重复已完成工作。这类恢复 Run 仍记录为 B；这是恢复优先规则，不是重新分配的实验样本。

## B 方案阶段

```mermaid
flowchart TD
    scan[确定性扫描与抽样] --> style[1. 文风基准]
    style -->|SQLite checkpoint| characters[2. 人物与角色声音]
    characters -->|SQLite checkpoint| entities[3. 实体与规范译名]
    entities -->|SQLite checkpoint| relationships[4. 人物 / 实体关系]
    relationships -->|SQLite checkpoint| chapters[5. 章节摘要与待确认问题]
    chapters --> validate[统一证据校验与图谱落库]
    validate --> completed[完成 / 记录 A-B 结果]
    style -.失败后保留已提交阶段.-> retry[重试或恢复]
    characters -.-> retry
    entities -.-> retry
    relationships -.-> retry
    chapters -.-> retry
```

1. 文风基准：叙述声音、语域、节奏与句法、对白特征、措辞与词汇、翻译规则、避免项和风格证据。
2. 人物：别名、目标语言译名、角色身份线索、人物声音和原文证据。
3. 实体：重要地点、组织、物件、作品或术语，连同规范译名及证据。
4. 关系：在人物和实体候选基础上识别有直接文本支持的关系。
5. 章节摘要：摘要只使用相应章节的证据，并记录未解决的问题。

每一步使用只包含该阶段字段的 JSON Schema，成功后将原始结构化结果写入 `context_graph_meta` 检查点，并同步更新 Run 的 `completedStages` / `stageResults`。文风阶段还会马上更新状态 API 使用的文风投影，所以不必等人物或章节分析结束才能读取。

## CodeBuddy Session 与检查点

B 对 Workbuddy/CodeBuddy 调用设置 `persistSession: true`，捕获初始化事件的 `session_id` 并存入项目 SQLite。后续阶段用 `resume: sessionId` 恢复多轮对话，让模型保留之前的原文样本、扫描线索和已生成上下文；新会话重试可从同一 Session 继续。Stage 输出和 Session ID 都是本机服务管理的持久数据。

**Session 不是业务检查点。** 模型 Session 可能因本机服务重启或 SDK 端状态而不可用；SQLite 的阶段结果才是可恢复的权威状态。B 恢复时即使无法继续原 Session，也可从已提交阶段跳过并重新构造后续请求。新的来源版本或分析版本不会复用不匹配的失败 Run 检查点。

CodeBuddy Dynamic Workflow 文档把编排步骤、分支和中间结果从单个提示移入可追踪、可重跑的 workflow 脚本。本服务的 B 方案采用相同的编排原则，并将阶段结果额外提交进本机 SQLite；它由服务端的确定性状态机执行，而不是要求模型在单次回复中自行规划和承诺完成所有阶段。这样才能把阶段提交、原文证据验证和故障恢复置于本机事务边界内。

## 文风字段保证

A 和 B 都要求 Schema 包含五个非空维度：`narrativeStyle`、`styleRegister`、`styleRhythm`、`styleDialogue` 和 `styleDiction`；`styleRules` 至少一条。若 Provider 仍返回空字段，服务端只重新请求文风阶段进行定向补全；补全后仍为空则 Run 失败，不会显示成成功。新分析版本为 `context-graph-v7-workflow-ab-style-required`，旧版已完成状态不会被当作新版分析完成。

## 如何评估

在相近模型和相同原文版本上交替运行 A/B，观察：
- 完成率、总耗时与单阶段耗时；
- 五个文风字段的非空率和具体性；
- 有有效原文证据的人物、实体、关系数量，而非只看模型原始候选数；
- 无效证据拒绝率、章节摘要覆盖率、需要人工确认的问题；
- B 在失败/服务重启后是否复用已经保存的阶段结果。

A/B 交替是工程对照，不等同于严格随机化实验：模型版本、服务负载、SDK 会话状态和模型侧输出波动都会影响结果。质量指标应结合输出审计与人工抽样，不应只按运行耗时判定 B 更好。
