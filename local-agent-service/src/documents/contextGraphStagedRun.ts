/**
 * B 方案：按波次执行分阶段工作流。
 *
 * 命中检查点的阶段直接恢复（把检查点原样写进本 Run），同波次阶段并发执行且互不依赖；
 * 任一阶段失败即整体失败，已落库的检查点留给下次恢复。阶段之间只通过 aggregate 传递结果。
 */

import { type DatabaseSync } from 'node:sqlite';
import { ANALYSIS_TIMEOUT_MS } from '../config.ts';
import { type parseAgentModel } from '../json.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { runAgentStructured } from '../agents/runner.ts';
import { formatTurnUsageLog } from '../agents/usage.ts';
import { logInfo } from '../log.ts';
import {
  DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
  ANALYSIS_SCHEMA,
  type Segment,
} from './contextGraphSchema.ts';
import {
  getMeta,
  patchRunProgress,
  persistWorkflowStageCheckpoint,
  readRunProgress,
  safeText,
  saveMeta,
  workflowCheckpointKey,
  workflowSessionKey,
  type ContextGraphRunProgress,
} from './contextGraphStore.ts';
import {
  buildContextGraphWorkflowPrompt,
  buildContextGraphWorkflowSchema,
  CONTEXT_GRAPH_STAGE_SESSION_PARENT,
  CONTEXT_GRAPH_STAGE_WAVES,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphWorkflowStageId,
} from './contextGraphWorkflow.ts';
import { getDocumentProjectStore } from './projectStore.ts';

/** 分阶段工作流的一个阶段：id、展示名、phase 字段名与必需的结构化字段。 */
type WorkflowStage = { id: ContextGraphWorkflowStageId; label: string; phase: string; fields: readonly string[] };

/**
 * 波次执行期间的状态。每波内的阶段共享同一份 aggregate 与会话槽位，
 * 且 style 阶段会更新 run 级 session，因此统一挂在可变容器里传递。
 */
type StagedWorkflowState = {
  store: ReturnType<typeof getDocumentProjectStore>;
  db: DatabaseSync;
  revisionId: string;
  projectId: string;
  runId: string;
  prompt: string;
  agent: ReturnType<typeof parseAgentModel>;
  taskProfile: ReturnType<typeof getCodeBuddyTaskProfile>;
  sampleIds: Set<string>;
  samples: Segment[];
  stageTimeoutMs: number;
  stageSessionIds: Map<ContextGraphWorkflowStageId, string>;
  completedBefore: Set<string>;
  checkpointSourceRunId: string;
  aggregate: Record<string, any>;
  /** style 阶段沿用 run 级 session key，恢复时一并回传调用方。 */
  workflowSessionId: string;
};

/**
 * B 方案：按波次执行分阶段工作流。命中检查点的阶段直接恢复，同波次阶段并发执行，
 * 任一阶段失败即整体失败，已落库的检查点留给下次恢复。
 */
export async function runStagedWorkflow(input: {
  store: ReturnType<typeof getDocumentProjectStore>;
  db: DatabaseSync;
  revisionId: string;
  projectId: string;
  runId: string;
  prompt: string;
  initialProgress: ContextGraphRunProgress;
  agent: ReturnType<typeof parseAgentModel>;
  taskProfile: ReturnType<typeof getCodeBuddyTaskProfile>;
  sampleIds: Set<string>;
  samples: Segment[];
  modelAnalysisStartedAt: number;
  workflowSessionId: string;
}): Promise<{ data: Record<string, any>; workflowSessionId: string }> {
  const { db, runId, initialProgress, modelAnalysisStartedAt } = input;
  const stageTimeoutConfigured = Number(process.env.LOCAL_AGENT_CONTEXT_GRAPH_STAGE_TIMEOUT_MS);
  const state: StagedWorkflowState = {
    store: input.store, db, revisionId: input.revisionId, projectId: input.projectId, runId,
    prompt: input.prompt, agent: input.agent, taskProfile: input.taskProfile,
    sampleIds: input.sampleIds, samples: input.samples,
    stageTimeoutMs: Number.isFinite(stageTimeoutConfigured) && stageTimeoutConfigured > 0
      ? Math.min(ANALYSIS_TIMEOUT_MS, stageTimeoutConfigured)
      : Math.min(ANALYSIS_TIMEOUT_MS, 5 * 60 * 1000),
    stageSessionIds: new Map(),
    completedBefore: new Set<string>(Array.isArray(initialProgress.completedStages) ? initialProgress.completedStages : []),
    checkpointSourceRunId: (typeof initialProgress.resumedFromRunId === 'string' ? initialProgress.resumedFromRunId : '') || runId,
    aggregate: {},
    workflowSessionId: input.workflowSessionId,
  };
  if (state.workflowSessionId) state.stageSessionIds.set('style', state.workflowSessionId);

  for (let waveIndex = 0; waveIndex < CONTEXT_GRAPH_STAGE_WAVES.length; waveIndex++) {
    const stages = resolveWaveStages(waveIndex);
    if (!stages.length) continue;
    // 同波次只写一次 phase：并发阶段各自写会让 UI 的阶段读数来回跳动。
    db.prepare('UPDATE context_graph_runs SET phase = ? WHERE run_id = ?').run(stages[0]!.phase, runId);
    if (stages.length > 1) {
      logInfo('context-graph', '并行波次 ' + (waveIndex + 1) + '/' + CONTEXT_GRAPH_STAGE_WAVES.length +
        ' · ' + stages.map((stage) => stage.id).join('+'));
    }
    // 同波次阶段互不依赖；任一失败即整体失败，已落库的检查点留给下次恢复。
    await Promise.all(stages.map((stage) => runWorkflowStage(stage, waveIndex, state)));
  }

  patchRunProgress(db, runId, {
    strategy: 'B', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    currentStage: null, workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
    completedStages: CONTEXT_GRAPH_WORKFLOW_STAGES.map((stage) => stage.id),
  });
  return { data: state.aggregate, workflowSessionId: state.workflowSessionId };
}

/** 波次里登记的阶段 id 解析成阶段定义；未知 id 直接跳过。 */
function resolveWaveStages(waveIndex: number): WorkflowStage[] {
  const wave = CONTEXT_GRAPH_STAGE_WAVES[waveIndex]!;
  return wave
    .map((stageId) => CONTEXT_GRAPH_WORKFLOW_STAGES.find((item) => item.id === stageId) as WorkflowStage | undefined)
    .filter((stage): stage is WorkflowStage => !!stage);
}

/** 阶段 Session key：style 沿用 run 级 key，其余阶段按阶段隔离，避免并行分支互相覆盖。 */
function stageSessionKey(stageId: ContextGraphWorkflowStageId, forRunId: string): string {
  return stageId === 'style' ? workflowSessionKey(forRunId) : workflowSessionKey(forRunId, stageId);
}

/**
 * 执行单个阶段：命中检查点直接恢复，否则发起一次结构化调用并落库。
 * 同波次内多个阶段会并发调用本函数，因此每次读写 progress_json 之间不能插入 await。
 */
async function runWorkflowStage(
  stage: WorkflowStage,
  waveIndex: number,
  state: StagedWorkflowState,
): Promise<void> {
  if (restoreStageCheckpoint(stage, state)) return;
  const { store, db, projectId, runId } = state;

  const prior = readRunProgress(db, runId);
  const completedStages = Array.isArray(prior.completedStages) ? prior.completedStages : [];
  patchRunProgress(db, runId, {
    strategy: 'B', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    currentStage: stage.id, completedStages,
  });
  store.appendEvent(projectId, runId, 'context-graph.phase', {
    phase: stage.phase, strategy: 'B', stage: stage.id, stageLabel: stage.label,
    stageIndex: CONTEXT_GRAPH_WORKFLOW_STAGES.findIndex((item) => item.id === stage.id) + 1,
    stageCount: CONTEXT_GRAPH_WORKFLOW_STAGES.length, completedStageCount: completedStages.length,
    waveIndex: waveIndex + 1, waveSize: (CONTEXT_GRAPH_STAGE_WAVES[waveIndex] || []).length,
  });

  const { stageOutput, elapsedMs } = await executeStageCall(stage, state);
  persistWorkflowStageCheckpoint(
    db, state.revisionId, runId, stage.id, stageOutput, elapsedMs,
    state.sampleIds, state.samples,
  );
  recordStageCompletion(stage, waveIndex, state, elapsedMs);
  Object.assign(state.aggregate, stageOutput);
}

/**
 * 检查点恢复：只有「本次恢复来源 Run 已完成该阶段」且字段齐全时才复用，
 * 复用时把检查点原样写入本 Run，后续阶段仍能读到同一份数据。
 */
function restoreStageCheckpoint(stage: WorkflowStage, state: StagedWorkflowState): boolean {
  const { store, db, revisionId, projectId, runId, checkpointSourceRunId } = state;
  const checkpoint = state.completedBefore.has(stage.id)
    ? getMeta(db, revisionId, workflowCheckpointKey(checkpointSourceRunId, stage.id))
    : null;
  const validCheckpoint = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) &&
    stage.fields.every((field) => Object.prototype.hasOwnProperty.call(checkpoint, field));
  if (!validCheckpoint) return false;
  Object.assign(state.aggregate, checkpoint);
  if (checkpointSourceRunId !== runId) saveMeta(db, revisionId, workflowCheckpointKey(runId, stage.id), checkpoint);
  const restoredProgress = readRunProgress(db, runId);
  store.appendEvent(projectId, runId, 'context-graph.stage.restored', {
    strategy: 'B', stage: stage.id, stageLabel: stage.label,
    sourceRunId: checkpointSourceRunId,
    completedStageCount: Array.isArray(restoredProgress.completedStages) ? restoredProgress.completedStages.length : 0,
    stageCount: CONTEXT_GRAPH_WORKFLOW_STAGES.length,
  });
  logInfo('context-graph', '恢复已保存阶段 · ' + stage.id + ' · run=' + runId.slice(0, 8));
  return true;
}

/**
 * 阶段 Session 的查找顺序：本 Run 已开的槽位 → 恢复来源 Run 的槽位 → 父阶段的槽位。
 * 能续聊时复用父阶段 Session，避免重发整份样本。
 */
function resolveStageSessionId(stage: WorkflowStage, state: StagedWorkflowState): string {
  const { db, revisionId, checkpointSourceRunId, stageSessionIds } = state;
  const parentStageId = CONTEXT_GRAPH_STAGE_SESSION_PARENT[stage.id];
  return stageSessionIds.get(stage.id)
    || safeText(getMeta(db, revisionId, stageSessionKey(stage.id, checkpointSourceRunId)), 500)
    || (parentStageId
      ? stageSessionIds.get(parentStageId)
        || safeText(getMeta(db, revisionId, stageSessionKey(parentStageId, checkpointSourceRunId)), 500)
      : '');
}

/** 记住一个阶段 Session：内存、meta 与 run 级返回值三处同步，缺一处下次就无法续聊。 */
function rememberStageSession(
  stageId: ContextGraphWorkflowStageId,
  sessionId: string,
  state: StagedWorkflowState,
): void {
  state.stageSessionIds.set(stageId, sessionId);
  saveMeta(state.db, state.revisionId, stageSessionKey(stageId, state.runId), sessionId);
  if (stageId === 'style') state.workflowSessionId = sessionId;
}

/** 一次阶段模型调用：装 Prompt、发请求、校验返回字段。失败一律抛出，由波次整体失败。 */
async function executeStageCall(
  stage: WorkflowStage,
  state: StagedWorkflowState,
): Promise<{ stageOutput: Record<string, any>; elapsedMs: number }> {
  const { db, revisionId, projectId, runId, prompt, agent, taskProfile, stageTimeoutMs } = state;
  const sessionId = resolveStageSessionId(stage, state);
  const stagePrompt = buildContextGraphWorkflowPrompt(
    stage.id, prompt, state.aggregate,
    agent.provider === 'workbuddy' && !!sessionId,
  );
  const stageSchema = buildContextGraphWorkflowSchema(ANALYSIS_SCHEMA, stage.id);
  const stageStartedAt = Date.now();
  const stageRun = await runAgentStructured(
    { provider: agent.provider, model: agent.model },
    stagePrompt,
    DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
    stageSchema,
    runId + ':' + stage.id,
    'context-graph:' + projectId + ':' + revisionId + ':' + runId,
    taskProfile,
    {
      timeoutMs: stageTimeoutMs,
      ...(agent.provider === 'workbuddy' ? {
        persistSession: true,
        ...(sessionId ? { sessionId } : {}),
        onSessionId: (newSessionId: string) => rememberStageSession(stage.id, newSessionId, state),
      } : {}),
    },
  );
  if (stageRun.usage) logInfo('context-graph', 'B 阶段 ' + stage.id + ' · ' + formatTurnUsageLog(stageRun.usage));
  if (!stageRun.result || Array.isArray(stageRun.result)) {
    throw new Error('Context Graph 工作流阶段 ' + stage.id + ' 返回了非对象结果。');
  }
  const stageOutput = stageRun.result as Record<string, any>;
  const missingFields = stage.fields.filter((field) => !Object.prototype.hasOwnProperty.call(stageOutput, field));
  if (missingFields.length) {
    throw new Error('Context Graph 工作流阶段 ' + stage.id + ' 缺少结构化字段：' + missingFields.join(', '));
  }
  if (stageRun.sessionId && agent.provider === 'workbuddy') {
    rememberStageSession(stage.id, stageRun.sessionId, state);
  }
  return { stageOutput, elapsedMs: Date.now() - stageStartedAt };
}

/** 阶段完成事件：带上本阶段输出计数与波次位置，便于在终端对齐 UI 的阶段读数。 */
function recordStageCompletion(
  stage: WorkflowStage,
  waveIndex: number,
  state: StagedWorkflowState,
  elapsedMs: number,
): void {
  const { store, db, projectId, runId } = state;
  const stageProgress = readRunProgress(db, runId);
  const stageSummary = Array.isArray(stageProgress.stageResults)
    ? stageProgress.stageResults.find((item: any) => item.stage === stage.id)
    : null;
  store.appendEvent(projectId, runId, 'context-graph.stage.completed', {
    strategy: 'B', stage: stage.id, stageLabel: stage.label,
    stageIndex: CONTEXT_GRAPH_WORKFLOW_STAGES.findIndex((item) => item.id === stage.id) + 1,
    stageCount: CONTEXT_GRAPH_WORKFLOW_STAGES.length,
    completedStageCount: Array.isArray(stageProgress.completedStages) ? stageProgress.completedStages.length : 0,
    elapsedMs, outputCounts: stageSummary?.outputCounts || {},
    waveIndex: waveIndex + 1,
  });
}
