/**
 * 源语言是否可复用已有的全书预处理记录。
 *
 * `auto` 表示「不指定源语言，由模型自行判断」，它不是语言代码，不能参与字面比较：
 * 预处理记录里写的是分析当时使用的语言（例如 `en`），而客户端默认发 `auto`。按字面比较二者
 * 永远不相等，每次启动翻译都会判定「语言不一致」并重跑整本分析。
 *
 * 目标语言始终是显式值，仍严格比较：换目标语言确实需要重新产出译名与文风基准。
 */
export function sourceLanguageMatches(recorded: unknown, requested: unknown): boolean {
  const left = String(recorded ?? '').trim().toLowerCase();
  const right = String(requested ?? '').trim().toLowerCase();
  if (!right || right === 'auto') return true;
  // 记录缺失（旧记录）或记录本身是 auto，都无法与当前设置构成冲突。
  if (!left || left === 'auto') return true;
  return left === right;
}

/**
 * 提示词里如何描述源语言。
 *
 * `auto` 是一句指令而不是语言代码，直接拼进「源语言代码：auto」会让模型去猜这个字段的语义；
 * 这里把它写成明确的判断要求，其余语言保持原样。
 */
export function sourceLanguagePromptLabel(lang: unknown): string {
  const value = String(lang ?? '').trim();
  if (!value || value.toLowerCase() === 'auto') return '自动判断（由你识别原文语言）';
  return value;
}

/**
 * 提示词里描述语言的正式名称。
 *
 * 项目里存的 systemPrompt 是「上一次生效的快照」，其中的语言行可能来自建项目时的旧设置
 * （后来把源语言从英语改成法语，快照仍然写着英语）。运行时的语言对才是权威，
 * 所以每次真正发请求前都按本次 Run 重写这两行；这里只负责把代码翻译成与提示词一致的中文名。
 */
const LANGUAGE_NAMES: Record<string, string> = {
  zh: '简体中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁体中文',
  'zh-hk': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  pt: '葡萄牙语',
  it: '意大利语',
  ru: '俄语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  nl: '荷兰语',
  pl: '波兰语',
  tr: '土耳其语',
};

/** 语言代码转展示用中文名；无法识别时返回调用方给的 fallback。 */
export function documentLanguageName(lang: unknown, fallback: string): string {
  const value = String(lang ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'auto') return '自动检测（按原文实际语言判断，不要假定为英语）';
  return LANGUAGE_NAMES[value] ?? LANGUAGE_NAMES[value.split('-')[0] ?? ''] ?? String(lang).trim();
}

/**
 * 按本次 Run 的语言重写 systemPrompt 里的「输入语言/目标语言」行。
 *
 * 没有这两行的自定义 Prompt 也不保留旧方向：直接补一段权威说明，避免模型按快照里的
 * 过期语言方向翻译。返回的文本保持幂等，重复调用不会叠加。
 */
export function applyRunLanguageDirection(
  systemPrompt: string,
  run: { sourceLang?: unknown; targetLang?: unknown },
): string {
  const sourceLine = '输入语言：' + documentLanguageName(run.sourceLang, '自动检测（按原文实际语言判断，不要假定为英语）');
  const targetLine = '目标语言：' + documentLanguageName(run.targetLang, '简体中文');
  const hasSourceLine = /^输入语言：.*$/m.test(systemPrompt);
  const hasTargetLine = /^目标语言：.*$/m.test(systemPrompt);
  if (!hasSourceLine && !hasTargetLine) return systemPrompt + '\n\n' + [sourceLine, targetLine].join('\n');
  return systemPrompt
    .replace(/^输入语言：.*$/m, () => sourceLine)
    .replace(/^目标语言：.*$/m, () => targetLine);
}


export interface SourceLanguageMismatch {
  requestedLang: string;
  detectedLang: string;
  requestedScore: number;
  detectedScore: number;
  wordCount: number;
}

const LANGUAGE_SIGNAL_WORDS: Record<string, Set<string>> = {
  en: new Set([
    'the', 'and', 'of', 'to', 'in', 'is', 'it', 'that', 'was', 'he', 'she',
    'you', 'his', 'her', 'with', 'for', 'on', 'as', 'but', 'not', 'had',
    'have', 'they', 'we', 'said', 'were', 'from', 'at', 'by', 'be', 'been',
    'are', 'if', 'then', 'when', 'which', 'who', 'what', 'would', 'could',
    'their', 'there', 'this', 'these', 'those', 'into', 'after', 'before',
  ]),
  fr: new Set([
    'le', 'la', 'les', 'des', 'du', 'de', 'et', 'est', 'que', 'qui', 'dans',
    'une', 'un', 'pour', 'pas', 'avec', 'sur', 'il', 'elle', 'vous', 'nous',
    'mais', 'avait', 'était', 'sont', 'ont', 'aux', 'au', 'ce', 'cette',
    'ces', 'son', 'sa', 'ses', 'être', 'comme', 'plus', 'tout', 'tous',
    'leur', 'leurs', 'après', 'avant', 'qui', 'quoi', 'dont', 'fait',
  ]),
};

/**
 * Lightweight local language guard for the common English/French confusion.
 * It deliberately requires a substantial sample and a clear stop-word margin:
 * code-switched dialogue and short selections must not be rejected on a guess.
 */
export function detectSourceLanguageMismatch(
  segments: Array<{ text?: unknown }> | null | undefined,
  requestedLanguage: unknown,
): SourceLanguageMismatch | null {
  const requested = String(requestedLanguage ?? '').trim().toLowerCase().split(/[-_]/)[0] || '';
  if (!['en', 'fr'].includes(requested)) return null;
  const other = requested === 'en' ? 'fr' : 'en';
  const sample = (Array.isArray(segments) ? segments : [])
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 30_000);
  const words = sample.toLocaleLowerCase().match(/[a-zÀ-ÿ]+/gu) || [];
  if (words.length < 80) return null;
  const score = (language: string): number => words.reduce<number>(
    (total, word) => total + (LANGUAGE_SIGNAL_WORDS[language]?.has(word) ? 1 : 0), 0,
  );
  const requestedScore = score(requested);
  const detectedScore = score(other);
  if (detectedScore < 8 || detectedScore - requestedScore < 5 ||
      detectedScore / words.length < 0.035) return null;
  return {
    requestedLang: requested,
    detectedLang: other,
    requestedScore,
    detectedScore,
    wordCount: words.length,
  };
}
