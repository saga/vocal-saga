import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalTermProtections,
  buildUserPrompt,
  canonicalMarkerCountsMatch,
  maskCanonicalTermText,
  restoreCanonicalTermMarkers,
} from '../src/documents/translationAgent.ts';

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
