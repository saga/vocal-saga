/**
 * 「0 译文」的诊断链路：provider 调用失败、响应无可用译文时，
 * 原因必须随调用链带出，而不是只在服务端 console 里留一行。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  translateChunk,
  summarizeTranslationFailures,
  type TranslationDiagnostics,
} from '../lib/translate/pipeline';
import { MapStorage, setDefaultStorage } from '../lib/storage';

function makeChunk() {
  return {
    id: 'c1',
    blocks: [{ id: 'b1', text: 'Hello world', tag: 'p', xpath: '' }],
    jsonContent: JSON.stringify([{ id: 'b1', text: 'Hello world' }]),
    estimatedTokens: 16,
  } as any;
}

function makeDiagnostics(): TranslationDiagnostics {
  return { provider: 'deepseek', totalChunks: 1, failures: [] };
}

/** skipCache=true 让测试只走 provider 调用与译文解析，不依赖历史缓存。 */
async function runChunk(service: any, diagnostics: TranslationDiagnostics) {
  return translateChunk(
    service,
    makeChunk(),
    'en',
    'zh',
    undefined,
    false,
    'deepseek',
    undefined,
    true,
    'technical',
    diagnostics,
  );
}

beforeEach(() => {
  setDefaultStorage(new MapStorage('test:failure-diag-' + Math.random().toString(36).slice(2)));
});

describe('翻译失败诊断', () => {
  it('provider 调用失败时记录错误并生成可返回的摘要', async () => {
    const diagnostics = makeDiagnostics();
    const service = {
      translate: async () => { throw new Error('DeepSeek API error: HTTP 401 - Authentication Fails'); },
    };

    const result = await runChunk(service, diagnostics);

    expect(result.size).toBe(0);
    expect(diagnostics.failures).toHaveLength(1);
    expect(diagnostics.failures[0]).toMatchObject({ chunkId: 'c1', stage: 'provider' });
    const summary = summarizeTranslationFailures(diagnostics);
    expect(summary).toContain('provider=deepseek');
    expect(summary).toContain('1 failure(s), 1 chunk(s)');
    expect(summary).toContain('HTTP 401');
  });

  it('响应解析不出译文时记录 empty 阶段', async () => {
    const diagnostics = makeDiagnostics();
    const service = { translate: async () => 'sorry, I cannot translate this <<<' };

    const result = await runChunk(service, diagnostics);

    expect(result.size).toBe(0);
    expect(diagnostics.failures.some((f) => f.stage === 'empty' || f.stage === 'parse')).toBe(true);
    expect(summarizeTranslationFailures(diagnostics)).toContain('provider=deepseek');
  });

  it('摘要对上游错误里的 API key 脱敏', async () => {
    const diagnostics = makeDiagnostics();
    const service = {
      translate: async () => { throw new Error('HTTP 401 for sk-abcdef1234567890XYZ'); },
    };

    await runChunk(service, diagnostics);

    const summary = summarizeTranslationFailures(diagnostics) || '';
    expect(summary).toContain('sk-***');
    expect(summary).not.toContain('sk-abcdef1234567890XYZ');
  });

  it('分段合并失败也会出现在摘要里', () => {
    const diagnostics = makeDiagnostics();
    diagnostics.failures.push({
      chunkId: 'merge',
      stage: 'merge',
      message: 'all 46 translated segments dropped: incomplete segment groups',
    });

    expect(summarizeTranslationFailures(diagnostics)).toContain('[merge/merge]');
    expect(summarizeTranslationFailures(diagnostics)).toContain('incomplete segment groups');
  });

  it('有可用译文时不产生失败摘要', async () => {
    const diagnostics = makeDiagnostics();
    const service = {
      translate: async () => JSON.stringify([{ id: 'b1', translated_text: '你好，世界' }]),
    };

    const result = await runChunk(service, diagnostics);

    expect(result.get('b1')).toBe('你好，世界');
    expect(diagnostics.failures).toHaveLength(0);
    expect(summarizeTranslationFailures(diagnostics)).toBeUndefined();
  });
});
