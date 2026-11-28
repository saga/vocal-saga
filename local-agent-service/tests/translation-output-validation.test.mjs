import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationSchema } from '../src/documents/translationSchema.ts';
import { parseTranslations } from '../src/documents/translationPrompt.ts';

test('translation schema is constrained to the current batch IDs and exact item count', () => {
  const schema = buildTranslationSchema(['seg-a', 'seg-b']);
  const translations = schema.properties.translations;
  assert.equal(translations.minItems, 2);
  assert.equal(translations.maxItems, 2);
  assert.deepEqual(translations.items.properties.id.enum, ['seg-a', 'seg-b']);
  assert.deepEqual(buildTranslationSchema(['seg-c']).properties.translations.items.properties.id.enum, ['seg-c']);
});

test('translation schema rejects empty, blank, and duplicate batch IDs', () => {
  assert.throws(() => buildTranslationSchema([]), /至少需要一个/);
  assert.throws(() => buildTranslationSchema(['seg-a', '']), /不能为空或重复/);
  assert.throws(() => buildTranslationSchema(['seg-a', 'seg-a']), /不能为空或重复/);
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
