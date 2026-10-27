import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTurnUsage,
  formatTurnUsageLog,
  parseTurnUsage,
  summarizeTurnUsage,
} from '../src/agents/usage.ts';

test('CodeBuddy input_tokens already includes cache read/write and is not double-counted', () => {
  const usage = parseTurnUsage({
    usage: {
      input_tokens: 10925,
      output_tokens: 87,
      cache_read_input_tokens: 6784,
      cache_creation_input_tokens: 4141,
    },
    total_cost_usd: 0,
    duration_ms: 1200,
    num_turns: 1,
  });

  assert.ok(usage);
  const summary = summarizeTurnUsage(usage);
  assert.deepEqual(summary, {
    inputTokens: 10925,
    uncachedInputTokens: 0,
    outputTokens: 87,
    cacheReadTokens: 6784,
    cacheCreationTokens: 4141,
    totalInputTokens: 10925,
    totalTokens: 11012,
    durationMs: 1200,
    numTurns: 1,
  });
  assert.equal(
    formatTurnUsageLog(usage),
    'token in=10,925 uncached=0 cache-read=6,784 cache-write=4,141 out=87',
  );
});

test('usage aggregation adds each request total once and preserves cache decomposition', () => {
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
    uncachedInputTokens: 50,
    outputTokens: 50,
    cacheReadTokens: 150,
    cacheCreationTokens: 30,
    totalInputTokens: 230,
    totalTokens: 280,
  });
});

test('uncached token estimate never becomes negative if provider cache fields overlap', () => {
  const usage = parseTurnUsage({
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 40 },
  });
  assert.ok(usage);
  assert.equal(summarizeTurnUsage(usage)?.uncachedInputTokens, 0);
  assert.equal(summarizeTurnUsage(usage)?.totalInputTokens, 100);
});
