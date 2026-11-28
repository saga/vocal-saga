import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeWorkbuddyQueryTiming } from '../src/agents/workbuddy.ts';

test('summarizes SDK loading, query creation and model response timing', () => {
  const summary = summarizeWorkbuddyQueryTiming({
    startedAt: 100,
    sdkReadyAt: 115,
    queryCreateStartedAt: 120,
    queryCreatedAt: 125,
    firstMessageAt: 145,
    firstAssistantAt: 505,
    resultAt: 705,
    finishedAt: 710,
  });

  assert.deepEqual(summary, {
    sdkImportMs: 15,
    preQuerySetupMs: 5,
    queryCreateMs: 5,
    firstMessageAfterQueryMs: 20,
    firstAssistantAfterQueryMs: 380,
    resultAfterQueryMs: 580,
    totalMs: 610,
  });
});

test('reports missing stages as null instead of zero', () => {
  const summary = summarizeWorkbuddyQueryTiming({
    startedAt: 100,
    finishedAt: 160,
  });

  assert.equal(summary.sdkImportMs, null);
  assert.equal(summary.preQuerySetupMs, null);
  assert.equal(summary.queryCreateMs, null);
  assert.equal(summary.firstMessageAfterQueryMs, null);
  assert.equal(summary.firstAssistantAfterQueryMs, null);
  assert.equal(summary.resultAfterQueryMs, null);
  assert.equal(summary.totalMs, 60);
});

test('does not report negative phase durations when timestamps are inconsistent', () => {
  const summary = summarizeWorkbuddyQueryTiming({
    startedAt: 100,
    sdkReadyAt: 90,
    queryCreateStartedAt: 120,
    queryCreatedAt: 110,
    firstMessageAt: 130,
    finishedAt: 150,
  });

  assert.equal(summary.sdkImportMs, null);
  assert.equal(summary.preQuerySetupMs, null);
  assert.equal(summary.queryCreateMs, null);
  assert.equal(summary.firstMessageAfterQueryMs, null);
  assert.equal(summary.firstAssistantAfterQueryMs, null);
  assert.equal(summary.resultAfterQueryMs, null);
  assert.equal(summary.totalMs, 50);
});
