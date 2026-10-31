# Agent 轨迹误报“全书预处理仍在运行”分析

> 范围说明（2026-10-31）：本文只分析 Context Graph 旧 run 的事件终态收尾、轨迹活跃任务清理和状态视图一致性；它不是文学翻译 readiness 规则。文学翻译是否可以开始，统一遵循 [ADR-0005](docs/adr/0005-literary-preprocessing-before-translation.md)。本文列出的僵尸 run / 轨迹收敛建议仍是独立的可观测性问题，不因 ADR-0005 的翻译门禁而自动视为已修复。

> 本轮仅做分析，未修改任何代码。扩展代码位于仓库外（`/Users/saga/code-repos/fanyi-extension`），服务端代码位于 `local-agent-service/`。

## 结论

Agent 轨迹里的“当前正在执行全书预处理 Agent · 正在分析人物、实体与规范译名 · run-id 621e724b…”是**从持久化事件流反推**出来的，不是读取 `context_graph_runs` 的真实状态：

- run `621e724b-2e31-4925-9b0e-01f7a8378dd0` 曾执行到 `phase = model-analysis`，写入了一条 `context-graph.phase` 事件；
- 进程在模型调用期间被中断/重启，`recoverInterruptedRuns()` 只把 `context_graph_runs.status` 改成 `failed`，**没有为这个 run 补写 `context-graph.failed` 终态事件**；
- 轨迹的活跃任务只会被**同一 runId** 的 `context-graph.completed` / `context-graph.failed` 清除，因此该任务永久停留在“运行中”；
- 预处理面板查的是“当前来源版本最新一条 run”，此时最新的是后来成功完成的 `196204f6…`，于是显示“已完成”；
- 当前没有实际分析在跑，所以终端也不会再出现任何 `[agent …] 全书预处理` 日志。

一句话：**陈旧 run 的 phase 事件没有终态事件收尾，而两个 UI 视图用了不同的数据源和选择口径。**

## 现象

| 视图 | 显示 | 实际数据源 |
|---|---|---|
| Agent 轨迹 | 正在执行全书预处理 Agent（run-id 621e724b） | `project_events` 事件流 + 前端状态机 |
| 预处理面板 | 已完成（run-id 196204f6） | `context_graph_runs` 当前 revision 最新一行 |
| 终端 | 只有 HTTP / session save，无任何预处理行 | 只有真正执行并 `appendEvent` 时才会打日志 |

关键点：面板的“已完成”和轨迹的“运行中”**并不矛盾于同一份数据**，它们看的是两个不同 run。

## 数据流对比

| 维度 | Agent 轨迹 | 预处理面板 |
|---|---|---|
| 数据源 | `GET /events` 返回的 `project_events` | `GET /context-graph/status` 返回的 `context_graph_runs` |
| 选择口径 | 事件窗口内**所有 run**，不区分来源版本 | `WHERE source_revision_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1` |
| 终态判定 | 只认 `context-graph.completed` / `context-graph.failed` 事件 | 认 `status` 字段（`queued/running/completed/failed/…`） |
| 陈旧数据处理 | 无 TTL、无服务端校验 | 仅当存在 `context-graph.completed` 事件时做一次补偿 |

代码位置：

- 轨迹活跃任务推导：`fanyi-extension/src/entrypoints/document/documentAgentTrajectory.ts:373-403`
  - `379-384`：遇到 `context-graph.phase` 就 `tasks.set(runId + ':context-graph', ...)`；
  - `382-384`：只有 `context-graph.completed` / `context-graph.failed` 才 `tasks.delete(...)`；
  - `403`：没有任何过期/心跳/权威状态校验。
- 轨迹标题：`documentAgentTrajectory.ts:126` 与 `381-382`，`phase === 'model-analysis'` 时正是“正在分析人物、实体与规范译名”。
- 事件轮询：`fanyi-extension/src/entrypoints/document/useAgentTrajectory.ts:63-100`，只读取已持久化事件，不启动/取消 run。
- 状态查询：`local-agent-service/src/documents/contextGraph.ts:1164-1166`（最新一条 run）。
- 分析启动：`local-agent-service/src/documents/contextGraph.ts:1104-1140`。
- 重启恢复：`local-agent-service/src/documents/projectStore.ts:579-606`。

## 根因

### 根因 1（直接原因）：轨迹只看事件，phase 事件没有终态收尾

`computeAgentTrajectoryActiveTasks` 是纯前端状态机：

```ts
if (type === 'context-graph.phase') {
  tasks.set(runId + ':context-graph', { ... });
} else if (type === 'context-graph.completed' || type === 'context-graph.failed') {
  tasks.delete(runId + ':context-graph');
}
```

只要事件窗口里存在 `621e724b` 的 `context-graph.phase`，且不存在**同 runId** 的终态事件，任务就永远显示为运行中。轨迹没有读取 `context_graph_runs.status`，也没有“该 run 已失败/已被新 run 取代”的兜底。

### 根因 2（关键）：重启恢复只改表，不写终态事件、不打日志

`recoverInterruptedRuns()` 对每个项目执行：

```sql
UPDATE context_graph_runs
SET status = 'failed', phase = 'failed',
    error = '服务重启后分析中断；请重新运行 context-analyze',
    finished_at = ?
WHERE status IN ('running','queued')
```

但它**不向 `project_events` 追加 `context-graph.failed`**，也不打印每个 run 的恢复日志（`projectStore.ts:596-599`）。

而 `startContextGraphAnalysis` 的 `.catch(...)`（`contextGraph.ts:1125-1138`）确实会补 `context-graph.failed` 事件——**但进程被 SIGINT/SIGTERM/崩溃/重启时，这个 Promise 的 catch 根本不会执行**。于是出现“表里已 failed、事件里永远 running”的分裂状态。

同一函数对 `translation_runs` 也是只改表（`projectStore.ts:588-590`），只是翻译轨迹的终态依赖 `run.finished` / `run.failed`，同样存在“重启后事件不收尾”的风险。

### 根因 3：两个视图的 run 选择口径不一致

- 轨迹：事件窗口内所有 run 的并集；
- 面板：当前 `source_revision_id` 下按 `started_at DESC` 的**最新一条** run。

因此只要旧 run 留有未收尾的 phase 事件，而新 run 已经完成，就会出现“轨迹还在跑旧的、面板显示新的已完成”。状态接口也不会因为旧 run 仍为 active 而报警：它只看最新一行。

### 根因 4（潜在）：force 重分析无法自愈同一 revision 的陈旧 active run

`startContextGraphAnalysis` 在插入新 run 前检查：

```sql
SELECT run_id FROM context_graph_runs
WHERE source_revision_id = ? AND status IN ('queued','running')
ORDER BY started_at DESC LIMIT 1
```

命中就直接返回 `{ accepted: true, alreadyRunning: true, runId: existing.run_id }`（`contextGraph.ts:1112-1115`）。扩展的“取消运行并重新分析全书”只绕过客户端 guard（`useContextGraph.ts:246-249`），服务端仍会返回这个陈旧 run，**不会重新执行**。如果陈旧行恰好属于当前 revision，用户点击重分析也不会有任何效果。

### 根因 5：终端为什么一条预处理日志都没有

`appendEvent` 的顺序是“先打日志、再落库”（`projectStore.ts:1280-1289`），`logWorkflowEvent` 对 `context-graph.phase/scan.completed/completed/failed` 都有明确文案（`projectStore.ts:353-397`）。所以：

- 当前会话没有任何预处理 run 在执行 → 没有任何 `appendEvent`；
- 重启恢复走的是纯 SQL，不经过 `appendEvent` → 恢复动作本身静默；
- 工作流内的模型调用日志被 `isWorkflowManaged(sessionScope)` 主动抑制（`agents/runner.ts:10,35-63`），所以即使重新分析，模型层也不会出现 `[model]` 行；
- 结论：终端“干净”恰好证明**没有活跃分析在跑**，与轨迹的“运行中”相反。

## 最可能的完整时间线

1. 用户启动全书预处理，得到 run `621e724b`；
2. 分析完成确定性扫描，进入 `model-analysis`，写入 `context-graph.phase`（这正是轨迹标题的来源）；
3. 模型调用期间服务被重启/中断，Promise 未走到 `catch`；
4. 服务启动时 `recoverInterruptedRuns()` 把 `621e724b` 改成 `failed`，但未写终态事件；
5. 用户重新分析，产生并完成了 `196204f6`；
6. `/context-graph/status` 取最新 run → 显示 `196204f6` 已完成；
7. 轨迹仍然看到 `621e724b` 的 phase 事件且没有终态事件 → 永久“运行中”。

## 排查 SQL

项目数据默认位于 `~/.vocal-saga-local-agent/documents/<projectId>/project.sqlite`（`projectStore.ts:421-447`）。本次项目 ID 为 `4fa564de-b0ec-485d-88dc-562ad1bf66d3`。

```sql
-- 1. 看所有预处理 run 的真实状态
SELECT run_id, source_revision_id, status, phase, started_at, finished_at, error
FROM context_graph_runs
ORDER BY started_at DESC, rowid DESC;

-- 2. 看某个 run 的事件收尾情况（重点：有没有 completed/failed）
SELECT event_id, run_id, event_type, created_at
FROM project_events
WHERE run_id = '621e724b-2e31-4925-9b0e-01f7a8378dd0'
ORDER BY event_id;

-- 3. 找“有 phase、无终态”的孤儿 run
SELECT r.run_id, r.status, r.phase, r.started_at, r.finished_at
FROM context_graph_runs r
WHERE EXISTS (
  SELECT 1 FROM project_events e
  WHERE e.run_id = r.run_id AND e.event_type = 'context-graph.phase'
)
AND NOT EXISTS (
  SELECT 1 FROM project_events e
  WHERE e.run_id = r.run_id
    AND e.event_type IN ('context-graph.completed','context-graph.failed')
);

-- 4. 确认当前 revision 与最新 run
SELECT value FROM project_meta WHERE key = 'current_source_revision_id';
```

判断标准：

- 若 `context_graph_runs` 中 `621e724b` 已是 `failed`，但第 2 条查不到 `context-graph.failed` → 根因 2 成立；
- 若 `621e724b` 的 `source_revision_id` 与当前 revision 不同 → 根因 3（跨版本残留事件）成立；
- 若两者相同且 `621e724b` 仍是 `queued/running` → 根因 4 也会同时成立（重分析无效）。

## 修复建议（按优先级）

### P0：让恢复动作闭合事件

- `recoverInterruptedRuns()` 在把 `context_graph_runs` 标记为 `failed` 的**同一事务/同一批处理**中，为每个受影响的 run 追加 `context-graph.failed` 事件（原因写明“服务重启导致中断”），并打一条可检索日志。
- 对 `translation_runs` 同样补 `run.finished`（`status: failed`）或 `run.failed` 事件，避免同类问题出现在翻译轨迹。
- 原则：**任何把 run 从 `queued/running` 改成终态的操作，都必须同时写终态事件**；不能只改表。

### P0：状态接口不要掩盖活跃 run

- `/context-graph/status` 在选择“最新 run”之外，额外检查当前 revision 是否存在 `queued/running` 的其它 run；若存在，应返回冲突/活跃信息，而不是静默返回最新 completed。
- 或者改为返回 `runs` 列表 + `active` 标记，由 UI 显式呈现。

### P1：请求时兜底回收僵尸 run

- `startContextGraphAnalysis` 在执行 `existing` 检查时，若命中的 run 不在 `activeAnalyses`（进程内）且 `started_at` 超过阈值（例如 30 分钟）或长时间无新事件/心跳，则先将其收敛为 `failed` 并补终态事件，再允许新 run。
- 这能让“force 重分析”真正生效，而不是返回陈旧的 `alreadyRunning`。

### P1：轨迹增加权威校验/过期策略

- 服务端提供“当前活跃 run/活跃 Agent”视图，轨迹以它为准，而不是纯事件状态机；
- 或在扩展侧对 `context-graph.phase` 任务加 TTL / 心跳判断：超过阈值没有新事件就视为“状态未知”，不显示为运行中；
- 至少应把事件按 `current_source_revision_id` 或“当前项目 run 集合”过滤，避免旧版本 run 的 phase 事件污染轨迹。

### P2：事件窗口完整性与可观测性

- 扩展首次加载取的是**最早** 5000 条事件（`useAgentTrajectory.ts:73-82` 从 `after=0` 正向翻页），项目事件超过 5000 条后，最新终态事件可能被截断；建议改用 `latest=true` 或保留最后 N 条。
- 为预处理阶段增加心跳事件（或 `updated_at`），让“长时间无事件”成为可判定的陈旧信号。
- 恢复流程补充结构化日志（projectId、runId、旧状态、新状态），便于以后从终端直接定位。

## 测试建议

1. **恢复闭环**：模拟 `context_graph_runs` 存在 `running` 行后调用 `recoverInterruptedRuns()`，断言表变 `failed` **且** 新增了同 runId 的 `context-graph.failed` 事件。
2. **轨迹清理**：给定 `phase` + `failed` 事件序列，断言 `computeAgentTrajectoryActiveTasks` 不返回该任务。
3. **状态口径**：同一 revision 同时存在“旧 running + 新 completed”时，断言 status 不静默只返回 completed。
4. **force 自愈**：陈旧 `running` 行 + `activeAnalyses` 为空时，断言 `startContextGraphAnalysis` 会收敛旧 run 并创建新 run。
5. **端到端**：在 `model-analysis` 阶段杀掉进程并重启，确认轨迹不再显示“运行中”。

## 影响

- 用户会误以为预处理仍在进行，从而等待、取消或反复重试；
- 若陈旧行属于当前 revision，“取消运行并重新分析全书”可能完全无效（无新 run、无日志），进一步加剧困惑；
- 该问题不影响已完成 run 的图谱数据本身，但会破坏“状态可信”的产品承诺，也违反 `local-agent-service/AGENTS.md` 中“状态转换必须持久化、可观察、可恢复”的要求。

## 附：与本次日志统一改动无关

上一轮把 local-agent-service 的日志统一为 `[scope HH:MM:SS]` 只是格式调整；`appendEvent` 的“先打日志再落库”顺序未变，`context-graph.*` 的日志分支也仍然存在。终端没有预处理日志的原因是**当前确实没有 run 在执行**，不是日志被吞掉。
