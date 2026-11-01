/**
 * 单段审校场景下的上下文构造。
 *
 * 从 translationAgent 抽出：当审校入口不经过整本书的 Run（例如逐段人工触发）时，
 * 需要就地拼出与 Run 同构的记忆、声音与图谱视图。
 */
import { canonicalTermPattern } from './canonicalTermProtection.ts';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from './voiceContext.ts';
/**
 * Standalone re-review requests originate in the extension and are not backed by an immutable
 * server-side Run/TranslationBrief. Treat all client-supplied memory as untrusted: only keep
 * evidence that can be verified against the exact current/preceding source text. In particular,
 * never pass book-wide summaries, recent examples, free-text descriptions, or voice profiles
 * synthesized from unseen future segments into this legacy endpoint.
 * 独立审校请求的客户端记忆不可信，仅保留可对照当前/前文原文验证的证据；不传递书级摘要等未来信息。
 */
export function buildStandaloneReviewMemory(input: Record<string, any>): Record<string, any> {
  const rawMemory = sanitizeProjectLiteraryMemory(input.memory);
  const segments = (Array.isArray(input.segments) ? input.segments : []).flatMap((item: any) => {
    if (!item || typeof item.id !== 'string' || typeof item.source !== 'string' || !item.source.trim()) return [];
    return [{ id: item.id, text: item.source, contextPath: typeof item.contextPath === 'string' ? item.contextPath : '' }];
  });
  const preceding = (Array.isArray(input.precedingSegments) ? input.precedingSegments : [])
    .slice(-6).flatMap((item: any) => {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
      return [{ id: item.id, text: item.text.slice(-900), contextPath: typeof item.contextPath === 'string' ? item.contextPath : '' }];
    });
  const visible = [...preceding, ...segments];
  const byId = new Map(visible.map((item) => [item.id, item.text]));
  const normalize = (value: unknown) => typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    : '';
  const quoteMatches = (segmentId: unknown, quote: unknown) => {
    const source = byId.get(typeof segmentId === 'string' ? segmentId : '');
    const expected = normalize(quote);
    return !!source && expected.length >= 2 && normalize(source).includes(expected);
  };
  const nameVisible = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    let pattern: RegExp;
    try { pattern = new RegExp(canonicalTermPattern(value), 'iu'); } catch { return false; }
    return visible.some((item) => pattern.test(item.text));
  };
  const currentTexts = segments.map((item) => item.text);
  const currentNameVisible = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    let pattern: RegExp;
    try { pattern = new RegExp(canonicalTermPattern(value), 'iu'); } catch { return false; }
    return currentTexts.some((text) => pattern.test(text));
  };
  const entities = rawMemory.entities.filter((entity: any) => {
    const names = [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])];
    if (entity.reviewStatus !== 'confirmed' ||
        !names.every((name: unknown) => nameVisible(name)) ||
        !names.some((name: unknown) => currentNameVisible(name))) return false;
    const refs = Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [];
    return !refs.length || refs.every((ref: any) => quoteMatches(ref.segmentId, ref.sourceQuote));
  }).map((entity: any) => ({
    source: entity.source, target: entity.target, kind: entity.kind,
    aliases: entity.aliases, reviewStatus: 'confirmed',
    confirmationSource: entity.confirmationSource || 'legacy-unknown',
    targetConfidence: entity.targetConfidence === 'corroborated' ? 'corroborated' : 'candidate',
  }));
  const entityNames = new Set(entities.flatMap((entity: any) =>
    [entity.source, ...(entity.aliases || [])].map((value: string) => normalize(value))));
  const relationships = rawMemory.relationships.filter((relation: any) => {
    if (relation.reviewStatus === 'rejected' || relation.reviewStatus !== 'confirmed' ||
        !entityNames.has(normalize(relation.subject)) ||
        !entityNames.has(normalize(relation.object))) return false;
    const refs = Array.isArray(relation.evidenceRefs) ? relation.evidenceRefs : [];
    return refs.length > 0 && refs.every((ref: any) =>
      quoteMatches(ref.segmentId, ref.sourceQuote) &&
      nameVisible(relation.subject) && nameVisible(relation.object));
  }).map((relation: any) => ({
    subject: relation.subject, predicate: relation.predicate, object: relation.object,
    reviewStatus: 'confirmed',
    confirmationSource: relation.confirmationSource || 'model-default',
    confidence: ['user-confirmed', 'user-modified'].includes(String(relation.confirmationSource || ''))
      ? 'user-confirmed' : 'candidate',
    evidenceRefs: relation.evidenceRefs,
  }));
  const characterVoices = rawMemory.characterVoices.filter((profile: any) => {
    const names = [profile.canonicalSourceName, ...(Array.isArray(profile.aliases) ? profile.aliases : [])];
    const evidence = Array.isArray(profile.evidence) ? profile.evidence : [];
    return profile.status === 'confirmed' && profile.evidenceTruncated !== true &&
      names.every((name: unknown) => nameVisible(name)) &&
      names.some((name: unknown) => currentNameVisible(name)) && evidence.length > 0 &&
      evidence.every((item: any) => quoteMatches(item.segmentId, item.sourceQuote));
  }).map((profile: any) => ({
    characterId: profile.characterId,
    canonicalSourceName: profile.canonicalSourceName,
    targetName: profile.targetName,
    aliases: profile.aliases,
    status: 'confirmed',
    voiceCore: profile.voiceCore,
    evidence: profile.evidence,
    contrastRules: [],
  }));
  const voiceIds = new Set(characterVoices.map((profile: any) => profile.characterId));
  const relationshipVoiceRules = rawMemory.relationshipVoiceRules.filter((rule: any) => {
    const ids = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds : [];
    return rule.status === 'confirmed' && voiceIds.has(rule.speakerId) && voiceIds.has(rule.addresseeId) &&
      ids.length > 0 && ids.every((id: unknown) => typeof id === 'string' && byId.has(id));
  }).map((rule: any) => ({
    speakerId: rule.speakerId,
    addresseeId: rule.addresseeId,
    baselineRegister: rule.baselineRegister,
    addressTerms: rule.addressTerms,
    directness: rule.directness,
    emotionalDistance: rule.emotionalDistance,
    sceneDependentShift: rule.sceneDependentShift,
    status: 'confirmed',
    evidenceSegmentIds: rule.evidenceSegmentIds,
  }));
  return sanitizeProjectLiteraryMemory({
    version: 2,
    entities,
    relationships,
    styleGuide: {},
    styleGuideStatus: 'candidate',
    chapterSummaries: [],
    recentExamples: [],
    characterVoices,
    relationshipVoiceRules,
    voiceAnchors: [],
    openQuestions: [],
  });
}

/**
 * 为独立审校请求构建项目声音上下文（先清洗记忆再构建）。
 * @param input 审校请求输入
 * @returns 声音上下文对象
 */
export function buildStandaloneReviewVoiceContext(input: Record<string, any>): Record<string, unknown> {
  const memory = buildStandaloneReviewMemory(input);
  const segments = (Array.isArray(input.segments) ? input.segments : []).flatMap((item: any) => {
    if (!item || typeof item.id !== 'string' || typeof item.source !== 'string' || !item.source.trim()) return [];
    return [{ id: item.id, text: item.source, contextPath: typeof item.contextPath === 'string' ? item.contextPath : '' }];
  });
  const preceding = (Array.isArray(input.precedingSegments) ? input.precedingSegments : [])
    .slice(-6).flatMap((item: any) => {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
      return [{ id: item.id, text: item.text.slice(-900), contextPath: typeof item.contextPath === 'string' ? item.contextPath : '' }];
    });
  return buildProjectVoiceContext(memory, segments, segments[0]?.contextPath || input.chapterTitle || '', preceding);
}

/** Build a bounded name-only Context Graph for legacy standalone Review requests.
 * Only explicit mappings visible in this request's source/preceding text are included; future
 * aliases from book memory are not serialized into the Reviewer prompt. 为独立审校请求构建仅含名称的有界 Context Graph，只包含当前/前文可见的显式映射。 */
export function buildStandaloneReviewContextGraph(input: Record<string, any>): Record<string, any> {
  // Do not accept a client-supplied Context Graph or TranslationBrief here. This endpoint has
  // no immutable server-side Run snapshot; reconstruct a name-only graph from the source-grounded
  // memory projection prepared by buildStandaloneReviewMemory instead.
  const nameMappings: Array<Record<string, any>> = [];
  const segments = Array.isArray(input.segments) ? input.segments : [];
  const preceding = Array.isArray(input.precedingSegments) ? input.precedingSegments : [];
  const sourceTexts = segments.map((item: any) => typeof item?.source === 'string' ? item.source : '');
  const visibleTexts = [...sourceTexts, ...preceding.map((item: any) => typeof item?.text === 'string' ? item.text : '')];
  const appearsIn = (name: string, texts: string[]) => {
    if (!name.trim()) return false;
    let pattern: RegExp;
    try { pattern = new RegExp(canonicalTermPattern(name), 'iu'); } catch { return false; }
    return texts.some((text) => pattern.test(text));
  };
  const memory = input.memory && typeof input.memory === 'object' ? input.memory as Record<string, any> : {};
  const entities = Array.isArray(memory.entities) ? memory.entities : [];
  for (const entity of entities) {
    if (entity?.reviewStatus !== 'confirmed' ||
        typeof entity.source !== 'string' || !entity.source.trim() ||
        typeof entity.target !== 'string' || !entity.target.trim()) continue;
    const aliases = Array.isArray(entity.aliases)
      ? entity.aliases.filter((alias: unknown): alias is string => typeof alias === 'string' && !!alias.trim())
      : [];
    // If an attached alias is not visible yet, its identity reveal may have contaminated the target.
    if (aliases.some((alias) => !appearsIn(alias, visibleTexts))) continue;
    if (!appearsIn(entity.source, sourceTexts) &&
        !aliases.some((alias) => appearsIn(alias, sourceTexts))) continue;
    // Legacy confirmed mappings predate provenance fields and must retain their prior protected behavior.
    const userDecidedMapping = !entity.confirmationSource ||
      ['user-confirmed', 'user-modified', 'legacy-unknown'].includes(String(entity.confirmationSource));
    nameMappings.push({
      source: entity.source.trim(),
      target: entity.target.trim(),
      aliases,
      kind: typeof entity.kind === 'string' ? entity.kind : 'other',
      evidenceBacked: true,
      // Standalone Review has no immutable run snapshot or verified target-surface ledger.
      // Only explicit user decisions may become protected mappings in this legacy path.
      sourceStatus: userDecidedMapping ? 'confirmed-memory' : 'candidate',
      confirmationSource: userDecidedMapping ? (entity.confirmationSource || 'user-confirmed') : 'model-default',
      targetConfidence: userDecidedMapping ? 'confirmed' : 'candidate',
    });
  }
  return {
    policyVersion: 'standalone-review-v1-source-grounded',
    nameMappings,
    constraints: ['Only user-confirmed mappings whose names and aliases are visible in the current or preceding source are included.'],
  };
}
