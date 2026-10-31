import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-review-timeout-'));
const workspace = path.join(root, 'workspace');
const bin = path.join(root, 'bin');
mkdirSync(workspace, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.LOCAL_AGENT_DATA_DIR = root;
process.env.LOCAL_AGENT_WORKDIR = workspace;
const opencodePath = path.join(bin, 'opencode');
writeFileSync(opencodePath, '#!/usr/bin/env node\nsetInterval(() => {}, 10_000);\n', { mode: 0o700 });
chmodSync(opencodePath, 0o700);
process.env.PATH = bin + path.delimiter + (process.env.PATH || '');

const { runAgentJson } = await import('../src/agents/runner.ts');

test('runAgentJson forwards a reviewer-specific timeout to the OpenCode child process', async () => {
  const startedAt = Date.now();
  try {
    await assert.rejects(
      runAgentJson(
        { provider: 'opencode', model: '' },
        'test prompt',
        'test system prompt',
        { type: 'object' },
        'reviewer-timeout-regression',
        undefined,
        undefined,
        { timeoutMs: 40 },
      ),
      /OpenCode 调用超时（40 ms）/,
    );
    assert.ok(Date.now() - startedAt < 3000, 'the short deadline should terminate the child without hanging');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
