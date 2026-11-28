import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TRANSLATION_SCHEMA } from '../src/documents/translationSchema.ts';
import { buildBatchOutputConstraint, parseTranslations } from '../src/documents/translationPrompt.ts';

test('translation schema stays a stable prefix with no per-batch ids or item counts', () => {
  const translations = TRANSLATION_SCHEMA.properties.translations;
  assert.equal(translations.minItems, undefined);
  assert.equal(translations.maxItems, undefined);
  assert.equal(translations.items.properties.id.enum, undefined);
});

test('batch output constraint puts exact ids and count at the end of the user prompt', () => {
  const constraint = buildBatchOutputConstraint([{ id: 'seg-a', text: 'A' }, { id: 'seg-b', text: 'B' }]);
  assert.match(constraint, /恰好包含 2 项/);
  assert.ok(constraint.includes('seg-a, seg-b'));
  assert.match(constraint, /precedingSegments/);
  assert.equal(buildBatchOutputConstraint([]), '');

  const source = readFileSync(new URL('../src/documents/translationBatchCall.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /buildTranslationSchema\(/);
  assert.match(source, /schema: TRANSLATION_SCHEMA/);
  assert.match(source, /systemPrompt, TRANSLATION_SCHEMA, requestId, sessionScope/);
  const assembly = source.slice(source.indexOf('const userPrompt ='), source.indexOf('const systemPrompt ='));
  assert.ok(assembly.indexOf('buildBatchOutputConstraint(items)') > assembly.indexOf('buildCanonicalMarkerReminder('));
});

test('duplicate output IDs are discarded so only the ambiguous segment is retried', () => {
  const parsed = parseTranslations({
    translations: [
      { id: 'seg-a', translated_text: '第一份结果' },
      { id: 'seg-a', translated_text: '第二份结果' },
      { id: 'seg-b', translated_text: '正常结果' },
    ],
  }, new Set(['seg-a', 'seg-b']));

  assert.equal(parsed.translations.has('seg-a'), false);
  assert.equal(parsed.translations.get('seg-b'), '正常结果');
  assert.deepEqual(parsed.diagnostics.duplicateSegmentIds, ['seg-a']);
  assert.equal(parsed.diagnostics.duplicateCount, 1);
});

test('unexpected IDs are ignored and missing IDs stay retriable', () => {
  const parsed = parseTranslations({
    translations: [
      { id: 'seg-a', translated_text: '正常结果' },
      { id: 'seg-c', translated_text: '越界结果' },
    ],
  }, new Set(['seg-a', 'seg-b']));

  assert.equal(parsed.translations.get('seg-a'), '正常结果');
  assert.equal(parsed.translations.has('seg-b'), false);
  assert.deepEqual(parsed.diagnostics.unexpectedOutputIds, ['seg-c']);
  assert.equal(parsed.diagnostics.unexpectedCount, 1);
});
