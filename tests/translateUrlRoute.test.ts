/**
 * GET /translate/<target-without-scheme> 路由单测。
 *
 * 设计：浏览器直访入口，无 auth。路径里的 target 是去掉 `https://` 后的 URL
 * 剩余部分，server 补回 `https://` 后抓取 + 翻译 + 双语回填 HTML。
 *
 * 覆盖：
 *   - 路径缺失 / 剥 scheme 后为空 → 400
 *   - 模式非法 → 400
 *   - 成功后透传 pipeline 的 html + 元数据 header
 *   - 默认 target=zh, mode=bilingual
 *   - 兼容用户传含 scheme 的 URL（自动剥）
 *   - translateUrl 抛错 → 500
 *   - 旧 /api/translate/url（GET/POST）都 404（彻底废弃）
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock 必须在被测模块 import 之前
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string }) => ({
    html: `<html><body>translated: ${args.url} (${args.mode})</p></body></html>`,
    blocks: 7,
    chunks: 3,
    duration_ms: 123,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:translate-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>ok</body></html>',
    title: 'Test',
    blocks: 1,
    chunks: 1,
    duration_ms: 10,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

describe('GET /translate/<target> — no auth (browser-direct)', () => {


  it('forwards pipeline metadata as response headers', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/example.com?mode=bilingual&target=zh&source=en'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Blocks')).toBe('1');
    expect(res.headers.get('X-Translate-Chunks')).toBe('1');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('10');
  });
});

describe('GET /translate/<target> — path parsing', () => {
  it('reconstructs https URL from bare host', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com');
  });

  it('preserves nested path segments', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com/blog/post-1'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/blog/post-1');
  });

  it('strips https:// when user includes it (URL-encoded)', async () => {
    // 用户在地址栏直接粘贴完整 URL 时的常见情况：含 https:// 被编码
    const app = buildApp();
    await app.request(req('/translate/https%3A%2F%2Fexample.com%2Ffoo'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://example.com/foo');
  });

  it('defaults target to zh and mode to bilingual', async () => {
    const app = buildApp();
    await app.request(req('/translate/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.target).toBe('zh');
    expect(call.mode).toBe('bilingual');
    expect(call.source).toBe('auto');
  });

});

describe('GET /translate/<target> — validation', () => {
  it('400 when target is empty', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/'));
    expect(res.status).toBe(400);
  });

  it('400 when only the scheme is given (e.g. /translate/https://)', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/https%3A%2F%2F'));
    expect(res.status).toBe(400);
  });


  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/translate/example.com'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream boom');
  });
});

describe('GET /translate/<target> — URL normalization', () => {

  it('adds .com suffix for domain without dot (towardsdatascience)', async () => {
    const app = buildApp();
    await app.request(req('/translate/towardsdatascience/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://towardsdatascience.com/article');
  });

  it('preserves www. prefix (www and non-www treated as different)', async () => {
    const app = buildApp();
    await app.request(req('/translate/www.example.com/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.example.com/article');
  });
});

describe('POST /api/translate/url — JSON URL translation endpoint', () => {
  it('returns translated HTML and metadata for a valid public URL', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request('http://test/api/translate/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { html: string; blocks: number; chunks: number };
    expect(body.html).toContain('ok');
    expect(body.blocks).toBe(1);
    expect(body.chunks).toBe(1);
  });

  it('rejects non-public URLs before calling the translation pipeline', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request('http://test/api/translate/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/admin' }),
      })
    );
    expect(res.status).toBe(400);
    const { translateUrl } = await import('../lib/translate/pipeline');
    expect(translateUrl).not.toHaveBeenCalled();
  });
});

describe('GET /translate/<target> — SSRF protection', () => {
  // SSRF 防护：私网/保留/链路本地地址必须在调用 translateUrl 之前被拦截。
  // 这里只验证「路由层在 fetch 前调用了 assertPublicUrl」这一条接线；
  // 各私网段（10/8、127/8、169.254/16、端口白名单…）的分支判定由
  // urlUtils.test.ts 逐段覆盖，不再在此重复。
  it('rejects private IPv4 (192.168.1.1) with 400 and skips pipeline', async () => {
    const app = buildApp();
    const res = await app.request(req('/translate/192.168.1.1'));
    expect(res.status).toBe(400);
    const { translateUrl } = await import('../lib/translate/pipeline');
    expect(translateUrl).not.toHaveBeenCalled();
  });
});

// ── D1 save 失败必须 surface 给前端（不再静默吞掉）──
// 回归：曾经 /translate/<url> 的 save 失败只 console.error，
// 用户直访 URL 时拿不到任何信号，每次访问都重复翻译却无人察觉。
// 现在通过 X-Translate-Warning header + HTML banner 双通道提示。
describe('GET /translate/<target> — D1 save error surfacing', () => {
  /**
   * 最小 mock D1：prepare → bind → run/first/all
   * @param insertError 非 null 时 INSERT 的 run() 抛此错误；null 表示 save 成功
   */
  function createMockDb(insertError: string | null) {
    return {
      prepare: (_sql: string) => {
        const sql = _sql;
        return {
          all: async () => ({ results: [], success: true }),
          first: async () => null,
          bind: (..._args: any[]) => ({
            run: async () => {
              if (sql.trim().startsWith('INSERT') && insertError) {
                throw new Error(insertError);
              }
              return { results: [], success: true };
            },
            first: async () => null,
            all: async () => ({ results: [], success: true }),
          }),
        };
      },
    };
  }

  it('surfaces D1 save error via X-Translate-Warning header and HTML banner', async () => {
    const db = createMockDb(
      'D1_ERROR: table translations has no column named content_hash: SQLITE_ERROR',
    );

    const app = buildApp();
    const res = await app.request(req('/translate/example.com'), {}, { DB999: db });
    // 翻译本身成功，仍然返回 200（graceful degradation：缓存失败不阻塞翻译）
    expect(res.status).toBe(200);
    // header 透出错误信息
    expect(res.headers.get('X-Translate-Warning')).toContain('content_hash');
    const html = await res.text();
    // HTML 包含可见警告条
    expect(html).toContain('data-vs-save-warning');
    expect(html).toContain('译文已生成，但服务端缓存失败');
    // 翻译内容仍然返回
    expect(html).toContain('ok');
  });

  it('does not surface warning when D1 save succeeds (no banner, no header)', async () => {
    const db = createMockDb(null);

    const app = buildApp();
    const res = await app.request(req('/translate/example.com'), {}, { DB999: db });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Warning')).toBeNull();
    const html = await res.text();
    expect(html).not.toContain('data-vs-save-warning');
  });
});

// ── 源站抓取失败时回落到 D1 旧译文 ──
// 回归：openai.com 之类站点现在直接 403。此前健康检查偏严，缓存被判 unhealthy
// 后必然重新 fetch → 403 → 用户拿到 500 而不是已有的好译文。
// 这里再加一道保险：即便缓存被判不健康，只要 fetch/翻译抛错，就返回旧译文。
describe('GET /translate/<target> — stale D1 fallback on fetch failure', () => {
  /** 缓存里存一份"不健康"（无样式）但译文完整的 HTML */
  const staleHtml =
    '<!doctype html><body><p>' +
    '<span class="fanyi-original">Hello world</span>' +
    '<span class="fanyi-translation">你好世界</span>' +
    '</p></body>';

  function createDbWithStaleRow() {
    return {
      prepare: (sql: string) => ({
        all: async () => ({ results: [], success: true }),
        first: async () => null,
        bind: () => ({
          run: async () => ({ results: [], success: true }),
          // SELECT 命中旧行；INSERT/其他查询返回 null
          first: async () => (sql.trim().startsWith('SELECT') ? { html: staleHtml } : null),
          all: async () => ({ results: [], success: true }),
        }),
      }),
    };
  }

  it('serves stale cache instead of 500 when translateUrl throws (源站 403)', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(
      new Error('fetch https://openai.com/index/x/ failed: HTTP 403'),
    );

    const app = buildApp();
    const res = await app.request(
      req('/translate/openai.com%2Findex%2Fx%2F'),
      {},
      { DB999: createDbWithStaleRow() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Translate-Source')).toBe('d1-stale-fallback');
    // 失败原因仍然透出，便于排查
    expect(res.headers.get('X-Translate-Warning')).toContain('HTTP 403');
    const html = await res.text();
    expect(html).toContain('你好世界');
    expect(html).toContain('Hello world');
  });

  it('still returns 500 when there is no cached row at all', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('fetch failed: HTTP 403'));

    const app = buildApp();
    const res = await app.request(req('/translate/example.com/nope'), {}, { DB999: {
      prepare: () => ({
        all: async () => ({ results: [], success: true }),
        first: async () => null,
        bind: () => ({
          run: async () => ({ results: [], success: true }),
          first: async () => null,
          all: async () => ({ results: [], success: true }),
        }),
      }),
    } });
    expect(res.status).toBe(500);
  });
});
