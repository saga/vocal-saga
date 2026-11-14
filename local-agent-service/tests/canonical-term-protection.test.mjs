import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUserPrompt } from '../src/documents/translationAgent.ts';
import {
  buildCanonicalTermProtections,
  buildCanonicalMarkerReminder,
  canonicalMarkerCountsMatch,
  describeCanonicalMarkerMismatch,
  maskCanonicalTermText,
  restoreCanonicalTermMarkers,
} from '../src/documents/canonicalTermProtection.ts';

const items = [{
  id: 's1',
  text: 'Yabu lay in the hot bath. Later, Yabu stirred.',
}];

const conflictingMappings = {
  nameMappings: [
    { source: 'Yabu', target: '矢部', aliases: [], kind: 'person', sourceStatus: 'confirmed' },
    { source: 'Yabu', target: '薮', aliases: [], kind: 'person', sourceStatus: 'confirmed-memory', confirmationSource: 'user-confirmed' },
  ],
};

test('confirmed LiteraryMemory target wins over a stale Context Graph target', () => {
  const protections = buildCanonicalTermProtections(items, conflictingMappings);

  assert.equal(protections.length, 1);
  assert.equal(protections[0].sourceForm, 'Yabu');
  assert.equal(protections[0].target, '薮');

  const masked = maskCanonicalTermText(items[0].text, protections);
  assert.equal(masked.split('__VSA_TERM_000__').length - 1, 2);
  assert.equal(canonicalMarkerCountsMatch(masked, masked, protections), true);
  assert.equal(
    canonicalMarkerCountsMatch(masked, items[0].text, protections),
    false,
    'a response without the markers must not pass canonical-name validation',
  );
  assert.equal(
    restoreCanonicalTermMarkers(masked, protections),
    '薮 lay in the hot bath. Later, 薮 stirred.',
  );
});

test('model-facing JSON masks the canonical name using the same TranslationBrief mapping', () => {
  const context = {
    project: { title: 'Test novel', format: 'epub' },
    run: { sourceLang: 'en', targetLang: 'zh', translationMode: 'literary' },
    prompt: { config: {} },
  };
  const brief = {
    contextGraph: { nameMappings: [
      { source: 'Yabu', target: '薮', aliases: [], kind: 'person', sourceStatus: 'confirmed-memory', confirmationSource: 'user-confirmed' },
    ] },
    precedingSegments: [],
    glossary: { document_terms: [] },
    contextHash: 'test',
  };

  const prompt = buildUserPrompt('{{CONTENT}}', items, context, [], brief.contextGraph, brief);
  const payload = JSON.parse(prompt);

  assert.match(payload.segments[0].text, /__VSA_TERM_000__/);
  assert.equal(payload.segments[0].text.includes('Yabu'), false);
  assert.equal(payload.contextGraph.nameMappings[0].target, '薮');

  const protections = buildCanonicalTermProtections(items, brief.contextGraph);
  assert.equal(
    restoreCanonicalTermMarkers(payload.segments[0].text, protections),
    '薮 lay in the hot bath. Later, 薮 stirred.',
  );
});

test('equally authoritative conflicting targets remain unprotected for explicit diagnosis', () => {
  const graph = {
    nameMappings: [
      { source: 'Yabu', target: '薮', aliases: [], sourceStatus: 'confirmed-memory' },
      { source: 'Yabu', target: '矢部', aliases: [], sourceStatus: 'confirmed-memory' },
    ],
  };

  assert.deepEqual(buildCanonicalTermProtections(items, graph), []);
});

test('marker mismatch reports expected vs actual counts so drop vs merge is distinguishable', () => {
  const protections = buildCanonicalTermProtections(items, conflictingMappings);
  const marker = protections[0].marker;
  const masked = maskCanonicalTermText(items[0].text, protections);
  assert.equal(canonicalMarkerCountsMatch(masked, masked, protections), true);
  assert.deepEqual(describeCanonicalMarkerMismatch(masked, masked, protections), []);

  // 模型把标记当普通词翻译掉了：expected=2 / actual=0
  const dropped = describeCanonicalMarkerMismatch(masked, '矢部 lay in the hot bath. Later, 矢部 stirred.', protections);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].expected, 2);
  assert.equal(dropped[0].actual, 0);
  assert.equal(dropped[0].sourceForm, 'Yabu');

  // 重复出现的标记被合并成一次：expected=2 / actual=1，处置方式与上一种不同
  const merged = describeCanonicalMarkerMismatch(masked, marker + ' lay in the hot bath. Later, 薮 stirred.', protections);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].expected, 2);
  assert.equal(merged[0].actual, 1);
});

test('marker reminder repeats the batch markers with their required occurrence counts', () => {
  const protections = buildCanonicalTermProtections(items, conflictingMappings);
  const masked = [maskCanonicalTermText(items[0].text, protections)];

  const reminder = buildCanonicalMarkerReminder(masked, protections);
  assert.match(reminder, /标记校验/);
  assert.ok(reminder.includes(protections[0].marker + '×2'), '必须给出本批实际的标记与次数');

  // 没有保护项、或本批压根没出现标记时不加噪音
  assert.equal(buildCanonicalMarkerReminder(masked, []), '');
  assert.equal(buildCanonicalMarkerReminder(['没有标记的文本'], protections), '');
});


test('candidate name proposals remain fail-closed and are not protected as canonical mappings', () => {
  const candidateGraph = {
    nameMappings: [
      { source: 'Yabu', target: '薮', aliases: [], kind: 'person', sourceStatus: 'candidate', confirmationSource: 'model-default' },
    ],
  };
  assert.deepEqual(buildCanonicalTermProtections(items, candidateGraph), []);
});

test('run-canonical decisions are protected within the run without becoming user-confirmed memory', () => {
  const runGraph = {
    nameMappings: [
      { source: 'Yabu', target: '薮', aliases: [], kind: 'person', sourceStatus: 'run-canonical', confirmationSource: 'model-default' },
    ],
  };
  const protections = buildCanonicalTermProtections(items, runGraph);
  assert.equal(protections.length, 1);
  assert.equal(protections[0].sourceForm, 'Yabu');
  assert.equal(protections[0].target, '薮');
});
