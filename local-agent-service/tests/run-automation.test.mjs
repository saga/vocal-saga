import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'vocal-saga-run-automation-'));
process.env.LOCAL_AGENT_DATA_DIR = testDataDir;
process.env.LOCAL_AGENT_DATABASE = path.join(testDataDir, 'service.sqlite');

const { getDocumentProjectStore } = await import('../src/documents/projectStore.ts');
const { CONTEXT_GRAPH_ANALYSIS_VERSION } = await import('../src/documents/contextGraph.ts');
const {
  autoAcceptFinishedRunCandidates,
  isContextGraphReadyForTranslationRun,
} = await import('../src/documents/translationAgent.ts');

test('literary Run readiness is tied to source revision, analysis version and language direction', () => {
  const run = { sourceRevisionId: 'revision-1', sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' };
  const ready = {
    sourceRevisionId: 'revision-1', status: 'completed', styleGuideReady: true,
    progress: {
      strategy: 'A', sampleCount: 24,
      analysisVersion: CONTEXT_GRAPH_ANALYSIS_VERSION, sourceLang: 'en', targetLang: 'zh',
    },
  };
  assert.equal(isContextGraphReadyForTranslationRun(ready, run), true);
  assert.equal(isContextGraphReadyForTranslationRun({ ...ready, sourceRevisionId: 'revision-2' }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({ ...ready, status: 'running' }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({ ...ready, progress: { ...ready.progress, targetLang: 'ja' } }, run), false);
  assert.equal(isContextGraphReadyForTranslationRun({ ...ready, progress: { ...ready.progress, analysisVersion: 'old' } }, run), false);
});

test('literary Run is persisted as queued before service-owned Context Graph preprocessing', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Service-owned preprocessing gate',
    format: 'txt',
    sourceFileName: 'service-owned-preprocessing.txt',
    prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'literary-gate-1', text: 'The room was quiet.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });

  // No Context Graph run exists yet. The Run must still be durably created so executeRun
  // can start analysis, wait for the matching source/version/language, and only then translate.
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  assert.equal(run.status, 'queued');
  assert.equal(run.translationMode, 'literary');
  assert.equal(run.sourceLang, 'en');
  assert.equal(run.targetLang, 'zh');
  assert.equal(run.counts.total, 1);
  assert.equal(store.getRun(project.projectId, run.runId).status, 'queued');
});

test('cancelled Run is terminal and late candidate writes are fenced by the Store transaction', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Cancellation write fence',
    format: 'txt',
    sourceFileName: 'cancel-write-fence.txt',
    prompt: { translationMode: 'technical', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'cancel-fence-1', text: 'A late result must not be committed.', kind: 'paragraph' },
    ],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });

  assert.equal(store.setRunStatus(project.projectId, run.runId, 'cancelled', 'user requested stop'), true);
  assert.equal(
    store.saveCandidates(project.projectId, run.runId, [
      { segmentId: 'cancel-fence-1', text: '迟到的结果不得提交。' },
    ]),
    false,
  );
  assert.equal(store.setRunStatus(project.projectId, run.runId, 'running'), false);
  assert.equal(store.getRunStatus(project.projectId, run.runId), 'cancelled');
  assert.equal(store.getSegments(project.projectId, { limit: 10, runId: run.runId })
    .find((item) => item.id === 'cancel-fence-1').candidateTranslation, null);
});

test('service automatically accepts finished candidates through the guarded Store transaction', () => {
  const store = getDocumentProjectStore();
  const project = store.createProject({
    title: 'Automatic acceptance test',
    format: 'txt',
    sourceFileName: 'automatic-acceptance.txt',
    prompt: { translationMode: 'technical', sourceLang: 'en', targetLang: 'zh' },
    segments: [
      { id: 'auto-1', text: 'The room was quiet.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'auto-2', text: 'She closed the book.', kind: 'paragraph', contextPath: 'Chapter 1' },
    ],
  });
  const run = store.createRun(project.projectId, { scope: { type: 'all' } });
  store.saveCandidate(project.projectId, run.runId, 'auto-1', '房间里很安静。');
  store.saveCandidate(project.projectId, run.runId, 'auto-2', '她合上了书。');

  // A manual edit after candidate creation must still win during automated finalization.
  store.saveManualEdit(project.projectId, 'auto-2', '她把书合上了。');
  const pending = store.finishRun(project.projectId, run.runId);
  assert.equal(pending.status, 'awaiting_acceptance');

  const finished = autoAcceptFinishedRunCandidates(project.projectId, run.runId);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.counts.candidate || 0, 0);

  const segments = store.getSegments(project.projectId, { limit: 10 });
  assert.equal(segments.find((item) => item.id === 'auto-1').acceptedTranslation, '房间里很安静。');
  assert.equal(segments.find((item) => item.id === 'auto-2').acceptedTranslation, '她把书合上了。');

  // Re-entry is idempotent and does not overwrite anything already accepted.
  const second = autoAcceptFinishedRunCandidates(project.projectId, run.runId);
  assert.equal(second.status, 'completed');
  assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'auto-2').acceptedTranslation,
    '她把书合上了。');
});
