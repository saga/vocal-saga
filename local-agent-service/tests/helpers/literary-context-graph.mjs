/**
 * Literary-run tests must model the same preprocessing precondition as production.
 * This creates a completed, empty graph for the current source/language at the same
 * analysis version as production; tests that exercise graph contents should continue
 * to build their own nodes/evidence explicitly.
 */
import { CONTEXT_GRAPH_ANALYSIS_VERSION } from '../../src/documents/contextGraphSchema.ts';

export function ensureTestContextGraph(store, project) {
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const prompt = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get();
  const config = prompt?.config_json ? JSON.parse(prompt.config_json) : {};
  if ((config.translationMode || 'technical') !== 'literary') return;
  // Create only the run ledger needed by createRun; graph-content tests use the full production schema.
  db.exec(
    'CREATE TABLE IF NOT EXISTS context_graph_runs (' +
    'run_id TEXT PRIMARY KEY, source_revision_id TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, ' +
    'progress_json TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT)'
  );
  const existing = db.prepare(
    'SELECT run_id, progress_json FROM context_graph_runs WHERE source_revision_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
  ).get(currentSourceRevisionId, 'completed');
  if (existing) {
    let progress = {};
    try { progress = JSON.parse(existing.progress_json); } catch { /* replace invalid test fixture */ }
    if (progress.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION &&
        progress.sourceLang === (config.sourceLang || 'auto') &&
        progress.targetLang === (config.targetLang || 'zh')) return;
  }
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_runs(run_id, source_revision_id, status, phase, progress_json, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
  ).run(
    'test-context-graph-' + currentSourceRevisionId + '-' + Date.now(),
    currentSourceRevisionId,
    'completed',
    'completed',
    JSON.stringify({
      analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
      sourceLang: config.sourceLang || 'auto',
      targetLang: config.targetLang || 'zh',
      segmentCount: Number(db.prepare('SELECT COUNT(*) AS count FROM source_segments WHERE source_revision_id = ?').get(currentSourceRevisionId)?.count || 0),
      testFixture: true,
    }),
    now,
    now,
  );
}
