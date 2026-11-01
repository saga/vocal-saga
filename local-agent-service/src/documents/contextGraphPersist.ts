/**
 * Context Graph 分析结果的落库：一个事务内清空可替换的模型生成项，再按
 * 文风 → 人物 → 实体 → 关系 → 章节摘要 的顺序写入，最后生成输出审计与完成事件。
 *
 * 只有能对回本次抽样原文的证据才会落库；每个候选的取舍原因都记进审计，
 * 供「为什么这个名字没进图谱」这类问题倒查。
 */

import { type DatabaseSync } from 'node:sqlite';
import {
  canonicalTargetsConflict,
  isWorthCanonicalEntityMapping,
  normalizeCanonicalEntityKind,
  splitCompoundCanonicalName,
  validateCanonicalTarget,
} from './canonicalEntityPolicy.ts';
import {
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  type Evidence,
  type Segment,
} from './contextGraphSchema.ts';
import {
  chapterMap,
  clearReplaceableModelGeneratedContextGraphItems,
  contextGraphCandidateDisposition,
  nameMap,
  nodeId,
  normalize,
  readRunProgress,
  resetChapterSummariesForReanalysis,
  safeText,
  saveEdge,
  saveMeta,
  saveNode,
  sourceNameMatches,
  uniqueStrings,
  validateEvidence,
} from './contextGraphStore.ts';
import {
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
  type ContextGraphAnalysisStrategy,
} from './contextGraphWorkflow.ts';
import { type parseAgentModel } from '../json.ts';
import { type scanBookSegmentsConcurrent } from './bookScan.ts';
import { getDocumentProjectStore } from './projectStore.ts';

/** 模型候选的落库判定结果，逐候选记录「为什么留下 / 为什么丢掉」。 */
export type CandidateAudit = {
  category: string;
  name: string;
  aliases: string[];
  suggestedTranslation?: string;
  role?: string;
  traits?: string[];
  voice?: string[];
  rawEvidenceCount: number;
  acceptedEvidenceCount: number;
  invalidEvidenceReasons: Record<string, number>;
  disposition: string;
  nodeId?: string;
};

/** 证据校验的累计计数，最终原样进入 output-audit 事件。 */
type EvidenceStats = {
  invalidCount: number;
  byReason: Record<string, number>;
  byCategory: Record<string, number>;
};

/** 已落库的节点，关系与审计都靠它做端点解析与计数。 */
type PersistedNode = { id: string; name: string; aliases: string[]; kind: string };

/** 关系落库的逐类丢弃计数，用来说明「模型给了 N 条关系，为什么只存了 M 条」。 */
type RelationshipDiagnostics = {
  processedCount: number;
  droppedMissingEndpoint: number;
  droppedSelfLink: number;
  droppedNoValidEvidence: number;
};

/** 实体候选在落库过程中的丢弃分类计数。 */
type EntityPolicyCounters = {
  droppedLowValue: number;
  droppedCompound: number;
  invalidTarget: number;
  splitCompound: number;
  conflictingTarget: number;
};

/** 一次图谱落库的完整输入；六阶段写入共用这一份上下文，中途不再重新查配置。 */
export interface GraphPersistInput {
  store: ReturnType<typeof getDocumentProjectStore>;
  db: DatabaseSync;
  projectId: string;
  runId: string;
  revisionId: string;
  segments: Segment[];
  sampleIds: Set<string>;
  samples: Segment[];
  chapters: ReturnType<typeof chapterMap>;
  scanSummary: Record<string, any>;
  data: Record<string, any>;
  strategy: ContextGraphAnalysisStrategy;
  sourceLang: string;
  targetLang: string;
  modelAnalysisStartedAt: number;
  agent: ReturnType<typeof parseAgentModel>;
  scan: Awaited<ReturnType<typeof scanBookSegmentsConcurrent>>;
  sampleReasons: Map<string, string[]>;
  style: {
    styleRepairUsed: boolean;
    styleFieldCoverage: Record<string, boolean>;
    styleRuleCount: number;
    styleAvoidCount: number;
    styleEvidenceCount: number;
  };
}

/** 六个落库阶段共享的上下文；阶段之间只通过这里的字段传递结果。 */
export interface GraphPersistContext extends GraphPersistInput {
  sourceById: Map<string, Segment>;
  allowedEvidence: Map<string, Segment>;
  evidenceStats: EvidenceStats;
  evidenceFromModel: (raw: unknown, category?: string, audit?: CandidateAudit) => Evidence[];
  persistedNodes: PersistedNode[];
  characterAudits: CandidateAudit[];
  entityAudits: CandidateAudit[];
  entityPolicy: EntityPolicyCounters;
  savedEdges: Set<string>;
  relationshipDiagnostics: RelationshipDiagnostics;
}

/**
 * 落库：把模型输出的事务性写入图谱——清空可替换的模型生成项、写文风元信息、
 * 保存人物/实体/关系、写章节摘要与完成事件。任何一步失败都整体回滚，
 * 已保存的阶段检查点不受影响，下次可从这里继续。
 */
export function persistAnalysisGraph(input: GraphPersistInput): void {
  const ctx = createGraphPersistContext(input);
  const { db } = ctx;
  db.exec('BEGIN IMMEDIATE');
  try {
    // 在事务里重建模型生成的图谱条目，但保留用户决定，
    // 以及那些仍被存活的用户确认/拒绝边引用的模型默认端点。
    clearReplaceableModelGeneratedContextGraphItems(db, ctx.revisionId);
    // 重新分析前重置上一轮模型生成的章节摘要（见 resetChapterSummariesForReanalysis）。
    resetChapterSummariesForReanalysis(db, ctx.revisionId, ctx.segments);
    saveStyleMeta(ctx);
    persistCharacterCandidates(ctx);
    persistEntityCandidates(ctx);
    persistRelationships(ctx);
    persistChapterSummaries(ctx);
    const outputAudit = buildGraphOutputAudit(ctx);
    completeGraphRun(ctx, outputAudit);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original analysis error */ }
    throw error;
  }
}

/**
 * 组装落库上下文：给全部源文片段建 id 索引，并单独列出「允许作为证据」的抽样片段。
 *
 * 证据只认抽样内的片段——模型可能引用一段它没真正读到的原文，这类引用不能进图谱。
 * 证据统计容器在这里初始化，后续各阶段只做累加。
 */
function createGraphPersistContext(input: GraphPersistInput): GraphPersistContext {
  const sourceById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const allowedEvidence = new Map<string, Segment>();
  for (const id of input.sampleIds) {
    const segment = sourceById.get(id);
    if (segment) allowedEvidence.set(id, segment);
  }
  const evidenceStats: EvidenceStats = { invalidCount: 0, byReason: {}, byCategory: {} };
  return {
    ...input,
    sourceById,
    allowedEvidence,
    evidenceStats,
    evidenceFromModel: createEvidenceValidator(allowedEvidence, evidenceStats),
    persistedNodes: [],
    characterAudits: [],
    entityAudits: [],
    entityPolicy: { droppedLowValue: 0, droppedCompound: 0, invalidTarget: 0, splitCompound: 0, conflictingTarget: 0 },
    savedEdges: new Set<string>(),
    relationshipDiagnostics: {
      processedCount: 0, droppedMissingEndpoint: 0, droppedSelfLink: 0, droppedNoValidEvidence: 0,
    },
  };
}

/**
 * 证据校验器：只接受落在本书本次抽样窗口内的引用。
 * 每次拒绝都同时计入总账与（若给了）单个候选的明细，便于回答「为什么这个名字没进图谱」。
 */
function createEvidenceValidator(
  allowedEvidence: Map<string, Segment>,
  stats: EvidenceStats,
): (raw: unknown, category?: string, audit?: CandidateAudit) => Evidence[] {
  return (raw: unknown, category = 'other', audit?: CandidateAudit) =>
    validateEvidence(raw, allowedEvidence, (reason) => {
      stats.invalidCount++;
      stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      if (audit) audit.invalidEvidenceReasons[reason] = (audit.invalidEvidenceReasons[reason] || 0) + 1;
    });
}

/**
 * 把文风字段逐项写进 meta 表。
 *
 * 每个字段都有独立长度上限，且是「按字段名取」而不是整块 JSON：这样后续读取某个维度时
 * 不必反序列化整份分析结果。styleRules / styleAvoid 额外去重并限量。
 */
function saveStyleMeta(ctx: GraphPersistContext): void {
  const { db, revisionId, data, samples } = ctx;
  saveMeta(db, revisionId, 'stylePolicyVersion', 'literary-style-v3-default-adoption');
  saveMeta(db, revisionId, 'bookSummary', safeText(data.bookSummary, 4000));
  saveMeta(db, revisionId, 'narrativeStyle', safeText(data.narrativeStyle, 1200));
  saveMeta(db, revisionId, 'styleRegister', safeText(data.styleRegister, 1000));
  saveMeta(db, revisionId, 'styleRhythm', safeText(data.styleRhythm, 1000));
  saveMeta(db, revisionId, 'styleDialogue', safeText(data.styleDialogue, 1000));
  saveMeta(db, revisionId, 'styleDiction', safeText(data.styleDiction, 1000));
  saveMeta(db, revisionId, 'styleRules', uniqueStrings(data.styleRules, 24, 240));
  saveMeta(db, revisionId, 'styleAvoid', uniqueStrings(data.styleAvoid, 16, 240));
  saveMeta(db, revisionId, 'styleEvidence', Array.isArray(data.styleEvidence) ? data.styleEvidence.filter((item: any) =>
    item && typeof item.segmentId === 'string' && samples.some((sample) => sample.id === item.segmentId) &&
    typeof item.quote === 'string' && item.quote.trim().length >= 8 && samples.some((sample) => sample.id === item.segmentId && sample.text.includes(item.quote.trim()))
  ).slice(0, 40).map((item: any) => ({ dimension: safeText(item.dimension, 40), segmentId: item.segmentId, quote: safeText(item.quote, 240), observation: safeText(item.observation, 300) })) : []);
}

/** 人物候选：有证据才入库，且严格按「已落库人物数」封顶。 */
function persistCharacterCandidates(ctx: GraphPersistContext): void {
  const { db, revisionId, data, targetLang, persistedNodes, characterAudits, evidenceFromModel } = ctx;
  for (const raw of (Array.isArray(data.characters) ? data.characters : []).slice(0, 200)) {
    const name = safeText(raw?.name, 120);
    const audit: CandidateAudit = {
      category: 'character', name,
      aliases: uniqueStrings(raw?.aliases, 12, 100),
      suggestedTranslation: safeText(raw?.suggestedTranslation, 120),
      role: safeText(raw?.role, 240),
      traits: uniqueStrings(raw?.traits, 6, 100),
      voice: uniqueStrings(raw?.voice, 6, 120),
      rawEvidenceCount: Array.isArray(raw?.evidence) ? raw.evidence.length : 0,
      acceptedEvidenceCount: 0, invalidEvidenceReasons: {}, disposition: 'not-evaluated',
    };
    characterAudits.push(audit);
    if (!name) {
      audit.disposition = 'dropped-empty-name';
      continue;
    }
    const evidence = evidenceFromModel(raw.evidence, 'character', audit);
    audit.acceptedEvidenceCount = evidence.length;
    const characterDecision = contextGraphCandidateDisposition(
      evidence.length, persistedNodes.filter((node) => node.kind === 'character').length, 40,
    );
    if (characterDecision !== 'persist') {
      audit.disposition = characterDecision === 'no-evidence'
        ? 'dropped-no-valid-evidence' : 'dropped-valid-candidate-limit';
      continue;
    }
    const characterTarget = validateCanonicalTarget({
      source: name, target: audit.suggestedTranslation || '', targetLang, kind: 'person',
    });
    if (!characterTarget.valid) audit.suggestedTranslation = '';
    else audit.suggestedTranslation = characterTarget.normalizedTarget;
    const aliases = audit.aliases.filter((item) => normalize(item) !== normalize(name));
    const attributes = {
      aliases, suggestedTranslation: audit.suggestedTranslation || '', targetLang,
      ...(characterTarget.valid ? {} : { suggestedTranslationQuality: characterTarget.reason || 'invalid-target' }),
      role: safeText(raw.role, 360), traits: uniqueStrings(raw.traits, 10, 160),
      voice: uniqueStrings(raw.voice, 10, 180), evidenceCount: evidence.length,
    };
    const id = saveNode(db, revisionId, 'character', name, attributes, evidence);
    audit.disposition = 'persisted';
    audit.nodeId = id;
    persistedNodes.push({ id, name, aliases, kind: 'character' });
  }
}

/** 实体落库期间跨候选共享的状态：已入库节点、译名索引与冲突集合。 */
type EntityPersistState = {
  db: any;
  revisionId: string;
  segments: Segment[];
  targetLang: string;
  persistedNodes: PersistedNode[];
  entityPolicy: EntityPolicyCounters;
  /** 源名规范化 → 已采纳的规范译名；同源两个译名即视为歧义。 */
  canonicalTargetBySource: Map<string, string>;
  conflictingCanonicalSources: Set<string>;
};

/** 实体候选落库前的中间形态：名字、类型与判定所需信号。 */
type EntityCandidateInput = {
  entityName: string;
  targetName: string;
  rawKind: unknown;
  significance: string;
  aliasesInput: unknown;
  evidence: Evidence[];
  audit: CandidateAudit;
  bookSpecificMeaning?: boolean;
};

/**
 * 实体候选：在人物之后入库，因此可以做「同名不同指」与复合名拆分这类跨候选校验。
 *
 * 同名实体的两个合理译名是歧义，不能让数组顺序替人做决定：出现冲突时把先前的机器候选
 * 降级为「无目标译名」，但绝不改动用户已确认的映射。
 */
function persistEntityCandidates(ctx: GraphPersistContext): void {
  const state: EntityPersistState = {
    db: ctx.db, revisionId: ctx.revisionId, segments: ctx.segments, targetLang: ctx.targetLang,
    persistedNodes: ctx.persistedNodes, entityPolicy: ctx.entityPolicy,
    canonicalTargetBySource: new Map(), conflictingCanonicalSources: new Set(),
  };
  for (const raw of (Array.isArray(ctx.data.entities) ? ctx.data.entities : []).slice(0, 400)) {
    persistEntityCandidateRecord(raw, ctx, state);
  }
}

/** 单条实体候选：先建审计记录，再按证据、复合名、目标质量依次判定。 */
function persistEntityCandidateRecord(raw: any, ctx: GraphPersistContext, state: EntityPersistState): void {
  const { persistedNodes, entityPolicy } = state;
  const name = safeText(raw?.name, 120);
  const target = safeText(raw?.suggestedTranslation, 120);
  const aliases = uniqueStrings(raw?.aliases, 12, 100);
  const significance = safeText(raw?.significance, 240);
  const audit: CandidateAudit = {
    category: 'entity', name, aliases, suggestedTranslation: target,
    role: significance,
    rawEvidenceCount: Array.isArray(raw?.evidence) ? raw.evidence.length : 0,
    acceptedEvidenceCount: 0, invalidEvidenceReasons: {}, disposition: 'not-evaluated',
  };
  ctx.entityAudits.push(audit);
  if (!name) {
    audit.disposition = 'dropped-empty-name';
    return;
  }
  const evidence = ctx.evidenceFromModel(raw.evidence, 'entity', audit);
  audit.acceptedEvidenceCount = evidence.length;
  const entityDecision = contextGraphCandidateDisposition(
    evidence.length, persistedNodes.filter((node) => node.kind === 'entity').length, 120,
  );
  if (entityDecision !== 'persist') {
    audit.disposition = entityDecision === 'no-evidence'
      ? 'dropped-no-valid-evidence' : 'dropped-valid-candidate-limit';
    return;
  }

  const sourceParts = splitCompoundCanonicalName(name);
  const targetParts = splitCompoundCanonicalName(target);
  if (sourceParts) {
    // 复合名必须与等长的译名列表逐项配对，每个拆出的成员都要有自己的证据。
    if (!targetParts || sourceParts.parts.length !== targetParts.parts.length) {
      entityPolicy.droppedCompound++;
      audit.disposition = 'dropped-compound-name-unpaired';
      return;
    }
    const pairs = sourceParts.parts.map((sourcePart, index) => ({
      source: sourcePart, target: targetParts.parts[index] || '',
      evidence: evidence.filter((item) => sourceNameMatches(item.quote, sourcePart)),
    }));
    if (pairs.some((pair) => !pair.target || !pair.evidence.length)) {
      entityPolicy.droppedCompound++;
      audit.disposition = 'dropped-compound-name-unverified-part';
      return;
    }
    entityPolicy.splitCompound += pairs.length;
    const bookSpecificMeaning = raw.bookSpecificMeaning === true || raw.book_specific_meaning === true;
    let saved = 0;
    for (const pair of pairs) {
      if (saveEntityCandidate(state, {
        entityName: pair.source, targetName: pair.target, rawKind: raw.kind, significance,
        aliasesInput: [], evidence: pair.evidence, audit, bookSpecificMeaning,
      })) saved++;
    }
    if (!saved && audit.disposition === 'not-evaluated') audit.disposition = 'dropped-low-value-compound-parts';
    else if (saved) audit.disposition = 'split-compound-persisted-' + saved;
    return;
  }
  if (splitCompoundCanonicalName(target)) {
    entityPolicy.invalidTarget++;
    audit.disposition = 'persisted-target-quality-rejected';
    // 源文证据留给诊断用，但绝不把复合目标译名当映射存下去。
    saveEntityCandidate(state, {
      entityName: name, targetName: '', rawKind: raw.kind, significance,
      aliasesInput: aliases, evidence, audit,
    });
    return;
  }
  saveEntityCandidate(state, {
    entityName: name, targetName: target, rawKind: raw.kind, significance,
    aliasesInput: aliases, evidence, audit,
    bookSpecificMeaning: raw.bookSpecificMeaning === true || raw.book_specific_meaning === true,
  });
}

/**
 * 写入一个实体候选。四道闸门依次是：数量上限、已判定歧义的源名、是否值得建映射、译名质量。
 * 译名冲突时回退先前机器候选，但用户确认过的映射永不改动。
 */
function saveEntityCandidate(state: EntityPersistState, candidate: EntityCandidateInput): boolean {
  const { db, revisionId, segments, targetLang, persistedNodes, entityPolicy } = state;
  const { entityName, targetName, rawKind, significance, aliasesInput, evidence, audit } = candidate;
  if (persistedNodes.filter((node) => node.kind === 'entity').length >= 120) {
    audit.disposition = 'dropped-valid-candidate-limit';
    return false;
  }
  const entityKey = normalize(entityName);
  if (state.conflictingCanonicalSources.has(entityKey)) {
    audit.disposition = 'dropped-conflicting-canonical-target';
    return false;
  }
  const normalizedKind = normalizeCanonicalEntityKind(rawKind);
  const occurrences = segments.filter((segment) => sourceNameMatches(segment.text, entityName));
  const chapterCount = new Set(occurrences.map((segment) => segment.contextPath).filter(Boolean)).size;
  if (!isWorthCanonicalEntityMapping({
    source: entityName, kind: normalizedKind,
    mentions: occurrences.length, chapterCount, significance,
    explicitBookSpecificMeaning: candidate.bookSpecificMeaning === true,
  })) {
    entityPolicy.droppedLowValue++;
    return false;
  }
  // 人工确认过的译名就是规范值；模型重新分析可以刷新证据，
  // 但绝不能悄悄替换用户对同一目标语的明确选择。
  const existingId = nodeId(revisionId, 'entity', entityName);
  const existingNode = db.prepare(
    'SELECT status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND node_id = ?'
  ).get(revisionId, existingId) as { status?: string; attributes_json?: string } | undefined;
  const effectiveTargetName = resolveConfirmedTarget(existingNode, targetLang) ?? targetName;

  const targetCheck = validateCanonicalTarget({
    source: entityName, target: effectiveTargetName, targetLang, kind: normalizedKind,
  });
  if (!targetCheck.valid) {
    entityPolicy.invalidTarget++;
    if (state.canonicalTargetBySource.has(entityKey)) {
      // 一条畸形的重复项，不能把同源下已经有效的候选抹掉。
      audit.disposition = 'dropped-invalid-target-conflicts-with-valid-candidate';
      return false;
    }
  }
  if (targetCheck.valid) {
    const priorTarget = state.canonicalTargetBySource.get(entityKey);
    if (priorTarget && canonicalTargetsConflict(priorTarget, targetCheck.normalizedTarget)) {
      state.conflictingCanonicalSources.add(entityKey);
      entityPolicy.conflictingTarget++;
      audit.disposition = 'dropped-conflicting-canonical-target';
      // 同一个源名出现两个都说得通的目标译名，就是有歧义：不能让数组顺序来定。
      // 让更早的机器候选失效，但绝不动用户确认过的映射。
      if (existingNode?.status !== 'confirmed') {
        clearPriorSuggestedTranslation(db, revisionId, entityName);
      }
      return false;
    }
    if (!priorTarget) state.canonicalTargetBySource.set(entityKey, targetCheck.normalizedTarget);
  }
  const aliases = uniqueStrings(aliasesInput, 12, 100)
    .filter((item) => normalize(item) !== normalize(entityName) && !splitCompoundCanonicalName(item));
  const attributes = {
    aliases,
    entityKind: normalizedKind,
    significance: safeText(significance, 360),
    bookSpecificMeaning: candidate.bookSpecificMeaning === true,
    suggestedTranslation: targetCheck.valid ? targetCheck.normalizedTarget : '',
    ...(targetCheck.valid ? {} : { suggestedTranslationQuality: targetCheck.reason || 'invalid-target' }),
    targetLang,
    evidenceCount: evidence.length,
  };
  const id = saveNode(db, revisionId, 'entity', entityName, attributes, evidence);
  audit.disposition = targetCheck.valid ? 'persisted' : 'persisted-target-quality-rejected';
  audit.nodeId ||= id;
  persistedNodes.push({ id, name: entityName, aliases, kind: 'entity' });
  return true;
}

/** 用户已确认的译名优先于模型本次的建议；语言不一致时不吃旧值。 */
function resolveConfirmedTarget(
  existingNode: { status?: string; attributes_json?: string } | undefined,
  targetLang: string,
): string | null {
  if (existingNode?.status !== 'confirmed') return null;
  try {
    const priorAttributes = JSON.parse(existingNode.attributes_json || '{}');
    if (priorAttributes.targetLang === targetLang && typeof priorAttributes.suggestedTranslation === 'string' &&
        priorAttributes.suggestedTranslation.trim()) {
      return priorAttributes.suggestedTranslation;
    }
  } catch { /* invalid legacy attributes are revalidated below */ }
  return null;
}

/** 把先前机器候选的译名清空并标注冲突来源，避免旧值继续被当成规范译名。 */
function clearPriorSuggestedTranslation(db: any, revisionId: string, entityName: string): void {
  const priorId = nodeId(revisionId, 'entity', entityName);
  const priorRow = db.prepare(
    'SELECT attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND node_id = ?'
  ).get(revisionId, priorId) as { attributes_json?: string } | undefined;
  if (!priorRow) return;
  let priorAttributes: Record<string, unknown> = {};
  try { priorAttributes = JSON.parse(priorRow.attributes_json || '{}'); } catch { priorAttributes = {}; }
  priorAttributes.suggestedTranslation = '';
  priorAttributes.suggestedTranslationQuality = 'conflicting-target-candidates';
  db.prepare('UPDATE context_graph_nodes SET attributes_json = ?, updated_at = ? WHERE source_revision_id = ? AND node_id = ?')
    .run(JSON.stringify(priorAttributes), new Date().toISOString(), revisionId, priorId);
}

/** 关系边：两端必须落在本次已入库的节点上，且至少有一条有效证据。 */
function persistRelationships(ctx: GraphPersistContext): void {
  const { db, revisionId, data, sourceLang, persistedNodes, savedEdges, relationshipDiagnostics, evidenceFromModel } = ctx;
  const identities = nameMap(persistedNodes);
  const resolveRelationshipEndpoint = (value: unknown): string | undefined => {
    const name = safeText(value, 120);
    if (!name) return undefined;
    const normalized = normalize(name);
    const direct = identities.get(normalized);
    if (direct) return direct;
    // 模型可能带着某语言的冠词，而图谱里存的是裸节点名。
    // 这里只做保守的单 token 归一；不要做模糊匹配或子串匹配。
    const language = String(sourceLang || 'auto').toLocaleLowerCase().split(/[-_]/u)[0];
    const articlePatterns: Record<string, RegExp> = {
      en: /^(?:the|a|an)\s+/u,
      fr: /^(?:le|la|les|un|une|des|l')\s*/u,
      de: /^(?:der|die|das|den|dem|des|ein|eine|einer|eines|einem)\s+/u,
      it: /^(?:il|lo|la|i|gli|le|un|uno|una|l')\s*/u,
    };
    const withoutArticle = normalized.replace(articlePatterns[language] || /^(?!)$/u, '');
    return withoutArticle !== normalized ? identities.get(withoutArticle) : undefined;
  };
  for (const raw of (Array.isArray(data.relationships) ? data.relationships : []).slice(0, 100)) {
    relationshipDiagnostics.processedCount++;
    const fromId = resolveRelationshipEndpoint(raw?.from);
    const toId = resolveRelationshipEndpoint(raw?.to);
    if (!fromId || !toId) {
      relationshipDiagnostics.droppedMissingEndpoint++;
      continue;
    }
    if (fromId === toId) {
      relationshipDiagnostics.droppedSelfLink++;
      continue;
    }
    const evidence = evidenceFromModel(raw.evidence, 'relationship');
    if (!evidence.length) {
      relationshipDiagnostics.droppedNoValidEvidence++;
      continue;
    }
    const edge = saveEdge(db, revisionId, fromId, toId, safeText(raw.kind, 80) || 'relationship', {
      description: safeText(raw.description, 500), voiceRule: safeText(raw.voiceRule, 500), evidenceCount: evidence.length,
    }, evidence);
    savedEdges.add(edge);
  }
}

/** 章节摘要：只回填能找到对应章节、且证据确实出自该章的条目。 */
function persistChapterSummaries(ctx: GraphPersistContext): void {
  const { db, revisionId, data, sourceById, evidenceFromModel } = ctx;
  const chapterRows = db.prepare(
    'SELECT chapter_key, chapter_order, chapter_title FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order'
  ).all(revisionId) as any[];
  for (const raw of (Array.isArray(data.chapterSummaries) ? data.chapterSummaries : [])) {
    const title = safeText(raw?.chapter, 160);
    const summary = safeText(raw?.summary, 5000);
    if (!title || !summary) continue;
    const matchingChapter = chapterRows.find((chapter) =>
      normalize(chapter.chapter_title) === normalize(title) || normalize(chapter.chapter_key) === normalize(title));
    if (!matchingChapter) continue;
    const evidence = evidenceFromModel(raw.evidence, 'chapterSummary');
    if (!evidence.length) continue;
    const evidenceBelongsToChapter = evidence.some((item) => {
      const segment = sourceById.get(item.segmentId);
      return !!segment && normalize(segment.contextPath) === normalize(matchingChapter.chapter_key);
    });
    if (!evidenceBelongsToChapter) continue;
    db.prepare(
      'UPDATE context_graph_chapters SET summary = ?, summary_kind = \'model\', segment_ids_json = ?, updated_at = ? ' +
      'WHERE source_revision_id = ? AND chapter_key = ?'
    ).run(summary, JSON.stringify(evidence.map((item) => item.segmentId)), new Date().toISOString(), revisionId, matchingChapter.chapter_key);
  }
}

/**
 * 输出审计：把「模型给了什么」与「最后存了什么」并排放，
 * 并逐条核对扫描阶段发现的人名候选有没有被模型漏掉。
 */
export function buildGraphOutputAudit(ctx: GraphPersistContext): Record<string, any> {
  const {
    runId, revisionId, agent, samples, data, style, scan, sampleReasons,
    persistedNodes, characterAudits, entityAudits, savedEdges, relationshipDiagnostics, evidenceStats,
  } = ctx;
  const normalizedNameMatches = (candidateName: string, audit: CandidateAudit) => {
    const names = [audit.name, ...audit.aliases].map(normalize).filter(Boolean);
    return names.includes(normalize(candidateName));
  };
  const candidateCoverage = scan.nameCandidates.slice(0, 32).map((candidate, index) => {
    const characterMatches = characterAudits.filter((audit) => normalizedNameMatches(candidate.name, audit));
    const entityMatches = entityAudits.filter((audit) => normalizedNameMatches(candidate.name, audit));
    const matchingSamples = samples.filter((sample) => {
      const escaped = candidate.name.split('').map((character) =>
        '\\^$.|?*+()[]{}-'.includes(character) ? '\\' + character : character
      ).join('');
      try { return new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])', 'iu').test(sample.text); }
      catch { return normalize(sample.text).includes(normalize(candidate.name)); }
    });
    return {
      rank: index + 1, name: candidate.name, mentions: candidate.mentions,
      chapterCount: candidate.chapterCount, dialogueSegmentCount: candidate.dialogueSegmentCount,
      regionCount: candidate.regionCount, score: candidate.score,
      earlySegmentId: candidate.earlySegmentId, middleSegmentId: candidate.middleSegmentId, lateSegmentId: candidate.lateSegmentId,
      sampleHitCount: matchingSamples.length,
      sampleHits: matchingSamples.slice(0, 4).map((sample) => ({
        segmentId: sample.id, ordinal: sample.ordinal, chapter: sample.contextPath,
        reasons: sampleReasons.get(sample.id) || [],
      })),
      returnedAsCharacter: characterMatches.length > 0,
      returnedAsEntity: entityMatches.length > 0,
      characterDisposition: characterMatches.map((audit) => ({ name: audit.name, disposition: audit.disposition, acceptedEvidenceCount: audit.acceptedEvidenceCount })),
      entityDisposition: entityMatches.map((audit) => ({ name: audit.name, disposition: audit.disposition, acceptedEvidenceCount: audit.acceptedEvidenceCount })),
    };
  });
  return {
    auditVersion: 'context-graph-model-output-audit-v1',
    runId, sourceRevisionId: revisionId,
    provider: agent.provider, model: agent.model || '<runtime-default>',
    sampleCount: samples.length,
    rawCounts: {
      characters: Array.isArray(data.characters) ? data.characters.length : 0,
      entities: Array.isArray(data.entities) ? data.entities.length : 0,
      relationships: Array.isArray(data.relationships) ? data.relationships.length : 0,
      chapterSummaries: Array.isArray(data.chapterSummaries) ? data.chapterSummaries.length : 0,
    },
    styleMetrics: {
      fieldCoverage: style.styleFieldCoverage,
      rules: style.styleRuleCount,
      avoidRules: style.styleAvoidCount,
      evidenceItems: style.styleEvidenceCount,
      repaired: style.styleRepairUsed,
    },
    persistedCounts: {
      characters: persistedNodes.filter((node) => node.kind === 'character').length,
      entities: persistedNodes.filter((node) => node.kind === 'entity').length,
      relationships: savedEdges.size,
      relationshipDiagnostics: { ...relationshipDiagnostics, persistedEdges: savedEdges.size },
      characterCandidatesDroppedForEvidence: characterAudits.filter((audit) => audit.disposition === 'dropped-no-valid-evidence').length,
      entityCandidatesDroppedForEvidence: entityAudits.filter((audit) => audit.disposition === 'dropped-no-valid-evidence').length,
      characterCandidatesDroppedAtValidLimit: characterAudits.filter((audit) => audit.disposition === 'dropped-valid-candidate-limit').length,
      entityCandidatesDroppedAtValidLimit: entityAudits.filter((audit) => audit.disposition === 'dropped-valid-candidate-limit').length,
      characterCandidatesOutsideScanWindow: Math.max(0, (Array.isArray(data.characters) ? data.characters.length : 0) - 200),
      entityCandidatesOutsideScanWindow: Math.max(0, (Array.isArray(data.entities) ? data.entities.length : 0) - 400),
    },
    evidenceValidation: {
      invalidEvidenceCount: evidenceStats.invalidCount,
      byReason: { ...evidenceStats.byReason },
      byCategory: { ...evidenceStats.byCategory },
    },
    candidateCoverage,
    modelCharacters: characterAudits.slice(0, 40),
    modelEntities: entityAudits.slice(0, 60),
  };
}

/** 收尾：写运行进度、审计事件与完成事件。事务提交由调用方负责。 */
export function completeGraphRun(ctx: GraphPersistContext, outputAudit: Record<string, any>): void {
  const {
    store, db, projectId, runId, samples, chapters, strategy, sourceLang, targetLang,
    modelAnalysisStartedAt, style, scanSummary, data, persistedNodes, savedEdges, relationshipDiagnostics, evidenceStats, entityPolicy,
  } = ctx;
  const characterCount = persistedNodes.filter((node) => node.kind === 'character').length;
  const entityCount = persistedNodes.filter((node) => node.kind === 'entity').length;
  const countCanonicalNameMappings = () => persistedNodes.filter((node) => {
    const row = db.prepare('SELECT attributes_json FROM context_graph_nodes WHERE node_id = ?').get(node.id) as { attributes_json?: string } | undefined;
    try { return !!safeText(JSON.parse(row?.attributes_json || '{}').suggestedTranslation, 120); } catch { return false; }
  }).length;
  const now = new Date().toISOString();
  db.prepare('UPDATE context_graph_runs SET status = \'completed\', phase = \'completed\', progress_json = ?, finished_at = ?, error = NULL WHERE run_id = ?')
    .run(JSON.stringify({
      ...readRunProgress(db, runId),
      strategy,
      workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
      analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
      sourceLang, targetLang,
      sampleCount: samples.length, chapterCount: chapters.length,
      characterCount,
      entityCount,
      relationshipCount: savedEdges.size,
      relationshipDiagnostics: { ...relationshipDiagnostics, persistedEdges: savedEdges.size },
      canonicalNameMappingCount: countCanonicalNameMappings(),
      openQuestions: uniqueStrings(data.openQuestions, 24, 200),
      invalidEvidenceCount: evidenceStats.invalidCount,
      invalidEvidenceByReason: evidenceStats.byReason,
      invalidEvidenceByCategory: evidenceStats.byCategory,
      outputAuditVersion: outputAudit.auditVersion,
      modelCandidateCounts: outputAudit.rawCounts,
      entityPolicy: {
        droppedLowValueEntityCount: entityPolicy.droppedLowValue,
        droppedCompoundEntityCount: entityPolicy.droppedCompound,
        invalidEntityTargetCount: entityPolicy.invalidTarget,
        splitCompoundEntityCount: entityPolicy.splitCompound,
        conflictingEntityTargetCount: entityPolicy.conflictingTarget,
      },
      droppedCandidateCounts: {
        characters: outputAudit.persistedCounts.characterCandidatesDroppedForEvidence,
        entities: outputAudit.persistedCounts.entityCandidatesDroppedForEvidence,
      },
      scan: scanSummary,
    }), now, runId);
  const canonicalNameMappingCount = countCanonicalNameMappings();
  store.appendEvent(projectId, runId, 'context-graph.output-audit', outputAudit);
  store.appendEvent(projectId, runId, 'context-graph.completed', {
    sampleCount: samples.length,
    chapterCount: chapters.length,
    characterCount,
    entityCount,
    relationshipCount: savedEdges.size,
    canonicalNameMappingCount,
    invalidEvidenceCount: evidenceStats.invalidCount,
    invalidEvidenceByReason: evidenceStats.byReason,
    invalidEvidenceByCategory: evidenceStats.byCategory,
    modelCandidateCounts: outputAudit.rawCounts,
    droppedCandidateCounts: outputAudit.persistedCounts,
    sourceLang, targetLang,
    strategy,
    workflowVersion: CONTEXT_GRAPH_WORKFLOW_VERSION,
    workflowElapsedMs: Date.now() - modelAnalysisStartedAt,
    styleRepairUsed: style.styleRepairUsed, styleFieldCoverage: style.styleFieldCoverage, styleRuleCount: style.styleRuleCount,
    styleAvoidCount: style.styleAvoidCount, styleEvidenceCount: style.styleEvidenceCount,
    ...(strategy === 'B' ? {
      completedStages: CONTEXT_GRAPH_WORKFLOW_STAGES.map((stage) => stage.id),
      stageResults: readRunProgress(db, runId).stageResults || [],
    } : {}),
    analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
  });
}
