/**
 * 规范译名保护：把源文里已确认的译名替换成占位标记，模型无法改写，
 * 返回后再还原成目标译名，并在还原时校验标记数量与顺序。
 *
 * 从 translationAgent 抽出：这里全部是纯字符串处理，不碰 Run/DB/模型调用，
 * 单独成模块后可以脱离翻译流程直接测试。
 */
import { logInfo } from '../log.ts';
import { isWorthCanonicalEntityMapping, validateCanonicalTarget } from './canonicalEntityPolicy.ts';
import type { ValidatedTranslationContextDelta } from './translationContextDelta.ts';

/** 强规范译名保护信息：占位标记、源形式与目标译名。 */
export interface CanonicalTermProtection {
  marker: string;
  sourceForm: string;
  target: string;
}

/** 规范化专名：NFKC、小写、统一撇号与空白。 */
export function normalizeCanonicalTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
}

// 独立出现的头衔与泛称属于语境语言，不是规范实体名。
const NON_CANONICAL_NAME_FORMS = new Set([
  'lord', 'general', 'sire', 'council', 'regent', 'regents', 'ship',
  'sir', 'madam', 'madame', 'captain', 'lady', 'samurai',
]);

/** 判断是否为通用头衔/称谓，不作为规范译名保护。 */
export function isGenericCanonicalNameForm(value: string): boolean {
  const normalized = normalizeCanonicalTerm(value)
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s|[.!?]+)$/g, '').trim();
  return NON_CANONICAL_NAME_FORMS.has(normalized);
}

/** 提取专名身份 token，忽略冠词与通用头衔。 */
function canonicalIdentityTokens(value: string): string[] {
  const ignored = new Set(['the', 'a', 'an', 'lord', 'general', 'sire', 'sir', 'lady', 'madam', 'madame', 'captain', 'master', 'mr', 'mrs', 'ms', 'san', 'sama', 'of']);
  return normalizeCanonicalTerm(value).replace(/['’]s\b/g, '')
    .match(/[a-z0-9]+/g)?.filter((token) => !ignored.has(token)) || [];
}

/** 判断别名与规范源名是否身份兼容。 */
export function isCompatibleCanonicalAlias(canonicalSource: string, alias: string): boolean {
  const sourceTokens = canonicalIdentityTokens(canonicalSource);
  const aliasTokens = canonicalIdentityTokens(alias);
  if (!sourceTokens.length || !aliasTokens.length) return true;
  return sourceTokens.some((sourceToken) => aliasTokens.some((aliasToken) =>
    sourceToken === aliasToken || sourceToken.startsWith(aliasToken) || aliasToken.startsWith(sourceToken)));
}

/** 转义正则特殊字符。 */
function escapeCanonicalTermRegex(value: string): string {
  return value.split('').map((char) => '.^$*+?()[]{}|\\'.includes(char) ? '\\' + char : char).join('');
}

/** 构建专名匹配正则（拉丁词边界/CJK 子串）。 */
export function canonicalTermPattern(value: string): string {
  const escaped = value.trim().split(/\s+/).map(escapeCanonicalTermRegex).join('\\s+').replace(/['’]/g, "['’]");
  // 拉丁名要求词边界（King 不能匹配到 Kingfisher）；CJK 词用
  // 精确子串匹配，因为相邻汉字之间没有词边界。
  return /^[A-Za-z0-9][A-Za-z0-9\s._'’\-]*$/.test(value)
    ? '(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])'
    : escaped;
}

/**
 * 仅保护源文可见、可操作的规范译名映射；确认记忆优先于图谱；同级矛盾映射失败闭合。
 */
export function buildCanonicalTermProtections(
  items: Array<{ id: string; text: string }>,
  contextGraph: Record<string, unknown> | null,
  targetLang = 'zh',
): CanonicalTermProtection[] {
  const mappings = Array.isArray((contextGraph as any)?.nameMappings)
    ? (contextGraph as any).nameMappings as Array<Record<string, any>>
    : [];
  const priorityFor = (status: unknown): number => {
    if (status === 'confirmed-memory') return 4;
    if (status === 'confirmed') return 3;
    if (status === 'auto') return 2;
    if (status === 'run-canonical') return 1;
    return 0;
  };
  const active = mappings.filter((mapping) => {
    const sourceStatus = String(mapping?.sourceStatus || '');
    if (priorityFor(sourceStatus) <= 0 ||
        typeof mapping?.source !== 'string' || !mapping.source.trim() ||
        typeof mapping?.target !== 'string' || !mapping.target.trim()) return false;
    const explicitlyConfirmed = sourceStatus === 'confirmed' ||
      (sourceStatus === 'confirmed-memory' && mapping.confirmationSource === 'user-confirmed');
    const kind = String(mapping.kind || 'other');
    if (!explicitlyConfirmed && !isWorthCanonicalEntityMapping({ source: mapping.source, kind, explicitBookSpecificMeaning: mapping.explicitBookSpecificMeaning === true })) return false;
    return validateCanonicalTarget({
      source: mapping.source, target: mapping.target, targetLang, kind,
    }).valid;
  });
  type NameCandidate = { sourceForm: string; target: string; priority: number; conflicting: boolean };
  const candidateByName = new Map<string, NameCandidate>();
  for (const mapping of active) {
    const target = String(mapping.target).trim();
    const priority = priorityFor(mapping.sourceStatus);
    const canonicalSource = String(mapping.source).trim();
    const forms = [canonicalSource, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
      .filter((value): value is string => typeof value === 'string' && !!value.trim())
      .filter((value) => !isGenericCanonicalNameForm(value))
      .filter((value) => value === canonicalSource || isCompatibleCanonicalAlias(canonicalSource, value));
    for (const rawForm of forms) {
      const sourceForm = rawForm.trim();
      const key = normalizeCanonicalTerm(sourceForm);
      if (!key || !items.some((item) => new RegExp(canonicalTermPattern(sourceForm), 'iu').test(item.text))) continue;
      const existing = candidateByName.get(key);
      if (!existing || priority > existing.priority) {
        // 显式维护的 LiteraryMemory 映射优先于过期的 Context Graph 提议；
        // 提示词里和恢复时用的目标译名必须是同一个。
        candidateByName.set(key, { sourceForm, target, priority, conflicting: false });
      } else if (priority === existing.priority &&
          normalizeCanonicalTerm(existing.target) !== normalizeCanonicalTerm(target)) {
        // 两条权威级别相同却互相矛盾的映射，是真的有歧义。
        // 失败关闭，而不是按数组碰巧的顺序挑一个。
        existing.conflicting = true;
      }
    }
  }
  const conflictingNames = new Set(Array.from(candidateByName.entries())
    .filter(([, value]) => value.conflicting).map(([key]) => key));
  const protections = Array.from(candidateByName.entries())
    .filter(([key, value]) => !conflictingNames.has(key) && !value.conflicting)
    .map(([, item]) => ({ sourceForm: item.sourceForm, target: item.target }))
    .sort((a, b) => b.sourceForm.length - a.sourceForm.length)
    .map((item, index) => ({
      marker: '__VSA_TERM_' + String(index).padStart(3, '0') + '__',
      sourceForm: item.sourceForm,
      target: item.target,
    }));
  logInfo('canonical-terms', 'protections=' + protections.length +
    ' · candidates=' + candidateByName.size +
    ' · conflicting=' + conflictingNames.size +
    (protections.length ? ' · ' + protections.map((p) => p.sourceForm + '→' + p.target).join(', ') : ''));
  return protections;
}

/**
 * Context 增量是模型生成的元数据，不是规范名的第二个真相来源。
 * 当本批次已经用了校验过的 TranslationBrief 映射时，在落盘增量之前
 * 先把匹配的实体提议归一到那个确切的目标译名。这样「米诺原」/「源氏」
 * 这类矛盾提议，就不会在译文已被保护之后又引入冲突。
 * 它不会提升未映射的候选，也不会造出模型没给过的目标证据。
 */
export function normalizeContextDeltaCanonicalTargets(
  delta: ValidatedTranslationContextDelta,
  protections: CanonicalTermProtection[],
): number {
  const keyOf = (value: unknown): string => normalizeCanonicalTerm(String(value || ''))
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s)\b/g, '')
    .trim();
  const targetBySource = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const protection of protections) {
    const key = keyOf(protection.sourceForm);
    if (!key) continue;
    const existing = targetBySource.get(key);
    if (existing && normalizeCanonicalTerm(existing) !== normalizeCanonicalTerm(protection.target)) {
      conflicts.add(key);
    } else {
      targetBySource.set(key, protection.target);
    }
  }
  let normalizedCount = 0;
  for (const candidate of delta.entityCandidates || []) {
    const key = keyOf(candidate.canonicalSource);
    const canonicalTarget = targetBySource.get(key);
    if (!canonicalTarget || conflicts.has(key) ||
        normalizeCanonicalTerm(candidate.targetProposal) === normalizeCanonicalTerm(canonicalTarget)) continue;
    candidate.targetProposal = canonicalTarget;
    candidate.reason = [
      candidate.reason,
      '服务端已按本次 TranslationBrief 的有效规范名称映射统一候选译名。',
    ].filter(Boolean).join(' ').slice(0, 180);
    normalizedCount++;
  }
  return normalizedCount;
}

/**
 * 将源文中出现的强规范译名替换为占位标记，避免模型翻译/改写。
 * @param text 原文
 * @param protections 保护列表
 * @returns 替换后的文本
 */
export function maskCanonicalTermText(text: string, protections: CanonicalTermProtection[]): string {
  if (!text || !protections.length) return text;
  const byName = new Map(protections.map((item) => [normalizeCanonicalTerm(item.sourceForm), item]));
  const alternatives = protections.map((item) => canonicalTermPattern(item.sourceForm)).join('|');
  if (!alternatives) return text;
  return text.replace(new RegExp(alternatives, 'giu'), (match) =>
    byName.get(normalizeCanonicalTerm(match))?.marker ?? match,
  );
}

/**
 * 将文本中的占位标记还原为源形式或目标译名。
 * @param text 含占位标记的文本
 * @param protections 保护列表
 * @param mode 'source' 还原源形式，'target'（默认）还原目标译名
 * @returns 还原后的文本
 */
export function restoreCanonicalTermMarkers(
  text: string,
  protections: CanonicalTermProtection[],
  mode: 'source' | 'target' = 'target',
): string {
  let result = text;
  for (const item of protections) {
    result = result.replaceAll(item.marker, mode === 'source' ? item.sourceForm : item.target);
  }
  return result;
}

/** 校验每个受保护标记在输出中的出现次数，是否与掩码源文一致；只做 includes() 检查会放过模型静默丢弃重复提及的情况。 */
export function canonicalMarkerCountsMatch(
  maskedSource: string,
  maskedTranslation: string,
  protections: CanonicalTermProtection[],
): boolean {
  return describeCanonicalMarkerMismatch(maskedSource, maskedTranslation, protections).length === 0;
}

/** 占位标记出现次数不匹配的明细。 */
export interface CanonicalMarkerMismatch {
  marker: string;
  sourceForm: string;
  expected: number;
  actual: number;
}

/**
 * 逐条比对标记出现次数，返回不匹配的明细。
 *
 * 只记「哪个片段被拒」无法区分两种完全不同的失败：模型把标记当普通词翻译掉了（actual=0），
 * 还是把重复出现的标记合并了一次（expected=2/actual=1）。前者要改提示词，后者是输出被压缩，
 * 处置方式不同，所以必须留下期望值与实际值。
 */
export function describeCanonicalMarkerMismatch(
  maskedSource: string,
  maskedTranslation: string,
  protections: CanonicalTermProtection[],
): CanonicalMarkerMismatch[] {
  const count = (value: string, marker: string) => value.split(marker).length - 1;
  const mismatches: CanonicalMarkerMismatch[] = [];
  for (const term of protections) {
    const expected = count(maskedSource, term.marker);
    const actual = count(maskedTranslation, term.marker);
    if (expected !== actual) {
      mismatches.push({ marker: term.marker, sourceForm: term.sourceForm, expected, actual });
    }
  }
  return mismatches;
}

/**
 * 在 user prompt 末尾重申本批的规范译名标记。
 *
 * 标记约束原本只在 system prompt 的契约里出现一次，模型在长批次里仍会把它当普通文本
 * 「顺手翻译」掉：实测 69 个受保护片段里 14 个（20%）因标记数量不符被整段丢弃并重发，
 * 补译吃掉 19% 的翻译墙钟。把本批实际出现的标记列在 payload 之后（recency 位置）
 * 只多几十个字符，能直接减少这类白跑。
 */
export function buildCanonicalMarkerReminder(
  maskedSources: string[],
  protections: CanonicalTermProtection[],
): string {
  if (!protections.length) return '';
  const counts = new Map<string, number>();
  for (const text of maskedSources) {
    for (const term of protections) {
      const occurrences = text.split(term.marker).length - 1;
      if (occurrences > 0) counts.set(term.marker, (counts.get(term.marker) || 0) + occurrences);
    }
  }
  if (!counts.size) return '';
  const entries = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const shown = entries.slice(0, 12).map(([marker, occurrences]) => marker + '×' + occurrences).join(' ');
  return '\n\n【标记校验】本批 translated_text 必须逐字保留下列占位标记，出现次数不得减少：' +
    shown + (entries.length > 12 ? ' 等 ' + entries.length + ' 种' : '') +
    '。标记不是文字，不要翻译、改写、拆分或删除；少一个就会导致整段译文被丢弃重译。';
}

/**
 * 将目标译文中出现的强规范译名替换为占位标记（用于 Reviewer 草稿保护）。
 * @param text 目标译文
 * @param protections 保护列表
 * @returns 替换后的文本
 */
export function maskCanonicalTargetText(text: string, protections: CanonicalTermProtection[]): string {
  if (!text || !protections.length) return text;
  const byTarget = new Map<string, CanonicalTermProtection>();
  for (const item of protections) {
    const key = normalizeCanonicalTerm(item.target);
    if (key && !byTarget.has(key)) byTarget.set(key, item);
  }
  const targets = Array.from(byTarget.values()).sort((a, b) => b.target.length - a.target.length);
  const alternatives = targets.map((item) => canonicalTermPattern(item.target)).join('|');
  if (!alternatives) return text;
  return text.replace(new RegExp(alternatives, 'giu'), (match) =>
    byTarget.get(normalizeCanonicalTerm(match))?.marker ?? match,
  );
}

/** 在 Reviewer 草稿里同时掩码源名与其规范译名，防止审校在初译已修正之后重新引入另一种译法。 */
export function protectCanonicalReviewSegments<T extends { id: string; source: string; draft: string }>(
  segments: T[],
  contextGraph: Record<string, unknown> | null,
): { protections: CanonicalTermProtection[]; segments: T[] } {
  const protections = buildCanonicalTermProtections(
    segments.map((item) => ({ id: item.id, text: item.source })),
    contextGraph,
  );
  if (!protections.length) return { protections, segments };
  return {
    protections,
    segments: segments.map((item) => {
      const source = maskCanonicalTermText(item.source, protections);
      const sourceScopedProtections = protections.filter((term) => source.includes(term.marker));
      return {
        ...item,
        source,
        draft: maskCanonicalTargetText(item.draft, sourceScopedProtections),
      };
    }),
  };
}

/**
 * 递归还原对象/数组/字符串中的占位标记；sourceExcerpt 字段按源形式还原。
 * @param value 任意值
 * @param protections 保护列表
 * @param mode 还原模式
 * @returns 还原后的值
 */
export function restoreCanonicalMarkersDeep(
  value: unknown,
  protections: CanonicalTermProtection[],
  mode: 'source' | 'target' = 'target',
): unknown {
  if (typeof value === 'string') return restoreCanonicalTermMarkers(value, protections, mode);
  if (Array.isArray(value)) {
    return value.map((item) => restoreCanonicalMarkersDeep(item, protections, mode));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [
        key,
        // sourceExcerpt 是针对原始源文的证据；把它还原成目标语，
        // 会让一条本来有效的引文型发现过不了服务端的接地检查。
        restoreCanonicalMarkersDeep(item, protections, key === 'sourceExcerpt' ? 'source' : mode),
      ]));
  }
  return value;
}
