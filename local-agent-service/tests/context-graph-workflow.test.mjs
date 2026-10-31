import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildContextGraphWorkflowPrompt,
  buildContextGraphWorkflowSchema,
  chooseContextGraphStrategy,
  contextGraphStageWave,
  CONTEXT_GRAPH_STAGE_SESSION_PARENT,
  CONTEXT_GRAPH_STAGE_WAVES,
  CONTEXT_GRAPH_WORKFLOW_STAGES,
  CONTEXT_GRAPH_WORKFLOW_VERSION,
} = await import('../src/documents/contextGraphWorkflow.ts');
const { ANALYSIS_SCHEMA, CONTEXT_GRAPH_ANALYSIS_VERSION } = await import('../src/documents/contextGraph.ts');
const { isContextGraphReadyForTranslationRun } = await import('../src/documents/translationAgent.ts');
const { buildWorkbuddyOptions } = await import('../src/agents/workbuddy.ts');

test('literary style dimensions are optional observations, not translation prerequisites', () => {
  const required = new Set(ANALYSIS_SCHEMA.required);
  for (const field of ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction', 'styleRules']) {
    assert.ok(required.has(field), field + ' remains part of the structured analysis contract');
  }
  for (const field of ['narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue', 'styleDiction']) {
    assert.equal(ANALYSIS_SCHEMA.properties[field].minLength, undefined, field + ' may be empty when evidence is limited');
  }
  assert.equal(ANALYSIS_SCHEMA.properties.styleRules.minItems, undefined);
  assert.match(CONTEXT_GRAPH_ANALYSIS_VERSION, /context-graph-v10-default-adoption/);
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
  assert.equal(CONTEXT_GRAPH_WORKFLOW_VERSION, 'context-graph-workflow-v2-canonical-entity-quality');
});

test('strategy defaults to the checkpointed parallel workflow and A stays an explicit opt-in', () => {
  assert.equal(chooseContextGraphStrategy('ab', null), 'B');
  assert.equal(chooseContextGraphStrategy('ab', 'B'), 'B');
  assert.equal(chooseContextGraphStrategy('ab', 'A'), 'B');
  assert.equal(chooseContextGraphStrategy(undefined, null), 'B');
  assert.equal(chooseContextGraphStrategy('b', 'A'), 'B');
  assert.equal(chooseContextGraphStrategy('a', 'B'), 'A');
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
  assert.match(prompt, /现实原型不是源文别名/);
  assert.match(prompt, /一个 canonical name/);
  assert.match(prompt, /bookSpecificMeaning=true/);
});

test('stage waves cover every stage once and keep dependencies in earlier waves', () => {
  const flat = CONTEXT_GRAPH_STAGE_WAVES.flat();
  assert.equal(flat.length, CONTEXT_GRAPH_WORKFLOW_STAGES.length);
  assert.deepEqual([...flat].sort(), CONTEXT_GRAPH_WORKFLOW_STAGES.map((stage) => stage.id).sort());

  // relationships 依赖 characters + entities；chapters 依赖 style 的 bookSummary。
  const dependencies = {
    relationships: ['characters', 'entities'],
    chapters: ['style'],
  };
  for (const [stageId, required] of Object.entries(dependencies)) {
    for (const dependency of required) {
      assert.ok(
        contextGraphStageWave(dependency) < contextGraphStageWave(stageId),
        stageId + ' 必须在 ' + dependency + ' 之后的波次执行',
      );
    }
  }
  // 首波必须真的并行，否则优化没有意义。
  assert.ok(CONTEXT_GRAPH_STAGE_WAVES[0].length >= 3);
  assert.equal(contextGraphStageWave('unknown-stage'), -1);
});

test('parallel stages only reuse a session from an earlier wave', () => {
  for (const [stageId, parent] of Object.entries(CONTEXT_GRAPH_STAGE_SESSION_PARENT)) {
    assert.ok(contextGraphStageWave(parent) < contextGraphStageWave(stageId),
      stageId + ' 只能续聊更早波次的 ' + parent + ' Session');
    assert.notEqual(contextGraphStageWave(parent), contextGraphStageWave(stageId),
      stageId + ' 与 ' + parent + ' 不能在同一波次共用 Session');
  }
  // 首波三个阶段各自开新 Session（都要带全量样本），不能互相续聊。
  for (const stageId of CONTEXT_GRAPH_STAGE_WAVES[0]) {
    assert.equal(CONTEXT_GRAPH_STAGE_SESSION_PARENT[stageId], undefined);
  }
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


test('Chinese literary edits require explicit bilingual coverage and otherwise fall back to first-pass drafts', async () => {
  const { resolveBilingualVerifiedChineseEdits } = await import('../src/documents/translationAgent.ts');
  const initial = new Map([
    ['verified-unchanged', '初译甲。'],
    ['verified-corrected', '初译乙。'],
    ['missing', '初译丙。'],
    ['retry-failed', '初译丁。'],
    ['malformed', '初译戊。'],
  ]);
  const edits = new Map([
    ['verified-unchanged', '中文编辑甲。'],
    ['verified-corrected', '中文编辑乙。'],
    ['missing', '中文编辑丙。'],
    ['retry-failed', '中文编辑丁。'],
    ['malformed', '中文编辑戊。'],
  ]);
  const result = resolveBilingualVerifiedChineseEdits(initial, edits, {
    reviewedIds: ['verified-unchanged', 'verified-corrected'],
    missingIds: ['missing', 'retry-failed', 'malformed'],
    translations: {
      'verified-unchanged': '中文编辑甲。',
      'verified-corrected': '双语审校修订乙。',
      missing: '中文编辑丙。',
      'retry-failed': '中文编辑丁。',
      malformed: '',
    },
    retryError: 'missing-segment retry failed',
  });
  assert.deepEqual(result.candidates, [
    { segmentId: 'verified-corrected', text: '双语审校修订乙。' },
    { segmentId: 'verified-unchanged', text: '中文编辑甲。' },
  ]);
  assert.deepEqual(result.fallbacks, [
    { segmentId: 'missing', text: '初译丙。' },
    { segmentId: 'retry-failed', text: '初译丁。' },
    { segmentId: 'malformed', text: '初译戊。' },
  ]);

  const failed = resolveBilingualVerifiedChineseEdits(initial, edits, {
    reviewedIds: [], missingIds: [...edits.keys()], translations: {},
    retryError: 'bilingual reviewer unavailable',
  });
  assert.deepEqual(failed.candidates, []);
  assert.equal(failed.fallbacks.length, edits.size,
    'a failed bilingual review must restore every provisional Chinese edit to the first-pass draft');
});

test('source-grounded style review revisions become automatic Run candidates', async () => {
  const { selectVerifiedStyleReviewCandidates } = await import('../src/documents/translationAgent.ts');
  const drafts = new Map([['s1', '她推开了旧门。'], ['s2', '他走进房间。']]);
  const review = {
    translations: { s1: '她轻轻推开那扇旧门。', s2: '他走进房间。' },
    findings: [{ id: 's1', category: 'style', proposedTranslation: '她轻轻推开那扇旧门。' }],
  };
  assert.deepEqual(selectVerifiedStyleReviewCandidates(review, drafts, ['s1', 's2']), [
    { segmentId: 's1', text: '她轻轻推开那扇旧门。' },
  ]);
  assert.deepEqual(selectVerifiedStyleReviewCandidates({
    ...review,
    findings: [],
  }, drafts, ['s1', 's2']), [], 'a rewrite without a matching grounded style finding must not be applied');
  assert.deepEqual(selectVerifiedStyleReviewCandidates({
    ...review,
    editorialMode: 'chinese-monolingual',
  }, drafts, ['s1', 's2']), [], 'Chinese monolingual edits must wait for bilingual verification');
});

test('standalone review keeps model-default mappings weak and excludes rejected mappings', async () => {
  const { buildStandaloneReviewContextGraph } = await import('../src/documents/translationAgent.ts');
  const context = buildStandaloneReviewContextGraph({
    segments: [{ id: 'standalone-1', source: 'Alice met Bob and Carol. Dave watched them.' }],
    precedingSegments: [],
    memory: {
      entities: [
        { source: 'Alice', target: '艾丽丝', kind: 'person', aliases: [], reviewStatus: 'confirmed', confirmationSource: 'model-default', targetConfidence: 'candidate' },
        { source: 'Bob', target: '鲍勃', kind: 'person', aliases: [], reviewStatus: 'confirmed', confirmationSource: 'user-confirmed', targetConfidence: 'confirmed' },
        { source: 'Carol', target: '卡罗尔', kind: 'person', aliases: [], reviewStatus: 'confirmed', confirmationSource: 'model-default', targetConfidence: 'corroborated' },
        { source: 'Dave', target: '戴夫', kind: 'person', aliases: [], reviewStatus: 'rejected', confirmationSource: 'user-rejected' },
      ],
    },
  });
  const mappings = new Map(context.nameMappings.map((item) => [item.source, item]));
  assert.equal(mappings.get('Alice').sourceStatus, 'candidate');
  assert.equal(mappings.get('Alice').targetConfidence, 'candidate');
  assert.equal(mappings.get('Carol').sourceStatus, 'candidate',
    'standalone review has no immutable target-evidence ledger, so model-default cannot become a protected mapping');
  assert.equal(mappings.get('Bob').sourceStatus, 'confirmed-memory');
  assert.equal(mappings.has('Dave'), false);
});

test('literary translation requires a complete, current full-book preprocessing snapshot', () => {
  const run = {
    sourceRevisionId: 'source-1',
    sourceLang: 'en',
    targetLang: 'zh',
  };
  const ready = {
    status: 'completed',
    styleGuideReady: true,
    sourceRevisionId: 'source-1',
    progress: {
      strategy: 'B',
      sampleCount: 80,
      analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION,
      sourceLang: 'en',
      targetLang: 'zh',
      completedStages: ['style', 'characters', 'entities', 'relationships', 'chapters'],
    },
  };
  assert.equal(isContextGraphReadyForTranslationRun(ready, run), true);
  assert.equal(isContextGraphReadyForTranslationRun({ ...ready, styleGuideReady: false }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({
    ...ready,
    progress: { ...ready.progress, strategy: undefined },
  }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({
    ...ready,
    progress: { ...ready.progress, completedStages: ['style', 'characters', 'entities', 'relationships'] },
  }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({
    ...ready,
    sourceRevisionId: 'source-2',
  }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({
    ...ready,
    progress: { ...ready.progress, analysisVersion: 'old-version' },
  }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({
    ...ready,
    progress: { ...ready.progress, sampleCount: 0 },
  }, run), false);
});
