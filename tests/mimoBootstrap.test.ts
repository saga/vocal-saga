import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('MiMo JWT bootstrap singleflight', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one bootstrap request across concurrent translations', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/bootstrap')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({
          jwt: 'header.payload.signature',
          exp: Date.now() + 60 * 60 * 1000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/openai/chat')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                translations: [{ id: 'b1', translated_text: '你好' }],
              }),
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Unexpected fetch URL');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { MimoTranslationService } = await import('../lib/translate/service/mimo');
    const service = new MimoTranslationService();
    const input = JSON.stringify([{ id: 'b1', text: 'hello' }]);

    const results = await Promise.all([
      service.translate(input, 'en', 'zh'),
      service.translate(input, 'en', 'zh'),
    ]);

    expect(results).toHaveLength(2);
    expect(calls.filter((url) => url.includes('/bootstrap'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/openai/chat'))).toHaveLength(2);
  });
});
