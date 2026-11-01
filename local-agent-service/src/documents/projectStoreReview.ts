/**
 * 候选译文、审校发现与人工决策的落库。
 *
 * 这里决定「模型给出的候选能不能进最终稿」：证据、重复命中与审校处置都在这一层过滤，
 * 人工确认过的结果优先级最高。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { formatFailedSegmentSummary, hash, isoNow, parseJson } from './documentStoreUtils.ts';
import { type RunStatus } from './documentStrategy.ts';
import { type DocumentProjectStore } from './projectStore.ts';

/**
 * 原子提交一个模型批次的候选译文与审校发现，仅在 Run 活动时允许。
 * 状态检查与所有写入共享 BEGIN IMMEDIATE，防止取消/暂停请求在检查与迟到写入之间交错。
 */
export function saveCandidates(store: DocumentProjectStore, projectId: string, runId: string, items: Array<{ segmentId: string; text: string }>, reviewFindings: Array<{ segmentId: string; finding: any }> = []): boolean {
  if (!Array.isArray(items) || items.length > 1000 ||
      !Array.isArray(reviewFindings) || reviewFindings.length > 1000) {
    throw Object.assign(new Error('候选译文或审校结果批次必须是最多 1000 条记录的数组'), { status: 400 });
  }
  const seen = new Set<string>();
  const normalized = items.map((item) => {
    const segmentId = typeof item?.segmentId === 'string' ? item.segmentId.trim() : '';
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!segmentId || !text || text.length > 20000 || seen.has(segmentId)) {
      throw Object.assign(new Error('候选译文包含空 ID、空文本、重复 ID 或超长文本'), { status: 400 });
    }
    seen.add(segmentId);
    return { segmentId, text };
  });
  const normalizedFindings = reviewFindings.map((item) => {
    const segmentId = typeof item?.segmentId === 'string' ? item.segmentId.trim() : '';
    if (!segmentId || !item.finding || typeof item.finding !== 'object' || Array.isArray(item.finding)) {
      throw Object.assign(new Error('审校结果包含无效的片段 ID 或 finding'), { status: 400 });
    }
    const category = ['accuracy', 'terminology', 'style'].includes(item.finding.category)
      ? item.finding.category : 'style';
    const priority = category === 'style' ? 'optional' : 'must_fix';
    return {
      segmentId,
      category,
      priority,
      findingJson: JSON.stringify({ ...item.finding, id: segmentId, category, priority }),
    };
  });
  if (!normalized.length && !normalizedFindings.length) return true;

  const { db } = store.getProjectContext(projectId);
  const now = isoNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare(
      'SELECT status, source_revision_id, prompt_revision_id, run_fingerprint FROM translation_runs WHERE run_id = ?',
    ).get(runId) as any;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (!['queued', 'running'].includes(String(run.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    const requiredIds = Array.from(new Set([
      ...normalized.map((item) => item.segmentId),
      ...normalizedFindings.map((item) => item.segmentId),
    ]));
    const rows = db.prepare(
      'SELECT segment_id, source_hash FROM run_segments WHERE run_id = ? AND segment_id IN (' +
        requiredIds.map(() => '?').join(',') + ')',
    ).all(runId, ...requiredIds) as Array<{ segment_id: string; source_hash: string }>;
    if (rows.length !== requiredIds.length) {
      throw Object.assign(new Error('候选译文或审校结果包含不属于本次运行的片段 ID'), { status: 400 });
    }
    const sourceHashes = new Map(rows.map((row) => [row.segment_id, row.source_hash]));
    const insertCandidate = db.prepare(
      'INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', 0, ?, NULL)",
    );
    const updateCandidate = db.prepare(
      "UPDATE run_segments SET status = 'candidate', candidate_result_id = ?, error = NULL, updated_at = ? WHERE run_id = ? AND segment_id = ?",
    );
    for (const item of normalized) {
      const resultId = randomUUID();
      insertCandidate.run(
        resultId, runId, run.source_revision_id, run.prompt_revision_id, item.segmentId,
        sourceHashes.get(item.segmentId), run.run_fingerprint, item.text, now,
      );
      updateCandidate.run(resultId, now, runId, item.segmentId);
    }
    const insertFinding = db.prepare(
      "INSERT INTO review_findings(run_id, segment_id, category, priority, finding_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    );
    for (const item of normalizedFindings) {
      insertFinding.run(runId, item.segmentId, item.category, item.priority, item.findingJson, now);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already have rolled back */ }
    throw error;
  }
}

/**
 * 保存单条候选译文；Run 非活动时抛出 409。
 */
export function saveCandidate(store: DocumentProjectStore, projectId: string, runId: string, segmentId: string, text: string): void {
  const committed = store.saveCandidates(projectId, runId, [{ segmentId, text }]);
  if (!committed) {
    throw Object.assign(new Error('翻译运行已暂停、取消或结束，拒绝保存迟到的候选译文。'), { status: 409 });
  }
}

/**
 * 保存审校发现（委托 saveCandidates，仅 findings）。
 */
export function saveFindings(store: DocumentProjectStore, projectId: string, runId: string, findings: Array<{ segmentId: string; finding: any }>): boolean {
  return store.saveCandidates(projectId, runId, [], findings);
}

/**
 * 保存单条审校发现；Run 非活动时抛出 409。
 */
export function saveFinding(store: DocumentProjectStore, projectId: string, runId: string, segmentId: string, finding: any): void {
  const committed = store.saveFindings(projectId, runId, [{ segmentId, finding }]);
  if (!committed) {
    throw Object.assign(new Error('翻译运行已暂停、取消或结束，拒绝保存迟到的审校结果。'), { status: 409 });
  }
}

/**
 * 仅在对应双语准确性审校返回完整结果后，标记中文单语编辑提案。
 * 最终经验证的候选替换预审提案，避免用户应用过期的中间编辑。
 */
export function markChineseEditorialFindingsReviewed(store: DocumentProjectStore, projectId: string, runId: string, results: Array<{ segmentId: string; status: 'verified' | 'corrected' | 'reverted'; proposedTranslation: string }>): boolean {
  if (!Array.isArray(results) || results.length > 1000) {
    throw Object.assign(new Error('中文编辑复核结果必须是最多 1000 条记录的数组'), { status: 400 });
  }
  const normalized = results.flatMap((item) => {
    const segmentId = typeof item?.segmentId === 'string' ? item.segmentId.trim() : '';
    const proposedTranslation = typeof item?.proposedTranslation === 'string' ? item.proposedTranslation.trim() : '';
    if (!segmentId || !proposedTranslation || proposedTranslation.length > 20000 ||
        !['verified', 'corrected', 'reverted'].includes(item.status)) return [];
    return [{ segmentId, status: item.status, proposedTranslation }];
  });
  if (!normalized.length) return true;
  const { db } = store.getProjectContext(projectId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (!['queued', 'running'].includes(String(run.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    const select = db.prepare(
      "SELECT rf.finding_id, rf.finding_json, rs.candidate_result_id, rs.source_hash " +
      "FROM review_findings rf JOIN run_segments rs ON rs.run_id = rf.run_id AND rs.segment_id = rf.segment_id " +
      "WHERE rf.run_id = ? AND rf.segment_id = ? AND rf.category = 'style' AND rf.status = 'pending'",
    );
    const updateFindingApplied = db.prepare(
      "UPDATE review_findings SET finding_json = ?, status = 'applied' WHERE finding_id = ? AND status = 'pending'",
    );
    const updateFindingReverted = db.prepare(
      "UPDATE review_findings SET finding_json = ?, status = 'dismissed' WHERE finding_id = ? AND status = 'pending'",
    );
    const updateCandidate = db.prepare(
      'UPDATE translation_results SET translation_text = ? ' +
      'WHERE result_id = ? AND run_id = ? AND accepted = 0 AND source_hash = ?',
    );
    const autoApplied: Array<{ segmentId: string; findingId: number }> = [];
    const autoReverted: Array<{ segmentId: string; findingId: number }> = [];
    for (const item of normalized) {
      const rows = select.all(runId, item.segmentId) as Array<{
        finding_id: number; finding_json: string; candidate_result_id?: string | null; source_hash: string;
      }>;
      for (const row of rows) {
        const finding = parseJson<any>(row.finding_json, {});
        if (finding.editorialMode !== 'chinese-monolingual' || !row.candidate_result_id) continue;
        // 双语审校对这条目标语改动本身做了核对。
        // 这里只更新本次 Run 中尚未采纳的候选；最终的采纳事务仍然会
        // 保护更新的手工编辑和源文版本。
        const candidate = updateCandidate.run(
          item.proposedTranslation, row.candidate_result_id, runId, row.source_hash,
        );
        if (Number(candidate.changes || 0) !== 1) continue;
        finding.bilingualReviewStatus = item.status;
        finding.proposedTranslation = item.proposedTranslation;
        if (item.status === 'reverted') {
          finding.applicationStatus = 'dismissed';
          finding.applicationMethod = 'automatic-bilingual-review-reverted';
          delete finding.appliedResultId;
          updateFindingReverted.run(JSON.stringify(finding), row.finding_id);
          autoReverted.push({ segmentId: item.segmentId, findingId: row.finding_id });
        } else {
          finding.applicationStatus = 'applied';
          finding.applicationMethod = 'automatic-bilingual-verification';
          finding.appliedResultId = row.candidate_result_id;
          updateFindingApplied.run(JSON.stringify(finding), row.finding_id);
          autoApplied.push({ segmentId: item.segmentId, findingId: row.finding_id });
        }
      }
    }
    db.exec('COMMIT');
    if (autoApplied.length || autoReverted.length) {
      store.addEvent(projectId, runId, 'chinese-editorial.bilingual-finalized', {
        appliedCount: autoApplied.length,
        applied: autoApplied,
        revertedCount: autoReverted.length,
        reverted: autoReverted,
        policy: 'complete-bilingual-review; source-pinned-candidate; uncovered-edits-fall-back-to-first-pass',
      });
    }
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * 采纳或驳回可选文风建议。采纳是显式用户决策，仅当建议仍针对当前原文时才记录新的已采纳人工译文。
 */
export function setReviewFindingDisposition(store: DocumentProjectStore, projectId: string, runId: string, findingId: number, action: 'apply' | 'dismiss'): any {
  const db = store.openProjectDb(projectId);
  const now = isoNow();
  let result: any;
  let statusEvent: { status: RunStatus; error: string | null } | null = null;

  // 源文版本、发现状态、最新已采纳文本和处理决定，必须在同一把写锁下判定。
  // 在 BEGIN IMMEDIATE 之前检查其中任何一项，都会留下跨标签页覆盖的竞态。
  db.exec('BEGIN IMMEDIATE');
  try {
    const { currentSourceRevisionId } = store.getProjectContext(projectId);
    const row = db.prepare(
      'SELECT rf.finding_id, rf.segment_id, rf.category, rf.finding_json, rf.status AS finding_status, ' +
      'rf.created_at AS finding_created_at, tr.source_revision_id, rs.source_hash AS run_source_hash ' +
      'FROM review_findings rf JOIN translation_runs tr ON tr.run_id = rf.run_id ' +
      'JOIN run_segments rs ON rs.run_id = rf.run_id AND rs.segment_id = rf.segment_id ' +
      'WHERE rf.finding_id = ? AND rf.run_id = ?',
    ).get(findingId, runId) as any;
    if (!row) throw Object.assign(new Error('找不到这条审校建议'), { status: 404 });
    if (row.category !== 'style') throw Object.assign(new Error('只有文风建议支持手动采纳或保留'), { status: 400 });
    if (row.source_revision_id !== currentSourceRevisionId) {
      throw Object.assign(new Error('这条审校建议属于旧原文版本，不能应用到当前文档'), { status: 409 });
    }
    const finding = parseJson<any>(row.finding_json, {});
    if (action === 'apply' && finding.editorialMode === 'chinese-monolingual' &&
        !['verified', 'corrected'].includes(String(finding.bilingualReviewStatus || ''))) {
      throw Object.assign(new Error('中文编辑建议尚未完成双语忠实度复核，暂时不能采纳。'), { status: 409 });
    }

    if (action === 'apply' && row.finding_status === 'applied' && finding.applicationStatus === 'applied' && finding.appliedResultId) {
      const saved = db.prepare(
        'SELECT translation_text FROM translation_results WHERE result_id = ? AND accepted = 1',
      ).get(finding.appliedResultId) as { translation_text?: string } | undefined;
      if (saved?.translation_text) {
        db.exec('ROLLBACK');
        return {
          findingId, segmentId: row.segment_id, applicationStatus: 'applied',
          resultId: finding.appliedResultId, text: saved.translation_text, alreadyApplied: true,
        };
      }
    }
    if (action === 'dismiss' && (row.finding_status === 'dismissed' || finding.applicationStatus === 'dismissed')) {
      db.exec('ROLLBACK');
      return { findingId, segmentId: row.segment_id, applicationStatus: 'dismissed', alreadyDismissed: true };
    }
    if (action === 'dismiss' && (row.finding_status === 'applied' || finding.applicationStatus === 'applied')) {
      throw Object.assign(new Error('文风建议已经应用为人工译文，不能直接撤销；请在正文中手工编辑。'), { status: 409 });
    }
    if (row.finding_status !== 'pending' && !(action === 'apply' && finding.applicationStatus === 'applied')) {
      throw Object.assign(new Error('这条文风建议已被处理，不能再次修改状态。'), { status: 409 });
    }

    if (action === 'apply') {
      const proposed = typeof finding.proposedTranslation === 'string' ? finding.proposedTranslation.trim() : '';
      if (!proposed || proposed.length > 20000) {
        throw Object.assign(new Error('这条文风建议没有可用的完整候选译文'), { status: 400 });
      }
      const source = db.prepare(
        'SELECT source_hash FROM source_segments WHERE source_revision_id = ? AND segment_id = ?',
      ).get(currentSourceRevisionId, row.segment_id) as { source_hash?: string } | undefined;
      if (!source || source.source_hash !== row.run_source_hash) {
        throw Object.assign(new Error('原文片段已变化，拒绝应用基于旧文本生成的文风建议'), { status: 409 });
      }

      // 这条发现创建之后被采纳的任何译文都要拒绝，不只是手工编辑。
      // 这样能同时拦住另一个标签页里之后跑完的 Agent 结果，以及用户后来的修正。
      const latestAccepted = db.prepare(
        'SELECT origin, COALESCE(accepted_at, created_at) AS accepted_at FROM translation_results ' +
        'WHERE source_revision_id = ? AND segment_id = ? AND source_hash = ? AND accepted = 1 ' +
        'ORDER BY COALESCE(accepted_at, created_at) DESC, rowid DESC LIMIT 1',
      ).get(currentSourceRevisionId, row.segment_id, source.source_hash) as { origin?: string; accepted_at?: string } | undefined;
      if (latestAccepted?.accepted_at && String(latestAccepted.accepted_at) >= String(row.finding_created_at || '')) {
        throw Object.assign(
          new Error('该片段在生成建议后已有译文被采纳或人工修改；为避免覆盖最新版本，请先核对正文，再手工决定是否采用此建议。'),
          { status: 409 },
        );
      }

      const latestPrompt = db.prepare(
        'SELECT prompt_revision_id FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1',
      ).get() as { prompt_revision_id?: string } | undefined;
      const resultId = randomUUID();
      db.prepare(
        'INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) ' +
        "VALUES (?, NULL, ?, ?, ?, ?, 'manual', ?, 'manual', 1, ?, ?)",
      ).run(resultId, currentSourceRevisionId, latestPrompt?.prompt_revision_id || null, row.segment_id, source.source_hash, proposed, now, now);
      finding.applicationStatus = 'applied';
      finding.appliedResultId = resultId;
      const findingUpdate = db.prepare(
        "UPDATE review_findings SET status = 'applied', finding_json = ? WHERE finding_id = ? AND run_id = ? AND status = 'pending'",
      ).run(JSON.stringify(finding), findingId, runId);
      if (Number(findingUpdate.changes || 0) !== 1) {
        throw Object.assign(new Error('这条文风建议刚刚被另一个操作处理；请刷新后重试。'), { status: 409 });
      }
      db.prepare(
        "UPDATE run_segments SET status = 'accepted', candidate_result_id = ?, error = NULL, updated_at = ? " +
        'WHERE run_id = ? AND segment_id = ?',
      ).run(resultId, now, runId, row.segment_id);

      const currentRun = db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
      if (currentRun && !['cancelled', 'paused'].includes(String(currentRun.status))) {
        const counts = db.prepare(
          'SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status',
        ).all(runId) as any[];
        const values = Object.fromEntries(counts.map((item) => [item.status, Number(item.count)]));
        const unresolved = Number(values.candidate || 0) + Number(values.pending || 0) + Number(values.running || 0);
        const failures = Number(values.failed || 0);
        if (!unresolved) {
          const acceptedCount = Number(values.accepted || 0);
          const terminalStatus: RunStatus = failures
            ? acceptedCount > 0 ? 'partial' : 'failed'
            : 'completed';
          if (terminalStatus !== currentRun.status) {
            const terminalError = failures ? formatFailedSegmentSummary(failures) : null;
            db.prepare('UPDATE translation_runs SET status = ?, error = ?, finished_at = ? WHERE run_id = ?')
              .run(terminalStatus, terminalError, now, runId);
            statusEvent = { status: terminalStatus, error: terminalError };
          }
        }
      }
      result = { findingId, segmentId: row.segment_id, applicationStatus: 'applied', resultId, text: proposed };
    } else {
      finding.applicationStatus = 'dismissed';
      const findingUpdate = db.prepare(
        "UPDATE review_findings SET status = 'dismissed', finding_json = ? WHERE finding_id = ? AND run_id = ? AND status = 'pending'",
      ).run(JSON.stringify(finding), findingId, runId);
      if (Number(findingUpdate.changes || 0) !== 1) {
        throw Object.assign(new Error('这条文风建议刚刚被处理；请刷新后重试。'), { status: 409 });
      }
      result = { findingId, segmentId: row.segment_id, applicationStatus: 'dismissed' };
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }

  if (statusEvent) store.addEvent(projectId, runId, 'run.' + statusEvent.status, { error: statusEvent.error || undefined });
  store.addEvent(projectId, runId, action === 'apply' ? 'review-finding.applied' : 'review-finding.dismissed', {
    findingId, segmentId: result.segmentId, ...(result.resultId ? { resultId: result.resultId } : {}),
  });
  store.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
  return result;
}

/**
 * 候选译文的唯一采纳事务边界。
 * Run 状态检查、候选选择、source hash 对齐、人工编辑保护和 accepted 标记在同一写事务中完成；
 * 允许经过验证的 Run 终结流程自动调用，但不得绕过版本及人工修订保护。
 */
export function acceptCandidates(store: DocumentProjectStore, projectId: string, runId: string, segmentIds?: string[]): any {
  const db = store.openProjectDb(projectId);
  const only = segmentIds?.length ? new Set(segmentIds) : null;
  const now = isoNow();
  let accepted = 0;
  const preservedManual: string[] = [];
  const preservedNewerAccepted: string[] = [];
  let finalStatus: RunStatus = 'completed';
  let terminalError: string | null = null;

  // Run 状态校验、候选选取与采纳写入共用同一把写锁。
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status, error, source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string; error?: string | null; source_revision_id?: string } | undefined;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    const currentSource = db.prepare("SELECT value FROM project_meta WHERE key = 'current_source_revision_id'").get() as { value?: string } | undefined;
    if (!run.source_revision_id || run.source_revision_id !== currentSource?.value) {
      throw Object.assign(new Error('候选译文属于旧原文版本，不能采纳；请基于当前原文重新运行。'), { status: 409 });
    }
    if (['cancelled', 'queued', 'running'].includes(String(run.status))) {
      throw Object.assign(
        new Error('运行处于 ' + run.status + ' 状态，不能采纳候选译文；请先完成或暂停运行。'),
        { status: 409 },
      );
    }
    const rows = db.prepare(
      'SELECT rs.segment_id, rs.candidate_result_id FROM run_segments rs ' +
      "WHERE rs.run_id = ? AND rs.status = 'candidate' AND rs.candidate_result_id IS NOT NULL",
    ).all(runId) as any[];
    for (const row of rows) {
      if (only && !only.has(row.segment_id)) continue;
      const candidate = db.prepare(
        'SELECT rowid AS seq, source_hash FROM translation_results WHERE result_id = ? AND run_id = ?',
      ).get(row.candidate_result_id, runId) as { seq?: number; source_hash?: string } | undefined;
      if (!candidate) throw Object.assign(new Error('候选译文记录已丢失，拒绝采纳片段：' + row.segment_id), { status: 409 });
      // 保护同一来源 hash 上的用户手动译文：若存在手动译文，则跳过采纳并标记为已保留。
     const sameSourceManual = db.prepare(
        "SELECT result_id FROM translation_results WHERE segment_id = ? AND accepted = 1 AND origin = 'manual' AND source_hash = ? ORDER BY rowid DESC LIMIT 1",
      ).get(row.segment_id, candidate.source_hash);
      const newerAccepted = db.prepare(
        'SELECT result_id, origin FROM translation_results WHERE segment_id = ? AND source_hash = ? AND accepted = 1 AND rowid > ? ORDER BY rowid DESC LIMIT 1',
      ).get(row.segment_id, candidate.source_hash, candidate.seq) as { result_id?: string; origin?: string } | undefined;
      if (sameSourceManual || newerAccepted) {
        if (sameSourceManual) preservedManual.push(row.segment_id);
        else preservedNewerAccepted.push(row.segment_id);
        db.prepare(
          "UPDATE run_segments SET status = 'accepted', updated_at = ? WHERE run_id = ? AND segment_id = ?",
        ).run(now, runId, row.segment_id);
        continue;
      }
      db.prepare(
        'UPDATE translation_results SET accepted = 1, accepted_at = ? WHERE result_id = ? AND run_id = ?',
      ).run(now, row.candidate_result_id, runId);
      db.prepare(
        "UPDATE run_segments SET status = 'accepted', updated_at = ? WHERE run_id = ? AND segment_id = ?",
      ).run(now, runId, row.segment_id);
      accepted++;
    }

    const counts = db.prepare(
      'SELECT status, COUNT(*) AS count FROM run_segments WHERE run_id = ? GROUP BY status',
    ).all(runId) as Array<{ status: string; count: number }>;
    const values = Object.fromEntries(counts.map((item) => [item.status, Number(item.count)]));
    const candidates = Number(values.candidate || 0);
    const pending = Number(values.pending || 0) + Number(values.running || 0);
    const failures = Number(values.failed || 0);
    const acceptedCount = Number(values.accepted || 0);
    if (pending > 0) {
      if (run.status !== 'paused') {
        throw Object.assign(new Error('运行仍包含待处理或执行中的片段，拒绝结束采纳事务。'), { status: 409 });
      }
      // 用户可以在 Run 暂停期间采纳已完成的候选，但这绝不能
      // 把这个只做了一半的 Run 变成 completed 或 awaiting_acceptance。
      finalStatus = 'paused';
      terminalError = run.error ?? null;
    } else if (candidates > 0) {
      finalStatus = acceptedCount > 0 && failures > 0 ? 'partial' : 'awaiting_acceptance';
      terminalError = failures ? formatFailedSegmentSummary(failures) : null;
    } else if (failures > 0) {
      finalStatus = acceptedCount > 0 ? 'partial' : 'failed';
      terminalError = formatFailedSegmentSummary(failures);
    } else {
      finalStatus = 'completed';
      terminalError = null;
    }
    db.prepare('UPDATE translation_runs SET status = ?, error = ?, finished_at = ? WHERE run_id = ?')
      .run(finalStatus, terminalError, now, runId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }

  store.addEvent(projectId, runId, 'run.' + finalStatus, { error: terminalError || undefined });
  store.addEvent(projectId, runId, 'translations.accepted', {
    count: accepted,
    preservedManualSegmentIds: preservedManual,
    preservedNewerAcceptedSegmentIds: preservedNewerAccepted,
    segmentIds: only ? Array.from(only) : undefined,
  });
  return store.getRun(projectId, runId);
}

/**
 * 将旧阅读器/IndexedDB 已有的译文一次性纳入项目版本库。只填充当前来源中尚无
 * accepted 译文的片段，不覆盖本机 workspace 已经版本化的人工修订或 Agent 结果。
 * 当前 Prompt 指纹作为导入基线，避免第一次切换到 workspace 后把整本旧译文全部判过期。
 */
export function importAcceptedTranslations(store: DocumentProjectStore, projectId: string, items: unknown): { imported: number; skipped: number } {
  if (!Array.isArray(items) || items.length > 1000) {
    throw Object.assign(new Error('译文导入必须是最多 1000 条记录的数组'), { status: 400 });
  }
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const currentSegments = new Map(
    (db.prepare('SELECT segment_id, source_hash FROM source_segments WHERE source_revision_id = ?').all(currentSourceRevisionId) as Array<{ segment_id: string; source_hash: string }>)
      .map((row) => [row.segment_id, row]),
  );
  const promptRow = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  if (!promptRow) throw new Error('导入译文前必须先保存当前 Prompt');
  const config = parseJson<any>(promptRow.config_json, {});
  const currentMemory = store.getCurrentLiteraryMemory(projectId);
  const currentRunFingerprint = store.makeRunFingerprint(projectId, currentSourceRevisionId, promptRow, config, currentMemory.fingerprint || null);
  // 旧版 Reader/IndexedDB 文本不带流水线版本出处。在文学模式下，
  // 不能把它当成已经过当前术语强制与 Reviewer 流程的产物。
  // 保留可见以便恢复，但标记为过期，让 Project Run 能安全重生成。
  const runFingerprint = config.translationMode === 'literary'
    ? 'legacy-literary-import:' + currentRunFingerprint
    : currentRunFingerprint;
  const now = isoNow();
  let imported = 0;
  let skipped = 0;
  const insert = db.prepare(
    'INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) ' +
    "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'imported', 1, ?, ?)",
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skipped++; continue; }
      const item = raw as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      const source = currentSegments.get(id);
      if (!id || !source || !text || text.length > 20000) { skipped++; continue; }
      const existing = db.prepare(
        'SELECT result_id FROM translation_results WHERE segment_id = ? AND source_hash = ? AND accepted = 1 LIMIT 1',
      ).get(id, source.source_hash);
      if (existing) { skipped++; continue; }
      insert.run(randomUUID(), currentSourceRevisionId, promptRow.prompt_revision_id, id,
        source.source_hash, runFingerprint, text, now, now);
      imported++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (imported) {
    store.addEvent(projectId, null, 'translations.imported', { imported, skipped, sourceRevisionId: currentSourceRevisionId });
    store.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
  }
  return { imported, skipped };
}

/**
 * 保存用户手动编辑的译文，origin=manual 且自动采纳。
 */
export function saveManualEdit(store: DocumentProjectStore, projectId: string, segmentId: string, text: string): any {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw Object.assign(new Error('译文不能为空或超过 20000 字符'), { status: 400 });
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const source = db.prepare('SELECT * FROM source_segments WHERE source_revision_id = ? AND segment_id = ?').get(currentSourceRevisionId, segmentId) as any;
  if (!source) throw Object.assign(new Error('找不到源片段：' + segmentId), { status: 404 });
  const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  const latestPrompt = db.prepare('SELECT prompt_revision_id FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  const resultId = randomUUID();
  db.prepare('INSERT INTO translation_results(result_id, run_id, source_revision_id, prompt_revision_id, segment_id, source_hash, run_fingerprint, translation_text, origin, accepted, created_at, accepted_at) VALUES (?, NULL, ?, ?, ?, ?, \'manual\', ?, \'manual\', 1, ?, ?)' )
    .run(resultId, currentSourceRevisionId, latestPrompt?.prompt_revision_id || null, segmentId, source.source_hash, text, isoNow(), isoNow());
  store.addEvent(projectId, null, 'translation.manually-edited', { segmentId, resultId });
  store.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
  return { resultId, segmentId, text, origin: 'manual', accepted: true };
}
