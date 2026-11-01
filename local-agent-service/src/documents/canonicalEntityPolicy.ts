/**
 * 全书级规范实体映射的确定性策略。
 *
 * 原文证据有效，不代表实体值得长期保存，也不代表目标译名正确。
 * Context Graph、context_delta 和记忆升级都应调用本模块，避免不同入口出现不同规则。
 */
export type CanonicalEntityKind =
  | 'person' | 'place' | 'object' | 'organization' | 'concept' | 'work' | 'artifact' | 'title' | 'other';

export type CompoundNameParts = { parts: string[]; delimiter: string } | null;

const COUNTRY_OR_NATIONALITY = new Set([
  'japan', 'england', 'scotland', 'wales', 'ireland', 'netherlands', 'holland',
  'spain', 'portugal', 'france', 'germany', 'italy', 'china', 'korea',
  'united states', 'united kingdom', 'america', 'britain', 'british',
  'japanese', 'english', 'scottish', 'welsh', 'irish', 'dutch', 'spanish',
  'portuguese', 'french', 'german', 'italian', 'chinese', 'korean',
  'spaniards', 'portuguese people', 'japmen',
]);
const GENERIC_NON_PERSON_TERMS = new Set([
  'god', 'gods', 'deity', 'religion', 'christian', 'christians', 'jesuit', 'jesuits',
  'samurai', 'ninja', 'pigeon', 'pigeons', 'longitude', 'latitude', 'saké', 'sake',
  'cha', 'tea', 'language', 'english language', 'japanese language',
  'queen', 'the queen', 'emperor', 'the emperor', 'heir', 'the heir',
  'lord', 'the lord', 'king', 'the king', 'sir', 'sire', 'captain', 'the captain',
]);
const LATIN_ACRONYM_ALLOWLIST: Set<string> = new Set([
  'AI', 'API', 'CPU', 'DNA', 'GPU', 'HDMI', 'HTTP', 'HTTPS', 'IBM', 'IP', 'ISBN',
  'NASA', 'NATO', 'NFC', 'OK', 'OS', 'PDF', 'RAM', 'SQL', 'TCP', 'TV', 'USB', 'URL', 'WWII',
]);
const VALID_CANONICAL_KINDS = new Set<CanonicalEntityKind>([
  'person', 'place', 'object', 'organization', 'concept', 'work', 'artifact', 'title', 'other',
]);

function normalized(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase().replace(/[’']/g, '').replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ').trim()
    : '';
}

/**
 * 将模型输出的 kind 归一化为规范 CanonicalEntityKind：人物/地点/组织/物件等同义词映射，
 * 未知 kind 保留若合法否则 'other'。
 */
export function normalizeCanonicalEntityKind(value: unknown): CanonicalEntityKind {
  const kind = normalized(value).replace(/\s+/g, '_');
  if (['person', 'character', 'human', 'character_epithet', 'nickname'].includes(kind)) return 'person';
  if (['place', 'location', 'country', 'nation', 'city', 'region'].includes(kind)) return 'place';
  if (['organization', 'organisation', 'group', 'clan', 'family', 'dynasty', 'faction', 'company'].includes(kind)) return 'organization';
  if (['object', 'artifact', 'artefact', 'ship', 'vessel', 'weapon'].includes(kind)) return ['artifact', 'artefact'].includes(kind) ? 'artifact' : 'object';
  if (['work', 'book', 'title_of_work'].includes(kind)) return 'work';
  if (['concept', 'religion', 'deity', 'language', 'term', 'unit'].includes(kind)) return 'concept';
  if (['title', 'role', 'rank'].includes(kind)) return 'title';
  return VALID_CANONICAL_KINDS.has(kind as CanonicalEntityKind) ? kind as CanonicalEntityKind : 'other';
}

/**
 * 只把明显具有清单语义的分隔符拆分；不拆 AC/DC、OS/2 等未带空格的半角斜杠专名。
 * 不默认拆普通逗号，以免损坏“姓, 名”等来源格式。
 */
export function splitCompoundCanonicalName(value: unknown): CompoundNameParts {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;
  const delimiterMatch = input.match(/\s+\/\s+|\s+／\s+|\s+\|\s+|／/);
  if (!delimiterMatch) return null;
  const delimiter = delimiterMatch[0];
  const separator = delimiter.trim() === '/' ? /\s+\/\s+/ :
    delimiter.trim() === '|' ? /\s+\|\s+/ :
    delimiter.trim() === '／' ? /\s*／\s*/ : /\s+/;
  const parts = input.split(separator).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  return { parts, delimiter };
}

/**
 * 判断名称是否包含复合分隔符（/、|、／ 或分号/逗号分隔），用于拒绝多目标清单式译名。
 */
export function hasCompoundCanonicalSyntax(value: unknown): boolean {
  return splitCompoundCanonicalName(value) !== null ||
    (typeof value === 'string' && /\s+[;,]\s+/.test(value.trim()));
}

export type EntityWorthInput = {
  source: string;
  kind: unknown;
  mentions?: number;
  chapterCount?: number;
  significance?: string;
  explicitBookSpecificMeaning?: boolean;
};

/**
 * 常见国名、语言/民族称谓、普通名词和通用头衔交由普通翻译处理；具有专属含义的概念可显式例外。
 */
export function isWorthCanonicalEntityMapping(input: EntityWorthInput): boolean {
  const source = normalized(input.source);
  if (!source || hasCompoundCanonicalSyntax(input.source)) return false;
  const kind = normalizeCanonicalEntityKind(input.kind);
  const explicitMeaning = input.explicitBookSpecificMeaning === true;
  const recurring = (input.mentions || 0) >= 3 && (input.chapterCount || 0) >= 2;
  const hasSignificance = Boolean((input.significance || '').trim());
  const genericTerm = kind !== 'person' &&
    (COUNTRY_OR_NATIONALITY.has(source) || GENERIC_NON_PERSON_TERMS.has(source));

  // 标准国名或普通词默认排除。即便模型声称它是本书专属，
  // 也必须由反复出现和具体的意义说明来支撑。
  if (genericTerm) return explicitMeaning && recurring && hasSignificance;

  // 概念类即使被标为「本书专属」，仍然需要跨章证据；这个标记是用来
  // 保留反复出现的概念，不是给一次性普通词或词汇示例开后门。
  if (kind === 'concept') {
    const crossChapter = (input.chapterCount || 0) >= 2;
    return hasSignificance && crossChapter &&
      ((input.mentions || 0) >= 3 || explicitMeaning);
  }
  if (kind === 'other' || kind === 'title') {
    return recurring && hasSignificance &&
      /^[A-Z][\p{L}\p{M}'’.-]*(?:\s+[A-Z][\p{L}\p{M}'’.-]*){0,5}$/u.test(input.source.trim());
  }
  if (explicitMeaning) return true;
  // 具名的人物、组织、作品、物件或地点，即使只出现一两次也可能值得收录。
  return ['person', 'place', 'object', 'organization', 'work', 'artifact'].includes(kind);
}

/**
 * 判断两个目标译名是否冲突（规范化后不同且非空）；用于检测同一源名出现不同译名。
 */
export function canonicalTargetsConflict(left: unknown, right: unknown): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return !!a && !!b && a !== b;
}

export type TargetQualityResult = {
  valid: boolean;
  normalizedTarget: string;
  reason?: 'empty' | 'compound-target' | 'annotation-target' | 'mixed-script-residue' | 'source-retained' | 'non-name';
};

/**
 * 目标译名的形状守卫，不是语义正确性的裁判。要成为强映射，还需要
 * 源文证据，以及（除非用户已确认）来自独立来源的目标佐证。
 */
export function validateCanonicalTarget(input: {
  source: string;
  target: string;
  targetLang: string;
  kind: unknown;
}): TargetQualityResult {
  const source = input.source.trim();
  let target = input.target.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!target) return { valid: false, normalizedTarget: '', reason: 'empty' };

  // 整体包裹的引号只是排版，不属于规范名。
  target = target.replace(/^[\"'“”‘’《》「」『』]+|[\"'“”‘’《》「」『』]+$/g, '').trim();
  if (!target) return { valid: false, normalizedTarget: '', reason: 'empty' };
  // NFKC 会把全角斜杠转成 '/'，所以要在归一化之后判断中文目标。
  // 中文目标里夹斜杠，几乎都意味着并列多个译法；只有分隔符两侧
  // 都没有 CJK 文本时，才保留 AC/DC 这类拉丁产品名。
  if (hasCompoundCanonicalSyntax(target) ||
      /[|]/.test(target) ||
      (/\//.test(target) && (/\p{Script=Han}/u.test(target) || /\s\/\s/.test(target)))) {
    return { valid: false, normalizedTarget: target, reason: 'compound-target' };
  }
  // 括号里的译文或注释不属于规范名（如 "ship (honorific)"）。
  if (/[（(][^）)]*[）)]/.test(target)) {
    return { valid: false, normalizedTarget: target, reason: 'annotation-target' };
  }
  if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(target)) {
    return { valid: false, normalizedTarget: target, reason: 'non-name' };
  }

  const targetLang = input.targetLang.toLocaleLowerCase();
  const sourceUpper = String(input.source).trim().toUpperCase();
  const sourceNorm = normalized(source);
  const targetNorm = normalized(target);
  if (targetLang === 'zh' || targetLang.startsWith('zh-')) {
    // 源文缩写本来就可能是拉丁字母；但随意混排的罗曼化碎片不行。
    const latinRuns = target.match(/[A-Za-z]{2,}/g) || [];
    const hasCjk = /[\u3400-\u9fff\u3040-\u30ff]/u.test(target);
    const kind = normalizeCanonicalEntityKind(input.kind);
    const onlyApprovedAcronyms = latinRuns.every((run) =>
      LATIN_ACRONYM_ALLOWLIST.has(String(run).toUpperCase()) ||
      (kind !== 'person' && /^[A-Z][a-z][A-Za-z0-9]+$/.test(run)));
    if (hasCjk && latinRuns.length && !onlyApprovedAcronyms) {
      return { valid: false, normalizedTarget: target, reason: 'mixed-script-residue' };
    }
    if (sourceNorm && targetNorm === sourceNorm && !LATIN_ACRONYM_ALLOWLIST.has(sourceUpper)) {
      return { valid: false, normalizedTarget: target, reason: 'source-retained' };
    }
  }
  return { valid: true, normalizedTarget: target };
}
