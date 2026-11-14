/**
 * Run 生命周期：预检、波次调度、审校排空、上下文记忆并入与最终结账。
 *
 * 批次内部的翻译与审校在 translationRunBatch 中完成；这里只决定「哪些批次、以多大并发、
 * 在什么时候跑」，以及 Run 结束时如何一次性提交记忆与状态。
 */
import { getCodeBuddyTaskProfile, resolveEffectiveTaskModel } from '../agents/taskProfiles.ts';
import { summarizeTurnUsage } from '../agents/usage.ts';
import { REVIEW_TIMEOUT_MS, WORKBUDDY_POOL_SIZE } from '../config.ts';
import { parseAgentModel } from '../json.ts';
import { logError, logInfo, logWarn, summarizeError } from '../log.ts';
import { scheduleChineseEditorialProfileRefresh } from './chineseEditorialProfile.ts';
import {
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  getContextGraphStatus,
  startContextGraphAnalysis,
} from './contextGraph.ts';
import { normalizeDocumentTranslationStrategy, type DocumentTranslationStrategy } from './documentStrategy.ts';
import { sourceLanguageMatches } from './languageMatch.ts';
import { type DocumentProjectStore, getDocumentProjectStore } from './projectStore.ts';
import { mergeTranslationContextDeltasIntoMemory, type ValidatedTranslationContextDelta } from './translationContextDelta.ts';
import { runProjectQualityAudit } from './qualityAudit.ts';
import { createQualityRepairRun } from './qualityRepairRun.ts';
import {
  CONFIGURED_REVIEW_CONCURRENCY,
  CONFIGURED_REVIEW_DRAIN_CONCURRENCY,
  CONFIGURED_TRANSLATION_CONCURRENCY,
  createConcurrencyLimiter,
  resolveDocumentRunConcurrencyBudget,
  runWithConcurrency,
} from './translationConcurrency.ts';
import { type TranslationItem } from './translationSchema.ts';
import { buildBatches } from './translationBatchPlan.ts';
import { takeRunUsage } from './translationRunUsage.ts';
import { processBatch, type RunBatchScope } from './translationRunBatch.ts';
import { consolidateAcceptedRunNames, prepareRunNameDecisions } from './translationNameDecisions.ts';
/**
 * 就绪状态绑定到 Run 的不可变原文版本、分析版本与语言对。
 */
export function isContextGraphReadyForTranslationRun(
  graph: Record<string, any> | null | undefined,
  run: Record<string, any> | null | undefined,
): boolean {
  if (!graph || !run || graph.status !== 'completed') return false;
  const progress = graph.progress && typeof graph.progress === 'object' ? graph.progress : {};
  if (Number(progress.sampleCount || 0) <= 0) return false;
  if (progress.strategy !== 'A' && progress.strategy !== 'B') return false;
  // B 方案是带检查点的五阶段工作流。数据库里那行写着「已完成」还不够——
  // 只要缺任何一个必需阶段的检查点，就不能认（例如完成事件是过期或半恢复的）。
  if (progress.strategy === 'B') {
    const requiredStages = ['style', 'characters', 'entities', 'relationships', 'chapters'];
    const completedStages = Array.isArray(progress.completedStages) ? progress.completedStages : [];
    if (!requiredStages.every((stage) => completedStages.includes(stage))) return false;
  }
  return String(graph.sourceRevisionId || '') === String(run.sourceRevisionId || '') &&
    progress.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION &&
    sourceLanguageMatches(progress.sourceLang, run.sourceLang) &&
    String(progress.targetLang || 'zh') === String(run.targetLang || 'zh');
}

/**
 * 判断本次选定范围是否足够小，可以在没有全书图谱时直接使用片段级上下文翻译。
 * 小范围阈值刻意低于默认一个文学批次；它只绕过预处理等待，不改变原文/译文校验、
 * 规范译名保护、审校或记忆采纳规则。已有匹配版本的全书图谱仍优先复用。
 */
export function shouldUseLightweightLiteraryContext(
  segments: Array<{ text?: unknown }> | null | undefined,
  scopeType: unknown,
): boolean {
  if (scopeType !== 'ids') return false;
  const valid = (Array.isArray(segments) ? segments : [])
    .filter((segment) => typeof segment?.text === 'string' && segment.text.trim().length > 0);
  if (!valid.length || valid.length > 12) return false;
  const sourceChars = valid.reduce((total, segment) => total + String(segment.text).length, 0);
  return sourceChars <= 6_000;
}

/**
 * 文学模式下阻塞等待全书预处理（Context Graph）就绪；非文学模式直接通过。
 * @returns true 表示已就绪可继续翻译，false 表示 Run 已终止/取消
 */
export async function ensureLiteraryPreprocessingBeforeRun(
  projectId: string,
  runId: string,
  run: Record<string, any>,
): Promise<boolean> {
  if (run.translationMode !== 'literary') return true;
  const store = getDocumentProjectStore();
  const deadline = Date.now() + 45 * 60 * 1000;
  let analysisAttempts = 0;
  store.appendEvent(projectId, runId, 'context-graph.gate.waiting', {
    sourceRevisionId: run.sourceRevisionId,
    sourceLang: run.sourceLang || 'auto',
    targetLang: run.targetLang || 'zh',
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    owner: 'local-agent-service',
  });

  while (Date.now() < deadline) {
    const runStatus = store.getRunStatus(projectId, runId);
    if (['cancelled', 'paused', 'completed', 'failed', 'awaiting_acceptance'].includes(String(runStatus))) {
      store.appendEvent(projectId, runId, 'context-graph.gate.stopped', { runStatus });
      return false;
    }
    const graph = getContextGraphStatus(projectId);
    if (isContextGraphReadyForTranslationRun(graph, run)) {
      store.appendEvent(projectId, runId, 'context-graph.gate.ready', {
        contextGraphRunId: graph.runId || null,
        sourceRevisionId: graph.sourceRevisionId,
        analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
      });
      return true;
    }
    const status = String(graph.status || 'not-started');
    // 已经有全书分析在跑时不与它争用项目图谱；否则，小选段无需为等待完整
    // 全书人物/关系/风格提取而阻塞。当前片段、前文与已确认译名仍会进入 Brief。
    if (!['queued', 'running'].includes(status)) {
      const currentSourceRevisionId = store.getProjectContext(projectId).currentSourceRevisionId;
      if (String(currentSourceRevisionId || '') !== String(run.sourceRevisionId || '')) {
        throw new Error('翻译 Run 绑定的原文版本已不是项目当前版本；为避免上下文与原文错配，本轮不会启动。请基于当前原文新建 Run。');
      }
      const runScopeType = (run.scope && typeof run.scope === 'object') ? run.scope.type : undefined;
      const selectedIds = store.getRunSegmentIds(projectId, runId);
      // 只允许用户明确传入的 ids 小选段；all/failed/stale/chapter 即使剩余待译片段很少，
      // 也不能因为 pending 数量偶然变小而绕过全书上下文。
      if (runScopeType === 'ids' && selectedIds.length > 0 && selectedIds.length <= 12) {
        const db = store.getProjectContext(projectId).db;
        const placeholders = selectedIds.map(() => '?').join(',');
        const selectedSource = db.prepare(
          'SELECT text FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' + placeholders + ')',
        ).all(run.sourceRevisionId, ...selectedIds) as Array<{ text: string }>;
        if (selectedSource.length === selectedIds.length &&
            shouldUseLightweightLiteraryContext(selectedSource, runScopeType)) {
          const sourceChars = selectedSource.reduce((total, item) => total + String(item.text || '').length, 0);
          store.appendEvent(projectId, runId, 'context-graph.gate.skipped', {
            reason: 'small-selected-scope-uses-local-context',
            sourceRevisionId: run.sourceRevisionId,
            segmentCount: selectedSource.length,
            sourceChars,
          limits: { maxSegments: 12, maxSourceChars: 6000 },
          note: 'No full-book graph was ready; translation continues with current segments, preceding context and confirmed memory only.',
        });
        return true;
      }
    }
    if (String(graph.sourceRevisionId || '') !== String(run.sourceRevisionId || '')) {
      throw new Error('翻译 Run 绑定的原文版本已不是项目当前版本；为避免上下文与原文错配，本轮不会启动。请基于当前原文新建 Run。');
    }
    if (!['queued', 'running'].includes(status)) {
      if (analysisAttempts >= 2) {
        const missingStyle = Array.isArray(graph.styleMissingFields) ? graph.styleMissingFields : [];
        const progress = graph.progress && typeof graph.progress === 'object' ? graph.progress : {};
        const requiredStages = ['style', 'characters', 'entities', 'relationships', 'chapters'];
        const completedStages = Array.isArray(progress.completedStages) ? progress.completedStages : [];
        const missingStages = progress.strategy === 'B'
          ? requiredStages.filter((stage) => !completedStages.includes(stage))
          : [];
        const details = [
          missingStyle.length ? '文风字段缺失：' + missingStyle.join('、') : '',
          missingStages.length ? '未完成阶段：' + missingStages.join('、') : '',
          graph.error ? String(graph.error) : '',
        ].filter(Boolean);
        store.appendEvent(projectId, runId, 'context-graph.gate.incomplete', {
          status, missingStyleFields: missingStyle, missingStages, error: graph.error || null,
        });
        throw new Error('全书预处理未能形成完整可用的上下文，正式翻译未启动。最后状态：' +
          status + (details.length ? '；' + details.join('；') : '；请查看 Context Graph 执行轨迹并重新分析。'));
      }
      const started = startContextGraphAnalysis(projectId, { ignoreQueuedRunId: runId });
      analysisAttempts += 1;
      store.appendEvent(projectId, runId, 'context-graph.auto-started', {
        contextGraphRunId: started.runId, analysisAttempt: analysisAttempts,
        alreadyRunning: started.alreadyRunning, sourceRevisionId: graph.sourceRevisionId,
        sourceLang: run.sourceLang || 'auto', targetLang: run.targetLang || 'zh',
        analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('等待服务端全书预处理超过 45 分钟；Run 已停止在预处理阶段，未开始翻译。可在文档工作区查看 Context Graph 状态后恢复 Run。');
}

/**
 * Run 执行的准备阶段：校验终态、确认全书预处理就绪、固定批次与并发预算，
 * 并把 plan.ready / run.context.ready 写进事件流。
 *
 * 返回 null 表示这次运行不该继续（已进入终态、预处理未就绪、或没有待译片段）。
 * 抽出后 executeRun 只剩「执行批次 → 收尾」两段，准备规则的改动不再和批处理纠缠。
 */
export async function prepareRunExecution(
  store: DocumentProjectStore,
  projectId: string,
  runId: string,
): Promise<PreparedRunExecution | null> {
  const context = store.getRunContext(projectId, runId);
  if (!context.prompt) throw new Error('找不到本次运行使用的 Prompt 版本');
  const initialStatus = context.run.status;
  if (initialStatus === 'completed' || initialStatus === 'cancelled' || initialStatus === 'awaiting_acceptance') return null;

  // 全书分析与证据归服务端所有；扩展只负责提交 Run 和渲染状态。
  if (!(await ensureLiteraryPreprocessingBeforeRun(projectId, runId, context.run as Record<string, any>))) return null;

  if (!store.setRunStatus(projectId, runId, 'running', null) ||
      store.getRunStatus(projectId, runId) !== 'running') {
    store.appendEvent(projectId, runId, 'run.start-discarded', {
      reason: 'Run entered a terminal state before the execution worker acquired it',
    });
    return null;
  }
  store.appendEvent(projectId, runId, 'stage.started', { stage: 'translate', label: '开始翻译' });

  const items = store.getRunSegmentsForExecution(projectId, runId) as TranslationItem[];
  if (!items.length) {
    store.finishRun(projectId, runId);
    return null;
  }
  // 同一 Run 在发出第一批翻译请求前固定规范译名决议；并行批次只读这份快照。
  if (context.run.translationMode === 'literary') {
    context.runNameDecisions = prepareRunNameDecisions(store, projectId, runId, context);
  }
  const strategy = normalizeDocumentTranslationStrategy(context.prompt?.config?.translationStrategy);
  const batches = buildBatches(items, context.run.translationMode === 'literary', strategy);

  // 审校强度只在文学模式下有意义；技术模式本来就不审校。
  const reviewStrength = context.run.translationMode === 'literary' && context.run.reviewEnabled
    ? strategy.reviewStrength
    : 'off' as const;
  const reviewEnabled = reviewStrength !== 'off';
  // 只有 strong/medium 会真的发模型请求；weak 是纯本地确定性检查，不该占会话槽位。
  const modelReviewEnabled = reviewStrength === 'strong' || reviewStrength === 'medium';
  const { poolSize, translationConcurrency, reviewConcurrency, detachReviews } =
    resolveDocumentRunConcurrencyBudget(
      WORKBUDDY_POOL_SIZE,
      modelReviewEnabled,
      Math.min(strategy.translationConcurrency, CONFIGURED_TRANSLATION_CONCURRENCY),
      // 审校并行度一律尊重用户配置（strong/medium 都是真的发模型请求）。
      // 这里曾经对 medium 硬编码 1，把项目配置的 2 和 env 的 4 全部覆盖掉，
      // 结果是 4 个审校批次排队跑完 332s，占整个 run 的 86%。
      reviewStrength === 'weak'
        ? 1
        : Math.min(strategy.reviewConcurrency, CONFIGURED_REVIEW_CONCURRENCY),
    );
  // 翻译排空后审校可以独占整个会话池：strategy.reviewConcurrency 和
  // LOCAL_AGENT_DOCUMENT_REVIEW_CONCURRENCY 表达的都是「翻译还在跑的时候给审校留几个槽」，
  // 不是审校吞吐的硬上限。翻译做完后所有槽位都空着，继续按翻译期的分配值排队纯属浪费。
  // 需要保留上限的机器可以设 LOCAL_AGENT_DOCUMENT_REVIEW_DRAIN_CONCURRENCY。
  const reviewDrainConcurrency = Math.min(poolSize, CONFIGURED_REVIEW_DRAIN_CONCURRENCY);
  // run 起点：日志里必须能看出这一次 Run 是哪一个项目、哪个范围、多少段、多少批、
  // 用什么并发和审校强度。缺了这些，"为什么慢/为什么没跑"只能去翻 DB。
  logInfo('document-agent', 'run started · project=' + projectId + ' · run=' + runId +
    ' · mode=' + context.run.translationMode +
    ' · scope=' + JSON.stringify(context.run.scope || {}) +
    ' · segments=' + items.length +
    ' · batches=' + batches.length +
    ' · translateConcurrency=' + translationConcurrency +
    ' · reviewStrength=' + reviewStrength +
    ' · reviewConcurrency=' + reviewConcurrency +
    ' · reviewDrainConcurrency=' + (modelReviewEnabled ? reviewDrainConcurrency : 0) +
    ' · provider=' + context.run.provider +
    ' · model=' + resolveEffectiveTaskModel(
      parseAgentModel(context.run.model || 'auto', context.run.provider || 'workbuddy').model,
      getCodeBuddyTaskProfile(context.prompt.config || {}, 'translation'),
    ) +
    ' · reviewModel=' + resolveEffectiveTaskModel(
      parseAgentModel(context.run.model || 'auto', context.run.provider || 'workbuddy').model,
      getCodeBuddyTaskProfile(context.prompt.config || {},
        reviewStrength === 'strong' ? 'styleReview' : 'accuracyReview'),
    ));
  store.appendEvent(projectId, runId, 'plan.ready', {
    batchCount: batches.length,
    segmentCount: items.length,
    strategy: 'bounded-parallel',
    translationConcurrency,
    reviewConcurrency,
    reviewDrainConcurrency: modelReviewEnabled ? reviewDrainConcurrency : 0,
    reviewStrength,
    reviewModelCallsPerBatch: reviewStrength === 'strong' ? 2 : reviewStrength === 'medium' ? 1 : 0,
    poolSize,
    reviewTimeoutMs: reviewEnabled ? REVIEW_TIMEOUT_MS : 0,
    maxBatchSegments: strategy.maxBatchSegments,
    maxBatchSourceChars: strategy.maxBatchSourceChars,
    precedingContextSegments: strategy.precedingContextSegments,
    contextBudgetChars: strategy.contextBudgetChars,
    maxModelAttempts: strategy.maxModelAttempts,
    sessionStrategy: 'independent-per-batch',
  });
  const memory = context.memory && typeof context.memory === 'object' ? context.memory as Record<string, any> : {};
  const configuredGlossary = context.prompt.config?.glossary as any;
  const glossaryTerms = Array.isArray(configuredGlossary?.document_terms)
    ? configuredGlossary.document_terms.length : 0;
  store.appendEvent(projectId, runId, 'run.context.ready', {
    provider: context.run.provider,
    model: context.run.model,
    // 「请求的模型」和「实际生效的模型」经常不同（池默认 auto → glm-5.3-flash，
    // 任务配置却是 deepseek-v4.1-flash）。只写 context.run.model 会让审计账本说谎。
    effectiveModel: resolveEffectiveTaskModel(
      parseAgentModel(context.run.model || 'auto', context.run.provider || 'workbuddy').model,
      getCodeBuddyTaskProfile(context.prompt.config || {}, 'translation'),
    ),
    effectiveReviewModel: resolveEffectiveTaskModel(
      parseAgentModel(context.run.model || 'auto', context.run.provider || 'workbuddy').model,
      getCodeBuddyTaskProfile(context.prompt.config || {},
        reviewStrength === 'strong' ? 'styleReview' : 'accuracyReview'),
    ),
    translationMode: context.run.translationMode,
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    reviewEnabled,
    reviewStrength,
    promptRevisionId: context.run.promptRevisionId,
    memoryRevisionId: context.memoryRevisionId || null,
    systemPromptChars: typeof context.prompt.systemPrompt === 'string' ? context.prompt.systemPrompt.length : 0,
    userPromptTemplateChars: typeof context.prompt.userPromptTemplate === 'string' ? context.prompt.userPromptTemplate.length : 0,
    glossaryTerms,
    memoryEntities: Array.isArray(memory.entities) ? memory.entities.length : 0,
    confirmedEntities: Array.isArray(memory.entities) ? memory.entities.filter((item: any) => item?.reviewStatus === 'confirmed').length : 0,
    memoryRelationships: Array.isArray(memory.relationships) ? memory.relationships.length : 0,
    chapterSummaries: Array.isArray(memory.chapterSummaries) ? memory.chapterSummaries.length : 0,
    characterVoices: Array.isArray(memory.characterVoices) ? memory.characterVoices.length : 0,
    confirmedCharacterVoices: Array.isArray(memory.characterVoices) ? memory.characterVoices.filter((item: any) => item?.status === 'confirmed').length : 0,
    relationshipVoiceRules: Array.isArray(memory.relationshipVoiceRules) ? memory.relationshipVoiceRules.length : 0,
    voiceAnchors: Array.isArray(memory.voiceAnchors) ? memory.voiceAnchors.length : 0,
    promptFingerprint: context.prompt.fingerprint || null,
  });

  const reviewLimiter = createConcurrencyLimiter(reviewConcurrency);
  const reviewTasks: Promise<void>[] = [];
  return {
    context, items, batches, strategy, reviewStrength, reviewEnabled, modelReviewEnabled,
    poolSize, translationConcurrency, reviewConcurrency, detachReviews, reviewDrainConcurrency,
    reviewLimiter, reviewTasks,
  };
}

/** 准备阶段产出：后续批处理直接消费，不再回读数据库。 */
export interface PreparedRunExecution {
  context: ReturnType<DocumentProjectStore['getRunContext']>;
  items: TranslationItem[];
  batches: TranslationItem[][];
  strategy: DocumentTranslationStrategy;
  reviewStrength: 'strong' | 'medium' | 'weak' | 'off';
  reviewEnabled: boolean;
  modelReviewEnabled: boolean;
  poolSize: number;
  translationConcurrency: number;
  reviewConcurrency: number;
  detachReviews: boolean;
  reviewDrainConcurrency: number;
  reviewLimiter: ReturnType<typeof createConcurrencyLimiter>;
  reviewTasks: Promise<void>[];
}

/**
 * Run 执行的收尾阶段：终结 Run、自动采纳候选、写 run.finished 事件，并触发全书质量审计。
 *
 * 从 executeRun 抽出：这一段只在所有批次结束后执行一次，和批处理没有共享状态，
 * 单独成函数后收尾策略（自动采纳、自动补译范围）可以独立阅读与调整。
 */
export function finalizeRunExecution(
  store: DocumentProjectStore,
  projectId: string,
  runId: string,
  context: ReturnType<DocumentProjectStore['getRunContext']>,
  runStartedAt: number,
): void {
  let finishedRun = store.finishRun(projectId, runId);

  // 候选采纳属于服务端 Run 的最终化，不依赖浏览器工作区保持打开。
  // Store 的事务仍会检查来源版本与更新过的人工修订，不允许自动采纳覆盖人工版本。
  if (finishedRun.status === 'awaiting_acceptance' && Number(finishedRun.counts?.candidate || 0) > 0) {
    try {
      finishedRun = autoAcceptFinishedRunCandidates(projectId, runId);
      store.appendEvent(projectId, runId, 'translations.auto-accepted', {
        acceptedCount: Number(finishedRun.counts?.accepted || 0),
        remainingCandidateCount: Number(finishedRun.counts?.candidate || 0),
        preservedManualCount: Number(finishedRun.counts?.manualPreserved || 0),
        policy: 'validated-finalization; manual-edits-and-source-hashes-protected',
      });
    } catch (acceptError) {
      // 译文候选会持久保留，扩展的恢复流程可以用同一个幂等操作重试。
      store.appendEvent(projectId, runId, 'stage.warning', {
        stage: 'acceptance',
        warning: '服务端自动采纳未完成，候选已保留供恢复：' +
          (acceptError instanceof Error ? acceptError.message : String(acceptError)),
      });
    }
  }

  // 长期记忆只吸收最终采纳译文能支撑的增量。初译/Reviewer 的临时输出不能直接污染项目记忆。
  if (context.run.translationMode === 'literary' && ['completed', 'partial'].includes(String(finishedRun.status))) {
    commitRunContextMemory(store, projectId, runId, context);
  }

  // 只在候选已采纳后回校命名记忆；审计/记忆失败不能撤销已经落盘的译文。
  if (context.run.translationMode === 'literary' && ['completed', 'partial'].includes(String(finishedRun.status))) {
    try {
      consolidateAcceptedRunNames(store, projectId, runId, context);
    } catch (consolidationError) {
      store.appendEvent(projectId, runId, 'stage.warning', {
        stage: 'translation-naming-consolidation',
        warning: '译文已完成，但规范译名记忆回校失败：' +
          (consolidationError instanceof Error ? consolidationError.message : String(consolidationError)),
      });
    }
  }

  const finishedUsage = summarizeTurnUsage(takeRunUsage(runId));
  store.appendEvent(projectId, runId, 'run.finished', {
    status: finishedRun.status,
    counts: finishedRun.counts || {},
    error: finishedRun.error || null,
    // 本运行累计 token 消耗（仅初译模型调用；审校/预处理各自有 model.usage 事件）。
    usage: finishedUsage,
  });
  // run 级终点必须在文件日志里也留一行：只写 project_events 时，日志里看不出
  // 「哪一次 run 结束了、结果如何」，排查只能靠打开项目 DB。
  // summarizeTurnUsage 返回对象，直接字符串拼接会得到 "[object Object]"，
  // 于是 run 级 token/成本/轮次在日志里全部丢失（这一行原本就是为回答"花了多少"加的）。
  const finishedLine = 'run finished · project=' + projectId + ' · run=' + runId +
    ' · status=' + finishedRun.status +
    ' · counts=' + JSON.stringify(finishedRun.counts || {}) +
    ' · wall=' + Math.round((Date.now() - runStartedAt) / 1000) + 's' +
    ' · usage=' + (finishedUsage ? JSON.stringify(finishedUsage) : '未计量') +
    (finishedRun.error ? ' · error=' + summarizeError(finishedRun.error) : '');
  if (['failed', 'cancelled'].includes(String(finishedRun.status))) logWarn('document-agent', finishedLine);
  else logInfo('document-agent', finishedLine);
  if (['completed', 'partial'].includes(finishedRun.status)) {
    scheduleChineseEditorialProfileRefresh(projectId, runId);
  }

  // 完整/部分运行结束后仍执行全书质量审计；但自动补译只允许覆盖父 Run 实际包含的片段，最多一轮。
  // 局部 Run 不得因全书其它位置缺译而扩大执行范围；启发式英文残留、数字差异、重复表达和规范名冲突
  // 留给有界 Reviewer/非阻塞报告处理。
  if (['completed', 'partial'].includes(finishedRun.status)) {
    try {
      const audit = runProjectQualityAudit(projectId);
      const automationScope = (context.run.scope && typeof context.run.scope === 'object')
        ? (context.run.scope as Record<string, any>).automation : undefined;
      const isAutomaticRepairPass = automationScope?.kind === 'quality-audit-repair' &&
        Number(automationScope.pass) >= 1;

      // 全书级审计在任何 Run 之后做都有意义，但它报出的「缺译文」发现
      // 绝不能把一个按片段/按章/过期范围选的 Run 悄悄扩大成整本翻译。
      // 用不可变的 run_segments 成员关系，而不是重新评估当前范围。
      const parentRunSegmentIds = new Set(store.getRunSegmentIds(projectId, runId));
      const allMissingFindings = (Array.isArray(audit.findings) ? audit.findings : [])
        .filter((finding: any) => finding.type === 'missing-translation' && finding.repairable === true);
      const inScopeMissingFindings = allMissingFindings.filter((finding: any) =>
        Array.isArray(finding.segmentIds) &&
        finding.segmentIds.some((segmentId: unknown) => parentRunSegmentIds.has(String(segmentId))),
      );
      const missingFindings = !isAutomaticRepairPass ? inScopeMissingFindings.slice(0, 100) : [];
      if (missingFindings.length) {
        const repair = createQualityRepairRun(
          projectId,
          String(audit.auditId),
          missingFindings.map((finding: any) => String(finding.findingId)),
          [],
          { automatic: true, parentRunId: runId },
        );
        store.appendEvent(projectId, runId, 'quality-audit.auto-repair-scheduled', {
          auditId: audit.auditId,
          repairRunId: repair.run.runId,
          segmentCount: repair.segmentIds.length,
          maximumAutomaticPasses: 1,
          findingType: 'missing-translation',
          parentRunScopeSegmentCount: parentRunSegmentIds.size,
          inScopeMissingTranslationCount: inScopeMissingFindings.length,
          outOfScopeMissingTranslationCount: allMissingFindings.length - inScopeMissingFindings.length,
          scopePolicy: 'automatic-repair-is-restricted-to-parent-run-segments',
        });
        startProjectTranslationRun(projectId, repair.run.runId);
      } else {
        store.appendEvent(projectId, runId, 'quality-audit.auto-disposition', {
          auditId: audit.auditId,
          findingCount: Array.isArray(audit.findings) ? audit.findings.length : 0,
          inScopeMissingTranslationCount: inScopeMissingFindings.length,
          outOfScopeMissingTranslationCount: allMissingFindings.length - inScopeMissingFindings.length,
          automaticRepairSkipped: isAutomaticRepairPass
            ? 'automatic-repair-pass-limit'
            : inScopeMissingFindings.length
              ? 'automatic-repair-batch-limit-reached'
              : allMissingFindings.length
                ? 'no-in-scope-missing-translation'
                : 'no-deterministic-missing-translation',
          remainingFindingsAreNonBlocking: true,
        });
      }
    } catch (auditError) {
      // 质量审计只是一层额外兜底：它绝不能把已经落库的译文变成一次失败的 Run。
      try {
        store.appendEvent(projectId, runId, 'stage.warning', {
          stage: 'quality-audit',
          warning: '译文已保存，但自动全书审计未完成：' +
            (auditError instanceof Error ? auditError.message : String(auditError)),
        });
      } catch {
        logWarn('document-agent', 'automatic quality audit failed and warning could not be persisted');
      }
    }
  }
}

/**
 * 服务端 Run 最终化：将等待采纳的候选走 Store 的同一受保护事务。
 * 不重写人工结果；仅当 Run 已终结且确实存在候选时执行。可幂等重入。
 */
export function autoAcceptFinishedRunCandidates(projectId: string, runId: string): any {
  const store = getDocumentProjectStore();
  const run = store.getRun(projectId, runId);
  if (run.status !== 'awaiting_acceptance' || Number(run.counts?.candidate || 0) <= 0) return run;
  return store.acceptCandidates(projectId, runId);
}

/**
 * 在 HTTP 请求之外启动后台执行。
 * Run 必须已由 Store 持久化；activeRuns 只做当前进程内的重复启动保护，不是恢复状态的事实来源。
 * 服务重启后的恢复/重试必须读取 SQLite 中的 Run 与 segment 状态。
 */
export function startProjectTranslationRun(projectId: string, runId: string): { accepted: boolean; alreadyRunning: boolean } {
  if (activeRuns.has(runId)) return { accepted: true, alreadyRunning: true };
  activeRuns.add(runId);
  void executeRun(projectId, runId).finally(() => activeRuns.delete(runId));
  return { accepted: true, alreadyRunning: false };
}

/** 判断某 Run 是否在当前进程内处于活跃执行状态。 */
export function isProjectRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** 当前进程内正在执行的 Run。只做重复启动保护，不是恢复状态的事实来源。 */
export const activeRuns = new Set<string>();

/**
 * Run 级工作流协调器，是翻译生命周期的主要编排入口。
 * 负责读取固定版本、规划批次与并发预算、在每批次的模型调用/审校/持久化之间推进，
 * 并将暂停、取消、部分失败和终态反映到 SQLite。所有模型返回后的写入都必须重新检查 Run 状态。
 */
async function executeRun(projectId: string, runId: string): Promise<void> {
  const store = getDocumentProjectStore();
  const runStartedAt = Date.now();
  try {
    const prepared = await prepareRunExecution(store, projectId, runId);
    if (!prepared) return;
    const scope: RunBatchScope = {
      store,
      projectId,
      runId,
      strategy: prepared.strategy,
      batches: prepared.batches,
      reviewStrength: prepared.reviewStrength,
      detachReviews: prepared.detachReviews,
      reviewLimiter: prepared.reviewLimiter,
      reviewTasks: prepared.reviewTasks,
    };

    const schedulerError = await scheduleTranslationWaves(scope, prepared.context, prepared.translationConcurrency);
    await drainAndSettleReviews(scope, prepared, runStartedAt, schedulerError);

    const finalStatus = store.getRunStatus(projectId, runId);
    if (finalStatus === 'cancelled' || finalStatus === 'paused') return;

    store.appendEvent(projectId, runId, 'stage.completed', {
      stage: 'validate',
      label: '结果结构与片段映射检查完成',
    });
    // 长期记忆在最终采纳之后提交；初译阶段的 context_delta 仍只在 Run 内供后续波次参考。
    finalizeRunExecution(store, projectId, runId, prepared.context, runStartedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const status = store.getRunStatus(projectId, runId);
      // 用户已明确取消之后才到的异常，不能把 cancelled 的 Run 变成 failed，
      // 也不能覆盖给它看的取消原因。
      if (status !== 'cancelled' && status !== 'paused') {
        // 致命的持久化/调度错误不能把片段卡在 running；标成失败之后，
        // 才能通过 getRunSegmentsForExecution 显式重试或续跑。
        const run = store.getRun(projectId, runId);
        const stuckIds = (run.segments || [])
          .filter((item: any) => item.status === 'running')
          .map((item: any) => item.id);
        if (stuckIds.length) store.markRunSegments(projectId, runId, stuckIds, 'failed', message);
        store.setRunStatus(projectId, runId, 'failed', message);
        store.appendEvent(projectId, runId, 'run.failed', {
          error: message,
          // 失败也要清账：把已发生的 token 消耗随失败事件透出，避免累加到下一次重试。
          usage: summarizeTurnUsage(takeRunUsage(runId)),
        });
      }
    } catch (persistError) {
      logError('document-agent', 'failed to persist run failure · ' + (persistError instanceof Error ? persistError.message : String(persistError)));
    }
  }
}

/**
 * 按波次推进翻译。每一波冻结同一份上下文：当前波的候选不允许竞态地流入同波其他批次，
 * 只在全部结束后供下一波使用。
 *
 * 返回调度异常而不直接抛出——已排上的审校仍要先排空，才能给出正确的终结状态。
 */
async function scheduleTranslationWaves(
  scope: RunBatchScope,
  context: any,
  translationConcurrency: number,
): Promise<unknown> {
  const { store, projectId, runId, batches } = scope;
  const baseRunMemory = JSON.parse(JSON.stringify(context.memory || {}));
  try {
    const sourceDb = store.getProjectContext(projectId).db;
    const ordinalById = new Map<string, number>();
    const sourceOrdinals = sourceDb.prepare(
      'SELECT segment_id, ordinal FROM source_segments WHERE source_revision_id = ?'
    ).all(context.run.sourceRevisionId) as Array<{ segment_id: string; ordinal: number }>;
    for (const row of sourceOrdinals) ordinalById.set(row.segment_id, Number(row.ordinal));

    // 每一波最多 translationConcurrency 个批次并行。
    for (let offset = 0, waveIndex = 0; offset < batches.length; offset += translationConcurrency, waveIndex++) {
      const wave = batches.slice(offset, offset + translationConcurrency);
      const waveFirstOrdinal = Math.min(...wave.map((batch) => ordinalById.get(batch[0]?.id || '') ?? Number.MAX_SAFE_INTEGER));
      const priorDeltas = store.listTranslationContextDeltas(projectId, runId)
        .filter((item: any) => Number(item.firstOrdinal) < waveFirstOrdinal)
        .map((item: any) => item.delta as ValidatedTranslationContextDelta);
      const waveMemory = mergeTranslationContextDeltasIntoMemory(baseRunMemory, priorDeltas);
      const batchContext = {
        ...context,
        memory: waveMemory.memory,
        contextDeltaCount: priorDeltas.reduce((count: number, delta: any) =>
          count + (Array.isArray(delta?.entityCandidates) ? delta.entityCandidates.length : 0), 0),
      };
      store.appendEvent(projectId, runId, 'translation.context-wave.ready', {
        waveIndex: waveIndex + 1,
        batchCount: wave.length,
        firstSourceOrdinal: Number.isFinite(waveFirstOrdinal) ? waveFirstOrdinal : null,
        visiblePriorDeltaCount: priorDeltas.length,
        visibleCandidateCount: batchContext.contextDeltaCount,
        memoryEntityCount: Array.isArray(batchContext.memory?.entities) ? batchContext.memory.entities.length : 0,
        policy: 'freeze-within-wave; merge-in-source-order-between-waves',
      });
      await runWithConcurrency(
        wave,
        translationConcurrency,
        (batch, waveOffset) => processBatch(scope, batch, offset + waveOffset, batchContext),
        () => {
          const status = store.getRunStatus(projectId, runId);
          return status === 'cancelled' || status === 'paused';
        },
      );
      const status = store.getRunStatus(projectId, runId);
      if (status === 'cancelled' || status === 'paused') break;
    }
    return null;
  } catch (error) {
    // runWithConcurrency 会等所有翻译 worker 都结束，然后才把错误抛出来。
    return error;
  }
}

/**
 * 翻译排空后放开审校闸门，并等待全部已排审校结束。
 *
 * 翻译排空 = 会话池里再没有翻译占用。这一刻必须把审校闸门提到整个池子的宽度，
 * 否则剩下的审校仍然一个接一个跑，空闲槽位纯属浪费（实测占 run 的 74%）。
 */
async function drainAndSettleReviews(
  scope: RunBatchScope,
  prepared: PreparedRunExecution,
  runStartedAt: number,
  schedulerError: unknown,
): Promise<void> {
  const { store, projectId, runId, reviewLimiter, reviewTasks } = scope;
  const { modelReviewEnabled, reviewConcurrency, reviewDrainConcurrency } = prepared;
  const drainedAt = Date.now();
  const pendingReviews = reviewLimiter.pending();
  if (modelReviewEnabled && pendingReviews > 0 && reviewDrainConcurrency > reviewLimiter.getConcurrency()) {
    const applied = reviewLimiter.setConcurrency(reviewDrainConcurrency);
    store.appendEvent(projectId, runId, 'review.drain.expanded', {
      from: reviewConcurrency,
      to: applied,
      pendingReviews,
      translationWallMs: drainedAt - runStartedAt,
      policy: 'idle-pool-handover',
    });
    logInfo('document-agent', 'review drain · run=' + runId +
      ' · 翻译已排空 · 审校并发 ' + reviewConcurrency + ' → ' + applied +
      ' · 待审批次=' + pendingReviews +
      ' · translationWall=' + Math.round((drainedAt - runStartedAt) / 1000) + 's');
  }

  // 算终态之前要等所有已拆出去的审校结束。翻译和审校是重叠进行的，
  // 但只要有审校还在跑，这次 Run 就不能算完成。
  const reviewResults = await Promise.allSettled(reviewTasks);
  if (schedulerError) throw schedulerError;
  const failedReviewTask = reviewResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failedReviewTask) {
    store.appendEvent(projectId, runId, 'stage.warning', {
      stage: 'review',
      warning: '部分审校任务未完成：' + (failedReviewTask.reason instanceof Error
        ? failedReviewTask.reason.message : String(failedReviewTask.reason)),
    });
  }
}

/**
 * 只允许被当前原文版本、当前 source_hash 且已采纳的译文支撑的增量进入长期记忆。
 * 波次内仍可使用原始已校验 delta；这里是项目级持久化的第二道门。
 */
export function retainAcceptedEvidenceDeltas(
  db: any,
  sourceRevisionId: string,
  deltas: ValidatedTranslationContextDelta[],
): ValidatedTranslationContextDelta[] {
  const acceptedRows = db.prepare(
    'SELECT tr.segment_id AS segmentId, tr.translation_text AS translation, s.text AS sourceText ' +
    'FROM translation_results tr JOIN source_segments s ' +
    'ON s.source_revision_id = tr.source_revision_id AND s.segment_id = tr.segment_id ' +
    'WHERE tr.source_revision_id = ? AND tr.accepted = 1 AND tr.source_hash = s.source_hash ' +
    'ORDER BY COALESCE(tr.accepted_at, tr.created_at) DESC, tr.created_at DESC, tr.rowid DESC'
  ).all(sourceRevisionId) as Array<{ segmentId: string; translation: string; sourceText: string }>;
  const accepted = new Map<string, { segmentId: string; translation: string; sourceText: string }>();
  for (const row of acceptedRows) {
    if (!accepted.has(row.segmentId)) accepted.set(row.segmentId, row);
  }
  const isAcceptedEvidence = (item: any) => {
    const row = accepted.get(String(item?.segmentId || ''));
    const quote = String(item?.sourceQuote || '').normalize('NFKC').trim();
    return !!row && quote.length > 0 &&
      String(row.sourceText || '').normalize('NFKC').includes(quote);
  };
  const hasAcceptedEvidence = (evidence: any[]) =>
    (Array.isArray(evidence) ? evidence : []).some(isAcceptedEvidence);
  const output = deltas.map((delta) => {
    const entityMentions = (delta.entityMentions || []).filter((mention: any) => {
      const row = accepted.get(String(mention.segmentId || ''));
      const targetSurface = String(mention.targetSurface || '').normalize('NFKC').trim();
      return !!row && isAcceptedEvidence(mention) && targetSurface.length > 0 &&
        row.translation.normalize('NFKC').includes(targetSurface);
    });
    const acceptedMentions = new Set(entityMentions.map((mention: any) => String(mention.entityRef || '')));
    const entityCandidates = (delta.entityCandidates || []).filter((candidate: any) =>
      hasAcceptedEvidence(candidate.evidence) &&
      (acceptedMentions.has(String(candidate.localId || '')) ||
        (Array.isArray(candidate.evidence) && candidate.evidence.some((item: any) => {
          const row = accepted.get(String(item?.segmentId || ''));
          return !!row && !!candidate.targetProposal &&
            row.translation.normalize('NFKC').includes(String(candidate.targetProposal).normalize('NFKC'));
        }))));
    return {
      ...delta,
      entityCandidates,
      entityMentions: entityMentions.filter((mention: any) =>
        entityCandidates.some((candidate: any) => String(candidate.localId) === String(mention.entityRef)) ||
        entityCandidates.some((candidate: any) => String(candidate.canonicalSource) === String(mention.entityRef))),
      relationshipDeltas: (delta.relationshipDeltas || []).filter((item: any) => hasAcceptedEvidence(item.evidence)),
      openQuestions: (delta.openQuestions || []).filter((item: any) => hasAcceptedEvidence(item.evidence)),
      conflicts: (delta.conflicts || []).filter((item: any) => hasAcceptedEvidence(item.evidence)),
    };
  });
  return output;
}

/**
 * 把本轮 Run 的 context delta 并入项目文学记忆。
 *
 * 上下文记忆是译文的附属产物：并入失败只写警告，绝不把已经完成的翻译改成失败 Run。
 */
function commitRunContextMemory(
  store: DocumentProjectStore,
  projectId: string,
  runId: string,
  context: any,
): void {
  try {
    const db = store.getProjectContext(projectId).db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedRunStatus = store.getRunStatus(projectId, runId);
      if (!['completed', 'partial'].includes(String(lockedRunStatus))) {
        store.appendEvent(projectId, runId, 'translation.context-memory.skipped', {
          reason: 'run-not-successfully-finalized',
          runStatus: lockedRunStatus,
        });
      } else {
        const lockedProjectContext = store.getProjectContext(projectId);
        if (lockedProjectContext.currentSourceRevisionId !== context.run.sourceRevisionId) {
          store.appendEvent(projectId, runId, 'translation.context-memory.skipped', {
            reason: 'source-revision-changed',
            runSourceRevisionId: context.run.sourceRevisionId,
            currentSourceRevisionId: lockedProjectContext.currentSourceRevisionId,
            retainedInRunLedger: true,
          });
        } else {
          const rawRunDeltas = store.listTranslationContextDeltas(projectId, runId)
            .map((item: any) => item.delta as ValidatedTranslationContextDelta);
          const runDeltas = retainAcceptedEvidenceDeltas(db, context.run.sourceRevisionId, rawRunDeltas);
          const currentMemory = store.getCurrentLiteraryMemory(projectId);
          const merged = mergeTranslationContextDeltasIntoMemory(currentMemory.memory, runDeltas);
          if (merged.changed) {
            const saved = store.saveLiteraryMemory(projectId, merged.memory);
            store.appendEvent(projectId, runId, 'translation.context-memory.persisted', {
              memoryRevisionId: saved.memoryRevisionId,
              fingerprint: saved.fingerprint,
              sourceRevisionId: context.run.sourceRevisionId,
              deltaBatchCount: runDeltas.length,
              ...merged.summary,
              statusPolicy: 'validated model-default records are active; user decisions are never overwritten; target confidence remains evidence-scoped',
            });
          } else {
            store.appendEvent(projectId, runId, 'translation.context-memory.unchanged', {
              deltaBatchCount: runDeltas.length,
              reason: 'no-new-candidates-or-context-changes',
            });
          }
        }
      }
      db.exec('COMMIT');
    } catch (transactionError) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already have rolled back */ }
      throw transactionError;
    }
  } catch (memoryError) {
    // 上下文记忆只是翻译交付的补充。绝不能因为建议投影存不下去，
    // 就把一次已完成的翻译变成失败的 Run。
    store.appendEvent(projectId, runId, 'stage.warning', {
      stage: 'context-memory',
      warning: '译文已保存，但本轮人物/上下文候选未能并入项目记忆：' +
        (memoryError instanceof Error ? memoryError.message : String(memoryError)),
    });
  }
}
