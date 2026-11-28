import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyLimiter, resolveReviewConcurrencyForWave } from '../src/documents/translationConcurrency.ts';

test('review concurrency reserves only the workers required by the next translation wave', () => {
  const base = {
    poolSize: 8,
    translationConcurrency: 4,
    reviewConcurrency: 2,
    reviewDrainConcurrency: 8,
  };
  assert.equal(resolveReviewConcurrencyForWave({ ...base, waveBatchCount: 4 }), 4);
  assert.equal(resolveReviewConcurrencyForWave({ ...base, waveBatchCount: 2 }), 6);
  assert.equal(resolveReviewConcurrencyForWave({ ...base, waveBatchCount: 1 }), 7);
  assert.equal(resolveReviewConcurrencyForWave({ ...base, waveBatchCount: 1, reviewDrainConcurrency: 3 }), 3);
});

test('shrinking the limiter stops waking queued tasks until active work drains to the new limit', async () => {
  const limiter = createConcurrencyLimiter(3);
  const started = [];
  const release = new Map();
  const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => limiter(() => new Promise((resolve) => {
    started.push(id);
    release.set(id, resolve);
  })));
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(limiter.active(), 3);

  limiter.setConcurrency(1);
  release.get('a')();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(limiter.active(), 2);

  release.get('b')();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(limiter.active(), 1);

  release.get('c')();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  assert.equal(limiter.active(), 1);

  release.get('d')();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  release.get('e')();
  await Promise.all(tasks);
  assert.equal(limiter.active(), 0);
});
