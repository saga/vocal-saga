import { describe, it, expect } from 'vitest';
import { simpleHash, generateTranslationCacheKey } from '../lib/translate/cacheKey';
import { buildPageCacheFingerprint } from '../lib/translate/pageCacheKey';

describe('simpleHash', () => {
  it('should return consistent hash for same string', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
  });


});

describe('generateTranslationCacheKey', () => {
  it('should generate consistent cache key for same input', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'Hello world' }]);
    const key1 = generateTranslationCacheKey(json, 'en', 'zh');
    const key2 = generateTranslationCacheKey(json, 'en', 'zh');
    expect(key1).toBe(key2);
  });

  it('should include source and target language in key', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'Hello' }]);
    const keyEnZh = generateTranslationCacheKey(json, 'en', 'zh');
    const keyEnJa = generateTranslationCacheKey(json, 'en', 'ja');
    const keyZhEn = generateTranslationCacheKey(json, 'zh', 'en');

    expect(keyEnZh).toContain('en');
    expect(keyEnZh).toContain('zh');
    expect(keyEnZh).not.toBe(keyEnJa);
    expect(keyEnZh).not.toBe(keyZhEn);
  });

  it('should generate different keys for different content', () => {
    const json1 = JSON.stringify([{ id: 'b1', text: 'Hello world' }]);
    const json2 = JSON.stringify([{ id: 'b1', text: 'Goodbye world' }]);
    const key1 = generateTranslationCacheKey(json1, 'en', 'zh');
    const key2 = generateTranslationCacheKey(json2, 'en', 'zh');
    expect(key1).not.toBe(key2);
  });


  it('invalidates page cache when provider, style, or site rules change', () => {
    const hash = 'v2:3:abc:def';
    const url = 'https://2026.stateofdevs.com/en-US/worldview/';
    const base = buildPageCacheFingerprint(hash, url, 'deepseek', 'default');
    expect(base).toMatch(/^page-v4:/);
    expect(buildPageCacheFingerprint(hash, url, 'openrouter', 'default')).not.toBe(base);
    expect(buildPageCacheFingerprint(hash, url, 'deepseek', 'formal')).not.toBe(base);
    expect(buildPageCacheFingerprint(hash, 'https://2026.stateofdevs.com/en-US/', 'deepseek', 'default')).not.toBe(base);
    expect(buildPageCacheFingerprint(hash, url, 'deepseek', 'default')).toBe(base);
  });

  it('includes site-specific instructions in the translation cache key', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'Translate this sentence.' }]);
    const generic = generateTranslationCacheKey(json, 'en', 'zh', 'deepseek', 'default', {});
    const siteA = generateTranslationCacheKey(json, 'en', 'zh', 'deepseek', 'default', {
      site_instructions: ['Preserve survey percentages and chart labels.'],
    });
    const siteB = generateTranslationCacheKey(json, 'en', 'zh', 'deepseek', 'default', {
      site_instructions: ['Use formal legal language.'],
    });
    expect(siteA).not.toBe(generic);
    expect(siteA).not.toBe(siteB);
  });


  it('keeps technical and literary profile cache entries separate', () => {
    const json = JSON.stringify([{ id: 'b1', text: 'A literary sentence.' }]);
    const technical = generateTranslationCacheKey(json, 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'technical');
    const literary = generateTranslationCacheKey(json, 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'literary');
    expect(technical).not.toBe(literary);
  });

  it('keeps page cache entries separate across translation profiles', () => {
    const hash = 'blocks-v1';
    const url = 'https://example.com/chapter';
    const technical = buildPageCacheFingerprint(hash, url, 'deepseek', 'default', 'technical');
    const literary = buildPageCacheFingerprint(hash, url, 'deepseek', 'default', 'literary');
    expect(technical).not.toBe(literary);
  });

  it('should use content prefix for faster comparison', () => {
    const longContent = 'a'.repeat(1000);
    const json = JSON.stringify([{ id: 'b1', text: longContent }]);
    const key = generateTranslationCacheKey(json, 'en', 'zh');

    expect(key).toMatch(/^translation_en_zh_\d+_\d+$/);
  });


});
