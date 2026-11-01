/**
 * 全书确定性质量审计：把各类检查汇总成一次审计结果，并落地审计记录。
 *
 * 自动检查只标记需要人工看的片段，不断言文学正确性，也从不采纳或覆盖译文。
 * 各类检查分散在同目录的 quality* 模块里，这里只负责编排顺序、汇总与持久化。
 */
import { randomUUID } from 'node:crypto';
import { ensureSourceFeatureIndex, readSourceFeatureIndex } from './contextGraph.ts';
import {
  acceptedTranslations,
  currentSource,
  loadMemory,
  overlayRunCandidates,
  translationSnapshotHash,
} from './qualityAuditData.ts';
import {
  MAX_BULK_REPAIR_SEGMENTS,
  MAX_REPEATED_EXPRESSION_GROUPS,
  MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING,
  fail,
  stableFindingId,
} from './qualityShared.ts';
import { canonicalNameMappingConflictFindings, terminologyFindings } from './qualityNames.ts';
import { englishResidueFindings, entityMentionDriftFindings, translationContextDeltaFindings } from './qualityResidueFindings.ts';
import { numericFindings, translationOutputValidationFindings } from './qualityNumeric.ts';
import { repeatedExpressionFindings } from './qualityRepetitionFindings.ts';
import { chineseEditorialFindingsForRun, chineseEditorialStageMetrics, currentReviewFindings } from './qualityReviewFindings.ts';

/**
 * 从 Run 或最新 prompt revision 推断审计目标语言。
 */
function auditTargetLanguage(db: any, runId?: string): string {
  if (runId) {
    const row = db.prepare('SELECT target_lang AS targetLang FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (typeof row?.targetLang === 'string' && row.targetLang.trim()) return row.targetLang.trim();
  }
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  try {
    const config = row?.config_json ? JSON.parse(row.config_json) : {};
    if (typeof config?.targetLang === 'string' && config.targetLang.trim()) return config.targetLang.trim();
  } catch { /* malformed historical config: use the product default */ }
  return 'zh';
}

/**
 * 从 Run 或最新 prompt revision 推断审计源语言。
 */
function auditSourceLanguage(db: any, runId?: string): string {
  if (runId) {
    const row = db.prepare('SELECT source_lang AS sourceLang FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (typeof row?.sourceLang === 'string' && row.sourceLang.trim()) return row.sourceLang.trim();
  }
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  try {
    const config = row?.config_json ? JSON.parse(row.config_json) : {};
    if (typeof config?.sourceLang === 'string' && config.sourceLang.trim()) return config.sourceLang.trim();
  } catch { /* malformed historical config: use product auto-detection */ }
  return 'auto';
}

/**
 * 对当前来源版本执行全书确定性质量审计，并合并相关 Reviewer/上下文漂移发现。
 * 可选择叠加一个已结束 Run 的候选译文；审计只产出 finding/metric，不自动修改或采纳译文。
 * 报告固定 sourceRevisionId，后续返工必须再次校验该 revision 仍是当前版本。
 */
export function runProjectQualityAudit(projectId: string, runId?: string): Record<string, any> {
  const { store, context, segments } = currentSource(projectId);
  if (!segments.length) fail('当前来源版本没有可审计的片段。', 409);
  // Each document project owns its own SQLite database, so every row here belongs to this project.
  // "partial" is a terminal status, not an active worker: its missing accepted translations need auditing.
  const active = context.db.prepare(
    "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused') LIMIT 1"
  ).get() as { run_id?: string } | undefined;
  if (active?.run_id && (!runId || runId === active.run_id)) {
    fail('当前项目仍有运行中的或已暂停的任务，请等待完成或继续运行后再审计；若需检查候选结果，请提供已结束的 runId。', 409);
  }
  if (runId) {
    const requestedRun = context.db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!requestedRun) fail('找不到质量审计指定的翻译运行：' + runId, 404);
    if (!['completed', 'awaiting_acceptance'].includes(String(requestedRun.status))) {
      fail('只有已完成或等待采纳的运行可以作为审计候选来源。', 409);
    }
  }
  const acceptedTranslationMap = acceptedTranslations(context.db, context.currentSourceRevisionId);
  const acceptedTranslationSnapshotHash = translationSnapshotHash(segments, acceptedTranslationMap);
  const translations = new Map(acceptedTranslationMap);
  if (runId) overlayRunCandidates(context.db, context.currentSourceRevisionId, runId, translations);
  const effectiveTranslationSnapshotHash = translationSnapshotHash(segments, translations);
  const memory = loadMemory(projectId, runId);
  const mappingConflictAudit = canonicalNameMappingConflictFindings(segments, memory);
  const termFindings = terminologyFindings(segments, translations, memory, mappingConflictAudit.conflictedSources);
  const sourceLang = auditSourceLanguage(context.db, runId);
  const residueFindings = englishResidueFindings(segments, translations, auditTargetLanguage(context.db, runId), sourceLang);
  const missing = segments.filter((segment) => !translations.get(segment.id)?.trim()).map((segment) => ({
    findingId: stableFindingId('missing-translation', [segment.id], context.currentSourceRevisionId),
    type: 'missing-translation',
    category: 'coverage',
    severity: 'must-fix',
    repairable: true,
    segmentIds: [segment.id],
    chapter: segment.contextPath || null,
    sourceExcerpt: segment.text.slice(0, 240),
    explanation: '该来源片段没有当前可用的已采纳译文或本次运行候选译文。',
  }));
  const numberFindings = numericFindings(segments, translations, sourceLang);
  ensureSourceFeatureIndex(projectId, context.currentSourceRevisionId, sourceLang);
  const storedSourceIndex = readSourceFeatureIndex(context.db, context.currentSourceRevisionId, sourceLang);
  const repeatedFindings = repeatedExpressionFindings(segments, translations, undefined, storedSourceIndex);
  const presentIds = new Set(segments.map((segment) => segment.id));
  const outputFindings = translationOutputValidationFindings(context.db, runId, presentIds);
  const contextFindings = translationContextDeltaFindings(context.db, runId, presentIds, context.currentSourceRevisionId);
  const sourceById = new Map(segments.map((segment) => [segment.id, segment.text]));
  const mentionFindings = entityMentionDriftFindings(
    context.db, runId, context.currentSourceRevisionId, sourceById, translations,
    Array.isArray(memory.entities) ? memory.entities : [],
  );
  const review = currentReviewFindings(context.db, context.currentSourceRevisionId, runId);
  const reviewFindings = review.findings.filter((finding) => presentIds.has(finding.segmentId)).map((finding) => ({
    findingId: 'review_' + finding.findingId,
    type: finding.editorialMode === 'chinese-monolingual' ? 'chinese-literary-editing'
      : finding.category === 'accuracy'
        ? 'accuracy-review'
        : finding.category === 'terminology'
          ? 'reviewer-terminology-review'
          : finding.dimension === 'character_voice' ? 'character-voice-review' : 'style-review',
    category: finding.category,
    editorialMode: finding.editorialMode,
    bilingualReviewStatus: finding.bilingualReviewStatus,
    applicationStatus: finding.applicationStatus,
    severity: finding.priority === 'must_fix' ? 'must-fix' : 'review',
    repairable: true,
    segmentIds: [finding.segmentId],
    reviewRunId: review.reviewRunId,
    status: finding.status,
    dimension: finding.dimension,
    characterId: finding.characterId,
    sourceExcerpt: finding.sourceExcerpt,
    draftExcerpt: finding.draftExcerpt || finding.reviewedTranslation,
    evidenceSegmentIds: finding.evidenceSegmentIds,
    reason: finding.reason,
    suggestion: finding.suggestion,
    proposedTranslation: finding.proposedTranslation,
  }));
  const chineseEditorial = chineseEditorialStageMetrics(context.db, context.currentSourceRevisionId, runId);
  const chineseEditorialFindings = chineseEditorialFindingsForRun(
    context.db, context.currentSourceRevisionId, chineseEditorial.runId,
  );
  const chineseEditorialApplied = chineseEditorialFindings.filter((finding) => finding.applicationStatus === 'applied').length;
  const chineseEditorialAutoApplied = chineseEditorialFindings.filter((finding) =>
    finding.applicationStatus === 'applied' && finding.applicationMethod === 'automatic-bilingual-verification').length;
  const chineseEditorialUserApplied = chineseEditorialApplied - chineseEditorialAutoApplied;
  const chineseEditorialDismissed = chineseEditorialFindings.filter((finding) => finding.applicationStatus === 'dismissed').length;
  const chineseEditorialPending = chineseEditorialFindings.filter((finding) => !['applied', 'dismissed'].includes(finding.applicationStatus)).length;
  const chineseEditorialVerified = chineseEditorialFindings.filter((finding) =>
    ['verified', 'corrected'].includes(finding.bilingualReviewStatus)).length;
  const chineseEditorialCorrected = chineseEditorialFindings.filter((finding) =>
    finding.bilingualReviewStatus === 'corrected').length;
  const chineseEditorialBilingualPending = chineseEditorialFindings.filter((finding) =>
    !['verified', 'corrected'].includes(finding.bilingualReviewStatus)).length;
  const chineseEditorialUserDecided = chineseEditorialUserApplied + chineseEditorialDismissed;
  const chineseEditorialLatestOverrides = chineseEditorialFindings.filter((finding) => {
    if (finding.applicationStatus !== 'applied' || !finding.appliedResultId) return false;
    const latest = context.db.prepare(
      'SELECT result_id, origin FROM translation_results WHERE source_revision_id = ? AND segment_id = ? AND accepted = 1 ORDER BY rowid DESC LIMIT 1'
    ).get(context.currentSourceRevisionId, finding.segmentId) as { result_id?: string; origin?: string } | undefined;
    return !!latest && latest.result_id !== finding.appliedResultId && latest.origin === 'manual';
  }).length;
  const editorialProfile = memory.chineseEditorialProfile || null;
  const findings = [
    ...missing, ...mappingConflictAudit.findings, ...termFindings, ...residueFindings,
    ...numberFindings, ...repeatedFindings, ...outputFindings, ...contextFindings, ...mentionFindings, ...reviewFindings,
  ];
  const auditId = randomUUID();
  const translatedCount = segments.length - missing.length;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  const report = {
    auditId,
    projectId,
    sourceRevisionId: context.currentSourceRevisionId,
    runId: runId || null,
    // Aggregate hashes keep stale-repair protection bounded even for very long books.
    translationSnapshotHash: effectiveTranslationSnapshotHash,
    acceptedTranslationSnapshotHash,
    reviewRunId: review.reviewRunId,
    createdAt: new Date().toISOString(),
    analysisLimits: {
      repeatedExpressionGroupsAnalyzed: MAX_REPEATED_EXPRESSION_GROUPS,
      sourceFeatureIndexVersion: storedSourceIndex?.indexVersion || null,
      sourceFeatureIndexUsed: Boolean(storedSourceIndex),
      sourceFeatureIndexSegments: storedSourceIndex?.sourceSegmentCount || 0,
      maximumLocationsListedPerRepeatedExpression: MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING,
      maximumSegmentsForFindingLevelRepair: MAX_BULK_REPAIR_SEGMENTS,
      note: '全书原文参与确定性扫描；为控制报告规模，重复表达最多分析前 300 个高频候选组，单组最多列出 500 个位置。更大范围必须显式选 segmentIds 返工。',
    },
    metrics: {
      sourceSegmentCount: segments.length,
      translatedSegmentCount: translatedCount,
      missingTranslationCount: missing.length,
      missingTranslationRatePer100Segments: ratePer100(missing.length),
      coveragePercent: segments.length ? Math.round(translatedCount / segments.length * 1000) / 10 : 100,
      terminologyDriftCount: termFindings.length,
      terminologyDriftRatePer100Segments: ratePer100(termFindings.length),
      canonicalNameMappingConflictCount: mappingConflictAudit.findings.length,
      englishResidueCount: residueFindings.length,
      englishResidueRatePer100Segments: ratePer100(residueFindings.length),
      numericTokenMismatchCount: numberFindings.length,
      numericTokenMismatchRatePer100Segments: ratePer100(numberFindings.length),
      duplicateOutputIdFindingCount: outputFindings.filter((item) => item.type === 'duplicate-output-id').length,
      malformedOutputFindingCount: outputFindings.filter((item) => item.type === 'malformed-output-row').length,
      unexpectedOutputIdFindingCount: outputFindings.filter((item) => item.type === 'unexpected-output-id').length,
      repeatedExpressionDriftGroups: repeatedFindings.filter((item) => item.type === 'repeated-expression-drift').length,
      contextDeltaConflictCount: contextFindings.length,
      entityMentionDriftCount: mentionFindings.length,
      repeatedExpressionAlignmentReviewCount: repeatedFindings.filter((item) => item.type === 'repeated-expression-alignment-review').length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeatedFindings.filter((item) => item.type === 'repeated-expression-drift').length),
      accuracyReviewFindingCount: reviewFindings.filter((item) => item.category === 'accuracy').length,
      reviewerTerminologyFindingCount: reviewFindings.filter((item) => item.category === 'terminology').length,
      styleReviewFindingCount: reviewFindings.filter((item) => item.category === 'style').length,
      styleFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.category === 'style').length),
      characterVoiceFindingCount: reviewFindings.filter((item) => item.type === 'character-voice-review').length,
      characterVoiceFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.type === 'character-voice-review').length),
      chineseEditorial: {
        runId: chineseEditorial.runId,
        reviewedSegmentCount: chineseEditorial.reviewedCount,
        editedSegmentCount: chineseEditorial.editedCount,
        unchangedSegmentCount: chineseEditorial.unchangedCount,
        uncoveredSegmentCount: chineseEditorial.uncoveredCount,
        editRatePercent: chineseEditorial.reviewedCount
          ? Math.round(chineseEditorial.editedCount / chineseEditorial.reviewedCount * 1000) / 10 : null,
        unchangedRatePercent: chineseEditorial.reviewedCount
          ? Math.round(chineseEditorial.unchangedCount / chineseEditorial.reviewedCount * 1000) / 10 : null,
        findingCount: chineseEditorial.findingCount,
        bilingualVerifiedFindingCount: chineseEditorialVerified,
        bilingualCorrectedFindingCount: chineseEditorialCorrected,
        bilingualPendingFindingCount: chineseEditorialBilingualPending,
        automaticallyAppliedFindingCount: chineseEditorialAutoApplied,
        userAppliedFindingCount: chineseEditorialUserApplied,
        userDismissedFindingCount: chineseEditorialDismissed,
        pendingUserDecisionFindingCount: chineseEditorialPending,
        userDecisionAcceptanceRatePercent: chineseEditorialUserDecided
          ? Math.round(chineseEditorialUserApplied / chineseEditorialUserDecided * 1000) / 10 : null,
        manuallyOverriddenAfterApplyCount: chineseEditorialLatestOverrides,
      },
      chineseEditorialProfile: editorialProfile ? {
        status: editorialProfile.status,
        sourceRevisionId: editorialProfile.sourceRevisionId,
        analysisVersion: editorialProfile.analysisVersion,
        sampleFingerprint: editorialProfile.sampleFingerprint,
        sampleCount: editorialProfile.sampleCount,
        chapterCount: editorialProfile.chapterCount,
        evidenceCount: Array.isArray(editorialProfile.evidenceRefs) ? editorialProfile.evidenceRefs.length : 0,
      } : { status: 'not-generated' },
      repairableFindingCount: findings.filter((item) => item.repairable).length,
    },
    interpretation: [
      '遗漏检查为确定性检查。',
      '术语漂移是基于已确认规范译名的启发式提示；未出现规范译名不一定代表错误。',
      '人物规范译名冲突会单独报告，不会在多个已确认译名之间自动选一个。',
      '英文残留检测只提供启发式复核提示；专名或刻意保留的外语也可能命中。',
      '数字序列差异是启发式提示，需考虑中文数字、日期格式和上下文后人工确认。',
      '重复表达只对重复源文片段的译文差异提示复核，不自动统一。',
      '重复输出 ID、未知输出 ID 和结构不合法的模型响应只从运行事件报告，不接受这些异常行。',
      '同一实体的候选译名冲突来自初译 context_delta 的来源证据，仅作为人工复核项；不会自动统一译名或自动返工。',
      '准确性/遗漏、术语、人物声线与文风提示来自已有 Reviewer 发现；若没有运行相应审校，报告不能证明该类问题不存在。',
      '中文单语编辑只有经过双语忠实度 Reviewer 完整验证后才会自动应用；其它可选文风建议仍需用户自行决定。',
      '自动应用、用户主动应用和用户拒绝分别计数；最终采纳事务不会覆盖更新的人工修订。',
    ],
    findings,
  };
  store.saveQualityAudit(projectId, report);
  store.appendEvent(projectId, runId || null, 'quality-audit.completed', {
    auditId, sourceRevisionId: context.currentSourceRevisionId, metrics: report.metrics,
  });
  return report;
}
