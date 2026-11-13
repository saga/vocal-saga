/**
 * OpenCode 翻译服务：使用 opencode.ai/zen OpenAI 兼容 API。
 *
 * 端点：https://opencode.ai/zen/v1/chat/completions
 * 鉴权：Authorization: Bearer <API_KEY>
 * 模型：big-pickle（默认）
 *
 * 与 DeepSeek 服务结构一致（同为 OpenAI 兼容），
 * 但不发送 DeepSeek 专有的 thinking / user_id 字段。
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { getOpencodeApiKey } from '../../config';
import {
  buildTranslationBody,
  stripThinkingTags,
  stripMarkdownCodeBlock,
  repairJson,
  type PromptStyle,
  type TranslationMode,
} from './shared';

const API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const DEFAULT_MODEL = 'big-pickle';

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getOpencodeApiKey()}`,
    // 添加 User-Agent，避免某些 Provider 对 undici/无 UA 请求限流更严格
    'User-Agent': 'vocal-saga/1.0',
  };
}

function buildOpencodeBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  style?: PromptStyle,
  translationMode: TranslationMode = 'technical',
) {
  const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, DEFAULT_MODEL, style, translationMode);
  return {
    ...body,
    response_format: { type: 'json_object' },
    stream: false,
  };
}

async function callApi(body: string): Promise<string> {
  const key = getOpencodeApiKey();
  if (!key) throw new Error('OpenCode API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('OpenCode API timeout (60s)');
    }
    throw err;
  }

  console.log('[OpenCode] Response status:', response.status);

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error('OpenCode API timeout (60000ms)');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // 429 限流诊断：打印完整响应体 + 限流相关 headers
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 'N/A';
      const rateLimitLimit = response.headers.get('x-ratelimit-limit') || 'N/A';
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining') || 'N/A';
      const rateLimitReset = response.headers.get('x-ratelimit-reset') || 'N/A';
      console.warn('[OpenCode] 429 Rate Limit');
      console.error(`[OpenCode] Headers: retry-after=${retryAfter} limit=${rateLimitLimit} remaining=${rateLimitRemaining} reset=${rateLimitReset}`);
    }
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson.error) {
        errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
      } else if (errorJson.message) {
        errorMessage += ` - ${errorJson.message}`;
      } else {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }
    } catch {
      errorMessage += ` - ${responseText.substring(0, 200)}`;
    }
    throw new Error(`OpenCode API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('OpenCode returned invalid response: missing choices[0].message.content');
  }

  // 清洗 LLM 输出：去 thinking 标签 → 去 markdown 代码块 → 修 JSON
  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    cleaned = repairJson(cleaned);
    JSON.parse(cleaned);
    return cleaned;
  }
}

export class OpencodeTranslationService implements TranslationService {
  /** 翻译文风，默认 undefined 表示使用通用直译风格 */
  private style?: PromptStyle;
  private translationMode: TranslationMode;

  constructor(style?: PromptStyle, translationMode: TranslationMode = 'technical') {
    this.style = style;
    this.translationMode = translationMode;
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);
    const body = buildOpencodeBody(blocks, sourceLang, targetLang, glossary, this.style, this.translationMode);
    return callApi(JSON.stringify(body));
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const body: any = buildOpencodeBody(blocks, sourceLang, targetLang, glossary, this.style, this.translationMode);
    body.stream = true;

    const key = getOpencodeApiKey();
    if (!key) throw new Error('OpenCode API key not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('OpenCode stream timeout (60s)');
      }
      throw err;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      clearTimeout(timeout);
      throw new Error(`OpenCode API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      clearTimeout(timeout);
      throw new Error('OpenCode API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    try {
      for await (const delta of parseSSEStream(reader)) {
        fullContent += delta;
        yield fullContent;
      }
    } catch (err) {
      if (controller.signal.aborted) throw new Error('OpenCode stream timeout (60s)');
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    return fullContent;
  }
}
