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
  assert.equal(accuracy?.applicationStatus, 'applied',
    'a must-fix is closed when the selected final translation removes its exact erroneous draft excerpt');
  assert.equal(accuracy?.applicationMethod, 'automatic-bilingual-review');
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


test('an unresolved must-fix remains open unless the reviewed translation removes its exact bad excerpt', () => {
  const source = 'Bog help you if you did not give him the money.';
  const draft = '愿上帝保佑你，如果你不给他钱。';
  const finding = {
    category: 'accuracy',
    sourceExcerpt: source,
    draftExcerpt: '愿上帝保佑你',
    reason: '原文是威胁，不是祝福。',
    suggestion: '可有你好受的。',
  };
  const sameMeaningFailure = collectReviewResults({
    results: [{ id: 'ch1-p1', finalTranslation: draft, findings: [finding] }],
  }, [{ id: 'ch1-p1', source, draft }], 'accuracy', false);
  assert.equal(sameMeaningFailure.translations['ch1-p1'], draft);
  assert.equal(sameMeaningFailure.findings[0].priority, 'must_fix');
  assert.equal(sameMeaningFailure.findings[0].applicationStatus, 'pending',
    'the finding cannot be marked fixed when its exact problematic wording remains');

  const corrected = collectReviewResults({
    results: [{ id: 'ch1-p1', finalTranslation: '你要是不把钱给他，可有你好受的。', findings: [finding] }],
  }, [{ id: 'ch1-p1', source, draft }], 'accuracy', false);
  assert.equal(corrected.translations['ch1-p1'], '你要是不把钱给他，可有你好受的。');
  assert.equal(corrected.findings[0].priority, 'must_fix');
  assert.equal(corrected.findings[0].applicationStatus, 'applied');
  assert.equal(corrected.findings[0].applicationMethod, 'automatic-bilingual-review');
});

test('must-fix findings persist as applied only when the reviewer actually repaired the text', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Must-fix persistence', format: 'txt', sourceFileName: 'must-fix.txt', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    const review = collectReviewResults({
      results: [{
        id: 'ch1-p1',
        finalTranslation: '门敞开着。',
        findings: [{
          category: 'accuracy',
          sourceExcerpt: 'The door was open.',
          draftExcerpt: '门关着。',
          reason: '原文是 open，初译说反了。',
          suggestion: '改为「门开着」。',
        }],
      }],
    }, [{ id: 'ch1-p1', source: 'The door was open.', draft: '门关着。' }], 'accuracy', false);
    store.saveCandidates(
      project.projectId,
      run.runId,
      [{ segmentId: 'ch1-p1', text: review.translations['ch1-p1'] }],
      review.findings.map((finding) => ({ segmentId: 'ch1-p1', finding })),
    );

    const persisted = store.getRun(project.projectId, run.runId).findings[0];
    assert.equal(persisted.category, 'accuracy');
    assert.equal(persisted.status, 'applied');
    assert.equal(persisted.finding.applicationStatus, 'applied');
    assert.equal(persisted.finding.applicationMethod, 'automatic-bilingual-review');
  });
});

test('a user can explicitly waive an unresolved accuracy must-fix without applying its draft', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Must-fix waiver', format: 'txt', sourceFileName: 'waiver.txt', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidates(
      project.projectId,
      run.runId,
      [{ segmentId: 'ch1-p1', text: '门关着。' }],
      [{
        segmentId: 'ch1-p1',
        finding: {
          category: 'accuracy',
          priority: 'must_fix',
          sourceExcerpt: 'The door was open.',
          draftExcerpt: '门关着。',
          reason: '原文是 open，初译说反了。',
          suggestion: '改为「门开着」。',
          applicationStatus: 'pending',
        },
      }],
    );
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const result = store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'dismiss');
    assert.equal(result.applicationStatus, 'dismissed');
    assert.equal(result.disposition, 'user-waiver');
    assert.equal(result.priority, 'must_fix');

    const finding = store.getRun(project.projectId, run.runId).findings[0];
    assert.equal(finding.status, 'dismissed');
    assert.equal(finding.finding.applicationStatus, 'dismissed');
    assert.equal(finding.finding.applicationMethod, 'user-waiver');
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '门关着。',
      'waiving a finding must never silently apply the reviewer suggestion',
    );
  });
});


test('a must-fix insertion repair closes only with an exact revised excerpt', () => {
  const source = 'He said, Get out.';
  const draft = '他说，滚出去。';
  const fixed = '“滚出去。”他说。';
  const review = collectReviewResults({
    results: [{
      id: 'ch1-p1',
      finalTranslation: fixed,
      findings: [{
        category: 'accuracy',
        sourceExcerpt: 'Get out.',
        draftExcerpt: '滚出去',
        revisedExcerpt: '“滚出去',
        reason: '原文是直接引语，初译缺少前引号。',
        suggestion: '补上引号。',
      }],
    }],
  }, [{ id: 'ch1-p1', source, draft }], 'accuracy', false);

  assert.equal(review.translations['ch1-p1'], fixed);
  assert.equal(review.findings[0].revisedExcerpt, '“滚出去');
  assert.equal(review.findings[0].applicationStatus, 'applied');
  assert.equal(review.findings[0].applicationMethod, 'automatic-bilingual-review-insertion-evidence');
});

test('a must-fix insertion repair remains pending without revised-excerpt evidence', () => {
  const source = 'He said, Get out.';
  const draft = '他说，滚出去。';
  const review = collectReviewResults({
    results: [{
      id: 'ch1-p1',
      finalTranslation: '“滚出去。”他说。',
      findings: [{
        category: 'accuracy',
        sourceExcerpt: 'Get out.',
        draftExcerpt: '滚出去',
        reason: '原文是直接引语，初译缺少前引号。',
        suggestion: '补上引号。',
      }],
    }],
  }, [{ id: 'ch1-p1', source, draft }], 'accuracy', false);

  assert.equal(review.translations['ch1-p1'], '“滚出去。”他说。');
  assert.equal(review.findings[0].applicationStatus, 'pending');
});
