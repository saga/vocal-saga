import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { appendLogToFile, logStamp } from '../src/log.ts';

test('file logs use physical newlines and sortable local date timestamps', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-log-'));
  const file = path.join(dir, 'service.log');
  const priorLogFile = process.env.LOCAL_AGENT_LOG_FILE;
  try {
    process.env.LOCAL_AGENT_LOG_FILE = file;
    appendLogToFile('[test] first');
    appendLogToFile('[test] second');
    assert.equal(readFileSync(file, 'utf8'), '[test] first\n[test] second\n');
    assert.match(logStamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally {
    if (priorLogFile === undefined) delete process.env.LOCAL_AGENT_LOG_FILE;
    else process.env.LOCAL_AGENT_LOG_FILE = priorLogFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
