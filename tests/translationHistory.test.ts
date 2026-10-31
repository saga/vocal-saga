/**
 * 翻译历史持久化（D1）和 GET /article/:id 路由单测。
 *
 * 每次 /translate/* 或 /s/* 成功后将结果写入 D1，
 * /<id> 从 D1 取出对应记录并渲染。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

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

  const mockDb = {
    _rows: rows,
    prepare: (_sql: string) => {
      const sql = _sql;
      return {
        bind: (...args: any[]) => ({
          run: async () => {
            if (sql.trim().startsWith('INSERT')) {
              const row: MockRow = {
                id: nextId++,
                url: args[0],
                title: args[1] ?? '',
                source_lang: args[2],
                target_lang: args[3],
                html: args[4],
                created_at: new Date().toISOString(),
              };
              rows.push(row);
            }
            return { results: rows, success: true };
          },
          first: async () => {
            if (sql.includes('WHERE id = ?')) {
              const id = args[0] as number;
              return rows.find((r) => r.id === id) || null;
            }
            return null;
          },
        }),
      };
    },
  };
  return mockDb;
}

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:history-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><head><link rel="stylesheet" href="/style.css"></head><body>translated page<span class="fanyi-translation">译文</span></body></html>',
    title: 'Test',
    blocks: 3,
    chunks: 1,
    duration_ms: 50,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

function envWithDb(db: any): object {
  return { DB999: db };
}

describe('GET /article/:id — D1 translation history', () => {
  it('500 when D1 binding is missing', async () => {
    const app = buildApp();
    const res = await app.request(req('/article/1'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/D1 not available/);
  });


  it('saves url and html to D1 after /translate/* and retrieves via /article/:id', async () => {
    const app = buildApp();
    const db = createMockDb();

    await app.request(req('/translate/example.com'), {}, envWithDb(db));

    // 确认 D1 有一条记录
    expect(db._rows).toHaveLength(1);
    expect(db._rows[0].url).toBe('https://example.com');
    expect(db._rows[0].html).toBe('<html><head><link rel="stylesheet" href="/style.css"></head><body>translated page<span class="fanyi-translation">译文</span></body></html>');
    expect(db._rows[0].source_lang).toBe('auto');

    // 通过 /article/1 取回
    const res = await app.request(req('/article/1'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const text = await res.text();
    // 注入了重定向守卫脚本，但仍包含原始翻译内容
    expect(text).toContain('translated page');
    expect(text).toContain('__vsRedirectGuard');
  });

  it('saves to D1 after /s/* and retrieves via /article/:id', async () => {
    const app = buildApp();
    const db = createMockDb();

    await app.request(req('/s/medium/article'), {}, envWithDb(db));

    expect(db._rows).toHaveLength(1);
    // www. 保留，所以存储的是 www.medium.com
    expect(db._rows[0].url).toBe('https://www.medium.com/article');

    const res = await app.request(req('/article/1'), {}, envWithDb(db));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('translated page');
    expect(text).toContain('__vsRedirectGuard');
  });

  it('auto-increments id across multiple translations', async () => {
    const app = buildApp();
    const db = createMockDb();

    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><head><style>.original { color: black; }</style></head><body>first<span class="fanyi-translation">译文</span></body></html>',
      title: 'First',
      blocks: 1, chunks: 1, duration_ms: 10,
    });
    (translateUrl as any).mockResolvedValueOnce({
      html: '<html><head><style>.original { color: black; }</style></head><body>second<span class="fanyi-translation">译文</span></body></html>',
      title: 'Second',
      blocks: 1, chunks: 1, duration_ms: 10,
    });

    await app.request(req('/translate/site1.com'), {}, envWithDb(db));
    await app.request(req('/translate/site2.com'), {}, envWithDb(db));

    expect(db._rows).toHaveLength(2);
    expect(db._rows[0].id).toBe(1);
    expect(db._rows[1].id).toBe(2);

    const r1 = await app.request(req('/article/1'), {}, envWithDb(db));
    const t1 = await r1.text();
    expect(t1).toContain('first');
    expect(t1).toContain('__vsRedirectGuard');

    const r2 = await app.request(req('/article/2'), {}, envWithDb(db));
    const t2 = await r2.text();
    expect(t2).toContain('second');
    expect(t2).toContain('__vsRedirectGuard');
  });


  it('handles D1 run error gracefully (save does not block response)', async () => {
    const app = buildApp();
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => { throw new Error('D1 write failure'); },
          first: async () => null,
        }),
      }),
    };
    const res = await app.request(req('/translate/example.com'), {}, envWithDb(brokenDb));
    expect(res.status).toBe(200);
  });
});
