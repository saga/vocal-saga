import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkbuddySessionPool } from '../src/agents/workbuddyPool.ts';

function fakeSession(onClose = () => {}) {
  return {
    send: async () => {},
    async *stream() {},
    interrupt: async () => {},
    close: onClose,
  };
}

const agent = (model) => ({ provider: 'workbuddy', model });

test('closing while session creation is pending closes the late session instead of publishing it', async () => {
  let resolveFactory;
  let factoryCalls = 0;
  let closeCalls = 0;
  const pool = new WorkbuddySessionPool(1, 10, () => {
    factoryCalls += 1;
    return new Promise((resolve) => { resolveFactory = resolve; });
  });

  const acquiring = pool.acquire(agent('model-a'), 'document:run:batch');
  await Promise.resolve();
  assert.equal(factoryCalls, 1);

  pool.closeAll();
  resolveFactory(fakeSession(() => { closeCalls += 1; }));

  await assert.rejects(acquiring, /session pool is closed/);
  assert.equal(closeCalls, 1);
});

test('closing wakes queued acquire calls and prevents them from creating another session', async () => {
  let factoryCalls = 0;
  const pool = new WorkbuddySessionPool(1, 10, () => {
    factoryCalls += 1;
    return fakeSession();
  });

  await pool.acquire(agent('model-a'), 'first-scope');
  const waiting = pool.acquire(agent('model-a'), 'second-scope');
  pool.closeAll();

  await assert.rejects(waiting, /session pool is closed/);
  assert.equal(factoryCalls, 1);
});

test('recreates a pooled Session when the SDK surface cannot switch models', async () => {
  const optionsSeen = [];
  let firstSessionCloseCalls = 0;
  const pool = new WorkbuddySessionPool(1, 10, (options) => {
    optionsSeen.push(options.model);
    return fakeSession(() => {
      if (optionsSeen.length === 1) firstSessionCloseCalls += 1;
    });
  });

  const first = await pool.acquire(agent('model-a'));
  pool.release(first);

  const second = await pool.acquire(agent('model-b'));
  assert.equal(second, first);
  assert.deepEqual(optionsSeen, ['model-a', 'model-b']);
  assert.equal(firstSessionCloseCalls, 1);
  pool.release(second);
  pool.closeAll();
});

test('legacy text translation option builder carries enabled low reasoning defaults', async () => {
  const { buildWorkbuddyOptions } = await import('../src/agents/workbuddy.ts');
  const options = buildWorkbuddyOptions(agent('model-a'));
  assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 8192 });
  assert.equal(options.effort, 'low');
});

test('legacy structured translation option builder also keeps thinking enabled at low effort', async () => {
  const { buildWorkbuddyOptions } = await import('../src/agents/workbuddy.ts');
  const options = buildWorkbuddyOptions(agent('model-a'), {
    type: 'object',
    properties: { translations: { type: 'array' } },
  });
  assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 8192 });
  assert.equal(options.effort, 'low');
  assert.equal(options.outputFormat.type, 'json_schema');
});
