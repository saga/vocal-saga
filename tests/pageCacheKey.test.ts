import { describe, expect, it } from 'vitest';
import { buildPageCacheFingerprint } from '../lib/translate/pageCacheKey';

describe('buildPageCacheFingerprint', () => {
  const base = {
    clientContentHash: 'blocks-v2:test',
    pageUrl: 'https://example.com/article',
    provider: 'deepseek',
    promptStyle: 'default',
    translationMode: 'technical',
  };

  it('uses a versioned page-cache namespace', () => {
    expect(buildPageCacheFingerprint(
      base.clientContentHash,
      base.pageUrl,
      base.provider,
      base.promptStyle,
      base.translationMode,
    )).toMatch(/^page-v4:/);
  });

  it('separates provider, style, model and quality mode; legacy literary flags do not change the web cache', () => {
    const fingerprint = (overrides: Partial<typeof base> & { model?: string; qualityMode?: string } = {}) =>
      buildPageCacheFingerprint(
        base.clientContentHash,
        base.pageUrl,
        overrides.provider ?? base.provider,
        overrides.promptStyle ?? base.promptStyle,
        overrides.translationMode ?? base.translationMode,
        overrides.model,
        overrides.qualityMode,
      );

    const original = fingerprint({ model: 'model-a' });
    expect(fingerprint({ provider: 'openrouter', model: 'model-a' })).not.toBe(original);
    expect(fingerprint({ promptStyle: 'wangxiaobo', model: 'model-a' })).not.toBe(original);
    expect(fingerprint({ model: 'model-b' })).not.toBe(original);
    expect(fingerprint({ qualityMode: 'enhanced', model: 'model-a' })).not.toBe(original);
    expect(fingerprint({ translationMode: 'literary', model: 'model-a' })).toBe(original);
  });
});
