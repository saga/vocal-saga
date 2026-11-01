/**
 * 质量修复运行：把审计命中的片段打包成一次候选运行，交给人工确认。
 *
 * 从 qualityAudit 抽出：修复运行是审计的下游动作（产出仍是候选，不自动采纳），
 * 和审计规则本身分开后，「谁能触发修复」这条约束更醒目。
 */

import { getDocumentProjectStore } from './projectStore.ts';
import { fail } from './qualityShared.ts';
import { acceptedTranslations, translationSnapshotHash } from './qualityAuditData.ts';

/**
 * 根据指定审计 finding 创建一个新的窄范围返工 Run。
 * 先验证报告仍属于当前 source revision，再解析 finding/segment 范围；大范围 finding 要求调用方
 * 显式提交 segmentIds，避免“修一个问题”隐式扩展成整组/整章返工。手动返工仍需用户采纳；
 * 自动返工只能由 Run 策略启用，并在服务端经同一采纳事务完成。
 */
export function createQualityRepairRun(
  projectId: string,
  auditId: string,
  selectedFindingIds: string[],
  requestedSegmentIds: string[] = [],
  options: { automatic?: boolean; parentRunId?: string } = {},
): any {
  const store = getDocumentProjectStore();
  const report = store.getQualityAudit(projectId, auditId) as any;
  if (!report) fail('找不到质量审计报告：' + auditId, 404);
  const projectContext = store.getProjectContext(projectId);
  const { currentSourceRevisionId, db } = projectContext;
  if (report.sourceRevisionId !== currentSourceRevisionId) fail('来源版本已变化，旧质量报告不能用于返工。', 409);

  const currentSourceSegments = db.prepare(
    'SELECT segment_id AS id FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(currentSourceRevisionId) as Array<{ id: string }>;
  const storedAcceptedTranslations = acceptedTranslations(db, currentSourceRevisionId);
  const currentAcceptedSnapshotHash = translationSnapshotHash(currentSourceSegments, storedAcceptedTranslations);
  const acceptedSnapshotAtAudit = typeof report.acceptedTranslationSnapshotHash === 'string'
    ? report.acceptedTranslationSnapshotHash : '';
  const effectiveSnapshotAtAudit = typeof report.translationSnapshotHash === 'string'
    ? report.translationSnapshotHash : '';
  if (!acceptedSnapshotAtAudit || !effectiveSnapshotAtAudit) {
    fail('该质量报告未记录译文快照，无法安全判断问题是否已被修正。请重新执行全书审计后再返工。', 409);
  }
  // A run's candidates may be accepted after the audit. That is safe only if the whole accepted
  // text now equals either the accepted snapshot or the effective text actually audited. Aggregate
  // hashes keep the report compact; a different third snapshot means the audit is stale.
  if (currentAcceptedSnapshotHash !== acceptedSnapshotAtAudit &&
      currentAcceptedSnapshotHash !== effectiveSnapshotAtAudit) {
    fail('审计后已有译文被修改；旧质量报告不能用于返工，请重新执行全书审计。', 409);
  }
  const wantedFindings = new Set(selectedFindingIds);
  const selectedFindings = (report.findings || []).filter((finding: any) => wantedFindings.has(finding.findingId));
  const parentRunId = options.parentRunId || report.runId || undefined;

  // Automatic repair is deliberately narrower than manual repair: it may only apply
  // deterministic missing-translation findings, and only to segments that belonged to
  // the completed parent Run. A book-level audit must never turn a partial Run into a
  // background whole-book translation request.
  const automaticFindingSegmentIds = new Set<string>();
  if (options.automatic) {
    if (!parentRunId) fail('自动返工必须关联已完成的父运行。', 400);
    if (!selectedFindingIds.length || selectedFindings.length !== wantedFindings.size ||
        selectedFindings.some((finding: any) =>
          finding.type !== 'missing-translation' || finding.repairable !== true)) {
      fail('自动返工只允许使用明确选中的、可修复的 missing-translation 发现。', 400);
    }
    for (const finding of selectedFindings) {
      for (const id of finding.segmentIds || []) automaticFindingSegmentIds.add(String(id));
    }
    if (requestedSegmentIds.some((id) => !automaticFindingSegmentIds.has(String(id)))) {
      fail('自动返工的 segmentIds 必须来自所选缺译发现。', 409);
    }
    const parent = db.prepare(
      'SELECT source_revision_id, status FROM translation_runs WHERE run_id = ?',
    ).get(parentRunId) as { source_revision_id?: string; status?: string } | undefined;
    if (!parent) fail('找不到自动返工的父运行：' + parentRunId, 404);
    if (parent.source_revision_id !== currentSourceRevisionId) {
      fail('自动返工的父运行与当前来源版本不同。', 409);
    }
    if (!['completed', 'partial'].includes(String(parent.status))) {
      fail('自动返工只能由已完成或部分完成的父运行触发。', 409);
    }
    const parentSegmentIds = new Set((db.prepare(
      'SELECT segment_id FROM run_segments WHERE run_id = ?',
    ).all(parentRunId) as Array<{ segment_id: string }>).map((row) => String(row.segment_id)));
    const outOfScopeIds = Array.from(automaticFindingSegmentIds).filter((id) => !parentSegmentIds.has(id));
    if (outOfScopeIds.length) {
      fail('自动返工超出父运行范围，已拒绝：' + outOfScopeIds.slice(0, 8).join(', '), 409);
    }
  }

  // Explicit segment IDs mean a genuinely narrow manual repair. They must not expand to
  // every segment in a repeated-expression group simply because it belongs to one finding.
  const segments = new Set<string>(requestedSegmentIds.map(String).filter(Boolean));
  if (!requestedSegmentIds.length) {
    for (const finding of selectedFindings) {
      if (!finding.repairable) {
        fail('该质量发现涉及较多片段，为避免扩大返工，请显式提供要修改的 segmentIds。');
      }
      for (const id of finding.segmentIds || []) segments.add(String(id));
    }
  }
  if (!segments.size) fail('没有选中可返工的质量发现；请提供报告中的 findingId 或 segmentId。');
  const currentIds = new Set(currentSourceSegments.map((row) => String(row.id)));
  const selected = Array.from(segments).filter((id) => currentIds.has(id));
  if (!selected.length) fail('选定的返工片段不属于当前来源版本。', 409);
  const run = store.createRun(projectId, {
    scope: {
      type: 'ids',
      ids: selected,
      ...(options.automatic ? { automation: { kind: 'quality-audit-repair', pass: 1 } } : {}),
    },
    ...(parentRunId ? { parentRunId } : {}),
  });
  store.appendEvent(projectId, run.runId, 'quality-repair.planned', {
    auditId, parentRunId: parentRunId || null, segmentIds: selected,
    automatic: options.automatic === true,
    humanAcceptanceRequired: options.automatic !== true,
  });
  return { auditId, run, segmentIds: selected, humanAcceptanceRequired: options.automatic !== true, automatic: options.automatic === true };
}
