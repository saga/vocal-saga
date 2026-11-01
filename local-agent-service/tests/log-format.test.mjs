/**
 * 日志可读性回归。
 *
 * 历史上这里写的是 line + '\\n'（字面反斜杠 + n），整个日志文件只有一个物理行，
 * wc -l / tail / grep -n 全部失效。这几条用例锁定"每行一条、真换行"和
 * "失败必须带原因"两个底线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = path.join(os.tmpdir(), 'vocal-saga-log-format-' + process.pid + '.log');
process.env.LOCAL_AGENT_LOG_FILE = LOG_FILE;

const { appendLogToFile, logWarn } = await import('../src/log.ts');
const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');

function readLog() {
  return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
}

function resetLog() {
  fs.rmSync(LOG_FILE, { force: true });
}

test('writes a real newline so the log file stays line-oriented', () => {
  resetLog();
  appendLogToFile('[scope 00:00:00] first');
  appendLogToFile('[scope 00:00:01] second');

  const raw = readLog();
  // 关键断言：文件里不能出现字面反斜杠 n。
  assert.equal(raw.includes('\\n'), false, '日志文件里出现了字面 \\n，说明换行没写对');
  const lines = raw.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['[scope 00:00:00] first', '[scope 00:00:01] second']);
});

test('one log call appends exactly one physical line', () => {
  resetLog();
  logWarn('pool', 'a');
  logWarn('pool', 'b');
  logWarn('pool', 'c');
  assert.equal(readLog().split('\n').filter(Boolean).length, 3);
});

test('a failed pool call records the underlying cause, not just "调用失败"', async () => {
  resetLog();
  const session = {
    send: async () => { throw new Error('cli exited with code 137'); },
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('unreachable'); },
    interrupt: async () => {},
    close: () => {},
  };
  const pool = new WorkbuddySessionPool(1, 10, async () => session);

  const index = await pool.acquire({ provider: 'workbuddy', model: 'm1' }, 'document:run:batch');
  await assert.rejects(
    pool.runPrompt(index, 'prompt', 'req-cause-1', 5_000),
    /Agent SDK 调用失败/,
  );
  pool.closeAll();

  const log = readLog();
  assert.match(log, /丢弃会话/);
  assert.match(log, /调用失败/);
  // 这一条是本用例的核心：没有 cause 的失败行等于没记。
  assert.match(log, /cause=cli exited with code 137/);
});

test('an empty response is logged with mode, request and scope', async () => {
  resetLog();
  const session = {
    send: async () => {},
    // eslint-disable-next-line require-yield
    async *stream() {},
    interrupt: async () => {},
    close: () => {},
  };
  const pool = new WorkbuddySessionPool(1, 10, async () => session);

  const index = await pool.acquire({ provider: 'workbuddy', model: 'm1' }, 'document:run:batch');
  await assert.rejects(pool.runPrompt(index, 'prompt', 'req-empty-1', 5_000), /空内容/);
  pool.closeAll();

  const log = readLog();
  assert.match(log, /空响应/);
  assert.match(log, /mode=text/);
  assert.match(log, /request=req-empty-1/);
});

test.after(() => {
  fs.rmSync(LOG_FILE, { force: true });
});
