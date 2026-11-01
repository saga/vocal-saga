/**
 * 单段审校场景下的上下文构造。
 *
 * 从 translationAgent 抽出：当审校入口不经过整本书的 Run（例如逐段人工触发）时，
 * 需要就地拼出与 Run 同构的记忆、声音与图谱视图。
 */
import { canonicalTermPattern } from './canonicalTermProtection.ts';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from './voiceContext.ts';
/**
 * 独立审校请求由扩展发起，背后没有服务端不可变的 Run/TranslationBrief 作依据。
 * 客户端带来的记忆一律当不可信：只保留能对照当前或前文确切原文验证的证据。
 * 尤其不要往这个旧接口里塞全书级摘要、近期示例、自由文本描述，
 * 或从尚未读到的后续片段合成出来的声音档案。
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

/** 为旧的独立审校请求构建只含名称的有界 Context Graph：只收录本次请求源文或前文里可见的显式映射，书级记忆里的未来别名不会写进 Reviewer 提示词。 */
export function buildStandaloneReviewContextGraph(input: Record<string, any>): Record<string, any> {
  // 这里不接受客户端传来的 Context Graph 或 TranslationBrief。这个接口没有
  // 服务端不可变的 Run 快照；应当改用 buildStandaloneReviewMemory 准备好的、
  // 有源文依据的记忆投影，重建一个只含名称的图谱。
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
    // 附属别名如果还没露出，它的身份揭示可能已经污染了目标译名。
    if (aliases.some((alias) => !appearsIn(alias, visibleTexts))) continue;
    if (!appearsIn(entity.source, sourceTexts) &&
        !aliases.some((alias) => appearsIn(alias, sourceTexts))) continue;
    // 旧版的已确认映射早于「出处」字段出现，必须保持它们原有的受保护行为。
    const userDecidedMapping = !entity.confirmationSource ||
      ['user-confirmed', 'user-modified', 'legacy-unknown'].includes(String(entity.confirmationSource));
    nameMappings.push({
      source: entity.source.trim(),
      target: entity.target.trim(),
      aliases,
      kind: typeof entity.kind === 'string' ? entity.kind : 'other',
      evidenceBacked: true,
      // 独立审校没有不可变的 Run 快照，也没有校验过的目标译文面台账。
      // 在这个旧路径上，只有明确的用户决定才能成为受保护的映射。
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
