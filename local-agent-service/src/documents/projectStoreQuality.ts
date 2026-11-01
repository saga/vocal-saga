/**
 * 质量审计与盲评报告的存取。报告由 qualityAudit / qualityEvaluation 生成，这里只负责落库与回读。
 */
import { isoNow, parseJson } from './documentStoreUtils.ts';
import { type DocumentProjectStore } from './projectStore.ts';

/**
 * 保存质量审计报告（按 auditId 幂等更新）。
 */
export function saveQualityAudit(store: DocumentProjectStore, projectId: string, report: Record<string, any>): void {
  const db = store.openProjectDb(projectId);
  db.prepare(
    'INSERT INTO quality_audits(audit_id, source_revision_id, run_id, report_json, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(audit_id) DO UPDATE SET report_json=excluded.report_json'
  ).run(report.auditId, report.sourceRevisionId, report.runId || null, JSON.stringify(report), report.createdAt || isoNow());
}

/**
 * 读取质量审计报告（未指定 auditId 时取最新）。
 */
export function getQualityAudit(store: DocumentProjectStore, projectId: string, auditId?: string): any | null {
  const db = store.openProjectDb(projectId);
  const row = auditId
    ? db.prepare('SELECT report_json FROM quality_audits WHERE audit_id = ?').get(auditId) as any
    : db.prepare('SELECT report_json FROM quality_audits ORDER BY created_at DESC LIMIT 1').get() as any;
  return row?.report_json ? parseJson(row.report_json, null) : null;
}

/**
 * 保存质量对照评测（M4 A/B 映射与盲评）。
 */
export function saveQualityEvaluation(store: DocumentProjectStore, projectId: string, report: Record<string, any>, blindMapping: Record<string, unknown>, blindReviews: unknown[] = []): void {
  const db = store.openProjectDb(projectId);
  const now = isoNow();
  db.prepare(
    'INSERT INTO quality_evaluations(evaluation_id, source_revision_id, before_run_id, after_run_id, report_json, blind_mapping_json, blind_reviews_json, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(evaluation_id) DO UPDATE SET report_json=excluded.report_json, blind_mapping_json=excluded.blind_mapping_json, blind_reviews_json=excluded.blind_reviews_json, updated_at=excluded.updated_at'
  ).run(report.evaluationId, report.sourceRevisionId, report.beforeRunId, report.afterRunId, JSON.stringify(report), JSON.stringify(blindMapping), JSON.stringify(blindReviews), now, now);
}

/**
 * 读取质量对照评测。
 */
export function getQualityEvaluation(store: DocumentProjectStore, projectId: string, evaluationId: string): any | null {
  const db = store.openProjectDb(projectId);
  const row = db.prepare('SELECT report_json, blind_mapping_json, blind_reviews_json FROM quality_evaluations WHERE evaluation_id = ?').get(evaluationId) as any;
  if (!row) return null;
  return {
    report: parseJson(row.report_json, null),
    blindMapping: parseJson(row.blind_mapping_json, {}),
    blindReviews: parseJson(row.blind_reviews_json, []),
  };
}

/**
 * 更新质量对照评测的盲评结果。
 */
export function updateQualityEvaluationReviews(store: DocumentProjectStore, projectId: string, evaluationId: string, reviews: unknown[]): any {
  const db = store.openProjectDb(projectId);
  const row = db.prepare('SELECT blind_mapping_json, report_json FROM quality_evaluations WHERE evaluation_id = ?').get(evaluationId) as any;
  if (!row) throw Object.assign(new Error('找不到质量对照评测：' + evaluationId), { status: 404 });
  db.prepare('UPDATE quality_evaluations SET blind_reviews_json = ?, updated_at = ? WHERE evaluation_id = ?')
    .run(JSON.stringify(reviews), isoNow(), evaluationId);
  return {
    report: parseJson(row.report_json, null),
    blindMapping: parseJson(row.blind_mapping_json, {}),
    blindReviews: reviews,
  };
}
