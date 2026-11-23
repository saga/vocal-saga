/**
 * GET /force/<target-without-scheme> 路由单测。
 *
 * 强制翻译：跳过 D1 缓存，强制重新抓取+翻译并覆盖写入。
 * 不校验 auth（与 /translate 一样是公开直访入口）。
 *
 * 覆盖：
 *   - 无 auth 也放行
 *   - Worker Rate Limiting binding 达到阈值 → 429
 *   - force=true 时始终调用 translateUrl（不读 D1）
 *   - pipeline 元数据透传为响应头
 *   - 上游抛错 → 500
 *
 * URL 重建 / 400 空 target 等共享行为由 translateUrlRoute.test.ts 覆盖。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// mock pipeline
vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(async (args: { url: string; mode: string }) => ({
    html: `<html><body>force-translated: ${args.url} (${args.mode})</body></html>`,
    blocks: 5,
    chunks: 2,
    duration_ms: 200,
  })),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:force-' + Math.random().toString(36).slice(2)));
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

function req(path: string, authKey = 'test-auth-key-123456'): Request {
  const headers: Record<string, string> = {};
  if (authKey) headers['Authorization'] = `Bearer ${authKey}`;
  return new Request(`http://test${path}`, { headers });
}

describe('GET /force/<target> — no auth required', () => {
  it('200 without Authorization header', async () => {
    const app = buildApp();
    const res = await app.request(new Request('http://test/force/example.com'));
    expect(res.status).toBe(200);
  });

});

describe('GET /force/<target> — rate limiting', () => {
  it('returns 429 after the force-specific Worker allowance is exhausted', async () => {
    const publicLimiter = { limit: vi.fn(async () => ({ success: true })) };
    let forceRequests = 0;
    const forceLimiter = {
      limit: vi.fn(async () => ({ success: ++forceRequests <= 2 })),
    };
    const app = buildApp();
    const env = {
      PUBLIC_TRANSLATION_LIMITER: publicLimiter,
      FORCE_TRANSLATION_LIMITER: forceLimiter,
    };
    const request = () => new Request('http://test/force/example.com', {
      headers: { 'cf-connecting-ip': '203.0.113.12' },
    });

    const first = await app.request(request(), {}, env);
    expect(first.status).toBe(200);
    const second = await app.request(request(), {}, env);
    expect(second.status).toBe(200);
    const third = await app.request(request(), {}, env);
    expect(third.status).toBe(429);
    const body = await third.json() as { error: string };
    expect(body.error).toBe('Too many requests');
    expect(third.headers.get('Retry-After')).toBe('60');
    expect(publicLimiter.limit).toHaveBeenCalledTimes(3);
    expect(forceLimiter.limit).toHaveBeenCalledTimes(3);
    expect(forceLimiter.limit).toHaveBeenCalledWith({ key: 'ip:203.0.113.12' });
  });

});

describe('GET /force/<target> — force mode', () => {
  it('always calls translateUrl (skips D1 cache)', async () => {
    const app = buildApp();
    await app.request(req('/force/example.com'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    expect((translateUrl as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('forwards pipeline metadata headers', async () => {
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    expect(res.headers.get('X-Translate-Blocks')).toBe('1');
    expect(res.headers.get('X-Translate-Chunks')).toBe('1');
    expect(res.headers.get('X-Translate-Duration-Ms')).toBe('10');
  });
});

describe('GET /force/<target> — validation', () => {
  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/force/example.com'));
    expect(res.status).toBe(500);
  });
});
