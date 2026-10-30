import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChineseLiteraryEditingPrompt, buildChineseTargetOnlyVoiceContext, buildLiteraryReviewPrompt, isChineseLiteraryFindingGrounded } from '../src/literary.ts';

const base = {
  body: { target: 'zh-CN', chapterTitle: 'Chapter 1' },
  segments: [{
    id: 'p1',
    source: 'And my body, the side upon which I was lying, loyally preserving from the past an impression.',
    draft: '而我的身体，我躺着的那一侧，忠实地从过去保存着一种印象。',
    kind: 'paragraph',
  }],
  translationBrief: null,
  precedingSegments: [],
  voiceContext: {},
  contextGraph: null,
};

test('Chinese style review includes Chinese literary editing without creating a separate review focus', () => {
  const { systemPrompt } = buildLiteraryReviewPrompt({ ...base, reviewFocus: 'style' });
  assert.match(systemPrompt, /Chinese Literary Editing/);
  assert.match(systemPrompt, /不必要的第一\/第二\/第三人称代词/);
  assert.match(systemPrompt, /“的、地、得”/);
  assert.match(systemPrompt, /英文语序/);
  assert.match(systemPrompt, /chinese_literary_editing/);
  assert.match(systemPrompt, /不得.*新增原文没有的信息/);
});

test('Chinese literary editing is not injected into non-Chinese style review', () => {
  const { systemPrompt } = buildLiteraryReviewPrompt({
    ...base,
    body: { ...base.body, target: 'ja' },
    reviewFocus: 'style',
  });
  assert.doesNotMatch(systemPrompt, /Chinese Literary Editing/);
  assert.doesNotMatch(systemPrompt, /“的、地、得”/);
  assert.match(systemPrompt, /人物声音差异/);
});

test('accuracy review does not receive Chinese copyediting instructions', () => {
  const { systemPrompt } = buildLiteraryReviewPrompt({ ...base, reviewFocus: 'accuracy' });
  assert.doesNotMatch(systemPrompt, /Chinese Literary Editing/);
  assert.doesNotMatch(systemPrompt, /“的、地、得”/);
  assert.match(systemPrompt, /准确性与专名审校阶段/);
});


test('Chinese literary editor receives only Chinese draft text and target-language memory', () => {
  const sourceOnly = 'SOURCE_SECRET: And my body, the side upon which I was lying.';
  const draft = '而我的身体，我躺着的那一侧，忠实地保存着一种印象。';
  const voiceContext = {
    styleGuideStatus: 'confirmed',
    styleGuide: { narrativeVoice: '克制、疏离，不主动解释人物心理' },
    entities: [{ source: 'Alice', target: '艾丽丝' }],
    relationships: [{ subject: 'Alice', predicate: 'knows', object: 'Bob' }],
    chapterSummaries: [{ chapter: 'Chapter 1', summary: sourceOnly }],
    characterVoices: [{
      characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
      aliases: ['Al'], status: 'confirmed', role: '叙述者',
      voiceCore: { register: '克制', syntaxRhythm: ['长句'] },
      evidence: [{ sourceQuote: sourceOnly, observation: 'source evidence must not leak' }],
    }],
    voiceAnchors: [{
      speakerId: 'char-alice', source: sourceOnly, target: '我不这么认为。',
      status: 'approved', tags: ['direct'],
    }],
    dialogueParticipants: [{ characterId: 'char-alice', role: 'speaker', confidence: 0.9 }],
    recentExamples: [{ source: sourceOnly, target: draft }],
  };
  const { systemPrompt, prompt } = buildChineseLiteraryEditingPrompt({
    body: { target: 'zh-CN', chapterTitle: 'Chapter 1' },
    segments: [{ id: 'p1', source: sourceOnly, draft, kind: 'paragraph' }],
    voiceContext,
  });
  assert.match(prompt, /而我的身体/);
  assert.match(prompt, /艾丽丝/);
  assert.match(prompt, /克制、疏离/);
  assert.doesNotMatch(prompt, /SOURCE_SECRET/);
  assert.doesNotMatch(prompt, /upon which I was lying/);
  assert.doesNotMatch(prompt, /Chapter 1/, 'source-language chapter labels are not part of the monolingual edit context');
  assert.doesNotMatch(prompt, /Alice/);
  assert.doesNotMatch(prompt, /source evidence must not leak/);
  assert.doesNotMatch(prompt, /最近/);
  assert.match(systemPrompt, /不会收到外文原文/);
  assert.match(systemPrompt, /原稿已经自然、准确/);
});

test('target-only voice projection removes source identity, quotations, summaries and relationships', () => {
  const projected = buildChineseTargetOnlyVoiceContext({
    styleGuideStatus: 'candidate',
    styleGuide: { narrativeVoice: 'must not be included' },
    entities: [{ source: 'Alice', target: '艾丽丝' }],
    relationships: [{ subject: 'Alice', object: 'Bob' }],
    chapterSummaries: [{ summary: 'source-derived plot summary' }],
    characterVoices: [{
      characterId: 'char-a', canonicalSourceName: 'Alice', targetName: '艾丽丝',
      aliases: ['Al'], status: 'confirmed', voiceCore: { register: '克制' },
      evidence: [{ sourceQuote: 'secret source quote' }],
    }],
    voiceAnchors: [{
      speakerId: 'char-a', source: 'secret source dialogue', target: '中文对白',
      status: 'approved',
    }],
    recentExamples: [{ source: 'secret source example', target: '已采纳的中文例句。', origin: 'manual' }],
  });
  const serialized = JSON.stringify(projected);
  assert.match(serialized, /艾丽丝/);
  assert.match(serialized, /中文对白/);
  assert.match(serialized, /已采纳的中文例句/);
  assert.doesNotMatch(serialized, /Alice|secret source|source-derived|must not be included/);
});

test('Chinese literary editing findings require a quoted target excerpt and do not permit source-based evidence', () => {
  const draft = '而我的身体，我躺着的那一侧，忠实地从过去保存着一种印象。';
  const targetExcerpt = '忠实地从过去保存着一种印象';
  assert.equal(isChineseLiteraryFindingGrounded(draft, targetExcerpt), true);
  assert.equal(isChineseLiteraryFindingGrounded(draft, 'This is an invented English source quote.'), false);
  assert.equal(isChineseLiteraryFindingGrounded(draft, 'x'), false);
  assert.equal(isChineseLiteraryFindingGrounded(draft, ''), false);
});


test('target-only editor preserves explicitly user-edited style guidance', () => {
  const projected = buildChineseTargetOnlyVoiceContext({
    styleGuideStatus: 'candidate',
    styleGuideOrigin: 'user-edited',
    styleGuide: { narrativeVoice: '用户明确要求保持克制。' },
  });
  assert.deepEqual(projected.styleGuide, { narrativeVoice: '用户明确要求保持克制。' });
});
