/**
 * 批次切分：按字符预算分组、合并过短的尾批、按固定大小补译。
 *
 * 从 translationAgent 抽出：这些函数只看片段长度与数量，不碰 Store 与模型。
 */
import { logInfo } from '../log.ts';
import {
  type DocumentTranslationStrategy,
  normalizeDocumentTranslationStrategy,
} from './documentStrategy.ts';
import { type TranslationItem } from './translationSchema.ts';
/**
 * 将待翻译片段按策略分批，可选在章节边界强制切分，并合并过短尾批。
 * @param items 待翻译片段列表
 * @param respectChapterBoundaries 是否在章节边界强制切批
 * @param strategyInput 分批策略（可选，缺省归一化）
 * @returns 分批后的二维数组
 */
export function buildBatches(
  items: TranslationItem[],
  respectChapterBoundaries = false,
  strategyInput?: Partial<DocumentTranslationStrategy>,
): TranslationItem[][] {
  const strategy = normalizeDocumentTranslationStrategy(strategyInput);
  const batches: TranslationItem[][] = [];
  let current: TranslationItem[] = [];
  let chars = 0;
  for (const item of items) {
    const size = item.text.length + (item.contextPath?.length || 0);
    const chapterBoundary = respectChapterBoundaries && current.length > 0 &&
      (current[0]?.contextPath || '') !== (item.contextPath || '');
    if (current.length && (
      chapterBoundary ||
      current.length >= strategy.maxBatchSegments ||
      chars + size > strategy.maxBatchSourceChars
    )) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
    // An individual paragraph may exceed the aggregate budget; isolate it in its own batch.
    if (size > strategy.maxBatchSourceChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length) batches.push(current);
  return mergeShortTailBatch(batches, strategy, respectChapterBoundaries);
}

/**
 * 把过短的尾批并回前一批。
 *
 * 尾批的代价和批次大小无关：它同样要一份 15–20k 字符的 brief，同样要一次完整的审校调用。
 * 实测 run 723c0b97 把 7 段切成 6+1，那 1 段单独付了 16,689 字符 brief + 25.4 秒审校。
 * 合并只在「不越段数上限、不越 maxBatchSourceChars、章节相同」时才做。
 */
export function mergeShortTailBatch(
  batches: TranslationItem[][],
  strategy: Pick<DocumentTranslationStrategy, 'maxBatchSegments' | 'maxBatchSourceChars'>,
  respectChapterBoundaries = false,
): TranslationItem[][] {
  if (batches.length < 2) return batches;
  const last = batches[batches.length - 1];
  const previous = batches[batches.length - 2];
  const tailThreshold = Math.max(1, Math.floor(strategy.maxBatchSegments / 3));
  if (last.length > tailThreshold) return batches;
  if (previous.length + last.length > strategy.maxBatchSegments) return batches;
  if (respectChapterBoundaries &&
      (previous[0]?.contextPath || '') !== (last[0]?.contextPath || '')) return batches;
  const sizeOf = (batch: TranslationItem[]) =>
    batch.reduce((sum, item) => sum + item.text.length + (item.contextPath?.length || 0), 0);
  // maxBatchSourceChars 是硬上限，不能为了少一次调用就突破它：超过预算的批次会让
  // 单次请求的上下文失去可预期性，也会破坏现有的分批契约（有测试锁定这一点）。
  if (sizeOf(previous) + sizeOf(last) > strategy.maxBatchSourceChars) return batches;
  const merged = [...batches.slice(0, -2), [...previous, ...last]];
  logInfo('document-agent', 'batch tail merged · ' + previous.length + '+' + last.length +
    ' → ' + (previous.length + last.length) + ' 段 · batches=' + batches.length + ' → ' + merged.length +
    ' · 省下一次完整 brief 与一次审校调用');
  return merged;
}

/** Split translation items into bounded groups for callers that explicitly need chunking. 将待翻译片段按固定大小切分为有界分组。 */
export function chunkMissingTranslationItems<T>(items: readonly T[], chunkSize = 4): T[][] {
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  const groups: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) groups.push(items.slice(offset, offset + size));
  return groups;
}
