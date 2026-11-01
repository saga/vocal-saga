import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CODEBUDDY_TASK_PROFILES,
  applyCodeBuddyTaskPrompt,
  codeBuddyThinkingOption,
  normalizeCodeBuddyTaskProfile,
  normalizeCodeBuddyTaskProfiles,
  resolveEffectiveTaskModel,
} from '../src/agents/taskProfiles.ts';
import { buildWorkbuddyOptions } from '../src/agents/workbuddy.ts';

test('defaults assign different reasoning budgets by task', () => {
  assert.deepEqual(codeBuddyThinkingOption(DEFAULT_CODEBUDDY_TASK_PROFILES.translation), { type: 'disabled' });
  assert.deepEqual(codeBuddyThinkingOption(DEFAULT_CODEBUDDY_TASK_PROFILES.accuracyReview), { type: 'adaptive' });
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.translation.effort, 'low');
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.styleReview.effort, 'high');
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.contextGraph.effort, 'high');
});

test('normalizes model inheritance and bounds thinking budget', () => {
  const normalized = normalizeCodeBuddyTaskProfile({
    model: 'auto',
    fallbackModel: ' auto ',
    thinkingMode: 'enabled',
    thinkingBudgetTokens: 90000,
    effort: 'xhigh',
    systemPromptAppendix: '  Keep names consistent  ',
  }, 'styleReview');

  assert.equal(normalized.model, '');
  assert.equal(normalized.fallbackModel, '');
  assert.equal(normalized.thinkingBudgetTokens, 65536);
  assert.equal(normalized.effort, 'xhigh');
  assert.equal(normalized.systemPromptAppendix, 'Keep names consistent');
  assert.deepEqual(codeBuddyThinkingOption(normalized), { type: 'enabled', budgetTokens: 65536 });
});

test('builds documented query Options for the selected task', () => {
  const profile = normalizeCodeBuddyTaskProfile({
    model: 'review-model',
    fallbackModel: 'backup-model',
    thinkingMode: 'enabled',
    thinkingBudgetTokens: 4096,
    effort: 'high',
  }, 'accuracyReview');
  const options = buildWorkbuddyOptions({ provider: 'workbuddy', model: 'review-model' }, undefined, profile);

  assert.equal(options.model, 'review-model');
  assert.equal(options.fallbackModel, 'backup-model');
  assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 4096 });
  assert.equal(options.effort, 'high');
  assert.deepEqual(options.tools, []);
  assert.equal(options.maxTurns, 1);
});

test('task prompts are supplemental and cannot drop the generated task payload', () => {
  const profile = normalizeCodeBuddyTaskProfile({
    systemPromptAppendix: 'Prefer short, natural Chinese.',
    userPromptTemplate: 'Task input:\n{{CONTENT}}',
  }, 'styleReview');
  const applied = applyCodeBuddyTaskPrompt(
    'source and draft JSON',
    'Built-in reviewer contract',
    profile,
  );

  assert.equal(applied.prompt, 'Task input:\nsource and draft JSON');
  assert.ok(applied.systemPrompt.indexOf('Prefer short, natural Chinese.') < applied.systemPrompt.indexOf('Built-in reviewer contract'));
});

test('old or partial profiles are filled with explicit per-task defaults', () => {
  const profiles = normalizeCodeBuddyTaskProfiles({ translation: { effort: 'low' } });
  assert.equal(profiles.translation.effort, 'low');
  assert.equal(profiles.translation.thinkingMode, 'disabled');
  assert.equal(profiles.styleReview.effort, 'high');
  assert.equal(profiles.contextGraph.thinkingMode, 'adaptive');
});

test('contextWindow is opt-in and normalized without changing task defaults', () => {
  const defaults = normalizeCodeBuddyTaskProfiles({});
  assert.equal(defaults.translation.contextWindow, undefined);
  assert.equal(DEFAULT_CODEBUDDY_TASK_PROFILES.translation.contextWindow, undefined);

  const explicit = normalizeCodeBuddyTaskProfile({ contextWindow: '1000000' }, 'translation');
  assert.equal(explicit.contextWindow, 1_000_000);
  assert.equal(normalizeCodeBuddyTaskProfile({ contextWindow: '1M' }, 'translation').contextWindow, undefined);
});

test('effective model prefers the task profile over the pool default', () => {
  // 回归：审计事件曾经记录池默认模型（glm-5.3-flash），而 runner 实际用的是
  // taskProfile.model（deepseek-v4.1-flash），日志上的模型名因此是错的。
  const profile = normalizeCodeBuddyTaskProfile({ model: 'deepseek-v4.1-flash' }, 'translation');
  assert.equal(resolveEffectiveTaskModel('glm-5.3-flash', profile), 'deepseek-v4.1-flash');
  assert.equal(resolveEffectiveTaskModel('glm-5.3-flash', undefined), 'glm-5.3-flash');
  assert.equal(resolveEffectiveTaskModel('', undefined), '<runtime-default>');
  // 'auto' 表示「不覆盖」，回落到基础模型。
  assert.equal(resolveEffectiveTaskModel('glm-5.3-flash', { ...profile, model: 'auto' }), 'glm-5.3-flash');
  assert.equal(resolveEffectiveTaskModel('glm-5.3-flash', { ...profile, model: '  ' }), 'glm-5.3-flash');
});
