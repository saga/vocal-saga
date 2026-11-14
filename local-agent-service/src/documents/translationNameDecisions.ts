/**
 * Run 级规范译名决议与采纳译文回校。
 *
 * 决议只使用明确的用户确认或更早片段的已采纳译文；模型提议本身不能成为强映射。
 * 每个 Run 首次准备时在 SQLite 写入不可变快照，同波批次共享，后续波次也不再各自重新投票。
 */
import type { DocumentProjectStore } from './projectStore.ts';
import { normalizeEntityName } from './literaryNormalizers.ts';
import { sourceNameMatches } from './contextGraphStore.ts';
import { normalizeCanonicalEntityKind, validateCanonicalTarget } from './canonicalEntityPolicy.ts';

export interface RunNameDecision {
  source: string;
  aliases: string[];
  target: string;
  kind: string;
  sourceStatus: 'confirmed-memory' | 'confirmed' | 'run-canonical';
  decisionSource: 'user-confirmed-memory' | 'user-confirmed-context-graph' | 'accepted-translation';
  decidedOrdinal: number;
  evidenceSegmentIds: string[];
}

interface AcceptedTranslationRow {
  segmentId: string;
  sourceText: string;
  translation: string;
  ordinal: number;
  sourceHash: string;
}

interface NameGroup {
  source: string;
  aliases: Set<string>;
  targets: Set<string>;
  kind: string;
  explicitTargets: Array<{ target: string; source: 'memory' | 'context-graph' }>;
}

export interface TargetVote {
  target: string;
  count: number;
  firstOrdinal: number;
  rows: AcceptedTranslationRow[];
}

function parseJson(value: unknown, fallback: any = {}): any {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function tableExists(db: any, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function addText(set: Set<string>, value: unknown, max = 120): void {
  if (typeof value !== 'string') return;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (normalized) set.add(normalized);
}

function hasText(haystack: string, needle: string): boolean {
  const target = needle.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
  const source = haystack.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
  return !!target && source.includes(target);
}

function acceptedRows(db: any, sourceRevisionId: string): AcceptedTranslationRow[] {
  const rows = db.prepare(
    'SELECT tr.segment_id AS segmentId, tr.translation_text AS translation, tr.source_hash AS sourceHash, ' +
    's.text AS sourceText, s.ordinal AS ordinal ' +
    'FROM translation_results tr JOIN source_segments s ' +
    'ON s.source_revision_id = tr.source_revision_id AND s.segment_id = tr.segment_id ' +
    'WHERE tr.source_revision_id = ? AND tr.accepted = 1 AND tr.source_hash = s.source_hash ' +
    'ORDER BY COALESCE(tr.accepted_at, tr.created_at) DESC, tr.created_at DESC, tr.rowid DESC'
  ).all(sourceRevisionId) as AcceptedTranslationRow[];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = String(row.segmentId || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function loadNameGroups(db: any, sourceRevisionId: string, memory: Record<string, any>, runId?: string): Map<string, NameGroup> {
  const groups = new Map<string, NameGroup>();
  const getGroup = (sourceValue: unknown, kindValue?: unknown): NameGroup | null => {
    const source = typeof sourceValue === 'string' ? sourceValue.trim().slice(0, 120) : '';
    const key = normalizeEntityName(source);
    if (!source || !key) return null;
    let group = groups.get(key);
    if (!group) {
      group = { source, aliases: new Set(), targets: new Set(), kind: normalizeCanonicalEntityKind(kindValue), explicitTargets: [] };
      groups.set(key, group);
    } else if (group.kind === 'other' && kindValue) {
      group.kind = normalizeCanonicalEntityKind(kindValue);
    }
    return group;
  };

  for (const entity of Array.isArray(memory.entities) ? memory.entities : []) {
    if (!entity || entity.reviewStatus === 'rejected') continue;
    const group = getGroup(entity.source, entity.kind);
    if (!group) continue;
    for (const alias of Array.isArray(entity.aliases) ? entity.aliases : []) addText(group.aliases, alias, 100);
    addText(group.targets, entity.target, 120);
    for (const ref of Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : []) {
      addText(group.targets, ref?.targetSurface, 120);
    }
    if (entity.reviewStatus === 'confirmed' &&
        ['user-confirmed', 'user-modified'].includes(String(entity.confirmationSource || ''))) {
      group.explicitTargets.push({ target: String(entity.target || '').trim(), source: 'memory' });
    }
  }

  if (tableExists(db, 'context_graph_nodes')) {
    const graphRows = db.prepare(
      "SELECT name, kind, status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ? AND status IN ('candidate','confirmed')"
    ).all(sourceRevisionId) as any[];
    for (const row of graphRows) {
      const attributes = parseJson(row.attributes_json, {});
      const group = getGroup(row.name, row.kind === 'character' ? 'person' : attributes.entityKind);
      if (!group) continue;
      for (const alias of Array.isArray(attributes.aliases) ? attributes.aliases : []) addText(group.aliases, alias, 100);
      addText(group.targets, attributes.suggestedTranslation, 120);
      if (row.status === 'confirmed' && attributes.adoptionSource !== 'model-default' &&
          typeof attributes.suggestedTranslation === 'string' && attributes.suggestedTranslation.trim()) {
        group.explicitTargets.push({ target: attributes.suggestedTranslation.trim(), source: 'context-graph' });
      }
    }
  }

  if (tableExists(db, 'translation_context_deltas')) {
    const deltaRows = db.prepare(
      'SELECT d.delta_json FROM translation_context_deltas d ' +
      'JOIN translation_runs r ON r.run_id = d.run_id ' +
      'WHERE r.source_revision_id = ? ORDER BY d.first_ordinal'
    ).all(sourceRevisionId) as Array<{ delta_json: string }>;
    for (const row of deltaRows) {
      const delta = parseJson(row.delta_json, {});
      for (const candidate of Array.isArray(delta.entityCandidates) ? delta.entityCandidates : []) {
        const group = getGroup(candidate.canonicalSource, candidate.kind);
        if (!group) continue;
        for (const alias of Array.isArray(candidate.aliases) ? candidate.aliases : []) addText(group.aliases, alias, 100);
        addText(group.targets, candidate.targetProposal, 120);
      }
    }
  }

  if (runId && tableExists(db, 'run_name_decisions')) {
    const rows = db.prepare(
      'SELECT source, aliases_json, target, kind FROM run_name_decisions WHERE run_id = ?'
    ).all(runId) as any[];
    for (const row of rows) {
      const group = getGroup(row.source, row.kind);
      if (!group) continue;
      for (const alias of parseJson(row.aliases_json, [])) addText(group.aliases, alias, 100);
      addText(group.targets, row.target, 120);
    }
  }

  return groups;
}

function rowMatchesGroup(row: AcceptedTranslationRow, group: NameGroup): string | null {
  if (sourceNameMatches(row.sourceText, group.source)) return group.source;
  for (const alias of group.aliases) {
    if (sourceNameMatches(row.sourceText, alias)) return alias;
  }
  return null;
}

/**
 * 对一个来源名统计已采纳译文中的实际目标表面。
 * 同一片段只贡献一次；目标包含关系有歧义时保留更完整的名称。
 */
export function chooseAcceptedTranslationTarget(
  targets: string[],
  rows: Array<{ segmentId: string; translation: string; ordinal: number }>,
): TargetVote | null {
  const uniqueTargets = Array.from(new Set(targets.map((item) => String(item || '').trim()).filter(Boolean)));
  const votes = new Map<string, TargetVote>();
  for (const target of uniqueTargets) votes.set(target, { target, count: 0, firstOrdinal: Number.MAX_SAFE_INTEGER, rows: [] });
  for (const row of rows) {
    const hits = uniqueTargets.filter((target) => hasText(row.translation, target));
    const mostSpecific = hits.filter((target) => !hits.some((other) =>
      other !== target && hasText(other, target) && other.length > target.length));
    // 一段译文里同时出现多个候选译名时属于歧义证据，不让同一片段给两个方案投票。
    if (mostSpecific.length !== 1) continue;
    for (const target of mostSpecific) {
      const vote = votes.get(target)!;
      if (vote.rows.some((item) => item.segmentId === row.segmentId)) continue;
      vote.count++;
      vote.firstOrdinal = Math.min(vote.firstOrdinal, Number(row.ordinal));
      vote.rows.push(row as AcceptedTranslationRow);
    }
  }
  const ranked = Array.from(votes.values()).filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.firstOrdinal - b.firstOrdinal ||
      normalizeEntityName(a.target).localeCompare(normalizeEntityName(b.target)));
  return ranked[0] || null;
}

function firstRunMentionOrdinals(db: any, runId: string, sourceRevisionId: string, groups: Map<string, NameGroup>): Map<string, number> {
  const rows = db.prepare(
    'SELECT s.ordinal, s.text FROM run_segments rs JOIN source_segments s ON s.segment_id = rs.segment_id ' +
    'AND s.source_revision_id = ? WHERE rs.run_id = ? ORDER BY s.ordinal'
  ).all(sourceRevisionId, runId) as Array<{ ordinal: number; text: string }>;
  const result = new Map<string, number>();
  for (const [key, group] of groups) {
    let first = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (rowMatchesGroup({ sourceText: row.text } as AcceptedTranslationRow, group)) {
        first = Math.min(first, Number(row.ordinal));
      }
    }
    if (Number.isFinite(first)) result.set(key, first);
  }
  return result;
}

function readRunDecisions(db: any, runId: string): RunNameDecision[] {
  const rows = db.prepare(
    'SELECT source, aliases_json, target, kind, source_status, decision_source, decided_ordinal, evidence_segment_ids_json ' +
    'FROM run_name_decisions WHERE run_id = ? ORDER BY decided_ordinal, normalized_source'
  ).all(runId) as any[];
  return rows.map((row) => ({
    source: String(row.source || ''),
    aliases: parseJson(row.aliases_json, []),
    target: String(row.target || ''),
    kind: String(row.kind || 'other'),
    sourceStatus: row.source_status,
    decisionSource: row.decision_source,
    decidedOrdinal: Number(row.decided_ordinal),
    evidenceSegmentIds: parseJson(row.evidence_segment_ids_json, []),
  })).filter((item) => item.source && item.target);
}

/**
 * 在 Run 的第一批模型请求之前建立不可变命名决议。
 * 即使没有可用决议，也写 snapshot 行，保证服务重启后不会拿更新后的语料重算同一 Run。
 */
export function prepareRunNameDecisions(
  store: DocumentProjectStore,
  projectId: string,
  runId: string,
  context: any,
): RunNameDecision[] {
  const db = store.getProjectContext(projectId).db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingSnapshot = db.prepare(
      'SELECT source_revision_id FROM run_name_decision_snapshots WHERE run_id = ?'
    ).get(runId) as { source_revision_id?: string } | undefined;
    if (existingSnapshot) {
      if (existingSnapshot.source_revision_id !== context.run.sourceRevisionId) {
        throw new Error('Run 命名决议快照与原文版本不一致，拒绝复用。');
      }
      const existing = readRunDecisions(db, runId);
      db.exec('COMMIT');
      return existing;
    }

    const memory = context.memory && typeof context.memory === 'object'
      ? context.memory as Record<string, any>
      : store.getCurrentLiteraryMemory(projectId).memory;
    const groups = loadNameGroups(db, context.run.sourceRevisionId, memory);
    const firstMentions = firstRunMentionOrdinals(db, runId, context.run.sourceRevisionId, groups);
    const accepted = acceptedRows(db, context.run.sourceRevisionId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO run_name_decisions(run_id, normalized_source, source, aliases_json, target, kind, source_status, decision_source, decided_ordinal, evidence_segment_ids_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    let explicitConflictCount = 0;
    let acceptedDecisionCount = 0;
    let userDecisionCount = 0;

    for (const [key, group] of groups) {
      const firstMention = firstMentions.get(key);
      if (firstMention === undefined) continue;
      const explicitTargets = Array.from(new Set(group.explicitTargets
        .map((item) => item.target).filter(Boolean)));
      let decision: RunNameDecision | null = null;
      if (explicitTargets.length === 1) {
        const explicitSource = group.explicitTargets.some((item) => item.source === 'memory') ? 'user-confirmed-memory' : 'user-confirmed-context-graph';
        const target = explicitTargets[0]!;
        if (!validateCanonicalTarget({ source: group.source, target, targetLang: String(context.run.targetLang || 'zh'), kind: group.kind }).valid) {
          // 用户确认的值不合格时也失败关闭；不能绕过用户决定退回模型/历史投票。
          explicitConflictCount++;
          continue;
        }
        decision = {
          source: group.source, aliases: Array.from(group.aliases).slice(0, 12), target, kind: group.kind,
          sourceStatus: explicitSource === 'user-confirmed-memory' ? 'confirmed-memory' : 'confirmed',
          decisionSource: explicitSource, decidedOrdinal: -1, evidenceSegmentIds: [],
        };
        userDecisionCount++;
      } else if (explicitTargets.length > 1) {
        explicitConflictCount++;
        continue;
      }

      if (!decision) {
        const priorRows = accepted.filter((row) =>
          // 同一原文片段在此前 Run 已采纳的译文也是合法先例；它不是未来章节知识，且 source_hash 已锁定。
          Number(row.ordinal) <= firstMention && !!rowMatchesGroup(row, group));
        const vote = chooseAcceptedTranslationTarget(
          Array.from(group.targets),
          priorRows,
        );
        if (!vote || !validateCanonicalTarget({
          source: group.source, target: vote.target, targetLang: String(context.run.targetLang || 'zh'), kind: group.kind,
        }).valid) continue;
        decision = {
          source: group.source, aliases: Array.from(group.aliases).slice(0, 12), target: vote.target, kind: group.kind,
          sourceStatus: 'run-canonical', decisionSource: 'accepted-translation',
          decidedOrdinal: vote.firstOrdinal,
          evidenceSegmentIds: vote.rows.map((row) => row.segmentId).slice(0, 24),
        };
        acceptedDecisionCount++;
      }
      insert.run(
        runId, key, decision.source, JSON.stringify(decision.aliases), decision.target, decision.kind,
        decision.sourceStatus, decision.decisionSource, decision.decidedOrdinal,
        JSON.stringify(decision.evidenceSegmentIds), now,
      );
    }

    const decisionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM run_name_decisions WHERE run_id = ?').get(runId)?.count || 0);
    db.prepare(
      'INSERT INTO run_name_decision_snapshots(run_id, source_revision_id, decision_count, created_at) VALUES (?, ?, ?, ?)'
    ).run(runId, context.run.sourceRevisionId, decisionCount, now);
    const decisions = readRunDecisions(db, runId);
    store.appendEvent(projectId, runId, 'translation.naming.decisions.prepared', {
      decisionCount,
      userDecisionCount,
      acceptedTranslationDecisionCount: acceptedDecisionCount,
      explicitConflictCount,
      sourceRevisionId: context.run.sourceRevisionId,
      policy: 'user-confirmed > prior-accepted-translation-majority > evidence-aligned-memory-or-graph; first-write-wins-per-run',
      preview: decisions.slice(0, 20).map((item) => ({
        source: item.source, target: item.target, sourceStatus: item.sourceStatus,
        decisionSource: item.decisionSource, decidedOrdinal: item.decidedOrdinal,
      })),
    });
    db.exec('COMMIT');
    return decisions;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}

/**
 * Run 结束且候选已经采纳后，用真实译文重新核对 LiteraryMemory / Context Graph。
 * 只更新非用户确认记录；不覆盖任何已采纳译文，分歧只生成可应用的 review finding。
 */
export function consolidateAcceptedRunNames(
  store: DocumentProjectStore,
  projectId: string,
  runId: string,
  context: any,
): Record<string, number> {
  const db = store.getProjectContext(projectId).db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const sourceRevisionId = String(context.run.sourceRevisionId || '');
    const currentSourceRevisionId = String(store.getProjectContext(projectId).currentSourceRevisionId || '');
    if (!sourceRevisionId || sourceRevisionId !== currentSourceRevisionId) {
      throw new Error('原文版本已变化，跳过旧 Run 的命名记忆回校；已采纳译文保持不变。');
    }
    const memoryResult = store.getCurrentLiteraryMemory(projectId);
    const memory = memoryResult.memory as Record<string, any>;
    const groups = loadNameGroups(db, sourceRevisionId, memory, runId);
    const accepted = acceptedRows(db, sourceRevisionId);
    const runSegmentIds = new Set((db.prepare(
      'SELECT segment_id FROM run_segments WHERE run_id = ?'
    ).all(runId) as Array<{ segment_id: string }>).map((row) => row.segment_id));
    const targetLang = String(context.run.targetLang || 'zh');
    let memoryEntityCount = 0;
    let graphNodeCount = 0;
    let minorityFindingCount = 0;
    let correctedCount = 0;
    const corrected: Array<{ source: string; previousTarget: string; target: string; evidenceCount: number }> = [];
    let memoryChanged = false;
    const entities = Array.isArray(memory.entities) ? memory.entities : [];

    for (const [key, group] of groups) {
      // 只回校本次 Run 真正采纳的名字；但目标表面仍以全书有效已采纳译文投票，避免单个局部 Run 反向改写全书规范。
      const runMatchingRows = accepted.filter((row) => runSegmentIds.has(row.segmentId) && !!rowMatchesGroup(row, group));
      if (!runMatchingRows.length) continue;
      const matchingRows = accepted.filter((row) => !!rowMatchesGroup(row, group));
      const explicitTargets = Array.from(new Set(group.explicitTargets.map((item) => item.target).filter(Boolean)));
      if (explicitTargets.length > 1) continue;
      const vote = explicitTargets.length === 1
        ? (() => {
            const target = explicitTargets[0]!;
            const rows = matchingRows.filter((row) => hasText(row.translation, target));
            return rows.length ? {
              target, count: rows.length,
              firstOrdinal: Math.min(...rows.map((row) => Number(row.ordinal))), rows,
            } : null;
          })()
        : chooseAcceptedTranslationTarget(Array.from(group.targets), matchingRows);
      if (!vote || !validateCanonicalTarget({ source: group.source, target: vote.target, targetLang, kind: group.kind }).valid) continue;

      const memoryEntity = entities.find((entity: any) => normalizeEntityName(String(entity?.source || '')) === key);
      if (memoryEntity && memoryEntity.reviewStatus !== 'rejected' &&
          !['user-confirmed', 'user-modified'].includes(String(memoryEntity.confirmationSource || ''))) {
        const previousTarget = String(memoryEntity.target || '');
        const targetEvidenceRefs = vote.rows.slice(0, 8).map((row) => ({
          segmentId: row.segmentId,
          sourceQuote: rowMatchesGroup(row, group) || group.source,
          targetSurface: vote.target,
        }));
        const evidenceRefs = Array.from(new Map([
          ...(Array.isArray(memoryEntity.evidenceRefs) ? memoryEntity.evidenceRefs : []),
          ...vote.rows.slice(0, 8).map((row) => ({
            segmentId: row.segmentId,
            sourceQuote: rowMatchesGroup(row, group) || group.source,
          })),
        ].map((item: any) => [String(item.segmentId) + '|' + normalizeEntityName(String(item.sourceQuote || '')), item])).values()).slice(0, 8);
        const next = {
          ...memoryEntity,
          target: vote.target,
          evidenceRefs,
          targetEvidenceRefs,
          targetConfidence: new Set(targetEvidenceRefs.map((item) => item.segmentId)).size >= 2 ? 'corroborated' : 'candidate',
          reviewStatus: 'confirmed',
          confirmationSource: 'consolidated',
        };
        if (JSON.stringify(next) !== JSON.stringify(memoryEntity)) {
          Object.assign(memoryEntity, next);
          memoryChanged = true;
          memoryEntityCount++;
          if (normalizeEntityName(previousTarget) !== normalizeEntityName(vote.target)) {
            corrected.push({ source: group.source, previousTarget, target: vote.target, evidenceCount: vote.count });
            correctedCount++;
          }
        }
      }

      const graphRows = tableExists(db, 'context_graph_nodes')
        ? db.prepare('SELECT node_id, name, kind, status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ?').all(sourceRevisionId) as any[]
        : [];
      for (const row of graphRows) {
        const attributes = parseJson(row.attributes_json, {});
        const graphNames = new Set([String(row.name || ''), ...(Array.isArray(attributes.aliases) ? attributes.aliases : [])]
          .map((item) => normalizeEntityName(String(item || ''))).filter(Boolean));
        if (!graphNames.has(key) && !Array.from(group.aliases).some((alias) => graphNames.has(normalizeEntityName(alias)))) continue;
        if (row.status === 'confirmed' && attributes.adoptionSource !== 'model-default') continue;
        if (normalizeEntityName(String(attributes.suggestedTranslation || '')) === normalizeEntityName(vote.target)) continue;
        const updatedAttributes = {
          ...attributes,
          suggestedTranslation: vote.target,
          adoptionSource: 'model-default',
          translationConsolidation: {
            source: 'accepted-translations', runId, target: vote.target,
            acceptedSegmentCount: vote.count,
            evidenceSegmentIds: vote.rows.map((item) => item.segmentId).slice(0, 24),
          },
        };
        db.prepare('UPDATE context_graph_nodes SET attributes_json = ?, updated_at = ? WHERE node_id = ? AND source_revision_id = ?')
          .run(JSON.stringify(updatedAttributes), new Date().toISOString(), row.node_id, sourceRevisionId);
        graphNodeCount++;
      }

      const minorityTargets = Array.from(new Set(matchingRows.flatMap((row) =>
        Array.from(group.targets).filter((target) =>
          normalizeEntityName(target) !== normalizeEntityName(vote.target) && hasText(row.translation, target)))));
      for (const row of matchingRows) {
        if (!runSegmentIds.has(row.segmentId)) continue;
        const variants = minorityTargets.filter((target) => hasText(row.translation, target));
        if (!variants.length) continue;
        const proposedTranslation = variants.reduce((text, variant) => text.split(variant).join(vote.target), row.translation);
        if (proposedTranslation === row.translation) continue;
        const existing = db.prepare(
          "SELECT finding_id FROM review_findings WHERE run_id = ? AND segment_id = ? AND category = 'terminology' AND status = 'pending' LIMIT 1"
        ).get(runId, row.segmentId);
        if (existing) continue;
        const finding = {
          id: row.segmentId,
          category: 'terminology',
          priority: 'must_fix',
          sourceName: group.source,
          expectedTarget: vote.target,
          observedTargets: variants,
          currentTranslation: row.translation,
          proposedTranslation,
          applicationStatus: 'pending',
          generatedBy: 'translation-name-consolidation',
          explanation: '同一源名的已采纳译文存在不同目标表面。本建议只做确定性的名称替换，不会自动改写已采纳正文；应用前仍可检查上下文。',
        };
        db.prepare(
          "INSERT INTO review_findings(run_id, segment_id, category, priority, finding_json, status, created_at) VALUES (?, ?, 'terminology', 'must_fix', ?, 'pending', ?)"
        ).run(runId, row.segmentId, JSON.stringify(finding), new Date().toISOString());
        minorityFindingCount++;
      }
    }

    if (memoryChanged) store.saveLiteraryMemory(projectId, memory);
    const summary = {
      memoryEntityCount, graphNodeCount, correctedCount, minorityFindingCount,
      acceptedSegmentCount: accepted.length,
      corrected: corrected.slice(0, 20),
      policy: 'accepted-translation-evidence; user-decisions-preserved; accepted-texts-never-rewritten',
    };
    store.appendEvent(projectId, runId, 'translation.naming.consolidated', summary);
    db.exec('COMMIT');
    return { memoryEntityCount, graphNodeCount, correctedCount, minorityFindingCount };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}
