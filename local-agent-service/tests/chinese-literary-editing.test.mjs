import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiteraryReviewPrompt } from '../src/literary.ts';

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
