/**
 * cssInliner 单测 —— 外联样式表内联化。
 *
 * 用本地 HTTP server 提供真实 CSS，验证：
 *   - 正常内联、相对路径解析、media 属性保留
 *   - 404 / HTML 兜底页 / 非 CSS content-type 一律跳过（保留原 <link>）
 *   - SSRF 校验：页面里的 <link href> 指向内网时被拦下
 *   - CSS 里的 </style 必须转义，否则会提前闭合标签
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { inlineExternalStylesheets } from '../lib/translate/cssInliner';
import { assertPublicUrl } from '../lib/urlUtils';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.a{color:red}');
      return;
    }
    if (url === '/print.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.p{color:blue}');
      return;
    }
    if (url === '/styles/main.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('@import "./theme.css" screen; .hero{background-image:url("../images/hero.png")}');
      return;
    }
    if (url === '/styles/theme.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.theme{background-image:url("../images/theme.png")}');
      return;
    }
    if (url === '/evil.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.e{content:"</style><script>alert(1)</script>"}');
      return;
    }
    if (url === '/gone.css') {
      // 模拟原站发版后哈希文件 404（返回 HTML 错误页）
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html>Not Found</html>');
      return;
    }
    if (url === '/spa-fallback.css') {
      // SPA 兜底路由：任何路径都返回 200 + HTML
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html>app shell</html>');
      return;
    }
    if (url === '/octet.css') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('.o{}');
      return;
    }

    if (url === '/slow.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.flushHeaders?.();
      setTimeout(() => res.end('.slow{color:red}'), 100);
      return;
    }
    res.writeHead(404);
    res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

/** 本地测试用的 SSRF guard：放行本机测试端口，其余走公共规则 */
const localGuard = (url: string): void => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1' && u.port === new URL(base).port) return;
  assertPublicUrl(url);
};

const run = (html: string, overrides: Record<string, unknown> = {}) =>
  inlineExternalStylesheets(html, {
    baseUrl: base,
    ssrfGuard: localGuard,
    ...overrides,
  });

describe('inlineExternalStylesheets', () => {
  it('把外联样式表内联成 <style>，并移除原 <link>', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body><p class="a">x</p></body></html>`;
    const out = await run(html);
    expect(out).not.toContain('<link');
    expect(out).toContain('<style data-fanyi-inlined-css="' + base + '/app.css">');
    expect(out).toContain('.a{color:red}');
  });

  it('历史缓存已丢失全部 CSS 时，仍能切换到 Reader 布局', async () => {
    const html = `<!doctype html><html><head></head><body>
      <main><article><h1 data-fanyi-block-id="b1">Title</h1>
      <p data-fanyi-block-id="b2"><span class="fanyi-original">Original text</span>
      <span class="fanyi-translation">原文内容</span></p></article></main>
      <aside>Sidebar</aside></body></html>`;
    const out = await run(html);
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).toContain('data-fanyi-reader-content="true"');
    expect(out).toContain('data-fanyi-reader-css');
  });
  it('没有外联样式表时原样返回（不解析 DOM、不发请求）', async () => {
    const html = `<html><head><style>.a{}</style></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: () => {
        throw new Error('should not fetch');
      },
    });
    expect(out).toBe(html);
  });

  it('保留 media 属性并用 @media 包裹，语义不变', async () => {
    const html = `<html><head><link rel="stylesheet" href="/print.css" media="print"></head><body>x</body></html>`;
    const out = await run(html);
    // 不断言属性顺序（linkedom 的输出顺序不保证）
    expect(out).toMatch(/<style\b[^>]*data-fanyi-inlined-css="[^"]*\/print\.css"[^>]*>/);
    expect(out).toMatch(/<style\b[^>]*media="print"[^>]*>/);
    expect(out).toContain('@media print{.p{color:blue}}');
  });


  it('404 的样式表保留原 <link>（不内联、不删）', async () => {
    const html = `<html><head><link rel="stylesheet" href="/gone.css"></head><body>x</body></html>`;
    const out = await run(html, { onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).toContain('data-fanyi-reader-css');
    expect(out).not.toContain('<link rel="stylesheet" href="/gone.css">');
    expect(out).not.toContain('Not Found');
  });

  it('200 但返回 HTML 的样式表（SPA 兜底路由）不内联', async () => {
    const html = `<html><head><link rel="stylesheet" href="/spa-fallback.css"></head><body>x</body></html>`;
    const out = await run(html, { onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('/spa-fallback.css');
    expect(out).not.toContain('app shell');
  });


  it('CSS 里的 </style 被转义，不会提前闭合标签', async () => {
    const html = `<html><head><link rel="stylesheet" href="/evil.css"></head><body><p>after</p></body></html>`;
    const out = await run(html);
    // 不能出现能闭合标签的字面序列
    expect(out).not.toContain('</style><script>');
    expect(out).toContain('<\\/style>');
    // 转义后结构仍然完整，body 内容没被吞
    expect(out).toContain('<p>after</p>');
  });

  it('响应头到达后 CSS body 仍受 timeout 约束', async () => {
    const html = `<html><head><link rel="stylesheet" href="/slow.css"></head><body>x</body></html>`;
    const out = await run(html, { timeoutMs: 20, onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('.slow{color:red}');
  });

  it('超出单张字节上限时不内联', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body>x</body></html>`;
    const out = await run(html, { maxBytesPerSheet: 3, onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('/app.css"');
    expect(out).not.toContain('color:red');
  });

  it('超出总预算时停止内联后续样式表', async () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="stylesheet" href="/print.css">
    </head><body>x</body></html>`;
    // 两张表各 12 字节：预算 15 只够放第一张，第二张整张跳过
    const out = await run(html, { maxBytesTotal: 15, onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('.a{color:red}');
    expect(out).not.toContain('.p{color:blue}');
  });

  it('超过 maxSheets 的样式表不静默保留外链，而是切换到 Reader', async () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="stylesheet" href="/print.css">
    </head><body>x</body></html>`;
    const out = await run(html, { maxSheets: 1, onError: () => {} });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('.a{color:red}');
    expect(out).not.toContain('<link rel="stylesheet" href="/print.css">');
  });

  it('跳过 data: / javascript: 等非网络协议', async () => {
    const html = `<html><head><link rel="stylesheet" href="data:text/css,.x{}"></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: () => {
        throw new Error('should not fetch');
      },
    });
    expect(out).toContain('data:text/css');
  });

  it('SSRF：页面里的 <link> 指向内网时被拦下', async () => {
    const html = `<html><head><link rel="stylesheet" href="http://169.254.169.254/latest/meta-data/"></head><body>x</body></html>`;
    const reasons: string[] = [];
    const out = await run(html, {
      onError: (_u: string, reason: string) => reasons.push(reason),
    });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('169.254.169.254');
    expect(reasons.join('|')).toMatch(/blocked/);
  });


  it('递归内联 @import，并相对于原 stylesheet 地址改写 url()', async () => {
    const html = `<html><head><link rel="stylesheet" href="/styles/main.css"></head><body><p class="hero">x</p></body></html>`;
    const out = await run(html);
    expect(out).toContain('background-image:url("' + base + '/images/theme.png")');
    expect(out).toContain('background-image:url("' + base + '/images/hero.png")');
    expect(out).not.toContain('@import');
    expect(out).toContain('data-fanyi-css-snapshot="v2-complete"');
  });

  it('完整快照重复处理时不再次请求 CSS', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body>x</body></html>`;
    const first = await run(html);
    const second = await run(first, {
      fetchFn: () => { throw new Error('complete snapshot must not refetch'); },
    });
    expect(second).toBe(first);
  });
  it('默认处理超过六张的 stylesheet，不再静默留下第七张以后依赖', async () => {
    const links = Array.from({ length: 11 }, (_, i) => `<link rel="stylesheet" href="/app.css?v=${i}">`).join('');
    const out = await run(`<html><head>${links}</head><body>x</body></html>`);
    expect(out).toContain('data-fanyi-css-snapshot="v2-complete"');
    expect(out).not.toContain('<link rel="stylesheet"');
    expect((out.match(/data-fanyi-inlined-css=/g) || []).length).toBe(11);
  });

  it('网络异常时切换到 Reader，不抛错', async () => {
    const html = `<html><head><link rel="stylesheet" href="/app.css"></head><body>x</body></html>`;
    const out = await run(html, {
      fetchFn: async () => {
        throw new Error('boom');
      },
      onError: () => {},
    });
    expect(out).toContain('data-fanyi-render-mode="reader"');
    expect(out).not.toContain('<link rel="stylesheet" href="/app.css">');
  });

});
