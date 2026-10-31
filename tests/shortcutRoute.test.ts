/**
 * GET / 和 GET /s/* 路由单测。
 *
 * /  — 展示最近 10 条翻译记录列表
 * /s/ — 简写域名扩展：单单词无点号 → www.<word>.com
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../lib/translate/pipeline', () => ({
  translateUrl: vi.fn(),
}));

import { createApp } from '../lib/app';
import { MapStorage, setDefaultStorage } from '../lib/storage';

beforeAll(() => {
  process.env.AUTH_KEY = 'test-auth-key-123456';
  process.env.DEEPSEEK_API_KEY = 'sk-test-dummy';
});

beforeEach(async () => {
  setDefaultStorage(new MapStorage('test:shortcut-' + Math.random().toString(36).slice(2)));
  const { translateUrl } = await import('../lib/translate/pipeline');
  (translateUrl as any).mockClear();
  (translateUrl as any).mockResolvedValue({
    html: '<html><body>translated content</body></html>',
    title: 'Test Page Title',
    blocks: 5,
    chunks: 2,
    duration_ms: 42,
  });
});

function buildApp() {
  return createApp();
}

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

describe('GET / — translation record list', () => {
  it('returns 200 with record list page (no D1 → empty list)', async () => {
    const app = buildApp();
    const res = await app.request(req('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('翻译记录');
    expect(text).toContain('暂无翻译记录');
  });

});

describe('GET /s/<domain-or-shorthand> — shorthand URL expansion', () => {
  // ── 单单词扩展 ──
  it('expands single-word to www.<word>.com', async () => {
    const app = buildApp();
    await app.request(req('/s/medium/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://www.medium.com/article');
  });



  // ── 支持 https:// 前缀 ──
  it('strips https:// prefix from URL', async () => {
    const app = buildApp();
    await app.request(req('/s/https%3A%2F%2Fgithub.com/user/repo'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.url).toBe('https://github.com/user/repo');
  });


  // ── 有点号的域名原样使用 ──


  // ── 空路径 ──
  it('400 when target is empty (just /s/)', async () => {
    const app = buildApp();
    const res = await app.request(req('/s/'));
    expect(res.status).toBe(400);
  });

  // ── query params 透传 ──
  it('defaults target to zh and mode to bilingual', async () => {
    const app = buildApp();
    await app.request(req('/s/medium/article'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.target).toBe('zh');
    expect(call.mode).toBe('bilingual');
    expect(call.source).toBe('auto');
  });

  it('passes through source and target, forces bilingual', async () => {
    const app = buildApp();
    await app.request(req('/s/example.com/article?source=en&target=fr&mode=target'));
    const { translateUrl } = await import('../lib/translate/pipeline');
    const call = (translateUrl as any).mock.calls[0][0];
    expect(call.source).toBe('en');
    expect(call.target).toBe('fr');
    // mode 被固定为 bilingual，忽略 mode=target
    expect(call.mode).toBe('bilingual');
  });

  // ── 元数据 header ──

  // ── 错误传播 ──
  it('500 when translateUrl throws', async () => {
    const { translateUrl } = await import('../lib/translate/pipeline');
    (translateUrl as any).mockRejectedValueOnce(new Error('upstream boom'));
    const app = buildApp();
    const res = await app.request(req('/s/medium/article'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream boom');
  });
});
