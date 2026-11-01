/**
 * 成对运行的人工盲评：创建评估、提交评审、读取结果。
 *
 * 从 qualityAudit 抽出：评估建立在 runMetrics 之上，是审计结果的下游产物，
 * 和审计规则分开后评估流程（盲评顺序、评审偏好汇总）可以独立调整。
 */

import { randomInt, randomUUID } from 'node:crypto';
import { getDocumentProjectStore } from './projectStore.ts';
import { fail } from './qualityShared.ts';
import { runMetrics } from './qualityAuditMetrics.ts';

/**
 * 读取 Run 的指标、上下文与译文映射，供对照评测使用。
 */
function runComparisonData(projectId: string, runId: string) {
  const store = getDocumentProjectStore();
  const metrics = runMetrics(projectId, runId);
  const context = store.getRunContext(projectId, runId);
  const { db } = store.getProjectContext(projectId);
  const translations = new Map<string, string>();
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, r.translation_text AS text FROM run_segments rs ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  return { metrics, context, translations };
}

/**
 * 对两个不同 Run 做同源版本的前后对照评测。
 * 先比较来源版本和语言条件，再计算确定性指标并生成盲评映射；不同来源版本的数字没有可比性，
 * 盲评/人工评价与自动指标分开保存，不能将模型自报分数当作实际质量改善证据。
 */
export function createProjectQualityEvaluation(projectId: string, beforeRunId: string, afterRunId: string): Record<string, any> {
  if (!beforeRunId || !afterRunId || beforeRunId === afterRunId) fail('必须提供两个不同的 beforeRunId 和 afterRunId。');
  const store = getDocumentProjectStore();
  const before = runComparisonData(projectId, beforeRunId);
  const after = runComparisonData(projectId, afterRunId);
  if (before.metrics.sourceRevisionId !== after.metrics.sourceRevisionId) fail('前后运行的来源版本不同，不能作有效对照。', 409);
  if (before.metrics.targetLang !== after.metrics.targetLang || before.context.run.sourceLang !== after.context.run.sourceLang) {
    fail('前后运行的源语言或目标语言不同，不能作有效对照。', 409);
  }
  if (before.metrics.translationMode !== after.metrics.translationMode) {
    fail('前后运行的翻译模式不同，不能作有效对照。', 409);
  }
  const comparableStatuses = new Set(['completed', 'awaiting_acceptance']);
  if (!comparableStatuses.has(before.metrics.status) || !comparableStatuses.has(after.metrics.status)) {
    fail('前后运行必须已完成翻译和审校并进入 completed 或 awaiting_acceptance；不能比较仍在运行、暂停或取消的结果。', 409);
  }
  const afterIdSet = new Set<string>(after.metrics.segmentIds);
  if (before.metrics.segmentIds.length !== after.metrics.segmentIds.length ||
      before.metrics.segmentIds.some((id: string) => !afterIdSet.has(id))) {
    fail('前后运行的片段范围不同；为了可比性，必须使用同一来源版本和相同片段集合。', 409);
  }
  const beforeIds = new Set(before.metrics.segmentIds);
  const segmentsRows = store.getProjectContext(projectId).db.prepare(
    'SELECT segment_id AS id, ordinal, text, context_path AS contextPath FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(before.metrics.sourceRevisionId) as any[];
  const sourceById = new Map(segmentsRows.map((row) => [String(row.id), row]));
  const candidateIds = before.metrics.segmentIds.filter((id: string) =>
    before.translations.get(id) !== after.translations.get(id));
  const prioritized = candidateIds;
  const maxBlindItems = 40;
  const maxSamples = Math.min(maxBlindItems, prioritized.length);
  const byChapter = new Map<string, string[]>();
  for (const id of prioritized) {
    const segment = sourceById.get(id);
    if (!segment) continue;
    const chapter = String(segment.contextPath || '');
    const list = byChapter.get(chapter) || [];
    list.push(id);
    byChapter.set(chapter, list);
  }
  const chapterEntries = Array.from(byChapter.entries());
  const selected = new Set<string>();
  // Reserve one sample per evenly spaced chapter first, then use evenly spaced remaining
  // changed segments. This prevents long novels from sampling only the first 40 chapters.
  const chapterSlots = Math.min(maxSamples, chapterEntries.length);
  for (let i = 0; i < chapterSlots; i++) {
    const chapterIndex = Math.floor(i * chapterEntries.length / chapterSlots);
    const representative = chapterEntries[chapterIndex]?.[1]?.[0];
    if (representative) selected.add(representative);
  }
  const remainingIds = prioritized.filter((id: string) => !selected.has(id));
  const additionalSlots = Math.min(maxSamples - selected.size, remainingIds.length);
  for (let i = 0; i < additionalSlots; i++) {
    const index = Math.floor(i * remainingIds.length / additionalSlots);
    selected.add(remainingIds[index]!);
  }
  const blindMapping: Record<string, { A: 'before' | 'after'; B: 'before' | 'after' }> = {};
  const blindPacket = Array.from(selected).map((id) => {
    const source = sourceById.get(id)!;
    const beforeText = before.translations.get(id) || '';
    const afterText = after.translations.get(id) || '';
    const swap = randomInt(2) === 1;
    const mapping = { A: swap ? 'after' as const : 'before' as const, B: swap ? 'before' as const : 'after' as const };
    blindMapping[id] = mapping;
    return {
      segmentId: id,
      chapter: String(source.contextPath || ''),
      source: String(source.text || ''),
      variantA: mapping.A === 'before' ? beforeText : afterText,
      variantB: mapping.B === 'before' ? beforeText : afterText,
    };
  });
  const metricKeys = [
    'missingTranslationCount', 'missingTranslationRatePer100Segments', 'coveragePercent', 'terminologyDriftCount',
    'terminologyDriftRatePer100Segments', 'numericTokenMismatchCount', 'numericTokenMismatchRatePer100Segments',
    'repeatedExpressionDriftGroups', 'repeatedExpressionDriftRatePer100Segments',
    'styleFindingCount', 'styleFindingRatePer100Segments', 'characterVoiceFindingCount', 'characterVoiceFindingRatePer100Segments',
    'totalPipelineRequestCount', 'totalPromptCharsKnown', 'modelDurationMsKnown',
  ];
  const delta: Record<string, number> = {};
  for (const key of metricKeys) {
    const a = Number(before.metrics.metrics[key] || 0);
    const b = Number(after.metrics.metrics[key] || 0);
    delta[key] = Math.round((b - a) * 100) / 100;
  }
  const evaluationId = randomUUID();
  const report: any = {
    evaluationId,
    projectId,
    sourceRevisionId: before.metrics.sourceRevisionId,
    beforeRunId,
    afterRunId,
    createdAt: new Date().toISOString(),
    comparable: true,
    deterministic: {
      configuration: {
        before: {
          sourceLang: before.metrics.sourceLang, targetLang: before.metrics.targetLang,
          provider: before.metrics.provider, model: before.metrics.model,
          translationMode: before.metrics.translationMode, reviewEnabled: before.metrics.reviewEnabled,
          promptRevisionId: before.metrics.promptRevisionId, memoryRevisionId: before.metrics.memoryRevisionId,
          status: before.metrics.status,
        },
        after: {
          sourceLang: after.metrics.sourceLang, targetLang: after.metrics.targetLang,
          provider: after.metrics.provider, model: after.metrics.model,
          translationMode: after.metrics.translationMode, reviewEnabled: after.metrics.reviewEnabled,
          promptRevisionId: after.metrics.promptRevisionId, memoryRevisionId: after.metrics.memoryRevisionId,
          status: after.metrics.status,
        },
      },
      before: before.metrics.metrics,
      after: after.metrics.metrics,
      deltaAfterMinusBefore: delta,
      improvementSignals: {
        missingTranslationsDecreased: delta.missingTranslationCount < 0,
        terminologyWarningsDecreased: delta.terminologyDriftCount < 0,
        repeatedExpressionWarningsDecreased: delta.repeatedExpressionDriftGroups < 0,
        coverageIncreased: delta.coveragePercent > 0,
      },
      runDisclosure: null as null | { beforeRunId: string; afterRunId: string },
    },
    blindReview: {
      status: blindPacket.length ? 'pending' : 'not_applicable',
      sampleCount: blindPacket.length,
      instruction: blindPacket.length
        ? '请先对照原文盲评 A/B，不要查阅运行 ID；每个样本只比较给定维度，不预设修订版本一定更好。A/B 位置已按样本独立随机化。'
        : '前后运行的目标译文完全相同，没有可进行文本偏好盲评的样本；仅报告覆盖率、审校发现与可用成本指标。',
      packet: blindPacket,
      result: blindPacket.length ? null : { reason: 'no_translation_differences' },
    },
  };
  if (!blindPacket.length) report.deterministic.runDisclosure = { beforeRunId, afterRunId };
  store.saveQualityEvaluation(projectId, report, blindMapping, []);
  store.appendEvent(projectId, afterRunId, 'quality-evaluation.created', {
    evaluationId, beforeRunId, afterRunId, sampleCount: blindPacket.length,
    costMetrics: {
      beforePipelineRequests: before.metrics.metrics.totalPipelineRequestCount,
      afterPipelineRequests: after.metrics.metrics.totalPipelineRequestCount,
      beforeDurationMs: before.metrics.metrics.modelDurationMsKnown,
      afterDurationMs: after.metrics.metrics.modelDurationMsKnown,
    },
  });
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: true,
    blindReview: report.blindReview,
    ...(blindPacket.length ? {
      instruction: '在完成盲评之前不返回 before/after 对照指标或 A/B 对应关系。',
    } : {
      deterministic: report.deterministic,
      beforeRunId,
      afterRunId,
    }),
  };
}

/**
 * 提交人工盲评结果，全部完成时汇总偏好。
 */
export function submitProjectQualityEvaluationReviews(
  projectId: string,
  evaluationId: string,
  reviewsInput: unknown,
): Record<string, any> {
  if (!Array.isArray(reviewsInput) || !reviewsInput.length || reviewsInput.length > 80) {
    fail('reviews 必须是 1-80 条人工盲评记录。');
  }
  const store = getDocumentProjectStore();
  const loaded = store.getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  if (report.blindReview?.status !== 'pending') fail('当前质量评测不处于待盲评状态。', 409);
  const allowed = new Set<string>((report.blindReview.packet || []).map((item: any) => String(item.segmentId)));
  const reviews: any[] = Array.isArray(loaded.blindReviews) ? [...loaded.blindReviews] : [];
  const existing = new Map(reviews.map((item) => [item.segmentId + ':' + item.dimension, item]));
  for (const raw of reviewsInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const segmentId = String((raw as any).segmentId || '');
    const dimension = ['overall', 'accuracy', 'terminology', 'voice', 'style'].includes((raw as any).dimension)
      ? String((raw as any).dimension) : 'overall';
    const preference = String((raw as any).preference || '');
    if (!allowed.has(segmentId)) fail('盲评包含不在评测样本中的片段：' + segmentId);
    if (!['A', 'B', 'tie', 'cannot_judge'].includes(preference)) fail('preference 必须为 A、B、tie 或 cannot_judge。');
    const item = {
      segmentId, dimension, preference,
      confidence: ['low', 'medium', 'high'].includes((raw as any).confidence) ? String((raw as any).confidence) : 'medium',
      comment: typeof (raw as any).comment === 'string' ? String((raw as any).comment).slice(0, 500) : '',
    };
    existing.set(segmentId + ':' + dimension, item);
  }
  reviews.splice(0, reviews.length, ...Array.from(existing.values()));
  const packetIds = (report.blindReview.packet || []).map((item: any) => String(item.segmentId));
  const overallBySegment = new Map(reviews.filter((item) => item.dimension === 'overall').map((item) => [item.segmentId, item.preference]));
  const complete = packetIds.every((id: string) => overallBySegment.has(id));
  if (complete) {
    const mapping = loaded.blindMapping;
    const summarizePreferences = (items: any[]) => {
      let beforeWins = 0, afterWins = 0, ties = 0, cannotJudge = 0;
      for (const item of items) {
        const preference = item.preference;
        if (preference === 'tie') ties++;
        else if (preference === 'cannot_judge') cannotJudge++;
        else if (mapping[item.segmentId]?.[preference] === 'before') beforeWins++;
        else if (mapping[item.segmentId]?.[preference] === 'after') afterWins++;
      }
      const decided = beforeWins + afterWins;
      return {
        beforeWins, afterWins, ties, cannotJudge,
        decidedPreferenceCount: decided,
        afterPreferred: afterWins > beforeWins,
        afterWinRateAmongDecided: decided ? Math.round(afterWins / decided * 1000) / 10 : null,
      };
    };
    const dimensions = ['overall', 'accuracy', 'terminology', 'voice', 'style'];
    const preferenceByDimension = Object.fromEntries(dimensions.map((dimension) => [
      dimension,
      summarizePreferences(reviews.filter((item) => item.dimension === dimension)),
    ]));
    report.blindReview = {
      ...report.blindReview,
      status: 'completed',
      result: {
        ...summarizePreferences(reviews.filter((item) => item.dimension === 'overall')),
        preferenceByDimension,
      },
    };
    report.blindReview.packet = [];
    report.deterministic.runDisclosure = { beforeRunId: report.beforeRunId, afterRunId: report.afterRunId };
  } else {
    report.blindReview = { ...report.blindReview, status: 'pending', completedOverallRatings: overallBySegment.size };
  }
  store.saveQualityEvaluation(projectId, report, loaded.blindMapping, reviews);
  return {
    evaluationId,
    blindReview: report.blindReview,
    ...(complete ? { deterministic: report.deterministic, beforeRunId: report.beforeRunId, afterRunId: report.afterRunId } : {}),
  };
}

/**
 * 读取质量对照评测的公开视图。
 */
export function getProjectQualityEvaluation(projectId: string, evaluationId: string): Record<string, any> {
  const loaded = getDocumentProjectStore().getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  const complete = ['completed', 'not_applicable'].includes(String(report.blindReview?.status));
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: report.comparable,
    blindReview: report.blindReview,
    ...(complete ? {
      deterministic: report.deterministic,
      beforeRunId: report.beforeRunId,
      afterRunId: report.afterRunId,
    } : {}),
    createdAt: report.createdAt,
    submittedReviewCount: Array.isArray(loaded.blindReviews) ? loaded.blindReviews.length : 0,
  };
}
