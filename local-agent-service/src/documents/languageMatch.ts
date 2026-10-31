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
