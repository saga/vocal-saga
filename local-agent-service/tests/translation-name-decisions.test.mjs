import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseAcceptedTranslationTarget } from '../src/documents/translationNameDecisions.ts';

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
