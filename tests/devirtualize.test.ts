/**
 * devirtualize 单测 — Virtual Layout 去虚拟化。
 *
 * 验证服务端 DOM rewrite 能正确移除 Virtual Scroller 的 inline 定位样式，
 * 让浏览器用普通 block flow 自动排版。
 */
import { describe, it, expect } from 'vitest';
import { devirtualizeLayout } from '../lib/devirtualize';

describe('devirtualizeLayout', () => {
  it('移除 cellInnerDiv 的 position:absolute 和 transform', () => {
    const html = `<html><body>
      <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(5227px);top:0;left:0;width:100%">
        <p>_tweet content_</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('translateY');
    expect(out).not.toContain('position:absolute');
    expect(out).toContain('position:static');
    expect(out).toContain('_tweet content_');
  });


  it('清理 cellInnerDiv 祖先链的 absolute 定位', () => {
    const html = `<html><body>
      <div style="position:absolute;top:0;left:0;height:10000px;overflow:auto">
        <div style="position:relative">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(200px)">
            <p>tweet</p>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // cellInnerDiv 自身
    expect(out).not.toContain('translateY');
    // 祖先也被清理
    expect(out).toContain('position:static');
    // 保留 relative（不是 absolute，不需要改）
  });


  it('移除 Timeline 容器的高度限制和 overflow', () => {
    const html = `<html><body>
      <div style="height:10000px;overflow:auto;position:relative">
        <div aria-label="Timeline" style="height:5000px;overflow:hidden;max-height:5000px">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(0px)">
            <p>tweet 1</p>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // Timeline 的 height 和 overflow 被移除
    expect(out).not.toContain('height:5000px');
    expect(out).not.toContain('overflow:hidden');
    expect(out).not.toContain('max-height:5000px');
    // 祖先的 height 和 overflow 也被移除
    expect(out).not.toContain('height:10000px');
    expect(out).not.toContain('overflow:auto');
    // cellInnerDiv 的 translate 被移除
    expect(out).not.toContain('translateY');
  });


  it('不处理 position:sticky 的元素', () => {
    const html = `<html><body>
      <div style="position:sticky;top:0;z-index:100">
        <p>sticky header</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('position:sticky');
    expect(out).toContain('z-index:100');
  });

  it('模拟 Twitter 完整页面', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="https://abs.twimg.com/responsive-web/client-web/main.css">
    </head><body>
      <div data-testid="primaryColumn" style="height:100vh;overflow-y:auto">
        <div aria-label="Timeline" style="height:10000px;overflow:hidden">
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(0px);width:100%;top:0">
            <article data-testid="tweet"><p>Tweet 1</p></article>
          </div>
          <div data-testid="cellInnerDiv" style="position:absolute;transform:translateY(5227px);width:100%;top:0">
            <article data-testid="tweet"><p>Tweet 2</p></article>
          </div>
        </div>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // Virtual 定位被移除
    expect(out).not.toContain('translateY(5227px)');
    expect(out).not.toContain('position:absolute');
    // CSS 保留
    expect(out).toContain('main.css');
    // 内容保留
    expect(out).toContain('Tweet 1');
    expect(out).toContain('Tweet 2');
    // 高度限制移除
    expect(out).not.toContain('height:10000px');
    expect(out).not.toContain('overflow:hidden');
  });



  it('移除 Substack 订阅弹窗（role=dialog + subscribe）', () => {
    const html = `<html><body>
      <article><p class="fanyi-translation">正文译文</p></article>
      <div role="dialog" aria-label="Subscribe modal" class="subscribeDialog-ApxQJS" style="position:absolute;top:100px;left:50px">
        <p>Subscribe now!</p>
        <p>立即订阅</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('subscribeDialog');
    expect(out).not.toContain('Subscribe modal');
    expect(out).toContain('正文译文');
  });

  it('移除 paywall modal', () => {
    const html = `<html><body>
      <article><p class="fanyi-translation">正文</p></article>
      <div class="paywall-modal-overlay">
        <p>Subscribe to continue reading</p>
      </div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).not.toContain('paywall-modal');
    expect(out).toContain('正文');
  });

  it('移除 SVG 内的 <title> 元素（避免 HTML 解析器陷阱）', () => {
    // SVG <title> 是 HTML integration point，里面的 <path .../> 不自闭合，
    // 会导致后续 HTML 内容被困在 SVG 内部
    const html = `<html><body>
      <article>
        <div class="post-header"><h1>Title</h1></div>
        <button>
          <svg class="icon"><g><title><path d="M2.53 7.8" /></title></g></svg>
        </button>
        <div><div class="available-content">
          <div class="body markup">
            <p class="fanyi-translation">正文译文第一段</p>
            <p class="fanyi-translation">正文译文第二段</p>
          </div>
        </div></div>
      </article>
    </body></html>`;
    const out = devirtualizeLayout(html);
    // SVG <title> 应被移除
    expect(out).not.toContain('<title>');
    // 正文内容应保留
    expect(out).toContain('正文译文第一段');
    expect(out).toContain('正文译文第二段');
  });
});

/**
 * SPA 文档站的示例代码放在 accordion 里，靠 hidden="until-found" +
 * data-starting-style(height:0) + data-animating(clip-path) 折叠。
 * 翻译页移除 hydration 脚本后折叠永远打不开，缓存页看起来像「代码丢了」
 * （article/83）。展示期必须把内容静态展开。
 */
describe('devirtualizeLayout — 展开折叠内容', () => {
  const collapsedPanel = (label: string) => `
    <div data-orientation="vertical" data-hidden="" data-closed="" class="group/accordion">
      <h3 data-closed="" data-cds="AccordionHeader">
        <button type="button" aria-expanded="false">${label}</button>
      </h3>
      <div role="region" data-index="0" data-closed="" data-hidden=""
           data-starting-style="" data-animating="" hidden="until-found"
           class="h-[var(--cds-disclosure-panel-height)] data-[starting-style]:h-0">
        <pre translate="no"><code>Draft a press release for AcmeSecurity Pro.
&lt;documents&gt;{{DOCUMENTS}}&lt;/documents&gt;</code></pre>
      </div>
    </div>`;

  it('展开 hidden=until-found 的 accordion 面板并保留代码块', () => {
    const out = devirtualizeLayout(`<html><body>${collapsedPanel('Example')}</body></html>`);
    const panelTag = out.match(/<div[^>]*data-fanyi-expanded="true"[^>]*>/)?.[0] ?? '';

    expect(panelTag).not.toBe('');
    expect(panelTag).not.toContain('hidden');
    expect(panelTag).not.toContain('data-closed');
    expect(panelTag).not.toContain('data-starting-style');
    expect(panelTag).not.toContain('data-animating');
    // 代码本身一个字都不能丢
    expect(out).toContain('AcmeSecurity Pro');
    expect(out).toContain('{{DOCUMENTS}}');
    expect(out).toContain('<pre');
    // 展开态同步到 header / 容器，避免 caret 仍指向收起
    expect(out).toContain('aria-expanded="true"');
    expect(out).not.toContain('aria-expanded="false"');
    expect(out).toContain('data-panel-open');
  });

  it('同一个页面的多个折叠面板全部展开', () => {
    const out = devirtualizeLayout(
      `<html><body>${collapsedPanel('A')}${collapsedPanel('B')}${collapsedPanel('C')}</body></html>`,
    );
    expect(out.match(/data-fanyi-expanded="true"/g)).toHaveLength(3);
    expect(out).not.toContain('hidden="until-found"');
    expect(out.match(/AcmeSecurity Pro/g)).toHaveLength(3);
  });

  it('原生 <details> 补 open', () => {
    const html = `<html><body>
      <details><summary>Example</summary><pre><code>prompt text</code></pre></details>
      <details open><summary>Already open</summary><p>visible</p></details>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out.match(/data-fanyi-expanded="true"/g)).toHaveLength(1);
    expect(out).toContain('prompt text');
    expect(out).toContain('<details');
  });

  it('不误伤同样带 hidden 的下拉菜单 / 弹窗 / 响应式占位', () => {
    const html = `<html><body>
      <div data-closed="" hidden class="dropdown-menu"><p>菜单项</p></div>
      <div role="status" hidden><p>状态</p></div>
      <div data-fanyi-remove="true"><p>噪声</p></div>
    </body></html>`;
    const out = devirtualizeLayout(html);
    expect(out).toContain('dropdown-menu');
    expect(out).toContain('hidden');
    expect(out).not.toContain('data-fanyi-expanded');
    expect(out).not.toContain('data-panel-open');
  });
});
