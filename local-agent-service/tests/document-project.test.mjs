import test from 'node:test';
import { ensureTestContextGraph } from './helpers/literary-context-graph.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DocumentProjectStore } from '../src/documents/projectStore.ts';

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vocal-doc-project-'));
  try {
    const store = new DocumentProjectStore(root);
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const segments = [
  { id: 'ch1-p1', text: 'The door was open.', kind: 'paragraph', contextPath: 'Chapter 1' },
  { id: 'ch1-p2', text: 'Nobody came inside.', kind: 'paragraph', contextPath: 'Chapter 1' },
];

test('same-timestamp Prompt revisions consistently use the most recently inserted revision', async () => {
  await withStore((store, root) => {
    const project = store.createProject({
      title: 'Prompt ordering',
      format: 'txt',
      sourceFileName: 'prompt-ordering.txt',
      segments,
    });
    const first = store.savePrompt(project.projectId, {
      name: 'first', systemPrompt: 'first prompt', userPromptTemplate: '',
      sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto',
      translationMode: 'technical', literaryReview: false,
    });
    const second = store.savePrompt(project.projectId, {
      name: 'second', systemPrompt: 'second prompt', userPromptTemplate: '',
      sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto',
      translationMode: 'technical', literaryReview: false,
    });

    const db = new DatabaseSync(path.join(root, project.projectId, 'project.sqlite'));
    db.prepare('UPDATE prompt_revisions SET created_at = ?').run('2026-01-01T00:00:00.000Z');
    db.close();

    assert.equal(store.listPrompts(project.projectId)[0].promptRevisionId, second.promptRevisionId);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(run.promptRevisionId, second.promptRevisionId);
    assert.notEqual(first.promptRevisionId, second.promptRevisionId);
  });
});

test('document projects persist each source segment, Prompt revision and run independently', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Example Book',
      format: 'epub',
      sourceFileName: 'example.epub',
      segments,
      prompt: { systemPrompt: 'Translate faithfully.', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' },
    });
    assert.equal(project.title, 'Example Book');
    assert.equal(project.segmentCount, 2);
    assert.equal(store.listProjects().length, 1);

    ensureTestContextGraph(store, project);

    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(run.status, 'queued');
    assert.equal(run.counts.total, 2);
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    const awaiting = store.finishRun(project.projectId, run.runId);
    assert.equal(awaiting.status, 'awaiting_acceptance');
    assert.equal(awaiting.counts.candidate, 2);

    // Candidate translations are durable but are not the current accepted translation.
    const beforeAccept = store.getSegments(project.projectId, { limit: 20, runId: run.runId });
    assert.equal(beforeAccept[0].acceptedTranslation, null);
    assert.equal(beforeAccept[0].candidateTranslation, '门开着。');

    const accepted = store.acceptCandidates(project.projectId, run.runId);
    assert.equal(accepted.status, 'completed');
    const current = store.getSegments(project.projectId, { limit: 20 });
    assert.equal(current[0].acceptedTranslation, '门开着。');
    assert.equal(current[1].acceptedTranslation, '没有人进来。');

    // Identical inputs should plan no stale work after accepting the run.
    ensureTestContextGraph(store, project);
    const noWork = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(noWork.counts.total, 0);
    assert.equal(noWork.status, 'completed');
  });
});

test('project resolution finds the exact server project and treats same-name changed source as related only', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Example Book', format: 'epub', sourceFileName: 'example.epub', segments,
    });

    const exact = store.resolveProjectForSource({
      title: 'Example Book', format: 'epub', sourceFileName: 'example.epub', segments,
    });
    assert.equal(exact.exactProject?.projectId, project.projectId);
    assert.equal(exact.relatedProject, null);

    const changedSegments = [{ ...segments[0], text: 'The old door was open.' }, segments[1]];
    const changed = store.resolveProjectForSource({
      title: 'Example Book', format: 'epub', sourceFileName: 'example.epub', segments: changedSegments,
    });
    assert.equal(changed.exactProject, null, 'changed source must not be treated as the same source revision');
    assert.equal(changed.relatedProject?.projectId, project.projectId, 'same filename should surface the existing project for explicit source-change handling');

    const unrelated = store.resolveProjectForSource({
      title: 'Another Book', format: 'epub', sourceFileName: 'another.epub', segments: changedSegments,
    });
    assert.equal(unrelated.exactProject, null);
    assert.equal(unrelated.relatedProject, null);
  });
});

test('source revisions retain prior runs and report translations stale when their source changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Revision Test', format: 'pdf', segments });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '没有人进来。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const revised = [
      { ...segments[0], text: 'The old door was open.' },
      segments[1],
    ];
    const nextProject = store.createSourceRevision(project.projectId, {
      title: project.title, format: 'pdf', segments: revised,
    });
    assert.notEqual(nextProject.currentSourceRevisionId, project.currentSourceRevisionId);
    const verification = store.verifyProject(project.projectId);
    assert.deepEqual(verification.staleSourceIds, ['ch1-p1']);
    const runList = store.listRuns(project.projectId);
    assert.equal(runList.length, 1, 'source import must not delete older run history');
  });
});

test('older Run acceptance cannot overwrite a newer accepted Agent translation', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Protect Newer Agent Result', format: 'epub', segments });
    const older = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, older.runId, 'ch1-p1', '旧 Run 的候选。');
    store.finishRun(project.projectId, older.runId);
    assert.throws(
      () => store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } }),
      /尚未完成最终化/,
      'a new Run must not start while the previous Run is still awaiting automatic acceptance',
    );
    // Simulate an interrupted finalization recovery record; once explicitly failed, a new Run
    // may proceed, but a later recovery accept must still not overwrite its newer accepted result.
    store.setRunStatus(project.projectId, older.runId, 'failed', 'simulated interrupted finalization');
    const newer = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, newer.runId, 'ch1-p1', '新 Run 的候选。');
    store.finishRun(project.projectId, newer.runId);
    store.acceptCandidates(project.projectId, newer.runId);
    store.acceptCandidates(project.projectId, older.runId);

    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '新 Run 的候选。',
      'a delayed recovery/accept call for an older Run must not replace a newer accepted result',
    );
    assert.equal(store.getRun(project.projectId, older.runId).status, 'completed');
  });
});

test('candidate acceptance refuses a Run from a superseded source revision', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Stale Candidate Revision', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '旧来源候选。');
    store.finishRun(project.projectId, run.runId);
    store.setRunStatus(project.projectId, run.runId, 'failed', '模拟中断后的可恢复状态');
    store.createSourceRevision(project.projectId, {
      title: project.title,
      format: 'epub',
      segments: [{ ...segments[0], text: 'The old door was open.' }, ...segments.slice(1)],
    });
    assert.throws(
      () => store.acceptCandidates(project.projectId, run.runId),
      /旧原文版本/,
      'acceptance must re-check the current source revision inside its transaction',
    );
  });
});

test('manual correction becomes an accepted version but remains traceable', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Edit', format: 'epub', segments });
    const edit = store.saveManualEdit(project.projectId, 'ch1-p1', '门敞开着。');
    assert.equal(edit.origin, 'manual');
    assert.equal(edit.accepted, true);
    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current[0].acceptedTranslation, '门敞开着。');
    assert.equal(store.getEvents(project.projectId).some((event) => event.type === 'translation.manually-edited'), true);
  });
});

test('stores each original source file in its document revision directory', async () => {
  await withStore(async (store) => {
    const project = store.createProject({
      title: 'Original File',
      format: 'epub',
      sourceFileName: 'original.epub',
      segments,
    });
    const bytes = Buffer.from('PK fake EPUB source bytes');
    const saved = await store.storeSourceFile(project.projectId, 'original.epub', bytes);
    assert.equal(saved.saved, true);
    assert.equal(saved.size, bytes.byteLength);
    assert.equal(saved.sourceRevisionId, project.currentSourceRevisionId);
    assert.equal(store.getProject(project.projectId)?.sourceFileSaved, true);
    const actual = await readFile(path.join(store.rootDir, project.projectId, 'sources', project.currentSourceRevisionId + '.epub'));
    assert.deepEqual(actual, bytes);

    await assert.rejects(
      store.storeSourceFile(project.projectId, 'original.epub', Buffer.from('different bytes')),
      /此来源版本已有不同的原始文件/,
    );
  });
});

test('auto-applying a rerun preserves an existing manual translation for the same source', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Preserve Manual Translation', format: 'epub', segments });
    store.saveManualEdit(project.projectId, 'ch1-p1', '用户已经确认的译文。');

    ensureTestContextGraph(store, project);

    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '模型重新生成的译文。');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '第二段的新译文。');
    store.finishRun(project.projectId, run.runId);

    const finished = store.acceptCandidates(project.projectId, run.runId);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.counts.candidate || 0, 0, 'preserved manual text must resolve the run item instead of leaving it awaiting acceptance');

    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current.find((item) => item.id === 'ch1-p1')?.acceptedTranslation, '用户已经确认的译文。');
    assert.equal(current.find((item) => item.id === 'ch1-p2')?.acceptedTranslation, '第二段的新译文。');
  });
});

test('manual acceptance is newer than an older candidate and is not auto-staled by Prompt changes', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Manual Priority', format: 'epub', segments });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '模型候选。');
    store.finishRun(project.projectId, run.runId);
    store.saveManualEdit(project.projectId, 'ch1-p1', '用户修订。');
    store.acceptCandidates(project.projectId, run.runId, ['ch1-p1']);

    const current = store.getSegments(project.projectId, { limit: 10 });
    assert.equal(current.find((item) => item.id === 'ch1-p1')?.acceptedTranslation, '用户修订。', 'a post-run manual edit must outrank the older Agent candidate');

    // A correction made after that explicit acceptance is newest and must survive Prompt changes.
    store.saveManualEdit(project.projectId, 'ch1-p1', '再次人工修订。');
    const nextPrompt = {
      systemPrompt: 'Changed prompt; use short natural Chinese.',
      sourceLang: 'en',
      targetLang: 'zh',
      provider: 'workbuddy',
      model: 'auto',
    };
    ensureTestContextGraph(store, project);
    const noAutomaticOverwrite = store.createRun(project.projectId, { prompt: nextPrompt, scope: { type: 'stale' } });
    assert.equal(noAutomaticOverwrite.counts.total, 1, 'only the segment not yet accepted should remain stale');
    assert.equal(store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation, '再次人工修订。');
  });
});

// 回归：毫秒时间戳打平不得让旧候选覆盖新人工修订。
// 原实现用 `created_at > 候选.created_at` 判断「是否存在更新的人工修订」。created_at 是
// 毫秒精度，同一毫秒内写入的候选与修订会打平，严格大于为假 → 旧候选获胜。上面那个用例
// 因此会间歇性失败（实测 6 次跑 4 次红）。现在改由插入顺序（rowid）裁决；
// 这里直接把两条记录的 created_at 改成完全相同，把打平路径固定下来。
test('a manual edit inserted after a candidate wins even when both share one created_at millisecond', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ title: 'Tie Break', format: 'epub', segments });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '模型候选。');
    store.finishRun(project.projectId, run.runId);
    store.saveManualEdit(project.projectId, 'ch1-p1', '用户修订。');

    const db = new DatabaseSync(path.join(store.rootDir, project.projectId, 'project.sqlite'));
    try {
      const candidate = db.prepare("SELECT rowid, created_at FROM translation_results WHERE origin = 'agent' AND segment_id = 'ch1-p1'").get();
      const manual = db.prepare("SELECT rowid, created_at FROM translation_results WHERE origin = 'manual' AND segment_id = 'ch1-p1'").get();
      assert.ok(manual.rowid > candidate.rowid, 'the manual edit must be inserted after the candidate');
      // 打平时间戳：此后时间戳再也无法区分新旧，只有插入顺序可以。
      db.prepare('UPDATE translation_results SET created_at = ?, accepted_at = ? WHERE rowid = ?')
        .run(candidate.created_at, candidate.created_at, manual.rowid);
    } finally {
      db.close();
    }

    store.acceptCandidates(project.projectId, run.runId, ['ch1-p1']);
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '用户修订。',
      'a tied timestamp must not let the stale Agent candidate overwrite the newer manual edit',
    );
  });
});

// 回归：created_at 必须在进程内严格递增。所有「哪一条更新」的判断都比时间戳，
// 毫秒精度下背靠背落库很容易打平（Agent 连续写候选时尤其明显），打平即失去顺序。
test('created_at is strictly increasing across back-to-back writes', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ title: 'Monotonic Clock', format: 'epub', segments });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    const db = new DatabaseSync(path.join(store.rootDir, project.projectId, 'project.sqlite'));
    try {
      for (let i = 0; i < 60; i++) store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '候选 ' + i);
      for (let i = 0; i < 60; i++) store.saveManualEdit(project.projectId, 'ch1-p1', '修订 ' + i);
      const stamps = db.prepare('SELECT created_at FROM translation_results ORDER BY rowid').all().map((row) => row.created_at);
      assert.equal(stamps.length, 120);
      // ISO-8601 UTC 字符串的字典序就是时间序。
      for (let i = 1; i < stamps.length; i++) {
        assert.ok(stamps[i] > stamps[i - 1], `created_at must strictly increase, got ${stamps[i - 1]} then ${stamps[i]}`);
      }
    } finally {
      db.close();
    }
  });
});


test('imports existing reader translations into workspace without overwriting accepted results', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Reader Shared State',
      format: 'epub',
      sourceFileName: 'reader.epub',
      segments,
      prompt: { systemPrompt: 'Shared prompt v1', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' },
    });
    const imported = store.importAcceptedTranslations(project.projectId, [
      { id: 'ch1-p1', text: '阅读页早先的译文。' },
      { id: 'ch1-p2', text: '另一段译文。' },
      { id: 'unknown', text: '不应导入。' },
    ]);
    assert.deepEqual(imported, { imported: 2, skipped: 1 });
    assert.equal(store.getSegments(project.projectId, { limit: 10 })[0].acceptedTranslation, '阅读页早先的译文。');

    const duplicate = store.importAcceptedTranslations(project.projectId, [
      { id: 'ch1-p1', text: '旧浏览器缓存不应覆盖 Agent 的当前版本。' },
    ]);
    assert.deepEqual(duplicate, { imported: 0, skipped: 1 });
    assert.equal(store.getSegments(project.projectId, { limit: 10 })[0].acceptedTranslation, '阅读页早先的译文。');

    ensureTestContextGraph(store, project);

    const noWork = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(noWork.counts.total, 0, 'imported text should be seeded against the current Prompt fingerprint');
  });
});


test('literary memory has immutable revisions and each run keeps its original snapshot', async () => {
  await withStore((store) => {
    const memoryA = {
      version: 2, entities: [], relationships: [], styleGuide: { narrativeVoice: '克制' },
      chapterSummaries: [], recentExamples: [],
      characterVoices: [{
        characterId: 'char-alice', canonicalSourceName: 'Alice', targetName: '艾丽丝', aliases: [],
        status: 'confirmed', confidence: 0.9, voiceCore: { syntaxRhythm: ['短反问'] },
        contrastRules: [], evidence: [{ segmentId: 'ch1-p1', sourceQuote: 'The door was open.', dimension: 'register', observation: '用简短陈述表达信息', confidence: 0.9 }],
        openQuestions: [],
      }],
      relationshipVoiceRules: [], voiceAnchors: [],
    };
    const project = store.createProject({
      title: 'Voice Versions', format: 'epub', segments,
      prompt: { systemPrompt: 'same prompt', userPromptTemplate: '{{CONTENT}}', sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto', translationMode: 'literary', literaryMemory: memoryA },
    });
    ensureTestContextGraph(store, project);
    const first = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    const firstContext = store.getRunContext(project.projectId, first.runId);
    assert.equal(firstContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '短反问');
    assert.ok(firstContext.memoryRevisionId);

    store.setRunStatus(project.projectId, first.runId, 'paused');
    const memoryB = structuredClone(memoryA);
    memoryB.characterVoices[0].voiceCore.syntaxRhythm = ['先给结论，再用完整句解释'];
    const secondMemory = store.saveLiteraryMemory(project.projectId, memoryB);
    ensureTestContextGraph(store, project);
    const second = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p2'] } });
    const secondContext = store.getRunContext(project.projectId, second.runId);

    assert.notEqual(secondMemory.memoryRevisionId, firstContext.memoryRevisionId);
    assert.equal(secondContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '先给结论，再用完整句解释');
    assert.equal(firstContext.memory.characterVoices[0].voiceCore.syntaxRhythm[0], '短反问', 'earlier run must retain its immutable memory snapshot');
    assert.equal(second.promptRevisionId, first.promptRevisionId, 'memory updates must not create prompt revisions');
    assert.notEqual(second.literaryMemoryRevisionId, first.literaryMemoryRevisionId);
    assert.equal(store.listLiteraryMemoryRevisions(project.projectId).length, 2);
  });
});

test('Run creation refuses to pin literary memory that changed before the write lock', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Run Snapshot Race', format: 'epub', segments });
    const readCurrentMemory = store.getCurrentLiteraryMemory.bind(store);
    let raced = false;
    store.getCurrentLiteraryMemory = (projectId) => {
      const snapshot = readCurrentMemory(projectId);
      if (!raced) {
        raced = true;
        store.saveLiteraryMemory(projectId, {
          ...snapshot.memory,
          openQuestions: ['a user edit committed while the Run snapshot was being assembled'],
        });
      }
      return snapshot;
    };
    assert.throws(
      () => store.createRun(project.projectId, { scope: { type: 'all' } }),
      /原文或文学记忆已更新/,
      'the Run must retry rather than bind a stale memory revision',
    );
    assert.equal(store.listRuns(project.projectId).length, 0);
  });
});

test('simultaneous Run creation requests cannot both acquire the workspace lock', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ title: 'Concurrent Run creation', format: 'epub', segments });
    ensureTestContextGraph(store, project);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => store.createRun(project.projectId, { scope: { type: 'all' } })),
      Promise.resolve().then(() => store.createRun(project.projectId, { scope: { type: 'all' } })),
    ]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
    const failure = attempts.find((item) => item.status === 'rejected');
    assert.match(String(failure?.reason?.message || failure?.reason), /已有尚未完成最终化的翻译任务/);
    assert.equal(store.listRuns(project.projectId, 10).length, 1,
      'a rejected concurrent create must not leave an orphan Run record');
  });
});

test('one workspace cannot run two translation jobs concurrently', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Single Run', format: 'epub', segments });
    ensureTestContextGraph(store, project);
    const first = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(first.status, 'queued');
    assert.throws(
      () => store.createRun(project.projectId, { scope: { type: 'all' } }),
      /已有尚未完成最终化的翻译任务/,
      'reader and Agent tabs must share one in-flight run lock',
    );
    store.setRunStatus(project.projectId, first.runId, 'paused');
    ensureTestContextGraph(store, project);
    const next = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(next.status, 'queued', 'a paused run can be explicitly replaced with a new run');
  });
});


test('literary voice profiles are default-adopted regardless of evidence count', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Evidence Verified Voice',
      format: 'epub',
      segments: [
        { id: 'voice-1', text: 'Alice answered in a measured tone.', contextPath: 'Chapter 1' },
        { id: 'voice-2', text: 'She paused, then asked a short question.', contextPath: 'Chapter 2' },
        { id: 'voice-3', text: 'Alice replied with deliberate precision.', contextPath: 'Chapter 3' },
      ],
      prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    });
    ensureTestContextGraph(store, project);

    store.saveLiteraryMemory(project.projectId, {
      characterVoices: [{
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        confidence: 0.99,
        voiceCore: {
          register: 'measured and restrained',
          syntaxRhythm: ['short questions after deliberate pauses'],
        },
        evidence: [
          { segmentId: 'voice-1', sourceQuote: 'Alice answered in a measured tone.', dimension: 'register', observation: 'measured register' },
          { segmentId: 'voice-2', sourceQuote: 'She paused, then asked a short question.', dimension: 'syntax_rhythm', observation: 'deliberate pause and short question' },
          { segmentId: 'voice-3', sourceQuote: 'Alice replied with deliberate precision.', dimension: 'lexicon', observation: 'precise diction' },
        ],
      }],
    });

    const saved = store.getCurrentLiteraryMemory(project.projectId).memory.characterVoices[0];
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.confirmationSource, 'model-default');
    assert.equal(saved.evidence.length, 3);
    assert.equal(saved.confidence, null,
      'model self-reported confidence remains uncalibrated metadata and does not control adoption');

    store.createSourceRevision(project.projectId, {
      title: project.title,
      format: 'epub',
      segments: [
        { id: 'voice-1', text: 'Alice answered in a measured tone.', contextPath: 'Chapter 1' },
        { id: 'voice-2', text: 'She paused, then asked a short question.', contextPath: 'Chapter 2' },
        { id: 'voice-3', text: 'Alice replied with a different sentence.', contextPath: 'Chapter 3' },
      ],
    });
    const afterSourceChange = store.getCurrentLiteraryMemory(project.projectId).memory.characterVoices[0];
    assert.equal(afterSourceChange.status, 'confirmed');
    assert.equal(afterSourceChange.confirmationSource, 'model-default');
    assert.equal(afterSourceChange.evidence.length, 2,
      'stale excerpts are removed, but the remaining model-default profile is not sent for human approval');
  });
});

test('sparse literary voice profiles are still default-adopted', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Insufficient Voice Evidence',
      format: 'epub',
      segments: [
        { id: 'voice-1', text: 'Alice answered quietly.', contextPath: 'Chapter 1' },
        { id: 'voice-2', text: 'Alice spoke softly.', contextPath: 'Chapter 1' },
        { id: 'voice-3', text: 'Alice replied gently.', contextPath: 'Chapter 1' },
      ],
    });
    ensureTestContextGraph(store, project);
    store.saveLiteraryMemory(project.projectId, {
      characterVoices: [{
        characterId: 'char-alice',
        canonicalSourceName: 'Alice',
        status: 'candidate',
        voiceCore: { register: 'quiet and gentle' },
        evidence: [
          { segmentId: 'voice-1', sourceQuote: 'Alice answered quietly.', dimension: 'register', observation: 'quiet register' },
          { segmentId: 'voice-2', sourceQuote: 'Alice spoke softly.', dimension: 'register', observation: 'soft register' },
          { segmentId: 'voice-3', sourceQuote: 'Alice replied gently.', dimension: 'register', observation: 'gentle register' },
        ],
      }],
    });
    const saved = store.getCurrentLiteraryMemory(project.projectId).memory.characterVoices[0];
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.confirmationSource, 'model-default');
  });
});

test('literary memory default-adopts profiles while validating source and translation anchors', async () => {
  await withStore((store) => {
    const source = [
      { id: 'ch1-p1', text: 'Alice asked Bob, “Really?”', kind: 'dialogue', contextPath: 'Chapter 1' },
      { id: 'ch1-p2', text: 'Bob said no.', kind: 'dialogue', contextPath: 'Chapter 1' },
    ];
    const project = store.createProject({ title: 'Voice Evidence', format: 'epub', segments: source,
      prompt: { translationMode: 'literary', literaryReview: true, sourceLang: 'en', targetLang: 'zh', provider: 'workbuddy', model: 'auto' } });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '艾丽丝问鲍勃：“真的？”');
    store.saveCandidate(project.projectId, run.runId, 'ch1-p2', '鲍勃说不。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const memory = {
      version: 2, entities: [], relationships: [], styleGuide: { narrativeVoice: '克制' },
      chapterSummaries: [], recentExamples: [],
      characterVoices: [
        {
          characterId: 'char-alice', canonicalSourceName: 'Alice', aliases: [], status: 'confirmed', confidence: 0.9,
          voiceCore: { syntaxRhythm: ['用简短反问'] }, contrastRules: [],
          evidence: [{ segmentId: 'ch1-p1', sourceQuote: 'Alice asked Bob', dimension: 'discourse', observation: '对白有明确的提问标记', confidence: 0.9 }],
          openQuestions: [],
        },
        {
          characterId: 'char-bob', canonicalSourceName: 'Bob', aliases: [], status: 'confirmed', confidence: 0.8,
          voiceCore: { register: '简短回答' }, contrastRules: [],
          evidence: [{ segmentId: 'ch1-p2', sourceQuote: 'This quote is not in this paragraph', dimension: 'register', observation: 'invalid source quote', confidence: 0.8 }],
          openQuestions: [],
        },
      ],
      relationshipVoiceRules: [{
        speakerId: 'char-alice', addresseeId: 'char-bob', status: 'confirmed',
        baselineRegister: '直接但平静', addressTerms: ['Bob'], evidenceSegmentIds: ['ch1-p1', 'missing-id'],
      }],
      voiceAnchors: [
        {
          anchorId: 'anchor-valid', speakerId: 'char-alice', addresseeId: 'char-bob', source: 'Really?',
          target: '真的？', chapter: 'Chapter 1', segmentId: 'ch1-p1', status: 'approved', approvedBy: 'user',
          attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: ['short-question'],
        },
        {
          anchorId: 'anchor-wrong-target', speakerId: 'char-alice', source: 'Really?',
          target: '我爱你。', chapter: 'Chapter 1', segmentId: 'ch1-p1', status: 'approved', approvedBy: 'user',
          attributionEvidence: 'Alice asked Bob', attributionConfidence: 0.95, tags: [],
        },
      ],
    };
    store.saveLiteraryMemory(project.projectId, memory);
    const saved = store.getCurrentLiteraryMemory(project.projectId).memory;
    assert.equal(saved.characterVoices.find((item) => item.characterId === 'char-alice').status, 'confirmed');
    assert.equal(saved.characterVoices.find((item) => item.characterId === 'char-bob').status, 'confirmed',
      'a model profile remains default-adopted even when its evidence excerpt needs correction');
    assert.equal(saved.characterVoices.find((item) => item.characterId === 'char-bob').evidence.length, 0);
    assert.equal(saved.relationshipVoiceRules.length, 1,
      'a directional relationship rule remains active without a human approval step');
    assert.deepEqual(saved.relationshipVoiceRules[0].evidenceSegmentIds, ['ch1-p1']);
    assert.equal(saved.voiceAnchors.find((item) => item.anchorId === 'anchor-valid').status, 'approved');
    assert.equal(saved.voiceAnchors.find((item) => item.anchorId === 'anchor-wrong-target').status, 'candidate',
      'an anchor target must exist in the accepted translation for the referenced segment');

    // Once the source segment changes, the prior accepted result is stale even if the quote still exists.
    store.createSourceRevision(project.projectId, {
      title: project.title, format: 'epub',
      segments: [{ ...source[0], text: source[0].text + ' Then she left.' }, source[1]],
    });
    const afterSourceRevision = store.getCurrentLiteraryMemory(project.projectId).memory;
    assert.equal(afterSourceRevision.voiceAnchors.find((item) => item.anchorId === 'anchor-valid').status, 'candidate',
      'an old accepted translation cannot keep a voice anchor approved for a newer source revision');
  });
});

test('literary Agent retrieves only bounded source context before the current segment', async () => {
  await withStore((store) => {
    const source = Array.from({ length: 8 }, (_, index) => ({
      id: 'p' + index, text: 'Source segment ' + index, kind: 'paragraph', contextPath: 'Chapter A',
    }));
    const project = store.createProject({ title: 'Previous Context', format: 'epub', segments: source });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    const preceding = store.getPrecedingSegments(project.projectId, run.runId, 'p7', 4);
    assert.deepEqual(preceding.map((item) => item.id), ['p3', 'p4', 'p5', 'p6']);
    assert.ok(preceding.every((item) => item.text.length <= 900));
    assert.ok(preceding.every((item) => item.contextPath === 'Chapter A'));
  });
});

// 整本书的正文必须能作为单个项目导入。此前 validateSegments 有一道 1,500,000 字符的
// 总量上限，会在创建 workspace 时把大文档挡在门外（"无法准备文档 workspace：..."）。
// 这个上限已移除；容量由 /api/documents 的请求体上限和片段条数上限约束，不由正文总长约束。
test('a document whose segments exceed 1,500,000 characters is imported in full', async () => {
  await withStore((store) => {
    const longSegments = Array.from({ length: 200 }, (_, index) => ({
      id: 'big-' + index,
      text: '长'.repeat(8000),
      kind: 'paragraph',
      contextPath: '第一章',
    }));
    const totalChars = longSegments.reduce((sum, item) => sum + item.text.length, 0);
    assert.ok(totalChars > 1_500_000, 'fixture must actually cross the removed limit');

    const project = store.createProject({ title: 'Long Book', format: 'epub', segments: longSegments });
    assert.equal(project.segmentCount, 200);

    const page = store.getSegments(project.projectId, { limit: 1000, offset: 0 });
    assert.equal(page.length, 200);
    assert.equal(page[199].text.length, 8000);
  });
});



test('Prompt revisions and Run creation cannot implicitly overwrite the server-owned literary memory', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Explicit Memory Write Boundary',
      format: 'txt',
      sourceFileName: 'memory-boundary.txt',
      segments: [{ id: 'king-1', text: 'The King looked at Max and remained silent.', kind: 'paragraph', contextPath: 'Chapter 1' }],
      prompt: {
        translationMode: 'literary', sourceLang: 'en', targetLang: 'zh',
        literaryMemory: {
          entities: [{
            source: 'The King', target: '国王', kind: 'character_epithet', aliases: ['King'],
            evidence: 'The King looked at Max and remained silent.', reviewStatus: 'suggested',
          }],
          relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
          characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
        },
      },
    });
    const before = store.getCurrentLiteraryMemory(project.projectId);
    assert.equal(before.memory.entities[0]?.target, '国王');

    assert.throws(() => store.savePrompt(project.projectId, {
      systemPrompt: 'Translate faithfully.', sourceLang: 'en', targetLang: 'zh',
      translationMode: 'literary',
      literaryMemory: {
        entities: [{ source: 'The King', target: '大王', kind: 'character_epithet', aliases: ['King'], evidence: 'The King looked at Max and remained silent.' }],
        relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [],
        characterVoices: [], relationshipVoiceRules: [], voiceAnchors: [],
      },
    }), /literary-memory|文学记忆必须通过项目的/);

    assert.throws(() => store.createRun(project.projectId, {
      scope: { type: 'all' },
      prompt: {
        translationMode: 'literary', sourceLang: 'en', targetLang: 'zh',
        literaryMemory: {
          entities: [{ source: 'The King', target: '大王', kind: 'character_epithet', aliases: ['King'], evidence: 'The King looked at Max and remained silent.' }],
        },
      },
    }), /literary-memory|文学记忆必须通过项目的/);

    const after = store.getCurrentLiteraryMemory(project.projectId);
    assert.equal(after.memoryRevisionId, before.memoryRevisionId);
    assert.equal(after.memory.entities[0]?.target, '国王');
  });
});


test('literary preprocessing readiness guard also rejects stale-running preprocessing before a resumed Run can restart', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Resume Preprocessing Guard',
      format: 'txt',
      sourceFileName: 'resume-preprocessing-guard.txt',
      segments,
      prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    });
    ensureTestContextGraph(store, project);
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.setRunStatus(project.projectId, run.runId, 'paused');

    const { db, currentSourceRevisionId } = store.getProjectContext(project.projectId);
    db.prepare(
      "UPDATE context_graph_runs SET status = 'running', phase = 'model-analysis', progress_json = ? WHERE source_revision_id = ?",
    ).run(JSON.stringify({
      analysisVersion: 'context-graph-v5-language-pinned',
      sourceLang: 'en',
      targetLang: 'zh',
    }), currentSourceRevisionId);

    assert.throws(
      () => store.assertLiteraryPreprocessingReady(project.projectId, run.sourceRevisionId, 'en', 'zh'),
      /全书预处理仍在运行/,
    );

    db.prepare(
      "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', progress_json = ? WHERE source_revision_id = ?",
    ).run(JSON.stringify({
      analysisVersion: 'context-graph-v5-language-pinned',
      sourceLang: 'en',
      targetLang: 'ja',
    }), currentSourceRevisionId);
    assert.throws(
      () => store.assertLiteraryPreprocessingReady(project.projectId, run.sourceRevisionId, 'en', 'zh'),
      /全书预处理语言与当前翻译配置不一致/,
    );
  });
});


test('new literary runs are queued before the server-owned preprocessing gate', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Missing Literary Preprocessing',
      format: 'epub',
      sourceFileName: 'missing-literary-preprocessing.epub',
      segments,
      prompt: { translationMode: 'literary', sourceLang: 'en', targetLang: 'zh' },
    });

    // The HTTP/API layer must first persist the Run. executeRun owns starting/waiting for
    // Context Graph and does not translate until source revision, version and language match.
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(run.status, 'queued');
    assert.equal(run.translationMode, 'literary');
    assert.equal(run.sourceLang, 'en');
    assert.equal(run.targetLang, 'zh');
    assert.equal(store.getRun(project.projectId, run.runId).status, 'queued');
  });
});


test('legacy imported literary translations remain visible but are stale under the current enforcement pipeline', async () => {
  await withStore((store) => {
    const project = store.createProject({
      title: 'Legacy Literary Import',
      format: 'epub',
      sourceFileName: 'legacy-literary.epub',
      segments,
      prompt: {
        translationMode: 'literary',
        literaryReview: true,
        sourceLang: 'en',
        targetLang: 'zh',
        provider: 'workbuddy',
        model: 'auto',
      },
    });
    ensureTestContextGraph(store, project);
    const imported = store.importAcceptedTranslations(project.projectId, [
      { id: 'ch1-p1', text: '旧版本中的不一致称谓。' },
      { id: 'ch1-p2', text: '旧版本中的另一段译文。' },
    ]);
    assert.deepEqual(imported, { imported: 2, skipped: 0 });
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '旧版本中的不一致称谓。',
      'legacy text stays visible and recoverable until regenerated',
    );
    const verification = store.verifyProject(project.projectId);
    assert.deepEqual(verification.stalePromptIds.sort(), ['ch1-p1', 'ch1-p2']);
    const staleRun = store.createRun(project.projectId, { scope: { type: 'stale' } });
    assert.equal(staleRun.counts.total, 2,
      'the stale scope must select every imported literary translation for the current protected pipeline');
  });
});


test('batch candidate commit is atomic and refuses writes after cancellation', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Atomic Candidate Commit', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    const db = new DatabaseSync(path.join(store.rootDir, project.projectId, 'project.sqlite'));
    try {
      assert.throws(
        () => store.saveCandidates(project.projectId, run.runId, [
          { segmentId: 'ch1-p1', text: '第一个候选。' },
          { segmentId: 'not-in-run', text: '不应写入。' },
        ]),
        /不属于本次运行/,
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM translation_results WHERE run_id = ?').get(run.runId).count),
        0,
        'a batch containing an invalid segment must leave no partial result rows',
      );

      store.setRunStatus(project.projectId, run.runId, 'cancelled', '用户请求停止');
      assert.equal(
        store.saveCandidates(project.projectId, run.runId, [
          { segmentId: 'ch1-p1', text: '迟到的候选。' },
          { segmentId: 'ch1-p2', text: '另一条迟到候选。' },
        ]),
        false,
        'cancellation must be authoritative at the transactional commit boundary',
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM translation_results WHERE run_id = ?').get(run.runId).count),
        0,
        'no candidate may be persisted after cancellation',
      );
      assert.deepEqual(
        store.getRun(project.projectId, run.runId).segments.map((item) => item.status),
        ['pending', 'pending'],
        'a rejected late commit must not alter segment states',
      );
    } finally {
      db.close();
    }
  });
});

test('batch candidate commit persists all valid rows and individual writes share the same active-run guard', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Batch Candidate Commit', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    assert.equal(store.saveCandidates(project.projectId, run.runId, [
      { segmentId: 'ch1-p1', text: '门开着。' },
      { segmentId: 'ch1-p2', text: '没有人进来。' },
    ]), true);
    assert.deepEqual(
      store.getRun(project.projectId, run.runId).segments.map((item) => item.status),
      ['candidate', 'candidate'],
    );

    store.setRunStatus(project.projectId, run.runId, 'cancelled', '用户请求停止');
    assert.throws(
      () => store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '不能覆盖的迟到结果。'),
      /拒绝保存迟到的候选译文/,
    );
    assert.equal(
      store.getRun(project.projectId, run.runId).segments[0].candidateTranslation,
      '门开着。',
      'the single-item convenience method must not bypass batch-level cancellation guards',
    );
  });
});


test('Reviewer candidate revisions and findings commit together and cannot persist after cancellation', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Atomic Review Commit', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidates(project.projectId, run.runId, [
      { segmentId: 'ch1-p1', text: '原始候选译文。' },
      { segmentId: 'ch1-p2', text: '第二段候选译文。' },
    ]);
    const db = new DatabaseSync(path.join(store.rootDir, project.projectId, 'project.sqlite'));
    try {
      const finding = {
        id: 'ch1-p1',
        category: 'accuracy',
        reason: '当前译文有可核验的漏译。',
        sourceExcerpt: 'The door was open.',
        draftExcerpt: '门关着。',
      };
      assert.equal(store.saveCandidates(
        project.projectId,
        run.runId,
        [{ segmentId: 'ch1-p1', text: '门开着。' }],
        [{ segmentId: 'ch1-p1', finding }],
      ), true);
      assert.equal(
        store.getRun(project.projectId, run.runId).segments.find((item) => item.id === 'ch1-p1')?.candidateTranslation,
        '门开着。',
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ?').get(run.runId).count),
        1,
        'the review finding and the corrected candidate are committed together',
      );

      store.setRunStatus(project.projectId, run.runId, 'cancelled', '用户请求停止');
      const candidatesBefore = Number(
        db.prepare('SELECT COUNT(*) AS count FROM translation_results WHERE run_id = ?').get(run.runId).count,
      );
      assert.equal(store.saveCandidates(
        project.projectId,
        run.runId,
        [{ segmentId: 'ch1-p2', text: '不应写入的迟到修订。' }],
        [{ segmentId: 'ch1-p2', finding: { category: 'accuracy', reason: '迟到建议。' } }],
      ), false);
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM translation_results WHERE run_id = ?').get(run.runId).count),
        candidatesBefore,
        'a canceled run cannot persist a late Reviewer correction',
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ?').get(run.runId).count),
        1,
        'a canceled run cannot persist a late finding either',
      );
    } finally {
      db.close();
    }
  });
});


test('candidate acceptance cannot commit after a Run has been cancelled', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Cancel Before Accept', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidates(project.projectId, run.runId, [
      { segmentId: 'ch1-p1', text: '门敞开着。' },
      { segmentId: 'ch1-p2', text: '没有人进来。' },
    ]);
    store.finishRun(project.projectId, run.runId);
    store.setRunStatus(project.projectId, run.runId, 'cancelled', '用户请求停止');

    assert.throws(
      () => store.acceptCandidates(project.projectId, run.runId),
      /不能采纳候选译文/,
      'acceptance must re-check the authoritative Run status inside the transaction',
    );
    const db = new DatabaseSync(path.join(store.rootDir, project.projectId, 'project.sqlite'));
    try {
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS count FROM translation_results WHERE run_id = ? AND accepted = 1').get(run.runId).count),
        0,
        'a cancelled Run must not accept any candidate translation',
      );
      assert.equal(store.getRunStatus(project.projectId, run.runId), 'cancelled',
        'a late accept request must not transition the Run back to completed');
    } finally {
      db.close();
    }
  });
});


test('style proposal cannot overwrite a manual edit saved after the finding', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Stale Style Proposal', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveFinding(project.projectId, run.runId, 'ch1-p1', {
      category: 'style',
      priority: 'optional',
      reason: '可略微调整节奏。',
      sourceExcerpt: 'The door was open.',
      draftExcerpt: '门开着。',
      proposedTranslation: '门敞开着。',
      applicationStatus: 'pending',
    });
    store.finishRun(project.projectId, run.runId);
    store.saveManualEdit(project.projectId, 'ch1-p1', '人工最终修订：门仍敞开着。');

    assert.throws(
      () => store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'apply'),
      /已有译文被采纳或人工修改/,
      'the stale suggestion must be rejected using a fresh check inside the write transaction',
    );
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '人工最终修订：门仍敞开着。',
    );
  });
});

test('style proposal cannot overwrite a newer accepted Agent translation', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Stale Agent Translation', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveFinding(project.projectId, run.runId, 'ch1-p1', {
      category: 'style',
      priority: 'optional',
      reason: '可略微调整节奏。',
      sourceExcerpt: 'The door was open.',
      draftExcerpt: '门开着。',
      proposedTranslation: '门敞开着。',
      applicationStatus: 'pending',
    });
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    assert.throws(
      () => store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'apply'),
      /已有译文被采纳或人工修改/,
      'an accepted translation newer than the finding must take precedence over its old proposal',
    );
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '门开着。',
    );
  });
});


test('Run status transitions cannot revive cancelled or completed runs', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Monotonic Run Status', format: 'epub', segments });
    const cancelled = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    assert.equal(store.setRunStatus(project.projectId, cancelled.runId, 'cancelled', '用户请求停止'), true);
    assert.equal(store.setRunStatus(project.projectId, cancelled.runId, 'running', null), false);
    assert.equal(store.markRunSegments(project.projectId, cancelled.runId, ['ch1-p1'], 'running'), false,
      'a stale batch must not mark segments running after cancellation');
    store.finishRun(project.projectId, cancelled.runId);
    assert.equal(store.getRunStatus(project.projectId, cancelled.runId), 'cancelled',
      'finishRun must not overwrite a cancellation that already committed');

    const completed = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p2'] } });
    assert.equal(store.setRunStatus(project.projectId, completed.runId, 'completed', null), true);
    assert.equal(store.setRunStatus(project.projectId, completed.runId, 'running', null), false);
    assert.equal(store.getRunStatus(project.projectId, completed.runId), 'completed',
      'a stale resume/worker call must not reopen a completed Run');
  });
});


test('Run recovery after store re-open preserves candidate revisions and never reopens a terminal Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vocal-doc-restart-'));
  try {
    const firstStore = new DocumentProjectStore(root);
    const project = firstStore.createProject({
      title: 'Restart recovery', format: 'epub', sourceFileName: 'restart.epub', segments,
    });
    ensureTestContextGraph(firstStore, project);
    const run = firstStore.createRun(project.projectId, { scope: { type: 'all' } });
    firstStore.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门仍然开着。');
    firstStore.markRunSegments(project.projectId, run.runId, ['ch1-p1'], 'running');
    firstStore.setRunStatus(project.projectId, run.runId, 'running', null);

    // Simulate a fresh process: constructor recovery must fail the interrupted Run,
    // return in-flight segments to retryable state, and retain durable candidate text.
    const restartedStore = new DocumentProjectStore(root);
    const recovered = restartedStore.getRun(project.projectId, run.runId);
    assert.equal(recovered.status, 'failed',
      'an interrupted running Run must be marked recoverable rather than left falsely running');
    assert.equal(recovered.runId, run.runId);
    const recoveredSegment = restartedStore.getSegments(project.projectId, { limit: 10, runId: run.runId })
      .find((item) => item.id === 'ch1-p1');
    assert.equal(
      recoveredSegment?.candidateTranslation,
      '门仍然开着。',
      'candidate translation must remain available after service restart',
    );
    assert.ok(recoveredSegment, 'the completed segment must still be present after restart');

    assert.equal(restartedStore.setRunStatus(project.projectId, run.runId, 'cancelled', 'user stop'), true);
    const afterCancelRestart = new DocumentProjectStore(root);
    assert.equal(afterCancelRestart.setRunStatus(project.projectId, run.runId, 'queued', null), false);
    assert.equal(afterCancelRestart.getRunStatus(project.projectId, run.runId), 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('Chinese monolingual style proposals cannot be applied before bilingual verification', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Chinese Editorial Gate', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveCandidate(project.projectId, run.runId, 'ch1-p1', '门开着。');
    store.saveFinding(project.projectId, run.runId, 'ch1-p1', {
      category: 'style',
      priority: 'optional',
      editorialMode: 'chinese-monolingual',
      bilingualReviewStatus: 'pending',
      reason: '中文表达可以更自然。',
      targetExcerpt: '门开着。',
      proposedTranslation: '门敞开着。',
      applicationStatus: 'pending',
    });

    assert.throws(
      () => store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'apply'),
      /尚未完成双语忠实度复核/,
      'a target-only edit must not be accepted before source-based verification',
    );

    assert.equal(store.markChineseEditorialFindingsReviewed(project.projectId, run.runId, [{
      segmentId: 'ch1-p1',
      status: 'corrected',
      proposedTranslation: '门仍然敞开着。',
    }]), true);

    const verifiedRun = store.getRun(project.projectId, run.runId);
    assert.equal(verifiedRun.findings[0].finding.applicationStatus, 'applied',
      'a Chinese edit that passed bilingual verification must be applied automatically');
    assert.equal(verifiedRun.findings[0].finding.applicationMethod, 'automatic-bilingual-verification');
    assert.equal(verifiedRun.segments.find((item) => item.id === 'ch1-p1')?.candidateTranslation, '门仍然敞开着。',
      'the verified edit must replace the Run candidate without a manual apply click');

    store.finishRun(project.projectId, run.runId);
    const accepted = store.acceptCandidates(project.projectId, run.runId);
    assert.equal(accepted.status, 'completed');
    assert.equal(
      store.getSegments(project.projectId, { limit: 10 }).find((item) => item.id === 'ch1-p1')?.acceptedTranslation,
      '门仍然敞开着。',
    );
  });
});

test('Chinese monolingual style proposal remains blocked when bilingual review did not complete', async () => {
  await withStore((store) => {
    const project = store.createProject({ title: 'Unverified Chinese Editorial', format: 'epub', segments });
    const run = store.createRun(project.projectId, { scope: { type: 'ids', ids: ['ch1-p1'] } });
    store.saveFinding(project.projectId, run.runId, 'ch1-p1', {
      category: 'style',
      priority: 'optional',
      editorialMode: 'chinese-monolingual',
      bilingualReviewStatus: 'pending',
      reason: '待双语复核。',
      targetExcerpt: '门开着。',
      proposedTranslation: '门敞开着。',
    });
    store.finishRun(project.projectId, run.runId);
    assert.throws(
      () => store.setReviewFindingDisposition(project.projectId, run.runId, 1, 'apply'),
      /尚未完成双语忠实度复核/,
    );
  });
});


test('default-adopted Chinese editorial profile retains surviving accepted evidence', async () => {
  await withStore((store) => {
    const profileSegments = [
      { id: 'ed-p1', text: 'The room was quiet.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'ed-p2', text: 'She looked away.', kind: 'paragraph', contextPath: 'Chapter 1' },
      { id: 'ed-p3', text: 'He did not answer.', kind: 'paragraph', contextPath: 'Chapter 2' },
    ];
    const project = store.createProject({
      title: 'Editorial Profile Evidence',
      format: 'epub',
      segments: profileSegments,
      prompt: { systemPrompt: 'Translate.', sourceLang: 'en', targetLang: 'zh-CN', provider: 'workbuddy', model: 'auto', translationMode: 'literary' },
    });
    const run = store.createRun(project.projectId, { scope: { type: 'all' } });
    store.saveCandidate(project.projectId, run.runId, 'ed-p1', '房间里很安静。');
    store.saveCandidate(project.projectId, run.runId, 'ed-p2', '她移开了目光。');
    store.saveCandidate(project.projectId, run.runId, 'ed-p3', '他没有回答。');
    store.finishRun(project.projectId, run.runId);
    store.acceptCandidates(project.projectId, run.runId);

    const revisionId = store.getProjectContext(project.projectId).currentSourceRevisionId;
    const profile = {
      version: 1,
      status: 'confirmed',
      confirmationSource: 'model-default',
      sourceRevisionId: revisionId,
      analysisVersion: 'chinese-editorial-profile-v1',
      sampleFingerprint: 'sample-fingerprint',
      sampleCount: 3,
      chapterCount: 2,
      generatedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      profile: {
        narrativeVoice: '叙述克制。',
        register: '现代书面语。',
        rhythm: '保留自然停顿。',
        dialogue: '',
        diction: '',
        rules: ['不机械拆短句。'],
        avoid: [],
      },
      evidenceRefs: [
        { segmentId: 'ed-p1', targetExcerpt: '房间里很安静', observation: '表达简洁克制。', aspect: 'narrativeVoice' },
        { segmentId: 'ed-p2', targetExcerpt: '移开了目光', observation: '动作描写直接。', aspect: 'diction' },
        { segmentId: 'ed-p3', targetExcerpt: '他没有回答', observation: '保留简洁叙述。', aspect: 'register' },
      ],
    };
    const saved = store.saveLiteraryMemory(project.projectId, { chineseEditorialProfile: profile });
    assert.equal(store.getCurrentLiteraryMemory(project.projectId).memory.chineseEditorialProfile.status, 'confirmed');

    const invalidated = store.saveLiteraryMemory(project.projectId, {
      chineseEditorialProfile: {
        ...profile,
        evidenceRefs: profile.evidenceRefs.map((item, index) =>
          index === 0 ? { ...item, targetExcerpt: '这段话并不存在' } : item),
      },
    });
    const current = store.getCurrentLiteraryMemory(project.projectId).memory.chineseEditorialProfile;
    assert.equal(current.status, 'confirmed');
    assert.equal(current.confirmationSource, 'model-default');
    assert.equal(current.evidenceRefs.length, 2);
    assert.notEqual(invalidated.memoryRevisionId, saved.memoryRevisionId);
  });
});
