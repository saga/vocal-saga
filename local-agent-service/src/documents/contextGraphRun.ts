/**
 * Context Graph 分析的编排：启动、孤儿运行回收、按策略执行并落库。
 *
 * 从 contextGraph 抽出：这里只负责「先做什么后做什么」与失败处理，
 * 具体的存取、提示词、查询分别在同目录的其它模块里。
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseAgentModel } from '../json.ts';
import { ANALYSIS_TIMEOUT_MS } from '../config.ts';
import { runAgentStructured } from '../agents/runner.ts';
import { formatTurnUsageLog } from '../agents/usage.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { getDocumentProjectStore } from './projectStore.ts';
import { planBookSamples, scanBookSegmentsConcurrent } from './bookScan.ts';
import { logError, logInfo, logWarn } from '../log.ts';
import {
  canonicalTargetsConflict,
  isWorthCanonicalEntityMapping,
  normalizeCanonicalEntityKind,
  splitCompoundCanonicalName,
  validateCanonicalTarget,
} from './canonicalEntityPolicy.ts';
import {
  buildContextGraphWorkflowPrompt,
  buildContextGraphWorkflowSchema,
  chooseContextGraphStrategy,
  CONTEXT_GRAPH_STAGE_SESSION_PARENT,
  CONTEXT_GRAPH_STAGE_WAVES,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphAnalysisStrategy,
  type ContextGraphWorkflowStageId,
} from './contextGraphWorkflow.ts';
import {
  assertNoActiveTranslation,
  chapterMap,
  clearReplaceableModelGeneratedContextGraphItems,
  contextGraphCandidateDisposition,
  getMeta,
  graphContext,
  nameMap,
  nodeId,
  normalize,
  patchRunProgress,
  persistWorkflowStageCheckpoint,
  readLatestStrategy,
  readRunProgress,
  readSegments,
  resetChapterSummariesForReanalysis,
  safeText,
  saveEdge,
  saveMeta,
  saveNode,
  sourceNameMatches,
  uniqueStrings,
  validateEvidence,
  workflowCheckpointKey,
  workflowSessionKey,
  writeChapterSnapshots,
} from './contextGraphStore.ts';
import {
  ANALYSIS_SCHEMA,
  BOOK_SCAN_INDEX_VERSION,
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
  ensureSchema,
  hasCurrentSourceFeatureIndex,
  persistSourceFeatureIndex,
  readySourceFeatureIndexes,
  type Evidence,
  type Segment,
} from './contextGraphSchema.ts';
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
  const { db, revisionId, segments } = readSegments(projectId);
  const startedAt = new Date().toISOString();
  const initialProgress = readRunProgress(db, runId);
  const strategy: ContextGraphAnalysisStrategy = initialProgress.strategy === 'B' ? 'B' : 'A';
  db.prepare('UPDATE context_graph_runs SET status = \'running\', phase = \'sample\', started_at = ?, progress_json = ? WHERE run_id = ?')
    .run(startedAt, JSON.stringify({ ...initialProgress, segmentCount: segments.length }), runId);
  store.appendEvent(projectId, runId, 'context-graph.phase', {
    phase: 'sample', segmentCount: segments.length, strategy,
    ...(initialProgress.resumedFromRunId ? { resumedFromRunId: initialProgress.resumedFromRunId } : {}),
  });
  writeChapterSnapshots(db, revisionId, segments);

  const prompts = store.listPrompts(projectId);
  const config = prompts[0]?.config || {};
  const sourceLang = safeText(config.sourceLang, 40) || 'auto';
  const targetLang = safeText(config.targetLang, 40) || 'zh';
  const provider = safeText(config.provider, 40) || 'workbuddy';
  const modelName = safeText(config.model, 240) || 'auto';
  const scanStartedAt = Date.now();
  const scan = await scanBookSegmentsConcurrent(segments, { sourceLang });
  const scanDurationMs = Date.now() - scanStartedAt;
  const sourceFeatureIndexReused = hasCurrentSourceFeatureIndex(db, revisionId, segments.length, sourceLang);
  if (!sourceFeatureIndexReused) {
    persistSourceFeatureIndex(db, revisionId, segments, scan, sourceLang);
    readySourceFeatureIndexes.set(revisionId, {
      indexVersion: BOOK_SCAN_INDEX_VERSION,
      sourceLang,
      sourceSegmentCount: segments.length,
      entityMentionCount: scan.indexDiagnostics.entityMentionCount,
      entityMentionLimit: scan.indexDiagnostics.entityMentionLimit,
      entityMentionsTruncated: scan.indexDiagnostics.entityMentionsTruncated,
      textUnitCount: scan.indexDiagnostics.textUnitCount,
      textUnitLimit: scan.indexDiagnostics.textUnitLimit,
      textUnitsTruncated: scan.indexDiagnostics.textUnitsTruncated,
      quantityMentionCount: scan.indexDiagnostics.quantityMentionCount,
      quantityMentionLimit: scan.indexDiagnostics.quantityMentionLimit,
      quantityMentionsTruncated: scan.indexDiagnostics.quantityMentionsTruncated,
    });
  }
  const samplePlan = planBookSamples(segments, scan);
  const samples: Segment[] = samplePlan.samples.map(({ segment }) => ({
    id: segment.id, ordinal: segment.ordinal, text: segment.text,
    kind: segment.kind || 'paragraph', contextPath: segment.contextPath || '',
  }));
  const sampleReasons = new Map<string, string[]>(samplePlan.samples.map((item) => [item.segment.id, item.reasons] as [string, string[]]));
  const sampleIds = new Set(samples.map((segment) => segment.id));
  const samplesById = new Map(samples.map((segment) => [segment.id, segment]));
  const chapters = chapterMap(segments);
  const scanSummary = {
    strategyVersion: 'adaptive-book-scan-v3-source-language-index',
    segmentCount: scan.segmentCount,
    sourceCharCount: scan.charCount,
    chapterCount: scan.chapterCount,
    dialogueSegmentCount: scan.dialogueSegmentCount,
    nameCandidateCount: scan.nameCandidates.length,
    repeatedPhraseCandidateCount: scan.repeatedPhrases.length,
    entityMentionCount: scan.indexDiagnostics.entityMentionCount,
    entityMentionsTruncated: scan.indexDiagnostics.entityMentionsTruncated,
    sentenceAndQuoteUnitCount: scan.indexDiagnostics.textUnitCount,
    textUnitsTruncated: scan.indexDiagnostics.textUnitsTruncated,
    quantityMentionCount: scan.indexDiagnostics.quantityMentionCount,
    quantityMentionsTruncated: scan.indexDiagnostics.quantityMentionsTruncated,
    ...samplePlan.diagnostics,
    samplePlan: samplePlan.samples.map((item) => ({
      segmentId: item.segment.id, ordinal: item.segment.ordinal, chapter: item.segment.contextPath,
      reasons: item.reasons,
    })),
  };
  store.appendEvent(projectId, runId, 'context-graph.scan.completed', {
    strategyVersion: scanSummary.strategyVersion,
    segmentCount: scan.segmentCount, chapterCount: scan.chapterCount,
    dialogueSegmentCount: scan.dialogueSegmentCount,
    nameCandidateCount: scan.nameCandidates.length,
    repeatedPhraseCandidateCount: scan.repeatedPhrases.length,
    sampleCount: samples.length, sampleLimit: samplePlan.diagnostics.sampleLimit,
    targetedNameCount: samplePlan.diagnostics.targetedNameCount,
    entityMentionCount: scan.indexDiagnostics.entityMentionCount,
    sentenceAndQuoteUnitCount: scan.indexDiagnostics.textUnitCount,
    quantityMentionCount: scan.indexDiagnostics.quantityMentionCount,
    indexVersion: BOOK_SCAN_INDEX_VERSION,
    scanDurationMs,
    sourceFeatureIndexReused,
    indexTruncation: {
      entityMentions: scan.indexDiagnostics.entityMentionsTruncated,
      textUnits: scan.indexDiagnostics.textUnitsTruncated,
      quantityMentions: scan.indexDiagnostics.quantityMentionsTruncated,
    },
  });


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
    scanDurationMs, sampleIds: samples.map((sample) => sample.id),
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
      dialogueSegmentCount: scan.dialogueSegmentCount, targetedNameCount: samplePlan.diagnostics.targetedNameCount,
    },
  });
  const modelAnalysisStartedAt = Date.now();
  let data: Record<string, any>;
  // style 沿用 run 级 Session key（兼容旧数据与文风补全路径），其余阶段各自持有独立 Session。
  let workflowSessionId = safeText(getMeta(db, revisionId, workflowSessionKey(runId)), 500);
  const stageSessionIds = new Map<ContextGraphWorkflowStageId, string>();
  if (workflowSessionId) stageSessionIds.set('style', workflowSessionId);
  if (!workflowSessionId && initialProgress.resumedFromRunId) {
    workflowSessionId = safeText(getMeta(db, revisionId, workflowSessionKey(String(initialProgress.resumedFromRunId))), 500);
    if (workflowSessionId) {
      saveMeta(db, revisionId, workflowSessionKey(runId), workflowSessionId);
      stageSessionIds.set('style', workflowSessionId);
    }
  }

  if (strategy === 'B') {
    const resumeFromRunId = typeof initialProgress.resumedFromRunId === 'string' ? initialProgress.resumedFromRunId : '';
    const checkpointSourceRunId = resumeFromRunId || runId;
    const completedBefore = new Set<string>(Array.isArray(initialProgress.completedStages) ? initialProgress.completedStages : []);
    const aggregate: Record<string, any> = {};
    const stageTimeoutConfigured = Number(process.env.LOCAL_AGENT_CONTEXT_GRAPH_STAGE_TIMEOUT_MS);
    const stageTimeoutMs = Number.isFinite(stageTimeoutConfigured) && stageTimeoutConfigured > 0
      ? Math.min(ANALYSIS_TIMEOUT_MS, stageTimeoutConfigured)
      : Math.min(ANALYSIS_TIMEOUT_MS, 5 * 60 * 1000);

    type WorkflowStage = { id: ContextGraphWorkflowStageId; label: string; phase: string; fields: readonly string[] };

    /** 阶段 Session key：style 沿用 run 级 key，其余阶段按阶段隔离，避免并行分支互相覆盖。 */
    const stageSessionKey = (stageId: ContextGraphWorkflowStageId, forRunId: string) =>
      stageId === 'style' ? workflowSessionKey(forRunId) : workflowSessionKey(forRunId, stageId);

    /**
     * 执行单个阶段：命中检查点直接恢复，否则发起一次结构化调用并落库。
     * 同波次内多个阶段会并发调用本函数，因此每次读写 progress_json 之间不能插入 await。
     */
    const runStage = async (stage: WorkflowStage, waveIndex: number): Promise<void> => {
      const checkpoint = completedBefore.has(stage.id)
        ? getMeta(db, revisionId, workflowCheckpointKey(checkpointSourceRunId, stage.id))
        : null;
      const validCheckpoint = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) &&
        stage.fields.every((field) => Object.prototype.hasOwnProperty.call(checkpoint, field));
      if (validCheckpoint) {
        Object.assign(aggregate, checkpoint);
        if (checkpointSourceRunId !== runId) saveMeta(db, revisionId, workflowCheckpointKey(runId, stage.id), checkpoint);
        const restoredProgress = readRunProgress(db, runId);
        store.appendEvent(projectId, runId, 'context-graph.stage.restored', {
          strategy: 'B', stage: stage.id, stageLabel: stage.label,
          sourceRunId: checkpointSourceRunId,
          completedStageCount: Array.isArray(restoredProgress.completedStages) ? restoredProgress.completedStages.length : 0,
          stageCount: CONTEXT_GRAPH_WORKFLOW_STAGES.length,
        });
        logInfo('context-graph', '恢复已保存阶段 · ' + stage.id + ' · run=' + runId.slice(0, 8));
        return;
      }

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

      // 并行分支不能共用同一个 Session；能续聊时复用父阶段 Session，避免重发整份样本。
      const parentStageId = CONTEXT_GRAPH_STAGE_SESSION_PARENT[stage.id];
      const sessionId = stageSessionIds.get(stage.id)
        || safeText(getMeta(db, revisionId, stageSessionKey(stage.id, checkpointSourceRunId)), 500)
        || (parentStageId
          ? stageSessionIds.get(parentStageId)
            || safeText(getMeta(db, revisionId, stageSessionKey(parentStageId, checkpointSourceRunId)), 500)
          : '');
      const stagePrompt = buildContextGraphWorkflowPrompt(
        stage.id, prompt, aggregate,
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
            onSessionId: (newSessionId: string) => {
              stageSessionIds.set(stage.id, newSessionId);
              saveMeta(db, revisionId, stageSessionKey(stage.id, runId), newSessionId);
              if (stage.id === 'style') workflowSessionId = newSessionId;
            },
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
        stageSessionIds.set(stage.id, stageRun.sessionId);
        saveMeta(db, revisionId, stageSessionKey(stage.id, runId), stageRun.sessionId);
        if (stage.id === 'style') workflowSessionId = stageRun.sessionId;
      }
      const stageElapsedMs = Date.now() - stageStartedAt;
      persistWorkflowStageCheckpoint(
        db, revisionId, runId, stage.id, stageOutput, stageElapsedMs,
        sampleIds, samples,
      );
      const stageProgress = readRunProgress(db, runId);
      const stageSummary = Array.isArray(stageProgress.stageResults)
        ? stageProgress.stageResults.find((item: any) => item.stage === stage.id)
        : null;
      store.appendEvent(projectId, runId, 'context-graph.stage.completed', {
        strategy: 'B', stage: stage.id, stageLabel: stage.label,
        stageIndex: CONTEXT_GRAPH_WORKFLOW_STAGES.findIndex((item) => item.id === stage.id) + 1,
        stageCount: CONTEXT_GRAPH_WORKFLOW_STAGES.length,
        completedStageCount: Array.isArray(stageProgress.completedStages) ? stageProgress.completedStages.length : 0,
        elapsedMs: stageElapsedMs, outputCounts: stageSummary?.outputCounts || {},
        waveIndex: waveIndex + 1,
      });
      Object.assign(aggregate, stageOutput);
    };

    for (let waveIndex = 0; waveIndex < CONTEXT_GRAPH_STAGE_WAVES.length; waveIndex++) {
      const wave = CONTEXT_GRAPH_STAGE_WAVES[waveIndex]!;
      const stages = wave
        .map((stageId) => CONTEXT_GRAPH_WORKFLOW_STAGES.find((item) => item.id === stageId) as WorkflowStage | undefined)
        .filter((stage): stage is WorkflowStage => !!stage);
      if (!stages.length) continue;
      // 同波次只写一次 phase：并发阶段各自写会让 UI 的阶段读数来回跳动。
      db.prepare('UPDATE context_graph_runs SET phase = ? WHERE run_id = ?').run(stages[0]!.phase, runId);
      if (stages.length > 1) {
        logInfo('context-graph', '并行波次 ' + (waveIndex + 1) + '/' + CONTEXT_GRAPH_STAGE_WAVES.length +
          ' · ' + stages.map((stage) => stage.id).join('+'));
      }
      // 同波次阶段互不依赖；任一失败即整体失败，已落库的检查点留给下次恢复。
      await Promise.all(stages.map((stage) => runStage(stage, waveIndex)));
    }

    data = aggregate;
    patchRunProgress(db, runId, {
      strategy: 'B', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
      currentStage: null, workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
      completedStages: CONTEXT_GRAPH_WORKFLOW_STAGES.map((stage) => stage.id),
    });
  } else {
    const analysisRun = await runAgentStructured(
      { provider: agent.provider, model: agent.model },
      prompt,
      DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
      ANALYSIS_SCHEMA,
      runId,
      'context-graph:' + projectId + ':' + revisionId + ':' + runId,
      taskProfile,
      { timeoutMs: ANALYSIS_TIMEOUT_MS },
    );
    if (analysisRun.usage) logInfo('context-graph', formatTurnUsageLog(analysisRun.usage));
    const output = analysisRun.result;
    if (!output || Array.isArray(output)) throw new Error('Context Graph 分析返回了非对象结果。');
    data = output as Record<string, any>;
    patchRunProgress(db, runId, {
      strategy: 'A', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
      currentStage: null, workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
    });
  }

  const styleDimensions = ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction'];
  const findMissingStyleFields = (value: Record<string, any>) => [
    ...styleDimensions.filter((field) => !safeText(value[field], 1000)),
    ...(!Array.isArray(value.styleRules) || uniqueStrings(value.styleRules, 24, 240).length === 0 ? ['styleRules'] : []),
  ];
  let missingStyleDimensions = findMissingStyleFields(data);
  let styleRepairUsed = false;
  if (missingStyleDimensions.length) {
    styleRepairUsed = true;
    // Some providers treat a JSON schema as shape guidance and still emit empty strings.
    // Repair only these fields rather than falsely completing a run with an empty style guide.
    logWarn('context-graph', '文风字段为空，启动定向补全 · strategy=' + strategy + ' · fields=' + missingStyleDimensions.join(','));
    const repairStartedAt = Date.now();
    const repairRun = await runAgentStructured(
      { provider: agent.provider, model: agent.model },
      buildContextGraphWorkflowPrompt(
        'style', prompt, data, strategy === 'B' && agent.provider === 'workbuddy' && !!workflowSessionId,
      ) + '\n\n上次结构化响应中的以下字段为空：' + missingStyleDimensions.join('、') +
        '。请重新分析并全部填写这些字段；不能返回空字符串或空规则数组。保持其他字段的证据边界，不要编造原文证据。',
      DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
      buildContextGraphWorkflowSchema(ANALYSIS_SCHEMA, 'style'),
      runId + ':style-repair',
      'context-graph:' + projectId + ':' + revisionId + ':' + runId,
      taskProfile,
      {
        timeoutMs: Math.min(ANALYSIS_TIMEOUT_MS, 5 * 60 * 1000),
        ...(strategy === 'B' && agent.provider === 'workbuddy' ? {
          persistSession: true,
          ...(workflowSessionId ? { sessionId: workflowSessionId } : {}),
          onSessionId: (sessionId: string) => {
            workflowSessionId = sessionId;
            saveMeta(db, revisionId, workflowSessionKey(runId), sessionId);
          },
        } : {}),
      },
    );
    if (!repairRun.result || Array.isArray(repairRun.result)) throw new Error('Context Graph 文风补全返回了非对象结果。');
    const repairedStyle = repairRun.result as Record<string, any>;
    Object.assign(data, repairedStyle);
    missingStyleDimensions = findMissingStyleFields(data);
    if (missingStyleDimensions.length) {
      throw new Error('Context Graph 文风补全后仍缺少有效字段（' + missingStyleDimensions.join('、') +
        '）。本轮未标记为完成；B 方案已保存的其他阶段结果会在重试时复用。');
    }
    if (strategy === 'B') {
      persistWorkflowStageCheckpoint(
        db, revisionId, runId, 'style',
        Object.fromEntries(CONTEXT_GRAPH_WORKFLOW_STAGES[0].fields.map((field) => [field, data[field]])),
        Date.now() - repairStartedAt, sampleIds, samples,
      );
    }
  }
  const styleFieldCoverage = Object.fromEntries(
    styleDimensions.map((field) => [field, !!safeText(data[field], 1000)]),
  ) as Record<string, boolean>;
  const styleRuleCount = uniqueStrings(data.styleRules, 24, 240).length;
  const styleAvoidCount = uniqueStrings(data.styleAvoid, 16, 240).length;
  const styleEvidenceCount = Array.isArray(data.styleEvidence) ? data.styleEvidence.length : 0;
  patchRunProgress(db, runId, {
    workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
    styleRepairUsed, styleFieldCoverage, styleRuleCount, styleAvoidCount, styleEvidenceCount,
  });
  const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
  const allowedEvidence = new Map<string, Segment>();
  for (const id of sampleIds) {
    const segment = sourceById.get(id);
    if (segment) allowedEvidence.set(id, segment);
  }

  let invalidEvidenceCount = 0;
  const invalidEvidenceByReason: Record<string, number> = {};
  const invalidEvidenceByCategory: Record<string, number> = {};
  type CandidateAudit = {
    category: string;
    name: string;
    aliases: string[];
    suggestedTranslation?: string;
    role?: string;
    traits?: string[];
    voice?: string[];
    rawEvidenceCount: number;
    acceptedEvidenceCount: number;
    invalidEvidenceReasons: Record<string, number>;
    disposition: string;
    nodeId?: string;
  };
  const characterAudits: CandidateAudit[] = [];
  const entityAudits: CandidateAudit[] = [];
  const evidenceFromModel = (raw: unknown, category = 'other', audit?: CandidateAudit) =>
    validateEvidence(raw, allowedEvidence, (reason) => {
      invalidEvidenceCount++;
      invalidEvidenceByReason[reason] = (invalidEvidenceByReason[reason] || 0) + 1;
      invalidEvidenceByCategory[category] = (invalidEvidenceByCategory[category] || 0) + 1;
      if (audit) audit.invalidEvidenceReasons[reason] = (audit.invalidEvidenceReasons[reason] || 0) + 1;
    });
  db.exec('BEGIN IMMEDIATE');
  try {
    // Rebuild model-generated graph items transactionally while retaining user decisions
    // and any model-default endpoint still referenced by a surviving user-confirmed/rejected edge.
    clearReplaceableModelGeneratedContextGraphItems(db, revisionId);
    // 重新分析前重置上一轮模型生成的章节摘要（见 resetChapterSummariesForReanalysis）。
    resetChapterSummariesForReanalysis(db, revisionId, segments);
    saveMeta(db, revisionId, 'stylePolicyVersion', 'literary-style-v3-default-adoption');
    saveMeta(db, revisionId, 'bookSummary', safeText(data.bookSummary, 4000));
    saveMeta(db, revisionId, 'narrativeStyle', safeText(data.narrativeStyle, 1200));
    saveMeta(db, revisionId, 'styleRegister', safeText(data.styleRegister, 1000));
    saveMeta(db, revisionId, 'styleRhythm', safeText(data.styleRhythm, 1000));
    saveMeta(db, revisionId, 'styleDialogue', safeText(data.styleDialogue, 1000));
    saveMeta(db, revisionId, 'styleDiction', safeText(data.styleDiction, 1000));
    saveMeta(db, revisionId, 'styleRules', uniqueStrings(data.styleRules, 24, 240));
    saveMeta(db, revisionId, 'styleAvoid', uniqueStrings(data.styleAvoid, 16, 240));
    saveMeta(db, revisionId, 'styleEvidence', Array.isArray(data.styleEvidence) ? data.styleEvidence.filter((item: any) =>
      item && typeof item.segmentId === 'string' && samples.some((sample) => sample.id === item.segmentId) &&
      typeof item.quote === 'string' && item.quote.trim().length >= 8 && samples.some((sample) => sample.id === item.segmentId && sample.text.includes(item.quote.trim()))
    ).slice(0, 40).map((item: any) => ({ dimension: safeText(item.dimension, 40), segmentId: item.segmentId, quote: safeText(item.quote, 240), observation: safeText(item.observation, 300) })) : []);

    const persistedNodes: Array<{ id: string; name: string; aliases: string[]; kind: string }> = [];
    for (const raw of (Array.isArray(data.characters) ? data.characters : []).slice(0, 200)) {
      const name = safeText(raw?.name, 120);
      const audit: CandidateAudit = {
        category: 'character', name,
        aliases: uniqueStrings(raw?.aliases, 12, 100),
        suggestedTranslation: safeText(raw?.suggestedTranslation, 120),
        role: safeText(raw?.role, 240),
        traits: uniqueStrings(raw?.traits, 6, 100),
        voice: uniqueStrings(raw?.voice, 6, 120),
        rawEvidenceCount: Array.isArray(raw?.evidence) ? raw.evidence.length : 0,
        acceptedEvidenceCount: 0, invalidEvidenceReasons: {}, disposition: 'not-evaluated',
      };
      characterAudits.push(audit);
      if (!name) {
        audit.disposition = 'dropped-empty-name';
        continue;
      }
      const evidence = evidenceFromModel(raw.evidence, 'character', audit);
      audit.acceptedEvidenceCount = evidence.length;
      const characterDecision = contextGraphCandidateDisposition(
        evidence.length, persistedNodes.filter((node) => node.kind === 'character').length, 40,
      );
      if (characterDecision !== 'persist') {
        audit.disposition = characterDecision === 'no-evidence'
          ? 'dropped-no-valid-evidence' : 'dropped-valid-candidate-limit';
        continue;
      }
      const characterTarget = validateCanonicalTarget({
        source: name, target: audit.suggestedTranslation || '', targetLang, kind: 'person',
      });
      if (!characterTarget.valid) audit.suggestedTranslation = '';
      else audit.suggestedTranslation = characterTarget.normalizedTarget;
      const aliases = audit.aliases.filter((item) => normalize(item) !== normalize(name));
      const attributes = {
        aliases, suggestedTranslation: audit.suggestedTranslation || '', targetLang,
        ...(characterTarget.valid ? {} : { suggestedTranslationQuality: characterTarget.reason || 'invalid-target' }),
        role: safeText(raw.role, 360), traits: uniqueStrings(raw.traits, 10, 160),
        voice: uniqueStrings(raw.voice, 10, 180), evidenceCount: evidence.length,
      };
      const id = saveNode(db, revisionId, 'character', name, attributes, evidence);
      audit.disposition = 'persisted';
      audit.nodeId = id;
      persistedNodes.push({ id, name, aliases, kind: 'character' });
    }
    let droppedLowValueEntityCount = 0;
    let droppedCompoundEntityCount = 0;
    let invalidEntityTargetCount = 0;
    let splitCompoundEntityCount = 0;
    let conflictingEntityTargetCount = 0;
    const canonicalTargetBySource = new Map<string, string>();
    const conflictingCanonicalSources = new Set<string>();
    const saveEntityCandidate = (
      entityName: string,
      targetName: string,
      rawKind: unknown,
      significance: string,
      aliasesInput: unknown,
      evidence: Evidence[],
      audit: CandidateAudit,
      bookSpecificMeaning = false,
    ) => {
      if (persistedNodes.filter((node) => node.kind === 'entity').length >= 120) {
        audit.disposition = 'dropped-valid-candidate-limit';
        return false;
      }
      const entityKey = normalize(entityName);
      if (conflictingCanonicalSources.has(entityKey)) {
        audit.disposition = 'dropped-conflicting-canonical-target';
        return false;
      }
      const normalizedKind = normalizeCanonicalEntityKind(rawKind);
      const occurrences = segments.filter((segment) => sourceNameMatches(segment.text, entityName));
      const chapterCount = new Set(occurrences.map((segment) => segment.contextPath).filter(Boolean)).size;
      if (!isWorthCanonicalEntityMapping({
        source: entityName, kind: normalizedKind,
        mentions: occurrences.length, chapterCount, significance, explicitBookSpecificMeaning: bookSpecificMeaning,
      })) {
        droppedLowValueEntityCount++;
        return false;
      }
      // A manually confirmed target is the canonical value; model re-analysis may refresh evidence
      // but never silently replace the explicit user choice for the same target language.
      let effectiveTargetName = targetName;
      const existingId = nodeId(revisionId, 'entity', entityName);
      const existingNode = db.prepare(
        'SELECT status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND node_id = ?'
      ).get(revisionId, existingId) as { status?: string; attributes_json?: string } | undefined;
      if (existingNode?.status === 'confirmed') {
        try {
          const priorAttributes = JSON.parse(existingNode.attributes_json || '{}');
          if (priorAttributes.targetLang === targetLang && typeof priorAttributes.suggestedTranslation === 'string' &&
              priorAttributes.suggestedTranslation.trim()) {
            effectiveTargetName = priorAttributes.suggestedTranslation;
          }
        } catch { /* invalid legacy attributes are revalidated below */ }
      }
      const targetCheck = validateCanonicalTarget({
        source: entityName, target: effectiveTargetName, targetLang, kind: normalizedKind,
      });
      if (!targetCheck.valid) {
        invalidEntityTargetCount++;
        if (canonicalTargetBySource.has(entityKey)) {
          // A malformed duplicate must not erase an already valid candidate for the same source.
          audit.disposition = 'dropped-invalid-target-conflicts-with-valid-candidate';
          return false;
        }
      }
      if (targetCheck.valid) {
        const priorTarget = canonicalTargetBySource.get(entityKey);
        if (priorTarget && canonicalTargetsConflict(priorTarget, targetCheck.normalizedTarget)) {
          conflictingCanonicalSources.add(entityKey);
          conflictingEntityTargetCount++;
          audit.disposition = 'dropped-conflicting-canonical-target';
          // Same source with two plausible targets is ambiguous: do not let array order choose.
          // Invalidate the earlier machine candidate, but never touch a confirmed user mapping.
          if (existingNode?.status !== 'confirmed') {
            const priorId = nodeId(revisionId, 'entity', entityName);
            const priorRow = db.prepare(
              'SELECT attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND node_id = ?'
            ).get(revisionId, priorId) as { attributes_json?: string } | undefined;
            if (priorRow) {
              let priorAttributes: Record<string, unknown> = {};
              try { priorAttributes = JSON.parse(priorRow.attributes_json || '{}'); } catch { priorAttributes = {}; }
              priorAttributes.suggestedTranslation = '';
              priorAttributes.suggestedTranslationQuality = 'conflicting-target-candidates';
              db.prepare('UPDATE context_graph_nodes SET attributes_json = ?, updated_at = ? WHERE source_revision_id = ? AND node_id = ?')
                .run(JSON.stringify(priorAttributes), new Date().toISOString(), revisionId, priorId);
            }
          }
          return false;
        }
        if (!priorTarget) canonicalTargetBySource.set(entityKey, targetCheck.normalizedTarget);
      }
      const aliases = uniqueStrings(aliasesInput, 12, 100)
        .filter((item) => normalize(item) !== normalize(entityName) && !splitCompoundCanonicalName(item));
      const attributes = {
        aliases,
        entityKind: normalizedKind,
        significance: safeText(significance, 360),
        bookSpecificMeaning,
        suggestedTranslation: targetCheck.valid ? targetCheck.normalizedTarget : '',
        ...(targetCheck.valid ? {} : { suggestedTranslationQuality: targetCheck.reason || 'invalid-target' }),
        targetLang,
        evidenceCount: evidence.length,
      };
      const id = saveNode(db, revisionId, 'entity', entityName, attributes, evidence);
      audit.disposition = targetCheck.valid ? 'persisted' : 'persisted-target-quality-rejected';
      audit.nodeId ||= id;
      persistedNodes.push({ id, name: entityName, aliases, kind: 'entity' });
      return true;
    };

    for (const raw of (Array.isArray(data.entities) ? data.entities : []).slice(0, 400)) {
      const name = safeText(raw?.name, 120);
      const target = safeText(raw?.suggestedTranslation, 120);
      const aliases = uniqueStrings(raw?.aliases, 12, 100);
      const significance = safeText(raw?.significance, 240);
      const audit: CandidateAudit = {
        category: 'entity', name, aliases, suggestedTranslation: target,
        role: significance,
        rawEvidenceCount: Array.isArray(raw?.evidence) ? raw.evidence.length : 0,
        acceptedEvidenceCount: 0, invalidEvidenceReasons: {}, disposition: 'not-evaluated',
      };
      entityAudits.push(audit);
      if (!name) {
        audit.disposition = 'dropped-empty-name';
        continue;
      }
      const evidence = evidenceFromModel(raw.evidence, 'entity', audit);
      audit.acceptedEvidenceCount = evidence.length;
      const entityDecision = contextGraphCandidateDisposition(
        evidence.length, persistedNodes.filter((node) => node.kind === 'entity').length, 120,
      );
      if (entityDecision !== 'persist') {
        audit.disposition = entityDecision === 'no-evidence'
          ? 'dropped-no-valid-evidence' : 'dropped-valid-candidate-limit';
        continue;
      }

      const sourceParts = splitCompoundCanonicalName(name);
      const targetParts = splitCompoundCanonicalName(target);
      if (sourceParts) {
        if (!targetParts || sourceParts.parts.length !== targetParts.parts.length) {
          droppedCompoundEntityCount++;
          audit.disposition = 'dropped-compound-name-unpaired';
          continue;
        }
        const pairs = sourceParts.parts.map((sourcePart, index) => ({
          source: sourcePart, target: targetParts.parts[index] || '',
          evidence: evidence.filter((item) => sourceNameMatches(item.quote, sourcePart)),
        }));
        if (pairs.some((pair) => !pair.target || !pair.evidence.length)) {
          droppedCompoundEntityCount++;
          audit.disposition = 'dropped-compound-name-unverified-part';
          continue;
        }
        splitCompoundEntityCount += pairs.length;
        let saved = 0;
        for (const pair of pairs) {
          if (saveEntityCandidate(
            pair.source, pair.target, raw.kind, significance, [], pair.evidence, audit,
            raw.bookSpecificMeaning === true || raw.book_specific_meaning === true,
          )) saved++;
        }
        if (!saved && audit.disposition === 'not-evaluated') audit.disposition = 'dropped-low-value-compound-parts';
        else if (saved) audit.disposition = 'split-compound-persisted-' + saved;
        continue;
      }
      if (splitCompoundCanonicalName(target)) {
        invalidEntityTargetCount++;
        audit.disposition = 'persisted-target-quality-rejected';
        // Preserve the source evidence for diagnostics, but never store a compound target as a mapping.
        saveEntityCandidate(name, '', raw.kind, significance, aliases, evidence, audit);
        continue;
      }
      saveEntityCandidate(name, target, raw.kind, significance, aliases, evidence, audit,
        raw.bookSpecificMeaning === true || raw.book_specific_meaning === true);
    }

    const identities = nameMap(persistedNodes);
    const savedEdges = new Set<string>();
    const relationshipDiagnostics = {
      processedCount: 0,
      droppedMissingEndpoint: 0,
      droppedSelfLink: 0,
      droppedNoValidEvidence: 0,
    };
    const resolveRelationshipEndpoint = (value: unknown): string | undefined => {
      const name = safeText(value, 120);
      if (!name) return undefined;
      const normalized = normalize(name);
      const direct = identities.get(normalized);
      if (direct) return direct;
      // Models may include a language-specific article while the graph stores the bare node name.
      // This is a conservative one-token normalization; do not perform fuzzy or substring matching.
      const language = String(sourceLang || 'auto').toLocaleLowerCase().split(/[-_]/u)[0];
      const articlePatterns: Record<string, RegExp> = {
        en: /^(?:the|a|an)\s+/u,
        fr: /^(?:le|la|les|un|une|des|l')\s*/u,
        de: /^(?:der|die|das|den|dem|des|ein|eine|einer|eines|einem)\s+/u,
        it: /^(?:il|lo|la|i|gli|le|un|uno|una|l')\s*/u,
      };
      const withoutArticle = normalized.replace(articlePatterns[language] || /^(?!)$/u, '');
      return withoutArticle !== normalized ? identities.get(withoutArticle) : undefined;
    };
    for (const raw of (Array.isArray(data.relationships) ? data.relationships : []).slice(0, 100)) {
      relationshipDiagnostics.processedCount++;
      const fromId = resolveRelationshipEndpoint(raw?.from);
      const toId = resolveRelationshipEndpoint(raw?.to);
      if (!fromId || !toId) {
        relationshipDiagnostics.droppedMissingEndpoint++;
        continue;
      }
      if (fromId === toId) {
        relationshipDiagnostics.droppedSelfLink++;
        continue;
      }
      const evidence = evidenceFromModel(raw.evidence, 'relationship');
      if (!evidence.length) {
        relationshipDiagnostics.droppedNoValidEvidence++;
        continue;
      }
      const edge = saveEdge(db, revisionId, fromId, toId, safeText(raw.kind, 80) || 'relationship', {
        description: safeText(raw.description, 500), voiceRule: safeText(raw.voiceRule, 500), evidenceCount: evidence.length,
      }, evidence);
      savedEdges.add(edge);
    }

    const chapterRows = db.prepare(
      'SELECT chapter_key, chapter_order, chapter_title FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order'
    ).all(revisionId) as any[];
    for (const raw of (Array.isArray(data.chapterSummaries) ? data.chapterSummaries : [])) {
      const title = safeText(raw?.chapter, 160);
      const summary = safeText(raw?.summary, 5000);
      if (!title || !summary) continue;
      const matchingChapter = chapterRows.find((chapter) =>
        normalize(chapter.chapter_title) === normalize(title) || normalize(chapter.chapter_key) === normalize(title));
      if (!matchingChapter) continue;
      const evidence = evidenceFromModel(raw.evidence, 'chapterSummary');
      if (!evidence.length) continue;
      const evidenceBelongsToChapter = evidence.some((item) => {
        const segment = sourceById.get(item.segmentId);
        return !!segment && normalize(segment.contextPath) === normalize(matchingChapter.chapter_key);
      });
      if (!evidenceBelongsToChapter) continue;
      db.prepare(
        'UPDATE context_graph_chapters SET summary = ?, summary_kind = \'model\', segment_ids_json = ?, updated_at = ? ' +
        'WHERE source_revision_id = ? AND chapter_key = ?'
      ).run(summary, JSON.stringify(evidence.map((item) => item.segmentId)), new Date().toISOString(), revisionId, matchingChapter.chapter_key);
    }
    const normalizedNameMatches = (candidateName: string, audit: CandidateAudit) => {
      const names = [audit.name, ...audit.aliases].map(normalize).filter(Boolean);
      return names.includes(normalize(candidateName));
    };
    const candidateCoverage = scan.nameCandidates.slice(0, 32).map((candidate, index) => {
      const characterMatches = characterAudits.filter((audit) => normalizedNameMatches(candidate.name, audit));
      const entityMatches = entityAudits.filter((audit) => normalizedNameMatches(candidate.name, audit));
      const matchingSamples = samples.filter((sample) => {
        const escaped = candidate.name.split('').map((character) =>
          '\\^$.|?*+()[]{}-'.includes(character) ? '\\' + character : character
        ).join('');
        try { return new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])', 'iu').test(sample.text); }
        catch { return normalize(sample.text).includes(normalize(candidate.name)); }
      });
      return {
        rank: index + 1, name: candidate.name, mentions: candidate.mentions,
        chapterCount: candidate.chapterCount, dialogueSegmentCount: candidate.dialogueSegmentCount,
        regionCount: candidate.regionCount, score: candidate.score,
        earlySegmentId: candidate.earlySegmentId, middleSegmentId: candidate.middleSegmentId, lateSegmentId: candidate.lateSegmentId,
        sampleHitCount: matchingSamples.length,
        sampleHits: matchingSamples.slice(0, 4).map((sample) => ({
          segmentId: sample.id, ordinal: sample.ordinal, chapter: sample.contextPath,
          reasons: sampleReasons.get(sample.id) || [],
        })),
        returnedAsCharacter: characterMatches.length > 0,
        returnedAsEntity: entityMatches.length > 0,
        characterDisposition: characterMatches.map((audit) => ({ name: audit.name, disposition: audit.disposition, acceptedEvidenceCount: audit.acceptedEvidenceCount })),
        entityDisposition: entityMatches.map((audit) => ({ name: audit.name, disposition: audit.disposition, acceptedEvidenceCount: audit.acceptedEvidenceCount })),
      };
    });
    const outputAudit = {
      auditVersion: 'context-graph-model-output-audit-v1',
      runId, sourceRevisionId: revisionId,
      provider: agent.provider, model: agent.model || '<runtime-default>',
      sampleCount: samples.length,
      rawCounts: {
        characters: Array.isArray(data.characters) ? data.characters.length : 0,
        entities: Array.isArray(data.entities) ? data.entities.length : 0,
        relationships: Array.isArray(data.relationships) ? data.relationships.length : 0,
        chapterSummaries: Array.isArray(data.chapterSummaries) ? data.chapterSummaries.length : 0,
      },
      styleMetrics: {
        fieldCoverage: styleFieldCoverage,
        rules: styleRuleCount,
        avoidRules: styleAvoidCount,
        evidenceItems: styleEvidenceCount,
        repaired: styleRepairUsed,
      },
      persistedCounts: {
        characters: persistedNodes.filter((node) => node.kind === 'character').length,
        entities: persistedNodes.filter((node) => node.kind === 'entity').length,
        relationships: savedEdges.size,
        relationshipDiagnostics: { ...relationshipDiagnostics, persistedEdges: savedEdges.size },
        characterCandidatesDroppedForEvidence: characterAudits.filter((audit) => audit.disposition === 'dropped-no-valid-evidence').length,
        entityCandidatesDroppedForEvidence: entityAudits.filter((audit) => audit.disposition === 'dropped-no-valid-evidence').length,
        characterCandidatesDroppedAtValidLimit: characterAudits.filter((audit) => audit.disposition === 'dropped-valid-candidate-limit').length,
        entityCandidatesDroppedAtValidLimit: entityAudits.filter((audit) => audit.disposition === 'dropped-valid-candidate-limit').length,
        characterCandidatesOutsideScanWindow: Math.max(0, (Array.isArray(data.characters) ? data.characters.length : 0) - 200),
        entityCandidatesOutsideScanWindow: Math.max(0, (Array.isArray(data.entities) ? data.entities.length : 0) - 400),
      },
      evidenceValidation: {
        invalidEvidenceCount,
        byReason: { ...invalidEvidenceByReason },
        byCategory: { ...invalidEvidenceByCategory },
      },
      candidateCoverage,
      modelCharacters: characterAudits.slice(0, 40),
      modelEntities: entityAudits.slice(0, 60),
    };
    const now = new Date().toISOString();
    db.prepare('UPDATE context_graph_runs SET status = \'completed\', phase = \'completed\', progress_json = ?, finished_at = ?, error = NULL WHERE run_id = ?')
      .run(JSON.stringify({
        ...readRunProgress(db, runId),
        strategy,
        workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
        analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
        sourceLang, targetLang,
        sampleCount: samples.length, chapterCount: chapters.length,
        characterCount: persistedNodes.filter((node) => node.kind === 'character').length,
        entityCount: persistedNodes.filter((node) => node.kind === 'entity').length,
        relationshipCount: savedEdges.size,
        relationshipDiagnostics: { ...relationshipDiagnostics, persistedEdges: savedEdges.size },
        canonicalNameMappingCount: persistedNodes.filter((node) => {
          const row = db.prepare('SELECT attributes_json FROM context_graph_nodes WHERE node_id = ?').get(node.id) as { attributes_json?: string } | undefined;
          try { return !!safeText(JSON.parse(row?.attributes_json || '{}').suggestedTranslation, 120); } catch { return false; }
        }).length,
        openQuestions: uniqueStrings(data.openQuestions, 24, 200),
        invalidEvidenceCount,
        invalidEvidenceByReason,
        invalidEvidenceByCategory,
        outputAuditVersion: outputAudit.auditVersion,
        modelCandidateCounts: outputAudit.rawCounts,
        entityPolicy: { droppedLowValueEntityCount, droppedCompoundEntityCount, invalidEntityTargetCount, splitCompoundEntityCount, conflictingEntityTargetCount },
        droppedCandidateCounts: {
          characters: outputAudit.persistedCounts.characterCandidatesDroppedForEvidence,
          entities: outputAudit.persistedCounts.entityCandidatesDroppedForEvidence,
        },
        scan: scanSummary,
      }), now, runId);
    const canonicalNameMappingCount = persistedNodes.filter((node) => {
      const row = db.prepare('SELECT attributes_json FROM context_graph_nodes WHERE node_id = ?').get(node.id) as { attributes_json?: string } | undefined;
      try { return !!safeText(JSON.parse(row?.attributes_json || '{}').suggestedTranslation, 120); } catch { return false; }
    }).length;
    store.appendEvent(projectId, runId, 'context-graph.output-audit', outputAudit);
    store.appendEvent(projectId, runId, 'context-graph.completed', {
      sampleCount: samples.length,
      chapterCount: chapters.length,
      characterCount: persistedNodes.filter((node) => node.kind === 'character').length,
      entityCount: persistedNodes.filter((node) => node.kind === 'entity').length,
      relationshipCount: savedEdges.size,
      canonicalNameMappingCount,
      invalidEvidenceCount,
      invalidEvidenceByReason,
      invalidEvidenceByCategory,
      modelCandidateCounts: outputAudit.rawCounts,
      droppedCandidateCounts: outputAudit.persistedCounts,
      sourceLang, targetLang,
      strategy,
      workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
      workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
      styleRepairUsed, styleFieldCoverage, styleRuleCount, styleAvoidCount, styleEvidenceCount,
      ...(strategy === 'B' ? {
        completedStages: CONTEXT_GRAPH_WORKFLOW_STAGES.map((stage) => stage.id),
        stageResults: readRunProgress(db, runId).stageResults || [],
      } : {}),
      analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original analysis error */ }
    throw error;
  }
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
