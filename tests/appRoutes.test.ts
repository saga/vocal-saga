/**
 * 剩余 Hono 路由单测：hello、models、text 翻译。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
  translateText: vi.fn(),
  translateHtml: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';
import { cacheKeyUrl } from '../lib/urlUtils';
import { simpleHash } from '../lib/translate/cacheKey';
import { buildPageCacheFingerprint } from '../lib/translate/pageCacheKey';

function mockClearAll(...mocks: any[]) {
  for (const m of mocks) m.mockClear();
}

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:app-routes-' + Math.random().toString(36).slice(2)));
  const { translateUrl, translateText, translateHtml } = await import('../lib/translate/pipeline');
  mockClearAll(translateUrl, translateText, translateHtml);
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
    blocks: 1, chunks: 1, duration_ms: 10,
  });
  (translateHtml as any).mockResolvedValue({
    html: '<html><body>translated</body></html>',
    title: 'Translated',
    blocks: 2, chunks: 1, duration_ms: 20,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init || {});
}

// ── mock D1 ──────────────────────────────────────────────────
interface MockRow {
  id: number;
  url: string;
  title: string;
  source_lang: string;
  target_lang: string;
  html: string;
  created_at: string;
}

function createMockDb() {
  const rows: MockRow[] = [];
  let nextId = 1;

  /** 按 id DESC 排序后的只读副本 */
  function sortedRows(): MockRow[] {
    return [...rows].sort((a, b) => b.id - a.id);
  }

  // 先定义 db，再让 prepare 内部通过闭包读取 db._insertError
  const db: {
    _rows: MockRow[];
    _insertError: string | null;
    /** 最近一次 INSERT 的 bind 参数，供测试断言写入的 content_hash 等字段 */
    _lastInsertArgs: any[] | null;
    prepare: (sql: string) => any;
  } = {
    _rows: rows,
    // 测试钩子：设为非空字符串后，下一次 INSERT 的 run() 会抛错，
    // 用于验证 D1 save 失败时是否正确 surface 给前端（header + HTML banner）
    _insertError: null,
    _lastInsertArgs: null,
    prepare: (_sql: string) => {
      const sql = _sql;
      // 无 bind 的查询（如 COUNT(*)、全量列表）
      const unbound = {
        all: async () => {
          // 建表检查：返回空列表表示 translations 尚不存在，schema 引导会走 CREATE TABLE。
          if (/PRAGMA\s+table_info/i.test(sql)) {
            return { results: [], success: true };
          }
          if (/COUNT\(\*\)/i.test(sql)) {
            return { results: [{ total: rows.length }], success: true };
          }
          return { results: sortedRows(), success: true };
        },
        first: async () => {
          if (/COUNT\(\*\)/i.test(sql)) {
            return { total: rows.length };
          }
          return null;
        },
        // 无参数执行（CREATE TABLE / PRAGMA 引导语句）。
        run: async () => ({ results: [], success: true }),
      };
      return {
        ...unbound,
        bind: (...args: any[]) => ({
          run: async () => {
            if (sql.trim().startsWith('DELETE')) {
              const before = rows.length;
              const idx = rows.findIndex((r) => r.id === Number(args[0]));
              if (idx >= 0) rows.splice(idx, 1);
              return { results: [], success: true, meta: { changes: before - rows.length } };
            }
            if (sql.trim().startsWith('INSERT')) {
              // 测试钩子：模拟 D1 save 失败（如 schema 不匹配、UNIQUE 冲突等）
              if (db._insertError) {
                throw new Error(db._insertError);
              }
              db._lastInsertArgs = args;
              const url = args[0] as string;
              const title = args[1] as string;
              const sourceLang = args[2] as string;
              const targetLang = args[3] as string;
              const html = args[4] as string;
              const idx = rows.findIndex(
                (r) => r.url === url && r.source_lang === sourceLang && r.target_lang === targetLang,
              );
              if (idx >= 0) {
                rows[idx].title = title;
                rows[idx].html = html;
                rows[idx].created_at = new Date().toISOString();
              } else {
                rows.push({
                  id: nextId++,
                  url,
                  title,
                  source_lang: sourceLang,
                  target_lang: targetLang,
                  html,
                  created_at: new Date().toISOString(),
                });
              }
            }
            return { results: rows, success: true };
          },
          first: async () => {
            if (sql.includes('WHERE url = ? AND source_lang = ? AND target_lang = ?')) {
              const [url, sourceLang, targetLang] = args;
              const matches = rows.filter(
                (r) => r.url === url && r.source_lang === sourceLang && r.target_lang === targetLang,
              );
              if (sql.match(/ORDER\s+BY\s+created_at\s+DESC/i)) {
                matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
              }
              return matches[0] || null;
            }
            if (sql.includes('WHERE id = ?')) {
              const [id] = args;
              return rows.find((r) => r.id === Number(id)) || null;
            }
            return null;
          },
          all: async () => {
            // 分页查询：SELECT ... LIMIT ? OFFSET ?
            if (/LIMIT\s+\?\s+OFFSET\s+\?/i.test(sql)) {
              const limit = args[0] as number;
              const offset = args[1] as number;
              return { results: sortedRows().slice(offset, offset + limit), success: true };
            }
            return { results: sortedRows(), success: true };
          },
        }),
      };
    },
  };
  return db;
}

function envWithDb(db: any): object {
  return { DB999: db };
}

// ─── GET /api/hello ──────────────────────────────────────────
describe('GET /api/hello', () => {
  it('returns default greeting', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/hello'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.message).toBe('Hello, world!');
    expect(body.timestamp).toBeDefined();
  });

});

// ─── GET /api/v1/models ──────────────────────────────────────
describe('GET /api/v1/models', () => {
  it('lists deepseek models when DEEPSEEK_API_KEY is set', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/v1/models'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const m of body.data) {
      expect(m.object).toBe('model');
      expect(['deepseek-v4-flash', 'deepseek-v4-pro']).toContain(m.id);
    }
  });

});

// ─── POST /api/v1/chat/completions ───────────────────────────
describe('POST /api/v1/chat/completions backend config', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-account';
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    process.env.NVIDIA_API_KEY = 'nv-token';
    process.env.OPENROUTER_API_KEY = 'or-token';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  function chatReq(body: Record<string, unknown>): Request {
    return req('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-auth-key-123456',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      }),
    });
  }


  it('uses NVIDIA API key value', async () => {
    const app = buildApp();
    const res = await app.request(chatReq({ _backend: 'nvidia', model: 'nvidia/test-model' }));
    expect(res.status).toBe(200);

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer nv-token');
  });


});

// ─── POST /api/translate/text ─────────────────────────────────
describe('POST /api/translate/text', () => {
  it('translates text via pipeline', async () => {
    const { translateText } = await import('../lib/translate/pipeline');
    (translateText as any).mockResolvedValue({
      translations: [{ id: 't1', original: 'hello', translated: '你好' }],
      chunks: 1,
      duration_ms: 10,
    });

    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', source: 'en', target: 'zh' }),
    }));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.translations[0].translated).toBe('你好');
  });

  it('400 when text is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/api/translate/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });


});

// ─── Glossary API ────────────────────────────────────────────
// ─── GET /fanyi/page/check ─────────────────────────────────
describe('GET /fanyi/page/check', () => {
  it('returns cached HTML when cache exists', async () => {
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存：保留原页面内联样式
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: 'cached-content-hash-1',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    const html = await res.text();
    expect(html).toContain('cached translation');
  });

  it('returns 204 when cache miss', async () => {
    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
    );

    expect(res.status).toBe(204);
  });

  it('returns 204 when cached HTML is structurally unhealthy', async () => {
    // 损坏缓存（缺 <html>，也无原页面样式）应视为 miss，让扩展端 fallback 到 POST /fanyi/page
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req('/fanyi/page/check?url=https://example.com/article&source=en&target=zh'),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(204);
  });

  // ── contentHash（客户端 block 结构指纹）比对 ──
  // 缓存里的双语 HTML 靠 data-fanyi-block-id 回填，id 只在生成缓存那次抽取里才有意义。
  // 页面结构一变（块插入/删除/重排），同一个 id 会指向别的元素 → 译文错位。
  // 客户端每次 check 带上本次抽取的 id+tag 指纹，不一致就必须 410 让客户端重译。
  // 回归：a16z.news 上小节标题拿到了正文段落的译文。
  it('returns 410 when client contentHash differs from cached content_hash', async () => {
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: buildPageCacheFingerprint('b1:h3|b2:p|b3:p', 'https://example.com/article', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req(
        '/fanyi/page/check?url=https://example.com/article&source=en&target=zh' +
          `&contentHash=${encodeURIComponent('b1:p|b2:h3|b3:p|b4:p')}`,
      ),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(410);
    expect(await res.text()).toBe('');
  });

  it('returns cached HTML when client contentHash matches content_hash', async () => {
    const app = buildApp();
    const db = createMockDb();
    const fingerprint = 'b1:h3|b2:p|b3:p';
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: buildPageCacheFingerprint(fingerprint, 'https://example.com/article', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req(
        '/fanyi/page/check?url=https://example.com/article&source=en&target=zh' +
          `&contentHash=${encodeURIComponent(fingerprint)}`,
      ),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
  });

  it('ignores contentHash when cached content_hash is empty (legacy cross-path cache)', async () => {
    // 空 content_hash 来自 /translate/url-page 等非预标记路径，block ID 体系不同，
    // 无论客户端指纹是什么都必须视为未命中（204），不能因为「没得比」就放行。
    const app = buildApp();
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: cacheKeyUrl('https://example.com/article'),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><style>.original { color: black; }</style></head><body>cached translation<span class="fanyi-translation">译文</span></body></html>',
      content_hash: '',
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      req(
        '/fanyi/page/check?url=https://example.com/article&source=en&target=zh' +
          `&contentHash=${encodeURIComponent('b1:h3|b2:p')}`,
      ),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(204);
  });

});

// ─── 双库部署：缓存命中不能只看 SW998 的最新一条 ──────────────
describe('SW998 + DB999 缓存查询', () => {
  const PAGE_URL = 'https://example.com/article';
  const FINGERPRINT = 'b1:h3|b2:p';
  const EXPECTED_HASH = buildPageCacheFingerprint(
    FINGERPRINT, PAGE_URL, 'deepseek', 'default', 'technical', undefined, 'fast',
  );
  const healthyHtml = (tag: string) =>
    `<html><head><style>.o{color:black}</style></head><body>${tag}<span class="fanyi-translation">译文</span></body></html>`;

  function seedCacheRow(db: any, opts: { id: number; hash: string; tag: string; healthy?: boolean }) {
    db._rows.push({
      id: opts.id,
      url: cacheKeyUrl(PAGE_URL),
      title: 'Test',
      source_lang: 'en',
      target_lang: 'zh',
      html: opts.healthy === false ? '<body><head>broken</body></head></html>' : healthyHtml(opts.tag),
      content_hash: opts.hash,
      created_at: '2026-11-01T00:00:00.000Z',
    });
  }

  const checkRequest = () => req(
    `/fanyi/page/check?url=${encodeURIComponent(PAGE_URL)}&source=en&target=zh` +
    `&contentHash=${encodeURIComponent(FINGERPRINT)}`,
  );

  it('主库有 stale 行、备用库有匹配行时命中备用库', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(primary, { id: 1, hash: 'stale', tag: 'PRIMARY-OLD' });
    seedCacheRow(fallback, { id: 7, hash: EXPECTED_HASH, tag: 'FALLBACK-NEW' });

    const res = await buildApp().request(checkRequest(), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    const body = await res.text();
    expect(body).toContain('FALLBACK-NEW');
    expect(body).not.toContain('PRIMARY-OLD');
  });

  it('主库记录损坏、备用库有效时仍命中备用库', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(primary, { id: 1, hash: EXPECTED_HASH, tag: 'PRIMARY-OLD', healthy: false });
    seedCacheRow(fallback, { id: 7, hash: EXPECTED_HASH, tag: 'FALLBACK-NEW' });

    const res = await buildApp().request(checkRequest(), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('FALLBACK-NEW');
  });

  it('主库空 content_hash、备用库有效时不被旧记录遮住', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(primary, { id: 1, hash: '', tag: 'PRIMARY-LEGACY' });
    seedCacheRow(fallback, { id: 7, hash: EXPECTED_HASH, tag: 'FALLBACK-NEW' });

    const res = await buildApp().request(checkRequest(), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('FALLBACK-NEW');
  });

  it('两库都只有 stale 行时仍返回 410 让扩展重译', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(primary, { id: 1, hash: 'stale-1', tag: 'PRIMARY-OLD' });
    seedCacheRow(fallback, { id: 7, hash: 'stale-2', tag: 'FALLBACK-OLD' });

    const res = await buildApp().request(checkRequest(), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(410);
  });

  it('主库无行时备用库照常命中（故障转移不回退）', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(fallback, { id: 7, hash: EXPECTED_HASH, tag: 'FALLBACK-NEW' });

    const res = await buildApp().request(checkRequest(), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('FALLBACK-NEW');
  });

  it('POST /fanyi/page 主库 stale、备用库匹配时直接返回缓存，不调用翻译', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const html = '<html><head></head><body><p>Test</p></body></html>';
    const postHash = buildPageCacheFingerprint(
      String(simpleHash(html)), PAGE_URL, 'deepseek', undefined, 'technical', undefined, 'fast',
    );
    const primary = createMockDb();
    const fallback = createMockDb();
    seedCacheRow(primary, { id: 1, hash: 'stale', tag: 'PRIMARY-OLD' });
    seedCacheRow(fallback, { id: 7, hash: postHash, tag: 'FALLBACK-NEW' });

    const res = await buildApp().request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, url: PAGE_URL, apiKey: 'sk-test-api-key' }),
    }), {}, { SW998: primary, DB999: fallback });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('FALLBACK-NEW');
    expect(translateHtml).not.toHaveBeenCalled();
  });
});

// ─── POST /fanyi/page ──────────────────────────────────────
describe('POST /fanyi/page', () => {
  it('returns translated HTML when html, url and apiKey provided', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><head><title>Hello</title></head><body><p>Test</p></body></html>',
        url: 'https://example.com/article',
        apiKey: 'sk-test-api-key',
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('translated');
  });

  it('0 译文时把上游失败原因写进 500 响应', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    (translateHtml as any).mockResolvedValueOnce({
      url: 'https://www.langchain.com/blog/human-insight-strategic-advantage-agents',
      finalUrl: 'https://www.langchain.com/blog/human-insight-strategic-advantage-agents',
      title: 'Human Insight',
      html: '<html></html>',
      blocks: 46,
      translatedBlocks: 0,
      chunks: 3,
      duration_ms: 1200,
      failureDetail: 'provider=deepseek: 3 failure(s), 3 chunk(s); first [c1/provider] DeepSeek API error: HTTP 401',
    });

    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><head><title>Human Insight</title></head><body><p>Test</p></body></html>',
        url: 'https://www.langchain.com/blog/human-insight-strategic-advantage-agents',
        apiKey: 'sk-test-api-key',
      }),
    }));

    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.detail).toContain('46 blocks extracted but 0 translated');
    expect(body.detail).toContain('provider=deepseek');
    expect(body.detail).toContain('HTTP 401');
  });



  it('accepts an HTML request larger than 4 MB and passes the complete document to translation', async () => {
    const app = buildApp();
    const { translateHtml } = await import('../lib/translate/pipeline');
    const largeHtml =
      '<html><head><style>.article{color:red}</style></head><body>' +
      '<p data-fanyi-block-id="b1">Test</p><div>' +
      'x'.repeat(4_200_000) +
      '</div></body></html>';

    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: largeHtml,
        url: 'https://example.com/large-article',
        apiKey: 'sk-test-api-key',
      }),
    }));

    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledTimes(1);
    expect((translateHtml as any).mock.calls[0][0].html).toBe(largeHtml);
    expect((translateHtml as any).mock.calls[0][0].html).toContain('<style>.article{color:red}</style>');
    expect((translateHtml as any).mock.calls[0][0].html).toContain('data-fanyi-block-id="b1"');
  });

  it('returns 400 when apiKey is missing for deepseek', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        provider: 'deepseek',
      }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('apiKey is required');
  });


  it('returns 400 when provider is invalid', async () => {
    const app = buildApp();
    const res = await app.request(req('/fanyi/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<html><body>test</body></html>',
        url: 'https://example.com',
        provider: 'mimo',
        apiKey: 'sk-test-api-key',
      }),
    }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/provider must be one of/);
  });



  it('returns D1 cache directly when url+source+target exists', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存需保留原页面样式
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      // content_hash 必须等于提交 html 的 simpleHash 才能命中（与线上修复一致）
      content_hash: buildPageCacheFingerprint(String(simpleHash('<html><body>new</body></html>')), 'https://example.com', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    const html = await res.text();
    // 注入了重定向守卫脚本，但仍包含原始缓存内容
    expect(html).toContain('cached from d1');
    expect(html).toContain('__vsRedirectGuard');
    expect(translateHtml).not.toHaveBeenCalled();
  });

  // ── 客户端结构指纹优先于 simpleHash(html) ──
  // 扩展端传 contentHash（block id+tag 序列）时，服务端必须原样存进 content_hash，
  // 而不是重算 simpleHash(html) —— 否则下次 /check 拿指纹去比数字永远不等，
  // 缓存永远不命中，每次访问都要重译一遍整页。
  it('stores client-supplied contentHash instead of simpleHash(html)', async () => {
    const db = createMockDb();
    const fingerprint = 'b1:h1|b2:p|b3:p';

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
          contentHash: fingerprint,
        }),
      }),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(db._lastInsertArgs?.[5]).toBe(buildPageCacheFingerprint(fingerprint, 'https://example.com', 'deepseek', 'default'));
    expect(db._lastInsertArgs?.[5]).not.toBe(String(simpleHash('<html><body>new</body></html>')));
  });

  it('serves D1 cache hit when stored content_hash equals the client fingerprint', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    const fingerprint = 'b1:h1|b2:p|b3:p';
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      content_hash: buildPageCacheFingerprint(fingerprint, 'https://example.com', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
          contentHash: fingerprint,
        }),
      }),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    expect(translateHtml).not.toHaveBeenCalled();
  });

  it('falls back to simpleHash(html) when contentHash is absent (legacy extension)', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    const html = '<html><body>new</body></html>';
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      content_hash: buildPageCacheFingerprint(String(simpleHash(html)), 'https://example.com', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, url: 'https://example.com', apiKey: 'sk-test-api-key' }),
      }),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-cache');
    expect(translateHtml).not.toHaveBeenCalled();
  });

  it('re-translates when client fingerprint differs from stored content_hash', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>stale cached<span class="fanyi-translation">旧译文</span></body></html>',
      content_hash: buildPageCacheFingerprint('b1:h3|b2:p', 'https://example.com', 'deepseek', 'default'),
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
          contentHash: 'b1:p|b2:h3|b3:p',
        }),
      }),
      {},
      envWithDb(db),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).not.toBe('d1-cache');
    expect(translateHtml).toHaveBeenCalled();
    const html = await res.text();
    expect(html).not.toContain('stale cached');
  });

  it('re-translates when cached content_hash is empty (cross-path pollution guard)', async () => {
    // 空 content_hash 的缓存（来自 /translate/url-page 等非预标记路径）block ID 与扩展端不兼容，
    // /fanyi/page 必须视为未命中并重新翻译，而非直接返回导致译文错位。
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>cached from d1<span class="fanyi-translation">译文</span></body></html>',
      content_hash: '',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).not.toBe('d1-cache');
    expect(translateHtml).toHaveBeenCalled();
  });

  it('saves translation result to D1 when cache miss', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledOnce();
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0].url).toBe('https://example.com');
    expect(db._rows[0].source_lang).toBe('en');
    expect(db._rows[0].target_lang).toBe('zh');
    expect(db._rows[0].html).toContain('translated');
  });

  it('ignores unhealthy D1 cache and re-translates', async () => {
    const { translateHtml } = await import('../lib/translate/pipeline');
    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(translateHtml).toHaveBeenCalledOnce();
    const html = await res.text();
    expect(html).toContain('translated');
    expect(html).not.toContain('corrupted');
  });

  // ── D1 save 失败必须 surface 给前端（不再静默吞掉）──
  // 回归：曾经 save 失败只 console.error，前端拿不到信号、无法察觉缓存失效。
  // 现在通过 X-Translate-Warning header + HTML banner 双通道提示。
  it('surfaces D1 save error via X-Translate-Warning header and HTML banner', async () => {
    const db = createMockDb();
    db._insertError = 'D1_ERROR: table translations has no column named content_hash: SQLITE_ERROR';

    const app = buildApp();
    const res = await app.request(
      req('/fanyi/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: '<html><body>new</body></html>',
          url: 'https://example.com',
          apiKey: 'sk-test-api-key',
        }),
      }),
      {},
      envWithDb(db),
    );
    // 翻译本身成功，仍然返回 200（graceful degradation：缓存失败不阻塞翻译）
    expect(res.status).toBe(200);
    // header 透出错误信息，让扩展端能程序化感知并 toast 提示
    expect(res.headers.get('X-Translate-Warning')).toContain('content_hash');
    const html = await res.text();
    // HTML 包含可见警告条，让直访用户也能看到
    expect(html).toContain('data-vs-save-warning');
    expect(html).toContain('译文已生成，但保存失败');
    // 错误信息在 HTML 中可见（且不会被原样注入为 HTML 标签）
    expect(html).toContain('content_hash');
    // 翻译内容仍然返回
    expect(html).toContain('translated');
  });
});

// ─── 分页列表 GET / 和 GET /page/:page ──────────────────────
describe('分页列表', () => {
  /** 向 mock D1 批量插入 n 条记录 */
  function seedDb(db: any, n: number) {
    for (let i = 1; i <= n; i++) {
      db._rows.push({
        id: i,
        url: `https://example.com/post-${i}`,
        title: `Post ${i}`,
        source_lang: 'en',
        target_lang: 'zh',
        html: '<html></html>',
        created_at: new Date().toISOString(),
      });
    }
  }

  it('首页 / 渲染第 1 页，包含分页导航', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 120); // 120 条 → 4 页（30×4）

    const res = await app.request(req('/'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 第 1 页应包含最新记录 Post 120
    expect(html).toContain('Post 120');
    // 不应包含第 2 页的记录 Post 90（第 1 页 30 条：120~91）
    expect(html).not.toContain('Post 90');
    // 分页导航：当前页 1/4，有下一页链接，上一页不可点
    expect(html).toContain('1 / 4');
    expect(html).toContain('href="/page/2"');
    expect(html).not.toContain('href="/page/0"');
  });

  it('GET /page/2 返回第 2 页记录', async () => {
    const app = buildApp();
    const db = createMockDb();
    seedDb(db, 120);

    const res = await app.request(req('/page/2'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    // 第 2 页：Post 90 ~ Post 61
    expect(html).toContain('Post 90');
    expect(html).toContain('Post 61');
    // 不应包含第 1 页和第 3 页的记录
    expect(html).not.toContain('Post 120');
    expect(html).not.toContain('Post 60');
    // 导航：2/4，有上一页和下一页
    expect(html).toContain('2 / 4');
    expect(html).toContain('href="/page/1"');
    expect(html).toContain('href="/page/3"');
  });

  /** 按显式 id / createdAt 造记录，便于验证跨库合并顺序与来源链接。 */
  function seedExplicit(db: any, items: Array<{ id: number; title: string; created_at?: string; body?: string }>) {
    for (const item of items) {
      db._rows.push({
        id: item.id,
        url: `https://example.com/post-${item.id}`,
        title: item.title,
        source_lang: 'en',
        target_lang: 'zh',
        html: '<html><head><link rel="stylesheet" href="/s.css"></head><body>' +
          (item.body || 'body') + '<span class="fanyi-translation">译文</span></body></html>',
        created_at: item.created_at || '2026-01-01T00:00:00.000Z',
      });
    }
  }

  it('首页合并主库与备用库的记录', async () => {
    const app = buildApp();
    const primary = createMockDb();
    const fallback = createMockDb();
    seedExplicit(primary, [{ id: 1, title: 'Primary recent', created_at: '2026-03-02T00:00:00.000Z' }]);
    seedExplicit(fallback, [{ id: 1, title: 'Fallback legacy', created_at: '2026-03-01T00:00:00.000Z' }]);

    const res = await app.request(req('/'), {}, { SW998: primary, DB999: fallback });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Primary recent');
    expect(html).toContain('Fallback legacy');
    // 总数是两库之和，分页才不会被截断
    expect(html).toContain('1 / 1');
  });

  it('备用库的记录链接带上来源库参数', async () => {
    const app = buildApp();
    const primary = createMockDb();
    const fallback = createMockDb();
    seedExplicit(primary, [{ id: 1, title: 'Primary recent', created_at: '2026-03-02T00:00:00.000Z' }]);
    seedExplicit(fallback, [{ id: 1, title: 'Fallback legacy', created_at: '2026-03-01T00:00:00.000Z' }]);

    const res = await app.request(req('/'), {}, { SW998: primary, DB999: fallback });
    const html = await res.text();
    // 两库 id 都是 1，备用库那条必须能指向自己的库
    expect(html).toContain('href="/article/1?db=2"');
    expect(html).toContain('href="/article/1"');
  });

  it('GET /article/:id?db=2 命中备用库同号记录', async () => {
    const app = buildApp();
    const primary = createMockDb();
    const fallback = createMockDb();
    // 两个库都有 id=1，但内容不同——这正是需要来源参数的场景
    seedExplicit(primary, [{ id: 1, title: 'Primary', body: 'primary-body' }]);
    seedExplicit(fallback, [{ id: 1, title: 'Fallback', body: 'fallback-body' }]);
    const env = { SW998: primary, DB999: fallback };

    const scoped = await app.request(req('/article/1?db=2'), {}, env);
    expect(scoped.status).toBe(200);
    expect(await scoped.text()).toContain('fallback-body');

    // 不带来源参数时仍按主库优先，返回主库那条
    const unscoped = await app.request(req('/article/1'), {}, env);
    expect(unscoped.status).toBe(200);
    expect(await unscoped.text()).toContain('primary-body');
  });

});

// ─── DELETE /api/translations/:id ───────────────────────────
describe('DELETE /api/translations/:id — 记录删除', () => {
  const AUTH = { Authorization: 'Bearer test-auth-key-123456' };

  function seed(db: any, id: number, title: string) {
    db._rows.push({
      id,
      url: `https://example.com/post-${id}`,
      title,
      source_lang: 'en',
      target_lang: 'zh',
      html: '<html><head><link rel="stylesheet" href="/s.css"></head><body>body<span class="fanyi-translation">译文</span></body></html>',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  }

  function del(path: string, headers: Record<string, string> = AUTH): Request {
    return req(path, { method: 'DELETE', headers });
  }

  it('列表页每条记录带删除按钮，并标明来源库', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seed(primary, 1, 'Primary');
    seed(fallback, 7, 'Fallback');

    const app = buildApp();
    const res = await app.request(req('/'), {}, { SW998: primary, DB999: fallback });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('data-delete-id="1" data-delete-db="1"');
    expect(html).toContain('data-delete-id="7" data-delete-db="2"');
    expect(html).toContain('库 2');
    expect(html).toContain('/api/translations/');
  });

  it('未携带或携带错误的管理密钥时拒绝删除', async () => {
    const db = createMockDb();
    seed(db, 1, 'Keep me');
    const app = buildApp();
    const env = envWithDb(db);

    const anonymous = await app.request(del('/api/translations/1', {}), {}, env);
    expect(anonymous.status).toBe(401);
    const wrong = await app.request(
      del('/api/translations/1', { Authorization: 'Bearer wrong-key' }), {}, env,
    );
    expect(wrong.status).toBe(401);
    const crossSite = await app.request(
      del('/api/translations/1', { ...AUTH, Origin: 'https://evil.example' }), {}, env,
    );
    expect(crossSite.status).toBe(403);
    expect(db._rows).toHaveLength(1);
  });

  it('本站页面发起的删除不受跨域限制影响', async () => {
    const db = createMockDb();
    seed(db, 1, 'Same origin');
    const app = buildApp();
    const res = await app.request(
      del('/api/translations/1', { ...AUTH, Origin: 'http://test' }), {}, envWithDb(db),
    );
    expect(res.status).toBe(200);
    expect(db._rows).toHaveLength(0);
  });

  it('携带正确密钥后从数据库删除记录', async () => {
    const db = createMockDb();
    seed(db, 1, 'Gone');
    seed(db, 2, 'Stay');
    const app = buildApp();
    const env = envWithDb(db);

    const res = await app.request(del('/api/translations/1'), {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 1, db: 1, deleted: 1 });
    expect(db._rows.map((r: any) => r.id)).toEqual([2]);

    const list = await app.request(req('/'), {}, env);
    const html = await list.text();
    expect(html).not.toContain('Gone');
    expect(html).toContain('Stay');
  });

  it('按来源库删除，不误删主库同号记录', async () => {
    const primary = createMockDb();
    const fallback = createMockDb();
    seed(primary, 1, 'Primary');
    seed(fallback, 1, 'Fallback');
    const env = { SW998: primary, DB999: fallback };

    const app = buildApp();
    const res = await app.request(del('/api/translations/1?db=2'), {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ db: 2, deleted: 1 });
    expect(fallback._rows).toHaveLength(0);
    expect(primary._rows).toHaveLength(1);
  });

  it('非法 id / 越界库序号 / 不存在的记录都不改动数据', async () => {
    const db = createMockDb();
    seed(db, 1, 'Only');
    const app = buildApp();
    const env = envWithDb(db);

    expect((await app.request(del('/api/translations/abc'), {}, env)).status).toBe(400);
    expect((await app.request(del('/api/translations/1?db=9'), {}, env)).status).toBe(400);
    expect((await app.request(del('/api/translations/999'), {}, env)).status).toBe(404);
    expect(db._rows).toHaveLength(1);
  });
});

// ─── GET /translate/:target ─────────────────────────────────
describe('GET /translate/<target> — cache health', () => {
  it('ignores unhealthy D1 cache and re-translates', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><body>fresh translation: https://example.com/post</body></html>',
      title: 'Fresh',
      blocks: 1,
      chunks: 1,
      duration_ms: 10,
    });

    const db = createMockDb();
    db._rows.push({
      id: 1,
      url: 'https://example.com/post',
      title: 'Cached',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/translate/example.com/post'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    expect(translateUrl).toHaveBeenCalledOnce();
    const html = await res.text();
    expect(html).toContain('fresh translation');
    expect(html).not.toContain('corrupted');
  });
});

// ─── GET /article/:id ───────────────────────────────────────
describe('GET /article/:id', () => {
  it('serves cached translation when HTML is healthy', async () => {
    const db = createMockDb();
    db._rows.push({
      id: 42,
      url: 'https://example.com/post',
      title: 'Post',
      source_lang: 'en',
      target_lang: 'zh',
      // 健康缓存需保留原页面样式
      html: '<html><head><style>.original { color: black; }</style></head><body>healthy cached translation<span class="fanyi-translation">译文</span></body></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/article/42'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('healthy cached translation');
    expect(html).toContain('__vsRedirectGuard');
  });

  it('redirects to re-translate when cached HTML is unhealthy', async () => {
    const db = createMockDb();
    db._rows.push({
      id: 42,
      url: 'https://example.com/post',
      title: 'Post',
      source_lang: 'en',
      target_lang: 'zh',
      html: '<body><head>corrupted cached translation</body></head></html>',
      created_at: new Date().toISOString(),
    });

    const app = buildApp();
    const res = await app.request(req('/article/42'), {}, envWithDb(db));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/translate/example.com%2Fpost');
  });


  it('serves newer healthy cache for same URL when requested id is unhealthy', async () => {
    const db = createMockDb();
    // id=44 是旧的损坏缓存（base 在相对 CSS 之后）
    db._rows.push({
      id: 44,
      url: 'https://arxiv.org/html/2501.00000',
      source_lang: 'en',
      target_lang: 'zh',
      title: 'Old',
      html: '<html><head><link href="/static/browse/style.css" rel="stylesheet"><base href="https://arxiv.org/html/"></head><body>old<span class="fanyi-translation">旧</span></body></html>',
      created_at: '2026-07-01T00:00:00Z',
    });
    // id=45 是同一 URL 的新健康缓存
    db._rows.push({
      id: 45,
      url: 'https://arxiv.org/html/2501.00000',
      source_lang: 'en',
      target_lang: 'zh',
      title: 'New',
      html: '<html><head><base href="https://arxiv.org/html/"><link href="/static/browse/style.css" rel="stylesheet"></head><body>new<span class="fanyi-translation">新</span></body></html>',
      created_at: '2026-07-27T00:00:00Z',
    });

    const app = buildApp();
    const res = await app.request(req('/article/44'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('新');
  });

});

// =============================================================================
// injectTranslationCss — 确保翻译 CSS 被正确注入到各种 HTML 结构中
// =============================================================================
import { injectTranslationCss, TRANSLATION_CSS } from '../lib/app';

describe('injectTranslationCss', () => {
  it('injects before </head>', () => {
    const html = '<html><head><title>Test</title></head><body>Hi</body></html>';
    const result = injectTranslationCss(html);
    expect(result).toContain('<style data-fanyi-css>');
    expect(result).toContain(TRANSLATION_CSS);
    expect(result.indexOf('<style data-fanyi-css>')).toBeLessThan(result.indexOf('</head>'));
  });





});
