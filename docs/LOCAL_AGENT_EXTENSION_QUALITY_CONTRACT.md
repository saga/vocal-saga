# Local Agent Service ↔ fanyi-extension：文档质量审计契约

> 本文是服务端与扩展端之间的单一协作约定。修改质量审计 API、Run 状态或返工数据结构时，应先更新这里，再同步实现与测试。长文档/小说项目工作流由 **local-agent-service** 执行；扩展只负责界面、筛选、用户操作和状态展示。

## 职责边界

- **local-agent-service** 是质量规则、报告持久化、当前来源版本校验、返工范围校验和 Run 生命周期的唯一事实来源。
- **fanyi-extension** 不复制审计算法，也不直接改写已采纳译文。可返工的问题通过服务端创建新候选 Run，仍需服务端/产品既有流程明确采纳。
- 每个文档项目有自己独立的 **project.sqlite**。不能假设 **translation_runs** 带有 **project_id** 列，也不能把项目数据库描述为共享数据库。
- 云端 Worker 的片段翻译 API 不是这套长文档审计/返工 API 的替代品。

## Context Graph 与文学 Run 的准备阶段

- Context Graph 节点、关系、章节摘要和原文证据只在 local-agent-service 的项目 SQLite 中保存与检索。扩展的常规状态轮询应调用 GET /context-graph/status，不得复制完整图谱到 LiteraryMemory。
- 正常扩展路径必须先读取服务端的轻量 Context Graph readiness 投影；只有当前 source revision、分析版本、语言方向、样本、文风和必需阶段全部通过，才允许创建文学翻译 Run。状态未知或读取失败时 fail closed。
- 新项目/从未分析的当前来源版本由扩展自动触发一次预处理并轮询状态；失败、过期或语言不匹配时不无限自动重试，用户通过“人物与预处理”显式重新分析。扩展不在浏览器运行分析算法，也不复制图谱节点/证据。
- executeRun 保留服务端最终门禁。旧客户端或直接 API 调用可以先创建 queued Run；服务端自动启动/等待匹配预处理，但在 readiness 通过前不进入 running、不调用翻译模型、不写候选。服务端不可用时要明确报错；不能将远端 fallback 的结果误当成 Local Agent 项目的规范分析数据。

## API

所有路径都以 **/api/documents/projects/:projectId** 为前缀，并通过本机服务既有鉴权和 JSON body 限制。

| 请求 | 行为 | 客户端必须遵守 |
|---|---|---|
| **GET /quality-audit** | 返回最新保存报告，或按 **auditId** 查指定报告 | **404** 表示当前项目尚无报告；这不是翻译失败 |
| **POST /quality-audit** | 对当前来源版本执行审计；可传 **{ "runId": "..." }** 叠加允许状态 Run 的候选译文 | 当前报告固定 **sourceRevisionId**；报告会保存到项目数据库 |
| **POST /quality-audit/repair** | Body 为 **{ "auditId": "...", "findingIds": ["..."] }**，或显式给 **segmentIds**，创建窄范围新 Run | 响应 **202** 返回 **repair.run** 和 **started**；不得把结果视为已采纳译文 |

### 状态与错误语义

- **queued**、**running**、**paused** 是活跃/未结束状态，普通全书审计应阻止并返回冲突错误。**partial** 是终态但不完整，允许审计已采纳文本来定位尚未完成的片段。
- **completed** 与 **awaiting_acceptance** 可作为候选 Run 进行叠加审计；其他 Run 状态不应被当作已完成候选。
- 来源版本变化会使旧报告失效。即使来源版本不变，审计后的译文若被人工修改，旧报告也不能用于返工；服务端通过两个聚合 SHA-256 快照哈希拒绝过期返工，并要求重新审计。
- **canonical-name-mapping-conflict** 是不可自动返工的配置冲突。先在项目 LiteraryMemory 或人物角色/声音中人工统一已确认译名，再重新审计。
- 术语漂移、疑似英文残留、数字差异等是启发式发现，不等同于已证实的翻译错误。界面应展示证据，并允许人工筛选；不要因“报告发现问题”直接覆盖旧结果。
- 活跃 Run/过期报告通常返回 **409**；客户端应展示服务端消息、重新加载状态或重跑审计，不能自行放宽限制。

## 报告契约

报告至少包含：

- **auditId**、**projectId**、**sourceRevisionId**、**runId**、**createdAt**。
- **metrics**：覆盖率/缺译、规范名冲突、译名漂移、疑似英文残留、数字差异、重复表达等计数。新指标应在服务端生成，并由扩展以可选字段显示，以兼容旧报告。
- **findings[]**：每项使用稳定 **findingId**、**type**、**category**、**severity**、**repairable**、**segmentIds** 和可读解释/证据。列表展示可做上限和本地筛选，但不能篡改服务端 finding ID。
- **translationSnapshotHash** 与 **acceptedTranslationSnapshotHash**：固定大小哈希用于防止过期返工；不要在报告内复制整本译文或逐段保存额外哈希映射。

## 必须同步的回归检查

1. 服务端：初译/人物角色声音规范名、冲突不可自动择一、英文残留只作为审计提示、旧报告/人工修订后返工返回 **409**、活跃 Run 阻止审计而 **partial** 可审计、项目 SQLite schema 不依赖 **project_id** 列。
2. 扩展端：无报告 **404**、旧来源报告不可返工、报告筛选不改变 finding ID、只选择 **repairable === true** 项、返工后显示候选 Run 而非宣称旧译文已覆盖。
3. 实际模型效果不能由单元测试替代：针对同一来源版本复跑出现问题的章节，检查实际 TranslationBrief、初译输出、Reviewer 输入/输出及剩余未完成片段。未进行本地模型实跑时，不得宣称真实小说的每个命名/残留实例均已验证。

## 修改流程

同时改动 API 结构、Run 状态或质量 finding 时，应在同一变更中更新服务端代码、单元/API 测试、本文和扩展消费逻辑。新增指标或 finding type 应有服务端合成样例；扩展需以未知 finding type 的原始名称兜底，而不是因新类型破坏渲染。
