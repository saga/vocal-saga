import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentPrompt, parseAgentModel, parseJsonObject, parseJsonValue } from '../src/server.ts';

test('uses Workbuddy as the default runtime and respects explicit runtime overrides', () => {
  const defaultAgent = parseAgentModel('auto');
  assert.equal(defaultAgent.provider, 'workbuddy');

  const openCode = parseAgentModel('opencode');
  assert.equal(openCode.provider, 'opencode');
  assert.ok(!openCode.model || openCode.model.includes('/'));

  const workbuddy = parseAgentModel('workbuddy', 'opencode');
  assert.equal(workbuddy.provider, 'workbuddy');
  assert.ok(typeof workbuddy.model === 'string');
});

test('routes explicit Workbuddy model aliases', () => {
  const result = parseAgentModel('workbuddy:claude-sonnet-example', 'opencode');
  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.model, 'claude-sonnet-example');
});

test('routes explicit OpenCode provider/model aliases', () => {
  const result = parseAgentModel('opencode:openai/gpt-5.4', 'workbuddy');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'openai/gpt-5.4');
});

test('parses JSON inside a Markdown code fence', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const newline = String.fromCharCode(10);
  assert.deepEqual(parseJsonObject(fence + 'json' + newline + '{"ok":true}' + newline + fence), { ok: true });
});

test('parses a JSON object wrapped in explanation', () => {
  assert.deepEqual(parseJsonObject('result:\n{"ok":true}\nthanks'), { ok: true });
});

test('accepts a valid JSON array as a translation response', () => {
  assert.deepEqual(parseJsonValue('[{"id":"s0","translated_text":"你好"}]'), [
    { id: 's0', translated_text: '你好' },
  ]);
  // Keep schema-specific parsing strict for literary-analysis and reviewer responses.
  assert.equal(parseJsonObject('[{"id":"s0","translated_text":"你好"}]'), null);
});

test('parses a fenced JSON array', () => {
  const fence = String.fromCharCode(96).repeat(3);
  assert.deepEqual(parseJsonValue(fence + 'json\n[{"id":"s0","translated_text":"你好"}]\n' + fence), [
    { id: 's0', translated_text: '你好' },
  ]);
});

test('parses an array surrounded by model commentary without breaking escaped quotes', () => {
  const raw = 'Result:\n[{"id":"s0","translated_text":"他说：\\\"你好\\\""}]\nDone';
  assert.deepEqual(parseJsonValue(raw), [
    { id: 's0', translated_text: '他说："你好"' },
  ]);
});

test('rejects reviewer input that would otherwise be silently truncated', async () => {
  const { validateSegments } = await import('../src/server.ts');
  assert.throws(
    () => validateSegments([{ id: 'long-source', source: 's'.repeat(4001), draft: '译文' }], 32, 'review'),
    /超过本机单片段限制/,
  );
  assert.throws(
    () => validateSegments([{ id: 'long-draft', source: '原文', draft: '译'.repeat(5001) }], 32, 'review'),
    /超过本机单片段限制/,
  );
});

test('workbuddy 文本模式禁用工具，JSON 模式开启原生 structured output', async () => {
  const { buildWorkbuddyOptions } = await import('../src/agents/workbuddy.ts');
  const text = buildWorkbuddyOptions({ provider: 'workbuddy', model: 'some-model' });
  assert.deepEqual(text.tools, []);
  assert.deepEqual(text.allowedTools, []);
  assert.equal(text.maxTurns, 1);
  assert.equal(text.outputFormat, undefined);
  // 翻译任务关思考、推理深度压到 low。
  // effort 现在是 SDK 的一级选项（transport 直接拼 --effort），不再经 extraArgs 传。
  assert.deepEqual(text.thinking, { type: 'disabled' });
  assert.equal(text.effort, 'low');
  assert.equal(text.extraArgs, undefined);

  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const json = buildWorkbuddyOptions({ provider: 'workbuddy', model: '' }, schema);
  assert.equal('model' in json, false);
  assert.deepEqual(json.tools, ['StructuredOutput']);
  assert.deepEqual(json.allowedTools, ['StructuredOutput']);
  assert.ok(json.maxTurns > 1);
  assert.deepEqual(json.outputFormat, { type: 'json_schema', schema });
  assert.deepEqual(JSON.parse(json.extraArgs['json-schema']), schema);
});

test('resolveWorkbuddyStructured 接受对象与数组', async () => {
  const { resolveWorkbuddyStructured } = await import('../src/agents/workbuddy.ts');
  assert.deepEqual(resolveWorkbuddyStructured([{ id: 's0' }], 'not json'), [{ id: 's0' }]);
  assert.deepEqual(resolveWorkbuddyStructured({ a: 1 }, 'not json'), { a: 1 });
  assert.deepEqual(resolveWorkbuddyStructured(undefined, '[{"id":"s0","translated_text":"你好"}]'), [
    { id: 's0', translated_text: '你好' },
  ]);
  assert.throws(() => resolveWorkbuddyStructured(undefined, 'not json'), /不是有效 JSON/);
  assert.throws(() => resolveWorkbuddyStructured('plain string', 'not json'), /不是有效 JSON/);
});

test('resolveWorkbuddyJson 优先使用原生 structured_output', async () => {
  const { resolveWorkbuddyJson } = await import('../src/agents/workbuddy.ts');
  assert.deepEqual(resolveWorkbuddyJson({ a: 1 }, 'not json'), { a: 1 });
  assert.deepEqual(resolveWorkbuddyJson(undefined, '{"a":1}'), { a: 1 });
  const fence = String.fromCharCode(96).repeat(3);
  assert.deepEqual(resolveWorkbuddyJson(null, fence + 'json\n{"a":2}\n' + fence), { a: 2 });
  assert.throws(() => resolveWorkbuddyJson(undefined, 'not json'), /不是有效 JSON/);
  assert.throws(() => resolveWorkbuddyJson(undefined, '[1,2]'), /不是预期 JSON 对象/);
});

test('文学分析与审校的 schema 约束必填顶层字段', async () => {
  const { LITERARY_ANALYSIS_SCHEMA, LITERARY_REVIEW_SCHEMA } = await import('../src/literary.ts');
  assert.deepEqual(LITERARY_ANALYSIS_SCHEMA.required, ['entities', 'relationships']);
  assert.deepEqual(LITERARY_REVIEW_SCHEMA.required, ['results']);
});

test('会话池复用：空闲槽复用同一会话，全忙时排队', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const created = [];
  const factory = (options) => {
    const session = {
      sent: [], closed: false, models: [], options,
      async send(m) { this.sent.push(m); },
      async *stream() {},
      async interrupt() {},
      close() { this.closed = true; },
      async setModel(m) { this.models.push(m); },
    };
    created.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(2, 25, factory);
  const a = await pool.acquire({ provider: 'workbuddy', model: '' });
  const b = await pool.acquire({ provider: 'workbuddy', model: '' });
  assert.notEqual(a, b);
  assert.equal(created.length, 2);
  pool.release(a);
  const c = await pool.acquire({ provider: 'workbuddy', model: '' });
  assert.equal(c, a);
  assert.equal(created.length, 2);
  pool.release(b);
  pool.release(c);
  pool.closeAll();
});

test('书籍 Session 按文档和任务角色隔离，同时复用同一 scope 的对话历史', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const created = [];
  const factory = (options) => {
    const session = {
      sent: [], closed: false, options,
      async send(message) { this.sent.push(message); },
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success' };
      },
      async interrupt() {},
      close() { this.closed = true; },
      async setModel() {},
    };
    created.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(4, 10, factory);
  const agent = { provider: 'workbuddy', model: 'test-model' };

  const firstBook = await pool.acquire(agent, 'book-a:translation');
  await pool.runPrompt(firstBook, 'book A chapter 1', 'a1', 5000);
  pool.release(firstBook);

  const nextChapter = await pool.acquire(agent, 'book-a:translation');
  assert.equal(nextChapter, firstBook, 'the same book/role should keep its Session');
  await pool.runPrompt(nextChapter, 'book A chapter 2', 'a2', 5000);
  pool.release(nextChapter);

  const secondBook = await pool.acquire(agent, 'book-b:translation');
  assert.notEqual(secondBook, firstBook, 'different books must have separate conversation history');
  await pool.runPrompt(secondBook, 'book B chapter 1', 'b1', 5000);
  pool.release(secondBook);

  const reviewer = await pool.acquire(agent, 'book-a:review', { type: 'object' });
  assert.notEqual(reviewer, firstBook, 'reviewer output must not share translation history');
  assert.equal(created[2].options.allowedTools.includes('StructuredOutput'), true);
  await pool.runPrompt(reviewer, 'review book A', 'review', 5000);
  pool.release(reviewer);

  const genericWeb = await pool.acquire(agent);
  assert.notEqual(genericWeb, firstBook, 'generic web translations must not reuse a book Session');
  await pool.runPrompt(genericWeb, 'web page translation', 'web', 5000);
  pool.release(genericWeb);

  assert.deepEqual(created[0].sent, ['book A chapter 1', 'book A chapter 2']);
  assert.deepEqual(created[1].sent, ['book B chapter 1']);
  assert.deepEqual(created[2].sent, ['review book A']);
  assert.deepEqual(created[3].sent, ['web page translation']);
  pool.closeAll();
});

test('会话池全忙时后来者排队等待', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const factory = () => ({
    async send() {}, async *stream() {}, async interrupt() {}, close() {}, async setModel() {},
  });
  const pool = new WorkbuddySessionPool(1, 25, factory);
  const a = await pool.acquire({ provider: 'workbuddy', model: '' });
  let resolved = false;
  const pending = pool.acquire({ provider: 'workbuddy', model: '' }).then((i) => { resolved = true; return i; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);
  pool.release(a);
  assert.equal(await pending, a);
  pool.closeAll();
});

test('会话池按轮数轮换与失败丢弃', async () => {
  const { WorkbuddySessionPool, buildTextSessionOptions } = await import('../src/agents/workbuddyPool.ts');
  // 复用 options 去掉按进程计的 maxTurns。
  assert.equal('maxTurns' in buildTextSessionOptions({ provider: 'workbuddy', model: 'm' }), false);
  let creates = 0;
  const sessions = [];
  const okMessages = () => [
    { type: 'assistant', message: { content: [{ type: 'text', text: '译文' }] } },
    { type: 'result', subtype: 'success', structured_output: { a: 1 } },
  ];
  const factory = () => {
    creates++;
    const session = {
      sent: [], closed: false,
      async send(m) { this.sent.push(m); },
      async *stream() { for (const m of okMessages()) yield m; },
      async interrupt() {}, close() { this.closed = true; }, async setModel() {},
    };
    sessions.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 2, factory);
  const i = await pool.acquire({ provider: 'workbuddy', model: '' });
  const first = await pool.runPrompt(i, 'p1', 'r1', 5000);
  assert.equal(first.text, '译文');
  assert.deepEqual(first.structuredOutput, { a: 1 });
  pool.release(i);
  const j = await pool.acquire({ provider: 'workbuddy', model: '' });
  assert.equal(j, i);
  await pool.runPrompt(j, 'p2', 'r1', 5000);
  pool.release(j);
  // 用满 2 轮即重建：旧会话已关闭，下次 acquire 新建。
  assert.equal(sessions[0].closed, true);
  await pool.acquire({ provider: 'workbuddy', model: '' });
  assert.equal(creates, 2);
  pool.closeAll();
});

test('结构化 Session 仅返回 tool_use 与 structured_output 时视为成功并保留会话', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const sessions = [];
  const schema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  };
  const factory = (options) => {
    const session = {
      closed: false, sent: [], options,
      async send(message) { this.sent.push(message); },
      async *stream() {
        // reproduce the SDK shape: no assistant text, only the StructuredOutput tool call.
        yield {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_structured_1',
              name: 'StructuredOutput',
              input: { value: 'ok' },
            }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: { value: 'ok' },
        };
      },
      async interrupt() {},
      close() { this.closed = true; },
      async setModel() {},
    };
    sessions.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: 'test-model' }, 'book-a:review', schema);
  const result = await pool.runPrompt(index, 'review this passage', 'structured-only', 5000);
  assert.equal(result.text, '');
  assert.deepEqual(result.structuredOutput, { value: 'ok' });
  assert.equal(sessions[0].closed, false, 'a valid native structured result must not poison the Session');
  assert.equal(pool.isFresh(index), false, 'successful structured turns count as Session uses');
  pool.release(index);

  const reused = await pool.acquire({ provider: 'workbuddy', model: 'test-model' }, 'book-a:review', schema);
  assert.equal(reused, index);
  assert.equal(sessions.length, 1, 'the healthy structured Session should be reused');
  pool.release(reused);
  pool.closeAll();
  assert.equal(sessions[0].closed, true, 'closeAll still releases the retained Session');
});

test('纯文本模式没有 text 和 structured_output 时仍丢弃空 Session', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const sessions = [];
  const factory = () => {
    const session = {
      closed: false,
      async send() {},
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SomeTool', input: {} }] } };
        yield { type: 'result', subtype: 'success' };
      },
      async interrupt() {},
      close() { this.closed = true; },
      async setModel() {},
    };
    sessions.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: 'test-model' });
  await assert.rejects(pool.runPrompt(index, 'translate', 'empty-text', 5000), /mode=text/);
  assert.equal(sessions[0].closed, true);
  pool.release(index);
  pool.closeAll();
});

test('结构化模式同时缺少 structured_output 和文本时仍报告失败', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const sessions = [];
  const factory = () => {
    const session = {
      closed: false,
      async send() {},
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } };
        yield { type: 'result', subtype: 'success' };
      },
      async interrupt() {},
      close() { this.closed = true; },
      async setModel() {},
    };
    sessions.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: 'test-model' }, 'book-a:review', { type: 'object' });
  await assert.rejects(pool.runPrompt(index, 'review', 'missing-structured-output', 5000), /mode=structured/);
  assert.equal(sessions[0].closed, true);
  pool.release(index);
  pool.closeAll();
});

test('会话池失败后丢弃会话并抛错', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const sessions = [];
  const factory = () => {
    const session = {
      closed: false,
      async send() {},
      async *stream() { throw new Error('boom'); },
      async interrupt() {}, close() { this.closed = true; }, async setModel() {},
    };
    sessions.push(session);
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 25, factory);
  const i = await pool.acquire({ provider: 'workbuddy', model: '' });
  await assert.rejects(pool.runPrompt(i, 'p', 'r', 5000), /Workbuddy Agent SDK 调用失败/);
  assert.equal(sessions[0].closed, true);
  pool.release(i);
  pool.closeAll();
});

test('会话池预热拉起全部空闲槽，失败不抛', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  let connects = 0;
  let creates = 0;
  const factory = () => {
    creates++;
    if (creates === 2) throw new Error('boot failed');
    return {
      async send() {}, async *stream() {}, async interrupt() {}, close() {},
      async setModel() {}, async connect() { connects++; },
    };
  };
  const pool = new WorkbuddySessionPool(3, 25, factory);
  // 占住一个槽：预热跳过忙槽。
  const busy = await pool.acquire({ provider: 'workbuddy', model: '' });
  await pool.prewarm({ provider: 'workbuddy', model: '' });
  assert.equal(connects, 1);
  pool.release(busy);
  await pool.prewarm({ provider: 'workbuddy', model: '' });
  pool.closeAll();
});

test('会话池模型不一致时热切换', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  let session;
  const factory = () => {
    session = {
      models: [],
      async send() {}, async *stream() {}, async interrupt() {}, close() {}, async setModel(m) { this.models.push(m); },
    };
    return session;
  };
  const pool = new WorkbuddySessionPool(1, 25, factory);
  const i = await pool.acquire({ provider: 'workbuddy', model: 'm1' });
  pool.release(i);
  await pool.acquire({ provider: 'workbuddy', model: 'm2' });
  assert.deepEqual(session.models, ['m2']);
  pool.closeAll();
});

test('separates system prompt and preserves JSON-only request', () => {
  const result = buildAgentPrompt([
    { role: 'system', content: 'Translate faithfully.' },
    { role: 'user', content: 'JSON: [{"id":"s0","text":"Hello"}]' },
  ], true);
  assert.equal(result.systemPrompt, 'Translate faithfully.');
  assert.match(result.prompt, /USER:/);
  assert.match(result.prompt, /严格合法的 JSON/);
  assert.match(result.prompt, /JSON:/);
});


/** Reserve an available loopback port for the child-process integration test. */
async function reserveLoopbackPort() {
  const socket = createTcpServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('starts without LOCAL_AGENT_TOKEN, allows extension requests, and blocks web-page origins', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vocal-saga-local-agent-test-'));
  const port = await reserveLoopbackPort();
  const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(serviceDir, 'src', 'start.ts');
  const env = {
    ...process.env,
    LOCAL_AGENT_HOST: '127.0.0.1',
    LOCAL_AGENT_PORT: String(port),
    LOCAL_AGENT_DATA_DIR: tempDir,
    LOCAL_AGENT_DATABASE: path.join(tempDir, 'test.sqlite'),
    LOCAL_AGENT_WORKDIR: path.join(tempDir, 'workspace'),
    LOCAL_AGENT_STORE_CONTENT: 'false',
    LOCAL_AGENT_ENV_FILE: path.join(tempDir, 'nonexistent.env'),
    // Malformed optional numeric settings must fall back to defaults rather than poisoning timers/SQLite.
    LOCAL_AGENT_TIMEOUT_MS: 'not-a-number',
    LOCAL_AGENT_MAX_HISTORY: 'not-a-number',
    // 集成测试不预热真 CLI 进程（慢且依赖登录态）；单测已覆盖 prewarm。
    LOCAL_AGENT_PREWARM: 'false',
  };
  env.LOCAL_AGENT_TOKEN = '';

  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: serviceDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2500))]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) assert.fail('Local service exited during startup: ' + logs);
    try {
      health = await fetch(baseUrl + '/health');
      if (health.ok) break;
    } catch {
      // The child may still be creating its SQLite database and binding the socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(health?.ok, 'service should start without a token; logs: ' + logs);

  const models = await fetch(baseUrl + '/v1/models');
  assert.equal(models.status, 200, 'tokenless local API requests should work');

  // A validation error should remain a 400 and still be recorded, even if optional
  // integer settings in the local .env are malformed.
  const invalidPayload = await fetch(baseUrl + '/api/translate/document/literary/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments: [] }),
  });
  assert.equal(invalidPayload.status, 400);
  const historyResponse = await fetch(baseUrl + '/api/history?limit=10');
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.rows.length, 1, 'request history should be saved without malformed LIMIT/OFFSET settings');


  // SQLite cache survives independent requests and is cleared by its dedicated endpoint.
  const cacheKey = 'test-translation-cache-v1';
  for (const ttlMs of [-1, 366 * 24 * 60 * 60 * 1000, 1.5, '60000']) {
    const invalidTtl = await fetch(baseUrl + '/api/cache/translation/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheKey: cacheKey + '-invalid', value: 'bad', ttlMs }),
    });
    assert.equal(invalidTtl.status, 400, 'invalid ttlMs must be rejected');
    const invalidTtlBody = await invalidTtl.json();
    assert.equal(invalidTtlBody.error, invalidTtlBody.message);
    assert.equal(invalidTtlBody.code, 'BAD_REQUEST');
  }
  const cacheSet = await fetch(baseUrl + '/api/cache/translation/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheKey, value: { b1: '你好', b2: '世界' }, ttlMs: 60000 }),
  });
  assert.equal(cacheSet.status, 200);
  const cacheGet = await fetch(baseUrl + '/api/cache/translation/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheKey }),
  });
  assert.deepEqual(await cacheGet.json(), { hit: true, value: { b1: '你好', b2: '世界' } });

  const cacheDelete = await fetch(baseUrl + '/api/cache/translation/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheKey }),
  });
  assert.equal(cacheDelete.status, 200);
  const deletedCacheGet = await fetch(baseUrl + '/api/cache/translation/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cacheKey }),
  });
  assert.deepEqual(await deletedCacheGet.json(), { hit: false, value: null });

  const batchPlan = await fetch(baseUrl + '/api/documents/batches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      budget: { maxChars: 5, maxSegments: 2, splitOnContextChange: true },
      segments: [
        { id: 'a', text: 'Hello', contextPath: 'chapter-1', page: 1 },
        { id: 'b', text: 'World', contextPath: 'chapter-1', page: 1 },
        { id: 'c', text: 'Next', contextPath: 'chapter-2', page: 2 },
      ],
    }),
  });
  assert.equal(batchPlan.status, 200);
  assert.deepEqual((await batchPlan.json()).batches, [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]]);

  const sessionPayload = { document: { id: 'doc-1' }, translations: [['s1', '你好']], checkpoint: 3 };
  const sessionSave = await fetch(baseUrl + '/api/documents/session/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'book-test', title: '测试书', format: 'epub', payload: sessionPayload }),
  });
  assert.equal(sessionSave.status, 200);
  const invalidSessionId = await fetch(baseUrl + '/api/documents/session/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: '   ' }),
  });
  assert.equal(invalidSessionId.status, 400);
  const invalidSessionBody = await invalidSessionId.json();
  assert.equal(invalidSessionBody.error, invalidSessionBody.message);
  assert.equal(invalidSessionBody.code, 'BAD_REQUEST');

  const sessionGet = await fetch(baseUrl + '/api/documents/session/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'book-test' }),
  });
  const sessionResult = await sessionGet.json();
  assert.equal(sessionResult.found, true);
  assert.deepEqual(sessionResult.session.payload, sessionPayload);

  const sessionSummaryResponse = await fetch(baseUrl + '/api/documents/session/summary', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'book-test' }),
  });
  assert.equal(sessionSummaryResponse.status, 200);
  const sessionSummary = await sessionSummaryResponse.json();
  assert.equal(sessionSummary.found, true);
  assert.equal(sessionSummary.session.title, '测试书');
  assert.equal(sessionSummary.session.format, 'epub');
  assert.equal(Object.hasOwn(sessionSummary.session, 'payload'), false, 'summary must not return the full document');


  const checkpointUpdate = await fetch(baseUrl + '/api/documents/session/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'book-test', title: '测试书', format: 'epub', mergeExisting: true,
      payload: { snapshot: { translations: [['s1', '你好'], ['s2', '世界']] } },
    }),
  });
  assert.equal(checkpointUpdate.status, 200);
  const checkpointReload = await fetch(baseUrl + '/api/documents/session/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'book-test' }),
  });
  const checkpointReloaded = await checkpointReload.json();
  assert.deepEqual(checkpointReloaded.session.payload.document, { id: 'doc-1' });
  assert.deepEqual(checkpointReloaded.session.payload.snapshot.translations, [['s1', '你好'], ['s2', '世界']]);

  // Later saves may omit the full translations array and send only the changed pairs.
  const deltaCheckpoint = await fetch(baseUrl + '/api/documents/session/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'book-test', title: '测试书', format: 'epub', mergeExisting: true,
      payload: {
        snapshot: { total: 4, done: 2 },
        translationDelta: [['s2', '更新后的译文'], ['s3', '再见']],
      },
    }),
  });
  assert.equal(deltaCheckpoint.status, 200);
  const deltaReloadResponse = await fetch(baseUrl + '/api/documents/session/get', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'book-test' }),
  });
  const deltaReload = await deltaReloadResponse.json();
  assert.deepEqual(deltaReload.session.payload.snapshot.translations, [
    ['s1', '你好'], ['s2', '更新后的译文'], ['s3', '再见'],
  ]);
  assert.equal(deltaReload.session.payload.snapshot.total, 4);
  assert.equal(deltaReload.session.payload.snapshot.done, 2);
  assert.equal(Object.hasOwn(deltaReload.session.payload, 'translationDelta'), false);

  // Project-route contract: malformed pagination is rejected before Store access.
  // The legacy string-valued `error` field stays intact; additive message/code fields
  // provide a migration path for clients without breaking the existing extension.
  const createdProjectResponse = await fetch(baseUrl + '/api/documents/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'API contract validation', format: 'txt', sourceFileName: 'api-contract.txt',
      allowDuplicate: true, segments: [{ id: 'p1', text: 'A sentence.', kind: 'paragraph' }],
    }),
  });
  assert.equal(createdProjectResponse.status, 201);
  const createdProject = await createdProjectResponse.json();
  const invalidPagination = await fetch(
    baseUrl + '/api/documents/projects/' + encodeURIComponent(createdProject.project.projectId) + '/segments?limit=1.5',
  );
  assert.equal(invalidPagination.status, 400);
  const invalidPaginationBody = await invalidPagination.json();
  assert.equal(typeof invalidPaginationBody.error, 'string', 'legacy error field must remain a string');
  assert.equal(invalidPaginationBody.message, invalidPaginationBody.error);
  assert.equal(invalidPaginationBody.code, 'BAD_REQUEST');

  const unknownEndpoint = await fetch(baseUrl + '/api/not-a-real-route');
  assert.equal(unknownEndpoint.status, 404);
  const unknownEndpointBody = await unknownEndpoint.json();
  assert.equal(unknownEndpointBody.code, 'NOT_FOUND');
  assert.equal(typeof unknownEndpointBody.message, 'string');
  assert.equal(unknownEndpointBody.error.message, unknownEndpointBody.message,
    'legacy object-valued error for unknown endpoints must remain compatible');

  const malformedJson = await fetch(baseUrl + '/api/cache/translation/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken":',
  });
  assert.equal(malformedJson.status, 400);
  const malformedJsonBody = await malformedJson.json();
  assert.equal(malformedJsonBody.code, 'BAD_REQUEST');
  assert.equal(malformedJsonBody.error, malformedJsonBody.message);

  const deniedOrigin = await fetch(baseUrl + '/v1/models', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://untrusted.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(deniedOrigin.status, 403, 'ordinary webpage origins must not access the local service');
  const deniedOriginBody = await deniedOrigin.json();
  assert.equal(deniedOriginBody.code, 'FORBIDDEN_ORIGIN');
  assert.equal(deniedOriginBody.error, deniedOriginBody.message);

  const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const allowedOrigin = await fetch(baseUrl + '/v1/models', {
    method: 'OPTIONS',
    headers: {
      Origin: extensionOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(allowedOrigin.status, 204);
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), extensionOrigin);
});

test('salvages quote-poisoned translation JSON via jsonrepair fallback', () => {
  // 线上实录：模型用 ASCII 双引号写中文对话引语，严格解析全灭。
  const poisoned = [
    '```json',
    '{',
    '  "translations": [',
    '    {"id": "s148", "translated_text": ""我没犯法——""},',
    '    {"id": "s149", "translated_text": ""那你的钱从哪来的？"格雷问""}',
    '  ]',
    '}',
    '```',
  ].join('\n');
  const salvaged = parseJsonValue(poisoned);
  assert.ok(salvaged && typeof salvaged === 'object' && !Array.isArray(salvaged));
  const items = salvaged.translations;
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 's148');
  assert.ok(items[0].translated_text.includes('我没犯法'));
  assert.equal(items[1].id, 's149');
});

test('salvages truncated translation JSON, keeping complete items', () => {
  const truncated = [
    '{"translations": [',
    '  {"id": "b33", "translated_text": "长段译文一。"},',
    '  {"id": "b34", "translated_text": "长段译文二。"},',
    '  {"id": "b35", "translated_text": "没写完的译文',
  ].join('\n');
  const salvaged = parseJsonValue(truncated);
  assert.ok(Array.isArray(salvaged) || (salvaged && Array.isArray(salvaged.translations)));
  const items = Array.isArray(salvaged) ? salvaged : salvaged.translations;
  assert.ok(items.length >= 2);
  assert.equal(items[0].id, 'b33');
});

test('pure prose with no JSON still returns null', () => {
  assert.equal(parseJsonValue('抱歉，我无法翻译这段内容。'), null);
  assert.equal(parseJsonValue(''), null);
});

// ── 每轮 token 消耗（费用口径） ─────────────────────────────

test('parseTurnUsage 解析 SDK result 的 usage 并拒绝无效计量', async () => {
  const { parseTurnUsage } = await import('../src/agents/usage.ts');
  const usage = parseTurnUsage({
    subtype: 'success',
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 },
    total_cost_usd: 0,
    duration_ms: 3658,
    num_turns: 3,
  });
  assert.deepEqual(usage, {
    inputTokens: 120, outputTokens: 45, cacheReadTokens: 3000, cacheCreationTokens: 500,
    totalCostUsd: null, durationMs: 3658, numTurns: 3,
  });
  // CodeBuddy 订阅 cost=0 → 不透出美元字段
  assert.equal(usage.totalCostUsd, null);

  // usage 全 0 或缺失 → 视为未计量
  assert.equal(parseTurnUsage({ subtype: 'success', usage: {} }), null);
  assert.equal(parseTurnUsage({ subtype: 'success' }), null);
  assert.equal(parseTurnUsage(null), null);

  // cost > 0 时透出
  const paid = parseTurnUsage({ usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.0123 });
  assert.equal(paid.totalCostUsd, 0.0123);
});

test('addTurnUsage 累加多轮 token 并合计轮数', async () => {
  const { addTurnUsage } = await import('../src/agents/usage.ts');
  const a = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 0, totalCostUsd: null, durationMs: 1000, numTurns: 1 };
  const b = { inputTokens: 430, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 400, totalCostUsd: 0.01, durationMs: 2000, numTurns: 2 };
  const total = addTurnUsage(a, b);
  assert.equal(total.inputTokens, 730);
  assert.equal(total.outputTokens, 70);
  assert.equal(total.cacheReadTokens, 200);
  assert.equal(total.cacheCreationTokens, 400);
  assert.equal(total.totalCostUsd, 0.01);
  assert.equal(total.numTurns, 3);
  assert.equal(total.durationMs, null, '合计不再表示单轮耗时');
  assert.deepEqual(addTurnUsage(null, null), null);
});

test('summarizeTurnUsage 输出 totalInputTokens/totalTokens 供事件与前端使用', async () => {
  const { summarizeTurnUsage } = await import('../src/agents/usage.ts');
  const summary = summarizeTurnUsage({
    inputTokens: 3620, outputTokens: 45, cacheReadTokens: 3000, cacheCreationTokens: 500,
    totalCostUsd: null, durationMs: 3658, numTurns: 1,
  });
  assert.equal(summary.totalInputTokens, 3620);
  assert.equal(summary.totalTokens, 3665);
  assert.equal(summary.durationMs, 3658);
  assert.equal('totalCostUsd' in summary, false, '订阅模式下没有美元费用，不透出该字段');
  assert.equal(summarizeTurnUsage(null), null);
});

test('会话池 runPrompt 透出 result.usage，空响应仍按原语义报错', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const factory = () => ({
    sent: [],
    async send(m) { this.sent.push(m); },
    async *stream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '译文' }] } };
      yield {
        type: 'result', subtype: 'success',
        usage: { input_tokens: 3287, output_tokens: 97, cache_read_input_tokens: 512, cache_creation_input_tokens: 2775 },
        total_cost_usd: 0, duration_ms: 3658, num_turns: 1,
      };
    },
    async interrupt() {}, close() {}, async setModel() {},
  });
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: '' });
  const outcome = await pool.runPrompt(index, 'hello', 'req-usage', 5000);
  assert.equal(outcome.text, '译文');
  assert.deepEqual(outcome.usage, {
    inputTokens: 3287, outputTokens: 97, cacheReadTokens: 512, cacheCreationTokens: 2775,
    totalCostUsd: null, durationMs: 3658, numTurns: 1,
  });
  pool.release(index);
  pool.closeAll();
});

test('会话卡住不返回时 runPrompt 按超时报错并丢弃会话', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  let closed = 0;
  const factory = () => ({
    async send() {},
    // CLI 卡死或事件流已断：stream() 既不产出也不结束。
    async *stream() { await new Promise(() => {}); },
    async interrupt() {},
    close() { closed += 1; },
    async setModel() {},
  });
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: '' });
  const started = Date.now();
  await assert.rejects(() => pool.runPrompt(index, 'x', 'req-timeout', 120), /调用超时/);
  assert.ok(Date.now() - started < 3000, '不能在超时后继续挂着');
  assert.equal(closed, 1, '超时后必须丢弃会话，下一轮换新 CLI 进程');
  pool.release(index);
  pool.closeAll();
});

test('全书预处理使用独立的长任务超时上限', async () => {
  const { ANALYSIS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } = await import('../src/config.ts');
  // 全书分析在单次调用里处理数十段样本并输出人物/实体/关系，耗时远超翻译批次；
  // 若这里退回到单次调用阈值，正常分析会被误判成超时。
  assert.ok(ANALYSIS_TIMEOUT_MS >= 300_000, '分析上限不能低于 5 分钟');
  assert.ok(ANALYSIS_TIMEOUT_MS > REQUEST_TIMEOUT_MS, '分析上限必须明显大于单次调用上限');
});

test('salvages quote-poisoned translation JSON via jsonrepair fallback', () => {
  // 线上实录：模型用 ASCII 双引号写中文对话引语，严格解析全灭。
  const poisoned = [
    '```json',
    '{',
    '  "translations": [',
    '    {"id": "s148", "translated_text": ""我没犯法——""},',
    '    {"id": "s149", "translated_text": ""那你的钱从哪来的？"格雷问""}',
    '  ]',
    '}',
    '```',
  ].join('\n');
  const salvaged = parseJsonValue(poisoned);
  assert.ok(salvaged && typeof salvaged === 'object' && !Array.isArray(salvaged));
  const items = salvaged.translations;
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 's148');
  assert.ok(items[0].translated_text.includes('我没犯法'));
  assert.equal(items[1].id, 's149');
});

test('salvages truncated translation JSON, keeping complete items', () => {
  const truncated = [
    '{"translations": [',
    '  {"id": "b33", "translated_text": "长段译文一。"},',
    '  {"id": "b34", "translated_text": "长段译文二。"},',
    '  {"id": "b35", "translated_text": "没写完的译文',
  ].join('\n');
  const salvaged = parseJsonValue(truncated);
  assert.ok(Array.isArray(salvaged) || (salvaged && Array.isArray(salvaged.translations)));
  const items = Array.isArray(salvaged) ? salvaged : salvaged.translations;
  assert.ok(items.length >= 2);
  assert.equal(items[0].id, 'b33');
});

test('pure prose with no JSON still returns null', () => {
  assert.equal(parseJsonValue('抱歉，我无法翻译这段内容。'), null);
  assert.equal(parseJsonValue(''), null);
});

// ── 每轮 token 消耗（费用口径） ─────────────────────────────

test('parseTurnUsage 解析 SDK result 的 usage 并拒绝无效计量', async () => {
  const { parseTurnUsage } = await import('../src/agents/usage.ts');
  const usage = parseTurnUsage({
    subtype: 'success',
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 },
    total_cost_usd: 0,
    duration_ms: 3658,
    num_turns: 3,
  });
  assert.deepEqual(usage, {
    inputTokens: 120, outputTokens: 45, cacheReadTokens: 3000, cacheCreationTokens: 500,
    totalCostUsd: null, durationMs: 3658, numTurns: 3,
  });
  // CodeBuddy 订阅 cost=0 → 不透出美元字段
  assert.equal(usage.totalCostUsd, null);

  // usage 全 0 或缺失 → 视为未计量
  assert.equal(parseTurnUsage({ subtype: 'success', usage: {} }), null);
  assert.equal(parseTurnUsage({ subtype: 'success' }), null);
  assert.equal(parseTurnUsage(null), null);

  // cost > 0 时透出
  const paid = parseTurnUsage({ usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.0123 });
  assert.equal(paid.totalCostUsd, 0.0123);
});

test('addTurnUsage 累加多轮 token 并合计轮数', async () => {
  const { addTurnUsage } = await import('../src/agents/usage.ts');
  const a = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 0, totalCostUsd: null, durationMs: 1000, numTurns: 1 };
  const b = { inputTokens: 430, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 400, totalCostUsd: 0.01, durationMs: 2000, numTurns: 2 };
  const total = addTurnUsage(a, b);
  assert.equal(total.inputTokens, 730);
  assert.equal(total.outputTokens, 70);
  assert.equal(total.cacheReadTokens, 200);
  assert.equal(total.cacheCreationTokens, 400);
  assert.equal(total.totalCostUsd, 0.01);
  assert.equal(total.numTurns, 3);
  assert.equal(total.durationMs, null, '合计不再表示单轮耗时');
  assert.deepEqual(addTurnUsage(null, null), null);
});

test('summarizeTurnUsage 输出 totalInputTokens/totalTokens 供事件与前端使用', async () => {
  const { summarizeTurnUsage } = await import('../src/agents/usage.ts');
  const summary = summarizeTurnUsage({
    inputTokens: 3620, outputTokens: 45, cacheReadTokens: 3000, cacheCreationTokens: 500,
    totalCostUsd: null, durationMs: 3658, numTurns: 1,
  });
  assert.equal(summary.totalInputTokens, 3620);
  assert.equal(summary.totalTokens, 3665);
  assert.equal(summary.durationMs, 3658);
  assert.equal('totalCostUsd' in summary, false, '订阅模式下没有美元费用，不透出该字段');
  assert.equal(summarizeTurnUsage(null), null);
});

test('会话池 runPrompt 透出 result.usage，空响应仍按原语义报错', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  const factory = () => ({
    sent: [],
    async send(m) { this.sent.push(m); },
    async *stream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '译文' }] } };
      yield {
        type: 'result', subtype: 'success',
        usage: { input_tokens: 3287, output_tokens: 97, cache_read_input_tokens: 512, cache_creation_input_tokens: 2775 },
        total_cost_usd: 0, duration_ms: 3658, num_turns: 1,
      };
    },
    async interrupt() {}, close() {}, async setModel() {},
  });
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: '' });
  const outcome = await pool.runPrompt(index, 'hello', 'req-usage', 5000);
  assert.equal(outcome.text, '译文');
  assert.deepEqual(outcome.usage, {
    inputTokens: 3287, outputTokens: 97, cacheReadTokens: 512, cacheCreationTokens: 2775,
    totalCostUsd: null, durationMs: 3658, numTurns: 1,
  });
  pool.release(index);
  pool.closeAll();
});

test('会话卡住不返回时 runPrompt 按超时报错并丢弃会话', async () => {
  const { WorkbuddySessionPool } = await import('../src/agents/workbuddyPool.ts');
  let closed = 0;
  const factory = () => ({
    async send() {},
    // CLI 卡死或事件流已断：stream() 既不产出也不结束。
    async *stream() { await new Promise(() => {}); },
    async interrupt() {},
    close() { closed += 1; },
    async setModel() {},
  });
  const pool = new WorkbuddySessionPool(1, 10, factory);
  const index = await pool.acquire({ provider: 'workbuddy', model: '' });
  const started = Date.now();
  await assert.rejects(() => pool.runPrompt(index, 'x', 'req-timeout', 120), /调用超时/);
  assert.ok(Date.now() - started < 3000, '不能在超时后继续挂着');
  assert.equal(closed, 1, '超时后必须丢弃会话，下一轮换新 CLI 进程');
  pool.release(index);
  pool.closeAll();
});

test('全书预处理使用独立的长任务超时上限', async () => {
  const { ANALYSIS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } = await import('../src/config.ts');
  // 全书分析在单次调用里处理数十段样本并输出人物/实体/关系，耗时远超翻译批次；
  // 若这里退回到单次调用阈值，正常分析会被误判成超时。
  assert.ok(ANALYSIS_TIMEOUT_MS >= 300_000, '分析上限不能低于 5 分钟');
  assert.ok(ANALYSIS_TIMEOUT_MS > REQUEST_TIMEOUT_MS, '分析上限必须明显大于单次调用上限');
});
