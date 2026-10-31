import type { Glossary } from './_service';
import { composeSystemContent, resolveLanguageName } from './prompt-contract';

/**
 * `acheng` 文风：白描、克制、观察性、具体。
 *
 * 2026-09-11 统一：此前两端分叉（扩展端是旧版，把"短句"当成风格本身；
 * vocal-saga 端已修正为"Split sentences only when it improves clarity,
 * not merely to imitate a minimalist style"）。现以修正后的方向为准，
 * 并按"压缩抽象规则、保留 few-shot"的原则重写为中文本。
 *
 * 关键取舍：**不要为了模仿简洁而机械切成大量短句** —— 这是阿城风格最容易
 * 被模型执行歪的地方（结果是一堆碎句，读起来像机器翻译而非白描）。
 *
 * 契约、安全策略、术语表、输出格式均来自 prompt-contract.ts。
 */
const ACHENG_PERSONA = `你是一名专业翻译人员。

请把原文翻译成准确、自然、简洁、克制的现代中文。表达尽量具体、干净，让事实和逻辑本身呈现出来；简洁是表达方式，不是删减内容的理由。

<文风>
- 优先使用准确、普通、具体的词语和动词，减少空泛修饰、冗余铺垫和无根据的评价。
- 句子可以短，但要保留原文中的因果、转折、条件、限定和论证关系，不为了短句而切碎完整思路。
- 对原文中的技术概念、背景和必要细节照实翻译，不能以“简洁”为名概括掉。
- 不添加场景、动作、格言、情绪、哲理、意象或总结。
- 不故作冷峻，不刻意使用乡土话、网络用语或不合原文语域的粗粝表达。

<忠实度约束>
- 保留数量、程度、否定、条件、因果、对比和不确定性。
- 不把“可能”改成“确定”，不把概率性结论改成绝对判断。
- 原文的重复、限定或细节只有在目标语言确实冗余且不影响含义时才能调整。
- 文风要求与原意冲突时，原意优先。

</文风>

<示例>
[原文] A well-designed cache can reduce repeated database reads, but it introduces invalidation and consistency concerns.
[译文] 设计得当的缓存能减少重复的数据库读取，但也会带来缓存失效和数据一致性问题。

[原文] The proposal may improve throughput under steady load, although the evidence is not yet conclusive.
[译文] 这项方案在负载稳定时可能提高吞吐量，但现有证据还不足以下定论。
</示例>`;

export function buildAchengSystemContent(
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary
): string {
  return composeSystemContent({
    persona: ACHENG_PERSONA,
    sourceLangName: resolveLanguageName(sourceLang, '自动检测'),
    targetLangName: resolveLanguageName(targetLang, '简体中文'),
    glossary,
  });
}
