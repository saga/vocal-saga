/**
 * 批次执行：初译、审校、候选落库。
 *
 * 这里只处理「一批片段从发出请求到候选入库」的完整过程，不负责 Run 生命周期、
 * 波次调度与最终结账。调度方通过 RunBatchScope 提供 Store、Run 身份与审校闸门，
 * 因此同一批代码可以在翻译并发内联执行，也可以被 detach 到审校任务队列里执行。
 */
import { REVIEW_TIMEOUT_MS } from '../config.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { logError, logInfo, logWarn, summarizeError } from '../log.ts';
import type { DocumentProjectStore } from './projectStore.ts';
import type { DocumentTranslationStrategy } from './documentStrategy.ts';
import { buildProjectVoiceContext } from './voiceContext.ts';
import type { TranslationBrief } from './translationBrief.ts';
import { buildTranslationBrief, summarizeTranslationBrief } from './translationBrief.ts';
import { combineTranslationContextDeltas, type ValidatedTranslationContextDelta } from './translationContextDelta.ts';
import type { TranslationItem } from './translationSchema.ts';
import { buildDocumentBatchSessionScope, type ConcurrencyLimiter } from './translationConcurrency.ts';
import { buildDeterministicBatchReview, isReviewWorthSending, resolveBilingualVerifiedChineseEdits, selectVerifiedStyleReviewCandidates } from './translationReviewPolicy.ts';
import { addRunUsage } from './translationRunUsage.ts';
import { translateBatch } from './translationBatchCall.ts';
import { runLiteraryReviewWithMissingRetry } from './translationLiteraryReview.ts';

/** 调度方为一批执行提供的外部依赖；所有字段在整个 Run 期间保持不变。 */
export interface RunBatchScope {
  store: DocumentProjectStore;
  projectId: string;
  runId: string;
  strategy: DocumentTranslationStrategy;
  batches: TranslationItem[][];
  reviewStrength: string;
  detachReviews: boolean;
  reviewLimiter: ConcurrencyLimiter;
  reviewTasks: Array<Promise<unknown>>;
}

/** 一批片段在审校阶段的共享状态；初译结果与候选集合在同一批内被反复读写。 */
interface BatchReviewState {
  batchContext: any;
  batchIndex: number;
  batch: TranslationItem[];
  reviewedItems: TranslationItem[];
  reviewTargets: TranslationItem[];
  translations: Map<string, string>;
  initialDrafts: Map<string, string>;
  chineseEditorialCandidateIds: Set<string>;
  precedingSegments: TranslationItem[];
  translationBrief: TranslationBrief | null;
  reviewVoiceContext: any;
  failedIds: string[];
  /** 中文单语编辑是否已作为预备阶段跑过；决定双语审校失败时是否补跑文风审校。 */
  styleReviewAttempted: boolean;
  /** 目标语为中文且强度为「强」时，文风审校先以单语编辑身份跑一轮。 */
  chineseMonolingualEdit: boolean;
}

/** 单批次翻译流程：构建 brief、有界重试、保存候选与 context delta、调度审校。 */
export async function processBatch(
  scope: RunBatchScope,
  batch: TranslationItem[],
  zeroBasedIndex: number,
  batchContext: any,
): Promise<void> {
  const { store, projectId, runId, batches } = scope;
  const batchIndex = zeroBasedIndex + 1;
  const status = store.getRunStatus(projectId, runId);
  if (status === 'cancelled' || status === 'paused') return;

  const batchIds = batch.map((item) => item.id);
  const precedingSegments = batchContext.run.translationMode === 'literary' && batch[0] && scope.strategy.precedingContextSegments > 0
    ? store.getPrecedingSegments(projectId, runId, batch[0].id, scope.strategy.precedingContextSegments) as TranslationItem[]
    : [];
  const translationBrief = batchContext.run.translationMode === 'literary'
    ? buildTranslationBrief(batchContext, batch, precedingSegments)
    : null;
  if (translationBrief) {
    const snapshotSaved = store.saveTranslationBriefSnapshot(
      projectId, runId, batchIndex, translationBrief as unknown as Record<string, any>,
    );
    if (!snapshotSaved) {
      store.appendEvent(projectId, runId, 'batch.discarded', {
        batchIndex, reason: 'Run left active state before TranslationBrief snapshot commit',
      });
      return;
    }
    store.appendEvent(projectId, runId, 'translation-brief.ready', {
      batchIndex, ...summarizeTranslationBrief(translationBrief),
    });
  }
  if (!store.markRunSegments(projectId, runId, batchIds, 'running')) {
    store.appendEvent(projectId, runId, 'batch.discarded', {
      batchIndex, reason: 'Run left active state before batch could be marked running',
    });
    return;
  }
  store.appendEvent(projectId, runId, 'batch.started', {
    batchIndex,
    batchCount: batches.length,
    chapter: batch[0]?.contextPath || batchContext.project.title,
    segmentIds: batchIds,
    precedingContextCount: precedingSegments.length,
    sessionStrategy: 'independent-per-batch',
  });

  const pending = new Map(batch.map((item) => [item.id, item]));
  const translations = new Map<string, string>();
  const contextDeltaParts: ValidatedTranslationContextDelta[] = [];

  // maxModelAttempts 是整个 batch 的模型调用总预算（包含首次调用），不是重试轮数。
  const attemptOutcome = await runModelAttempts(
    scope, batchContext, batchIndex, precedingSegments, translationBrief || undefined,
    pending, translations, contextDeltaParts,
  );
  if (attemptOutcome.cancelled) return;

  // Stop is checked again directly before persistence; no late model response may commit
  // after cancellation, even if the response arrived in the same turn as a retry failure.
  if (store.getRunStatus(projectId, runId) === 'cancelled') {
    store.appendEvent(projectId, runId, 'batch.discarded', {
      batchIndex, reason: 'cancelled before candidate commit',
    });
    return;
  }
  const candidatesCommitted = store.saveCandidates(
    projectId,
    runId,
    Array.from(translations, ([segmentId, text]) => ({ segmentId, text })),
  );
  if (!candidatesCommitted) {
    store.appendEvent(projectId, runId, 'batch.discarded', {
      batchIndex,
      reason: 'Run entered a non-active state before atomic candidate commit',
      candidateCount: translations.size,
    });
    return;
  }
  if (batchContext.run.translationMode === 'literary' && batch[0]) {
    saveBatchContextDelta(scope, batchIndex, batch[0].id, batchIds, contextDeltaParts);
  }
  if (pending.size > 0) {
    store.markRunSegments(projectId, runId, Array.from(pending.keys()), 'failed', attemptOutcome.lastError);
  }

  const failedIds = Array.from(pending.keys());
  if (failedIds.length) {
    // 批次失败只在文件日志里出现一次，就够定位「哪一批、哪些片段、什么原因」。
    logWarn('document-agent', 'batch failed · project=' + projectId + ' · run=' + runId +
      ' · batch=' + batchIndex + '/' + batches.length +
      ' · failed=' + failedIds.length + '/' + batch.length +
      ' · ids=' + failedIds.slice(0, 8).join(',') + (failedIds.length > 8 ? '…' : '') +
      ' · error=' + summarizeError(attemptOutcome.lastError));
  }
  const shouldReview = translations.size > 0 &&
    batchContext.run.translationMode === 'literary' &&
    batchContext.run.reviewEnabled;
  store.appendEvent(projectId, runId, 'batch.translation.completed', {
    batchIndex,
    batchCount: batches.length,
    candidateCount: translations.size,
    failedIds,
    reviewScheduled: shouldReview,
  });

  if (!shouldReview) {
    store.appendEvent(projectId, runId, 'batch.completed', {
      batchIndex, batchCount: batches.length, candidateCount: translations.size,
      failedIds, reviewCompleted: false,
    });
    return;
  }
  const job = () => runBatchReview(scope, {
    batchContext,
    batchIndex,
    batch,
    // 审校只覆盖本批真正拿到译文的片段；缺失片段在 failedIds 里单独上报。
    reviewedItems: batch.filter((item) => translations.has(item.id)),
    reviewTargets: [],
    translations,
    initialDrafts: new Map(batch.filter((item) => translations.has(item.id))
      .map((item) => [item.id, translations.get(item.id)!])),
    chineseEditorialCandidateIds: new Set<string>(),
    precedingSegments,
    translationBrief,
    reviewVoiceContext: null,
    failedIds,
    styleReviewAttempted: false,
    chineseMonolingualEdit: false,
  });
  if (scope.detachReviews) {
    // Do not await here: another translation batch can start while this review is in flight.
    scope.reviewTasks.push(scope.reviewLimiter(job));
  } else {
    // A one-slot session pool cannot overlap translation and review safely.
    await scope.reviewLimiter(job);
  }
}

/**
 * 单批的模型调用预算：首次调用按原 batch 请求，若响应不完整，只用剩余预算补齐全部缺失 ID，
 * 避免按 4 段切组突破调用上限。取消发生在任何一次调用前后都会立刻中止，不再发起下一次。
 */
async function runModelAttempts(
  scope: RunBatchScope,
  batchContext: any,
  batchIndex: number,
  precedingSegments: TranslationItem[],
  translationBrief: TranslationBrief | undefined,
  pending: Map<string, TranslationItem>,
  translations: Map<string, string>,
  contextDeltaParts: ValidatedTranslationContextDelta[],
): Promise<{ cancelled: boolean; lastError: string }> {
  const { store, projectId, runId } = scope;
  let lastError = '模型未返回完整的片段集合';
  for (let attempt = 0; attempt < scope.strategy.maxModelAttempts && pending.size > 0; attempt++) {
    if (store.getRunStatus(projectId, runId) === 'cancelled') {
      store.appendEvent(projectId, runId, 'batch.discarded', {
        batchIndex, reason: 'cancelled before model call',
      });
      return { cancelled: true, lastError };
    }
    const current = Array.from(pending.values());
    const currentGroups = current.length ? [current] : [];
    for (let groupIndex = 0; groupIndex < currentGroups.length; groupIndex++) {
      if (store.getRunStatus(projectId, runId) === 'cancelled') {
        store.appendEvent(projectId, runId, 'batch.discarded', {
          batchIndex, reason: 'cancelled before retry chunk', retryChunkIndex: groupIndex + 1,
        });
        return { cancelled: true, lastError };
      }
      const group = currentGroups[groupIndex]!;
      const callId = runId + '-b' + batchIndex + '-a' + attempt +
        (currentGroups.length > 1 ? '-r' + (groupIndex + 1) : '');
      try {
        const output = await translateBatch(
          batchContext, group, callId, batchIndex, precedingSegments, translationBrief,
        );
        if (store.getRunStatus(projectId, runId) === 'cancelled') {
          store.appendEvent(projectId, runId, 'batch.discarded', {
            batchIndex, reason: 'cancelled while model call was in flight',
          });
          return { cancelled: true, lastError };
        }
        for (const [id, translated] of output.translations) {
          translations.set(id, translated);
          pending.delete(id);
        }
        if (batchContext.run.translationMode === 'literary') contextDeltaParts.push(output.contextDelta);
        const groupMissing = group.filter((item) => pending.has(item.id)).map((item) => item.id);
        if (groupMissing.length) {
          lastError = '模型响应未返回全部片段；尚有 ' + pending.size + ' 段未完成';
          store.appendEvent(projectId, runId, 'batch.partial', {
            batchIndex, attempt: attempt + 1,
            retryChunkIndex: groupIndex + 1, retryChunkCount: currentGroups.length,
            requestedIds: group.map((item) => item.id),
            missingIds: groupMissing, remainingMissingCount: pending.size,
          });
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        store.appendEvent(projectId, runId, 'model.call.failed', {
          batchIndex, attempt: attempt + 1, retryChunkIndex: groupIndex + 1,
          retryChunkCount: currentGroups.length, requestedIds: group.map((item) => item.id),
          error: lastError,
        });
      }
    }
  }
  return { cancelled: false, lastError };
}

/** 上下文记忆属于初译的附属产物。即使其序列化/持久化失败，也不撤销前面成功保存的译文候选。 */
function saveBatchContextDelta(
  scope: RunBatchScope,
  batchIndex: number,
  firstSegmentId: string,
  batchIds: string[],
  contextDeltaParts: ValidatedTranslationContextDelta[],
): void {
  const { store, projectId, runId } = scope;
  const contextDelta = combineTranslationContextDeltas(contextDeltaParts);
  const validation = {
    modelAttempts: Math.max(1, contextDeltaParts.length),
    entityCandidateCount: contextDelta.entityCandidates.length,
    entityMentionCount: contextDelta.entityMentions.length,
    relationshipCount: contextDelta.relationshipDeltas.length,
    openQuestionCount: contextDelta.openQuestions.length,
    conflictCount: contextDelta.conflicts.length,
  };
  try {
    const deltaPersisted = store.saveTranslationContextDelta(
      projectId, runId, batchIndex, firstSegmentId, batchIds,
      contextDelta as unknown as Record<string, any>, validation,
    );
    if (deltaPersisted) {
      store.appendEvent(projectId, runId, 'translation.context-delta.saved', {
        batchIndex, firstSegmentId,
        sourceSegmentCount: batchIds.length,
        ...validation,
        availableToLaterWaves: true,
      });
    } else {
      store.appendEvent(projectId, runId, 'translation.context-delta.discarded', {
        batchIndex, firstSegmentId,
        reason: 'Run entered a non-active state before context-delta commit',
      });
    }
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    try {
      store.appendEvent(projectId, runId, 'stage.warning', {
        stage: 'context-delta', batchIndex,
        warning: '初译已保存，但本批人物/上下文增量未能持久化：' + warning,
      });
    } catch (eventError) {
      logWarn('document-agent', 'context-delta persistence failed · run=' + runId + ' batch=' + batchIndex + ' · ' + warning + ' · ' + (eventError instanceof Error ? eventError.message : String(eventError)));
    }
  }
}

async function runBatchReview(scope: RunBatchScope, state: BatchReviewState): Promise<void> {
  const { store, projectId, runId, batches } = scope;
  const { batchContext, batchIndex, batch, translations, failedIds } = state;
  if (store.getRunStatus(projectId, runId) === 'cancelled') {
    store.appendEvent(projectId, runId, 'review.discarded', {
      batchIndex, reason: 'cancelled before reviewer started',
    });
    return;
  }
  if (!state.reviewedItems.length) {
    store.appendEvent(projectId, runId, 'batch.completed', {
      batchIndex, batchCount: batches.length, candidateCount: translations.size,
      failedIds, reviewCompleted: true,
    });
    return;
  }

  // 「弱」档：不发模型请求，只做确定性检查，因此不占会话槽位、也不阻塞翻译。
  if (scope.reviewStrength === 'weak') {
    await runDeterministicReview(scope, state);
    return;
  }

  // 「中」档只把值得送审的片段交给模型；整批都不值得时一次调用都不发。
  state.reviewTargets = scope.reviewStrength === 'medium'
    ? state.reviewedItems.filter((item) => isReviewWorthSending(item))
    : state.reviewedItems;
  if (!state.reviewTargets.length) {
    store.appendEvent(projectId, runId, 'stage.skipped', {
      stage: 'review', batchIndex, reviewStrength: scope.reviewStrength,
      reason: '本批全部是短片段且无数字/对白/专名，合并审校的收益低于一次模型调用',
      skippedSegmentCount: state.reviewedItems.length,
    });
    store.appendEvent(projectId, runId, 'batch.completed', {
      batchIndex, batchCount: batches.length, candidateCount: translations.size,
      failedIds, reviewCompleted: true,
    });
    return;
  }

  store.appendEvent(projectId, runId, 'stage.started', {
    stage: 'review', batchIndex, timeoutMs: REVIEW_TIMEOUT_MS,
    reviewStrength: scope.reviewStrength,
    label: scope.reviewStrength === 'medium' ? '合并审校' : '文学审校',
  });
  const reviewStartedAt = Date.now();
  state.reviewVoiceContext = state.translationBrief?.voiceContext || buildProjectVoiceContext(
    batchContext.memory,
    state.reviewedItems.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
    batch[0]?.contextPath || batchContext.project.title,
    state.precedingSegments,
  );
  appendReviewContextEvent(scope, state);

  // 中文单语编辑是「强」档独有的预备阶段；「中」档把它并进合并审校的双语调用里。
  state.chineseMonolingualEdit = scope.reviewStrength === 'strong' &&
    /^zh(?:[-_]|$)/i.test(String(batchContext.run.targetLang || ''));
  // Chinese editing must happen before bilingual review: the latter verifies the edited
  // Chinese candidate against source. Other target languages retain their existing order.
  if (state.chineseMonolingualEdit) await runStyleReview(scope, state);

  // 审校中途被丢弃时，本批不发 batch.completed：Run 已离开活跃状态，终结事件由 Run 级流程负责。
  let settled = false;
  try {
    settled = await runBilingualReview(scope, state, reviewStartedAt);
  } catch (error) {
    // Review is a quality improvement, not a gate on translation progress.
    // 审校失败以前只写 project_events，文件日志里完全看不到；批次「跑完了但没审」时
    // 只能靠打开 DB 才知道。这里补一行，带上强度档位与失败原因。
    if (store.getRunStatus(projectId, runId) !== 'cancelled') {
      logWarn('document-agent', 'review failed · project=' + projectId + ' · run=' + runId +
        ' · batch=' + batchIndex + '/' + batches.length +
        ' · strength=' + scope.reviewStrength +
        ' · segments=' + state.reviewTargets.length +
        ' · durationMs=' + (Date.now() - reviewStartedAt) +
        ' · error=' + summarizeError(error));
    }
    try {
      // If bilingual review failed as a whole, discard all provisional Chinese-only edits.
      // The persisted first-pass candidates remain untouched and will be auto-finalized.
      restoreInitialDrafts(state);
      if (store.getRunStatus(projectId, runId) !== 'cancelled') {
        store.appendEvent(projectId, runId, 'stage.warning', {
          stage: 'review', batchIndex,
          warning: '审校失败，已保留有效初译，不影响本批翻译候选：' +
            (error instanceof Error ? error.message : String(error)),
          durationMs: Date.now() - reviewStartedAt,
        });
      }
    } catch (persistError) {
      logError('document-agent', 'failed to persist review warning · ' + (persistError instanceof Error ? persistError.message : String(persistError)));
    }
    if (!state.styleReviewAttempted && scope.reviewStrength === 'strong' && store.getRunStatus(projectId, runId) !== 'cancelled') {
      await runStyleReview(scope, state);
    }
    settled = true;
  }
  if (!settled) return;

  // batch.completed remains a terminal batch event, emitted only after review settles.
  if (store.getRunStatus(projectId, runId) !== 'cancelled') {
    store.appendEvent(projectId, runId, 'batch.completed', {
      batchIndex,
      batchCount: batches.length,
      candidateCount: translations.size,
      failedIds,
      reviewCompleted: true,
    });
  }
}

/** 「弱」档的确定性审校：不占会话槽位，只落 finding，不改候选。 */
async function runDeterministicReview(scope: RunBatchScope, state: BatchReviewState): Promise<void> {
  const { store, projectId, runId, batches } = scope;
  const { batchContext, batchIndex, translations, failedIds } = state;
  const deterministicStartedAt = Date.now();
  const deterministicFindings = buildDeterministicBatchReview({
    items: state.reviewedItems,
    translations,
    memory: batchContext.memory && typeof batchContext.memory === 'object' ? batchContext.memory : null,
    sourceLang: String(batchContext.run.sourceLang || 'en'),
    targetLang: String(batchContext.run.targetLang || 'zh'),
  });
  const findingsPersisted = deterministicFindings.length
    ? store.saveFindings(projectId, runId, deterministicFindings)
    : true;
  if (!findingsPersisted) {
    store.appendEvent(projectId, runId, 'review.discarded', {
      batchIndex, stage: 'deterministic-review',
      reason: 'Run left active state before deterministic finding commit',
      findingCount: deterministicFindings.length,
    });
    return;
  }
  store.appendEvent(projectId, runId, 'stage.completed', {
    stage: 'deterministic-review', batchIndex,
    reviewStrength: scope.reviewStrength, modelCalls: 0, findingCount: deterministicFindings.length,
    durationMs: Date.now() - deterministicStartedAt,
  });
  if (store.getRunStatus(projectId, runId) !== 'cancelled') {
    store.appendEvent(projectId, runId, 'batch.completed', {
      batchIndex, batchCount: batches.length, candidateCount: translations.size,
      failedIds, reviewCompleted: true,
    });
  }
}

/** 审校上下文规模的诊断事件：哪一路记忆被注入、注入了多少条。 */
function appendReviewContextEvent(scope: RunBatchScope, state: BatchReviewState): void {
  const { store, projectId, runId } = scope;
  const { batchContext, batchIndex, translationBrief, reviewVoiceContext } = state;
  const reviewCount = (value: unknown) => Array.isArray(value) ? value.length : 0;
  store.appendEvent(projectId, runId, 'review.batchContext.ready', {
    batchIndex, segmentCount: state.reviewedItems.length,
    precedingSegmentCount: state.precedingSegments.length,
    memoryRevisionId: batchContext.memoryRevisionId || null,
    injectedEntities: reviewCount(reviewVoiceContext.entities),
    injectedRelationships: reviewCount(reviewVoiceContext.relationships),
    injectedChapterSummaries: reviewCount(reviewVoiceContext.chapterSummaries),
    injectedCharacterVoices: reviewCount(reviewVoiceContext.characterVoices),
    injectedRelationshipVoiceRules: reviewCount(reviewVoiceContext.relationshipVoiceRules),
    injectedVoiceAnchors: reviewCount(reviewVoiceContext.voiceAnchors),
    contextPolicyVersion: reviewVoiceContext.policyVersion,
    translationBriefHash: translationBrief?.contextHash || null,
    translationBriefChars: translationBrief?.contextChars || 0,
    contextGraphIncluded: !!translationBrief?.contextGraph,
    contextGraphCharacters: reviewCount((translationBrief?.contextGraph as any)?.characters),
    contextGraphEntities: reviewCount((translationBrief?.contextGraph as any)?.entities),
    contextGraphRelationships: reviewCount((translationBrief?.contextGraph as any)?.relationships),
  });
}

/** 中文单语编辑 / 文风审校：失败只降级为警告，绝不撤销已入库的准确性译文。 */
async function runStyleReview(scope: RunBatchScope, state: BatchReviewState): Promise<void> {
  const { store, projectId, runId } = scope;
  const { batchContext, batchIndex, batch, reviewedItems, translations, initialDrafts, translationBrief } = state;
  if (scope.reviewStrength !== 'strong') return;
  if (store.getRunStatus(projectId, runId) === 'cancelled') return;
  state.styleReviewAttempted = true;
  const styleStartedAt = Date.now();
  const chineseMonolingualEdit = /^zh(?:[-_]|$)/i.test(String(batchContext.run.targetLang || ''));
  try {
    store.appendEvent(projectId, runId, 'stage.started', {
      stage: 'style-review', batchIndex, timeoutMs: REVIEW_TIMEOUT_MS,
      label: chineseMonolingualEdit ? '中文单语文学编辑' : '人物声音与文风审校',
    });
    const styleScope = buildDocumentBatchSessionScope({
      projectId,
      runId: runId + '-style',
      promptRevisionId: batchContext.run.promptRevisionId,
      role: 'review',
      batchIndex,
      translationMode: batchContext.run.translationMode,
      memoryRevisionId: batchContext.memoryRevisionId || 'no-memory',
    });
    const styleReview = await runLiteraryReviewWithMissingRetry({
      projectId, runId,
      reviewType: 'style',
      taskProfiles: batchContext.prompt.config?.taskProfiles || {},
      chapterTitle: batch[0]?.contextPath || batchContext.project.title,
      target: batchContext.run.targetLang,
      provider: batchContext.run.provider,
      model: batchContext.run.model,
      memory: batchContext.memory,
      precedingSegments: state.precedingSegments,
      voiceContext: state.reviewVoiceContext,
      translationBrief: translationBrief || undefined,
      reviewFocus: 'style',
      chineseMonolingualEdit,
      segments: reviewedItems.map((item) => ({
        id: item.id, source: item.text, draft: translations.get(item.id)!,
        kind: item.kind, contextPath: item.contextPath,
      })),
    }, runId + '-style-review-' + batchIndex, styleScope);

    if (store.getRunStatus(projectId, runId) === 'cancelled') {
      store.appendEvent(projectId, runId, 'review.discarded', {
        batchIndex, stage: 'style-review', reason: 'cancelled while reviewer was in flight',
      });
      return;
    }
    const chineseEditorialMode = styleReview.editorialMode === 'chinese-monolingual';
    const styleFindings = (styleReview.findings || [])
      .filter((finding: any) => finding.category === 'style')
      .map((finding: any) => ({
        segmentId: finding.id,
        finding: {
          ...finding,
          ...(chineseEditorialMode ? { editorialMode: 'chinese-monolingual' } : {}),
        },
      }));
    // 中文单语编辑尚未经过原文对照，先只保存 finding；其他语言的 Reviewer 已同时
    // 对照原文，只有带有对应、已验证 style finding 的完整修订才自动写成新候选。
    const styleCandidates = selectVerifiedStyleReviewCandidates(
      styleReview,
      translations,
      reviewedItems.map((item) => item.id),
    );
    const styleFindingsPersisted = store.saveCandidates(projectId, runId, styleCandidates, styleFindings);
    if (!styleFindingsPersisted) {
      store.appendEvent(projectId, runId, 'review.discarded', {
        batchIndex, stage: 'style-review', reason: 'Run left active state before atomic candidate/finding commit',
        candidateCount: styleCandidates.length, findingCount: styleFindings.length,
      });
      return;
    }
    for (const item of styleCandidates) translations.set(item.segmentId, item.text);
    // 中文单语编辑的候选先交给后续双语准确性审校；验证通过后由
    // markChineseEditorialFindingsReviewed 更新本 Run 的候选，不要求用户点击采纳。
    if (chineseEditorialMode) {
      for (const [id, edited] of Object.entries(styleReview.translations || {})) {
        if (typeof edited === 'string' && edited.trim() && reviewedItems.some((item) => item.id === id)) {
          translations.set(id, edited);
          if (edited !== initialDrafts.get(id)) state.chineseEditorialCandidateIds.add(id);
        }
      }
    }
    const styleReviewedIds = Array.isArray(styleReview.reviewedIds) ? styleReview.reviewedIds : [];
    const chineseEditorialChangedIds = chineseEditorialMode
      ? styleReviewedIds.filter((id: string) =>
          typeof styleReview.translations?.[id] === 'string' &&
          styleReview.translations[id] !== initialDrafts.get(id))
      : [];
    const chineseEditorialUnchangedCount = chineseEditorialMode
      ? Math.max(0, styleReviewedIds.length - chineseEditorialChangedIds.length) : 0;
    store.appendEvent(projectId, runId, 'stage.completed', {
      stage: 'style-review', batchIndex,
      editorialMode: styleReview.editorialMode || null,
      ...(chineseEditorialMode ? {
        chineseEditorialMetrics: {
          reviewedCount: styleReviewedIds.length,
          editedCount: chineseEditorialChangedIds.length,
          unchangedCount: chineseEditorialUnchangedCount,
          uncoveredCount: Array.isArray(styleReview.missingIds) ? styleReview.missingIds.length : 0,
          findingCount: (styleReview.findings || []).filter((item: any) => item.category === 'style').length,
        },
      } : {}),
      reviewedIds: styleReview.reviewedIds,
      missingIds: styleReview.missingIds,
      styleFindingCount: (styleReview.findings || []).filter((item: any) => item.category === 'style').length,
      proposedStyleTranslations: (styleReview.findings || []).filter((item: any) => item.category === 'style' && item.proposedTranslation).length,
      promptChars: styleReview.promptChars,
      systemPromptChars: styleReview.systemPromptChars,
      contextChars: styleReview.contextChars,
      translationBriefHash: styleReview.translationBriefHash || translationBrief?.contextHash || null,
      durationMs: Date.now() - styleStartedAt,
    });
    if ((styleReview.missingIds || []).length || styleReview.retryError) {
      store.appendEvent(projectId, runId, 'stage.warning', {
        stage: 'style-review', batchIndex,
        warning: '文风审校仍有片段未覆盖：' + (styleReview.missingIds || []).join(', ') +
          (styleReview.retryError ? '；补审重试失败：' + String(styleReview.retryError).slice(0, 300) : ''),
        durationMs: Date.now() - styleStartedAt,
      });
    }
  } catch (styleError) {
    if (store.getRunStatus(projectId, runId) !== 'cancelled') {
      try {
        store.appendEvent(projectId, runId, 'stage.warning', {
          stage: 'style-review', batchIndex,
          warning: '文风审校失败，已保留准确性审校和初译结果：' +
            (styleError instanceof Error ? styleError.message : String(styleError)),
          durationMs: Date.now() - styleStartedAt,
        });
      } catch { /* The translation result remains durable even if the warning event cannot be written. */ }
    }
  }
}

/** 双语准确性审校：请求、中文单语编辑的双语复核、候选与 finding 的原子提交。 */
async function runBilingualReview(
  scope: RunBatchScope,
  state: BatchReviewState,
  reviewStartedAt: number,
): Promise<boolean> {
  const { store, projectId, runId } = scope;
  const { batchContext, batchIndex, batch, translations, initialDrafts, translationBrief } = state;
  const reviewScope = buildDocumentBatchSessionScope({
    projectId,
    runId,
    promptRevisionId: batchContext.run.promptRevisionId,
    role: 'review',
    batchIndex,
    translationMode: batchContext.run.translationMode,
    memoryRevisionId: batchContext.memoryRevisionId || 'no-memory',
  });
  const review = await runLiteraryReviewWithMissingRetry({
    projectId, runId,
    reviewType: scope.reviewStrength === 'medium' ? 'combined-review' : 'accuracy-terminology',
    taskProfiles: batchContext.prompt.config?.taskProfiles || {},
    chapterTitle: batch[0]?.contextPath || batchContext.project.title,
    target: batchContext.run.targetLang,
    provider: batchContext.run.provider,
    model: batchContext.run.model,
    memory: batchContext.memory,
    precedingSegments: state.precedingSegments,
    voiceContext: state.reviewVoiceContext,
    translationBrief: translationBrief || undefined,
    reviewFocus: scope.reviewStrength === 'medium' ? 'combined' : 'accuracy',
    segments: state.reviewTargets.map((item) => ({
      id: item.id, source: item.text, draft: translations.get(item.id)!,
      initialDraft: initialDrafts.get(item.id),
      kind: item.kind, contextPath: item.contextPath,
    })),
  }, runId + '-review-' + batchIndex, reviewScope);

  // A cancellation can happen while the reviewer is in flight. In that case neither
  // its revised candidates nor its findings may be written after the stop request.
  if (store.getRunStatus(projectId, runId) === 'cancelled') {
    restoreInitialDrafts(state);
    store.appendEvent(projectId, runId, 'review.discarded', {
      batchIndex, reason: 'cancelled while reviewer was in flight',
    });
    return false;
  }
  const revisedCandidates = collectRevisedCandidates(review, translations);
  const chineseVerification = verifyChineseEditorialEdits(state, review, revisedCandidates);
  const reviewFindings = review.findings.map((finding: any) => ({
    segmentId: finding.id,
    finding,
  }));
  // Reviewer corrections and their supporting findings are one transaction. If stop wins
  // the race, neither the revised candidate nor its audit findings are persisted.
  const reviewPersisted = store.saveCandidates(projectId, runId, revisedCandidates, reviewFindings);
  if (!reviewPersisted) {
    restoreInitialDrafts(state);
    store.appendEvent(projectId, runId, 'review.discarded', {
      batchIndex, reason: 'Run left active state before atomic Reviewer commit',
      revisedCount: revisedCandidates.length, findingCount: reviewFindings.length,
    });
    return false;
  }
  const revisedCount = revisedCandidates.length;
  for (const item of revisedCandidates) translations.set(item.segmentId, item.text);
  if (!markChineseEditorialReviewed(scope, state, chineseVerification)) return false;

  emitReviewOutcome(scope, state, review, revisedCount, reviewStartedAt);
  if (!state.chineseMonolingualEdit && scope.reviewStrength === 'strong') {
    await runStyleReview(scope, state);
  }
  return true;
}

/** 只收「被复核过、未被标记缺失、确实改了」的修订，避免把缺审片段当成新候选。 */
function collectRevisedCandidates(review: any, translations: Map<string, string>): Array<{ segmentId: string; text: string }> {
  const revisedCandidates: Array<{ segmentId: string; text: string }> = [];
  const reviewedIds = new Set(Array.isArray(review.reviewedIds) ? review.reviewedIds : []);
  const missingIds = new Set(Array.isArray(review.missingIds) ? review.missingIds : []);
  for (const [id, revised] of Object.entries(review.translations || {})) {
    const draft = translations.get(id);
    if (!reviewedIds.has(id) || missingIds.has(id) || !draft ||
        typeof revised !== 'string' || !revised.trim() || revised === draft) continue;
    revisedCandidates.push({ segmentId: id, text: revised });
  }
  return revisedCandidates;
}

/**
 * 中文单语编辑的候选在双语审校覆盖之前都是临时值。
 * 覆盖成功则保留双语审校的最终文本，覆盖缺失则回退到首译。
 */
function verifyChineseEditorialEdits(
  state: BatchReviewState,
  review: any,
  revisedCandidates: Array<{ segmentId: string; text: string }>,
): { verified: Array<{ segmentId: string; text: string }>; fallbacks: Array<{ segmentId: string; text: string }>; candidates: Array<{ segmentId: string; text: string }> } {
  const { translations, initialDrafts, chineseEditorialCandidateIds } = state;
  const chineseEditorialEdits = new Map<string, string>();
  for (const id of chineseEditorialCandidateIds) {
    const edited = translations.get(id);
    if (typeof edited === 'string') chineseEditorialEdits.set(id, edited);
  }
  const verification = resolveBilingualVerifiedChineseEdits(initialDrafts, chineseEditorialEdits, review);
  for (const item of verification.fallbacks) translations.set(item.segmentId, item.text);
  for (const item of verification.verified) translations.set(item.segmentId, item.text);
  for (const item of verification.candidates) {
    translations.set(item.segmentId, item.text);
    const existing = revisedCandidates.find((candidate) => candidate.segmentId === item.segmentId);
    if (!existing) revisedCandidates.push(item);
    else existing.text = item.text;
  }
  for (let index = revisedCandidates.length - 1; index >= 0; index--) {
    const segmentId = revisedCandidates[index]!.segmentId;
    if (chineseEditorialCandidateIds.has(segmentId) &&
        !verification.candidates.some((item) => item.segmentId === segmentId)) {
      revisedCandidates.splice(index, 1);
    }
  }
  return verification;
}

/** 双语复核后回写中文单语编辑的 finding 状态；写失败只放弃本次状态更新。 */
function markChineseEditorialReviewed(
  scope: RunBatchScope,
  state: BatchReviewState,
  chineseVerification: { verified: Array<{ segmentId: string; text: string }>; candidates: Array<{ segmentId: string; text: string }> },
): boolean {
  const { store, projectId, runId } = scope;
  if (!state.chineseEditorialCandidateIds.size) return true;
  const correctedIds = new Set(chineseVerification.candidates.map((item) => item.segmentId));
  const editorialResults = chineseVerification.verified
    .map(({ segmentId }) => ({
      segmentId,
      status: correctedIds.has(segmentId) ? 'corrected' as const : 'reverted' as const,
      proposedTranslation: state.translations.get(segmentId)!,
    }));
  const marked = store.markChineseEditorialFindingsReviewed(projectId, runId, editorialResults);
  if (!marked) {
    store.appendEvent(projectId, runId, 'review.discarded', {
      batchIndex: state.batchIndex, stage: 'chinese-literary-editing',
      reason: 'Run left active state before bilingual verification status commit',
    });
    return false;
  }
  return true;
}

/** 审校的完成事件、文件日志与未覆盖告警。 */
function emitReviewOutcome(
  scope: RunBatchScope,
  state: BatchReviewState,
  review: any,
  revisedCount: number,
  reviewStartedAt: number,
): void {
  const { store, projectId, runId, batches } = scope;
  const { batchContext, batchIndex, translationBrief } = state;
  const reviewDurationMs = Date.now() - reviewStartedAt;
  // 审校的模型用量以前只出现在文件日志里，project_events 查不到，
  // 于是 run 级成本统计永远缺审校那一半（而审校正是最贵的一半）。
  if (review.usage) addRunUsage(runId, review.usage);
  if (review.usageSummary) {
    const taskProfile = getCodeBuddyTaskProfile(
      batchContext.prompt.config || {},
      scope.reviewStrength === 'strong' ? 'styleReview' : 'accuracyReview',
    );
    store.appendEvent(projectId, runId, 'model.usage', {
      stage: 'review', batchIndex, requestId: runId + '-review-' + batchIndex,
      provider: batchContext.run.provider, model: review.model || null,
      thinkingMode: taskProfile.thinkingMode,
      effort: taskProfile.effort,
      reviewStrength: scope.reviewStrength,
      ...review.usageSummary,
    });
  }
  store.appendEvent(projectId, runId, 'stage.completed', {
    stage: 'review',
    batchIndex,
    reviewStrength: scope.reviewStrength,
    reviewedIds: review.reviewedIds,
    missingIds: review.missingIds,
    findingCount: review.findings.length,
    accuracyFindingCount: review.findings.filter((item: any) => item.category === 'accuracy').length,
    terminologyFindingCount: review.findings.filter((item: any) => item.category === 'terminology').length,
    revisedCount,
    promptChars: review.promptChars,
    systemPromptChars: review.systemPromptChars,
    contextChars: review.contextChars,
    translationBriefHash: review.translationBriefHash || translationBrief?.contextHash || null,
    durationMs: reviewDurationMs,
  });
  // 审校耗时是判断「为什么一批要一分多钟」的第一手依据，必须进文件日志。
  logInfo('document-agent', 'review done · run=' + runId +
    ' · batch=' + batchIndex + '/' + batches.length +
    ' · strength=' + scope.reviewStrength +
    ' · segments=' + state.reviewTargets.length +
    ' · findings=' + review.findings.length +
    ' · missing=' + (Array.isArray(review.missingIds) ? review.missingIds.length : 0) +
    ' · revised=' + revisedCount +
    ' · promptChars=' + (review.promptChars || 0) +
    ' · model=' + (review.model || '<运行时默认>') +
    ' · durationMs=' + reviewDurationMs);
  if ((review.missingIds || []).length || review.retryError) {
    store.appendEvent(projectId, runId, 'stage.warning', {
      stage: 'review', batchIndex,
      warning: '准确性/术语审校仍有片段未覆盖：' + (review.missingIds || []).join(', ') +
        (review.retryError ? '；补审重试失败：' + String(review.retryError).slice(0, 300) : ''),
      durationMs: Date.now() - reviewStartedAt,
    });
  }
}

function restoreInitialDrafts(state: BatchReviewState): void {
  for (const id of state.chineseEditorialCandidateIds) {
    const initial = state.initialDrafts.get(id);
    if (initial !== undefined) state.translations.set(id, initial);
  }
}
