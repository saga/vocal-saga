/**
 * 度量词表：各单位的多语言写法、各语言"数字 + 单位"匹配模式、中文单位归一化。
 * QUANTITY_UNITS 顺序有意义——find 取首个命中项，同一写法不可重复登记到不同单位。
 */
export const QUANTITY_UNITS: Array<{ pattern: RegExp; unit: string; family: string }> = [
  { pattern: /^inches?$/i, unit: 'inch', family: 'length' }, { pattern: /^(feet|foot)$/i, unit: 'foot', family: 'length' },
  { pattern: /^miles?$/i, unit: 'mile', family: 'length' }, { pattern: /^centimeters?$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^centimetres?$/i, unit: 'centimeter', family: 'length' }, { pattern: /^millimeters?$/i, unit: 'millimeter', family: 'length' },
  { pattern: /^millimetres?$/i, unit: 'millimeter', family: 'length' }, { pattern: /^kilometers?$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^kilometres?$/i, unit: 'kilometer', family: 'length' }, { pattern: /^meters?$/i, unit: 'meter', family: 'length' },
  { pattern: /^metres?$/i, unit: 'meter', family: 'length' }, { pattern: /^seconds?$/i, unit: 'second', family: 'time' },
  { pattern: /^minutes?$/i, unit: 'minute', family: 'time' }, { pattern: /^hours?$/i, unit: 'hour', family: 'time' },
  { pattern: /^days?$/i, unit: 'day', family: 'time' }, { pattern: /^weeks?$/i, unit: 'week', family: 'time' },
  { pattern: /^months?$/i, unit: 'month', family: 'time' }, { pattern: /^years?$/i, unit: 'year', family: 'time' },
  { pattern: /^degrees?$/i, unit: 'degree', family: 'angle' }, { pattern: /^pounds?$/i, unit: 'pound', family: 'weight' },
  { pattern: /^kilograms?$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^ounces?$/i, unit: 'ounce', family: 'weight' },
  { pattern: /^grams?$/i, unit: 'gram', family: 'weight' }, { pattern: /^liters?$/i, unit: 'liter', family: 'volume' },
  { pattern: /^litres?$/i, unit: 'liter', family: 'volume' }, { pattern: /^sides?$/i, unit: 'side', family: 'count' },
  { pattern: /^pouces?$/i, unit: 'inch', family: 'length' }, { pattern: /^pieds?$/i, unit: 'foot', family: 'length' },
  { pattern: /^milles?$/i, unit: 'mile', family: 'length' }, { pattern: /^centimètres?$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^millimètres?$/i, unit: 'millimeter', family: 'length' }, { pattern: /^kilomètres?$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^mètres?$/i, unit: 'meter', family: 'length' }, { pattern: /^secondes?$/i, unit: 'second', family: 'time' },
  { pattern: /^minutes?$/i, unit: 'minute', family: 'time' }, { pattern: /^heures?$/i, unit: 'hour', family: 'time' },
  { pattern: /^jours?$/i, unit: 'day', family: 'time' }, { pattern: /^semaines?$/i, unit: 'week', family: 'time' },
  { pattern: /^mois$/i, unit: 'month', family: 'time' }, { pattern: /^(ans?|années?)$/i, unit: 'year', family: 'time' },
  { pattern: /^degrés?$/i, unit: 'degree', family: 'angle' }, { pattern: /^livres?$/i, unit: 'pound', family: 'weight' },
  { pattern: /^kilogrammes?$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^grammes?$/i, unit: 'gram', family: 'weight' },
  { pattern: /^litres?$/i, unit: 'liter', family: 'volume' },
  { pattern: /^zoll$/i, unit: 'inch', family: 'length' }, { pattern: /^fuß$/i, unit: 'foot', family: 'length' },
  { pattern: /^meilen?$/i, unit: 'mile', family: 'length' }, { pattern: /^zentimeter$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^millimeter$/i, unit: 'millimeter', family: 'length' }, { pattern: /^kilometer$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^metern?$/i, unit: 'meter', family: 'length' }, { pattern: /^sekunden?$/i, unit: 'second', family: 'time' },
  { pattern: /^minuten?$/i, unit: 'minute', family: 'time' }, { pattern: /^stunden?$/i, unit: 'hour', family: 'time' },
  { pattern: /^tage?$/i, unit: 'day', family: 'time' }, { pattern: /^wochen?$/i, unit: 'week', family: 'time' },
  { pattern: /^monate?$/i, unit: 'month', family: 'time' }, { pattern: /^jahre?$/i, unit: 'year', family: 'time' },
  { pattern: /^grad$/i, unit: 'degree', family: 'angle' }, { pattern: /^pfund$/i, unit: 'pound', family: 'weight' },
  { pattern: /^kilogramm$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^gramm$/i, unit: 'gram', family: 'weight' },
  { pattern: /^liter$/i, unit: 'liter', family: 'volume' },
  { pattern: /^pollici?$/i, unit: 'inch', family: 'length' }, { pattern: /^piedi$/i, unit: 'foot', family: 'length' },
  { pattern: /^miglia?$/i, unit: 'mile', family: 'length' }, { pattern: /^centimetri?$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^millimetri?$/i, unit: 'millimeter', family: 'length' }, { pattern: /^chilometri?$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^metri?$/i, unit: 'meter', family: 'length' }, { pattern: /^secondi?$/i, unit: 'second', family: 'time' },
  { pattern: /^minuti?$/i, unit: 'minute', family: 'time' }, { pattern: /^ore$/i, unit: 'hour', family: 'time' },
  { pattern: /^giorni?$/i, unit: 'day', family: 'time' }, { pattern: /^settimane?$/i, unit: 'week', family: 'time' },
  { pattern: /^mesi$/i, unit: 'month', family: 'time' }, { pattern: /^anni$/i, unit: 'year', family: 'time' },
  { pattern: /^gradi$/i, unit: 'degree', family: 'angle' }, { pattern: /^libbre?$/i, unit: 'pound', family: 'weight' },
  { pattern: /^chilogrammi?$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^grammi?$/i, unit: 'gram', family: 'weight' },
  { pattern: /^litri?$/i, unit: 'liter', family: 'volume' },
  { pattern: /^pulgadas?$/i, unit: 'inch', family: 'length' }, { pattern: /^pies?$/i, unit: 'foot', family: 'length' },
  { pattern: /^millas?$/i, unit: 'mile', family: 'length' }, { pattern: /^centímetros?$/i, unit: 'centimeter', family: 'length' },
  { pattern: /^milímetros?$/i, unit: 'millimeter', family: 'length' }, { pattern: /^kilómetros?$/i, unit: 'kilometer', family: 'length' },
  { pattern: /^metros?$/i, unit: 'meter', family: 'length' }, { pattern: /^segundos?$/i, unit: 'second', family: 'time' },
  { pattern: /^minutos?$/i, unit: 'minute', family: 'time' }, { pattern: /^horas?$/i, unit: 'hour', family: 'time' },
  { pattern: /^días?$/i, unit: 'day', family: 'time' }, { pattern: /^semanas?$/i, unit: 'week', family: 'time' },
  { pattern: /^meses?$/i, unit: 'month', family: 'time' }, { pattern: /^años?$/i, unit: 'year', family: 'time' },
  { pattern: /^grados?$/i, unit: 'degree', family: 'angle' }, { pattern: /^libras?$/i, unit: 'pound', family: 'weight' },
  { pattern: /^kilogramos?$/i, unit: 'kilogram', family: 'weight' }, { pattern: /^gramos?$/i, unit: 'gram', family: 'weight' },
  { pattern: /^litros?$/i, unit: 'liter', family: 'volume' },
  { pattern: /^インチ$/u, unit: 'inch', family: 'length' }, { pattern: /^フィート$/u, unit: 'foot', family: 'length' },
  { pattern: /^マイル$/u, unit: 'mile', family: 'length' }, { pattern: /^センチメートル$/u, unit: 'centimeter', family: 'length' },
  { pattern: /^ミリメートル$/u, unit: 'millimeter', family: 'length' }, { pattern: /^キロメートル$/u, unit: 'kilometer', family: 'length' },
  { pattern: /^メートル$/u, unit: 'meter', family: 'length' }, { pattern: /^秒$/u, unit: 'second', family: 'time' },
  { pattern: /^分$/u, unit: 'minute', family: 'time' }, { pattern: /^時間$/u, unit: 'hour', family: 'time' },
  { pattern: /^日$/u, unit: 'day', family: 'time' }, { pattern: /^(?:週|週間)$/u, unit: 'week', family: 'time' },
  { pattern: /^(?:月|ヶ月|か月)$/u, unit: 'month', family: 'time' }, { pattern: /^年$/u, unit: 'year', family: 'time' },
  { pattern: /^度$/u, unit: 'degree', family: 'angle' }, { pattern: /^キログラム$/u, unit: 'kilogram', family: 'weight' },
  { pattern: /^グラム$/u, unit: 'gram', family: 'weight' }, { pattern: /^リットル$/u, unit: 'liter', family: 'volume' },
];

// 英文数字词 + 单位（带 g 标志，调用前重置 lastIndex）。
// 数字部分允许连续组合，才能吃下 `three hundred thirty` 与 `twenty-one` 这种写法；
// 单位只收常见度量与时间词，避免把 `sides` 之外的普通名词误判成量。
export const ENGLISH_QUANTITY_PATTERN = /\b(?:\d+(?:[,.]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?:[\s-]+(?:and[\s-]+)?(?:\d+(?:[,.]\d+)*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion))*[\s-]+(inches?|feet|foot|miles?|hours?|minutes?|seconds?|days?|weeks?|months?|years?|degrees?|meters?|metres?|centimeters?|centimetres?|millimeters?|millimetres?|kilometers?|kilometres?|pounds?|kilograms?|ounces?|liters?|litres?|sides?)\b/giu;
// 中文数量：阿拉伯数字或中文数字 + 单位。中文没有词间空格，因此不加 \b，
// 单位必须落在已知集合里，单位到规范名的映射见下方 CHINESE_UNIT_MAP。
export const CHINESE_QUANTITY_PATTERN = /(?:\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万亿]+)(英寸|寸|英尺|尺|英里|公里|千米|厘米|毫米|米|小时|分钟|秒钟|秒|天|周|星期|个月|月|年|岁|公斤|千克|克|升|毫升|度|边)/gu;

// 中文数字 + 单位，单位再经 CHINESE_UNIT_MAP 归一。
export const CHINESE_UNIT_MAP: Record<string, { unit: string; family: string }> = {
  英寸:{unit:'inch',family:'length'},寸:{unit:'inch',family:'length'},英尺:{unit:'foot',family:'length'},尺:{unit:'foot',family:'length'},
  英里:{unit:'mile',family:'length'},公里:{unit:'kilometer',family:'length'},千米:{unit:'kilometer',family:'length'},米:{unit:'meter',family:'length'},
  厘米:{unit:'centimeter',family:'length'},毫米:{unit:'millimeter',family:'length'},小时:{unit:'hour',family:'time'},分钟:{unit:'minute',family:'time'},
  秒钟:{unit:'second',family:'time'},秒:{unit:'second',family:'time'},天:{unit:'day',family:'time'},周:{unit:'week',family:'time'},
  星期:{unit:'week',family:'time'},个月:{unit:'month',family:'time'},月:{unit:'month',family:'time'},年:{unit:'year',family:'time'},
  岁:{unit:'year',family:'time'},公斤:{unit:'kilogram',family:'weight'},千克:{unit:'kilogram',family:'weight'},克:{unit:'gram',family:'weight'},
  升:{unit:'liter',family:'volume'},毫升:{unit:'milliliter',family:'volume'},度:{unit:'degree',family:'angle'},边:{unit:'side',family:'count'},
};

// 法/德/意/西/日的本地化数字词 + 单位，按源语言选用。
export const LOCALIZED_QUANTITY_PATTERNS: Record<string, RegExp> = {
  fr: /(?:\d+(?:[,.]\d+)*|zéro|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille)(?:[\s-]+(?:et[\s-]+)?(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|cent|mille))*[\s-]+(pouces?|pieds?|milles?|centimètres?|millimètres?|kilomètres?|mètres?|secondes?|minutes?|heures?|jours?|semaines?|mois|ans?|années?|degrés?|livres?|kilogrammes?|grammes?|litres?)/giu,
  de: /(?:\d+(?:[,.]\d+)*|null|ein|eine|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert|tausend)(?:[\s-]+(?:und[\s-]+)?(?:ein|eine|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwanzig|hundert|tausend))*[\s-]+(Zoll|Fuß|Meilen?|Zentimeter|Millimeter|Kilometer|Meter|Metern|Sekunden?|Minuten?|Stunden?|Tage?|Wochen?|Monate?|Jahre?|Grad|Pfund|Kilogramm|Gramm|Liter)/giu,
  it: /(?:\d+(?:[,.]\d+)*|zero|uno|una|un|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|venti|trenta|quaranta|cinquanta|sessanta|settanta|ottanta|novanta|cento|mille)(?:[\s-]+(?:e[\s-]+)?(?:uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|venti|trenta|cento|mille))*[\s-]+(pollici?|piedi|miglia?|centimetri?|millimetri?|chilometri?|metri?|secondi?|minuti?|ore|giorni?|settimane?|mesi|anni|gradi|libbre?|chilogrammi?|grammi?|litri?)/giu,
  es: /(?:\d+(?:[,.]\d+)*|cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintiuna|veintidós|veintidos|veintitrés|veintitres|veinticuatro|veinticinco|veintiséis|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|millón|millones)(?:[\s-]+(?:y[\s-]+)?(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintiuna|veintidós|veintidos|veintitrés|veintitres|veinticuatro|veinticinco|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|millón|millones))*[\s-]+(pulgadas?|pies?|millas?|centímetros?|milímetros?|kilómetros?|metros?|segundos?|minutos?|horas?|días?|semanas?|meses?|años?|grados?|libras?|kilogramos?|gramos?|litros?)/giu,
  ja: /(?:\d+(?:[,.]\d+)*|[零〇一二两三四五六七八九十百千万億]+)\s*(インチ|フィート|マイル|センチメートル|ミリメートル|キロメートル|メートル|秒|分|時間|日|週間|週|ヶ月|か月|月|年|度|キログラム|グラム|リットル)/gu,
};
