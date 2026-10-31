import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonl,
  validateBenchmarkDataset,
  summarizeEditorOutput,
  buildBlindReviewPacket,
} from '../scripts/run-chinese-literary-benchmark.mjs';

const rows = [
  {
    id: 'p1',
    source: 'And my body remembered the past.',
    draft: '而我的身体记得过去。',
    genre: 'memoir',
    targetLang: 'zh-CN',
    rights: { basis: 'public-domain', reference: 'Public-domain test fixture' },
  },
  {
    id: 'p2',
    source: 'She did not answer.',
    draft: '她没有回答。',
    genre: 'novel',
    targetLang: 'zh-CN',
    rights: { basis: 'user-owned', reference: 'User-authored test fixture' },
  },
];

test('benchmark JSONL parser and dataset validator enforce rights and stable IDs', () => {
  const parsed = parseJsonl(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(validateBenchmarkDataset(parsed, { allowSmall: true }).length, 2);
  assert.throws(() => validateBenchmarkDataset([{ ...rows[0], rights: undefined }], { allowSmall: true }), /rights/);
  assert.throws(() => validateBenchmarkDataset([rows[0], rows[0]], { allowSmall: true }), /重复/);
  assert.throws(() => validateBenchmarkDataset([{ ...rows[0], targetLang: 'en' }], { allowSmall: true }), /中文目标语言/);
});

test('benchmark editor summary separates changed and unchanged segments', () => {
  const summary = summarizeEditorOutput(rows, {
    translations: { p1: '而我的身体，仍记得过去。', p2: '她没有回答。' },
    findings: [{ editingAspect: 'rhythm' }, { editingAspect: 'rhythm' }, { editingAspect: 'diction' }],
  });
  assert.equal(summary.reviewedCount, 2);
  assert.equal(summary.editedCount, 1);
  assert.equal(summary.unchangedCount, 1);
  assert.equal(summary.editRatePercent, 50);
  assert.deepEqual(summary.editingAspectCounts, { rhythm: 2, diction: 1 });
});

test('blind review packet hides model identity and keeps source for fidelity assessment', () => {
  const first = { translations: { p1: '候选甲。', p2: '她并未回答。' } };
  const second = { translations: { p1: '候选乙。', p2: '她没有回答。' } };
  const result = buildBlindReviewPacket(rows, first, second, true);
  assert.equal(result.mapping.candidateA, 'second');
  assert.equal(result.packet.items[0].candidateA, '候选乙。');
  assert.equal(result.packet.items[0].candidateB, '候选甲。');
  assert.equal(result.packet.items[0].source, rows[0].source);
  assert.doesNotMatch(JSON.stringify(result.packet), /model-a|model-b|workbuddy|opencode/);
});
