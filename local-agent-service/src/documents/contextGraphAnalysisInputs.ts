/**
 * 一次全书分析的输入准备：读进度与提示词配置、扫描全书、制定样本计划、写章节快照。
 * 扫描是这里最慢的一步，结果会落库并缓存源文特征索引，重跑时直接复用。
 */

import { planBookSamples, scanBookSegmentsConcurrent } from './bookScan.ts';
import {
  BOOK_SCAN_INDEX_VERSION,
  hasCurrentSourceFeatureIndex,
  persistSourceFeatureIndex,
  readySourceFeatureIndexes,
  type Segment,
} from './contextGraphSchema.ts';
import {
  chapterMap,
  readRunProgress,
  readSegments,
  safeText,
  writeChapterSnapshots,
} from './contextGraphStore.ts';
import { type ContextGraphAnalysisStrategy } from './contextGraphWorkflow.ts';
import { getDocumentProjectStore } from './projectStore.ts';

/**
 * 准备一次全书分析的输入：进度、提示词配置、全书扫描、样本计划与章节索引。
 * 扫描是这里最慢的一步，因此先把结果落库并缓存源文特征索引，重跑时直接复用。
 */
export async function prepareAnalysisInputs(store: ReturnType<typeof getDocumentProjectStore>, projectId: string, runId: string) {
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

  return {
    db, revisionId, segments, initialProgress, strategy, sourceLang, targetLang, provider, modelName,
    scan, scanDurationMs, samples, sampleReasons, sampleIds, samplesById, chapters, scanSummary,
    samplePlanDiagnostics: samplePlan.diagnostics,
  };
}
