/**
 * Gemini 翻译服务：使用 Google @google/genai SDK。
 *
 * SDK 会自动处理认证（X-goog-api-key header）、请求格式（contents/parts）、
 * 响应解析（candidates[0].content.parts），比手动 fetch 更简洁。
 *
 * 参考：https://ai.google.dev/gemini-api/docs/api-key
 */
import { GoogleGenAI } from '@google/genai';
import type { TranslationService, Glossary } from './_service';
import { getGeminiApiKey1, getGeminiApiKey2 } from '../../config';
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

const DEFAULT_MODEL_3 = 'gemini-5.5-flash-lite';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
//const DEFAULT_MODEL = 'gemma-4-31b-it'

//GEMINI_API_KEY_2

/** 随机从两个 Gemini API Key 中选择一个，缺失时抛错 */
function getApiKey(): string {
  const key1 = getGeminiApiKey1();
  const key2 = getGeminiApiKey2();
  const candidates = [key1, key2].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error('Gemini API key not configured');
  }
  return candidates.length === 1 ? candidates[0] : candidates[Math.floor(Math.random() * candidates.length)];
}

/** 获取 Gemini 客户端实例 */
function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getApiKey() });
}

/** 清洗 LLM 输出：去 thinking 标签 → 去 markdown 代码块 → 修 JSON */
function cleanResponse(content: string): string {
  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    JSON.parse(cleaned);
  } catch {
    cleaned = cleanJsonString(cleaned);
    try {
      JSON.parse(cleaned);
    } catch {
      // LLM 输出可能因 max_tokens 被截断，尝试修复未闭合的 JSON。
      // repairJson 仍可能失败（如结构彻底损坏）——此时不抛错，
      // 返回 best-effort 字符串，交由 processTranslationWithCheck 做最终容错
      // （extractJsonContainer + 空 Map 降级），避免 gemini.translate 直接抛错
      // 拖垮整页翻译。
      try {
        cleaned = repairJson(cleaned);
      } catch (e) {
        console.error('[Gemini] repairJson failed, returning best-effort cleaned content:', (e as Error)?.message);
      }
    }
  }
  return cleaned;
}

export class GeminiTranslationService implements TranslationService {
  private model: string;
  /** 翻译文风，默认 undefined 表示使用通用直译风格 */
  private style?: PromptStyle;
  private translationMode: TranslationMode;

  constructor(model?: string, style?: PromptStyle, translationMode: TranslationMode = 'technical') {
    this.model = model || DEFAULT_MODEL;
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
    const ai = getClient();

    // 构造请求参数：contents 为用户输入，config.systemInstruction 为系统提示
    const blocksJson = JSON.stringify(
      blocks.map((b: any) => ({
        id: b.id,
        text: b.text,
        ...(b.contextPath?.trim() ? { contextPath: b.contextPath.trim() } : {}),
        ...(b.kind ? { kind: b.kind } : {}),
        ...(Number.isInteger(b.level) ? { level: b.level } : {}),
        ...(b.marker ? { marker: b.marker } : {}),
      })),
      null,
      2,
    );
    const systemContent = buildSystemContent(sourceLang, targetLang, glossary, this.style, this.translationMode);
    const userTemplate = glossary?.document_user_prompt_template?.trim();
    const userContent = userTemplate
      ? (userTemplate.includes('{{CONTENT}}')
          ? userTemplate.replaceAll('{{CONTENT}}', blocksJson)
          : userTemplate + '\n\nJSON content (IDs and structure must be preserved):\n' + blocksJson)
      : 'JSON:\n\n' + blocksJson;

    // 超时保护：60s（与其他服务一致）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response;
    try {
      response = await ai.models.generateContent({
        model: this.model,
        contents: userContent,
        config: {
          systemInstruction: systemContent,
          temperature: 0.5,
          maxOutputTokens: estimateMaxTokens(blocksJson),
          // 强制 Gemini 输出严格 JSON（而非 Markdown 包裹 / 前后散文），
          // 从源头消除 "Colon expected" 这类 malformed JSON 失败。
          // 注意：与 thinkingConfig 不能同时使用；本路径未启用 thinking，安全。
          responseMimeType: 'application/json',
          abortSignal: controller.signal,
        },
      });
    } catch (err: any) {
      clearTimeout(timeout);
      // SDK 抛出的错误可能是 GoogleGenAIError 或 ClientError
      throw new Error(`Gemini API error: ${err?.message || String(err)}`);
    }
    clearTimeout(timeout);

    // response.text 是 getter，返回所有 text parts 的拼接
    const content = response.text || '';
    if (!content) {
      throw new Error('Gemini returned empty response');
    }

    const cleaned = cleanResponse(content);

    // 简单的 unchanged 检测
    try {
      const parsed = JSON.parse(cleaned);
      const translations = parsed.translations || parsed;
      if (Array.isArray(translations)) {
        const unchanged = translations.filter(
          (t: any, i: number) => t.translated_text === blocks[i]?.text || t.text === blocks[i]?.text
        ).length;
        if (unchanged > 0 && unchanged === translations.length) {
          console.warn('[Gemini] ALL translated blocks came back unchanged');
        }
      }
    } catch {
      // parse 失败不阻塞
    }

    return cleaned;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    const blocks = JSON.parse(jsonContent);
    const ai = getClient();

    const blocksJson = JSON.stringify(
      blocks.map((b: any) => ({
        id: b.id,
        text: b.text,
        ...(b.contextPath?.trim() ? { contextPath: b.contextPath.trim() } : {}),
        ...(b.kind ? { kind: b.kind } : {}),
        ...(Number.isInteger(b.level) ? { level: b.level } : {}),
        ...(b.marker ? { marker: b.marker } : {}),
      })),
      null,
      2,
    );
    const systemContent = buildSystemContent(sourceLang, targetLang, glossary, this.style);
    const userTemplate = glossary?.document_user_prompt_template?.trim();
    const userContent = userTemplate
      ? (userTemplate.includes('{{CONTENT}}')
          ? userTemplate.replaceAll('{{CONTENT}}', blocksJson)
          : userTemplate + '\n\nJSON content (IDs and structure must be preserved):\n' + blocksJson)
      : 'JSON:\n\n' + blocksJson;

    // 超时保护：60s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let stream: AsyncIterable<{ text?: string }>;
    try {
      stream = await ai.models.generateContentStream({
        model: this.model,
        contents: userContent,
        config: {
          systemInstruction: systemContent,
          temperature: 0.1,
          maxOutputTokens: estimateMaxTokens(blocksJson),
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: controller.signal,
        },
      });
    } catch (err: any) {
      clearTimeout(timeout);
      throw new Error(`Gemini API error: ${err?.message || String(err)}`);
    }

    let fullContent = '';
    try {
      // SDK 的 stream 是 AsyncIterable，每个 chunk 有 .text getter
      for await (const chunk of stream) {
        const delta = chunk.text || '';
        if (delta) {
          fullContent += delta;
          yield fullContent;
        }
      }
    } catch (err: any) {
      throw new Error(`Gemini stream error: ${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    return fullContent;
  }
}
