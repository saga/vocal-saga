import type { TranslationService } from './_service';
import { parseSSEStream } from './streamParser';
import { getDSApiKey } from '../../config';
import { buildTranslationBody, stripThinkingTags, stripMarkdownCodeBlock, cleanJsonString, repairJson, type PromptStyle, type TranslationMode } from './shared';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const USER_ID = 'fanyi-extension';

function buildHeaders(apiKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || getDSApiKey()}`,
  };
}

function buildDeepSeekBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: any,
  style?: PromptStyle,
  translationMode: TranslationMode = 'technical',
) {
  const body = buildTranslationBody(blocks, sourceLang, targetLang, glossary, MODEL, style, translationMode);
  return {
    ...body,
    response_format: { type: 'json_object' },
    user_id: USER_ID,
    thinking: { type: 'enabled' },
    reasoning_effort: "high",
    stream: false,
  };
}

async function callApi(body: string, apiKey?: string): Promise<string> {
  const key = apiKey || getDSApiKey();
  if (!key) throw new Error('DeepSeek API key not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150_000);

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('DeepSeek API timeout (150s)');
    }
    throw err;
  }

  console.log('[DeepSeek] Response status:', response.status);

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error('DeepSeek API timeout (150000ms)');
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
    throw new Error(`DeepSeek API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('DeepSeek returned invalid response: missing choices[0].message.content');
  }

  // DeepSeek 使用 response_format: json_object，但 max_tokens 仍可能截断长输出
  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  cleaned = cleanJsonString(cleaned);
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch (parseErr: any) {
    console.error('[DeepSeek] JSON parse error:', parseErr?.message || parseErr);
    const positionMatch = parseErr?.message?.match(/position (\d+)/);
    const errorPos = positionMatch ? parseInt(positionMatch[1], 10) : 0;
    console.warn('[DeepSeek] Response JSON parse failed near position:', errorPos);
    try {
      cleaned = repairJson(cleaned);
      JSON.parse(cleaned);
      return cleaned;
    } catch (e) {
      // repair 仍失败：不再抛错，返回 best-effort 字符串，交由
      // processTranslationWithCheck 做最终容错（extractJsonContainer + 空 Map 降级），
      // 避免 provider 抛错拖垮整页翻译。
      console.error('[DeepSeek] repairJson also failed; returning best-effort cleaned content:', (e as Error)?.message);
      return cleaned;
    }
  }
}

export class DeepSeekTranslationService implements TranslationService {
  private apiKey?: string;
  /** 翻译文风，默认 undefined 表示使用通用直译风格 */
  private style?: PromptStyle;
  private translationMode: TranslationMode;

  constructor(apiKey?: string, style?: PromptStyle, translationMode: TranslationMode = 'technical') {
    this.apiKey = apiKey;
    this.style = style;
    this.translationMode = translationMode;
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: any,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);
    const body = buildDeepSeekBody(blocks, sourceLang, targetLang, glossary, this.style, this.translationMode);
    const raw = await callApi(JSON.stringify(body), this.apiKey);
    return raw;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: any,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const body = buildDeepSeekBody(blocks, sourceLang, targetLang, glossary, this.style);
    (body as any).stream = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('DeepSeek stream timeout (45s)');
      }
      throw err;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      clearTimeout(timeout);
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      clearTimeout(timeout);
      throw new Error('DeepSeek API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    try {
      for await (const delta of parseSSEStream(reader)) {
        fullContent += delta;
        yield fullContent;
      }
    } catch (err) {
      if (controller.signal.aborted) throw new Error('DeepSeek stream timeout (45s)');
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    return fullContent;
  }
}
