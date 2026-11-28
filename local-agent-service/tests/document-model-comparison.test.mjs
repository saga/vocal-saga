import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComparisonModelChoices } from '../src/documents/documentModelComparison.ts';

test('two-model comparison remains supported and receives literary defaults', () => {
  const choices = normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', model: 'glm-5.3-flash' },
  ]);
  assert.deepEqual(choices, [
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', thinkingMode: 'enabled', effort: 'low' },
    { provider: 'workbuddy', model: 'glm-5.3-flash', thinkingMode: 'enabled', effort: 'low' },
  ]);
});

test('three-model comparison preserves each model thinking mode and effort independently', () => {
  const choices = normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', thinkingMode: 'enabled', effort: 'low' },
    { provider: 'workbuddy', model: 'glm-5.3-flash', thinkingMode: 'adaptive', effort: 'medium' },
    { provider: 'workbuddy', model: 'hy3', thinkingMode: 'disabled', effort: 'high' },
  ]);
  assert.equal(choices?.length, 3);
  assert.deepEqual(choices?.map(({ thinkingMode, effort }) => ({ thinkingMode, effort })), [
    { thinkingMode: 'enabled', effort: 'low' },
    { thinkingMode: 'adaptive', effort: 'medium' },
    { thinkingMode: 'disabled', effort: 'high' },
  ]);
});

test('the same model can be compared with different reasoning settings', () => {
  const choices = normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', thinkingMode: 'enabled', effort: 'low' },
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash', thinkingMode: 'enabled', effort: 'high' },
  ]);
  assert.equal(choices?.length, 2);
});

test('identical configurations and invalid model counts are rejected', () => {
  assert.equal(normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  ]), null);
  assert.equal(normalizeComparisonModelChoices([{ provider: 'workbuddy', model: 'a' }]), null);
  assert.equal(normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'a' },
    { provider: 'workbuddy', model: 'b' },
    { provider: 'workbuddy', model: 'c' },
    { provider: 'workbuddy', model: 'd' },
  ]), null);
});

test('unsupported thinking modes, effort levels and providers are rejected', () => {
  assert.equal(normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'a', thinkingMode: 'random' },
    { provider: 'workbuddy', model: 'b' },
  ]), null);
  assert.equal(normalizeComparisonModelChoices([
    { provider: 'workbuddy', model: 'a', effort: 'turbo' },
    { provider: 'workbuddy', model: 'b' },
  ]), null);
  assert.equal(normalizeComparisonModelChoices([
    { provider: 'other', model: 'a' },
    { provider: 'workbuddy', model: 'b' },
  ]), null);
});
