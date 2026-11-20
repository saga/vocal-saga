/**
 * 语言检测（纯本地：零 token、零网络、零依赖）。
 *
 * 用于 PDF 阅读器在源语言设为 auto 时，从已提取的正文中推断语言。
 * 检测结果只用于语言选择，不改变翻译文风；文风始终由用户配置决定。
 *
 * ## 为什么不需要 LLM
 *
 * 日语有一个极强的结构性特征：**假名**（平假名 + 片假名）。
 *
 *   中文：以汉字为主，假名 ≈ 0
 *   日语：汉字 + 平假名 + 片假名混排
 *
 * 仅靠 Unicode 区间统计就能可靠区分，且对「中文 / 日语」这一对尤其准 ——
 * 这正是本项目的核心场景，所以没有必要为此引入第三方语言识别库。
 *
 * ## 为什么必须传「正文」而不是整页 HTML
 *
 * `<script>` / `<nav>` / 广告 / 页脚等噪声会严重污染统计。调用方应传入
 * 已经抽取的正文文本，而不是 HTML、脚本或页面噪声。
 *
 * ## 设计取舍
 *
 * - **评分制**而非单一布尔：返回 evidence 与各项比例，便于调阈值、便于打日志。
 * - **假名是主证据**；`<html lang>` 只作辅助信号（页面声明经常是错的或缺失）。
 * - **短文本不判**：页面标题「日本経済新聞」不足以代表整页语言。
 * - **只检测一次**：PDF 阅读器基于文档开头的代表性段落推断一次源语言，再供整篇翻译使用；
 *   不应逐 chunk 判断，否则短片段更容易落入 unknown。检测结果不改变 PromptStyle。
 */

export type DetectedLanguage = 'ja' | 'zh' | 'ko' | 'en' | 'unknown';

export interface LanguageDetectionResult {
  language: DetectedLanguage;
  /** 0–1，越高越可信。`unknown` 恒为 0。 */
  confidence: number;
  /** 假名（平假名 + 片假名）占有效字符的比例 */
  kanaRatio: number;
  /** 汉字占有效字符的比例 */
  kanjiRatio: number;
  evidence: {
    hiragana: number;
    katakana: number;
    hangul: number;
    cjk: number;
    latin: number;
    /** 参与统计的有效字符总数 */
    meaningful: number;
  };
}

export interface DetectLanguageOptions {
  /**
   * `<html lang>` / `og:locale` 等文档级语言声明，**仅作辅助信号**。
   * 不能单独据此判定：页面声明经常缺失，或者是错的（例如站点模板写死 `en`）。
   */
  htmlLang?: string;
}

/** 短于该有效字符数不做判断（标题/导航等短文本不足以代表整页语言）。 */
const MIN_MEANINGFUL_CHARS = 80;

/** 只统计正文前 N 字符：长文无需全量扫描，前 20KB 已足够稳定。 */
const MAX_SAMPLE_CHARS = 20000;

const HIRAGANA_RE = /[\u3040-\u309f]/g;
const KATAKANA_RE = /[\u30a0-\u30ff]/g;
const HANGUL_RE = /[\uac00-\ud7af]/g;
const CJK_RE = /[\u4e00-\u9fff]/g;
const LATIN_RE = /[A-Za-z]/g;

function countMatches(re: RegExp, text: string): number {
  // String#match 对 /g 正则会返回全部匹配且不受 lastIndex 影响，可安全复用同一实例
  return text.match(re)?.length ?? 0;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function isJapaneseTag(tag: string | undefined): boolean {
  return /^ja\b/i.test((tag || '').trim());
}

export function detectLanguage(
  text: string,
  options: DetectLanguageOptions = {}
): LanguageDetectionResult {
  const sample = text.slice(0, MAX_SAMPLE_CHARS);

  const hiragana = countMatches(HIRAGANA_RE, sample);
  const katakana = countMatches(KATAKANA_RE, sample);
  const hangul = countMatches(HANGUL_RE, sample);
  const cjk = countMatches(CJK_RE, sample);
  const latin = countMatches(LATIN_RE, sample);

  const kana = hiragana + katakana;

  // 「有效字符」= 有语言指向性的字符（假名 / 汉字 / 谚文 / 拉丁字母）。
  // 用白名单求和而不是黑名单剔除标点：更稳，且天然把未知文字（西里尔、阿拉伯等）
  // 排除在外 —— 那些场景返回 unknown 比误判成 zh / ja 更安全。
  const meaningful = kana + hangul + cjk + latin;

  const kanaRatio = meaningful > 0 ? kana / meaningful : 0;
  const kanjiRatio = meaningful > 0 ? cjk / meaningful : 0;
  const evidence = { hiragana, katakana, hangul, cjk, latin, meaningful };

  // 短文本不判：否则「日本経済新聞」这种标题会把整页误判成日语
  if (meaningful < MIN_MEANINGFUL_CHARS) {
    return { language: 'unknown', confidence: 0, kanaRatio, kanjiRatio, evidence };
  }

  // ── 日语：假名是主证据 ──
  // 假名在日语里几乎无处不在（助词、送假名、活用词尾），中文则恒为 0。
  // 注意：全汉字的日文标题会落到下面的 zh 分支 —— 这是该方法的固有歧义，
  // 但真实日文正文必然含假名，配合 MIN_MEANINGFUL_CHARS 门槛已足够可靠。
  if (kana >= 5 && kanaRatio >= 0.03) {
    const confidence = clamp01(
      0.7 + Math.min(kanaRatio, 0.3) + (isJapaneseTag(options.htmlLang) ? 0.1 : 0)
    );
    return { language: 'ja', confidence, kanaRatio, kanjiRatio, evidence };
  }

  // ── 韩语：谚文 ──
  if (hangul >= 5 && hangul / meaningful >= 0.15) {
    return { language: 'ko', confidence: 0.9, kanaRatio, kanjiRatio, evidence };
  }

  // ── 中文：汉字主导，且几乎没有假名 ──
  if (cjk >= 5 && kana === 0 && kanjiRatio >= 0.25) {
    return { language: 'zh', confidence: 0.9, kanaRatio, kanjiRatio, evidence };
  }

  // ── 英语：拉丁字母主导 ──
  if (latin / meaningful >= 0.5) {
    return { language: 'en', confidence: 0.8, kanaRatio, kanjiRatio, evidence };
  }

  return { language: 'unknown', confidence: 0, kanaRatio, kanjiRatio, evidence };
}
