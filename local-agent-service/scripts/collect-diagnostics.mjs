#!/usr/bin/env node
/**
 * Export compact, privacy-aware diagnostics for the two most recently updated
 * document projects. Source/translation bodies and raw prompt/audit/event payloads
 * are deliberately excluded; the bundle keeps counts, identifiers, state changes,
 * failure details and a bounded lifecycle-log excerpt.
 *
 * Usage:
 *   npm run diagnose:bundle
 *   npm run diagnose:bundle -- --analyze
 *   npm run diagnose:bundle -- --out /tmp/vocal-saga-diagnostics
 *   npm run diagnose:bundle -- --no-logs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dataDir = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(home, '.vocal-saga-local-agent'));
const documentsDir = path.join(dataDir, 'documents');
const catalogPath = path.join(documentsDir, 'catalog.sqlite');
const outputRoot = path.resolve(argValue('--out', path.join(dataDir, 'diagnostic-bundles')));
const analyze = hasFlag('--analyze');
const collectLogs = !hasFlag('--no-logs');
const generatedAt = new Date().toISOString();
const bundleName = 'local-agent-diagnostics-' + generatedAt.replace(/[:.]/g, '-');
const bundleDir = path.join(outputRoot, bundleName);
fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

const MAX_EVENTS = 300;
const MAX_SAMPLE_IDS = 12;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_LINES = 180;
const MAX_LOG_CHARS = 64 * 1024;
const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|local_agent_token)\s*[:=]\s*)["']?[^\s"',;]+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
];
const OMIT_KEYS = /(?:text|content|prompt|translation|source|excerpt|quote|response|body|input|output|raw|transcript|arguments|toolresult)/i;
const DIAGNOSTIC_EVENT_TYPES = new Set([
  'run.planned', 'run.running', 'run.finished', 'run.completed', 'run.failed',
  'run.partial', 'run.cancelled', 'run.paused', 'run.awaiting_acceptance',
  'stage.started', 'stage.completed', 'stage.warning', 'batch.started',
  'batch.completed', 'batch.translation.completed', 'model.call.failed',
  'review.audit.failed', 'context-graph.phase', 'context-graph.failed',
  'context-graph.completed', 'quality-audit.completed', 'quality-repair.planned',
  'quality-audit.auto-repair-scheduled', 'quality-audit.auto-disposition',
  'translations.accepted', 'translations.auto-accepted',
  'translation.context-memory.persisted',
]);

function redact(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1[REDACTED]');
  if (home) text = text.split(home).join('~');
  return text;
}
function writeJson(relativePath, value) {
  const target = path.join(bundleDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function writeText(relativePath, value) {
  const target = path.join(bundleDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}
function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}
function rows(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); }
  catch (error) {
    return { collectionError: redact(error instanceof Error ? error.message : String(error)) };
  }
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; }
}
function compactScope(raw) {
  const scope = typeof raw === 'string' ? parseJson(raw, {}) : (raw || {});
  const ids = Array.isArray(scope.ids) ? scope.ids.map(String) : [];
  return {
    type: scope.type || null,
    idCount: ids.length,
    sampleIds: ids.slice(0, MAX_SAMPLE_IDS),
    idsTruncated: ids.length > MAX_SAMPLE_IDS,
    automation: scope.automation && typeof scope.automation === 'object'
      ? { kind: scope.automation.kind || null, pass: scope.automation.pass ?? null }
      : null,
  };
}
function compactValue(key, value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redact(value).slice(0, 500);
  if (Array.isArray(value)) {
    if (/(?:ids|segmentIds|sampleIds)$/i.test(key)) {
      return { count: value.length, sample: value.slice(0, 8).map((item) => redact(item).slice(0, 100)) };
    }
    if (key === 'stageResults') {
      return value.slice(0, 12).map((item) => ({
        stage: item?.stage || null,
        label: item?.label || null,
        elapsedMs: item?.elapsedMs ?? null,
        completedAt: item?.completedAt || null,
        outputCounts: compactValue('outputCounts', item?.outputCounts || {}, depth + 1),
      }));
    }
    if (key === 'completedStages') return value.slice(0, 12).map((item) => redact(item));
    return { count: value.length };
  }
  if (typeof value === 'object') {
    if (depth >= 3) return { keys: Object.keys(value).length };
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
      if (OMIT_KEYS.test(childKey)) continue;
      result[childKey] = compactValue(childKey, childValue, depth + 1);
    }
    return result;
  }
  return String(value);
}
function compactEventPayload(raw) {
  const payload = typeof raw === 'string' ? parseJson(raw, {}) : (raw || {});
  const allow = new Set([
    'stage', 'batchIndex', 'label', 'warning', 'error', 'durationMs', 'status',
    'recovery', 'reason', 'requestId', 'phase', 'strategy', 'stageIndex',
    'stageCount', 'completedStageCount', 'waveIndex', 'waveSize', 'timeoutMs', 'timeoutMs',
    'provider', 'model', 'sourceLang', 'targetLang', 'segmentCount',
    'sampleCount', 'chapterCount', 'characterCount', 'entityCount',
    'relationshipCount', 'canonicalNameMappingCount', 'invalidEvidenceCount',
    'invalidEvidenceByReason', 'invalidEvidenceByCategory', 'completedStages',
    'stageResults', 'workflowElapsedMs', 'styleFieldCoverage', 'styleRuleCount',
    'styleAvoidCount', 'styleEvidenceCount', 'modelCandidateCounts',
    'droppedCandidateCounts', 'relationshipDiagnostics', 'counts', 'usage',
    'metrics', 'auditId', 'parentRunId', 'repairRunId', 'segmentIds',
    'segmentCount', 'maximumAutomaticPasses', 'findingType',
    'automatic', 'humanAcceptanceRequired', 'findingCount',
    'automaticRepairSkipped', 'remainingFindingsAreNonBlocking',
    'inputChars', 'outputChars', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'numTurns',
  ]);
  const compact = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allow.has(key) || OMIT_KEYS.test(key)) continue;
    compact[key] = compactValue(key, value);
  }
  return compact;
}
function groupCounts(list, keyFn) {
  const counts = {};
  for (const item of list) {
    const key = String(keyFn(item) ?? 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
function summarizeGraphProgress(row) {
  const progress = parseJson(row.progress_json, {});
  const scan = progress.scan && typeof progress.scan === 'object' ? {
    strategyVersion: progress.scan.strategyVersion || null,
    nameCandidateCount: progress.scan.nameCandidateCount ?? null,
    repeatedPhraseCandidateCount: progress.scan.repeatedPhraseCandidateCount ?? null,
    dialogueSegmentCount: progress.scan.dialogueSegmentCount ?? null,
    targetedNameCount: progress.scan.targetedNameCount ?? null,
  } : null;
  return {
    runId: row.run_id, status: row.status, phase: row.phase,
    startedAt: row.started_at, finishedAt: row.finished_at,
    error: redact(row.error || '').slice(0, 500) || null,
    strategy: progress.strategy || null,
    workflowVersion: progress.workflowVersion || null,
    analysisVersion: progress.analysisVersion || null,
    sampleCount: progress.sampleCount ?? null,
    chapterCount: progress.chapterCount ?? null,
    sourceLang: progress.sourceLang || null,
    targetLang: progress.targetLang || null,
    provider: progress.provider || null,
    model: progress.model || null,
    scan,
    workflowElapsedMs: progress.workflowElapsedMs ?? null,
    completedStages: compactValue('completedStages', progress.completedStages || []),
    stageResults: compactValue('stageResults', progress.stageResults || []),
    characterCount: progress.characterCount ?? null,
    entityCount: progress.entityCount ?? null,
    relationshipCount: progress.relationshipCount ?? null,
    canonicalNameMappingCount: progress.canonicalNameMappingCount ?? null,
    invalidEvidenceCount: progress.invalidEvidenceCount ?? null,
    invalidEvidenceByReason: progress.invalidEvidenceByReason || {},
    invalidEvidenceByCategory: progress.invalidEvidenceByCategory || {},
    styleFieldCoverage: progress.styleFieldCoverage || {},
    styleRuleCount: progress.styleRuleCount ?? null,
    styleAvoidCount: progress.styleAvoidCount ?? null,
    styleEvidenceCount: progress.styleEvidenceCount ?? null,
    droppedCandidateCounts: progress.droppedCandidateCounts || {},
  };
}
function summarizeAudit(row) {
  const report = parseJson(row.report_json, {});
  const findings = asArray(report.findings);
  return {
    auditId: row.audit_id,
    runId: row.run_id || report.runId || null,
    createdAt: row.created_at || report.createdAt || null,
    sourceRevisionId: report.sourceRevisionId || null,
    reviewRunId: report.reviewRunId || null,
    metrics: report.metrics || {},
    findingCounts: groupCounts(findings, (finding) =>
      [finding.type || 'unknown', finding.category || 'unknown', finding.severity || 'unknown'].join('/')),
    findingCount: findings.length,
    sampleFindingIds: findings.slice(0, 12).map((finding) => finding.findingId).filter(Boolean),
  };
}
function summarizeDocument(project, db) {
  const metaRows = asArray(rows(db, 'SELECT key, value FROM project_meta'));
  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  const currentRevisionId = meta.current_source_revision_id || null;
  const revisions = asArray(rows(db,
    'SELECT revision_id, format, source_fingerprint, parser_version, segment_count, created_at, source_file_size ' +
    'FROM source_revisions ORDER BY created_at DESC'));
  const rawRuns = asArray(rows(db, 'SELECT * FROM translation_runs ORDER BY created_at DESC'));
  const sourceKinds = currentRevisionId ? asArray(rows(db,
    'SELECT kind, COUNT(*) AS count, SUM(length(text)) AS textChars FROM source_segments ' +
    'WHERE source_revision_id = ? GROUP BY kind ORDER BY count DESC', currentRevisionId)) : [];
  const sourceSamples = currentRevisionId ? asArray(rows(db,
    'SELECT segment_id, ordinal, kind, length(text) AS textChars, path ' +
    'FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal LIMIT 12', currentRevisionId)) : [];

  const rawRunSegments = asArray(rows(db,
    'SELECT run_id, segment_id, status, attempts, error, updated_at FROM run_segments ORDER BY updated_at'));
  const rawResults = asArray(rows(db,
    'SELECT run_id, origin, provider, model, length(translation_text) AS textChars, accepted FROM translation_results ORDER BY created_at'));
  const rawFindings = asArray(rows(db,
    'SELECT finding_id, category, priority, status FROM review_findings ORDER BY finding_id'));
  const rawBriefs = asArray(rows(db,
    'SELECT run_id, batch_index, source_revision_id, memory_revision_id, brief_hash, ' +
    'length(brief_json) AS briefChars, length(source_segment_ids_json) AS segmentIdsJsonChars, created_at ' +
    'FROM translation_briefs ORDER BY run_id, batch_index'));
  const rawDeltas = asArray(rows(db,
    'SELECT * FROM translation_context_deltas ORDER BY run_id, first_ordinal'));
  const graphMetaRows = currentRevisionId ? asArray(rows(db,
    'SELECT key, value FROM context_graph_meta WHERE source_revision_id = ? ORDER BY key', currentRevisionId)) : [];
  const graphNodeCounts = currentRevisionId ? asArray(rows(db,
    'SELECT kind, status, COUNT(*) AS count FROM context_graph_nodes ' +
    'WHERE source_revision_id = ? GROUP BY kind, status ORDER BY kind, status', currentRevisionId)) : [];
  const graphEdgeCounts = currentRevisionId ? asArray(rows(db,
    'SELECT kind, status, COUNT(*) AS count FROM context_graph_edges ' +
    'WHERE source_revision_id = ? GROUP BY kind, status ORDER BY kind, status', currentRevisionId)) : [];
  const graphEvidenceCounts = currentRevisionId ? asArray(rows(db,
    'SELECT role, COUNT(*) AS count FROM context_graph_evidence ' +
    'WHERE source_revision_id = ? GROUP BY role ORDER BY role', currentRevisionId)) : [];
  const graphChapterStats = currentRevisionId ? rows(db,
    'SELECT COUNT(*) AS count, SUM(length(summary)) AS summaryChars ' +
    'FROM context_graph_chapters WHERE source_revision_id = ?', currentRevisionId) : [];
  const graphRunRows = currentRevisionId ? asArray(rows(db,
    'SELECT run_id, status, phase, started_at, finished_at, error, progress_json ' +
    'FROM context_graph_runs WHERE source_revision_id = ? ORDER BY started_at', currentRevisionId)) : [];
  const sourceFeatureCount = currentRevisionId ? rows(db,
    'SELECT COUNT(*) AS count FROM context_graph_source_features WHERE source_revision_id = ?',
    currentRevisionId) : [];
  const auditRows = asArray(rows(db, 'SELECT audit_id, run_id, created_at, report_json FROM quality_audits ORDER BY created_at DESC'));
  const eventRows = asArray(rows(db,
    'SELECT event_id, run_id, event_type, payload_json, created_at FROM project_events ORDER BY event_id'));

  const runSummary = rawRuns.map((run) => ({
    runId: run.run_id, status: run.status,
    createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    provider: run.provider, model: run.model,
    sourceLang: run.source_lang, targetLang: run.target_lang,
    translationMode: run.translation_mode,
    reviewEnabled: Boolean(run.review_enabled),
    error: redact(run.error || '').slice(0, 1000) || null,
    scope: compactScope(run.scope_json),
    sourceRevisionId: run.source_revision_id,
    promptRevisionId: run.prompt_revision_id || null,
    literaryMemoryRevisionId: run.literary_memory_revision_id || null,
    parentRunId: run.parent_run_id || null,
  }));
  const runSegmentSummary = rawRuns.map((run) => {
    const items = rawRunSegments.filter((item) => item.run_id === run.run_id);
    return {
      runId: run.run_id,
      statusCounts: groupCounts(items, (item) => item.status),
      total: items.length,
      retryAttempts: items.reduce((sum, item) => sum + Number(item.attempts || 0), 0),
      errorCount: items.filter((item) => !!item.error).length,
      sampleNonAcceptedSegmentIds: items.filter((item) => item.status !== 'accepted')
        .slice(0, MAX_SAMPLE_IDS).map((item) => item.segment_id),
      segmentErrors: items.filter((item) => !!item.error).slice(0, 8).map((item) => ({
        segmentId: item.segment_id, status: item.status, error: redact(item.error).slice(0, 300),
      })),
    };
  });
  const resultRowsByRun = {};
  for (const result of rawResults) {
    const key = String(result.run_id || 'unknown');
    resultRowsByRun[key] ||= { total: 0, byOrigin: {}, byProviderModel: {}, textChars: 0, acceptedRows: 0 };
    const group = resultRowsByRun[key];
    group.total++;
    const origin = String(result.origin || 'unknown');
    group.byOrigin[origin] = (group.byOrigin[origin] || 0) + 1;
    const providerModel = String(result.provider || 'unknown') + '/' + String(result.model || 'unknown');
    group.byProviderModel[providerModel] = (group.byProviderModel[providerModel] || 0) + 1;
    group.textChars += Number(result.textChars || 0);
    if (result.accepted) group.acceptedRows++;
  }
  const reviewFindingCategories = groupCounts(rawFindings, (finding) =>
    [finding.category || 'unknown', finding.priority || 'unknown', finding.status || 'unknown'].join('/'));
  const eventTypeCounts = groupCounts(eventRows, (event) => event.event_type);
  const eventTimeline = eventRows.filter((event) =>
    DIAGNOSTIC_EVENT_TYPES.has(event.event_type) || /^(?:run|stage|batch)\./.test(event.event_type))
    .slice(-MAX_EVENTS)
    .map((event) => ({
      eventId: event.event_id, runId: event.run_id,
      type: event.event_type, createdAt: event.created_at,
      payload: compactEventPayload(event.payload_json),
    }));
  const memoryRows = asArray(rows(db,
    'SELECT memory_revision_id, version, memory_json, fingerprint, created_at ' +
    'FROM literary_memory_revisions ORDER BY created_at DESC'));
  const latestMemory = memoryRows[0] ? parseJson(memoryRows[0].memory_json, {}) : {};
  const latestMemorySummary = {
    revisionId: memoryRows[0]?.memory_revision_id || null,
    version: memoryRows[0]?.version ?? null,
    fingerprint: memoryRows[0]?.fingerprint || null,
    createdAt: memoryRows[0]?.created_at || null,
    bytes: String(memoryRows[0]?.memory_json || '').length,
    entityCount: asArray(latestMemory.entities).length,
    relationshipCount: asArray(latestMemory.relationships).length,
    characterVoiceCount: asArray(latestMemory.characterVoices).length,
    voiceAnchorCount: asArray(latestMemory.voiceAnchors).length,
    chapterSummaryCount: asArray(latestMemory.chapterSummaries).length,
    styleGuideFields: latestMemory.styleGuide && typeof latestMemory.styleGuide === 'object'
      ? Object.keys(latestMemory.styleGuide) : [],
    styleGuideStatus: latestMemory.styleGuideStatus || null,
  };
  const promptRows = asArray(rows(db,
    'SELECT prompt_revision_id, name, system_prompt, user_prompt_template, config_json, fingerprint, created_at ' +
    'FROM prompt_revisions ORDER BY created_at DESC'));
  const latestPrompt = promptRows[0] || {};
  const promptConfig = parseJson(latestPrompt.config_json, {});
  const promptSummary = {
    revisionId: latestPrompt.prompt_revision_id || null,
    name: latestPrompt.name || null,
    fingerprint: latestPrompt.fingerprint || null,
    createdAt: latestPrompt.created_at || null,
    systemPromptChars: String(latestPrompt.system_prompt || '').length,
    userPromptTemplateChars: String(latestPrompt.user_prompt_template || '').length,
    config: {
      sourceLang: promptConfig.sourceLang || null,
      targetLang: promptConfig.targetLang || null,
      provider: promptConfig.provider || null,
      model: promptConfig.model || null,
      translationMode: promptConfig.translationMode || null,
      literaryReview: promptConfig.literaryReview ?? null,
      translationStrategy: promptConfig.translationStrategy && typeof promptConfig.translationStrategy === 'object'
        ? Object.fromEntries(Object.entries(promptConfig.translationStrategy)
            .filter(([key, value]) => ['maxBatchSegments', 'maxConcurrentBatches', 'reviewConcurrency', 'reviewTimeoutMs'].includes(key) &&
              (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'))
        ) : {},
    },
  };
  const graphMetaSummary = graphMetaRows.map((item) => ({
    key: item.key,
    valueChars: String(item.value || '').length,
    recognizedIndex: item.key === 'sourceFeatureIndex' ? (() => {
      const index = parseJson(item.value, {});
      return {
        indexVersion: index.indexVersion || null,
        sourceLang: index.sourceLang || null,
        sourceSegmentCount: index.sourceSegmentCount ?? null,
        entityMentionCount: index.entityMentionCount ?? null,
        entityMentionLimit: index.entityMentionLimit ?? null,
        entityMentionsTruncated: index.entityMentionsTruncated ?? null,
        textUnitCount: index.textUnitCount ?? null,
        textUnitLimit: index.textUnitLimit ?? null,
        textUnitsTruncated: index.textUnitsTruncated ?? null,
        quantityMentionCount: index.quantityMentionCount ?? null,
        quantityMentionsTruncated: index.quantityMentionsTruncated ?? null,
      };
    })() : undefined,
  }));
  const graphChapter = Array.isArray(graphChapterStats) ? graphChapterStats[0] : graphChapterStats;
  const diagnostics = {
    document: {
      projectId: project.project_id, title: project.title, format: project.format,
      createdAt: project.created_at, updatedAt: project.updated_at,
      currentSourceRevisionId: currentRevisionId,
      sourceFingerprint: project.source_fingerprint,
    },
    sourceRevisions: revisions,
    source: {
      segmentCount: sourceKinds.reduce((sum, row) => sum + Number(row.count || 0), 0),
      textChars: sourceKinds.reduce((sum, row) => sum + Number(row.textChars || 0), 0),
      kinds: sourceKinds,
      metadataSamples: sourceSamples,
    },
    metrics: {
      runCount: rawRuns.length,
      runStatusCounts: groupCounts(rawRuns, (run) => run.status),
      runSegmentStatusCounts: groupCounts(rawRunSegments, (segment) => segment.status),
      translationResultCount: rawResults.length,
      translationResultsByRun: resultRowsByRun,
      reviewFindingCount: rawFindings.length,
      reviewFindingCategories,
      translationBriefCount: rawBriefs.length,
      translationBriefChars: rawBriefs.reduce((sum, item) => sum + Number(item.briefChars || 0), 0),
      translationContextDeltaCount: rawDeltas.length,
      translationContextDeltaJsonChars: rawDeltas.reduce((sum, item) =>
        sum + Object.values(item).reduce((n, value) => n + (typeof value === 'string' ? value.length : 0), 0), 0),
      eventCount: eventRows.length,
      eventTypeCounts,
      qualityAuditCount: auditRows.length,
      qualityEvaluationCount: Number(Array.isArray(rows(db, 'SELECT COUNT(*) AS count FROM quality_evaluations')) 
        ? rows(db, 'SELECT COUNT(*) AS count FROM quality_evaluations')[0]?.count || 0 : 0),
      contextGraph: {
        metaKeyCount: graphMetaRows.length,
        nodeCounts: graphNodeCounts,
        edgeCounts: graphEdgeCounts,
        evidenceCounts: graphEvidenceCounts,
        chapterCount: Number(graphChapter?.count || 0),
        chapterSummaryChars: Number(graphChapter?.summaryChars || 0),
        analysisRunCount: graphRunRows.length,
        sourceFeatureCount: Number(Array.isArray(sourceFeatureCount) ? sourceFeatureCount[0]?.count || 0 : 0),
      },
    },
    prompt: promptSummary,
    literaryMemory: latestMemorySummary,
    runs: runSummary,
    runSegments: runSegmentSummary,
    translationBriefs: rawBriefs.map((item) => ({
      runId: item.run_id, batchIndex: item.batch_index,
      sourceRevisionId: item.source_revision_id,
      memoryRevisionId: item.memory_revision_id,
      briefHash: item.brief_hash,
      briefChars: item.briefChars,
      sourceSegmentIdsJsonChars: item.segmentIdsJsonChars,
      createdAt: item.created_at,
    })),
    reviewFindings: {
      count: rawFindings.length,
      categories: reviewFindingCategories,
      sampleFindingIds: rawFindings.slice(0, 20).map((item) => item.finding_id).filter(Boolean),
    },
    qualityAudits: auditRows.map(summarizeAudit),
    contextGraph: {
      metaKeys: graphMetaSummary,
      nodeCounts: graphNodeCounts,
      edgeCounts: graphEdgeCounts,
      evidenceCounts: graphEvidenceCounts,
      chapterCount: Number(graphChapter?.count || 0),
      chapterSummaryChars: Number(graphChapter?.summaryChars || 0),
      sourceFeatureCount: Number(Array.isArray(sourceFeatureCount) ? sourceFeatureCount[0]?.count || 0 : 0),
      analysisRuns: graphRunRows.map(summarizeGraphProgress),
    },
    eventTimeline,
  };
  diagnostics.integritySignals = {
    failedRunsWithUnacceptedSegments: runSegmentSummary
      .filter((item) => ['failed', 'cancelled'].includes(String(runSummary.find((run) => run.runId === item.runId)?.status)) &&
        Number(item.statusCounts.candidate || 0) + Number(item.statusCounts.pending || 0) > 0)
      .map((item) => ({
        runId: item.runId, runStatus: runSummary.find((run) => run.runId === item.runId)?.status,
        segmentStatusCounts: item.statusCounts,
      })),
    activeRunsWithTerminalEvents: runSummary.filter((run) =>
      ['running', 'queued'].includes(String(run.status)) &&
      eventTimeline.some((event) => event.runId === run.runId &&
        ['run.finished', 'run.failed', 'run.completed', 'run.partial'].includes(event.type)))
      .map((run) => run.runId),
  };
  return {
    diagnostics,
    analysisSignals: {
      runs: runSummary,
      eventTimeline,
      reviewFindingCategories,
      qualityAudits: diagnostics.qualityAudits,
      contextGraph: diagnostics.contextGraph,
      integritySignals: diagnostics.integritySignals,
    },
  };
}
function summarizeLogExcerpt() {
  const configured = (process.env.LOCAL_AGENT_LOG_FILE || '').trim();
  const logPath = configured
    ? path.resolve(configured)
    : path.join(dataDir, 'logs', 'local-agent.log');
  if (!collectLogs) return { status: 'disabled', path: path.basename(logPath), retainedLines: 0 };
  if (!fs.existsSync(logPath)) return { status: 'missing', path: path.basename(logPath), retainedLines: 0 };
  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
    let text = '';
    try {
      const length = Math.min(stat.size, MAX_LOG_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    const allLines = text.split(/\r?\n/).filter(Boolean);
    const pattern = /(?:uncaught|unhandled|fatal|SIGTERM|SIGINT|shutdown|restart|recovered interrupted|recovery check failed|context-graph|document-projects|workbuddy|codebuddy|timeout|timed out|process interrupted|server listening|server started|server stopped|EADDRINUSE|ECONNRESET|aborted)/i;
    const skip = /(?:polling summary|response preview|prompt preview|request body|authorization\s*[:=]|bearer\s+)/i;
    const retained = allLines.filter((line) => pattern.test(line) && !skip.test(line))
      .slice(-MAX_LOG_LINES).map(redact);
    let output = [
      'Log file: ' + path.basename(logPath),
      'Bytes scanned from tail: ' + Math.min(stat.size, MAX_LOG_BYTES),
      'Total lines in scanned tail: ' + allLines.length,
      'Matching lines retained: ' + retained.length,
      stat.size > MAX_LOG_BYTES ? 'Earlier log content omitted by byte limit.' : '',
      '',
      ...retained,
    ].filter(Boolean).join('\n');
    if (output.length > MAX_LOG_CHARS) output = output.slice(-MAX_LOG_CHARS);
    return { status: 'included', path: path.basename(logPath), bytesScanned: Math.min(stat.size, MAX_LOG_BYTES), retainedLines: retained.length, content: output };
  } catch (error) {
    return { status: 'error', path: path.basename(logPath), retainedLines: 0, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}
function safeProjectDbPath(projectId, catalogPathValue) {
  const expected = path.resolve(documentsDir, projectId, 'project.sqlite');
  const candidate = path.resolve(typeof catalogPathValue === 'string' && catalogPathValue ? catalogPathValue : expected);
  if (candidate !== expected) throw new Error('项目数据库路径与项目 ID 不匹配，已拒绝读取');
  return candidate;
}
function collectLatestDocuments() {
  if (!fs.existsSync(catalogPath)) return { documents: [], error: '文档项目目录或 catalog.sqlite 不存在' };
  const catalog = openReadOnly(catalogPath);
  try {
    const projects = catalog.prepare(
      'SELECT project_id, title, format, source_fingerprint, db_path, created_at, updated_at ' +
      'FROM document_projects WHERE archived = 0 ORDER BY updated_at DESC, created_at DESC LIMIT 2'
    ).all();
    const documents = [];
    for (const project of projects) {
      const projectDbPath = safeProjectDbPath(project.project_id, project.db_path);
      if (!fs.existsSync(projectDbPath)) {
        documents.push({ projectId: project.project_id, title: project.title, error: '项目 SQLite 文件不存在' });
        continue;
      }
      const db = openReadOnly(projectDbPath);
      try {
        const result = summarizeDocument(project, db);
        const safeName = String(project.project_id).replace(/[^a-zA-Z0-9-]/g, '');
        writeJson('documents/' + safeName + '.json', result.diagnostics);
        documents.push({
          projectId: project.project_id, title: project.title, format: project.format,
          updatedAt: project.updated_at, metrics: result.diagnostics.metrics,
          runs: result.diagnostics.runs,
          analysisSignals: result.analysisSignals,
          exportedFile: 'documents/' + safeName + '.json',
        });
      } finally { db.close(); }
    }
    return {
      documents, selectedCount: projects.length,
      selection: '最新更新的两个未归档文档项目（按 document_projects.updated_at DESC）',
    };
  } finally { catalog.close(); }
}
async function runCodeBuddyAnalysis(summary, logSummary) {
  const sdk = await import('@tencent-ai/agent-sdk');
  const analysisInput = {
    selection: summary.selection,
    generatedAt,
    logSummary: {
      status: logSummary.status,
      bytesScanned: logSummary.bytesScanned || 0,
      retainedLines: logSummary.retainedLines || 0,
    },
    documents: summary.documents.map((doc) => ({
      title: doc.title, format: doc.format, updatedAt: doc.updatedAt,
      metrics: doc.metrics, signals: doc.analysisSignals || null,
    })),
    instructions: [
      '只分析这两个最新文档项目，以及有限服务日志摘录的状态/行数元信息；实际日志行单独保存在 bundle 中，本次不会传给分析模型。不要扩展到其他项目。',
      '重点检查运行状态、Run scope、批次状态、Reviewer、失败/重试/回退、服务重启与自动返工范围。',
      '区分数据库事实、推测和缺失观测。特别检查失败 Run 是否仍有 candidate/pending、终态事件计数是否与持久化行一致。',
      '检查部分 scope 的 Run 是否触发全书缺译扫描与自动返工，并判断是否造成范围扩张。',
      '不要复述原文/译文或推断不存在的服务器重启根因。给出 projectId/runId/eventType 证据。',
    ],
  };
  const stream = sdk.query({
    prompt: '请诊断以下本机翻译服务的压缩摘要，输出中文分析报告：\n\n' + JSON.stringify(analysisInput, null, 2),
    options: {
      cwd: serviceDir, settingSources: [], persistSession: false,
      tools: [], allowedTools: [], maxTurns: 1, thinking: { type: 'disabled' },
    },
  });
  let output = '';
  for await (const message of stream) {
    if (message?.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const part of message.message.content) if (part?.type === 'text') output += part.text;
    }
    if (message?.type === 'result' && message.subtype && message.subtype !== 'success') {
      throw new Error('CodeBuddy analysis failed: ' + message.subtype);
    }
  }
  return output.trim();
}

const collection = collectLatestDocuments();
const logSummary = summarizeLogExcerpt();
if (logSummary.content) writeText('service-log-excerpt.txt', logSummary.content + '\n');
delete logSummary.content;
const summary = {
  schemaVersion: 2,
  generatedAt,
  selection: collection.selection || '最新两个未归档文档项目',
  selectedCount: collection.selectedCount || 0,
  documents: collection.documents || [],
  serviceLog: logSummary,
  collectionError: collection.error || null,
};
writeJson('summary.json', summary);
const readme = [
  'Vocal Saga Local Agent - compact diagnostic bundle',
  'Generated: ' + generatedAt,
  'Selection: latest two non-archived document projects by document_projects.updated_at.',
  'Schema version: 2',
  '',
  'Included: source revision metadata; source segment counts and lengths; Prompt/LiteraryMemory revision fingerprints and compact metadata; Run scopes/statuses; run-segment state counts; translation result counts and text lengths; review finding categories; TranslationBrief size metadata; Context Graph counts and compact analysis progress; quality-audit metrics; filtered project event timeline; bounded service lifecycle/error log excerpt when available.',
  '',
  'Excluded by default: source segment bodies, translations, full Prompt text, LiteraryMemory bodies, Context Graph Source Feature rows, raw Context Graph checkpoint values, raw TranslationBrief JSON, context-delta payloads, full quality-audit finding text, raw project event payloads, source EPUB/PDF files, SDK session transcripts and unrelated documents.',
  '',
  'The service log excerpt scans at most the last 512 KiB and retains at most 180 lifecycle/error-related lines. Use --no-logs to omit it. Secret-like values and the user home path are redacted.',
  '',
  'PRIVACY: The bundle is designed to diagnose control flow and persisted state without exporting book text or translated content. It still contains project titles, stable segment IDs, model/provider names, timestamps and error messages; review before sharing.',
  analyze ? 'CodeBuddy analysis was requested; see codebuddy-analysis.md.' : 'No model analysis was run. Add --analyze to call the local CodeBuddy SDK.',
].join('\n') + '\n';
writeText('README.txt', readme);

if (analyze) {
  try {
    const report = await runCodeBuddyAnalysis(summary, logSummary);
    writeText('codebuddy-analysis.md', report + '\n');
  } catch (error) {
    writeText('codebuddy-analysis-error.txt',
      redact(error instanceof Error ? error.stack || error.message : String(error)) + '\n');
  }
}

const archivePath = bundleDir + '.tar.gz';
const tar = spawnSync('tar', ['-czf', archivePath, '-C', outputRoot, bundleName], {
  encoding: 'utf8',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (tar.status !== 0) {
  console.error('Bundle directory: ' + bundleDir);
  console.error(tar.stderr || 'tar failed');
  process.exitCode = 1;
} else {
  const archiveBytes = fs.statSync(archivePath).size;
  console.log('Diagnostic bundle: ' + archivePath);
  console.log('Archive size: ' + archiveBytes + ' bytes');
  console.log('Selected documents: ' + summary.selectedCount);
  for (const doc of summary.documents) {
    console.log('- ' + doc.title + ': ' + (doc.metrics?.runCount ?? 'n/a') +
      ' runs, ' + (doc.metrics?.sourceSegmentCount ?? 'n/a') + ' source segments');
  }
  console.log('Service log excerpt: ' + logSummary.status +
    ' (' + (logSummary.retainedLines || 0) + ' lines)');
  if (summary.collectionError) console.error(summary.collectionError);
  console.log('Source text, translations, raw prompts and large derived tables are excluded.');
}
