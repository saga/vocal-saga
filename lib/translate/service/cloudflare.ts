/**
 * Cloudflare AI 翻译服务：通过 CF REST API 调用 Workers AI。
 *
 * 使用账号级 API：`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}`
 * 需要环境变量 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN。
 */
import type { TranslationService, Glossary } from './_service';
import { buildSystemContent, stripThinkingTags, stripMarkdownCodeBlock, cleanJsonString, repairJson, estimateMaxTokens, type PromptStyle, type TranslationMode } from './shared';
import { getCfAccountId, getCfApiToken } from '../../config';

const MODEL = '@cf/moonshotai/kimi-k2.6';

export class CloudflareAITranslationService implements TranslationService {
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

    const blocksJson = JSON.stringify(
      blocks.map((b: any) => ({ id: b.id, text: b.text })),
      null,
      2
    );

    const systemContent = buildSystemContent(sourceLang, targetLang, glossary, this.style, this.translationMode);

    // CF AI 的 ai.run(model, body)：model 在第一个参数指定，body 不传 model
    const body = {
      messages: [
        { role: 'system' as const, content: systemContent },
        { role: 'user' as const, content: `JSON:\n\n${blocksJson}` },
      ],
      // 关闭思考：GLM-4.7-flash 是 reasoning 模型，思考过程会被模型放进
      // message.reasoning 字段（我们已忽略），但思考本身会拖慢全并行翻译。
      // 双重保险：参数 + prompt 末尾的强约束。
      parameters: {
        disable_thinking: true,
        reasoning_effort: 'none',
      },
    };

    // 末尾再追加禁思考约束，覆盖参数被 Workers AI 忽略的场景。
    body.messages[0].content += `

Do NOT output any reasoning, thinking, chain-of-thought, or analysis.
Return ONLY the final JSON object. No prose, no explanation, no markdown outside the JSON block.`;

    const accountId = getCfAccountId();
    const apiToken = getCfApiToken();
    if (!accountId || !apiToken) {
      throw new Error('Cloudflare AI not configured');
    }

    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

    console.log(`[CloudAI] Calling ${MODEL}, ${blocks.length} blocks`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          ...body,
          max_tokens: estimateMaxTokens(JSON.stringify(body.messages)),
        }),
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Cloudflare AI request timeout (120s)');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(
        `Cloudflare AI API error: HTTP ${response.status} - ${responseText.slice(0, 200)}`
      );
    }

    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch {
      throw new Error(`Cloudflare AI returned invalid JSON: ${responseText.slice(0, 200)}`);
    }

    console.log('[CloudAI] response parsed; top-level keys:', Object.keys(parsedResponse ?? {}).slice(0, 12));

    // Workers AI REST 返回格式：
    //   { result: { choices: [{ message: { role, content, reasoning? } }] } }
    // message.content 是真正的 LLM 输出（可能带 ```json``` 包装），
    // message.reasoning 是思考过程，忽略。
    let content: string;
    const choice = parsedResponse?.result?.choices?.[0]?.message ?? parsedResponse?.choices?.[0]?.message;
    if (typeof choice?.content === 'string') {
      content = choice.content;
    } else if (typeof parsedResponse?.result?.response === 'string') {
      content = parsedResponse.result.response;
    } else if (typeof parsedResponse?.response === 'string') {
      content = parsedResponse.response;
    } else if (typeof parsedResponse === 'string') {
      content = parsedResponse;
    } else {
      content = JSON.stringify(parsedResponse);
    }

    // 清理 thinking 标签 + markdown 代码块 + 修复 JSON
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

    // 防御：下游 processTranslationWithCheck 会做 `for (const item of translations)`，
    // 拿到非数组就直接抛 "translations is not iterable"，排查时只能看到错误
    // 信息，看不到真实 payload。这里提前验证，失败时把完整内容带上。
    let parsedForCheck: any;
    try {
      parsedForCheck = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(
        `[CloudAI] cleaned content is not valid JSON. content=${cleaned.slice(0, 1000)}`
      );
    }
    const arr = parsedForCheck?.translations;
    if (!Array.isArray(arr)) {
      console.warn('[CloudAI] response did not contain a translations array; keys:', Object.keys(parsedForCheck ?? {}).slice(0, 12));
      throw new Error('[CloudAI] response did not contain a translations array');
    }

    return cleaned;
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
  ): AsyncGenerator<string, string, unknown> {
    // CF AI 不支持流式，降级为非流式
    const result = await this.translate(jsonContent, sourceLang, targetLang, glossary);
    yield result;
    return result;
  }
}
