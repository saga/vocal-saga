/**
 * 单批模型调用：装配提示、发起请求、回收译文与 context delta。
 *
 * 从 translationAgent 抽出：只负责「一批片段换来一批译文」这一件事，
 * 重试预算与候选落库由调用方（Run 批次流程）负责。
 *
 * 内部按阶段拆开：装请求 → 记审计 → 调模型 → 校验强规范译名标记 → 解析 context delta。
 * 每个阶段都可以单独读、单独改，整条链只有 requestTranslation 一处会抛错。
 */
import { runAgentStructured } from '../agents/runner.ts';
import { getCodeBuddyTaskProfile, resolveEffectiveTaskModel } from '../agents/taskProfiles.ts';
import { summarizeTurnUsage } from '../agents/usage.ts';
import { parseAgentModel } from '../json.ts';
import { logInfo } from '../log.ts';
import {
  buildCanonicalMarkerReminder,
  buildCanonicalTermProtections,
  type CanonicalMarkerMismatch,
  describeCanonicalMarkerMismatch,
  maskCanonicalTermText,
  normalizeContextDeltaCanonicalTargets,
  restoreCanonicalTermMarkers,
} from './canonicalTermProtection.ts';
import { applyRunLanguageDirection } from './languageMatch.ts';
import { type DocumentProjectStore, getDocumentProjectStore } from './projectStore.ts';
import { type TranslationBrief } from './translationBrief.ts';
import {
  emptyTranslationContextDelta,
  type ValidatedTranslationContextDelta,
  validateTranslationContextDelta,
} from './translationContextDelta.ts';
import { buildDocumentBatchSessionScope } from './translationConcurrency.ts';
import { sourceNameMatches } from './briefSourceContext.ts';
import { buildUserPrompt, type TranslationParseDiagnostics, parseTranslations } from './translationPrompt.ts';
import { addRunUsage } from './translationRunUsage.ts';
import { LITERARY_TRANSLATION_CONTRACT, MANDATORY_TRANSLATION_CONTRACT, TRANSLATION_SCHEMA, type TranslationItem } from './translationSchema.ts';

/** 一次批次请求在发出前就已确定的全部输入；后续阶段只读它，不再重新装配。 */
interface BatchRequest {
  agent: ReturnType<typeof parseAgentModel>;
  contextGraph: Record<string, unknown> | null;
  memory: Record<string, any>;
  termProtections: ReturnType<typeof buildCanonicalTermProtections>;
  maskedSourceById: Map<string, string>;
  userPrompt: string;
  systemPrompt: string;
  sessionScope: string;
  translationProfile: ReturnType<typeof getCodeBuddyTaskProfile>;
  effectiveModel: string;
}

/**
 * 执行单个翻译批次：构建提示、保护强规范译名、调用结构化模型接口并校验输出。
 * 文学模式下，TranslationBrief 同时作为初译和两类 Reviewer 的共享上下文来源；
 * context_delta 是可选的附属候选数据，其校验/持久化失败不能抹掉已成功解析的译文。
 */
export async function translateBatch(context: any, items: TranslationItem[], requestId: string, batchIndex: number, precedingSegments: TranslationItem[] = [], translationBrief?: TranslationBrief): Promise<{ translations: Map<string, string>; contextDelta: ValidatedTranslationContextDelta }> {
  const request = prepareBatchRequest(context, items, batchIndex, precedingSegments, translationBrief);
  const store = getDocumentProjectStore();
  const requestStartedAt = Date.now();
  appendPromptAudit(store, context, request, items, requestId, batchIndex, precedingSegments, translationBrief);

  const value = await requestTranslation(store, context, request, items, requestId, batchIndex, requestStartedAt);
  const parsed = parseTranslations(value, new Set(items.map((item) => item.id)));
  const translations = acceptCanonicalTranslations(store, context, request, parsed.translations, batchIndex, requestId, items);
  appendOutputAudit(store, context, request, items, translations, value, parsed.diagnostics, requestId, batchIndex, requestStartedAt);

  const delta = parseBatchContextDelta(context, items, translations, value, request, requestId, batchIndex);
  return { translations, contextDelta: delta };
}

/** 装配一次请求的全部输入：提示、强规范译名保护、会话作用域与实际生效模型。 */
function prepareBatchRequest(
  context: any,
  items: TranslationItem[],
  batchIndex: number,
  precedingSegments: TranslationItem[],
  translationBrief?: TranslationBrief,
): BatchRequest {
  const agent = parseAgentModel(context.run.model || 'auto', context.run.provider || 'workbuddy');
  const contextGraph = translationBrief?.contextGraph ?? null;
  // 只为了审计计数才去读 Run 锁定的记忆。规范名掩码仍然绑定到
  // buildUserPrompt 和标记校验所用的那份 TranslationBrief 快照。
  const memory = context.memory && typeof context.memory === 'object' ? context.memory as Record<string, any> : {};
  // TranslationBrief 是模型提示词、标记校验和两个 Reviewer 共用的唯一映射快照。
  // 不要在这里追加未过滤的记忆映射：那会让校验器要求一些
  // buildUserPrompt 从未发出去的标记，把本来合法的片段判成失败。
  const termProtections = context.run.translationMode === 'literary'
    ? buildCanonicalTermProtections(items, contextGraph, String(context.run.targetLang || 'zh'))
    : [];
  logInfo('document-agent', 'batch ready · batch=' + batchIndex +
    ' · mode=' + context.run.translationMode +
    ' · segments=' + items.length +
    ' · contextGraphMappings=' + (Array.isArray((contextGraph as any)?.nameMappings) ? (contextGraph as any).nameMappings.length : 0) +
    ' · protectedTerms=' + termProtections.length +
    ' · voiceEntities=' + (Array.isArray((translationBrief?.voiceContext as any)?.entities) ? (translationBrief?.voiceContext as any).entities.length : 0) +
    ' · voiceCharacters=' + (Array.isArray((translationBrief?.voiceContext as any)?.characterVoices) ? (translationBrief?.voiceContext as any).characterVoices.length : 0));
  const maskedSourceById = new Map(items.map((item) => [
    item.id, maskCanonicalTermText(item.text, termProtections),
  ]));
  const userPrompt = buildUserPrompt(
    context.prompt.userPromptTemplate || '', items, context, precedingSegments, contextGraph, translationBrief,
  ) + buildCanonicalMarkerReminder(Array.from(maskedSourceById.values()), termProtections);
  const systemPrompt = [
    // 项目 Prompt 是上一次生效的快照，语言行可能已经过期；运行时的语言对才是权威。
    applyRunLanguageDirection(context.prompt.systemPrompt || '', context.run),
    context.run.translationMode === 'literary' ? LITERARY_TRANSLATION_CONTRACT : '',
    MANDATORY_TRANSLATION_CONTRACT,
  ].filter(Boolean).join('\n\n');
  const sessionScope = buildDocumentBatchSessionScope({
    projectId: context.project.projectId,
    runId: context.run.runId,
    promptRevisionId: context.run.promptRevisionId,
    role: 'translation',
    batchIndex,
    translationMode: context.run.translationMode,
  });
  // 记录「本次实际生效」的模型，而不是池默认模型。两者经常不同（池默认 auto → glm-5.3-flash，
  // 任务配置却是 deepseek-v4.1-flash），写错会让所有基于日志的速度分析指向错误的模型。
  const translationProfile = getCodeBuddyTaskProfile(context.prompt.config || {}, 'translation');
  const effectiveModel = resolveEffectiveTaskModel(agent.model, translationProfile);
  return {
    agent, contextGraph, memory, termProtections, maskedSourceById,
    userPrompt, systemPrompt, sessionScope, translationProfile, effectiveModel,
  };
}

/**
 * 审计账本保存实际发送的 Prompt 与 schema；正文是本地用户数据，不能只留字符数。
 */
function appendPromptAudit(
  store: DocumentProjectStore,
  context: any,
  request: BatchRequest,
  items: TranslationItem[],
  requestId: string,
  batchIndex: number,
  precedingSegments: TranslationItem[],
  translationBrief?: TranslationBrief,
): void {
  const { agent, contextGraph, memory, termProtections, userPrompt, systemPrompt, sessionScope, translationProfile, effectiveModel } = request;
  const voiceContext = translationBrief?.voiceContext;
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  store.appendEvent(context.project.projectId, context.run.runId, 'batch.prompt.ready', {
    stage: 'translate',
    batchIndex,
    requestId,
    provider: agent.provider,
    model: effectiveModel,
    requestedModel: agent.model || '<runtime-default>',
    thinkingMode: translationProfile.thinkingMode,
    thinkingBudgetTokens: translationProfile.thinkingBudgetTokens,
    effort: translationProfile.effort,
    fallbackModel: translationProfile.fallbackModel,
    translationMode: context.run.translationMode,
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    promptRevisionId: context.run.promptRevisionId,
    sessionScope,
    segmentCount: items.length,
    sourceChars: items.reduce((sum, item) => sum + item.text.length, 0),
    segmentIds: items.map((item) => item.id).slice(0, 12),
    precedingSegmentCount: precedingSegments.length,
    userPromptChars: userPrompt.length,
    systemPromptChars: systemPrompt.length,
    glossaryTerms: count((translationBrief?.glossary as any)?.document_terms ?? context.prompt.config?.glossary?.document_terms),
    memoryEntities: count(memory.entities),
    memoryRelationships: count(memory.relationships),
    memoryChapterSummaries: count(memory.chapterSummaries),
    memoryCharacterVoices: count(memory.characterVoices),
    memoryRelationshipVoiceRules: count(memory.relationshipVoiceRules),
    memoryVoiceAnchors: count(memory.voiceAnchors),
    contextGraphIncluded: !!contextGraph,
    contextGraphCharacters: count((contextGraph as any)?.characters),
    contextGraphEntities: count((contextGraph as any)?.entities),
    contextGraphNameMappingCount: count((contextGraph as any)?.nameMappings),
    protectedCanonicalTermCount: termProtections.length,
    // 只留名字的紧凑预览，用来确认术语表确实到达了这个批次，
    // 又不把完整源文或完整提示词写进事件流。
    contextGraphNameMappingPreview: (Array.isArray((contextGraph as any)?.nameMappings)
      ? (contextGraph as any).nameMappings : []).slice(0, 12).map((item: any) => ({
        source: typeof item?.source === 'string' ? item.source.slice(0, 120) : '',
        target: typeof item?.target === 'string' ? item.target.slice(0, 120) : '',
      })),
    contextGraphRelationships: count((contextGraph as any)?.relationships),
    contextGraphChapterSummaries: count((contextGraph as any)?.chapterSummaries),
    voiceContextIncluded: !!voiceContext,
    injectedEntities: count(voiceContext?.entities),
    injectedRelationships: count(voiceContext?.relationships),
    injectedChapterSummaries: count(voiceContext?.chapterSummaries),
    injectedCharacterVoices: count(voiceContext?.characterVoices),
    injectedRelationshipVoiceRules: count(voiceContext?.relationshipVoiceRules),
    injectedVoiceAnchors: count(voiceContext?.voiceAnchors),
    contextPolicyVersion: typeof voiceContext?.policyVersion === 'string' ? voiceContext.policyVersion : undefined,
    translationBriefHash: translationBrief?.contextHash || null,
    translationBriefChars: translationBrief?.contextChars || 0,
    translationBriefPolicyVersion: translationBrief?.policyVersion || null,
    graphKnowledgeBoundaryOrdinal: (contextGraph as any)?.knowledgeBoundaryOrdinal ?? null,
    audit: { systemPrompt, userPrompt, schema: TRANSLATION_SCHEMA, sourceSegments: items.map((item) => ({ id: item.id, text: item.text })), precedingSegments: precedingSegments.map((item) => ({ id: item.id, text: item.text })) },
  });
}

/**
 * 发起一次结构化模型调用并结算用量。
 *
 * 这是整条链里唯一会把异常抛给调用方的地方：失败事件写完之后原样 rethrow，
 * 由 Run 批次流程决定是否用剩余调用预算重试。
 */
async function requestTranslation(
  store: DocumentProjectStore,
  context: any,
  request: BatchRequest,
  items: TranslationItem[],
  requestId: string,
  batchIndex: number,
  requestStartedAt: number,
): Promise<unknown> {
  const { agent, userPrompt, systemPrompt, sessionScope, translationProfile, effectiveModel } = request;
  try {
    const modelRun = await runAgentStructured(
      agent, userPrompt, systemPrompt, TRANSLATION_SCHEMA, requestId, sessionScope,
      translationProfile,
    );
    const turnUsage = modelRun.usage;
    addRunUsage(context.run.runId, turnUsage);
    if (turnUsage) {
      store.appendEvent(context.project.projectId, context.run.runId, 'model.usage', {
        stage: 'translate', batchIndex, requestId,
        provider: agent.provider, model: effectiveModel, requestedModel: agent.model || '<runtime-default>',
        thinkingMode: translationProfile.thinkingMode,
        thinkingBudgetTokens: translationProfile.thinkingBudgetTokens,
        effort: translationProfile.effort,
        fallbackModel: translationProfile.fallbackModel,
        ...summarizeTurnUsage(turnUsage),
      });
    }
    return modelRun.result;
  } catch (error) {
    store.appendEvent(context.project.projectId, context.run.runId, 'model.call.failed', {
      stage: 'translate', batchIndex, requestId,
      provider: agent.provider, model: effectiveModel, requestedModel: agent.model || '<runtime-default>',
      thinkingMode: translationProfile.thinkingMode,
      thinkingBudgetTokens: translationProfile.thinkingBudgetTokens,
      effort: translationProfile.effort,
      fallbackModel: translationProfile.fallbackModel,
      durationMs: Date.now() - requestStartedAt,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    throw error;
  }
}

/**
 * 强规范译名标记校验：把丢失受保护标记的片段判为缺失，交给有界重试重取。
 *
 * 源文里确实出现了某个被映射的名字，但模型把它的受保护标记丢了。
 * 不要落盘一份可能不一致的译文；把这个 ID 留空，让现有的有界重试
 * 再来要这个片段。重试仍然丢标记，就把该片段显式标失败，
 * 而不是悄悄存下一个错的规范名。
 */
function acceptCanonicalTranslations(
  store: DocumentProjectStore,
  context: any,
  request: BatchRequest,
  parsedTranslations: Map<string, string>,
  batchIndex: number,
  requestId: string,
  items: TranslationItem[],
): Map<string, string> {
  const { termProtections, maskedSourceById } = request;
  const translations = new Map<string, string>();
  const missingProtectedMarkers = new Set<string>();
  // 逐片段的标记差异明细：只有片段 id 无法判断是「标记被翻译掉」还是「重复标记被合并」。
  const markerMismatches: Array<{ segmentId: string; markers: CanonicalMarkerMismatch[] }> = [];
  let droppedMarkerOccurrences = 0;
  for (const [id, rawTranslation] of parsedTranslations) {
    const maskedSource = maskedSourceById.get(id) || '';
    const mismatch = describeCanonicalMarkerMismatch(maskedSource, rawTranslation, termProtections);
    if (mismatch.length) {
      missingProtectedMarkers.add(id);
      for (const item of mismatch) droppedMarkerOccurrences += Math.max(0, item.expected - item.actual);
      if (markerMismatches.length < 20) markerMismatches.push({ segmentId: id, markers: mismatch });
      continue;
    }
    translations.set(id, restoreCanonicalTermMarkers(rawTranslation, termProtections, 'target'));
  }
  const protectedSourceKeys = new Set(termProtections.map((item) =>
    String(item.sourceForm || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()));
  const visibleMappings = Array.isArray((request.contextGraph as any)?.nameMappings)
    ? (request.contextGraph as any).nameMappings.filter((mapping: any) =>
        typeof mapping?.source === 'string' && items.some((item) => sourceNameMatches(item.text, mapping.source)))
    : [];
  const visibleButUnprotectedNames = visibleMappings.filter((mapping: any) => {
    const key = String(mapping.source).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    return !protectedSourceKeys.has(key);
  }).map((mapping: any) => ({ source: String(mapping.source).slice(0, 120), target: String(mapping.target || '').slice(0, 120) })).slice(0, 20);
  if (termProtections.length || visibleMappings.length) {
    store.appendEvent(context.project.projectId, context.run.runId, 'canonical-terms.protected', {
      stage: 'translate', batchIndex, requestId,
      mappingCount: termProtections.length,
      protectedSources: termProtections.map((item) => ({ source: item.sourceForm, target: item.target })),
      visibleButUnprotectedNames,
      protectedSegmentCount: Array.from(maskedSourceById.values()).filter((text) =>
        termProtections.some((item) => text.includes(item.marker))).length,
      missingMarkerSegmentIds: Array.from(missingProtectedMarkers).slice(0, 20),
      rejectedSegmentCount: missingProtectedMarkers.size,
      droppedMarkerOccurrences,
      markerMismatches,
    });
  }
  return translations;
}

/**
 * 输出审计：解析诊断、未覆盖片段与原始响应。
 */
function appendOutputAudit(
  store: DocumentProjectStore,
  context: any,
  request: BatchRequest,
  items: TranslationItem[],
  translations: Map<string, string>,
  value: unknown,
  outputDiagnostics: TranslationParseDiagnostics,
  requestId: string,
  batchIndex: number,
  requestStartedAt: number,
): void {
  if (outputDiagnostics.duplicateCount || outputDiagnostics.unexpectedCount || outputDiagnostics.malformedRowCount) {
    store.appendEvent(context.project.projectId, context.run.runId, 'batch.output.validation', {
      stage: 'translate',
      batchIndex,
      requestId,
      duplicateSegmentIds: outputDiagnostics.duplicateSegmentIds,
      duplicateCount: outputDiagnostics.duplicateCount,
      unexpectedOutputIds: outputDiagnostics.unexpectedOutputIds,
      unexpectedCount: outputDiagnostics.unexpectedCount,
      malformedRowCount: outputDiagnostics.malformedRowCount,
    });
  }
  const missingIds = items.filter((item) => !translations.has(item.id)).map((item) => item.id);
  store.appendEvent(context.project.projectId, context.run.runId, 'batch.model.response', {
    stage: 'translate', batchIndex, requestId,
    audit: { responseShape: 'parsed-structured-output', response: value, acceptedTranslations: Array.from(translations, ([id, text]) => ({ id, text })), outputDiagnostics },
    provider: request.agent.provider, model: request.effectiveModel,
    durationMs: Date.now() - requestStartedAt,
    requestedSegments: items.length,
    returnedSegments: translations.size,
    missingIds: missingIds.slice(0, 12),
    missingCount: missingIds.length,
  });
}

/**
 * context_delta 与译文本体隔离验证。即使元数据失真、引用越界或译文没有落点，
 * 也只丢弃对应上下文候选，不能让一份有效的初译响应变成失败。
 */
function parseBatchContextDelta(
  context: any,
  items: TranslationItem[],
  translations: Map<string, string>,
  value: unknown,
  request: BatchRequest,
  requestId: string,
  batchIndex: number,
): ValidatedTranslationContextDelta {
  if (context.run.translationMode !== 'literary') return emptyTranslationContextDelta();
  const deltaResult = validateTranslationContextDelta(
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).context_delta : undefined,
    items,
    translations,
    requestId.slice(-24) + ':',
    Array.isArray(context.memory?.entities) ? context.memory.entities : [],
    String(context.run.targetLang || 'zh'),
  );
  const deltaDiagnostics = deltaResult.diagnostics!;
  const canonicalizedContextEntityCandidates =
    normalizeContextDeltaCanonicalTargets(deltaResult.delta, request.termProtections);
  getDocumentProjectStore().appendEvent(context.project.projectId, context.run.runId, 'translation.context-delta.parsed', {
    batchIndex, requestId,
    canonicalizedContextEntityCandidates,
    acceptedEntityCandidates: deltaDiagnostics.acceptedEntityCandidates,
    rejectedEntityCandidates: deltaDiagnostics.rejectedEntityCandidates,
    acceptedEntityMentions: deltaDiagnostics.acceptedEntityMentions,
    rejectedEntityMentions: deltaDiagnostics.rejectedEntityMentions,
    acceptedRelationships: deltaDiagnostics.acceptedRelationships,
    rejectedRelationships: deltaDiagnostics.rejectedRelationships,
    acceptedOpenQuestions: deltaDiagnostics.acceptedOpenQuestions,
    rejectedOpenQuestions: deltaDiagnostics.rejectedOpenQuestions,
    acceptedConflicts: deltaDiagnostics.acceptedConflicts,
    rejectedConflicts: deltaDiagnostics.rejectedConflicts,
  });
  return deltaResult.delta;
}
