/**
 * 翻译映射校验（mapping validation）
 * =============================================================================
 * 检测单个 block 的「原文」与「译文」在信息量上是否严重不匹配，从而发现
 * block id 错配（例如标题拿到了正文的译文、正文拿到了标题的译文）。
 *
 * 为什么需要它：
 *   - 之前的 mitsloan 故障就是 D1 缓存跨路径污染导致 block id 错位，
 *     标题被填上了正文段落的译文。这种错位单看译文质量没问题，
 *     但「短原文 ↔ 长译文」的长度/句子数反差会立刻暴露。
 *
 * 信号选择（避免误报）：
 *   - 中文比英文密度高，纯字符长度比对会产生误报，因此用【非对称区间】
 *     +【句子数】双信号，且对「较长原文才检查过短」以降低短文压缩的误报。
 *   - 句子数对语言密度不敏感：标题通常 1 句、正文多句；原文 1 句译文 5 句
 *     是强烈错配信号，与中英文无关。
 *   - 但句子计数本身必须可靠：英文列表项里一个 `e.g.` 就能把 1 句数成 3 句
 *     （`...mid-conversation (e.g. memory lookup) move into the tools.` →
 *     "…(e" / "g" / " memory lookup)…"），配上中文译文的 1 句就是 0.33 < 0.34
 *     的假告警。因此 `;`、缩写内的句点、「句点+空格+小写」都不再算句末。
 *   - 「骤减」比「激增」弱：中文把几个英文短句并成一句是常态，所以只在原文
 *     句数 ≥ 4 时才把骤减当信号，3 句→1 句不告警。
 *
 * 默认行为：仅返回 verdict（是否可疑 + 原因），由调用方决定 log-only 还是
 * 严格剔除。不修改任何翻译结果。
 */

export interface MappingVerdict {
  origChars: number;
  transChars: number;
  origSentences: number;
  transSentences: number;
  /** transChars / origChars；origChars 为 0 时：transChars 也为 0 → 1，否则 Infinity */
  charRatio: number;
  /** transSentences / origSentences；origSentences 为 0 时：transSentences 也为 0 → 1，否则 Infinity */
  sentenceRatio: number;
  suspect: boolean;
  reasons: string[];
}

export interface MappingOptions {
  /** 译文过长的阈值（transChars / origChars 上限），默认 3.5 */
  maxCharRatio?: number;
  /** 译文过短的阈值（transChars / origChars 下限），默认 0.2 */
  minCharRatio?: number;
  /** 句子数激增阈值（transSentences / origSentences 上限），默认 2.5。
   *  设 2.5 是因为：标题（1 句）若拿到正文（3+ 句）译文，比值为 3 > 2.5 即告警；
   *  而正常的 2 句→3 句（比值 1.5）不会误报。中文密度高，字符比在此类错配中不可靠，
   *  句子数是更稳健的信号。 */
  maxSentenceRatio?: number;
  /** 句子数骤减阈值（transSentences / origSentences 下限），默认 0.34 */
  minSentenceRatio?: number;
  /** 触发字符比判定所需的最小绝对字符差，默认 25（过滤微小波动） */
  minAbsoluteChars?: number;
  /** 启用「过短」字符比判定所需的原文最小字符数，默认 40（短文压缩属正常） */
  minOrigCharsForShortCheck?: number;
  /** 启用「句子数骤减」判定所需的原文最小句数，默认 4（3 句并 1 句属正常合并） */
  minOrigSentencesForCollapse?: number;
}

/** 句末标点：中英文句号/叹号/问号。分号属从句级标点，不切分句子。 */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '!', '?']);

/** 句点后面允许出现的「收尾」字符；其余字符（字母/数字）说明句点是词内点。 */
const TRAILING_CHARS = /[\s"'”’)\]】]/;

/** 常见缩写（小写比较）：其后的句点不是句末。 */
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'cf.',
  'ca.',
  'approx.',
  'al.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'fig.',
  'no.',
  'vol.',
  'u.s.',
  'u.k.',
  'a.k.a.',
  'p.s.',
]);

/** `beforeDot` 是否以已知缩写结尾（例如 "...(e.g." 里的 "e.g."）。 */
function endsWithAbbreviation(beforeDot: string): boolean {
  const token = beforeDot.match(/([A-Za-z][A-Za-z.]*\.)$/)?.[1];
  return token !== undefined && ABBREVIATIONS.has(token.toLowerCase());
}

/** 判断 index 处的 `.` 是否为句末（而非 3.5 / node.js / e.g. 这类词内点）。 */
function isPeriodBoundary(text: string, index: number): boolean {
  const next = text[index + 1];
  // 句点后直接跟字母/数字 → 词内点
  if (next !== undefined && !TRAILING_CHARS.test(next)) return false;
  // 已知缩写 → 不是句末
  if (endsWithAbbreviation(text.slice(0, index + 1))) return false;
  // 句点后是空格 + 小写字母 → 同一句的延续（"e.g. memory" / "wait... and then"）
  const after = text.slice(index + 1).replace(/^[\s"'”’)\]】]+/, '')[0];
  if (after !== undefined && /[a-z]/.test(after)) return false;
  return true;
}

/**
 * 统计句子数（中英文通用）。
 *
 * 切分规则：`。！？!?` 恒为句末；`.` 仅在「后面不是词内字符、不是已知缩写、
 * 且后面首个实字符不是小写字母」时算句末；换行视为段落分隔（按句末处理）。
 * 过滤空片段与纯符号/数字片段（不含字母或汉字）。空串返回 0；普通单句返回 1。
 */
export function countSentences(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/[\n\r]+/g, '。');

  let count = 0;
  let start = 0;
  const flush = (end: number) => {
    const piece = normalized.slice(start, end).trim();
    start = end;
    if (piece.length === 0) return;
    // 过滤纯符号/数字片段（不含任何字母或汉字）
    if (!/[一-鿿a-zA-Z]/.test(piece)) return;
    count++;
  };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charAt(i);
    if (SENTENCE_END_CHARS.has(ch) || (ch === '.' && isPeriodBoundary(normalized, i))) {
      flush(i + 1);
    }
  }
  flush(normalized.length);

  return count;
}

/**
 * 校验单个 block 的原文/译文映射是否可疑。
 */
export function validateBlockMapping(
  original: string,
  translated: string,
  opts: MappingOptions = {}
): MappingVerdict {
  const maxCharRatio = opts.maxCharRatio ?? 3.5;
  const minCharRatio = opts.minCharRatio ?? 0.2;
  const maxSentenceRatio = opts.maxSentenceRatio ?? 2.5;
  const minSentenceRatio = opts.minSentenceRatio ?? 0.34;
  const minAbs = opts.minAbsoluteChars ?? 25;
  const minOrigForShort = opts.minOrigCharsForShortCheck ?? 40;
  const minOrigForCollapse = opts.minOrigSentencesForCollapse ?? 4;

  const origChars = (original || '').replace(/\s/g, '').length;
  const transChars = (translated || '').replace(/\s/g, '').length;
  const origSentences = countSentences(original || '');
  const transSentences = countSentences(translated || '');

  const charRatio =
    origChars === 0 ? (transChars === 0 ? 1 : Infinity) : transChars / origChars;
  const sentenceRatio =
    origSentences === 0
      ? transSentences === 0
        ? 1
        : Infinity
      : transSentences / origSentences;

  const reasons: string[] = [];
  const absDiff = Math.abs(transChars - origChars);

  // 原文为空却有译文：异常映射
  if (origChars === 0 && transChars > 0) {
    reasons.push('原文为空却有译文');
  }

  // 字符比判定（需达到一定绝对差，避免微小波动误报）
  if (absDiff >= minAbs && origChars > 0) {
    if (charRatio > maxCharRatio) {
      reasons.push(`译文过长：字符比 ${charRatio.toFixed(2)} > ${maxCharRatio}`);
    }
    // 仅对较长原文检查「过短」：短文（如标题）压缩成更短中文属正常
    if (origChars > minOrigForShort && charRatio < minCharRatio) {
      reasons.push(`译文过短：字符比 ${charRatio.toFixed(2)} < ${minCharRatio}`);
    }
  }

  // 句子数比判定（对语言密度不敏感，是更稳健的错配信号）
  if (origSentences >= 1 && transSentences >= 1) {
    if (sentenceRatio > maxSentenceRatio) {
      reasons.push(`句子数激增：比 ${sentenceRatio.toFixed(2)} > ${maxSentenceRatio}`);
    }
    // 「骤减」需要原文句数足够多才有区分度：中文把几个英文短句并成一句是常态，
    // 3 句→1 句（比 0.33）刚好压在阈值下，属于正常合并，不告警。
    if (sentenceRatio < minSentenceRatio && origSentences >= minOrigForCollapse) {
      reasons.push(`句子数骤减：比 ${sentenceRatio.toFixed(2)} < ${minSentenceRatio}`);
    }
  }

  return {
    origChars,
    transChars,
    origSentences,
    transSentences,
    charRatio,
    sentenceRatio,
    suspect: reasons.length > 0,
    reasons,
  };
}
