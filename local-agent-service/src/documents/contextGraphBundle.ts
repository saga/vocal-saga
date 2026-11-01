/**
 * 翻译请求侧的 Context Graph 快照：按批次取出名称映射、人物、关系与近两章摘要。
 *
 * 从 contextGraph 抽出：这是分析与翻译之间唯一的接缝，只读不写，
 * 单独成模块后批次检索的边界规则可以独立审阅。
 */

import { logInfo } from '../log.ts';
import { isWorthCanonicalEntityMapping, validateCanonicalTarget } from './canonicalEntityPolicy.ts';
import {
  allSourceSegments,
  extractiveSummary,
  getMeta,
  graphContext,
  normalize,
  safeText,
  selectRecentPriorChapterSummaries,
  sourceNameMatches,
  uniqueStrings,
} from './contextGraphStore.ts';
import { CONTEXT_GRAPH_ANALYSIS_VERSION, ensureSourceFeatureIndexInDatabase } from './contextGraphSchema.ts';

/**
 * 为一个翻译批次构建按时间边界过滤的 Context Graph 子集。
 * 节点/边/别名/关系证据必须全部早于当前批次首个 segment；
 * 章节摘要仅取前两章完整摘要与当前章节前缀摘要；
 * 规范名称映射在当前/前文可见且有证据时才暴露；
 * 该函数只检索上下文，不修改图谱事实。
 */
export function buildProjectContextGraphBundle(
  projectId: string,
  items: Array<{ id: string; text: string; contextPath?: string }>,
  precedingSegments: Array<{ id: string; text: string; contextPath?: string }> = [],
  sourceRevisionId?: string,
  targetLang?: string,
): Record<string, unknown> | null {
  const { db, revisionId } = graphContext(projectId, sourceRevisionId);
  ensureSourceFeatureIndexInDatabase(projectId, db, revisionId);
  const sourceText = [...precedingSegments, ...items].map((item) => item.text).join('\n');
  const normalizedSource = normalize(sourceText);
  if (!normalizedSource) return null;
  // Fail closed at the start of the batch. A graph fact is eligible only when every stored
  // evidence segment precedes the first segment of this batch. The current source always wins.
  const firstOrdinal = items.reduce((minimum, item) => {
    const row = db.prepare(
      'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
    ).get(revisionId, item.id) as { ordinal?: number } | undefined;
    return typeof row?.ordinal === 'number' ? Math.min(minimum, row.ordinal) : minimum;
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(firstOrdinal)) return null;
  const knowledgeBoundary = firstOrdinal - 1;
  const currentMemoryRevision = db.prepare(
    "SELECT value FROM project_meta WHERE key = 'current_literary_memory_revision_id'"
  ).get() as { value?: string } | undefined;
  const currentMemoryRow = currentMemoryRevision?.value
    ? db.prepare('SELECT memory_json FROM literary_memory_revisions WHERE memory_revision_id = ?')
        .get(currentMemoryRevision.value) as { memory_json?: string } | undefined
    : undefined;
  let memoryRejections: any[] = [];
  try {
    const parsedMemory = currentMemoryRow?.memory_json ? JSON.parse(currentMemoryRow.memory_json) : {};
    memoryRejections = Array.isArray(parsedMemory?.rejectedItems) ? parsedMemory.rejectedItems : [];
  } catch { memoryRejections = []; }
  const rejectedEntityTombstones = memoryRejections.filter((item) => item?.type === 'entity');
  const rejectedRelationshipTombstones = memoryRejections.filter((item) => item?.type === 'relationship');
  const graphNodeRows = db.prepare(
    "SELECT * FROM context_graph_nodes WHERE source_revision_id = ? AND status IN ('candidate', 'confirmed')"
  ).all(revisionId) as any[];
  const graphNodesById = new Map(graphNodeRows.map((row) => [row.node_id, row]));
  const nodeNames = (row: any): string[] => {
    let attributes: any = {};
    try { attributes = JSON.parse(row.attributes_json || '{}'); } catch { attributes = {}; }
    return [row.name, attributes.sourceName, attributes.canonicalName,
      ...(Array.isArray(attributes.aliases) ? attributes.aliases : [])]
      .map((name) => normalize(name)).filter(Boolean);
  };
  const isRejectedGraphNode = (row: any): boolean => {
    let attributes: any = {};
    try { attributes = JSON.parse(row.attributes_json || '{}'); } catch { attributes = {}; }
    const kind = normalize(row.kind === 'character' ? 'person' : (attributes.entityKind || 'other'));
    const names = new Set(nodeNames(row));
    return rejectedEntityTombstones.some((tombstone) => {
      const rejectedKind = normalize(tombstone.kind || 'other');
      const kindMatches = rejectedKind === kind || rejectedKind === 'other' || kind === 'other';
      const rejectedNames = [tombstone.source, ...(Array.isArray(tombstone.aliases) ? tombstone.aliases : [])]
        .map((name) => normalize(name)).filter(Boolean);
      return kindMatches && rejectedNames.some((name) => names.has(name));
    });
  };
  const isRejectedGraphEdge = (edge: any): boolean => {
    const source = graphNodesById.get(edge.source_node_id);
    const target = graphNodesById.get(edge.target_node_id);
    if (!source || !target) return false;
    const sourceNames = new Set(nodeNames(source));
    const targetNames = new Set(nodeNames(target));
    let attributes: any = {};
    try { attributes = JSON.parse(edge.attributes_json || '{}'); } catch { attributes = {}; }
    const rawKind = normalize(edge.kind);
    const predicate = normalize(attributes.predicate ||
      (['relation', 'relationship', 'observed-association'].includes(rawKind) ? '' : edge.kind));
    return rejectedRelationshipTombstones.some((tombstone) => {
      const subjectMatches = sourceNames.has(normalize(tombstone.subject));
      const objectMatches = targetNames.has(normalize(tombstone.object));
      const predicateMatches = !predicate || predicate === normalize(tombstone.predicate);
      return subjectMatches && objectMatches && predicateMatches;
    });
  };
  const visibleNodeRows = db.prepare(
    'SELECT e.node_id FROM context_graph_evidence e ' +
    'JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
    'WHERE e.source_revision_id = ? AND e.node_id IS NOT NULL ' +
    'GROUP BY e.node_id HAVING COUNT(*) > 0 AND MAX(s.ordinal) <= ?'
  ).all(revisionId, knowledgeBoundary) as Array<{ node_id: string }>;
  const visibleNodeIds = new Set(visibleNodeRows.map((row) => row.node_id));
  const visibleEdgeRows = db.prepare(
    'SELECT e.edge_id FROM context_graph_evidence e ' +
    'JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
    'WHERE e.source_revision_id = ? AND e.edge_id IS NOT NULL ' +
    'GROUP BY e.edge_id HAVING COUNT(*) > 0 AND MAX(s.ordinal) <= ?'
  ).all(revisionId, knowledgeBoundary) as Array<{ edge_id: string }>;
  const visibleEdgeIds = new Set(visibleEdgeRows.map((row) => row.edge_id));
  const nameBeforeCache = new Map<string, boolean>();
  const sourceRows = allSourceSegments(db, revisionId);
  const appearedBefore = (nameInput: unknown): boolean => {
    const name = normalize(nameInput);
    if (!name || name.length < 2) return false;
    const cached = nameBeforeCache.get(name);
    if (cached !== undefined) return cached;
    const matched = sourceRows.some((row) =>
      Number(row.ordinal) < firstOrdinal && sourceNameMatches(row.text, nameInput));
    nameBeforeCache.set(name, matched);
    return matched;
  };
  const quoteMentions = (quoteInput: unknown, nameInput: unknown): boolean =>
    sourceNameMatches(quoteInput, nameInput);
  const nodes = (db.prepare(
    'SELECT * FROM context_graph_nodes WHERE source_revision_id = ? AND status IN (\'candidate\', \'confirmed\') ORDER BY kind, name'
  ).all(revisionId) as any[]).filter((row) =>
    visibleNodeIds.has(row.node_id) && !isRejectedGraphNode(row) && appearedBefore(row.name));
  const matched: Array<{ row: any; score: number; attributes: any }> = [];
  for (const row of nodes) {
    let attributes: any = {};
    try { attributes = JSON.parse(row.attributes_json); } catch { attributes = {}; }
    if (targetLang && safeText(attributes.suggestedTranslation, 120) && attributes.targetLang !== targetLang) continue;
    const safeAliases = (Array.isArray(attributes.aliases) ? attributes.aliases : [])
      .filter((alias: unknown) => appearedBefore(alias));
    const names = [row.name, ...safeAliases].map(normalize).filter(Boolean);
    let score = 0;
    for (const name of names) {
      if (name.length < 2) continue;
      const hit = /^[a-z0-9 _.'’-]+$/i.test(name)
        ? (' ' + normalizedSource.replace(/[^a-z0-9]+/gi, ' ') + ' ').includes(' ' + name.replace(/[^a-z0-9]+/gi, ' ').trim() + ' ')
        : normalizedSource.includes(name);
      if (hit) score += name === normalize(row.name) ? 4 : 2;
    }
    if (score) matched.push({ row, score, attributes });
  }
  matched.sort((a, b) => b.score - a.score);
  const characters = matched.filter((item) => item.row.kind === 'character').slice(0, 4);
  const entities = matched.filter((item) => item.row.kind === 'entity').slice(0, 8);
  const selectedNodes = [...characters, ...entities];
  const selectedIds = new Set(selectedNodes.map((item) => item.row.node_id));
  const selectedAttributes = (item: { row: any; attributes: any }) => ({
    id: item.row.node_id,
    name: item.row.name,
    status: item.row.status,
    // Only aliases whose canonical spelling has appeared before this batch are safe.
    // Do not inject free-text role/traits/significance/suggested translations from book-wide
    // analysis: those fields may encode a later identity reveal despite an earlier citation.
    aliases: (Array.isArray(item.attributes.aliases) ? item.attributes.aliases : [])
      .filter((alias: unknown) => appearedBefore(alias)),
    entityKind: item.row.kind === 'character' ? 'character' : 'entity',
    evidence: (db.prepare(
      'SELECT e.segment_id AS segmentId, e.quote FROM context_graph_evidence e ' +
      'JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
      'WHERE e.source_revision_id = ? AND e.node_id = ? AND s.ordinal <= ? ORDER BY s.ordinal'
    ).all(revisionId, item.row.node_id, knowledgeBoundary) as any[])
      .filter((evidence) => [item.row.name, ...(Array.isArray(item.attributes.aliases) ? item.attributes.aliases : [])]
        .filter((name: unknown) => appearedBefore(name))
        .some((name: unknown) => quoteMentions(evidence.quote, name)))
      .slice(0, 2).map((row) => ({ segmentId: row.segmentId, quote: row.quote })),
  });
  const edges = (db.prepare(
    'SELECT * FROM context_graph_edges WHERE source_revision_id = ? AND status IN (\'candidate\', \'confirmed\')'
  ).all(revisionId) as any[]).filter((edge) =>
    visibleEdgeIds.has(edge.edge_id) && !isRejectedGraphEdge(edge));
  const selectedById = new Map(selectedNodes.map((item) => [item.row.node_id, item]));
  const relationships = edges.filter((edge) => selectedIds.has(edge.source_node_id) && selectedIds.has(edge.target_node_id))
    .flatMap((edge) => {
      const sourceNode = selectedById.get(edge.source_node_id) as any;
      const targetNode = selectedById.get(edge.target_node_id) as any;
      const evidenceRows = db.prepare(
        'SELECT e.segment_id AS segmentId, e.quote FROM context_graph_evidence e ' +
        'JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
        'WHERE e.source_revision_id = ? AND e.edge_id = ? AND s.ordinal <= ? ORDER BY s.ordinal'
      ).all(revisionId, edge.edge_id, knowledgeBoundary) as any[];
      const grounded = evidenceRows.find((evidence) => {
        const sourceNames = [sourceNode.row.name, ...(Array.isArray(sourceNode.attributes.aliases) ? sourceNode.attributes.aliases : [])]
          .filter((name: unknown) => appearedBefore(name));
        const targetNames = [targetNode.row.name, ...(Array.isArray(targetNode.attributes.aliases) ? targetNode.attributes.aliases : [])]
          .filter((name: unknown) => appearedBefore(name));
        return sourceNames.some((name: unknown) => quoteMentions(evidence.quote, name)) &&
          targetNames.some((name: unknown) => quoteMentions(evidence.quote, name));
      });
      if (!grounded) return [];
      // A coarse association marker carries less semantic information than full-book relation
      // descriptions/voice rules; those free-text fields have no per-claim temporal citations.
      return [{
        sourceNodeId: edge.source_node_id,
        targetNodeId: edge.target_node_id,
        kind: 'observed-association',
        status: edge.status,
        confidence: 'candidate',
        evidence: [{ segmentId: grounded.segmentId, quote: grounded.quote }],
      }];
    }).slice(0, 6);

  const contextPaths = Array.from(new Set(items.map((item) => item.contextPath).filter(Boolean))) as string[];
  const currentChapter = contextPaths[0] || '';
  const chapterRows = db.prepare(
    'SELECT chapter_key, chapter_order, chapter_title, summary, summary_kind FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order'
  ).all(revisionId) as any[];
  const currentIndex = chapterRows.findIndex((chapter) =>
    normalize(chapter.chapter_key) === normalize(currentChapter) || normalize(chapter.chapter_title) === normalize(currentChapter));
  // Only complete summaries for previous chapters are eligible. A full summary of the current
  // chapter can include its final paragraph, which is future context when translating early batches.
  const priorChapterSummaries = selectRecentPriorChapterSummaries(chapterRows, currentIndex);
  const currentPrefixRows = currentIndex >= 0 && currentChapter
    ? db.prepare(
        'SELECT segment_id, ordinal, text, kind FROM source_segments ' +
        'WHERE source_revision_id = ? AND context_path = ? AND ordinal < ? ORDER BY ordinal DESC'
      ).all(revisionId, currentChapter, firstOrdinal) as any[]
    : [];
  const currentPrefixSegments = currentPrefixRows.reverse().map((row) => ({
    id: String(row.segment_id), ordinal: Number(row.ordinal), text: String(row.text),
    kind: String(row.kind || 'paragraph'), contextPath: currentChapter,
  }));
  const currentPrefixSummary = currentPrefixSegments.length
    ? extractiveSummary(currentPrefixSegments)
    : '';
  const chapterSummaries = [
    ...priorChapterSummaries,
    ...(currentPrefixSummary ? [{
      chapter: currentChapter,
      summary: currentPrefixSummary,
      summaryKind: 'prefix-extractive',
    }] : []),
  ];

  // Canonical proper-name mappings are a special, non-narrative part of the graph. A name
  // and its target translation may be reused as a glossary even when the supporting quote is
  // later in the book; only mappings whose canonical source name is already visible in the
  // current/preceding source are exposed. No future aliases, role descriptions, relationships,
  // or plot facts are included here.
  const namesInContext = sourceText;
  const priorNamesInContext = precedingSegments.map((item) => item.text).join('\n');
  const appearsInPriorContext = (value: unknown): boolean => {
    const name = normalize(value);
    if (!name || name.length < 2) return false;
    if (/^[a-z0-9 ._'’ -]+$/i.test(name)) {
      const haystack = ' ' + normalize(priorNamesInContext).replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
      const needle = name.replace(/[^a-z0-9]+/gi, ' ').trim();
      return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
    }
    return normalize(priorNamesInContext).includes(name);
  };
  const appearsInContext = (value: unknown): boolean => {
    const name = normalize(value);
    if (!name || name.length < 2) return false;
    if (/^[a-z0-9 ._'’ -]+$/i.test(name)) {
      const haystack = ' ' + normalize(namesInContext).replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
      const needle = name.replace(/[^a-z0-9]+/gi, ' ').trim();
      return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
    }
    return normalize(namesInContext).includes(name);
  };
  // Only earlier accepted translations can corroborate a character's proposed target.
  // This gate prevents a book-wide target from revealing an identity disclosed in later chapters.
  // Character targets can reveal identities disclosed later in the book. This is a temporal
  // knowledge boundary, not a human approval gate: use the model-default target once an earlier
  // accepted translation has established it, but do not leak later identity reveals backwards.
  const priorAcceptedTranslations = db.prepare(
    'SELECT s.segment_id AS segmentId, s.text AS source, s.ordinal, tr.translation_text AS target ' +
    'FROM translation_results tr JOIN source_segments s ' +
      'ON s.source_revision_id = tr.source_revision_id AND s.segment_id = tr.segment_id ' +
    'WHERE tr.source_revision_id = ? AND tr.accepted = 1 AND tr.source_hash = s.source_hash AND s.ordinal < ? ' +
      'AND tr.rowid = (SELECT latest.rowid FROM translation_results latest ' +
        'WHERE latest.source_revision_id = s.source_revision_id AND latest.segment_id = s.segment_id ' +
          'AND latest.accepted = 1 AND latest.source_hash = s.source_hash ' +
        'ORDER BY COALESCE(latest.accepted_at, latest.created_at) DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1) ' +
    'ORDER BY s.ordinal DESC'
  ).all(revisionId, firstOrdinal) as Array<{ segmentId: string; source: string; ordinal: number; target: string }>;
  const graphNameRows = (db.prepare(
    `SELECT * FROM context_graph_nodes WHERE source_revision_id = ? AND status IN ('candidate', 'confirmed') ORDER BY kind, name`
  ).all(revisionId) as any[]).filter((row) => !isRejectedGraphNode(row));
  const nameMappingDiagnostics = {
    graphNameMappingCandidates: graphNameRows.length,
    graphNameMappingExcludedNameNotVisible: 0,
    graphNameMappingExcludedAliasBoundary: 0,
    graphNameMappingExcludedEvidenceNotVisible: 0,
    graphNameMappingExcludedInvalidTarget: 0,
    graphNameMappingExcludedTargetNotPreviouslyAccepted: 0,
    graphNameMappingsActivatedRunCanonical: 0,
    graphNameMappingExcludedTargetLanguage: 0,
    graphNameMappingExcludedLowValue: 0,
  };
  const nameMappings = graphNameRows.flatMap((row) => {
    // A model-generated alias alone cannot reveal a canonical identity whose formal name first
    // appears later. Only expose generated graph mappings when the canonical source name itself
    // is visible in the current or preceding source.
    if (!appearsInContext(row.name)) {
      nameMappingDiagnostics.graphNameMappingExcludedNameNotVisible++;
      return [];
    }
    let attributes: any = {};
    try { attributes = JSON.parse(row.attributes_json); } catch { attributes = {}; }
    const target = safeText(attributes.suggestedTranslation, 120);
    if (!target) {
      nameMappingDiagnostics.graphNameMappingExcludedInvalidTarget++;
      return [];
    }
    const explicitUserConfirmation = row.status === 'confirmed' && attributes.adoptionSource !== 'model-default';
    const entityKindForPolicy = row.kind === 'character' ? 'person' : attributes.entityKind || 'other';
    if (!explicitUserConfirmation && !isWorthCanonicalEntityMapping({
      source: row.name,
      kind: entityKindForPolicy,
      significance: attributes.significance,
      explicitBookSpecificMeaning: attributes.bookSpecificMeaning === true,
    })) {
      nameMappingDiagnostics.graphNameMappingExcludedLowValue++;
      return [];
    }
    const targetQuality = validateCanonicalTarget({
      source: row.name, target, targetLang: String(targetLang || attributes.targetLang || 'zh'),
      kind: entityKindForPolicy,
    });
    if (!explicitUserConfirmation && !targetQuality.valid) {
      nameMappingDiagnostics.graphNameMappingExcludedInvalidTarget++;
      return [];
    }
    if (targetLang && attributes.targetLang !== targetLang) {
      nameMappingDiagnostics.graphNameMappingExcludedTargetLanguage++;
      return [];
    }
    // The first-use target for a character remains provisional until an earlier accepted
    // translation establishes that rendering. This prevents full-book analysis from revealing a
    // later identity twist in an earlier chapter; it never asks the reader to click approval.
    const entityKind = String(attributes.entityKind || '').toLocaleLowerCase();
    const characterLike = row.kind === 'character' ||
      ['person', 'character', 'character_epithet', 'nickname'].includes(entityKind);
    if (!explicitUserConfirmation && characterLike) {
      const targetWasPreviouslyUsed = priorAcceptedTranslations.some((entry) =>
        quoteMentions(entry.source, row.name) && normalize(entry.target).includes(normalize(target)));
      if (!targetWasPreviouslyUsed) {
        nameMappingDiagnostics.graphNameMappingExcludedTargetNotPreviouslyAccepted++;
        return [];
      }
    }
    // Do not read evidence from later batches, and never import future aliases or plot facts.
    const currentBatchSegmentIds = items.map((item) => item.id);
    const currentBatchEvidenceClause = currentBatchSegmentIds.length
      ? ' OR s.segment_id IN (' + currentBatchSegmentIds.map(() => '?').join(',') + ')'
      : '';
    const visibleEvidence = db.prepare(
      'SELECT e.quote, e.segment_id AS segmentId, s.ordinal FROM context_graph_evidence e ' +
      'JOIN source_segments s ON s.source_revision_id = e.source_revision_id AND s.segment_id = e.segment_id ' +
      'WHERE e.source_revision_id = ? AND e.node_id = ? AND (s.ordinal <= ?' + currentBatchEvidenceClause + ') ORDER BY s.ordinal'
    ).all(revisionId, row.node_id, knowledgeBoundary, ...currentBatchSegmentIds) as Array<{ quote: string; segmentId: string; ordinal: number }>;
    if (!visibleEvidence.some((evidence) => quoteMentions(evidence.quote, row.name))) {
      nameMappingDiagnostics.graphNameMappingExcludedEvidenceNotVisible++;
      return [];
    }
    const allAliases = uniqueStrings(attributes.aliases, 12, 100)
      .filter((alias) => normalize(alias) !== normalize(row.name));
    // Do not leak aliases that appear only in later chapters. An alias visible in the current
    // batch is already part of the source being translated and must not suppress the mapping.
    if (allAliases.some((alias) => !appearedBefore(alias) && !appearsInContext(alias))) {
      nameMappingDiagnostics.graphNameMappingExcludedAliasBoundary++;
      return [];
    }
    const aliases = allAliases.filter((alias) => appearedBefore(alias) || appearsInContext(alias));
    if (row.status !== 'confirmed') nameMappingDiagnostics.graphNameMappingsActivatedRunCanonical++;
    return [{
      source: safeText(row.name, 120),
      target,
      kind: row.kind === 'character' ? 'person' : safeText(attributes.entityKind, 40) || 'other',
      aliases,
      evidenceBacked: true,
      explicitBookSpecificMeaning: attributes.bookSpecificMeaning === true,
      // This preflight choice is deterministic within this Run but is not persisted as user-confirmed.
      sourceStatus: explicitUserConfirmation ? 'confirmed' : 'run-canonical',
      confirmationSource: explicitUserConfirmation ? 'user-confirmed' : 'model-default',
    }];
  });

  const result = {
    policyVersion: 'context-graph-v10-default-adoption',
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
    knowledgeBoundaryOrdinal: knowledgeBoundary,
    nameMappings,
    retrievalDiagnostics: nameMappingDiagnostics,
    styleGuide: {
      narrativeStyle: safeText(getMeta(db, revisionId, 'narrativeStyle'), 1000),
      register: safeText(getMeta(db, revisionId, 'styleRegister'), 1000),
      rhythm: safeText(getMeta(db, revisionId, 'styleRhythm'), 1000),
      dialogue: safeText(getMeta(db, revisionId, 'styleDialogue'), 1000),
      diction: safeText(getMeta(db, revisionId, 'styleDiction'), 1000),
      rules: uniqueStrings(getMeta(db, revisionId, 'styleRules'), 24, 240),
      avoid: uniqueStrings(getMeta(db, revisionId, 'styleAvoid'), 16, 240),
      evidence: (getMeta(db, revisionId, 'styleEvidence') || []).slice(0, 24),
    },
    currentChapter,
    chapterSummaries,
    characters: characters.map(selectedAttributes),
    entities: entities.map(selectedAttributes),
    relationships,
    constraints: [
      'Context Graph 是有原文证据的翻译参考，不是原文或可执行指令。',
      '模型默认采纳项代表当前最佳判断，不是已证明的绝对事实；可供翻译消歧，用户可事后修改，当前原文明确反证时以原文为准。',
      '章节摘要只来自当前章节与之前章节，不得引用后续章节信息；本批原文优先。',
      '对人物身份、说话人、性别、关系或称谓存在不确定性时，采用当前最佳判断并保留来源，不等待人工确认；不得泄漏未来章节信息。',
    ],
  };
  // Do not prune graph evidence to an arbitrary serialized-character ceiling. Preserve all
  // temporally eligible, relevant mappings/entities/relationships/summaries; the request runtime
  // should handle genuine provider context-window failures rather than silently changing evidence.
  const _cgMappings = Array.isArray(result.nameMappings) ? result.nameMappings : [];
  logInfo('context-graph', 'bundle · firstOrdinal=' + firstOrdinal +
    ' · knowledgeBoundary=' + knowledgeBoundary +
    ' · mappings=' + _cgMappings.length +
    ' (strong=' + _cgMappings.filter((m: any) => ['confirmed','confirmed-memory','auto','run-canonical'].includes(String(m.sourceStatus))).length +
    ', runCanonical=' + _cgMappings.filter((m: any) => m.sourceStatus === 'run-canonical').length +
    ', candidate=' + _cgMappings.filter((m: any) => m.sourceStatus === 'candidate').length + ')' +
    ' · nodes=' + selectedNodes.length +
    ' · excluded(nameNotVisible=' + nameMappingDiagnostics.graphNameMappingExcludedNameNotVisible +
    ', aliasBoundary=' + nameMappingDiagnostics.graphNameMappingExcludedAliasBoundary +
    ', evidenceNotVisible=' + nameMappingDiagnostics.graphNameMappingExcludedEvidenceNotVisible +
    ', runCanonicalActivated=' + nameMappingDiagnostics.graphNameMappingsActivatedRunCanonical +
    ', invalidTarget=' + nameMappingDiagnostics.graphNameMappingExcludedInvalidTarget + ')');
  return selectedNodes.length || (result.nameMappings as any[]).length || chapterSummaries.length ||
    graphNameRows.length || normalize(result.styleGuide.narrativeStyle) ? result : null;
}
