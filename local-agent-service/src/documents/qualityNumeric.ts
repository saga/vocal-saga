/**
 * 数字与量词审计：把多语种的数词（英文/法文/德文/意大利文/西班牙文/中文）解析成数值，
 * 再比对原文与译文的数量、量词是否一致。
 *
 * 从 qualityAudit 抽出：词表与解析规则占了近 400 行，和其余审计规则没有交集，
 * 单独成模块后新增语种只需要改这一处。
 */

import { stableFindingId } from './qualityShared.ts';

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

/**
 * 根据语言值与样本文本推断审计使用的源语言代码。
 */
export function normalizeAuditLanguage(value: string, sampleText = ''): string {
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

/**
 * 解析中文数字字符串为整数值（支持十/百/千/万/亿）。
 */
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

/**
 * 从 token 序列中解析一段本地化数字短语，返回数值与结束位置。
 */
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

/**
 * 按语言习惯将数字字面量标准化为点小数形式。
 */
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

/**
 * 从文本中提取可比较的数字 token 列表，支持多语言与中文量词。
 */
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

/**
 * 提取文本中的数量单位并映射为规范化单位键。
 */
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

/**
 * 比较原文与译文的数字序列/计量单位，生成 numeric-token-mismatch 发现。
 */
export function numericFindings(
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

/**
 * 从 project_events 中的 batch.output.validation 事件提取输出校验发现。
 */
export function translationOutputValidationFindings(
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
