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
