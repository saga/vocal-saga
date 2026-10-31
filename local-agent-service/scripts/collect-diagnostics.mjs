#!/usr/bin/env node
/**
 * Export the two most recently updated document projects and their persisted
 * analysis/translation trajectories. No wall-clock log window is involved.
 *
 * Usage:
 *   npm run diagnose:bundle
 *   npm run diagnose:bundle -- --analyze
 *   npm run diagnose:bundle -- --out /tmp/vocal-saga-diagnostics
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
const generatedAt = new Date().toISOString();
const bundleName = 'local-agent-diagnostics-' + generatedAt.replace(/[:.]/g, '-');
const bundleDir = path.join(outputRoot, bundleName);
fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|local_agent_token)\s*[:=]\s*)["']?[^\s"',;]+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
];
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
function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}
function rows(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); }
  catch (error) {
    return { collectionError: error instanceof Error ? error.message : String(error) };
  }
}
function safeProjectDbPath(projectId, catalogPathValue) {
  const expected = path.resolve(documentsDir, projectId, 'project.sqlite');
  const candidate = path.resolve(typeof catalogPathValue === 'string' && catalogPathValue ? catalogPathValue : expected);
  if (candidate !== expected) throw new Error('项目数据库路径与项目 ID 不匹配，已拒绝读取');
  return candidate;
}
function summarizeDocument(project, db) {
  const metaRows = rows(db, 'SELECT key, value FROM project_meta');
  const meta = Array.isArray(metaRows) ? Object.fromEntries(metaRows.map((row) => [row.key, row.value])) : {};
  const revisions = rows(db, 'SELECT revision_id, file_name, format, source_fingerprint, parser_version, segment_count, created_at, source_file_size FROM source_revisions ORDER BY created_at DESC');
  const currentRevisionId = meta.current_source_revision_id || revisions[0]?.revision_id || null;
  const runs = rows(db, 'SELECT * FROM translation_runs ORDER BY created_at DESC');
  const runIds = Array.isArray(runs) ? runs.map((run) => run.run_id) : [];
  const sourceSegments = currentRevisionId
    ? rows(db, 'SELECT segment_id, ordinal, text, kind, context_path, page, level, marker, path, start_time, end_time, source_hash FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal', currentRevisionId)
    : [];
  const tables = {
    promptRevisions: rows(db, 'SELECT prompt_revision_id, name, system_prompt, user_prompt_template, config_json, fingerprint, created_at FROM prompt_revisions ORDER BY created_at DESC'),
    literaryMemoryRevisions: rows(db, 'SELECT memory_revision_id, version, memory_json, fingerprint, created_at FROM literary_memory_revisions ORDER BY created_at DESC'),
    runs,
    runSegments: rows(db, 'SELECT * FROM run_segments ORDER BY updated_at'),
    translationResults: rows(db, 'SELECT * FROM translation_results ORDER BY created_at'),
    reviewFindings: rows(db, 'SELECT * FROM review_findings ORDER BY finding_id'),
    translationBriefs: rows(db, 'SELECT * FROM translation_briefs ORDER BY run_id, batch_index'),
    translationContextDeltas: rows(db, 'SELECT * FROM translation_context_deltas ORDER BY run_id, first_ordinal'),
    qualityAudits: rows(db, 'SELECT * FROM quality_audits ORDER BY created_at DESC'),
    qualityEvaluations: rows(db, 'SELECT * FROM quality_evaluations ORDER BY created_at DESC'),
    events: rows(db, 'SELECT event_id, run_id, event_type, payload_json, created_at FROM project_events ORDER BY event_id'),
  };
  const statusCounts = {};
  if (Array.isArray(tables.runSegments)) {
    for (const row of tables.runSegments) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  }
  const eventCounts = {};
  if (Array.isArray(tables.events)) {
    for (const event of tables.events) eventCounts[event.event_type] = (eventCounts[event.event_type] || 0) + 1;
  }
  const runSummary = Array.isArray(runs) ? runs.map((run) => ({
    runId: run.run_id, status: run.status, createdAt: run.created_at, startedAt: run.started_at,
    finishedAt: run.finished_at, provider: run.provider, model: run.model,
    sourceLang: run.source_lang, targetLang: run.target_lang, translationMode: run.translation_mode,
    reviewEnabled: Boolean(run.review_enabled), error: run.error,
    scope: parseJson(run.scope_json), sourceRevisionId: run.source_revision_id,
  })) : [];
  const reviewFindingCategories = {};
  if (Array.isArray(tables.reviewFindings)) {
    for (const finding of tables.reviewFindings) {
      const key = finding.category + '/' + finding.priority + '/' + finding.status;
      reviewFindingCategories[key] = (reviewFindingCategories[key] || 0) + 1;
    }
  }
  const eventTimeline = Array.isArray(tables.events) ? tables.events.map((event) => {
    const payload = parseJson(event.payload_json);
    return {
      eventId: event.event_id, runId: event.run_id, type: event.event_type, createdAt: event.created_at,
      payload: Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
        !/(text|content|prompt|translation|source|excerpt|quote|response|body)/i.test(key) &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null)
      )),
    };
  }) : [];
  const analysisSignals = {
    runs: runSummary, eventTimeline, reviewFindingCategories,
    qualityAuditSummaries: Array.isArray(tables.qualityAudits) ? tables.qualityAudits.map((item) => ({
      auditId: item.audit_id, runId: item.run_id, createdAt: item.created_at,
      reportPreview: JSON.stringify(parseJson(item.report_json)).slice(0, 6000),
    })) : [],
  };
  return {
    document: {
      projectId: project.project_id, title: project.title, format: project.format,
      sourceFileName: project.source_file_name, createdAt: project.created_at,
      updatedAt: project.updated_at, currentSourceRevisionId: currentRevisionId,
      sourceFingerprint: project.source_fingerprint,
    },
    projectMeta: meta,
    sourceRevisions: revisions,
    currentSourceSegments: sourceSegments,
    runSummary,
    metrics: {
      sourceSegmentCount: Array.isArray(sourceSegments) ? sourceSegments.length : null,
      runCount: runIds.length,
      runSegmentStatusCounts: statusCounts,
      eventTypeCounts: eventCounts,
      translationResultCount: Array.isArray(tables.translationResults) ? tables.translationResults.length : null,
      reviewFindingCount: Array.isArray(tables.reviewFindings) ? tables.reviewFindings.length : null,
      translationBriefCount: Array.isArray(tables.translationBriefs) ? tables.translationBriefs.length : null,
    },
    records: tables,
  };
}
function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return { unparseable: true }; }
}
function collectLatestDocuments() {
  if (!fs.existsSync(catalogPath)) return { documents: [], error: '文档项目目录或 catalog.sqlite 不存在' };
  const catalog = openReadOnly(catalogPath);
  try {
    const projects = catalog.prepare(
      'SELECT project_id, title, format, source_file_name, source_fingerprint, db_path, created_at, updated_at ' +
      'FROM document_projects WHERE archived = 0 ORDER BY updated_at DESC, created_at DESC LIMIT 2'
    ).all();
    const documents = [];
    for (const project of projects) {
      const projectDbPath = safeProjectDbPath(project.project_id, project.db_path);
      if (!fs.existsSync(projectDbPath)) {
        documents.push({ document: { projectId: project.project_id, title: project.title }, error: '项目 SQLite 文件不存在' });
        continue;
      }
      const db = openReadOnly(projectDbPath);
      try {
        const document = summarizeDocument(project, db);
        const safeName = String(project.project_id).replace(/[^a-zA-Z0-9-]/g, '');
        writeJson('documents/' + safeName + '.json', document);
        documents.push({
          projectId: project.project_id, title: project.title, format: project.format,
          updatedAt: project.updated_at, metrics: document.metrics,
          runSummary: document.runSummary,
          analysisSignals: document.analysisSignals,
          exportedFile: 'documents/' + safeName + '.json',
        });
      } finally {
        db.close();
      }
    }
    return { documents, selectedCount: projects.length, selection: '最新更新的两个未归档文档项目（按 document_projects.updated_at DESC）' };
  } finally {
    catalog.close();
  }
}
function run(command, commandArgs, timeout = 8000) {
  const result = spawnSync(command, commandArgs, { cwd: serviceDir, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  return {
    status: result.status,
    stdout: redact((result.stdout || '').slice(0, 4000)),
    stderr: redact((result.stderr || '').slice(0, 2000)),
    error: result.error ? result.error.message : undefined,
  };
}
async function runCodeBuddyAnalysis(summary) {
  const sdk = await import('@tencent-ai/agent-sdk');
  const analysisInput = {
    selection: summary.selection,
    documents: summary.documents.map((doc) => ({
      title: doc.title, format: doc.format, updatedAt: doc.updatedAt,
      metrics: doc.metrics, signals: doc.analysisSignals ? {\n        runs: doc.analysisSignals.runs,\n        eventTimeline: doc.analysisSignals.eventTimeline.slice(-250),\n        reviewFindingCategories: doc.analysisSignals.reviewFindingCategories,\n        qualityAuditSummaries: doc.analysisSignals.qualityAuditSummaries,\n      } : null,
    })),
    instructions: [
      '只分析这两个最近更新的文档项目，不要扩展到其他项目或系统日志。',
      '重点检查分析阶段和翻译阶段的执行轨迹、事件顺序、批次状态、Reviewer、失败/重试/回退、自动采纳及最终完成情况。',
      '区分数据库中有记录的事实、推测和缺失的观测数据。指出两个文档之间是否存在共同问题。',
      '不要重写或复述大段原文/译文；输出中文诊断报告，给出证据对应的 projectId/runId/eventType。',
    ],
  };
  const stream = sdk.query({
    prompt: '请分析以下两个最新文档项目的翻译流水线诊断摘要，按要求输出结论：\n\n' + JSON.stringify(analysisInput, null, 2),
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
const summary = {
  generatedAt, selection: collection.selection || '最新两个未归档文档项目',
  selectedCount: collection.selectedCount || 0,
  documents: collection.documents || [],
  collectionError: collection.error || null,
  host: {
    platform: os.platform(), release: os.release(), arch: os.arch(),
    node: process.version, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
  },
  service: {
    package: JSON.parse(fs.readFileSync(path.join(serviceDir, 'package.json'), 'utf8')).name,
    provider: process.env.LOCAL_AGENT_PROVIDER || 'workbuddy',
    port: process.env.LOCAL_AGENT_PORT || '8789',
  },
  checks: {
    health: run(process.execPath, ['-e', "fetch('http://127.0.0.1:'+(process.env.LOCAL_AGENT_PORT||8789)+'/health').then(async r=>{console.log('HTTP '+r.status);console.log((await r.text()).slice(0,500));}).catch(e=>{console.error(e.message);process.exitCode=1})"]),
  },
};
writeJson('summary.json', summary);
const readme = [
  'Vocal Saga Local Agent - latest two document projects diagnostic bundle',
  'Generated: ' + generatedAt,
  'Selection: latest two non-archived document projects by document_projects.updated_at.',
  'No 12-hour/24-hour log window is used. No general SDK transcript or machine log directories are scanned.',
  '',
  'Each documents/*.json contains the project metadata, source revisions and source segments, all persisted translation runs, run-segment states, translation results, review findings, TranslationBrief snapshots, context deltas, quality audit/evaluation records, and the ordered project event timeline.',
  '',
  'PRIVACY: These document records intentionally include source text, translated text, review findings and persisted prompts because they are needed to diagnose translation quality. Review the two JSON files before sharing. Original EPUB/PDF binaries, unrelated documents, request-history database rows and SDK session transcripts are not included.',
  analyze ? 'CodeBuddy analysis was requested; see codebuddy-analysis.md.' : 'No model analysis was run. Add --analyze to call the local CodeBuddy SDK.',
].join('\n') + '\n';
fs.writeFileSync(path.join(bundleDir, 'README.txt'), readme, { mode: 0o600 });

if (analyze) {
  try {
    const report = await runCodeBuddyAnalysis(summary);
    fs.writeFileSync(path.join(bundleDir, 'codebuddy-analysis.md'), report + '\n', { mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(path.join(bundleDir, 'codebuddy-analysis-error.txt'), redact(error instanceof Error ? error.stack || error.message : String(error)) + '\n', { mode: 0o600 });
  }
}

const archivePath = bundleDir + '.tar.gz';
const tar = spawnSync('tar', ['-czf', archivePath, '-C', outputRoot, bundleName], { encoding: 'utf8' });
if (tar.status !== 0) {
  console.error('Bundle directory: ' + bundleDir);
  console.error(tar.stderr || 'tar failed');
  process.exitCode = 1;
} else {
  console.log('Diagnostic bundle: ' + archivePath);
  console.log('Selected documents: ' + summary.selectedCount);
  for (const doc of summary.documents) console.log('- ' + doc.title + ': ' + (doc.metrics?.runCount ?? 'n/a') + ' runs, ' + (doc.metrics?.sourceSegmentCount ?? 'n/a') + ' source segments');
  if (summary.collectionError) console.error(summary.collectionError);
  console.log('Review the included source/translation records before uploading the archive.');
}
