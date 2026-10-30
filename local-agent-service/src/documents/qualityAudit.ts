/**
 * Book-level deterministic quality audit and paired-run evaluation.
 *
 * Automated checks flag review targets; they do not assert literary correctness and never accept
 * or overwrite translations. Human blind review is recorded separately from deterministic metrics.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { scanBookSegments, type BookScanSegment, type RepeatedPhraseCandidate } from './bookScan.ts';
import { ensureSourceFeatureIndex, readSourceFeatureIndex, type StoredSourceFeatureIndex } from './contextGraph.ts';
import { getDocumentProjectStore } from './projectStore.ts';

const MAX_REPEATED_EXPRESSION_GROUPS = 300;
const MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING = 500;
const MAX_BULK_REPAIR_SEGMENTS = 100;

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function normalized(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedPhrase(value: unknown): string {
  return normalized(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function containsName(source: string, name: string): boolean {
  const candidate = normalized(name);
  if (!candidate) return false;
  if (/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(candidate)) {
    const haystack = ' ' + normalized(source).replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim() + ' ';
    const needle = candidate.replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return Array.from(candidate).length >= 2 && normalized(source).includes(candidate);
}

function targetPresent(translation: string, target: string): boolean {
  const latinTarget = /^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(target);
  if (latinTarget) {
    const haystack = ' ' + normalized(translation).replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim() + ' ';
    const needle = target.replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim();
    return !needle || haystack.includes(' ' + needle + ' ');
  }
  const needle = normalizedPhrase(target).replace(/\s+/g, '');
  if (!needle) return true;
  const haystack = normalizedPhrase(translation).replace(/\s+/g, '');
  return haystack.includes(needle);
}

const ENGLISH_NUMBER_VALUES: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
};
const ENGLISH_NUMBER_SCALES: Record<string, number> = {
  hundred:100, thousand:1_000, million:1_000_000, billion:1_000_000_000,
};
const ENGLISH_QUANTITY_UNITS = new Set([
  'inch','inches','foot','feet','mile','miles','hour','hours','minute','minutes','second','seconds',
  'day','days','week','weeks','month','months','year','years','degree','degrees','percent','percentage',
  'meter','meters','metre','metres','centimeter','centimeters','centimetre','centimetres','kilometer',
  'kilometers','kilometre','kilometres','pound','pounds','kilogram','kilograms','ounce','ounces',
  'liter','liters','litre','litres','side','sides','person','people','child','children','item','items',
  'key','keys','door','doors','step','steps','page','pages',
]);
const FRENCH_NUMBER_VALUES: Record<string, number> = {
  zéro:0, zero:0, un:1, une:1, deux:2, trois:3, quatre:4, cinq:5, six:6, sept:7, huit:8, neuf:9,
  dix:10, onze:11, douze:12, treize:13, quatorze:14, quinze:15, seize:16, vingt:20, trente:30,
  quarante:40, cinquante:50, soixante:60, quatrevingts:80, quatrevingt:80,
};
const GERMAN_NUMBER_VALUES: Record<string, number> = {
  null:0, ein:1, eine:1, eins:1, einen:1, einem:1, einer:1, zwei:2, drei:3, vier:4, fünf:5,
  sechs:6, sieben:7, acht:8, neun:9, zehn:10, elf:11, zwölf:12, dreizehn:13, vierzehn:14,
  fünfzehn:15, sechzehn:16, siebzehn:17, achtzehn:18, neunzehn:19, zwanzig:20, dreißig:30,
  vierzig:40, fünfzig:50, sechzig:60, siebzig:70, achtzig:80, neunzig:90,
};
const ITALIAN_NUMBER_VALUES: Record<string, number> = {
  zero:0, uno:1, una:1, un:1, due:2, tre:3, quattro:4, cinque:5, sei:6, sette:7, otto:8, nove:9,
  dieci:10, undici:11, dodici:12, tredici:13, quattordici:14, quindici:15, sedici:16, diciassette:17,
  diciotto:18, diciannove:19, venti:20, trenta:30, quaranta:40, cinquanta:50, sessanta:60,
  settanta:70, ottanta:80, novanta:90,
};
const SPANISH_NUMBER_VALUES: Record<string, number> = {
  cero:0, un:1, uno:1, una:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9,
  diez:10, once:11, doce:12, trece:13, catorce:14, quince:15, dieciseis:16, 'dieciséis':16,
  diecisiete:17, dieciocho:18, diecinueve:19, veinte:20, veintiuno:21, veintiun:21, 'veintiún':21,
  veintiuna:21, veintidos:22, 'veintidós':22, veintitres:23, 'veintitrés':23, veinticuatro:24,
  veinticinco:25, veintiseis:26, 'veintiséis':26, veintisiete:27, veintiocho:28, veintinueve:29,
  treinta:30, cuarenta:40, cincuenta:50, sesenta:60, setenta:70, ochenta:80, noventa:90,
  doscientos:200, trescientos:300, cuatrocientos:400, quinientos:500, seiscientos:600,
  setecientos:700, ochocientos:800, novecientos:900,
};
const FRENCH_NUMBER_SCALES: Record<string, number> = { cent:100, cents:100, mille:1_000, million:1_000_000, millions:1_000_000 };
const GERMAN_NUMBER_SCALES: Record<string, number> = { hundert:100, tausend:1_000, million:1_000_000, millionen:1_000_000 };
const ITALIAN_NUMBER_SCALES: Record<string, number> = { cento:100, mille:1_000, mila:1_000, milione:1_000_000, milioni:1_000_000 };
const SPANISH_NUMBER_SCALES: Record<string, number> = { cien:100, ciento:100, mil:1_000, millón:1_000_000, millones:1_000_000, billón:1_000_000_000, billones:1_000_000_000 };
const NUMBER_LEXICONS: Record<string, { values: Record<string, number>; scales: Record<string, number>; joiners: Set<string>; units: Set<string> }> = {
  en: { values:ENGLISH_NUMBER_VALUES, scales:ENGLISH_NUMBER_SCALES, joiners:new Set(['and']), units:ENGLISH_QUANTITY_UNITS },
  fr: { values:FRENCH_NUMBER_VALUES, scales:FRENCH_NUMBER_SCALES, joiners:new Set(['et']), units:new Set(['pouce','pouces','pied','pieds','mille','milles','mètre','mètres','centimètre','centimètres','kilomètre','kilomètres','seconde','secondes','minute','minutes','heure','heures','jour','jours','semaine','semaines','mois','an','ans','année','années','degré','degrés','livre','livres','kilogramme','kilogrammes','gramme','grammes','litre','litres']) },
  de: { values:GERMAN_NUMBER_VALUES, scales:GERMAN_NUMBER_SCALES, joiners:new Set(['und']), units:new Set(['zoll','fuß','meile','meilen','meter','metern','zentimeter','millimeter','kilometer','sekunde','sekunden','minute','minuten','stunde','stunden','tag','tage','woche','wochen','monat','monate','jahr','jahre','grad','pfund','kilogramm','gramm','liter']) },
  it: { values:ITALIAN_NUMBER_VALUES, scales:ITALIAN_NUMBER_SCALES, joiners:new Set(['e']), units:new Set(['pollice','pollici','piede','piedi','miglio','miglia','metro','metri','centimetro','centimetri','chilometro','chilometri','secondo','secondi','minuto','minuti','ora','ore','giorno','giorni','settimana','settimane','mese','mesi','anno','anni','grado','gradi','libbra','libbre','chilogrammo','chilogrammi','grammo','grammi','litro','litri']) },
  es: { values:SPANISH_NUMBER_VALUES, scales:SPANISH_NUMBER_SCALES, joiners:new Set(['y']), units:new Set(['pulgada','pulgadas','pie','pies','milla','millas','centímetro','centímetros','milímetro','milímetros','kilómetro','kilómetros','metro','metros','segundo','segundos','minuto','minutos','hora','horas','día','días','semana','semanas','mes','meses','año','años','grado','grados','libra','libras','kilogramo','kilogramos','gramo','gramos','litro','litros','persona','personas']) },
};
const CHINESE_MEASURE_UNIT = /^(?:英寸|寸|英尺|尺|厘米|毫米|米|公里|千米|小时|分钟|秒钟|秒|天|周|星期|个月|月|年|岁|公斤|千克|克|升|毫升|度|百分比|百分之|インチ|フィート|マイル|センチメートル|ミリメートル|キロメートル|メートル|時間|週間|週|ヶ月|か月|キログラム|グラム|リットル)/u;
const CHINESE_COUNT_UNIT = /^(?:个|只|件|位|本|支|张|颗|条|头|匹|座|扇|间|辆|名|次|人|回|遍|边|つ|人|匹|冊|本|個|台|枚)/u;
const CHINESE_DIGITS: Record<string, number> = {
  零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9,
};
function normalizeAuditLanguage(value: string, sampleText = ''): string {
  const raw = String(value || '').trim().toLocaleLowerCase();
  const primary = raw.split(/[-_]/u)[0] || '';
  const aliases: Record<string, string> = {
    english:'en',eng:'en',french:'fr',français:'fr',fra:'fr',fre:'fr',
    german:'de',deutsch:'de',deu:'de',ger:'de',italian:'it',italiano:'it',ita:'it',
    spanish:'es',español:'es',espanol:'es',castellano:'es',spa:'es',
    japanese:'ja',日本語:'ja',jpn:'ja',chinese:'zh',中文:'zh',zho:'zh',
  };
  if (aliases[raw] || aliases[primary]) return aliases[raw] || aliases[primary]!;
  if (!raw || ['auto','unknown','und'].includes(primary)) {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sampleText)) return 'ja';
    const sample = sampleText.toLocaleLowerCase();
    if (/[ñ¿¡]/u.test(sample)) return 'es';
    const scores: Record<string, number> = {
      es: (sample.match(/\b(?:el|los|las|una|unos|unas|y|que|con|para|por|pero|porque|del|al|se|es|son|está|están|fue|dijo|ella|ellos|nosotros|usted|muy|también|años|cada|todo)\b/gu) || []).length,
      fr: (sample.match(/\b(?:le|la|les|une|des|est|et|que|qui|avec|dans|pour|pas|mais|je|elle|vous|nous)\b/gu) || []).length,
      de: (sample.match(/\b(?:der|die|das|ein|eine|und|ist|mit|nicht|ich|war|hat|zu|von|dem|den|er|sie|drei|zwei|vier|fünf)\b/gu) || []).length,
      it: (sample.match(/\b(?:il|lo|gli|sono|che|non|una|per|con|della|era|dove|ma|voi|noi)\b/gu) || []).length,
    };
    const ranked = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
    if (ranked[0] && ranked[0][1] >= 2 && ranked[0][1] > (ranked[1]?.[1] || 0)) return ranked[0][0]!;
    if (/[ßäöü]/u.test(sample)) return 'de';
    if (/[çœéèêëàâîïôùûüÿ]/u.test(sample)) return 'fr';
    if (/[òì]/u.test(sample)) return 'it';
    return 'en';
  }
  return primary || 'en';
}
function parseChineseNumber(value: string): number {
  let total=0, section=0, digit=0;
  for (const char of value) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS,char)) { digit=CHINESE_DIGITS[char]!; continue; }
    const unit = char==='十'?10:char==='百'?100:char==='千'?1_000:char==='万'?10_000:char==='亿'?100_000_000:0;
    if (!unit) continue;
    if (unit<10_000) section+=(digit || (section===0?1:0))*unit;
    else { section+=digit; total=(total+section)*unit; section=0; }
    digit=0;
  }
  return total+section+digit;
}
function parseLocalizedNumberRun(
  tokens: Array<{ token: string; index: number }>,
  start: number,
  language: string,
) {
  const lexicon = NUMBER_LEXICONS[language];
  if (!lexicon) return null;
  let total=0, current=0, sawNumber=false, hasScale=false, index=start;
  while(index<tokens.length) {
    const token=tokens[index]!.token;
    if(Object.prototype.hasOwnProperty.call(lexicon.values,token)) {
      current+=lexicon.values[token]!;
      sawNumber=true; index++; continue;
    }
    if(Object.prototype.hasOwnProperty.call(lexicon.scales,token)) {
      const scale=lexicon.scales[token]!;
      if(scale===100) current=(current||1)*scale;
      else { total+=(current||1)*scale; current=0; }
      hasScale=true; sawNumber=true; index++; continue;
    }
    if(lexicon.joiners.has(token) && sawNumber && index+1<tokens.length &&
      (Object.prototype.hasOwnProperty.call(lexicon.values,tokens[index+1]!.token) ||
       Object.prototype.hasOwnProperty.call(lexicon.scales,tokens[index+1]!.token))) {
      index++; continue;
    }
    break;
  }
  return sawNumber ? { value:total+current, end:index, hasScale } : null;
}
function normalizeNumericLiteralToken(value: string, language: string): string {
  // Spanish, French, German and Italian conventionally use comma decimals and dot grouping.
  if (['es','fr','de','it'].includes(language)) {
    if (value.includes(',')) {
      const separator = value.lastIndexOf(',');
      const integer = value.slice(0, separator).replace(/[.,]/g, '') || '0';
      const fraction = value.slice(separator + 1).replace(/[.,]/g, '');
      return integer + '.' + fraction;
    }
    if (/^\d{1,3}(?:\.\d{3})+$/u.test(value)) return value.replace(/\./g, '');
  }
  return value.replace(/,/g, '');
}
function numericTokens(value: unknown, allowImplicitChineseClassifierOne = true, sourceLang = 'en'): string[] {
  // Unsupported source-language words are not guessed. Only recognized numerals and explicit digits
  // are compared; an unrecognized number phrase must not be treated as a source value of zero.
  const source=String(value??'').normalize('NFKC').toLocaleLowerCase();
  const language=normalizeAuditLanguage(sourceLang, source);
  const matches=Array.from(source.matchAll(/\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万亿]+|[\p{Script=Latin}][\p{Script=Latin}\p{M}]*/giu),
    (match)=>({token:match[0]!,index:match.index??0}));
  const result:string[]=[];
  let index=0;
  while(index<matches.length) {
    const current=matches[index]!;
    if(/^\d/u.test(current.token)) { result.push(normalizeNumericLiteralToken(current.token,language)); index++; continue; }
    if(/^[零〇一二两三四五六七八九十百千万亿]+$/u.test(current.token)) {
      const valueNumber=parseChineseNumber(current.token);
      const suffix=source.slice(current.index+current.token.length);
      const measure=CHINESE_MEASURE_UNIT.test(suffix), classifier=CHINESE_COUNT_UNIT.test(suffix);
      if(measure || classifier && (allowImplicitChineseClassifierOne || valueNumber!==1)) result.push(String(valueNumber));
      index++; continue;
    }
    const parsed=parseLocalizedNumberRun(matches,index,language);
    if(parsed) {
      const lexicon=NUMBER_LEXICONS[language]!;
      const next=matches[parsed.end]?.token || '';
      if(parsed.hasScale || lexicon.units.has(next)) {
        result.push(String(parsed.value)); index=parsed.end; continue;
      }
    }
    index++;
  }
  return result;
}
const QUANTITY_UNIT_CANONICAL: Record<string, string> = {
  inch:'length:inch', inches:'length:inch', 英寸:'length:inch', 寸:'length:inch', pouce:'length:inch', pouces:'length:inch', zoll:'length:inch', pollice:'length:inch', pollici:'length:inch',
  foot:'length:foot', feet:'length:foot', 英尺:'length:foot', 尺:'length:foot', pied:'length:foot', pieds:'length:foot', fuß:'length:foot', piede:'length:foot', piedi:'length:foot',
  mile:'length:mile', miles:'length:mile', 英里:'length:mile', mille:'length:mile', milles:'length:mile', meile:'length:mile', meilen:'length:mile', miglio:'length:mile', miglia:'length:mile',
  meter:'length:meter', meters:'length:meter', metre:'length:meter', metres:'length:meter', 米:'length:meter', mètre:'length:meter', mètres:'length:meter', metern:'length:meter', metro:'length:meter', metri:'length:meter', メートル:'length:meter',
  centimeter:'length:centimeter', centimeters:'length:centimeter', centimetre:'length:centimeter', centimetres:'length:centimeter', 厘米:'length:centimeter', centimètre:'length:centimeter', centimètres:'length:centimeter', zentimeter:'length:centimeter', centimetro:'length:centimeter', centimetri:'length:centimeter', センチメートル:'length:centimeter',
  millimeter:'length:millimeter', millimeters:'length:millimeter', 毫米:'length:millimeter', millimètre:'length:millimeter', millimètres:'length:millimeter', millimetro:'length:millimeter', millimetri:'length:millimeter', ミリメートル:'length:millimeter',
  kilometer:'length:kilometer', kilometers:'length:kilometer', kilometre:'length:kilometer', kilometres:'length:kilometer', 公里:'length:kilometer', 千米:'length:kilometer', kilomètre:'length:kilometer', kilomètres:'length:kilometer', chilometro:'length:kilometer', chilometri:'length:kilometer', キロメートル:'length:kilometer',
  hour:'time:hour', hours:'time:hour', 小时:'time:hour', heure:'time:hour', heures:'time:hour', stunde:'time:hour', stunden:'time:hour', ora:'time:hour', ore:'time:hour', 時間:'time:hour',
  minute:'time:minute', minutes:'time:minute', 分钟:'time:minute', minuten:'time:minute', minuto:'time:minute', minuti:'time:minute', 分:'time:minute',
  second:'time:second', seconds:'time:second', 秒:'time:second', 秒钟:'time:second', seconde:'time:second', secondes:'time:second', sekunde:'time:second', sekunden:'time:second', secondo:'time:second', secondi:'time:second',
  day:'time:day', days:'time:day', 天:'time:day', jour:'time:day', jours:'time:day', tag:'time:day', tage:'time:day', giorno:'time:day', giorni:'time:day', 日:'time:day',
  week:'time:week', weeks:'time:week', 周:'time:week', 星期:'time:week', semaine:'time:week', semaines:'time:week', woche:'time:week', wochen:'time:week', settimana:'time:week', settimane:'time:week', 週:'time:week',
  month:'time:month', months:'time:month', 月:'time:month', '个月':'time:month', mois:'time:month', monat:'time:month', monate:'time:month', mese:'time:month', mesi:'time:month', mes:'time:month', meses:'time:month',
  pulgada:'length:inch', pulgadas:'length:inch', pie:'length:foot', pies:'length:foot', milla:'length:mile', millas:'length:mile',
  'centímetro':'length:centimeter', 'centímetros':'length:centimeter', 'milímetro':'length:millimeter', 'milímetros':'length:millimeter',
  'kilómetro':'length:kilometer', 'kilómetros':'length:kilometer', metros:'length:meter',
  segundo:'time:second', segundos:'time:second', minutos:'time:minute', hora:'time:hour', horas:'time:hour',
  día:'time:day', días:'time:day', semana:'time:week', semanas:'time:week', año:'time:year', años:'time:year',
  grados:'angle:degree', libra:'weight:pound', libras:'weight:pound', kilogramo:'weight:kilogram', kilogramos:'weight:kilogram',
  gramo:'weight:gram', gramos:'weight:gram', litros:'volume:liter',
  year:'time:year', years:'time:year', 年:'time:year', 岁:'time:year', an:'time:year', ans:'time:year', jahr:'time:year', jahre:'time:year', anno:'time:year', anni:'time:year',
  degree:'angle:degree', degrees:'angle:degree', 度:'angle:degree', degré:'angle:degree', degrés:'angle:degree', grad:'angle:degree', grado:'angle:degree', gradi:'angle:degree',
  pound:'weight:pound', pounds:'weight:pound', livre:'weight:pound', livres:'weight:pound', pfund:'weight:pound', libbra:'weight:pound', libbre:'weight:pound',
  kilogram:'weight:kilogram', kilograms:'weight:kilogram', 公斤:'weight:kilogram', 千克:'weight:kilogram', kilogramme:'weight:kilogram', kilogrammes:'weight:kilogram', kilogramm:'weight:kilogram', chilogrammo:'weight:kilogram', chilogrammi:'weight:kilogram', キログラム:'weight:kilogram',
  gram:'weight:gram', grams:'weight:gram', 克:'weight:gram', gramme:'weight:gram', grammes:'weight:gram', gramm:'weight:gram', grammo:'weight:gram', grammi:'weight:gram', グラム:'weight:gram',
  liter:'volume:liter', liters:'volume:liter', litre:'volume:liter', litres:'volume:liter', 升:'volume:liter', litro:'volume:liter', litri:'volume:liter', リットル:'volume:liter',
  side:'count:side', sides:'count:side', 边:'count:side',
};
const LOCALIZED_QUANTITY_UNIT_PATTERNS: Record<string, RegExp> = {
  fr: /(?:\d+(?:[,.]\d+)*|zéro|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille)(?:[\s-]+(?:et[\s-]+)?(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|cent|mille))*[\s-]+([\p{Script=Latin}\p{M}]+)/giu,
  de: /(?:\d+(?:[,.]\d+)*|null|ein|eine|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert|tausend)(?:[\s-]+(?:und[\s-]+)?(?:ein|eine|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwanzig|hundert|tausend))*[\s-]+([\p{Script=Latin}\p{M}]+)/giu,
  it: /(?:\d+(?:[,.]\d+)*|zero|uno|una|un|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|venti|trenta|quaranta|cinquanta|sessanta|settanta|ottanta|novanta|cento|mille)(?:[\s-]+(?:e[\s-]+)?(?:uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|venti|trenta|cento|mille))*[\s-]+([\p{Script=Latin}\p{M}]+)/giu,
  es: /(?:\d+(?:[,.]\d+)*|cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintiun|veintiuna|veintidós|veintidos|veintitrés|veintitres|veinticuatro|veinticinco|veintiséis|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|millón|millones)(?:[\s-]+(?:y[\s-]+)?(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|veintidós|veintidos|veintitrés|veintitres|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|millón|millones))*[\s-]+([\p{Script=Latin}\p{M}]+)/giu,
  ja: /(?:\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万億]+)\s*([\p{Script=Katakana}ー]+)/gu,
};
function numericQuantityUnits(value: unknown, sourceLang = 'en'): string[] {
  const source=String(value??'').normalize('NFKC').toLocaleLowerCase();
  const found:Array<{index:number;unit:string}>=[];
  const englishNumber='(?:\\d+(?:[,.]\\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)';
  const englishPattern=new RegExp('\\b'+englishNumber+'(?:[\\s-]+(?:and[\\s-]+)?'+englishNumber+')*[\\s-]+(inches?|feet|foot|miles?|hours?|minutes?|seconds?|days?|weeks?|months?|years?|degrees?|meters?|metres?|centimeters?|centimetres?|millimeters?|millimetres?|kilometers?|kilometres?|pounds?|kilograms?|ounces?|liters?|litres?|sides?)\\b','giu');
  for(const match of source.matchAll(englishPattern)){
    const unit=QUANTITY_UNIT_CANONICAL[String(match[1]||'').toLocaleLowerCase()];
    if(unit)found.push({index:match.index??0,unit});
  }
  const chinesePattern=/(?:\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万亿]+)(英寸|寸|英尺|尺|英里|公里|千米|厘米|毫米|米|小时|分钟|秒钟|秒|天|周|星期|个月|月|年|岁|公斤|千克|克|升|毫升|度|边|インチ|フィート|マイル|センチメートル|ミリメートル|キロメートル|メートル|時間|週間|週|ヶ月|か月|キログラム|グラム|リットル)/gu;
  for(const match of source.matchAll(chinesePattern)){
    const unit=QUANTITY_UNIT_CANONICAL[String(match[1]||'')];
    if(unit)found.push({index:match.index??0,unit});
  }
  const language=normalizeAuditLanguage(sourceLang, source);
  const localized=LOCALIZED_QUANTITY_UNIT_PATTERNS[language];
  if(localized){
    localized.lastIndex=0;
    for(const match of source.matchAll(localized)){
      const unit=QUANTITY_UNIT_CANONICAL[String(match[1]||'').toLocaleLowerCase()];
      if(unit)found.push({index:match.index??0,unit});
    }
  }
  // The Japanese katakana scanner and the CJK unit scanner can match the same source span.
  // De-duplicate only identical (offset, canonical unit) pairs; repeated quantities at different
  // offsets remain separate so cardinality differences are still visible.
  const unique = new Map<string, { index: number; unit: string }>();
  for (const item of found) unique.set(item.index + ':' + item.unit, item);
  return Array.from(unique.values()).sort((a,b)=>a.index-b.index).map((item)=>item.unit);
}
function numericFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  sourceLang = 'en',
) {
  const findings:any[]=[];
  const resolvedSourceLang = normalizeAuditLanguage(sourceLang, segments.slice(0, 100).map((segment) => segment.text).join(' '));
  for(const segment of segments){
    const translation=translations.get(segment.id)||'';
    if(!translation.trim())continue;
    const sourceNumbers=numericTokens(segment.text,false,resolvedSourceLang);
    const sourceUnits=numericQuantityUnits(segment.text,resolvedSourceLang);
    // Only compare when the source contains a number/quantity the selected lexical rules could
    // identify. Empty source evidence is "unknown", not a numeric value of zero.
    if(!sourceNumbers.length && !sourceUnits.length)continue;
    const targetNumbers=numericTokens(translation,sourceNumbers.length>0,'zh');
    const targetUnits=numericQuantityUnits(translation,'zh');
    const numericValuesDiffer=sourceNumbers.length>0 && JSON.stringify(sourceNumbers)!==JSON.stringify(targetNumbers);
    const quantityUnitsDiffer=sourceUnits.length>0 &&
      JSON.stringify(sourceUnits)!==JSON.stringify(targetUnits);
    if(!numericValuesDiffer&&!quantityUnitsDiffer)continue;
    findings.push({
      findingId:stableFindingId('numeric-token-mismatch',[segment.id],
        sourceNumbers.join(',')+'>'+targetNumbers.join(',')+':'+sourceUnits.join(',')+'>'+targetUnits.join(',')),
      type:'numeric-token-mismatch',category:'numeric',severity:'warning',confidence:'heuristic',repairable:true,
      segmentIds:[segment.id],chapter:segment.contextPath||null,
      sourceNumbers,translatedNumbers:targetNumbers,sourceUnits,translatedUnits:targetUnits,
      sourceExcerpt:segment.text.slice(0,240),translationExcerpt:translation.slice(0,320),
      explanation:numericValuesDiffer
        ? '原文与译文中的数字序列不同；这可能是数值遗漏、增添或格式转换，需要结合上下文人工确认。'
        : '原文与译文中的计量单位或数量单位不同；请结合上下文判断是否属于有效换算或单位误译。',
    });
  }
  return findings;
}

function translationOutputValidationFindings(
  db: any,
  runId: string | undefined,
  sourceSegmentIds: Set<string>,
): any[] {
  if (!runId) return [];
  const rows = db.prepare(
    'SELECT event_id, payload_json FROM project_events WHERE run_id = ? AND event_type = ? ORDER BY event_id'
  ).all(runId, 'batch.output.validation') as any[];
  const findings: any[] = [];
  for (const row of rows) {
    let payload: any = {};
    try { payload = JSON.parse(String(row.payload_json || '{}')); } catch { payload = {}; }
    const batchIndex = Number.isFinite(Number(payload.batchIndex)) ? Number(payload.batchIndex) : null;
    const duplicateIds = Array.isArray(payload.duplicateSegmentIds)
      ? Array.from(new Set<string>(payload.duplicateSegmentIds.filter((id: unknown): id is string =>
          typeof id === 'string' && sourceSegmentIds.has(id)))).slice(0, 20)
      : [];
    if (Number(payload.duplicateCount) > 0) {
      findings.push({
        findingId: stableFindingId('duplicate-output-id', duplicateIds, String(runId) + ':' + String(batchIndex) + ':' + String(payload.duplicateCount)),
        type: 'duplicate-output-id',
        category: 'output-validation',
        severity: 'warning',
        confidence: 'deterministic-output-shape',
        repairable: duplicateIds.length > 0,
        segmentIds: duplicateIds,
        batchIndex,
        duplicateCount: Math.max(0, Number(payload.duplicateCount) || 0),
        explanation: '模型在同一批响应中重复返回了输入片段 ID；重复结果未被接受，相关片段仍按缺失/重试逻辑处理。',
      });
    }
    if (Number(payload.unexpectedCount) > 0) {
      findings.push({
        findingId: stableFindingId('unexpected-output-id', [], String(runId) + ':' + String(batchIndex) + ':' + String(payload.unexpectedCount)),
        type: 'unexpected-output-id',
        category: 'output-validation',
        severity: 'warning',
        confidence: 'deterministic-output-shape',
        repairable: false,
        segmentIds: [],
        batchIndex,
        unexpectedCount: Math.max(0, Number(payload.unexpectedCount) || 0),
        unexpectedOutputIds: Array.isArray(payload.unexpectedOutputIds)
          ? payload.unexpectedOutputIds.filter((id: unknown) => typeof id === 'string').slice(0, 20)
          : [],
        explanation: '模型返回了不属于本批输入的片段 ID；这些结果已忽略。',
      });
    }
    if (Number(payload.malformedRowCount) > 0) {
      findings.push({
        findingId: stableFindingId('malformed-output-row', [], String(runId) + ':' + String(batchIndex) + ':' + String(payload.malformedRowCount)),
        type: 'malformed-output-row',
        category: 'output-validation',
        severity: 'warning',
        confidence: 'deterministic-output-shape',
        repairable: false,
        segmentIds: [],
        batchIndex,
        malformedRowCount: Math.max(0, Number(payload.malformedRowCount) || 0),
        explanation: '模型响应包含缺少 ID、空译文或结构不合法的行；这些行未被接受。',
      });
    }
  }
  return findings;
}

function stableFindingId(type: string, ids: string[], detail: string): string {
  let hash = 0x811c9dc5;
  const input = type + ':' + ids.join(',') + ':' + detail;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  return 'qf_' + (hash >>> 0).toString(16).padStart(8, '0');
}

function currentSource(projectId: string) {
  const store = getDocumentProjectStore();
  const context = store.getProjectContext(projectId);
  const rows = context.db.prepare(
    'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath, source_hash AS sourceHash ' +
    'FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(context.currentSourceRevisionId) as any[];
  return {
    store,
    context,
    segments: rows.map((row) => ({
      id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text), kind: String(row.kind || 'paragraph'),
      contextPath: String(row.contextPath || ''), sourceHash: String(row.sourceHash || ''),
    })),
  };
}

function acceptedTranslations(db: any, revisionId: string): Map<string, string> {
  const rows = db.prepare(
    'SELECT r.segment_id AS id, r.translation_text AS text, r.source_hash AS sourceHash ' +
    'FROM translation_results r JOIN source_segments s ON s.source_revision_id = r.source_revision_id ' +
    'AND s.segment_id = r.segment_id AND s.source_hash = r.source_hash ' +
    'WHERE r.source_revision_id = ? AND r.accepted = 1 ORDER BY r.rowid DESC'
  ).all(revisionId) as any[];
  const result = new Map<string, string>();
  for (const row of rows) if (!result.has(String(row.id))) result.set(String(row.id), String(row.text || ''));
  return result;
}

function overlayRunCandidates(db: any, revisionId: string, runId: string, translations: Map<string, string>): void {
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!run) fail('找不到质量审计指定的翻译运行：' + runId, 404);
  if (run.source_revision_id !== revisionId) fail('质量审计的翻译运行不属于当前来源版本，请先对当前版本重新翻译。', 409);
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, rs.source_hash AS sourceHash, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    'WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) {
    if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  }
}

function hashTranslationText(value: unknown): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function translationSnapshotHash(segments: Array<{ id: string }>, translations: Map<string, string>): string {
  const hashes = segments.map((segment) => [
    segment.id,
    hashTranslationText(translations.get(segment.id) || ''),
  ]);
  return createHash('sha256').update(JSON.stringify(hashes), 'utf8').digest('hex');
}

function memoryWithGlossary(memoryInput: Record<string, any>, glossary: unknown): Record<string, any> {
  const memory = memoryInput && typeof memoryInput === 'object' ? memoryInput : {};
  const existing = Array.isArray(memory.entities) ? [...memory.entities] : [];
  const existingSources = new Set(existing.map((item: any) => normalized(item?.source)).filter(Boolean));
  const glossaryObject = glossary && typeof glossary === 'object' && !Array.isArray(glossary)
    ? glossary as Record<string, any> : {};
  const terms = Array.isArray(glossaryObject.document_terms) ? glossaryObject.document_terms : [];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) continue;
    const source = String(term.source ?? term.source_term ?? term.term ?? term.original ?? term.en ?? term.from ?? '').trim();
    const target = String(term.target ?? term.target_term ?? term.translation ?? term.zh ?? term.to ?? '').trim();
    if (!source || !target) continue;
    if (['candidate', 'suggested', 'rejected'].includes(String(term.reviewStatus || term.status || '').toLowerCase())) continue;
    const key = normalized(source);
    if (existingSources.has(key)) continue;
    existingSources.add(key);
    existing.push({
      source,
      target,
      kind: String(term.kind || term.category || 'other'),
      aliases: Array.isArray(term.aliases) ? term.aliases.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [],
      reviewStatus: 'confirmed',
      evidence: typeof term.evidence === 'string' ? term.evidence : '',
    });
  }
  return { ...memory, entities: existing };
}

function loadMemory(projectId: string, runId?: string): Record<string, any> {
  const store = getDocumentProjectStore();
  if (runId) {
    const context = store.getRunContext(projectId, runId);
    return memoryWithGlossary(context.memory, context.prompt?.config?.glossary);
  }
  const memory = store.getCurrentLiteraryMemory(projectId).memory;
  const { db } = store.getProjectContext(projectId);
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC LIMIT 1').get() as { config_json?: string } | undefined;
  let glossary: unknown = null;
  try { glossary = row?.config_json ? JSON.parse(row.config_json).glossary : null; } catch { glossary = null; }
  return memoryWithGlossary(memory, glossary);
}

function currentReviewFindings(
  db: any,
  revisionId: string,
  requestedRunId?: string,
): { reviewRunId: string | null; findings: any[] } {
  let reviewRunId = requestedRunId || null;
  if (!reviewRunId) {
    const row = db.prepare(
      'SELECT tr.run_id FROM translation_runs tr ' +
      'WHERE tr.source_revision_id = ? AND tr.review_enabled = 1 ' +
      'AND EXISTS (SELECT 1 FROM review_findings rf WHERE rf.run_id = tr.run_id) ' +
      'ORDER BY tr.finished_at DESC, tr.created_at DESC LIMIT 1'
    ).get(revisionId) as any;
    reviewRunId = row?.run_id || null;
  }
  if (!reviewRunId) return { reviewRunId: null, findings: [] };
  const rows = db.prepare(
    'SELECT rf.finding_id, rf.segment_id, rf.category, rf.priority, rf.finding_json, rf.status, rf.created_at, ' +
    'rs.candidate_result_id, r.translation_text AS reviewed_translation ' +
    'FROM review_findings rf JOIN translation_runs tr ON tr.run_id = rf.run_id ' +
    'LEFT JOIN run_segments rs ON rs.run_id = rf.run_id AND rs.segment_id = rf.segment_id ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id ' +
    "WHERE rf.run_id = ? AND tr.source_revision_id = ? AND rf.category = 'style' " +
    'ORDER BY rf.finding_id DESC LIMIT 300'
  ).all(reviewRunId, revisionId) as any[];
  const findings = rows.flatMap((row) => {
    const reviewedTranslation = typeof row.reviewed_translation === 'string' ? row.reviewed_translation : null;
    // When auditing accepted text (no runId specified), suppress stale style findings from an
    // older candidate whose translation is no longer the accepted text for this source revision.
    if (!requestedRunId) {
      const accepted = db.prepare(
        'SELECT translation_text FROM translation_results WHERE source_revision_id = ? AND segment_id = ? ' +
        'AND accepted = 1 ORDER BY rowid DESC LIMIT 1'
      ).get(revisionId, String(row.segment_id)) as { translation_text?: string } | undefined;
      if (!accepted || accepted.translation_text !== reviewedTranslation) return [];
    }
    let finding: any = {};
    try { finding = JSON.parse(row.finding_json); } catch { finding = {}; }
    return [{
      findingId: Number(row.finding_id),
      segmentId: String(row.segment_id),
      category: String(row.category),
      priority: String(row.priority),
      status: String(row.status),
      dimension: typeof finding.dimension === 'string' ? finding.dimension : null,
      characterId: typeof finding.characterId === 'string' ? finding.characterId : null,
      sourceExcerpt: String(finding.sourceExcerpt || ''),
      draftExcerpt: String(finding.draftExcerpt || ''),
      evidenceSegmentIds: Array.isArray(finding.evidenceSegmentIds) ? finding.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string').slice(0, 8) : [],
      reason: String(finding.reason || ''),
      suggestion: String(finding.suggestion || ''),
      proposedTranslation: typeof finding.proposedTranslation === 'string' ? finding.proposedTranslation : null,
      reviewedTranslation,
      createdAt: row.created_at,
    }];
  }).reverse();
  return { reviewRunId, findings };
}

const GENERIC_CANONICAL_NAME_FORMS = new Set([
  'lord', 'general', 'sire', 'council', 'regent', 'regents', 'ship',
  'sir', 'madam', 'madame', 'captain', 'lady', 'samurai',
]);
const CANONICAL_NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'lord', 'general', 'sire', 'sir', 'lady',
  'madam', 'madame', 'captain', 'master', 'mr', 'mrs', 'ms', 'san', 'sama',
]);

function normalizedCanonicalName(value: unknown): string {
  return normalized(value).replace(/^(?:the|a|an)\s+/, '')
    .replace(/(?:['’]s)\b/g, '').replace(/[.!?]+$/g, '').trim();
}

function isGenericCanonicalName(value: unknown): boolean {
  return GENERIC_CANONICAL_NAME_FORMS.has(normalizedCanonicalName(value));
}

function canonicalIdentityTokens(value: string): string[] {
  return normalizedCanonicalName(value).replace(/['’]s\b/g, '')
    .match(/[\p{Script=Latin}\p{M}\p{N}]+/gu)?.filter((token) => !CANONICAL_NAME_STOPWORDS.has(token)) || [];
}

function isCompatibleCanonicalAlias(source: string, alias: string): boolean {
  if (!/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(source) || !/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(alias)) return true;
  const sourceTokens = canonicalIdentityTokens(source);
  const aliasTokens = canonicalIdentityTokens(alias);
  if (!aliasTokens.length) return false;
  if (!sourceTokens.length) return true;
  return sourceTokens.some((sourceToken) => aliasTokens.some((aliasToken) =>
    sourceToken === aliasToken || sourceToken.startsWith(aliasToken) || aliasToken.startsWith(sourceToken)));
}

function canonicalNameForms(source: string, aliases: unknown): string[] {
  const candidates = [source, ...(Array.isArray(aliases) ? aliases : [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value) => !isGenericCanonicalName(value))
    .filter((value, index) => index === 0 || isCompatibleCanonicalAlias(source, value));
  return Array.from(new Map(candidates.map((value) => [normalized(value), value])).values());
}

type CanonicalNameAuditMapping = {
  source: string;
  target: string;
  aliases: string[];
  kind: string;
  status: 'confirmed';
  mappingSources: string[];
};

function canonicalNameAuditMappings(memory: Record<string, any>): CanonicalNameAuditMapping[] {
  const mappings: CanonicalNameAuditMapping[] = [];
  const add = (sourceValue: unknown, targetValue: unknown, aliasesValue: unknown, kindValue: unknown, mappingSource: string) => {
    const source = typeof sourceValue === 'string' ? sourceValue.trim() : '';
    const target = typeof targetValue === 'string' ? targetValue.trim() : '';
    if (!source || !target || isGenericCanonicalName(source)) return;
    const aliases = canonicalNameForms(source, aliasesValue).filter((value) => normalized(value) !== normalized(source));
    const key = normalized(source) + '\u0000' + normalized(target);
    const existing = mappings.find((item) => normalized(item.source) + '\u0000' + normalized(item.target) === key);
    if (existing) {
      existing.aliases = Array.from(new Map([...existing.aliases, ...aliases].map((value) => [normalized(value), value])).values());
      if (!existing.mappingSources.includes(mappingSource)) existing.mappingSources.push(mappingSource);
      return;
    }
    mappings.push({
      source, target, aliases, kind: typeof kindValue === 'string' ? kindValue : 'other',
      status: 'confirmed', mappingSources: [mappingSource],
    });
  };

  for (const entity of Array.isArray(memory.entities) ? memory.entities : []) {
    if (entity?.reviewStatus !== 'confirmed') continue;
    add(entity.source, entity.target, entity.aliases, entity.kind, 'literary-memory');
  }
  // Character/Voice profiles maintain their own canonical target names. They may be the only
  // source of an approved name mapping, so book-level audits must inspect them as well as entities.
  for (const profile of Array.isArray(memory.characterVoices) ? memory.characterVoices : []) {
    if (profile?.status !== 'confirmed' || profile?.useForTranslation === false) continue;
    add(profile.canonicalSourceName, profile.targetName, profile.aliases, 'character', 'character-voice');
  }
  return mappings;
}

function canonicalNameMappingConflictFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  memory: Record<string, any>,
): { findings: any[]; conflictedSources: Set<string> } {
  const mappings = canonicalNameAuditMappings(memory);
  const groups = new Map<string, CanonicalNameAuditMapping[]>();
  for (const mapping of mappings) {
    const key = normalized(mapping.source);
    const list = groups.get(key) || [];
    list.push(mapping);
    groups.set(key, list);
  }
  const findings: any[] = [];
  const conflictedSources = new Set<string>();
  for (const [sourceKey, group] of groups) {
    const targets = Array.from(new Map(group.map((mapping) => [normalized(mapping.target), mapping.target])).values());
    if (targets.length < 2) continue;
    conflictedSources.add(sourceKey);
    const forms = group.flatMap((mapping) => [mapping.source, ...mapping.aliases]);
    const affected = segments.filter((segment) => forms.some((form) => containsName(segment.text, form)));
    // A conflicting stored rule matters even if it has not been used in the current translation.
    // Attach the specific affected source IDs whenever the name occurs in this book.
    if (!affected.length) continue;
    const ids = affected.map((segment) => segment.id);
    const confirmed = group.every((mapping) => mapping.status === 'confirmed');
    findings.push({
      findingId: stableFindingId('canonical-name-mapping-conflict', ids, sourceKey + ':' + targets.map(normalized).sort().join('|')),
      type: 'canonical-name-mapping-conflict',
      category: 'terminology',
      severity: confirmed ? 'must-fix' : 'review',
      confidence: 'confirmed-conflict',
      repairable: false,
      segmentIds: ids,
      chapter: affected[0]?.contextPath || null,
      sourceExcerpt: affected[0]?.text.slice(0, 240) || '',
      entity: {
        source: group[0]?.source || '',
        targets,
        mappings: group.map((mapping) => ({ source: mapping.source, target: mapping.target, mappingSources: mapping.mappingSources })),
      },
      explanation: '人物规范名在已确认的 LiteraryMemory 与人物角色/声音资料中存在不同译名。审计不会擅自选择其中一个；请先在项目记忆中统一规范译名，再对受影响片段做定点复核。',
    });
  }
  return { findings, conflictedSources };
}

function terminologyFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  memory: Record<string, any>,
  conflictedSources: Set<string> = new Set(),
) {
  const mappings = canonicalNameAuditMappings(memory);
  const findings: any[] = [];
  for (const segment of segments) {
    const translation = translations.get(segment.id) || '';
    if (!translation) continue;
    for (const mapping of mappings) {
      // When two confirmed sources disagree, report the mapping conflict once rather than making
      // each valid target appear to be a separate translation defect.
      if (conflictedSources.has(normalized(mapping.source))) continue;
      const forms = [mapping.source, ...mapping.aliases];
      const matchedSource = forms.find((alias) => containsName(segment.text, alias));
      if (!matchedSource || targetPresent(translation, mapping.target)) continue;
      findings.push({
        findingId: stableFindingId('terminology-drift', [segment.id], normalized(mapping.source) + '>' + normalized(mapping.target)),
        type: 'terminology-drift',
        category: 'terminology',
        severity: 'warning',
        confidence: 'heuristic',
        repairable: true,
        segmentIds: [segment.id],
        chapter: segment.contextPath || null,
        sourceExcerpt: segment.text.slice(0, 240),
        translationExcerpt: translation.slice(0, 320),
        entity: { source: mapping.source, matchedAlias: matchedSource, target: mapping.target, mappingSources: mapping.mappingSources },
        explanation: '原文包含已确认规范名，但当前译文中未检测到对应译名；请结合语境人工判断是否属于省略、代词替代或真实译名漂移。',
      });
    }
  }
  return findings;
}

// Catch likely source-language residue in Chinese translations. This is deliberately a review hint:
// Latin names, short isolated tokens not in the watchlist, and all stylistic decisions remain untouched.
const ENGLISH_RESIDUE_WORDS = new Set([
  'again','although','already','anyway','because','before','behind','between','beyond','could','during',
  'ever','however','indeed','instead','later','maybe','might','must','never','nothing','perhaps','rather',
  'really','should','since','still','though','through','until','unless','whether','while','would',
]);
const ENGLISH_FUNCTION_WORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does','for','from','had','has',
  'have','he','her','him','his','how','i','if','in','is','it','its','me','my','no','not','of','on','or',
  'our','she','so','than','that','the','their','them','then','there','they','this','to','was','we','were',
  'what','when','where','which','who','will','with','you','your',
]);
const RESIDUE_WORDS_BY_SOURCE_LANG: Record<string, Set<string>> = {
  fr: new Set(['déjà','était','étaient','encore','alors','pourtant','toujours','jamais','peut-être','bonjour','bonsoir','merci','salut','oui','non','voilà','ainsi','très','mais','donc','parce','pourquoi']),
  de: new Set(['schön','schon','nicht','doch','auch','aber','oder','und','der','die','das','ein','eine','ich','du','er','sie','wir','ihr','ja','nein','danke','hallo','ach','also','noch','schon','wieder','immer','nie','weil','wenn','dass','was','wie']),
  it: new Set(['allora','perché','perche','però','pero','già','gia','ancora','sempre','mai','ciao','grazie','buongiorno','buonasera','salve','sì','si','no','non','che','come','dunque','quindi','anche','molto','era','sono']),
  es: new Set(['todavía','todavia','aunque','entonces','porque','porqué','quizá','quizás','siempre','nunca','ahora','pero','además','ademas','también','tambien','después','despues','antes','bien','hola','adiós','adios','gracias','buenos','buenas','días','dias','tardes','noches','señor','señora','qué','quién','cómo','dónde','cuándo','sí','si','no']),
  ja: new Set(),
};
const FUNCTION_WORDS_BY_SOURCE_LANG: Record<string, Set<string>> = {
  en: ENGLISH_FUNCTION_WORDS,
  fr: new Set(['je','tu','il','elle','nous','vous','ils','elles','le','la','les','un','une','des','de','du','et','mais','pas','ne','que','qui','dans','pour','avec','est','sont','était','était']),
  de: new Set(['ich','du','er','sie','es','wir','ihr','der','die','das','ein','eine','und','oder','aber','nicht','mit','von','zu','ist','war','sind','hat','haben','dass','weil','wenn','was','wie']),
  it: new Set(['io','tu','lui','lei','noi','voi','loro','il','lo','la','i','gli','le','un','una','di','da','e','ma','non','che','per','con','è','era','sono','ha']),
  es: new Set(['yo','tú','él','ella','ellos','ellas','nosotros','nosotras','ustedes','vosotros','vosotras','el','la','los','las','un','una','unos','unas','de','del','al','y','o','pero','porque','por','para','con','sin','en','sobre','entre','que','quien','quién','quienes','quiénes','como','cómo','cuando','cuándo','donde','dónde','no','sí','si','es','son','está','están','era','fue','ser','estar','se','me','te','nos','os','lo','le','les','mi','mis','su','sus','muy','más','menos','también','todo','cada']),
};
function englishResidueFindings(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  translations: Map<string, string>,
  targetLang: string,
  sourceLang = 'en',
): any[] {
  if (!/^(?:zh(?:[-_].*)?|chinese|中文|简体中文|繁体中文)$/iu.test(String(targetLang || '').trim())) return [];
  const language = normalizeAuditLanguage(sourceLang, segments.map((segment) => segment.text).join(' '));
  const residueWords = RESIDUE_WORDS_BY_SOURCE_LANG[language] || ENGLISH_RESIDUE_WORDS;
  const functionWords = FUNCTION_WORDS_BY_SOURCE_LANG[language] || ENGLISH_FUNCTION_WORDS;
  const phrasePattern = /(?<![\p{L}\p{M}])(?:[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*\s+){1,}[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*(?![\p{L}\p{M}])/gu;
  const wordPattern = /(?<![\p{L}\p{M}])[\p{Script=Latin}][\p{Script=Latin}\p{M}'’-]*(?![\p{L}\p{M}])/gu;
  const japaneseResiduePattern = /[\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu;
  const findings: any[] = [];
  for (const segment of segments) {
    const translation = translations.get(segment.id) || '';
    if (!translation.trim()) continue;
    const residues = new Set<string>();
    for (const match of translation.matchAll(phrasePattern)) {
      const phrase = match[0].trim();
      const words = phrase.split(/\s+/u).filter((word) => word.length > 0);
      const hasFunctionWord = words.some((word) => functionWords.has(word.toLocaleLowerCase()));
      if (words.length >= 4 || hasFunctionWord) residues.add(phrase);
    }
    for (const match of translation.matchAll(wordPattern)) {
      const word = String(match[0] || '').toLocaleLowerCase();
      if (residueWords.has(word)) residues.add(String(match[0] || ''));
    }
    if (language === 'ja') {
      for (const match of translation.matchAll(japaneseResiduePattern)) residues.add(match[0]);
    }
    if (!residues.size) continue;
    const examples = Array.from(residues).slice(0, 5);
    findings.push({
      findingId: stableFindingId('english-residue', [segment.id], examples.join('|')),
      type: 'english-residue',
      category: 'coverage',
      severity: 'review',
      confidence: 'heuristic',
      repairable: true,
      segmentIds: [segment.id],
      chapter: segment.contextPath || null,
      sourceExcerpt: segment.text.slice(0, 240),
      translationExcerpt: translation.slice(0, 360),
      residueExamples: examples,
      explanation: '中文译文里仍存在疑似未翻译的源语言词语或短语。人名、专名和刻意保留的外语表达也可能命中；日文汉字与中文汉字无法仅凭字形可靠区分，请结合上下文人工判断。',
    });
  }
  return findings;
}

function translationContextDeltaFindings(db: any, runId: string | undefined, validSourceIds: Set<string>, sourceRevisionId: string): any[] {
  if (!runId) return [];
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
  if (!run || run.source_revision_id !== sourceRevisionId) return [];
  const rows = db.prepare(
    'SELECT batch_index, delta_json FROM translation_context_deltas WHERE run_id = ? ORDER BY first_ordinal, first_segment_id'
  ).all(runId) as Array<{ batch_index: number; delta_json: string }>;
  type TargetProposal = { target: string; segmentIds: Set<string>; batches: Set<number> };
  type ProposalGroup = { source: string; names: Set<string>; targets: Map<string, TargetProposal> };
  const groups: ProposalGroup[] = [];
  const normalizeEntityName = (value: unknown) => normalized(String(value || '')).replace(/[._'’\-]+/g, ' ').trim();
  for (const row of rows) {
    let delta: any = {};
    try { delta = JSON.parse(row.delta_json || '{}'); } catch { delta = {}; }
    const entities = Array.isArray(delta.entityCandidates) ? delta.entityCandidates : [];
    for (const entity of entities) {
      const source = typeof entity?.canonicalSource === 'string' ? entity.canonicalSource.trim() : '';
      const target = typeof entity?.targetProposal === 'string' ? entity.targetProposal.trim() : '';
      if (!source || !target) continue;
      const names = new Set([source, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
        .map(normalizeEntityName).filter(Boolean));
      if (!names.size) continue;
      const matchingIndexes = groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => Array.from(names).some((name) => group.names.has(name)))
        .map(({ index }) => index);
      let group: ProposalGroup;
      if (!matchingIndexes.length) {
        group = { source, names: new Set(names), targets: new Map() };
        groups.push(group);
      } else {
        const canonicalIndex = matchingIndexes[0]!;
        group = groups[canonicalIndex]!;
        for (const name of names) group.names.add(name);
        // Explicit alias bridges can connect prior groups. Merge them without fuzzy substring
        // matching, retaining source-order target proposals and their exact evidence locations.
        for (const index of matchingIndexes.slice(1).reverse()) {
          const bridged = groups[index]!;
          for (const name of bridged.names) group.names.add(name);
          for (const [key, proposal] of bridged.targets) {
            if (!group.targets.has(key)) {
              group.targets.set(key, proposal);
            } else {
              const prior = group.targets.get(key)!;
              for (const id of proposal.segmentIds) prior.segmentIds.add(id);
              for (const batch of proposal.batches) prior.batches.add(batch);
            }
          }
          groups.splice(index, 1);
        }
      }
      const targetKey = normalizeEntityName(target);
      if (!group.targets.has(targetKey)) group.targets.set(targetKey, { target, segmentIds: new Set(), batches: new Set() });
      const targetGroup = group.targets.get(targetKey)!;
      targetGroup.batches.add(Number(row.batch_index));
      for (const evidence of Array.isArray(entity.evidence) ? entity.evidence : []) {
        const segmentId = typeof evidence?.segmentId === 'string' ? evidence.segmentId : '';
        if (validSourceIds.has(segmentId)) targetGroup.segmentIds.add(segmentId);
      }
    }
  }
  const findings: any[] = [];
  for (const group of groups) {
    if (group.targets.size < 2) continue;
    const targetOptions = Array.from(group.targets.values()).map((item) => ({
      target: item.target, batchIndexes: Array.from(item.batches).sort((a, b) => a - b),
      segmentIds: Array.from(item.segmentIds).sort(),
    }));
    const segmentIds = Array.from(new Set(targetOptions.flatMap((item) => item.segmentIds))).sort();
    findings.push({
      findingId: stableFindingId('context-delta-conflict', segmentIds, group.source + ':' + targetOptions.map((item) => normalizeEntityName(item.target)).sort().join('|')),
      type: 'context-delta-conflict',
      category: 'context',
      severity: 'warning',
      confidence: 'deterministic-conflicting-proposals',
      repairable: false,
      segmentIds,
      entity: { source: group.source, names: Array.from(group.names).sort(), proposals: targetOptions },
      explanation: '不同初译批次通过规范名称或明确别名指向同一来源实体，却提出了不同译名。系统保留来源顺序中的首个候选并记录冲突，不会自动覆盖既有或人工确认的译名；请结合各位置原文决定这些称谓是否属于同一实体。',
    });
  }
  return findings;
}


function entityMentionDriftFindings(
  db: any,
  runId: string | undefined,
  sourceRevisionId: string,
  sourceById: Map<string, string>,
  translations: Map<string, string>,
  knownEntities: unknown[] = [],
): any[] {
  if (!runId) return [];
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as { source_revision_id?: string } | undefined;
  if (!run || run.source_revision_id !== sourceRevisionId) return [];
  const rows = db.prepare(
    'SELECT batch_index, first_segment_id, delta_json FROM translation_context_deltas WHERE run_id = ? ORDER BY first_ordinal, first_segment_id'
  ).all(runId) as Array<{ batch_index: number; first_segment_id: string; delta_json: string }>;
  type Mention = { segmentId: string; sourceQuote: string; targetSurface: string; batchIndex: number };
  type Candidate = { localId: string; source: string; target: string; batchIndex: number };
  type Group = { source: string; names: Set<string>; targets: Set<string>; candidates: Candidate[]; mentions: Mention[]; localIds: Set<string> };
  const groups: Group[] = [];
  const localIdToGroup = new Map<string, Group>();
  const normalizeName = (value: unknown) => normalized(String(value || '')).replace(/[._'’\\-]+/g, ' ').trim();
  const normalizeSurface = (value: unknown) => normalized(String(value || ''));

  const mergeGroup = (target: Group, other: Group) => {
    for (const name of other.names) target.names.add(name);
    for (const value of other.targets) target.targets.add(value);
    target.candidates.push(...other.candidates);
    target.mentions.push(...other.mentions);
    for (const localId of other.localIds) {
      target.localIds.add(localId);
      localIdToGroup.set(localId, target);
    }
  };
  const findOrCreate = (source: string, aliases: unknown[], target?: string, kind?: string): Group => {
    const names = new Set([source, ...(Array.isArray(aliases) ? aliases : [])].map(normalizeName).filter(Boolean));
    const matching = groups.filter((group) => Array.from(names).some((name) => group.names.has(name)));
    let group: Group;
    if (!matching.length) {
      group = { source, names: new Set(names), targets: new Set(), candidates: [], mentions: [], localIds: new Set() };
      groups.push(group);
    } else {
      group = matching[0]!;
      for (const name of names) group.names.add(name);
      for (const duplicate of matching.slice(1)) {
        mergeGroup(group, duplicate);
        groups.splice(groups.indexOf(duplicate), 1);
      }
    }
    if (target) group.targets.add(normalizeSurface(target));
    return group;
  };

  for (const raw of knownEntities.slice(0, 160)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entity = raw as Record<string, any>;
    const source = typeof entity.source === 'string' ? entity.source.trim() : '';
    const target = typeof entity.target === 'string' ? entity.target.trim() : '';
    if (source && target) findOrCreate(source, entity.aliases, target, entity.kind);
  }

  for (const row of rows) {
    let delta: any = {};
    try { delta = JSON.parse(row.delta_json || '{}'); } catch { delta = {}; }
    const candidates = Array.isArray(delta.entityCandidates) ? delta.entityCandidates : [];
    const currentLocalIds = new Set<string>();
    for (const entity of candidates) {
      const source = typeof entity?.canonicalSource === 'string' ? entity.canonicalSource.trim() : '';
      const target = typeof entity?.targetProposal === 'string' ? entity.targetProposal.trim() : '';
      const localId = typeof entity?.localId === 'string' ? entity.localId.trim() : '';
      if (!source || !target) continue;
      const group = findOrCreate(source, entity.aliases, target, entity.kind);
      if (localId) {
        localIdToGroup.set(localId, group);
        group.localIds.add(localId);
        currentLocalIds.add(localId);
      }
      group.candidates.push({ localId, source, target, batchIndex: Number(row.batch_index) });
    }
    const mentions = Array.isArray(delta.entityMentions) ? delta.entityMentions : [];
    for (const mention of mentions) {
      const segmentId = typeof mention?.segmentId === 'string' ? mention.segmentId : '';
      const sourceQuote = typeof mention?.sourceQuote === 'string' ? mention.sourceQuote.trim() : '';
      const targetSurface = typeof mention?.targetSurface === 'string' ? mention.targetSurface.trim() : '';
      const entityRef = typeof mention?.entityRef === 'string' ? mention.entityRef.trim() : '';
      const source = sourceById.get(segmentId) || '';
      const translated = translations.get(segmentId) || '';
      if (!segmentId || !source || !sourceQuote || !targetSurface || !entityRef ||
          !normalizeName(source).includes(normalizeName(sourceQuote)) ||
          !normalizeSurface(translated).includes(normalizeSurface(targetSurface))) continue;
      let group = localIdToGroup.get(entityRef);
      if (!group) {
        const name = normalizeName(entityRef);
        group = groups.find((candidate) => candidate.names.has(name));
      }
      if (!group) continue;
      // Keep evidence local to a real source segment; validation at audit time is deliberate in
      // case stored data was migrated or imported from an older implementation.
      group.mentions.push({ segmentId, sourceQuote, targetSurface, batchIndex: Number(row.batch_index) });
    }
  }

  const findings: any[] = [];
  for (const group of groups) {
    // If candidate targets themselves disagree, the separate context-delta conflict finding is
    // more accurate than conflating canonical target choice with actual surface rendering.
    if (group.targets.size > 1) continue;
    const bySurface = new Map<string, Mention[]>();
    for (const mention of group.mentions) {
      const key = normalizeSurface(mention.targetSurface);
      const values = bySurface.get(key) || [];
      values.push(mention);
      bySurface.set(key, values);
    }
    if (bySurface.size < 2) continue;
    const segmentIds = Array.from(new Set(group.mentions.map((item) => item.segmentId))).sort();
    if (segmentIds.length < 2) continue;
    findings.push({
      findingId: stableFindingId('entity-mention-drift', segmentIds,
        group.source + ':' + Array.from(bySurface.keys()).sort().join('|')),
      type: 'entity-mention-drift',
      category: 'consistency',
      severity: 'warning',
      confidence: 'deterministic-explicit-entity-mention',
      repairable: segmentIds.length <= MAX_BULK_REPAIR_SEGMENTS,
      segmentIds,
      entity: {
        source: group.source,
        aliases: Array.from(group.names).sort(),
        canonicalTarget: group.targets.values().next().value || null,
        surfaces: Array.from(bySurface.entries()).map(([surface, items]) => ({
          surface: items[0]?.targetSurface || surface,
          segmentIds: Array.from(new Set(items.map((item) => item.segmentId))).sort(),
          batchIndexes: Array.from(new Set(items.map((item) => item.batchIndex))).sort((a, b) => a - b),
        })),
      },
      explanation: '初译显式标记了指向同一来源实体的提及，但实际译文表面形式存在差异。系统只依据规范名称/明确别名关联产生提示；称谓、语法或语境也可能合理改变表面形式，因此需要结合原文人工复核。',
    });
  }
  return findings;
}

function repeatedPhraseCandidatesFromSourceIndex(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  sourceFeatureIndex: StoredSourceFeatureIndex,
): RepeatedPhraseCandidate[] {
  const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
  const grouped = new Map<string, {
    text: string;
    normalized: string;
    unitType: 'sentence' | 'quotation';
    segmentIds: string[];
    segmentIdSet: Set<string>;
    chapterKeys: string[];
    chapterKeySet: Set<string>;
  }>();
  for (const [segmentId, features] of sourceFeatureIndex.segments) {
    const segment = sourceById.get(segmentId);
    if (!segment) continue;
    for (const unit of features.textUnits) {
      const normalizedValue = unit.normalized;
      const wordCount = normalizedValue.split(' ').filter(Boolean).length;
      if (normalizedValue.length < 12 || wordCount < 3) continue;
      const text = segment.text.slice(unit.start, unit.end).trim();
      if (!text) continue;
      const key = normalizedValue + '\u0000' + unit.unitType;
      const group = grouped.get(key) || {
        text: text.slice(0, 180),
        normalized: normalizedValue,
        unitType: unit.unitType,
        segmentIds: [],
        segmentIdSet: new Set<string>(),
        chapterKeys: [],
        chapterKeySet: new Set<string>(),
      };
      if (!group.segmentIdSet.has(segmentId)) {
        group.segmentIds.push(segmentId);
        group.segmentIdSet.add(segmentId);
      }
      const chapter = segment.contextPath || '正文';
      if (!group.chapterKeySet.has(chapter)) {
        group.chapterKeys.push(chapter);
        group.chapterKeySet.add(chapter);
      }
      grouped.set(key, group);
    }
  }
  return Array.from(grouped.values())
    .filter((group) => group.segmentIds.length > 1)
    .map((group) => ({
      text: group.text,
      normalized: group.normalized,
      unitType: group.unitType,
      count: group.segmentIds.length,
      firstSegmentId: group.segmentIds[0] || null,
      lastSegmentId: group.segmentIds[group.segmentIds.length - 1] || null,
      segmentIds: group.segmentIds.slice(0, 16),
      segmentIdsTruncated: group.segmentIds.length > 16,
      chapterKeys: group.chapterKeys.slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count || b.chapterKeys.length - a.chapterKeys.length)
    .slice(0, MAX_REPEATED_EXPRESSION_GROUPS);
}

function targetQuotationSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const patterns = [
    /“([^”]{1,3000})”/gu,
    /"([^"]{1,3000})"/gu,
    /「([^」]{1,3000})」/gu,
    /『([^』]{1,3000})』/gu,
    /‘([^’]{8,3000})’/gu,
    /'([^']{8,3000})'/gu,
  ];
  const spans: Array<{ start: number; end: number; text: string }> = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value = match[1] || '';
    const start = (match.index ?? 0) + match[0].indexOf(value);
    if (value.trim()) spans.push({ start, end: start + value.length, text: value.trim() });
  }
  return spans.sort((a, b) => a.start - b.start);
}

function repeatedExpressionFindings(
  segments: Array<{ id: string; text: string; contextPath: string; ordinal?: number }>,
  translations: Map<string, string>,
  scopedIds?: Set<string>,
  sourceFeatureIndex?: StoredSourceFeatureIndex | null,
) {
  const scanSegments: BookScanSegment[] = segments.map((segment, index) => ({
    id: segment.id,
    ordinal: index,
    text: segment.text,
    kind: 'paragraph',
    contextPath: segment.contextPath,
  }));
  const fallbackScan = sourceFeatureIndex
    ? null
    : scanBookSegments(scanSegments, { maxRepeatedPhraseGroups: MAX_REPEATED_EXPRESSION_GROUPS });
  const repeatedPhrases = sourceFeatureIndex
    ? repeatedPhraseCandidatesFromSourceIndex(segments, sourceFeatureIndex)
    : fallbackScan!.repeatedPhrases;
  const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
  const textUnits = sourceFeatureIndex
    ? Array.from(sourceFeatureIndex.segments.entries()).flatMap(([segmentId, features]) => {
        const segment = sourceById.get(segmentId);
        return segment ? features.textUnits.map((unit) => ({
          segmentId, ordinal: segment.ordinal ?? 0, chapterKey: segment.contextPath,
          unitType: unit.unitType, normalized: unit.normalized, start: unit.start, end: unit.end,
        })) : [];
      })
    : fallbackScan!.textUnits;
  const quoteUnitsBySegment = new Map<string, number>();
  for (const unit of textUnits) {
    if (unit.unitType === 'quotation') quoteUnitsBySegment.set(unit.segmentId, (quoteUnitsBySegment.get(unit.segmentId) || 0) + 1);
  }

  type AlignedRow = { id: string; text: string };
  type AlignmentGroup = { method: 'whole-segment' | 'quoted-span'; rows: AlignedRow[] };
  const findings: any[] = [];
  for (const phrase of repeatedPhrases) {
    const occurrenceUnits = textUnits.filter((unit) =>
      unit.unitType === phrase.unitType && unit.normalized === phrase.normalized &&
      (!scopedIds || scopedIds.has(unit.segmentId)));
    const ids = Array.from(new Set(occurrenceUnits.map((unit) => unit.segmentId)));
    if (ids.length < 2) continue;
    const groups = new Map<AlignmentGroup['method'], AlignmentGroup>();
    const unresolvedIds: string[] = [];

    for (const id of ids) {
      const source = sourceById.get(id);
      const translation = translations.get(id) || '';
      if (!source || !translation.trim()) continue;
      let alignedText = '';
      let method: AlignmentGroup['method'] | null = null;

      // Comparing full translations is valid only when the repeated sentence is the whole source
      // segment. Embedded source sentences must not inherit differences from their surrounding prose.
      if (phrase.unitType === 'sentence' && normalizedPhrase(source.text) === phrase.normalized) {
        alignedText = translation;
        method = 'whole-segment';
      } else if (phrase.unitType === 'quotation') {
        const translatedQuotes = targetQuotationSpans(translation);
        if (translatedQuotes.length === 1) {
          alignedText = translatedQuotes[0]!.text;
          method = 'quoted-span';
        } else if (translatedQuotes.length === 0 && quoteUnitsBySegment.get(id) === 1 &&
          /\b(said|asked|replied|answered|whispered|shouted|murmured|called|cried|remarked|added|insisted|told)\b/i.test(source.text) &&
          !/(?:说道|说着|说|问道|答道|低声|大喊|喊道|回答|whispered|said|asked|replied)/i.test(translation)) {
          // Some translation styles omit quotation marks while omitting source-language speaker
          // attribution entirely. Only use the entire target as the quote when that structure is clear.
          alignedText = translation;
          method = 'quoted-span';
        }
      }
      if (!method || !alignedText.trim()) {
        unresolvedIds.push(id);
        continue;
      }
      const group = groups.get(method) || { method, rows: [] };
      group.rows.push({ id, text: alignedText });
      groups.set(method, group);
    }

    for (const group of groups.values()) {
      if (group.rows.length < 2) continue;
      const variants = new Map<string, string[]>();
      for (const row of group.rows) {
        const key = normalizedPhrase(row.text);
        const variantIds = variants.get(key) || [];
        variantIds.push(row.id);
        variants.set(key, variantIds);
      }
      if (variants.size <= 1) continue;

      const alignedIds = group.rows.map((row) => row.id);
      const maxListedIds = MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING;
      const uniqueKey = phrase.normalized + ':' + group.method;
      findings.push({
        findingId: stableFindingId('repeated-expression-drift', alignedIds.slice(0, 32), uniqueKey),
        type: 'repeated-expression-drift',
        category: 'consistency',
        severity: 'warning',
        confidence: group.method === 'whole-segment' ? 'deterministic-whole-segment-match' : 'deterministic-quoted-span-match',
        repairable: alignedIds.length <= MAX_BULK_REPAIR_SEGMENTS,
        segmentIds: alignedIds.slice(0, maxListedIds),
        occurrenceCount: alignedIds.length,
        segmentIdsTruncated: alignedIds.length > maxListedIds,
        sourceExcerpt: phrase.text,
        alignmentMethod: group.method,
        alignedOccurrenceCount: group.rows.length,
        unresolvedOccurrenceCount: unresolvedIds.length,
        variants: Array.from(variants.entries()).map(([normalizedTranslation, variantIds]) => ({
          segmentIds: variantIds.slice(0, maxListedIds),
          occurrenceCount: variantIds.length,
          segmentIdsTruncated: variantIds.length > maxListedIds,
          normalizedTranslation,
          sampleTranslation: (group.rows.find((row) => variantIds.includes(row.id))?.text || '').slice(0, 320),
        })),
        explanation: group.method === 'whole-segment'
          ? '相同原文句子本身在不同位置存在不同译法；请判断差异是否由语境驱动。'
          : '相同原文引语在不同位置的对应译文引语存在差异；只比较了可定位的引语内容，没有比较周围叙述。',
      });
    }

    // Embedded, unquoted phrases cannot be aligned to target text reliably using string heuristics.
    // Keep them visible as a review task, but do not call whole-paragraph variation a proven drift.
    if (!groups.size && unresolvedIds.length >= 2) {
      findings.push({
        findingId: stableFindingId('repeated-expression-alignment-review', unresolvedIds.slice(0, 32), phrase.normalized),
        type: 'repeated-expression-alignment-review',
        category: 'consistency',
        severity: 'info',
        confidence: 'source-match-target-alignment-unavailable',
        repairable: false,
        segmentIds: unresolvedIds.slice(0, MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING),
        occurrenceCount: unresolvedIds.length,
        segmentIdsTruncated: unresolvedIds.length > MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING,
        sourceExcerpt: phrase.text,
        explanation: '原文中存在重复句子，但它嵌入了不同上下文，系统无法可靠定位对应译文片段。为避免误报，没有将完整段落译文的差异判定为重复表达漂移；建议人工复核或在未来使用经过验证的句段对齐。',
      });
    }
  }
  return findings;
}

function runMetrics(projectId: string, runId: string): any {
  const store = getDocumentProjectStore();
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const context = store.getRunContext(projectId, runId);
  if (context.run.sourceRevisionId !== currentSourceRevisionId) fail('对照评测只支持当前同一来源版本上的运行。', 409);
  const sourceRows = db.prepare(
    'SELECT ss.segment_id AS id, ss.ordinal, ss.text, ss.kind, ss.context_path AS contextPath ' +
    'FROM run_segments rs JOIN source_segments ss ON ss.segment_id = rs.segment_id ' +
    'AND ss.source_revision_id = ? WHERE rs.run_id = ? ORDER BY ss.ordinal'
  ).all(currentSourceRevisionId, runId) as any[];
  if (!sourceRows.length) fail('运行没有可比较的片段。', 409);
  const resultRows = db.prepare(
    'SELECT rs.segment_id AS id, rs.status, r.translation_text AS text ' +
    'FROM run_segments rs LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  const translationById = new Map<string, string>();
  const statusById = new Map<string, string>();
  for (const row of resultRows) {
    statusById.set(String(row.id), String(row.status));
    if (typeof row.text === 'string' && row.text.trim()) translationById.set(String(row.id), String(row.text));
  }
  const segments = sourceRows.map((row) => ({
    id: String(row.id), ordinal: Number(row.ordinal), text: String(row.text),
    kind: String(row.kind || 'paragraph'), contextPath: String(row.contextPath || ''),
  }));
  const normalizedSegments = segments.map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath }));
  const auditMemory = memoryWithGlossary(context.memory, context.prompt?.config?.glossary);
  const mappingConflictAudit = canonicalNameMappingConflictFindings(normalizedSegments, auditMemory);
  const entities = terminologyFindings(
    normalizedSegments, translationById, auditMemory, mappingConflictAudit.conflictedSources,
  ).filter((item) => item.category === 'terminology');
  const sourceLang = String(context.run.sourceLang || 'auto');
  const residues = englishResidueFindings(normalizedSegments, translationById, String(context.run.targetLang || ''), sourceLang);
  const numbers = numericFindings(normalizedSegments, translationById, sourceLang);
  const scopedIds = new Set(segments.map((item) => item.id));
  ensureSourceFeatureIndex(projectId, currentSourceRevisionId, sourceLang);
  const storedSourceIndex = readSourceFeatureIndex(db, currentSourceRevisionId, sourceLang);
  const repeated = repeatedExpressionFindings(normalizedSegments, translationById, scopedIds, storedSourceIndex);
  const findings = db.prepare('SELECT category, finding_json FROM review_findings WHERE run_id = ?').all(runId) as any[];
  const styleFindings = findings.filter((row) => row.category === 'style').length;
  const voiceFindings = findings.filter((row) => {
    if (row.category !== 'style') return false;
    try { return JSON.parse(row.finding_json).dimension === 'character_voice'; } catch { return false; }
  }).length;
  const eventRows = db.prepare('SELECT event_type, payload_json FROM project_events WHERE run_id = ? ORDER BY event_id').all(runId) as any[];
  const events = eventRows.map((row) => ({ type: String(row.event_type), payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })() }));
  const translationCalls = events.filter((event) => event.type === 'batch.prompt.ready').length;
  const reviewCalls = events.filter((event) => event.type === 'stage.started' && ['review', 'style-review'].includes(String(event.payload.stage))).length;
  const translationInputChars = events.filter((event) => event.type === 'batch.prompt.ready').reduce((sum, event) =>
    sum + Number(event.payload.userPromptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const reviewerInputChars = events.filter((event) => ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage)))
    .reduce((sum, event) => sum + Number(event.payload.promptChars || 0) + Number(event.payload.systemPromptChars || 0), 0);
  const durationMs = events.filter((event) =>
    event.type === 'batch.model.response' || event.type === 'model.call.failed' ||
    ['stage.completed', 'stage.warning'].includes(event.type) && ['review', 'style-review'].includes(String(event.payload.stage))
  ).reduce((sum, event) => sum + Number(event.payload.durationMs || 0), 0);
  const missing = segments.filter((segment) => !translationById.get(segment.id)?.trim()).length;
  const coverage = segments.length ? Math.round(((segments.length - missing) / segments.length) * 1000) / 10 : 100;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  return {
    runId,
    sourceRevisionId: currentSourceRevisionId,
    promptRevisionId: context.run.promptRevisionId,
    memoryRevisionId: context.run.literaryMemoryRevisionId,
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    provider: context.run.provider,
    model: context.run.model,
    translationMode: context.run.translationMode,
    reviewEnabled: context.run.reviewEnabled,
    status: context.run.status,
    segmentIds: segments.map((item) => item.id),
    metrics: {
      segmentCount: segments.length,
      translatedSegmentCount: segments.length - missing,
      missingTranslationCount: missing,
      missingTranslationRatePer100Segments: ratePer100(missing),
      coveragePercent: coverage,
      terminologyDriftCount: entities.length,
      terminologyDriftRatePer100Segments: ratePer100(entities.length),
      canonicalNameMappingConflictCount: mappingConflictAudit.findings.length,
      englishResidueCount: residues.length,
      englishResidueRatePer100Segments: ratePer100(residues.length),
      numericTokenMismatchCount: numbers.length,
      numericTokenMismatchRatePer100Segments: ratePer100(numbers.length),
      repeatedExpressionDriftGroups: repeated.filter((item) => item.type === 'repeated-expression-drift').length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeated.filter((item) => item.type === 'repeated-expression-drift').length),
      styleFindingCount: styleFindings,
      styleFindingRatePer100Segments: ratePer100(styleFindings),
      characterVoiceFindingCount: voiceFindings,
      characterVoiceFindingRatePer100Segments: ratePer100(voiceFindings),
      translationRequestCount: translationCalls,
      reviewerRequestCount: reviewCalls,
      totalPipelineRequestCount: translationCalls + reviewCalls,
      translationPromptChars: translationInputChars,
      reviewerPromptCharsKnown: reviewerInputChars,
      totalPromptCharsKnown: translationInputChars + reviewerInputChars,
      modelDurationMsKnown: durationMs,
      tokenAndBillingCostsAvailable: false,
    },
    findings: [...mappingConflictAudit.findings, ...entities, ...residues, ...numbers, ...repeated],
  };
}

function auditTargetLanguage(db: any, runId?: string): string {
  if (runId) {
    const row = db.prepare('SELECT target_lang AS targetLang FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (typeof row?.targetLang === 'string' && row.targetLang.trim()) return row.targetLang.trim();
  }
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  try {
    const config = row?.config_json ? JSON.parse(row.config_json) : {};
    if (typeof config?.targetLang === 'string' && config.targetLang.trim()) return config.targetLang.trim();
  } catch { /* malformed historical config: use the product default */ }
  return 'zh';
}

function auditSourceLanguage(db: any, runId?: string): string {
  if (runId) {
    const row = db.prepare('SELECT source_lang AS sourceLang FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (typeof row?.sourceLang === 'string' && row.sourceLang.trim()) return row.sourceLang.trim();
  }
  const row = db.prepare('SELECT config_json FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  try {
    const config = row?.config_json ? JSON.parse(row.config_json) : {};
    if (typeof config?.sourceLang === 'string' && config.sourceLang.trim()) return config.sourceLang.trim();
  } catch { /* malformed historical config: use product auto-detection */ }
  return 'auto';
}

/**
 * 对当前来源版本执行全书确定性质量审计，并合并相关 Reviewer/上下文漂移发现。
 * 可选择叠加一个已结束 Run 的候选译文；审计只产出 finding/metric，不自动修改或采纳译文。
 * 报告固定 sourceRevisionId，后续返工必须再次校验该 revision 仍是当前版本。
 */
export function runProjectQualityAudit(projectId: string, runId?: string): Record<string, any> {
  const { store, context, segments } = currentSource(projectId);
  if (!segments.length) fail('当前来源版本没有可审计的片段。', 409);
  // Each document project owns its own SQLite database, so every row here belongs to this project.
  // "partial" is a terminal status, not an active worker: its missing accepted translations need auditing.
  const active = context.db.prepare(
    "SELECT run_id FROM translation_runs WHERE status IN ('queued','running','paused') LIMIT 1"
  ).get() as { run_id?: string } | undefined;
  if (active?.run_id && (!runId || runId === active.run_id)) {
    fail('当前项目仍有运行中的或已暂停的任务，请等待完成或继续运行后再审计；若需检查候选结果，请提供已结束的 runId。', 409);
  }
  if (runId) {
    const requestedRun = context.db.prepare('SELECT status FROM translation_runs WHERE run_id = ?').get(runId) as { status?: string } | undefined;
    if (!requestedRun) fail('找不到质量审计指定的翻译运行：' + runId, 404);
    if (!['completed', 'awaiting_acceptance'].includes(String(requestedRun.status))) {
      fail('只有已完成或等待采纳的运行可以作为审计候选来源。', 409);
    }
  }
  const acceptedTranslationMap = acceptedTranslations(context.db, context.currentSourceRevisionId);
  const acceptedTranslationSnapshotHash = translationSnapshotHash(segments, acceptedTranslationMap);
  const translations = new Map(acceptedTranslationMap);
  if (runId) overlayRunCandidates(context.db, context.currentSourceRevisionId, runId, translations);
  const effectiveTranslationSnapshotHash = translationSnapshotHash(segments, translations);
  const memory = loadMemory(projectId, runId);
  const mappingConflictAudit = canonicalNameMappingConflictFindings(segments, memory);
  const termFindings = terminologyFindings(segments, translations, memory, mappingConflictAudit.conflictedSources);
  const sourceLang = auditSourceLanguage(context.db, runId);
  const residueFindings = englishResidueFindings(segments, translations, auditTargetLanguage(context.db, runId), sourceLang);
  const missing = segments.filter((segment) => !translations.get(segment.id)?.trim()).map((segment) => ({
    findingId: stableFindingId('missing-translation', [segment.id], context.currentSourceRevisionId),
    type: 'missing-translation',
    category: 'coverage',
    severity: 'must-fix',
    repairable: true,
    segmentIds: [segment.id],
    chapter: segment.contextPath || null,
    sourceExcerpt: segment.text.slice(0, 240),
    explanation: '该来源片段没有当前可用的已采纳译文或本次运行候选译文。',
  }));
  const numberFindings = numericFindings(segments, translations, sourceLang);
  ensureSourceFeatureIndex(projectId, context.currentSourceRevisionId, sourceLang);
  const storedSourceIndex = readSourceFeatureIndex(context.db, context.currentSourceRevisionId, sourceLang);
  const repeatedFindings = repeatedExpressionFindings(segments, translations, undefined, storedSourceIndex);
  const presentIds = new Set(segments.map((segment) => segment.id));
  const outputFindings = translationOutputValidationFindings(context.db, runId, presentIds);
  const contextFindings = translationContextDeltaFindings(context.db, runId, presentIds, context.currentSourceRevisionId);
  const sourceById = new Map(segments.map((segment) => [segment.id, segment.text]));
  const mentionFindings = entityMentionDriftFindings(
    context.db, runId, context.currentSourceRevisionId, sourceById, translations,
    Array.isArray(memory.entities) ? memory.entities : [],
  );
  const review = currentReviewFindings(context.db, context.currentSourceRevisionId, runId);
  const reviewFindings = review.findings.filter((finding) => presentIds.has(finding.segmentId)).map((finding) => ({
    findingId: 'review_' + finding.findingId,
    type: finding.category === 'accuracy'
      ? 'accuracy-review'
      : finding.category === 'terminology'
        ? 'reviewer-terminology-review'
        : finding.dimension === 'character_voice' ? 'character-voice-review' : 'style-review',
    category: finding.category,
    severity: finding.priority === 'must_fix' ? 'must-fix' : 'review',
    repairable: true,
    segmentIds: [finding.segmentId],
    reviewRunId: review.reviewRunId,
    status: finding.status,
    dimension: finding.dimension,
    characterId: finding.characterId,
    sourceExcerpt: finding.sourceExcerpt,
    draftExcerpt: finding.draftExcerpt || finding.reviewedTranslation,
    evidenceSegmentIds: finding.evidenceSegmentIds,
    reason: finding.reason,
    suggestion: finding.suggestion,
    proposedTranslation: finding.proposedTranslation,
  }));
  const findings = [
    ...missing, ...mappingConflictAudit.findings, ...termFindings, ...residueFindings,
    ...numberFindings, ...repeatedFindings, ...outputFindings, ...contextFindings, ...mentionFindings, ...reviewFindings,
  ];
  const auditId = randomUUID();
  const translatedCount = segments.length - missing.length;
  const ratePer100 = (count: number) => segments.length ? Math.round(count / segments.length * 1000) / 10 : 0;
  const report = {
    auditId,
    projectId,
    sourceRevisionId: context.currentSourceRevisionId,
    runId: runId || null,
    // Aggregate hashes keep stale-repair protection bounded even for very long books.
    translationSnapshotHash: effectiveTranslationSnapshotHash,
    acceptedTranslationSnapshotHash,
    reviewRunId: review.reviewRunId,
    createdAt: new Date().toISOString(),
    analysisLimits: {
      repeatedExpressionGroupsAnalyzed: MAX_REPEATED_EXPRESSION_GROUPS,
      sourceFeatureIndexVersion: storedSourceIndex?.indexVersion || null,
      sourceFeatureIndexUsed: Boolean(storedSourceIndex),
      sourceFeatureIndexSegments: storedSourceIndex?.sourceSegmentCount || 0,
      maximumLocationsListedPerRepeatedExpression: MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING,
      maximumSegmentsForFindingLevelRepair: MAX_BULK_REPAIR_SEGMENTS,
      note: '全书原文参与确定性扫描；为控制报告规模，重复表达最多分析前 300 个高频候选组，单组最多列出 500 个位置。更大范围必须显式选 segmentIds 返工。',
    },
    metrics: {
      sourceSegmentCount: segments.length,
      translatedSegmentCount: translatedCount,
      missingTranslationCount: missing.length,
      missingTranslationRatePer100Segments: ratePer100(missing.length),
      coveragePercent: segments.length ? Math.round(translatedCount / segments.length * 1000) / 10 : 100,
      terminologyDriftCount: termFindings.length,
      terminologyDriftRatePer100Segments: ratePer100(termFindings.length),
      canonicalNameMappingConflictCount: mappingConflictAudit.findings.length,
      englishResidueCount: residueFindings.length,
      englishResidueRatePer100Segments: ratePer100(residueFindings.length),
      numericTokenMismatchCount: numberFindings.length,
      numericTokenMismatchRatePer100Segments: ratePer100(numberFindings.length),
      duplicateOutputIdFindingCount: outputFindings.filter((item) => item.type === 'duplicate-output-id').length,
      malformedOutputFindingCount: outputFindings.filter((item) => item.type === 'malformed-output-row').length,
      unexpectedOutputIdFindingCount: outputFindings.filter((item) => item.type === 'unexpected-output-id').length,
      repeatedExpressionDriftGroups: repeatedFindings.filter((item) => item.type === 'repeated-expression-drift').length,
      contextDeltaConflictCount: contextFindings.length,
      entityMentionDriftCount: mentionFindings.length,
      repeatedExpressionAlignmentReviewCount: repeatedFindings.filter((item) => item.type === 'repeated-expression-alignment-review').length,
      repeatedExpressionDriftRatePer100Segments: ratePer100(repeatedFindings.filter((item) => item.type === 'repeated-expression-drift').length),
      accuracyReviewFindingCount: reviewFindings.filter((item) => item.category === 'accuracy').length,
      reviewerTerminologyFindingCount: reviewFindings.filter((item) => item.category === 'terminology').length,
      styleReviewFindingCount: reviewFindings.filter((item) => item.category === 'style').length,
      styleFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.category === 'style').length),
      characterVoiceFindingCount: reviewFindings.filter((item) => item.type === 'character-voice-review').length,
      characterVoiceFindingRatePer100Segments: ratePer100(reviewFindings.filter((item) => item.type === 'character-voice-review').length),
      repairableFindingCount: findings.filter((item) => item.repairable).length,
    },
    interpretation: [
      '遗漏检查为确定性检查。',
      '术语漂移是基于已确认规范译名的启发式提示；未出现规范译名不一定代表错误。',
      '人物规范译名冲突会单独报告，不会在多个已确认译名之间自动选一个。',
      '英文残留检测只提供启发式复核提示；专名或刻意保留的外语也可能命中。',
      '数字序列差异是启发式提示，需考虑中文数字、日期格式和上下文后人工确认。',
      '重复表达只对重复源文片段的译文差异提示复核，不自动统一。',
      '重复输出 ID、未知输出 ID 和结构不合法的模型响应只从运行事件报告，不接受这些异常行。',
      '同一实体的候选译名冲突来自初译 context_delta 的来源证据，仅作为人工复核项；不会自动统一译名或自动返工。',
      '准确性/遗漏、术语、人物声线与文风提示来自已有 Reviewer 发现；若没有运行相应审校，报告不能证明该类问题不存在。',
      '所有修订都进入新的候选 Run，不自动覆盖已采纳或人工修改的译文。',
    ],
    findings,
  };
  store.saveQualityAudit(projectId, report);
  store.appendEvent(projectId, runId || null, 'quality-audit.completed', {
    auditId, sourceRevisionId: context.currentSourceRevisionId, metrics: report.metrics,
  });
  return report;
}

/**
 * 根据指定审计 finding 创建一个新的窄范围返工 Run。
 * 先验证报告仍属于当前 source revision，再解析 finding/segment 范围；大范围 finding 要求调用方
 * 显式提交 segmentIds，避免“修一个问题”隐式扩展成整组/整章返工。手动返工仍需用户采纳；
 * 自动返工只能由 Run 策略启用，并在服务端经同一采纳事务完成。
 */
export function createQualityRepairRun(
  projectId: string,
  auditId: string,
  selectedFindingIds: string[],
  requestedSegmentIds: string[] = [],
  options: { automatic?: boolean; parentRunId?: string } = {},
): any {
  const store = getDocumentProjectStore();
  const report = store.getQualityAudit(projectId, auditId) as any;
  if (!report) fail('找不到质量审计报告：' + auditId, 404);
  const projectContext = store.getProjectContext(projectId);
  const { currentSourceRevisionId, db } = projectContext;
  if (report.sourceRevisionId !== currentSourceRevisionId) fail('来源版本已变化，旧质量报告不能用于返工。', 409);

  const currentSourceSegments = db.prepare(
    'SELECT segment_id AS id FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(currentSourceRevisionId) as Array<{ id: string }>;
  const storedAcceptedTranslations = acceptedTranslations(db, currentSourceRevisionId);
  const currentAcceptedSnapshotHash = translationSnapshotHash(currentSourceSegments, storedAcceptedTranslations);
  const acceptedSnapshotAtAudit = typeof report.acceptedTranslationSnapshotHash === 'string'
    ? report.acceptedTranslationSnapshotHash : '';
  const effectiveSnapshotAtAudit = typeof report.translationSnapshotHash === 'string'
    ? report.translationSnapshotHash : '';
  if (!acceptedSnapshotAtAudit || !effectiveSnapshotAtAudit) {
    fail('该质量报告未记录译文快照，无法安全判断问题是否已被修正。请重新执行全书审计后再返工。', 409);
  }
  // A run's candidates may be accepted after the audit. That is safe only if the whole accepted
  // text now equals either the accepted snapshot or the effective text actually audited. Aggregate
  // hashes keep the report compact; a different third snapshot means the audit is stale.
  if (currentAcceptedSnapshotHash !== acceptedSnapshotAtAudit &&
      currentAcceptedSnapshotHash !== effectiveSnapshotAtAudit) {
    fail('审计后已有译文被修改；旧质量报告不能用于返工，请重新执行全书审计。', 409);
  }
  const wantedFindings = new Set(selectedFindingIds);
  // Explicit segment IDs mean a genuinely narrow repair. They must not expand to every segment
  // in a repeated-expression group simply because that segment belongs to the same finding.
  const segments = new Set<string>(requestedSegmentIds.map(String).filter(Boolean));
  if (!requestedSegmentIds.length) {
    for (const finding of report.findings || []) {
      if (!wantedFindings.has(finding.findingId)) continue;
      if (!finding.repairable) {
        fail('该质量发现涉及较多片段，为避免扩大返工，请显式提供要修改的 segmentIds。');
      }
      for (const id of finding.segmentIds || []) segments.add(String(id));
    }
  }
  if (!segments.size) fail('没有选中可返工的质量发现；请提供报告中的 findingId 或 segmentId。');
  const currentIds = new Set(currentSourceSegments.map((row) => String(row.id)));
  const selected = Array.from(segments).filter((id) => currentIds.has(id));
  if (!selected.length) fail('选定的返工片段不属于当前来源版本。', 409);
  const parentRunId = options.parentRunId || report.runId || undefined;
  const run = store.createRun(projectId, {
    scope: {
      type: 'ids',
      ids: selected,
      ...(options.automatic ? { automation: { kind: 'quality-audit-repair', pass: 1 } } : {}),
    },
    ...(parentRunId ? { parentRunId } : {}),
  });
  store.appendEvent(projectId, run.runId, 'quality-repair.planned', {
    auditId, parentRunId: parentRunId || null, segmentIds: selected,
    automatic: options.automatic === true,
    humanAcceptanceRequired: options.automatic !== true,
  });
  return { auditId, run, segmentIds: selected, humanAcceptanceRequired: options.automatic !== true, automatic: options.automatic === true };
}

function runComparisonData(projectId: string, runId: string) {
  const store = getDocumentProjectStore();
  const metrics = runMetrics(projectId, runId);
  const context = store.getRunContext(projectId, runId);
  const { db } = store.getProjectContext(projectId);
  const translations = new Map<string, string>();
  const rows = db.prepare(
    'SELECT rs.segment_id AS id, r.translation_text AS text FROM run_segments rs ' +
    'LEFT JOIN translation_results r ON r.result_id = rs.candidate_result_id WHERE rs.run_id = ?'
  ).all(runId) as any[];
  for (const row of rows) if (typeof row.text === 'string' && row.text.trim()) translations.set(String(row.id), String(row.text));
  return { metrics, context, translations };
}

/**
 * 对两个不同 Run 做同源版本的前后对照评测。
 * 先比较来源版本和语言条件，再计算确定性指标并生成盲评映射；不同来源版本的数字没有可比性，
 * 盲评/人工评价与自动指标分开保存，不能将模型自报分数当作实际质量改善证据。
 */
export function createProjectQualityEvaluation(projectId: string, beforeRunId: string, afterRunId: string): Record<string, any> {
  if (!beforeRunId || !afterRunId || beforeRunId === afterRunId) fail('必须提供两个不同的 beforeRunId 和 afterRunId。');
  const store = getDocumentProjectStore();
  const before = runComparisonData(projectId, beforeRunId);
  const after = runComparisonData(projectId, afterRunId);
  if (before.metrics.sourceRevisionId !== after.metrics.sourceRevisionId) fail('前后运行的来源版本不同，不能作有效对照。', 409);
  if (before.metrics.targetLang !== after.metrics.targetLang || before.context.run.sourceLang !== after.context.run.sourceLang) {
    fail('前后运行的源语言或目标语言不同，不能作有效对照。', 409);
  }
  if (before.metrics.translationMode !== after.metrics.translationMode) {
    fail('前后运行的翻译模式不同，不能作有效对照。', 409);
  }
  const comparableStatuses = new Set(['completed', 'awaiting_acceptance']);
  if (!comparableStatuses.has(before.metrics.status) || !comparableStatuses.has(after.metrics.status)) {
    fail('前后运行必须已完成翻译和审校并进入 completed 或 awaiting_acceptance；不能比较仍在运行、暂停或取消的结果。', 409);
  }
  const afterIdSet = new Set<string>(after.metrics.segmentIds);
  if (before.metrics.segmentIds.length !== after.metrics.segmentIds.length ||
      before.metrics.segmentIds.some((id: string) => !afterIdSet.has(id))) {
    fail('前后运行的片段范围不同；为了可比性，必须使用同一来源版本和相同片段集合。', 409);
  }
  const beforeIds = new Set(before.metrics.segmentIds);
  const segmentsRows = store.getProjectContext(projectId).db.prepare(
    'SELECT segment_id AS id, ordinal, text, context_path AS contextPath FROM source_segments WHERE source_revision_id = ? ORDER BY ordinal'
  ).all(before.metrics.sourceRevisionId) as any[];
  const sourceById = new Map(segmentsRows.map((row) => [String(row.id), row]));
  const candidateIds = before.metrics.segmentIds.filter((id: string) =>
    before.translations.get(id) !== after.translations.get(id));
  const prioritized = candidateIds;
  const maxBlindItems = 40;
  const maxSamples = Math.min(maxBlindItems, prioritized.length);
  const byChapter = new Map<string, string[]>();
  for (const id of prioritized) {
    const segment = sourceById.get(id);
    if (!segment) continue;
    const chapter = String(segment.contextPath || '');
    const list = byChapter.get(chapter) || [];
    list.push(id);
    byChapter.set(chapter, list);
  }
  const chapterEntries = Array.from(byChapter.entries());
  const selected = new Set<string>();
  // Reserve one sample per evenly spaced chapter first, then use evenly spaced remaining
  // changed segments. This prevents long novels from sampling only the first 40 chapters.
  const chapterSlots = Math.min(maxSamples, chapterEntries.length);
  for (let i = 0; i < chapterSlots; i++) {
    const chapterIndex = Math.floor(i * chapterEntries.length / chapterSlots);
    const representative = chapterEntries[chapterIndex]?.[1]?.[0];
    if (representative) selected.add(representative);
  }
  const remainingIds = prioritized.filter((id: string) => !selected.has(id));
  const additionalSlots = Math.min(maxSamples - selected.size, remainingIds.length);
  for (let i = 0; i < additionalSlots; i++) {
    const index = Math.floor(i * remainingIds.length / additionalSlots);
    selected.add(remainingIds[index]!);
  }
  const blindMapping: Record<string, { A: 'before' | 'after'; B: 'before' | 'after' }> = {};
  const blindPacket = Array.from(selected).map((id) => {
    const source = sourceById.get(id)!;
    const beforeText = before.translations.get(id) || '';
    const afterText = after.translations.get(id) || '';
    const swap = randomInt(2) === 1;
    const mapping = { A: swap ? 'after' as const : 'before' as const, B: swap ? 'before' as const : 'after' as const };
    blindMapping[id] = mapping;
    return {
      segmentId: id,
      chapter: String(source.contextPath || ''),
      source: String(source.text || ''),
      variantA: mapping.A === 'before' ? beforeText : afterText,
      variantB: mapping.B === 'before' ? beforeText : afterText,
    };
  });
  const metricKeys = [
    'missingTranslationCount', 'missingTranslationRatePer100Segments', 'coveragePercent', 'terminologyDriftCount',
    'terminologyDriftRatePer100Segments', 'numericTokenMismatchCount', 'numericTokenMismatchRatePer100Segments',
    'repeatedExpressionDriftGroups', 'repeatedExpressionDriftRatePer100Segments',
    'styleFindingCount', 'styleFindingRatePer100Segments', 'characterVoiceFindingCount', 'characterVoiceFindingRatePer100Segments',
    'totalPipelineRequestCount', 'totalPromptCharsKnown', 'modelDurationMsKnown',
  ];
  const delta: Record<string, number> = {};
  for (const key of metricKeys) {
    const a = Number(before.metrics.metrics[key] || 0);
    const b = Number(after.metrics.metrics[key] || 0);
    delta[key] = Math.round((b - a) * 100) / 100;
  }
  const evaluationId = randomUUID();
  const report: any = {
    evaluationId,
    projectId,
    sourceRevisionId: before.metrics.sourceRevisionId,
    beforeRunId,
    afterRunId,
    createdAt: new Date().toISOString(),
    comparable: true,
    deterministic: {
      configuration: {
        before: {
          sourceLang: before.metrics.sourceLang, targetLang: before.metrics.targetLang,
          provider: before.metrics.provider, model: before.metrics.model,
          translationMode: before.metrics.translationMode, reviewEnabled: before.metrics.reviewEnabled,
          promptRevisionId: before.metrics.promptRevisionId, memoryRevisionId: before.metrics.memoryRevisionId,
          status: before.metrics.status,
        },
        after: {
          sourceLang: after.metrics.sourceLang, targetLang: after.metrics.targetLang,
          provider: after.metrics.provider, model: after.metrics.model,
          translationMode: after.metrics.translationMode, reviewEnabled: after.metrics.reviewEnabled,
          promptRevisionId: after.metrics.promptRevisionId, memoryRevisionId: after.metrics.memoryRevisionId,
          status: after.metrics.status,
        },
      },
      before: before.metrics.metrics,
      after: after.metrics.metrics,
      deltaAfterMinusBefore: delta,
      improvementSignals: {
        missingTranslationsDecreased: delta.missingTranslationCount < 0,
        terminologyWarningsDecreased: delta.terminologyDriftCount < 0,
        repeatedExpressionWarningsDecreased: delta.repeatedExpressionDriftGroups < 0,
        coverageIncreased: delta.coveragePercent > 0,
      },
      runDisclosure: null as null | { beforeRunId: string; afterRunId: string },
    },
    blindReview: {
      status: blindPacket.length ? 'pending' : 'not_applicable',
      sampleCount: blindPacket.length,
      instruction: blindPacket.length
        ? '请先对照原文盲评 A/B，不要查阅运行 ID；每个样本只比较给定维度，不预设修订版本一定更好。A/B 位置已按样本独立随机化。'
        : '前后运行的目标译文完全相同，没有可进行文本偏好盲评的样本；仅报告覆盖率、审校发现与可用成本指标。',
      packet: blindPacket,
      result: blindPacket.length ? null : { reason: 'no_translation_differences' },
    },
  };
  if (!blindPacket.length) report.deterministic.runDisclosure = { beforeRunId, afterRunId };
  store.saveQualityEvaluation(projectId, report, blindMapping, []);
  store.appendEvent(projectId, afterRunId, 'quality-evaluation.created', {
    evaluationId, beforeRunId, afterRunId, sampleCount: blindPacket.length,
    costMetrics: {
      beforePipelineRequests: before.metrics.metrics.totalPipelineRequestCount,
      afterPipelineRequests: after.metrics.metrics.totalPipelineRequestCount,
      beforeDurationMs: before.metrics.metrics.modelDurationMsKnown,
      afterDurationMs: after.metrics.metrics.modelDurationMsKnown,
    },
  });
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: true,
    blindReview: report.blindReview,
    ...(blindPacket.length ? {
      instruction: '在完成盲评之前不返回 before/after 对照指标或 A/B 对应关系。',
    } : {
      deterministic: report.deterministic,
      beforeRunId,
      afterRunId,
    }),
  };
}

export function submitProjectQualityEvaluationReviews(
  projectId: string,
  evaluationId: string,
  reviewsInput: unknown,
): Record<string, any> {
  if (!Array.isArray(reviewsInput) || !reviewsInput.length || reviewsInput.length > 80) {
    fail('reviews 必须是 1-80 条人工盲评记录。');
  }
  const store = getDocumentProjectStore();
  const loaded = store.getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  if (report.blindReview?.status !== 'pending') fail('当前质量评测不处于待盲评状态。', 409);
  const allowed = new Set<string>((report.blindReview.packet || []).map((item: any) => String(item.segmentId)));
  const reviews: any[] = Array.isArray(loaded.blindReviews) ? [...loaded.blindReviews] : [];
  const existing = new Map(reviews.map((item) => [item.segmentId + ':' + item.dimension, item]));
  for (const raw of reviewsInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const segmentId = String((raw as any).segmentId || '');
    const dimension = ['overall', 'accuracy', 'terminology', 'voice', 'style'].includes((raw as any).dimension)
      ? String((raw as any).dimension) : 'overall';
    const preference = String((raw as any).preference || '');
    if (!allowed.has(segmentId)) fail('盲评包含不在评测样本中的片段：' + segmentId);
    if (!['A', 'B', 'tie', 'cannot_judge'].includes(preference)) fail('preference 必须为 A、B、tie 或 cannot_judge。');
    const item = {
      segmentId, dimension, preference,
      confidence: ['low', 'medium', 'high'].includes((raw as any).confidence) ? String((raw as any).confidence) : 'medium',
      comment: typeof (raw as any).comment === 'string' ? String((raw as any).comment).slice(0, 500) : '',
    };
    existing.set(segmentId + ':' + dimension, item);
  }
  reviews.splice(0, reviews.length, ...Array.from(existing.values()));
  const packetIds = (report.blindReview.packet || []).map((item: any) => String(item.segmentId));
  const overallBySegment = new Map(reviews.filter((item) => item.dimension === 'overall').map((item) => [item.segmentId, item.preference]));
  const complete = packetIds.every((id: string) => overallBySegment.has(id));
  if (complete) {
    const mapping = loaded.blindMapping;
    const summarizePreferences = (items: any[]) => {
      let beforeWins = 0, afterWins = 0, ties = 0, cannotJudge = 0;
      for (const item of items) {
        const preference = item.preference;
        if (preference === 'tie') ties++;
        else if (preference === 'cannot_judge') cannotJudge++;
        else if (mapping[item.segmentId]?.[preference] === 'before') beforeWins++;
        else if (mapping[item.segmentId]?.[preference] === 'after') afterWins++;
      }
      const decided = beforeWins + afterWins;
      return {
        beforeWins, afterWins, ties, cannotJudge,
        decidedPreferenceCount: decided,
        afterPreferred: afterWins > beforeWins,
        afterWinRateAmongDecided: decided ? Math.round(afterWins / decided * 1000) / 10 : null,
      };
    };
    const dimensions = ['overall', 'accuracy', 'terminology', 'voice', 'style'];
    const preferenceByDimension = Object.fromEntries(dimensions.map((dimension) => [
      dimension,
      summarizePreferences(reviews.filter((item) => item.dimension === dimension)),
    ]));
    report.blindReview = {
      ...report.blindReview,
      status: 'completed',
      result: {
        ...summarizePreferences(reviews.filter((item) => item.dimension === 'overall')),
        preferenceByDimension,
      },
    };
    report.blindReview.packet = [];
    report.deterministic.runDisclosure = { beforeRunId: report.beforeRunId, afterRunId: report.afterRunId };
  } else {
    report.blindReview = { ...report.blindReview, status: 'pending', completedOverallRatings: overallBySegment.size };
  }
  store.saveQualityEvaluation(projectId, report, loaded.blindMapping, reviews);
  return {
    evaluationId,
    blindReview: report.blindReview,
    ...(complete ? { deterministic: report.deterministic, beforeRunId: report.beforeRunId, afterRunId: report.afterRunId } : {}),
  };
}

export function getProjectQualityEvaluation(projectId: string, evaluationId: string): Record<string, any> {
  const loaded = getDocumentProjectStore().getQualityEvaluation(projectId, evaluationId) as any;
  if (!loaded) fail('找不到质量对照评测：' + evaluationId, 404);
  const report = loaded.report as any;
  const complete = ['completed', 'not_applicable'].includes(String(report.blindReview?.status));
  return {
    evaluationId,
    sourceRevisionId: report.sourceRevisionId,
    comparable: report.comparable,
    blindReview: report.blindReview,
    ...(complete ? {
      deterministic: report.deterministic,
      beforeRunId: report.beforeRunId,
      afterRunId: report.afterRunId,
    } : {}),
    createdAt: report.createdAt,
    submittedReviewCount: Array.isArray(loaded.blindReviews) ? loaded.blindReviews.length : 0,
  };
}
