/**
 * 人名词面词表与正则：判断"大写词串是否可能指人"的全部知识数据。
 * 这里只有数据，判定逻辑在 bookScan.ts。补词时按语言分节追加，不影响扫描逻辑。
 */

// 功能词/称谓/常见普通名词。人名正则只认"大写起首"，靠它挡掉 Suddenly / However / Der / Mais。
export const NAME_STOP_WORDS = new Set([
  'a','an','and','as','at','after','although','around','before','behind','below','between','both','but','by',
  'can','did','do','does','down','during','each','even','every','for','from','get','got','had','has','have',
  'he','her','here','hers','him','his','how','i','if','in','into','is','it','its','just','keep','like','may',
  'me','might','more','most','must','my','near','no','nor','not','now','of','off','on','once','one','only','or',
  'other','our','out','over','own','said','same','she','should','so','some','such','than','that','the','their',
  'them','then','there','these','they','this','those','through','thus','to','too','under','until','up','upon',
  'us','very','was','we','were','what','when','where','which','while','who','why','will','with','would','yes',
  'you','your','suddenly','however','perhaps','indeed','well','still','yet','finally','mr','mrs','ms','miss',
  'dr','prof','captain','capt','sir','lord','lady','warden','archivist',
  'le','la','les','un','une','des','du','de','et','à','au','aux','en','dans','sur','avec','pour','par','pas',
  'ne','que','qui','dont','je','tu','il','elle','nous','vous','ils','elles','est','sont','était','été','mais',
  'donc','alors','ainsi','bonjour','bonsoir','merci','monsieur','madame','mademoiselle','oui','non',
  'der','die','das','den','dem','des','ein','eine','einer','eines','einem','und','oder','aber','auch','nicht',
  'doch','mit','für','von','zu','zum','zur','im','am','auf','aus','bei','nach','vor','über','unter','zwischen',
  'ist','war','sind','waren','wird','werden','hat','haben','ich','du','er','es','wir','ihr','man','wie','was',
  'wer','wann','wo','wenn','weil','dass','denn','sagte','fragte','hallo','danke','nein','ja','ach','so','guten','gute','morgen','abend',
  'frau','mann','stadt','zeit','haus','weg','hand','auge','tag','nacht','welt','zimmer','straße','strasse','kind','kinder','leute','mensch',
  'il','lo','i','gli','uno','una','di','da','del','della','dei','degli','delle','e','o','ma','anche',
  'non','che','chi','cui','per','con','su','tra','fra','è','era','sono','sei','ha','hanno','io','tu',
  'lui','lei','noi','voi','loro','questo','quella','quello','ciao','grazie','buongiorno','buonasera','salve','bene','signore','signora','sì',
  '彼女','彼ら','私達','自分','先生','友人','男性','女性','人物','家族','父親','母親','少年','少女','子供',
  '老人','警察','会社','学校','時間','場所','部屋','人々',
  'el','la','los','las','un','una','unos','unas','y','o','pero','porque','por','para','con','sin','de','del','al','en','sobre','entre',
  'que','quien','quién','quienes','quiénes','como','cómo','cuando','cuándo','donde','dónde','no','sí','si','es','son','era','fue','ser','estar','está','están',
  'soy','eres','yo','tú','él','ella','ellos','ellas','nosotros','nosotras','ustedes','vosotros','vosotras','mi','mis','su','sus','lo','le','les','se','me','te','nos','os',
  'muy','más','menos','también','todavía','aún','ya','aquí','allí','hola','adiós','gracias','buenos','buenas','días','tardes','noches','señor','señora','señorita','don','doña',
]);

// 只剥一层的冠词前缀。"The King Rat" 要留下 King Rat，见 stripNamePrefix。
export const ARTICLE_PREFIX_WORDS = new Set([
  'the','a','an','le','la','les','un','une','der','die','das','den','dem','ein','eine',
  'il','lo','i','gli','uno','una','el','los','las','unos','unas',
]);

// 称谓前缀。可连续剥离（"Mr. Captain Ahab" → "Ahab"）。
export const TITLE_PREFIX_WORDS = new Set([
  'mr','mrs','ms','miss','dr','prof','sir','lord','lady','captain','capt',
  'm','mme','mlle','monsieur','madame','mademoiselle','herr','frau','fräulein',
  'sig','signor','signora','signorina','dott','dottore','capitano','kapitän','könig','königin',
  'don','doña','dona','señor','senor','señora','senora','señorita','senorita','sr','sra','srta','san','santa','padre','madre',
]);

// 人名匹配模式。单名/复合/带称谓三类，es 与 ja 各补本语言语序的变体。
//
// 所有拉丁模式都要求「大写开头 + 至少两个小写字母」，因此天然排除全大写缩写（NASA）
// 与单字母（"A."）；首尾的 lookaround 保证不在单词内部命中。

// 单名。`Ann`、`Jean-Luc`、`O'Brien` 能中，`ANNA` 与 `A` 不能。
export const NAME_PATTERN = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*(?![\p{L}\p{N}])/gu;
// 复合名：在一段单名之后再接 1~2 个大写词（`Captain Ahab` 之外的 `Jean Paul Sartre` 这类）。
// 上限取 2 是为了不把整行标题吞成一个名字。
export const COMPOUND_NAME_PATTERN = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*(?:\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*){1,2}(?![\p{L}\p{N}])/gu;
// 带称谓的写法。称谓既可能是名词 prefix（Mr./Herr），也可能是 `King Rat` 里的限定词；
// 这里把它们连同后面的名字一次抓出来，交给 stripNamePrefix 去剥离。
export const TITLED_NAME_PATTERN = /(?<![\p{L}\p{N}])(?:[Tt]he|[Aa]|[Aa]n|[Mm]r\.?|[Mm]rs\.?|[Mm]s\.?|[Mm]iss|[Dd]r\.?|[Pp]rof\.?|[Ss]ir|[Ll]ord|[Ll]ady|[Cc]aptain|[Cc]apt\.?|[Kk]ing|[Qq]ueen|[Pp]rince|[Pp]rincess|[Gg]eneral|[Cc]olonel|[Mm]ajor|[Ss]ergeant|Monsieur|Madame|Mademoiselle|M\.|Mme\.?|Mlle\.?|Herr|Frau|Fräulein|Signor(?:a|ina)?|Sig\.?|Dott\.?|Dottore|Capitano|Kapitän|König|Königin|Regina|Don|Doña|Dona|Señor|Senor|Señora|Senora|Señorita|Senorita|Sr\.?|Sra\.?|Srta\.?|San|Santa)\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*(?:\s+\p{Lu}\p{Ll}{2,}(?:[’'-]\p{Lu}?\p{Ll}+)*)?(?![\p{L}\p{N}])/gu;
// 西语允许 `de`/`del`/`la`/`y` 连接各段（`Don Quijote de la Mancha`），
// 通用复合名模式只认空格分隔，所以这套语序要单独写一条。
export const SPANISH_COMPOUND_NAME_PATTERN = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?:(?:\s+(?:de|del|la|las|los|y)){1,2}\s+\p{Lu}\p{Ll}{2,}|\s+\p{Lu}\p{Ll}{2,}){1,3}(?![\p{L}\p{N}])/gu;
// 西语称谓 + 带连接词的复合名（`Señor de la Vega`）。两者必须合起来匹配，
// 否则先命中的会是最短的 `Señor de`。
export const SPANISH_TITLED_NAME_PATTERN = /(?<![\p{L}\p{N}])(?:Don|Doña|Dona|Señor|Senor|Señora|Senora|Señorita|Senorita|Sr\.?|Sra\.?|Srta\.?|San|Santa)\s+\p{Lu}\p{Ll}{2,}(?:(?:\s+(?:de|del|la|las|los|y)){1,2}\s+\p{Lu}\p{Ll}{2,}|\s+\p{Lu}\p{Ll}{2,}){0,3}(?![\p{L}\p{N}])/gu;
// 这些连接词本身不是名字的一部分，切分与归一时要能识别出来。
export const SPANISH_NAME_PARTICLES = new Set(['de','del','la','las','los','y']);
// 日文没有词间空格，只能靠后置敬称反推：先匹配敬称前的 2~4 个汉字。
// 少于 2 字多是普通词（「彼」「私」），多于 4 字基本是短语而非姓名。
export const JAPANESE_NAME_PATTERN = /(?<![\p{Script=Han}])[\p{Script=Han}]{2,4}(?=(?:さん|様|氏|君|殿|先生))/gu;
// 片假名写的译名（外来人名），同样靠敬称定位；8 字符上限用于截断整句片假名。
export const JAPANESE_KATAKANA_NAME_PATTERN = /(?<![\p{L}\p{N}])[\p{Script=Katakana}ー]{2,8}(?=(?:さん|様|氏|君))/gu;
