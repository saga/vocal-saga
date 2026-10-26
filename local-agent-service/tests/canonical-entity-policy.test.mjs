import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorthCanonicalEntityMapping,
  normalizeCanonicalEntityKind,
  splitCompoundCanonicalName,
  validateCanonicalTarget,
  canonicalTargetsConflict,
} from '../src/documents/canonicalEntityPolicy.ts';

test('normalizes model entity kinds into a small canonical vocabulary', () => {
  assert.equal(normalizeCanonicalEntityKind('clan'), 'organization');
  assert.equal(normalizeCanonicalEntityKind('country'), 'place');
  assert.equal(normalizeCanonicalEntityKind('work'), 'work');
  assert.equal(normalizeCanonicalEntityKind('term / language register'), 'other');
});

test('excludes common words and standard country names from book-specific entity memory', () => {
  for (const [source, kind] of [
    ['God', 'concept'], ['Japan', 'country'], ['England', 'place'],
    ['the Queen', 'other'], ['longitude', 'term'], ['pigeon', 'object'],
  ]) {
    assert.equal(isWorthCanonicalEntityMapping({ source, kind, mentions: 20, chapterCount: 10 }), false, source);
  }
  assert.equal(isWorthCanonicalEntityMapping({
    source: 'God of the Mountain', kind: 'concept', explicitBookSpecificMeaning: true, mentions: 1, chapterCount: 1, significance: 'A named faith-specific concept',
  }), true);
});

test('retains important fictional names and named groups', () => {
  assert.equal(isWorthCanonicalEntityMapping({ source: 'Minowara', kind: 'clan' }), true);
  assert.equal(isWorthCanonicalEntityMapping({ source: 'The Council of Regents', kind: 'organization' }), true);
});

test('does not keep one-off language register and glossary terms as canonical entities', () => {
  assert.equal(isWorthCanonicalEntityMapping({ source: 'Dozo', kind: 'term', mentions: 1, chapterCount: 1 }), false);
  assert.equal(isWorthCanonicalEntityMapping({ source: 'neh', kind: 'language register', mentions: 1, chapterCount: 1 }), false);
  assert.equal(isWorthCanonicalEntityMapping({ source: 'Ingeles', kind: 'term', mentions: 1, chapterCount: 1 }), false);
  assert.equal(isWorthCanonicalEntityMapping({
    source: 'God', kind: 'concept', mentions: 5, chapterCount: 3,
    significance: 'Central named religious concept', explicitBookSpecificMeaning: true,
  }), true);
});

test('splits list-style compound names but does not split actual slash names', () => {
  assert.deepEqual(splitCompoundCanonicalName('Dozo / neh / Ingeles')?.parts, ['Dozo', 'neh', 'Ingeles']);
  assert.deepEqual(splitCompoundCanonicalName('England／Netherlands／Spain')?.parts, ['England', 'Netherlands', 'Spain']);
  assert.equal(splitCompoundCanonicalName('AC/DC'), null);
  assert.equal(splitCompoundCanonicalName('OS/2'), null);
});

test('rejects malformed mixed-script and multi-target Chinese names', () => {
  assert.equal(validateCanonicalTarget({ source: 'Achiko', target: 'achi子', targetLang: 'zh', kind: 'person' }).reason, 'mixed-script-residue');
  assert.equal(validateCanonicalTarget({ source: 'Achiko', target: 'ACHI子', targetLang: 'zh', kind: 'person' }).reason, 'mixed-script-residue');
  assert.equal(validateCanonicalTarget({ source: 'Sire', target: '船长（敬称）／大人', targetLang: 'zh', kind: 'title' }).valid, false);
  assert.equal(validateCanonicalTarget({ source: 'Council', target: '御众（议和班）', targetLang: 'zh', kind: 'organization' }).reason, 'annotation-target');
});

test('detects conflicting canonical target proposals without choosing by order', () => {
  assert.equal(canonicalTargetsConflict('蓑原', '源氏'), true);
  assert.equal(canonicalTargetsConflict('蓑原', '蓑原'), false);
  assert.equal(canonicalTargetsConflict('', '蓑原'), false);
});

test('accepts natural Chinese names and approved acronym preservation', () => {
  assert.equal(validateCanonicalTarget({ source: 'Achiko', target: '阿千', targetLang: 'zh', kind: 'person' }).valid, true);
  assert.equal(validateCanonicalTarget({ source: 'DNA', target: 'DNA', targetLang: 'zh', kind: 'other' }).valid, true);
});
