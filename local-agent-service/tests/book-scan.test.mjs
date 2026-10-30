import test from 'node:test';
import assert from 'node:assert/strict';
import { planBookSamples, scanBookSegments, scanBookSegmentsConcurrent } from '../src/documents/bookScan.ts';

function makeSegments() {
  const segments = [];
  for (let index = 0; index < 90; index++) {
    const chapter = Math.floor(index / 10) + 1;
    let text = 'A quiet passage leads deeper into the archive.';
    if (index % 4 === 0) text = 'Mara spoke to Iven: “Keep the western lamp burning.”';
    if (index % 7 === 0) text = 'Captain Vale asked Mara about the western lamp.';
    if ([3, 43, 83].includes(index)) text = 'Keep the western lamp burning before the last door opens.';
    segments.push({
      id: 'seg-' + String(index + 1).padStart(3, '0'),
      ordinal: index,
      contextPath: 'Chapter ' + chapter,
      kind: text.includes('“') ? 'dialogue' : 'paragraph',
      text,
    });
  }
  return segments;
}

test('book scan covers every chapter and ranks candidates across the full source', () => {
  const segments = makeSegments();
  const scan = scanBookSegments(segments);
  assert.equal(scan.segmentCount, 90);
  assert.equal(scan.chapterCount, 9);
  assert.equal(scan.chapters[0].firstSegmentId, 'seg-001');
  assert.equal(scan.chapters[8].lastSegmentId, 'seg-090');
  assert.ok(scan.dialogueSegmentCount > 10);
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Mara'));
  assert.ok(scan.repeatedPhrases.some((phrase) => phrase.count >= 3));
});

test('adaptive sampling keeps book endpoints and adds early/middle/late samples for recurring characters', () => {
  const segments = makeSegments();
  const plan = planBookSamples(segments, scanBookSegments(segments), 60);
  const selectedIds = new Set(plan.samples.map((item) => item.segment.id));
  assert.ok(selectedIds.has('seg-001'));
  assert.ok(selectedIds.has('seg-046') || selectedIds.has('seg-045'));
  assert.ok(selectedIds.has('seg-090'));
  const maraSamples = plan.samples.filter((item) => item.reasons.some((reason) => reason.endsWith(':Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-early:Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-middle:Mara')));
  assert.ok(maraSamples.some((item) => item.reasons.includes('entity-late:Mara')));
  assert.ok(plan.diagnostics.selectedSampleCount <= 60);
  assert.ok(plan.diagnostics.targetedNameCount > 0);
});

test('sampling is deterministic, bounded, and records why each segment was selected', () => {
  const segments = makeSegments();
  const first = planBookSamples(segments, undefined, 48);
  const second = planBookSamples(segments, undefined, 48);
  assert.deepEqual(first.samples, second.samples);
  assert.ok(first.samples.length <= 48);
  assert.ok(first.samples.every((sample) => sample.reasons.length > 0));
  assert.ok(first.samples.some((sample) => sample.reasons.some((reason) => reason.startsWith('dialogue-density:'))));
  assert.ok(first.samples.some((sample) => sample.reasons.some((reason) => reason.startsWith('repeated-phrase:'))));
});

test('short documents keep all source segments and do not truncate the sample set', () => {
  const segments = makeSegments().slice(0, 12);
  const plan = planBookSamples(segments);
  assert.equal(plan.samples.length, segments.length);
  assert.ok(plan.samples.every((sample) => sample.reasons.includes('complete-short-document')));
});

test('English source scan detects repeated quoted dialogue despite changing speaker attribution', () => {
  const segments = [
    {
      id: 'en-1', ordinal: 0, contextPath: 'Chapter 1', kind: 'dialogue',
      text: '“Keep the western lamp burning.” Mara said to Iven.',
    },
    {
      id: 'en-2', ordinal: 12, contextPath: 'Chapter 2', kind: 'dialogue',
      text: 'Mara repeated the warning: “Keep the western lamp burning.”',
    },
    {
      id: 'en-3', ordinal: 24, contextPath: 'Chapter 7', kind: 'dialogue',
      text: '“Keep the western lamp burning,” Mara whispered as she left.',
    },
  ];
  const scan = scanBookSegments(segments);
  const repeatedLine = scan.repeatedPhrases.find((phrase) =>
    phrase.normalized === 'keep the western lamp burning');
  assert.ok(repeatedLine);
  assert.equal(repeatedLine.count, 3);
  assert.equal(repeatedLine.chapterKeys.length, 3);
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Mara'));
});

test('English scan retains recurring full names as separate sampling candidates', () => {
  const segments = [
    { id: 'name-1', ordinal: 0, contextPath: 'Chapter 1', text: 'Mara Voss entered the archive before dawn.' },
    { id: 'name-2', ordinal: 4, contextPath: 'Chapter 3', text: 'Mara spoke with Iven near the western lamp.' },
    { id: 'name-3', ordinal: 8, contextPath: 'Chapter 5', text: 'Mara Voss returned the brass key to Vale.' },
    { id: 'name-4', ordinal: 12, contextPath: 'Chapter 8', text: 'Mara Voss told Iven to leave before midnight.' },
  ];
  const scan = scanBookSegments(segments);
  const fullName = scan.nameCandidates.find((candidate) => candidate.name === 'Mara Voss');
  assert.ok(fullName);
  assert.equal(fullName.mentions, 3);
  assert.equal(fullName.chapterCount, 3);
  assert.equal(fullName.regionCount, 3);
});

test('repeated-phrase sampling selects the true final occurrence beyond the bounded ID preview', () => {
  const segments = Array.from({ length: 120 }, (_, index) => ({
    id: 'long-' + String(index + 1).padStart(3, '0'),
    ordinal: index,
    contextPath: 'Chapter ' + (Math.floor(index / 10) + 1),
    kind: 'dialogue',
    text: index % 5 === 3
      ? 'A traveller whispered: “Keep the western lamp burning.”'
      : 'A traveller walked quietly through the archive corridor.',
  }));
  const scan = scanBookSegments(segments);
  const phrase = scan.repeatedPhrases.find((item) => item.normalized === 'keep the western lamp burning');
  assert.ok(phrase);
  assert.equal(phrase.firstSegmentId, 'long-004');
  assert.equal(phrase.lastSegmentId, 'long-119');
  assert.equal(phrase.segmentIdsTruncated, true);
  assert.ok(!phrase.segmentIds.includes('long-119'), 'bounded preview must not silently claim to contain the last occurrence');

  const plan = planBookSamples(segments, scan, 72);
  const finalOccurrence = plan.samples.find((sample) => sample.segment.id === 'long-119');
  assert.ok(finalOccurrence);
  assert.ok(finalOccurrence.reasons.includes('repeated-phrase:last'));
});


test('compound titles retain articles and expose source-positioned entity, dialogue, sentence, and quantity features', () => {
  const segments = [
    {
      id: 'king-early', ordinal: 10, contextPath: 'Chapter 1', kind: 'paragraph',
      text: 'The King Rat watched Max. The King raised his hand and spoke to Max.',
    },
    {
      id: 'king-later', ordinal: 30, contextPath: 'Chapter 5', kind: 'dialogue',
      text: 'Captain Vale whispered: “The King Rat has returned.” It will take twenty-four hours. He added, \'Keep watch for twelve hours.\'',
    },
  ];
  const scan = scanBookSegments(segments);
  const compound = scan.nameCandidates.find((candidate) => candidate.name === 'The King Rat');
  assert.ok(compound, 'a leading article must not cause the entire compound candidate to be dropped');
  assert.equal(compound.mentions, 2);
  assert.equal(compound.tokenCount, 2, 'The should be removed as an article without stripping the next token King');
  const articleTitle = scan.entityMentions.find((mention) => mention.segmentId === 'king-early' && mention.surface === 'The King');
  assert.ok(articleTitle);
  assert.equal(segments[0].text.slice(articleTitle.start, articleTitle.end), 'The King');
  const titledName = scan.entityMentions.find((mention) => mention.segmentId === 'king-later' && mention.surface === 'Captain Vale');
  assert.ok(titledName);
  assert.equal(segments[1].text.slice(titledName.start, titledName.end), 'Captain Vale');
  assert.ok(scan.textUnits.some((unit) => unit.unitType === 'quotation' &&
    segments.find((segment) => segment.id === unit.segmentId).text.slice(unit.start, unit.end) === 'The King Rat has returned.'));
  assert.ok(scan.textUnits.some((unit) => unit.unitType === 'quotation' &&
    segments.find((segment) => segment.id === unit.segmentId).text.slice(unit.start, unit.end) === 'Keep watch for twelve hours.'));
  const quantity = scan.quantityMentions.find((mention) => mention.surface === 'twenty-four hours');
  assert.ok(quantity);
  assert.equal(quantity.unit, 'hour');
  assert.equal(segments[1].text.slice(quantity.start, quantity.end), quantity.surface);
  assert.ok(scan.dialogueIndex.some((item) => item.segmentId === 'king-later' && item.signals.includes('quotation')));
  assert.ok(scan.indexDiagnostics.entityMentionCount >= scan.entityMentions.length);
});


test('worker-parallel book scan is byte-for-byte equivalent to serial scan and preserves source ordering', async () => {
  const segments = makeSegments().slice().reverse();
  const options = {
    maxEntityMentions: 500,
    maxTextUnits: 700,
    maxQuantityMentions: 250,
    maxRepeatedPhraseSegmentIds: 8,
    maxRepeatedPhraseGroups: 40,
  };
  const serial = scanBookSegments(segments, options);
  const parallel = await scanBookSegmentsConcurrent(segments, options, 3);
  assert.deepEqual(parallel, serial);
});


test('French, German and Italian book scans identify localized dialogue and names', () => {
  const french = scanBookSegments([
    { id: 'fr-1', ordinal: 0, contextPath: 'Chapitre 1', text: 'Émile ouvrit la porte et sourit.' },
    { id: 'fr-2', ordinal: 1, contextPath: 'Chapitre 1', text: 'Émile regarda la fenêtre.' },
    { id: 'fr-3', ordinal: 2, contextPath: 'Chapitre 2', text: 'Émile revint avant la nuit.' },
    { id: 'fr-4', ordinal: 3, contextPath: 'Chapitre 2', text: '«Bonsoir», dit Émile.' },
  ], { sourceLang: 'fr' });
  assert.ok(french.nameCandidates.some((candidate) => candidate.name === 'Émile' && candidate.mentions >= 4));
  assert.ok(french.dialogueIndex.some((item) => item.segmentId === 'fr-4' && item.isDialogue));
  assert.ok(!french.nameCandidates.some((candidate) => candidate.name === 'Bonsoir'));

  const german = scanBookSegments([
    { id: 'de-1', ordinal: 0, contextPath: 'Kapitel 1', text: 'Herr Müller kam durch die Stadt.' },
    { id: 'de-2', ordinal: 1, contextPath: 'Kapitel 2', text: 'Herr Müller ging später nach Hause.' },
    { id: 'de-3', ordinal: 2, contextPath: 'Kapitel 2', text: '„Guten Tag“, sagte er.' },
    { id: 'de-4', ordinal: 3, contextPath: 'Kapitel 3', text: '— ich weiß nicht, antwortete Müller.' },
  ], { sourceLang: 'de' });
  assert.ok(german.nameCandidates.some((candidate) => candidate.name.includes('Müller')));
  assert.ok(!german.nameCandidates.some((candidate) => ['Stadt', 'Mann', 'Frau', 'Haus'].includes(candidate.name)));
  assert.ok(german.dialogueIndex.some((item) => item.segmentId === 'de-3' && item.isDialogue));
  assert.ok(german.dialogueIndex.some((item) => item.segmentId === 'de-4' && item.isDialogue));

  const italian = scanBookSegments([
    { id: 'it-1', ordinal: 0, contextPath: 'Capitolo 1', text: '«Buongiorno», disse Marco.' },
  ], { sourceLang: 'it' });
  assert.ok(italian.dialogueIndex[0].isDialogue);
});

test('Japanese source scan indexes honorific name candidates and Japanese dialogue marks', () => {
  const scan = scanBookSegments([
    { id: 'ja-1', ordinal: 0, contextPath: '第一章', text: '田中さんは静かに部屋へ入った。' },
    { id: 'ja-2', ordinal: 1, contextPath: '第一章', text: '田中さんは窓のそばに立った。' },
    { id: 'ja-3', ordinal: 2, contextPath: '第二章', text: '「田中さん、聞こえますか」と彼女は尋ねた。' },
  ], { sourceLang: 'ja' });
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === '田中'));
  assert.ok(scan.dialogueIndex.some((item) => item.segmentId === 'ja-3' && item.isDialogue));
});

test('localized quantity feature extraction covers French German Italian and Japanese', () => {
  const cases = [
    { sourceLang: 'fr', text: 'Il marcha trois mètres.' },
    { sourceLang: 'de', text: 'Er ging drei Meter.' },
    { sourceLang: 'it', text: 'Camminò tre metri.' },
    { sourceLang: 'ja', text: '三メートル歩いた。' },
  ];
  for (const [index, item] of cases.entries()) {
    const scan = scanBookSegments([{ id: 'quantity-' + index, ordinal: 0, text: item.text }], { sourceLang: item.sourceLang });
    assert.ok(scan.quantityMentions.some((mention) => mention.unit === 'meter'), item.sourceLang + ' quantity should be indexed');
  }
});

test('Spanish source scan recognizes titled compound names, dialogue, quantities and auto language detection', () => {
  const scan = scanBookSegments([
    { id: 'es-1', ordinal: 0, contextPath: 'Capítulo 1', text: 'Don Quijote de la Mancha llegó al pueblo.' },
    { id: 'es-2', ordinal: 1, contextPath: 'Capítulo 1', text: 'Don Quijote de la Mancha miró a Sancho Panza.' },
    { id: 'es-3', ordinal: 2, contextPath: 'Capítulo 2', text: '«No lo sé», dijo Don Quijote.' },
    { id: 'es-4', ordinal: 3, contextPath: 'Capítulo 2', text: 'Caminó treinta y dos metros antes de volver.' },
    { id: 'es-5', ordinal: 4, contextPath: 'Capítulo 3', text: 'Tenía veintiún años.' },
  ], { sourceLang: 'es-ES' });
  assert.ok(scan.entityMentions.some((mention) => mention.surface === 'Don Quijote de la Mancha'));
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Don Quijote de la Mancha'));
  assert.ok(scan.nameCandidates.some((candidate) => candidate.name === 'Sancho Panza'));
  assert.ok(scan.dialogueIndex.some((item) => item.segmentId === 'es-3' && item.isDialogue && item.signals.includes('speech-verb')));
  assert.ok(scan.quantityMentions.some((item) => item.segmentId === 'es-4' && item.unit === 'meter'));
  assert.ok(scan.quantityMentions.some((item) => item.segmentId === 'es-5' && item.unit === 'year'));

  const auto = scanBookSegments([
    { id: 'es-auto', ordinal: 0, text: '¿Qué haces? —dijo Don Quijote.' },
  ], { sourceLang: 'auto' });
  assert.ok(auto.dialogueIndex.some((item) => item.segmentId === 'es-auto' && item.isDialogue),
    'Spanish punctuation and speech verbs should be recognized when sourceLang is auto');
});

test('parallel worker scan receives source language and matches serial output', async () => {
  const segments = [
    { id: 'worker-fr-1', ordinal: 0, text: 'Émile ouvrit la porte. «Bonjour», dit Émile.' },
    { id: 'worker-fr-2', ordinal: 1, text: 'Émile revint après trois mètres.' },
  ];
  const options = { sourceLang: 'fr' };
  assert.deepEqual(
    await scanBookSegmentsConcurrent(segments, options, 2),
    scanBookSegments(segments, options),
  );
});


test('German digit quantities are indexed once and greeting words are not person candidates', () => {
  const scan = scanBookSegments([
    { id: 'de-digit-1', ordinal: 0, contextPath: 'Kapitel 1', text: 'Er ging 3 Meter.' },
    { id: 'de-digit-2', ordinal: 1, contextPath: 'Kapitel 2', text: '„Guten Tag“, sagte er.' },
    { id: 'it-greeting', ordinal: 2, contextPath: 'Capitolo 1', text: '«Buongiorno», disse Marco.' },
  ], { sourceLang: 'de' });
  const quantity = scan.quantityMentions.filter((item) => item.segmentId === 'de-digit-1');
  assert.equal(quantity.length, 1);
  assert.equal(quantity[0].unit, 'meter');
  assert.ok(!scan.nameCandidates.some((candidate) => ['Guten Tag', 'Guten', 'Tag', 'Buongiorno'].includes(candidate.name)));
});
