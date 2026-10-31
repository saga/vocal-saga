import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-translation-brief-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { buildProjectVoiceContext } = await import('../src/documents/voiceContext.ts');
const { buildProjectContextGraphBundle } = await import('../src/documents/contextGraph.ts');
const { selectRecentPriorChapterSummaries } = await import('../src/documents/contextGraph.ts');
const { contextGraphCandidateDisposition } = await import('../src/documents/contextGraph.ts');
const { buildTranslationBrief, summarizeTranslationBrief, MAX_TRANSLATION_BRIEF_CHARS } = await import('../src/documents/translationBrief.ts');
const { buildBatches, buildCanonicalTermProtections, buildUserPrompt } = await import('../src/documents/translationAgent.ts');

test('TranslationBrief excludes rejected entities and preserves model-default target uncertainty', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Rejected Memory Projection',
    format: 'txt',
    sourceFileName: 'rejected-memory-projection.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [{
      id: 'memory-projection-1',
      text: 'Alice met Bob. Carol was absent.',
      kind: 'paragraph',
      contextPath: 'Chapter 1',
    }],
  });
  ensureTestContextGraph(store, project);
  store.saveLiteraryMemory(project.projectId, {
    version: 2,
    entities: [
      {
        source: 'Alice', target: '艾丽丝', kind: 'person', aliases: [],
        reviewStatus: 'confirmed', confirmationSource: 'model-default',
        evidenceRefs: [{ segmentId: 'memory-projection-1', sourceQuote: 'Alice met Bob.' }],
        targetConfidence: 'candidate',
      },
      {
        source: 'Bob', target: '鲍勃', kind: 'person', aliases: [],
        reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
      },
      {
        source: 'Carol', target: '卡罗尔', kind: 'person', aliases: [],
        reviewStatus: 'rejected', confirmationSource: 'user-rejected',
        evidenceRefs: [{ segmentId: 'memory-projection-1', sourceQuote: 'Carol was absent.' }],
      },
    ],
    relationships: [],
    styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['memory-projection-1'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 })
    .find((item) => item.id === 'memory-projection-1');
  const brief = buildTranslationBrief(context, [source], []);

  assert.equal(brief.voiceContext.entities.some((entity) => entity.source === 'Carol'), false);
  assert.equal(brief.contextGraph.nameMappings.some((mapping) => mapping.source === 'Carol'), false,
    'a rejected entity must not leak into the canonical-name mapping projection');
  const alice = brief.voiceContext.entities.find((entity) => entity.source === 'Alice');
  assert.equal(alice?.targetConfidence, 'candidate',
    'default adoption must not turn a weak target mapping into a protected canonical term');
  assert.equal(brief.contextGraph.nameMappings.find((mapping) => mapping.source === 'Alice')?.sourceStatus, 'candidate');
});

test('TranslationBrief is revision-pinned, bounded and hashes the source selection', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Brief Test',
    format: 'txt',
    sourceFileName: 'brief-test.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'c1-1', text: 'Mara Voss entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'c1-2', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'c2-1', text: 'Iven returned at midnight.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, {
    scope: { type: 'ids', ids: ['c1-1', 'c1-2'] },
  });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 });
  const first = buildTranslationBrief(context, source.slice(0, 1), []);
  const second = buildTranslationBrief(context, source.slice(1, 2), [
    { id: source[0].id, text: source[0].text, contextPath: source[0].contextPath },
  ]);

  assert.equal(first.sourceRevisionId, run.sourceRevisionId);
  assert.equal(first.promptRevisionId, run.promptRevisionId);
  assert.equal(first.memoryRevisionId, run.literaryMemoryRevisionId);
  assert.deepEqual(first.sourceSegmentIds, ['c1-1']);
  assert.equal(first.chapterPath, 'Chapter 1');
  assert.equal(first.policyVersion, 'translation-brief-v8-default-adoption');
  assert.ok(first.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
  assert.match(first.contextHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.contextHash, second.contextHash, 'context identity changes when source IDs and preceding context change');

  store.saveTranslationBriefSnapshot(project.projectId, run.runId, 1, first);
  const snapshots = store.listTranslationBriefSnapshots(project.projectId, run.runId, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].contextHash, first.contextHash);
  assert.deepEqual(snapshots[0].sourceSegmentIds, ['c1-1']);
  assert.equal(snapshots[0].brief.policyVersion, 'translation-brief-v8-default-adoption');

  const configuredContext = {
    ...context,
    prompt: {
      ...context.prompt,
      config: {
        ...context.prompt.config,
        translationStrategy: { precedingContextSegments: 1, contextBudgetChars: 8000 },
      },
    },
  };
  const configuredBrief = buildTranslationBrief(
    configuredContext,
    source.slice(2, 3),
    source.slice(0, 2).map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath })),
  );
  assert.equal(configuredBrief.precedingSegments.length, 1);
  assert.equal(configuredBrief.precedingSegments[0]?.id, source[1]?.id,
    'context count setting should retain only the closest earlier segment');
  assert.ok(configuredBrief.contextChars <= 8000);
});

test('literary batch planner never crosses a chapter boundary', () => {
  const items = [
    { id: 'a1', text: 'Mara entered.', contextPath: 'Chapter 1' },
    { id: 'a2', text: 'She looked at the lamp.', contextPath: 'Chapter 1' },
    { id: 'b1', text: 'Iven arrived.', contextPath: 'Chapter 2' },
  ];
  const ordinary = buildBatches(items, false);
  const literary = buildBatches(items, true);
  assert.equal(ordinary.length, 1);
  assert.deepEqual(literary.map((batch) => Array.from(new Set(batch.map((item) => item.contextPath)))), [
    ['Chapter 1'],
    ['Chapter 2'],
  ]);
});


test('future-supported glossary, character profile, anchor, examples and style text are excluded from an early TranslationBrief', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Temporal Knowledge Boundary Test',
    format: 'txt',
    sourceFileName: 'temporal-boundary.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'early-1', text: 'Mara Voss entered the archive and touched the old key.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'future-1', text: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.', kind: 'paragraph', contextPath: 'Chapter 8' },
    ],
  });
  store.saveManualEdit(project.projectId, 'future-1', '玛拉·沃斯其实是灰烬女王，也是密道的守护者。');
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Mara Voss',
      target: '灰烬女王',
      aliases: ['Queen of Ash'],
      kind: 'character',
      reviewStatus: 'confirmed',
      evidence: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.',
    }],
    relationships: [{
      subject: 'Mara Voss',
      predicate: 'guards',
      object: 'hidden passage',
      reviewStatus: 'confirmed',
      evidence: 'Mara Voss was the secret Queen of Ash, keeper of the hidden passage.',
    }],
    styleGuide: {
      narrativeVoice: 'The narrator gradually reveals that Mara is the Queen of Ash.',
      register: 'Literary',
      rhythm: 'Measured',
      dialogue: 'Restrained',
      diction: 'Gothic',
      avoid: [],
    },
    chapterSummaries: [{ chapter: 'Chapter 8', summary: 'Mara is the Queen of Ash.' }],
    recentExamples: [{ source: 'Mara Voss was the secret Queen of Ash.', target: '玛拉·沃斯其实是灰烬女王。', chapter: 'Chapter 8' }],
    characterVoices: [{
      characterId: 'mara-voss',
      canonicalSourceName: 'Mara Voss',
      targetName: '玛拉·沃斯',
      aliases: ['Queen of Ash'],
      status: 'confirmed',
      confidence: 0.95,
      voiceCore: { register: 'Cold and commanding', syntaxRhythm: [], lexicalPreferences: ['kneel'], discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [] },
      evidence: [{
        segmentId: 'future-1',
        sourceQuote: 'Mara Voss was the secret Queen of Ash',
        observation: 'Uses royal imperatives',
        dimension: 'register',
        confidence: 0.95,
      }],
      contrastRules: [],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [{
      anchorId: 'future-anchor',
      speakerId: 'mara-voss',
      source: 'keeper of the hidden passage',
      target: '密道守护者',
      chapter: 'Chapter 8',
      segmentId: 'future-1',
      attributionEvidence: 'Mara Voss was the secret Queen of Ash',
      attributionConfidence: 0.95,
      status: 'approved',
    }],
    openQuestions: [],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['early-1'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'early-1');
  const brief = buildTranslationBrief(context, [source], []);
  const serialized = JSON.stringify(brief);

  assert.ok(!serialized.includes('Queen of Ash'));
  assert.ok(!serialized.includes('hidden passage'));
  assert.ok(!serialized.includes('灰烬女王'));
  assert.ok(!serialized.includes('密道守护者'));
  assert.ok(!serialized.includes('gradually reveals'));
  assert.deepEqual(brief.voiceContext.entities, []);
  assert.deepEqual(brief.voiceContext.characterVoices, []);
  assert.deepEqual(brief.voiceContext.voiceAnchors, []);
  assert.deepEqual(brief.voiceContext.chapterSummaries, []);
});

test('later identity never enters an earlier brief', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Temporal Boundary',
    format: 'txt',
    sourceFileName: 'temporal.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh', glossary: { document_terms: [
      { source: 'Mara Voss', target: '玛拉·沃斯', aliases: ['Mara'] },
      // Canonical spelling is known early, but this target was derived from a later alias.
      { source: 'Mara Voss', target: '灰后', aliases: ['Queen Ash'], description: 'Target contaminated by a later identity reveal' },
      { source: 'Queen Ash', target: '灰后', aliases: ['Liora Vale'], description: 'Later identity reveal' },
    ] } },
    segments: [
      { id: 'early-a', text: 'Mara Voss is a careful archivist.', contextPath: 'Chapter 1' },
      { id: 'early-b', text: 'Mara Voss said, Keep the western lamp burning.', contextPath: 'Chapter 1' },
      { id: 'late-a', text: 'Mara Voss was secretly Queen Ash.', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['early-b'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  context.memory = {
    entities: [
      { source: 'Mara Voss', target: '玛拉·沃斯', aliases: ['Mara'], reviewStatus: 'confirmed', evidence: 'Mara Voss is a careful archivist.' },
      // Adversarial case: the canonical source and quote are early, but a later alias may
      // have contaminated the canonical target. Fail closed on the whole entity.
      { source: 'Mara Voss', target: '灰后', aliases: ['Queen Ash'], reviewStatus: 'confirmed', evidence: 'Mara Voss is a careful archivist.' },
      { source: 'Queen Ash', target: '灰后', aliases: [], reviewStatus: 'confirmed', evidence: 'Mara Voss was secretly Queen Ash.' },
    ],
    relationships: [],
    styleGuide: { narrativeVoice: 'Mara Voss is secretly Queen Ash.' },
    chapterSummaries: [{ chapter: 'Chapter 2', summary: 'Mara Voss is secretly Queen Ash.' }],
    recentExamples: [{ source: 'Mara Voss was secretly Queen Ash.', target: '玛拉其实是灰后。' }],
    characterVoices: [
      {
        characterId: 'mara-early', canonicalSourceName: 'Mara Voss', targetName: '玛拉·沃斯',
        aliases: ['Mara'], status: 'confirmed',
        voiceCore: { register: 'measured', syntaxRhythm: ['short declarations'] },
        contrastRules: [],
        evidence: [{
          segmentId: 'early-a', sourceQuote: 'Mara Voss is a careful archivist.',
          observation: 'measured register', dimension: 'register', confidence: 0.9,
        }],
      },
      {
        characterId: 'mara-mixed', canonicalSourceName: 'Mara Voss', targetName: '玛拉·沃斯',
        aliases: ['Mara'], status: 'confirmed',
        voiceCore: { register: 'imperious after her revelation' },
        contrastRules: [],
        evidence: [
          {
            segmentId: 'early-a', sourceQuote: 'Mara Voss is a careful archivist.',
            observation: 'measured register', dimension: 'register', confidence: 0.9,
          },
          {
            segmentId: 'late-a', sourceQuote: 'Mara Voss was secretly Queen Ash.',
            observation: 'imperious register', dimension: 'register', confidence: 0.99,
          },
        ],
      },
      {
        characterId: 'mara-legacy-capped', canonicalSourceName: 'Mara Voss', targetName: '玛拉·沃斯',
        aliases: ['Mara'], status: 'confirmed',
        voiceCore: { register: 'possibly contaminated by omitted later evidence' },
        contrastRules: [],
        // Older memory records capped evidence at eight rows but did not store a completeness marker.
        // Even if all retained quotes are prior-visible, the aggregate VoiceCore cannot be trusted.
        evidence: Array.from({ length: 8 }, () => ({
          segmentId: 'early-a', sourceQuote: 'Mara Voss is a careful archivist.',
          observation: 'measured register', dimension: 'register', confidence: 0.9,
        })),
      },
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  };
  const brief = buildTranslationBrief(context,
    [{ id: 'early-b', text: 'Mara Voss said, Keep the western lamp burning.', contextPath: 'Chapter 1' }],
    [{ id: 'early-a', text: 'Mara Voss is a careful archivist.', contextPath: 'Chapter 1' }]);
  const injected = JSON.stringify({ graph: brief.contextGraph, voice: brief.voiceContext });
  assert.ok(injected.includes('Mara Voss'));
  assert.ok(!injected.includes('Queen Ash'));
  assert.ok(!injected.includes('灰后'));
  assert.ok(!JSON.stringify(brief.voiceContext).includes('Queen Ash'));
  assert.deepEqual(brief.glossary.document_terms.map((term) => term.source), ['Mara Voss']);
  assert.ok(!JSON.stringify(brief.glossary).includes('Queen Ash'));
  assert.ok(!JSON.stringify(brief.glossary).includes('Later identity reveal'));
  assert.deepEqual(brief.voiceContext.chapterSummaries, []);
  assert.deepEqual(brief.voiceContext.recentExamples, []);
  assert.deepEqual(brief.voiceContext.characterVoices.map((profile) => profile.characterId), ['mara-early'],
    'a profile that combines early and future evidence must not be partially filtered and injected');
  assert.ok(brief.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
});

test('both reviewer focuses consume the same bounded TranslationBrief glossary and prior context', async () => {
  const { buildLiteraryReviewPrompt } = await import('../src/literary.ts');
  const translationBrief = {
    policyVersion: 'translation-brief-v2-dynamic-context',
    contextHash: 'brief-hash-123',
    contextChars: 900,
    sourceRevisionId: 'source-revision-1',
    promptRevisionId: 'prompt-revision-1',
    memoryRevisionId: 'memory-revision-1',
    chapterPath: 'Chapter 2',
    glossary: { document_terms: [{ source: 'Mara Voss', target: '玛拉·沃斯' }] },
    precedingSegments: [{ id: 'prior-1', text: 'Mara Voss entered the archive.', contextPath: 'Chapter 1' }],
    contextGraph: {
      policyVersion: 'context-graph-v3-temporal-target-evidence',
      knowledgeBoundaryOrdinal: 12,
      characters: [{ name: 'Mara Voss', voice: ['measured'] }],
      entities: [],
      relationships: [],
      chapterSummaries: [{ chapter: 'Chapter 1', summary: 'Mara entered the archive.' }],
    },
    voiceContext: {
      policyVersion: 'character-voice-v4-dialogue-participants',
      characterVoices: [{ canonicalSourceName: 'Mara Voss', voiceCore: { register: 'measured' } }],
      relationshipVoiceRules: [],
      voiceAnchors: [],
      chapterSummaries: [{ chapter: 'Chapter 1', summary: 'Mara entered the archive.' }],
      entities: [],
      relationships: [],
    },
  };
  const body = {
    target: 'zh',
    chapterTitle: 'Chapter 2',
    glossary: { document_terms: [{ source: 'Queen Ash', target: '灰后' }] },
    translationBrief,
  };
  const segments = [{ id: 'current-1', source: 'Mara Voss opened the ledger.', draft: '玛拉打开了账本。', kind: 'paragraph' }];
  const precedingSegments = translationBrief.precedingSegments;
  const translatorPrompt = buildUserPrompt('', [{
    id: 'current-1', text: 'Mara Voss opened the ledger.', kind: 'paragraph', contextPath: 'Chapter 2',
  }], {
    project: { title: 'Temporal Test', format: 'txt' },
    run: { sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' },
    prompt: { config: { glossary: { document_terms: [{ source: 'Queen Ash', target: '灰后' }] } } },
    memory: {},
  }, [], translationBrief.contextGraph, translationBrief);
  assert.ok(translatorPrompt.includes('玛拉·沃斯'));
  assert.ok(!translatorPrompt.includes('Queen Ash'));
  assert.ok(!translatorPrompt.includes('灰后'));

  for (const reviewFocus of ['accuracy', 'style']) {
    const built = buildLiteraryReviewPrompt({
      body, segments, reviewFocus, translationBrief, precedingSegments,
      voiceContext: translationBrief.voiceContext, contextGraph: translationBrief.contextGraph,
    });
    assert.ok(built.prompt.includes('brief-hash-123'));
    assert.ok(built.prompt.includes('玛拉·沃斯'));
    assert.ok(built.prompt.includes('prior-1'));
    assert.ok(built.prompt.includes('knowledgeBoundaryOrdinal') && built.prompt.includes('12'));
    assert.ok(!built.prompt.includes('Queen Ash'));
    assert.ok(!built.prompt.includes('灰后'));
    assert.equal(built.contextChars > 0, true);
    assert.ok(built.systemPrompt.length > 0);
  }
});


test('TranslationBrief diagnostic summary exposes the count fields expected by the Agent Trajectory UI', () => {
  const summary = summarizeTranslationBrief({
    version: 1,
    policyVersion: 'translation-brief-v2-dynamic-context',
    sourceRevisionId: 'source-r1',
    promptRevisionId: 'prompt-r1',
    memoryRevisionId: null,
    sourceSegmentIds: ['s1'],
    chapterPath: 'Chapter 1',
    glossary: { document_terms: [] },
    precedingSegments: [],
    contextGraph: {
      characters: [{ id: 'c1' }],
      entities: [{ id: 'e1' }, { id: 'e2' }],
      relationships: [{ id: 'r1' }],
      nameMappings: [{ source: 'Grey', target: '格雷' }],
    },
    voiceContext: {
      entities: [],
      relationships: [],
      characterVoices: [{ characterId: 'grey' }],
      relationshipVoiceRules: [],
      voiceAnchors: [],
    },
    contextChars: 100,
    contextHash: 'test-hash',
  });

  assert.equal(summary.entityCount, 3);
  assert.equal(summary.relationshipCount, 1);
  assert.equal(summary.characterVoiceCount, 1);
  assert.equal(summary.nameMappingCount, 1);
  assert.equal(summary.graphEntities, 2);
  assert.equal(summary.graphCharacters, 1);
});


test('dynamic entity evidence is hidden before its cited source segment and visible after it', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Ordinal Evidence Test',
    format: 'txt',
    sourceFileName: 'ordinal-evidence.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-early', text: 'The King watched Max from the doorway.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-evidence', text: 'The King revealed his identity to Max.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'king-later', text: 'The King addressed Max again.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  store.saveLiteraryMemory(project.projectId, {
    version: 2,
    entities: [{
      source: 'The King',
      target: '大王',
      kind: 'character_epithet',
      aliases: ['King'],
      evidence: 'The King revealed his identity to Max.',
      evidenceRefs: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King revealed his identity to Max.',
      }],
      reviewStatus: 'suggested',
    }],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });

  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-early', 'king-later'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const early = { id: 'king-early', text: 'The King watched Max from the doorway.', contextPath: 'Chapter 1' };
  const later = { id: 'king-later', text: 'The King addressed Max again.', contextPath: 'Chapter 2' };
  const earlyBrief = buildTranslationBrief(context, [early], []);
  const laterBrief = buildTranslationBrief(context, [later], []);

  assert.equal(earlyBrief.voiceContext.entities.some((entity) => entity.source === 'The King'), false,
    'a mapping inferred from Chapter 2 must not leak into an earlier Chapter 1 segment');
  assert.equal(laterBrief.voiceContext.entities.some((entity) => entity.source === 'The King' && entity.target === '大王'), true,
    'the same evidence may be used after the cited source segment');
});


test('source-ordered dynamic memory replaces conflicting unconfirmed Context Graph name proposals', async () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Dynamic Memory Beats Graph Candidate',
    format: 'txt',
    sourceFileName: 'dynamic-memory-graph-conflict.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-early', text: 'The King watched Max from the doorway.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-evidence', text: 'The King revealed his identity to Max.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'king-later', text: 'The King addressed Max again.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  const source = store.getSegments(project.projectId, { limit: 10 });
  // Calling the production bundle ensures the graph schema exists before inserting a test candidate.
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-later', text: 'The King addressed Max again.', contextPath: 'Chapter 2' },
  ], [], currentSourceRevisionId, 'zh');
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'graph-king', currentSourceRevisionId, 'character', 'The King', 'the king',
    JSON.stringify({ suggestedTranslation: '大王', aliases: [], targetLang: 'zh' }),
    'candidate', new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) ' +
    'VALUES (?, ?, NULL, ?, ?, ?, ?)'
  ).run(
    currentSourceRevisionId, 'graph-king', 'king-early',
    'The King watched Max from the doorway.', 'name', new Date().toISOString(),
  );
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'The King', target: '国王', kind: 'character_epithet', aliases: ['King'],
      evidence: 'The King revealed his identity to Max.',
      evidenceRefs: [{
        segmentId: 'king-evidence',
        sourceQuote: 'The King revealed his identity to Max.',
      }],
      reviewStatus: 'suggested',
    }],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-later'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const later = source.find((item) => item.id === 'king-later');
  const brief = buildTranslationBrief(context, [later], []);

  const mappings = (brief.contextGraph?.nameMappings || []).filter((mapping) => mapping.source === 'The King');
  assert.equal(mappings.length, 1,
    'there must be only one canonical mapping for the explicitly linked entity');
  assert.equal(mappings[0]?.target, '国王',
    'source-ordered dynamic memory should replace an unconfirmed, conflicting book-wide candidate');
});


test('preflight canonical name mapping protects first and later occurrences without a prior accepted translation', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Run Canonical Fictional Clan',
    format: 'txt',
    sourceFileName: 'run-canonical-minowara.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'minowara-first', text: 'After sixty years the Minowara prevailed over the Takashima.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'minowara-second', text: 'The Minowara Shoguns dominated the realm.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  ensureTestContextGraph(store, project);
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'minowara-first', text: 'After sixty years the Minowara prevailed over the Takashima.', contextPath: 'Chapter 1' },
  ], [], currentSourceRevisionId, 'zh');
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'graph-minowara', currentSourceRevisionId, 'entity', 'Minowara', 'minowara',
    JSON.stringify({ suggestedTranslation: '蓑原', aliases: [], entityKind: 'organization', targetLang: 'zh' }),
    'candidate', new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) ' +
    'VALUES (?, ?, NULL, ?, ?, ?, ?)'
  ).run(
    currentSourceRevisionId, 'graph-minowara', 'minowara-first',
    'the Minowara prevailed over the Takashima', 'name', new Date().toISOString(),
  );

  const firstRun = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['minowara-first'] } });
  const firstContext = store.getRunContext(project.projectId, firstRun.runId);
  const firstSource = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'minowara-first');
  const firstBrief = buildTranslationBrief(firstContext, [firstSource], []);
  const firstMapping = firstBrief.contextGraph?.nameMappings.find((mapping) => mapping.source === 'Minowara');
  assert.equal(firstMapping?.target, '蓑原');
  assert.equal(firstMapping?.sourceStatus, 'run-canonical',
    'whole-book preflight mapping should be usable at the first occurrence without prior translation evidence');
  assert.equal(buildCanonicalTermProtections([firstSource], firstBrief.contextGraph)[0]?.target, '蓑原');
  store.setRunStatus(project.projectId, firstRun.runId, 'cancelled', 'test finished building first TranslationBrief');

  const laterRun = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['minowara-second'] } });
  const laterContext = store.getRunContext(project.projectId, laterRun.runId);
  const laterSource = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'minowara-second');
  const laterBrief = buildTranslationBrief(laterContext, [laterSource], []);
  const laterMapping = laterBrief.contextGraph?.nameMappings.find((mapping) => mapping.source === 'Minowara');
  assert.equal(laterMapping?.target, '蓑原');
  assert.equal(laterMapping?.sourceStatus, 'run-canonical',
    'the same preflight target remains stable in later batches without a human approval step');
  assert.equal(buildCanonicalTermProtections([laterSource], laterBrief.contextGraph)[0]?.target, '蓑原');
});

test('explicit confirmed glossary mappings without AI evidence activate on first visible mention', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Manual Canonical Mapping',
    format: 'txt',
    sourceFileName: 'manual-canonical.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-current', text: 'Timsen noticed King near the door.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-future', text: 'The King spoke again.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-current', text: 'Timsen noticed King near the door.', contextPath: 'Chapter 1' },
  ]);
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'the King', target: '国王', aliases: ['King'], kind: 'person',
      reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
    }],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'king-current');
  const brief = buildTranslationBrief(context, [source], []);
  const mapping = brief.contextGraph?.nameMappings.find((item) => item.source === 'the King');

  assert.equal(mapping?.target, '国王',
    'an explicit mapping should survive first-occurrence filtering: ' + JSON.stringify({
      mode: context.run.translationMode,
      memoryEntities: context.memory.entities,
      graphMappings: brief.contextGraph?.nameMappings,
    }));
  assert.equal(mapping?.sourceStatus, 'confirmed-memory');
  assert.ok(mapping?.aliases.includes('King'),
    'aliases present in the current source batch must remain available for exact name protection');
});

test('confirmed organization name mapping is protected on its first occurrence', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Confirmed Clan Name',
    format: 'txt',
    sourceFileName: 'confirmed-clan-name.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'clan-first', text: 'After sixty years the Minowara prevailed.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  ensureTestContextGraph(store, project);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'clan-first', text: 'After sixty years the Minowara prevailed.', contextPath: 'Chapter 1' },
  ]);
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Minowara', target: '蓑原', kind: 'organization', aliases: [], reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
    }],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['clan-first'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'clan-first');
  const brief = buildTranslationBrief(context, [source], []);
  const mapping = brief.contextGraph?.nameMappings.find((item) => item.source === 'Minowara');

  assert.equal(mapping?.target, '蓑原');
  assert.equal(mapping?.sourceStatus, 'confirmed-memory');
  assert.equal(buildCanonicalTermProtections([source], brief.contextGraph)[0]?.target, '蓑原',
    'confirmed organization/clan mappings must not disappear merely because this is the first source occurrence');
});

test('canonical mappings and relevant context survive a legacy character budget preference', () => {
  const store = getDocumentProjectStore();
  const entities = [];
  const sourceParts = [];
  for (let i = 0; i < 8; i++) {
    const source = 'Character' + String(i).padStart(2, '0') + 'CanonicalName';
    const aliases = Array.from({ length: 2 }, (_, j) =>
      'Alias' + String(i).padStart(2, '0') + 'Variant' + String(j).padStart(2, '0') + 'Name');
    sourceParts.push(source, ...aliases);
    entities.push({
      source,
      target: '规范译名' + String(i).padStart(2, '0') + '固定称呼',
      aliases,
      kind: 'person',
      reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
    });
  }
  const project = store.createProject({
    title: 'Brief Budget Canonical Mapping',
    format: 'txt',
    sourceFileName: 'brief-budget-canonical.txt',
    prompt: {
      translationMode: 'literary', sourceLang: 'en', targetLang: 'zh',
      glossary: { document_terms: [{
        source: 'Character00CanonicalName',
        target: '规范译名00固定称呼',
      }] },
      translationStrategy: { contextBudgetChars: 4000 },
    },
    segments: [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: 'budget-prior-' + i,
        text: ('Previous scene context remains available for resolving references. ').repeat(14),
        kind: 'paragraph',
        contextPath: 'Chapter 1',
      })),
      { id: 'names-heavy', text: sourceParts.join(' and ') + '.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'next', text: 'The scene continued.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  ensureTestContextGraph(store, project);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'names-heavy', text: sourceParts.join(' and ') + '.', contextPath: 'Chapter 1' },
  ]);
  store.saveLiteraryMemory(project.projectId, {
    entities,
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['names-heavy'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const allSegments = store.getSegments(project.projectId, { limit: 20 });
  const source = allSegments.find((item) => item.id === 'names-heavy');
  const preceding = allSegments
    .filter((item) => item.id.startsWith('budget-prior-'))
    .map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath }));
  const brief = buildTranslationBrief(context, [source], preceding);

  assert.ok(brief.contextChars > 4000,
    'legacy contextBudgetChars is not a hard ceiling; relevant context should not be silently removed');
  assert.ok(brief.contextGraph?.nameMappings?.length,
    'all relevant name mappings should remain available without budget fallback: ' + JSON.stringify({
      mode: context.run.translationMode,
      memoryEntityCount: context.memory.entities.length,
      contextChars: brief.contextChars,
      hasGraph: !!brief.contextGraph,
    }));
  assert.ok(brief.contextGraph.nameMappings.some((item) => item.target === '规范译名00固定称呼'));
  assert.ok(brief.glossary.document_terms.some((item) =>
    item.source === 'Character00CanonicalName' && item.target === '规范译名00固定称呼'),
    'an explicit static glossary entry must remain available when the legacy budget is exceeded');
});


test('static glossary applies on its first source occurrence but withholds future-only aliases', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'First-Occurrence Glossary',
    format: 'txt',
    sourceFileName: 'first-occurrence-glossary.txt',
    prompt: {
      translationMode: 'literary',
      sourceLang: 'en',
      targetLang: 'zh',
      glossary: { document_terms: [
        { source: 'Red Cross', target: '红十字会' },
        { source: 'the King', target: '国王', aliases: ['Pirate Queen'] },
        { source: 'Pirate Queen', target: '海盗女王' },
      ] },
    },
    segments: [
      { id: 'first-mention', text: 'Timsen visited the Red Cross storehouse with the King.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'later-reveal', text: 'The King was secretly called the Pirate Queen.', kind: 'paragraph', contextPath: 'Chapter 8' },
    ],
  });
  ensureTestContextGraph(store, project);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'first-mention', text: 'Timsen visited the Red Cross storehouse with the King.', contextPath: 'Chapter 1' },
  ]);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['first-mention'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'first-mention');
  const brief = buildTranslationBrief(context, [source], []);
  const terms = brief.glossary.document_terms;

  assert.ok(terms.some((term) => term.source === 'Red Cross' && term.target === '红十字会'),
    'the explicit glossary term must reach the first batch where it appears');
  assert.ok(!terms.some((term) => term.source === 'Pirate Queen'),
    'a glossary term first revealed in a later chapter must not leak into an earlier batch');
  assert.ok(!terms.some((term) => term.source === 'the King'),
    'a canonical target whose alias is only revealed later remains withheld as a whole');
});


test('a cancelled Run cannot persist a late TranslationBrief snapshot', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Cancelled Brief Snapshot',
    format: 'txt',
    sourceFileName: 'cancelled-brief.txt',
    prompt: { translationMode: 'technical', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'brief-current', text: 'The King entered the room.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['brief-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'brief-current');
  const brief = buildTranslationBrief(context, [source], []);
  store.setRunStatus(project.projectId, run.runId, 'cancelled', '用户请求停止');

  assert.equal(store.saveTranslationBriefSnapshot(
    project.projectId, run.runId, 1, brief,
  ), false);
  assert.deepEqual(store.listTranslationBriefSnapshots(project.projectId, run.runId), [],
    'the audit log must not claim that a brief was committed after the Run was cancelled');
});


test('an unconfirmed whole-book target is not injected just because the canonical name appeared earlier', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Do not leak graph target',
    format: 'txt',
    sourceFileName: 'graph-target-boundary.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-prior', text: 'The King watched Max from the doorway.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-reveal', text: 'The King was secretly the Pirate Queen.', kind: 'paragraph', contextPath: 'Chapter 8' },
      { id: 'king-current', text: 'The King entered the room again.', kind: 'paragraph', contextPath: 'Chapter 9' },
    ],
  });
  // A previous accepted draft used the spoiler target, but a later accepted correction replaced it.
  store.saveManualEdit(project.projectId, 'king-prior', '海盗女王从门口注视着麦克斯。');
  store.saveManualEdit(project.projectId, 'king-prior', '国王从门口注视着麦克斯。');
  ensureTestContextGraph(store, project);
  const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
  buildProjectContextGraphBundle(project.projectId, [
    { id: 'king-current', text: 'The King entered the room again.', contextPath: 'Chapter 9' },
  ], [], currentSourceRevisionId, 'zh');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO context_graph_nodes(node_id, source_revision_id, kind, name, normalized_name, attributes_json, status, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'graph-king-spoiler', currentSourceRevisionId, 'character', 'The King', 'the king',
    JSON.stringify({ suggestedTranslation: '海盗女王', aliases: [], targetLang: 'zh' }),
    'candidate', now, now,
  );
  db.prepare(
    'INSERT INTO context_graph_evidence(source_revision_id, node_id, edge_id, segment_id, quote, role, created_at) ' +
    'VALUES (?, ?, NULL, ?, ?, ?, ?)'
  ).run(
    currentSourceRevisionId, 'graph-king-spoiler', 'king-prior',
    'The King watched Max from the doorway.', 'name', now,
  );
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['king-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 20 }).find((item) => item.id === 'king-current');
  const brief = buildTranslationBrief(context, [source], []);

  assert.equal(brief.contextGraph.nameMappings.some((item) =>
    item.source === 'The King' && item.target === '海盗女王'), false,
  'source-name evidence cannot validate a target inferred from a future identity reveal');
  assert.ok(brief.contextDiagnostics.graphNameMappingExcludedTargetNotPreviouslyAccepted >= 1,
    'trajectory diagnostics should explain that the candidate target lacked earlier accepted translation evidence');
});

test('accepted examples are retrieved by relevance only from the same source revision before the batch', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Accepted example retrieval',
    format: 'txt',
    sourceFileName: 'accepted-example-retrieval.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'example-prior', text: 'Mara Voss watched the western lamp burning beside the silver door.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'example-current', text: 'Mara Voss noticed the western lamp burning beside the silver door again.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'example-future', text: 'Mara Voss was secretly the Queen of Ash.', kind: 'paragraph', contextPath: 'Chapter 8' },
    ],
  });
  store.saveManualEdit(project.projectId, 'example-prior', '玛拉·沃斯在银门上看到了西灯。');
  store.saveManualEdit(project.projectId, 'example-prior', '玛拉·沃斯看着银门旁的西侧灯火燃烧。');
  store.saveManualEdit(project.projectId, 'example-future', '玛拉·沃斯其实是灰烬女王。');
  store.saveLiteraryMemory(project.projectId, {
    entities: [], relationships: [], styleGuide: {}, chapterSummaries: [],
    recentExamples: [{
      source: 'Mara Voss was secretly the Queen of Ash.',
      target: '玛拉·沃斯其实是灰烬女王。',
      chapter: 'Chapter 8',
    }],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['example-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 20 }).find((item) => item.id === 'example-current');
  const brief = buildTranslationBrief(context, [source], []);

  assert.ok(brief.voiceContext.recentExamples.some((item) =>
    item.segmentId === 'example-prior' && item.origin === 'manual' &&
    item.source.includes('western lamp') && item.target.includes('西侧灯火')),
  'a prior accepted human translation with strong lexical overlap should be injected');
  assert.equal(brief.voiceContext.recentExamples.some((item) =>
    item.segmentId === 'example-prior' && item.target === '玛拉·沃斯在银门上看到了西灯。'), false,
  'a superseded accepted draft from the same source segment must not be retrieved as an example');
  assert.equal(brief.voiceContext.recentExamples.some((item) =>
    item.segmentId === 'example-future' || item.source.includes('Queen of Ash') || item.target.includes('灰烬女王')), false,
  'later accepted translations and unscoped book-level examples must not enter an earlier brief');
  assert.equal(brief.contextDiagnostics.selectedAcceptedExamples, brief.voiceContext.recentExamples.length);
});

test('voice retrieval can select an evidence-backed dialogue participant when current lines use only pronouns', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Dialogue participant retrieval',
    format: 'txt',
    sourceFileName: 'dialogue-participant.txt',
    prompt: {
      translationMode: 'literary',
      sourceLang: 'en',
      targetLang: 'zh',
      translationStrategy: { precedingContextSegments: 1 },
    },
    segments: [
      { id: 'dialogue-name', text: 'Iven was waiting at the platform.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'dialogue-anchor', text: 'The train is already gone, she said.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'dialogue-current', text: 'Then what do we do?', kind: 'dialogue', contextPath: 'Chapter 1' },
    ],
  });
  // The project store approves a voice anchor only when its source/attribution evidence and
  // accepted translated surface can all be verified against the current source revision.
  store.saveManualEdit(project.projectId, 'dialogue-anchor', '火车已经开走了。');
  store.saveLiteraryMemory(project.projectId, {
    entities: [], relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [{
      characterId: 'iven',
      canonicalSourceName: 'Iven',
      targetName: '伊文',
      aliases: [],
      status: 'confirmed',
      voiceCore: { register: 'Measured and restrained' },
      evidence: [{
        segmentId: 'dialogue-name',
        sourceQuote: 'Iven was waiting at the platform.',
        observation: 'Uses restrained, measured phrasing',
        dimension: 'register',
      }],
      contrastRules: [],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [{
      anchorId: 'approved-iven-anchor',
      speakerId: 'iven',
      source: 'The train is already gone',
      target: '火车已经开走了',
      chapter: 'Chapter 1',
      segmentId: 'dialogue-anchor',
      attributionEvidence: 'The train is already gone',
      attributionConfidence: 0.95,
      status: 'approved',
    }],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['dialogue-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 20 }).find((item) => item.id === 'dialogue-current');
  const preceding = store.getPrecedingSegments(project.projectId, run.runId, 'dialogue-current', 1);
  const brief = buildTranslationBrief(context, [source], preceding);

  assert.equal(brief.precedingSegments.length, 1);
  assert.equal(brief.precedingSegments[0].id, 'dialogue-anchor');
  assert.equal(brief.voiceContext.characterVoices.some((profile) => profile.characterId === 'iven'), true,
    'the profile can be retrieved through a source-linked approved speaker anchor despite no name in the current dialogue');
  assert.equal(brief.voiceContext.dialogueParticipants.some((participant) =>
    participant.characterId === 'iven' && participant.role === 'speaker' &&
    participant.evidenceSegmentId === 'dialogue-anchor'), true,
    JSON.stringify({
      profiles: brief.voiceContext.characterVoices.map((profile) => profile.characterId),
      anchors: brief.voiceContext.voiceAnchors,
      participants: brief.voiceContext.dialogueParticipants,
      diagnostics: brief.contextDiagnostics,
    }));
});

test('source occurrence lookup normalizes apostrophes and dash variants before temporal filtering', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Normalized source evidence',
    format: 'txt',
    sourceFileName: 'normalized-source-evidence.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'normalized-prior', text: 'O’Connor carried the blue–green box across the street.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'normalized-current', text: "He followed O'Connor with the blue-green box.", kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  ensureTestContextGraph(store, project);
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: "O'Connor",
      target: '奥康纳',
      aliases: [],
      kind: 'person',
      reviewStatus: 'suggested',
      evidence: 'O’Connor carried the blue–green box across the street.',
      evidenceRefs: [{
        segmentId: 'normalized-prior',
        sourceQuote: 'O’Connor carried the blue–green box across the street.',
      }],
    }],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['normalized-current'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 20 }).find((item) => item.id === 'normalized-current');
  const brief = buildTranslationBrief(context, [source], []);

  assert.equal(brief.contextGraph.nameMappings.some((mapping) =>
    mapping.source === "O'Connor" && mapping.target === '奥康纳'), true,
  'normalized source lookup should validate prior evidence despite punctuation variants');
  assert.equal(brief.contextDiagnostics.memoryEntityExcludedByBoundary, 0);
});


test('confirmed character-profile names enter the translation mapping while unsafe and future-only aliases are excluded', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Character Profile Canonical Mapping Test',
    format: 'txt',
    sourceFileName: 'character-profile-mapping.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'profile-early', text: 'Yabu-san met Omi near the gate.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'profile-late', text: 'Yabu II was revealed in a later chapter.', kind: 'paragraph', contextPath: 'Chapter 8' },
    ],
  });
  store.saveLiteraryMemory(project.projectId, {
    entities: [],
    relationships: [],
    styleGuide: {},
    styleGuideStatus: 'candidate',
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [
      {
        characterId: 'char-yabu',
        canonicalSourceName: 'Yabu',
        targetName: '薮',
        aliases: ['Yabu-san', 'Lord', "Lord Toranaga's", 'General', 'Yabu II'],
        status: 'confirmed',
        useForTranslation: true,
        voiceCore: { register: 'measured', syntaxRhythm: [], lexicalPreferences: [], discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [] },
        evidence: [{
          segmentId: 'profile-early',
          sourceQuote: 'Yabu-san met Omi near the gate.',
          dimension: 'register',
          observation: '本段以人物称呼开头。',
        }],
        contrastRules: [],
        openQuestions: [],
      },
      {
        characterId: 'char-omi',
        canonicalSourceName: 'Omi',
        targetName: '近江',
        aliases: [],
        status: 'candidate',
        useForTranslation: true,
        voiceCore: { register: '', syntaxRhythm: [], lexicalPreferences: [], discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [] },
        evidence: [{
          segmentId: 'profile-early',
          sourceQuote: 'Omi near the gate.',
          dimension: 'register',
          observation: '本段出现人物姓名。',
        }],
        contrastRules: [],
        openQuestions: [],
      },
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  ensureTestContextGraph(store, project);

  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['profile-early'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 })
    .find((item) => item.id === 'profile-early');
  const brief = buildTranslationBrief(context, [source], []);
  const mappings = brief.contextGraph.nameMappings;
  const yabu = mappings.find((item) => item.source === 'Yabu');
  assert.ok(yabu, 'a confirmed Character/Voice profile must provide a canonical target even without a memory entity');
  assert.equal(yabu.target, '薮');
  assert.deepEqual(yabu.aliases, ['Yabu-san'],
    'generic titles, aliases referring to another person, and later-only aliases must not be injected');
  const omi = mappings.find((item) => item.source === 'Omi');
  assert.equal(omi?.target, '近江');
  assert.equal(omi?.sourceStatus, 'confirmed-memory',
    'model-default character mappings are adopted immediately; provenance remains distinct from user confirmation');
  const visibleYabuProfile = brief.voiceContext.characterVoices.find((item) => item.canonicalSourceName === 'Yabu');
  if (visibleYabuProfile) {
    assert.deepEqual(visibleYabuProfile.aliases, ['Yabu-san'],
      'when the profile is eligible for voice context, unsafe/future aliases must also be removed');
  }
  assert.equal(brief.contextDiagnostics.characterProfileMappingConflictCount, 0);
});

test('conflicting confirmed character profile and entity targets are not arbitrarily forced into TranslationBrief', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Character Profile Mapping Conflict Test',
    format: 'txt',
    sourceFileName: 'character-profile-conflict.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'conflict-early', text: 'Yabu returned to the camp.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Yabu',
      target: '矢部',
      aliases: [],
      kind: 'person',
      reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
      evidence: 'Yabu returned to the camp.',
    }],
    relationships: [],
    styleGuide: {},
    styleGuideStatus: 'candidate',
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char-yabu-conflict',
      canonicalSourceName: 'Yabu',
      targetName: '薮',
      aliases: [],
      status: 'confirmed', confirmationSource: 'user-confirmed',
      useForTranslation: true,
      voiceCore: { register: '', syntaxRhythm: [], lexicalPreferences: [], discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [] },
      evidence: [{
        segmentId: 'conflict-early',
        sourceQuote: 'Yabu returned to the camp.',
        dimension: 'register',
        observation: '原文以姓名指代人物。',
      }],
      contrastRules: [],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  ensureTestContextGraph(store, project);

  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['conflict-early'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const source = store.getSegments(project.projectId, { limit: 10 })
    .find((item) => item.id === 'conflict-early');
  const brief = buildTranslationBrief(context, [source], []);
  assert.equal(brief.contextGraph.nameMappings.some((item) => item.source === 'Yabu'), false,
    'when two confirmed canonical targets disagree, do not force either translation');
  assert.equal(brief.contextDiagnostics.characterProfileMappingConflictCount, 1);
  assert.ok(brief.contextGraph.constraints.some((item) => String(item).includes('canonicalNameMappingConflicts')));
  assert.deepEqual(brief.contextGraph.canonicalNameMappingConflicts.map((item) =>
    new Set([item.existingTarget, item.profileTarget])), [new Set(['矢部', '薮'])]);
});

test('voice retrieval keeps relevant profiles beyond the former first-80 persistence cap', () => {
  const profiles = Array.from({ length: 100 }, (_, index) => ({
    characterId: `character-${index}`,
    canonicalSourceName: `Character ${index}`,
    targetName: `人物${index}`,
    aliases: [],
    status: 'confirmed',
    confidence: 0.9,
    voiceCore: {
      register: 'measured', syntaxRhythm: [], lexicalPreferences: [],
      discourseHabits: [], stanceModality: [], humorIrony: '', disfluency: '', avoid: [],
    },
    evidence: [{
      segmentId: 'current',
      sourceQuote: 'Character 99 spoke quietly.',
      observation: 'Uses a restrained declarative sentence.',
      dimension: 'register',
    }],
    contrastRules: [],
    openQuestions: [],
  }));
  const context = buildProjectVoiceContext(
    { version: 2, characterVoices: profiles, entities: [], relationships: [], relationshipVoiceRules: [], voiceAnchors: [], chapterSummaries: [], recentExamples: [] },
    [{ id: 'current', text: 'Character 99 spoke quietly.', contextPath: 'Chapter 1', kind: 'dialogue' }],
    'Chapter 1',
  );

  assert.deepEqual(
    context.characterVoices.map((profile) => profile.characterId),
    ['character-99'],
    'relevant later profiles must remain eligible for retrieval instead of being discarded by input order',
  );
});

test('historical example retrieval keeps distant relevant examples and bounds redundant context', () => {
  const store = getDocumentProjectStore();
  const segments = [];
  for (let index = 0; index < 280; index++) {
    segments.push({
      id: 'example-' + index,
      text: index === 0
        ? 'Rhododendron concealed the silver vault beneath the mountain.'
        : 'Rhododendron grows among warm garden stones number ' + index + '.',
      kind: 'paragraph',
      contextPath: 'Chapter ' + (Math.floor(index / 10) + 1),
    });
  }
  segments.push({
    id: 'current-example',
    text: 'The rhododendron opened the silver vault beside the river.',
    kind: 'paragraph',
    contextPath: 'Chapter 29',
  });
  const project = store.createProject({
    title: 'Bounded Historical Example Retrieval',
    format: 'txt',
    sourceFileName: 'historical-examples.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments,
  });
  ensureTestContextGraph(store, project);
  store.importAcceptedTranslations(project.projectId, segments.slice(0, -1).map((segment, index) => ({
    id: segment.id,
    text: index === 0 ? '杜鹃花藏起了银色地窖。' : '杜鹃花在温暖的花园石块间生长。',
  })));
  const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['current-example'] } });
  const context = store.getRunContext(project.projectId, run.runId);
  const current = store.getSegments(project.projectId, { limit: 500 }).find((item) => item.id === 'current-example');
  const brief = buildTranslationBrief(context, [current], []);

  assert.ok(
    brief.voiceContext.recentExamples.some((example) => example.source.includes('silver vault')),
    'distinctive source terms must retrieve a relevant accepted example older than the recent-window boundary',
  );
  assert.equal(brief.voiceContext.recentExamples.length, 1, 'single-token overlaps in unrelated history are excluded by relevance filtering');
  assert.ok(brief.contextChars <= MAX_TRANSLATION_BRIEF_CHARS);
});

test('chapter summary retrieval includes only the two immediately preceding chapters', () => {
  const chapters = Array.from({ length: 6 }, (_, index) => ({
    chapter_title: 'Chapter ' + (index + 1),
    summary: 'Summary ' + (index + 1),
    summary_kind: 'model',
  }));

  assert.deepEqual(selectRecentPriorChapterSummaries(chapters, 5), [
    { chapter: 'Chapter 4', summary: 'Summary 4', summaryKind: 'model' },
    { chapter: 'Chapter 5', summary: 'Summary 5', summaryKind: 'model' },
  ]);
  assert.deepEqual(selectRecentPriorChapterSummaries(chapters, 1), [
    { chapter: 'Chapter 1', summary: 'Summary 1', summaryKind: 'model' },
  ]);
  assert.deepEqual(selectRecentPriorChapterSummaries(chapters, -1), []);
});

test('invalid leading candidates do not consume the evidence-backed persistence quota', () => {
  const candidates = Array.from({ length: 41 }, (_, index) => ({
    name: 'Candidate ' + index,
    evidenceCount: index === 40 ? 1 : 0,
  }));
  const persisted = [];
  for (const candidate of candidates) {
    const disposition = contextGraphCandidateDisposition(candidate.evidenceCount, persisted.length, 40);
    if (disposition === 'persist') persisted.push(candidate.name);
  }

  assert.deepEqual(persisted, ['Candidate 40']);
  assert.equal(contextGraphCandidateDisposition(0, 39, 40), 'no-evidence');
  assert.equal(contextGraphCandidateDisposition(1, 40, 40), 'valid-limit');
});

