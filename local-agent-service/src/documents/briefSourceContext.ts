/**
 * 源文侧的查询与匹配：文本规范化、引文核实、规范名形态判断、按 segment 找 ordinal。
 *
 * 从 translationBrief 抽出：时间边界判断（「这个名字/这句引文在本批次之前出现过吗」）
 * 全靠这几个函数，它们只读数据库、不碰记忆结构。
 */

export function normalizedSourceText(value: unknown): string {
  return String(value || '').normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 判断 quote 是否为 source 中的连续子串（归一化后），且引文长度至少 8 个字符。
 * 用于证据引文的可验证性校验，防止短片段/伪造引用通过。
 */
export function sourceQuoteMatches(source: unknown, quote: unknown): boolean {
  const sourceText = normalizedSourceText(source);
  const quoteText = normalizedSourceText(quote);
  return quoteText.length >= 8 && sourceText.includes(quoteText);
}

const GENERIC_CANONICAL_SOURCE_FORMS = new Set([
  'lord', 'general', 'sire', 'council', 'regent', 'regents', 'ship',
  'sir', 'madam', 'madame', 'captain', 'lady', 'samurai',
]);
const CANONICAL_ALIAS_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'lord', 'general', 'sire', 'sir', 'lady',
  'madam', 'madame', 'captain', 'master', 'mr', 'mrs', 'ms', 'san', 'sama',
]);

/**
 * 对规范实体源名做进一步归一化：去掉冠词、所有格后缀与尾部标点，便于别名兼容性比较。
 */
function normalizedCanonicalSourceName(value: unknown): string {
  return normalizedSourceText(value).replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s)\b/g, '').replace(/[.!?]+$/g, '').trim();
}

/**
 * 判断源名是否为通用称谓（如 lord/general/captain），这类名称不应直接作为规范映射注入。
 */
export function isGenericCanonicalSourceName(value: unknown): boolean {
  return GENERIC_CANONICAL_SOURCE_FORMS.has(normalizedCanonicalSourceName(value));
}

/**
 * 提取规范源名的身份 token（去除停用词），用于别名兼容性判断。
 */
function canonicalSourceIdentityTokens(value: string): string[] {
  return normalizedCanonicalSourceName(value).replace(/['’]s\b/g, '')
    .match(/[a-z0-9]+/g)?.filter((token) => !CANONICAL_ALIAS_STOPWORDS.has(token)) || [];
}

/**
 * 判断 alias 是否与 source 在身份上兼容（token 有重叠/前缀关系）；非拉丁文本默认兼容。
 * 防止把属于他人的别名挂到当前实体上。
 */
function isCompatibleCanonicalSourceAlias(source: string, alias: string): boolean {
  if (!/^[a-z0-9 ._'’-]+$/iu.test(source) || !/^[a-z0-9 ._'’-]+$/iu.test(alias)) return true;
  const sourceTokens = canonicalSourceIdentityTokens(source);
  const aliasTokens = canonicalSourceIdentityTokens(alias);
  if (!aliasTokens.length) return false;
  if (!sourceTokens.length) return true;
  return sourceTokens.some((sourceToken) => aliasTokens.some((aliasToken) =>
    sourceToken === aliasToken || sourceToken.startsWith(aliasToken) || aliasToken.startsWith(sourceToken)));
}

/**
 * 从别名输入中过滤掉通用称谓、与源名相同项及不兼容别名，按归一化文本去重。
 */
export function safeCanonicalSourceAliases(source: string, aliasesInput: unknown): string[] {
  const aliases = (Array.isArray(aliasesInput) ? aliasesInput : [])
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    .map((alias) => alias.trim())
    .filter((alias) => !isGenericCanonicalSourceName(alias) &&
      normalizedSourceText(alias) !== normalizedSourceText(source) &&
      isCompatibleCanonicalSourceAlias(source, alias));
  return Array.from(new Map(aliases.map((alias) => [normalizedSourceText(alias), alias])).values());
}

const firstSourceOccurrenceCache = new Map<string, number>();
const sourceRowsByRevision = new Map<string, Array<{ ordinal: number; text: string }>>();

/**
 * 按来源版本读取全部 source_segments（ordinal/text），带两版本 LRU 缓存。
 * 来源版本不可变，缓存可避免每个别名都重新扫描 SQLite。
 */
function sourceRowsForRevision(db: any, revisionId: string): Array<{ ordinal: number; text: string }> {
  const cached = sourceRowsByRevision.get(revisionId);
  if (cached) {
    sourceRowsByRevision.delete(revisionId);
    sourceRowsByRevision.set(revisionId, cached);
    return cached;
  }
  // 源文版本不可变。两版本上限的 LRU 避免为每个别名都去扫一遍 SQLite，
  // 同时在同时打开几本书时把内存控住。
  const rows = db.prepare(
    'SELECT ordinal, text FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(revisionId) as Array<{ ordinal: number; text: string }>;
  sourceRowsByRevision.set(revisionId, rows);
  while (sourceRowsByRevision.size > 2) {
    const oldest = sourceRowsByRevision.keys().next().value;
    if (oldest) sourceRowsByRevision.delete(oldest);
    else break;
  }
  return rows;
}

/**
 * 在指定来源版本中查找 term 首次出现的 ordinal（name 或 quote 匹配）。
 * 结果缓存；用于时间边界判定（某名称/引文是否在当前批次之前已出现）。
 */
export function firstMatchingSourceOrdinal(
  db: any,
  revisionId: string,
  termInput: unknown,
  kind: 'name' | 'quote',
): number {
  const term = String(termInput || '').trim();
  const normalizedTerm = normalizedSourceText(term);
  if (!normalizedTerm || (kind === 'quote' && normalizedTerm.length < 8)) return Number.POSITIVE_INFINITY;
  const cacheKey = revisionId + '\u0000' + kind + '\u0000' + normalizedTerm;
  const cached = firstSourceOccurrenceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // 不要用 SQLite 的 instr(lower(text), lower(term)) 预过滤：那种字面比较
  // 会在 JS 拿到之前，就把 O’Connor / O'Connor 这类归一后等价的写法排除掉。
  const match = sourceRowsForRevision(db, revisionId).find((row) => kind === 'quote'
    ? sourceQuoteMatches(row.text, term)
    : sourceNameMatches(row.text, term));
  const ordinal = match ? Number(match.ordinal) : Number.POSITIVE_INFINITY;
  firstSourceOccurrenceCache.set(cacheKey, ordinal);
  while (firstSourceOccurrenceCache.size > 5000) {
    const oldest = firstSourceOccurrenceCache.keys().next().value;
    if (oldest) firstSourceOccurrenceCache.delete(oldest);
    else break;
  }
  return ordinal;
}

/**
 * 判断 name 是否作为完整词/子串出现在 source 中（拉丁名按词边界，非拉丁按子串）。
 */
export function sourceNameMatches(source: unknown, nameInput: unknown): boolean {
  const sourceText = normalizedSourceText(source);
  const name = normalizedSourceText(nameInput);
  if (!sourceText || !name || name.length < 2) return false;
  if (/^[a-z0-9 ._'’-]+$/i.test(name)) {
    const haystack = ' ' + sourceText.replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
    const needle = name.replace(/[^a-z0-9]+/gi, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return sourceText.includes(name);
}


