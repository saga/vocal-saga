/**
 * One bounded, immutable-in-memory context bundle shared by translation and both reviewers.
 * The persisted snapshot contains references and compact memory, not the full novel or draft text.
 */
import { createHash } from 'node:crypto';
import { logInfo } from '../log.ts';
import { buildProjectVoiceContext } from './voiceContext.ts';
import { buildProjectContextGraphBundle, CONTEXT_GRAPH_ANALYSIS_VERSION } from './contextGraph.ts';
import { getDocumentProjectStore, normalizeDocumentTranslationStrategy } from './projectStore.ts';
import { isWorthCanonicalEntityMapping, normalizeCanonicalEntityKind, validateCanonicalTarget } from './canonicalEntityPolicy.ts';

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v7-canonical-entity-style-quality';
// Safety ceiling only; this is not a retrieval target. Prefer complete relevant context over silent pruning.
export const MAX_TRANSLATION_BRIEF_CHARS = 1_000_000;

export interface BriefSegment {
  id: string;
  text: string;
  contextPath?: string;
  kind?: string;
  page?: number | null;
  level?: number | null;
  marker?: string | null;
}

export interface TranslationBrief {
  version: 1;
  policyVersion: string;
  sourceRevisionId: string;
  promptRevisionId: string;
  memoryRevisionId: string | null;
  /** Count of source-ordered context deltas merged for this run-local wave snapshot. */
  contextDeltaCount: number;
  sourceSegmentIds: string[];
  chapterPath: string;
  glossary: unknown;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  contextGraph: Record<string, any> | null;
  voiceContext: Record<string, any>;
  /** Retrieval, temporal-boundary and budget-trimming counters for the trajectory/audit log. */
  contextDiagnostics: Record<string, unknown>;
  contextChars: number;
  contextHash: string;
}

function normalizedSourceText(value: unknown): string {
  return String(value || '').normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceQuoteMatches(source: unknown, quote: unknown): boolean {
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

function normalizedCanonicalSourceName(value: unknown): string {
  return normalizedSourceText(value).replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s)\b/g, '').replace(/[.!?]+$/g, '').trim();
}

function isGenericCanonicalSourceName(value: unknown): boolean {
  return GENERIC_CANONICAL_SOURCE_FORMS.has(normalizedCanonicalSourceName(value));
}

function canonicalSourceIdentityTokens(value: string): string[] {
  return normalizedCanonicalSourceName(value).replace(/['’]s\b/g, '')
    .match(/[a-z0-9]+/g)?.filter((token) => !CANONICAL_ALIAS_STOPWORDS.has(token)) || [];
}

function isCompatibleCanonicalSourceAlias(source: string, alias: string): boolean {
  if (!/^[a-z0-9 ._'’-]+$/iu.test(source) || !/^[a-z0-9 ._'’-]+$/iu.test(alias)) return true;
  const sourceTokens = canonicalSourceIdentityTokens(source);
  const aliasTokens = canonicalSourceIdentityTokens(alias);
  if (!aliasTokens.length) return false;
  if (!sourceTokens.length) return true;
  return sourceTokens.some((sourceToken) => aliasTokens.some((aliasToken) =>
    sourceToken === aliasToken || sourceToken.startsWith(aliasToken) || aliasToken.startsWith(sourceToken)));
}

function safeCanonicalSourceAliases(source: string, aliasesInput: unknown): string[] {
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

function sourceRowsForRevision(db: any, revisionId: string): Array<{ ordinal: number; text: string }> {
  const cached = sourceRowsByRevision.get(revisionId);
  if (cached) {
    sourceRowsByRevision.delete(revisionId);
    sourceRowsByRevision.set(revisionId, cached);
    return cached;
  }
  // Source revisions are immutable. A bounded two-revision LRU avoids rescanning SQLite for
  // every alias while keeping memory usage bounded when several books are open.
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

function firstMatchingSourceOrdinal(
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
  // Do not prefilter using SQLite instr(lower(text), lower(term)): that literal comparison
  // rejects normalized-equivalent forms such as O’Connor/O'Connor before JS can compare them.
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

function sourceNameMatches(source: unknown, nameInput: unknown): boolean {
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

/**
 * Literary memory is a book-level snapshot, but not all its claims are available at every point
 * in the source. Only evidence whose source ordinal precedes this batch may survive retrieval.
 * Unscoped free-text summaries/examples are removed because they have no trustworthy temporal
 * provenance and could contain late plot revelations.
 */
function buildTemporallyVisibleMemory(
  context: any,
  items: BriefSegment[],
  precedingSegments: BriefSegment[],
): Record<string, any> {
  const projectId = String(context?.project?.projectId || '');
  const revisionId = String(context?.run?.sourceRevisionId || '');
  const store = getDocumentProjectStore();
  const projectContext = store.getProjectContext(projectId);
  const empty: Record<string, any> = {
    version: 2, entities: [], relationships: [], styleGuide: {}, styleGuideStatus: 'candidate',
    chapterSummaries: [], recentExamples: [], characterVoices: [],
    relationshipVoiceRules: [], voiceAnchors: [], openQuestions: [],
  };
  const sourceRevisionExists = !!revisionId && !!projectContext.db.prepare(
    'SELECT 1 FROM source_revisions WHERE revision_id = ?'
  ).get(revisionId);
  if (!projectId || !sourceRevisionExists || !items.length) return empty;

  const rows = projectContext.db.prepare(
    'SELECT segment_id, ordinal, text, context_path FROM source_segments ' +
    'WHERE source_revision_id = ? AND segment_id IN (' + items.map(() => '?').join(',') + ') ' +
    'ORDER BY ordinal'
  ).all(revisionId, ...items.map((item) => item.id)) as any[];
  const itemOrdinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!itemOrdinals.length) return empty;
  const firstOrdinal = Math.min(...itemOrdinals);

  const rawMemory = context?.memory && typeof context.memory === 'object'
    ? JSON.parse(JSON.stringify(context.memory)) as Record<string, any>
    : empty;
  const editorialProfile = rawMemory.chineseEditorialProfile;
  if (!editorialProfile || editorialProfile.status === 'rejected' ||
      editorialProfile.sourceRevisionId !== revisionId) {
    rawMemory.chineseEditorialProfile = null;
  } else {
    // Machine-generated editorial profiles are default-adopted. Evidence remains metadata;
    // it does not create a human approval gate. This profile is style-only, not plot memory.
    editorialProfile.status = 'confirmed';
    editorialProfile.confirmationSource = editorialProfile.confirmationSource || 'model-default';
  }
  const initialMemoryCounts = {
    entities: Array.isArray(rawMemory.entities) ? rawMemory.entities.length : 0,
    relationships: Array.isArray(rawMemory.relationships) ? rawMemory.relationships.length : 0,
    characterVoices: Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices.length : 0,
  };
  const exclusionDiagnostics = {
    memoryEntityExcludedFutureAlias: 0,
    memoryEntityExcludedNameNotVisible: 0,
    memoryEntityExcludedEvidenceNotVisible: 0,
    memoryRelationshipExcludedNameNotVisible: 0,
    memoryRelationshipExcludedEvidenceNotVisible: 0,
    characterVoiceExcludedFutureEvidence: 0,
    characterVoiceExcludedIncompleteEvidence: 0,
    characterVoiceExcludedNameNotVisible: 0,
    characterVoiceExcludedFutureAlias: 0,
    targetEvidenceExcludedAfterAcceptedCorrection: 0,
  };
  const referencedIds = new Set<string>();
  for (const entity of Array.isArray(rawMemory.entities) ? rawMemory.entities : []) {
    for (const evidence of Array.isArray(entity?.evidenceRefs) ? entity.evidenceRefs : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
    for (const evidence of Array.isArray(entity?.targetEvidenceRefs) ? entity.targetEvidenceRefs : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
  }
  for (const relation of Array.isArray(rawMemory.relationships) ? rawMemory.relationships : []) {
    for (const evidence of Array.isArray(relation?.evidenceRefs) ? relation.evidenceRefs : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
  }
  for (const profile of Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices : []) {
    for (const evidence of Array.isArray(profile.evidence) ? profile.evidence : []) {
      if (typeof evidence?.segmentId === 'string') referencedIds.add(evidence.segmentId);
    }
    for (const rule of Array.isArray(profile.contrastRules) ? profile.contrastRules : []) {
      for (const id of Array.isArray(rule?.evidenceSegmentIds) ? rule.evidenceSegmentIds : []) {
        if (typeof id === 'string') referencedIds.add(id);
      }
    }
  }
  for (const rule of Array.isArray(rawMemory.relationshipVoiceRules) ? rawMemory.relationshipVoiceRules : []) {
    for (const id of Array.isArray(rule?.evidenceSegmentIds) ? rule.evidenceSegmentIds : []) {
      if (typeof id === 'string') referencedIds.add(id);
    }
  }
  for (const anchor of Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []) {
    if (typeof anchor?.segmentId === 'string') referencedIds.add(anchor.segmentId);
  }
  for (const segment of precedingSegments) referencedIds.add(segment.id);

  const ids = Array.from(referencedIds);
  const sourceById = new Map<string, { ordinal: number; text: string; contextPath: string }>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const refRows = projectContext.db.prepare(
      'SELECT segment_id, ordinal, text, context_path FROM source_segments ' +
      'WHERE source_revision_id = ? AND segment_id IN (' + chunk.map(() => '?').join(',') + ')'
    ).all(revisionId, ...chunk) as any[];
    for (const row of refRows) sourceById.set(String(row.segment_id), {
      ordinal: Number(row.ordinal), text: String(row.text || ''), contextPath: String(row.context_path || ''),
    });
  }
  for (const row of rows) sourceById.set(String(row.segment_id), {
    ordinal: Number(row.ordinal), text: String(row.text || ''), contextPath: String(row.context_path || ''),
  });
  const targetEvidenceSegmentIds = Array.from(new Set(
    (Array.isArray(rawMemory.entities) ? rawMemory.entities : []).flatMap((entity: any) =>
      (Array.isArray(entity?.targetEvidenceRefs) ? entity.targetEvidenceRefs : [])
        .map((ref: any) => typeof ref?.segmentId === 'string' ? ref.segmentId : ''))
      .filter(Boolean)
  ));
  const latestAcceptedTranslationBySegment = new Map<string, string>();
  for (let offset = 0; offset < targetEvidenceSegmentIds.length; offset += 400) {
    const chunk = targetEvidenceSegmentIds.slice(offset, offset + 400);
    const acceptedRows = projectContext.db.prepare(
      'SELECT s.segment_id AS segmentId, tr.translation_text AS translatedText ' +
      'FROM source_segments s JOIN translation_results tr ' +
        'ON tr.source_revision_id = s.source_revision_id AND tr.segment_id = s.segment_id ' +
      'WHERE s.source_revision_id = ? AND s.segment_id IN (' + chunk.map(() => '?').join(',') + ') ' +
        'AND tr.accepted = 1 AND tr.source_hash = s.source_hash AND tr.rowid = (' +
          'SELECT latest.rowid FROM translation_results latest ' +
          'WHERE latest.source_revision_id = s.source_revision_id AND latest.segment_id = s.segment_id ' +
            'AND latest.accepted = 1 AND latest.source_hash = s.source_hash ' +
          'ORDER BY COALESCE(latest.accepted_at, latest.created_at) DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1)'
    ).all(revisionId, ...chunk) as Array<{ segmentId: string; translatedText: string }>;
    for (const row of acceptedRows) latestAcceptedTranslationBySegment.set(String(row.segmentId), String(row.translatedText || ''));
  }
  const isPrior = (id: unknown) => {
    const source = typeof id === 'string' ? sourceById.get(id) : undefined;
    return !!source && Number.isFinite(source.ordinal) && source.ordinal < firstOrdinal;
  };
  const appearedBefore = (nameInput: unknown): boolean =>
    firstMatchingSourceOrdinal(projectContext.db, revisionId, nameInput, 'name') < firstOrdinal;
  const appearsAsEarlierEvidence = (quoteInput: unknown): boolean =>
    firstMatchingSourceOrdinal(projectContext.db, revisionId, quoteInput, 'quote') < firstOrdinal;

  // Never trust book-level recentExamples: retrieve examples from the accepted translation
  // ledger, pinned to this source revision and strictly before the current batch.
  const currentExampleSource = [...precedingSegments, ...items].map((item) => String(item.text || '')).join(' ');
  const stopWords = new Set([
    'about','after','again','against','almost','also','among','another','around','because','before','being',
    'between','could','does','during','each','every','from','have','hers','himself','into','just','more',
    'most','other','over','same','should','some','such','than','that','their','them','then','there','these',
    'they','this','those','through','under','very','were','what','when','where','which','while','with','would',
    'your','you','the','and','for','are','was','were','but','not','you','his','her','she','him','our','out',
    'who','how','why','can','did','had','has','its','let','may','now','off','once','one','only','own','say',
    'said','see','too','two','all','any','day','get','got','new','old','way'
  ]);
  const sourceTokens = (value: unknown) => new Set(
    (normalizedSourceText(value).match(/[\p{L}\p{N}]{2,}/gu) || [])
      .filter((token) => !stopWords.has(token))
  );
  const currentTokens = sourceTokens(currentExampleSource);
  const currentKinds = new Set(items.map((item) => String(item.kind || '')).filter(Boolean));
  const currentChapters = new Set(items.map((item) => String(item.contextPath || '')).filter(Boolean));
  const visibleReferenceNames = [
    ...(Array.isArray(rawMemory.entities) ? rawMemory.entities.flatMap((entity: any) =>
      [entity?.source, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]) : []),
    ...(Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices.flatMap((profile: any) =>
      [profile?.canonicalSourceName, ...(Array.isArray(profile?.aliases) ? profile.aliases : [])]) : []),
  ].filter((name: unknown) => typeof name === 'string' && appearedBefore(name));

  // Keep retrieval bounded without relying on a fixed "last N examples" window alone:
  // include recent accepted work, the current chapter, manually accepted examples, and rows
  // matching a small set of distinctive current-source tokens. Scoring/ranking below remains
  // authoritative. Query results are pinned to the immutable source revision and accepted row.
  const currentChapterParams = Array.from(currentChapters);
  const candidateTerms = Array.from(currentTokens)
    .filter((token) => token.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, 12);
  const candidateClauses = [
    's.ordinal >= ?',
    ...(currentChapterParams.length ? ['s.context_path IN (' + currentChapterParams.map(() => '?').join(',') + ')'] : []),
    "tr.origin = 'manual'",
    ...candidateTerms.map(() => 'instr(lower(s.text), lower(?)) > 0'),
  ];
  const recentOrdinalBoundary = Math.max(0, firstOrdinal - 250);
  const acceptedExampleRows = projectContext.db.prepare(
    'SELECT s.segment_id AS segmentId, s.ordinal, s.text AS source, s.context_path AS chapter, ' +
      's.kind, tr.translation_text AS target, tr.origin, COALESCE(tr.accepted_at, tr.created_at) AS acceptedAt ' +
    'FROM translation_results tr JOIN source_segments s ' +
      'ON s.source_revision_id = tr.source_revision_id AND s.segment_id = tr.segment_id ' +
    'WHERE tr.source_revision_id = ? AND tr.accepted = 1 AND tr.source_hash = s.source_hash AND s.ordinal < ? ' +
      'AND tr.rowid = (SELECT latest.rowid FROM translation_results latest ' +
        'WHERE latest.source_revision_id = s.source_revision_id AND latest.segment_id = s.segment_id ' +
          'AND latest.accepted = 1 AND latest.source_hash = s.source_hash ' +
        'ORDER BY COALESCE(latest.accepted_at, latest.created_at) DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1) ' +
      'AND (' + candidateClauses.join(' OR ') + ') ' +
    "ORDER BY CASE WHEN tr.origin = 'manual' THEN 0 " +
      (currentChapterParams.length ? 'WHEN s.context_path IN (' + currentChapterParams.map(() => '?').join(',') + ') THEN 1 ' : '') +
      'ELSE 2 END, s.ordinal DESC LIMIT 1200'
  ).all(
    revisionId, firstOrdinal,
    recentOrdinalBoundary,
    ...(currentChapterParams.length ? currentChapterParams : []),
    ...candidateTerms,
    ...(currentChapterParams.length ? currentChapterParams : []),
  ) as Array<{
    segmentId: string; ordinal: number; source: string; chapter: string; kind: string;
    target: string; origin: string; acceptedAt: string;
  }>;

  const scoredExamples = acceptedExampleRows.map((row) => {
    const tokens = sourceTokens(row.source);
    const shared = Array.from(tokens).filter((token) => currentTokens.has(token)).length;
    const overlap = shared / Math.max(1, Math.min(currentTokens.size, 12));
    const normalizedRowSource = normalizedSourceText(row.source);
    const normalizedCurrentSource = normalizedSourceText(currentExampleSource);
    const exactPhrase = normalizedRowSource.length >= 12 &&
      normalizedCurrentSource.includes(normalizedRowSource) ? 1 : 0;
    const sharedNamedEntity = visibleReferenceNames.some((name: unknown) =>
      sourceNameMatches(currentExampleSource, name) && sourceNameMatches(row.source, name)) ? 1 : 0;
    const sameChapter = currentChapters.has(String(row.chapter || '')) ? 0.8 : 0;
    const sameKind = currentKinds.has(String(row.kind || '')) ? 0.25 : 0;
    const manual = row.origin === 'manual' ? 1.2 : 0;
    const recency = 0.5 / (1 + Math.max(0, firstOrdinal - Number(row.ordinal)) / 40);
    const score = overlap * 6 + Math.min(shared, 3) * 0.15 + exactPhrase * 2 +
      sharedNamedEntity * 3.2 + sameChapter + sameKind + manual + recency;
    return { ...row, score, shared, exactPhrase, sharedNamedEntity, tokens };
  }).filter((row) => row.shared >= 2 || row.exactPhrase > 0 || row.sharedNamedEntity > 0)
    .sort((a, b) => b.score - a.score || Number(b.origin === 'manual') - Number(a.origin === 'manual') ||
      Number(b.ordinal) - Number(a.ordinal));

  // Select a compact, diverse set rather than injecting every historical match. Highly
  // overlapping examples usually repeat the same evidence and displace useful style variety.
  const retrievedExamples: Array<{ segmentId: string; source: string; target: string; chapter: string; origin: string }> = [];
  const selectedExampleTokens: Set<string>[] = [];
  for (const row of scoredExamples) {
    const source = String(row.source || '');
    const target = String(row.target || '');
    if (!source || !target) continue;
    const tokens = row.tokens as Set<string>;
    const redundant = selectedExampleTokens.some((selected) => {
      if (!tokens.size || !selected.size) return false;
      const intersection = Array.from(tokens).filter((token) => selected.has(token)).length;
      const union = tokens.size + selected.size - intersection;
      return intersection / Math.max(1, union) >= 0.85;
    });
    // Do not impose a fixed number/character budget on retrieved examples. Preserve every
    // relevant, materially different accepted example; filter by relevance and source similarity,
    // not by arbitrary context-size heuristics.
    if (redundant && row.sharedNamedEntity === 0 && row.exactPhrase === 0) continue;
    retrievedExamples.push({
      segmentId: String(row.segmentId),
      source,
      target,
      chapter: String(row.chapter || '').slice(0, 120),
      origin: ['manual', 'agent', 'imported'].includes(String(row.origin)) ? String(row.origin) : 'imported',
    });
    selectedExampleTokens.push(tokens);
  }
  rawMemory.entities = (Array.isArray(rawMemory.entities) ? rawMemory.entities : []).flatMap((entity: any) => {
    const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
    const evidenceRefs = Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [];
    const userConfirmedMapping = entity?.reviewStatus === 'confirmed' && entity?.confirmationSource === 'user-confirmed';
    const confirmedPersonMapping = entity?.kind === 'person' && userConfirmedMapping;
    // Inferred identities still fail closed when a later-only alias appears. A confirmed person
    // translation, however, is the canonical entry in 人物管理: keep it when its source name is
    // already visible, and omit only aliases first revealed in later chapters.
    if (!confirmedPersonMapping && aliases.some((alias: unknown) =>
      !appearedBefore(alias) && !items.some((item) => sourceNameMatches(item.text, alias)))) {
      exclusionDiagnostics.memoryEntityExcludedFutureAlias++;
      return [];
    }
    const explicitCanonicalMapping = userConfirmedMapping;
    const canonicalSourceVisibleNow = items.some((item) => sourceNameMatches(item.text, entity?.source));
    const visibleInCurrentBatch = canonicalSourceVisibleNow || items.some((item) =>
      aliases.some((alias: unknown) => sourceNameMatches(item.text, alias)));
    if (!entity || (!appearedBefore(entity.source) &&
        !(explicitCanonicalMapping && (visibleInCurrentBatch)))) {
      exclusionDiagnostics.memoryEntityExcludedNameNotVisible++;
      return [];
    }
    const priorEvidenceRefs = evidenceRefs.filter((ref: any) => {
      if (!ref || !isPrior(ref.segmentId)) return false;
      const source = sourceById.get(ref.segmentId);
      return !!source && sourceQuoteMatches(source.text, ref.sourceQuote) &&
        [entity.source, ...aliases].some((name: unknown) => sourceNameMatches(ref.sourceQuote, name));
    });
    const rawTargetEvidence = Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : [];
    const visibleTargetEvidence = rawTargetEvidence.filter((ref: any) => {
      if (!ref || !isPrior(ref.segmentId) ||
          normalizedSourceText(ref.targetSurface) !== normalizedSourceText(entity.target)) return false;
      const source = sourceById.get(ref.segmentId);
      if (!source || !sourceQuoteMatches(source.text, ref.sourceQuote) ||
          ![entity.source, ...aliases].some((name: unknown) => sourceNameMatches(ref.sourceQuote, name))) return false;
      const latestAcceptedTranslation = latestAcceptedTranslationBySegment.get(String(ref.segmentId));
      // If this source segment has since been accepted/edited, an older candidate surface must
      // not keep a corrected target promoted. When no accepted result exists yet, retain the
      // validated in-run surface as provisional rather than treating it as human-reviewed.
      if (latestAcceptedTranslation !== undefined &&
          !normalizedSourceText(latestAcceptedTranslation).includes(normalizedSourceText(ref.targetSurface))) {
        exclusionDiagnostics.targetEvidenceExcludedAfterAcceptedCorrection++;
        return false;
      }
      return true;
    });
    const independentTargetEvidenceCount = new Set(visibleTargetEvidence.map((ref: any) => ref.segmentId)).size;
    const targetConfidence = entity.reviewStatus === 'confirmed' ? 'confirmed' :
      independentTargetEvidenceCount >= 2 ? 'corroborated' : 'candidate';
    // Dynamic candidates retain exact source and target evidence segments; source-name
    // recognition alone is not enough to make the proposed target a forced canonical mapping.
    const evidenceVisible = explicitCanonicalMapping || (evidenceRefs.length
      ? priorEvidenceRefs.length > 0
      : sourceNameMatches(entity.evidence, entity.source) && appearsAsEarlierEvidence(entity.evidence));
    if (!evidenceVisible) {
      const hasFutureEvidence = evidenceRefs.some((ref: any) => {
        const source = typeof ref?.segmentId === 'string' ? sourceById.get(ref.segmentId) : undefined;
        return !!source && Number(source.ordinal) >= firstOrdinal;
      });
      exclusionDiagnostics.memoryEntityExcludedEvidenceNotVisible++;
      if (hasFutureEvidence) (exclusionDiagnostics as any).memoryEntityExcludedFutureEvidence =
        Number((exclusionDiagnostics as any).memoryEntityExcludedFutureEvidence || 0) + 1;
      return [];
    }
    const visibleAliases = aliases.filter((alias: unknown) =>
      appearedBefore(alias) || items.some((item) => sourceNameMatches(item.text, alias)));
    return [{
      ...entity,
      aliases: visibleAliases,
      ...(evidenceRefs.length ? { evidenceRefs: priorEvidenceRefs } : {}),
      targetEvidenceRefs: visibleTargetEvidence,
      targetConfidence,
    }];
  });
  rawMemory.relationships = (Array.isArray(rawMemory.relationships) ? rawMemory.relationships : []).flatMap((relation: any) => {
    if (!relation || !appearedBefore(relation.subject) || !appearedBefore(relation.object)) {
      exclusionDiagnostics.memoryRelationshipExcludedNameNotVisible++;
      return [];
    }
    const evidenceRefs = Array.isArray(relation.evidenceRefs) ? relation.evidenceRefs : [];
    const priorEvidenceRefs = evidenceRefs.filter((ref: any) => {
      if (!ref || !isPrior(ref.segmentId)) return false;
      const source = sourceById.get(ref.segmentId);
      return !!source && sourceQuoteMatches(source.text, ref.sourceQuote) &&
        sourceNameMatches(ref.sourceQuote, relation.subject) && sourceNameMatches(ref.sourceQuote, relation.object);
    });
    // Relationship analysis is default-adopted. Keep only names already visible before this
    // batch; evidence quality is retained as metadata and never asks the reader to approve it.
    return [{
      ...relation,
      reviewStatus: relation.reviewStatus === 'rejected' ? 'rejected' : 'confirmed',
      ...(evidenceRefs.length ? { evidenceRefs: priorEvidenceRefs } : {}),
    }].filter((item: any) => item.reviewStatus !== 'rejected');
  });

  rawMemory.characterVoices = (Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices : []).flatMap((profile: any) => {
    const rawEvidence = Array.isArray(profile.evidence) ? profile.evidence : [];
    // Legacy Run snapshots and callers can bypass the current-memory sanitizer. Re-derive the
    // old eight-row truncation condition here so a missing completeness flag cannot leak an
    // aggregate profile synthesized from omitted future dialogue into an early batch.
    const hasFutureEvidence = rawEvidence.some((item: any) => {
      const source = typeof item?.segmentId === 'string' ? sourceById.get(item.segmentId) : undefined;
      return !!source && Number(source.ordinal) >= firstOrdinal;
    });
    const invalidEvidence = rawEvidence.some((item: any) => {
      if (!item || !isPrior(item.segmentId)) return true;
      const source = sourceById.get(item.segmentId);
      return !source || !sourceQuoteMatches(source.text, item.sourceQuote);
    });
    if (hasFutureEvidence) {
      // Aggregate voiceCore may include later dialogue; never leak it into an earlier batch.
      exclusionDiagnostics.characterVoiceExcludedFutureEvidence++;
      return [];
    }
    // Partial or imperfect evidence lowers traceability, not adoption. Retain valid prior
    // examples and use the model's current best profile instead of waiting for a click.
    const usableEvidence = rawEvidence.filter((item: any) => {
      if (!item || !isPrior(item.segmentId)) return false;
      const source = sourceById.get(item.segmentId);
      return !!source && sourceQuoteMatches(source.text, item.sourceQuote);
    });
    if (!usableEvidence.length && !profile.voiceCore) {
      exclusionDiagnostics.characterVoiceExcludedIncompleteEvidence++;
      return [];
    }
    if (!appearedBefore(profile.canonicalSourceName)) {
      exclusionDiagnostics.characterVoiceExcludedNameNotVisible++;
      return [];
    }
    const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
    if (aliases.some((alias: unknown) => !appearedBefore(alias))) {
      exclusionDiagnostics.characterVoiceExcludedFutureAlias++;
      return [];
    }
    const contrastRules = (Array.isArray(profile.contrastRules) ? profile.contrastRules : []).filter((rule: any) => {
      const ids = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
      return ids.length > 0 && ids.every(isPrior) && rawMemory.characterVoices.some((other: any) =>
        other.characterId === rule.otherCharacterId && appearedBefore(other.canonicalSourceName) &&
        (Array.isArray(other.aliases) ? other.aliases : []).every((alias: unknown) => appearedBefore(alias)));
    }).map((rule: any) => ({ ...rule, evidenceSegmentIds: rule.evidenceSegmentIds.filter(isPrior) }));
    return [{ ...profile, status: profile.status === 'rejected' ? 'rejected' : 'confirmed',
      confirmationSource: profile.confirmationSource || 'model-default',
      useForTranslation: profile.status !== 'rejected' && profile.useForTranslation !== false,
      aliases, evidence: usableEvidence, contrastRules }];
  });
  const visibleCharacterIds = new Set(rawMemory.characterVoices.map((profile: any) => profile.characterId));
  rawMemory.relationshipVoiceRules = (Array.isArray(rawMemory.relationshipVoiceRules) ? rawMemory.relationshipVoiceRules : [])
    .filter((rule: any) => {
      const evidenceIds = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
      return evidenceIds.every(isPrior) &&
        visibleCharacterIds.has(rule.speakerId) && visibleCharacterIds.has(rule.addresseeId) &&
        rule.status !== 'rejected';
    })
    .map((rule: any) => ({
      ...rule,
      status: 'confirmed',
      confirmationSource: rule.confirmationSource || 'model-default',
      evidenceSegmentIds: (Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : []).filter(isPrior),
      addressTerms: (Array.isArray(rule.addressTerms) ? rule.addressTerms : [])
        .filter((term: unknown) => appearedBefore(term)),
      // Scene-dependent register changes often summarize a later arc without segment-level quotes.
      sceneDependentShift: '',
    }));
  rawMemory.voiceAnchors = (Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []).filter((voiceAnchor: any) => {
    const source = sourceById.get(String(voiceAnchor?.segmentId || ''));
    return !!source && source.ordinal < firstOrdinal &&
      visibleCharacterIds.has(voiceAnchor.speakerId) && sourceQuoteMatches(source.text, voiceAnchor.source) &&
      sourceNameMatches(source.text, voiceAnchor.source);
  });

  // These book-level strings lack source-positioned citations. Do not let whole-book analysis
  // leak a future plot fact through a field labelled "style", "example", or "summary".
  // Whole-book summaries/examples remain excluded to protect temporal plot boundaries. Style-only
  // guides are default-adopted; a user can explicitly disable the generated guide.
  const styleGuideEnabled = rawMemory.styleGuideAutoDisabled !== true &&
    (rawMemory.styleGuideOrigin === 'context-graph' || rawMemory.styleGuideOrigin === 'user-edited' ||
      Object.keys(rawMemory.styleGuide || {}).length > 0);
  rawMemory.styleGuide = styleGuideEnabled ? rawMemory.styleGuide : {};
  rawMemory.styleGuideStatus = styleGuideEnabled ? 'confirmed' : 'candidate';
  rawMemory.styleGuideConfirmationSource = styleGuideEnabled
    ? rawMemory.styleGuideConfirmationSource || 'model-default' : undefined;
  rawMemory.chapterSummaries = [];
  rawMemory.recentExamples = retrievedExamples;
  rawMemory.openQuestions = [];
  // The voice-context sanitizer intentionally ignores these counters; TranslationBrief copies
  // them into its durable diagnostic summary so zero-injection and boundary exclusions are visible.
  rawMemory.__translationBriefDiagnostics = {
    ...exclusionDiagnostics,
    memoryEntityCandidates: initialMemoryCounts.entities,
    temporallyVisibleMemoryEntities: rawMemory.entities.length,
    memoryEntityExcludedByBoundary: Math.max(0, initialMemoryCounts.entities - rawMemory.entities.length),
    memoryRelationshipCandidates: initialMemoryCounts.relationships,
    temporallyVisibleMemoryRelationships: rawMemory.relationships.length,
    memoryRelationshipExcludedByBoundary: Math.max(0, initialMemoryCounts.relationships - rawMemory.relationships.length),
    characterVoiceCandidates: initialMemoryCounts.characterVoices,
    temporallyVisibleCharacterVoices: rawMemory.characterVoices.length,
    characterVoicesExcludedByBoundary: Math.max(0, initialMemoryCounts.characterVoices - rawMemory.characterVoices.length),
    acceptedExampleCandidates: scoredExamples.length,
    selectedAcceptedExamples: retrievedExamples.length,
  };
  return rawMemory;
}

function filterGlossaryForBatch(context: any, items: BriefSegment[]): unknown {
  const configured = context?.prompt?.config?.glossary ?? context?.prompt?.glossary ?? null;
  if (context?.run?.translationMode !== 'literary') return configured;
  const empty = { document_terms: [] as unknown[] };
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || !items.length) return empty;

  const projectId = String(context?.project?.projectId || '');
  const revisionId = String(context?.run?.sourceRevisionId || '');
  const { db } = getDocumentProjectStore().getProjectContext(projectId);
  const sourceRevisionExists = !!projectId && !!db.prepare(
    'SELECT 1 FROM source_revisions WHERE revision_id = ?'
  ).get(revisionId);
  if (!sourceRevisionExists) return empty;
  const rows = db.prepare(
    'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
      items.map(() => '?').join(',') + ')'
  ).all(revisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
  const ordinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!ordinals.length) return empty;
  const firstOrdinal = Math.min(...ordinals);

  const appearedEarlier = (value: unknown): boolean =>
    firstMatchingSourceOrdinal(db, revisionId, value, 'name') < firstOrdinal;
  const visibleInBatch = (value: unknown): boolean =>
    items.some((item) => sourceNameMatches(item.text, value));

  const allowedKeys = [
    'source', 'source_term', 'term', 'original', 'en', 'from',
    'target', 'target_term', 'translation', 'zh', 'to',
    'kind', 'category', 'caseSensitive', 'case_sensitive',
  ];
  const sourceOf = (item: any) => item && typeof item === 'object'
    ? item.source ?? item.source_term ?? item.term ?? item.original ?? item.en ?? item.from
    : item;
  const terms = Array.isArray((configured as any).document_terms) ? (configured as any).document_terms : [];
  return {
    document_terms: terms.flatMap((term: any) => {
      const source = sourceOf(term);
      // A static glossary entry is useful on its first actual occurrence. Only entries whose
      // source name is absent from both the preceding book text and this batch are withheld.
      if (!appearedEarlier(source) && !visibleInBatch(source)) return [];
      if (typeof term === 'string') return [term];
      if (!term || typeof term !== 'object' || Array.isArray(term)) return [];
      const aliasKeys = ['aliases', 'source_aliases', 'sourceAliases'];
      // If any alias is first revealed at/after this batch, the canonical target may itself
      // have been chosen from that reveal. Do not merely remove the alias and retain the target.
      if (aliasKeys.some((key) => Array.isArray(term[key]) &&
          (term[key] as unknown[]).some((alias) => !appearedEarlier(alias) && !visibleInBatch(alias)))) return [];
      const selected: Record<string, unknown> = {};
      for (const key of allowedKeys) {
        const value = term[key];
        if (value !== undefined && (typeof value !== 'object' || value === null)) selected[key] = value;
      }
      for (const key of aliasKeys) {
        if (Array.isArray(term[key])) selected[key] = [...term[key]];
      }
      return [selected];
    }),
  };
}

function serializedContext(brief: Pick<TranslationBrief,
  'policyVersion' | 'sourceRevisionId' | 'promptRevisionId' | 'memoryRevisionId' |
  'sourceSegmentIds' | 'chapterPath' | 'glossary' | 'precedingSegments' | 'contextGraph' | 'voiceContext' | 'contextDeltaCount'
>): string {
  return JSON.stringify({
    policyVersion: brief.policyVersion,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    contextDeltaCount: brief.contextDeltaCount,
    sourceSegmentIds: brief.sourceSegmentIds,
    chapterPath: brief.chapterPath,
    glossary: brief.glossary,
    precedingSegments: brief.precedingSegments,
    contextGraph: brief.contextGraph,
    voiceContext: brief.voiceContext,
  });
}

export function buildTranslationBrief(
  context: any,
  items: BriefSegment[],
  precedingSegments: BriefSegment[] = [],
): TranslationBrief {
  const projectId = String(context?.project?.projectId || '');
  if (!projectId) throw new Error('TranslationBrief 缺少 projectId');
  const sourceRevisionId = String(context?.run?.sourceRevisionId || '');
  const promptRevisionId = String(context?.run?.promptRevisionId || '');
  const memoryRevisionId = typeof context?.memoryRevisionId === 'string' ? context.memoryRevisionId : null;
  const strategy = normalizeDocumentTranslationStrategy(context?.prompt?.config?.translationStrategy);
  const selectedPrecedingSegments = strategy.precedingContextSegments > 0
    ? precedingSegments.slice(-strategy.precedingContextSegments)
    : [];
  // Resolve predecessor metadata from the immutable run source. Some callers provide only id/text,
  // but dialogue-participant retrieval needs the actual segment kind and must not infer it from prose.
  const visiblePrecedingSegments: BriefSegment[] = [];
  if (selectedPrecedingSegments.length) {
    const projectContext = getDocumentProjectStore().getProjectContext(projectId);
    const ids = selectedPrecedingSegments.map((item) => item.id);
    const rows = projectContext.db.prepare(
      'SELECT segment_id, text, kind, context_path FROM source_segments ' +
      'WHERE source_revision_id = ? AND segment_id IN (' + ids.map(() => '?').join(',') + ')'
    ).all(sourceRevisionId, ...ids) as Array<{
      segment_id: string; text: string; kind: string; context_path: string;
    }>;
    const rowsById = new Map(rows.map((row) => [String(row.segment_id), row]));
    for (const item of selectedPrecedingSegments) {
      const row = rowsById.get(item.id);
      // A stale ID from another revision is not valid preceding context for this Run.
      if (!row) continue;
      visiblePrecedingSegments.push({
        id: String(row.segment_id),
        text: String(row.text || ''),
        kind: String(row.kind || ''),
        contextPath: String(row.context_path || ''),
      });
    }
  }
  // strategy.contextBudgetChars remains a legacy preference, not a hard ceiling. Context must not
  // be silently discarded just to satisfy an arbitrary character budget; provider limits are handled
  // by the runtime/model request layer, which can report a genuine provider rejection explicitly.
  const maxBriefChars = MAX_TRANSLATION_BRIEF_CHARS;
  const glossary = filterGlossaryForBatch(context, items);
  const temporalMemory = context?.run?.translationMode === 'literary'
    ? buildTemporallyVisibleMemory(context, items, visiblePrecedingSegments)
    : {};
  const chapterPaths = Array.from(new Set(items.map((item) => String(item.contextPath || '').trim()).filter(Boolean)));
  // Book batches should be chapter-scoped. If callers violate that invariant, omitting summaries is safer.
  const chapterPath = chapterPaths.length === 1 ? chapterPaths[0]! : '';
  let graph = context?.run?.translationMode === 'literary'
    ? buildProjectContextGraphBundle(
        projectId,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        visiblePrecedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        sourceRevisionId,
        String(context?.run?.targetLang || 'zh'),
      ) as Record<string, any> | null
    : null;
  if (context?.run?.translationMode === 'literary' && !graph) {
    // A book with no eligible Context Graph nodes can still have an explicit user glossary or
    // source-evidenced LiteraryMemory. The previous null result skipped that entire merge path,
    // so confirmed names silently disappeared from the actual translation request.
    graph = {
      policyVersion: 'context-graph-v5-canonical-entity-style-quality',
      knowledgeBoundaryOrdinal: null,
      currentChapter: chapterPath,
      chapterSummaries: [],
      characters: [],
      entities: [],
      relationships: [],
      nameMappings: [],
      styleGuide: { narrativeStyle: '', rules: [] },
      constraints: ['Only source-visible explicit mappings and evidence-backed memory may be added to this empty graph.'],
    };
  }
  const graphRetrievalDiagnostics = (graph as any)?.retrievalDiagnostics &&
    typeof (graph as any).retrievalDiagnostics === 'object'
    ? { ...(graph as any).retrievalDiagnostics } : {};
  if (graph && Object.prototype.hasOwnProperty.call(graph, 'retrievalDiagnostics')) {
    delete (graph as any).retrievalDiagnostics;
  }
  if (graph && Array.isArray(graph.nameMappings)) {
    // Do not feed generic titles or aliases belonging to another person back to the translator.
    graph.nameMappings = graph.nameMappings.flatMap((mapping: any) => {
      const source = typeof mapping?.source === 'string' ? mapping.source.trim() : '';
      const target = typeof mapping?.target === 'string' ? mapping.target.trim() : '';
      if (!source || !target || isGenericCanonicalSourceName(source)) return [];
      return [{ ...mapping, aliases: safeCanonicalSourceAliases(source, mapping.aliases) }];
    });
    const sourceText = [...visiblePrecedingSegments, ...items].map((item) => item.text).join('\n');
    const priorSourceText = visiblePrecedingSegments.map((item) => item.text).join('\n');
    const projectContext = getDocumentProjectStore().getProjectContext(projectId);
    const batchRows = projectContext.db.prepare(
      'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
        items.map(() => '?').join(',') + ')'
    ).all(sourceRevisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
    const ordinals = batchRows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
    const firstOrdinal = ordinals.length ? Math.min(...ordinals) : Number.POSITIVE_INFINITY;
    const sourceVisible = (name: unknown) =>
      firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, name, 'name') < firstOrdinal ||
      sourceNameMatches(sourceText, name);
    const memoryEntities = Array.isArray((temporalMemory as any)?.entities) ? (temporalMemory as any).entities : [];
    const sourceRowCache = new Map<string, { ordinal: number; text: string } | null>();
    const sourceRowFor = (segmentId: unknown) => {
      const id = typeof segmentId === 'string' ? segmentId : '';
      if (!id) return null;
      if (sourceRowCache.has(id)) return sourceRowCache.get(id) || null;
      const row = projectContext.db.prepare(
        'SELECT ordinal, text FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
      ).get(sourceRevisionId, id) as { ordinal?: number; text?: string } | undefined;
      const value = row && Number.isFinite(Number(row.ordinal))
        ? { ordinal: Number(row.ordinal), text: String(row.text || '') } : null;
      sourceRowCache.set(id, value);
      return value;
    };
    for (const entity of memoryEntities) {
      const source = String(entity?.source || '').trim();
      const target = String(entity?.target || '').trim();
      const evidence = String(entity?.evidence || '').trim();
      const rawAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
      const userConfirmedMapping = entity.reviewStatus === 'confirmed' && entity.confirmationSource === 'user-confirmed';
      const entityKind = normalizeCanonicalEntityKind(entity.kind);
      if (!source || !target || !validateCanonicalTarget({ source, target, targetLang: String(context?.run?.targetLang || 'zh'), kind: entityKind }).valid) continue;
      if (!userConfirmedMapping && !isWorthCanonicalEntityMapping({ source, kind: entityKind, significance: entity.description || entity.evidence, explicitBookSpecificMeaning: entity.bookSpecificMeaning === true })) continue;
      const confirmedPersonMapping = entity.kind === 'person' && userConfirmedMapping;
      // A confirmed person name is a canonical mapping in 人物管理. Activate it only when the
      // canonical source or one of its aliases is visible; omit later-only aliases without suppressing
      // the whole translation name.
      if (!source || !target ||
          (!sourceVisible(source) && !rawAliases.some((alias: unknown) => sourceVisible(alias)))) continue;
      const aliasIsVisible = (alias: unknown) =>
        firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, alias, 'name') < firstOrdinal ||
        sourceNameMatches(sourceText, alias);
      const aliasesVisibleAtBoundary = rawAliases.every(aliasIsVisible);
      // Inferred/non-person mappings remain fail-closed when any identity alias first appears later.
      if (!aliasesVisibleAtBoundary && !confirmedPersonMapping) continue;
      const visibleEvidenceRefs = (Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : []).filter((ref: any) => {
        const row = sourceRowFor(ref?.segmentId);
        return !!row && row.ordinal < firstOrdinal &&
          sourceQuoteMatches(row.text, ref?.sourceQuote) &&
          sourceNameMatches(ref.sourceQuote, source);
      });
      // New dynamic memory has segment-specific provenance. Do not fall back to searching the
      // same quotation elsewhere in the book, because duplicate prose can predate the observation.
      // Legacy/user-authored mappings without evidenceRefs retain the source-quote fallback.
      // A confirmed person mapping is the canonical target shown in 人物管理. Its source name
      // and aliases must still be visible at this temporal boundary, but a character's voice-evidence
      // quote need not be from an earlier segment; otherwise the same confirmed name could disappear
      // from some batches and translator/Reviewer behavior would drift.
      // A user-confirmed source→target name mapping is canonical regardless of entity kind.
      // It must work on the first source occurrence too; requiring earlier evidence would make
      // confirmed organization/clan/place names behave differently from confirmed character names.
      const explicitCanonicalMapping = userConfirmedMapping;
      const evidenceVisible = explicitCanonicalMapping ||
        (Array.isArray(entity.evidenceRefs) && entity.evidenceRefs.length
          ? visibleEvidenceRefs.length > 0
          : !!evidence && (
              firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, evidence, 'quote') < firstOrdinal ||
              normalizedSourceText(sourceText).includes(normalizedSourceText(evidence))));
      if (!evidenceVisible) continue;
      // The alias must be visible by the start of this batch or in its actual source text;
      // an alias first revealed in a later chapter still cannot activate the mapping.
      const aliases = rawAliases.filter((alias: unknown) =>
        firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, alias, 'name') < firstOrdinal ||
        sourceNameMatches(sourceText, alias));
      const targetRefs = Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : [];
      const corroboratedTarget = entity.targetConfidence === 'corroborated' &&
        new Set(targetRefs.map((ref: any) => ref?.segmentId).filter(Boolean)).size >= 2;
      const incoming = {
        source, target, aliases,
        kind: String(entity.kind || 'other'),
        evidenceBacked: true,
        targetConfidence: userConfirmedMapping ? 'confirmed' :
          corroboratedTarget ? 'corroborated' : 'candidate',
        sourceStatus: userConfirmedMapping ? 'confirmed-memory' : corroboratedTarget ? 'auto' : 'candidate',
        confirmationSource: entity.confirmationSource || 'legacy-unknown',
      };
      const names = new Set([source, ...aliases].map((name) => normalizedSourceText(name)));
      const index = graph.nameMappings.findIndex((mapping: any) =>
        [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
          .some((name: unknown) => names.has(normalizedSourceText(name))));
      if (userConfirmedMapping) {
        if (index >= 0) graph.nameMappings[index] = { ...graph.nameMappings[index], ...incoming };
        else graph.nameMappings.unshift(incoming);
      } else if (index < 0) {
        graph.nameMappings.push(incoming);
      } else {
        // A source-ordered dynamic candidate outranks an unconfirmed whole-book proposal.
        // Keep an already confirmed Context Graph mapping, but avoid injecting two competing targets.
        const existing = graph.nameMappings[index];
        const existingStatus = String(existing?.sourceStatus || '');
        if (!['confirmed', 'confirmed-memory'].includes(existingStatus) &&
            (existingStatus !== 'run-canonical' || incoming.sourceStatus === 'auto')) {
          graph.nameMappings[index] = { ...existing, ...incoming };
        }
      }
    }
    const mappingRelevance = (mapping: any) => {
      const names = [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])];
      const inCurrent = names.some((name: unknown) => items.some((item) => sourceNameMatches(item.text, name))) ? 2 : 0;
      const inPreceding = names.some((name: unknown) => visiblePrecedingSegments.some((item) =>
        sourceNameMatches(item.text, name))) ? 1 : 0;
      const statusRank = ['confirmed', 'confirmed-memory'].includes(String(mapping.sourceStatus)) ? 5 :
        mapping.sourceStatus === 'auto' ? 4 : mapping.sourceStatus === 'run-canonical' ? 3 : 1;
      return statusRank + inCurrent + inPreceding;
    };
    graph.nameMappings.sort((a: any, b: any) => mappingRelevance(b) - mappingRelevance(a));
    // Keep every source-visible mapping; relevance ordering is useful, but a fixed count can
    // discard a confirmed name needed later in the same batch.
  }
  const voiceContext = context?.run?.translationMode === 'literary'
    ? buildProjectVoiceContext(
        temporalMemory,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath, kind: item.kind })),
        chapterPath || undefined,
        visiblePrecedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath, kind: item.kind })),
      ) as Record<string, any>
    : {};
  let characterProfileMappingConflictCount = 0;
  if (graph) {
    const visibleSourceSegments = [...visiblePrecedingSegments, ...items];
    const isVisibleHere = (name: unknown) => typeof name === 'string' && name.trim() &&
      visibleSourceSegments.some((item) => sourceNameMatches(item.text, name));
    // Use the run-pinned, Store-validated profile snapshot for canonical names. Voice-context
    // retrieval deliberately requires earlier evidence, so using only its selected profiles would
    // make a confirmed name disappear when its supporting quote belongs to the current batch.
    const pinnedProfiles = Array.isArray((context as any)?.memory?.characterVoices)
      ? (context as any).memory.characterVoices as Array<Record<string, any>>
      : [];
    for (const profile of pinnedProfiles) {
      const source = typeof profile?.canonicalSourceName === 'string' ? profile.canonicalSourceName.trim() : '';
      const target = typeof profile?.targetName === 'string' ? profile.targetName.trim() : '';
      const status = String(profile?.status || '');
      if (!source || !target || profile.useForTranslation === false ||
          !['confirmed', 'candidate'].includes(status) || isGenericCanonicalSourceName(source)) continue;
      const aliases = safeCanonicalSourceAliases(source, profile.aliases).filter(isVisibleHere);
      // The canonical source or at least one safe, source-visible alias must be relevant to
      // this batch. Names merely stored elsewhere in the book are not injected into the prompt.
      if (!isVisibleHere(source) && !aliases.length) continue;
      const incoming = {
        source, target, aliases, kind: 'character',
        evidenceBacked: status === 'confirmed',
        targetConfidence: status === 'confirmed' ? 'confirmed' : 'candidate',
        sourceStatus: status === 'confirmed' ? 'confirmed-memory' : 'candidate',
      };
      const names = new Set([source, ...aliases].map(normalizedSourceText));
      const matches = (mapping: any) =>
        [mapping?.source, ...(Array.isArray(mapping?.aliases) ? mapping.aliases : [])]
          .some((name: unknown) => typeof name === 'string' && names.has(normalizedSourceText(name)));
      const conflicting = graph.nameMappings.filter((mapping: any) =>
        matches(mapping) && ['confirmed', 'confirmed-memory'].includes(String(mapping?.sourceStatus || '')) &&
        normalizedSourceText(mapping?.target) !== normalizedSourceText(target));
      if (status === 'confirmed' && conflicting.length) {
        // Two confirmed sources disagree. Remove hard mappings for the overlapping names and
        // expose the conflict as a constraint; never silently let array order select the winner.
        graph.nameMappings = graph.nameMappings.filter((mapping: any) => !matches(mapping));
        const oldConflicts = Array.isArray(graph.canonicalNameMappingConflicts) ? graph.canonicalNameMappingConflicts : [];
        graph.canonicalNameMappingConflicts = [
          ...oldConflicts,
          ...conflicting.map((mapping: any) => ({ source, existingTarget: String(mapping.target || ''), profileTarget: target })),
        ];
        const constraints = Array.isArray(graph.constraints) ? graph.constraints : [];
        graph.constraints = Array.from(new Set([
          ...constraints,
          'Conflicting confirmed canonical-name mappings are listed in canonicalNameMappingConflicts. Do not choose a target arbitrarily; preserve the source name and request project-memory correction.',
        ]));
        characterProfileMappingConflictCount++;
        continue;
      }
      const matched = graph.nameMappings.filter(matches);
      if (status === 'candidate' && matched.some((mapping: any) =>
          ['confirmed', 'confirmed-memory', 'run-canonical', 'auto'].includes(String(mapping?.sourceStatus || '')))) continue;
      const mergedAliases = safeCanonicalSourceAliases(source, [
        ...aliases,
        ...matched.flatMap((mapping: any) => Array.isArray(mapping?.aliases) ? mapping.aliases : []),
      ]).filter(isVisibleHere);
      graph.nameMappings = graph.nameMappings.filter((mapping: any) => !matches(mapping));
      graph.nameMappings.unshift({ ...incoming, aliases: mergedAliases });
    }
    graph.nameMappings.sort((a: any, b: any) => {
      const rank = (mapping: any) => {
        const statusRank = ['confirmed', 'confirmed-memory'].includes(String(mapping?.sourceStatus || '')) ? 5 :
          mapping?.sourceStatus === 'auto' ? 4 : mapping?.sourceStatus === 'run-canonical' ? 3 : 1;
        const names = [mapping?.source, ...(Array.isArray(mapping?.aliases) ? mapping.aliases : [])];
        const inCurrent = names.some((name: unknown) => items.some((item) => sourceNameMatches(item.text, name))) ? 2 : 0;
        const inPreceding = names.some((name: unknown) => visiblePrecedingSegments.some((item) =>
          sourceNameMatches(item.text, name))) ? 1 : 0;
        return statusRank + inCurrent + inPreceding;
      };
      return rank(b) - rank(a);
    });
    // Keep every source-visible mapping; relevance ordering is useful, but a fixed count can
    // discard a confirmed name needed later in the same batch.
    if (characterProfileMappingConflictCount) {
      logInfo('translation-brief', 'confirmed character profile mapping conflicts=' + characterProfileMappingConflictCount);
    }
  }
  // A completed, version-matched style-only baseline is auto-applied. Its fields must never
  // supply plot facts or identity claims; user-confirmed style memory has priority.
  if (graph) {
    const candidateStyle = graph.styleGuide && typeof graph.styleGuide === 'object' ? graph.styleGuide : {};
    const required = ['narrativeStyle', 'register', 'rhythm', 'dialogue', 'diction'];
    const styleReady = graph.analysisVersion === CONTEXT_GRAPH_ANALYSIS_VERSION &&
      required.every((key) => typeof candidateStyle[key] === 'string' && candidateStyle[key].trim()) &&
      Array.isArray(candidateStyle.rules) && candidateStyle.rules.some((item: unknown) => typeof item === 'string' && item.trim());
    const userConfirmedStyle = temporalMemory.styleGuideStatus === 'confirmed';
    const userEditedStyle = temporalMemory.styleGuideOrigin === 'user-edited';
    const userStyle = userConfirmedStyle || userEditedStyle ? temporalMemory.styleGuide : null;
    const machineStyleEnabled = temporalMemory.styleGuideAutoDisabled !== true;
    graph.styleGuide = userStyle ? {
      ...userStyle, sourceStatus: userConfirmedStyle ? 'user-confirmed' : 'user-edited',
    } : styleReady && machineStyleEnabled ? {
      narrativeStyle: candidateStyle.narrativeStyle, register: candidateStyle.register, rhythm: candidateStyle.rhythm,
      dialogue: candidateStyle.dialogue, diction: candidateStyle.diction, rules: candidateStyle.rules, avoid: candidateStyle.avoid || [],
      sourceStatus: 'machine-applied', analysisVersion: graph.analysisVersion,
    } : { narrativeStyle: '', rules: [], sourceStatus: machineStyleEnabled ? 'unavailable' : 'user-disabled' };
    graph.styleGuideReady = !!userStyle || (styleReady && machineStyleEnabled);
    graph.policyVersion = 'context-graph-v5-canonical-entity-style-quality';
    graph.constraints = [...(Array.isArray(graph.constraints) ? graph.constraints : []),
      'styleGuide 只约束文风、句法、语域和词汇选择；绝不可用它推断或补写人物身份、事件、秘密与剧情结论。'];
  }
  // Graph chapter order is derived from source segment order and therefore is the canonical
  // boundary. Do not use memory-only summaries when chapter matching could be ambiguous.
  voiceContext.chapterSummaries = graph && chapterPath ? graph.chapterSummaries : [];
  const brief: TranslationBrief = {
    version: 1,
    policyVersion: TRANSLATION_BRIEF_POLICY_VERSION,
    sourceRevisionId,
    promptRevisionId,
    memoryRevisionId,
    contextDeltaCount: Math.max(0, Number(context?.contextDeltaCount || 0)),
    sourceSegmentIds: items.map((item) => item.id),
    chapterPath,
    glossary,
    precedingSegments: visiblePrecedingSegments.map((item) => ({
      id: item.id,
      text: String(item.text || ''),
      contextPath: String(item.contextPath || '').slice(0, 160),
    })),
    contextGraph: graph,
    voiceContext,
    contextDiagnostics: {
      ...(typeof (temporalMemory as any)?.__translationBriefDiagnostics === 'object'
        ? (temporalMemory as any).__translationBriefDiagnostics : {}),
      ...graphRetrievalDiagnostics,
      characterProfileMappingConflictCount,
      precedingContextAvailable: precedingSegments.length,
      precedingContextConfigured: strategy.precedingContextSegments,
      precedingContextInjected: visiblePrecedingSegments.length,
      graphNameMappingsBeforeBudget: Array.isArray((graph as any)?.nameMappings) ? (graph as any).nameMappings.length : 0,
      strongNameMappingsBeforeBudget: Array.isArray((graph as any)?.nameMappings)
        ? (graph as any).nameMappings.filter((mapping: any) =>
            ['confirmed', 'confirmed-memory', 'auto', 'run-canonical'].includes(String(mapping.sourceStatus))).length : 0,
      acceptedExamplesInjected: Array.isArray((voiceContext as any)?.recentExamples) ? (voiceContext as any).recentExamples.length : 0,
      dialogueParticipantsInjected: Array.isArray((voiceContext as any)?.dialogueParticipants)
        ? (voiceContext as any).dialogueParticipants.length : 0,
      contextBudgetChars: maxBriefChars,
      budgetTrimCount: 0,
      budgetFallbackUsed: false,
    },
    contextChars: 0,
    contextHash: '',
  };
  // Do not prune retrieved context to satisfy a configured character budget. In particular,
  // never erase glossary terms, voice profiles, accepted examples, preceding dialogue, or confirmed
  // name mappings as an indirect consequence of a prompt-size heuristic. The runtime/provider owns
  // the actual model context-window check and should surface a real limit error without mutating evidence.
  const serialized = serializedContext(brief);
  (brief.contextDiagnostics as any).budgetTrimCount = 0;
  (brief.contextDiagnostics as any).budgetFallbackUsed = false;
  (brief.contextDiagnostics as any).contextBudgetPolicy = 'preserve-retrieved-context';
  const finalGraph = brief.contextGraph as any;
  const finalVoice = brief.voiceContext as any;
  const finalMappings = Array.isArray(finalGraph?.nameMappings) ? finalGraph.nameMappings : [];
  const finalCount = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const diagnostic = brief.contextDiagnostics as any;
  diagnostic.graphNameMappingsAfterBudget = finalMappings.length;
  diagnostic.graphNameMappingsTrimmedByBudget = 0;
  diagnostic.strongNameMappingsAfterBudget = finalMappings.filter((mapping: any) =>
    ['confirmed', 'confirmed-memory', 'auto', 'run-canonical'].includes(String(mapping.sourceStatus))).length;
  diagnostic.strongNameMappingsTrimmedByBudget = 0;
  diagnostic.graphCharactersTrimmedByBudget = 0;
  diagnostic.graphEntitiesTrimmedByBudget = 0;
  diagnostic.graphRelationshipsTrimmedByBudget = 0;
  diagnostic.voiceEntitiesTrimmedByBudget = 0;
  diagnostic.voiceRelationshipsTrimmedByBudget = 0;
  diagnostic.characterVoicesTrimmedByBudget = 0;
  diagnostic.relationshipVoiceRulesTrimmedByBudget = 0;
  diagnostic.voiceAnchorsTrimmedByBudget = 0;
  diagnostic.acceptedExamplesAfterBudget = finalCount(finalVoice?.recentExamples);
  diagnostic.acceptedExamplesTrimmedByBudget = 0;
  diagnostic.dialogueParticipantsAfterBudget = finalCount(finalVoice?.dialogueParticipants);
  diagnostic.dialogueParticipantsTrimmedByBudget = 0;
  diagnostic.chapterSummariesTrimmedByBudget = 0;
  diagnostic.precedingSegmentsAfterBudget = brief.precedingSegments.length;
  diagnostic.precedingSegmentsTrimmedByBudget = 0;
  diagnostic.glossaryTermsAfterBudget = finalCount((brief.glossary as any)?.document_terms);
  diagnostic.glossaryTermsTrimmedByBudget = 0;
  diagnostic.contextDeltaCandidatesAvailable = Math.max(0, Number(brief.contextDeltaCount || 0));
  brief.contextChars = serialized.length;
  brief.contextHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
  logInfo('translation-brief', 'assembled · segments=' + brief.sourceSegmentIds.length +
    ' · chars=' + brief.contextChars +
    ' · graphMappings=' + (Array.isArray((brief.contextGraph as any)?.nameMappings) ? (brief.contextGraph as any).nameMappings.length : 0) +
    ' (strong=' + (Array.isArray((brief.contextGraph as any)?.nameMappings) ? (brief.contextGraph as any).nameMappings.filter((m: any) => ['confirmed','confirmed-memory','auto','run-canonical'].includes(String(m.sourceStatus))).length : 0) + ')' +
    ' · voiceEntities=' + (Array.isArray((brief.voiceContext as any)?.entities) ? (brief.voiceContext as any).entities.length : 0) +
    ' · voiceCharacters=' + (Array.isArray((brief.voiceContext as any)?.characterVoices) ? (brief.voiceContext as any).characterVoices.length : 0) +
    ' · preceding=' + brief.precedingSegments.length);
  return brief;
}

export function summarizeTranslationBrief(brief: TranslationBrief): Record<string, unknown> {
  const graph = brief.contextGraph as any;
  const voice = brief.voiceContext as any;
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const graphCharacterCount = count(graph?.characters);
  const graphEntityCount = count(graph?.entities);
  const graphRelationshipCount = count(graph?.relationships);
  const voiceCharacterCount = count(voice?.characterVoices);
  const nameMappingCount = count(graph?.nameMappings);
  return {
    policyVersion: brief.policyVersion,
    contextHash: brief.contextHash,
    contextChars: brief.contextChars,
    sourceRevisionId: brief.sourceRevisionId,
    promptRevisionId: brief.promptRevisionId,
    memoryRevisionId: brief.memoryRevisionId,
    sourceSegmentCount: brief.sourceSegmentIds.length,
    chapterPath: brief.chapterPath || null,
    precedingSegmentCount: brief.precedingSegments.length,
    knowledgeBoundaryOrdinal: graph?.knowledgeBoundaryOrdinal ?? null,
    graphCharacters: graphCharacterCount,
    graphEntities: graphEntityCount,
    graphRelationships: graphRelationshipCount,
    graphChapterSummaries: count(graph?.chapterSummaries),
    glossaryTerms: count((brief.glossary as any)?.document_terms),
    voiceEntities: count(voice?.entities),
    voiceRelationships: count(voice?.relationships),
    characterVoices: voiceCharacterCount,
    relationshipVoiceRules: count(voice?.relationshipVoiceRules),
    voiceAnchors: count(voice?.voiceAnchors),
    recentExamples: count(voice?.recentExamples),
    dialogueParticipants: count(voice?.dialogueParticipants),
    contextDiagnostics: brief.contextDiagnostics || {},
    // Compatibility fields consumed by the Agent Trajectory UI. Keep them aligned with the
    // detailed fields above so the UI doesn't silently display zero for populated context.
    entityCount: graphCharacterCount + graphEntityCount,
    relationshipCount: graphRelationshipCount,
    characterVoiceCount: voiceCharacterCount,
    nameMappingCount,
  };
}
