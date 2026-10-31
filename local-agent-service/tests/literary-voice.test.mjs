import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeVoiceAnalysis } from '../src/literary.ts';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';

const sourceSegments = [
  { id: 'ch1-a1', text: 'Alice asked Bob, “You really think so?”' },
  { id: 'ch1-b1', text: 'The evidence is clear.' },
];

test('voice analysis assigns stable character IDs and rejects unsupported evidence', () => {
  const priorMemory = {
    version: 2,
    entities: [],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char_existing_alice',
      canonicalSourceName: 'Alice',
      status: 'confirmed',
      confidence: 0.9,
      aliases: ['Miss Alice'],
      voiceCore: { syntaxRhythm: ['短反问'] },
      contrastRules: [],
      evidence: [{
        segmentId: 'ch1-a1',
        sourceQuote: 'You really think so?',
        dimension: 'syntax_rhythm',
        observation: '以短反问回应质疑',
        confidence: 0.9,
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  };
  const parsed = {
    characterVoices: [
      {
        characterId: 'random-model-id-17',
        canonicalSourceName: 'Alice',
        aliases: ['Alice'],
        status: 'confirmed',
        confidence: 0.95,
        voiceCore: { syntaxRhythm: ['每句都添加感叹号'] },
        evidence: [{
          segmentId: 'ch1-a1',
          sourceQuote: 'You really think so?',
          dimension: 'syntax_rhythm',
          observation: '先用短反问表达怀疑',
          confidence: 0.9,
        }],
      },
      {
        characterId: 'random-model-id-bob',
        canonicalSourceName: 'Bob',
        status: 'confirmed',
        confidence: 0.75,
        voiceCore: { register: '先给结论再补充理由' },
        evidence: [{
          segmentId: 'ch1-b1',
          sourceQuote: 'The evidence is clear.',
          dimension: 'register',
          observation: '完整陈述结论',
          confidence: 0.75,
        }],
      },
      {
        characterId: 'unreliable-id',
        canonicalSourceName: 'Unknown',
        status: 'confirmed',
        confidence: 0.99,
        voiceCore: { register: '高贵、优雅' },
        evidence: [{
          segmentId: 'ch1-a1',
          sourceQuote: 'This quote is not in the source.',
          dimension: 'register',
          observation: '模型声称但没有对应原文',
          confidence: 0.99,
        }],
      },
    ],
    relationshipVoiceRules: [{
      speakerId: 'random-model-id-17',
      addresseeId: 'random-model-id-bob',
      status: 'confirmed',
      baselineRegister: '直接但不亲昵',
      addressTerms: ['Bob'],
      evidenceSegmentIds: ['ch1-a1', 'missing-segment'],
    }],
    voiceAnchors: [
      {
        anchorId: 'random-anchor',
        speakerId: 'random-model-id-17',
        source: 'You really think so?',
        target: '你真这么认为？',
        segmentId: 'ch1-a1',
        status: 'approved',
        approvedBy: 'user',
        attributionEvidence: 'Alice asked Bob',
        attributionConfidence: 0.95,
        tags: ['question'],
      },
      {
        anchorId: 'invalid-anchor',
        speakerId: 'random-model-id-17',
        source: 'Not actually in source',
        target: '并非原文',
        segmentId: 'ch1-a1',
        status: 'approved',
        approvedBy: 'user',
        tags: [],
      },
    ],
    openQuestions: [],
  };

  const normalized = stabilizeVoiceAnalysis(priorMemory, parsed, sourceSegments);
  const alice = normalized.characterVoices.find((profile) => profile.canonicalSourceName === 'Alice');
  assert.equal(alice.characterId, 'char_existing_alice', 'an existing character id is stable across chapters');
  assert.equal(alice.status, 'confirmed', 'new analysis cannot silently demote a confirmed profile');
  assert.equal(alice.voiceCore.syntaxRhythm[0], '短反问', 'new chapters cannot silently overwrite a confirmed voice core');
  assert.ok(normalized.openQuestions.some((question) => question.includes('Alice') && question.includes('差异')));
  assert.ok(alice.openQuestions.some((question) => question.includes('差异')), 'the conflict must be visible on the character profile');
  assert.equal(normalized.characterVoices.some((profile) => profile.canonicalSourceName === 'Unknown'), false);

  const bob = normalized.characterVoices.find((profile) => profile.canonicalSourceName === 'Bob');
  assert.ok(bob.characterId.startsWith('char_'));
  const repeat = stabilizeVoiceAnalysis(priorMemory, parsed, sourceSegments);
  assert.equal(repeat.characterVoices.find((profile) => profile.canonicalSourceName === 'Bob').characterId, bob.characterId);

  assert.deepEqual(normalized.relationshipVoiceRules[0].evidenceSegmentIds, ['ch1-a1']);
  assert.equal(normalized.relationshipVoiceRules[0].speakerId, 'char_existing_alice');
  assert.equal(normalized.relationshipVoiceRules[0].addresseeId, bob.characterId);
  assert.equal(normalized.voiceAnchors.length, 1);
  assert.equal(normalized.voiceAnchors[0].status, 'candidate', 'analysis can never approve a voice anchor');
  assert.equal(normalized.voiceAnchors[0].approvedBy, 'reviewer');
});

test('preceding context can select a speaker and retrieve approved anchors from another chapter', () => {
  const memory = sanitizeProjectLiteraryMemory({
    entities: [
      { source: 'Alice', target: '艾丽丝', kind: 'person', aliases: [], reviewStatus: 'confirmed' },
      { source: 'Bob', target: '鲍勃', kind: 'person', aliases: [], reviewStatus: 'confirmed' },
    ],
    relationships: [],
    styleGuide: { narrativeVoice: '克制' },
    chapterSummaries: [], recentExamples: [],
    characterVoices: [
      {
        characterId: 'char-alice', canonicalSourceName: 'Alice', aliases: [], status: 'confirmed',
        voiceCore: { syntaxRhythm: ['短反问'] }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-a1', sourceQuote: 'Alice said', dimension: 'discourse', observation: '有明确说话标记', confidence: 0.95 }],
      },
      {
        characterId: 'char-bob', canonicalSourceName: 'Bob', aliases: [], status: 'confirmed',
        voiceCore: { register: '简短回应' }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-b1', sourceQuote: 'Bob answered', dimension: 'register', observation: '简短回答', confidence: 0.8 }],
      },
    ],
    relationshipVoiceRules: [{
      speakerId: 'char-alice', addresseeId: 'char-bob', status: 'confirmed',
      baselineRegister: '直接但克制', addressTerms: ['Bob'], evidenceSegmentIds: ['ch1-a1'],
    }],
    voiceAnchors: [{
      anchorId: 'alice-cross-chapter', speakerId: 'char-alice', addresseeId: 'char-bob',
      source: 'You never listen to me.', target: '你从来不听我说话。',
      chapter: 'Chapter 1', segmentId: 'ch1-a1', status: 'approved', approvedBy: 'user',
      attributionEvidence: 'Alice said', attributionConfidence: 0.95, tags: ['reproach'],
    }],
  });
  const context = buildProjectVoiceContext(
    memory,
    [{ id: 'ch4-p10', text: 'He looked away.', contextPath: 'Chapter 4' }],
    'Chapter 4',
    [{ id: 'ch4-p9', text: 'Alice said, “You always do this, Bob.”', contextPath: 'Chapter 4' }],
  );
  assert.deepEqual(context.characterVoices.map((profile) => profile.characterId), ['char-alice', 'char-bob']);
  assert.deepEqual(context.voiceAnchors.map((anchor) => anchor.anchorId), ['alice-cross-chapter']);
  assert.deepEqual(context.scene.segmentIds, ['ch4-p10']);
});

test('explicit entity aliases retain a single canonical translation in local-agent memory', () => {
  const memory = sanitizeProjectLiteraryMemory({
    entities: [
      { source: 'Kiri', target: '吉莉', kind: 'person', aliases: ['Kiri'], reviewStatus: 'confirmed' },
      // Old memory may already have a competing full-name row with no known alias.
      { source: 'Kiritsubo', target: '吉罗', kind: 'person', aliases: [], reviewStatus: 'suggested' },
      // A newer analysis can bridge the two rows by supplying the alias.
      { source: 'Kiritsubo', target: '吉罗', kind: 'person', aliases: ['Kiri'], reviewStatus: 'suggested' },
    ],
    relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
  });
  assert.equal(memory.entities.length, 1);
  assert.equal(memory.entities[0].source, 'Kiri');
  assert.equal(memory.entities[0].target, '吉莉');
  assert.ok(memory.entities[0].aliases.includes('Kiritsubo'));

  const context = buildProjectVoiceContext(
    memory,
    [{ id: 'kiri-1', text: 'Kiritsubo-san asked where Kiri was.' }],
    'Chapter 1',
  );
  assert.equal(context.entities.length, 1);
  assert.equal(context.entities[0].target, '吉莉');
});

test('project voice context includes default-adopted profiles and anchors', () => {
  const memory = sanitizeProjectLiteraryMemory({
    version: 2,
    entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', aliases: [], reviewStatus: 'confirmed' }],
    relationships: [],
    styleGuide: { narrativeVoice: '克制的第三人称' },
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [
      {
        characterId: 'char-alice', canonicalSourceName: 'Alice', aliases: [], status: 'confirmed', confidence: 0.9,
        voiceCore: { syntaxRhythm: ['使用简短反问'] }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-a1', sourceQuote: 'You really think so?', dimension: 'discourse', observation: '简短反问', confidence: 0.9 }],
      },
      {
        characterId: 'char-candidate', canonicalSourceName: 'Unknown', aliases: [], status: 'candidate', confidence: 0.4,
        voiceCore: { register: '猜测性的语域' }, contrastRules: [],
        evidence: [{ segmentId: 'ch1-b1', sourceQuote: 'The evidence is clear.', dimension: 'register', observation: '候选声音', confidence: 0.4 }],
      },
    ],
    relationshipVoiceRules: [],
    voiceAnchors: [
      { anchorId: 'approved', speakerId: 'char-alice', source: 'You really think so?', target: '你真这么认为？', segmentId: 'ch1-a1', status: 'approved', approvedBy: 'user', attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: [] },
      { anchorId: 'candidate', speakerId: 'char-alice', source: 'The evidence is clear.', target: '证据很清楚。', segmentId: 'ch1-b1', status: 'candidate', approvedBy: 'reviewer', tags: [] },
    ],
  });
  const context = buildProjectVoiceContext(memory, [{
    id: 'ch1-a1',
    text: 'Alice looked at Bob. “You really think so?”',
    contextPath: 'Chapter 1',
  }], 'Chapter 1');
  const roundTrip = JSON.parse(JSON.stringify(context));
  assert.equal(roundTrip.scene.chapterTitle, 'Chapter 1');
  assert.deepEqual(roundTrip.scene.segmentIds, ['ch1-a1']);
  assert.equal(roundTrip.characterVoices.length, 1);
  assert.equal(roundTrip.characterVoices[0].characterId, 'char-alice');
  assert.deepEqual(roundTrip.voiceAnchors.map((anchor) => anchor.anchorId), ['approved', 'candidate']);
  assert.ok(JSON.stringify(roundTrip).length < 9000);
  assert.match(roundTrip.constraints.join(' '), /不确定说话人/);
});


test('default-adopted Chinese editorial profiles are projected into voice context', () => {
  const memory = sanitizeProjectLiteraryMemory({
    version: 2,
    chineseEditorialProfile: {
      version: 1,
      status: 'confirmed',
      confirmationSource: 'user-confirmed',
      sourceRevisionId: 'revision-1',
      analysisVersion: 'chinese-editorial-profile-v1',
      sampleFingerprint: 'fingerprint',
      sampleCount: 12,
      chapterCount: 3,
      profile: {
        narrativeVoice: '叙述克制，不主动解释人物心理。',
        register: '现代书面语。',
        rhythm: '保留长句与有意停顿。',
        dialogue: '对白避免统一成同一种口吻。',
        diction: '优先自然、准确的常用词。',
        rules: ['不机械拆分长句。'],
        avoid: ['不主动增加心理解释。'],
      },
      evidenceRefs: [{
        segmentId: 'ch1-a1',
        targetExcerpt: '我仍记得那一天',
        observation: '第一人称回忆语气克制。',
        aspect: 'narrativeVoice',
      }, {
        segmentId: 'ch1-b1',
        targetExcerpt: '证据已经很清楚',
        observation: '叙述语域偏现代书面语。',
        aspect: 'register',
      }, {
        segmentId: 'ch1-c1',
        targetExcerpt: '他没有再说什么',
        observation: '叙述不额外解释人物心理。',
        aspect: 'diction',
      }],
    },
  });
  const projected = buildProjectVoiceContext(memory, sourceSegments);
  assert.match(JSON.stringify(projected.chineseEditorialProfile), /叙述克制/);

  const candidate = sanitizeProjectLiteraryMemory({
    chineseEditorialProfile: {
      version: 1,
      status: 'candidate',
      sourceRevisionId: 'revision-1',
      profile: { narrativeVoice: '候选风格，不应注入。' },
      evidenceRefs: [],
    },
  });
  const candidateProjection = buildProjectVoiceContext(candidate, sourceSegments);
  assert.match(JSON.stringify(candidateProjection.chineseEditorialProfile), /候选风格/);
});


test('new Chinese editorial profile versions are automatically adopted', () => {
  const memory = sanitizeProjectLiteraryMemory({
    entities: [], relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
    characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
    chineseEditorialProfile: {
      version: 1,
      profileVersion: 2,
      status: 'confirmed',
      confirmationSource: 'user-confirmed',
      sourceRevisionId: 'revision-1',
      sampleFingerprint: 'base-fingerprint',
      profile: {
        narrativeVoice: '克制、疏离，不主动解释人物心理。',
        register: '现代书面语，避免过度口语化。',
        rhythm: '保留原文长句和有意重复。',
        dialogue: '对白简洁，不替人物补充情绪。',
        diction: '准确、节制。',
        rules: ['不擅自拆分有节奏作用的长句。'],
        avoid: ['避免无依据增加形容词。'],
      },
      evidenceRefs: [
        { segmentId: 'p1', targetExcerpt: '克制的叙述', observation: '叙述保持距离', aspect: 'narrativeVoice' },
        { segmentId: 'p2', targetExcerpt: '没有回答', observation: '对白简洁', aspect: 'dialogue' },
        { segmentId: 'p3', targetExcerpt: '仍然重复', observation: '保留重复节奏', aspect: 'rhythm' },
      ],
      pendingUpdate: {
        version: 1,
        status: 'candidate',
        sourceRevisionId: 'revision-1',
        analysisVersion: 'chinese-editorial-profile-v1',
        sampleFingerprint: 'new-fingerprint',
        basedOnFingerprint: 'base-fingerprint',
        sampleCount: 18,
        chapterCount: 4,
        generatedAt: '2026-10-31T00:00:00.000Z',
        profile: {
          narrativeVoice: '更新后的叙述声音。',
          register: '更新后的语域。',
          rhythm: '更新后的节奏。',
          dialogue: '更新后的对白。',
          diction: '更新后的措辞。',
          rules: ['新增规则。'],
          avoid: [],
        },
        evidenceRefs: [
          { segmentId: 'p4', targetExcerpt: '仍旧沉默', observation: '新的叙述证据', aspect: 'narrativeVoice' },
          { segmentId: 'p5', targetExcerpt: '慢慢地说', observation: '新的对白证据', aspect: 'dialogue' },
          { segmentId: 'p6', targetExcerpt: '没有改变', observation: '新的节奏证据', aspect: 'rhythm' },
        ],
      },
    },
  });

  assert.equal(memory.chineseEditorialProfile.profileVersion, 3);
  assert.equal(memory.chineseEditorialProfile.sampleFingerprint, 'new-fingerprint');
  assert.equal(memory.chineseEditorialProfile.pendingUpdate, undefined);
  const context = buildProjectVoiceContext(
    memory,
    [{ id: 'p7', text: 'He remained silent.', contextPath: 'Chapter 5' }],
    'Chapter 5',
    [],
  );
  assert.equal(context.chineseEditorialProfile.narrativeVoice, '更新后的叙述声音。');
});
