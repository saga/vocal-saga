/**
 * OpenRouter 翻译服务：使用 OpenRouter API 的免费模型。
 *
 * 与 DeepSeekTranslationService 共享 TranslationService 接口，
 * 但指向 OpenRouter 的 API 端点。
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { getOpenrouterApiKey } from '../../config';
import { buildTranslationBody, stripThinkingTags, stripMarkdownCodeBlock, cleanJsonString, repairJson, type PromptStyle, type TranslationMode } from './shared';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-oss-20b:free';

function buildHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getOpenrouterApiKey()}`,
    'HTTP-Referer': 'https://vocal-saga.com',
    'X-Title': 'Vocal Saga Translation',
  };
}

async function callApi(body: string): Promise<string> {
  const apiKey = getOpenrouterApiKey();
  if (!apiKey) throw new Error('OpenRouter API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

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
      throw new Error('OpenRouter API timeout (90s)');
    }
    throw err;
  }

  console.log('[OpenRouter] Response status:', response.status);

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error('OpenRouter API timeout (90000ms)');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
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
    throw new Error(`OpenRouter API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('OpenRouter returned invalid response: missing choices[0].message.content');
  }

  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    JSON.parse(cleaned);
  } catch {
    cleaned = cleanJsonString(cleaned);
    try {
      JSON.parse(cleaned);
    } catch {
      // LLM 输出可能因 max_tokens 被截断，尝试修复未闭合的 JSON
      cleaned = repairJson(cleaned);
    }
  }

  return cleaned;
}

export class OpenRouterTranslationService implements TranslationService {
  // apiKey 已通过 config 模块管理
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

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, MODEL, this.style, this.translationMode);
    const raw = await callApi(JSON.stringify({ ...body }));

    // 简单的 unchanged 检测
    try {
      const parsed = JSON.parse(raw);
      const translations = parsed.translations || parsed;
      if (Array.isArray(translations)) {
        const unchanged = translations.filter(
          (t: any, i: number) => t.translated_text === blocks[i]?.text || t.text === blocks[i]?.text
        ).length;
        if (unchanged > 0 && unchanged === translations.length) {
          console.warn('[OpenRouter] ALL translated blocks came back unchanged');
        }
      }
    } catch {
      // parse 失败不阻塞
    }

    return raw;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, undefined, this.style, this.translationMode);

    // 60s 超时
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ ...body, stream: true, reasoning: { effort: 'none' } }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('OpenRouter stream timeout (60s)');
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenRouter API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('OpenRouter API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    for await (const delta of parseSSEStream(reader)) {
      fullContent += delta;
      yield fullContent;
    }

    return fullContent;
  }
}
