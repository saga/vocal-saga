import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-quality-audit-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');
const realNovelFixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/alice-adventures-real-novel.json', import.meta.url)), 'utf8',
));

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const {
  runProjectQualityAudit,
  createQualityRepairRun,
  createProjectQualityEvaluation,
  submitProjectQualityEvaluationReviews,
  getProjectQualityEvaluation,
} = await import('../src/documents/qualityAudit.ts');

test('book audit finds missing translations, confirmed-name drift and repeated-line variation; repair remains a candidate run', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Quality Audit Test',
    format: 'txt',
    sourceFileName: 'quality-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh', glossary: { document_terms: [
      { source: 'Captain Vale', target: '维尔船长' },
    ] } },
    segments: [
      { id: 'name-1', text: 'Mara Voss entered the archive before dawn.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'name-2', text: 'Captain Vale entered the archive before dawn.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'repeat-1', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'repeat-2', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 3' },
      { id: 'missing-1', text: 'The ledger remained beneath the floor.', kind: 'paragraph', contextPath: 'Chapter 4' },
    ],
  });
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Mara Voss',
      target: '玛拉·沃斯',
      aliases: ['Mara'],
      kind: 'character',
      reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
      description: 'Main character',
    }],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  store.saveManualEdit(project.projectId, 'name-1', '玛丽·沃斯在黎明前进入档案室。');
  store.saveManualEdit(project.projectId, 'name-2', '维尔在黎明前进入档案室。');
  store.saveManualEdit(project.projectId, 'repeat-1', '让西侧的灯一直亮着。');
  store.saveManualEdit(project.projectId, 'repeat-2', '西边的灯不要熄灭。');

  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  assert.equal(report.metrics.missingTranslationCount, 1);
  assert.ok(report.findings.some((item) => item.type === 'missing-translation' && item.segmentIds.includes('missing-1')));
  assert.ok(report.findings.some((item) => item.type === 'terminology-drift' && item.segmentIds.includes('name-1')));
  assert.ok(report.findings.some((item) => item.type === 'terminology-drift' && item.segmentIds.includes('name-2')),
    'book audit must include prompt glossary terms even when literary memory has no duplicate entry');
  assert.ok(report.findings.some((item) => item.type === 'repeated-expression-drift' &&
    item.segmentIds.includes('repeat-1') && item.segmentIds.includes('repeat-2')));

  const missingFinding = report.findings.find((item) => item.type === 'missing-translation');
  const termFinding = report.findings.find((item) => item.type === 'terminology-drift');
  const repair = createQualityRepairRun(project.projectId, report.auditId, [missingFinding.findingId, termFinding.findingId]);
  assert.deepEqual(new Set(repair.segmentIds), new Set(['missing-1', 'name-1']));
  assert.equal(repair.humanAcceptanceRequired, true);
  assert.equal(repair.run.scope.type, 'ids');
  assert.equal(repair.run.parentRunId, null);
  assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'name-1').acceptedTranslation,
    '玛丽·沃斯在黎明前进入档案室。', 'planning a repair must never overwrite an accepted manual translation');
  assert.equal(store.getRun(project.projectId, repair.run.runId).status, 'queued');

  store.saveCandidate(project.projectId, repair.run.runId, 'name-1', '模型候选：玛拉·沃斯在黎明前走进档案室。');
  store.saveCandidate(project.projectId, repair.run.runId, 'missing-1', '账本仍然藏在地板下面。');
  store.saveManualEdit(project.projectId, 'name-1', '人工再次确认：玛丽·沃斯在黎明前进入档案室。');
  store.finishRun(project.projectId, repair.run.runId);
  store.acceptCandidates(project.projectId, repair.run.runId);
  const afterRepairAcceptance = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(afterRepairAcceptance.find((item) => item.id === 'name-1').acceptedTranslation,
    '人工再次确认：玛丽·沃斯在黎明前进入档案室。',
    'an acceptance operation must not overwrite a newer manual edit with a repair candidate');
  assert.equal(afterRepairAcceptance.find((item) => item.id === 'missing-1').acceptedTranslation,
    '账本仍然藏在地板下面。');
});

test('book consistency audit catches a changed repeated dialogue after the first 16 occurrences', () => {
  const store = getDocumentProjectStore();
  const segments = Array.from({ length: 20 }, (_, index) => ({
    id: 'dialogue-' + String(index + 1).padStart(2, '0'),
    text: 'Speaker ' + (index + 1) + ' whispered: “Keep the western lamp burning.”',
    kind: 'dialogue',
    contextPath: 'Chapter ' + (Math.floor(index / 4) + 1),
  }));
  const project = store.createProject({
    title: 'Late Repeated Dialogue Test',
    format: 'txt',
    sourceFileName: 'late-repeat.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments,
  });
  segments.forEach((segment, index) => {
    store.saveManualEdit(project.projectId, segment.id,
      index === 19 ? '别让西边的灯熄灭。' : '让西边的灯一直亮着。');
  });

  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  const finding = report.findings.find((item) =>
    item.type === 'repeated-expression-drift' && item.occurrenceCount === 20);
  assert.ok(finding);
  assert.ok(finding.segmentIds.includes('dialogue-20'));
  assert.equal(finding.segmentIdsTruncated, false);

  const repair = createQualityRepairRun(project.projectId, report.auditId, [], ['dialogue-20']);
  assert.deepEqual(repair.segmentIds, ['dialogue-20'], 'explicit segment repair must not expand to all repeated occurrences');
});

test('book audit detects numeric drift and records malformed model outputs without changing accepted translations', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Numeric and Output Validation Audit Test',
    format: 'txt',
    sourceFileName: 'numeric-output-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'numeric-1', text: 'The vault opens in 7 minutes and requires 2 keys.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'plain-1', text: 'The door is heavy.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });

  store.saveManualEdit(project.projectId, 'numeric-1', '人工确认：保险库将在 7 分钟后开启，需要 2 把钥匙。');
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'numeric-1', '保险库将在 8 分钟后开启，需要 2 把钥匙。');
  store.saveCandidate(project.projectId, run.runId, 'plain-1', '这扇门很沉。');
  store.appendEvent(project.projectId, run.runId, 'batch.output.validation', {
    stage: 'translate',
    batchIndex: 0,
    requestId: 'test-output-shape',
    duplicateSegmentIds: ['numeric-1'],
    duplicateCount: 1,
    unexpectedOutputIds: ['not-in-input'],
    unexpectedCount: 1,
    malformedRowCount: 1,
  });
  store.finishRun(project.projectId, run.runId);

  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId, run.runId);
  const numeric = report.findings.find((item) => item.type === 'numeric-token-mismatch');
  assert.ok(numeric);
  assert.deepEqual(numeric.segmentIds, ['numeric-1']);
  assert.deepEqual(numeric.sourceNumbers, ['7', '2']);
  assert.deepEqual(numeric.translatedNumbers, ['8', '2']);
  assert.equal(numeric.repairable, true);

  const duplicate = report.findings.find((item) => item.type === 'duplicate-output-id');
  assert.ok(duplicate);
  assert.deepEqual(duplicate.segmentIds, ['numeric-1']);
  assert.equal(duplicate.duplicateCount, 1);

  const unexpected = report.findings.find((item) => item.type === 'unexpected-output-id');
  assert.ok(unexpected);
  assert.deepEqual(unexpected.unexpectedOutputIds, ['not-in-input']);
  assert.equal(unexpected.repairable, false);

  const malformed = report.findings.find((item) => item.type === 'malformed-output-row');
  assert.ok(malformed);
  assert.equal(malformed.malformedRowCount, 1);
  assert.equal(report.metrics.numericTokenMismatchCount, 1);

  const afterAudit = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(afterAudit.find((item) => item.id === 'numeric-1').acceptedTranslation,
    '人工确认：保险库将在 7 分钟后开启，需要 2 把钥匙。',
    'audit findings must not overwrite an accepted manual translation');
});

test('numeric audit compares written-out English and Chinese quantities without treating articles as numbers', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Written Quantity Audit Test',
    format: 'txt',
    sourceFileName: 'written-quantity-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'ten-correct', text: 'She was now only ten inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'ten-wrong', text: 'She was now only ten inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'article-a', text: 'A White Rabbit ran close by.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'one-side', text: 'One side will make you grow taller.', kind: 'paragraph', contextPath: 'Chapter 5' },
      { id: 'twenty-four-hours', text: 'The earth takes twenty-four hours to turn around.', kind: 'paragraph', contextPath: 'Chapter 6' },
      { id: 'digit-mismatch', text: 'The door is 4 inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'unit-mismatch', text: 'The table is three inches high.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveManualEdit(project.projectId, 'ten-correct', '她如今只有十英寸高。');
  store.saveManualEdit(project.projectId, 'ten-wrong', '她如今只有九英寸高。');
  store.saveManualEdit(project.projectId, 'article-a', '一只白兔从她身边跑过。');
  store.saveManualEdit(project.projectId, 'one-side', '一边会让你长高。');
  store.saveManualEdit(project.projectId, 'twenty-four-hours', '地球转一圈需要二十四小时。');
  store.saveManualEdit(project.projectId, 'digit-mismatch', '这扇门有五英寸高。');
  store.saveManualEdit(project.projectId, 'unit-mismatch', '这张桌子有三英尺高。');

  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  const numeric = report.findings.filter((item) => item.type === 'numeric-token-mismatch');
  assert.deepEqual(new Set(numeric.flatMap((item) => item.segmentIds)),
    new Set(['ten-wrong', 'digit-mismatch', 'unit-mismatch']));
  assert.ok(numeric.some((item) => item.segmentIds.includes('ten-wrong') &&
    item.sourceNumbers[0] === '10' && item.translatedNumbers[0] === '9'));
  assert.ok(numeric.some((item) => item.segmentIds.includes('digit-mismatch') &&
    item.sourceNumbers[0] === '4' && item.translatedNumbers[0] === '5'));
  assert.ok(numeric.some((item) => item.segmentIds.includes('unit-mismatch') &&
    item.sourceNumbers[0] === '3' && item.translatedNumbers[0] === '3' &&
    item.sourceUnits[0] === 'length:inch' && item.translatedUnits[0] === 'length:foot'),
    'equal number tokens must still warn when the translated measurement unit changes');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('article-a')),
    'Chinese classifier 一只 should not be misread as an explicit number for English article a');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('one-side')),
    'the explicitly numeric phrase one side should match 一边');
  assert.ok(!numeric.some((item) => item.segmentIds.includes('twenty-four-hours')),
    'written-out twenty-four must match 二十四');
});

test('M4 paired-run evaluation uses the real-novel corpus and withholds A/B mapping until blind ratings', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: realNovelFixture.title,
    format: 'txt',
    sourceFileName: 'alice-adventures-real-novel.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: realNovelFixture.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      kind: segment.kind,
      contextPath: segment.contextPath,
    })),
  });

  const createRunWithTranslations = (values) => {
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    values.forEach((item) => store.saveCandidate(project.projectId, run.runId, item.id, item.translated_text));
    store.finishRun(project.projectId, run.runId);
    return store.getRun(project.projectId, run.runId);
  };
  // The M0 control deliberately contains one missing item. The M4 API requires two completed
  // comparable runs, so use a non-empty wrong candidate for that one segment in this workflow test.
  const completeBefore = realNovelFixture.baselineTranslations.map((item) =>
    item.translated_text.trim() ? item : { ...item, translated_text: '我说不清。' });
  const before = createRunWithTranslations(completeBefore);
  const after = createRunWithTranslations(realNovelFixture.improvedExampleTranslations);
  assert.equal(before.sourceRevisionId, after.sourceRevisionId);
  assert.equal(before.status, 'awaiting_acceptance');
  assert.equal(after.status, 'awaiting_acceptance');

  const created = createProjectQualityEvaluation(project.projectId, before.runId, after.runId);
  assert.equal(created.comparable, true);
  assert.equal(created.blindReview.status, 'pending');
  assert.ok(created.blindReview.sampleCount > 0);
  assert.equal(created.beforeRunId, undefined);
  assert.equal(created.afterRunId, undefined);
  assert.equal(created.deterministic, undefined);
  assert.ok(created.blindReview.packet.every((item) => typeof item.source === 'string' &&
    typeof item.variantA === 'string' && typeof item.variantB === 'string'));

  const ratings = created.blindReview.packet.map((item) => ({
    segmentId: item.segmentId,
    dimension: 'overall',
    preference: 'A',
    confidence: 'medium',
  }));
  const submitted = submitProjectQualityEvaluationReviews(project.projectId, created.evaluationId, ratings);
  assert.equal(submitted.blindReview.status, 'completed');
  assert.equal(submitted.blindReview.result.beforeWins + submitted.blindReview.result.afterWins,
    ratings.length);
  const persisted = getProjectQualityEvaluation(project.projectId, created.evaluationId);
  assert.equal(persisted.blindReview.status, 'completed');
  assert.equal(persisted.beforeRunId, before.runId);
  assert.equal(persisted.afterRunId, after.runId);
  assert.equal(persisted.deterministic.before.segmentCount, realNovelFixture.segments.length);
});

test('paired-run evaluation withholds A/B mapping until every sampled segment has an overall blind rating', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Quality Evaluation Test',
    format: 'txt',
    sourceFileName: 'quality-eval.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'eval-1', text: 'Mara Voss entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'eval-2', text: 'Iven closed the heavy door.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'eval-3', text: 'Keep the western lamp burning.', kind: 'dialogue', contextPath: 'Chapter 2' },
    ],
  });
  const createRunWithTranslations = (values) => {
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    values.forEach(([id, translation]) => store.saveCandidate(project.projectId, run.runId, id, translation));
    store.finishRun(project.projectId, run.runId);
    return store.getRun(project.projectId, run.runId);
  };
  const before = createRunWithTranslations([
    ['eval-1', '玛丽·沃斯进入了档案室。'],
    ['eval-2', '伊文关上了沉重的门。'],
    ['eval-3', '让西边的灯一直亮着。'],
  ]);
  const after = createRunWithTranslations([
    ['eval-1', '玛拉·沃斯走进档案室。'],
    ['eval-2', '伊文关上那扇沉重的门。'],
    ['eval-3', '让西侧的灯一直亮着。'],
  ]);
  assert.equal(before.status, 'awaiting_acceptance');
  assert.equal(after.status, 'awaiting_acceptance');

  const created = createProjectQualityEvaluation(project.projectId, before.runId, after.runId);
  assert.equal(created.comparable, true);
  assert.equal(created.blindReview.status, 'pending');
  assert.ok(created.blindReview.packet.length > 0);
  assert.equal(created.beforeRunId, undefined);
  assert.equal(created.afterRunId, undefined);

  const ratings = created.blindReview.packet.map((item) => ({
    segmentId: item.segmentId,
    dimension: 'overall',
    preference: 'A',
    confidence: 'medium',
  }));
  const submitted = submitProjectQualityEvaluationReviews(project.projectId, created.evaluationId, ratings);
  assert.equal(submitted.blindReview.status, 'completed');
  assert.equal(submitted.blindReview.result.beforeWins + submitted.blindReview.result.afterWins,
    ratings.length);
  assert.ok(submitted.deterministic);
  assert.equal(submitted.deterministic.before.totalPipelineRequestCount, 0);
  assert.equal(submitted.deterministic.after.totalPipelineRequestCount, 0);
  assert.equal(submitted.deterministic.after.tokenAndBillingCostsAvailable, false);

  const persisted = getProjectQualityEvaluation(project.projectId, created.evaluationId);
  assert.equal(persisted.blindReview.status, 'completed');
  assert.equal(persisted.beforeRunId, before.runId);
  assert.equal(persisted.afterRunId, after.runId);

  const identical = createRunWithTranslations([
    ['eval-1', '玛丽·沃斯进入了档案室。'],
    ['eval-2', '伊文关上了沉重的门。'],
    ['eval-3', '让西边的灯一直亮着。'],
  ]);
  const noTextDelta = createProjectQualityEvaluation(project.projectId, before.runId, identical.runId);
  assert.equal(noTextDelta.blindReview.status, 'not_applicable');
  assert.equal(noTextDelta.blindReview.sampleCount, 0);
  assert.ok(noTextDelta.deterministic, 'metrics are disclosed when no differing translation can be blindly compared');
  assert.throws(
    () => submitProjectQualityEvaluationReviews(project.projectId, noTextDelta.evaluationId, [
      { segmentId: 'eval-1', dimension: 'overall', preference: 'A' },
    ]),
    /不处于待盲评状态/,
  );
});



test('book audit reports conflicting context-delta name proposals across source-ordered batches', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Context Delta Conflict Audit',
    format: 'txt',
    sourceFileName: 'context-delta-conflict.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-early', text: 'The King looked at Max and remained silent.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-later', text: 'The King addressed Max before leaving.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'king-early', '国王看了马克斯一眼，没有说话。');
  store.saveCandidate(project.projectId, run.runId, 'king-later', '大王离开前对马克斯说了话。');
  store.saveTranslationContextDelta(project.projectId, run.runId, 1, 'king-early', ['king-early'], {
    entityCandidates: [{
      localId: 'king-a', canonicalSource: 'The King', aliases: ['King'], kind: 'character_epithet',
      targetProposal: '国王', evidence: [{ segmentId: 'king-early', sourceQuote: 'The King looked at Max and remained silent.' }],
    }],
    entityMentions: [], relationshipDeltas: [], openQuestions: [], conflicts: [],
  }, { entityCandidateCount: 1 });
  store.saveTranslationContextDelta(project.projectId, run.runId, 2, 'king-later', ['king-later'], {
    entityCandidates: [{
      // The later batch uses the short form as canonical but explicitly links it to The King.
      localId: 'king-b', canonicalSource: 'King', aliases: ['The King'], kind: 'nickname',
      targetProposal: '大王', evidence: [{ segmentId: 'king-later', sourceQuote: 'The King addressed Max before leaving.' }],
    }],
    entityMentions: [], relationshipDeltas: [], openQuestions: [], conflicts: [],
  }, { entityCandidateCount: 1 });
  store.finishRun(project.projectId, run.runId);

  const report = runProjectQualityAudit(project.projectId, run.runId);
  const finding = report.findings.find((item) => item.type === 'context-delta-conflict');
  assert.ok(finding, 'conflicting translated-name proposals should be visible in the whole-book audit');
  assert.deepEqual(new Set(finding.segmentIds), new Set(['king-early', 'king-later']));
  assert.equal(finding.repairable, false);
  assert.equal(report.metrics.contextDeltaConflictCount, 1);
});


test('repeated quoted dialogue compares the translated quotation, not surrounding paragraph narration', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Quoted Span Alignment Test',
    format: 'txt',
    sourceFileName: 'quoted-span-alignment.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'quote-1', text: 'Mara said softly: “Keep the western lamp burning.” Then she entered the archive.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'quote-2', text: 'Iven whispered: “Keep the western lamp burning.” He locked the gate behind him.', kind: 'paragraph', contextPath: 'Chapter 2' },
      { id: 'quote-3', text: '“Keep the western lamp burning.”', kind: 'dialogue', contextPath: 'Chapter 5' },
    ],
  });
  store.saveManualEdit(project.projectId, 'quote-1', '玛拉轻声说道：“让西边的灯一直亮着。”随后她走进档案室。');
  store.saveManualEdit(project.projectId, 'quote-2', '伊文低声说：“让西边的灯一直亮着。”他随后锁上了身后的门。');
  store.saveManualEdit(project.projectId, 'quote-3', '“让西边的灯一直亮着。”');
  ensureTestContextGraph(store, project);

  const aligned = runProjectQualityAudit(project.projectId);
  assert.equal(aligned.findings.some((item) =>
    item.type === 'repeated-expression-drift' && String(item.sourceExcerpt || '').replace(/[.!?。！？]+$/u, '') === 'Keep the western lamp burning'), false,
    'different surrounding narration must not look like a quotation translation inconsistency');

  store.saveManualEdit(project.projectId, 'quote-2', '伊文低声说：“别让西边的灯熄灭。”他随后锁上了身后的门。');
  const drift = runProjectQualityAudit(project.projectId);
  const finding = drift.findings.find((item) =>
    item.type === 'repeated-expression-drift' && String(item.sourceExcerpt || '').replace(/[.!?。！？]+$/u, '') === 'Keep the western lamp burning' &&
    item.alignmentMethod === 'quoted-span');
  assert.ok(finding, 'a genuine quoted-span translation change must still be detected');
  assert.equal(finding.occurrenceCount, 3);
  assert.deepEqual(new Set(finding.segmentIds), new Set(['quote-1', 'quote-2', 'quote-3']));
});

test('book audit detects surface-rendering drift from validated entity_mentions', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Entity Mention Drift Audit',
    format: 'txt',
    sourceFileName: 'entity-mention-drift.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'king-mention-1', text: 'The King looked at Max and remained silent.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'king-mention-2', text: 'The King addressed Max before leaving.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ],
  });
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'king-mention-1', '国王看了马克斯一眼，没有说话。');
  store.saveCandidate(project.projectId, run.runId, 'king-mention-2', '大王离开前对马克斯说了话。');
  store.saveTranslationContextDelta(project.projectId, run.runId, 1, 'king-mention-1', ['king-mention-1'], {
    entityCandidates: [{
      localId: 'king-a', canonicalSource: 'The King', aliases: ['King'], kind: 'character_epithet',
      targetProposal: '国王', evidence: [{ segmentId: 'king-mention-1', sourceQuote: 'The King looked at Max and remained silent.' }],
    }],
    entityMentions: [{
      segmentId: 'king-mention-1', sourceQuote: 'The King', entityRef: 'king-a', targetSurface: '国王',
    }],
    relationshipDeltas: [], openQuestions: [], conflicts: [],
  }, { entityCandidateCount: 1, entityMentionCount: 1 });
  store.saveTranslationContextDelta(project.projectId, run.runId, 2, 'king-mention-2', ['king-mention-2'], {
    entityCandidates: [{
      localId: 'king-b', canonicalSource: 'King', aliases: ['The King'], kind: 'nickname',
      targetProposal: '国王', evidence: [{ segmentId: 'king-mention-2', sourceQuote: 'The King addressed Max before leaving.' }],
    }],
    entityMentions: [{
      segmentId: 'king-mention-2', sourceQuote: 'The King', entityRef: 'king-b', targetSurface: '大王',
    }],
    relationshipDeltas: [], openQuestions: [], conflicts: [],
  }, { entityCandidateCount: 1, entityMentionCount: 1 });
  store.finishRun(project.projectId, run.runId);

  const report = runProjectQualityAudit(project.projectId, run.runId);
  const finding = report.findings.find((item) => item.type === 'entity-mention-drift');
  assert.ok(finding);
  assert.deepEqual(new Set(finding.segmentIds), new Set(['king-mention-1', 'king-mention-2']));
  assert.equal(report.metrics.entityMentionDriftCount, 1);
  assert.equal(finding.repairable, true);
});


test('book audit includes confirmed character-profile names and flags likely English residue without applying changes', () => {
  const store = getDocumentProjectStore();
  const segments = [
    { id: 'yabu-wrong', text: 'Yabu appeared at dawn.', kind: 'paragraph', contextPath: 'Chapter 1' },
    { id: 'yabu-correct', text: 'Yabu returned after the storm.', kind: 'paragraph', contextPath: 'Chapter 2' },
    { id: 'title-only', text: 'The lord watched the gate.', kind: 'paragraph', contextPath: 'Chapter 2' },
    { id: 'english-again', text: 'He tried once more.', kind: 'paragraph', contextPath: 'Chapter 3' },
    { id: 'english-sentence', text: 'The old man opened the gate slowly.', kind: 'paragraph', contextPath: 'Chapter 3' },
  ];
  const project = store.createProject({
    title: 'Character Voice Name Audit',
    format: 'txt',
    sourceFileName: 'character-voice-name-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments,
  });
  for (const segment of segments) {
    const translated = {
      'yabu-wrong': '矢部清晨出现。',
      'yabu-correct': '暴风雨后，薮回来了。',
      'title-only': '那位大人看着大门。',
      'english-again': '他又试了一次 again。',
      'english-sentence': 'The old man opened the gate slowly.',
    }[segment.id];
    store.saveManualEdit(project.projectId, segment.id, translated);
  }
  store.saveLiteraryMemory(project.projectId, {
    entities: [],
    relationships: [],
    styleGuide: {},
    styleGuideStatus: 'candidate',
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char-yabu',
      canonicalSourceName: 'Yabu',
      targetName: '薮',
      aliases: ['Yabu-san', 'Lord'],
      status: 'confirmed', confirmationSource: 'user-confirmed',
      useForTranslation: true,
      voiceCore: {},
      evidence: [{
        segmentId: 'yabu-wrong',
        sourceQuote: 'Yabu appeared at dawn.',
        dimension: 'register',
        observation: '本段直接以人物姓名指代。',
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  assert.ok(report.findings.some((item) =>
    item.type === 'terminology-drift' && item.segmentIds.includes('yabu-wrong') && item.entity?.target === '薮'),
  'confirmed names saved only in character/voice profiles must be audited');
  assert.equal(report.findings.some((item) =>
    item.type === 'terminology-drift' && item.segmentIds.includes('yabu-correct')), false,
  'the confirmed target already present in the translation should not be flagged');
  assert.equal(report.findings.some((item) =>
    item.type === 'terminology-drift' && item.segmentIds.includes('title-only')), false,
  'generic title aliases such as Lord must not trigger unrelated name drift');
  assert.ok(report.findings.some((item) =>
    item.type === 'english-residue' && item.segmentIds.includes('english-again')),
  'a common English word left in a Chinese translation should be surfaced');
  assert.ok(report.findings.some((item) =>
    item.type === 'english-residue' && item.segmentIds.includes('english-sentence')),
  'a largely untranslated English sentence should be surfaced');
  assert.equal(report.metrics.englishResidueCount, 2);
  assert.equal(store.getSegments(project.projectId, { limit: 10 })
    .find((item) => item.id === 'yabu-wrong').acceptedTranslation, '矢部清晨出现。',
    'audit findings must not rewrite an accepted translation');
});

test('book audit reports conflicting confirmed entity and character-profile translations instead of choosing one', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Canonical Name Conflict Audit',
    format: 'txt',
    sourceFileName: 'canonical-name-conflict-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'conflict-yabu', text: 'Yabu returned before sunset.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveManualEdit(project.projectId, 'conflict-yabu', '矢部在日落前回来了。');
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Yabu',
      target: '矢部',
      aliases: [],
      kind: 'person',
      reviewStatus: 'confirmed', confirmationSource: 'user-confirmed',
      evidence: 'Yabu returned before sunset.',
    }],
    relationships: [],
    styleGuide: {},
    styleGuideStatus: 'candidate',
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [{
      characterId: 'char-yabu-conflict',
      canonicalSourceName: 'Yabu',
      targetName: '薮',
      aliases: [],
      status: 'confirmed',
      useForTranslation: true,
      voiceCore: {},
      evidence: [{
        segmentId: 'conflict-yabu',
        sourceQuote: 'Yabu returned before sunset.',
        dimension: 'register',
        observation: '人物被原文姓名指代。',
      }],
      openQuestions: [],
    }],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  const conflict = report.findings.find((item) =>
    item.type === 'canonical-name-mapping-conflict' && item.segmentIds.includes('conflict-yabu'));
  assert.ok(conflict, 'contradictory confirmed targets must be reported explicitly');
  assert.deepEqual(new Set(conflict.entity.targets), new Set(['矢部', '薮']));
  assert.equal(conflict.repairable, false, 'the audit must not guess which stored mapping is authoritative');
  assert.equal(report.findings.some((item) =>
    item.type === 'terminology-drift' && item.segmentIds.includes('conflict-yabu')), false,
  'a stored mapping conflict should not be mislabeled as a translation defect');
});


test('quality audit blocks queued runs but allows auditing terminal partial runs', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Partial Run Audit Test',
    format: 'txt',
    sourceFileName: 'partial-run-audit.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'partial-audit-segment', text: 'The old gate remained closed.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveManualEdit(project.projectId, 'partial-audit-segment', '旧门一直关着。');
  ensureTestContextGraph(store, project);
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });

  assert.throws(
    () => runProjectQualityAudit(project.projectId),
    (error) => error?.status === 409 && /运行中的或已暂停/u.test(error.message),
    'a queued run for this project must block an ordinary accepted-text audit',
  );

  const context = store.getProjectContext(project.projectId);
  context.db.prepare(
    "UPDATE translation_runs SET status = 'partial', finished_at = ? WHERE run_id = ?",
  ).run(new Date().toISOString(), run.runId);

  const report = runProjectQualityAudit(project.projectId);
  assert.equal(report.metrics.missingTranslationCount, 0,
    'the previously accepted translation remains visible when a partial Run is audited');
});

test('quality repair rejects an audit finding after its accepted translation has been manually corrected', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Stale Quality Audit Snapshot Test',
    format: 'txt',
    sourceFileName: 'stale-quality-audit-snapshot.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'stale-yabu', text: 'Yabu spoke again before sunset.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveLiteraryMemory(project.projectId, {
    entities: [{
      source: 'Yabu',
      target: '薮',
      aliases: [],
      kind: 'person',
      reviewStatus: 'confirmed',
      evidence: 'Yabu spoke again before sunset.',
    }],
    relationships: [],
    styleGuide: {},
    chapterSummaries: [],
    recentExamples: [],
    characterVoices: [],
    relationshipVoiceRules: [],
    voiceAnchors: [],
  });
  store.saveManualEdit(project.projectId, 'stale-yabu', '矢部在日落前 again 说了话。');
  ensureTestContextGraph(store, project);

  const report = runProjectQualityAudit(project.projectId);
  const staleFinding = report.findings.find((item) =>
    item.type === 'terminology-drift' && item.segmentIds.includes('stale-yabu'));
  assert.ok(staleFinding, 'the deliberately inconsistent accepted translation should be audited');
  assert.ok(report.translationSnapshotHash);
  assert.ok(report.acceptedTranslationSnapshotHash);
  assert.equal(Object.hasOwn(report, 'acceptedTranslationHashes'), false,
    'the report should not store a per-segment hash map that grows with the book size');

  store.saveManualEdit(project.projectId, 'stale-yabu', '薮在日落前又说了话。');
  assert.throws(
    () => createQualityRepairRun(project.projectId, report.auditId, [staleFinding.findingId]),
    (error) => error?.status === 409 && /审计后已有译文被修改/u.test(error.message),
    'an old finding must not create a repair Run after a user has already corrected the translation',
  );
});

test('automatic quality repair is marked as bounded service automation and linked to its parent run', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Automatic Quality Repair Test',
    format: 'txt',
    sourceFileName: 'automatic-quality-repair.txt',
    prompt: { translationMode: 'technical', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'auto-present', text: 'The door was open.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'auto-missing', text: 'The letter remained on the desk.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  store.saveManualEdit(project.projectId, 'auto-present', '门开着。');
  ensureTestContextGraph(store, project);
  const parent = store.createRun(project.projectId, { scope: { type: 'ids', ids: [] } });
  const report = runProjectQualityAudit(project.projectId);
  const missing = report.findings.find((item) => item.type === 'missing-translation' &&
    item.segmentIds.includes('auto-missing'));
  assert.ok(missing);

  const repair = createQualityRepairRun(
    project.projectId,
    report.auditId,
    [missing.findingId],
    [],
    { automatic: true, parentRunId: parent.runId },
  );
  assert.equal(repair.humanAcceptanceRequired, false);
  assert.equal(repair.automatic, true);
  assert.equal(repair.run.parentRunId, parent.runId);
  assert.equal(repair.run.scope.automation.kind, 'quality-audit-repair');
  assert.equal(repair.run.scope.automation.pass, 1);
  assert.deepEqual(repair.segmentIds, ['auto-missing']);
});



test('numeric audit recognizes French German Italian and Japanese source quantities', () => {
  const store = getDocumentProjectStore();
  const cases = [
    { sourceLang: 'fr', source: 'Il marcha trois mètres.', translation: '他走了三米。' },
    { sourceLang: 'de', source: 'Er ging drei Meter.', translation: '他走了三米。' },
    { sourceLang: 'it', source: 'Camminò tre metri.', translation: '他走了三米。' },
    { sourceLang: 'ja', source: '三メートル歩いた。', translation: '走了三米。' },
    { sourceLang: 'pt', source: 'Ele caminhou 3 metros.', translation: '他走了三米。' },
  ];
  for (const [index, item] of cases.entries()) {
    const project = store.createProject({
      title: 'Localized Numeric Audit ' + item.sourceLang,
      format: 'txt',
      sourceFileName: 'localized-numeric-' + item.sourceLang + '.txt',
      prompt: { translationMode: 'literary', sourceLang: item.sourceLang, targetLang: 'zh' },
      segments: [{ id: 'localized-number-' + index, text: item.source, kind: 'paragraph', contextPath: 'Chapter 1' }],
    });
    store.saveManualEdit(project.projectId, 'localized-number-' + index, item.translation);
    ensureTestContextGraph(store, project);
    const report = runProjectQualityAudit(project.projectId);
    assert.equal(report.findings.some((finding) =>
      finding.type === 'numeric-token-mismatch' && finding.segmentIds.includes('localized-number-' + index)),
    false, item.sourceLang + ' correct quantity should not be reported as a mismatch');
  }

  const incorrect = store.createProject({
    title: 'French Numeric Mismatch',
    format: 'txt',
    sourceFileName: 'french-numeric-mismatch.txt',
    prompt: { translationMode: 'literary', sourceLang: 'fr', targetLang: 'zh' },
    segments: [{ id: 'fr-incorrect-number', text: 'Il marcha trois mètres.', kind: 'paragraph', contextPath: 'Chapter 1' }],
  });
  store.saveManualEdit(incorrect.projectId, 'fr-incorrect-number', '他走了四米。');
  ensureTestContextGraph(store, incorrect);
  const incorrectReport = runProjectQualityAudit(incorrect.projectId);
  assert.ok(incorrectReport.findings.some((finding) =>
    finding.type === 'numeric-token-mismatch' && finding.segmentIds.includes('fr-incorrect-number')),
  'a recognized source number must still detect a real translation mismatch');
});

test('source-language residue audit detects accented French German Italian and Japanese fragments', () => {
  const store = getDocumentProjectStore();
  const cases = [
    { sourceLang: 'fr', source: 'Il partit sans répondre.', translation: '他转身离开了，mais il reviendra déjà。', residue: 'déjà' },
    { sourceLang: 'de', source: 'Er ging nach Hause.', translation: '他看起来 schön。', residue: 'schön' },
    { sourceLang: 'it', source: 'Lui era stanco.', translation: '他又说了 allora。', residue: 'allora' },
    { sourceLang: 'ja', source: '彼はすぐに戻った。', translation: '他没有回答，こんにちは。', residue: 'こんにちは' },
  ];
  for (const [index, item] of cases.entries()) {
    const id = 'residue-' + item.sourceLang;
    const project = store.createProject({
      title: 'Localized Residue Audit ' + item.sourceLang,
      format: 'txt',
      sourceFileName: 'localized-residue-' + item.sourceLang + '.txt',
      prompt: { translationMode: 'literary', sourceLang: item.sourceLang, targetLang: 'zh' },
      segments: [{ id, text: item.source, kind: 'paragraph', contextPath: 'Chapter 1' }],
    });
    store.saveManualEdit(project.projectId, id, item.translation);
    ensureTestContextGraph(store, project);
    const report = runProjectQualityAudit(project.projectId);
    assert.ok(report.findings.some((finding) =>
      finding.type === 'english-residue' && finding.segmentIds.includes(id) &&
      finding.residueExamples.includes(item.residue)),
    item.sourceLang + ' source-language residue should be surfaced for manual review');
  }
});



test('short French and Italian greetings are flagged as possible source-language residue', () => {
  const store = getDocumentProjectStore();
  const cases = [
    { sourceLang: 'fr', source: 'Il partit sans un mot.', translation: '他转身离开了，Merci beaucoup。', residue: 'Merci' },
    { sourceLang: 'it', source: 'Lui entrò nella stanza.', translation: '他走进房间，说了 Buongiorno。', residue: 'Buongiorno' },
  ];
  for (const item of cases) {
    const id = 'short-residue-' + item.sourceLang;
    const project = store.createProject({
      title: 'Short Residue Audit ' + item.sourceLang, format: 'txt', sourceFileName: 'short-residue-' + item.sourceLang + '.txt',
      prompt: { translationMode: 'literary', sourceLang: item.sourceLang, targetLang: 'zh' },
      segments: [{ id, text: item.source, kind: 'paragraph', contextPath: 'Chapter 1' }],
    });
    store.saveManualEdit(project.projectId, id, item.translation);
    ensureTestContextGraph(store, project);
    const report = runProjectQualityAudit(project.projectId);
    assert.ok(report.findings.some((finding) => finding.type === 'english-residue' && finding.segmentIds.includes(id) && finding.residueExamples.includes(item.residue)), item.sourceLang + ' short greeting residue should be surfaced for review');
  }
});

test('Spanish numeric audit handles written numbers, inflections, regional aliases and auto detection', () => {
  const store = getDocumentProjectStore();
  const cases = [
    { sourceLang: 'es', source: 'Él caminó tres metros.', translation: '他走了三米。' },
    { sourceLang: 'es-ES', source: 'Recorrió treinta y dos kilómetros.', translation: '他走了三十二公里。' },
    { sourceLang: 'es', source: 'La cuerda mide 1,5 metros.', translation: '这根绳子长1.5米。' },
    { sourceLang: 'es', source: 'La montaña tiene 1.250 metros de altura.', translation: '这座山高1,250米。' },
    { sourceLang: 'español', source: 'Tenía veintiún años.', translation: '他二十一岁。' },
    { sourceLang: 'auto', source: '¿Caminó tres metros antes de regresar?', translation: '他回来前走了三米。' },
  ];
  for (const [index, item] of cases.entries()) {
    const id = 'spanish-number-' + index;
    const project = store.createProject({
      title: 'Spanish Numeric Audit ' + item.sourceLang,
      format: 'txt',
      sourceFileName: 'spanish-numeric-' + index + '.txt',
      prompt: { translationMode: 'literary', sourceLang: item.sourceLang, targetLang: 'zh' },
      segments: [{ id, text: item.source, kind: 'paragraph', contextPath: 'Capítulo 1' }],
    });
    store.saveManualEdit(project.projectId, id, item.translation);
    ensureTestContextGraph(store, project);
    const report = runProjectQualityAudit(project.projectId);
    assert.equal(report.findings.some((finding) =>
      finding.type === 'numeric-token-mismatch' && finding.segmentIds.includes(id)),
    false, item.sourceLang + ' correct Spanish quantity should not be reported as a mismatch');
  }

  const incorrect = store.createProject({
    title: 'Spanish Numeric Mismatch',
    format: 'txt',
    sourceFileName: 'spanish-numeric-mismatch.txt',
    prompt: { translationMode: 'literary', sourceLang: 'es', targetLang: 'zh' },
    segments: [{ id: 'es-incorrect-number', text: 'La puerta mide tres metros.', kind: 'paragraph', contextPath: 'Capítulo 1' }],
  });
  store.saveManualEdit(incorrect.projectId, 'es-incorrect-number', '这扇门高四米。');
  ensureTestContextGraph(store, incorrect);
  const incorrectReport = runProjectQualityAudit(incorrect.projectId);
  assert.ok(incorrectReport.findings.some((finding) =>
    finding.type === 'numeric-token-mismatch' && finding.segmentIds.includes('es-incorrect-number')),
  'a real Spanish number mismatch must remain visible to the audit');
});

test('Spanish source-language residue audit flags short untranslated phrases in Chinese output', () => {
  const store = getDocumentProjectStore();
  const cases = [
    { sourceLang: 'es', source: 'El hombre sonrió antes de salir.', translation: '他离开前仍然说了 todavía。', residue: 'todavía' },
    { sourceLang: 'es-MX', source: 'La mujer abrió la puerta.', translation: '她轻声说了 buenos días。', residue: 'buenos' },
  ];
  for (const [index, item] of cases.entries()) {
    const id = 'spanish-residue-' + index;
    const project = store.createProject({
      title: 'Spanish Residue Audit ' + item.sourceLang,
      format: 'txt',
      sourceFileName: 'spanish-residue-' + index + '.txt',
      prompt: { translationMode: 'literary', sourceLang: item.sourceLang, targetLang: 'zh' },
      segments: [{ id, text: item.source, kind: 'paragraph', contextPath: 'Capítulo 1' }],
    });
    store.saveManualEdit(project.projectId, id, item.translation);
    ensureTestContextGraph(store, project);
    const report = runProjectQualityAudit(project.projectId);
    assert.ok(report.findings.some((finding) =>
      finding.type === 'english-residue' && finding.segmentIds.includes(id) &&
      finding.residueExamples.includes(item.residue)),
    item.sourceLang + ' Spanish residue should be surfaced for manual review');
  }
});

