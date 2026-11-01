/**
 * 成对运行的质量指标：把各类审计结果折算成可比较的比率，用于前后两次运行的对比。
 *
 * 从 qualityAudit 抽出：指标是「汇总层」，只依赖各类审计函数与记忆读取，
 * 单独成模块后调权重、加指标都不会触碰审计主流程。
 */

import { ensureSourceFeatureIndex, readSourceFeatureIndex } from './contextGraph.ts';
import { getDocumentProjectStore } from './projectStore.ts';
import { fail } from './qualityShared.ts';
import { numericFindings } from './qualityNumeric.ts';
import { canonicalNameMappingConflictFindings, terminologyFindings } from './qualityNames.ts';
import { englishResidueFindings } from './qualityResidueFindings.ts';
import { repeatedExpressionFindings } from './qualityRepetitionFindings.ts';
import { memoryWithGlossary } from './qualityAuditData.ts';

/**
 * 计算单个 Run 的确定性质量指标与发现集合。
 */
export function runMetrics(projectId: string, runId: string): any {
  const store = getDocumentProjectStore();
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const context = store.getRunContext(projectId, runId);
  if (context.run.sourceRevisionId !== currentSourceRevisionId) fail('对照评测只支持当前同一来源版本上的运行。', 409);
  const sourceRows = db.prepare(
    'SELECT ss.segment_id AS id, ss.ordinal, ss.text, ss.kind, ss.context_path AS contextPath ' +
    'FROM run_segments rs JOIN source_segments ss ON ss.segment_id = rs.segment_id ' +
    'AND ss.source_revision_id = ? WHERE rs.run_id = ? ORDER BY ss.ordinal'
  ).all(currentSourceRevisionId, runId) as any[];
  if (!sourceRows.length) fail('运行没有可比较的片段。', 409);
  const resultRows = db.prepare(
    'SELECT rs.segment_id AS id, rs.status, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  const translationById = new Map<string, string>();
  const statusById = new Map<string, string>();
  for (const row of resultRows) {
    statusById.set(String(row.id), String(row.status));
    if (typeof row.text === 'string' && row.text.trim()) translationById.set(String(row.id), String(row.text));
  }
  const segments = sourceRows.map((row) => ({
    id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text),
    kind: String(row.kind || 'paragraph'), contextPath: String(row.contextPath || ''),
  }));
  const normalizedSegments = segments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath }));
  const auditMemory = memoryWithGlossary(context.memory, context.prompt?.config?.glossary);
  const mappingConflictAudit = canonicalNameMappingConflictFindings(normalizedSegments, auditMemory);
  const entities = terminologyFindings(
    normalizedSegments, translationById, auditMemory, mappingConflictAudit.conflictedSources,
  ).filter((item) => item.category === 'terminology');
  const sourceLang = String(context.run.sourceLang || 'auto');
  const residues = englishResidueFindings(normalizedSegments, translationById, String(context.run.targetLang || ''), sourceLang);
  const numbers = numericFindings(normalizedSegments, translationById, sourceLang);
  const scopedIds = new Set(segments.map((item) => item.id));
  ensureSourceFeatureIndex(projectId, currentSourceRevisionId, sourceLang);
  const storedSourceIndex = readSourceFeatureIndex(db, currentSourceRevisionId, sourceLang);
  const repeated = repeatedExpressionFindings(normalizedSegments, translationById, scopedIds, storedSourceIndex);
  const findings = db.prepare('SELECT category, finding_json FROM review_findings WHERE run_id = ?').all(runId) as any[];
  const styleFindings = findings.filter((row) => row.category === 'style').length;
  const voiceFindings = findings.filter((row) => {
    if (row.category !== 'style') return false;
    try { return JSON.parse(row.finding_json).dimension === 'character_voice'; } catch { return false; }
  }).length;
  const eventRows = db.prepare('SELECT event_type, payload_json FROM project_events WHERE run_id = ? ORDER BY event_id').all(runId) as any[];
  const events = eventRows.map((row) => ({ type: String(row.event_type), payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })() }));
  const translationCalls = events.filter((event) => event.type === 'batch.prompt.ready').length;
  const reviewCalls = events.filter((event) => event.type === 'stage.started' && ['review', 'style-review'].includes(String(event.payload.stage))).length;
  const translationInputChars = events.filter((event) => event.type === 'batch.prompt.ready').reduce((sum, event) =>
    sum + Number(event.payload.userPromptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const reviewerInputChars = events.filter((event) => ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage)))
    .reduce((sum, event) => sum + Number(event.payload.promptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const durationMs = events.filter((event) =>
    event.type === 'batch.model.response' || event.type === 'model.call.failed' ||
    ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage))
  ).reduce((sum, event) => sum + Number(event.payload.durationMs || 0), 0);
  const missing = segments.filter((segment) => !translationById.get(segment.id)?.trim()).length;
  const coverage = segments.length ? Math.round(((segments.length - missing) / segments.length) * 1000) / 10 : 100;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  return {
    runId,
    sourceRevisionId: currentSourceRevisionId,
    promptRevisionId: context.run.promptRevisionId,
    memoryRevisionId: context.run.literaryMemoryRevisionId,
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    provider: context.run.provider,
    model: context.run.model,
    translationMode: context.run.translationMode,
    reviewEnabled: context.run.reviewEnabled,
    status: context.run.status,
    segmentIds: segments.map((item) => item.id),
    metrics: {
      segmentCount: segments.length,
      translatedSegmentCount: segments.length - missing,
      missingTranslationCount: missing,
      missingTranslationRatePer100Segments: ratePer100(missing),
      coveragePercent: coverage,
      terminologyDriftCount: entities.length,
      terminologyDriftRatePer100Segments: ratePer100(entities.length),
      canonicalNameMappingConflictCount: mappingConflictAudit.findings.length,
      englishResidueCount: residues.length,
      englishResidueRatePer100Segments: ratePer100(residues.length),
      numericTokenMismatchCount: numbers.length,
      numericTokenMismatchRatePer100Segments: ratePer100(numbers.length),
      repeatedExpressionDriftGroups: repeated.filter((item) => item.type === 'repeated-expression-drift').length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeated.filter((item) => item.type === 'repeated-expression-drift').length),
      styleFindingCount: styleFindings,
      styleFindingRatePer100Segments: ratePer100(styleFindings),
      characterVoiceFindingCount: voiceFindings,
      characterVoiceFindingRatePer100Segments: ratePer100(voiceFindings),
      translationRequestCount: translationCalls,
      reviewerRequestCount: reviewCalls,
      totalPipelineRequestCount: translationCalls + reviewCalls,
      translationPromptChars: translationInputChars,
      reviewerPromptCharsKnown: reviewerInputChars,
      totalPromptCharsKnown: translationInputChars + reviewerInputChars,
      modelDurationMsKnown: durationMs,
      tokenAndBillingCostsAvailable: false,
    },
    findings: [...mappingConflictAudit.findings, ...entities, ...residues, ...numbers, ...repeated],
  };
}
