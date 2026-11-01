/**
 * 名称类审计：规范译名的形态比对（别名、词序、通用词过滤）与术语表漂移。
 *
 * 从 qualityAudit 抽出：canonicalName* 是一组只服务于名称审计的私有助手，
 * 和数字/重复表达审计无关，单独成模块后名称规则可以独立演进。
 */

import { containsName, normalized, stableFindingId, targetPresent } from './qualityShared.ts';

const GENERIC_CANONICAL_NAME_FORMS = new Set([
  'lord', 'general', 'sire', 'council', 'regent', 'regents', 'ship',
  'sir', 'madam', 'madame', 'captain', 'lady', 'samurai',
]);

const CANONICAL_NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'lord', 'general', 'sire', 'sir', 'lady',
  'madam', 'madame', 'captain', 'master', 'mr', 'mrs', 'ms', 'san', 'sama',
]);

/**
 * 规范化规范名（去掉冠词、所有格后缀、尾部标点）。
 */
function normalizedCanonicalName(value: unknown): string {
  return normalized(value).replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s)\b/g, '').replace(/[.!?]+$/g, '').trim();
}

/**
 * 判断是否为通用规范名（如 lord/general 等），这类不参与审计。
 */
function isGenericCanonicalName(value: unknown): boolean {
  return GENERIC_CANONICAL_NAME_FORMS.has(normalizedCanonicalName(value));
}

/**
 * 提取规范名的身份 token（去除停用词）。
 */
function canonicalIdentityTokens(value: string): string[] {
  return normalizedCanonicalName(value).replace(/['’]s\b/g, '')
    .match(/[\p{Script=Latin}\p{M}\p{N}]+/gu)?.filter((token) => !CANONICAL_NAME_STOPWORDS.has(token)) || [];
}

/**
 * 判断别名与源规范名是否兼容（共享 token 或前缀）。
 */
function isCompatibleCanonicalAlias(source: string, alias: string): boolean {
  if (!/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(source) || !/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(alias)) return true;
  const sourceTokens = canonicalIdentityTokens(source);
  const aliasTokens = canonicalIdentityTokens(alias);
  if (!aliasTokens.length) return false;
  if (!sourceTokens.length) return true;
  return sourceTokens.some((sourceToken) => aliasTokens.some((aliasToken) =>
    sourceToken === aliasToken || sourceToken.startsWith(aliasToken) || aliasToken.startsWith(sourceToken)));
}

/**
 * 生成规范名及其兼容别名的候选形式列表。
 */
function canonicalNameForms(source: string, aliases: unknown): string[] {
  const candidates = [source, ...(Array.isArray(aliases) ? aliases : [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value) => !isGenericCanonicalName(value))
    .filter((value, index) => index === 0 || isCompatibleCanonicalAlias(source, value));
  return Array.from(new Map(candidates.map((value) => [normalized(value), value])).values());
}

type CanonicalNameAuditMapping = {
  source: string;
  target: string;
  aliases: string[];
  kind: string;
  status: 'confirmed';
  mappingSources: string[];
};

/**
 * 从 literary memory entities 与 characterVoices 提取已确认的规范名映射。
 */
function canonicalNameAuditMappings(memory: Record<string, any>): CanonicalNameAuditMapping[] {
  const mappings: CanonicalNameAuditMapping[] = [];
  const add = (sourceValue: unknown, targetValue: unknown, aliasesValue: unknown, kindValue: unknown, mappingSource: string) => {
    const source = typeof sourceValue === 'string' ? sourceValue.trim() : '';
    const target = typeof targetValue === 'string' ? targetValue.trim() : '';
    if (!source || !target || isGenericCanonicalName(source)) return;
    const aliases = canonicalNameForms(source, aliasesValue).filter((value) => normalized(value) !== normalized(source));
    const key = normalized(source) + '\u0000' + normalized(target);
    const existing = mappings.find((item) => normalized(item.source) + '\u0000' + normalized(item.target) === key);
    if (existing) {
      existing.aliases = Array.from(new Map([...existing.aliases, ...aliases].map((value) => [normalized(value), value])).values());
      if (!existing.mappingSources.includes(mappingSource)) existing.mappingSources.push(mappingSource);
      return;
    }
    mappings.push({
      source, target, aliases, kind: typeof kindValue === 'string' ? kindValue : 'other',
      status: 'confirmed', mappingSources: [mappingSource],
    });
  };

  for (const entity of Array.isArray(memory.entities) ? memory.entities : []) {
    if (entity?.reviewStatus !== 'confirmed') continue;
    add(entity.source, entity.target, entity.aliases, entity.kind, 'literary-memory');
  }
  // 人物/声音档案维护着自己的规范译名。它们可能是某个已认可译名的唯一来源，
  // 所以全书级审计既要查实体，也要查这些档案。
  for (const profile of Array.isArray(memory.characterVoices) ? memory.characterVoices : []) {
    if (profile?.status !== 'confirmed' || profile?.useForTranslation === false) continue;
    add(profile.canonicalSourceName, profile.targetName, profile.aliases, 'character', 'character-voice');
  }
  return mappings;
}

/**
 * 检测同一规范源存在多个不同译名的冲突。
 */
export function canonicalNameMappingConflictFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  memory: Record<string, any>,
): { findings: any[]; conflictedSources: Set<string> } {
  const mappings = canonicalNameAuditMappings(memory);
  const groups = new Map<string, CanonicalNameAuditMapping[]>();
  for (const mapping of mappings) {
    const key = normalized(mapping.source);
    const list = groups.get(key) || [];
    list.push(mapping);
    groups.set(key, list);
  }
  const findings: any[] = [];
  const conflictedSources = new Set<string>();
  for (const [sourceKey, group] of groups) {
    const targets = Array.from(new Map(group.map((mapping) => [normalized(mapping.target), mapping.target])).values());
    if (targets.length < 2) continue;
    conflictedSources.add(sourceKey);
    const forms = group.flatMap((mapping) => [mapping.source, ...mapping.aliases]);
    const affected = segments.filter((segment) => forms.some((form) => containsName(segment.text, form)));
    // 即使某条已存规则在当前这次翻译里还没用上，只要冲突就要报。
    // 只要这个名字在本书中出现过，就带上具体受影响的源文 ID。
    if (!affected.length) continue;
    const ids = affected.map((segment) => segment.id);
    const confirmed = group.every((mapping) => mapping.status === 'confirmed');
    findings.push({
      findingId: stableFindingId('canonical-name-mapping-conflict', ids, sourceKey + ':' + targets.map(normalized).sort().join('|')),
      type: 'canonical-name-mapping-conflict',
      category: 'terminology',
      severity: confirmed ? 'must-fix' : 'review',
      confidence: 'confirmed-conflict',
      repairable: false,
      segmentIds: ids,
      chapter: affected[0]?.contextPath || null,
      sourceExcerpt: affected[0]?.text.slice(0, 240) || '',
      entity: {
        source: group[0]?.source || '',
        targets,
        mappings: group.map((mapping) => ({ source: mapping.source, target: mapping.target, mappingSources: mapping.mappingSources })),
      },
      explanation: '人物规范名在已确认的 LiteraryMemory 与人物角色/声音资料中存在不同译名。审计不会擅自选择其中一个；请先在项目记忆中统一规范译名，再对受影响片段做定点复核。',
    });
  }
  return { findings, conflictedSources };
}

/**
 * 检测原文含已确认规范名但译文未出现对应译名的术语漂移。
 */
export function terminologyFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  memory: Record<string, any>,
  conflictedSources: Set<string> = new Set(),
) {
  const mappings = canonicalNameAuditMappings(memory);
  const findings: any[] = [];
  for (const segment of segments) {
    const translation = translations.get(segment.id) || '';
    if (!translation) continue;
    for (const mapping of mappings) {
      // 两个已确认来源互相矛盾时，报一次映射冲突，
      // 而不是让每个有效译名看起来都是独立的翻译缺陷。
      if (conflictedSources.has(normalized(mapping.source))) continue;
      const forms = [mapping.source, ...mapping.aliases];
      const matchedSource = forms.find((alias) => containsName(segment.text, alias));
      if (!matchedSource || targetPresent(translation, mapping.target)) continue;
      findings.push({
        findingId: stableFindingId('terminology-drift', [segment.id], normalized(mapping.source) + '>' + normalized(mapping.target)),
        type: 'terminology-drift',
        category: 'terminology',
        severity: 'warning',
        confidence: 'heuristic',
        repairable: true,
        segmentIds: [segment.id],
        chapter: segment.contextPath || null,
        sourceExcerpt: segment.text.slice(0, 240),
        translationExcerpt: translation.slice(0, 320),
        entity: { source: mapping.source, matchedAlias: matchedSource, target: mapping.target, mappingSources: mapping.mappingSources },
        explanation: '原文包含已确认规范名，但当前译文中未检测到对应译名；请结合语境人工判断是否属于省略、代词替代或真实译名漂移。',
      });
    }
  }
  return findings;
}
