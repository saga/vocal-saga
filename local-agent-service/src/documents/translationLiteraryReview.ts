/**
 * 文学审校调用与缺失片段补审。
 *
 * 从 translationAgent 抽出：一次审校请求的组装、专名映射的合并确认、未覆盖片段的重试，
 * 都在这里；候选与 finding 的落库仍由调用方决定。
 */
import { addTurnUsage, summarizeTurnUsage } from '../agents/usage.ts';
import { runLiteraryReview } from '../literary.ts';
import {
  canonicalMarkerCountsMatch,
  canonicalTermPattern,
  isCompatibleCanonicalAlias,
  isGenericCanonicalNameForm,
  normalizeCanonicalTerm,
  protectCanonicalReviewSegments,
  restoreCanonicalMarkersDeep,
} from './canonicalTermProtection.ts';
import { getDocumentProjectStore } from './projectStore.ts';
/**
 * Reviewer 专用的安全合并：保留图谱快照中可能被裁剪的确认译名，并要求名称/别名出现在当前审校源文中。
 */
export function mergeConfirmedMemoryNameMappings(
  contextGraph: Record<string, unknown> | null | undefined,
  memoryInput: unknown,
  sourceSegments?: Array<{ source?: string; text?: string }>,
): Record<string, unknown> | null {
  const graph = contextGraph && typeof contextGraph === 'object' && !Array.isArray(contextGraph)
    ? contextGraph : null;
  const rawGraphMappings = Array.isArray((graph as any)?.nameMappings)
    ? (graph as any).nameMappings as Array<Record<string, any>> : [];
  const memory = memoryInput && typeof memoryInput === 'object' && !Array.isArray(memoryInput)
    ? memoryInput as Record<string, any> : {};
  const hasSourceScope = Array.isArray(sourceSegments);
  const sourceTexts = hasSourceScope
    ? sourceSegments!.map((segment) => String(segment?.source ?? segment?.text ?? '')).filter(Boolean)
    : [];
  const visibleName = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (!hasSourceScope) return true;
    let pattern: RegExp;
    try { pattern = new RegExp(canonicalTermPattern(value), 'iu'); } catch { return false; }
    return sourceTexts.some((source) => pattern.test(source));
  };
  const safeAliases = (source: string, aliasesInput: unknown) => {
    const aliases = (Array.isArray(aliasesInput) ? aliasesInput : [])
      .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
      .map((alias) => alias.trim())
      .filter((alias) =>
        !isGenericCanonicalNameForm(alias) &&
        isCompatibleCanonicalAlias(source, alias) &&
        (!hasSourceScope || visibleName(alias)));
    return Array.from(new Map(aliases.map((alias) => [normalizeCanonicalTerm(alias), alias])).values());
  };
  const includeMapping = (source: string, aliases: string[]) =>
    !hasSourceScope || visibleName(source) || aliases.some(visibleName);
  const graphMappings = rawGraphMappings.flatMap((mapping) => {
    const source = typeof mapping?.source === 'string' ? mapping.source.trim() : '';
    const target = typeof mapping?.target === 'string' ? mapping.target.trim() : '';
    if (!source || !target || isGenericCanonicalNameForm(source)) return [];
    const aliases = safeAliases(source, mapping.aliases);
    if (!includeMapping(source, aliases)) return [];
    return [{ ...mapping, aliases }];
  });
  const confirmedEntityMappings = (Array.isArray(memory.entities) ? memory.entities : [])
    .filter((entity: any) => entity?.reviewStatus === 'confirmed' && entity?.confirmationSource === 'user-confirmed' &&
      typeof entity?.source === 'string' && entity.source.trim() &&
      typeof entity?.target === 'string' && entity.target.trim() &&
      !isGenericCanonicalNameForm(entity.source))
    .flatMap((entity: any) => {
      const source = entity.source.trim();
      const aliases = safeAliases(source, entity.aliases);
      if (!includeMapping(source, aliases)) return [];
      return [{
        source,
        target: entity.target.trim(),
        aliases,
        kind: typeof entity.kind === 'string' ? entity.kind : 'other',
        sourceStatus: 'confirmed-memory', confirmationSource: 'user-confirmed',
      }];
    });
  // 人物管理里的规范原文名/译名是独立的权威入口。旧数据可能只保存 characterVoices，
  // 没有对应 entities；已确认档案可保护译名，但候选档案只能进入软提示而非强制保护。
  const confirmedCharacterMappings = (Array.isArray(memory.characterVoices) ? memory.characterVoices : [])
    .filter((profile: any) => profile?.status === 'confirmed' && profile?.confirmationSource === 'user-confirmed' && profile?.useForTranslation !== false &&
      typeof profile?.canonicalSourceName === 'string' && profile.canonicalSourceName.trim() &&
      typeof profile?.targetName === 'string' && profile.targetName.trim() &&
      !isGenericCanonicalNameForm(profile.canonicalSourceName))
    .flatMap((profile: any) => {
      const source = profile.canonicalSourceName.trim();
      const aliases = safeAliases(source, profile.aliases);
      if (!includeMapping(source, aliases)) return [];
      return [{
        source,
        target: profile.targetName.trim(),
        aliases,
        kind: 'character',
        sourceStatus: 'confirmed-memory', confirmationSource: 'user-confirmed',
      }];
    });
  const combinedMappings: Array<Record<string, any>> = [...graphMappings, ...confirmedEntityMappings, ...confirmedCharacterMappings];
  if (!graph && !combinedMappings.length) return null;

  // 强映射之间也可能互相矛盾。候选只是建议，不能把已确认的译名顶掉；
  // 多个强来源之间若有未解冲突，就失败关闭。
  const strongTargetsBySource = new Map<string, Set<string>>();
  const targetsBySource = new Map<string, Set<string>>();
  for (const mapping of combinedMappings) {
    const key = normalizeCanonicalTerm(String(mapping.source || ''));
    const target = normalizeCanonicalTerm(String(mapping.target || ''));
    const values = targetsBySource.get(key) || new Set<string>();
    values.add(target);
    targetsBySource.set(key, values);
    if (['confirmed', 'confirmed-memory'].includes(String(mapping.sourceStatus || ''))) {
      const strong = strongTargetsBySource.get(key) || new Set<string>();
      strong.add(target);
      strongTargetsBySource.set(key, strong);
    }
  }
  const conflicted = new Set(Array.from(strongTargetsBySource.entries())
    .filter(([, targets]) => targets.size > 1).map(([key]) => key));
  const nameMappings = combinedMappings.filter((mapping) => {
    const key = normalizeCanonicalTerm(String(mapping.source || ''));
    if (conflicted.has(key)) return false;
    const strongTargets = strongTargetsBySource.get(key);
    if (!['confirmed', 'confirmed-memory'].includes(String(mapping.sourceStatus || '')) &&
        strongTargets?.size === 1 &&
        !strongTargets.has(normalizeCanonicalTerm(String(mapping.target || '')))) return false;
    return true;
  });
  const result: Record<string, unknown> = { ...(graph || {}), nameMappings };
  if (conflicted.size) {
    const conflicts = Array.from(strongTargetsBySource.entries())
      .filter(([key]) => conflicted.has(key))
      .map(([source, targets]) => ({
        source,
        targets: Array.from(targets),
      }));
    result.canonicalNameMappingConflicts = [
      ...(Array.isArray((graph as any)?.canonicalNameMappingConflicts) ? (graph as any).canonicalNameMappingConflicts : []),
      ...conflicts,
    ];
    const constraints = Array.isArray((graph as any)?.constraints) ? (graph as any).constraints : [];
    result.constraints = Array.from(new Set([
      ...constraints,
      'Conflicting confirmed canonical-name mappings are listed in canonicalNameMappingConflicts. Do not choose a target arbitrarily; request project-memory correction.',
    ]));
  }
  return result;
}

/**
 * 运行文学 Reviewer，并对其漏掉的 ID 做一次有界补审。
 * 调用前后都会保护/恢复强规范译名标记；重试只包含 missingIds，不重复提交整批。
 * 此函数只产出修订建议，外层必须再次检查 Run 状态并通过 Store 原子提交候选与 findings。
 */
export async function runLiteraryReviewWithMissingRetry(input: Record<string, any>, requestId: string, sessionScope?: string): Promise<any> {
  const originalSegments = Array.isArray(input.segments) ? input.segments : [];
  const reviewContextGraph = input.translationBrief && typeof input.translationBrief === 'object'
    ? (input.translationBrief as any).contextGraph ?? null
    : null;
  const reviewerCanonicalContext = mergeConfirmedMemoryNameMappings(reviewContextGraph, input.memory, originalSegments);
  const protectedReview = protectCanonicalReviewSegments(originalSegments, reviewerCanonicalContext);
  const reviewInput = protectedReview.protections.length
    ? { ...input, segments: protectedReview.segments }
    : input;
  const restoreReview = (result: any) => {
    if (!protectedReview.protections.length) return result;
    const rawTranslations = result?.translations && typeof result.translations === 'object'
      ? result.translations as Record<string, unknown>
      : {};
    const safeTranslations: Record<string, unknown> = { ...rawTranslations };
    const fallbackIds: string[] = [];
    const originalById = new Map(originalSegments.map((segment: any) => [String(segment.id), segment]));
    for (const maskedSegment of protectedReview.segments) {
      const relevantMarkers = protectedReview.protections.filter((term) => maskedSegment.source.includes(term.marker));
      if (!relevantMarkers.length) continue;
      const rawTranslation = rawTranslations[maskedSegment.id];
      if (typeof rawTranslation === 'string' &&
          canonicalMarkerCountsMatch(maskedSegment.source, rawTranslation, relevantMarkers)) continue;
      // 不允许审校把有证据的规范名删掉。遇到这种情况保留该 ID 已归一的初译，
      // 而不是接受一次不兼容的重写。
      const original = originalById.get(maskedSegment.id) as any;
      if (original && typeof original.draft === 'string') {
        safeTranslations[maskedSegment.id] = original.draft;
        fallbackIds.push(maskedSegment.id);
      }
    }
    const restored = restoreCanonicalMarkersDeep(
      { ...result, translations: safeTranslations },
      protectedReview.protections,
    ) as any;
    return fallbackIds.length ? { ...restored, canonicalTermFallbackIds: fallbackIds } : restored;
  };
  const store = getDocumentProjectStore();
  const projectId = typeof input.projectId === 'string' ? input.projectId : '';
  const runId = typeof input.runId === 'string' ? input.runId : '';
  if (projectId && runId) {
    store.appendEvent(projectId, runId, 'review.audit.input', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId, sessionScope,
      responseShape: 'review-input-snapshot',
      audit: { input: reviewInput },
    });
  }
  let rawInitial: any;
  try {
    rawInitial = await runLiteraryReview(reviewInput, requestId, sessionScope);
    if (projectId && runId) store.appendEvent(projectId, runId, 'review.audit.output', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId, sessionScope,
      responseShape: 'parsed-review-result',
      audit: { response: rawInitial },
    });
  } catch (error) {
    if (projectId && runId) store.appendEvent(projectId, runId, 'review.audit.failed', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId, sessionScope, error: error instanceof Error ? error.message : String(error),
      audit: { input: reviewInput },
    });
    throw error;
  }
  const initial = restoreReview(rawInitial);
  const missingIds = Array.isArray(initial.missingIds) ? initial.missingIds as string[] : [];
  if (!missingIds.length) return initial;
  const missing = new Set(missingIds);
  const retrySegments = (Array.isArray(reviewInput.segments) ? reviewInput.segments : [])
    .filter((segment: any) => missing.has(segment.id));
  if (!retrySegments.length) return initial;
  try {
    const retryInput = { ...reviewInput, segments: retrySegments };
    if (projectId && runId) store.appendEvent(projectId, runId, 'review.audit.retry-input', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId: requestId + '-missing-retry', parentRequestId: requestId,
      sessionScope, missingIds, audit: { input: retryInput },
    });
    const rawRetry = await runLiteraryReview(retryInput, requestId + '-missing-retry', sessionScope);
    if (projectId && runId) store.appendEvent(projectId, runId, 'review.audit.retry-output', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId: requestId + '-missing-retry', parentRequestId: requestId,
      sessionScope, audit: { response: rawRetry },
    });
    const retry = restoreReview(rawRetry);
    const translations = { ...(initial.translations || {}), ...(retry.translations || {}) };
    const expectedIds = (Array.isArray(originalSegments) ? originalSegments : []).map((segment: any) => segment.id);
    const reviewedIds = expectedIds.filter((id: string) => typeof translations[id] === 'string');
    return {
      ...initial,
      translations,
      findings: [...(initial.findings || []), ...(retry.findings || [])],
      reviewedIds,
      missingIds: expectedIds.filter((id: string) => typeof translations[id] !== 'string'),
      promptChars: Number(initial.promptChars || 0) + Number(retry.promptChars || 0),
      systemPromptChars: Math.max(Number(initial.systemPromptChars || 0), Number(retry.systemPromptChars || 0)),
      contextChars: Number(initial.contextChars || 0) + Number(retry.contextChars || 0),
      // 补审是第二次模型调用，用量必须合并，否则审校成本永远只记首轮。
      usage: addTurnUsage(initial.usage ?? null, retry.usage ?? null),
      usageSummary: summarizeTurnUsage(addTurnUsage(initial.usage ?? null, retry.usage ?? null)),
      retryError: undefined,
    };
  } catch (error) {
    const retryError = error instanceof Error ? error.message : String(error);
    if (projectId && runId) store.appendEvent(projectId, runId, 'review.audit.retry-failed', {
      stage: input.reviewType === 'style' ? 'style-review' : 'review',
      requestId: requestId + '-missing-retry',
      parentRequestId: requestId,
      sessionScope,
      missingIdCount: retrySegments.length,
      error: retryError,
    });
    return {
      ...initial,
      retryError,
    };
  }
}
