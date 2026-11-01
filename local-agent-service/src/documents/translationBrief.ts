/**
 * 中文：一个有界、内存不可变的上下文包，由初译与两个 Reviewer 共享。
 * 持久化快照只包含引用与紧凑记忆，不包含整本小说或完整草稿。
 * English:
 * One bounded, immutable-in-memory context bundle shared by translation and both reviewers.
 * The persisted snapshot contains references and compact memory, not the full novel or draft text.
 */
import { createHash } from 'node:crypto';
import { logInfo } from '../log.ts';
import { buildProjectVoiceContext } from './voiceContext.ts';
import { buildProjectContextGraphBundle, CONTEXT_GRAPH_ANALYSIS_VERSION } from './contextGraph.ts';
import { getDocumentProjectStore } from './projectStore.ts';
import { normalizeDocumentTranslationStrategy } from './documentStrategy.ts';
import { isWorthCanonicalEntityMapping, normalizeCanonicalEntityKind, validateCanonicalTarget } from './canonicalEntityPolicy.ts';

import {
  MAX_ACCEPTED_EXAMPLE_CHARS, MAX_TRANSLATION_BRIEF_CHARS, TRANSLATION_BRIEF_POLICY_VERSION,
  type BriefSegment, type TranslationBrief,
} from './briefContract.ts';
import {
  firstMatchingSourceOrdinal, isGenericCanonicalSourceName, normalizedSourceText,
  safeCanonicalSourceAliases, sourceNameMatches, sourceQuoteMatches,
} from './briefSourceContext.ts';
import { buildTemporallyVisibleMemory } from './briefTemporalMemory.ts';


/**
 * 中文：按当前批次的时间边界过滤术语表：仅保留源名在前文或本批次出现的术语；
 * 若术语的某个别名首次出现在本批次之后，则整体丢弃，避免未来揭示泄漏到当前译文。
 */
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

/**
 * 中文：将 TranslationBrief 的关键字段序列化为稳定字符串，用于计算 contextHash。
 */
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
  const visiblePrecedingSegments = resolveVisiblePrecedingSegments(projectId, sourceRevisionId, selectedPrecedingSegments);
  // The configured soft budget controls optional historical style examples. Core source context,
  // glossary entries, visible canonical mappings and evidence-backed voice data are not discarded.
  const glossary = filterGlossaryForBatch(context, items);
  const exampleBudgetChars = Math.min(MAX_ACCEPTED_EXAMPLE_CHARS,
    Math.max(1_000, Math.floor(strategy.contextBudgetChars * 0.25)));
  const temporalMemory = context?.run?.translationMode === 'literary'
    ? buildTemporallyVisibleMemory(context, items, visiblePrecedingSegments, exampleBudgetChars)
    : {};
  const chapterPaths = Array.from(new Set(items.map((item) => String(item.contextPath || '').trim()).filter(Boolean)));
  // Book batches should be chapter-scoped. If callers violate that invariant, omitting summaries is safer.
  const chapterPath = chapterPaths.length === 1 ? chapterPaths[0]! : '';
  let graph = buildBatchContextGraph(projectId, items, visiblePrecedingSegments, chapterPath,
    sourceRevisionId, String(context?.run?.targetLang || 'zh'), context?.run?.translationMode === 'literary');
  const graphRetrievalDiagnostics = mergeMemoryEntitiesIntoMappings(graph, temporalMemory, projectId,
    sourceRevisionId, items, visiblePrecedingSegments, String(context?.run?.targetLang || 'zh'));
  const voiceContext = context?.run?.translationMode === 'literary'
    ? buildProjectVoiceContext(
        temporalMemory,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath, kind: item.kind })),
        chapterPath || undefined,
        visiblePrecedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath, kind: item.kind })),
      ) as Record<string, any>
    : {};
  const pinnedMappings = mergePinnedProfileMappings(graph,
    Array.isArray((context as any)?.memory?.characterVoices) ? (context as any).memory.characterVoices : [],
    items, visiblePrecedingSegments);
  applyStyleGuide(graph, temporalMemory);
  // Graph chapter order is derived from source segment order and therefore is the canonical
  // boundary. Do not use memory-only summaries when chapter matching could be ambiguous.
  voiceContext.chapterSummaries = graph && chapterPath ? graph.chapterSummaries : [];

  const { componentDiagnostics, componentLargest } = measureBriefComponents(
    glossary, visiblePrecedingSegments, graph, voiceContext);

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
      characterProfileMappingConflictCount: pinnedMappings.conflictCount,
      graphMappingCandidatesBeforeBatchFilter: pinnedMappings.candidatesBeforeBatchFilter,
      graphMappingsExcludedNotMentioned: pinnedMappings.excludedNotMentioned,
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
      contextBudgetChars: strategy.contextBudgetChars,
      acceptedExampleBudgetChars: exampleBudgetChars,
      budgetTrimCount: Number((temporalMemory as any)?.__translationBriefDiagnostics?.acceptedExamplesTrimmedByBudget || 0),
      budgetFallbackUsed: false,
    },
    contextChars: 0,
    contextHash: '',
  };
  finalizeBriefDiagnostics(brief, temporalMemory, componentDiagnostics);
  // contextBudgetChars 是「建议预算」，不是硬约束：上下文证据不因提示词体积被删除。
  // 但它必须可见——否则用户改了配置、看到日志里写着 18000，却不知道实际发了 18750。
  const budgetExcess = strategy.contextBudgetChars > 0
    ? brief.contextChars - strategy.contextBudgetChars : 0;
  (brief.contextDiagnostics as any).contextBudgetExcessChars = budgetExcess > 0 ? budgetExcess : 0;
  logInfo('translation-brief', 'assembled · segments=' + brief.sourceSegmentIds.length +
    ' · chars=' + brief.contextChars +
    ' · graphMappings=' + (Array.isArray((brief.contextGraph as any)?.nameMappings) ? (brief.contextGraph as any).nameMappings.length : 0) +
    ' (strong=' + (Array.isArray((brief.contextGraph as any)?.nameMappings) ? (brief.contextGraph as any).nameMappings.filter((m: any) => ['confirmed','confirmed-memory','auto','run-canonical'].includes(String(m.sourceStatus))).length : 0) + ')' +
    ' · voiceEntities=' + (Array.isArray((brief.voiceContext as any)?.entities) ? (brief.voiceContext as any).entities.length : 0) +
    ' · voiceCharacters=' + (Array.isArray((brief.voiceContext as any)?.characterVoices) ? (brief.voiceContext as any).characterVoices.length : 0) +
    ' · preceding=' + brief.precedingSegments.length +
    ' · componentChars=' + componentLargest +
    (budgetExcess > 0 ? ' · 超建议预算=' + budgetExcess + '（未裁剪）' : ''));
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

// 对外入口仍是 translationBrief：消费方（翻译 Agent、两个 Reviewer、轨迹面板、测试）
// 不需要知道内部拆成了契约 / 源文引用 / 时间可见记忆三个模块。
export {
  MAX_ACCEPTED_EXAMPLES, MAX_ACCEPTED_EXAMPLE_CHARS, MAX_TRANSLATION_BRIEF_CHARS, TRANSLATION_BRIEF_POLICY_VERSION,
  type BriefSegment, type TranslationBrief,
} from './briefContract.ts';

/**
 * 解析真正可用的前文：按策略裁剪后回库补全 kind/contextPath。
 * 来自其他来源版本的过期 ID 会被丢弃——它不是本次 Run 的合法前文。
 */
function resolveVisiblePrecedingSegments(
  projectId: string,
  sourceRevisionId: string,
  selectedPrecedingSegments: BriefSegment[],
): BriefSegment[] {
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
  return visiblePrecedingSegments;
}

/**
 * 构造本批次的 Context Graph。整本书分析没有可用的图节点时，仍然返回一个空壳图，
 * 让显式术语表与有证据的记忆能继续合并进来；返回 null 会静默丢掉已确认的译名。
 */
function buildBatchContextGraph(
  projectId: string,
  items: BriefSegment[],
  visiblePrecedingSegments: BriefSegment[],
  chapterPath: string,
  sourceRevisionId: string,
  targetLang: string,
  literary: boolean,
): Record<string, any> | null {
  let graph = literary
    ? buildProjectContextGraphBundle(
        projectId,
        items.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        visiblePrecedingSegments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
        sourceRevisionId,
        targetLang,
      ) as Record<string, any> | null
    : null;
  if (literary && !graph) {
    // A book with no eligible Context Graph nodes can still have an explicit user glossary or
    // source-evidenced LiteraryMemory. The previous null result skipped that entire merge path,
    // so confirmed names silently disappeared from the actual translation request.
    graph = {
      policyVersion: 'context-graph-v6-default-adoption',
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
  return graph;
}

/** 记忆实体在本批次的时间可见性判定，实体循环里反复用到。 */
type MemoryVisibility = {
  db: any;
  revisionId: string;
  firstOrdinal: number;
  sourceText: string;
  /** 名字在批次开始时已经出现，或出现在本批原文里。 */
  sourceVisible(name: unknown): boolean;
  /** 别名同样要求边界可见，后文才出现的别名不得激活映射。 */
  aliasVisible(alias: unknown): boolean;
  /** 证据引文所属源段，带缓存；找不到返回 null。 */
  sourceRowFor(segmentId: unknown): { ordinal: number; text: string } | null;
};

/**
 * 把时间可见记忆里的实体合并进 Context Graph 的 nameMappings。
 * 用户确认的映射是权威条目：它覆盖同名候选，且在首次出现时就生效。
 */
function mergeMemoryEntitiesIntoMappings(
  graph: Record<string, any>,
  temporalMemory: Record<string, any>,
  projectId: string,
  sourceRevisionId: string,
  items: BriefSegment[],
  visiblePrecedingSegments: BriefSegment[],
  targetLang: string,
): Record<string, any> {
  const graphRetrievalDiagnostics = takeGraphRetrievalDiagnostics(graph);
  if (!graph || !Array.isArray(graph.nameMappings)) return graphRetrievalDiagnostics;

  // Do not feed generic titles or aliases belonging to another person back to the translator.
  graph.nameMappings = graph.nameMappings.flatMap((mapping: any) => {
    const source = typeof mapping?.source === 'string' ? mapping.source.trim() : '';
    const target = typeof mapping?.target === 'string' ? mapping.target.trim() : '';
    if (!source || !target || isGenericCanonicalSourceName(source)) return [];
    return [{ ...mapping, aliases: safeCanonicalSourceAliases(source, mapping.aliases) }];
  });

  const visibility = createMemoryVisibility(projectId, sourceRevisionId, items, visiblePrecedingSegments);
  const memoryEntities = Array.isArray((temporalMemory as any)?.entities) ? (temporalMemory as any).entities : [];
  for (const entity of memoryEntities) {
    const decided = decideMemoryMapping(entity, visibility, targetLang);
    if (!decided) continue;
    upsertNameMapping(graph, decided.incoming, decided.userConfirmedMapping);
  }
  rankNameMappings(graph, items, visiblePrecedingSegments);
  // Do not apply a count cap here. A later batch-scoped pass, after pinned profiles are
  // merged, removes mappings not mentioned in this batch or its configured preceding context.
  return graphRetrievalDiagnostics;
}

/** 取出并移除图上的检索诊断，避免它们被当成映射写进 Prompt。 */
function takeGraphRetrievalDiagnostics(graph: Record<string, any>): Record<string, any> {
  const diagnostics = (graph as any)?.retrievalDiagnostics &&
    typeof (graph as any).retrievalDiagnostics === 'object'
    ? { ...(graph as any).retrievalDiagnostics } : {};
  if (graph && Object.prototype.hasOwnProperty.call(graph, 'retrievalDiagnostics')) {
    delete (graph as any).retrievalDiagnostics;
  }
  return diagnostics;
}

/**
 * 建立本批次的可见性判定：边界 ordinal 由本批片段的源段位置决定，
 * 名字/引文的可见性一律以「边界之前出现过」或「就在本批原文里」为准。
 */
function createMemoryVisibility(
  projectId: string,
  sourceRevisionId: string,
  items: BriefSegment[],
  visiblePrecedingSegments: BriefSegment[],
): MemoryVisibility {
  const sourceText = [...visiblePrecedingSegments, ...items].map((item) => item.text).join('\n');
  const projectContext = getDocumentProjectStore().getProjectContext(projectId);
  const batchRows = projectContext.db.prepare(
    'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' +
      items.map(() => '?').join(',') + ')'
  ).all(sourceRevisionId, ...items.map((item) => item.id)) as Array<{ ordinal: number }>;
  const ordinals = batchRows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  const firstOrdinal = ordinals.length ? Math.min(...ordinals) : Number.POSITIVE_INFINITY;
  const sourceRowCache = new Map<string, { ordinal: number; text: string } | null>();
  const appearsBefore = (name: unknown) =>
    firstMatchingSourceOrdinal(projectContext.db, sourceRevisionId, name, 'name') < firstOrdinal;
  return {
    db: projectContext.db,
    revisionId: sourceRevisionId,
    firstOrdinal,
    sourceText,
    sourceVisible: (name) => appearsBefore(name) || sourceNameMatches(sourceText, name),
    aliasVisible: (alias) => appearsBefore(alias) || sourceNameMatches(sourceText, alias),
    sourceRowFor: (segmentId) => {
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
    },
  };
}

/**
 * 判断一条记忆实体能否进入本批映射，返回待写入的映射与「是否为用户确认」。
 * 四道判定依次是：译名质量、是否值得建映射、名字可见、证据可见。
 */
function decideMemoryMapping(
  entity: any,
  visibility: MemoryVisibility,
  targetLang: string,
): { incoming: Record<string, any>; userConfirmedMapping: boolean } | null {
  const source = String(entity?.source || '').trim();
  const target = String(entity?.target || '').trim();
  const evidence = String(entity?.evidence || '').trim();
  const rawAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  const userConfirmedMapping = entity.reviewStatus === 'confirmed' && entity.confirmationSource === 'user-confirmed';
  const entityKind = normalizeCanonicalEntityKind(entity.kind);
  if (!source || !target || !validateCanonicalTarget({ source, target, targetLang: targetLang, kind: entityKind }).valid) return null;
  if (!userConfirmedMapping && !isWorthCanonicalEntityMapping({
    source, kind: entityKind,
    significance: entity.description || entity.evidence,
    explicitBookSpecificMeaning: entity.bookSpecificMeaning === true,
  })) return null;
  const confirmedPersonMapping = entity.kind === 'person' && userConfirmedMapping;
  // A confirmed person name is a canonical mapping in 人物管理. Activate it only when the
  // canonical source or one of its aliases is visible; omit later-only aliases without suppressing
  // the whole translation name.
  if (!visibility.sourceVisible(source) && !rawAliases.some((alias: unknown) => visibility.sourceVisible(alias))) {
    return null;
  }
  const aliasesVisibleAtBoundary = rawAliases.every((alias: unknown) => visibility.aliasVisible(alias));
  // Inferred/non-person mappings remain fail-closed when any identity alias first appears later.
  if (!aliasesVisibleAtBoundary && !confirmedPersonMapping) return null;
  if (!isMemoryEvidenceVisible(entity, evidence, visibility, source, userConfirmedMapping)) return null;
  // The alias must be visible by the start of this batch or in its actual source text;
  // an alias first revealed in a later chapter still cannot activate the mapping.
  const aliases = rawAliases.filter((alias: unknown) => visibility.aliasVisible(alias));
  const targetRefs = Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : [];
  const corroboratedTarget = entity.targetConfidence === 'corroborated' &&
    new Set(targetRefs.map((ref: any) => ref?.segmentId).filter(Boolean)).size >= 2;
  return {
    incoming: {
      source, target, aliases,
      kind: String(entity.kind || 'other'),
      evidenceBacked: true,
      targetConfidence: userConfirmedMapping ? 'confirmed' :
        corroboratedTarget ? 'corroborated' : 'candidate',
      sourceStatus: userConfirmedMapping ? 'confirmed-memory' : corroboratedTarget ? 'auto' : 'candidate',
      confirmationSource: entity.confirmationSource || 'legacy-unknown',
    },
    userConfirmedMapping,
  };
}

/**
 * 证据可见性。用户确认的映射直接放行——它是一个「源名→译名」决定，不该因为出处是后文而消失；
 * 其余映射必须落在边界前的证据上，且引文要与源名对得上。
 * New dynamic memory has segment-specific provenance. Do not fall back to searching the
 * same quotation elsewhere in the book, because duplicate prose can predate the observation.
 */
function isMemoryEvidenceVisible(
  entity: any,
  evidence: string,
  visibility: MemoryVisibility,
  source: string,
  userConfirmedMapping: boolean,
): boolean {
  if (userConfirmedMapping) return true;
  const evidenceRefs = Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [];
  if (!evidenceRefs.length) {
    return !!evidence && (
      firstMatchingSourceOrdinal(visibility.db, visibility.revisionId, evidence, 'quote') < visibility.firstOrdinal ||
      normalizedSourceText(visibility.sourceText).includes(normalizedSourceText(evidence)));
  }
  return evidenceRefs.some((ref: any) => {
    const row = visibility.sourceRowFor(ref?.segmentId);
    return !!row && row.ordinal < visibility.firstOrdinal &&
      sourceQuoteMatches(row.text, ref?.sourceQuote) &&
      sourceNameMatches(ref.sourceQuote, source);
  });
}

/**
 * 写入一条映射：用户确认的覆盖同名条目并置顶；动态候选只在没有更强条目时替换。
 * A source-ordered dynamic candidate outranks an unconfirmed whole-book proposal,
 * but never a confirmed Context Graph mapping.
 */
function upsertNameMapping(
  graph: Record<string, any>,
  incoming: Record<string, any>,
  userConfirmedMapping: boolean,
): void {
  const names = new Set([incoming.source, ...incoming.aliases].map((name) => normalizedSourceText(name)));
  const index = graph.nameMappings.findIndex((mapping: any) =>
    [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])]
      .some((name: unknown) => names.has(normalizedSourceText(name))));
  if (userConfirmedMapping) {
    if (index >= 0) graph.nameMappings[index] = { ...graph.nameMappings[index], ...incoming };
    else graph.nameMappings.unshift(incoming);
    return;
  }
  if (index < 0) {
    graph.nameMappings.push(incoming);
    return;
  }
  const existing = graph.nameMappings[index];
  const existingStatus = String(existing?.sourceStatus || '');
  if (!['confirmed', 'confirmed-memory'].includes(existingStatus) &&
      (existingStatus !== 'run-canonical' || incoming.sourceStatus === 'auto')) {
    graph.nameMappings[index] = { ...existing, ...incoming };
  }
}

/** 排序：状态优先，其次本次正文命中，再次前文命中。稳定前缀越靠前，缓存越容易命中。 */
function rankNameMappings(
  graph: Record<string, any>,
  items: BriefSegment[],
  visiblePrecedingSegments: BriefSegment[],
): void {
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
}

/**
 * 合并 run 期间固定的角色画像：它们是人物管理里已校验的名字快照。
 * 与已确认映射冲突时不按数组顺序取胜，而是移除硬映射并把冲突写进 constraints。
 */
function mergePinnedProfileMappings(
  graph: Record<string, any>,
  pinnedProfiles: Array<Record<string, any>>,
  items: BriefSegment[],
  visiblePrecedingSegments: BriefSegment[],
): { conflictCount: number; candidatesBeforeBatchFilter: number; excludedNotMentioned: number } {
  let characterProfileMappingConflictCount = 0;
  let graphMappingCandidatesBeforeBatchFilter = 0;
  let graphMappingsExcludedNotMentioned = 0;
  if (graph) {
    const visibleSourceSegments = [...visiblePrecedingSegments, ...items];
    const isVisibleHere = (name: unknown) => typeof name === 'string' && name.trim() &&
      visibleSourceSegments.some((item) => sourceNameMatches(item.text, name));
    // Use the run-pinned, Store-validated profile snapshot for canonical names. Voice-context
    // retrieval deliberately requires earlier evidence, so using only its selected profiles would
    // make a confirmed name disappear when its supporting quote belongs to the current batch.
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
    const isVisibleInBatch = (name: unknown) => typeof name === 'string' && !!name.trim() &&
      [...visiblePrecedingSegments, ...items].some((item) => sourceNameMatches(item.text, name));
    graphMappingCandidatesBeforeBatchFilter = graph.nameMappings.length;
    graph.nameMappings = graph.nameMappings.flatMap((mapping: any) => {
      const source = typeof mapping?.source === 'string' ? mapping.source.trim() : '';
      const aliases = safeCanonicalSourceAliases(source, mapping?.aliases).filter(isVisibleInBatch);
      if (!isVisibleInBatch(source) && !aliases.length) return [];
      return [{ ...mapping, aliases }];
    });
    graphMappingsExcludedNotMentioned = graphMappingCandidatesBeforeBatchFilter - graph.nameMappings.length;
    graph.nameMappings.sort((a: any, b: any) => {
      const rank = (mapping: any) => {
        const names = [mapping.source, ...(Array.isArray(mapping.aliases) ? mapping.aliases : [])];
        const inCurrent = names.some((name: unknown) => items.some((item) => sourceNameMatches(item.text, name))) ? 2 : 0;
        const inPreceding = names.some((name: unknown) => visiblePrecedingSegments.some((item) =>
          sourceNameMatches(item.text, name))) ? 1 : 0;
        const statusRank = ['confirmed', 'confirmed-memory'].includes(String(mapping.sourceStatus)) ? 5 :
          mapping.sourceStatus === 'auto' ? 4 : mapping.sourceStatus === 'run-canonical' ? 3 : 1;
        return statusRank + inCurrent + inPreceding;
      };
      return rank(b) - rank(a);
    });
    // Retain every mapping actually mentioned in this batch or its visible preceding context.
    // A mapping for an unrelated person mentioned hundreds of pages earlier is retrieved again
    // when that name becomes relevant; it does not need to inflate every intervening request.
    if (characterProfileMappingConflictCount) {
      logInfo('translation-brief', 'confirmed character profile mapping conflicts=' + characterProfileMappingConflictCount);
    }
  }
  return {
    conflictCount: characterProfileMappingConflictCount,
    candidatesBeforeBatchFilter: graphMappingCandidatesBeforeBatchFilter,
    excludedNotMentioned: graphMappingsExcludedNotMentioned,
  };
}

/**
 * 应用文风基线：只补文风、语域、句法，绝不从中推断人物身份或剧情结论。
 */
function applyStyleGuide(graph: Record<string, any> | null, temporalMemory: Record<string, any>): void {
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
    graph.policyVersion = 'context-graph-v6-default-adoption';
    graph.constraints = [...(Array.isArray(graph.constraints) ? graph.constraints : []),
      'styleGuide 只约束文风、句法、语域和词汇选择；绝不可用它推断或补写人物身份、事件、秘密与剧情结论。'];
  }
}

/**
 * 统计各上下文组件的体积，用于诊断「哪一块撑大了请求」；只输出字数，不导出原文。
 */
function measureBriefComponents(
  glossary: unknown,
  visiblePrecedingSegments: BriefSegment[],
  graph: Record<string, any> | null,
  voiceContext: Record<string, any>,
): { componentDiagnostics: Record<string, any>; componentLargest: string } {
  // Size attribution is metadata-only: it lets diagnostics identify which retrieved
  // component dominates a prompt without exporting source, translation, or memory text.
  const jsonChars = (value: unknown) => JSON.stringify(value ?? null)?.length || 0;
  const sectionStats = (value: unknown) => {
    const chars = jsonChars(value);
    if (!Array.isArray(value)) return { chars, count: value && typeof value === 'object' ? Object.keys(value as object).length : 0 };
    const itemChars = value.map((item) => jsonChars(item)).sort((a, b) => a - b);
    return {
      chars, count: value.length,
      itemCharsTotal: itemChars.reduce((sum, item) => sum + item, 0),
      itemCharsMax: itemChars[itemChars.length - 1] || 0,
      itemCharsMedian: itemChars.length ? itemChars[Math.floor(itemChars.length / 2)] : 0,
    };
  };
  const componentDiagnostics = {
    glossary: sectionStats(glossary),
    precedingSegments: sectionStats(visiblePrecedingSegments),
    contextGraph: {
      chars: jsonChars(graph),
      sections: Object.fromEntries(Object.entries(graph || {}).map(([key, value]) => [key, sectionStats(value)] as const)),
    },
    voiceContext: {
      chars: jsonChars(voiceContext),
      sections: Object.fromEntries(Object.entries(voiceContext).map(([key, value]) => [key, sectionStats(value)] as const)),
    },
  };
  const componentLargest = [
    ['glossary', componentDiagnostics.glossary.chars],
    ['precedingSegments', componentDiagnostics.precedingSegments.chars],
    ['contextGraph', componentDiagnostics.contextGraph.chars],
    ['voiceContext', componentDiagnostics.voiceContext.chars],
  ].sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 4)
    .map(([key, chars]) => key + ':' + chars).join(',');
  return { componentDiagnostics, componentLargest };
}

/**
 * 填充预算相关诊断：全部为 0 是刻意的——检索到的证据不会为了满足建议预算被裁剪。
 */
function finalizeBriefDiagnostics(
  brief: TranslationBrief,
  temporalMemory: Record<string, any>,
  componentDiagnostics: Record<string, any>,
): void {
  // Do not prune retrieved context to satisfy a configured character budget. In particular,
  // never erase glossary terms, voice profiles, accepted examples, preceding dialogue, or confirmed
  // name mappings as an indirect consequence of a prompt-size heuristic. The runtime/provider owns
  // the actual model context-window check and should surface a real limit error without mutating evidence.
  const serialized = serializedContext(brief);
  (brief.contextDiagnostics as any).budgetTrimCount = Number((temporalMemory as any)?.__translationBriefDiagnostics?.acceptedExamplesTrimmedByBudget || 0);
  (brief.contextDiagnostics as any).budgetFallbackUsed = false;
  (brief.contextDiagnostics as any).contextBudgetPolicy = 'bounded-ranked-accepted-examples';
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
  diagnostic.acceptedExamplesTrimmedByBudget = Number((temporalMemory as any)?.__translationBriefDiagnostics?.acceptedExamplesTrimmedByBudget || 0);
  diagnostic.acceptedExamplesExcludedAsPreceding = Number((temporalMemory as any)?.__translationBriefDiagnostics?.acceptedExamplesExcludedAsPreceding || 0);
  diagnostic.acceptedExampleChars = Number((temporalMemory as any)?.__translationBriefDiagnostics?.acceptedExampleChars || 0);
  diagnostic.dialogueParticipantsAfterBudget = finalCount(finalVoice?.dialogueParticipants);
  diagnostic.dialogueParticipantsTrimmedByBudget = 0;
  diagnostic.chapterSummariesTrimmedByBudget = 0;
  diagnostic.precedingSegmentsAfterBudget = brief.precedingSegments.length;
  diagnostic.precedingSegmentsTrimmedByBudget = 0;
  diagnostic.glossaryTermsAfterBudget = finalCount((brief.glossary as any)?.document_terms);
  diagnostic.glossaryTermsTrimmedByBudget = 0;
  diagnostic.contextDeltaCandidatesAvailable = Math.max(0, Number(brief.contextDeltaCount || 0));
  diagnostic.contextComponents = componentDiagnostics;
  brief.contextChars = serialized.length;
  brief.contextHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
}
