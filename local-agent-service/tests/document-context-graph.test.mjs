import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-context-graph-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const {
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  getContextGraph,
  getContextGraphStatus,
  buildProjectContextGraphBundle,
  reviewContextGraphItem,
  reviewContextGraphItems,
  clearReplaceableModelGeneratedContextGraphItems,
  startContextGraphAnalysis,
  persistSourceFeatureIndex,
  readSourceFeatureIndex,
  ensureSourceFeatureIndex,
  resetChapterSummariesForReanalysis,
} = await import('../src/documents/contextGraph.ts');
const { scanBookSegments } = await import('../src/documents/bookScan.ts');

test('retrieval injects matched graph records and excludes future chapter summaries', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Graph Test',
    format: 'txt',
    sourceFileName: 'context-test.txt',
    prompt: { translationMode: 'literary' },
    segments: [
      { id: 'chapter-1-seg-1', text: 'Alice spoke politely to Bob. Ishido stood nearby.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-2-seg-2', text: 'Alice later found the hidden staircase behind the locked door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'chapter-3-seg-1', text: 'Alice revealed the secret passage to Ishido.', kind: 'paragraph', contextPath: 'Chapter 3' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  // Initializing through the public reader applies the production schema.
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  const insertNode = db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertNode.run('node-alice', currentSourceRevisionId, 'character', 'Alice', 'alice',
    JSON.stringify({ aliases: ['Ally'], role: 'protagonist', traits: [], voice: ['measured'] }),
    'confirmed', now, now);
  insertNode.run('node-bob', currentSourceRevisionId, 'character', 'Bob', 'bob',
    JSON.stringify({ aliases: [], role: 'companion', traits: [], voice: ['terse'] }),
    'candidate', now, now);
  insertNode.run('node-future', currentSourceRevisionId, 'entity', 'secret passage', 'secret passage',
    JSON.stringify({ aliases: ['locked door'], entityKind: 'location', significance: 'future reveal', suggestedTranslation: '密道' }),
    'confirmed', now, now);
  insertNode.run('node-hidden-identity', currentSourceRevisionId, 'entity', 'Queen Ash', 'queen ash',
    JSON.stringify({ aliases: ['Bob'], entityKind: 'character', significance: 'hidden identity', suggestedTranslation: '灰后' }),
    'confirmed', now, now);
  insertNode.run('node-ishido', currentSourceRevisionId, 'character', 'Ishido', 'ishido',
    JSON.stringify({ aliases: [], suggestedTranslation: '石堂', role: 'military governor', traits: [], voice: ['formal'] }),
    'candidate', now, now);
  db.prepare(
    'INSERT INTO context_graph_edges(edge_id, source_revision_id, source_node_id, target_node_id, kind, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('edge-alice-bob', currentSourceRevisionId, 'node-alice', 'node-bob', 'relation',
    JSON.stringify({ predicate: 'trusts', adoptionSource: 'model-default' }), 'confirmed', now, now);
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  );
  insertEvidence.run(currentSourceRevisionId, 'node-alice', 'chapter-1-seg-1', 'Alice spoke politely', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-bob', 'chapter-1-seg-1', 'Bob', 'character', now);
  insertEvidence.run(currentSourceRevisionId, 'node-future', 'chapter-3-seg-1', 'secret passage', 'entity', now);
  // A single early citation cannot make a later-only canonical name safe, even when an alias
  // matches the current batch (an adversarial fixture for full-book inferred identities).
  insertEvidence.run(currentSourceRevisionId, 'node-hidden-identity', 'chapter-1-seg-1', 'Bob', 'entity', now);
  // The canonical name is present early, but its analyzed supporting evidence is later.
  // The target name may be reused as a glossary mapping without importing later plot facts.
  insertEvidence.run(currentSourceRevisionId, 'node-ishido', 'chapter-3-seg-1', 'Ishido', 'character', now);
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
  ).run(currentSourceRevisionId, 'edge-alice-bob', 'chapter-1-seg-1', 'Alice spoke politely to Bob.', 'relationship', now);
  const insertChapter = db.prepare(
    'INSERT INTO context_graph_chapters(source_revision_id, chapter_key, chapter_order, chapter_title, summary, summary_kind, segment_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertChapter.run(currentSourceRevisionId, 'Chapter 1', 0, 'Chapter 1', 'Alice met Bob for the first time.', 'model', '["chapter-1-seg-1"]', now);
  insertChapter.run(currentSourceRevisionId, 'Chapter 2', 1, 'Chapter 2', 'Later Alice found the hidden staircase behind the locked door.', 'model', '["chapter-2-seg-1","chapter-2-seg-2"]', now);
  insertChapter.run(currentSourceRevisionId, 'Chapter 3', 2, 'Chapter 3', 'Alice found the secret passage.', 'model', '["chapter-3-seg-1"]', now);

  const bundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', contextPath: 'Chapter 2' },
  ]);
  assert.ok(bundle);
  assert.deepEqual(bundle.characters.map((item) => item.name).sort(), ['Alice', 'Bob']);
  assert.deepEqual(bundle.relationships, [{
    sourceNodeId: 'node-alice',
    targetNodeId: 'node-bob',
    kind: 'observed-association',
    status: 'confirmed',
    confidence: 'candidate',
    evidence: [{ segmentId: 'chapter-1-seg-1', quote: 'Alice spoke politely to Bob.' }],
  }], 'even a confirmed graph co-occurrence is only a weak association unless the user confirmed a specific relation');
  assert.deepEqual(bundle.chapterSummaries.map((item) => item.chapter), ['Chapter 1']);
  assert.ok(!JSON.stringify(bundle).includes('hidden staircase'));
  assert.ok(!JSON.stringify(bundle).includes('secret passage'));
  assert.ok(!JSON.stringify(bundle).includes('future reveal'));
  assert.ok(!JSON.stringify(bundle).includes('密道'));
  assert.ok(!JSON.stringify(bundle).includes('Queen Ash'));
  assert.ok(!JSON.stringify(bundle).includes('hidden identity'));
  assert.ok(!JSON.stringify(bundle).includes('灰后'));

  const earlyNameBundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-1-seg-1', text: 'Alice spoke politely to Bob. Ishido stood nearby.', contextPath: 'Chapter 1' },
  ]);
  assert.ok(earlyNameBundle);
  assert.equal(earlyNameBundle.nameMappings.some((item) =>
    item.source === 'Ishido' && item.target === '石堂'), false,
  'a canonical spelling in the current batch cannot validate a target whose only supporting evidence is in a later chapter');
  // The source-visible name may still be translated naturally; an unverified graph target is not enforced.
  assert.ok(!JSON.stringify(earlyNameBundle).includes('military governor'));
  assert.ok(!JSON.stringify(earlyNameBundle).includes('secret passage'));
  assert.ok(!JSON.stringify(earlyNameBundle).includes('Queen Ash'));

  // A new graph edge/node ID must not bypass the user's durable LiteraryMemory rejection.
  const currentMemory = store.getCurrentLiteraryMemory(project.projectId);
  store.saveLiteraryMemory(project.projectId, {
    ...currentMemory.memory,
    rejectedItems: [{
      type: 'relationship', subject: 'Alice', predicate: 'trusts', object: 'Bob',
    }],
  });
  const relationRejectedBundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', contextPath: 'Chapter 2' },
  ]);
  assert.ok(relationRejectedBundle);
  assert.deepEqual(relationRejectedBundle.characters.map((item) => item.name).sort(), ['Alice', 'Bob']);
  assert.deepEqual(relationRejectedBundle.relationships, [],
    'a rejected relation must not leak through a still-active or newly-created graph edge');

  const latestMemory = store.getCurrentLiteraryMemory(project.projectId);
  store.saveLiteraryMemory(project.projectId, {
    ...latestMemory.memory,
    rejectedItems: [
      ...latestMemory.memory.rejectedItems,
      { type: 'entity', source: 'Alice', kind: 'person', aliases: ['Ally'] },
    ],
  });
  const entityRejectedBundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'chapter-2-seg-1', text: 'Alice asked Bob about the locked door.', contextPath: 'Chapter 2' },
  ]);
  assert.ok(entityRejectedBundle);
  assert.deepEqual(entityRejectedBundle.characters.map((item) => item.name), ['Bob'],
    'entity tombstones must suppress graph nodes by canonical name and aliases, not only by node ID');
  assert.deepEqual(entityRejectedBundle.relationships, []);

  const graph = getContextGraph(project.projectId);
  const status = getContextGraphStatus(project.projectId);
  assert.equal(status.sourceRevisionId, currentSourceRevisionId);
  // 扩展必须拿到「服务端当前版本」才能判断记录是否过期；本地硬编码副本会随服务端升版漂移。
  assert.equal(status.currentAnalysisVersion, CONTEXT_GRAPH_ANALYSIS_VERSION);
  assert.equal(status.counts.characters, 3);
  assert.equal(status.counts.entities, 2);
  assert.equal(status.counts.chapters, 3);
  assert.equal(status.counts.evidencedNodes, 5);
  assert.equal(status.status, 'not-started');
  assert.ok(!('nodes' in status) && !('edges' in status) && !('chapters' in status),
    'status polling must not copy the full graph and its evidence into extension state');
  assert.ok(!('bookSummary' in status.overview));
  assert.equal(typeof status.overview.narrativeStyle, 'string');
  assert.equal(typeof status.overview.styleRegister, 'string');
  assert.equal(typeof status.overview.styleRhythm, 'string');
  assert.equal(typeof status.overview.styleDialogue, 'string');
  assert.equal(typeof status.overview.styleDiction, 'string');
  assert.ok(Array.isArray(status.overview.styleRules));
  assert.ok(Array.isArray(status.overview.styleAvoid));
  assert.ok(JSON.stringify(status).length < 5000, 'status response should be a small projection');
  const alice = graph.nodes.find((item) => item.id === 'node-alice');
  assert.ok(alice);
  assert.equal(alice.evidence[0].segmentId, 'chapter-1-seg-1');
  assert.equal(alice.evidence[0].chapter, 'Chapter 1');
  assert.equal(typeof alice.evidence[0].ordinal, 'number');

  // The Agent trajectory tab starts from the most recent persisted events, then polls by cursor.
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 1 });
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 2 });
  store.appendEvent(project.projectId, 'trajectory-test-run', 'trajectory.test', { sequence: 3 });
  const recent = store.getEvents(project.projectId, 'trajectory-test-run', 0, 2, true);
  assert.deepEqual(recent.map((item) => item.payload.sequence), [2, 3]);
  const incremental = store.getEvents(project.projectId, 'trajectory-test-run', recent[0].eventId, 10);
  assert.deepEqual(incremental.map((item) => item.payload.sequence), [3]);
});

test('current-batch name evidence cannot promote a book-level target to an automatic canonical mapping', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Auto Canonical Mapping Test',
    format: 'txt',
    sourceFileName: 'auto-canonical-mapping.txt',
    segments: [
      { id: 'king-first', text: 'Timsen had been taken up by the King.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-next', text: 'The King looked through the papers.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'node-the-king', currentSourceRevisionId, 'character', 'the King', 'the king',
    JSON.stringify({ aliases: ['King'], suggestedTranslation: '国王', targetLang: 'zh' }),
    'candidate', now, now,
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  ).run(currentSourceRevisionId, 'node-the-king', 'king-first', 'the King', 'character', now);

  const bundle = buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-first', text: 'Timsen had been taken up by the King.', contextPath: 'Chapter 1' },
  ]);
  const mapping = bundle?.nameMappings.find((item) => item.source === 'the King');
  assert.equal(mapping, undefined,
    'evidence appearing only in the current batch must not validate a target inferred from whole-book analysis');
});

test('a prior alias cannot reveal a canonical identity whose name appears only later', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Alias Retrieval',
    format: 'txt',
    segments: [
      { id: 'alias-prior', text: 'King stepped through the door.', contextPath: 'Chapter 1' },
      { id: 'alias-current', text: 'King spoke to Max.', contextPath: 'Chapter 2' },
      { id: 'formal-future', text: 'The King revealed his identity.', contextPath: 'Chapter 3' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('node-formal-king', currentSourceRevisionId, 'character', 'The King', 'the king',
      JSON.stringify({ aliases: ['King'], suggestedTranslation: '国王', targetLang: 'zh' }), 'candidate', now, now);
  db.prepare('INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
    .run(currentSourceRevisionId, 'node-formal-king', 'alias-prior', 'King stepped through the door.', 'character', now);
  const bundle = buildProjectContextGraphBundle(project.projectId,
    [{ id: 'alias-current', text: 'King spoke to Max.', contextPath: 'Chapter 2' }],
    [{ id: 'alias-prior', text: 'King stepped through the door.', contextPath: 'Chapter 1' }],
    currentSourceRevisionId, 'zh');
  const mapping = bundle?.nameMappings.find((item) => item.source === 'The King');
  assert.equal(mapping, undefined,
    'a generated alias must not reveal a canonical identity before its formal name appears in the source');
});

test('Context Graph batch review is atomic when any requested item is missing', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Graph Atomic Review',
    format: 'txt',
    sourceFileName: 'context-graph-atomic-review.txt',
    prompt: { translationMode: 'literary' },
    segments: [{ id: 'atomic-source', text: 'Alice trusts Bob.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('atomic-alice', currentSourceRevisionId, 'character', 'Alice', 'alice',
    JSON.stringify({ adoptionSource: 'model-default' }), 'confirmed', now, now);
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  ).run(currentSourceRevisionId, 'atomic-alice', 'atomic-source', 'Alice trusts Bob.', 'character', now);

  assert.throws(() => reviewContextGraphItems(project.projectId, [
    { type: 'node', id: 'atomic-alice', status: 'rejected' },
    { type: 'edge', id: 'missing-edge', status: 'rejected' },
  ]), /找不到当前来源版本中的 Context Graph 项/);

  const row = db.prepare(
    'SELECT status, attributes_json FROM context_graph_nodes WHERE node_id = ? AND source_revision_id = ?',
  ).get('atomic-alice', currentSourceRevisionId);
  assert.equal(row.status, 'confirmed');
  assert.equal(JSON.parse(row.attributes_json).adoptionSource, 'model-default',
    'the valid first item must roll back when a later item in the batch is invalid');
});

test('batch graph rejection and LiteraryMemory revision commit or roll back together', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Atomic Graph and Memory Persistence',
    format: 'txt',
    sourceFileName: 'atomic-graph-memory.txt',
    prompt: { translationMode: 'literary' },
    segments: [{ id: 'atomic-memory-source', text: 'Alice trusts Bob.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  const insertNode = db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  );
  insertNode.run('atomic-alice', currentSourceRevisionId, 'character', 'Alice', 'alice',
    JSON.stringify({ adoptionSource: 'model-default' }), 'confirmed', now, now);
  insertEvidence.run(currentSourceRevisionId, 'atomic-alice', 'atomic-memory-source', 'Alice trusts Bob.', 'character', now);

  const memory = {
    version: 2, entities: [], relationships: [], styleGuide: {}, chapterSummaries: [],
    recentExamples: [], characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [], openQuestions: [],
  };
  reviewContextGraphItems(project.projectId, [
    { type: 'node', id: 'atomic-alice', status: 'rejected' },
  ], memory);
  assert.equal(getContextGraph(project.projectId).nodes.find((node) => node.id === 'atomic-alice').status, 'rejected');
  assert.ok(store.getCurrentLiteraryMemory(project.projectId).memoryRevisionId,
    'the matching LiteraryMemory revision must be committed with the graph decision');

  const rollbackProject = store.createProject({
    title: 'Atomic Graph Memory Rollback',
    format: 'txt',
    sourceFileName: 'atomic-graph-memory-rollback.txt',
    prompt: { translationMode: 'literary' },
    segments: [{ id: 'atomic-rollback-source', text: 'Carol knows Dave.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });
  const rollbackContext = store.getProjectContext(rollbackProject.projectId);
  getContextGraph(rollbackProject.projectId);
  rollbackContext.db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('rollback-carol', rollbackContext.currentSourceRevisionId, 'character', 'Carol', 'carol',
    JSON.stringify({ adoptionSource: 'model-default' }), 'confirmed', now, now);
  rollbackContext.db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  ).run(rollbackContext.currentSourceRevisionId, 'rollback-carol', 'atomic-rollback-source', 'Carol knows Dave.', 'character', now);

  const originalSave = store.saveLiteraryMemory;
  store.saveLiteraryMemory = () => { throw new Error('simulated LiteraryMemory write failure'); };
  try {
    assert.throws(() => reviewContextGraphItems(rollbackProject.projectId, [
      { type: 'node', id: 'rollback-carol', status: 'rejected' },
    ], memory), /simulated LiteraryMemory write failure/);
  } finally {
    store.saveLiteraryMemory = originalSave;
  }
  assert.equal(getContextGraph(rollbackProject.projectId).nodes.find((node) => node.id === 'rollback-carol').status, 'confirmed',
    'graph rejection must roll back when the LiteraryMemory revision cannot be saved');
});

test('Context Graph changes are rejected while a translation run is active', () => {
  const store = getDocumentProjectStore();
  const project = store.listProjects().find((item) => item.title === 'Context Graph Test');
  assert.ok(project);
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, {
    scope: { type: 'ids', ids: ['chapter-2-seg-1'] },
  });
  assert.equal(run.status, 'queued');
  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, {
    sourceRevisionId: run.sourceRevisionId,
    promptRevisionId: run.promptRevisionId,
    memoryRevisionId: run.literaryMemoryRevisionId,
    sourceSegmentIds: ['chapter-2-seg-1'],
    contextHash: 'brief-test-hash',
    contextChars: 1234,
    policyVersion: 'translation-brief-v1',
  });
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, 'brief-test-hash');
  assert.equal(snapshots[0].brief.sourceRevisionId, run.sourceRevisionId);
  assert.throws(
    () => reviewContextGraphItem(project.projectId, 'node', 'node-alice', 'confirmed'),
    /不能在运行中修改 Context Graph/,
  );
  assert.throws(
    () => startContextGraphAnalysis(project.projectId),
    /不能在运行中修改 Context Graph/,
  );
});


test('preprocessing persists source-revision-scoped feature index with exact source offsets', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Source Feature Index Test',
    format: 'txt',
    sourceFileName: 'source-feature-index.txt',
    segments: [
      { id: 'index-king-1', text: 'The King Rat watched Max. The King Rat raised his hand.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'index-king-2', text: 'Captain Vale whispered: “The King Rat has returned.” It will take twenty-four hours.', kind: 'dialogue', contextPath: 'Chapter 2' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const segments = (db.prepare(
    'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(currentSourceRevisionId));
  const scan = scanBookSegments(segments);
  persistSourceFeatureIndex(db, currentSourceRevisionId, segments, scan);

  const index = readSourceFeatureIndex(db, currentSourceRevisionId);
  assert.ok(index);
  assert.equal(index.indexVersion, 'book-scan-index-v3');
  assert.equal(index.sourceSegmentCount, 2);
  assert.equal(index.segments.size, 2);

  const first = index.segments.get('index-king-1');
  const titled = first.entityMentions.find((item) => item.surface === 'The King Rat');
  assert.ok(titled);
  assert.equal(segments[0].text.slice(titled.start, titled.end), 'The King Rat');

  const second = index.segments.get('index-king-2');
  const captain = second.entityMentions.find((item) => item.surface === 'Captain Vale');
  assert.ok(captain);
  assert.equal(segments[1].text.slice(captain.start, captain.end), 'Captain Vale');
  const quotation = second.textUnits.find((item) =>
    item.unitType === 'quotation' && segments[1].text.slice(item.start, item.end) === 'The King Rat has returned.');
  assert.ok(quotation);
  const quantity = second.quantityMentions.find((item) => item.surface === 'twenty-four hours');
  assert.ok(quantity);
  assert.equal(segments[1].text.slice(quantity.start, quantity.end), quantity.surface);
  assert.ok(index.diagnostics.textUnitCount >= 3);

  assert.equal(readSourceFeatureIndex(db, 'missing-source-revision'), null,
    'feature index must never be read across source revisions');
});


test('legacy project gets a deterministic source index without re-running Context Graph model analysis', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Lazy Source Feature Index Upgrade',
    format: 'txt',
    sourceFileName: 'lazy-source-index.txt',
    segments: [
      { id: 'lazy-1', text: 'The King Rat watched Max. “Stay here.”', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'lazy-2', text: 'Captain Vale said: “Stay here.” It lasted twelve hours.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  assert.equal(readSourceFeatureIndex(db, currentSourceRevisionId), null);

  const summary = ensureSourceFeatureIndex(project.projectId, currentSourceRevisionId);
  assert.equal(summary.indexVersion, 'book-scan-index-v3');
  assert.equal(summary.sourceSegmentCount, 2);
  assert.ok(readSourceFeatureIndex(db, currentSourceRevisionId));
  const events = store.getEvents(project.projectId);
  const ready = events.find((event) => event.type === 'context-graph.source-index.ready');
  assert.ok(ready, 'index upgrade should be observable and durable');
  assert.equal(ready.payload.upgrade, true);
  assert.equal(ready.payload.sourceRevisionId, currentSourceRevisionId);
});

test('literary memory save events retain compact entity and character-voice sync diagnostics', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Literary Memory Sync Diagnostics',
    format: 'txt',
    sourceFileName: 'literary-memory-sync.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-evidence', text: 'The King spoke quietly and said, “Leave it to me.”', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });

  const memory = {
    version: 2,
    entities: [{
      source: 'the King', target: '国王', kind: 'person', aliases: ['King'],
      evidence: 'The King spoke quietly and said, “Leave it to me.”',
      evidenceRefs: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King spoke quietly and said, “Leave it to me.”',
      }],
      reviewStatus: 'suggested',
    }],
    relationships: [],
    styleGuide: {}, styleGuideStatus: 'candidate',
    chapterSummaries: [], recentExamples: [],
    characterVoices: [{
      characterId: 'context-graph-king',
      canonicalSourceName: 'the King',
      targetName: '国王',
      aliases: ['King', 'Corporal King'],
      status: 'candidate',
      confidence: 0.55,
      role: '战俘营中的美国下士',
      traits: ['精明'],
      voiceCore: { register: '简短、克制' },
      contrastRules: [],
      evidence: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King spoke quietly and said, “Leave it to me.”',
        observation: '语气克制、直接',
        dimension: 'register',
        confidence: 0.8,
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [], voiceAnchors: [],
  };

  const first = store.saveLiteraryMemory(project.projectId, memory);
  const second = store.saveLiteraryMemory(project.projectId, memory);
  assert.equal(first.memoryRevisionId, second.memoryRevisionId,
    'an identical literary-memory revision should be reused without hiding the second sync attempt');

  const events = store.getEvents(project.projectId);
  const savedEvents = events.filter((event) => event.type === 'literary-memory.saved');
  assert.equal(savedEvents.length, 2);
  const firstPayload = savedEvents[0].payload;
  const secondPayload = savedEvents[1].payload;
  assert.equal(firstPayload.entityCount, 1);
  assert.equal(firstPayload.characterCount, 1);
  assert.equal(firstPayload.candidateCharacterCount, 0);
  assert.equal(firstPayload.confirmedCharacterCount, 1);
  assert.equal(firstPayload.reusedRevision, false);
  assert.equal(secondPayload.reusedRevision, true);
  assert.equal(firstPayload.literaryEntities[0].source, 'the King');
  assert.equal(firstPayload.characterProfiles[0].canonicalSourceName, 'the King');
  assert.deepEqual(firstPayload.characterProfiles[0].aliases, ['King', 'Corporal King']);
  assert.equal(firstPayload.characterProfiles[0].status, 'confirmed');
  assert.equal(firstPayload.characterProfiles[0].evidenceCount, 1);
  assert.ok(!JSON.stringify(firstPayload).includes('Leave it to me.'),
    'diagnostic events record evidence counts, never full source quotations');
});

test('re-analysis resets model chapter summaries without violating the NOT NULL columns', () => {
  const store = getDocumentProjectStore();
  const segments = [
    { id: 'reset-ch1-s1', text: 'Alice opened the iron gate.', kind: 'paragraph', contextPath: 'Chapter 1' },
    { id: 'reset-ch1-s2', text: 'Alice counted the steps.', kind: 'paragraph', contextPath: 'Chapter 1' },
    { id: 'reset-ch2-s1', text: 'Bob waited in the rain.', kind: 'paragraph', contextPath: 'Chapter 2' },
  ];
  const project = store.createProject({
    title: 'Chapter Reset Test',
    format: 'txt',
    sourceFileName: 'chapter-reset.txt',
    prompt: { translationMode: 'literary' },
    segments,
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  // 通过公共读取器初始化生产 schema。
  getContextGraph(project.projectId);

  // 模拟上一轮预处理留下的模型摘要：summary_kind='model'。
  db.prepare(
    'INSERT INTO context_graph_chapters(source_revision_id, chapter_key, chapter_order, chapter_title, summary, summary_kind, segment_ids_json, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(currentSourceRevisionId, 'Chapter 1', 0, 'Chapter 1', '上一轮模型摘要', 'model', '[]', new Date().toISOString());
  const before = db.prepare(
    'SELECT summary, summary_kind FROM context_graph_chapters WHERE source_revision_id = ? AND chapter_key = ?'
  ).get(currentSourceRevisionId, 'Chapter 1');
  assert.equal(before.summary_kind, 'model');

  // 回归点：旧实现写 summary = NULL，会在第二次预处理时抛 NOT NULL constraint failed。
  const ordered = segments.map((segment, ordinal) => ({ ...segment, ordinal }));
  resetChapterSummariesForReanalysis(db, currentSourceRevisionId, ordered);

  const rows = db.prepare(
    'SELECT chapter_key, summary, summary_kind, segment_ids_json FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order'
  ).all(currentSourceRevisionId);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.summary_kind, 'extractive', row.chapter_key + ' 必须降级为确定性摘要');
    assert.ok(row.summary.length > 0, row.chapter_key + ' 的确定性摘要必须被重新生成');
    assert.notEqual(row.summary, '上一轮模型摘要');
    assert.ok(JSON.parse(row.segment_ids_json).length > 0);
  }
});


test('reanalysis cleanup preserves rejected/user-confirmed graph items and protected endpoints', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Graph Adoption Cleanup',
    format: 'txt',
    sourceFileName: 'context-graph-adoption-cleanup.txt',
    prompt: { translationMode: 'literary' },
    segments: [{ id: 'cleanup-source', text: 'Alice trusts Bob.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  getContextGraph(project.projectId);
  const now = new Date().toISOString();
  const insertNode = db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const nodes = [
    ['n-model', 'Model Node', { adoptionSource: 'model-default' }, 'confirmed'],
    ['n-rejected', 'Rejected Node', { adoptionSource: 'user-rejected' }, 'rejected'],
    ['n-user', 'User Node', { adoptionSource: 'user-confirmed' }, 'confirmed'],
    ['n-protected-model', 'Model Endpoint', { adoptionSource: 'model-default' }, 'confirmed'],
    ['n-candidate', 'Candidate Node', { adoptionSource: 'model-default' }, 'candidate'],
  ];
  for (const [id, name, attributes, status] of nodes) {
    insertNode.run(id, currentSourceRevisionId, 'character', name, String(name).toLowerCase(),
      JSON.stringify(attributes), status, now, now);
  }
  const insertEdge = db.prepare(
    'INSERT INTO context_graph_edges(edge_id, source_revision_id, source_node_id, target_node_id, kind, attributes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const edges = [
    ['e-model', 'n-model', 'n-user', { adoptionSource: 'model-default' }, 'confirmed'],
    ['e-rejected', 'n-rejected', 'n-user', { adoptionSource: 'user-rejected' }, 'rejected'],
    ['e-user', 'n-protected-model', 'n-user', { adoptionSource: 'user-confirmed' }, 'confirmed'],
    ['e-candidate', 'n-candidate', 'n-user', { adoptionSource: 'model-default' }, 'candidate'],
  ];
  for (const [id, source, target, attributes, status] of edges) {
    insertEdge.run(id, currentSourceRevisionId, source, target, 'relation',
      JSON.stringify(attributes), status, now, now);
  }
  const insertEvidence = db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [id] of nodes) {
    insertEvidence.run(currentSourceRevisionId, id, null, 'cleanup-source', 'Alice trusts Bob.', 'character', now);
  }
  for (const [id] of edges) {
    insertEvidence.run(currentSourceRevisionId, null, id, 'cleanup-source', 'Alice trusts Bob.', 'relationship', now);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    clearReplaceableModelGeneratedContextGraphItems(db, currentSourceRevisionId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const remainingNodes = db.prepare(
    'SELECT node_id, status FROM context_graph_nodes WHERE source_revision_id = ? ORDER BY node_id',
  ).all(currentSourceRevisionId);
  const remainingEdges = db.prepare(
    'SELECT edge_id, status FROM context_graph_edges WHERE source_revision_id = ? ORDER BY edge_id',
  ).all(currentSourceRevisionId);
  assert.deepEqual(remainingNodes.map((row) => row.node_id), ['n-protected-model', 'n-rejected', 'n-user']);
  assert.deepEqual(remainingEdges.map((row) => row.edge_id), ['e-rejected', 'e-user']);
  assert.equal(remainingNodes.find((row) => row.node_id === 'n-rejected').status, 'rejected');
  assert.equal(remainingEdges.find((row) => row.edge_id === 'e-rejected').status, 'rejected');
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM context_graph_evidence WHERE source_revision_id = ? AND node_id = ?',
  ).get(currentSourceRevisionId, 'n-rejected').count, 1);
});

test('source feature index is scoped to both source revision and source language', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Language Scoped Source Feature Index', format: 'txt', sourceFileName: 'language-scoped-index.txt',
    prompt: { translationMode: 'literary', sourceLang: 'fr', targetLang: 'zh' },
    segments: [
      { id: 'lang-index-1', text: 'Émile ouvrit la porte. «Bonjour», dit Émile.', kind: 'paragraph', contextPath: 'Chapitre 1' },
      { id: 'lang-index-2', text: 'Émile revint après trois mètres.', kind: 'paragraph', contextPath: 'Chapitre 2' },
    ],
  });
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  ensureSourceFeatureIndex(project.projectId, currentSourceRevisionId, 'fr');
  const french = readSourceFeatureIndex(db, currentSourceRevisionId, 'fr');
  assert.ok(french);
  assert.equal(french.sourceLang, 'fr');
  assert.ok(Array.from(french.segments.values()).some((features) => features.entityMentions.some((mention) => mention.surface === 'Émile')));
  assert.equal(readSourceFeatureIndex(db, currentSourceRevisionId, 'de'), null);
  ensureSourceFeatureIndex(project.projectId, currentSourceRevisionId, 'de');
  const german = readSourceFeatureIndex(db, currentSourceRevisionId, 'de');
  assert.ok(german);
  assert.equal(german.sourceLang, 'de');
  assert.equal(readSourceFeatureIndex(db, currentSourceRevisionId, 'fr'), null);
});
