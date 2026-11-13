import { translationCache } from './cacheManager';
import { cleanJsonString, repairJson, extractJsonContainer } from './service/shared';
import { validateBlockMapping } from './mappingValidator';

/** Normalize the response shapes commonly returned by translation models. */
function normalizeTranslationItems(parsed: unknown): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const value = parsed as Record<string, unknown>;
  if (Array.isArray(value.translations)) return value.translations;
  // Some providers ignore the requested wrapper when translating a single block.
  if (typeof value.id === 'string') return [value];
  return [];
}

export async function getCachedTranslation(cacheKey: string): Promise<Map<string, string> | null> {
  const raw = await translationCache.get<Record<string, string>>(cacheKey);
  if (!raw) {
    return null;
  }
  
  // Convert plain object back to Map for compatibility
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    map.set(key, value);
  }
  return map;
}

export async function cacheTranslation(cacheKey: string, data: Map<string, string>) {
  // Convert Map to plain object for storage compatibility
  const obj: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    obj[key] = value;
  }
  await translationCache.set(cacheKey, obj, 7 * 24 * 60 * 60 * 1000);
}

export function processTranslationResult(jsonResult: string): Map<string, string> {
  const parsed = JSON.parse(jsonResult);
  const translations = normalizeTranslationItems(parsed);
  const result = new Map<string, string>();
  for (const item of translations) {
    if (typeof item?.id !== 'string') continue;
    // 模型可能用 `text` / `translated_text` / `translation` 中的任意一个——
    // 都接受。prompt 里说的是 `translated_text`，但实际跑下来模型经常
    // 自由发挥用 `text`，硬编码 `translated_text` 会让 result Map 是空。
    const translated =
      typeof item.translated_text === 'string'
        ? item.translated_text
        : typeof item.text === 'string'
        ? item.text
        : typeof item.translation === 'string'
        ? item.translation
        : null;
    if (translated === null) continue;
    result.set(item.id, translated);
  }
  return result;
}

/**
 * Compare a raw LLM translation response against the original blocks to flag
 * cases where the model silently returned the source text unchanged — a sign
 * that the model refused, hit a content filter, or ignored instructions.
 *
 * LLM-agnostic: works for any translation service that returns the
 * {"translations":[{"id","translated_text"}]} shape. Returns the same JSON
 * string untouched so callers can pass it through to the parser.
 */
export function logUnchangedBlocks(
  rawJson: string,
  originalBlocks: Array<{ id: string; text: string }>
): string {
  try {
    const parsed = JSON.parse(rawJson);
    const translations = normalizeTranslationItems(parsed);
    if (translations.length === 0) return rawJson;

    const byId = new Map(originalBlocks.map((b) => [b.id, b.text]));
    const seenIds = new Set<string>();
    let unchanged = 0;
    let extraIds = 0;
    for (const item of translations) {
      // 同样的字段名宽松：text / translated_text / translation 都认
      const translatedText =
        typeof item.translated_text === 'string'
          ? item.translated_text
          : typeof item.text === 'string'
          ? item.text
          : typeof item.translation === 'string'
          ? item.translation
          : null;
      if (typeof item.id !== 'string') continue;
      seenIds.add(item.id);
      const original = byId.get(item.id);
      if (original === undefined) {
        extraIds++;
        continue;
      }
      if (translatedText !== null && translatedText === original) {
        unchanged++;
        console.warn(
          '[TranslateApi] Block',
          item.id,
          'came back unchanged (LLM refused / no-op)'
        );
      }
    }
    // Count input blocks that the model never produced output for.
    const inputMissing = originalBlocks.length - seenIds.size;
    const totalMissing = extraIds + inputMissing;
    const total = originalBlocks.length;
    if (total > 0 && unchanged === translations.length) {
      console.error(
        '[TranslateApi] ALL',
        translations.length,
        'translated blocks came back unchanged — prompt may be too weak or content was filtered'
      );
    } else if (totalMissing > 0) {
      console.warn(
        '[TranslateApi]',
        totalMissing,
        'blocks missing from response (input had',
        total,
        'blocks)'
      );
    } else if (unchanged > 0) {
      console.warn(
        '[TranslateApi]',
        unchanged,
        '/',
        translations.length,
        'blocks returned unchanged'
      );
    }
  } catch {
    // If the raw string isn't valid JSON the downstream parser will throw
    // with a more useful error.
  }
  return rawJson;
}

/**
 * 组合函数：一次 JSON.parse 完成 processTranslationResult + logUnchangedBlocks。
 * 避免同一 rawJson 被 parse 两次（原流程：deepseek.ts logUnchangedBlocks → pipeline.ts processTranslationResult）。
 *
 * @param jsonResult  LLM 返回的原始 JSON 字符串
 * @param originalBlocks  原始输入 blocks（可选，传了就做 unchanged 检测）
 * @returns Map<id, translatedText>
 */
export function processTranslationWithCheck(
  jsonResult: string,
  originalBlocks?: Array<{ id: string; text: string }>
): Map<string, string> {
  let parsed;
  try {
    parsed = JSON.parse(jsonResult);
  } catch {
    try {
      // 尝试清理 JSON 后再解析
      let cleaned = cleanJsonString(jsonResult);
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        // 截取最外层 JSON 容器后再修复：避免前后散文干扰 jsonrepair，
        // 显著降低 "Colon expected" 这类因模型夹带说明文字导致的修复失败。
        const container = extractJsonContainer(jsonResult);
        const cleaned = cleanJsonString(container);
        parsed = JSON.parse(repairJson(cleaned));
      } catch (e) {
        // 所有修复手段都用尽仍无法解析：不再抛错拖垮整页翻译，
        // 返回空 Map → 所有 block 计为缺失 → 触发 chunk 缺失重试/降级渲染。
        console.error(
          '[TranslateApi] Failed to parse translation JSON after all repair attempts; treating all blocks as missing:',
          (e as Error)?.message,
        );
        return new Map<string, string>();
      }
    }
  }
  const translations = normalizeTranslationItems(parsed);
  const result = new Map<string, string>();

  // 用于 unchanged 检测
  const byId = originalBlocks ? new Map(originalBlocks.map((b) => [b.id, b.text])) : null;
  const seenIds = new Set<string>();
  let unchanged = 0;
  let extraIds = 0;
  let mappingSuspect = 0;

  for (const item of translations) {
    if (typeof item?.id !== 'string') continue;
    const translated =
      typeof item.translated_text === 'string'
        ? item.translated_text
        : typeof item.text === 'string'
        ? item.text
        : typeof item.translation === 'string'
        ? item.translation
        : null;
    if (translated === null) continue;
    result.set(item.id, translated);

    // unchanged 检测
    if (byId) {
      seenIds.add(item.id);
      const original = byId.get(item.id);
      if (original === undefined) {
        extraIds++;
        continue;
      }
      if (translated === original) {
        unchanged++;
        console.warn(
          '[TranslateApi] Block',
          item.id,
          'came back unchanged (LLM refused / no-op). Original:',
          original.substring(0, 80)
        );
      }

      // 映射校验：原文/译文信息量严重不匹配 → 提示 block id 可能错配
      const verdict = validateBlockMapping(original, translated);
      if (verdict.suspect) {
        mappingSuspect++;
        console.warn(
          '[TranslateApi] Block',
          item.id,
          'suspect mapping:',
          verdict.reasons.join('; '),
          '| origChars',
          verdict.origChars,
          'transChars',
          verdict.transChars,
          '| origSent',
          verdict.origSentences,
          'transSent',
          verdict.transSentences,
          '| sourceChars=', original.length,
          '| translatedChars=', translated.length
        );
      }
    }
  }

  // 输出 unchanged 统计
  if (byId && originalBlocks) {
    const inputMissing = originalBlocks.length - seenIds.size;
    const totalMissing = extraIds + inputMissing;
    const total = originalBlocks.length;
    if (total > 0 && unchanged === translations.length) {
      console.error(
        '[TranslateApi] ALL',
        translations.length,
        'translated blocks came back unchanged — prompt may be too weak or content was filtered'
      );
    } else if (totalMissing > 0) {
      console.warn(
        '[TranslateApi]',
        totalMissing,
        'blocks missing from response (input had',
        total,
        'blocks)'
      );
    } else if (unchanged > 0) {
      console.warn(
        '[TranslateApi]',
        unchanged,
        '/',
        translations.length,
        'blocks returned unchanged'
      );
    }
    if (mappingSuspect > 0) {
      console.warn(
        '[TranslateApi]',
        mappingSuspect,
        '/',
        translations.length,
        'blocks have suspect mapping (length/sentence mismatch) — possible block-id misalignment'
      );
    }
  }

  return result;
}

export async function clearAllCache(): Promise<void> {
  await translationCache.clear();
}
