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
  assertAuditPreconditions(runId, context, segments);
  const revisionId = context.currentSourceRevisionId;

  const view = buildAuditTranslationView(context, segments, runId);
  const memory = loadMemory(projectId, runId);
  const section = collectAuditFindings({
    projectId, context, segments, translations: view.translations, memory,
    sourceLang: auditSourceLanguage(context.db, runId), runId,
  });
  const chinese = chineseEditorialMetrics(context.db, revisionId, runId);
  const findings = allAuditFindings(section);
  const auditId = randomUUID();
  const report = buildAuditReport({
    auditId, projectId, runId, segments, section, chinese, findings,
    revisionId,
    acceptedTranslationSnapshotHash: view.acceptedTranslationSnapshotHash,
    effectiveTranslationSnapshotHash: view.effectiveTranslationSnapshotHash,
    storedSourceIndex: section.storedSourceIndex,
    editorialProfile: memory.chineseEditorialProfile || null,
  });
  store.saveQualityAudit(projectId, report);
  store.appendEvent(projectId, runId || null, 'quality-audit.completed', {
    auditId, sourceRevisionId: revisionId, metrics: report.metrics,
  });
  return report;
}

/**
 * 前置校验：空来源、仍在运行的 Run、以及「指定 runId 必须已结束」这三种情况都拒绝审计。
 * "partial" 是终结状态而非活跃 worker，它的缺失译文正是审计要看的东西，因此不拦。
 */
function assertAuditPreconditions(runId: string | undefined, context: any, segments: any[]): void {
  if (!segments.length) fail('当前来源版本没有可审计的片段。', 409);
  // 每个文档项目有自己的 SQLite 库，所以这里每一行都属于本项目。
  // "partial" 是终态而不是还在跑的 worker：它缺的已采纳译文需要被审计。
  const active = context.db.prepare(
    "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused') LIMIT 1"
  ).get() as { run_id?: string } | undefined;
  if (active?.run_id && (!runId || runId === active.run_id)) {
    fail('当前项目仍有运行中的或已暂停的任务，请等待完成或继续运行后再审计；若需检查候选结果，请提供已结束的 runId。', 409);
  }
  if (!runId) return;
  const requestedRun = context.db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
  if (!requestedRun) fail('找不到质量审计指定的翻译运行：' + runId, 404);
  if (!['completed', 'awaiting_acceptance'].includes(String(requestedRun.status))) {
    fail('只有已完成或等待采纳的运行可以作为审计候选来源。', 409);
  }
}

/**
 * 译文视图：已采纳译文 + 可选叠加一个已结束 Run 的候选。
 * 两个快照哈希都保留——返工校验要比对用户当时看到的那一版，而不是叠加后的版本。
 */
function buildAuditTranslationView(
  context: any,
  segments: any[],
  runId?: string,
): { translations: Map<string, string>; acceptedTranslationSnapshotHash: string; effectiveTranslationSnapshotHash: string } {
  const acceptedTranslationMap = acceptedTranslations(context.db, context.currentSourceRevisionId);
  const acceptedTranslationSnapshotHash = translationSnapshotHash(segments, acceptedTranslationMap);
  const translations = new Map(acceptedTranslationMap);
  if (runId) overlayRunCandidates(context.db, context.currentSourceRevisionId, runId, translations);
  return {
    translations,
    acceptedTranslationSnapshotHash,
    effectiveTranslationSnapshotHash: translationSnapshotHash(segments, translations),
  };
}

/** 覆盖检查：没有可用译文的片段。 */
function missingTranslationFindings(
  segments: any[],
  translations: Map<string, string>,
  revisionId: string,
): any[] {
  return segments.filter((segment) => !translations.get(segment.id)?.trim()).map((segment) => ({
    findingId: stableFindingId('missing-translation', [segment.id], revisionId),
    type: 'missing-translation',
    category: 'coverage',
    severity: 'must-fix',
    repairable: true,
    segmentIds: [segment.id],
    chapter: segment.contextPath || null,
    sourceExcerpt: segment.text.slice(0, 240),
    explanation: '该来源片段没有当前可用的已采纳译文或本次运行候选译文。',
  }));
}

/** 九类确定性检查与审校发现。返回分组而不合并，因为指标要按组计数。 */
function collectAuditFindings(input: {
  projectId: string;
  context: any;
  segments: any[];
  translations: Map<string, string>;
  memory: any;
  sourceLang: string;
  runId?: string;
}) {
  const { projectId, context, segments, translations, memory, sourceLang, runId } = input;
  const revisionId = context.currentSourceRevisionId;
  const mappingConflict = canonicalNameMappingConflictFindings(segments, memory);
  const terminology = terminologyFindings(segments, translations, memory, mappingConflict.conflictedSources);
  const residue = englishResidueFindings(segments, translations, auditTargetLanguage(context.db, runId), sourceLang);
  const missing = missingTranslationFindings(segments, translations, revisionId);
  const numeric = numericFindings(segments, translations, sourceLang);

  // 源文特征索引是重复表达检测的输入；先确保存在，再读取实际使用的那一版。
  ensureSourceFeatureIndex(projectId, revisionId, sourceLang);
  const storedSourceIndex = readSourceFeatureIndex(context.db, revisionId, sourceLang);
  const repeated = repeatedExpressionFindings(segments, translations, undefined, storedSourceIndex);

  const presentIds = new Set(segments.map((segment) => segment.id));
  const output = translationOutputValidationFindings(context.db, runId, presentIds);
  const contextDelta = translationContextDeltaFindings(context.db, runId, presentIds, revisionId);
  const sourceById = new Map(segments.map((segment) => [segment.id, segment.text]));
  const mentions = entityMentionDriftFindings(
    context.db, runId, revisionId, sourceById, translations,
    Array.isArray(memory.entities) ? memory.entities : [],
  );
  const review = currentReviewFindings(context.db, revisionId, runId);
  return {
    mappingConflict, terminology, residue, missing, numeric, repeated, output, contextDelta, mentions,
    review, reviewRows: reviewFindingRows(review, presentIds), storedSourceIndex,
  };
}

/** 审校发现转成审计 finding：类型由编辑模式与维度共同决定，级别由优先级映射。 */
function reviewFindingRows(review: any, presentIds: Set<string>): any[] {
  return review.findings.filter((finding: any) => presentIds.has(finding.segmentId)).map((finding: any) => ({
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
}

/**
 * 中文单语编辑的统计口径：应用状态与双语验证状态是两个独立维度，
 * 用户决定率只统计用户真正处理过的（应用 + 拒绝），未处理的不计入分母。
 */
function chineseEditorialMetrics(db: any, revisionId: string, runId?: string) {
  const stage = chineseEditorialStageMetrics(db, revisionId, runId);
  const findings = chineseEditorialFindingsForRun(db, revisionId, stage.runId);
  const applied = findings.filter((finding: any) => finding.applicationStatus === 'applied').length;
  const autoApplied = findings.filter((finding: any) =>
    finding.applicationStatus === 'applied' && finding.applicationMethod === 'automatic-bilingual-verification').length;
  const userApplied = applied - autoApplied;
  const dismissed = findings.filter((finding: any) => finding.applicationStatus === 'dismissed').length;
  const pending = findings.filter((finding: any) => !['applied', 'dismissed'].includes(finding.applicationStatus)).length;
  const verified = findings.filter((finding: any) =>
    ['verified', 'corrected'].includes(finding.bilingualReviewStatus)).length;
  const corrected = findings.filter((finding: any) => finding.bilingualReviewStatus === 'corrected').length;
  const bilingualPending = findings.filter((finding: any) =>
    !['verified', 'corrected'].includes(finding.bilingualReviewStatus)).length;
  return {
    stage, applied, autoApplied, userApplied, dismissed, pending, verified, corrected, bilingualPending,
    userDecided: userApplied + dismissed,
    latestOverrides: countManuallyOverriddenAfterApply(db, revisionId, findings),
  };
}

/**
 * 「自动应用后被人工改写」的条数：只有当前采纳的仍是自动应用结果时才算没被覆盖，
 * 已经变成 manual 且结果 ID 不同，就说明用户最终还是自己改了。
 */
function countManuallyOverriddenAfterApply(db: any, revisionId: string, findings: any[]): number {
  return findings.filter((finding: any) => {
    if (finding.applicationStatus !== 'applied' || !finding.appliedResultId) return false;
    const latest = db.prepare(
      'SELECT result_id, origin FROM translation_results WHERE source_revision_id = ? AND segment_id = ? AND accepted = 1 ORDER BY rowid DESC LIMIT 1'
    ).get(revisionId, finding.segmentId) as { result_id?: string; origin?: string } | undefined;
    return !!latest && latest.result_id !== finding.appliedResultId && latest.origin === 'manual';
  }).length;
}

/** 每百段发生率，保留一位小数；总数为 0 时返回 0，避免除零。 */
function ratePer100Segments(count: number, total: number): number {
  return total ? Math.round(count / total * 1000) / 10 : 0;
}

/** 指标汇总：所有比率都按片段总数归一，未翻译片段也算分母，避免小样本虚高。 */
function buildAuditMetrics(input: {
  segments: any[];
  section: ReturnType<typeof collectAuditFindings>;
  chinese: ReturnType<typeof chineseEditorialMetrics>;
  findings: any[];
  editorialProfile: any;
}): Record<string, any> {
  const { segments, section, chinese, findings, editorialProfile } = input;
  const { missing, terminology, mappingConflict, residue, numeric, output, repeated, contextDelta, mentions, reviewRows } = section;
  const translatedCount = segments.length - missing.length;
  const rate = (count: number) => ratePer100Segments(count, segments.length);
  const repeatedDrift = repeated.filter((item) => item.type === 'repeated-expression-drift').length;
  const styleFindings = reviewRows.filter((item) => item.category === 'style').length;
  const characterVoiceFindings = reviewRows.filter((item) => item.type === 'character-voice-review').length;
  return {
    sourceSegmentCount: segments.length,
    translatedSegmentCount: translatedCount,
    missingTranslationCount: missing.length,
    missingTranslationRatePer100Segments: rate(missing.length),
    coveragePercent: segments.length ? Math.round(translatedCount / segments.length * 1000) / 10 : 100,
    terminologyDriftCount: terminology.length,
    terminologyDriftRatePer100Segments: rate(terminology.length),
    canonicalNameMappingConflictCount: mappingConflict.findings.length,
    englishResidueCount: residue.length,
    englishResidueRatePer100Segments: rate(residue.length),
    numericTokenMismatchCount: numeric.length,
    numericTokenMismatchRatePer100Segments: rate(numeric.length),
    duplicateOutputIdFindingCount: output.filter((item: any) => item.type === 'duplicate-output-id').length,
    malformedOutputFindingCount: output.filter((item: any) => item.type === 'malformed-output-row').length,
    unexpectedOutputIdFindingCount: output.filter((item: any) => item.type === 'unexpected-output-id').length,
    repeatedExpressionDriftGroups: repeatedDrift,
    contextDeltaConflictCount: contextDelta.length,
    entityMentionDriftCount: mentions.length,
    repeatedExpressionAlignmentReviewCount: repeated.filter((item) => item.type === 'repeated-expression-alignment-review').length,
    repeatedExpressionDriftRatePer100Segments: rate(repeatedDrift),
    accuracyReviewFindingCount: reviewRows.filter((item) => item.category === 'accuracy').length,
    reviewerTerminologyFindingCount: reviewRows.filter((item) => item.category === 'terminology').length,
    styleReviewFindingCount: styleFindings,
    styleFindingRatePer100Segments: rate(styleFindings),
    characterVoiceFindingCount: characterVoiceFindings,
    characterVoiceFindingRatePer100Segments: rate(characterVoiceFindings),
    chineseEditorial: {
      runId: chinese.stage.runId,
      reviewedSegmentCount: chinese.stage.reviewedCount,
      editedSegmentCount: chinese.stage.editedCount,
      unchangedSegmentCount: chinese.stage.unchangedCount,
      uncoveredSegmentCount: chinese.stage.uncoveredCount,
      editRatePercent: chinese.stage.reviewedCount
        ? Math.round(chinese.stage.editedCount / chinese.stage.reviewedCount * 1000) / 10 : null,
      unchangedRatePercent: chinese.stage.reviewedCount
        ? Math.round(chinese.stage.unchangedCount / chinese.stage.reviewedCount * 1000) / 10 : null,
      findingCount: chinese.stage.findingCount,
      bilingualVerifiedFindingCount: chinese.verified,
      bilingualCorrectedFindingCount: chinese.corrected,
      bilingualPendingFindingCount: chinese.bilingualPending,
      automaticallyAppliedFindingCount: chinese.autoApplied,
      userAppliedFindingCount: chinese.userApplied,
      userDismissedFindingCount: chinese.dismissed,
      pendingUserDecisionFindingCount: chinese.pending,
      userDecisionAcceptanceRatePercent: chinese.userDecided
        ? Math.round(chinese.userApplied / chinese.userDecided * 1000) / 10 : null,
      manuallyOverriddenAfterApplyCount: chinese.latestOverrides,
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
  };
}

/** 把九组 finding 合并成一个扁平列表；指标统计与修复流程都从这里取数，保证口径一致。 */
function allAuditFindings(section: ReturnType<typeof collectAuditFindings>): any[] {
  return [
    ...section.missing, ...section.mappingConflict.findings, ...section.terminology, ...section.residue,
    ...section.numeric, ...section.repeated, ...section.output, ...section.contextDelta,
    ...section.mentions, ...section.reviewRows,
  ];
}

/** 报告装配：分析上限与解释文案是契约的一部分，改检查口径时必须同步改这里。 */
function buildAuditReport(input: {
  auditId: string;
  projectId: string;
  runId?: string;
  revisionId: string;
  segments: any[];
  section: ReturnType<typeof collectAuditFindings>;
  chinese: ReturnType<typeof chineseEditorialMetrics>;
  findings: any[];
  acceptedTranslationSnapshotHash: string;
  effectiveTranslationSnapshotHash: string;
  storedSourceIndex: any;
  editorialProfile: any;
}): Record<string, any> {
  const { auditId, projectId, runId, revisionId, segments, section, findings, storedSourceIndex } = input;
  return {
    auditId,
    projectId,
    sourceRevisionId: revisionId,
    runId: runId || null,
    // 用聚合哈希来防过期修复，即使书很长也能保持有界。
    translationSnapshotHash: input.effectiveTranslationSnapshotHash,
    acceptedTranslationSnapshotHash: input.acceptedTranslationSnapshotHash,
    reviewRunId: section.review.reviewRunId,
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
    metrics: buildAuditMetrics({
      segments,
      section,
      findings,
      chinese: input.chinese,
      editorialProfile: input.editorialProfile,
    }),
    interpretation: AUDIT_INTERPRETATION,
    findings,
  };
}

const AUDIT_INTERPRETATION = [
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
];
