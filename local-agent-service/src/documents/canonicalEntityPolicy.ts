/**
 * Deterministic policy for book-level canonical entity mappings.
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
 * True means the mapping is useful as a book-level canonical entry, not simply that the term exists.
 * 常见国名、语言/民族称谓、普通名词和通用头衔交由普通翻译处理；具有专属含义的概念可显式例外。
 */
export function isWorthCanonicalEntityMapping(input: EntityWorthInput): boolean {
  const source = normalized(input.source);
  if (!source || hasCompoundCanonicalSyntax(input.source)) return false;
  const kind = normalizeCanonicalEntityKind(input.kind);
  const explicitMeaning = input.explicitBookSpecificMeaning === true;
  if (explicitMeaning) return true;

  if (kind !== 'person' && (COUNTRY_OR_NATIONALITY.has(source) || GENERIC_NON_PERSON_TERMS.has(source))) return false;

  // Other/unknown is deliberately conservative. Frequent ordinary words should not fill the glossary.
  if (kind === 'other' || kind === 'title') {
    const recurring = (input.mentions || 0) >= 3 && (input.chapterCount || 0) >= 2;
    return recurring && Boolean((input.significance || '').trim()) &&
      /^[A-Z][\p{L}\p{M}'’.-]*(?:\s+[A-Z][\p{L}\p{M}'’.-]*){0,5}$/u.test(input.source.trim());
  }
  // A proper person, named organization, work, object, or place can be useful even if infrequent.
  return ['person', 'place', 'object', 'organization', 'concept', 'work', 'artifact'].includes(kind);
}

export type TargetQualityResult = {
  valid: boolean;
  normalizedTarget: string;
  reason?: 'empty' | 'compound-target' | 'annotation-target' | 'mixed-script-residue' | 'source-retained' | 'non-name';
};

/**
 * Target shape guard; it is not a semantic correctness oracle. Strong mapping requires this check
 * plus source evidence and (unless user-confirmed) independent target corroboration.
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

  // A whole-string quote is formatting, not part of the canonical name.
  target = target.replace(/^[\"'“”‘’《》「」『』]+|[\"'“”‘’《》「」『』]+$/g, '').trim();
  if (!target) return { valid: false, normalizedTarget: '', reason: 'empty' };
  // NFKC turns a full-width slash into '/', so judge Chinese targets after normalization.
  // A slash embedded in a Chinese target almost always means multiple alternatives; preserve
  // Latin product names such as AC/DC only when there is no CJK text around the delimiter.
  if (hasCompoundCanonicalSyntax(target) ||
      /[|]/.test(target) ||
      (/\//.test(target) && (/\p{Script=Han}/u.test(target) || /\s\/\s/.test(target)))) {
    return { valid: false, normalizedTarget: target, reason: 'compound-target' };
  }
  // Parenthetical translations/notes are not part of a canonical name ("ship (honorific)").
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
    // A source acronym can legitimately remain Latin; arbitrary mixed romanized fragments cannot.
    const latinRuns = target.match(/[A-Za-z]{2,}/g) || [];
    const hasCjk = /[\u3400-\u9fff\u3040-\u30ff]/u.test(target);
    const kind = normalizeCanonicalEntityKind(input.kind);
    const onlyApprovedAcronyms = latinRuns.every((run) =>
      LATIN_ACRONYM_ALLOWLIST.has(run.toUpperCase()) ||
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
