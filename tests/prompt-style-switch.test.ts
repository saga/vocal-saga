/**
 * PromptStyle 文风切换测试（服务端签名）。
 *
 * 2026-09-11 起，prompt 全量中文化，并抽成「共用骨架 + 各自文风段落」：
 * 契约 / 原文安全策略 / 术语表 / 输出格式 由 prompt-contract.ts 统一提供，
 * 各文风文件只提供 persona（角色 + <文风> / <翻译原则> / <日语原文特点>）。
 *
 * 因此本文件的重点不只是「选了哪个文风」，还要锁住
 * **「核心规则完全共用，只有文风段落变化」** 这条结构约束 ——
 * 它是两端（fanyi-extension / vocal-saga）能长期逐字同步的前提。
 */
import { describe, it, expect } from 'vitest';
import { buildSystemContent, type PromptStyle } from '../lib/translate/service/shared';
import { buildLiteraryPageReviewInstructions } from '../lib/translate/service/prompt-style';

const sourceLang = 'en';
const targetLang = 'zh';

/** 所有文风共用的段落标记。 */
const SHARED_MARKERS = [
  '<翻译契约>',
  '</翻译契约>',
  '<原文安全策略>',
  '</原文安全策略>',
  '<输出格式>',
  '</输出格式>',
];

/** 各文风自己的标记 —— 用来判断"串味"。 */
const STYLE_MARKER: Record<PromptStyle, string> = {
  default: '<翻译原则>',
  jinyong: '<文风>',
  acheng: '<文风>',
  wangxiaobo: '<文风>',
  'ja-source-natural': '<日语原文特点>',
};

const ALL_STYLES = Object.keys(STYLE_MARKER) as PromptStyle[];

/** 取出 `<翻译契约>` 段落全文，用于逐字比对。 */
function extractContract(content: string): string {
  const start = content.indexOf('<翻译契约>');
  const end = content.indexOf('</翻译契约>');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

describe('buildSystemContent 文风切换', () => {
  it('不传 style 时走 default', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined);
    expect(content).toContain(STYLE_MARKER.default);
    expect(content).not.toContain('<日语原文特点>');
  });

  it('非法 style 也回退 default（不抛错、不产出空 prompt）', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, 'nope' as PromptStyle);
    expect(content).toContain(STYLE_MARKER.default);
  });


  it('所有文风都包含共用骨架段落', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      for (const marker of SHARED_MARKERS) {
        expect(content, `${style} 缺少 ${marker}`).toContain(marker);
      }
    }
  });

  it('所有文风的 <翻译契约> 段落逐字完全相同', () => {
    // 「核心规则完全共用，只有文风部分变化」—— 契约段落必须一模一样，
    // 否则改一处规则就要改五个文件，两端同步必然漂移。
    const contracts = ALL_STYLES.map((style) =>
      extractContract(buildSystemContent(sourceLang, targetLang, undefined, style))
    );
    for (const c of contracts) {
      expect(c).toBe(contracts[0]);
    }
  });

  it('每种文风都带上自己的文风标记，且不串味', () => {
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, style);
      expect(content, `${style} 缺少自己的标记`).toContain(STYLE_MARKER[style]);

      // 其他文风的标记不得出现（<文风> 被三种文学风格共用，故跳过同名标记）
      for (const other of ALL_STYLES) {
        if (other === style) continue;
        if (STYLE_MARKER[other] === STYLE_MARKER[style]) continue;
        expect(content, `${style} 混入了 ${other} 的标记`).not.toContain(STYLE_MARKER[other]);
      }
    }
  });



  it('语言代码解析为中文语言名（未知代码原样透传）', () => {
    const zh2ja = buildSystemContent('zh', 'ja', undefined, 'default');
    expect(zh2ja).toContain('输入语言：简体中文');
    expect(zh2ja).toContain('目标语言：日语');

    const unknown = buildSystemContent('xx', 'yy', undefined, 'default');
    expect(unknown).toContain('输入语言：xx');
    expect(unknown).toContain('目标语言：yy');
  });

  it('源语言为 auto 时不得假定为英语', () => {
    // ja-source-natural 例外：这个文风本身就限定源语言是日语。
    for (const style of ALL_STYLES.filter((item) => item !== 'ja-source-natural')) {
      const content = buildSystemContent('auto', 'zh', undefined, style);
      expect(content, `${style} 把 auto 当成了具体语言`).not.toContain('输入语言：英语');
      expect(content, `${style} 应明确写出自动检测`).toContain('自动检测');
    }
    // 文学模式同样不能把 auto 落成英语。
    const literary = buildSystemContent('auto', 'zh', undefined, 'acheng', 'literary');
    expect(literary).not.toContain('输入语言：英语');
    expect(literary).toContain('自动检测');
  });

});

describe('glossary 注入', () => {
  it('所有文风都用 <术语表> 段落承载 document_terms', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    for (const style of ALL_STYLES) {
      const content = buildSystemContent(sourceLang, targetLang, glossary, style);
      expect(content).toContain('<术语表>');
      expect(content).toContain('React');
      expect(content).toContain('Vue');
    }
  });

});


describe('translation profile', () => {
  it('literary mode uses its own prompt and ignores extracted term candidates', () => {
    const glossary = { document_terms: ['Erasmus', 'Blackthorne', 'Dutch', 'Spanish'] };
    const literary = buildSystemContent(sourceLang, targetLang, glossary, 'default', 'literary');
    expect(literary).toContain('<文学翻译目标>');
    expect(literary).toContain('人物对白');
    expect(literary).toContain('习语、隐喻、双关');
    expect(literary).not.toContain('<术语表>');
    expect(literary).not.toContain('Erasmus');
    expect(literary).not.toContain('Blackthorne');
    expect(literary).not.toContain('Dutch');
    expect(literary).not.toContain('Spanish');
  });

  it('technical mode keeps the established glossary behavior', () => {
    const glossary = { document_terms: ['React', 'OpenAPI'] };
    const technical = buildSystemContent(sourceLang, targetLang, glossary, 'default', 'technical');
    expect(technical).toContain('<术语表>');
    expect(technical).toContain('React');
    expect(technical).toContain('OpenAPI');
    expect(technical).not.toContain('<文学翻译目标>');
  });
});


describe('literary webpage reviewer prompt', () => {
  it('asks for a restrained second-pass edit and structured findings', () => {
    const prompt = buildLiteraryPageReviewInstructions();
    expect(prompt).toContain('独立审校');
    expect(prompt).toContain('翻译腔');
    expect(prompt).toContain('finalTranslation');
    expect(prompt).toContain('accuracy|terminology|style');
    expect(prompt).toContain('不能增加原文没有的情节');
    expect(prompt).toContain('style 必须是 optional');
  });
});

describe('ja-source-natural 文风', () => {
  it('ja → zh 时生效，包含日语原文特点与判断强度清单', () => {
    const content = buildSystemContent('ja', targetLang, undefined, 'ja-source-natural');
    expect(content).toContain('<日语原文特点>');
    expect(content).toContain('<中文表达原则>');
    expect(content).toContain('<判断强度>');
    expect(content).toContain('保留日本文章的味道');
    // 判断强度清单：日语的"推测"不能被译成"结论"
    expect(content).toContain('〜と考えられる');
    expect(content).toContain('〜かもしれない');
    // 不能串到文学风格
    expect(content).not.toContain('金庸');
    expect(content).not.toContain('阿城');
    expect(content).not.toContain('王小波');
  });

  it('目标语言为英语 / 韩语时同样生效（不止中文）', () => {
    for (const target of ['en', 'ko']) {
      const content = buildSystemContent('ja', target, undefined, 'ja-source-natural');
      expect(content).toContain('<日语原文特点>');
    }
  });

});
