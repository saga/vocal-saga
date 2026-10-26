import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildContextGraphWorkflowPrompt,
  buildContextGraphWorkflowSchema,
  chooseContextGraphStrategy,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
} = await import('../src/documents/contextGraphWorkflow.ts');
const { ANALYSIS_SCHEMA, CONTEXT_GRAPH_ANALYSIS_VERSION } = await import('../src/documents/contextGraph.ts');
const { buildWorkbuddyOptions } = await import('../src/agents/workbuddy.ts');

test('all literary style dimensions are required by the single-call A schema', () => {
  const required = new Set(ANALYSIS_SCHEMA.required);
  for (const field of ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction', 'styleRules']) {
    assert.ok(required.has(field), field + ' must be required by the JSON schema');
  }
  for (const field of ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction']) {
    assert.equal(ANALYSIS_SCHEMA.properties[field].minLength, 1, field + ' must not be an empty string');
  }
  assert.equal(ANALYSIS_SCHEMA.properties.styleRules.minItems, 1);
  assert.match(CONTEXT_GRAPH_ANALYSIS_VERSION, /v8-canonical-name-preflight/);
});

test('B defines five isolated stages with stage-specific required schemas', () => {
  assert.equal(CONTEXT_GRAPH_WORKFLOW_STAGES.length, 5);
  const expected = {
    style: ['bookSummary', 'narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction', 'styleRules', 'styleAvoid', 'styleEvidence'],
    characters: ['characters'],
    entities: ['entities'],
    relationships: ['relationships'],
    chapters: ['chapterSummaries', 'openQuestions'],
  };
  for (const [stageId, fields] of Object.entries(expected)) {
    const schema = buildContextGraphWorkflowSchema(ANALYSIS_SCHEMA, stageId);
    assert.deepEqual(Object.keys(schema.properties), fields);
    assert.deepEqual(schema.required, fields);
  }
  assert.equal(CONTEXT_GRAPH_WORKFLOW_VERSION, 'context-graph-workflow-v1');
});

test('A/B assignment starts with B for legacy projects, alternates, and supports forcing a strategy', () => {
  assert.equal(chooseContextGraphStrategy('ab', null), 'B');
  assert.equal(chooseContextGraphStrategy('ab', 'A'), 'B');
  assert.equal(chooseContextGraphStrategy('ab', 'B'), 'A');
  assert.equal(chooseContextGraphStrategy('a', 'B'), 'A');
  assert.equal(chooseContextGraphStrategy('b', 'A'), 'B');
});

test('B style prompt asks for concrete values in every field instead of allowing silent blanks', () => {
  const prompt = buildContextGraphWorkflowPrompt('style', 'SAMPLED SOURCE TEXT', {}, false);
  assert.match(prompt, /必须分别填写/);
  assert.match(prompt, /styleRules 至少给出一条/);
  assert.doesNotMatch(prompt, /某维度证据不足时返回空字符串/);
});

test('entity preflight preserves fictional clan names instead of replacing historical analogues', () => {
  const prompt = buildContextGraphWorkflowPrompt('entities', 'SAMPLED SOURCE TEXT', {}, false);
  assert.match(prompt, /氏族|家族|宗族/);
  assert.match(prompt, /现实历史原型/);
  assert.match(prompt, /统一的规范 name/);
});

test('CodeBuddy workflow turns can resume a persisted SDK session', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const options = buildWorkbuddyOptions(
    { provider: 'workbuddy', model: 'test-model' },
    schema,
    undefined,
    { sessionId: 'persisted-session-123', persistSession: true },
  );
  assert.equal(options.persistSession, true);
  assert.equal(options.resume, 'persisted-session-123');
  assert.equal(options.model, 'test-model');
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema });
});
