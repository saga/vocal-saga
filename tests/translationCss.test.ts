/**
 * TRANSLATION_CSS 单测 —— 注入的展示期兜底样式。
 *
 * 关键点：injectTranslationCss 注入的 TRANSLATION_CSS 必须包含
 *   [data-fanyi-remove="true"]{display:none}
 * 否则 applySiteDisplayRules 给元素打的 data-fanyi-remove 标记无法隐藏元素，
 * 表现为 Oreilly 侧栏（#right-rail）被打标却仍显示（article/588）。
 *
 * 这条规则曾遗漏，导致所有依赖 removeSelectors 的站点规则在展示期失效。
 */
import { describe, it, expect } from 'vitest';
import { TRANSLATION_CSS, injectTranslationCss } from '../lib/app';

describe('TRANSLATION_CSS', () => {
  it('包含 [data-fanyi-low-priority] 弱化规则', () => {
    expect(TRANSLATION_CSS).toContain('[data-fanyi-low-priority="true"]');
  });

  it('包含通知/订阅弹窗兜底隐藏规则', () => {
    expect(TRANSLATION_CSS).toContain('[class*="notification"]');
    expect(TRANSLATION_CSS).toContain('[class*="subscribers"]');
  });

  it('injectTranslationCss 输出的 <style> 含 data-fanyi-remove 规则', () => {
    const out = injectTranslationCss('<html><head></head><body>x</body></html>');
    expect(out).toContain('data-fanyi-css');
    expect(out).toContain('[data-fanyi-remove="true"]{display:none');
  });

  it('包含展开面板的兜底规则，覆盖站点的 height:0 / clip-path', () => {
    expect(TRANSLATION_CSS).toContain('[data-fanyi-expanded="true"]');
    expect(TRANSLATION_CSS).toContain('height:auto!important');
    expect(TRANSLATION_CSS).toContain('clip-path:none!important');
    expect(TRANSLATION_CSS).toContain('content-visibility:visible!important');
  });
});
