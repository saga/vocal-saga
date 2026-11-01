/**
 * 残留与漂移审计：译文里没清干净的源语言虚词、上下文增量里的未生效实体、
 * 以及同一实体在不同段落被译成不同写法。
 *
 * 从 qualityAudit 抽出：这三类检查共享「源语言词表 + 归一化比对」的思路，
 * 放在一起便于统一调整阈值与词表。
 */

import { MAX_BULK_REPAIR_SEGMENTS, normalized, stableFindingId } from './qualityShared.ts';
import { normalizeAuditLanguage } from './qualityNumeric.ts';

// Catch likely source-language residue in Chinese translations. This is deliberately a review hint:
// Latin names, short isolated tokens not in the watchlist, and all stylistic decisions remain untouched.
const ENGLISH_RESIDUE_WORDS = new Set([
  'again','although','already','anyway','because','before','behind','between','beyond','could','during',
  'ever','however','indeed','instead','later','maybe','might','must','never','nothing','perhaps','rather',
  'really','should','since','still','though','through','until','unless','whether','while','would',
]);

const ENGLISH_FUNCTION_WORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does','for','from','had','has',
  'have','he','her','him','his','how','i','if','in','is','it','its','me','my','no','not','of','on','or',
  'our','she','so','than','that','the','their','them','then','there','they','this','to','was','we','were',
  'what','when','where','which','who','will','with','you','your',
]);

const RESIDUE_WORDS_BY_SOURCE_LANG: Record<string, Set<string>> = {
  fr: new Set(['déjà','était','étaient','encore','alors','pourtant','toujours','jamais','peut-être','bonjour','bonsoir','merci','salut','oui','non','voilà','ainsi','très','mais','donc','parce','pourquoi']),
  de: new Set(['schön','schon','nicht','doch','auch','aber','oder','und','der','die','das','ein','eine','ich','du','er','sie','wir','ihr','ja','nein','danke','hallo','ach','also','noch','schon','wieder','immer','nie','weil','wenn','dass','was','wie']),
  it: new Set(['allora','perché','perche','però','pero','già','gia','ancora','sempre','mai','ciao','grazie','buongiorno','buonasera','salve','sì','si','no','non','che','come','dunque','quindi','anche','molto','era','sono']),
  es: new Set(['todavía','todavia','aunque','entonces','porque','porqué','quizá','quizás','siempre','nunca','ahora','pero','además','ademas','también','tambien','después','despues','antes','bien','hola','adiós','adios','gracias','buenos','buenas','días','dias','tardes','noches','señor','señora','qué','quién','cómo','dónde','cuándo','sí','si','no']),
  ja: new Set(),
};

const FUNCTION_WORDS_BY_SOURCE_LANG: Record<string, Set<string>> = {
  en: ENGLISH_FUNCTION_WORDS,
  fr: new Set(['je','tu','il','elle','nous','vous','ils','elles','le','la','les','un','une','des','de','du','et','mais','pas','ne','que','qui','dans','pour','avec','est','sont','était','était']),
  de: new Set(['ich','du','er','sie','es','wir','ihr','der','die','das','ein','eine','und','oder','aber','nicht','mit','von','zu','ist','war','sind','hat','haben','dass','weil','wenn','was','wie']),
  it: new Set(['io','tu','lui','lei','noi','voi','loro','il','lo','la','i','gli','le','un','una','di','da','e','ma','non','che','per','con','è','era','sono','ha']),
  es: new Set(['yo','tú','él','ella','ellos','ellas','nosotros','nosotras','ustedes','vosotros','vosotras','el','la','los','las','un','una','unos','unas','de','del','al','y','o','pero','porque','por','para','con','sin','en','sobre','entre','que','quien','quién','quienes','quiénes','como','cómo','cuando','cuándo','donde','dónde','no','sí','si','es','son','está','están','era','fue','ser','estar','se','me','te','nos','os','lo','le','les','mi','mis','su','sus','muy','más','menos','también','todo','cada']),
};

/**
 * 检测中文译文中残留的源语言词语/短语。
 */
export function englishResidueFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  targetLang: string,
  sourceLang = 'en',
): any[] {
  if (!/^(?:zh(?:[-_].*)?|chinese|中文|简体中文|繁体中文)$/iu.test(String(targetLang || '').trim())) return [];
  const language = normalizeAuditLanguage(sourceLang, segments.map((segment) => segment.text).join(' '));
  const residueWords = RESIDUE_WORDS_BY_SOURCE_LANG[language] || ENGLISH_RESIDUE_WORDS;
  const functionWords = FUNCTION_WORDS_BY_SOURCE_LANG[language] || ENGLISH_FUNCTION_WORDS;
  const phrasePattern = /(?<![\p{L}\p{M}])(?:[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*\s+){1,}[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*(?![\p{L}\p{M}])/gu;
  const wordPattern = /(?<![\p{L}\p{M}])[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*(?![\p{L}\p{M}])/gu;
  const japaneseResiduePattern = /[\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu;
  const findings: any[] = [];
  for (const segment of segments) {
    const translation = translations.get(segment.id) || '';
    if (!translation.trim()) continue;
    const residues = new Set<string>();
    for (const match of translation.matchAll(phrasePattern)) {
      const phrase = match[0].trim();
      const words = phrase.split(/\s+/u).filter((word) => word.length > 0);
      const hasFunctionWord = words.some((word) => functionWords.has(word.toLocaleLowerCase()));
      if (words.length >= 4 || hasFunctionWord) residues.add(phrase);
    }
    for (const match of translation.matchAll(wordPattern)) {
      const word = String(match[0] || '').toLocaleLowerCase();
      if (residueWords.has(word)) residues.add(String(match[0] || ''));
    }
    if (language === 'ja') {
      for (const match of translation.matchAll(japaneseResiduePattern)) residues.add(match[0]);
    }
    if (!residues.size) continue;
    const examples = Array.from(residues).slice(0, 5);
    findings.push({
      findingId: stableFindingId('english-residue', [segment.id], examples.join('|')),
      type: 'english-residue',
      category: 'coverage',
      severity: 'review',
      confidence: 'heuristic',
      repairable: true,
      segmentIds: [segment.id],
      chapter: segment.contextPath || null,
      sourceExcerpt: segment.text.slice(0, 240),
      translationExcerpt: translation.slice(0, 360),
      residueExamples: examples,
      explanation: '中文译文里仍存在疑似未翻译的源语言词语或短语。人名、专名和刻意保留的外语表达也可能命中；日文汉字与中文汉字无法仅凭字形可靠区分，请结合上下文人工判断。',
    });
  }
  return findings;
}

/**
 * 检测 context_delta 中同一实体提出不同译名的冲突。
 */
export function translationContextDeltaFindings(db: any, runId: string | undefined, validSourceIds: Set<string>, sourceRevisionId: string): any[] {
  if (!runId) return [];
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
  if (!run || run.source_revision_id !== sourceRevisionId) return [];
  const rows = db.prepare(
    'SELECT batch_index, delta_json FROM translation_context_deltas WHERE run_id = ? ORDER BY first_ordinal, first_segment_id'
  ).all(runId) as Array<{ batch_index: number; delta_json: string }>;
  type TargetProposal = { target: string; segmentIds: Set<string>; batches: Set<number> };
  type ProposalGroup = { source: string; names: Set<string>; targets: Map<string, TargetProposal> };
  const groups: ProposalGroup[] = [];
  const normalizeEntityName = (value: unknown) => normalized(String(value || '')).replace(/[._'’\-]+/g, ' ').trim();
  for (const row of rows) {
    let delta: any = {};
    try { delta = JSON.parse(row.delta_json || '{}'); } catch { delta = {}; }
    const entities = Array.isArray(delta.entityCandidates) ? delta.entityCandidates : [];
    for (const entity of entities) {
      const source = typeof entity?.canonicalSource === 'string' ? entity.canonicalSource.trim() : '';
      const target = typeof entity?.targetProposal === 'string' ? entity.targetProposal.trim() : '';
      if (!source || !target) continue;
      const names = new Set([source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
        .map(normalizeEntityName).filter(Boolean));
      if (!names.size) continue;
      const matchingIndexes = groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => Array.from(names).some((name) => group.names.has(name)))
        .map(({ index }) => index);
      let group: ProposalGroup;
      if (!matchingIndexes.length) {
        group = { source, names: new Set(names), targets: new Map() };
        groups.push(group);
      } else {
        const canonicalIndex = matchingIndexes[0]!;
        group = groups[canonicalIndex]!;
        for (const name of names) group.names.add(name);
        // Explicit alias bridges can connect prior groups. Merge them without fuzzy substring
        // matching, retaining source-order target proposals and their exact evidence locations.
        for (const index of matchingIndexes.slice(1).reverse()) {
          const bridged = groups[index]!;
          for (const name of bridged.names) group.names.add(name);
          for (const [key, proposal] of bridged.targets) {
            if (!group.targets.has(key)) {
              group.targets.set(key, proposal);
            } else {
              const prior = group.targets.get(key)!;
              for (const id of proposal.segmentIds) prior.segmentIds.add(id);
              for (const batch of proposal.batches) prior.batches.add(batch);
            }
          }
          groups.splice(index, 1);
        }
      }
      const targetKey = normalizeEntityName(target);
      if (!group.targets.has(targetKey)) group.targets.set(targetKey, { target, segmentIds: new Set(), batches: new Set() });
      const targetGroup = group.targets.get(targetKey)!;
      targetGroup.batches.add(Number(row.batch_index));
      for (const evidence of Array.isArray(entity.evidence) ? entity.evidence : []) {
        const segmentId = typeof evidence?.segmentId === 'string' ? evidence.segmentId : '';
        if (validSourceIds.has(segmentId)) targetGroup.segmentIds.add(segmentId);
      }
    }
  }
  const findings: any[] = [];
  for (const group of groups) {
    if (group.targets.size < 2) continue;
    const targetOptions = Array.from(group.targets.values()).map((item) => ({
      target: item.target, batchIndexes: Array.from(item.batches).sort((a, b) => a - b),
      segmentIds: Array.from(item.segmentIds).sort(),
    }));
    const segmentIds = Array.from(new Set(targetOptions.flatMap((item) => item.segmentIds))).sort();
    findings.push({
      findingId: stableFindingId('context-delta-conflict', segmentIds, group.source + ':' + targetOptions.map((item) => normalizeEntityName(item.target)).sort().join('|')),
      type: 'context-delta-conflict',
      category: 'context',
      severity: 'warning',
      confidence: 'deterministic-conflicting-proposals',
      repairable: false,
      segmentIds,
      entity: { source: group.source, names: Array.from(group.names).sort(), proposals: targetOptions },
      explanation: '不同初译批次通过规范名称或明确别名指向同一来源实体，却提出了不同译名。系统保留来源顺序中的首个候选并记录冲突，不会自动覆盖既有或人工确认的译名；请结合各位置原文决定这些称谓是否属于同一实体。',
    });
  }
  return findings;
}

/**
 * 检测同一实体在不同片段的译文表面形式不一致。
 */
export function entityMentionDriftFindings(
  db: any,
  runId: string | undefined,
  sourceRevisionId: string,
  sourceById: Map<string, string>,
  translations: Map<string, string>,
  knownEntities: unknown[] = [],
): any[] {
  if (!runId) return [];
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
  if (!run || run.source_revision_id !== sourceRevisionId) return [];
  const rows = db.prepare(
    'SELECT batch_index, first_segment_id, delta_json FROM translation_context_deltas WHERE run_id = ? ORDER BY first_ordinal, first_segment_id'
  ).all(runId) as Array<{ batch_index: number; first_segment_id: string; delta_json: string }>;
  type Mention = { segmentId: string; sourceQuote: string; targetSurface: string; batchIndex: number };
  type Candidate = { localId: string; source: string; target: string; batchIndex: number };
  type Group = { source: string; names: Set<string>; targets: Set<string>; candidates: Candidate[]; mentions: Mention[]; localIds: Set<string> };
  const groups: Group[] = [];
  const localIdToGroup = new Map<string, Group>();
  const normalizeName = (value: unknown) => normalized(String(value || '')).replace(/[._'’\\-]+/g, ' ').trim();
  const normalizeSurface = (value: unknown) => normalized(String(value || ''));

  const mergeGroup = (target: Group, other: Group) => {
    for (const name of other.names) target.names.add(name);
    for (const value of other.targets) target.targets.add(value);
    target.candidates.push(...other.candidates);
    target.mentions.push(...other.mentions);
    for (const localId of other.localIds) {
      target.localIds.add(localId);
      localIdToGroup.set(localId, target);
    }
  };
  const findOrCreate = (source: string, aliases: unknown[], target?: string, kind?: string): Group => {
    const names = new Set([source, ...(Array.isArray(aliases) ? aliases : [])].map(normalizeName).filter(Boolean));
    const matching = groups.filter((group) => Array.from(names).some((name) => group.names.has(name)));
    let group: Group;
    if (!matching.length) {
      group = { source, names: new Set(names), targets: new Set(), candidates: [], mentions: [], localIds: new Set() };
      groups.push(group);
    } else {
      group = matching[0]!;
      for (const name of names) group.names.add(name);
      for (const duplicate of matching.slice(1)) {
        mergeGroup(group, duplicate);
        groups.splice(groups.indexOf(duplicate), 1);
      }
    }
    if (target) group.targets.add(normalizeSurface(target));
    return group;
  };

  for (const raw of knownEntities.slice(0, 160)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entity = raw as Record<string, any>;
    const source = typeof entity.source === 'string' ? entity.source.trim() : '';
    const target = typeof entity.target === 'string' ? entity.target.trim() : '';
    if (source && target) findOrCreate(source, entity.aliases, target, entity.kind);
  }

  for (const row of rows) {
    let delta: any = {};
    try { delta = JSON.parse(row.delta_json || '{}'); } catch { delta = {}; }
    const candidates = Array.isArray(delta.entityCandidates) ? delta.entityCandidates : [];
    const currentLocalIds = new Set<string>();
    for (const entity of candidates) {
      const source = typeof entity?.canonicalSource === 'string' ? entity.canonicalSource.trim() : '';
      const target = typeof entity?.targetProposal === 'string' ? entity.targetProposal.trim() : '';
      const localId = typeof entity?.localId === 'string' ? entity.localId.trim() : '';
      if (!source || !target) continue;
      const group = findOrCreate(source, entity.aliases, target, entity.kind);
      if (localId) {
        localIdToGroup.set(localId, group);
        group.localIds.add(localId);
        currentLocalIds.add(localId);
      }
      group.candidates.push({ localId, source, target, batchIndex: Number(row.batch_index) });
    }
    const mentions = Array.isArray(delta.entityMentions) ? delta.entityMentions : [];
    for (const mention of mentions) {
      const segmentId = typeof mention?.segmentId === 'string' ? mention.segmentId : '';
      const sourceQuote = typeof mention?.sourceQuote === 'string' ? mention.sourceQuote.trim() : '';
      const targetSurface = typeof mention?.targetSurface === 'string' ? mention.targetSurface.trim() : '';
      const entityRef = typeof mention?.entityRef === 'string' ? mention.entityRef.trim() : '';
      const source = sourceById.get(segmentId) || '';
      const translated = translations.get(segmentId) || '';
      if (!segmentId || !source || !sourceQuote || !targetSurface || !entityRef ||
          !normalizeName(source).includes(normalizeName(sourceQuote)) ||
          !normalizeSurface(translated).includes(normalizeSurface(targetSurface))) continue;
      let group = localIdToGroup.get(entityRef);
      if (!group) {
        const name = normalizeName(entityRef);
        group = groups.find((candidate) => candidate.names.has(name));
      }
      if (!group) continue;
      // Keep evidence local to a real source segment; validation at audit time is deliberate in
      // case stored data was migrated or imported from an older implementation.
      group.mentions.push({ segmentId, sourceQuote, targetSurface, batchIndex: Number(row.batch_index) });
    }
  }

  const findings: any[] = [];
  for (const group of groups) {
    // If candidate targets themselves disagree, the separate context-delta conflict finding is
    // more accurate than conflating canonical target choice with actual surface rendering.
    if (group.targets.size > 1) continue;
    const bySurface = new Map<string, Mention[]>();
    for (const mention of group.mentions) {
      const key = normalizeSurface(mention.targetSurface);
      const values = bySurface.get(key) || [];
      values.push(mention);
      bySurface.set(key, values);
    }
    if (bySurface.size < 2) continue;
    const segmentIds = Array.from(new Set(group.mentions.map((item) => item.segmentId))).sort();
    if (segmentIds.length < 2) continue;
    findings.push({
      findingId: stableFindingId('entity-mention-drift', segmentIds,
        group.source + ':' + Array.from(bySurface.keys()).sort().join('|')),
      type: 'entity-mention-drift',
      category: 'consistency',
      severity: 'warning',
      confidence: 'deterministic-explicit-entity-mention',
      repairable: segmentIds.length <= MAX_BULK_REPAIR_SEGMENTS,
      segmentIds,
      entity: {
        source: group.source,
        aliases: Array.from(group.names).sort(),
        canonicalTarget: group.targets.values().next().value || null,
        surfaces: Array.from(bySurface.entries()).map(([surface, items]) => ({
          surface: items[0]?.targetSurface || surface,
          segmentIds: Array.from(new Set(items.map((item) => item.segmentId))).sort(),
          batchIndexes: Array.from(new Set(items.map((item) => item.batchIndex))).sort((a, b) => a - b),
        })),
      },
      explanation: '初译显式标记了指向同一来源实体的提及，但实际译文表面形式存在差异。系统只依据规范名称/明确别名关联产生提示；称谓、语法或语境也可能合理改变表面形式，因此需要结合原文人工复核。',
    });
  }
  return findings;
}
