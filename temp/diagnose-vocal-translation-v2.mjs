#!/usr/bin/env node
/**
 * Read-only diagnostics for inconsistent literary names and untranslated English residue.
 * Run from local-agent-service with Node supporting node:sqlite.
 * It writes a compact JSON report containing only segments matching --name (default Yabu)
 * or English residue matching --word (default again), plus per-batch name-protection facts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
}
function safeJson(value, fallback = null) {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}
function trunc(value, max = 260) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function existsTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function maybeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function maybeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return undefined; }
}
function eventPayload(row) {
  return safeJson(row?.payload_json, {} ) || {};
}
function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s._'’\-]+/g, ' ').trim();
}
function isNameMappingFor(mapping, name) {
  const wanted = normalize(name);
  if (!wanted) return false;
  return [mapping?.source, ...(Array.isArray(mapping?.aliases) ? mapping.aliases : [])]
    .some((candidate) => {
      const normalized = normalize(candidate);
      return !!normalized && (normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized));
    });
}
function sourceFormAppears(text, value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const isLatinName = /^[A-Za-z0-9][A-Za-z0-9\s._'’\-]*$/u.test(raw);
  try {
    const escaped = escapeRegex(raw).split(/\s+/u).join('\\s+');
    const pattern = isLatinName
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
      : new RegExp(escaped, 'iu');
    return pattern.test(String(text || ''));
  } catch { return false; }
}
function confirmedMemoryMappingsInSource(memory, sourceText, name) {
  const entities = Array.isArray(memory?.entities) ? memory.entities : [];
  return entities.filter((entity) => {
    if (entity?.reviewStatus !== 'confirmed' || !String(entity?.source || '').trim() || !String(entity?.target || '').trim()) return false;
    const forms = [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])].filter(Boolean);
    return isNameMappingFor(entity, name) && forms.some((form) => sourceFormAppears(sourceText, form));
  }).map((entity) => ({
    source: entity.source, target: entity.target, aliases: entity.aliases || [],
    reviewStatus: entity.reviewStatus, targetConfidence: entity.targetConfidence || null,
    targetEvidenceRefCount: Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs.length : 0,
  }));
}
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function firstOrdinalForName(sourceRows, name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const isLatinName = /^[A-Za-z0-9][A-Za-z0-9\s._'’\-]*$/u.test(raw);
  let pattern;
  try {
    pattern = new RegExp(isLatinName
      ? `(?<![\\p{L}\\p{N}])${escapeRegex(raw).trim().split(/\s+/u).join('\\s+')}(?![\\p{L}\\p{N}])`
      : escapeRegex(raw), 'iu');
  } catch { return null; }
  const row = sourceRows.find((item) => pattern.test(String(item.text || '')));
  return row ? Number(row.ordinal) : null;
}
function readEnvValue(key) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.LOCAL_AGENT_ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(scriptDir, '.env'),
    path.resolve(scriptDir, '..', '.env'),
  ].filter(Boolean);
  for (const envPath of candidates) {
    try {
      const body = fs.readFileSync(envPath, 'utf8');
      for (const line of body.split(/\r?\n/u)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
        if (!match || match[1] !== key) continue;
        return String(match[2] || '').replace(/^(['"])(.*)\1$/u, '$2').trim();
      }
    } catch { /* this candidate .env is optional */ }
  }
  return '';
}
function readRelevantLogEvidence(dataDir, name) {
  const explicit = (process.env.LOCAL_AGENT_LOG_FILE || readEnvValue('LOCAL_AGENT_LOG_FILE') || '').trim();
  const logPath = explicit ? path.resolve(explicit) : path.join(dataDir, 'logs', 'local-agent.log');
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile()) return { path: logPath, found: false, reason: '不是普通文件', lines: [] };
    const maxBytes = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const fd = fs.openSync(logPath, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    const termPattern = new RegExp(escapeRegex(name), 'iu');
    // 兼容新 log.ts 目前可能写入的字面量 \n 分隔符，以及正常文件换行。
    const lines = buffer.toString('utf8').split(/\\n|\r?\n/u)
      .map((line) => line.trim()).filter(Boolean);
    const relevant = lines.filter((line) =>
      /canonical-terms|translation-brief|document-agent|voice-context|context-graph|batch ready/iu.test(line) &&
      (termPattern.test(line) || /canonical-terms|translation-brief|document-agent/iu.test(line)))
      .slice(-100).map((line) => trunc(line, 420));
    return { path: logPath, found: true, bytesRead: buffer.length, truncatedAtHead: start > 0, relevantLineCount: relevant.length, lines: relevant };
  } catch (error) {
    return { path: logPath, found: false, reason: error?.code || trunc(error?.message || error, 160), lines: [] };
  }
}
function excerptRows(db, revisionId, namePattern, residuePattern) {
  const sourceRows = maybeAll(db,
    'SELECT segment_id, ordinal, text, context_path, source_hash FROM source_segments WHERE source_revision_id=? ORDER BY ordinal',
    [revisionId]);
  const accepted = maybeAll(db,
    'SELECT result_id, run_id, prompt_revision_id, segment_id, source_hash, translation_text, origin, accepted, created_at, accepted_at ' +
    'FROM translation_results WHERE source_revision_id=? AND accepted=1 ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC',
    [revisionId]);
  const latestBySegment = new Map();
  for (const row of accepted) {
    const key = `${row.segment_id}\u0000${row.source_hash}`;
    if (!latestBySegment.has(key)) latestBySegment.set(key, row);
  }
  const result = [];
  for (const source of sourceRows) {
    const tr = latestBySegment.get(`${source.segment_id}\u0000${source.source_hash}`);
    const sourceText = String(source.text || '');
    const translatedText = String(tr?.translation_text || '');
    const nameHit = namePattern.test(sourceText) || namePattern.test(translatedText);
    const residueHit = residuePattern.test(translatedText);
    if (!nameHit && !residueHit) continue;
    result.push({
      ordinal: source.ordinal,
      segmentId: source.segment_id,
      contextPath: source.context_path || '',
      source: trunc(sourceText, 320),
      translation: trunc(translatedText, 360),
      result: tr ? {
        resultId: tr.result_id,
        runId: tr.run_id,
        promptRevisionId: tr.prompt_revision_id,
        origin: tr.origin,
        acceptedAt: tr.accepted_at || tr.created_at,
      } : null,
      flags: { sourceOrTranslationMatchesName: nameHit, translationContainsEnglishResidue: residueHit },
    });
  }
  return result;
}
function buildMemorySummary(db, run, sourceOrdinalById, sourceRows, name) {
  if (!run?.literary_memory_revision_id || !existsTable(db, 'literary_memory_revisions')) return null;
  const row = maybeGet(db, 'SELECT memory_json, created_at FROM literary_memory_revisions WHERE memory_revision_id=?', [run.literary_memory_revision_id]);
  const memory = safeJson(row?.memory_json, {});
  const entityRows = (Array.isArray(memory?.entities) ? memory.entities : [])
    .filter((item) => isNameMappingFor(item, name))
    .map((item) => ({
      source: item.source,
      target: item.target,
      aliases: item.aliases || [],
      sourceFirstOrdinal: firstOrdinalForName(sourceRows, item.source),
      aliasFirstOrdinals: (item.aliases || []).map((alias) => ({ alias, firstOrdinal: firstOrdinalForName(sourceRows, alias) })),
      reviewStatus: item.reviewStatus || null,
      evidence: trunc(item.evidence, 180),
      evidenceRefs: (item.evidenceRefs || []).map((ref) => ({
        segmentId: ref.segmentId,
        ordinal: sourceOrdinalById.get(ref.segmentId) ?? null,
        sourceQuote: trunc(ref.sourceQuote, 180),
      })),
      targetConfidence: item.targetConfidence || null,
      targetEvidenceRefs: (item.targetEvidenceRefs || []).map((ref) => ({
        segmentId: ref.segmentId,
        ordinal: sourceOrdinalById.get(ref.segmentId) ?? null,
        targetSurface: trunc(ref.targetSurface, 100),
      })),
    }));
  const voiceRows = (Array.isArray(memory?.characterVoices) ? memory.characterVoices : [])
    .filter((item) => isNameMappingFor({ source: item.canonicalSourceName, aliases: item.aliases }, name))
    .map((item) => ({
      canonicalSourceName: item.canonicalSourceName,
      targetName: item.targetName || null,
      aliases: item.aliases || [],
      sourceFirstOrdinal: firstOrdinalForName(sourceRows, item.canonicalSourceName),
      aliasFirstOrdinals: (item.aliases || []).map((alias) => ({ alias, firstOrdinal: firstOrdinalForName(sourceRows, alias) })),
      status: item.status || null,
      useForTranslation: item.useForTranslation !== false,
      evidence: (item.evidence || []).map((ref) => ({
        segmentId: ref.segmentId,
        ordinal: sourceOrdinalById.get(ref.segmentId) ?? null,
        sourceQuote: trunc(ref.sourceQuote, 180),
      })),
    }));
  return { revisionId: run.literary_memory_revision_id, createdAt: row?.created_at || null, entities: entityRows, characterVoices: voiceRows };
}
function parsePromptPayload(userPrompt) {
  const raw = String(userPrompt || '');
  const delimiter = '请处理以下 JSON 数据：\n';
  const index = raw.lastIndexOf(delimiter);
  const candidates = index >= 0 ? [raw.slice(index + delimiter.length).trim()] : [raw.trim()];
  for (const candidate of candidates) {
    const parsed = safeJson(candidate, null);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

const configuredDataDir = process.env.LOCAL_AGENT_DATA_DIR || readEnvValue('LOCAL_AGENT_DATA_DIR') || path.join(os.homedir(), '.vocal-saga-local-agent');
const dataDir = path.resolve(arg('data-dir', configuredDataDir));
const rootDir = path.join(dataDir, 'documents');
const requestedProjectId = arg('project-id');
const requestedRunId = arg('run-id');
const name = arg('name', 'Yabu');
const word = arg('word', 'again');
const outputPath = path.resolve(arg('out', path.join(os.tmpdir(), `vocal-translation-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)));
const namePattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
const residuePattern = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

if (!fs.existsSync(rootDir)) {
  console.error(`没有找到文档工作区：${rootDir}\n请检查 LOCAL_AGENT_DATA_DIR，或使用 --data-dir 指定服务的数据目录。`);
  process.exit(2);
}

let projectRows = [];
const catalogPath = path.join(rootDir, 'catalog.sqlite');
if (fs.existsSync(catalogPath)) {
  let catalog;
  try {
    catalog = new DatabaseSync(catalogPath, { readOnly: true });
    projectRows = maybeAll(catalog,
      'SELECT project_id, title, format, source_file_name, updated_at, archived FROM document_projects WHERE archived=0 ORDER BY updated_at DESC');
  } finally { try { catalog?.close(); } catch {} }
}
if (!projectRows.length) {
  projectRows = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(rootDir, entry.name, 'project.sqlite')))
    .map((entry) => ({ project_id: entry.name, title: entry.name, format: '', source_file_name: '', updated_at: '', archived: 0 }));
}
if (requestedProjectId) projectRows = projectRows.filter((p) => p.project_id === requestedProjectId);

const report = {
  reportVersion: 'vocal-translation-diagnostic-v2',
  generatedAt: new Date().toISOString(),
  dataDir,
  filters: { name, englishResidueWord: word, projectId: requestedProjectId || null, runId: requestedRunId || null },
  note: 'Read-only report. Text excerpts are limited to segments matching the requested name or English word; prompts, tokens and full model responses are not exported. The latest report also compares calculated protection counts with the source markers actually present in the submitted prompt.',
  runtimeLogEvidence: readRelevantLogEvidence(dataDir, name),
  projects: [],
};

for (const project of projectRows) {
  const dbPath = path.join(rootDir, project.project_id, 'project.sqlite');
  if (!fs.existsSync(dbPath)) continue;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if (!existsTable(db, 'translation_runs') || !existsTable(db, 'source_segments')) continue;
    const runs = maybeAll(db,
      'SELECT run_id, source_revision_id, prompt_revision_id, literary_memory_revision_id, status, provider, model, source_lang, target_lang, translation_mode, review_enabled, created_at, finished_at, error ' +
      'FROM translation_runs ORDER BY created_at DESC');
    const selectedRuns = runs.filter((run) => !requestedRunId || run.run_id === requestedRunId).slice(0, requestedRunId ? 1 : 6);
    if (requestedRunId && !selectedRuns.length) continue;
    const projectReport = {
      projectId: project.project_id,
      title: project.title || project.source_file_name || project.project_id,
      format: project.format || null,
      dbPath,
      matchingAcceptedTranslations: [],
      runs: [],
    };
    for (const run of selectedRuns) {
      const sourceRows = maybeAll(db,
        'SELECT segment_id, ordinal, text, context_path FROM source_segments WHERE source_revision_id=? ORDER BY ordinal',
        [run.source_revision_id]);
      const sourceOrdinalById = new Map(sourceRows.map((row) => [row.segment_id, row.ordinal]));
      const promptRow = maybeGet(db,
        'SELECT config_json, name, fingerprint FROM prompt_revisions WHERE prompt_revision_id=?', [run.prompt_revision_id]);
      const promptConfig = safeJson(promptRow?.config_json, {});
      const matchingTranslations = excerptRows(db, run.source_revision_id, namePattern, residuePattern);
      const pinnedMemoryRow = run.literary_memory_revision_id && existsTable(db, 'literary_memory_revisions')
        ? maybeGet(db, 'SELECT memory_json FROM literary_memory_revisions WHERE memory_revision_id=?', [run.literary_memory_revision_id])
        : null;
      const pinnedMemory = safeJson(pinnedMemoryRow?.memory_json, {});
      const events = maybeAll(db,
        'SELECT event_id, event_type, payload_json, created_at FROM project_events WHERE run_id=? ORDER BY event_id', [run.run_id]);
      const promptEvents = [];
      const protectedEvents = [];
      const responseEvents = [];
      const reviewEvents = [];
      for (const event of events) {
        const payload = eventPayload(event);
        if (event.event_type === 'batch.prompt.ready') {
          const audit = payload.audit || {};
          const parsedPayload = parsePromptPayload(audit.userPrompt);
          const sourceSegments = Array.isArray(audit.sourceSegments) ? audit.sourceSegments : [];
          const segments = Array.isArray(parsedPayload?.segments) ? parsedPayload.segments : [];
          const segmentRows = sourceSegments.filter((segment) => namePattern.test(String(segment?.text || '')))
            .map((segment) => {
              const submitted = segments.find((item) => item?.id === segment.id);
              const source = String(segment.text || '');
              const sentText = String(submitted?.text || '');
              const graphMappings = Array.isArray(parsedPayload?.contextGraph?.nameMappings) ? parsedPayload.contextGraph.nameMappings : [];
              const relevantMappings = graphMappings.filter((mapping) => isNameMappingFor(mapping, name));
              const memoryMappings = confirmedMemoryMappingsInSource(pinnedMemory, source, name);
              const graphMappingsCoverSource = relevantMappings.filter((mapping) =>
                [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
                  .some((form) => sourceFormAppears(source, form)));
              const confirmedMemoryExpectedButMarkerMissing = memoryMappings.length > 0 &&
                !/__VSA_TERM_\d+__/u.test(sentText);
              return {
                segmentId: segment.id,
                source: trunc(source, 260),
                textActuallySentToModel: trunc(sentText, 260),
                protectedMarkerSent: /__VSA_TERM_\d+__/u.test(sentText),
                mappingSeenInPrompt: relevantMappings.map((mapping) => ({
                  source: mapping.source, target: mapping.target, aliases: mapping.aliases || [], sourceStatus: mapping.sourceStatus || null,
                })),
                graphMappingsCoveringThisSource: graphMappingsCoverSource.map((mapping) => ({
                  source: mapping.source, target: mapping.target, aliases: mapping.aliases || [], sourceStatus: mapping.sourceStatus || null,
                })),
                confirmedMemoryMappingsCoveringThisSource: memoryMappings,
                confirmedMemoryExpectedButMarkerMissing,
                probableMaskingMismatch: confirmedMemoryExpectedButMarkerMissing,
              };
            });
          promptEvents.push({
            eventId: event.event_id,
            batchIndex: payload.batchIndex ?? null,
            requestId: payload.requestId || null,
            provider: payload.provider || null,
            model: payload.model || null,
            segmentCount: payload.segmentCount ?? null,
            protectedCanonicalTermCount: payload.protectedCanonicalTermCount ?? null,
            contextGraphIncluded: payload.contextGraphIncluded ?? null,
            translationBriefHash: payload.translationBriefHash || null,
            translationBriefChars: payload.translationBriefChars ?? null,
            contextGraphNameMappingPreview: Array.isArray(payload.contextGraphNameMappingPreview)
              ? payload.contextGraphNameMappingPreview.filter((mapping) => isNameMappingFor(mapping, name))
              : [],
            promptSystemHasNoEnglishResidueRule: typeof audit.systemPrompt === 'string' &&
              audit.systemPrompt.includes('不得原样保留源语言单词'),
            matchingSourceSegments: segmentRows,
            confirmedMemoryMaskMismatchCount: segmentRows.filter((row) => row.confirmedMemoryExpectedButMarkerMissing).length,
            promptPayloadParseSucceeded: !!parsedPayload,
          });
        } else if (event.event_type === 'canonical-terms.protected') {
          protectedEvents.push({
            eventId: event.event_id,
            batchIndex: payload.batchIndex ?? null,
            mappingCount: payload.mappingCount ?? null,
            protectedSegmentCount: payload.protectedSegmentCount ?? null,
            rejectedSegmentCount: payload.rejectedSegmentCount ?? null,
            missingMarkerSegmentIds: payload.missingMarkerSegmentIds || [],
          });
        } else if (event.event_type === 'batch.model.response') {
          const audit = payload.audit || {};
          const accepted = Array.isArray(audit.acceptedTranslations) ? audit.acceptedTranslations : [];
          const raw = audit.response && typeof audit.response === 'object' ? audit.response : {};
          const rawTranslations = Array.isArray(raw.translations) ? raw.translations : [];
          const hits = accepted.filter((item) => residuePattern.test(String(item?.text || '')) ||
            namePattern.test(String(item?.text || '')) || namePattern.test(String(sourceRows.find((s) => s.segment_id === item?.id)?.text || '')))
            .map((item) => ({
              segmentId: item.id,
              source: trunc(sourceRows.find((s) => s.segment_id === item.id)?.text || '', 260),
              acceptedTranslation: trunc(item.text, 360),
              rawModelText: trunc(rawTranslations.find((row) => row?.id === item.id)?.translated_text || '', 360),
              hasEnglishResidue: residuePattern.test(String(item.text || '')),
            }));
          if (hits.length) responseEvents.push({ eventId: event.event_id, batchIndex: payload.batchIndex ?? null, requestId: payload.requestId || null, hits });
        } else if (/^review\.|^stage\.started$/.test(event.event_type)) {
          reviewEvents.push({ eventType: event.event_type, eventId: event.event_id,
            stage: payload.stage || null, batchIndex: payload.batchIndex ?? null,
            reviewType: payload.reviewType || null, findingsCount: Array.isArray(payload.findings) ? payload.findings.length : null });
        }
      }
      const briefRows = maybeAll(db,
        'SELECT batch_index, brief_hash, brief_chars, brief_json, created_at FROM translation_briefs WHERE run_id=? ORDER BY batch_index', [run.run_id]);
      const nameMappingsByBatch = briefRows.map((row) => {
        const brief = safeJson(row.brief_json, {});
        const mappings = Array.isArray(brief?.contextGraph?.nameMappings) ? brief.contextGraph.nameMappings : [];
        return {
          batchIndex: row.batch_index,
          briefHash: row.brief_hash,
          briefChars: row.brief_chars,
          contextPolicyVersion: brief.policyVersion || brief.contextGraph?.policyVersion || null,
          matchingNameMappings: mappings.filter((mapping) => isNameMappingFor(mapping, name)).map((mapping) => ({
            source: mapping.source, target: mapping.target, aliases: mapping.aliases || [], sourceStatus: mapping.sourceStatus || null,
          })),
          contextDiagnostics: brief.contextDiagnostics ? {
            graphNameMappingsBeforeBudget: brief.contextDiagnostics.graphNameMappingsBeforeBudget ?? null,
            graphNameMappingsAfterBudget: brief.contextDiagnostics.graphNameMappingsAfterBudget ?? null,
            strongNameMappingsBeforeBudget: brief.contextDiagnostics.strongNameMappingsBeforeBudget ?? null,
            strongNameMappingsAfterBudget: brief.contextDiagnostics.strongNameMappingsAfterBudget ?? null,
            graphNameMappingExcludedNameNotVisible: brief.contextDiagnostics.graphNameMappingExcludedNameNotVisible ?? null,
            graphNameMappingExcludedEvidenceNotVisible: brief.contextDiagnostics.graphNameMappingExcludedEvidenceNotVisible ?? null,
          } : null,
        };
      });
      const memorySummary = buildMemorySummary(db, run, sourceOrdinalById, sourceRows, name);
      projectReport.runs.push({
        run: {
          runId: run.run_id,
          status: run.status,
          sourceRevisionId: run.source_revision_id,
          promptRevisionId: run.prompt_revision_id,
          memoryRevisionId: run.literary_memory_revision_id || null,
          provider: run.provider,
          model: run.model,
          sourceLang: run.source_lang,
          targetLang: run.target_lang,
          translationMode: run.translation_mode,
          reviewEnabled: !!run.review_enabled,
          createdAt: run.created_at,
          finishedAt: run.finished_at,
          error: trunc(run.error, 240),
          promptName: promptRow?.name || null,
          promptConfig: { literaryReview: promptConfig.literaryReview ?? null, translationMode: promptConfig.translationMode ?? null },
        },
        yabuOrRequestedNameMemory: memorySummary,
        pinnedMemoryMappings: (Array.isArray(pinnedMemory?.entities) ? pinnedMemory.entities : [])
          .filter((entity) => entity?.reviewStatus === 'confirmed' && isNameMappingFor(entity, name))
          .map((entity) => ({ source: entity.source, target: entity.target, aliases: entity.aliases || [],
            reviewStatus: entity.reviewStatus, targetConfidence: entity.targetConfidence || null,
            targetEvidenceRefCount: Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs.length : 0 })),
        matchingSegmentsInAcceptedResults: matchingTranslations,
        perBatchBriefNameMappings: nameMappingsByBatch,
        perBatchPromptAndMasking: promptEvents,
        canonicalTermProtectionEvents: protectedEvents,
        rawModelAndAcceptedOutputHits: responseEvents,
        reviewEvents,
      });
    }
    projectReport.matchingAcceptedTranslations = selectedRuns.length
      ? excerptRows(db, selectedRuns[0].source_revision_id, namePattern, residuePattern)
      : [];
    if (projectReport.runs.length) report.projects.push(projectReport);
  } catch (error) {
    report.projects.push({ projectId: project.project_id, title: project.title || project.project_id, error: trunc(error?.stack || error, 600) });
  } finally {
    try { db?.close(); } catch {}
  }
}

fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
const runCount = report.projects.reduce((sum, project) => sum + (project.runs?.length || 0), 0);
const nameCount = report.projects.reduce((sum, project) => sum + (project.matchingAcceptedTranslations || []).filter((row) => row.flags.sourceOrTranslationMatchesName).length, 0);
const residueCount = report.projects.reduce((sum, project) => sum + (project.matchingAcceptedTranslations || []).filter((row) => row.flags.translationContainsEnglishResidue).length, 0);
const maskMismatchCount = report.projects.reduce((sum, project) => sum + (project.runs || []).reduce((runSum, run) => runSum + (run.perBatchPromptAndMasking || []).reduce((eventSum, event) => eventSum + (event.confirmedMemoryMaskMismatchCount || 0), 0), 0), 0);
console.log(`诊断完成：项目 ${report.projects.length} 个，运行 ${runCount} 次；当前结果中匹配 ${name} 的片段约 ${nameCount} 条，包含 ${word} 的译文约 ${residueCount} 条，疑似“记忆规范译名已计入保护数但实际 Prompt 未遮罩” ${maskMismatchCount} 处。`);
console.log(`报告已写入：${outputPath}`);
console.log('报告不包含完整 Prompt 或整批模型响应；仍含少量匹配片段原文/译文及相关日志摘要，分享前可先检查。');
if (!report.projects.length) {
  console.log('未找到项目。检查 --data-dir / LOCAL_AGENT_DATA_DIR，或加 --project-id 和 --run-id 精确限定。');
}
