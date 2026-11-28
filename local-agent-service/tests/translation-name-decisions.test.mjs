import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseAcceptedTranslationTarget,
  chooseFirstUseRunNameDecision,
  mergeRunNameDecisions,
} from '../src/documents/translationNameDecisions.ts';

function row(segmentId, translation, ordinal) {
  return {
    segmentId,
    sourceText: 'Tennent arrived.',
    translation,
    ordinal,
    sourceHash: 'source-hash-' + segmentId,
  };
}

test('accepted translation majority wins and records only distinct supporting segments', () => {
  const vote = chooseAcceptedTranslationTarget(
    ['坦嫩特', '坦南特'],
    [
      row('s1', '坦嫩特走进房间。', 1),
      row('s2', '坦南特看向门外。', 2),
      row('s3', '坦嫩特没有回答。', 3),
      row('s4', '坦嫩特转过身。', 4),
    ],
  );

  assert.equal(vote?.target, '坦嫩特');
  assert.equal(vote?.count, 3);
  assert.equal(vote?.firstOrdinal, 1);
  assert.deepEqual(vote?.rows.map((item) => item.segmentId), ['s1', 's3', 's4']);
  assert.ok(vote?.rows.every((item) => item.sourceText === 'Tennent arrived.'));
});

test('equal vote counts are resolved by earliest accepted source ordinal', () => {
  const vote = chooseAcceptedTranslationTarget(
    ['坦嫩特', '坦南特'],
    [
      row('later-first', '坦南特走进房间。', 9),
      row('earlier-second', '坦嫩特看向门外。', 3),
    ],
  );

  assert.equal(vote?.target, '坦嫩特');
  assert.equal(vote?.count, 1);
  assert.equal(vote?.firstOrdinal, 3);
});

test('a single accepted segment cannot cast duplicate votes for repeated occurrences', () => {
  const vote = chooseAcceptedTranslationTarget(
    ['坦嫩特'],
    [
      row('s1', '坦嫩特停下，坦嫩特回头。', 1),
      row('s1', '坦嫩特又说了一遍。', 1),
    ],
  );

  assert.equal(vote?.count, 1);
  assert.equal(vote?.rows.length, 1);
});

test('ambiguous accepted segments containing competing target surfaces do not vote', () => {
  const vote = chooseAcceptedTranslationTarget(
    ['坦嫩特', '坦南特'],
    [
      row('ambiguous', '坦嫩特看向坦南特。', 1),
    ],
  );

  assert.equal(vote, null);
});

test('unaccepted model proposals without accepted target evidence cannot create a decision', () => {
  const vote = chooseAcceptedTranslationTarget(
    ['特南特'],
    [
      row('s1', '他走进房间。', 1),
      row('s2', '门外传来脚步声。', 2),
    ],
  );

  assert.equal(vote, null);
});

test('first-use mapping is provisional and requires the target to survive in the reviewed candidate text', () => {
  const decision = chooseFirstUseRunNameDecision({
    source: 'Tennent',
    aliases: ['Mr. Tennent'],
    kind: 'person',
    targetLang: 'zh',
    targets: ['坦嫩特', '坦南特'],
    rows: [
      { ...row('s1', '坦嫩特走进房间。', 1), sourceHash: 'h1' },
      { ...row('s2', '他看向门外。', 2), sourceHash: 'h2' },
    ],
  });

  assert.equal(decision?.target, '坦嫩特');
  assert.equal(decision?.sourceStatus, 'run-canonical');
  assert.equal(decision?.decisionSource, 'first-use-provisional');
  assert.deepEqual(decision?.evidenceSegmentIds, ['s1']);
});

test('first-use mapping fails closed when one translation contains competing target variants', () => {
  const decision = chooseFirstUseRunNameDecision({
    source: 'Tennent',
    kind: 'person',
    targetLang: 'zh',
    targets: ['坦嫩特', '坦南特'],
    rows: [
      { ...row('s1', '坦嫩特与坦南特同时出现。', 1), sourceHash: 'h1' },
    ],
  });

  assert.equal(decision, null);
});

test('first-use mapping does not preserve an untranslated source name as a Chinese canonical target', () => {
  const decision = chooseFirstUseRunNameDecision({
    source: 'Tennent',
    kind: 'person',
    targetLang: 'zh',
    targets: ['Tennent'],
    rows: [
      { ...row('s1', 'Tennent 走进房间。', 1), sourceHash: 'h1' },
    ],
  });

  assert.equal(decision, null);
});

test('immutable user-confirmed snapshot overrides a provisional first-use mapping', () => {
  const merged = mergeRunNameDecisions(
    [{
      source: 'Tennent',
      aliases: [],
      target: '坦嫩特',
      kind: 'person',
      sourceStatus: 'confirmed-memory',
      decisionSource: 'user-confirmed-memory',
      decidedOrdinal: -1,
      evidenceSegmentIds: [],
    }],
    [{
      source: 'Tennent',
      aliases: [],
      target: '坦南特',
      kind: 'person',
      sourceStatus: 'run-canonical',
      decisionSource: 'first-use-provisional',
      decidedOrdinal: 7,
      evidenceSegmentIds: ['s7'],
    }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].target, '坦嫩特');
  assert.equal(merged[0].decisionSource, 'user-confirmed-memory');
});

test('first-use canonical mapping also stabilizes named vessels and other durable non-person entities', () => {
  const decision = chooseFirstUseRunNameDecision({
    source: 'Safina',
    aliases: ['the Safina'],
    kind: 'ship',
    targetLang: 'zh',
    targets: ['萨菲娜'],
    rows: [
      { ...row('ship-first', '萨菲娜驶入港口。', 1), sourceHash: 'ship-hash-1' },
    ],
  });

  assert.equal(decision?.kind, 'object', 'ship is normalized to the canonical object kind');
  assert.equal(decision?.target, '萨菲娜');
  assert.equal(decision?.sourceStatus, 'run-canonical');
  assert.equal(decision?.decisionSource, 'first-use-provisional');
  assert.deepEqual(decision?.evidenceSegmentIds, ['ship-first']);
});

test('ordinary/unknown kinds do not become run-wide canonical entity decisions', () => {
  const decision = chooseFirstUseRunNameDecision({
    source: 'Safina',
    kind: 'other',
    targetLang: 'zh',
    targets: ['萨菲娜'],
    rows: [
      { ...row('other-first', '萨菲娜驶入港口。', 1), sourceHash: 'other-hash-1' },
    ],
  });

  assert.equal(decision, null);
});

