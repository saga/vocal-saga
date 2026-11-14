import test from 'node:test';
import assert from 'node:assert/strict';

import { retainAcceptedEvidenceDeltas } from '../src/documents/translationRun.ts';

test('long-term literary memory only receives deltas backed by accepted translations', () => {
  const acceptedRows = [{
    segmentId: 'accepted-1',
    translation: '坦嫩特走进房间。',
    sourceText: 'Tennent entered the room.',
  }];
  const db = {
    prepare() {
      return { all() { return acceptedRows; } };
    },
  };
  const delta = {
    entityCandidates: [
      {
        localId: 'entity-1',
        canonicalSource: 'Tennent',
        aliases: [],
        kind: 'person',
        targetProposal: '坦嫩特',
        evidence: [{ segmentId: 'accepted-1', sourceQuote: 'Tennent entered the room.' }],
      },
      {
        localId: 'entity-2',
        canonicalSource: 'FutureName',
        aliases: [],
        kind: 'person',
        targetProposal: '未来人物',
        evidence: [{ segmentId: 'not-accepted', sourceQuote: 'FutureName appeared later.' }],
      },
    ],
    entityMentions: [
      {
        segmentId: 'accepted-1',
        sourceQuote: 'Tennent entered the room.',
        entityRef: 'entity-1',
        targetSurface: '坦嫩特',
      },
      {
        segmentId: 'accepted-1',
        sourceQuote: 'Tennent entered the room.',
        entityRef: 'entity-1',
        targetSurface: '错误译名',
      },
      {
        segmentId: 'not-accepted',
        sourceQuote: 'FutureName appeared later.',
        entityRef: 'entity-2',
        targetSurface: '未来人物',
      },
    ],
    relationshipDeltas: [
      {
        subjectSource: 'Tennent', predicate: 'entered', objectSource: 'room',
        evidence: [{ segmentId: 'accepted-1', sourceQuote: 'Tennent entered the room.' }],
      },
      {
        subjectSource: 'FutureName', predicate: 'knows', objectSource: 'Tennent',
        evidence: [{ segmentId: 'not-accepted', sourceQuote: 'FutureName appeared later.' }],
      },
    ],
    openQuestions: [
      { question: 'Who is Tennent?', evidence: [{ segmentId: 'accepted-1', sourceQuote: 'Tennent entered the room.' }] },
      { question: 'Who is FutureName?', evidence: [{ segmentId: 'not-accepted', sourceQuote: 'FutureName appeared later.' }] },
    ],
    conflicts: [],
  };

  const [result] = retainAcceptedEvidenceDeltas(db, 'revision-1', [delta]);
  assert.deepEqual(result.entityCandidates.map((item) => item.localId), ['entity-1']);
  assert.deepEqual(result.entityMentions.map((item) => item.targetSurface), ['坦嫩特']);
  assert.equal(result.relationshipDeltas.length, 1);
  assert.equal(result.openQuestions.length, 1);
});
