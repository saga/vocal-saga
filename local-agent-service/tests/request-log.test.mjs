import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPollingRequest, collapsePath, createPollingRollup, recordPollingRequest,
  resetPollingRollup, formatPollingSummary,
} from '../src/log.ts';

const PROJECT = '/api/documents/projects/d871e550-d68d-425b-b0bb-1f6598c5f8da';

test('treats every context-graph sub-path as polling, not just the bare path', () => {
  // 回归：过滤规则曾经写成 /context-graph$/，于是 /context-graph/status 每 1.2s 打一行，
  // 实测占全量日志 27%。子路径必须一并覆盖。
  assert.equal(isPollingRequest('GET', PROJECT + '/context-graph'), true);
  assert.equal(isPollingRequest('GET', PROJECT + '/context-graph/status'), true);
  assert.equal(isPollingRequest('GET', PROJECT + '/context-graph/summary'), true);
});

test('treats run detail and event stream as polling', () => {
  assert.equal(isPollingRequest('GET', PROJECT + '/runs/85834967'), true);
  assert.equal(isPollingRequest('GET', PROJECT + '/runs/85834967/events'), true);
});

test('keeps writes and one-off reads in the log', () => {
  assert.equal(isPollingRequest('POST', PROJECT + '/context-graph/analyze'), false);
  assert.equal(isPollingRequest('POST', PROJECT + '/runs'), false);
  assert.equal(isPollingRequest('GET', PROJECT + '/segments'), false);
  assert.equal(isPollingRequest('GET', PROJECT + '/literary-memory'), false);
  // 只按方法 + 路径判定：run 的子资源不是轮询（例如单段译文读写）。
  assert.equal(isPollingRequest('GET', PROJECT + '/runs/85834967/segments'), false);
});

test('collapses ids so one endpoint does not occupy several summary slots', () => {
  assert.equal(collapsePath(PROJECT + '/context-graph/status'), '/api/documents/projects/:id/context-graph/status');
  assert.equal(collapsePath(PROJECT + '/runs/85834967'), '/api/documents/projects/:id/runs/:id');
});

test('summarises a window into one line and resets afterwards', () => {
  const rollup = createPollingRollup();
  const now = 1_000_000;
  recordPollingRequest(rollup, PROJECT + '/context-graph/status', 3, now);
  recordPollingRequest(rollup, PROJECT + '/context-graph/status', 7, now + 500);
  recordPollingRequest(rollup, PROJECT + '/runs/abc', 2, now + 900);

  const line = formatPollingSummary(rollup, now + 60_000);
  assert.match(line, /静默 3 次/);
  assert.match(line, /context-graph\/status ×2/);
  assert.match(line, /最慢 7ms/);
  assert.match(line, /最近 60s/);

  resetPollingRollup(rollup);
  assert.equal(formatPollingSummary(rollup, now + 61_000), null, '空窗口不该打出空汇总行');
});

test('empty rollup yields no summary line', () => {
  assert.equal(formatPollingSummary(createPollingRollup()), null);
});
