/**
 * Run 的生命周期与进度读写：排队、状态流转、片段状态、事件追加与完成收尾。
 *
 * 事件表是终态的权威来源，状态列只是它的投影；两者不一致时的修复见 projectStoreRecovery。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logError } from '../log.ts';
import { formatFailedSegmentSummary, hash, isoNow, parseJson } from './documentStoreUtils.ts';
import { type RunStatus } from './documentStrategy.ts';
import { logWorkflowEvent } from './documentWorkflowLog.ts';
import { type CreateRunInput, type DocumentProjectStore } from './projectStore.ts';
import { sanitizeProjectLiteraryMemory } from './voiceContext.ts';

/**
 * 持久化一次翻译执行计划。
 * 在返回 Run 前固定 sourceRevision、promptRevision、literaryMemoryRevision 和片段范围，
 * 同时建立 run_segments；执行 worker 只能按这份快照工作，不能在恢复时悄悄读取最新 Prompt/记忆。
 */
export function createRun(store: DocumentProjectStore, projectId: string, input: CreateRunInput = {}): any {
  const db = store.openProjectDb(projectId);
  const project = store.getProject(projectId)!;
  const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  const sourceRevisionId = meta.get('current_source_revision_id') || '';
  const promptRow = input.prompt
    ? store.savePromptRevision(projectId, input.prompt)
    : input.promptRevisionId
      ? db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(input.promptRevisionId)
      : db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
  if (!promptRow) throw Object.assign(new Error('找不到指定 Prompt 版本'), { status: 404 });
  if (input.parentRunId) {
    const parent = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(input.parentRunId) as { source_revision_id?: string } | undefined;
    if (!parent) throw Object.assign(new Error('找不到返工的父运行：' + input.parentRunId), { status: 404 });
    if (parent.source_revision_id !== sourceRevisionId) {
      throw Object.assign(new Error('返工的父运行与当前来源版本不同，不能建立关联。'), { status: 409 });
    }
  }
  const currentMemory = store.getCurrentLiteraryMemory(projectId);
  const literaryMemoryRevisionId = currentMemory.memoryRevisionId as string | null;
  const config = parseJson<any>(promptRow.config_json, {});
  const scope = input.scope || { type: 'stale' };
  const scopeType = scope.type || 'stale';
  if (!['all', 'stale', 'failed', 'ids', 'chapter'].includes(scopeType)) {
    throw Object.assign(new Error('不支持的运行范围：' + scopeType), { status: 400 });
  }
  const currentSegments = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal').all(sourceRevisionId) as any[];
  const acceptedRows = db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC').all() as any[];
  const currentHashById = new Map<string, string>(currentSegments.map((segment) => [segment.segment_id, segment.source_hash]));
  const latestAccepted = new Map<string, any>();
  // Source revision 变更后保留旧译文供追溯，但新旧来源的同 ID 片段不可混用。
  for (const row of acceptedRows) {
    if (row.source_hash === currentHashById.get(row.segment_id) && !latestAccepted.has(row.segment_id)) {
      latestAccepted.set(row.segment_id, row);
    }
  }
  const manuallyAcceptedIds = new Set(acceptedRows
    .filter((row) => row.origin === 'manual' && row.source_hash === currentHashById.get(row.segment_id))
    .map((row) => row.segment_id));
  // 失败行只对「失败的那个源文版本 + 那个确切的源文哈希」有效。
  const failedRows = db.prepare(
    "SELECT rs.segment_id FROM run_segments rs " +
    "JOIN translation_runs r ON r.run_id = rs.run_id " +
    "JOIN source_segments current ON current.source_revision_id = ? " +
    "AND current.segment_id = rs.segment_id AND current.source_hash = rs.source_hash " +
    "WHERE rs.status = 'failed' AND r.source_revision_id = ? ORDER BY rs.updated_at DESC",
  ).all(sourceRevisionId, sourceRevisionId) as Array<{ segment_id: string }>;
  const failedIds = new Set(failedRows.map((row) => row.segment_id));
  const idSet = new Set((scope.ids || []).map(String));
  const chapter = (scope.chapter || '').trim();
  const runFingerprint = store.makeRunFingerprint(projectId, sourceRevisionId, promptRow, config, currentMemory.fingerprint || null);
  // 根据 scope 类型筛选本次 Run 需要翻译的片段：all 全部、ids 指定、chapter 章节、failed 失败重试、stale 过期重译。
  const selected = currentSegments.filter((segment) => {
    if (scopeType === 'all') return true;
    if (scopeType === 'ids') return idSet.has(segment.segment_id);
    if (scopeType === 'chapter') return !!chapter && (segment.context_path === chapter || segment.context_path.startsWith(chapter + ' >'));
    if (scopeType === 'failed') {
      if (!failedIds.has(segment.segment_id) || manuallyAcceptedIds.has(segment.segment_id)) return false;
      const accepted = latestAccepted.get(segment.segment_id);
      return !accepted || accepted.run_fingerprint !== runFingerprint;
    }
    const accepted = latestAccepted.get(segment.segment_id);
    return !accepted || accepted.source_hash !== segment.source_hash || (accepted.origin !== 'manual' && accepted.run_fingerprint !== runFingerprint);
  });
  // 不要在创建 Run 时就拦截文学 Run。先把排队的 Run 落盘，这样 executeRun
  // 才能启动或等待 Context Graph 预处理，并记录它的持久状态与事件。
  // 源文版本、分析版本和语言检查，只有 worker 说了算。
  const runId = randomUUID();
  const createdAt = isoNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 不可变的 Run 快照是在拿写锁之前组装的。拿到锁后要重新校验它的
    // 源文与记忆（以及隐含的最新 Prompt），否则一次并发编辑会让刚建好的 Run
    // 悄悄钉住过期的项目状态。
    const lockedSource = db.prepare("SELECT value FROM project_meta WHERE key = 'current_source_revision_id'").get() as { value?: string } | undefined;
    const lockedMemory = db.prepare("SELECT value FROM project_meta WHERE key = 'current_literary_memory_revision_id'").get() as { value?: string } | undefined;
    if (lockedSource?.value !== sourceRevisionId || (lockedMemory?.value || null) !== literaryMemoryRevisionId) {
      throw Object.assign(new Error('创建运行期间原文或文学记忆已更新；请基于最新项目状态重新提交运行。'), { status: 409 });
    }
    if (!input.prompt && !input.promptRevisionId) {
      const lockedPrompt = db.prepare('SELECT prompt_revision_id FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { prompt_revision_id?: string } | undefined;
      if (lockedPrompt?.prompt_revision_id !== promptRow.prompt_revision_id) {
        throw Object.assign(new Error('创建运行期间 Prompt 已更新；请基于最新 Prompt 重新提交运行。'), { status: 409 });
      }
    }
    // 一个 workspace 同时只允许一个 queued/running/awaiting_acceptance run；最终化未完成前不启动下一轮。
    const inFlight = db.prepare("SELECT run_id FROM translation_runs WHERE status IN ('queued','running','awaiting_acceptance') LIMIT 1").get() as { run_id?: string } | undefined;
    if (inFlight?.run_id) {
      throw Object.assign(new Error('当前文档已有尚未完成最终化的翻译任务：' + inFlight.run_id), { status: 409 });
    }
    db.prepare('INSERT INTO translation_runs(run_id, source_revision_id, prompt_revision_id, literary_memory_revision_id, status, scope_json, run_fingerprint, provider, model, source_lang, target_lang, translation_mode, review_enabled, parent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, sourceRevisionId, promptRow.prompt_revision_id, literaryMemoryRevisionId, selected.length ? 'queued' : 'completed', JSON.stringify({ ...scope, type: scopeType }), runFingerprint,
        config.provider || 'workbuddy', config.model || 'auto', config.sourceLang || 'auto', config.targetLang || 'zh',
        config.translationMode || 'technical', config.literaryReview ? 1 : 0, input.parentRunId || null, createdAt);
    const insert = db.prepare('INSERT INTO run_segments(run_id, segment_id, source_hash, status, attempts, candidate_result_id, error, updated_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)');
    for (const segment of selected) insert.run(runId, segment.segment_id, segment.source_hash, 'pending', createdAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  store.addEvent(projectId, runId, 'run.planned', {
    scope: { ...scope, type: scopeType },
    promptRevisionId: promptRow.prompt_revision_id,
    literaryMemoryRevisionId,
    parentRunId: input.parentRunId || null,
    plannedSegments: selected.length,
    sourceRevisionId,
    // 落盘实际生效的模式。这样前端万一被「降级」成 technical，
    // 在 Agent 轨迹里能看出来。
    translationMode: config.translationMode || 'technical',
    literaryReview: Boolean(config.literaryReview),
    literaryMemoryCounts: {
      entities: Array.isArray(currentMemory.memory?.entities) ? currentMemory.memory.entities.length : 0,
      characterVoices: Array.isArray(currentMemory.memory?.characterVoices) ? currentMemory.memory.characterVoices.length : 0,
    },
  });
  store.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(createdAt, projectId);
  return store.getRun(projectId, runId);
}

/**
 * 将结构化事件写入项目事件账本，并同步输出工作流日志。
 * SQLite event 是 UI 轮询、故障排查和运行追踪的持久化事实来源；console 日志不能替代它。
 */
export function appendEvent(store: DocumentProjectStore, projectId: string, runId: string | null, type: string, payload: unknown): void {
  // 先打印再落库：SQLite 写入失败时，终端至少还能看到「本应发生什么」。
  // 反过来先落库的话，一次写盘错误会让整条事件彻底消失，日志里什么都不剩。
  logWorkflowEvent(runId, type, payload);
  try {
    store.addEvent(projectId, runId, type, payload);
  } catch (error) {
    logError('document-agent', '事件写入失败 · ' + type + ' · ' + (error instanceof Error ? error.message : String(error)));
    throw error;
  }
}

/**
 * 直接写入一条项目事件，不打印工作流日志。
 */
export function addEvent(store: DocumentProjectStore, projectId: string, runId: string | null, type: string, payload: unknown): void {
  const db = store.openProjectDb(projectId);
  db.prepare('INSERT INTO project_events(run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)').run(runId, type, JSON.stringify(payload ?? {}), isoNow());
}

/**
 * 计算 Run 指纹，综合 Prompt、记忆、图谱、语言方向、Provider/模型与 Pipeline 版本。
 * 用于判断已有译文是否因上下文变化而过期。
 */
export function makeRunFingerprint(store: DocumentProjectStore, projectId: string, sourceRevisionId: string, promptRow: any, config: any, literaryMemoryFingerprint: string | null): string {
  return hash(JSON.stringify({
    promptFingerprint: promptRow.fingerprint,
    // 人物声音/关系/锚点变化必须让文学批次变 stale，但不应虚增一个静态 Prompt revision。
    literaryMemoryFingerprint: config.translationMode === 'literary' ? literaryMemoryFingerprint : null,
    ...(config.translationMode === 'literary'
      ? { contextGraphFingerprint: store.contextGraphFingerprint(projectId, sourceRevisionId) }
      : {}),
    sourceLang: config.sourceLang || 'auto',
    targetLang: config.targetLang || 'zh',
    provider: config.provider || 'workbuddy',
    model: config.model || 'auto',
    translationMode: config.translationMode || 'technical',
    literaryReview: Boolean(config.literaryReview),
    pipelineVersion: config.translationMode === 'literary' ? 'document-agent-v6-temporal-glossary-review-evidence' : 'document-agent-v2-voice',
  }));
}

/**
 * 列出项目的翻译运行，按创建时间倒序。
 */
export function listRuns(store: DocumentProjectStore, projectId: string, limit = 50): any[] {
  const db = store.openProjectDb(projectId);
  return (db.prepare('SELECT * FROM translation_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as any[])
    .map((row) => store.runSummary(db, row));
}

/**
 * 读取单个 Run 的详细信息（含片段与审校发现）。
 */
export function getRun(store: DocumentProjectStore, projectId: string, runId: string): any {
  const db = store.openProjectDb(projectId);
  const row = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!row) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
  return store.runSummary(db, row, true);
}

/**
 * 读取 Run 当前状态。
 */
export function getRunStatus(store: DocumentProjectStore, projectId: string, runId: string): RunStatus {
  const row = store.openProjectDb(projectId).prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!row) throw Object.assign(new Error('找不到翻译运行'), { status: 404 });
  return row.status as RunStatus;
}

/**
 * 在 SQLite 写事务中执行 Run 状态转换。
 * completed/cancelled 是不可被延迟 worker 逆转的终态；false 表示状态门拒绝本次转换，
 * 调用者必须停止后续持久化，不能把内存中的任务状态当作成功提交的依据。
 */
export function setRunStatus(store: DocumentProjectStore, projectId: string, runId: string, status: RunStatus, error?: string | null): boolean {
  const db = store.openProjectDb(projectId);
  const now = isoNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!current) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (current.status === status) {
      db.exec('ROLLBACK');
      return true;
    }
    // 取消与完成都是不可变的终态。迟到的 worker、恢复请求或过期的路由快照，
    // 绝不能把它们改回 running/queued。
    if (['cancelled', 'completed'].includes(String(current.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare(
      'UPDATE translation_runs SET status = ?, error = ?, ' +
      'started_at = CASE WHEN ? = \'running\' AND started_at IS NULL THEN ? ELSE started_at END, ' +
      'finished_at = CASE WHEN ? IN (\'queued\', \'running\') THEN NULL ' +
      'WHEN ? IN (\'paused\', \'awaiting_acceptance\', \'partial\', \'completed\', \'failed\', \'cancelled\') THEN ? ELSE finished_at END ' +
      'WHERE run_id = ?',
    ).run(status, error ?? null, status, now, status, status, now, runId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
  store.addEvent(projectId, runId, 'run.' + status, { error: error || undefined });
  return true;
}

/**
 * 批量更新 Run 片段状态；running 状态会递增 attempts。
 */
export function markRunSegments(store: DocumentProjectStore, projectId: string, runId: string, segmentIds: string[], status: string, error?: string | null): boolean {
  const db = store.openProjectDb(projectId);
  const stmt = db.prepare(
    'UPDATE run_segments SET status = ?, attempts = attempts + CASE WHEN ? = \'running\' THEN 1 ELSE 0 END, ' +
    'error = ?, updated_at = ? WHERE run_id = ? AND segment_id = ?',
  );
  const now = isoNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (['running', 'failed'].includes(status) && !['queued', 'running'].includes(String(run.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    if (status === 'cancelled' && run.status !== 'cancelled') {
      db.exec('ROLLBACK');
      return false;
    }
    for (const id of segmentIds) stmt.run(status, status, error ?? null, now, runId, id);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * 根据片段级状态汇总 Run 终态，而不是单凭 Promise 是否结束决定成功。
 * 未处理片段导致 paused；存在候选时进入 awaiting_acceptance；失败与已有成功结果组合为
 * partial/failed。此函数不自动采纳 candidate。
 */
export function finishRun(store: DocumentProjectStore, projectId: string, runId: string): any {
  const db = store.openProjectDb(projectId);
  const now = isoNow();
  let finalStatus: RunStatus = 'completed';
  let errorMessage: string | null = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (['cancelled', 'paused', 'completed'].includes(String(run.status))) {
      db.exec('ROLLBACK');
      return store.getRun(projectId, runId);
    }
    const counts = db.prepare(
      'SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status',
    ).all(runId) as any[];
    const values = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
    const candidates = Number(values.candidate || 0);
    const accepted = Number(values.accepted || 0);
    const failures = Number(values.failed || 0);
    const pending = Number(values.pending || 0) + Number(values.running || 0);
    finalStatus = pending > 0 ? 'paused' : candidates > 0 ? 'awaiting_acceptance'
      : failures > 0 ? (accepted > 0 ? 'partial' : 'failed') : 'completed';
    errorMessage = failures ? formatFailedSegmentSummary(failures) : null;
    db.prepare('UPDATE translation_runs SET status = ?, error = ?, finished_at = ? WHERE run_id = ?')
      .run(finalStatus, errorMessage, now, runId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
  store.addEvent(projectId, runId, 'run.' + finalStatus, { error: errorMessage || undefined });
  return store.getRun(projectId, runId);
}

/**
 * 读取 Run 创建时绑定的项目、Prompt 和文学记忆快照。
 * 旧 Run 缺少 memory revision 外键时只允许回退到对应旧 Prompt 中迁移的记忆，
 * 不得将当前最新的 Voice Bible 套用到历史 Run。
 */
export function getRunContext(store: DocumentProjectStore, projectId: string, runId: string): any {
  const { db, project } = store.getProjectContext(projectId);
  const run = db.prepare('SELECT * FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
  const prompt = db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(run.prompt_revision_id) as any;
  const memoryRow = run.literary_memory_revision_id
    ? db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(run.literary_memory_revision_id) as any
    : null;
  // 旧版 Run 没有 memory revision 外键；如对应的 Prompt 曾嵌入文学记忆，仍使用那份旧快照，
  // 不能在回看旧 Run 时偷偷套用当前最新版的 Voice Bible。
  const legacyMemory = prompt ? parseJson<any>(prompt.config_json, {}).literaryMemory : null;
  const memory = memoryRow
    ? parseJson(memoryRow.memory_json, sanitizeProjectLiteraryMemory({}))
    : legacyMemory
      ? sanitizeProjectLiteraryMemory(legacyMemory)
      : sanitizeProjectLiteraryMemory({});
  return {
    project,
    memoryRevisionId: memoryRow?.memory_revision_id || null,
    memory,
    run: {
      runId: run.run_id, sourceRevisionId: run.source_revision_id, promptRevisionId: run.prompt_revision_id,
      literaryMemoryRevisionId: run.literary_memory_revision_id || null,
      status: run.status, scope: parseJson(run.scope_json, {}), runFingerprint: run.run_fingerprint,
      provider: run.provider, model: run.model, sourceLang: run.source_lang, targetLang: run.target_lang,
      translationMode: run.translation_mode, reviewEnabled: Boolean(run.review_enabled),
    },
    prompt: prompt ? store.publicPrompt(prompt) : null,
  };
}

/**
 * 将 translation_runs 数据库行转换为 Run 摘要，可选包含片段与审校发现。
 */
export function runSummary(store: DocumentProjectStore, db: DatabaseSync, row: any, includeSegments = false): any {
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status').all(row.run_id) as Array<{ status: string; count: number }>;
  const byStatus = Object.fromEntries(counts.map((entry) => [entry.status, Number(entry.count)]));
  const summary = {
    runId: row.run_id, sourceRevisionId: row.source_revision_id, promptRevisionId: row.prompt_revision_id, literaryMemoryRevisionId: row.literary_memory_revision_id || null,
    status: row.status as RunStatus, scope: parseJson(row.scope_json, {}), runFingerprint: row.run_fingerprint,
    provider: row.provider, model: row.model, sourceLang: row.source_lang, targetLang: row.target_lang,
    translationMode: row.translation_mode, reviewEnabled: Boolean(row.review_enabled), parentRunId: row.parent_run_id,
    counts: { total: counts.reduce((sum, item) => sum + Number(item.count), 0), ...byStatus },
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
  };
  if (!includeSegments) return summary;
  const segmentRows = db.prepare(
    'SELECT rs.segment_id, rs.status, rs.attempts, rs.error, r.translation_text AS candidate_translation ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ? ORDER BY rs.updated_at'
  ).all(row.run_id) as any[];
  const findings = db.prepare('SELECT finding_id, segment_id, category, priority, finding_json, status, created_at FROM review_findings WHERE run_id = ? ORDER BY finding_id')
    .all(row.run_id) as any[];
  return {
    ...summary,
    segments: segmentRows.map((segment) => ({
      id: segment.segment_id, status: segment.status, attempts: segment.attempts, error: segment.error,
      candidateTranslation: segment.candidate_translation ?? null,
    })),
    findings: findings.map((finding) => ({ findingId: finding.finding_id, segmentId: finding.segment_id, category: finding.category,
      priority: finding.priority, finding: parseJson(finding.finding_json, {}), status: finding.status, createdAt: finding.created_at })),
  };
}

/**
   * 返回 Run 的不可变片段成员列表，不加载原文或译文正文。
 */
export function getRunSegmentIds(store: DocumentProjectStore, projectId: string, runId: string): string[] {
  const { db } = store.getProjectContext(projectId);
  const exists = db.prepare('SELECT 1 FROM translation_runs WHERE run_id = ?').get(runId);
  if (!exists) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
  return (db.prepare(
    'SELECT segment_id FROM run_segments WHERE run_id = ? ORDER BY rowid',
  ).all(runId) as Array<{ segment_id: string }>).map((row) => row.segment_id);
}

/**
 * 读取 Run 中待处理（pending/failed）的片段及其原文信息，供执行器使用。
 */
export function getRunSegmentsForExecution(store: DocumentProjectStore, projectId: string, runId: string): any[] {
  const { db } = store.getProjectContext(projectId);
  return db.prepare(
    'SELECT rs.segment_id AS id, rs.status, rs.source_hash, rs.attempts, ss.ordinal, ss.text, ss.kind, ss.context_path, ss.page, ss.level, ss.marker, ss.path, ss.start_time AS start, ss.end_time AS end ' +
    'FROM run_segments rs JOIN translation_runs tr ON tr.run_id = rs.run_id ' +
    'JOIN source_segments ss ON ss.source_revision_id = tr.source_revision_id AND ss.segment_id = rs.segment_id ' +
    'WHERE rs.run_id = ? AND rs.status IN (\'pending\', \'failed\') ORDER BY ss.ordinal'
  ).all(runId);
}

/**
 * 取若干前置源文片段，用于解析对白与指代。
 * 这些行永远属于本次 Run 锁定的同一个不可变源文版本。
 * 它们只是上下文：调用方绝不能为它们创建 run_segments 或输出 id。
 */
export function getPrecedingSegments(store: DocumentProjectStore, projectId: string, runId: string, firstSegmentId: string, limit = 4): any[] {
  const { db } = store.getProjectContext(projectId);
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
  if (!run?.source_revision_id) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
  const current = db.prepare(
    'SELECT ordinal, context_path FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
  ).get(run.source_revision_id, firstSegmentId) as { ordinal?: number; context_path?: string } | undefined;
  if (typeof current?.ordinal !== 'number') return [];
  const bounded = Math.max(0, Math.min(6, Math.floor(limit)));
  if (!bounded) return [];
  const sameChapter = current.context_path
    ? db.prepare(
        'SELECT segment_id, ordinal, text, kind, context_path, page, level, marker FROM source_segments ' +
        'WHERE source_revision_id = ? AND ordinal < ? AND context_path = ? ORDER BY ordinal DESC LIMIT ?'
      ).all(run.source_revision_id, current.ordinal, current.context_path, bounded) as any[]
    : [];
  const rows = sameChapter.length
    ? sameChapter
    : db.prepare(
        'SELECT segment_id, ordinal, text, kind, context_path, page, level, marker FROM source_segments ' +
        'WHERE source_revision_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?'
      ).all(run.source_revision_id, current.ordinal, bounded) as any[];
  return rows.reverse().map((row) => ({
    id: row.segment_id,
    text: String(row.text).slice(0, 900),
    kind: row.kind,
    contextPath: row.context_path,
    page: row.page,
    level: row.level,
    marker: row.marker,
  }));
}

/**
 * 分页读取当前来源版本的片段，并附带已采纳/候选译文。
 */
export function getSegments(store: DocumentProjectStore, projectId: string, options: { limit?: number; offset?: number; runId?: string } = {}): any[] {
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit || 250)));
  const offset = Math.max(0, Math.floor(options.offset || 0));
  const rows = db.prepare(
    'SELECT s.segment_id, s.ordinal, s.text, s.kind, s.context_path, s.page, s.level, s.marker, s.path, s.start_time, s.end_time, s.source_hash, ' +
    '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.source_hash = s.source_hash AND r.accepted = 1 ORDER BY COALESCE(r.accepted_at, r.created_at) DESC, r.created_at DESC, r.rowid DESC LIMIT 1) AS accepted_translation, ' +
    '(SELECT r.translation_text FROM translation_results r WHERE r.segment_id = s.segment_id AND r.run_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS candidate_translation ' +
    'FROM source_segments s WHERE s.source_revision_id = ? ORDER BY s.ordinal LIMIT ? OFFSET ?'
  ).all(options.runId || '', currentSourceRevisionId, limit, offset) as any[];
  return rows.map((row) => ({
    id: row.segment_id, ordinal: row.ordinal, text: row.text, kind: row.kind, contextPath: row.context_path,
    page: row.page, level: row.level, marker: row.marker, path: row.path, start: row.start_time, end: row.end_time, sourceHash: row.source_hash,
    acceptedTranslation: row.accepted_translation ?? null, candidateTranslation: row.candidate_translation ?? null,
  }));
}

/**
 * 读取项目事件，支持按 runId/after 游标分页。
 */
export function getEvents(store: DocumentProjectStore, projectId: string, runId?: string, after = 0, limit = 200, latest = false): any[] {
  const db = store.openProjectDb(projectId);
  const maxLimit = latest && after <= 0 ? 5000 : 1000;
  const boundedLimit = Math.max(1, Math.min(maxLimit, Math.floor(limit)));
  // 老项目优先显示最近活动。后续轮询用 after=eventId。
  const rows = latest && after <= 0
    ? runId
      ? db.prepare('SELECT * FROM (SELECT * FROM project_events WHERE run_id = ? ORDER BY event_id DESC LIMIT ?) ORDER BY event_id').all(runId, boundedLimit)
      : db.prepare('SELECT * FROM (SELECT * FROM project_events ORDER BY event_id DESC LIMIT ?) ORDER BY event_id').all(boundedLimit)
    : runId
      ? db.prepare('SELECT * FROM project_events WHERE run_id = ? AND event_id > ? ORDER BY event_id LIMIT ?').all(runId, after, boundedLimit)
      : db.prepare('SELECT * FROM project_events WHERE event_id > ? ORDER BY event_id LIMIT ?').all(after, boundedLimit);
  return (rows as any[]).map((row) => ({ eventId: row.event_id, runId: row.run_id, type: row.event_type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at }));
}
