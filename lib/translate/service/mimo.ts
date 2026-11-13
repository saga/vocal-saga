/**
 * MiMo 翻译服务：使用 MiMo Auto 免费 API。
 *
 * 两步认证：
 *   1. Bootstrap 获取 JWT（有效期约 1 小时）
 *   2. 使用 JWT 调用 OpenAI 兼容的 Chat API
 *
 * 参考：https://www.appinn.com/mimo-auto-free-api-guide-extract-from-mimo-code/
 */
import type { TranslationService, Glossary } from './_service';
import { parseSSEStream } from './streamParser';
import { getMimoClientId } from '../../config';
import {
  buildSystemContent,
  estimateMaxTokens,
  stripThinkingTags,
  stripMarkdownCodeBlock,
  cleanJsonString,
  repairJson,
  type PromptStyle,
  type TranslationMode,
} from './shared';

const BOOTSTRAP_URL = 'https://api.xiaomimimo.com/api/free-ai/bootstrap';
const CHAT_URL = 'https://api.xiaomimimo.com/api/free-ai/openai/chat';
const MODEL = 'mimo-auto';
const SOURCE_HEADER = 'mimocode-cli-free';

// JWT 缓存（module-level，Worker 实例存活期间复用）
let _cachedJwt: string | null = null;
let _cachedExp = 0;
let _bootstrapPromise: Promise<BootstrapResponse> | null = null;

// 预留 5 分钟缓冲期，避免在临界时刻使用即将过期的 token
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface BootstrapResponse {
  jwt: string;
  exp: number; // unix timestamp in ms
}

async function bootstrap(): Promise<BootstrapResponse> {
  const clientId = getMimoClientId();
  console.log('[MiMo] Bootstrapping JWT with client:', clientId);

  const response = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: clientId }),
  });

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error('MiMo API timeout (120000ms)');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`MiMo bootstrap error: HTTP ${response.status} - ${responseText.substring(0, 200)}`);
  }

  const data = JSON.parse(responseText) as BootstrapResponse;
  if (!data.jwt) {
    throw new Error(`MiMo bootstrap error: invalid response - ${responseText.substring(0, 200)}`);
  }

  // 优先使用响应中的 exp，否则从 JWT payload 中解析，最后兜底 1 小时
  let exp = data.exp;
  if (!exp) {
    try {
      const payload = JSON.parse(atob(data.jwt.split('.')[1]));
      exp = payload.exp ? payload.exp * 1000 : Date.now() + 3600_000;
    } catch {
      exp = Date.now() + 3600_000;
    }
  }

  console.log('[MiMo] JWT acquired, expires at:', new Date(exp).toISOString());
  return { jwt: data.jwt, exp };
}

async function getJwt(): Promise<string> {
  const now = Date.now();
  if (_cachedJwt && _cachedExp > now + EXPIRY_BUFFER_MS) {
    return _cachedJwt;
  }

  // Concurrent chunks in a cold Worker isolate share one bootstrap request.
  if (!_bootstrapPromise) {
    _bootstrapPromise = bootstrap().finally(() => {
      _bootstrapPromise = null;
    });
  }
  const data = await _bootstrapPromise;
  _cachedJwt = data.jwt;
  _cachedExp = data.exp;
  return _cachedJwt;
}

function buildHeaders(jwt: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    'X-Mimo-Source': SOURCE_HEADER,
  };
}

async function callApi(body: string): Promise<string> {
  const jwt = await getJwt();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // MiMo 免费 API 可能较慢，给 120s

  let response: Response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: buildHeaders(jwt),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('MiMo API timeout (120s)');
    }
    throw err;
  }

  console.log('[MiMo] Response status:', response.status);

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    // 401 可能表示 JWT 已过期，清除缓存让下次重新 bootstrap
    if (response.status === 401) {
      _cachedJwt = null;
      _cachedExp = 0;
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
    throw new Error(`MiMo API error: ${errorMessage}`);
  }

  const data = JSON.parse(responseText);
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('MiMo returned invalid response: missing choices[0].message.content');
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

/**
 * 为 MiMo 构造干净的请求体。
 * 不携带 DeepSeek 特有的字段（如 thinking、response_format、temperature），
 * 避免 MiMo 返回 403 Illegal access。
 */
function buildMimoBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary?: Glossary,
  style?: PromptStyle,
  translationMode: TranslationMode = 'technical',
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2,
  );
  const systemContent = buildSystemContent(sourceLang, targetLang, glossary, style, translationMode);
  return {
    model: MODEL,
    messages: [
      { role: 'system' as const, content: systemContent },
      { role: 'user' as const, content: `JSON:\n\n${blocksJson}` },
    ],
    max_tokens: estimateMaxTokens(blocksJson),
  };
}

export class MimoTranslationService implements TranslationService {
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
    const body = buildMimoBody(blocks, sourceLang, targetLang, glossary, this.style, this.translationMode);
    const raw = await callApi(JSON.stringify(body));
    return raw;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const body = buildMimoBody(blocks, sourceLang, targetLang, glossary, this.style);
    (body as any).stream = true;

    const jwt = await getJwt();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: buildHeaders(jwt),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('MiMo stream timeout (120s)');
      }
      throw err;
    }
    if (!response.ok) {
      if (response.status === 401) {
        _cachedJwt = null;
        _cachedExp = 0;
      }
      const text = await response.text().catch(() => '');
      clearTimeout(timeout);
      throw new Error(`MiMo API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      clearTimeout(timeout);
      throw new Error('MiMo API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    try {
      for await (const delta of parseSSEStream(reader)) {
        fullContent += delta;
        yield fullContent;
      }
    } catch (err) {
      if (controller.signal.aborted) throw new Error('MiMo stream timeout (120s)');
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    return fullContent;
  }
}
