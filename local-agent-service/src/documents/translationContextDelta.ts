import { isWorthCanonicalEntityMapping, normalizeCanonicalEntityKind, splitCompoundCanonicalName, validateCanonicalTarget } from './canonicalEntityPolicy.ts';
/**
 * 初译阶段的上下文增量契约。
 *
 * 模型只提出有原文证据的候选；本模块负责验证输入片段范围、原文引文和译文落点，
 * 并以保守、可重复的规则合并候选。这里绝不把模型输出提升为人工确认事实。
 */

export type ContextEvidence = { segmentId: string; sourceQuote: string };
export type ContextEntityCandidate = {
  localId: string;
  canonicalSource: string;
  aliases: string[];
  kind: string;
  targetProposal: string;
  evidence: ContextEvidence[];
  reason?: string;
  bookSpecificMeaning?: boolean;
};
export type ContextEntityMention = {
  segmentId: string;
  sourceQuote: string;
  entityRef: string;
  targetSurface: string;
};
export type ContextRelationshipCandidate = {
  subjectSource: string;
  predicate: string;
  objectSource: string;
  evidence: ContextEvidence[];
};
export type ValidatedTranslationContextDelta = {
  entityCandidates: ContextEntityCandidate[];
  entityMentions: ContextEntityMention[];
  relationshipDeltas: ContextRelationshipCandidate[];
  openQuestions: Array<{ question: string; evidence: ContextEvidence[] }>;
  conflicts: Array<{ topic: string; details: string; evidence: ContextEvidence[] }>;
};
export type ContextDeltaDiagnostics = {
  candidateCount: number;
  acceptedEntityCandidates: number;
  rejectedEntityCandidates: number;
  droppedLowValueEntityCandidates: number;
  rejectedCompoundEntityCandidates: number;
  rejectedTargetQualityCandidates: number;
  acceptedEntityMentions: number;
  rejectedEntityMentions: number;
  acceptedRelationships: number;
  rejectedRelationships: number;
  acceptedOpenQuestions: number;
  rejectedOpenQuestions: number;
  acceptedConflicts: number;
  rejectedConflicts: number;
};

/**
 * 返回空的已验证 context_delta，用于初始化与合并基底。
 */
export function emptyTranslationContextDelta(): ValidatedTranslationContextDelta {
  return { entityCandidates: [], entityMentions: [], relationshipDeltas: [], openQuestions: [], conflicts: [] };
}

/**
 * 清洗并截断文本：移除控制字符、折叠空白，按 limit 截断；非字符串返回空。
 */
function text(value: unknown, limit = 240): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

/**
 * NFKC 归一化 + 小写 + 空白折叠，用于宽松匹配与去重键。
 */
function normalized(value: unknown): string {
  return text(value, 2000).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 判断 needle（归一化后）是否包含于 haystack（归一化后）。
 */
function includesNormalized(haystack: unknown, needle: unknown): boolean {
  const source = normalized(haystack);
  const quote = normalized(needle);
  return !!source && !!quote && source.includes(quote);
}

/**
 * 校验并提取原文证据：segmentId 必须存在、quote 长度达标且能在对应原文中找到；
 * 去重，最多 4 条。
 */
function sourceEvidence(raw: unknown, sourceById: Map<string, string>, minimumLength = 8): ContextEvidence[] {
  if (!Array.isArray(raw)) return [];
  const output: ContextEvidence[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const segmentId = text(row.segment_id ?? row.segmentId, 160);
    const sourceQuote = text(row.quote ?? row.source_quote ?? row.sourceQuote, 240);
    const source = sourceById.get(segmentId);
    if (!source || sourceQuote.length < minimumLength || !includesNormalized(source, sourceQuote)) continue;
    const key = segmentId + '\u0000' + normalized(sourceQuote);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ segmentId, sourceQuote });
  }
  return output;
}

/**
 * 判断 name 是否作为独立词/短语出现在 source 中；拉丁名称按单词边界匹配，CJK 直接子串匹配。
 */
function hasName(source: string, name: string): boolean {
  const value = normalized(name);
  if (!value) return false;
  // 人名候选必须有明确证据。既要避免把短拉丁名当成普通单词里的子串，
  // 又要保留 CJK 的自然匹配方式。
  if (/^[a-z0-9 .'-]+$/i.test(value)) {
    const paddedSource = ' ' + normalized(source).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const paddedName = ' ' + value.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    return paddedName.trim().length >= 3 && paddedSource.includes(paddedName);
  }
  return normalized(source).includes(value);
}

/**
 * 校验过程中反复用到的只读输入，与两个会被逐段填充的输出容器。
 * 拆成五段校验后共用这一份上下文，避免每段各带一串参数。
 */
type DeltaValidationContext = {
  delta: ValidatedTranslationContextDelta;
  diagnostics: ContextDeltaDiagnostics;
  segments: Array<{ id: string; text: string; contextPath?: string }>;
  sourceById: Map<string, string>;
  translations: Map<string, string>;
  targetLang: string;
  idPrefix: string;
};

/** 单个候选经字段清洗后的形态；null 表示基础证据已经不足，直接判为无效候选。 */
type ParsedEntityCandidate = {
  originalLocalId: string;
  canonicalSource: string;
  targetProposal: string;
  aliasesRaw: unknown[];
  kind: string;
  evidence: ContextEvidence[];
  reason: string;
  bookSpecificMeaning: boolean;
};

type ExpandedEntity = { source: string; target: string; evidence: ContextEvidence[]; localId: string };

/**
 * 独立校验初译返回的 context_delta，不让无效记忆元数据污染有效译文。
 * 每条声明必须引用当前输入 segments 中的原文 quote；target_surface 还必须能在对应译文中找到。
 * 输出是经过服务端证据校验的模型默认采纳建议；模型不能伪装成用户确认，置信度与证据范围单独记录。
 */
export function validateTranslationContextDelta(
  raw: unknown,
  segments: Array<{ id: string; text: string }>,
  translations: Map<string, string>,
  idPrefix = '',
  knownEntities: unknown[] = [],
  targetLang = 'zh',
): { delta: ValidatedTranslationContextDelta; diagnostics: ContextDeltaDiagnostics } {
  const context: DeltaValidationContext = {
    delta: emptyTranslationContextDelta(),
    diagnostics: {
      candidateCount: 0,
      acceptedEntityCandidates: 0, rejectedEntityCandidates: 0,
      droppedLowValueEntityCandidates: 0, rejectedCompoundEntityCandidates: 0, rejectedTargetQualityCandidates: 0,
      acceptedEntityMentions: 0, rejectedEntityMentions: 0,
      acceptedRelationships: 0, rejectedRelationships: 0,
      acceptedOpenQuestions: 0, rejectedOpenQuestions: 0,
      acceptedConflicts: 0, rejectedConflicts: 0,
    },
    segments,
    sourceById: new Map(segments.map((segment) => [segment.id, segment.text])),
    translations,
    targetLang,
    idPrefix,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { delta: context.delta, diagnostics: context.diagnostics };
  }
  const value = raw as Record<string, unknown>;

  const candidatesRaw = Array.isArray(value.entity_candidates) ? value.entity_candidates.slice(0, 32) : [];
  context.diagnostics.candidateCount = candidatesRaw.length;
  const localIds = validateEntityCandidates(context, candidatesRaw);
  validateEntityMentions(context, value.entity_mentions, localIds, collectKnownNames(knownEntities));
  validateRelationshipDeltas(context, value.relationship_deltas);
  validateOpenQuestions(context, value.open_questions);
  validateConflicts(context, value.conflicts);
  return { delta: context.delta, diagnostics: context.diagnostics };
}

/**
 * 实体候选：先做字段与证据的最低门槛，再拆复合名（如「张氏兄弟」拆成多人），
 * 每个拆出的成员都要单独通过译名质量与「是否值得建映射」两关。
 * 返回「模型原始 localId → 服务端 localId」映射，供后续 entity_mentions 引用绑定。
 */
function validateEntityCandidates(
  context: DeltaValidationContext,
  candidatesRaw: unknown[],
): Map<string, string> {
  const { delta, diagnostics, segments, sourceById, targetLang, idPrefix } = context;
  const localIds = new Map<string, string>();
  const seenLocalIds = new Set<string>();

  for (const candidateRaw of candidatesRaw) {
    const parsed = parseEntityCandidate(candidateRaw, sourceById);
    if (!parsed || seenLocalIds.has(parsed.originalLocalId)) {
      diagnostics.rejectedEntityCandidates++;
      continue;
    }
    // 复合源名会按各组成部分展开成候选；拆出的部分必须与等长的目标列表一一配对。
    // 长度对不上属于畸形映射，而不是一组名字。
    const expansion = expandEntityCandidate(parsed, idPrefix);
    if (!expansion) {
      diagnostics.rejectedEntityCandidates++;
      diagnostics.rejectedCompoundEntityCandidates++;
      continue;
    }
    // 原来的本地 ID 指向整条列表，拆开之后就有歧义了。
    // 不要悄悄把它的实体提及绑到第一个元素上；提及要么用规范名指明拆出的某个源，
    // 要么被常规证据检查拒掉。
    if (expansion.wholeLocalId) localIds.set(parsed.originalLocalId, expansion.wholeLocalId);
    seenLocalIds.add(parsed.originalLocalId);

    for (const item of expansion.items) {
      if (delta.entityCandidates.length >= 120) {
        diagnostics.rejectedEntityCandidates++;
        continue;
      }
      const targetQuality = validateCanonicalTarget({
        source: item.source, target: item.target, targetLang, kind: parsed.kind,
      });
      if (!targetQuality.valid) {
        diagnostics.rejectedEntityCandidates++;
        diagnostics.rejectedTargetQualityCandidates++;
        continue;
      }
      if (parsed.kind !== 'person' && !isWorthCanonicalEntityMapping({
        source: item.source, kind: parsed.kind,
        ...countNameOccurrences(segments, item.source),
        significance: parsed.reason,
        explicitBookSpecificMeaning: parsed.bookSpecificMeaning,
      })) {
        diagnostics.droppedLowValueEntityCandidates++;
        continue;
      }
      const aliases = Array.from(new Set(parsed.aliasesRaw.map((alias) => text(alias, 80)).filter((alias) =>
        alias && !splitCompoundCanonicalName(alias) &&
        normalized(alias) !== normalized(item.source) &&
        segments.some((segment) => hasName(segment.text, alias)) &&
        item.evidence.some((entry) => hasName(entry.sourceQuote, alias)
      )))).slice(0, 8);
      const localId = item.localId;
      if (seenLocalIds.has(localId) && localId !== parsed.originalLocalId) {
        // 拆出来的候选会拿到稳定且唯一的后缀；同时防住模型恶意输出重复 ID。
        diagnostics.rejectedEntityCandidates++;
        continue;
      }
      seenLocalIds.add(localId);
      delta.entityCandidates.push({
        localId, canonicalSource: item.source, aliases, kind: parsed.kind,
        targetProposal: targetQuality.normalizedTarget, evidence: item.evidence,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        ...(parsed.bookSpecificMeaning ? { bookSpecificMeaning: true } : {}),
      });
      diagnostics.acceptedEntityCandidates++;
    }
  }
  return localIds;
}

/** 读取候选字段并做首轮门槛：来源名必须在自己的证据引文中出现，否则视为凭空提出。 */
function parseEntityCandidate(
  candidateRaw: unknown,
  sourceById: Map<string, string>,
): ParsedEntityCandidate | null {
  if (!candidateRaw || typeof candidateRaw !== 'object' || Array.isArray(candidateRaw)) return null;
  const candidate = candidateRaw as Record<string, unknown>;
  const originalLocalId = text(candidate.local_id ?? candidate.localId, 64);
  const canonicalSource = text(candidate.canonical_source ?? candidate.canonicalSource, 120);
  const targetProposal = text(candidate.target_proposal ?? candidate.targetProposal, 120);
  const aliasesRaw = Array.isArray(candidate.aliases) ? candidate.aliases.slice(0, 12) : [];
  const kind = normalizeCanonicalEntityKind(candidate.kind);
  const evidence = sourceEvidence(candidate.evidence, sourceById);
  const matchingEvidence = evidence.some((entry) => hasName(entry.sourceQuote, canonicalSource));
  if (!originalLocalId || !canonicalSource || !targetProposal || !evidence.length || !matchingEvidence) return null;
  return {
    originalLocalId,
    canonicalSource,
    targetProposal,
    aliasesRaw,
    kind,
    evidence,
    reason: text(candidate.reason, 180),
    bookSpecificMeaning: candidate.book_specific_meaning === true || candidate.bookSpecificMeaning === true,
  };
}

/**
 * 复合名拆分。返回 null 表示这份映射无法安全展开：目标不是等长的列表、成员过多，
 * 或者某个成员缺少自己的证据——这几种情况都不允许退化成「整体当作一个实体」。
 */
function expandEntityCandidate(
  parsed: ParsedEntityCandidate,
  idPrefix: string,
): { items: ExpandedEntity[]; wholeLocalId?: string } | null {
  const sourceCompound = splitCompoundCanonicalName(parsed.canonicalSource);
  const targetCompound = splitCompoundCanonicalName(parsed.targetProposal);
  if (!sourceCompound) {
    // 单个源名绝不能带一串目标名。
    if (targetCompound) return null;
    const localId = (idPrefix + parsed.originalLocalId).slice(0, 64);
    return {
      items: [{ source: parsed.canonicalSource, target: parsed.targetProposal, evidence: parsed.evidence, localId }],
      wholeLocalId: localId,
    };
  }
  if (!targetCompound || sourceCompound.parts.length !== targetCompound.parts.length) return null;
  if (sourceCompound.parts.length > 12) return null;
  const pairs = sourceCompound.parts.map((sourcePart, index) => ({
    source: sourcePart,
    target: targetCompound.parts[index] || '',
    evidence: parsed.evidence.filter((entry) => hasName(entry.sourceQuote, sourcePart)),
  }));
  if (pairs.some((pair) => !pair.target || !pair.evidence.length)) return null;
  return {
    items: pairs.map((pair, index) => ({
      ...pair,
      localId: (idPrefix + parsed.originalLocalId).slice(0, 56) + ':part' + String(index + 1),
    })),
  };
}

/** 名称在全书出现次数与跨章数：低价值实体（一次性地名、泛称）靠这两个量被筛掉。 */
function countNameOccurrences(
  segments: DeltaValidationContext['segments'],
  name: string,
): { mentions: number; chapterCount: number } {
  const hits = segments.filter((segment) => hasName(segment.text, name));
  return {
    mentions: hits.length,
    chapterCount: new Set(hits
      .map((segment) => String((segment as any).contextPath || '')).filter(Boolean)).size,
  };
}

/** 已确认的已知实体名，用来放行「本地候选已存在」的提及引用。 */
function collectKnownNames(knownEntities: unknown[]): Set<string> {
  const knownNames = new Set<string>();
  for (const entity of knownEntities.slice(0, 160)) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
    const row = entity as Record<string, unknown>;
    for (const name of [row.source, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      if (text(name, 120)) knownNames.add(normalized(name));
    }
  }
  return knownNames;
}

/**
 * 实体提及：引用必须指向本批已采纳的候选或已知实体，原文引文与译文落点都要能对上。
 * 这两处「对不上」正是模型最常见的编造方式，因此缺一即拒。
 */
function validateEntityMentions(
  context: DeltaValidationContext,
  mentionsRaw: unknown,
  localIds: Map<string, string>,
  knownNames: Set<string>,
): void {
  const { delta, diagnostics, sourceById, translations } = context;
  const validRefs = new Set(delta.entityCandidates.flatMap((candidate) =>
    [candidate.localId, candidate.canonicalSource, ...candidate.aliases].map(normalized)));
  for (const mentionRaw of (Array.isArray(mentionsRaw) ? mentionsRaw : []).slice(0, 128)) {
    if (!mentionRaw || typeof mentionRaw !== 'object' || Array.isArray(mentionRaw)) {
      diagnostics.rejectedEntityMentions++;
      continue;
    }
    const mention = mentionRaw as Record<string, unknown>;
    const segmentId = text(mention.segment_id ?? mention.segmentId, 160);
    const sourceQuote = text(mention.source_quote ?? mention.sourceQuote, 240);
    const source = sourceById.get(segmentId);
    const targetSurface = text(mention.target_surface ?? mention.targetSurface, 120);
    const rawRef = text(mention.entity_ref ?? mention.entityRef, 120);
    const entityRef = localIds.get(rawRef) || rawRef;
    const translated = translations.get(segmentId) || '';
    const knownRef = validRefs.has(normalized(entityRef)) || knownNames.has(normalized(rawRef));
    if (!source || !sourceQuote || !includesNormalized(source, sourceQuote) || !targetSurface ||
        !includesNormalized(translated, targetSurface) || !knownRef) {
      diagnostics.rejectedEntityMentions++;
      continue;
    }
    delta.entityMentions.push({ segmentId, sourceQuote, entityRef, targetSurface });
    diagnostics.acceptedEntityMentions++;
  }
}

/** 关系：主客体都必须在同一条证据引文中同时出现，否则只是两条独立提及的拼接。 */
function validateRelationshipDeltas(context: DeltaValidationContext, relationshipRaw: unknown): void {
  const { delta, diagnostics, sourceById } = context;
  for (const relationRaw of (Array.isArray(relationshipRaw) ? relationshipRaw : []).slice(0, 32)) {
    if (!relationRaw || typeof relationRaw !== 'object' || Array.isArray(relationRaw)) {
      diagnostics.rejectedRelationships++;
      continue;
    }
    const relation = relationRaw as Record<string, unknown>;
    const subjectSource = text(relation.subject_source ?? relation.subjectSource, 120);
    const predicate = text(relation.predicate, 100);
    const objectSource = text(relation.object_source ?? relation.objectSource, 120);
    const evidence = sourceEvidence(relation.evidence, sourceById);
    const hasGroundedRelation = evidence.some((entry) =>
      hasName(sourceById.get(entry.segmentId) || '', subjectSource) &&
      hasName(sourceById.get(entry.segmentId) || '', objectSource));
    if (!subjectSource || !predicate || !objectSource || normalized(subjectSource) === normalized(objectSource) ||
        !evidence.length || !hasGroundedRelation) {
      diagnostics.rejectedRelationships++;
      continue;
    }
    delta.relationshipDeltas.push({ subjectSource, predicate, objectSource, evidence });
    diagnostics.acceptedRelationships++;
  }
}

/** 悬念：问题本身不要求证据内容，但必须能指回本批原文，否则无法在后续章节复核。 */
function validateOpenQuestions(context: DeltaValidationContext, questionsRaw: unknown): void {
  const { delta, diagnostics, sourceById } = context;
  for (const questionRaw of (Array.isArray(questionsRaw) ? questionsRaw : []).slice(0, 20)) {
    if (!questionRaw || typeof questionRaw !== 'object' || Array.isArray(questionRaw)) {
      diagnostics.rejectedOpenQuestions++;
      continue;
    }
    const question = questionRaw as Record<string, unknown>;
    const cleanQuestion = text(question.question, 200);
    const evidence = sourceEvidence(question.evidence, sourceById);
    if (!cleanQuestion || !evidence.length) {
      diagnostics.rejectedOpenQuestions++;
      continue;
    }
    delta.openQuestions.push({ question: cleanQuestion, evidence });
    diagnostics.acceptedOpenQuestions++;
  }
}

/** 冲突：主题与细节都必须给出，且证据要落在本批原文上。 */
function validateConflicts(context: DeltaValidationContext, conflictsRaw: unknown): void {
  const { delta, diagnostics, sourceById } = context;
  for (const conflictRaw of (Array.isArray(conflictsRaw) ? conflictsRaw : []).slice(0, 20)) {
    if (!conflictRaw || typeof conflictRaw !== 'object' || Array.isArray(conflictRaw)) {
      diagnostics.rejectedConflicts++;
      continue;
    }
    const conflict = conflictRaw as Record<string, unknown>;
    const topic = text(conflict.topic, 120);
    const details = text(conflict.details, 200);
    const evidence = sourceEvidence(conflict.evidence, sourceById);
    if (!topic || !details || !evidence.length) {
      diagnostics.rejectedConflicts++;
      continue;
    }
    delta.conflicts.push({ topic, details, evidence });
    diagnostics.acceptedConflicts++;
  }
}

/**
 * 合并同一源批次多个模型尝试的 context_delta。
 * 重试生成的 local entity ID 不稳定，因此合并时要规范化实体引用；同一实体的冲突目标保留为冲突诊断，
 * 不能用最后一次响应无声覆盖前一次证据。
 */
export function combineTranslationContextDeltas(
  deltas: ValidatedTranslationContextDelta[],
): ValidatedTranslationContextDelta {
  const combined = emptyTranslationContextDelta();
  const entityKeyIndex = new Map<string, number>();
  for (const delta of deltas) {
    // 重试时的实体 ID 在不同模型尝试之间并不稳定。合并之前先把提及归一成
    // 规范源名，这样校验过的目标译文面才能真正佐证到同一个实体。
    const sourceNameByRef = new Map<string, string>();
    for (const candidate of delta.entityCandidates) {
      for (const name of [candidate.localId, candidate.canonicalSource, ...candidate.aliases]) {
        const key = normalized(name);
        if (key && !sourceNameByRef.has(key)) sourceNameByRef.set(key, candidate.canonicalSource);
      }
    }
    for (const candidate of delta.entityCandidates) {
      const key = normalized(candidate.canonicalSource) + '\u0000' + normalized(candidate.targetProposal);
      const index = entityKeyIndex.get(key);
      if (index === undefined) {
        entityKeyIndex.set(key, combined.entityCandidates.length);
        combined.entityCandidates.push({ ...candidate, aliases: [...candidate.aliases], evidence: [...candidate.evidence] });
      } else {
        const prior = combined.entityCandidates[index]!;
        prior.aliases = Array.from(new Set([...prior.aliases, ...candidate.aliases])).slice(0, 8);
        prior.bookSpecificMeaning = prior.bookSpecificMeaning === true || candidate.bookSpecificMeaning === true;
        prior.evidence = [...prior.evidence, ...candidate.evidence].filter((item, i, all) =>
          all.findIndex((other) => other.segmentId === item.segmentId && normalized(other.sourceQuote) === normalized(item.sourceQuote)) === i).slice(0, 4);
      }
    }
    combined.entityMentions.push(...delta.entityMentions.map((mention) => ({
      ...mention,
      entityRef: sourceNameByRef.get(normalized(mention.entityRef)) || mention.entityRef,
    })));
    combined.relationshipDeltas.push(...delta.relationshipDeltas);
    combined.openQuestions.push(...delta.openQuestions);
    combined.conflicts.push(...delta.conflicts);
  }
  combined.entityCandidates = combined.entityCandidates.slice(0, 32);
  combined.entityMentions = combined.entityMentions.filter((item, index, all) =>
    all.findIndex((other) => other.segmentId === item.segmentId && normalized(other.sourceQuote) === normalized(item.sourceQuote) &&
      normalized(other.entityRef) === normalized(item.entityRef) && normalized(other.targetSurface) === normalized(item.targetSurface)) === index).slice(0, 128);
  combined.relationshipDeltas = combined.relationshipDeltas.slice(0, 32);
  combined.openQuestions = combined.openQuestions.filter((item, index, all) =>
    all.findIndex((other) => normalized(other.question) === normalized(item.question)) === index).slice(0, 20);
  combined.conflicts = combined.conflicts.slice(0, 20);
  return combined;
}

/**
 * 归一化实体 kind：将人物别名/称谓/头衔等呈现层形式统一为 'person'，避免绕过冲突保护。
 */
function normalizedEntityKind(value: unknown): string {
  const kind = text(value, 40).toLocaleLowerCase();
  // 模型可能把对某人的文字指称标成绰号、别称或头衔，
  // 而 Context Graph 和项目记忆把同一个实体归为 person。
  // 别名匹配之前先归一这些「呈现形式」，
  // 否则它们能绕过冲突保护，再生成一条互相竞争的第二映射。
  if (['character', 'person', 'character_epithet', 'nickname', 'role', 'title'].includes(kind)) return 'person';
  if (['place', 'object', 'organization', 'group'].includes(kind)) return kind;
  return 'other';
}

function sameKind(a: unknown, b: unknown): boolean {
  const left = normalizedEntityKind(a); const right = normalizedEntityKind(b);
  return left === right || left === 'other' || right === 'other';
}

/** 一次合并的累计计数，直接作为调用方的持久化摘要。 */
type MergeSummary = {
  addedEntities: number;
  mergedEntities: number;
  entityTargetConflicts: number;
  addedRelationships: number;
  addedOpenQuestions: number;
};

/** 合并过程中的工作副本与计数。 */
type MergeContext = { memory: Record<string, any>; summary: MergeSummary };

/** 归一化名称：实体与关系的跨批次比对一律经此，避免标点/大小写差异造成重复条目。 */
function mergeName(value: unknown): string {
  return normalized(value).replace(/[._'’\-]+/g, ' ').trim();
}

/**
 * 按源顺序把已验证的 context_delta 合并为后续批次可见的记忆投影。
 * 有来源证据的新增事实默认以 model-default 生效；目标译名的置信度仍取决于实际译文证据，
 * 不会因为默认采纳就升级为强制术语。用户确认/修改/拒绝优先，冲突不自动覆盖。调用方应只传入当前
 * wave 结束后可见的增量，避免并发批次观察到彼此尚未提交的记忆。
 */
export function mergeTranslationContextDeltasIntoMemory(
  memoryInput: unknown,
  deltas: ValidatedTranslationContextDelta[],
): { memory: Record<string, any>; summary: Record<string, number>; changed: boolean } {
  const context = createMergeContext(memoryInput);
  const before = JSON.stringify(context.memory);
  for (const delta of deltas) {
    for (const candidate of delta.entityCandidates) applyEntityCandidate(context, candidate, delta);
    for (const relation of delta.relationshipDeltas) applyRelationshipCandidate(context, relation);
    for (const question of delta.openQuestions) {
      addOpenQuestion(context, question.question +
        (question.evidence[0]?.sourceQuote ? '（原文：“' + question.evidence[0].sourceQuote.slice(0, 80) + '”）' : ''));
    }
    for (const conflict of delta.conflicts) {
      addOpenQuestion(context, '上下文冲突待核对：' + conflict.topic + '；' + conflict.details +
        (conflict.evidence[0]?.sourceQuote ? '（原文：“' + conflict.evidence[0].sourceQuote.slice(0, 80) + '”）' : ''));
    }
  }
  return { memory: context.memory, summary: context.summary, changed: before !== JSON.stringify(context.memory) };
}

/** 深拷贝一份记忆并补齐四个必填数组；非法输入退化为空记忆而不是抛出。 */
function createMergeContext(memoryInput: unknown): MergeContext {
  let memory: Record<string, any>;
  try { memory = JSON.parse(JSON.stringify(memoryInput && typeof memoryInput === 'object' ? memoryInput : {})); }
  catch { memory = {}; }
  if (!Array.isArray(memory.entities)) memory.entities = [];
  if (!Array.isArray(memory.relationships)) memory.relationships = [];
  if (!Array.isArray(memory.openQuestions)) memory.openQuestions = [];
  if (!Array.isArray(memory.rejectedItems)) memory.rejectedItems = [];
  return {
    memory,
    summary: { addedEntities: 0, mergedEntities: 0, entityTargetConflicts: 0, addedRelationships: 0, addedOpenQuestions: 0 },
  };
}

/** 与本次候选目标译名一致、且逐段去重后的译文证据。 */
function targetEvidenceFor(candidate: ContextEntityCandidate, delta: ValidatedTranslationContextDelta) {
  const names = new Set([candidate.localId, candidate.canonicalSource, ...candidate.aliases]
    .map(mergeName).filter(Boolean));
  const seenSegments = new Set<string>();
  return delta.entityMentions.flatMap((mention) => {
    if (!names.has(mergeName(mention.entityRef)) ||
        mergeName(mention.targetSurface) !== mergeName(candidate.targetProposal) ||
        seenSegments.has(mention.segmentId)) return [];
    seenSegments.add(mention.segmentId);
    return [{
      segmentId: mention.segmentId,
      sourceQuote: mention.sourceQuote,
      targetSurface: mention.targetSurface,
    }];
  }).slice(0, 8);
}

/** 两个以上独立片段给出同一译名才算互相印证，否则仍是候选。 */
function targetConfidence(refs: Array<{ segmentId: string }>): string {
  return new Set(refs.map((item) => item.segmentId)).size >= 2 ? 'corroborated' : 'candidate';
}

function isRejectedEntity(context: MergeContext, candidate: ContextEntityCandidate): boolean {
  const candidateNames = new Set([candidate.canonicalSource, ...candidate.aliases].map(mergeName).filter(Boolean));
  return context.memory.rejectedItems.some((item: any) => item?.type === 'entity' &&
    sameKind(item.kind, candidate.kind) &&
    [item.source, ...(Array.isArray(item.aliases) ? item.aliases : [])]
      .some((name: unknown) => candidateNames.has(mergeName(name))));
}

function isRejectedRelationship(context: MergeContext, relation: ContextRelationshipCandidate): boolean {
  const key = [relation.subjectSource, relation.predicate, relation.objectSource].map(mergeName).join('\u0000');
  return context.memory.rejectedItems.some((item: any) => item?.type === 'relationship' &&
    [item.subject, item.predicate, item.object].map(mergeName).join('\u0000') === key);
}

/** 追加一条待核对问题；重复问题不重复入列，列表只保留最近 40 条。 */
function addOpenQuestion(context: MergeContext, value: string): void {
  const question = text(value, 200);
  const { memory } = context;
  if (!question || memory.openQuestions.some((item: unknown) => normalized(item) === normalized(question))) return;
  memory.openQuestions.push(question);
  memory.openQuestions = memory.openQuestions.slice(-40);
  context.summary.addedOpenQuestions++;
}

/** 证据引用合并：按 segmentId + 引文去重，保留调用方原有的先后顺序。 */
function mergeEvidenceRefs(existing: unknown, incoming: ContextEvidence[]): Array<{ segmentId: string; sourceQuote: string }> {
  return [
    ...(Array.isArray(existing) ? existing : []),
    ...incoming.map((item) => ({ segmentId: item.segmentId, sourceQuote: item.sourceQuote })),
  ].filter((item, index, all) => all.findIndex((other) =>
    other.segmentId === item.segmentId && normalized(other.sourceQuote) === normalized(item.sourceQuote)) === index);
}

/**
 * 实体候选合并：用户删除是持久决定，用户拒绝的实体不会被新观察复活；
 * 同名不同译名只登记冲突，不让后到的候选覆盖先前的。
 */
function applyEntityCandidate(
  context: MergeContext,
  candidate: ContextEntityCandidate,
  delta: ValidatedTranslationContextDelta,
): void {
  const { memory, summary } = context;
  // 用户删除是持久的，即使可见的 LiteraryMemory 行已经被移除。
  if (isRejectedEntity(context, candidate)) return;
  const names = new Set([candidate.canonicalSource, ...candidate.aliases].map(mergeName).filter(Boolean));
  const newTargetEvidence = targetEvidenceFor(candidate, delta);
  const matching = memory.entities
    .map((entity: any, index: number) => ({ entity, index }))
    .filter(({ entity }: any) => sameKind(entity.kind, candidate.kind) &&
      [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
        .some((name: unknown) => names.has(mergeName(name))));
  if (!matching.length) {
    memory.entities.push({
      source: candidate.canonicalSource,
      target: candidate.targetProposal,
      kind: candidate.kind,
      aliases: candidate.aliases.slice(0, 8),
      evidence: candidate.evidence[0]?.sourceQuote || '',
      evidenceRefs: candidate.evidence.slice(0, 4).map((item) => ({
        segmentId: item.segmentId, sourceQuote: item.sourceQuote,
      })),
      targetEvidenceRefs: newTargetEvidence,
      targetConfidence: targetConfidence(newTargetEvidence),
      reviewStatus: 'confirmed',
      confirmationSource: 'model-default',
    });
    memory.entities = memory.entities.slice(0, 120);
    summary.addedEntities++;
    return;
  }
  const prior = matching[0]!.entity;
  // 已落盘的用户拒绝是持久决定；后续模型观察不能把它复活。
  if (prior.reviewStatus === 'rejected') return;
  if (mergeName(prior.target) !== mergeName(candidate.targetProposal)) {
    summary.entityTargetConflicts++;
    addOpenQuestion(context, '候选译名存在冲突：“' + candidate.canonicalSource + '”已有“' +
      text(prior.target, 80) + '”，新批次提出“' + candidate.targetProposal + '”；需人工核对原文证据。');
    return;
  }
  mergeEntityEvidence(prior, candidate, newTargetEvidence);
  summary.mergedEntities++;
}

/**
 * 命中已有实体：只追加别名与证据，不覆盖用户已确认的译名与来源出处。
 * 译文证据按片段去重后保留最近 8 条，置信度随证据数重算。
 */
function mergeEntityEvidence(
  prior: Record<string, any>,
  candidate: ContextEntityCandidate,
  newTargetEvidence: Array<{ segmentId: string; sourceQuote: string; targetSurface: string }>,
): void {
  const existingAliases = Array.isArray(prior.aliases) ? prior.aliases : [];
  const aliases = Array.from(new Set([...existingAliases, ...candidate.aliases, candidate.canonicalSource]
    .filter((name) => mergeName(name) && mergeName(name) !== mergeName(prior.source))));
  prior.aliases = aliases.slice(0, 8);

  const priorTargetEvidence = Array.isArray(prior.targetEvidenceRefs) ? prior.targetEvidenceRefs : [];
  const targetEvidenceBySegment = new Map<string, any>();
  for (const ref of [...priorTargetEvidence, ...newTargetEvidence]) {
    if (ref && typeof ref.segmentId === 'string' && ref.segmentId.trim()) {
      targetEvidenceBySegment.set(ref.segmentId, ref);
    }
  }
  prior.targetEvidenceRefs = Array.from(targetEvidenceBySegment.values()).slice(-8);
  prior.targetConfidence = targetConfidence(prior.targetEvidenceRefs);
  if (prior.reviewStatus !== 'confirmed') {
    prior.reviewStatus = 'confirmed';
    prior.confirmationSource = 'model-default';
  }
  if (!prior.evidence && candidate.evidence[0]?.sourceQuote) prior.evidence = candidate.evidence[0].sourceQuote;
  // 为建议实体保留定位到源文位置的证据，但不要让后续模型观察
  // 覆盖用户确认过的旧映射的出处。
  if (prior.reviewStatus !== 'confirmed' || (Array.isArray(prior.evidenceRefs) && prior.evidenceRefs.length > 0)) {
    const evidenceRefs = mergeEvidenceRefs(prior.evidenceRefs, candidate.evidence);
    if (evidenceRefs.length) prior.evidenceRefs = evidenceRefs.slice(0, 8);
  }
}

/** 关系候选合并：同一「主体-谓词-客体」只累加证据，不重复建条目。 */
function applyRelationshipCandidate(context: MergeContext, relation: ContextRelationshipCandidate): void {
  const { memory, summary } = context;
  // 被删的关系可能压根没有图谱边可拒；保留它的记忆墓碑。
  if (isRejectedRelationship(context, relation)) return;
  const key = [relation.subjectSource, relation.predicate, relation.objectSource].map(mergeName).join('\u0000');
  const prior = memory.relationships.find((item: any) =>
    [item.subject, item.predicate, item.object].map(mergeName).join('\u0000') === key);
  if (!prior) {
    memory.relationships.push({
      subject: relation.subjectSource, predicate: relation.predicate, object: relation.objectSource,
      evidence: relation.evidence[0]?.sourceQuote || '',
      evidenceRefs: relation.evidence.slice(0, 4).map((item) => ({
        segmentId: item.segmentId, sourceQuote: item.sourceQuote,
      })),
      reviewStatus: 'confirmed',
      confirmationSource: 'model-default',
    });
    memory.relationships = memory.relationships.slice(0, 160);
    summary.addedRelationships++;
    return;
  }
  if (prior.reviewStatus === 'rejected') return;
  const evidenceRefs = mergeEvidenceRefs(prior.evidenceRefs, relation.evidence);
  if (evidenceRefs.length) prior.evidenceRefs = evidenceRefs.slice(0, 8);
  if (prior.reviewStatus !== 'confirmed') {
    prior.reviewStatus = 'confirmed';
    prior.confirmationSource = 'model-default';
  }
}
