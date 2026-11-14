/**
 * 文学记忆的清洗器：把不可信的输入投影成有界、可序列化的规范结构。
 *
 * 从 voiceContext 抽出：这里只负责结构/字段清洗；原文证据是否位于当前批次之前，
 * 仍由 TranslationBrief 的时间过滤负责——不能把「通过 sanitizer」当成「事实已验证」。
 */
import { hasCompoundCanonicalSyntax, isWorthCanonicalEntityMapping, normalizeCanonicalEntityKind, validateCanonicalTarget } from './canonicalEntityPolicy.ts';
import {
  confirmationSource,
  dedupeProjectEntities,
  list,
  MAX_ANCHORS,
  MAX_MEMORY_BYTES,
  MAX_RELATION_RULES,
  normalizeEntityName,
  numericConfidence,
  safeHash,
  status,
  text,
} from './literaryNormalizers.ts';

/** 空记忆的规范形状：调用方无需再判 undefined。 */
function emptyLiteraryMemory(): Record<string, any> {
  return {
    version: 2, entities: [], relationships: [], styleGuide: {}, styleGuideStatus: 'candidate',
    chapterSummaries: [], recentExamples: [], characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  };
}

/**
 * 将保存的文学记忆归一化为有界、可序列化的内部结构。
 * 这里只负责结构/字段清洗；原文证据是否位于当前批次之前，仍由 TranslationBrief 的时间过滤负责，
 * 不能把“通过 sanitizer”当成“事实已验证”或“可在所有章节使用”。
 */
export function sanitizeProjectLiteraryMemory(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyLiteraryMemory();
  // 刻意先只投影已知字段，再来量体积。调用方可能带着额外属性，
  // 比如整份源文或 Context Graph 负载；这些都不属于 LiteraryMemory，
  // 未知字段也不能让一份本来合法的结构化记忆存不下去。
  const raw = input as Record<string, any>;
  const rejectedItems = normalizeRejectedItems(raw);
  const characterVoices = normalizeCharacterVoices(raw);
  const validCharacterIds = new Set(characterVoices.map((item: any) => item.characterId));
  const style = normalizeStyleGuide(raw);

  const memory: Record<string, any> = {
    version: 2,
    entities: normalizeMemoryEntities(raw),
    relationships: normalizeRelationships(raw),
    styleGuide: style.styleGuide,
    styleGuideStatus: style.styleGuideStatus,
    ...(style.styleGuideConfirmationSource ? { styleGuideConfirmationSource: style.styleGuideConfirmationSource } : {}),
    styleGuideOrigin: style.styleGuideOrigin,
    ...(style.styleGuideAnalysisVersion ? { styleGuideAnalysisVersion: style.styleGuideAnalysisVersion } : {}),
    ...(style.styleGuideSourceRevisionId ? { styleGuideSourceRevisionId: style.styleGuideSourceRevisionId } : {}),
    styleGuideAutoDisabled: style.styleGuideAutoDisabled,
    ...(style.chineseEditorialProfile ? { chineseEditorialProfile: style.chineseEditorialProfile } : {}),
    chapterSummaries: normalizeChapterSummaries(raw),
    recentExamples: normalizeRecentExamples(raw),
    characterVoices,
    relationshipVoiceRules: normalizeRelationshipVoiceRules(raw, validCharacterIds),
    voiceAnchors: normalizeVoiceAnchors(raw, validCharacterIds),
    openQuestions: list(raw.openQuestions, 40, 200),
    rejectedItems,
  };
  applyRejectionTombstones(memory, rejectedItems);
  enforceMemoryByteLimit(memory);
  return memory;
}

/**
 * 用户删除墓碑。显式的实体/关系删除即使在可见投影里已被移除也必须保留，
 * 否则后续批次的模型增量会把它们悄悄重建回来。
 */
function normalizeRejectedItems(raw: Record<string, any>): Array<Record<string, any>> {
  return Array.isArray(raw.rejectedItems) ? raw.rejectedItems.slice(-2000).flatMap((item: any): any[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    if (item.type === 'entity') {
      const source = text(item.source, 120);
      if (!source) return [];
      return [{
        type: 'entity',
        source,
        kind: normalizeCanonicalEntityKind(item.kind),
        aliases: list(item.aliases, 8, 80),
      }];
    }
    if (item.type === 'relationship') {
      const subject = text(item.subject, 120);
      const predicate = text(item.predicate, 100);
      const object = text(item.object, 120);
      return subject && predicate && object ? [{ type: 'relationship', subject, predicate, object }] : [];
    }
    return [];
  }) : [];
}

/** 关系条目：主体/谓词/客体缺一不可，证据引用逐条清洗。 */
function normalizeRelationships(raw: Record<string, any>): Array<Record<string, any>> {
  if (!Array.isArray(raw.relationships)) return [];
  return raw.relationships.slice(0, 160).flatMap((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const subject = text(item.subject, 120); const predicate = text(item.predicate, 100); const object = text(item.object, 120);
    if (!subject || !predicate || !object) return [];
    const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.slice(0, 8).flatMap((ref: any) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
      const segmentId = text(ref.segmentId, 160);
      const sourceQuote = text(ref.sourceQuote, 240);
      return segmentId && sourceQuote ? [{ segmentId, sourceQuote }] : [];
    }) : [];
    return [{
      subject, predicate, object, evidence: text(item.evidence, 180),
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      reviewStatus: item.reviewStatus === 'rejected' ? 'rejected' : 'confirmed',
      confirmationSource: item.reviewStatus === 'rejected' ? undefined : item.reviewStatus === 'confirmed'
         ? (item.confirmationSource ? confirmationSource(item.confirmationSource, true) : 'legacy-unknown') : 'model-default',
    }];
  });
}

/**
 * 文风指南及其来源元数据。缺失维度不固化成空串；只有来自图谱或用户编辑的指南才算 confirmed，
 * 自动禁用时一律降回 candidate。
 */
function normalizeStyleGuide(raw: Record<string, any>): Record<string, any> {
  const style = raw.styleGuide && typeof raw.styleGuide === 'object' && !Array.isArray(raw.styleGuide) ? raw.styleGuide : {};
  // 不把缺失维度固化成空串；允许值与 Context Graph 一致的 1000 字上限。
  const styleGuide = {
    ...(text(style.narrativeVoice, 1000) ? { narrativeVoice: text(style.narrativeVoice, 1000) } : {}),
    ...(text(style.register, 1000) ? { register: text(style.register, 1000) } : {}),
    ...(text(style.rhythm, 1000) ? { rhythm: text(style.rhythm, 1000) } : {}),
    ...(text(style.dialogue, 1000) ? { dialogue: text(style.dialogue, 1000) } : {}),
    ...(text(style.diction, 1000) ? { diction: text(style.diction, 1000) } : {}),
    ...(list(style.rules, 24, 240).length ? { rules: list(style.rules, 24, 240) } : {}),
    ...(list(style.avoid, 16, 240).length ? { avoid: list(style.avoid, 16, 240) } : {}),
  };
  const rawStyleGuideOrigin = raw.styleGuideOrigin;
  const styleGuideStatus = raw.styleGuideAutoDisabled === true ? 'candidate'
    : Object.keys(styleGuide).length && ['context-graph', 'user-edited', 'user-confirmed'].includes(String(rawStyleGuideOrigin))
      ? 'confirmed' : 'candidate';
  const styleGuideConfirmationSource = rawStyleGuideOrigin === 'user-edited' ? 'user-modified'
    : rawStyleGuideOrigin === 'user-confirmed' ? 'user-confirmed'
      : raw.styleGuideStatus === 'confirmed'
        ? (raw.styleGuideConfirmationSource ? confirmationSource(raw.styleGuideConfirmationSource, true) : 'legacy-unknown')
        : styleGuideStatus === 'confirmed' ? 'model-default' : undefined;
  const styleGuideOrigin = ['context-graph', 'user-edited', 'user-confirmed', 'legacy-unknown'].includes(String(rawStyleGuideOrigin))
    ? String(rawStyleGuideOrigin)
    : styleGuideConfirmationSource === 'user-confirmed' ? 'user-confirmed' : 'legacy-unknown';
  return {
    styleGuide,
    styleGuideStatus,
    styleGuideConfirmationSource,
    styleGuideOrigin,
    styleGuideAnalysisVersion: text(raw.styleGuideAnalysisVersion, 120),
    styleGuideSourceRevisionId: text(raw.styleGuideSourceRevisionId, 200),
    styleGuideAutoDisabled: raw.styleGuideAutoDisabled === true,
    chineseEditorialProfile: normalizeChineseEditorialProfile(raw),
  };
}

/** 关系语言规则：说话双方必须都是已采纳的人物画像，否则规则无从应用。 */
function normalizeRelationshipVoiceRules(raw: Record<string, any>, validCharacterIds: Set<string>): Array<Record<string, any>> {
  if (!Array.isArray(raw.relationshipVoiceRules)) return [];
  return raw.relationshipVoiceRules.slice(0, MAX_RELATION_RULES).flatMap((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const speakerId = text(item.speakerId, 100); const addresseeId = text(item.addresseeId, 100);
    const evidenceSegmentIds = list(item.evidenceSegmentIds, 8, 160);
    if (!validCharacterIds.has(speakerId) || !validCharacterIds.has(addresseeId)) return [];
    const ruleStatus = item.status === 'rejected' ? 'rejected' : 'confirmed';
    return [{
      speakerId, addresseeId, status: ruleStatus,
      ...(ruleStatus === 'confirmed' ? { confirmationSource: item.status === 'confirmed'
        ? (item.confirmationSource ? confirmationSource(item.confirmationSource, true) : 'legacy-unknown') : 'model-default' } : {}),
      baselineRegister: text(item.baselineRegister, 180), addressTerms: list(item.addressTerms, 8, 100),
      directness: text(item.directness, 180), emotionalDistance: text(item.emotionalDistance, 180),
      sceneDependentShift: text(item.sceneDependentShift, 180), evidenceSegmentIds,
    }];
  });
}

/** 声音锚点：归属证据缺失或置信度非数值的旧锚点只能保留为 approved 记录，但不构成强约束。 */
function normalizeVoiceAnchors(raw: Record<string, any>, validCharacterIds: Set<string>): Array<Record<string, any>> {
  if (!Array.isArray(raw.voiceAnchors)) return [];
  return raw.voiceAnchors.slice(0, MAX_ANCHORS).flatMap((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const speakerId = text(item.speakerId, 100); const segmentId = text(item.segmentId, 160);
    const source = text(item.source, 400); const target = text(item.target, 500);
    if (!validCharacterIds.has(speakerId) || !segmentId || !source || !target) return [];
    const attributionEvidence = text(item.attributionEvidence, 240);
    const attributionConfidence = Number(item.attributionConfidence);
    const claimedStatus = item.status === 'rejected' ? 'rejected' : 'approved';
    // 老版本或缺少归属证据的锚点只能回到候选，不会因为 SQLite 中保存了 approved 就自动成为强约束。
    const groundedAttribution = !!attributionEvidence && Number.isFinite(attributionConfidence);
    return [{
      anchorId: text(item.anchorId, 120) || 'anchor_' + safeHash(segmentId + source).slice(0, 12),
      speakerId, addresseeId: text(item.addresseeId, 100), source, target, chapter: text(item.chapter, 120), segmentId,
      status: claimedStatus,
      ...(claimedStatus === 'approved' ? { confirmationSource: item.status === 'approved'
        ? (item.confirmationSource ? confirmationSource(item.confirmationSource, true) : 'legacy-unknown') : 'model-default' } : {}),
      approvedBy: status(item.approvedBy, ['user','reviewer','manual-edit','model-default'], 'model-default'),
      ...(attributionEvidence ? { attributionEvidence } : {}),
      ...(Number.isFinite(attributionConfidence) ? { attributionConfidence: Math.max(0, Math.min(1, attributionConfidence)) } : {}),
      tags: list(item.tags, 8, 80),
    }];
  });
}

/** 清洗章节摘要：只保留有章节名与摘要正文的条目，并按上限截断。 */
function normalizeChapterSummaries(raw: Record<string, any>): Array<{ chapter: string; summary: string }> {
  if (!Array.isArray(raw.chapterSummaries)) return [];
  return raw.chapterSummaries.flatMap((item: any) => {
    const chapter = text(item?.chapter, 120); const summary = text(item?.summary, 5000);
    return chapter && summary ? [{ chapter, summary }] : [];
  });
}

/** 清洗近期示例：逐条校验字段类型与长度，非法条目直接丢弃。 */
function normalizeRecentExamples(raw: Record<string, any>): Array<Record<string, any>> {
  if (!Array.isArray(raw.recentExamples)) return [];
  return raw.recentExamples.flatMap((item: any) => {
    const source = text(item?.source, 260);
    const target = text(item?.target, 320);
    const chapter = text(item?.chapter, 120);
    const segmentId = text(item?.segmentId, 160);
    const origin = status(item?.origin, ['manual', 'agent', 'imported'], 'imported');
    return source && target ? [{
      source, target,
      ...(chapter ? { chapter } : {}),
      ...(segmentId ? { segmentId } : {}),
      origin,
    }] : [];
  });
}

/** 墓碑生效：被用户删除的实体/关系从可见投影里移除，避免「删了又回来」。 */
function applyRejectionTombstones(memory: Record<string, any>, rejectedItems: Array<Record<string, any>>): void {
  const rejectedEntityNames = rejectedItems.filter((item: any) => item.type === 'entity');
  memory.entities = memory.entities.filter((entity: any) => !rejectedEntityNames.some((rejected: any) => {
    const kindMatches = rejected.kind === entity.kind || rejected.kind === 'other' || entity.kind === 'other';
    const names = new Set([rejected.source, ...(Array.isArray(rejected.aliases) ? rejected.aliases : [])].map(normalizeEntityName));
    return kindMatches && [entity.source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
      .some((name: unknown) => names.has(normalizeEntityName(String(name || ''))));
  }));
  const rejectedRelationshipKeys = new Set(rejectedItems.filter((item: any) => item.type === 'relationship')
    .map((item: any) => [item.subject, item.predicate, item.object].map(normalizeEntityName).join('|')));
  memory.relationships = memory.relationships.filter((relation: any) =>
    !rejectedRelationshipKeys.has([relation.subject, relation.predicate, relation.object].map(normalizeEntityName).join('|')));
}

/**
 * 实体候选：逐条清洗译名质量与证据，再按来源名去重。
 * 每条都会带上 canonicalMappingDisposition，供上层判断能否作为强映射注入。
 */
function normalizeMemoryEntities(raw: Record<string, any>): Array<Record<string, any>> {
  const entities = dedupeProjectEntities(Array.isArray(raw.entities) ? raw.entities.slice(0, 120).flatMap((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = text(item.source, 120); const target = text(item.target, 120);
    if (!source || !target) return [];
    const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.slice(0, 8).flatMap((ref: any) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
      const segmentId = text(ref.segmentId, 160);
      const sourceQuote = text(ref.sourceQuote, 240);
      return segmentId && sourceQuote ? [{ segmentId, sourceQuote }] : [];
    }) : [];
    const aliases = list(item.aliases, 8, 80);
    const kind = normalizeCanonicalEntityKind(item.kind);
    const explicitlyRejected = item.reviewStatus === 'rejected';
    const confirmation = explicitlyRejected ? undefined : item.reviewStatus === 'confirmed'
      ? (item.confirmationSource ? confirmationSource(item.confirmationSource, true) : 'legacy-unknown') : 'model-default';
    const userConfirmed = item.reviewStatus === 'confirmed' && ['user-confirmed', 'user-modified'].includes(String(confirmation || ''));
    const targetEvidenceRefs = Array.isArray(item.targetEvidenceRefs) ? item.targetEvidenceRefs.slice(-8).flatMap((ref: any) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
      const segmentId = text(ref.segmentId, 160);
      const sourceQuote = text(ref.sourceQuote, 240);
      const targetSurface = text(ref.targetSurface, 120);
      return segmentId && sourceQuote && targetSurface ? [{ segmentId, sourceQuote, targetSurface }] : [];
    }) : [];
    const targetConfidence = item.targetConfidence === 'corroborated' &&
      new Set(targetEvidenceRefs.map((ref: any) => ref.segmentId)).size >= 2 ? 'corroborated' : 'candidate';
    const targetQuality = validateCanonicalTarget({ source, target, targetLang: 'zh', kind });
    const bookSpecificMeaning = item.bookSpecificMeaning === true;
    const canonicalMappingDisposition = hasCompoundCanonicalSyntax(source) ? 'compound-name'
      : !targetQuality.valid ? 'invalid-target'
      : !userConfirmed && !isWorthCanonicalEntityMapping({
          source, kind, mentions: Math.max(evidenceRefs.length, targetEvidenceRefs.length),
          chapterCount: targetConfidence === 'corroborated' ? 2 : 0,
          significance: text(item.description || item.evidence, 200),
          explicitBookSpecificMeaning: bookSpecificMeaning,
        }) ? 'low-value' : 'eligible';
    return [{
      source, target, kind, aliases, bookSpecificMeaning,
      description: text(item.description, 200), evidence: text(item.evidence, 180),
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      ...(targetEvidenceRefs.length ? { targetEvidenceRefs } : {}),
      targetConfidence,
      canonicalMappingDisposition,
      reviewStatus: explicitlyRejected ? 'rejected' : 'confirmed',
      ...(confirmation ? { confirmationSource: confirmation } : {}),
    }];
  }) : []);
  return entities;
}

/**
 * 人物声音画像：证据、声线核心、对比规则一并清洗。
 * 老版本把证据截到 8 条却不记录是否还有更多，这种记录被判为 evidenceTruncated，
 * 时间检索时按「不完整」处理，宁可不注入也不注入可能失真的画像。
 */
function normalizeCharacterVoices(raw: Record<string, any>): Array<Record<string, any>> {
  const characterVoices = Array.isArray(raw.characterVoices) ? raw.characterVoices.flatMap((item: any) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const canonicalSourceName = text(item.canonicalSourceName || item.source || item.name, 120);
    const characterId = text(item.characterId, 100);
    // 旧的数值默认值（Context Graph 的 0.55、文学回退的 0.4）没有出处，不能当分数用。
    const profileConfidence = numericConfidence(item.confidence);
    const profileConfidenceSource = profileConfidence !== null && item.confidenceSource === 'model_self_report'
      ? 'model_self_report' as const
      : undefined;
    const voice = item.voiceCore && typeof item.voiceCore === 'object' && !Array.isArray(item.voiceCore) ? item.voiceCore : {};
    const rawEvidence = Array.isArray(item.evidence) ? item.evidence : [];
    // 旧的持久记录把证据截到八行，却没记下是否还有更多。
    // 这类记录有歧义：它们的 voiceCore 可能概括了早已不在证据列表里的后文对白。
    // 把旧档案标记为不完整，好让时间检索失败关闭。
    const evidenceTruncated = item.evidenceTruncated === true ||
      (item.evidencePolicyVersion !== 'character-evidence-v2-complete' && rawEvidence.length >= 8);
    const evidence = rawEvidence.slice(-12).flatMap((ev: any) => {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return [];
      const segmentId = text(ev.segmentId, 160); const sourceQuote = text(ev.sourceQuote, 240);
      const observation = text(ev.observation, 240); const dimension = text(ev.dimension, 32);
      if (!segmentId || !sourceQuote || !observation || !['register','syntax_rhythm','lexicon','discourse','stance','humor_irony','disfluency','relationship','role_traits'].includes(dimension)) return [];
      const evidenceConfidence = numericConfidence(ev.confidence);
      const confidenceSource = evidenceConfidence !== null && ev.confidenceSource === 'model_self_report'
        ? 'model_self_report' as const
        : undefined;
      return [{
        segmentId, sourceQuote, observation, dimension,
        confidence: confidenceSource ? evidenceConfidence : null,
        ...(confidenceSource ? { confidenceSource } : {}),
      }];
    });
    if (!canonicalSourceName || !characterId || (!evidence.length && !text(voice.register, 180) && !list(voice.syntaxRhythm, 6).length && !list(voice.lexicalPreferences, 6).length)) return [];
    const profileStatus = item.status === 'rejected' ? 'rejected' : 'confirmed';
    return [{
      characterId, canonicalSourceName, targetName: text(item.targetName, 120), aliases: list(item.aliases, 12, 80),
      ...(text(item.role, 360) ? { role: text(item.role, 360) } : {}),
      ...(list(item.traits, 10, 160).length ? { traits: list(item.traits, 10, 160) } : {}),
      status: profileStatus,
      ...(profileStatus === 'confirmed' ? { confirmationSource: item.status === 'confirmed'
        ? (item.confirmationSource ? confirmationSource(item.confirmationSource, true) : 'legacy-unknown') : 'model-default' } : {}),
      useForTranslation: item.useForTranslation !== false && profileStatus !== 'rejected',
      confidence: profileConfidenceSource ? profileConfidence : null,
      ...(profileConfidenceSource ? { confidenceSource: profileConfidenceSource } : {}),
      voiceCore: {
        register: text(voice.register, 180), syntaxRhythm: list(voice.syntaxRhythm, 6), lexicalPreferences: list(voice.lexicalPreferences, 6),
        discourseHabits: list(voice.discourseHabits, 6), stanceModality: list(voice.stanceModality, 6),
        humorIrony: text(voice.humorIrony, 180), disfluency: text(voice.disfluency, 180), avoid: list(voice.avoid, 8),
      },
      contrastRules: Array.isArray(item.contrastRules) ? item.contrastRules.slice(0, 6).flatMap((rule: any) => {
        const otherCharacterId = text(rule?.otherCharacterId, 100); const difference = text(rule?.difference, 240);
        const evidenceSegmentIds = list(rule?.evidenceSegmentIds, 8, 160);
        return otherCharacterId && difference && evidenceSegmentIds.length ? [{ otherCharacterId, difference, evidenceSegmentIds }] : [];
      }) : [],
      evidence,
      evidencePolicyVersion: 'character-evidence-v2-complete',
      evidenceTruncated,
      openQuestions: list(item.openQuestions, 8),
    }];
  }) : [];
  return characterVoices;
}

/**
 * 中文单语文学编辑画像：当前生效画像 + 待采纳更新。
 * 旧版本的待采纳更新在这里被自动提升为生效画像，并递增 profileVersion。
 */
function normalizeChineseEditorialProfile(raw: Record<string, any>): Record<string, any> | null {
  const rawEditorial = raw.chineseEditorialProfile && typeof raw.chineseEditorialProfile === 'object' &&
    !Array.isArray(raw.chineseEditorialProfile) ? raw.chineseEditorialProfile : null;
  const editorialProfileInput = rawEditorial?.profile && typeof rawEditorial.profile === 'object' &&
    !Array.isArray(rawEditorial.profile) ? rawEditorial.profile : {};
  const editorialEvidence = Array.isArray(rawEditorial?.evidenceRefs)
    ? rawEditorial.evidenceRefs.slice(0, 24).flatMap((item: any) => {
        const segmentId = text(item?.segmentId, 160);
        const targetExcerpt = text(item?.targetExcerpt, 240);
        const observation = text(item?.observation, 240);
        const aspect = ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'consistency'].includes(String(item?.aspect))
          ? String(item.aspect) : '';
        return segmentId && targetExcerpt.length >= 4 && observation && aspect
          ? [{ segmentId, targetExcerpt, observation, aspect }] : [];
      })
    : [];
  const normalizeEditorialCandidate = (candidate: any) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const candidateProfile = candidate.profile && typeof candidate.profile === 'object' &&
      !Array.isArray(candidate.profile) ? candidate.profile : {};
    const candidateEvidence = Array.isArray(candidate.evidenceRefs)
      ? candidate.evidenceRefs.slice(0, 24).flatMap((item: any) => {
          const segmentId = text(item?.segmentId, 160);
          const targetExcerpt = text(item?.targetExcerpt, 240);
          const observation = text(item?.observation, 240);
          const aspect = ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'consistency'].includes(String(item?.aspect))
            ? String(item.aspect) : '';
          return segmentId && targetExcerpt.length >= 4 && observation && aspect
            ? [{ segmentId, targetExcerpt, observation, aspect }] : [];
        })
      : [];
    return {
      version: 1,
      status: 'candidate',
      sourceRevisionId: text(candidate.sourceRevisionId, 200),
      analysisVersion: text(candidate.analysisVersion, 120),
      sampleFingerprint: text(candidate.sampleFingerprint, 128),
      sampleCount: Math.max(0, Math.min(1000, Number(candidate.sampleCount) || 0)),
      chapterCount: Math.max(0, Math.min(500, Number(candidate.chapterCount) || 0)),
      generatedAt: text(candidate.generatedAt, 64),
      basedOnFingerprint: text(candidate.basedOnFingerprint, 128) || null,
      generatedFromMemoryRevisionId: text(candidate.generatedFromMemoryRevisionId, 200) || null,
      profile: {
        narrativeVoice: text(candidateProfile.narrativeVoice, 1000),
        register: text(candidateProfile.register, 1000),
        rhythm: text(candidateProfile.rhythm, 1000),
        dialogue: text(candidateProfile.dialogue, 1000),
        diction: text(candidateProfile.diction, 1000),
        rules: list(candidateProfile.rules, 16, 240),
        avoid: list(candidateProfile.avoid, 12, 240),
      },
      evidenceRefs: candidateEvidence,
    };
  };
  const editorialStatus = rawEditorial?.status === 'rejected' ? 'rejected' : 'confirmed';
  const pendingEditorialUpdate = normalizeEditorialCandidate(rawEditorial?.pendingUpdate);
  // 把旧的 pending 更新自动迁移成活动档案。新的更新由生成器直接采纳；
  // 这条路径只为处理旧版本留下的快照。
  const chineseEditorialProfile = rawEditorial ? {
    version: 1,
    profileVersion: Math.max(1, Math.min(1000, Number(rawEditorial.profileVersion) || 1)) + (pendingEditorialUpdate && editorialStatus !== 'rejected' ? 1 : 0),
    status: editorialStatus,
    ...(editorialStatus === 'confirmed' ? { confirmationSource: rawEditorial.status === 'confirmed'
      ? rawEditorial.confirmationSource || 'legacy-unknown' : 'model-default' } : {}),
    sourceRevisionId: pendingEditorialUpdate?.sourceRevisionId || text(rawEditorial.sourceRevisionId, 200),
    analysisVersion: pendingEditorialUpdate?.analysisVersion || text(rawEditorial.analysisVersion, 120),
    sampleFingerprint: pendingEditorialUpdate?.sampleFingerprint || text(rawEditorial.sampleFingerprint, 128),
    sampleCount: pendingEditorialUpdate?.sampleCount ?? Math.max(0, Math.min(1000, Number(rawEditorial.sampleCount) || 0)),
    chapterCount: pendingEditorialUpdate?.chapterCount ?? Math.max(0, Math.min(500, Number(rawEditorial.chapterCount) || 0)),
    generatedAt: pendingEditorialUpdate?.generatedAt || text(rawEditorial.generatedAt, 64),
    ...(pendingEditorialUpdate ? { previousFingerprint: text(rawEditorial.sampleFingerprint, 128), acceptedUpdateAt: new Date().toISOString() } : {}),
    profile: pendingEditorialUpdate?.profile || {
      narrativeVoice: text(editorialProfileInput.narrativeVoice, 1000),
      register: text(editorialProfileInput.register, 1000),
      rhythm: text(editorialProfileInput.rhythm, 1000),
      dialogue: text(editorialProfileInput.dialogue, 1000),
      diction: text(editorialProfileInput.diction, 1000),
      rules: list(editorialProfileInput.rules, 16, 240),
      avoid: list(editorialProfileInput.avoid, 12, 240),
    },
    evidenceRefs: pendingEditorialUpdate?.evidenceRefs || editorialEvidence,
  } : null;
  return chineseEditorialProfile;
}

/**
 * 持久化体积上限：按「低价值历史 → 证据 → 规则 → 画像 → 实体」的顺序确定性裁剪，
 * 而不是切序列化 JSON（那会破坏记忆 schema）。全部字段耗尽仍超限则报 413。
 */
function enforceMemoryByteLimit(memory: Record<string, any>): void {
  // 上限作用于最终持久化的规范 DTO，而非上面已丢弃的不可信输入字段。
  // 确定性地裁剪低价值证据；绝不直接切片序列化 JSON（可能破坏记忆 schema）。
  // 上限作用在真正要落盘的规范 DTO 上，而不是上面已丢弃的不可信输入字段。
  // 按确定性顺序裁掉价值更低的证据；
  // 绝不要对序列化后的 JSON 直接切片（那会把记忆结构切坏）。
  const serializedBytes = () => Buffer.byteLength(JSON.stringify(memory), 'utf8');
  while (serializedBytes() > MAX_MEMORY_BYTES) {
    // 分批裁剪低价值的历史数组。原先每处理一条就重新序列化一次几 MB 的记忆，
    // 最坏情况下的归一化是平方复杂度，能把文档启动卡住。
    if (memory.recentExamples.length) {
      memory.recentExamples.splice(0, Math.max(1, Math.ceil(memory.recentExamples.length / 2)));
      continue;
    }
    if (memory.chapterSummaries.length) {
      memory.chapterSummaries.splice(0, Math.max(1, Math.ceil(memory.chapterSummaries.length / 2)));
      continue;
    }
    if (memory.voiceAnchors.length) {
      memory.voiceAnchors.splice(0, Math.max(1, Math.ceil(memory.voiceAnchors.length / 2)));
      continue;
    }

    // 保留档案与名字，逐步削减源文摘录。每个档案至少留一条最近证据，
    // 并用轮转方式裁剪，避免因输入顺序让靠前的角色被削光引文、
    // 而靠后的档案还没轮到。
    const bytesToFree = serializedBytes() - MAX_MEMORY_BYTES + 16 * 1024;
    let freedBytes = 0;
    const profilesWithEvidence = memory.characterVoices.filter((profile: any) => profile.evidence.length > 1);
    if (profilesWithEvidence.length) {
      while (freedBytes < bytesToFree) {
        let removedInRound = false;
        for (const profile of profilesWithEvidence) {
          if (profile.evidence.length <= 1 || freedBytes >= bytesToFree) continue;
          const removed = profile.evidence.shift();
          if (removed !== undefined) {
            freedBytes += Buffer.byteLength(JSON.stringify(removed), 'utf8') + 8;
            profile.evidenceTruncated = true;
            removedInRound = true;
          }
        }
        if (!removedInRound) break;
      }
      if (freedBytes > 0) continue;
    }
    if (memory.relationshipVoiceRules.length) {
      memory.relationshipVoiceRules.pop();
      continue;
    }
    if (memory.characterVoices.length) {
      memory.characterVoices.pop();
      continue;
    }
    if (memory.entities.length) {
      memory.entities.pop();
      continue;
    }
    if (memory.relationships.length) {
      memory.relationships.pop();
      continue;
    }
    if (memory.openQuestions.length) {
      memory.openQuestions.pop();
      continue;
    }
    // 所有集合字段都削到头了；有界的标量/文风字段本应让这里到不了，
    // 但真到了就要精确报错，而不是把超限数据存下去。
    throw Object.assign(new Error('结构化文学记忆本身超过 5 MiB 上限，已达到可裁剪边界'), { status: 413 });
  }
}
