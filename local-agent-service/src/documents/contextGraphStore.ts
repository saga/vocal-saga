/**
 * Context Graph 的读写：元信息、Run 进度、章节快照、节点与边、工作流检查点。
 *
 * 从 contextGraph 抽出：这些函数都是「按某个键读写 SQLite」，不决定分析顺序，
 * 单独成模块后分析编排只调用它们，不再关心表结构细节。
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDocumentProjectStore } from './projectStore.ts';
import {
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphAnalysisStrategy,
  type ContextGraphWorkflowStageId,
} from './contextGraphWorkflow.ts';
import { ensureSchema, type Evidence, type Segment } from './contextGraphSchema.ts';

/**
 * 将任意值规范化为小写、NFKC 归一化后的字符串。
 * 统一引号、连字符与空白，用于名称/别名匹配、节点 ID 生成与证据去重。
 */
export function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

const sourceSegmentsByRevision = new Map<string, Array<{ ordinal: number; text: string }>>();

/**
 * 读取并缓存指定来源版本的全部源片段（ordinal + text）。
 * Revisions are immutable，因此可安全缓存；最多保留两份完整索引，
 * 避免每次候选名称的时间边界检查都重复查询 SQLite。
 */
export function allSourceSegments(db: any, revisionId: string): Array<{ ordinal: number; text: string }> {
  const cached = sourceSegmentsByRevision.get(revisionId);
  if (cached) {
    sourceSegmentsByRevision.delete(revisionId);
    sourceSegmentsByRevision.set(revisionId, cached);
    return cached;
  }
  // Revisions are immutable. Cache at most two full source indexes so temporal name checks
  // never rely on SQLite's punctuation-sensitive instr() prefilter for every candidate name.
  const rows = db.prepare(
    'SELECT ordinal, text FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(revisionId) as Array<{ ordinal: number; text: string }>;
  sourceSegmentsByRevision.set(revisionId, rows);
  while (sourceSegmentsByRevision.size > 2) {
    const oldest = sourceSegmentsByRevision.keys().next().value;
    if (oldest) sourceSegmentsByRevision.delete(oldest);
    else break;
  }
  return rows;
}

/**
 * 判断某个名称是否出现在源文本中。
 * 英文/拉丁名称要求按单词边界匹配，避免子串误判；
 * 其他语言退化为子串包含判断。用于实体价值评估、别名可见性与时间边界过滤。
 */
export function sourceNameMatches(sourceInput: unknown, nameInput: unknown): boolean {
  const source = normalize(sourceInput);
  const name = normalize(nameInput);
  if (!source || !name || name.length < 2) return false;
  if (/^[a-z0-9 ._'’-]+$/i.test(name)) {
    const haystack = ' ' + source.replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
    const needle = name.replace(/[^a-z0-9]+/gi, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return source.includes(name);
}

/**
 * 对字符串计算 SHA-256 十六进制摘要，用于生成稳定的节点/边 ID。
 */
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 将任意值安全转换为字符串：移除控制字符、折叠空白、截断到指定长度。
 * 用于所有模型输出字段的清洗与入库，防止超长或含控制字符的文本破坏存储。
 */
export function safeText(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

/**
 * 将数组中的字符串清洗、去重并限制数量与长度，返回稳定列表。
 */
export function uniqueStrings(value: unknown, limit = 12, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => safeText(item, maxLength)).filter(Boolean))).slice(0, limit);
}

/**
 * 校验引文是否能在源文本中找到（规范化后子串包含）。
 * 证据校验的基础函数：quote 必须是对应 segment 中连续出现的短引文。
 */
function hasQuote(source: string, quote: string): boolean {
  const sourceNorm = normalize(source);
  const quoteNorm = normalize(quote);
  return quoteNorm.length >= 4 && sourceNorm.includes(quoteNorm);
}

/**
 * 断言当前没有正在运行的翻译 Run。
 * 允许忽略一个精确匹配的 queued Run（预处理阶段的自身 Run），
 * 其余任何 queued/running/paused/awaiting/partial Run 都会阻断图谱修改，
 * 防止翻译过程中图谱版本发生未记录的漂移。
 */
export function assertNoActiveTranslation(projectId: string, db: DatabaseSync, ignoreQueuedRunId?: string): void {
  // The worker may prepare Context Graph before moving its own Run from queued to running.
  // Ignore only that exact queued Run; all other active translations still block graph mutation.
  const active = ignoreQueuedRunId
    ? db.prepare(
        "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') " +
        "AND NOT (run_id = ? AND status = 'queued') LIMIT 1"
      ).get(ignoreQueuedRunId) as { run_id?: string } | undefined
    : db.prepare(
        "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') LIMIT 1"
      ).get() as { run_id?: string } | undefined;
  if (active?.run_id) {
    throw Object.assign(
      new Error('翻译运行 ' + active.run_id + ' 尚未完成，不能在运行中修改 Context Graph；请先完成、采纳或取消该运行。'),
      { status: 409 },
    );
  }
}

/**
 * 解析项目对应的 SQLite 数据库与当前（或指定）来源版本 ID。
 * 若指定的 revisionId 不是当前版本，则校验其存在于 source_revisions，
 * 保证后续所有读写都在合法的来源版本上进行。
 */
export function graphContext(projectId: string, sourceRevisionId?: string): { db: DatabaseSync; revisionId: string } {
  const context = getDocumentProjectStore().getProjectContext(projectId);
  ensureSchema(context.db);
  const revisionId = sourceRevisionId || context.currentSourceRevisionId;
  if (revisionId !== context.currentSourceRevisionId) {
    const exists = context.db.prepare('SELECT 1 FROM source_revisions WHERE revision_id = ?').get(revisionId);
    if (!exists) throw Object.assign(new Error('找不到指定的原文版本：' + revisionId), { status: 404 });
  }
  return { db: context.db, revisionId };
}

/**
 * 读取指定来源版本的全部源片段，并转换为 Segment 结构。
 */
export function readSegments(projectId: string): { db: DatabaseSync; revisionId: string; segments: Segment[] } {
  const context = graphContext(projectId);
  const rows = context.db.prepare(
    'SELECT segment_id, ordinal, text, kind, context_path FROM source_segments ' +
    'WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(context.revisionId) as any[];
  return {
    db: context.db,
    revisionId: context.revisionId,
    segments: rows.map((row) => ({
      id: String(row.segment_id), ordinal: Number(row.ordinal), text: String(row.text),
      kind: String(row.kind || 'paragraph'), contextPath: String(row.context_path || ''),
    })),
  };
}

/**
 * 按 contextPath 将源片段分组为章节列表，保持出现顺序。
 */
export function chapterMap(segments: Segment[]): Array<{ key: string; title: string; order: number; segments: Segment[] }> {
  const chapters: Array<{ key: string; title: string; order: number; segments: Segment[] }> = [];
  const byKey = new Map<string, { key: string; title: string; order: number; segments: Segment[] }>();
  for (const segment of segments) {
    const title = segment.contextPath || '正文';
    const key = title;
    let chapter = byKey.get(key);
    if (!chapter) {
      chapter = { key, title, order: chapters.length, segments: [] };
      chapters.push(chapter);
      byKey.set(key, chapter);
    }
    chapter.segments.push(segment);
  }
  return chapters;
}

/**
 * 为一组章节片段生成抽取式摘要：取前几段正文开头与最后一段结尾拼接，
 * 用于无模型摘要时的确定性兜底，以及当前章节前缀摘要。
 */
export function extractiveSummary(chapterSegments: Segment[]): string {
  const body = chapterSegments.filter((segment) => segment.kind !== 'heading');
  if (!body.length) return chapterSegments[0]?.text.slice(0, 480) || '';
  const first = body.slice(0, 3).map((segment) => segment.text.trim()).join(' ').slice(0, 420);
  const last = body.length > 5 ? body[body.length - 1]!.text.trim().slice(0, 140) : '';
  const result = last && !normalize(first).includes(normalize(last)) ? first + ' … ' + last : first;
  return result.slice(0, 600);
}

/**
 * 为每个章节写入/更新抽取式摘要快照。
 * 已有 model 摘要的章节保留模型摘要，其余使用抽取式摘要；
 * 保证 reanalysis 前重置后仍有可用摘要。
 */
export function writeChapterSnapshots(db: DatabaseSync, revisionId: string, segments: Segment[]): void {
  const insert = db.prepare(
    'INSERT INTO context_graph_chapters(source_revision_id, chapter_key, chapter_order, chapter_title, summary, summary_kind, segment_ids_json, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_revision_id, chapter_key) DO UPDATE SET ' +
    'chapter_order=excluded.chapter_order, chapter_title=excluded.chapter_title, ' +
    'summary=CASE WHEN context_graph_chapters.summary_kind = \'model\' THEN context_graph_chapters.summary ELSE excluded.summary END, ' +
    'summary_kind=CASE WHEN context_graph_chapters.summary_kind = \'model\' THEN \'model\' ELSE excluded.summary_kind END, ' +
    'segment_ids_json=excluded.segment_ids_json, updated_at=excluded.updated_at'
  );
  const now = new Date().toISOString();
  for (const chapter of chapterMap(segments)) {
    insert.run(revisionId, chapter.key, chapter.order, chapter.title, extractiveSummary(chapter.segments), 'extractive',
      JSON.stringify(chapter.segments.slice(0, 16).map((segment) => segment.id)), now);
  }
}

/**
 * 重新分析前重置上一轮模型生成的章节摘要。
 *
 * context_graph_chapters.summary / summary_kind 都是 NOT NULL 列，不能用 NULL 标记"失效"：
 * 早期实现写 `SET summary = NULL`，导致同一 source revision 的第二次预处理在模型跑完 4 分钟后
 * 抛 `NOT NULL constraint failed`，整轮结果被回滚。这里改为降级成空 extractive，
 * 再由 writeChapterSnapshots 重新生成确定性摘要；本轮模型摘要稍后会覆盖需要的章节。
 */
export function resetChapterSummariesForReanalysis(
  db: DatabaseSync,
  revisionId: string,
  segments: Segment[],
): void {
  db.prepare(
    "UPDATE context_graph_chapters SET summary = '', summary_kind = 'extractive', segment_ids_json = '[]', updated_at = ? " +
    "WHERE source_revision_id = ? AND summary_kind = 'model'"
  ).run(new Date().toISOString(), revisionId);
  writeChapterSnapshots(db, revisionId, segments);
}

/**
 * 以 upsert 方式保存来源版本级的 meta 键值（JSON 序列化）。
 */
export function saveMeta(db: DatabaseSync, revisionId: string, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO context_graph_meta(source_revision_id, key, value, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(source_revision_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run(revisionId, key, JSON.stringify(value), new Date().toISOString());
}

/**
 * 读取来源版本级的 meta 键值，解析失败返回 null。
 */
export function getMeta(db: DatabaseSync, revisionId: string, key: string): any {
  const row = db.prepare('SELECT value FROM context_graph_meta WHERE source_revision_id = ? AND key = ?').get(revisionId, key) as { value?: string } | undefined;
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

type ContextGraphRunProgress = Record<string, any>;

/**
 * 读取 run 的 progress_json 并解析为对象；失败时返回空对象。
 */
export function readRunProgress(db: DatabaseSync, runId: string): ContextGraphRunProgress {
  const row = db.prepare('SELECT progress_json FROM context_graph_runs WHERE run_id = ?').get(runId) as { progress_json?: string } | undefined;
  try {
    const value = row?.progress_json ? JSON.parse(row.progress_json) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Merge a durable checkpoint into progress_json without deleting strategy or earlier stage results. */
export function patchRunProgress(db: DatabaseSync, runId: string, patch: Record<string, unknown>): ContextGraphRunProgress {
  const next = { ...readRunProgress(db, runId), ...patch };
  db.prepare('UPDATE context_graph_runs SET progress_json = ? WHERE run_id = ?').run(JSON.stringify(next), runId);
  return next;
}

/**
 * 生成阶段检查点的 meta key，按 runId + stageId 唯一命名。
 */
export function workflowCheckpointKey(runId: string, stageId: ContextGraphWorkflowStageId): string {
  return 'contextGraphCheckpoint:' + runId + ':' + stageId;
}

/**
 * 生成工作流 Session 的 meta key，style 阶段沿用 run 级 key。
 */
export function workflowSessionKey(runId: string, stageId?: ContextGraphWorkflowStageId): string {
  return 'contextGraphSession:' + runId + (stageId ? ':' + stageId : '');
}

/**
 * 从最近的 run 记录中读取最近一次使用的分析策略（A/B）。
 */
export function readLatestStrategy(db: DatabaseSync, revisionId: string): ContextGraphAnalysisStrategy | null {
  const rows = db.prepare(
    'SELECT progress_json FROM context_graph_runs WHERE source_revision_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 30'
  ).all(revisionId) as Array<{ progress_json?: string }>;
  for (const row of rows) {
    try {
      const progress = JSON.parse(row.progress_json || '{}');
      if (progress?.strategy === 'A' || progress?.strategy === 'B') return progress.strategy;
    } catch { /* ignore old/malformed run metadata */ }
  }
  return null;
}

/**
 * 持久化单个 workflow 阶段的输出检查点与进度。
 * style 阶段同时写入文风 meta；更新 completedStages/stageResults；
 * 在事务内完成，失败整体回滚。
 */
export function persistWorkflowStageCheckpoint(
  db: DatabaseSync,
  revisionId: string,
  runId: string,
  stageId: ContextGraphWorkflowStageId,
  output: Record<string, any>,
  elapsedMs: number,
  sampleIds: Set<string>,
  samples: Segment[],
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    saveMeta(db, revisionId, workflowCheckpointKey(runId, stageId), output);
    if (stageId === 'style') {
      saveMeta(db, revisionId, 'bookSummary', safeText(output.bookSummary, 4000));
      saveMeta(db, revisionId, 'narrativeStyle', safeText(output.narrativeStyle, 1200));
      saveMeta(db, revisionId, 'styleRegister', safeText(output.styleRegister, 1000));
      saveMeta(db, revisionId, 'styleRhythm', safeText(output.styleRhythm, 1000));
      saveMeta(db, revisionId, 'styleDialogue', safeText(output.styleDialogue, 1000));
      saveMeta(db, revisionId, 'styleDiction', safeText(output.styleDiction, 1000));
      saveMeta(db, revisionId, 'styleRules', uniqueStrings(output.styleRules, 24, 240));
      saveMeta(db, revisionId, 'styleAvoid', uniqueStrings(output.styleAvoid, 16, 240));
      saveMeta(db, revisionId, 'styleEvidence', Array.isArray(output.styleEvidence) ? output.styleEvidence.filter((item: any) =>
        item && typeof item.segmentId === 'string' && sampleIds.has(item.segmentId) &&
        typeof item.quote === 'string' && item.quote.trim().length >= 8 &&
        samples.some((sample) => sample.id === item.segmentId && sample.text.includes(item.quote.trim()))
      ).slice(0, 40).map((item: any) => ({
        dimension: safeText(item.dimension, 40), segmentId: item.segmentId,
        quote: safeText(item.quote, 240), observation: safeText(item.observation, 300),
      })) : []);
    }
    const progress = readRunProgress(db, runId);
    const completedStages = Array.isArray(progress.completedStages) ? progress.completedStages as string[] : [];
    const stageResults = Array.isArray(progress.stageResults) ? progress.stageResults as Array<Record<string, any>> : [];
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(output)) {
      if (Array.isArray(value)) counts[key] = value.length;
      else if (typeof value === 'string') counts[key] = value.length;
    }
    const stage = CONTEXT_GRAPH_WORKFLOW_STAGES.find((item) => item.id === stageId);
    const resultSummary = { stage: stageId, label: stage?.label || stageId, elapsedMs, outputCounts: counts, completedAt: new Date().toISOString() };
    const nextCompleted = Array.from(new Set([...completedStages, stageId]));
    const nextResults = [...stageResults.filter((item) => item.stage !== stageId), resultSummary];
    db.prepare('UPDATE context_graph_runs SET progress_json = ? WHERE run_id = ?').run(JSON.stringify({
      ...progress, strategy: 'B', workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
      currentStage: null, completedStages: nextCompleted, stageResults: nextResults,
    }), runId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve checkpoint error */ }
    throw error;
  }
}

/**
 * 校验模型返回的证据数组。
 * 每条证据必须引用本次样本中的 segmentId，quote 必须能在对应 segment 文本中验证；
 * 去重并限制数量；通过 onInvalid 回调记录失败原因与计数。
 */
export function validateEvidence(
  raw: unknown,
  samplesById: Map<string, Segment>,
  onInvalid?: (reason: string) => void,
): Evidence[] {
  if (!Array.isArray(raw)) {
    onInvalid?.('evidence-not-array');
    return [];
  }
  if (raw.length === 0) {
    onInvalid?.('evidence-empty');
    return [];
  }
  const result: Evidence[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      onInvalid?.('evidence-item-not-object');
      continue;
    }
    const segmentId = safeText((item as any)?.segmentId, 200);
    const quote = safeText((item as any)?.quote, 240);
    const sample = samplesById.get(segmentId);
    if (!sample) {
      onInvalid?.('segment-not-in-model-samples');
      continue;
    }
    if (!quote) {
      onInvalid?.('quote-empty-after-sanitization');
      continue;
    }
    if (!hasQuote(sample.text, quote)) {
      onInvalid?.('quote-not-found-in-cited-sample');
      continue;
    }
    if (!result.some((prior) => prior.segmentId === segmentId && normalize(prior.quote) === normalize(quote))) {
      result.push({ segmentId, quote });
    }
  }
  return result;
}

/**
 * 根据来源版本、类型与名称生成稳定的节点 ID（SHA-256 截断）。
 */
export function nodeId(revisionId: string, kind: string, name: string): string {
  return 'cg-' + hash(revisionId + '\n' + kind + '\n' + normalize(name)).slice(0, 32);
}

/**
 * Remove replaceable model-generated graph records before a fresh analysis.
 * Explicitly rejected and user-confirmed records survive. A model-default node referenced by a
 * surviving user edge is retained as well; otherwise reanalysis would leave a dangling decision.
 * The caller owns the surrounding SQLite transaction.
 */
export function clearReplaceableModelGeneratedContextGraphItems(db: DatabaseSync, revisionId: string): void {
  const replaceableEdge = "(status = 'candidate' OR (status = 'confirmed' AND COALESCE(json_extract(attributes_json, '$.adoptionSource'), '') = 'model-default'))";
  const replaceableNode = "(n.status = 'candidate' OR (n.status = 'confirmed' AND COALESCE(json_extract(n.attributes_json, '$.adoptionSource'), '') = 'model-default'))";
  const protectedEdgeForNode =
    "NOT EXISTS (SELECT 1 FROM context_graph_edges protected " +
    "WHERE protected.source_revision_id = n.source_revision_id " +
    "AND (protected.source_node_id = n.node_id OR protected.target_node_id = n.node_id) " +
    "AND NOT (protected.status = 'candidate' OR (protected.status = 'confirmed' AND " +
    "COALESCE(json_extract(protected.attributes_json, '$.adoptionSource'), '') = 'model-default')))";

  db.prepare(
    'DELETE FROM context_graph_evidence WHERE source_revision_id = ? AND (' +
    'node_id IN (SELECT n.node_id FROM context_graph_nodes n WHERE n.source_revision_id = ? AND ' +
    replaceableNode + ' AND ' + protectedEdgeForNode + ') OR ' +
    'edge_id IN (SELECT e.edge_id FROM context_graph_edges e WHERE e.source_revision_id = ? AND ' +
    replaceableEdge.replaceAll('status', 'e.status').replaceAll('attributes_json', 'e.attributes_json') +
    '))',
  ).run(revisionId, revisionId, revisionId);
  db.prepare(
    'DELETE FROM context_graph_edges WHERE source_revision_id = ? AND ' +
    replaceableEdge,
  ).run(revisionId);
  db.prepare(
    'DELETE FROM context_graph_nodes AS n WHERE n.source_revision_id = ? AND ' +
    replaceableNode + ' AND ' + protectedEdgeForNode,
  ).run(revisionId);
}

/**
 * 以 upsert 方式保存一个图谱节点及其证据。
 * 默认 adoptionSource 为 model-default；已 rejected 或用户确认的节点不会被模型结果覆盖；
 * 证据去重插入，避免重复记录。
 */
export function saveNode(
  db: DatabaseSync, revisionId: string, kind: string, name: string,
  attributes: Record<string, unknown>, evidence: Evidence[],
): string {
  const normalizedName = normalize(name);
  const id = nodeId(revisionId, kind, name);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, \'confirmed\', ?, ?) ON CONFLICT(node_id) DO UPDATE SET ' +
    'attributes_json=CASE WHEN (context_graph_nodes.status = \'rejected\' OR (context_graph_nodes.status = \'confirmed\' AND COALESCE(json_extract(context_graph_nodes.attributes_json, \'$.adoptionSource\'), \'\') <> \'model-default\')) AND json_extract(context_graph_nodes.attributes_json, \'$.targetLang\') IS json_extract(excluded.attributes_json, \'$.targetLang\') THEN context_graph_nodes.attributes_json ELSE excluded.attributes_json END, ' +
    'status=CASE WHEN context_graph_nodes.status = \'rejected\' THEN \'rejected\' ELSE \'confirmed\' END, updated_at=excluded.updated_at'
  ).run(id, revisionId, kind, safeText(name, 120), normalizedName, JSON.stringify({ ...attributes, adoptionSource: 'model-default' }), now, now);
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)'
  );
  for (const item of evidence) {
    const exists = db.prepare(
      'SELECT 1 FROM context_graph_evidence WHERE source_revision_id = ? AND node_id = ? AND segment_id = ? AND quote = ? LIMIT 1'
    ).get(revisionId, id, item.segmentId, item.quote);
    if (!exists) insertEvidence.run(revisionId, id, item.segmentId, item.quote, kind, now);
  }
  return id;
}

/**
 * 以 upsert 方式保存一条图谱边及其证据。
 * 与 saveNode 相同的采纳优先级与证据去重策略。
 */
export function saveEdge(
  db: DatabaseSync, revisionId: string, fromId: string, toId: string, kind: string,
  attributes: Record<string, unknown>, evidence: Evidence[],
): string {
  const id = 'cge-' + hash(revisionId + '\n' + fromId + '\n' + toId + '\n' + kind).slice(0, 32);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_edges(edge_id, source_revision_id, source_node_id, target_node_id, kind, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, \'confirmed\', ?, ?) ON CONFLICT(edge_id) DO UPDATE SET ' +
    'attributes_json=CASE WHEN context_graph_edges.status = \'rejected\' OR (context_graph_edges.status = \'confirmed\' AND COALESCE(json_extract(context_graph_edges.attributes_json, \'$.adoptionSource\'), \'\') <> \'model-default\') THEN context_graph_edges.attributes_json ELSE excluded.attributes_json END, ' +
    'status=CASE WHEN context_graph_edges.status = \'rejected\' THEN \'rejected\' ELSE \'confirmed\' END, updated_at=excluded.updated_at'
  ).run(id, revisionId, fromId, toId, kind, JSON.stringify({ ...attributes, adoptionSource: 'model-default' }), now, now);
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, NULL, ?, ?, ?, \'relationship\', ?)'
  );
  for (const item of evidence) {
    const exists = db.prepare(
      'SELECT 1 FROM context_graph_evidence WHERE source_revision_id = ? AND edge_id = ? AND segment_id = ? AND quote = ? LIMIT 1'
    ).get(revisionId, id, item.segmentId, item.quote);
    if (!exists) insertEvidence.run(revisionId, id, item.segmentId, item.quote, now);
  }
  return id;
}

/**
 * 从节点列表构建 名称/别名 -> 节点 ID 的映射，优先保留先出现的映射。
 */
export function nameMap(nodes: Array<{ id: string; name: string; aliases: string[]; kind: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) for (const name of [node.name, ...node.aliases]) {
    if (normalize(name) && !map.has(normalize(name))) map.set(normalize(name), node.id);
  }
  return map;
}

/**
 * 为一个翻译批次生成按时间边界过滤的 Context Graph 子集。
 * 这里按固定 source revision 的 ordinal 校验节点、别名、关系证据与目标语言；模型产生的全书候选
 * 不能因为名称出现在当前片段就自动成为规范译名。该函数只检索上下文，不修改图谱事实。
 */
export type ContextGraphCandidateDisposition = 'no-evidence' | 'persist' | 'valid-limit';

/**
 * 根据已验证证据数量与当前已持久化数量决定候选处置：
 * 无有效证据 -> no-evidence；达到上限 -> valid-limit；否则 -> persist。
 */
export function contextGraphCandidateDisposition(
  evidenceCount: number,
  persistedCount: number,
  limit: number,
): ContextGraphCandidateDisposition {
  // Evidence must be valid before a candidate consumes the quota. This prevents invalid
  // early model outputs from crowding out later source-grounded characters and entities.
  if (!Number.isFinite(evidenceCount) || evidenceCount <= 0) return 'no-evidence';
  if (persistedCount >= Math.max(0, Math.floor(limit))) return 'valid-limit';
  return 'persist';
}

/**
 * 选择当前章节之前的最多两章完整摘要，
 * 避免更早章节稀释上下文；当前章节由前缀摘要单独处理。
 */
export function selectRecentPriorChapterSummaries(
  chapterRows: Array<{ chapter_title: string; summary: string; summary_kind: string }>,
  currentIndex: number,
): Array<{ chapter: string; summary: string; summaryKind: string }> {
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return [];
  // Complete summaries are useful continuity context, but older chapters dilute the active
  // scene and grow every downstream translator/reviewer prompt. The current chapter is handled
  // separately by an extractive prefix summary bounded to the current batch ordinal.
  return chapterRows.slice(Math.max(0, currentIndex - 2), currentIndex).map((chapter) => ({
    chapter: chapter.chapter_title,
    summary: String(chapter.summary),
    summaryKind: chapter.summary_kind,
  })).filter((chapter) => chapter.summary.trim().length > 0);
}
