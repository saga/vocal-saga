/**
 * 审校侧的审计输入：当前未决审校项、以及中文编辑阶段（分段/润色）的指标与告警。
 *
 * 从 qualityAudit 抽出：这些读数服务于「审校质量」这条线，和语言层面的审计规则无关，
 * 单独成模块后调整编辑阶段指标不会牵动审计主流程。
 */


/**
 * 读取指定/最新 style review 运行的 review_findings，过滤过期候选。
 */
export function currentReviewFindings(
  db: any,
  revisionId: string,
  requestedRunId?: string,
): { reviewRunId: string | null; findings: any[] } {
  let reviewRunId = requestedRunId || null;
  if (!reviewRunId) {
    const row = db.prepare(
      'SELECT tr.run_id FROM translation_runs tr ' +
      'WHERE tr.source_revision_id = ? AND tr.review_enabled = 1 ' +
      'AND (EXISTS (SELECT 1 FROM review_findings rf WHERE rf.run_id = tr.run_id) ' +
        'OR EXISTS (SELECT 1 FROM project_events pe WHERE pe.run_id = tr.run_id ' +
          "AND pe.event_type = 'stage.completed' AND pe.payload_json LIKE '%style-review%')) " +
      'ORDER BY tr.finished_at DESC, tr.created_at DESC LIMIT 1'
    ).get(revisionId) as any;
    reviewRunId = row?.run_id || null;
  }
  if (!reviewRunId) return { reviewRunId: null, findings: [] };
  const rows = db.prepare(
    'SELECT rf.finding_id, rf.segment_id, rf.category, rf.priority, rf.finding_json, rf.status, rf.created_at, ' +
    'rs.candidate_result_id, r.translation_text AS reviewed_translation ' +
    'FROM review_findings rf JOIN translation_runs tr ON tr.run_id = rf.run_id ' +
    'LEFT JOIN run_segments rs ON rs.run_id = rf.run_id AND rs.segment_id = rf.segment_id ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    "WHERE rf.run_id = ? AND tr.source_revision_id = ? AND rf.category = 'style' " +
    'ORDER BY rf.finding_id DESC LIMIT 300'
  ).all(reviewRunId, revisionId) as any[];
  const findings = rows.flatMap((row) => {
    const reviewedTranslation = typeof row.reviewed_translation === 'string' ? row.reviewed_translation : null;
    // 审计已采纳文本时（没指定 runId），要压掉旧候选留下的过期文风发现——
    // 那份译文已经不是当前源文版本的已采纳文本了。
    if (!requestedRunId) {
      const accepted = db.prepare(
        'SELECT translation_text FROM translation_results WHERE source_revision_id = ? AND segment_id = ? ' +
        'AND accepted = 1 ORDER BY rowid DESC LIMIT 1'
      ).get(revisionId, String(row.segment_id)) as { translation_text?: string } | undefined;
      if (!accepted || accepted.translation_text !== reviewedTranslation) return [];
    }
    let finding: any = {};
    try { finding = JSON.parse(row.finding_json); } catch { finding = {}; }
    return [{
      findingId: Number(row.finding_id),
      segmentId: String(row.segment_id),
      category: String(row.category),
      priority: String(row.priority),
      status: String(row.status),
      dimension: typeof finding.dimension === 'string' ? finding.dimension : null,
      characterId: typeof finding.characterId === 'string' ? finding.characterId : null,
      editorialMode: typeof finding.editorialMode === 'string' ? finding.editorialMode : null,
      bilingualReviewStatus: typeof finding.bilingualReviewStatus === 'string' ? finding.bilingualReviewStatus : 'not-required',
      applicationStatus: typeof finding.applicationStatus === 'string' ? finding.applicationStatus : 'pending',
      applicationMethod: typeof finding.applicationMethod === 'string' ? finding.applicationMethod : null,
      appliedResultId: typeof finding.appliedResultId === 'string' ? finding.appliedResultId : null,
      targetExcerpt: typeof finding.targetExcerpt === 'string' ? finding.targetExcerpt : null,
      sourceExcerpt: String(finding.sourceExcerpt || ''),
      draftExcerpt: String(finding.draftExcerpt || ''),
      evidenceSegmentIds: Array.isArray(finding.evidenceSegmentIds) ? finding.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string').slice(0, 8) : [],
      reason: String(finding.reason || ''),
      suggestion: String(finding.suggestion || ''),
      proposedTranslation: typeof finding.proposedTranslation === 'string' ? finding.proposedTranslation : null,
      reviewedTranslation,
      createdAt: row.created_at,
    }];
  }).reverse();
  return { reviewRunId, findings };
}

/**
 * 聚合 chinese-monolingual style-review 阶段事件中的编辑指标。
 */
export function chineseEditorialStageMetrics(
  db: any,
  revisionId: string,
  requestedRunId?: string,
): { runId: string | null; reviewedCount: number; editedCount: number; unchangedCount: number; uncoveredCount: number; findingCount: number } {
  let runId = requestedRunId || null;
  if (!runId) {
    const row = db.prepare(
      'SELECT tr.run_id FROM translation_runs tr JOIN project_events pe ON pe.run_id = tr.run_id ' +
      'WHERE tr.source_revision_id = ? AND pe.event_type = ? ' +
      "AND pe.payload_json LIKE '%chinese-monolingual%' " +
      'ORDER BY tr.finished_at DESC, pe.event_id DESC LIMIT 1'
    ).get(revisionId, 'stage.completed') as { run_id?: string } | undefined;
    runId = row?.run_id || null;
  }
  if (!runId) return { runId: null, reviewedCount: 0, editedCount: 0, unchangedCount: 0, uncoveredCount: 0, findingCount: 0 };
  const rows = db.prepare(
    "SELECT payload_json FROM project_events WHERE run_id = ? AND event_type = 'stage.completed' ORDER BY event_id"
  ).all(runId) as Array<{ payload_json: string }>;
  const totals = { runId, reviewedCount: 0, editedCount: 0, unchangedCount: 0, uncoveredCount: 0, findingCount: 0 };
  for (const row of rows) {
    let payload: any = {};
    try { payload = JSON.parse(row.payload_json); } catch { continue; }
    if (payload.stage !== 'style-review' || payload.editorialMode !== 'chinese-monolingual') continue;
    const metrics = payload.chineseEditorialMetrics || {};
    for (const key of ['reviewedCount', 'editedCount', 'unchangedCount', 'uncoveredCount', 'findingCount'] as const) {
      totals[key] += Math.max(0, Number(metrics[key]) || 0);
    }
  }
  return totals;
}

/**
 * 读取指定运行的中文单语编辑 findings。
 */
export function chineseEditorialFindingsForRun(db: any, revisionId: string, runId: string | null): any[] {
  if (!runId) return [];
  const rows = db.prepare(
    'SELECT rf.finding_id, rf.segment_id, rf.finding_json, rf.status ' +
    'FROM review_findings rf JOIN translation_runs tr ON tr.run_id = rf.run_id ' +
    "WHERE rf.run_id = ? AND tr.source_revision_id = ? AND rf.category = 'style' ORDER BY rf.finding_id"
  ).all(runId, revisionId) as any[];
  return rows.flatMap((row) => {
    let finding: any = {};
    try { finding = JSON.parse(row.finding_json); } catch { return []; }
    if (finding.editorialMode !== 'chinese-monolingual') return [];
    return [{
      findingId: Number(row.finding_id),
      segmentId: String(row.segment_id),
      status: String(row.status),
      bilingualReviewStatus: typeof finding.bilingualReviewStatus === 'string' ? finding.bilingualReviewStatus : 'pending',
      applicationStatus: typeof finding.applicationStatus === 'string' ? finding.applicationStatus : 'pending',
      applicationMethod: typeof finding.applicationMethod === 'string' ? finding.applicationMethod : null,
      appliedResultId: typeof finding.appliedResultId === 'string' ? finding.appliedResultId : null,
    }];
  });
}
