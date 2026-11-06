import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/translate/translateApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/translate/translateApi')>('../lib/translate/translateApi');
  return {
    ...actual,
    getCachedTranslation: vi.fn(),
    cacheTranslation: vi.fn(),
  };
});

import { getCachedTranslation, cacheTranslation } from '../lib/translate/translateApi';
import { buildChunks } from '../lib/translate/chunkBuilder';
import { generateTranslationCacheKey } from '../lib/translate/cacheKey';
import { translateChunk } from '../lib/translate/pipeline';

const getCachedMock = vi.mocked(getCachedTranslation);
const cacheMock = vi.mocked(cacheTranslation);

/** 造 n 个长度接近真实段落的 block，避免触发「译文过短」的映射告警。 */
function makeBlocks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`,
    xpath: `/p[${i + 1}]`,
    tag: 'p',
    text: `Paragraph ${i + 1}: translation caching should stay at chunk granularity so that a single article costs exactly one write.`,
  }));
}

/** 回一段与原文等长的中文，保证映射校验通过。 */
const service = {
  translate: vi.fn(async (jsonContent: string) => {
    const payload = JSON.parse(jsonContent) as Array<{ id: string; text: string }>;
    return JSON.stringify({
      translations: payload.map((item) => ({
        id: item.id,
        translated_text: `第 ${item.id.slice(1)} 段：翻译缓存应当以 chunk 为粒度，这样一整篇文章只产生一次写入。`,
      })),
    });
  }),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  getCachedMock.mockResolvedValue(null);
  cacheMock.mockResolvedValue(undefined);
});

describe('translateChunk 缓存粒度', () => {
  it('一个 chunk 无论多少块都只读一次、只写一次', async () => {
    const chunk = buildChunks(makeBlocks(46) as any)[0];

    const result = await translateChunk(service, chunk, 'en', 'zh', undefined, false, 'deepseek', 'default');

    expect(result.size).toBe(46);
    expect(getCachedMock).toHaveBeenCalledTimes(1);
    expect(cacheMock).toHaveBeenCalledTimes(1);
    expect(cacheMock.mock.calls[0][0]).toBe(
      generateTranslationCacheKey(chunk.jsonContent, 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'technical'),
    );
    // 写入的是整块结果，不是逐块条目。
    expect(cacheMock.mock.calls[0][1].size).toBe(46);
  });

  it('chunk 命中时既不调用 provider 也不回写', async () => {
    const chunk = buildChunks(makeBlocks(5) as any)[0];
    const key = generateTranslationCacheKey(chunk.jsonContent, 'en', 'zh', 'deepseek', 'default', undefined, undefined, 'technical');
    const cached = new Map(chunk.blocks.map((block) => [block.id, `已缓存的译文 ${block.id}`]));
    getCachedMock.mockImplementation(async (k) => (k === key ? cached : null));

    const result = await translateChunk(service, chunk, 'en', 'zh', undefined, false, 'deepseek', 'default');

    expect(result).toEqual(cached);
    expect(service.translate).not.toHaveBeenCalled();
    expect(cacheMock).not.toHaveBeenCalled();
  });

  it('retry 不读也不写缓存', async () => {
    const chunk = buildChunks(makeBlocks(3) as any)[0];

    await translateChunk(service, chunk, 'en', 'zh', undefined, true, 'deepseek', 'default');

    expect(getCachedMock).not.toHaveBeenCalled();
    expect(cacheMock).not.toHaveBeenCalled();
  });

  it('skipCache 跳过读取，但仍会写入结果', async () => {
    const chunk = buildChunks(makeBlocks(3) as any)[0];

    await translateChunk(service, chunk, 'en', 'zh', undefined, false, 'deepseek', 'default', true);

    expect(getCachedMock).not.toHaveBeenCalled();
    expect(cacheMock).toHaveBeenCalledTimes(1);
  });
});
