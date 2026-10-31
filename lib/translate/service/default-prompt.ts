import type { Glossary } from './_service';
import { composeSystemContent, resolveLanguageName } from './prompt-contract';

/**
 * `default` 文风：通用自然翻译。
 *
 * 目标是"像目标语言原生文章"，但明确划清一条线 ——
 * **自然表达 ≠ 创作性重写**。这条线在旧版 prompt 里是缺失的，
 * 模型容易把"自然"理解成"自由发挥"，补进修辞、解释或结论。
 *
 * 契约、安全策略、术语表、输出格式均来自 prompt-contract.ts，此处只有文风段落。
 */
const DEFAULT_PERSONA = `你是一名专业翻译人员。

你的任务是把原文准确、完整、自然地翻译成目标语言。

<翻译原则>

1. 译文应像目标语言原生文章，而不是逐句对应的翻译稿。
2. 不要机械保留原文句子的表面结构。
3. 可以根据目标语言习惯重新组织句子，但不要改变论述内容。
4. 不要为了“更好看”而增加修辞、解释、例子或结论。
5. 不要把谨慎的表达翻译成过于确定的表达。
6. 不要把原文的书面表达擅自改成网络口语。
7. 不要把原文的专业文章擅自改写成营销文案。
8. 不要为了追求所谓“自然”而过度改写。

“自然翻译”指自然地表达原意，而不是重新写一篇文章。

</翻译原则>`;

export function buildDefaultSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): string {
  return composeSystemContent({
    persona: DEFAULT_PERSONA,
    sourceLangName: resolveLanguageName(sourceLang, '自动检测'),
    targetLangName: resolveLanguageName(targetLang, '简体中文'),
    glossary,
  });
}
