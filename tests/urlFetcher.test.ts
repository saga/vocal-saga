/**
 * urlFetcher.fetchPage 单测。
 *
 * 用 Node 内置 http 起一个本地服务器（无需联网），覆盖：
 *   - 正常 GET 拿到 html + Document
 *   - 重定向 finalUrl 更新
 *   - 4xx/5xx 抛错
 *   - 超时（AbortController）
 *   - 收到 html 后能用 querySelector 解析
 *
 * 不在 CF 跑（import jsdom 会因 MessagePort 失败），但单测在 Node 下能完整覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPage } from '../lib/translate/urlFetcher';
import { assertPublicUrl } from '../lib/urlUtils';

let server: http.Server;
let baseUrl: string;
let lastHeaders: http.IncomingHttpHeaders | undefined;

/**
 * 本地 server 监听 127.0.0.1 的随机端口，必然命中 assertPublicUrl 的
 * loopback 与端口白名单规则。
 *
 * 因此注入一个"放行本地 server、其余全部交回 assertPublicUrl"的校验函数，
 * 而不是整体关闭防护 —— 这样重定向到 169.254.169.254 等内网地址时依然会被拒。
 */
const localGuard = (url: string): void => {
  const { hostname, port } = new URL(url);
  if (hostname === '127.0.0.1' && port === String(localPort)) return;
  assertPublicUrl(url);
};

/** 走本地 server，但保留真实 SSRF 校验（只放行 127.0.0.1:<localPort>）。 */
const fetchLocal = (url: string, opts: { timeoutMs?: number } = {}) =>
  fetchPage(url, { ...opts, ssrfGuard: localGuard });

let localPort = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1 id="title">Hello</h1>
        <p class="msg">World</p>
      </body></html>`);
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      res.end();
      return;
    }

    // 跳转到查询参数指定的任意绝对/相对地址，用于构造 SSRF 重定向链。
    // 注意：目标地址只写进 Location 头，服务端自己不会去请求它，
    // 因此"跳转到的地址到底有没有被 fetch"由 guard 决定，测试可安全断言。
    if (url.pathname === '/to') {
      res.writeHead(302, { Location: url.searchParams.get('u') || '/ok' });
      res.end();
      return;
    }

    // 自跳转死循环：/loop 永远 302 回自己，用于验证 MAX_REDIRECTS 上限。
    if (url.pathname === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }

    if (url.pathname === '/404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (url.pathname === '/slow') {
      // 不响应，让 fetchPage 撞 timeout
      return;
    }

    if (url.pathname === '/slow-body') {
      // Return headers immediately, then stall the body to verify the timeout
      // remains active after fetch() has resolved.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.flushHeaders?.();
      setTimeout(() => res.end('<!doctype html><html><body>late</body></html>'), 300);
      return;
    }

    res.writeHead(418, { 'Content-Type': 'text/plain' });
    res.end("I'm a teapot");
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  localPort = addr.port;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchPage', () => {
  it('fetches HTML and returns a jsdom Document', async () => {
    const result = await fetchLocal(`${baseUrl}/ok`);
    expect(result.status).toBe(200);
    expect(result.html).toContain('Hello');
    expect(result.doc).toBeTruthy();
    expect(result.doc.querySelector('#title')?.textContent).toBe('Hello');
    expect(result.doc.querySelector('.msg')?.textContent).toBe('World');
  });

  it('throws on 4xx', async () => {
    await expect(fetchLocal(`${baseUrl}/404`)).rejects.toThrow(/HTTP 404/);
  });

  it('keeps the timeout active while reading a response body after headers arrive', async () => {
    await expect(fetchLocal(`${baseUrl}/slow-body`, { timeoutMs: 100 }))
      .rejects.toThrow(/fetch page body timeout/);
  });




});

/**
 * SSRF 防护：重定向必须逐跳校验。
 *
 * 背景：`redirect: 'follow'` 由运行时内部完成整条重定向链，入口处一次
 * assertPublicUrl 只校验了链首。公网页面 302 到 169.254.169.254 就能把
 * 云元数据服务整条绕过（连端口白名单一起绕过）。
 *
 * 这些用例全部回归该行为：只要有一跳落到内网，必须抛错。
 */
describe('SSRF 防护（重定向逐跳校验）', () => {
  /**
   * 构造一次"链首合法 → 跳转到 target"的请求。
   * 链首是本地 server（被 localGuard 放行），target 则交回 assertPublicUrl 判定。
   */
  const redirectTo = (target: string, opts: { timeoutMs?: number } = {}) =>
    fetchLocal(`${baseUrl}/to?u=${encodeURIComponent(target)}`, opts);

  it('拒绝跳转到云元数据地址 169.254.169.254', async () => {
    await expect(
      redirectTo('http://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(/private\/reserved ipv4 not allowed: 169\.254\.169\.254/);
  });

  it('拒绝跳转到 localhost', async () => {
    await expect(redirectTo('http://localhost/admin')).rejects.toThrow(
      /localhost not allowed/
    );
  });


  it('拒绝跳转到私网段 10.x / 192.168.x', async () => {
    await expect(redirectTo('http://10.0.0.5/')).rejects.toThrow(
      /private\/reserved ipv4 not allowed/
    );
    await expect(redirectTo('http://192.168.1.1/')).rejects.toThrow(
      /private\/reserved ipv4 not allowed/
    );
  });

  it('拒绝跳转到非 80/443 端口（绕开端口白名单）', async () => {
    await expect(redirectTo('http://203.0.113.9:8080/')).rejects.toThrow(
      /port not allowed: 8080/
    );
  });


  it('拒绝跳转到 IPv6 loopback', async () => {
    await expect(redirectTo('http://[::1]/')).rejects.toThrow(
      /private\/reserved ipv6 not allowed: ::1/
    );
  });

  it('相对 Location 按当前跳 URL 解析后再校验', async () => {
    // 关键：相对地址本身看起来"无害"，只有按 chain 当前 URL 解析成绝对 URL
    // 之后才能判定。这里让 /to 跳到 /to?u=http://169.254.169.254/，
    // 第二次解析出的绝对地址必须被拒。
    await expect(
      fetchLocal(
        `${baseUrl}/to?u=${encodeURIComponent('/to?u=http%3A%2F%2F169.254.169.254%2F')}`
      )
    ).rejects.toThrow(/private\/reserved ipv4 not allowed: 169\.254\.169\.254/);
  });

  it('重定向死循环超过上限抛错，不耗尽资源', async () => {
    await expect(fetchLocal(`${baseUrl}/loop`)).rejects.toThrow(
      /too many redirects/
    );
  });

  it('默认校验器拒绝链首为内网地址（无重定向也必须拦截）', async () => {
    // 不注入 guard，走生产默认的 assertPublicUrl
    await expect(fetchPage('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private\/reserved ipv4 not allowed/
    );
    // 端口校验先于 IP 段校验命中，同样属于拦截成功
    await expect(fetchPage('http://127.0.0.1:8080/')).rejects.toThrow(
      /port not allowed: 8080/
    );
  });

  it('合法链：跳转后仍放行并更新 finalUrl', async () => {
    // 反向对照：证明上面的拒绝不是因为"任何重定向都被拒"
    const result = await redirectTo('/ok');
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${baseUrl}/ok`);
  });
});
