/**
 * 文学记忆清洗与检索共用的基础件：有界文本裁剪、状态归一、名称比较与哈希。
 *
 * 从 voiceContext 抽出：这些函数只看单个字段，不含记忆结构知识，
 * 因此清洗器（literaryMemorySanitize）与检索器（voiceContext）可以共用同一套口径。
 */
import { createHash } from 'node:crypto';
import { hasCompoundCanonicalSyntax, isWorthCanonicalEntityMapping, normalizeCanonicalEntityKind, validateCanonicalTarget } from './canonicalEntityPolicy.ts';

// 持久化安全上限，不是提示词预算。要给长篇记忆留够空间。
export const MAX_MEMORY_BYTES = 5 * 1024 * 1024;
export const MAX_RELATION_RULES = 160;
export const MAX_ANCHORS = 240;

/**
 * 把任意值转为单行、去控制字符、截断到 max 长度的清洗文本；非字符串返回空串。
 */
export function text(value: unknown, max = 300): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}
/**
 * 将输入数组清洗为去重、截断后的字符串数组；非数组返回空数组。
 */
export function list(value: unknown, maxItems: number, maxLength = 180): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => text(item, maxLength)).filter(Boolean))).slice(0, maxItems);
}
/**
 * 若 value 属于 allowed 则返回 value，否则返回 fallback；用于状态字段白名单校验。
 */
export function status(value: unknown, allowed: string[], fallback = 'candidate'): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

export type ConfirmationSource = 'model-default' | 'user-modified' | 'evidence-verified' | 'user-confirmed' | 'legacy-unknown';
/**
 * 仅当 active 为 true 时返回确认来源（白名单校验，未知回退 legacy-unknown）；否则 undefined。
 */
export function confirmationSource(value: unknown, active: boolean): ConfirmationSource | undefined {
  if (!active) return undefined;
  return value === 'model-default' || value === 'user-modified' || value === 'evidence-verified' || value === 'user-confirmed' || value === 'legacy-unknown'
    ? value : 'legacy-unknown';
}
/**
 * 将输入解析为 [0,1] 范围的有限数值；null/undefined/空串返回 null，非法返回 null。
 */
export function numericConfidence(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const score = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
}
/**
 * 对字符串做 SHA-256 哈希，用于生成稳定 ID（如 anchorId）。
 */
export function safeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 按确认来源的优先级（user-confirmed > model-default > evidence-verified > legacy-unknown）合并，
 * 仅在 incoming 优先级更高时采用 incoming，避免降级。
 */
export function mergeConfirmationSource(prior: unknown, incoming: unknown): unknown {
  const rank = (value: unknown) => value === 'user-confirmed' ? 4 :
    value === 'model-default' ? 3 : value === 'evidence-verified' ? 2 : value === 'legacy-unknown' ? 1 : 0;
  return rank(incoming) > rank(prior) ? incoming : prior;
}

/**
 * 对实体名做 NFKC 归一化、小写化与空白/标点折叠，用于匹配与去重。
 */
export function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s._'’\-]+/g, ' ').trim();
}

/**
 * 名称匹配时避免短拉丁名被当作任意子串（如 "Ann" 不应匹配 "annual"）；
 * 非拉丁（CJK）名称仍用归一化子串匹配，以支持自然的中文名匹配。
 */
export function containsEntityName(sourceText: string, candidateName: string): boolean {
  const source = normalizeEntityName(sourceText);
  const name = normalizeEntityName(candidateName);
  if (!source || !name) return false;
  if (/^[a-z0-9 ]+$/.test(name)) {
    const latinSource = source.replace(/[^a-z0-9]+/g, ' ').trim();
    const latinName = name.replace(/[^a-z0-9]+/g, ' ').trim();
    // 像 "A." 这样的单字母别名太含糊，不足以检索到档案：
    // 否则每篇文章里的冠词 "a" 都能把那个角色的声音规则注进来。
    if (latinName.length < 2) return false;
    return (' ' + latinSource + ' ').includes(' ' + latinName + ' ');
  }
  return source.includes(name);
}

/**
 * 仅当两个实体的来源/别名集合显式重叠时才合并；保留首个规范来源与译名，
 * 后续章节可补充别名/证据，但不得静默引入同一人物/对象的竞争译名。
 */
export function mergeProjectEntityRecord(prior: Record<string, any>, candidate: Record<string, any>): Record<string, any> {
  const canonicalName = normalizeEntityName(prior.source);
  const aliases = new Map<string, string>();
  for (const alias of [...(prior.aliases ?? []), prior.source, ...(candidate.aliases ?? []), candidate.source]) {
    const key = normalizeEntityName(alias);
    if (key && key !== canonicalName && !aliases.has(key)) aliases.set(key, alias);
  }
  const canMergeEvidenceRefs = prior.reviewStatus !== 'confirmed' ||
    (Array.isArray(prior.evidenceRefs) && prior.evidenceRefs.length > 0);
  const evidenceRefs = canMergeEvidenceRefs
    ? [...(Array.isArray(prior.evidenceRefs) ? prior.evidenceRefs : []),
        ...(Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [])]
        .filter((item, index, all) => all.findIndex((other) =>
          other.segmentId === item.segmentId && normalizeEntityName(other.sourceQuote) === normalizeEntityName(item.sourceQuote)) === index)
        .slice(0, 8)
    : [];
  const sameTarget = normalizeEntityName(String(prior.target || '')) === normalizeEntityName(String(candidate.target || ''));
  const targetEvidenceRefs = sameTarget
    ? [...(Array.isArray(prior.targetEvidenceRefs) ? prior.targetEvidenceRefs : []),
        ...(Array.isArray(candidate.targetEvidenceRefs) ? candidate.targetEvidenceRefs : [])]
        .filter((item, index, all) => all.findIndex((other) =>
          other.segmentId === item.segmentId && normalizeEntityName(other.targetSurface) === normalizeEntityName(item.targetSurface)) === index)
        .slice(-8)
    : (Array.isArray(prior.targetEvidenceRefs) ? prior.targetEvidenceRefs : []);
  const targetEvidenceCount = new Set(targetEvidenceRefs
    .filter((item: any) => normalizeEntityName(String(item?.targetSurface || '')) === normalizeEntityName(String(prior.target || '')))
    .map((item: any) => String(item?.segmentId || '')).filter(Boolean)).size;
  return {
    ...prior,
    aliases: Array.from(aliases.values()).slice(0, 8),
    targetEvidenceRefs,
    targetConfidence: prior.reviewStatus === 'confirmed' ? 'confirmed' :
      targetEvidenceCount >= 2 ? 'corroborated' : 'candidate',
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
    ...(prior.reviewStatus !== 'confirmed' && candidate.reviewStatus === 'confirmed' &&
        normalizeEntityName(prior.target) === normalizeEntityName(candidate.target)
      ? { reviewStatus: 'confirmed' }
      : {}),
    ...(sameTarget && (prior.reviewStatus === 'confirmed' || candidate.reviewStatus === 'confirmed')
      ? { confirmationSource: mergeConfirmationSource(prior.confirmationSource, candidate.confirmationSource) }
      : {}),
    description: prior.description || candidate.description,
    evidence: prior.evidence || candidate.evidence,
  };
}

/**
 * 折叠所有显式别名组，包括新行桥接两个旧行的情况；按 kind/名称重叠合并。
 */
export function dedupeProjectEntities(entities: Array<Record<string, any>>): Array<Record<string, any>> {
  const merged: Array<Record<string, any>> = [];
  for (const entity of entities) {
    const names = new Set([entity.source, ...(entity.aliases ?? [])].map(normalizeEntityName).filter(Boolean));
    const matchingIndices: number[] = [];
    merged.forEach((prior, index) => {
      if (prior.kind !== entity.kind && prior.kind !== 'other' && entity.kind !== 'other') return;
      const priorNames = new Set([prior.source, ...(prior.aliases ?? [])].map(normalizeEntityName).filter(Boolean));
      if (Array.from(names).some((name) => priorNames.has(name))) matchingIndices.push(index);
    });
    if (!matchingIndices.length) {
      merged.push(entity);
      continue;
    }
    const canonicalIndex = matchingIndices[0]!;
    let canonical = merged[canonicalIndex]!;
    for (const index of matchingIndices.slice(1)) canonical = mergeProjectEntityRecord(canonical, merged[index]!);
    canonical = mergeProjectEntityRecord(canonical, entity);
    for (const index of matchingIndices.slice(1).reverse()) merged.splice(index, 1);
    merged[canonicalIndex] = canonical;
  }
  return merged;
}

export interface ProjectVoiceContextSegment {
  id: string;
  text: string;
  contextPath?: string;
  kind?: string;
}
