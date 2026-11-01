/**
 * 审计的数据入口：读取当前源文版本、已采纳译文、运行候选覆盖、记忆与术语表，
 * 以及计算译文快照哈希（用于判断两次审计之间译文有没有变）。
 *
 * 从 qualityAudit 抽出：这里是审计与存储层之间唯一的接缝，
 * 各类审计规则只消费这里产出的内存结构，不再直接摸数据库。
 */

import { createHash } from 'node:crypto';
import { getDocumentProjectStore } from './projectStore.ts';
import { fail, normalized } from './qualityShared.ts';

/**
 * 读取当前来源版本的全部 source_segments。
 */
export function currentSource(projectId: string) {
  const store = getDocumentProjectStore();
  const context = store.getProjectContext(projectId);
  const rows = context.db.prepare(
    'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath, source_hash AS sourceHash ' +
    'FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(context.currentSourceRevisionId) as any[];
  return {
    store,
    context,
    segments: rows.map((row) => ({
      id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text), kind: String(row.kind || 'paragraph'),
      contextPath: String(row.contextPath || ''), sourceHash: String(row.sourceHash || ''),
    })),
  };
}

/**
 * 读取当前来源版本已采纳的译文映射（按 segment_id 去重，取最新）。
 */
export function acceptedTranslations(db: any, revisionId: string): Map<string, string> {
  const rows = db.prepare(
    'SELECT r.segment_id AS id, r.translation_text AS text, r.source_hash AS sourceHash ' +
    'FROM translation_results r JOIN source_segments s ON s.source_revision_id = r.source_revision_id ' +
    'AND s.segment_id = r.segment_id AND s.source_hash = r.source_hash ' +
    'WHERE r.source_revision_id = ? AND r.accepted = 1 ORDER BY r.rowid DESC'
  ).all(revisionId) as any[];
  const result = new Map<string, string>();
  for (const row of rows) if (!result.has(String(row.id))) result.set(String(row.id), String(row.text || ''));
  return result;
}

/**
 * 用指定 Run 的候选译文覆盖当前已采纳译文映射，供审计候选对比。
 */
export function overlayRunCandidates(db: any, revisionId: string, runId: string, translations: Map<string, string>): void {
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!run) fail('找不到质量审计指定的翻译运行：' + runId, 404);
  if (run.source_revision_id !== revisionId) fail('质量审计的翻译运行不属于当前来源版本，请先对当前版本重新翻译。', 409);
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, rs.source_hash AS sourceHash, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    'WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) {
    if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  }
}

/**
 * 计算译文文本的 SHA-256 哈希。
 */
function hashTranslationText(value: unknown): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * 计算来源片段与译文映射的聚合快照哈希，用于返工前的一致性校验。
 */
export function translationSnapshotHash(segments: Array<{ id: string }>, translations: Map<string, string>): string {
  const hashes = segments.map((segment) => [
    segment.id,
    hashTranslationText(translations.get(segment.id) || ''),
  ]);
  return createHash('sha256').update(JSON.stringify(hashes), 'utf8').digest('hex');
}

/**
 * 将 glossary 中的术语合并进 literary memory 的 entities 列表（去重、跳过候选/建议/拒绝状态）。
 */
export function memoryWithGlossary(memoryInput: Record<string, any>, glossary: unknown): Record<string, any> {
  const memory = memoryInput && typeof memoryInput === 'object' ? memoryInput : {};
  const existing = Array.isArray(memory.entities) ? [...memory.entities] : [];
  const existingSources = new Set(existing.map((item: any) => normalized(item?.source)).filter(Boolean));
  const glossaryObject = glossary && typeof glossary === 'object' && !Array.isArray(glossary)
    ? glossary as Record<string, any> : {};
  const terms = Array.isArray(glossaryObject.document_terms) ? glossaryObject.document_terms : [];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) continue;
    const source = String(term.source ?? term.source_term ?? term.term ?? term.original ?? term.en ?? term.from ?? '').trim();
    const target = String(term.target ?? term.target_term ?? term.translation ?? term.zh ?? term.to ?? '').trim();
    if (!source || !target) continue;
    if (['candidate', 'suggested', 'rejected'].includes(String(term.reviewStatus || term.status || '').toLowerCase())) continue;
    const key = normalized(source);
    if (existingSources.has(key)) continue;
    existingSources.add(key);
    existing.push({
      source,
      target,
      kind: String(term.kind || term.category || 'other'),
      aliases: Array.isArray(term.aliases) ? term.aliases.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [],
      reviewStatus: 'confirmed',
      evidence: typeof term.evidence === 'string' ? term.evidence : '',
    });
  }
  return { ...memory, entities: existing };
}

/**
 * 加载项目的 literary memory，并叠加最新 prompt revision 的 glossary。
 */
export function loadMemory(projectId: string, runId?: string): Record<string, any> {
  const store = getDocumentProjectStore();
  if (runId) {
    const context = store.getRunContext(projectId, runId);
    return memoryWithGlossary(context.memory, context.prompt?.config?.glossary);
  }
  const memory = store.getCurrentLiteraryMemory(projectId).memory;
  const { db } = store.getProjectContext(projectId);
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as { config_json?: string } | undefined;
  let glossary: unknown = null;
  try { glossary = row?.config_json ? JSON.parse(row.config_json).glossary : null; } catch { glossary = null; }
  return memoryWithGlossary(memory, glossary);
}
