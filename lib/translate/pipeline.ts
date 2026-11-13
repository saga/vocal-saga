/**
 * 翻译 pipeline — 串联 contentHelper / chunkBuilder / cache / service。
 *
 * 三个对外入口：
 *   - translateText   纯文本批量翻译（不抽 DOM）
 *   - translateDoc    已有 Document（service-side 用 urlFetcher.ts）
 *   - translateUrl    完整 URL → 翻译后 HTML（linkedom 回填）
 *
 * Server 端策略：
 *   - chunk 内 missing 自动 retry 一次
 *   - 整 chunk 缓存 (translationCache)
 *   - 有界并发翻译（KV cache 不跨请求）
 */

import { prepareDocument } from './contentHelper';
import { buildChunks, mergeSegmentTranslations, type Chunk } from './chunkBuilder';
import { extractBlocksFromMarkedHtml, type TextBlock } from './blockExtractor';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from './chunkRetry';
import {
  cacheTranslation,
  getCachedTranslation,
  processTranslationWithCheck,
} from './translateApi';
import { generateTranslationCacheKey } from './cacheKey';
import { translateSingleflight } from './singleflight.js';
import { DeepSeekTranslationService } from './service/deepseek';
import type { Glossary } from './service/_service';
import type { PromptStyle, TranslationMode } from './service/shared';
import { detectLanguage, shouldUseJapaneseSource } from './languageDetector';
import { fetchPage } from './urlFetcher';
import { runWithConcurrency } from './concurrency';
import { matchSiteRule } from './rules';
import { parseHTML } from 'linkedom';
import { inlineExternalStylesheets } from './cssInliner';
import { assertNotDomainParkingPage, looksLikeDomainParkingHtml } from './pageGuard';
import { safeLogUrl } from '../urlUtils';

/**
 * Stable model identity for translation cache/singleflight isolation.
 * Resolve defaults here so a provider's implicit default is also versioned in the cache.
 */
export function resolveTranslationModelIdentity(provider: string, requestedModel?: string): string {
  if (requestedModel?.trim()) return requestedModel.trim();
  const defaults: Record<string, string> = {
    deepseek: 'deepseek-v4-flash',
    openrouter: 'openai/gpt-oss-20b:free',
    nvidia: 'stepfun-ai/step-3.7-flash',
    cloudflare: '@cf/moonshotai/kimi-k2.6',
    mimo: 'mimo-auto',
    gemini: 'gemini-3.1-flash-lite',
    opencode: 'big-pickle',
  };
  return defaults[provider] ?? 'provider-default';
}

// =============================================================================
// 性能日志
// =============================================================================

function logCost(label: string, startMs: number): void {
  console.log(`[PERF] ${label} ${Math.round((performance.now() - startMs) * 1000)}µs`);
}

/**
 * 防御：data-fanyi-remove 是抽取/清理阶段的运行时标记，不应出现在对外输出的 HTML 中。
 * 尤其不能留在 <main> 的祖先（例如 Drupal 的 dialog-off-canvas-main-canvas）上——
 * 否则输出 HTML 自带的 [data-fanyi-remove]{display:none} CSS 会把整页容器隐藏，导致白屏。
 * 这里只剥离"正文根祖先"上的标记；真正的浮层/广告（与正文平级）仍保留隐藏，保持干净的译文视图。
 */
function stripRemoveMarkersFromAncestors(doc: Document): void {
  const main = doc.querySelector('main, article, [role="main"]');
  if (!main) return;
  const ancestors = new Set<Element>();
  let p: Element | null = main.parentElement;
  while (p) {
    ancestors.add(p);
    p = p.parentElement;
  }
  for (const el of Array.from(doc.querySelectorAll('[data-fanyi-remove="true"]'))) {
    if (ancestors.has(el)) {
      el.removeAttribute('data-fanyi-remove');
    }
  }
}

// =============================================================================
// 内部：chunk → translation
// =============================================================================

/**
 * 把站点规则里的 `documentTerms`（各站点手工维护的专有名词表）合并进 glossary。
 *
 * 合并而不是替换：调用方（/fanyi/page 等）可能已经传了自定义术语，站点词表
 * 只是补充。重复项无需处理 —— 进 prompt 前 `sanitizeDocumentTerms` 会去重。
 *
 * 为什么放在这里：只有 pipeline 同时拿得到 `finalUrl`（决定命中哪条站点规则）
 * 和 glossary，service 层两者都看不到。
 */
export function withSiteDocumentTerms(
  glossary: Glossary | undefined,
  finalUrl: string
): Glossary | undefined {
  const rule = matchSiteRule(finalUrl)?.siteRule;
  const siteTerms = rule?.documentTerms ?? [];
  const siteInstruction = rule?.promptInstructions?.trim();
  if (siteTerms.length === 0 && !siteInstruction) return glossary;
  return {
    ...glossary,
    ...(siteTerms.length > 0
      ? { document_terms: [...(glossary?.document_terms ?? []), ...siteTerms] }
      : {}),
    ...(siteInstruction
      ? { site_instructions: [...(glossary?.site_instructions ?? []), siteInstruction] }
      : {}),
  };
}

/**
 * Enhanced webpage mode reuses already-extracted page metadata. It never calls a
 * separate context/reviewer model; the bounded context is shared with each chunk.
 */
export type WebTranslationQualityMode = 'fast' | 'enhanced';

export function buildWebQualityInstructions(
  title: string,
  blocks: TextBlock[],
): string | undefined {
  const headings = blocks
    .filter((block) => /^h[1-6]$/i.test(block.tag || ''))
    .slice(0, 4)
    .map((block) => block.text.trim().slice(0, 80))
    .filter(Boolean);
  const opening = blocks
    .filter((block) => /^p$/i.test(block.tag || ''))
    .slice(0, 1)
    .map((block) => block.text.trim().slice(0, 160))
    .filter(Boolean);
  const context = {
    title: title.slice(0, 160),
    headings,
    opening,
  };
  if (!title.trim() && !headings.length && !opening.length) return undefined;
  return [
    '增强质量模式：以下是当前网页已有的标题、章节标题和开头片段，仅作为理解本页主题与术语的只读上下文，不要翻译或复述这些上下文。',
    '结合上下文理解当前片段中的缩写、术语和指代；同一术语在本页保持一致。仍以当前待翻译片段为准，不得根据上下文补充原文没有的信息。',
    JSON.stringify(context),
  ].join('\n');
}

export function withWebQualityContext(
  glossary: Glossary | undefined,
  title: string,
  blocks: TextBlock[],
  qualityMode: WebTranslationQualityMode,
): Glossary | undefined {
  if (qualityMode !== 'enhanced') return glossary;
  const instruction = buildWebQualityInstructions(title, blocks);
  if (!instruction) return glossary;
  return {
    ...glossary,
    site_instructions: [...(glossary?.site_instructions ?? []), instruction],
  };
}

/**
 * 单个 chunk 的失败记录。provider 调用失败、译文解析失败、响应里没有可用译文，
 * 这三种情况都会降级成「本块缺失」；全部 chunk 都走到这里时最终译文数为 0，
 * 只有把原因带出去才能区分上游故障和页面本身无可译内容。
 */
export interface TranslationFailure {
  chunkId: string;
  stage: 'provider' | 'parse' | 'empty' | 'merge';
  message: string;
}

/** 本次翻译的失败汇总，随调用链传递，不进缓存 key。 */
export interface TranslationDiagnostics {
  provider: string;
  totalChunks: number;
  failures: TranslationFailure[];
}

/** 聚合成一行可返回给客户端的诊断；顺带脱敏上游错误里可能夹带的 API key。 */
export function summarizeTranslationFailures(diagnostics: TranslationDiagnostics): string | undefined {
  const { failures } = diagnostics;
  if (!failures.length) return undefined;
  const first = failures[0];
  const message = first.message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').slice(0, 240);
  return `provider=${diagnostics.provider}: ${failures.length} failure(s), ${diagnostics.totalChunks} chunk(s); ` +
    `first [${first.chunkId}/${first.stage}] ${message}`;
}

export async function translateChunk(
  service: DeepSeekTranslationService,
  chunk: ReturnType<typeof buildChunks>[number],
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  isRetry = false,
  /** LLM 提供方，纳入 cacheKey 避免 provider 切换后读到脏缓存 */
  provider?: string,
  /** 翻译文风，纳入 cacheKey 避免 style 切换后读到脏缓存 */
  promptStyle?: string,
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache = false,
  translationMode: TranslationMode = 'technical',
  diagnostics?: TranslationDiagnostics,
  modelIdentity?: string,
): Promise<Map<string, string>> {
  const chunkLabel = `[Chunk ${chunk.id}]`;
  const cacheKey = generateTranslationCacheKey(chunk.jsonContent, sourceLang, targetLang, provider, promptStyle, glossary, undefined, translationMode, modelIdentity);
  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`${chunkLabel} start (${chunk.blocks.length} blocks, ${chunk.estimatedTokens} tokens)`);

  // 缓存粒度就是 chunk：一个 chunk 一次读、一次写。按块缓存会让每篇长文产生
  // 「块数 + 1」次 KV 写（一篇 46 段的文章就是 47 次），轻易超过 Workers KV
  // 免费版每天 1000 次写额度；而页级缓存已经挡住重复访问，块级命中率本就接近零。
  if (!isRetry && !skipCache) {
    const cachedChunk = await getCachedTranslation(cacheKey);
    if (cachedChunk) {
      console.log(`${chunkLabel} cache hit`);
      return cachedChunk;
    }
  }

  const pendingBlocks = chunk.blocks;

  console.log(`${chunkLabel} api.call start (blocks=${pendingBlocks.length})`);
  const tApi = performance.now();
  let raw: string;
  try {
    raw = await translateSingleflight(cacheKey, () => service.translate(chunk.jsonContent, sourceLang, targetLang, glossary));
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error(`${chunkLabel} provider call failed, treating chunk as missing:`, message);
    diagnostics?.failures.push({ chunkId: chunk.id, stage: 'provider', message });
    return new Map();
  }
  console.log(`${chunkLabel} api.call done (${us(performance.now() - tApi)})`);

  let freshResult: Map<string, string>;
  try {
    freshResult = processTranslationWithCheck(raw, pendingBlocks.map((block) => ({ id: block.id, text: block.text })));
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error(`${chunkLabel} translation parse failed, treating chunk as missing:`, message);
    diagnostics?.failures.push({ chunkId: chunk.id, stage: 'parse', message });
    freshResult = new Map<string, string>();
  }
  if (freshResult.size === 0) {
    // 解析函数对无法修复的响应直接返回空 Map（不抛错），也要留下诊断。
    diagnostics?.failures.push({
      chunkId: chunk.id,
      stage: 'empty',
      message: `provider response had no usable translations for ${pendingBlocks.length} block(s)`,
    });
  }

  const result = new Map(freshResult);

  // 整个 chunk 一次写完；retry 不写缓存，避免污染。
  if (!isRetry && result.size > 0) {
    await cacheTranslation(cacheKey, result);
  }

  return result;
}

async function translateChunksWithRetry(
  service: DeepSeekTranslationService,
  chunks: ReturnType<typeof buildChunks>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  /**
   * 并行 chunk 数。
   *   - translateText（小文本，单 chunk）→ 1
   *   - translateUrl → 6（CF Workers 同时建立连接上限 6，全并发）
   * CF Workers 限制同时最多 6 个 fetch 等待 response headers。
   * Server 端 KV cache 不跨请求，直接全并行。
   */
  concurrency = 6,
  /** LLM 提供方，透传给 translateChunk 纳入 cacheKey */
  provider?: string,
  /** 翻译文风，透传给 translateChunk 纳入 cacheKey */
  promptStyle?: string,
  /** 跳过 chunk 缓存读取（强制刷新场景） */
  skipCache = false,
  translationMode: TranslationMode = 'technical',
  diagnostics?: TranslationDiagnostics,
  modelIdentity?: string,
): Promise<Map<string, string>> {
  const finalTranslations = new Map<string, string>();
  if (diagnostics) diagnostics.totalChunks = chunks.length;
  if (chunks.length === 0) return finalTranslations;

  const us = (ms: number) => `${Math.round(ms * 1000)}µs`;
  console.log(`[Pipeline] translateChunks: ${chunks.length} chunks, concurrency=${concurrency}`);
  const tAll = performance.now();

  async function processOneChunk(
    chunk: ReturnType<typeof buildChunks>[number]
  ): Promise<void> {
    const result = await translateChunk(service, chunk, sourceLang, targetLang, glossary, false, provider, promptStyle, skipCache, translationMode, diagnostics, modelIdentity);

    // 缺失检测 + 重试
    const inputIds = chunk.blocks.map((b) => b.id);
    const outputIds = Array.from(result.keys());
    const missingIds = diffMissingIds(inputIds, outputIds);

    if (
      shouldRetryMissing({
        missingCount: missingIds.length,
        totalCount: chunk.blocks.length,
        isRetry: chunk.id.endsWith('_retry'),
      })
    ) {
      console.warn(
        `[Pipeline] ${chunk.id} missing ${missingIds.length}/${chunk.blocks.length}, retrying`
      );
      const retryChunk = buildRetryChunk(chunk, missingIds);
      const retryResult = await translateChunk(
        service,
        retryChunk,
        sourceLang,
        targetLang,
        glossary,
        /* isRetry */ true,
        provider,
        promptStyle,
        skipCache,
        translationMode,
        diagnostics,
        modelIdentity,
      );
      for (const [id, text] of retryResult) {
        result.set(id, text);
      }
    }

    for (const [id, text] of result) {
      finalTranslations.set(id, text);
    }
  }

  try {
    // 有界并发：始终只有 `concurrency` 个 chunk 在飞。
    // 早期这里是 chunks.map(...) + Promise.all（全并发），concurrency 只进日志、
    // 不生效，长文会瞬间打满上游触发 429。详见 lib/translate/concurrency.ts。
    await runWithConcurrency(chunks, concurrency, processOneChunk);
    console.log(`[Pipeline] translateChunks done (${us(performance.now() - tAll)})`);
  } catch (err) {
    console.error(`[Pipeline] translateChunks failed after ${us(performance.now() - tAll)}:`, (err as Error)?.name || 'UnknownError');
    throw err;
  }

  const merged = mergeSegmentTranslations(chunks, finalTranslations);
  if (finalTranslations.size > 0 && merged.size === 0) {
    // 分段译文只有在整组齐全时才会合并回原 block id；组不全时全部丢弃，
    // 这与上游无关，也要留下诊断，否则会被误报成 provider 故障。
    diagnostics?.failures.push({
      chunkId: 'merge',
      stage: 'merge',
      message: `all ${finalTranslations.size} translated segments dropped: incomplete segment groups`,
    });
  }
  if (diagnostics?.failures.length) {
    const summary = summarizeTranslationFailures(diagnostics);
    console.error(merged.size === 0
      ? `[Pipeline] every chunk failed: ${summary}`
      : `[Pipeline] partial chunk failures (${merged.size} blocks translated): ${summary}`);
  }
  return merged;
}

// =============================================================================
// 对外：translateText
// =============================================================================

export interface TranslateTextInput {
  text: string;
  source?: string;
  target?: string;
  glossary?: Glossary;
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
  translationMode?: TranslationMode;
}

export interface TranslateTextResult {
  translations: Array<{ id: string; text: string }>;
  chunks: number;
  duration_ms: number;
}

export async function translateText(input: TranslateTextInput): Promise<TranslateTextResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';

  if (!input.text.trim()) {
    return { translations: [], chunks: 0, duration_ms: 0 };
  }

  // 把整段文本当作一个 block（id=b1）→ chunkBuilder 按 token 切
  const blocks = [
    { id: 'b1', xpath: '', tag: 'p', text: input.text.trim() },
  ];
  const chunks = buildChunks(blocks as any);

  const service = new DeepSeekTranslationService(undefined, input.promptStyle, input.translationMode);
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    input.glossary,
    6,
    /* provider */ 'deepseek',
    input.promptStyle,
    false,
    input.translationMode,
    undefined,
    resolveTranslationModelIdentity('deepseek'),
  );

  return {
    translations: Array.from(translations, ([id, text]) => ({ id, text })),
    chunks: chunks.length,
    duration_ms: Date.now() - start,
  };
}

// =============================================================================
// 对外：translateBlocks → 文档翻译的原子能力
// =============================================================================

export type TranslationProvider =
  | 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode';

export interface TranslateBlocksInput {
  /** 一批待翻译片段，id 由调用方保证稳定（文档里就是 segment.id）。 */
  blocks: Array<{ id: string; text: string; contextPath?: string; kind?: string; level?: number; marker?: string }>;
  source?: string;
  target?: string;
  glossary?: Glossary;
  promptStyle?: PromptStyle;
  /** 独立翻译目标：技术准确性优先或文学表达/实体一致性优先。 */
  translationMode?: TranslationMode;
  concurrency?: number;
  /** 文档接口沿用调用方当前选择的 provider；省略时保持旧行为 DeepSeek。 */
  provider?: TranslationProvider;
  model?: string;
  /** 仅 DeepSeek provider 需要由调用方提供的 key。 */
  apiKey?: string;
  /**
   * 只用于文档专用任务（书籍分析/翻译/审校）。被合并进 request glossary 的 system instructions，
   * 因而会参与 cache key；不传时网页翻译 prompt 与缓存行为保持不变。
   */
  taskInstructions?: string;
  /** Document-reader-only full prompt overrides; omitted for normal webpage translation. */
  systemPromptOverride?: string;
  userPromptTemplate?: string;
  /** Bypass cached block/chunk reads; newly generated results still replace the cache. */
  skipCache?: boolean;
}

/**
 * 翻译一批 blocks，复用 chunk 级缓存与 missing 重试。
 *
 * 与 translateText 的区别：translateText 把整段文本当成一个 block（id=b1），
 * 适合"翻译一段话"；文档翻译需要保留每个 segment 的 id 以便回填，
 * 所以这里按调用方给出的 id 走，不做合并。
 */
export async function translateBlocks(
  input: TranslateBlocksInput,
): Promise<Map<string, string>> {
  const blocks = input.blocks
    .filter((b) => b?.text?.trim())
    .map((b) => ({
      id: b.id,
      xpath: '',
      tag: b.kind === 'heading' ? 'h' + Math.min(6, Math.max(1, b.level ?? 2)) : 'p',
      text: b.text,
      ...(b.contextPath?.trim() ? { contextPath: b.contextPath.trim() } : {}),
      ...(b.kind ? { kind: b.kind } : {}),
      ...(Number.isInteger(b.level) ? { level: b.level } : {}),
      ...(b.marker ? { marker: b.marker } : {}),
    }));
  if (!blocks.length) return new Map();

  // 文学书籍的专用任务指令只在调用方显式提供时加入，不改变网页翻译默认 prompt。
  // 与提示词一起进入 glossary cache fingerprint，避免旧直译缓存污染审校/分析结果。
  const taskInstruction = input.taskInstructions?.trim();
  const translationMode: TranslationMode = input.translationMode === 'literary' ? 'literary' : 'technical';
  // Literary mode has no generic terminology glossary. Keep only explicit site/task instructions
  // because those are workflow constraints, not terms that force words to remain untranslated.
  const promptOverrides = {
    ...(input.systemPromptOverride?.trim() ? { document_system_prompt_override: input.systemPromptOverride.trim() } : {}),
    ...(input.userPromptTemplate?.trim() ? { document_user_prompt_template: input.userPromptTemplate.trim() } : {}),
  };
  const baseGlossary: Glossary | undefined = translationMode === 'literary'
    ? {
        ...(input.glossary?.site_instructions?.length ? { site_instructions: input.glossary.site_instructions } : {}),
        ...promptOverrides,
      }
    : { ...(input.glossary ?? {}), ...promptOverrides };
  const requestGlossary: Glossary | undefined = taskInstruction
    ? {
        ...(baseGlossary ?? {}),
        site_instructions: [
          ...(baseGlossary?.site_instructions ?? []),
          taskInstruction,
        ].filter((instruction) => typeof instruction === 'string' && instruction.trim()),
      }
    : baseGlossary;

  const chunks = buildChunks(blocks as unknown as TextBlock[]);
  const provider = input.provider ?? 'deepseek';
  let service: DeepSeekTranslationService;
  if (provider === 'openrouter') {
    const { OpenRouterTranslationService } = await import('./service/openrouter');
    service = new OpenRouterTranslationService(input.promptStyle, translationMode) as any;
  } else if (provider === 'nvidia') {
    const { NvidiaTranslationService } = await import('./service/nvidia');
    service = new NvidiaTranslationService(input.model, input.promptStyle, translationMode) as any;
  } else if (provider === 'cloudflare') {
    const { CloudflareAITranslationService } = await import('./service/cloudflare');
    service = new CloudflareAITranslationService(input.promptStyle, translationMode) as any;
  } else if (provider === 'mimo') {
    const { MimoTranslationService } = await import('./service/mimo');
    service = new MimoTranslationService(input.promptStyle, translationMode) as any;
  } else if (provider === 'gemini') {
    const { GeminiTranslationService } = await import('./service/gemini');
    service = new GeminiTranslationService(input.model, input.promptStyle, translationMode) as any;
  } else if (provider === 'opencode') {
    const { OpencodeTranslationService } = await import('./service/opencode');
    service = new OpencodeTranslationService(input.promptStyle, translationMode) as any;
  } else {
    service = new DeepSeekTranslationService(input.apiKey, input.promptStyle, translationMode);
  }
  return translateChunksWithRetry(
    service,
    chunks,
    input.source || 'auto',
    input.target || 'zh',
    requestGlossary,
    input.concurrency ?? 4,
    provider,
    input.promptStyle,
    input.skipCache ?? false,
    translationMode,
    undefined,
    resolveTranslationModelIdentity(provider, input.model),
  );
}

// =============================================================================
// 对外：translateUrl → 返回翻译后 HTML
// =============================================================================

export interface TranslateUrlInput {
  url: string;
  source?: string;
  target?: string;
  mode?: 'bilingual';
  glossary?: Glossary;
  /** LLM 提供方，统一字段名 provider（避免与 TranslationService 类混淆） */
  provider?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode';
  model?: string;
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
  /** @deprecated Legacy compatibility only; remote webpage translation always uses technical mode. */
  translationMode?: TranslationMode;
  /** Optional bounded webpage context; defaults to fast with no additional model calls. */
  qualityMode?: WebTranslationQualityMode;
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache?: boolean;
  /**
   * 覆盖默认的 SSRF 校验函数，透传给 fetchPage，**仅用于单元测试**。
   * 生产不传，使用默认的 assertPublicUrl。
   */
  ssrfGuard?: (url: string) => void;
}

export interface TranslateUrlResult {
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  blocks: number;
  translatedBlocks: number;
  chunks: number;
  duration_ms: number;
  /** 0 译文时的上游失败摘要；部分成功时为 undefined。 */
  failureDetail?: string;
}

export interface TranslateHtmlInput {
  html: string;
  url: string;
  /** Exact extension-extracted text; accepted only when IDs/tags/order match marked HTML. */
  blocks?: Array<{ id: string; tag: string; text: string }>;
  source?: string;
  target?: string;
  mode?: 'bilingual';
  glossary?: Glossary;
  /** LLM 提供方，统一字段名 provider（避免与 TranslationService 类混淆） */
  provider?: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode';
  model?: string;
  /** 客户端传入的 DeepSeek API Key（/fanyi/page 使用） */
  apiKey?: string;
  /** 翻译文风，默认通用直译 */
  promptStyle?: PromptStyle;
  /** @deprecated Legacy compatibility only; remote webpage translation always uses technical mode. */
  translationMode?: TranslationMode;
  /** Optional bounded webpage context; defaults to fast with no additional model calls. */
  qualityMode?: WebTranslationQualityMode;
  /** 跳过 chunk 缓存读取（强制刷新场景：/force/* 路由） */
  skipCache?: boolean;
}

async function runTranslationPipeline(
  doc: Document,
  finalUrl: string,
  sourceLang: string,
  targetLang: string,
  mode: 'bilingual',
  provider: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode',
  model: string | undefined,
  glossary: Glossary | undefined,
  existingBlocks?: TextBlock[],
  existingChunks?: Chunk[],
  apiKey?: string,
  style?: PromptStyle,
  /** 跳过 chunk 缓存读取（强制刷新场景） */
  skipCache = false,
  translationMode: TranslationMode = 'technical',
  qualityMode: WebTranslationQualityMode = 'fast',
): Promise<{ title: string; html: string; blocks: number; translatedBlocks: number; chunks: number; failureDetail?: string }> {
  // Webpage translation is deliberately not the literary/document workflow.
  // Ignore legacy clients that still send translationMode=literary.
  translationMode = 'technical';
  const title =
    (doc.querySelector('title')?.textContent || '').trim().substring(0, 200) ||
    finalUrl;

  const tPrep = performance.now();
  let blocks: TextBlock[];
  let chunks: Chunk[];

  if (existingChunks && existingChunks.length > 0) {
    // 扩展端已分块，直接使用
    chunks = existingChunks;
    blocks = existingBlocks || chunks.flatMap((c) => c.blocks);
    console.log(`[Pipeline] Using ${blocks.length} pre-extracted blocks → ${chunks.length} pre-built chunks`);
  } else if (existingBlocks && existingBlocks.length > 0) {
    // 扩展端提供了 blocks，服务端分块
    blocks = existingBlocks;
    chunks = buildChunks(blocks);
    console.log(`[Pipeline] Using ${blocks.length} pre-extracted blocks → ${chunks.length} chunks`);
  } else {
    // 原有流程：从 HTML 提取
    const result = prepareDocument(doc, finalUrl);
    blocks = result.blocks;
    chunks = result.chunks;
    console.log(`[Pipeline] Extracted ${blocks.length} blocks → ${chunks.length} chunks`);
  }

  // ── 页级语言检测（整页只做一次）──
  // 目的：日语原文 → 非日语目标语言时，把 default 文风自动升级为 ja-source-natural
  // （保留原文的克制、论述顺序与限定语气，见 service/japanese-natural-zh-prompt）。
  // 只检测一次而不是每 chunk 一次：既避免重复统计，也让 DeepSeek prompt 的
  // 公共前缀保持稳定（利于 KV cache 命中）。
  // 用户手工选择的文风永远优先 —— 策略集中在 shouldUseJapaneseSource。
  const detected = detectLanguage(blocks.map((b) => b.text).join('\n'), {
    htmlLang: doc.documentElement?.getAttribute('lang') || undefined,
  });
  const effectiveStyle: PromptStyle | undefined = shouldUseJapaneseSource(
    style,
    detected.language,
    targetLang,
  )
    ? 'ja-source-natural'
    : style;
  if (effectiveStyle !== style) {
    console.log(
      `[Pipeline] Source detected as ${detected.language} ` +
        `(kanaRatio=${detected.kanaRatio.toFixed(3)}, confidence=${detected.confidence.toFixed(2)}) ` +
        `→ promptStyle ${style ?? 'default'} auto-upgraded to ${effectiveStyle}`,
    );
  }

  // 根据 provider 选择翻译服务实例，传入 effectiveStyle 切换文风
  let service: DeepSeekTranslationService;
  if (provider === 'openrouter') {
    const { OpenRouterTranslationService } = await import('./service/openrouter');
    service = new OpenRouterTranslationService(effectiveStyle, translationMode) as any;
  } else if (provider === 'nvidia') {
    const { NvidiaTranslationService } = await import('./service/nvidia');
    service = new NvidiaTranslationService(model, effectiveStyle, translationMode) as any;
  } else if (provider === 'cloudflare') {
    const { CloudflareAITranslationService } = await import('./service/cloudflare');
    service = new CloudflareAITranslationService(effectiveStyle, translationMode) as any;
  } else if (provider === 'mimo') {
    const { MimoTranslationService } = await import('./service/mimo');
    service = new MimoTranslationService(effectiveStyle, translationMode) as any;
  } else if (provider === 'gemini') {
    const { GeminiTranslationService } = await import('./service/gemini');
    service = new GeminiTranslationService(model, effectiveStyle, translationMode) as any;
  } else if (provider === 'opencode') {
    const { OpencodeTranslationService } = await import('./service/opencode');
    service = new OpencodeTranslationService(effectiveStyle, translationMode) as any;
  } else {
    service = new DeepSeekTranslationService(apiKey, effectiveStyle, translationMode);
  }
  const tTrans = performance.now();
  // 并发度：opencode 限流严格（CF Worker 共享 IP 易触发 429）与 openrouter 的
  // 免费模型都串行；deepseek 放宽到 4；其余 provider 取 2。
  // 该值此前只是打印进日志、实际全并发（见 lib/translate/concurrency.ts）。
  const concurrency =
    provider === 'opencode' || provider === 'openrouter'
      ? 1
      : provider === 'deepseek'
        ? 4
        : 2;
  const siteAwareGlossary = withSiteDocumentTerms(glossary, finalUrl);
  // A single chunk already contains the complete short page; extra context would only repeat tokens.
  const pageGlossary = chunks.length > 1
    ? withWebQualityContext(siteAwareGlossary, title, blocks, qualityMode)
    : siteAwareGlossary;

  const diagnostics: TranslationDiagnostics = { provider, totalChunks: chunks.length, failures: [] };
  const translations = await translateChunksWithRetry(
    service,
    chunks,
    sourceLang,
    targetLang,
    pageGlossary,
    concurrency,
    provider,
    effectiveStyle,
    skipCache,
    translationMode,
    diagnostics,
    resolveTranslationModelIdentity(provider, model),
  );

  // 回填：一次性 querySelectorAll 建 Map → O(1) 查找（原实现 O(blocks × N)）
  const tApply = performance.now();
  const { applyBlockTranslation, applyInlineTranslation } = await import('./translationDisplay');
  const blockMap = new Map<string, Element>();
  doc.querySelectorAll('[data-fanyi-block-id]').forEach((el) => {
    const id = el.getAttribute('data-fanyi-block-id');
    if (id) blockMap.set(id, el);
  });
  for (const block of blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const el = blockMap.get(block.id);
    // linkedom 的节点 instanceof jsdom.Element = false，统一用 nodeType 判别；
    // 这里任何 data-fanyi-block-id 节点都是 grabNode 出来的 Element，可信。
    if (el && (el as Node).nodeType === 1) {
      const htmlEl = el as unknown as HTMLElement;
      // Render 阶段最终决定：candidate + 译文也要短
      const shouldInline =
        block.renderHint?.inlineCandidate === true &&
        translated.length <= 40 &&               // 译文不超过 40 字符
        translated.split(/\s+/).length <= 12;    // 译文不超过 12 词
      if (shouldInline) {
        applyInlineTranslation(htmlEl, translated, mode);
      } else {
        applyBlockTranslation(htmlEl, translated, mode);
      }
    }
  }
  const tApplyEnd = performance.now();

  const tSer = performance.now();

  // 用 <base> 标签让浏览器原生解析相对 URL，避免手动遍历 DOM
  const cleanUrl = finalUrl.split('?')[0].split('#')[0];
  let baseUrl: string;
  if (cleanUrl.endsWith('/')) {
    baseUrl = cleanUrl;
  } else if (/\.[a-zA-Z0-9]{1,10}$/.test(cleanUrl)) {
    baseUrl = new URL('.', cleanUrl).href;
  } else {
    baseUrl = cleanUrl + '/';
  }
  // 用 <base> 标签让浏览器原生解析相对 URL，避免手动遍历 DOM。
  // 注意：<base> 必须位于所有相对 URL 引用之前（如 <link rel="stylesheet">、<script src="/...">），
  // 否则浏览器会用当前页面地址解析这些资源。arxiv / ar5iv 等站点的原页面常把 <base>
  // 放在 <head> 末尾，翻译后会导致 CSS/JS 404，因此更新 href 后必须把它移到最前面。
  const head = doc.head;
  const existingBase = doc.querySelector('head > base');
  if (existingBase) {
    existingBase.setAttribute('href', baseUrl);
    if (head && head.firstChild !== existingBase) {
      head.insertBefore(existingBase, head.firstChild);
    }
  } else {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    if (head) head.insertBefore(base, head.firstChild);
  }

  // 注入双语显示 CSS —— 只针对我们注入的 span，不覆盖原页面任何已有元素的样式。
  if (head && !head.querySelector('#fanyi-bilingual-styles')) {
    const style = doc.createElement('style');
    style.id = 'fanyi-bilingual-styles';
    style.textContent = [
      '/* 双语对照样式 —— 仅作用于翻译注入的 span，不覆盖原页面 */',
      '.fanyi-original { /* 原样保留，不动 */ }',
      '.fanyi-translation {',
      '  display: block;',
      '  margin: 0.2em 0 0.4em 0;',
      // 说明：早期版本使用 `border-left: 3px solid currentColor` 作为视觉分隔，
      // 但 currentColor 在绝大多数页面解析为黑色，导致中文译文段前出现明显的竖黑条，
      // 视觉上像原文被"涂改"。移除该 border，保留 padding 维持缩进感。
      '}',
      '.fanyi-inline-original { /* 原文：继承原页面样式，不额外设颜色 */ }',
      '.fanyi-inline-translation {',
      '  opacity: 0.75;',
      '  font-size: 0.9em;',
      '  margin-left: 0.3em;',
      '  white-space: normal;',
      '}',
      '.fanyi-translated { /* 容器：仅加 class，不改原样式 */ }',
      '',
      '/* 低优先级元素视觉弱化（footer/nav/aside/广告/社交等） */',
      '[data-fanyi-low-priority="true"] {',
      '  opacity: 0.35;',
      '  filter: grayscale(60%);',
      '  transition: opacity 0.2s ease, filter 0.2s ease;',
      '}',
      '[data-fanyi-low-priority="true"]:hover {',
      '  opacity: 1;',
      '  filter: none;',
      '}',
      '',
      '/* 弹窗 / Cookie Banner / Overlay 直接隐藏 */',
      '[data-fanyi-remove="true"] {',
      '  display: none !important;',
      '  visibility: hidden !important;',
      '  pointer-events: none !important;',
      '}',
      '',
      '/* 动态注入的通知/订阅弹窗兜底隐藏（InfoWorld 等站点的 subscribers notification prompt） */',
      '[class*="notification"], [id*="notification"],',
      '[class*="subscribers"], [id*="subscribers"],',
      '[class*="push-notification"], [id*="push-notification"] {',
      '  display: none !important;',
      '}',
    ].join('\n');
    head.appendChild(style);
  }

  // 防御：剥离正文根祖先上的 data-fanyi-remove（见 stripRemoveMarkersFromAncestors）。
  // 否则对外输出的 HTML 自带 [data-fanyi-remove]{display:none} CSS，会隐藏整页容器 → 白屏。
  stripRemoveMarkersFromAncestors(doc);

  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;

  const logDuration = performance.now() - tPrep;
  function us(v: number): string { return `${Math.round(v * 1000)}µs`; }
  console.log(`[PERF] total ${us(logDuration)} prep=${us(tTrans - tPrep)} trans=${us(tApply - tTrans)} apply=${us(tApplyEnd - tApply)} ser=${us(performance.now() - tSer)}`);

  return {
    title,
    html,
    blocks: blocks.length,
    translatedBlocks: translations.size,
    chunks: chunks.length,
    failureDetail: translations.size === 0 ? summarizeTranslationFailures(diagnostics) : undefined,
  };
}

export async function translateUrl(input: TranslateUrlInput): Promise<TranslateUrlResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';
  const mode = input.mode || 'bilingual';

  const page = await fetchPage(input.url, {
    // 生产路径不传 ssrfGuard，走默认 assertPublicUrl
    ...(input.ssrfGuard ? { ssrfGuard: input.ssrfGuard } : {}),
  });

  const redirectTrace = page.redirectChain.map((value) => {
    try {
      const parsed = new URL(value);
      return parsed.origin + parsed.pathname;
    } catch {
      return '(invalid URL)';
    }
  }).join(' -> ');
  // Log redirects before validation so rejected parking/challenge pages remain diagnosable.
  console.log(
    `[Pipeline] Fetched ${safeLogUrl(input.url)} → ${page.finalUrl} (${page.status}, ${page.html.length} bytes); redirects=${redirectTrace}`,
  );

  // Redirects are valid, but registrar parking pages are not article content.
  // Reject them before invoking the model or allowing the result into D1.
  assertNotDomainParkingPage(page.doc, input.url, page.finalUrl);

  const result = await runTranslationPipeline(
    page.doc,
    page.finalUrl,
    sourceLang,
    targetLang,
    mode,
    input.provider || 'deepseek',
    input.model,
    input.glossary,
    undefined,
    undefined,
    undefined,
    input.promptStyle,
    input.skipCache ?? false,
    input.translationMode,
    input.qualityMode ?? 'fast',
  );

  return {
    url: input.url,
    finalUrl: page.finalUrl,
    title: result.title,
    html: result.html,
    blocks: result.blocks,
    translatedBlocks: result.translatedBlocks,
    failureDetail: result.failureDetail,
    chunks: result.chunks,
    duration_ms: Date.now() - start,
  };
}

export async function translateHtml(input: TranslateHtmlInput): Promise<TranslateUrlResult> {
  const start = Date.now();
  const sourceLang = input.source || 'auto';
  const targetLang = input.target || 'zh';
  const mode = input.mode || 'bilingual';

  // Fast path: recognize the common parking template before downloading any external CSS.
  // Parse only suspicious HTML to produce the same diagnostic as the post-inline guard.
  if (looksLikeDomainParkingHtml(input.html)) {
    const { document: suspiciousDoc } = parseHTML(input.html) as unknown as { document: Document };
    assertNotDomainParkingPage(suspiciousDoc, input.url, input.url);
  }

  // 扩展传来的 HTML 里，样式表仍然是外链且多为内容哈希文件名（/assets/app-XXXX.css）。
  // 存进 D1 后原站一发版就 404，页面布局类全部失效。这里和 translateUrl 一样
  // 先内联再解析，让入库的 HTML 自包含。
  const selfContainedHtml = await inlineExternalStylesheets(input.html, { baseUrl: input.url });

  // 用 linkedom 解析扩展传来的 HTML
  const { document: doc } = parseHTML(selfContainedHtml) as unknown as { document: Document };

  // The browser may itself have landed on a parking page before submitting HTML.
  // Apply the same guard as the server-fetch route; do not translate or cache the page.
  assertNotDomainParkingPage(doc, input.url, input.url);

  // 设置 baseURI，让相对 URL 能正确解析
  try {
    if (doc.documentElement) {
      (doc.documentElement as unknown as { baseURI?: string }).baseURI = input.url;
    }
  } catch {
    /* ignore */
  }

  // 检测扩展端是否已在 HTML 中标记了 data-fanyi-block-id
  // 如果标记了，说明扩展端已在浏览器中执行过 walker，服务端无需重新 walk
  const hasMarkedBlocks = doc.querySelector('[data-fanyi-block-id]') !== null;
  let preExtractedBlocks: TextBlock[] | undefined;

  if (hasMarkedBlocks) {
    const reconciled = input.blocks
      ? extractBlocksFromMarkedHtml(doc, input.blocks)
      : extractBlocksFromMarkedHtml(doc);
    preExtractedBlocks = reconciled ?? extractBlocksFromMarkedHtml(doc);
    if (input.blocks && !reconciled) {
      console.warn(`[Pipeline] Client block snapshot did not match marked HTML; falling back to DOM text: ${input.url}`);
    }
    console.log(`[Pipeline] Received pre-marked HTML from extension: ${input.url} (${input.html.length} bytes, ${preExtractedBlocks.length} blocks, clientText=${Boolean(reconciled)})`);
  } else {
    console.log(`[Pipeline] Received HTML from extension: ${input.url} (${input.html.length} bytes, no pre-marked blocks)`);
  }

  const result = await runTranslationPipeline(
    doc,
    input.url,
    sourceLang,
    targetLang,
    mode,
    input.provider || 'deepseek',
    input.model,
    input.glossary,
    preExtractedBlocks,
    undefined,
    input.apiKey,
    input.promptStyle,
    input.skipCache ?? false,
    input.translationMode,
    input.qualityMode ?? 'fast',
  );

  return {
    url: input.url,
    finalUrl: input.url,
    title: result.title,
    html: result.html,
    blocks: result.blocks,
    translatedBlocks: result.translatedBlocks,
    failureDetail: result.failureDetail,
    chunks: result.chunks,
    duration_ms: Date.now() - start,
  };
}
