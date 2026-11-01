/**
 * 项目数据库的表结构与增量列迁移。
 *
 * 从 projectStore 抽出：DDL 变更是独立关注点，和「怎么读写数据」分开后，
 * 存储类只保留业务方法。Context Graph 相关的表由 contextGraph 自己的 ensureSchema 负责，
 * 这里只定义项目基础表（原文片段、Run、候选译文、审校、快照、事件）。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 建项目库的全部表与索引。使用 IF NOT EXISTS，重复执行安全，可作为启动期的补齐步骤。 */
export function createProjectSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS source_revisions (' +
    'revision_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, format TEXT NOT NULL, source_fingerprint TEXT NOT NULL, ' +
    'parser_version TEXT NOT NULL, segment_count INTEGER NOT NULL, created_at TEXT NOT NULL, source_file_path TEXT, source_file_hash TEXT, source_file_size INTEGER);' +
    'CREATE TABLE IF NOT EXISTS source_segments (' +
    'source_revision_id TEXT NOT NULL, segment_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, ' +
    'kind TEXT NOT NULL, context_path TEXT NOT NULL, page INTEGER, level INTEGER, marker TEXT, path TEXT, start_time TEXT, end_time TEXT, source_hash TEXT NOT NULL, ' +
    'PRIMARY KEY(source_revision_id, segment_id));' +
    'CREATE INDEX IF NOT EXISTS idx_source_segments_order ON source_segments(source_revision_id, ordinal);' +
    'CREATE TABLE IF NOT EXISTS prompt_revisions (' +
    'prompt_revision_id TEXT PRIMARY KEY, name TEXT NOT NULL, system_prompt TEXT NOT NULL, user_prompt_template TEXT NOT NULL, ' +
    'config_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_prompt_revisions_created ON prompt_revisions(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS literary_memory_revisions (' +
    'memory_revision_id TEXT PRIMARY KEY, version INTEGER NOT NULL, memory_json TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_literary_memory_created ON literary_memory_revisions(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS translation_runs (' +
    'run_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT NOT NULL, literary_memory_revision_id TEXT, status TEXT NOT NULL, '+
    'scope_json TEXT NOT NULL, run_fingerprint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, source_lang TEXT NOT NULL, ' +
    'target_lang TEXT NOT NULL, translation_mode TEXT NOT NULL, review_enabled INTEGER NOT NULL, parent_run_id TEXT, ' +
    'created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_runs_created ON translation_runs(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS run_segments (' +
    'run_id TEXT NOT NULL, segment_id TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, ' +
    'candidate_result_id TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, segment_id));' +
    'CREATE INDEX IF NOT EXISTS idx_run_segments_status ON run_segments(run_id, status);' +
    'CREATE TABLE IF NOT EXISTS translation_results (' +
    'result_id TEXT PRIMARY KEY, run_id TEXT, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT, segment_id TEXT NOT NULL, ' +
    'source_hash TEXT NOT NULL, run_fingerprint TEXT NOT NULL, translation_text TEXT NOT NULL, origin TEXT NOT NULL, ' +
    'accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, accepted_at TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_results_segment ON translation_results(segment_id, accepted, created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_results_run ON translation_results(run_id, created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS review_findings (' +
    'finding_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, segment_id TEXT NOT NULL, category TEXT NOT NULL, ' +
    'priority TEXT NOT NULL, finding_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', created_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_review_findings_run ON review_findings(run_id, segment_id);' +
    'CREATE TABLE IF NOT EXISTS translation_briefs (' +
    'run_id TEXT NOT NULL, batch_index INTEGER NOT NULL, source_revision_id TEXT NOT NULL, prompt_revision_id TEXT NOT NULL, ' +
    'memory_revision_id TEXT, brief_hash TEXT NOT NULL, brief_chars INTEGER NOT NULL, source_segment_ids_json TEXT NOT NULL, brief_json TEXT NOT NULL, created_at TEXT NOT NULL, ' +
    'PRIMARY KEY(run_id, batch_index));' +
    'CREATE INDEX IF NOT EXISTS idx_translation_briefs_run ON translation_briefs(run_id, batch_index);' +
    'CREATE TABLE IF NOT EXISTS translation_context_deltas (' +
    'run_id TEXT NOT NULL, first_segment_id TEXT NOT NULL, batch_index INTEGER NOT NULL, first_ordinal INTEGER NOT NULL, ' +
    'source_segment_ids_json TEXT NOT NULL, delta_json TEXT NOT NULL, validation_json TEXT NOT NULL, created_at TEXT NOT NULL, ' +
    'PRIMARY KEY(run_id, first_segment_id));' +
    'CREATE INDEX IF NOT EXISTS idx_translation_context_deltas_order ON translation_context_deltas(run_id, first_ordinal);' +
    'CREATE TABLE IF NOT EXISTS quality_audits (' +
    'audit_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, run_id TEXT, report_json TEXT NOT NULL, created_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_quality_audits_created ON quality_audits(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS quality_evaluations (' +
    'evaluation_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, before_run_id TEXT NOT NULL, after_run_id TEXT NOT NULL, ' +
    'report_json TEXT NOT NULL, blind_mapping_json TEXT NOT NULL, blind_reviews_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_quality_evaluations_created ON quality_evaluations(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS project_events (' +
    'event_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_project_events_run ON project_events(run_id, event_id);'
  );
  // SQLite 项目可能早于独立文学记忆版本表创建；增量迁移不能丢旧的 Run / Prompt / 译文。
  const runColumns = new Set(
    (db.prepare('PRAGMA table_info(translation_runs)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!runColumns.has('literary_memory_revision_id')) db.exec('ALTER TABLE translation_runs ADD COLUMN literary_memory_revision_id TEXT');
  const translationColumns = new Set(
    (db.prepare('PRAGMA table_info(translation_results)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!translationColumns.has('accepted_at')) {
    db.exec('ALTER TABLE translation_results ADD COLUMN accepted_at TEXT');
    db.exec('UPDATE translation_results SET accepted_at = created_at WHERE accepted = 1 AND accepted_at IS NULL');
  }
  const sourceColumns = new Set(
    (db.prepare('PRAGMA table_info(source_revisions)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!sourceColumns.has('source_file_path')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_path TEXT');
  if (!sourceColumns.has('source_file_hash')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_hash TEXT');
  if (!sourceColumns.has('source_file_size')) db.exec('ALTER TABLE source_revisions ADD COLUMN source_file_size INTEGER');
  const segmentColumns = new Set(
    (db.prepare('PRAGMA table_info(source_segments)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!segmentColumns.has('path')) db.exec('ALTER TABLE source_segments ADD COLUMN path TEXT');
  if (!segmentColumns.has('start_time')) db.exec('ALTER TABLE source_segments ADD COLUMN start_time TEXT');
  if (!segmentColumns.has('end_time')) db.exec('ALTER TABLE source_segments ADD COLUMN end_time TEXT');
}
