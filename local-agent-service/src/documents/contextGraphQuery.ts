/**
 * Context Graph 的读取与人工审阅：状态、快照、节点/边的确认与拒绝。
 *
 * 从 contextGraph 抽出：读路径只依赖存储层与运行状态，不触发分析，
 * 单独成模块后可以让 UI 侧的读取逻辑独立演进。
 */

import { getDocumentProjectStore } from './projectStore.ts';
import {
  assertNoActiveTranslation,
  getMeta,
  graphContext,
  safeText,
  uniqueStrings,
} from './contextGraphStore.ts';
import { activeAnalyses, reconcileOrphanedContextGraphRun } from './contextGraphRun.ts';
import { CONTEXT_GRAPH_ANALYSIS_VERSION } from './contextGraphSchema.ts';

/**
 * 返回轻量的 Context Graph 状态 DTO（不含节点/边/证据载荷）。
 * 供扩展轮询使用；包含版本、计数、run 状态与文风字段。
 */
export function getContextGraphStatus(projectId: string, runId?: string): Record<string, any> {
  const { db, revisionId } = graphContext(projectId);
  const segmentCount = Number((db.prepare(
    'SELECT COUNT(*) AS count FROM source_segments WHERE source_revision_id = ?'
  ).get(revisionId) as any)?.count || 0);
  const nodeCounts = db.prepare(
    'SELECT kind, COUNT(*) AS count FROM context_graph_nodes WHERE source_revision_id = ? GROUP BY kind'
  ).all(revisionId) as Array<{ kind: string; count: number }>;
  const countForKind = (kind: string) => Number(nodeCounts.find((item) => item.kind === kind)?.count || 0);
  const counts = {
    characters: countForKind('character'),
    entities: countForKind('entity'),
    relationships: Number((db.prepare(
      'SELECT COUNT(*) AS count FROM context_graph_edges WHERE source_revision_id = ?'
    ).get(revisionId) as any)?.count || 0),
    chapters: Number((db.prepare(
      'SELECT COUNT(*) AS count FROM context_graph_chapters WHERE source_revision_id = ?'
    ).get(revisionId) as any)?.count || 0),
    evidencedNodes: Number((db.prepare(
      'SELECT COUNT(DISTINCT node_id) AS count FROM context_graph_evidence WHERE source_revision_id = ? AND node_id IS NOT NULL'
    ).get(revisionId) as any)?.count || 0),
  };
  const activeRows = db.prepare(
    "SELECT run_id FROM context_graph_runs WHERE source_revision_id = ? AND status IN ('queued','running')"
  ).all(revisionId) as Array<{ run_id: string }>;
  for (const activeRow of activeRows) {
    if (activeAnalyses.get(projectId) !== activeRow.run_id) {
      reconcileOrphanedContextGraphRun(
        projectId, db, activeRow.run_id,
        '检测到没有对应执行任务的陈旧预处理记录；已收敛为失败，可重新分析。',
      );
    }
  }
  const recentRows = db.prepare(
    "SELECT * FROM context_graph_runs WHERE source_revision_id = ? ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END, started_at DESC, rowid DESC LIMIT 10"
  ).all(revisionId) as any[];
  const row = runId
    ? db.prepare('SELECT * FROM context_graph_runs WHERE source_revision_id = ? AND run_id = ?').get(revisionId, runId) as any
    : (recentRows[0] || null);
  if (row && ['queued', 'running'].includes(String(row.status))) {
    // Recover a stale active status if completion was committed before process exit.
    const completion = db.prepare(
      "SELECT payload_json, created_at FROM project_events WHERE run_id = ? AND event_type = 'context-graph.completed' ORDER BY created_at DESC LIMIT 1"
    ).get(row.run_id) as { payload_json?: string; created_at?: string } | undefined;
    if (completion) {
      let payload: any = {};
      try { payload = JSON.parse(completion.payload_json || '{}'); } catch { payload = {}; }
      if (payload.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION) {
        const completedAt = completion.created_at || new Date().toISOString();
        db.prepare(
          "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', finished_at = COALESCE(finished_at, ?), error = NULL WHERE run_id = ? AND status IN ('queued','running')"
        ).run(completedAt, row.run_id);
        row.status = 'completed';
        row.phase = 'completed';
        row.finished_at = row.finished_at || completedAt;
        row.error = null;
      }
    }
  }
  let progress: Record<string, any> = {};
  try { progress = row ? JSON.parse(row.progress_json) : {}; } catch { progress = {}; }
  const status = String(row?.status || 'not-started');
  const rowsForResponse = runId ? (row ? [row] : []) : recentRows;
  const runs = rowsForResponse.map((item: any) => {
    let itemProgress: Record<string, any> = {};
    try { itemProgress = JSON.parse(item.progress_json || '{}'); } catch { itemProgress = {}; }
    return {
      runId: item.run_id, status: String(item.status || 'not-started'), phase: item.phase,
      progress: itemProgress, startedAt: item.started_at, finishedAt: item.finished_at, error: item.error,
      active: activeAnalyses.get(projectId) === item.run_id && ['queued', 'running'].includes(String(item.status)),
    };
  });
  const styleFields = {
    narrativeStyle: safeText(getMeta(db, revisionId, 'narrativeStyle'), 1000),
    styleRegister: safeText(getMeta(db, revisionId, 'styleRegister'), 1000),
    styleRhythm: safeText(getMeta(db, revisionId, 'styleRhythm'), 1000),
    styleDialogue: safeText(getMeta(db, revisionId, 'styleDialogue'), 1000),
    styleDiction: safeText(getMeta(db, revisionId, 'styleDiction'), 1000),
  };
  const styleRules = uniqueStrings(getMeta(db, revisionId, 'styleRules'), 24, 240);
  const styleAvoid = uniqueStrings(getMeta(db, revisionId, 'styleAvoid'), 16, 240);
  const requiredStyleFields: Array<[string, string]> = [
    ['narrativeStyle', styleFields.narrativeStyle],
    ['styleRegister', styleFields.styleRegister],
    ['styleRhythm', styleFields.styleRhythm],
    ['styleDialogue', styleFields.styleDialogue],
    ['styleDiction', styleFields.styleDiction],
  ] as const;
  const styleMissingFields = requiredStyleFields.filter(([, value]) => !value.trim()).map(([key]) => key)
    .concat(styleRules.length ? [] : ['styleRules']);
  // UI/status DTO only: never return graph nodes, edges, evidence or chapter summaries while polling.
  return {
    sourceRevisionId: revisionId, segmentCount,
    // analysisVersion 是「这条记录由哪个版本产出」，currentAnalysisVersion 是「服务端当前版本」。
    // 扩展必须比较这两者，不能自己硬编码版本号，否则服务端升版后扩展会一直误报「版本过旧」。
    analysisVersion: String(progress.analysisVersion || ''),
    currentAnalysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    styleGuideReady: status === 'completed' && progress.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION,
    styleMissingFields,
    styleFieldCoverage: Object.fromEntries(requiredStyleFields.map(([key, value]) => [key, !!value.trim()])),
    styleGuideUpdatedAt: row?.finished_at || null,
    overview: {
      ...styleFields,
      styleRules,
      styleAvoid,
    },
    counts, status, phase: row?.phase || 'not-started', runId: row?.run_id || null,
    progress, startedAt: row?.started_at || null, finishedAt: row?.finished_at || null,
    error: row?.error || '', runs,
  };
}

/**
 * 返回完整的 Context Graph（节点、边、证据、章节摘要、runs）。
 * 供管理/调试界面使用；会尝试收敛陈旧 run 状态。
 */
export function getContextGraph(projectId: string): Record<string, unknown> {
  const { db, revisionId } = graphContext(projectId);
  const segmentCount = Number((db.prepare('SELECT COUNT(*) AS count FROM source_segments WHERE source_revision_id = ?').get(revisionId) as any)?.count || 0);
  const nodes = db.prepare('SELECT * FROM context_graph_nodes WHERE source_revision_id = ? ORDER BY kind, name LIMIT 500').all(revisionId) as any[];
  const edges = db.prepare('SELECT * FROM context_graph_edges WHERE source_revision_id = ? ORDER BY kind LIMIT 800').all(revisionId) as any[];
  const runs = db.prepare('SELECT * FROM context_graph_runs WHERE source_revision_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 10').all(revisionId) as any[];
  // The completion event is committed with the graph transaction. This read still reconciles
  // databases created by older versions, where the row and terminal event could diverge.
  for (const run of runs) {
    if (!['queued', 'running'].includes(String(run.status))) continue;
    const completion = db.prepare(
      "SELECT payload_json, created_at FROM project_events WHERE run_id = ? AND event_type = 'context-graph.completed' ORDER BY created_at DESC LIMIT 1"
    ).get(run.run_id) as { payload_json?: string; created_at?: string } | undefined;
    if (!completion) continue;
    let payload: any = {};
    try { payload = JSON.parse(completion.payload_json || '{}'); } catch { payload = {}; }
    if (payload.analysisVersion !== CONTEXT_GRAPH_ANALYSIS_VERSION) continue;
    const completedAt = completion.created_at || new Date().toISOString();
    db.prepare(
      "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', finished_at = COALESCE(finished_at, ?), error = NULL WHERE run_id = ? AND status IN ('queued','running')"
    ).run(completedAt, run.run_id);
    run.status = 'completed';
    run.phase = 'completed';
    run.finished_at = run.finished_at || completedAt;
    run.error = null;
  }
  const evidence = db.prepare(
    'SELECT e.node_id, e.edge_id, e.segment_id, e.quote, e.role, s.ordinal AS source_ordinal, s.context_path AS source_context_path ' +
    'FROM context_graph_evidence e LEFT JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
    'WHERE e.source_revision_id = ?'
  ).all(revisionId) as any[];
  const evidenceByNode = new Map<string, any[]>();
  const evidenceByEdge = new Map<string, any[]>();
  for (const row of evidence) {
    const map = row.node_id ? evidenceByNode : evidenceByEdge;
    const key = row.node_id || row.edge_id;
    if (!key) continue;
    const current = map.get(key) || [];
    if (current.length < 3) current.push({
      segmentId: row.segment_id, quote: row.quote, role: row.role,
      ...(row.source_ordinal != null && Number.isInteger(Number(row.source_ordinal)) ? { ordinal: Number(row.source_ordinal) } : {}),
      ...(typeof row.source_context_path === 'string' && row.source_context_path ? { chapter: row.source_context_path } : {}),
    });
    map.set(key, current);
  }
  const chapters = db.prepare(
    'SELECT chapter_title AS title, chapter_order AS orderIndex, summary, summary_kind AS summaryKind, segment_ids_json AS segmentIds ' +
    'FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order'
  ).all(revisionId).map((row: any) => ({
    title: row.title, order: row.orderIndex, summary: row.summary, summaryKind: row.summaryKind,
    segmentIds: (() => { try { return JSON.parse(row.segmentIds); } catch { return []; } })(),
  }));
  return {
    sourceRevisionId: revisionId,
    segmentCount,
    overview: {
      bookSummary: getMeta(db, revisionId, 'bookSummary'),
      narrativeStyle: getMeta(db, revisionId, 'narrativeStyle'),
      styleRegister: getMeta(db, revisionId, 'styleRegister') || '',
      styleRhythm: getMeta(db, revisionId, 'styleRhythm') || '',
      styleDialogue: getMeta(db, revisionId, 'styleDialogue') || '',
      styleDiction: getMeta(db, revisionId, 'styleDiction') || '',
      styleRules: getMeta(db, revisionId, 'styleRules') || [],
      styleAvoid: getMeta(db, revisionId, 'styleAvoid') || [],
    },
    counts: {
      characters: nodes.filter((node) => node.kind === 'character').length,
      entities: nodes.filter((node) => node.kind === 'entity').length,
      relationships: edges.length,
      chapters: chapters.length,
      evidencedNodes: nodes.filter((node) => (evidenceByNode.get(node.node_id) || []).length > 0).length,
    },
    nodes: nodes.map((node) => ({
      id: node.node_id, kind: node.kind, name: node.name, status: node.status,
      attributes: JSON.parse(node.attributes_json), evidence: evidenceByNode.get(node.node_id) || [],
    })),
    edges: edges.map((edge) => ({
      id: edge.edge_id, sourceNodeId: edge.source_node_id, targetNodeId: edge.target_node_id,
      kind: edge.kind, status: edge.status, attributes: JSON.parse(edge.attributes_json),
      evidence: evidenceByEdge.get(edge.edge_id) || [],
    })),
    chapters,
    runs: runs.map((run) => ({
      runId: run.run_id, status: run.status, phase: run.phase,
      progress: (() => { try { return JSON.parse(run.progress_json); } catch { return {}; } })(),
      startedAt: run.started_at, finishedAt: run.finished_at, error: run.error,
    })),
  };
}

/**
 * 保存用户对图谱节点/边的 candidate、confirmed 或 rejected 决策。
 * 明确确认与模型候选必须保持不同状态；当前有翻译 Run 时拒绝修改，避免某批次正在使用的
 * 上下文和随后读取到的图谱版本发生未记录的漂移。
 */
export function reviewContextGraphItems(
  projectId: string,
  items: Array<{ type: 'node' | 'edge'; id: string; status: 'candidate' | 'confirmed' | 'rejected' }>,
  memory?: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(items) || !items.length || items.length > 500) {
    throw Object.assign(new Error('review items 必须是 1-500 条记录的数组。'), { status: 400 });
  }
  const normalized = items.map((item) => ({
    type: item?.type,
    id: typeof item?.id === 'string' ? item.id.trim() : '',
    status: item?.status,
  }));
  const seen = new Set<string>();
  for (const item of normalized) {
    if (!['node', 'edge'].includes(String(item.type)) || !item.id ||
        !['candidate', 'confirmed', 'rejected'].includes(String(item.status))) {
      throw Object.assign(new Error('每条 review item 需要 type=node|edge、id 和 status=candidate|confirmed|rejected。'), { status: 400 });
    }
    const key = String(item.type) + ':' + item.id;
    if (seen.has(key)) throw Object.assign(new Error('review items 不得包含重复项。'), { status: 400 });
    seen.add(key);
  }

  const { db, revisionId } = graphContext(projectId);
  const store = getDocumentProjectStore();
  const reviewed: Array<Record<string, unknown>> = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Serialize against Run creation so a batch cannot be partially applied while a translation starts.
    assertNoActiveTranslation(projectId, db);
    for (const item of normalized) {
      const table = item.type === 'node' ? 'context_graph_nodes' : 'context_graph_edges';
      const key = item.type === 'node' ? 'node_id' : 'edge_id';
      const row = db.prepare(
        'SELECT status FROM ' + table + ' WHERE ' + key + ' = ? AND source_revision_id = ?',
      ).get(item.id, revisionId) as { status?: string } | undefined;
      if (!row) throw Object.assign(new Error('找不到当前来源版本中的 Context Graph 项：' + item.id), { status: 404 });
      if (item.status === 'confirmed') {
        const evidence = db.prepare(
          'SELECT 1 FROM context_graph_evidence WHERE source_revision_id = ? AND ' + key + ' = ? LIMIT 1',
        ).get(revisionId, item.id);
        if (!evidence) throw Object.assign(new Error('没有可核验的原文证据，不能确认此项：' + item.id), { status: 409 });
      }
      reviewed.push({
        type: item.type, id: item.id, previousStatus: row.status,
        status: item.status, sourceRevisionId: revisionId,
      });
    }
    const now = new Date().toISOString();
    for (const item of normalized) {
      const table = item.type === 'node' ? 'context_graph_nodes' : 'context_graph_edges';
      const key = item.type === 'node' ? 'node_id' : 'edge_id';
      const sql = 'UPDATE ' + table +
        ' SET status = ?, attributes_json = json_set(attributes_json, \'$.adoptionSource\', ?), updated_at = ? WHERE ' +
        key + ' = ? AND source_revision_id = ?';
      db.prepare(sql).run(
        item.status,
        item.status === 'rejected' ? 'user-rejected' : item.status === 'confirmed' ? 'user-confirmed' : 'model-default',
        now, item.id, revisionId,
      );
    }
    // When the caller supplies the updated LiteraryMemory projection, persist it under the
    // same SQLite write transaction as graph rejections. A failed memory validation rolls back
    // every node/edge decision instead of leaving the two projections out of sync.
    if (memory !== undefined) store.saveLiteraryMemory(projectId, memory);
    for (const item of reviewed) {
      store.appendEvent(projectId, null, 'context-graph.reviewed', {
        type: item.type, id: item.id, previousStatus: item.previousStatus,
        status: item.status, sourceRevisionId: revisionId,
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already have rolled back */ }
    throw error;
  }

  return reviewed;
}

/**
 * 单条 reviewContextGraphItems 的便捷封装。
 */
export function reviewContextGraphItem(
  projectId: string,
  type: 'node' | 'edge',
  id: string,
  status: 'candidate' | 'confirmed' | 'rejected',
): Record<string, unknown> {
  return reviewContextGraphItems(projectId, [{ type, id, status }])[0]!;
}
