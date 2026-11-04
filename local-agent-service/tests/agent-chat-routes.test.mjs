import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentChatRequest } from '../src/agentChatRoutes.ts';

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('standalone Agent Skill endpoint is independent and returns server-owned Skills', () => {
  const res = responseStub();
  const handled = handleAgentChatRequest(
    { method: 'GET', body: {} },
    res,
    new URL('http://localhost/api/agent/skills'),
  );
  assert.equal(handled, true);
  assert.ok(Array.isArray(res.body.skills));
  assert.ok(res.body.skills.every((skill) => typeof skill.id === 'string'));
});

test('standalone Agent capabilities expose provider and reasoning choices', () => {
  const res = responseStub();
  const handled = handleAgentChatRequest(
    { method: 'GET', body: {} },
    res,
    new URL('http://localhost/api/agent/capabilities'),
  );
  assert.equal(handled, true);
  assert.deepEqual(res.body.providers.map((provider) => provider.id), ['workbuddy', 'opencode']);
  assert.deepEqual(res.body.thinkingModes, ['disabled', 'adaptive', 'enabled']);
  assert.ok(res.body.efforts.includes('xhigh'));
});

test('unrelated routes are not captured by the standalone Agent handler', () => {
  const handled = handleAgentChatRequest(
    { method: 'GET', body: {} },
    responseStub(),
    new URL('http://localhost/api/documents/projects'),
  );
  assert.equal(handled, false);
});
