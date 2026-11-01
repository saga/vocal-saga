/**
 * Context Graph 分析的入口编排：排队启动、孤儿运行回收、以及在 A/B 两种策略间分派。
 *
 * 具体的输入准备、模型调用、分阶段工作流与落库分别在 contextGraphAnalysisInputs、
 * contextGraphModelRuns、contextGraphStagedRun、contextGraphPersist 里；
 * 这里只负责「先做什么后做什么」与失败处理。
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import { parseAgentModel } from '../json.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { logError } from '../log.ts';
import { getDocumentProjectStore } from './projectStore.ts';
import { prepareAnalysisInputs } from './contextGraphAnalysisInputs.ts';
import { completeStyleGuide, runSingleShotAnalysis } from './contextGraphModelRuns.ts';
import { persistAnalysisGraph } from './contextGraphPersist.ts';
import { runStagedWorkflow } from './contextGraphStagedRun.ts';
import {
  chooseContextGraphStrategy,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphAnalysisStrategy,
  type ContextGraphWorkflowStageId,
} from './contextGraphWorkflow.ts';
import {
  assertNoActiveTranslation,
  getMeta,
  graphContext,
  patchRunProgress,
  readLatestStrategy,
  safeText,
  saveMeta,
  workflowCheckpointKey,
  workflowSessionKey,
} from './contextGraphStore.ts';
import { CONTEXT_GRAPH_ANALYSIS_VERSION, ensureSchema } from './contextGraphSchema.ts';
import { graphAnalysisPrompt } from './contextGraphPrompts.ts';

// Track the exact live run; a project-level boolean cannot distinguish stale runs from another revision.
export const activeAnalyses = new Map<string, string>();

/**
 * 协调数据库中残留的陈旧预处理运行记录。
 * 当进程重启或分析异常终止时， queued/running 状态的 run 可能没有对应执行任务；
 * 此函数根据 project_events 中的终态事件将其收敛为 completed/failed，或标记为失败并追加失败事件，
 * 避免 UI 长期显示“分析中”而无法重新分析。
 */
export function reconcileOrphanedContextGraphRun(projectId: string, db: DatabaseSync, runId: string, reason: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(
      "SELECT status FROM context_graph_runs WHERE run_id = ? AND status IN ('queued','running')"
    ).get(runId) as { status?: string } | undefined;
    if (!row) {
      db.exec('COMMIT');
      return;
    }

    const terminal = db.prepare(
      "SELECT event_type, payload_json, created_at FROM project_events WHERE run_id = ? AND event_type IN ('context-graph.completed','context-graph.failed') ORDER BY event_id DESC LIMIT 1"
    ).get(runId) as { event_type: string; payload_json?: string; created_at?: string } | undefined;
    const now = new Date().toISOString();

    if (terminal?.event_type === 'context-graph.completed') {
      db.prepare(
        "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', finished_at = COALESCE(finished_at, ?), error = NULL WHERE run_id = ? AND status IN ('queued','running')"
      ).run(terminal.created_at || now, runId);
    } else if (terminal?.event_type === 'context-graph.failed') {
      let payload: Record<string, any> = {};
      try { payload = JSON.parse(terminal.payload_json || '{}'); } catch { payload = {}; }
      db.prepare(
        "UPDATE context_graph_runs SET status = 'failed', phase = 'failed', finished_at = COALESCE(finished_at, ?), error = COALESCE(error, ?) WHERE run_id = ? AND status IN ('queued','running')"
      ).run(terminal.created_at || now, String(payload.error || reason), runId);
    } else {
      const changed = db.prepare(
        "UPDATE context_graph_runs SET status = 'failed', phase = 'failed', error = ?, finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status IN ('queued','running')"
      ).run(reason, now, runId);
      if (changed.changes > 0) {
        getDocumentProjectStore().appendEvent(projectId, runId, 'context-graph.failed', {
          error: reason, recovery: 'orphan-run', reason: 'no-live-analysis-in-current-process',
        });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the reconciliation error */ }
    throw error;
  }
}

/**
 * 执行一次全书文学预分析：确定性扫描/抽样 -> 结构化模型分析 -> 逐项验证原文证据 -> 事务落库。
 * 模型只负责提出候选；只有引用指向本次样本且 quote 能在对应 source segment 中验证时，
 * 节点、关系或章节摘要才可能持久化。phase/progress 与终态事件供 UI 恢复进度和定位失败。
 */
async function runAnalysis(projectId: string, runId: string): Promise<void> {
  const store = getDocumentProjectStore();
  const prepared = await prepareAnalysisInputs(store, projectId, runId);
  const {
    db, revisionId, segments, initialProgress, strategy, sourceLang, targetLang, provider, modelName,
    scan, samples, sampleReasons, sampleIds, samplesById, chapters, scanSummary,
  } = prepared;

  const agent = parseAgentModel(modelName, provider);
  const prompt = graphAnalysisPrompt(
    store.getProject(projectId)?.title || '未命名文档',
    store.getProject(projectId)?.format || '',
    sourceLang, targetLang,
    samples, chapters, scan, sampleReasons,
  );

  patchRunProgress(db, runId, {
    sampleCount: samples.length, chapterCount: chapters.length,
    sourceLang, targetLang, provider: agent.provider, model: agent.model, scan: scanSummary,
    scanDurationMs: prepared.scanDurationMs, sampleIds: samples.map((sample) => sample.id),
  });
  db.prepare('UPDATE context_graph_runs SET phase = \'model-analysis\' WHERE run_id = ?').run(runId);
  const latestPrompt = store.listPrompts(projectId)[0];
  const taskProfile = getCodeBuddyTaskProfile({ taskProfiles: latestPrompt?.config?.taskProfiles || {} }, 'contextGraph');
  store.appendEvent(projectId, runId, 'context-graph.phase', {
    phase: 'model-analysis', sampleCount: samples.length, chapterCount: chapters.length,
    sourceLang, targetLang,
    provider: agent.provider, model: agent.model || '<runtime-default>',
    thinkingMode: taskProfile.thinkingMode,
    thinkingBudgetTokens: taskProfile.thinkingBudgetTokens,
    effort: taskProfile.effort,
    fallbackModel: taskProfile.fallbackModel,
    scan: {
      strategyVersion: scanSummary.strategyVersion, nameCandidateCount: scan.nameCandidates.length,
      repeatedPhraseCandidateCount: scan.repeatedPhrases.length,
      dialogueSegmentCount: scan.dialogueSegmentCount, targetedNameCount: prepared.samplePlanDiagnostics.targetedNameCount,
    },
  });
  const modelAnalysisStartedAt = Date.now();
  let workflowSessionId = safeText(getMeta(db, revisionId, workflowSessionKey(runId)), 500);
  if (!workflowSessionId && initialProgress.resumedFromRunId) {
    workflowSessionId = safeText(getMeta(db, revisionId, workflowSessionKey(String(initialProgress.resumedFromRunId))), 500);
    if (workflowSessionId) saveMeta(db, revisionId, workflowSessionKey(runId), workflowSessionId);
  }

  let data: Record<string, any>;
  if (strategy === 'B') {
    const staged = await runStagedWorkflow({
      store, db, revisionId, projectId, runId, prompt, initialProgress, agent, taskProfile,
      sampleIds, samples, modelAnalysisStartedAt, workflowSessionId,
    });
    data = staged.data;
    workflowSessionId = staged.workflowSessionId;
  } else {
    data = await runSingleShotAnalysis({ db, projectId, revisionId, runId, prompt, agent, taskProfile, modelAnalysisStartedAt });
  }

  const style = await completeStyleGuide({
    db, projectId, revisionId, runId, prompt, data, strategy, agent, taskProfile,
    modelAnalysisStartedAt, sampleIds, samples, workflowSessionId: workflowSessionId || undefined,
  });

  persistAnalysisGraph({
    store, db, projectId, runId, revisionId, segments, sampleIds, samples, chapters, scanSummary,
    data, strategy, sourceLang, targetLang, modelAnalysisStartedAt, agent, scan, sampleReasons, style,
  });
}

/**
 * 幂等地排队并异步启动当前 source revision 的 Context Graph 预处理。
 * 同一项目/来源版本只允许一个活动分析，并禁止与活动翻译 Run 冲突；返回 accepted 不代表
 * 分析已完成。调用方应通过 getContextGraphStatus/事件轨迹读取完成或失败状态。
 */
export function startContextGraphAnalysis(
  projectId: string,
  options: { ignoreQueuedRunId?: string } = {},
): { accepted: boolean; alreadyRunning: boolean; runId: string } {
  const { db, revisionId } = graphContext(projectId);
  const segmentCount = Number((db.prepare('SELECT COUNT(*) AS count FROM source_segments WHERE source_revision_id = ?').get(revisionId) as any)?.count || 0);
  if (!segmentCount) throw Object.assign(new Error('当前来源版本没有可分析的文档片段。'), { status: 409 });
  assertNoActiveTranslation(projectId, db, options.ignoreQueuedRunId);
  const existing = db.prepare(
    "SELECT run_id FROM context_graph_runs WHERE source_revision_id = ? AND status IN ('queued','running') ORDER BY started_at DESC, rowid DESC LIMIT 1"
  ).get(revisionId) as { run_id?: string } | undefined;
  if (existing?.run_id && activeAnalyses.get(projectId) === existing.run_id) {
    return { accepted: true, alreadyRunning: true, runId: existing.run_id };
  }
  if (existing?.run_id) {
    // A database row alone is not proof that a live analysis still exists. Heal orphaned
    // rows before accepting a new request, including force-reanalyze requests.
    reconcileOrphanedContextGraphRun(
      projectId, db, existing.run_id,
      '检测到没有对应执行任务的陈旧预处理记录；旧任务已收敛为失败，可重新分析。',
    );
  }
  // Do not persist a queued run that cannot start while another source revision is being analyzed.
  if (activeAnalyses.has(projectId)) {
    throw Object.assign(new Error('该项目的上一轮 Context Graph 分析仍在运行，请稍后重试。'), { status: 409 });
  }
  const strategyMode = process.env.LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY || 'b';
  let resume: { runId: string; progress: Record<string, any>; completedStages: string[] } | null = null;
  if (String(strategyMode).trim().toLowerCase() !== 'a') {
    const failedRows = db.prepare(
      "SELECT run_id, progress_json FROM context_graph_runs WHERE source_revision_id = ? AND status = 'failed' ORDER BY started_at DESC, rowid DESC LIMIT 12"
    ).all(revisionId) as Array<{ run_id: string; progress_json?: string }>;
    for (const row of failedRows) {
      let progress: Record<string, any> = {};
      try { progress = JSON.parse(row.progress_json || '{}'); } catch { continue; }
      if (progress.strategy !== 'B' ||
          progress.workflowVersion !== CONTEXT_GRAPH_WORKFLOW_VERSION ||
          progress.analysisVersion !== CONTEXT_GRAPH_ANALYSIS_VERSION ||
          !Array.isArray(progress.completedStages)) continue;
      const reusableStages = progress.completedStages.filter((stageId: unknown): stageId is string => {
        if (typeof stageId !== 'string') return false;
        const stage = CONTEXT_GRAPH_WORKFLOW_STAGES.find((candidate) => candidate.id === stageId);
        if (!stage) return false;
        const checkpoint = getMeta(db, revisionId, workflowCheckpointKey(row.run_id, stageId as ContextGraphWorkflowStageId));
        return !!checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) &&
          stage.fields.every((field) => Object.prototype.hasOwnProperty.call(checkpoint, field));
      });
      if (reusableStages.length) {
        resume = { runId: row.run_id, progress, completedStages: reusableStages };
        break;
      }
    }
  }

  const runId = randomUUID();
  const strategy: ContextGraphAnalysisStrategy = resume
    ? 'B'
    : chooseContextGraphStrategy(strategyMode, readLatestStrategy(db, revisionId));
  const initialRunProgress: Record<string, any> = resume ? {
    ...resume.progress,
    strategy: 'B',
    workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    resumedFromRunId: resume.runId,
    completedStages: resume.completedStages,
    stageResults: Array.isArray(resume.progress.stageResults)
      ? resume.progress.stageResults.filter((item: any) => resume!.completedStages.includes(item.stage))
      : [],
    currentStage: null,
  } : {
    strategy,
    workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    completedStages: [],
    stageResults: [],
  };
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at) VALUES (?, ?, \'queued\', \'queued\', ?, ?)'
  ).run(runId, revisionId, JSON.stringify(initialRunProgress), new Date().toISOString());
  if (resume) {
    const previousSessionId = getMeta(db, revisionId, workflowSessionKey(resume.runId));
    if (typeof previousSessionId === 'string' && previousSessionId.trim()) {
      saveMeta(db, revisionId, workflowSessionKey(runId), previousSessionId);
    }
  }
  getDocumentProjectStore().appendEvent(projectId, runId, 'context-graph.strategy.selected', {
    strategy, workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    ...(resume ? { resumedFromRunId: resume.runId, resumedStages: resume.completedStages } : {}),
    assignment: ['a', 'b'].includes(String(strategyMode).trim().toLowerCase()) ? 'configured' : 'alternating-ab',
  });
  activeAnalyses.set(projectId, runId);
  void runAnalysis(projectId, runId).catch((error) => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    try {
      const context = getDocumentProjectStore().getProjectContext(projectId);
      ensureSchema(context.db);
      context.db.exec('BEGIN IMMEDIATE');
      try {
        context.db.prepare("UPDATE context_graph_runs SET status = 'failed', phase = 'failed', error = ?, finished_at = ? WHERE run_id = ?")
          .run(message, new Date().toISOString(), runId);
        getDocumentProjectStore().appendEvent(projectId, runId, 'context-graph.failed', { error: message, recovery: 'analysis-error' });
        context.db.exec('COMMIT');
      } catch (writeError) {
        try { context.db.exec('ROLLBACK'); } catch { /* preserve the persistence error */ }
        throw writeError;
      }
    } catch (persistError) {
      logError('context-graph', 'unable to persist failure · ' + (persistError instanceof Error ? persistError.message : String(persistError)));
    }
    // context-graph.failed already writes a concise terminal summary with the same error.
    // Avoid dumping the same Error object/stack a second time for ordinary failures.
  }).finally(() => { if (activeAnalyses.get(projectId) === runId) activeAnalyses.delete(projectId); });
  return { accepted: true, alreadyRunning: false, runId };
}

