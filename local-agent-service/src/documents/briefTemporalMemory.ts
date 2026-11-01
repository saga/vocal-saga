/**
 * 时间可见记忆：把整本书级别的 LiteraryMemory 裁剪成「当前批次可知道」的那一部分。
 *
 * 从 translationBrief 抽出：剧透防线全部集中在这里——实体、关系、角色声音、译例
 * 都要按源文 ordinal 边界过滤，任何一个字段漏过滤都会把后文剧情泄漏到前文。
 */
import { getDocumentProjectStore } from './projectStore.ts';
import {
  MAX_ACCEPTED_EXAMPLES, MAX_ACCEPTED_EXAMPLE_CHARS, type BriefSegment,
} from './briefContract.ts';
import {
  firstMatchingSourceOrdinal, normalizedSourceText, sourceNameMatches, sourceQuoteMatches,
} from './briefSourceContext.ts';

/**
 * 时间边界：当前批次「允许知道到哪里」的全部依据。
 *
 * 批次之前出现过的名字、引文与片段才能进入上下文；谓词与索引都挂在这个对象上，
 * 各个过滤阶段只读它，不各自去查库，保证所有字段用的是同一条边界。
 */
interface TemporalBoundary {
  db: any;
  revisionId: string;
  /** 当前批次第一个源段的 ordinal。 */
  firstOrdinal: number;
  items: BriefSegment[];
  precedingSegments: BriefSegment[];
  sourceById: Map<string, { ordinal: number; text: string; contextPath: string }>;
  /** 已采纳译文的最后版本，用于判断译名证据是否被后续人工修改推翻。 */
  latestAcceptedTranslationBySegment: Map<string, string>;
  /** 名字在批次边界之前出现过。 */
  appearedBefore(name: unknown): boolean;
  /** 该源段早于批次边界。 */
  isPrior(id: unknown): boolean;
  /** 这段引文在批次边界之前出现过（用于没有 segment 证据的旧版实体）。 */
  appearsAsEarlierEvidence(quote: unknown): boolean;
}

interface AcceptedExample {
  segmentId: string;
  source: string;
  target: string;
  chapter: string;
  origin: string;
}

interface AcceptedExampleRetrieval {
  retrievedExamples: AcceptedExample[];
  scoredExamples: Array<Record<string, any>>;
  acceptedExampleRows: Array<Record<string, any>>;
  currentChapters: Set<string>;
  currentTokens: Set<string>;
  candidateTerms: string[];
  recentOrdinalBoundary: number;
  retrievedExampleChars: number;
  acceptedExamplesExcludedAsPreceding: number;
  acceptedExamplesTrimmedByBudget: number;
}

export function buildTemporallyVisibleMemory(
  context: any,
  items: BriefSegment[],
  precedingSegments: BriefSegment[],
  exampleBudgetChars = MAX_ACCEPTED_EXAMPLE_CHARS,
): Record<string, any> {
  const base = loadTemporalBase(context, items);
  if (!base) return emptyTemporalMemory();
  const { db, revisionId, rows, firstOrdinal } = base;

  const rawMemory = prepareRunMemory(context, revisionId);
  const initialMemoryCounts = countMemoryEntries(rawMemory);
  const exclusionDiagnostics = createExclusionDiagnostics();
  const sourceById = loadSourceIndex(db, revisionId, rawMemory, precedingSegments, rows);
  const latestAcceptedTranslationBySegment = loadLatestAcceptedTranslations(db, revisionId, rawMemory);

  const boundary = createTemporalBoundary({
    db, revisionId, firstOrdinal, items, precedingSegments,
    sourceById, latestAcceptedTranslationBySegment,
  });
  const acceptedExamples = retrieveAcceptedExamples(boundary, rawMemory, exampleBudgetChars);
  rawMemory.entities = filterVisibleEntities(boundary, rawMemory.entities, exclusionDiagnostics);
  rawMemory.relationships = filterVisibleRelationships(boundary, rawMemory.relationships, exclusionDiagnostics);
  rawMemory.characterVoices = filterVisibleCharacterVoices(boundary, rawMemory.characterVoices, exclusionDiagnostics);
  applyVoiceRuleVisibility(rawMemory, boundary, sourceById);
  applyStyleGuideGate(rawMemory);

  // 全书级摘要与示例仍然排除在外，以守住时间上的情节边界。纯文风指南
  // 默认采纳；用户可以显式关掉生成出来的指南。
  rawMemory.chapterSummaries = [];
  rawMemory.recentExamples = acceptedExamples.retrievedExamples;
  rawMemory.openQuestions = [];
  // 声音上下文清洗器刻意不看这几个计数器；TranslationBrief 把它们抄进
  // 持久化诊断摘要，好让「零注入」和「边界排除」看得见。
  rawMemory.__translationBriefDiagnostics = buildBriefDiagnostics({
    exclusionDiagnostics, initialMemoryCounts, rawMemory, acceptedExamples, exampleBudgetChars,
  });
  return rawMemory;
}

/** 空记忆的规范形状：所有可注入字段都显式给出空值，调用方无需再判 undefined。 */
function emptyTemporalMemory(): Record<string, any> {
  return {
    version: 2, entities: [], relationships: [], styleGuide: {}, styleGuideStatus: 'candidate',
    chapterSummaries: [], recentExamples: [], characterVoices: [],
    relationshipVoiceRules: [], voiceAnchors: [], openQuestions: [],
  };
}

/**
 * 建立时间边界的必要输入：来源版本必须仍然存在，批次片段必须取得到 ordinal。
 * 任一条不成立就无法定义「之前」，返回 null 让调用方返回空记忆，绝不放行整本记忆。
 */
function loadTemporalBase(
  context: any,
  items: BriefSegment[],
): { db: any; revisionId: string; rows: any[]; firstOrdinal: number } | null {
  const projectId = String(context?.project?.projectId || '');
  const revisionId = String(context?.run?.sourceRevisionId || '');
  const projectContext = getDocumentProjectStore().getProjectContext(projectId);
  const sourceRevisionExists = !!revisionId && !!projectContext.db.prepare(
    'SELECT 1 FROM source_revisions WHERE revision_id = ?'
  ).get(revisionId);
  if (!projectId || !sourceRevisionExists || !items.length) return null;

  const rows = projectContext.db.prepare(
    'SELECT segment_id, ordinal, text, context_path FROM source_segments ' +
    'WHERE source_revision_id = ? AND segment_id IN (' + items.map(() => '?').join(',') + ') ' +
    'ORDER BY ordinal'
  ).all(revisionId, ...items.map((item) => item.id)) as any[];
  const itemOrdinals = rows.map((row) => Number(row.ordinal)).filter(Number.isFinite);
  if (!itemOrdinals.length) return null;
  // firstOrdinal 是当前批次第一个源段的 ordinal，作为时间边界基准。
  return { db: projectContext.db, revisionId, rows, firstOrdinal: Math.min(...itemOrdinals) };
}

/**
 * 取本轮的记忆工作副本，并按来源版本闸门处理中文编辑画像。
 * 画像只在来源版本匹配且未被拒绝时启用；机器默认采纳，证据仅作元数据。
 */
function prepareRunMemory(context: any, revisionId: string): Record<string, any> {
  const rawMemory = context?.memory && typeof context.memory === 'object'
    ? JSON.parse(JSON.stringify(context.memory)) as Record<string, any>
    : emptyTemporalMemory();
  const editorialProfile = rawMemory.chineseEditorialProfile;
  if (!editorialProfile || editorialProfile.status === 'rejected' ||
      editorialProfile.sourceRevisionId !== revisionId) {
    rawMemory.chineseEditorialProfile = null;
    return rawMemory;
  }
  // 机器生成的编辑档案默认采纳。证据只是元数据，不构成人工审批关卡。
  // 这类档案只用于文风，不是情节记忆。
  editorialProfile.status = 'confirmed';
  editorialProfile.confirmationSource = editorialProfile.confirmationSource || 'model-default';
  return rawMemory;
}

function countMemoryEntries(rawMemory: Record<string, any>): {
  entities: number; relationships: number; characterVoices: number;
} {
  return {
    entities: Array.isArray(rawMemory.entities) ? rawMemory.entities.length : 0,
    relationships: Array.isArray(rawMemory.relationships) ? rawMemory.relationships.length : 0,
    characterVoices: Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices.length : 0,
  };
}

/** 各阶段被时间边界排除的条数，最终原样并入 TranslationBrief 诊断。 */
function createExclusionDiagnostics(): Record<string, number> {
  return {
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
}

/** 记忆里被引用到的全部源段，加上当前批次的前文片段。 */
function collectReferencedSegmentIds(rawMemory: Record<string, any>, precedingSegments: BriefSegment[]): string[] {
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
  return Array.from(referencedIds);
}

/**
 * 一次取回所有被引用的源段。分批是因为 SQLite 的绑定变量数有上限，
 * 批次自身的片段最后覆盖，保证它们始终是真值。
 */
function loadSourceIndex(
  db: any,
  revisionId: string,
  rawMemory: Record<string, any>,
  precedingSegments: BriefSegment[],
  rows: any[],
): Map<string, { ordinal: number; text: string; contextPath: string }> {
  const ids = collectReferencedSegmentIds(rawMemory, precedingSegments);
  const sourceById = new Map<string, { ordinal: number; text: string; contextPath: string }>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const refRows = db.prepare(
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
  return sourceById;
}

/**
 * 译名证据对应的最新已采纳译文：用来识别「译名证据已被人工修改推翻」的旧实体。
 * 只查 targetEvidenceRefs 涉及的片段，不做全量扫描。
 */
function loadLatestAcceptedTranslations(
  db: any,
  revisionId: string,
  rawMemory: Record<string, any>,
): Map<string, string> {
  const targetEvidenceSegmentIds = Array.from(new Set(
    (Array.isArray(rawMemory.entities) ? rawMemory.entities : []).flatMap((entity: any) =>
      (Array.isArray(entity?.targetEvidenceRefs) ? entity.targetEvidenceRefs : [])
        .map((ref: any) => typeof ref?.segmentId === 'string' ? ref.segmentId : ''))
      .filter(Boolean)
  ));
  const latestAcceptedTranslationBySegment = new Map<string, string>();
  for (let offset = 0; offset < targetEvidenceSegmentIds.length; offset += 400) {
    const chunk = targetEvidenceSegmentIds.slice(offset, offset + 400);
    const acceptedRows = db.prepare(
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
  return latestAcceptedTranslationBySegment;
}

/** 把边界判定收成一个对象：所有过滤阶段共用它，边界规则只在这一处定义。 */
function createTemporalBoundary(input: {
  db: any;
  revisionId: string;
  firstOrdinal: number;
  items: BriefSegment[];
  precedingSegments: BriefSegment[];
  sourceById: Map<string, { ordinal: number; text: string; contextPath: string }>;
  latestAcceptedTranslationBySegment: Map<string, string>;
}): TemporalBoundary {
  const { db, revisionId, firstOrdinal, sourceById } = input;
  return {
    ...input,
    isPrior: (id: unknown) => {
      const source = typeof id === 'string' ? sourceById.get(id) : undefined;
      return !!source && Number.isFinite(source.ordinal) && source.ordinal < firstOrdinal;
    },
    appearedBefore: (nameInput: unknown): boolean =>
      firstMatchingSourceOrdinal(db, revisionId, nameInput, 'name') < firstOrdinal,
    appearsAsEarlierEvidence: (quoteInput: unknown): boolean =>
      firstMatchingSourceOrdinal(db, revisionId, quoteInput, 'quote') < firstOrdinal,
  };
}

/**
 * 关系声音规则与声音锚点：都要求说话双方已经通过声音过滤，且全部证据早于边界。
 * 场景相关的语域变化经常概括后文而没有片段级引文，因此这里一律清空。
 */
function applyVoiceRuleVisibility(
  rawMemory: Record<string, any>,
  boundary: TemporalBoundary,
  sourceById: Map<string, { ordinal: number; text: string; contextPath: string }>,
): void {
  const { isPrior, appearedBefore, firstOrdinal } = boundary;
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
      // 随场景而变的语域变化，常常在没有片段级引文的情况下概括了后面某段弧线。
      sceneDependentShift: '',
    }));
  rawMemory.voiceAnchors = (Array.isArray(rawMemory.voiceAnchors) ? rawMemory.voiceAnchors : []).filter((voiceAnchor: any) => {
    const source = sourceById.get(String(voiceAnchor?.segmentId || ''));
    return !!source && source.ordinal < firstOrdinal &&
      visibleCharacterIds.has(voiceAnchor.speakerId) && sourceQuoteMatches(source.text, voiceAnchor.source) &&
      sourceNameMatches(source.text, voiceAnchor.source);
  });
}

/**
 * 文风指南的数据开关：整本书级别、没有源文定位的字段不能放行，
 * 但只含风格规范且来自图谱/用户时默认生效——用户可以显式关闭。
 */
function applyStyleGuideGate(rawMemory: Record<string, any>): void {
  // 这些全书级字符串没有定位到源文位置的引文。不要让全书分析
  // 借「style」「example」「summary」这类字段名，把未来的情节事实漏进来。
  const styleGuideEnabled = rawMemory.styleGuideAutoDisabled !== true &&
    ['context-graph', 'user-edited', 'user-confirmed'].includes(String(rawMemory.styleGuideOrigin || ''));
  rawMemory.styleGuide = styleGuideEnabled ? rawMemory.styleGuide : {};
  rawMemory.styleGuideStatus = styleGuideEnabled ? 'confirmed' : 'candidate';
  rawMemory.styleGuideConfirmationSource = styleGuideEnabled
    ? rawMemory.styleGuideConfirmationSource || 'model-default' : undefined;
}

/** 诊断汇总：候选数、可见数、被边界排除数与译例预算，全部落到一个可持久化的对象上。 */
function buildBriefDiagnostics(input: {
  exclusionDiagnostics: Record<string, number>;
  initialMemoryCounts: { entities: number; relationships: number; characterVoices: number };
  rawMemory: Record<string, any>;
  acceptedExamples: AcceptedExampleRetrieval;
  exampleBudgetChars: number;
}): Record<string, any> {
  const { exclusionDiagnostics, initialMemoryCounts, rawMemory, acceptedExamples, exampleBudgetChars } = input;
  return {
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
    acceptedExampleCandidates: acceptedExamples.scoredExamples.length,
    acceptedExampleRowsRetrieved: acceptedExamples.acceptedExampleRows.length,
    acceptedExampleManualCandidates: acceptedExamples.acceptedExampleRows.filter((row) => row.origin === 'manual').length,
    acceptedExampleSameChapterCandidates: acceptedExamples.acceptedExampleRows.filter((row) => acceptedExamples.currentChapters.has(String(row.chapter || ''))).length,
    acceptedExampleRecentWindowCandidates: acceptedExamples.acceptedExampleRows.filter((row) => Number(row.ordinal) >= acceptedExamples.recentOrdinalBoundary).length,
    acceptedExampleCandidateTermCount: acceptedExamples.candidateTerms.length,
    acceptedExampleSourceTokenCount: acceptedExamples.currentTokens.size,
    selectedAcceptedExamples: acceptedExamples.retrievedExamples.length,
    acceptedExamplesInjected: acceptedExamples.retrievedExamples.length,
    acceptedExamplesExcludedAsPreceding: acceptedExamples.acceptedExamplesExcludedAsPreceding,
    acceptedExamplesTrimmedByBudget: acceptedExamples.acceptedExamplesTrimmedByBudget,
    acceptedExampleChars: acceptedExamples.retrievedExampleChars,
    acceptedExampleBudgetChars: Math.max(0, exampleBudgetChars),
  };
}

/** 检索停用词：只影响分词打分，不参与任何持久化。 */
const EXAMPLE_STOP_WORDS = new Set([
  'about','after','again','against','almost','also','among','another','around','because','before','being',
  'between','could','does','during','each','every','from','have','hers','himself','into','just','more',
  'most','other','over','same','should','some','such','than','that','their','them','then','there','these',
  'they','this','those','through','under','very','were','what','when','where','which','while','with','would',
  'your','you','the','and','for','are','was','were','but','not','you','his','her','she','him','our','out',
  'who','how','why','can','did','had','has','its','let','may','now','off','once','one','only','own','say',
  'said','see','too','two','all','any','day','get','got','new','old','way'
]);

/** 词面 token：2 字以上的字母数字串，去掉停用词。 */
function sourceTokens(value: unknown): Set<string> {
  return new Set(
    (normalizedSourceText(value).match(/[\p{L}\p{N}]{2,}/gu) || [])
      .filter((token) => !EXAMPLE_STOP_WORDS.has(token))
  );
}

/** 检索用的当前批次快照：词面、章节、体裁与可见人名，打分只依赖这些。 */
type ExampleRetrievalBase = {
  currentExampleSource: string;
  currentTokens: Set<string>;
  currentKinds: Set<string>;
  currentChapters: Set<string>;
  visibleReferenceNames: unknown[];
  currentChapterParams: string[];
  candidateTerms: string[];
  recentOrdinalBoundary: number;
};

/** 取数返回的一行已采纳译例。 */
type RawAcceptedExampleRow = {
  segmentId: string; ordinal: number; source: string; chapter: string; kind: string;
  target: string; origin: string; acceptedAt: string;
};

/** 打分后的一行译例：保留原始字段与命中信息，供排序与去重阶段共用。 */
type ScoredExampleRow = RawAcceptedExampleRow & {
  score: number; shared: number; exactPhrase: number; sharedNamedEntity: number; tokens: Set<string>;
};

/**
 * 检索可用的历史译例：只从「同一来源版本、已采纳、且早于批次」的记录里挑，
 * 再按词面重合度、同名实体、同章节、人工采纳与临近程度打分，最后做去重与字数预算裁剪。
 */
function retrieveAcceptedExamples(
  boundary: TemporalBoundary,
  rawMemory: Record<string, any>,
  exampleBudgetChars: number,
): AcceptedExampleRetrieval {
  const base = buildExampleRetrievalBase(boundary, rawMemory);
  const acceptedExampleRows = loadAcceptedExampleRows(boundary, base);
  const scoredExamples = scoreAcceptedExamples(acceptedExampleRows, base, boundary.firstOrdinal);
  const selection = selectRetrievedExamples(scoredExamples, boundary.precedingSegments, exampleBudgetChars);

  rawMemory.recentExamples = selection.retrievedExamples;
  rawMemory.__translationBriefDiagnostics = {
    ...(rawMemory.__translationBriefDiagnostics || {}),
    acceptedExamplesRetrieved: scoredExamples.length,
    acceptedExamplesInjected: selection.retrievedExamples.length,
    acceptedExamplesExcludedAsPreceding: selection.excludedAsPreceding,
    acceptedExamplesTrimmedByBudget: selection.trimmedByBudget,
    acceptedExampleChars: selection.retrievedExampleChars,
    acceptedExampleBudgetChars: Math.max(0, exampleBudgetChars),
  };

  return {
    retrievedExamples: selection.retrievedExamples,
    scoredExamples,
    acceptedExampleRows,
    currentChapters: base.currentChapters,
    currentTokens: base.currentTokens,
    candidateTerms: base.candidateTerms,
    recentOrdinalBoundary: base.recentOrdinalBoundary,
    retrievedExampleChars: selection.retrievedExampleChars,
    acceptedExamplesExcludedAsPreceding: selection.excludedAsPreceding,
    acceptedExamplesTrimmedByBudget: selection.trimmedByBudget,
  };
}

/** 当前批次的检索基准：词面、章节、体裁与「边界前出现过」的可见人名。 */
function buildExampleRetrievalBase(boundary: TemporalBoundary, rawMemory: Record<string, any>): ExampleRetrievalBase {
  const { firstOrdinal, items, precedingSegments, appearedBefore } = boundary;
  // 绝不要相信全书级的 recentExamples：示例要从已采纳译文台账里取，
  // 且钉死在本源文版本、严格早于当前批次。
  const currentExampleSource = [...precedingSegments, ...items].map((item) => String(item.text || '')).join(' ');
  const currentTokens = sourceTokens(currentExampleSource);
  const currentKinds = new Set(items.map((item) => String(item.kind || '')).filter(Boolean));
  const currentChapters = new Set(items.map((item) => String(item.contextPath || '')).filter(Boolean));
  const visibleReferenceNames = [
    ...(Array.isArray(rawMemory.entities) ? rawMemory.entities.flatMap((entity: any) =>
      [entity?.source, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])]) : []),
    ...(Array.isArray(rawMemory.characterVoices) ? rawMemory.characterVoices.flatMap((profile: any) =>
      [profile?.canonicalSourceName, ...(Array.isArray(profile?.aliases) ? profile.aliases : [])]) : []),
  ].filter((name: unknown) => typeof name === 'string' && appearedBefore(name));
  return {
    currentExampleSource,
    currentTokens,
    currentKinds,
    currentChapters,
    visibleReferenceNames,
    currentChapterParams: Array.from(currentChapters),
    candidateTerms: Array.from(currentTokens)
      .filter((token) => token.length >= 3)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .slice(0, 12),
    recentOrdinalBoundary: Math.max(0, firstOrdinal - 250),
  };
}

/**
 * 候选译例的取数：只取同一来源版本、最新一条已采纳、且 ordinal 早于边界的记录。
 * 命中共四类——近期窗口、当前章节、人工采纳、与当前原文有区分度词面重合。
 * 让检索保持有界，但不只依赖固定的「最近 N 条示例」窗口：要纳入近期已采纳的工作、
 * 当前章节、人工采纳过的示例，以及命中少量当前源文特征词的记录。
 * 下面的打分排序仍然是权威。查询结果钉死在不可变源文版本与对应的已采纳行上。
 */
function loadAcceptedExampleRows(boundary: TemporalBoundary, base: ExampleRetrievalBase): RawAcceptedExampleRow[] {
  const { db, revisionId, firstOrdinal } = boundary;
  const { currentChapterParams, candidateTerms, recentOrdinalBoundary } = base;
  const candidateClauses = [
    's.ordinal >= ?',
    ...(currentChapterParams.length ? ['s.context_path IN (' + currentChapterParams.map(() => '?').join(',') + ')'] : []),
    "tr.origin = 'manual'",
    ...candidateTerms.map(() => 'instr(lower(s.text), lower(?)) > 0'),
  ];
  return db.prepare(
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
  ) as RawAcceptedExampleRow[];
}

/** 打分：词面重合度为主，完全包含原文短语、同名实体、同章节、人工采纳与临近程度各自加权。 */
function scoreAcceptedExamples(
  acceptedExampleRows: RawAcceptedExampleRow[],
  base: ExampleRetrievalBase,
  firstOrdinal: number,
): ScoredExampleRow[] {
  const { currentExampleSource, currentTokens, currentKinds, currentChapters, visibleReferenceNames } = base;
  return acceptedExampleRows.map((row) => {
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
}

/**
 * 去重与预算裁剪：高度重合的译例只会重复同一份证据，挤掉真正有用的风格样本。
 * 与已选译例词面高度重合、且既不同名实体也不完全包含原文的，直接跳过。
 */
function selectRetrievedExamples(
  scoredExamples: ScoredExampleRow[],
  precedingSegments: BriefSegment[],
  exampleBudgetChars: number,
): {
  retrievedExamples: AcceptedExample[];
  retrievedExampleChars: number;
  excludedAsPreceding: number;
  trimmedByBudget: number;
} {
  // 选一组紧凑而多样的示例，而不是把每一条历史命中都注入。高度重叠的示例
  // 往往只是在重复同一份证据，还挤掉了真正有用的文风多样性。
  const retrievedExamples: AcceptedExample[] = [];
  const selectedExampleTokens: Set<string>[] = [];
  const selectedPrecedingIds = new Set(precedingSegments.map((segment) => segment.id));
  let retrievedExampleChars = 0;
  let excludedAsPreceding = 0;
  let trimmedByBudget = 0;
  for (const row of scoredExamples) {
    const source = String(row.source || '');
    const target = String(row.target || '');
    if (!source || !target) continue;
    if (selectedPrecedingIds.has(String(row.segmentId))) {
      excludedAsPreceding++;
      continue;
    }
    const tokens = row.tokens;
    const redundant = selectedExampleTokens.some((selected) => {
      if (!tokens.size || !selected.size) return false;
      const intersection = Array.from(tokens).filter((token) => selected.has(token)).length;
      const union = tokens.size + selected.size - intersection;
      return intersection / Math.max(1, union) >= 0.85;
    });
    if (redundant && row.sharedNamedEntity === 0 && row.exactPhrase === 0) continue;
    const example = {
      segmentId: String(row.segmentId), source, target,
      chapter: String(row.chapter || '').slice(0, 120),
      origin: ['manual', 'agent', 'imported'].includes(String(row.origin)) ? String(row.origin) : 'imported',
    };
    const exampleChars = JSON.stringify(example).length;
    if (retrievedExamples.length >= MAX_ACCEPTED_EXAMPLES ||
        retrievedExampleChars + exampleChars + (retrievedExamples.length ? 1 : 2) > Math.max(0, exampleBudgetChars)) {
      trimmedByBudget++;
      continue;
    }
    retrievedExamples.push(example);
    retrievedExampleChars += exampleChars;
    selectedExampleTokens.push(tokens);
  }
  return { retrievedExamples, retrievedExampleChars, excludedAsPreceding, trimmedByBudget };
}

/**
 * 过滤实体：名称或别名尚未在批次边界前出现、且证据早于/晚于边界的，一律丢弃。
 * 用户确认过的人名映射是例外——它在人物管理里是权威条目，只裁掉后文才出现的别名。
 */
function filterVisibleEntities(
  boundary: TemporalBoundary,
  entities: unknown,
  exclusionDiagnostics: Record<string, number>,
): any[] {
  const { isPrior, appearedBefore, appearsAsEarlierEvidence, items, sourceById, latestAcceptedTranslationBySegment, firstOrdinal } = boundary;
  return (Array.isArray(entities) ? entities : []).flatMap((entity: any) => {
    // 用户明确拒绝过的实体，必须从 TranslationBrief 的每一个下游投影里移除，
    // 而不只是从可见的 voiceContext 字段里去掉。
    if (!entity || entity.reviewStatus === 'rejected') return [];
    const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
    const evidenceRefs = Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [];
    const userConfirmedMapping = entity?.reviewStatus === 'confirmed' && ['user-confirmed', 'user-modified'].includes(String(entity?.confirmationSource || ''));
    const confirmedPersonMapping = entity?.kind === 'person' && userConfirmedMapping;
    // 推断出来的身份仍然失败关闭：只要出现仅在后面才露出的别名就不注入。
    // 但用户确认过的人物译名是「人物管理」里的权威条目：只要其源名已经可见就保留，
    // 只摘掉后面章节才首次揭示的别名。
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
      // 如果这个源文片段此后已被采纳或编辑过，旧的候选面就不能继续把更正后的译名顶上去。
      // 还没有已采纳结果时，保留本轮校验过的候选面作为暂定值，
      // 而不是把它当成已人工审校的结果。
      if (latestAcceptedTranslation !== undefined &&
          !normalizedSourceText(latestAcceptedTranslation).includes(normalizedSourceText(ref.targetSurface))) {
        exclusionDiagnostics.targetEvidenceExcludedAfterAcceptedCorrection++;
        return false;
      }
      return true;
    });
    const independentTargetEvidenceCount = new Set(visibleTargetEvidence.map((ref: any) => ref.segmentId)).size;
    const targetConfidence = independentTargetEvidenceCount >= 2 ? 'corroborated' : 'candidate';
    // 动态候选会保留精确的源文与译文证据片段；单凭源名识别，
    // 还不足以让提议的译名变成强制的规范映射。
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
}

/** 过滤关系：两端名称都必须在边界前出现过，证据同样要早于边界。 */
function filterVisibleRelationships(
  boundary: TemporalBoundary,
  relations: unknown,
  exclusionDiagnostics: Record<string, number>,
): any[] {
  const { isPrior, appearedBefore, sourceById } = boundary;
  return (Array.isArray(relations) ? relations : []).flatMap((relation: any) => {
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
    // 关系分析默认采纳。只保留本批次之前已经可见的名字；
    // 证据质量作为元数据保留，绝不要求读者去批准它。
    return [{
      ...relation,
      reviewStatus: relation.reviewStatus === 'rejected' ? 'rejected' : 'confirmed',
      ...(evidenceRefs.length ? { evidenceRefs: priorEvidenceRefs } : {}),
    }].filter((item: any) => item.reviewStatus !== 'rejected');
  });
}

/**
 * 过滤角色声音：证据被截断、含后文证据、名字或别名尚未出现的画像整体丢弃；
 * 保留下来的画像只留边界前的证据与对照规则。
 */
function filterVisibleCharacterVoices(
  boundary: TemporalBoundary,
  profiles: any[],
  exclusionDiagnostics: Record<string, number>,
): any[] {
  const { isPrior, appearedBefore, sourceById, firstOrdinal } = boundary;
  return (Array.isArray(profiles) ? profiles : []).flatMap((profile: any) => {
    const rawEvidence = Array.isArray(profile.evidence) ? profile.evidence : [];
    // 旧版的截断档案可能已经丢掉了那些贡献到 voiceCore 的未来日期行。
    // 因此一个被截断的聚合结果，不能安全地在更早的章节里部分复用。
    const evidenceTruncated = profile.evidenceTruncated === true ||
      (profile.evidencePolicyVersion !== 'character-evidence-v2-complete' && rawEvidence.length >= 8);
    if (evidenceTruncated) {
      exclusionDiagnostics.characterVoiceExcludedIncompleteEvidence++;
      return [];
    }
    const hasFutureEvidence = rawEvidence.some((item: any) => {
      const source = typeof item?.segmentId === 'string' ? sourceById.get(item.segmentId) : undefined;
      return !!source && Number(source.ordinal) >= firstOrdinal;
    });
    if (hasFutureEvidence) {
      // 聚合出来的 voiceCore 可能包含后文对白；绝不把它漏进更早的批次。
      exclusionDiagnostics.characterVoiceExcludedFutureEvidence++;
      return [];
    }
    // 证据不完整或不完美只降低可追溯性，不影响是否采纳。保留有效的前文示例，
    // 直接用模型当前的最佳档案，而不是等某个人点确认。
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
      return ids.length > 0 && ids.every(isPrior) && profiles.some((other: any) =>
        other.characterId === rule.otherCharacterId && appearedBefore(other.canonicalSourceName) &&
        (Array.isArray(other.aliases) ? other.aliases : []).every((alias: unknown) => appearedBefore(alias)));
    }).map((rule: any) => ({ ...rule, evidenceSegmentIds: rule.evidenceSegmentIds.filter(isPrior) }));
    return [{ ...profile, status: profile.status === 'rejected' ? 'rejected' : 'confirmed',
      confirmationSource: profile.confirmationSource || 'model-default',
      useForTranslation: profile.status !== 'rejected' && profile.useForTranslation !== false,
      aliases, evidence: usableEvidence, contrastRules }];
  });
}

