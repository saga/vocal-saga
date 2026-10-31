# Local Agent Service API 接口审查与整改计划

- 状态：Plan（仅审查与规划，尚未修改 API 实现）
- 日期：2026-10-20
- 范围：`local-agent-service` HTTP API，以及 `fanyi-extension` 对这些 API 的实际消费
- 主要入口：
  - `local-agent-service/src/server.ts`
  - `local-agent-service/src/routes.ts`
  - `local-agent-service/src/documents/projectRoutes.ts`
  - `local-agent-service/src/middleware.ts`
  - `local-agent-service/src/documents/projectStore.ts`
  - `local-agent-service/src/documents/translationAgent.ts`
  - `local-agent-service/src/documents/contextGraph.ts`
  - `local-agent-service/src/documents/qualityAudit.ts`
  - `fanyi-extension/src/entrypoints/document/documentWorkspaceClient.ts`

## 1. 目标与审查原则

这次不是先重构路由，而是建立可靠的 API 清单和证据，再按风险分批修复以下三类问题：

1. **应该成为接口但目前没有明确接口**：内部已有稳定业务能力，调用方却需要重复拼装、直接访问旧路径，或只能通过宽泛响应字段间接获取。
2. **已定义但可能没有调用方**：路由存在，但在扩展、服务内部客户端、CLI、测试与文档中找不到有效消费者。先验证后再决定保留、弃用或删除，不根据一次搜索直接删除。
3. **接口定义不完整或不一致**：请求/响应结构、参数范围、错误语义、鉴权、版本兼容、幂等性、分页、并发、状态机或文档不够明确。

原则：服务端是项目状态、来源版本、Run 生命周期、文学记忆和审计结果的权威来源；扩展只消费 API，不复制业务规则。优先修复正确性、安全性与数据一致性，不为了 REST 风格而做无收益的重命名或大规模重构。

## 2. 当前 API 结构

HTTP 入口在 `server.ts` 中统一完成 loopback 绑定、Host/Origin 检查、JSON body 解析和请求日志，再调用 `routes.ts` 的 `handleRequest`。通用端点由 `routes.ts` 直接分支处理；长文档项目端点委托给 `documents/projectRoutes.ts`。后者再调用 ProjectStore、TranslationAgent、ContextGraph 和 QualityAudit。

当前路由主要分为：

- 基础与配置：`GET /health`、`GET /api/settings/diagnostics`、`GET /v1/models`、`GET /api/codebuddy/models`、`GET /api/config/task-prompts`。
- 请求历史与缓存：`GET/DELETE /api/history`、`POST /api/cache/translation/{get,set,delete}`、`DELETE /api/cache/translation`。
- 兼容阅读会话：`POST /api/documents/session/{summary,get,save}`、`DELETE /api/documents/session/:sessionId`。
- 旧式批次规划：`POST /api/documents/batches`。
- 单次模型任务：`POST /v1/chat/completions`、`POST /api/translate/document/literary/{analyze,review}`。
- 项目式文档 API：`/api/documents/projects` 下的项目创建/解析/归档、原文导入与版本、片段分页、人工编辑、Prompt、LiteraryMemory、Context Graph、Runs、事件、TranslationBrief、质量审计与评估。

当前已有 `docs/LOCAL_AGENT_EXTENSION_QUALITY_CONTRACT.md`，但其重点是质量审计、Run 状态和返工契约，并非全量 API 规范。当前 API 路由主要依赖手写条件分支；没有发现覆盖全部端点的统一 OpenAPI/机器可读契约。此项需要通过后续代码与测试确认，而不是假设所有端点都存在同等程度的问题。

## 3. 初步发现与待验证项

以下是代码审查发现的候选问题，不将“搜索不到调用”直接等同于“确定无人使用”。

### P0 / P1：先保证安全与数据正确性

1. **请求/响应 Schema 分散，参数验证不一致。** 不同路由使用手写 `typeof` 检查、默认值或直接把对象交给 Store；缺少统一的请求 DTO、响应契约和字段范围验证。重点检查 projectId、runId、segmentId、分页参数、Run 创建范围、Prompt/Memory 对象及质量审计参数。
2. **错误响应形状不统一。** 有些端点返回 `{ error: string }`，有些返回 `{ error: { message, type } }`；body-parser 错误、项目路由错误和未捕获异常也由不同位置处理。客户端容易出现无法稳定提取错误信息、状态码语义不一致的问题。
3. **分页参数校验不完整。** segments、runs、events、history 等端点有分页参数，但需要核实负数、非数字、超大值、溢出与默认值是否一致，以及响应是否准确返回实际使用的 limit/offset/cursor。
4. **长任务 API 的状态/幂等契约需要统一检查。** Context Graph 分析、Run 创建/恢复/取消/采纳、质量审计/返工均涉及异步操作。需明确何时返回 202、重复提交如何处理、终态操作如何响应、并发命令如何冲突，以及客户端通过哪个持久化状态轮询。
5. **二进制文件导入与路径解析需做安全回归。** 已有 body 上限、Content-Type、文件名头和 URL decode 处理；仍需系统测试错误编码、重复导入、来源更新、归档项目、超限请求以及不同 Content-Type 的错误语义，避免计划性整改破坏现有安全边界。

### P1 / P2：契约完整性与维护成本

6. **路由注册与 API 文档没有统一来源。** `routes.ts` 中的 `supported` 集合只涵盖少量模型端点；项目路由另由 `projectRoutes.ts` 分发。需建立可测试的路由目录，避免“路由实现、文档、客户端路径、测试清单”逐渐漂移。
7. **HTTP 方法不受支持时的响应语义不明确。** 未匹配的路径和路径存在但方法不匹配的请求，可能统一返回 404。应评估是否为已知资源返回 405/Allow，并保证不会泄露项目是否存在等不必要信息。
8. **响应 DTO 可能暴露持久化内部结构。** 需逐项审查直接返回 Store 对象、数据库行或宽泛 `any` 的端点；区分公开 DTO 与 SQLite 内部字段，尤其是项目、Run、事件、Prompt、Memory、历史记录与审计报告。
9. **缓存接口需要边界定义。** `ttlMs` 当前以数值存在时直接传入缓存写入逻辑；需检查负数、零、极大值、非整数和过期行为。缓存 get/set/delete 的返回值与“未命中/无效输入/持久化失败”应有明确契约。
10. **鉴权策略需要按接口分类记录。** 当前 `/api/*` 与 `/v1/*` 先执行 authorize，loopback 请求默认不要求 token，非 loopback 依赖 token；Origin/Host 检查在更早的 middleware 执行。需要把该安全模型、CORS、OPTIONS、错误响应和可暴露配置写入 API 文档及测试，避免调用方误以为所有请求均需 token。
11. **类型安全不足。** 路由层有多个 `any`、动态 JSON 和隐式默认值。优先为高风险命令定义 DTO 与运行时校验，不要求一次性消灭所有 `any`。

### P2：确认是否应保留的端点

12. **`POST /api/documents/batches` 是疑似遗留端点。** 在当前扩展源码的快速搜索中未找到调用；它与项目式 Runs/服务端批次执行的职责可能重叠。下一步需全仓库搜索、检查历史兼容需求和测试，再决定保留为明确的兼容接口、标记弃用或删除。
13. **旧式 `/api/documents/session/*` 需要区分仍在使用的轻量恢复状态与旧全量快照。** 当前扩展仍调用 `session/get`、`session/save`；不能整体删除。需进一步确认 `summary`、`DELETE /session/:id` 是否仍被调用，并核对保存 payload 是否遵守“只保存轻量阅读检查点、不复制项目权威数据”的约束。
14. **缓存清理与单键删除端点需要核实调用方。** 已发现扩展调用 translation cache get；应继续确认 set、单键 delete、全量 delete 是否分别有消费者，不能只因它们是 CRUD 对称接口就认定无用。
15. **`GET /api/settings/diagnostics`、`GET /api/codebuddy/models`、`GET /api/config/task-prompts`、`GET /api/history` 等工具型端点需要逐项记录消费者。** 有些可能只用于设置页/诊断，也可能是人工调试接口；无调用方不一定意味着应删除，需决定是否正式支持、仅限诊断或迁移到 CLI。

## 3.1 API 资产矩阵

第一轮静态清单已单独维护在根目录 [`LOCAL_AGENT_API_MATRIX.md`](./LOCAL_AGENT_API_MATRIX.md)。它记录当前已识别的 method/path、用途、调用方证据、初步风险和待确认事项。该矩阵尚不是最终 API 契约，也不把“未确认调用”直接判定为死接口；整改时应先补齐精确消费者与请求/响应结构。

## 4. 执行计划

### Phase 0：建立完整 API 资产清单（只读）

- [ ] 枚举 `routes.ts`、`projectRoutes.ts` 和中间件的全部 method/path 分支。
- [ ] 为每个端点记录请求 DTO、响应 DTO、状态码、错误、鉴权、持久化副作用、长任务语义。
- [ ] 在 `fanyi-extension`、`vocal-saga`、测试、文档和脚本中搜索所有调用点。
- [ ] 标注每个端点为：已确认使用、仅测试/诊断使用、兼容保留、疑似未使用、实现缺失/文档缺失。
- [ ] 检查前后端路径、字段名和状态语义是否一致，特别是项目/Run/事件/审计 API。
- [ ] 输出可追溯的端点矩阵，作为后续整改的验收基线。

### Phase 1：补齐契约与高风险验证

- [ ] 定义统一 API 错误结构和错误码约定；兼容现有调用方后再逐步统一响应。
- [ ] 为写操作建立运行时请求 Schema，明确必填字段、枚举、长度、数组上限、数字范围和未知字段策略。
- [ ] 统一分页参数的解析、夹取/拒绝策略和响应元数据。
- [ ] 明确异步端点的 200/201/202/204/400/401/404/409/413/415/422/500 语义；只在实际需要时使用相应状态码。
- [ ] 为 Run 创建、取消、恢复、采纳、Context Graph 分析、质量审计/返工增加重复提交、并发与终态操作测试。
- [ ] 验证错误路径不泄露 Token、绝对路径、原文内容、数据库内部细节或敏感 Prompt。

### Phase 2：API 目录与文档成为可验证契约

- [ ] 新增全量 API 参考文档（建议放在 `docs/LOCAL_AGENT_SERVICE_API.md`），覆盖通用接口和完整项目路由。
- [ ] 评估采用 OpenAPI 3.1 作为机器可读契约；如果当前栈不希望引入依赖，可先维护类型化 route manifest，并从测试验证其完整性。
- [ ] 为每个端点定义稳定 DTO；避免直接把数据库行或内部 Store 对象当成公开响应。
- [ ] 建立自动化一致性检查：实现路由必须在清单/文档中登记；清单中的路由必须有实现或明确标注兼容/弃用。
- [ ] 在 `local-agent-service/README.md` 与跨仓库质量契约中链接 API 文档，并说明 loopback、Token、Origin/Host 和 body 限制。

### Phase 3：清理疑似未使用与重叠端点

- [ ] 对 `POST /api/documents/batches`、旧 session 端点和 cache delete 端点完成全仓库引用确认。
- [ ] 对确认无消费者的端点，优先增加弃用标记和日志/文档，再在有明确版本策略后删除；不直接删除可能影响旧版扩展的端点。
- [ ] 如果存在职责重复的端点，先选定权威路径，再迁移客户端与测试，避免同时维护两套批次/Run 状态逻辑。
- [ ] 删除前检查外部脚本、CLI、历史版本扩展和人工运维流程。

### Phase 4：测试与交付

- [ ] 单元测试：Schema、参数边界、错误转换、分页、DTO 映射。
- [ ] HTTP 集成测试：所有登记路由均覆盖成功路径、未授权/错误输入、资源不存在与错误方法。
- [ ] 契约测试：扩展实际请求字段与服务端响应 DTO 对齐；未知可选字段不导致崩溃。
- [ ] 安全回归：Origin/Host、Token、JSON body 上限、原始文件大小上限、路径编码和项目归档边界。
- [ ] 生命周期回归：创建 Run、轮询状态/事件、暂停/取消/恢复、采纳、来源版本变化与服务重启恢复。
- [ ] 执行 `npm run typecheck`、相关 API 测试及完整 `npm test`；报告真实结果，不把静态审查当成测试通过。
- [ ] 更新本计划的完成状态，并把仍保留的兼容端点、弃用时间和未解决问题列入结论。

## 5. 优先级与范围控制

| 优先级 | 范围 | 交付 |
|---|---|---|
| P0 | 安全边界、写操作参数验证、项目/Run 状态正确性 | 不允许非法输入破坏数据或绕过状态机 |
| P1 | 错误语义、分页、响应 DTO、API 契约目录 | 客户端可以稳定处理所有常见结果 |
| P1 | 异步命令幂等性与并发语义 | 重复请求不会产生难以恢复的重复工作 |
| P2 | 疑似未使用端点与重叠职责 | 有证据的保留/弃用/删除决策 |
| P2 | OpenAPI/类型化 route manifest 与文档生成 | 降低跨仓库接口漂移 |

## 6. 明确不做

- 不在未确认调用关系前删除接口。
- 不一次性改写整个 HTTP 服务或引入大型框架。
- 不把所有 404 机械改成 405；需结合资源存在性与信息泄露风险评估。
- 不改变当前服务端作为项目数据权威来源的架构，不在扩展端复制 Run、Context Graph 或质量审计状态机。
- 不在未完成测试前宣称 API 已完整、无死接口或全部符合规范。

## 7. 完成定义

满足以下条件才算完成 API 整改：

1. 全部 method/path 有唯一登记项，并有调用方/兼容策略与测试状态。
2. 每个公开端点有明确请求/响应 DTO、成功状态码、错误语义和鉴权说明。
3. 高风险写操作有运行时校验，分页与 body/file size 上限一致且可测试。
4. 长任务的状态机、重复提交和并发操作语义有测试覆盖。
5. 疑似未使用接口均有基于仓库引用与兼容需求的明确结论。
6. 服务端、扩展、文档和测试中的契约一致；类型检查与相关测试结果已记录。
