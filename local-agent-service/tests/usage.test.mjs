import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTurnUsage,
  formatTurnUsageLog,
  parseTurnUsage,
  summarizeTurnUsage,
} from '../src/agents/usage.ts';

test('CodeBuddy input, cache-read, and cache-write tokens are disjoint input components', () => {
  const usage = parseTurnUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 87,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 40,
    },
    total_cost_usd: 0,
    duration_ms: 1200,
    num_turns: 1,
  });

  assert.ok(usage);
  const summary = summarizeTurnUsage(usage);
  assert.deepEqual(summary, {
    inputTokens: 100,
    outputTokens: 87,
    cacheReadTokens: 60,
    cacheCreationTokens: 40,
    totalInputTokens: 200,
    totalTokens: 287,
    durationMs: 1200,
    numTurns: 1,
  });
  assert.equal(
    formatTurnUsageLog(usage),
    'token input=100 cache-read=60 cache-write=40 total-in=200 out=87',
  );
});

test('usage aggregation adds each disjoint input component once', () => {
  const first = parseTurnUsage({
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 },
  });
  const second = parseTurnUsage({
    usage: { input_tokens: 130, output_tokens: 30, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 },
  });

  const combined = addTurnUsage(first, second);
  assert.ok(combined);
  assert.deepEqual(summarizeTurnUsage(combined), {
    inputTokens: 230,
    outputTokens: 50,
    cacheReadTokens: 150,
    cacheCreationTokens: 30,
    totalInputTokens: 410,
    totalTokens: 460,
  });
});

test('total input includes uncached, cache-read, and cache-write tokens as separate fields', () => {
  const usage = parseTurnUsage({
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 40 },
  });
  assert.ok(usage);
  const summary = summarizeTurnUsage(usage);
  assert.equal(summary?.totalInputTokens, 220);
  assert.equal(summary?.totalTokens, 230);
});
