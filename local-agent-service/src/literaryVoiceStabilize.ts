/**
 * 人物声音画像的稳定化：模型每一章都可能换一套 ID 与写法，这里负责锁定身份、校验证据、
 * 合并且不覆盖已确认画像。
 *
 * 从 literary 抽出：稳定性规则（ID 锁定、证据必达、确认优先）是这个流程的全部内容，
 * 与「怎么发请求」「怎么建 Prompt」无关。
 */
import { sanitizeProjectLiteraryMemory } from './documents/voiceContext.ts';
import { confidenceScore, normalizeEvidenceText, stableCharacterId } from './literaryShared.ts';

/**
 * 将模型返回的文学分析结果稳定化为可持久化的人物声音画像、关系语言规则、声音锚点与开放问题。
 * 职责：锁定稳定 characterId、校验原文证据、合并已有确认画像、过滤无效锚点与关系规则。
 * 边界：无原文证据支撑的人物画像会被丢弃；已确认画像的核心字段不会被新分析静默覆盖，冲突写入 openQuestions。
 * @param memoryInput 现有项目文学记忆（unknown）。
 * @param parsed 模型返回的分析 JSON。
 * @param segments 本章原文片段（含 id/text），用于证据校验。
 * @returns 稳定化后的人物声音画像、关系语言规则、声音锚点与开放问题。
 */
export function stabilizeVoiceAnalysis(
  memoryInput: unknown,
  parsed: Record<string, any>,
  segments: Array<{ id: string; text: string }>,
): { characterVoices: any[]; relationshipVoiceRules: any[]; voiceAnchors: any[]; openQuestions: string[] } {
  const existing = sanitizeProjectLiteraryMemory(memoryInput);
  // 建立片段 ID → 原文映射，后续所有证据引文都必须在对应片段中可定位。
  const validSegments = new Map(segments.map((segment) => [segment.id, segment.text]));
  const isQuoteValid = createQuoteValidator(validSegments);
  const oldToStable = new Map<string, string>();
  const profiles = lockCharacterProfiles(parsed, existing, isQuoteValid, oldToStable);
  const characterIds = new Set(profiles.map((profile) => profile.characterId));
  const relationshipVoiceRules = buildRelationshipVoiceRules(parsed, oldToStable, characterIds, validSegments);
  const voiceAnchors = buildVoiceAnchors(parsed, oldToStable, characterIds, isQuoteValid);
  const openQuestions = buildOpenQuestions(parsed);
  finalizeVoiceProfiles(profiles, existing, openQuestions, oldToStable, characterIds, validSegments);
  return { characterVoices: profiles, relationshipVoiceRules, voiceAnchors, openQuestions: openQuestions.slice(0, 40) };
}

/**
 * 引文校验器：证据必须在同一 segmentId 的原文中逐字定位。
 * 分析与审校共用这一个口径，避免出现「分析收下、审校拒绝」的矛盾证据。
 */
function createQuoteValidator(validSegments: Map<string, string>): (segmentId: unknown, quote: unknown) => boolean {
  return (segmentId, quote) => {
    const sourceText = validSegments.get(typeof segmentId === 'string' ? segmentId : '');
    const normalizedQuote = typeof quote === 'string' ? normalizeEvidenceText(quote) : '';
    return !!sourceText && !!normalizedQuote && normalizeEvidenceText(sourceText).includes(normalizedQuote);
  };
}

/** 逐个采纳有证据的画像；旧模型 ID 记进 oldToStable，供关系规则与锚点重新绑定。 */
function lockCharacterProfiles(
  parsed: Record<string, any>,
  existing: Record<string, any>,
  isQuoteValid: (segmentId: unknown, quote: unknown) => boolean,
  oldToStable: Map<string, string>,
): any[] {
  if (!Array.isArray(parsed.characterVoices)) return [];
  const profiles: any[] = [];
  for (const raw of parsed.characterVoices.slice(0, 80)) {
    const profile = buildVoiceProfile(raw, existing, isQuoteValid, oldToStable);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/**
 * 单个人物画像：锁定 ID、过滤无证据维度、与已有画像合并。
 * 已确认画像只允许追加证据与提出冲突，voiceCore 不会被新章节静默覆盖。
 */
function buildVoiceProfile(
  raw: any,
  existing: Record<string, any>,
  isQuoteValid: (segmentId: unknown, quote: unknown) => boolean,
  oldToStable: Map<string, string>,
): any | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.canonicalSourceName === 'string' ? raw.canonicalSourceName.trim().slice(0, 120) : '';
  if (!name || !raw.voiceCore || typeof raw.voiceCore !== 'object') return null;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [];
  const rawEvidenceTruncated = Array.isArray(raw.evidence) && raw.evidence.length > 12;
  const existingProfile = existing.characterVoices.find((profile: any) =>
    profile.characterId === raw.characterId ||
    profile.canonicalSourceName.toLocaleLowerCase() === name.toLocaleLowerCase() ||
    profile.aliases.some((alias: string) => alias.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
    aliases.some((alias: string) => alias.toLocaleLowerCase() === profile.canonicalSourceName.toLocaleLowerCase()),
  );
  // 模型生成的 ID 每一章都可能变化；宿主根据规范原文名锁定 ID，并优先沿用已有 ID。
  const characterId = existingProfile?.characterId || stableCharacterId(name);
  if (typeof raw.characterId === 'string') oldToStable.set(raw.characterId, characterId);
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.slice(0, 12).flatMap((item: any) => {
    if (!item || typeof item !== 'object' || !isQuoteValid(item.segmentId, item.sourceQuote)) return [];
    const dimension = ['register','syntax_rhythm','lexicon','discourse','stance','humor_irony','disfluency','relationship','role_traits'].includes(item.dimension) ? item.dimension : '';
    const observation = typeof item.observation === 'string' ? item.observation.trim().slice(0, 240) : '';
    if (!dimension || !observation) return [];
    const confidence = confidenceScore(item.confidence);
    const confidenceSource = confidence === null ? undefined : 'model_self_report' as const;
    return [{
      ...item,
      segmentId: String(item.segmentId).slice(0, 160),
      sourceQuote: String(item.sourceQuote).slice(0, 240),
      dimension, observation, confidence,
      confidenceSource,
    }];
  }) : [];
  if (!evidence.length) {
    // 无可核对的原文证据，不创建可用于翻译的声音画像。
    return null;
  }
  const analysisConflictWithConfirmed = existingProfile?.status === 'confirmed' &&
    JSON.stringify(existingProfile.voiceCore) !== JSON.stringify(raw.voiceCore);
  const combinedEvidence = existingProfile?.status === 'confirmed'
    ? [...existingProfile.evidence, ...evidence].filter((item: any, index: number, all: any[]) =>
        all.findIndex((other: any) => other.segmentId === item.segmentId && other.dimension === item.dimension) === index,
      )
    : evidence;
  const reportedConfidence = confidenceScore(raw.confidence);
  const priorConfidence = existingProfile?.confidenceSource === 'model_self_report'
    ? confidenceScore(existingProfile.confidence)
    : null;
  const profileConfidence = reportedConfidence ?? priorConfidence;
  const profileConfidenceSource = profileConfidence === null ? undefined : 'model_self_report' as const;
  const evidenceTruncated = rawEvidenceTruncated ||
    existingProfile?.evidenceTruncated === true ||
    combinedEvidence.length > 12;
  // 滚动的声音档案到达存储上限时，保留最新的证据。上面那个完整性标记
  // 仍然是权威：只要有源文证据被这个上限挤掉，时间检索就不会用这份聚合的 VoiceCore。
  const stableEvidence = combinedEvidence.slice(-12);
  return {
    analysisConflictWithConfirmed,
    ...raw, characterId, canonicalSourceName: name,
    targetName: existingProfile?.targetName || raw.targetName,
    role: existingProfile?.status === 'confirmed'
      ? existingProfile.role
      : typeof raw.role === 'string' ? raw.role.trim().slice(0, 360) : undefined,
    traits: existingProfile?.status === 'confirmed'
      ? existingProfile.traits
      : Array.isArray(raw.traits) ? raw.traits.filter((item: unknown) => typeof item === 'string').slice(0, 10).map((item: string) => item.slice(0, 160)) : undefined,
    aliases: Array.from(new Set([...(existingProfile?.aliases || []), ...aliases])).slice(0, 12),
    // 旧画像一旦由用户确认后，新章节只能增加证据/提出冲突，不得覆盖画像核心。
    voiceCore: existingProfile?.status === 'confirmed' ? existingProfile.voiceCore : raw.voiceCore,
    status: existingProfile?.status === 'confirmed' ? 'confirmed'
      : existingProfile?.status === 'rejected' ? 'rejected' : 'candidate',
    // 是否用于翻译属于用户偏好，不是模型能决定的事。
    useForTranslation: existingProfile
      ? existingProfile.useForTranslation !== false && existingProfile.status !== 'rejected'
      : true,
    confidence: profileConfidence,
    confidenceSource: profileConfidenceSource,
    evidence: stableEvidence,
    evidencePolicyVersion: 'character-evidence-v2-complete',
    evidenceTruncated,
    openQuestions: Array.isArray(raw.openQuestions) ? raw.openQuestions.slice(0, 8) : [],
  };
}

/**
 * 关系语言规则：说话双方必须都是本章被采纳的人物，证据片段必须真实存在。
 * 关系事实与「怎么说话」是两回事，所以这里只收语言规则。
 */
function buildRelationshipVoiceRules(
  parsed: Record<string, any>,
  oldToStable: Map<string, string>,
  characterIds: Set<string>,
  validSegments: Map<string, string>,
): any[] {
  const relationshipVoiceRules = Array.isArray(parsed.relationshipVoiceRules)
    ? parsed.relationshipVoiceRules.slice(0, 160).flatMap((raw: any) => {
      if (!raw || typeof raw !== 'object') return [];
      const speakerId = oldToStable.get(raw.speakerId) || raw.speakerId;
      const addresseeId = oldToStable.get(raw.addresseeId) || raw.addresseeId;
      const evidenceSegmentIds = Array.isArray(raw.evidenceSegmentIds)
        ? raw.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string' && validSegments.has(id)).slice(0, 8)
        : [];
      return characterIds.has(speakerId) && characterIds.has(addresseeId) && evidenceSegmentIds.length
        ? [{ ...raw, speakerId, addresseeId, evidenceSegmentIds, status: 'candidate' }]
        : [];
    })
    : [];
  return relationshipVoiceRules;
}

/**
 * 声音锚点：要求原文引文可定位、归属证据同样可定位且置信度不低于 0.7。
 * 归属不可靠的对白不进锚点，改写进 openQuestions。
 */
function buildVoiceAnchors(
  parsed: Record<string, any>,
  oldToStable: Map<string, string>,
  characterIds: Set<string>,
  isQuoteValid: (segmentId: unknown, quote: unknown) => boolean,
): any[] {
  const voiceAnchors = Array.isArray(parsed.voiceAnchors)
    ? parsed.voiceAnchors.slice(0, 240).flatMap((raw: any) => {
      if (!raw || typeof raw !== 'object') return [];
      const speakerId = oldToStable.get(raw.speakerId) || raw.speakerId;
      const source = typeof raw.source === 'string' ? raw.source.trim() : '';
      const target = typeof raw.target === 'string' ? raw.target.trim() : '';
      const segmentId = typeof raw.segmentId === 'string' ? raw.segmentId : '';
      const attributionEvidence = typeof raw.attributionEvidence === 'string' ? raw.attributionEvidence.trim() : '';
      const attributionConfidence = Number(raw.attributionConfidence);
      if (!characterIds.has(speakerId) || !source || !target || !isQuoteValid(segmentId, source)) return [];
      // 说话人证据必须在原文同一片段中可定位；不以模型声称的 confidence 单独作为事实。
      if (!attributionEvidence || !isQuoteValid(segmentId, attributionEvidence) ||
        !Number.isFinite(attributionConfidence) || attributionConfidence < 0.7) {
        return [];
      }
      const anchorId = 'anchor_' + stableCharacterId(segmentId + '\\u0000' + speakerId + '\\u0000' + source).slice(5);
      return [{
        ...raw, anchorId, speakerId, segmentId, source: source.slice(0, 400), target: target.slice(0, 500),
        attributionEvidence: attributionEvidence.slice(0, 240),
        attributionConfidence: Math.max(0, Math.min(1, attributionConfidence)),
        status: 'candidate', approvedBy: 'reviewer',
      }];
    })
    : [];
  return voiceAnchors;
}

/** 从分析结果里收集待确认问题：去重、限长，并丢弃空项。 */
function buildOpenQuestions(parsed: Record<string, any>): string[] {
  const openQuestions = Array.isArray(parsed.openQuestions)
    ? parsed.openQuestions.filter((value: unknown) => typeof value === 'string').slice(0, 40).map((value: string) => value.slice(0, 200))
    : [];
  return openQuestions;
}

/**
 * 收尾：把「与已确认画像冲突」写成可复核的问题，再过滤对比规则。
 * 冲突不自动覆盖，也不丢弃——留给用户判断。
 */
function finalizeVoiceProfiles(
  profiles: any[],
  existing: Record<string, any>,
  openQuestions: string[],
  oldToStable: Map<string, string>,
  characterIds: Set<string>,
  validSegments: Map<string, string>,
): void {
  for (const profile of profiles) {
    const conflicts = profile.analysisConflictWithConfirmed || existing.characterVoices.some((prior: any) =>
      prior.characterId === profile.characterId && prior.status === 'confirmed' &&
      JSON.stringify(prior.voiceCore) !== JSON.stringify(profile.voiceCore));
    if (conflicts) {
      const question = profile.canonicalSourceName + '：新章节观察与已确认声音画像存在差异，需要复核，不自动覆盖。';
      openQuestions.push(question);
      // 同时挂到具体人物画像，保证 extension 的 Voice Bible 能展示并在后续章节合并时保留。
      profile.openQuestions = Array.from(new Set([...(profile.openQuestions || []), question])).slice(0, 8);
    }
    delete profile.analysisConflictWithConfirmed;
    profile.contrastRules = Array.isArray(profile.contrastRules) ? profile.contrastRules.slice(0, 6).flatMap((rule: any) => {
      const otherCharacterId = oldToStable.get(rule.otherCharacterId) || rule.otherCharacterId;
      const evidenceSegmentIds = Array.isArray(rule.evidenceSegmentIds) ? rule.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string' && validSegments.has(id)).slice(0, 6) : [];
      return characterIds.has(otherCharacterId) && typeof rule.difference === 'string' && evidenceSegmentIds.length
        ? [{ ...rule, otherCharacterId, evidenceSegmentIds }]
        : [];
    }) : [];
    profile.openQuestions = Array.isArray(profile.openQuestions) ? profile.openQuestions.slice(0, 8) : [];
  }
}
