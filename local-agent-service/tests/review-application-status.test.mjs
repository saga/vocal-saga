import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentProjectStore } from '../src/documents/projectStore.ts';
import { collectReviewResults } from '../src/literaryReviewRun.ts';

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vocal-review-application-'));
  try {
    const store = new DocumentProjectStore(root);
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const segments = [
  { id: 'ch1-p1', text: 'The door was open.', kind: 'paragraph', contextPath: 'Chapter 1' },
];

/** 一段只有文风建议、没有 must_fix 的审校返回。 */
function styleOnlyReview(finalTranslation) {
  return {
    results: [{
      id: 'ch1-p1',
      finalTranslation,
      findings: [{
        category: 'style',
        sourceExcerpt: 'The door was open.',
        draftExcerpt: '门开着。',
        reason: '「敞开着」比「开着」更有停顿感。',
        suggestion: '改为「门敞开着」。',
        dimension: 'narrative_style',
      }],
    }],
  };
}

const reviewSegments = [{ id: 'ch1-p1', source: 'The door was open.', draft: '门开着。' }];

test('a style-only segment records its proposal as applied once the candidate is adopted', () => {
  const { translations, findings } = collectReviewResults(
    styleOnlyReview('门敞开着。'), reviewSegments, 'style', false,
  );

  assert.equal(translations['ch1-p1'], '门敞开着。', 'the grounded style revision replaces the draft');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].priority, 'optional');
  assert.equal(findings[0].applicationStatus, 'applied',
    'a proposal carried into the accepted text must not stay pending');
  assert.equal(findings[0].applicationMethod, 'automatic-review-adoption');
});

test('a style proposal stays pending when the reviewer returned no usable candidate', () => {
  const { translations, findings } = collectReviewResults(
    styleOnlyReview(''), reviewSegments, 'style', false,
  );

  assert.equal(translations['ch1-p1'], '门开着。', 'without a usable candidate the draft wins');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].applicationStatus, undefined,
    'nothing was applied, so the proposal must not claim an application status');
});

test('a must-fix segment marks its accompanying style proposal applied too', () => {
  const review = {
    results: [{
      id: 'ch1-p1',
      finalTranslation: '门大敞着。',
      findings: [
        {
          category: 'accuracy',
          sourceExcerpt: 'The door was open.',
          draftExcerpt: '门关着。',
          reason: '原文是 open，初译说反了。',
          suggestion: '改为「门开着」。',
        },
        {
          category: 'style',
          sourceExcerpt: 'The door was open.',
          draftExcerpt: '门关着。',
          reason: '节奏拖沓。',
          suggestion: '改为「门大敞着」。',
          dimension: 'pacing',
        },
      ],
    }],
  };
  const { translations, findings } = collectReviewResults(
    review, [{ id: 'ch1-p1', source: 'The door was open.', draft: '门关着。' }], 'combined', false,
  );

  assert.equal(translations['ch1-p1'], '门大敞着。');
  const style = findings.find((finding) => finding.category === 'style');
  const accuracy = findings.find((finding) => finding.category === 'accuracy');
  assert.equal(style?.applicationStatus, 'applied');
  assert.equal(accuracy?.applicationStatus, undefined,
    'accuracy findings carry no proposal and are not applied through the finding channel');
});

test('applying a proposal whose text is already in the body only records the decision', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Already applied proposal', format: 'txt', sourceFileName: 'already.txt', segments,
    });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门敞开着。');
    store.saveFinding(project.projectId, run.runId, 'ch1-p1', {
      category: 'style',
      priority: 'optional',
      sourceExcerpt: 'The door was open.',
      draftExcerpt: '门开着。',
      reason: '「敞开着」更有停顿感。',
      suggestion: '改为「门敞开着」。',
      proposedTranslation: '门敞开着。',
      applicationStatus: 'applied',
      applicationMethod: 'automatic-review-adoption',
    });
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const result = store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'apply');
    assert.equal(result.applicationStatus, 'applied');

    const stored = store.getRun(project.projectId, run.runId).findings[0];
    assert.equal(stored.status, 'applied');
    assert.equal(stored.finding.applicationStatus, 'applied');

    const db = store.projectDbs.get(project.projectId);
    const acceptedRows = db.prepare(
      "SELECT origin FROM translation_results WHERE segment_id = 'ch1-p1' AND accepted = 1",
    ).all();
    assert.equal(acceptedRows.length, 1,
      'confirming an already-applied proposal must not insert a duplicate translation');
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '门敞开着。',
    );
  });
});
