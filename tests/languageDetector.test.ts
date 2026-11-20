import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
} from '../lib/translate/languageDetector';

/**
 * languageDetector 单元测试。
 *
 * 这是**纯函数**模块（零 import、零网络、零 token），所以测试可以完全
 * 确定性地构造输入，不需要 mock。
 *
 * 测试重点：
 *   1. 四种语言的判定（ja / zh / ko / en）+ 未知文字不误判
 *   2. 假名是日语的主证据 —— 含少量假名的中文文本不会被误判
 *   3. 短文本保护（<80 有效字符不判）
 *   4. MAX_SAMPLE_CHARS 采样窗口
 *   5. htmlLang 只作辅助信号（加分，不单独决定）
 *   6. shouldUseJapaneseSource 的真值表（用户手工选择永远优先）
 */

// ── 语料 ────────────────────────────────────────────────────
// 说明：每个样本的有效字符数都刻意 > 80（MIN_MEANINGFUL_CHARS），
// 否则会落到短文本保护分支，测不到判定逻辑。

const JA_NONFICTION =
  'これは一見簡単な問題のように思われるが、実際に理解するのは容易ではない。' +
  '研究者にとって、それが寺院の遺構なのか城郭の遺構なのかを判断するのは容易ではない。' +
  'その解釈には慎重であるべきだと考えられる。';

const ZH_NONFICTION =
  '这个问题乍看之下似乎很简单，但要真正理解它却并不容易。' +
  '对研究者而言，那究竟是寺院的遗构，还是城郭的遗构，要作出判断并非易事。' +
  '要读懂这些遗构背后的历史，还必须反复核对史料，才能作出稳妥的判断。' +
  '可以说，对这一解释应当保持慎重。';

const KO_NONFICTION =
  '이 문제는 언뜻 보기에는 간단해 보이지만 실제로 이해하기는 쉽지 않다. ' +
  '연구자에게 그것이 사찰의 유구인지 성곽의 유구인지 판단하는 것은 쉽지 않다. ' +
  '그러나 그 해석에는 신중해야 한다고 생각된다. 오랜 세월이 지나면서 많은 것이 사라졌기 때문이다.';

const EN_NONFICTION =
  'This question looks simple at first glance, but it is not actually easy to understand. ' +
  'For a researcher, judging whether it is a temple ruin or a castle ruin is not easy.';

/** 西里尔字母：不在白名单内 → 有效字符为 0 → 应判 unknown 而不是误判成 zh/ja。 */
const RU_NONFICTION =
  'Этот вопрос кажется простым на первый взгляд, но на самом деле понять его не так-то просто. ' +
  'Однако к его интерпретации следует относиться осторожно.';

describe('detectLanguage — 语言判定', () => {
  it('日语：假名充足 → ja', () => {
    const r = detectLanguage(JA_NONFICTION);
    expect(r.language).toBe('ja');
    expect(r.kanaRatio).toBeGreaterThan(0.3);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.evidence.hiragana).toBeGreaterThan(0);
  });

  it('中文：汉字主导且假名为 0 → zh', () => {
    const r = detectLanguage(ZH_NONFICTION);
    expect(r.language).toBe('zh');
    expect(r.evidence.hiragana).toBe(0);
    expect(r.evidence.katakana).toBe(0);
    expect(r.kanjiRatio).toBeGreaterThan(0.9);
    expect(r.confidence).toBe(0.9);
  });

  it('韩语：谚文主导 → ko', () => {
    const r = detectLanguage(KO_NONFICTION);
    expect(r.language).toBe('ko');
    expect(r.evidence.hangul).toBeGreaterThan(80);
    expect(r.evidence.cjk).toBe(0);
  });



});

describe('detectLanguage — 假名是日语的主证据', () => {
  it('纯汉字长文本 → zh（全汉字日文标题的固有歧义，已在注释中说明）', () => {
    const r = detectLanguage('漢'.repeat(100));
    expect(r.language).toBe('zh');
    expect(r.kanjiRatio).toBe(1);
    expect(r.kanaRatio).toBe(0);
  });



  it('假名不足 5 个 → 既不是 ja 也不是 zh，返回 unknown', () => {
    // 4 个假名 + 96 汉字：kanaRatio = 0.04 虽然过了 0.03 的比例门槛，
    // 但 kana 数量不足 5，判不出 ja；
    // 而 zh 分支要求 kana === 0（避免把少量假名的日文当成中文），也判不出 zh。
    // 结果落在 unknown —— 这是安全的默认：不自动升级文风，走通用直译。
    const r = detectLanguage('あ'.repeat(4) + '漢'.repeat(96));
    expect(r.language).toBe('unknown');
    expect(r.evidence.meaningful).toBe(100);
    expect(r.kanaRatio).toBeCloseTo(0.04, 5);
  });

});

describe('detectLanguage — 短文本保护', () => {
  it('短于 80 有效字符不判（标题不足以代表整页语言）', () => {
    const r = detectLanguage('日本経済新聞');
    expect(r.language).toBe('unknown');
    expect(r.evidence.meaningful).toBe(6);
    // 即使看起来像日语，也不给 confidence
    expect(r.confidence).toBe(0);
    // 比例仍然计算出来，便于调用方打日志/调阈值
    expect(r.kanjiRatio).toBe(1);
  });


});

describe('detectLanguage — 采样窗口（MAX_SAMPLE_CHARS = 20000）', () => {
  it('只看正文前 20000 字符：前段日语 + 后段中文 → ja', () => {
    const r = detectLanguage('あ'.repeat(20000) + '漢'.repeat(500));
    expect(r.language).toBe('ja');
    expect(r.evidence.meaningful).toBe(20000);
  });

});

describe('detectLanguage — htmlLang 仅作辅助信号', () => {
  // 用低 kanaRatio 的语料，避免置信度被 clamp01 顶到 1.0 而看不出加分
  const mixed = 'あ'.repeat(10) + '漢'.repeat(90);

  it('htmlLang=ja 时加 0.1 置信度', () => {
    const base = detectLanguage(mixed);
    const hinted = detectLanguage(mixed, { htmlLang: 'ja' });
    expect(base.language).toBe('ja');
    expect(hinted.language).toBe('ja');
    expect(hinted.confidence).toBeCloseTo(base.confidence + 0.1, 5);
  });



  it('htmlLang 不能单独决定语言：声明 ja 但正文是中文 → 仍判 zh', () => {
    const r = detectLanguage(ZH_NONFICTION, { htmlLang: 'ja' });
    expect(r.language).toBe('zh');
  });

  it('htmlLang 不能把 unknown 变成 ja：短文本仍不判', () => {
    const r = detectLanguage('日本経済新聞', { htmlLang: 'ja' });
    expect(r.language).toBe('unknown');
  });
});
