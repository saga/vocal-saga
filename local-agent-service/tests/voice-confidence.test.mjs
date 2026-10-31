import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectVoiceContext, sanitizeProjectLiteraryMemory } from '../src/documents/voiceContext.ts';
import { stabilizeVoiceAnalysis } from '../src/literary.ts';

test('legacy Context Graph 0.55 is sanitized as unassessed, not as a model score', () => {
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices: [{
      characterId: 'context-graph-cg-legacy',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      confidence: 0.55,
      voiceCore: { register: 'candidate observation' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
        confidence: 0.55,
      }],
    }],
  });

  assert.equal(memory.characterVoices[0].confidence, null);
  assert.equal(memory.characterVoices[0].confidenceSource, undefined);
  assert.equal(memory.characterVoices[0].evidence[0].confidence, null);
  assert.equal(memory.characterVoices[0].evidence[0].confidenceSource, undefined);
});

test('only provenance-tagged model scores survive sanitization; explicit null is not coerced to zero', () => {
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices: [
      {
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        confidence: 0.82,
        confidenceSource: 'model_self_report',
        voiceCore: { register: 'measured' },
        evidence: [{
          segmentId: 's1',
          sourceQuote: 'Alice spoke softly.',
          dimension: 'register',
          observation: 'quiet register',
          confidence: 0.76,
          confidenceSource: 'model_self_report',
        }],
      },
      {
        characterId: 'char-bob',
        canonicalSourceName: 'Bob',
        status: 'candidate',
        confidence: 0.4,
        voiceCore: { register: 'unknown' },
        evidence: [{
          segmentId: 's2',
          sourceQuote: 'Bob looked away.',
          dimension: 'discourse',
          observation: 'insufficient evidence',
          confidence: 0.4,
        }],
      },
    ],
  });

  assert.equal(memory.characterVoices[0].confidence, 0.82);
  assert.equal(memory.characterVoices[0].confidenceSource, 'model_self_report');
  assert.equal(memory.characterVoices[0].evidence[0].confidence, 0.76);
  assert.equal(memory.characterVoices[0].evidence[0].confidenceSource, 'model_self_report');
  assert.equal(memory.characterVoices[1].confidence, null);
  assert.equal(memory.characterVoices[1].confidenceSource, undefined);
  assert.equal(memory.characterVoices[1].evidence[0].confidence, null);
  assert.equal(memory.characterVoices[1].evidence[0].confidenceSource, undefined);
});


test('evidence-backed candidate voice profiles are included by default; disabled profiles are excluded', () => {
  const memory = {
    characterVoices: [
      {
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        role: 'a young officer',
        traits: ['measured'],
        voiceCore: { register: 'brief and restrained' },
        evidence: [{
          segmentId: 's1', sourceQuote: 'Alice answered quietly.',
          dimension: 'register', observation: 'brief answer', confidence: null,
        }],
      },
      {
        characterId: 'char-bob',
        canonicalSourceName: 'Bob',
        status: 'candidate',
        useForTranslation: false,
        role: 'disabled role',
        voiceCore: { register: 'do not include' },
        evidence: [{
          segmentId: 's2', sourceQuote: 'Bob shouted loudly.',
          dimension: 'register', observation: 'loud answer', confidence: null,
        }],
      },
    ],
  };
  const context = buildProjectVoiceContext(memory, [
    { id: 'current', text: 'Alice answered, then Bob shouted.', contextPath: 'Chapter 1' },
  ], 'Chapter 1');
  const voices = context.characterVoices;
  assert.deepEqual(voices.map((profile) => profile.characterId), ['char-alice']);
  assert.equal(voices[0].useForTranslation, true);
  assert.equal(voices[0].role, 'a young officer');
  assert.deepEqual(voices[0].traits, ['measured']);
});


test('literary analysis does not invent a 0.4 confidence when the model omits it', () => {
  const result = stabilizeVoiceAnalysis({}, {
    characterVoices: [{
      characterId: 'model-alice',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      voiceCore: { register: 'measured' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
      }],
    }],
  }, [{ id: 's1', text: 'Alice spoke softly.' }]);

  assert.equal(result.characterVoices[0].confidence, null);
  assert.equal(result.characterVoices[0].confidenceSource, undefined);
  assert.equal(result.characterVoices[0].evidence[0].confidence, null);
  assert.equal(result.characterVoices[0].evidence[0].confidenceSource, undefined);
});

test('valid numeric scores are retained with explicit model-self-report provenance', () => {
  const result = stabilizeVoiceAnalysis({}, {
    characterVoices: [{
      characterId: 'model-alice',
      canonicalSourceName: 'Alice',
      status: 'candidate',
      confidence: 0.83,
      voiceCore: { register: 'measured' },
      evidence: [{
        segmentId: 's1',
        sourceQuote: 'Alice spoke softly.',
        dimension: 'register',
        observation: 'quiet register',
        confidence: 0.74,
      }],
    }],
  }, [{ id: 's1', text: 'Alice spoke softly.' }]);

  assert.equal(result.characterVoices[0].confidence, 0.83);
  assert.equal(result.characterVoices[0].confidenceSource, 'model_self_report');
  assert.equal(result.characterVoices[0].evidence[0].confidence, 0.74);
  assert.equal(result.characterVoices[0].evidence[0].confidenceSource, 'model_self_report');
});

test('legacy active literary memory states preserve their status but record unknown confirmation provenance', () => {
  const memory = sanitizeProjectLiteraryMemory({
    entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', reviewStatus: 'confirmed' }],
    relationships: [{ subject: 'Alice', predicate: 'knows', object: 'Bob', reviewStatus: 'confirmed' }],
    styleGuide: { register: 'restrained' },
    styleGuideStatus: 'confirmed',
    characterVoices: [{
      characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
      status: 'confirmed', useForTranslation: true, voiceCore: { register: 'restrained' },
      evidence: [{
        segmentId: 's1', sourceQuote: 'Alice answered quietly.', dimension: 'register',
        observation: 'restrained register', confidence: null,
      }],
    }, {
      characterId: 'char-bob', canonicalSourceName: 'Bob', targetName: '鲍勃',
      status: 'confirmed', useForTranslation: true, voiceCore: { register: 'direct' },
      evidence: [{
        segmentId: 's2', sourceQuote: 'Bob replied quickly.', dimension: 'register',
        observation: 'direct register', confidence: null,
      }],
    }],
    relationshipVoiceRules: [{
      speakerId: 'char-alice', addresseeId: 'char-bob', status: 'confirmed',
      addressTerms: ['Mr.'], evidenceSegmentIds: ['s1'],
    }],
    voiceAnchors: [{
      anchorId: 'anchor-1', speakerId: 'char-alice', addresseeId: 'char-bob',
      source: 'Alice answered quietly.', target: '艾丽丝轻声回答。',
      segmentId: 's1', status: 'approved', attributionEvidence: 'Alice answered quietly.',
      attributionConfidence: 0.9, approvedBy: 'user', tags: [],
    }],
  });

  assert.equal(memory.entities[0].reviewStatus, 'confirmed');
  assert.equal(memory.entities[0].confirmationSource, 'legacy-unknown');
  assert.equal(memory.relationships[0].confirmationSource, 'legacy-unknown');
  assert.equal(memory.styleGuideConfirmationSource, 'legacy-unknown');
  assert.equal(memory.characterVoices[0].confirmationSource, 'legacy-unknown');
  assert.equal(memory.relationshipVoiceRules[0].confirmationSource, 'legacy-unknown');
  assert.equal(memory.voiceAnchors[0].confirmationSource, 'legacy-unknown');
});

test('default adoption never mislabels a model candidate as user-confirmed', () => {
  const memory = sanitizeProjectLiteraryMemory({
    entities: [
      { source: 'Alice', target: '艾丽丝', kind: 'person', reviewStatus: 'confirmed', confirmationSource: 'user-confirmed' },
      { source: 'Bob', target: '鲍勃', kind: 'person', reviewStatus: 'suggested', confirmationSource: 'user-confirmed' },
    ],
  });
  assert.equal(memory.entities[0].confirmationSource, 'user-confirmed');
  assert.equal(memory.entities[1].reviewStatus, 'confirmed');
  assert.equal(memory.entities[1].confirmationSource, 'model-default');
});



test('LiteraryMemory drops unrelated full-book payloads before enforcing the canonical DTO budget', () => {
  const memory = sanitizeProjectLiteraryMemory({
    sourceDocument: 'full book text '.repeat(50_000),
    contextGraph: { evidence: 'whole-book graph '.repeat(20_000) },
    entities: [{ source: 'Yabu', target: '薮', kind: 'person', aliases: ['Yabu'], reviewStatus: 'confirmed' }],
  });
  assert.equal(memory.entities.length, 1);
  assert.equal(memory.entities[0].target, '薮');
  assert.equal(Object.hasOwn(memory, 'sourceDocument'), false);
  assert.equal(Object.hasOwn(memory, 'contextGraph'), false);
});

test('oversized structured LiteraryMemory is pruned safely to a bounded canonical DTO', () => {
  const characterVoices = Array.from({ length: 900 }, (_, index) => ({
    characterId: 'char-' + index,
    canonicalSourceName: 'Character ' + index,
    status: 'candidate',
    evidencePolicyVersion: 'character-evidence-v2-complete',
    voiceCore: {
      register: 'measured '.repeat(20),
      syntaxRhythm: Array.from({ length: 6 }, (_, n) => 'sentence rhythm observation ' + n + ' '.repeat(20)),
      lexicalPreferences: Array.from({ length: 6 }, (_, n) => 'lexical observation ' + n + ' '.repeat(20)),
      discourseHabits: Array.from({ length: 6 }, (_, n) => 'dialogue strategy ' + n + ' '.repeat(20)),
    },
    evidence: Array.from({ length: 12 }, (_, evidenceIndex) => ({
      segmentId: 's' + index + '-' + evidenceIndex,
      sourceQuote: 'SOURCE '.repeat(30),
      dimension: 'register',
      observation: 'Observation '.repeat(20),
    })),
  }));
  const memory = sanitizeProjectLiteraryMemory({
    characterVoices,
    chapterSummaries: Array.from({ length: 40 }, (_, index) => ({
      chapter: 'Chapter ' + index, summary: 'Summary '.repeat(50),
    })),
    recentExamples: Array.from({ length: 8 }, () => ({
      source: 'Source '.repeat(30), target: 'Target '.repeat(30),
    })),
    voiceAnchors: Array.from({ length: 240 }, (_, index) => ({
      anchorId: 'anchor-' + index, speakerId: 'char-0', segmentId: 's' + index,
      source: 'Source '.repeat(20), target: 'Target '.repeat(20), status: 'candidate',
    })),
  });

  assert.ok(Buffer.byteLength(JSON.stringify(memory), 'utf8') <= 5 * 1024 * 1024);
  assert.equal(memory.characterVoices.length, 900, 'the DTO byte ceiling must not silently cap the number of character profiles');
  assert.ok(memory.characterVoices.some((profile) => profile.evidenceTruncated === true),
    'overflow is handled by explicitly marking pruned source evidence instead of dropping profiles by input order');
});
