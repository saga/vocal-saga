/**
 * 重复表达审计：原文里的重复短语在译文中是否被压平成同一句，
 * 以及引号内台词在不同段落的一致性。
 *
 * 从 qualityAudit 抽出：这一类检查要读全书扫描结果（bookScan）与源文特征索引，
 * 是唯一带外部扫描依赖的审计类别。
 */

import { scanBookSegments, type BookScanSegment, type RepeatedPhraseCandidate } from './bookScan.ts';
import type { StoredSourceFeatureIndex } from './contextGraph.ts';
import {
  MAX_REPEATED_EXPRESSION_GROUPS, MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING, MAX_BULK_REPAIR_SEGMENTS,
  normalized, normalizedPhrase, stableFindingId,
} from './qualityShared.ts';

/**
 * 从来源特征索引中聚合重复文本单元候选。
 */
function repeatedPhraseCandidatesFromSourceIndex(
  segments: Array<{ id: string; text: string; contextPath: string }>,
  sourceFeatureIndex: StoredSourceFeatureIndex,
): RepeatedPhraseCandidate[] {
  const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
  const grouped = new Map<string, {
    text: string;
    normalized: string;
    unitType: 'sentence' | 'quotation';
    segmentIds: string[];
    segmentIdSet: Set<string>;
    chapterKeys: string[];
    chapterKeySet: Set<string>;
  }>();
  for (const [segmentId, features] of sourceFeatureIndex.segments) {
    const segment = sourceById.get(segmentId);
    if (!segment) continue;
    for (const unit of features.textUnits) {
      const normalizedValue = unit.normalized;
      const wordCount = normalizedValue.split(' ').filter(Boolean).length;
      if (normalizedValue.length < 12 || wordCount < 3) continue;
      const text = segment.text.slice(unit.start, unit.end).trim();
      if (!text) continue;
      const key = normalizedValue + '\u0000' + unit.unitType;
      const group = grouped.get(key) || {
        text: text.slice(0, 180),
        normalized: normalizedValue,
        unitType: unit.unitType,
        segmentIds: [],
        segmentIdSet: new Set<string>(),
        chapterKeys: [],
        chapterKeySet: new Set<string>(),
      };
      if (!group.segmentIdSet.has(segmentId)) {
        group.segmentIds.push(segmentId);
        group.segmentIdSet.add(segmentId);
      }
      const chapter = segment.contextPath || '正文';
      if (!group.chapterKeySet.has(chapter)) {
        group.chapterKeys.push(chapter);
        group.chapterKeySet.add(chapter);
      }
      grouped.set(key, group);
    }
  }
  return Array.from(grouped.values())
    .filter((group) => group.segmentIds.length > 1)
    .map((group) => ({
      text: group.text,
      normalized: group.normalized,
      unitType: group.unitType,
      count: group.segmentIds.length,
      firstSegmentId: group.segmentIds[0] || null,
      lastSegmentId: group.segmentIds[group.segmentIds.length - 1] || null,
      segmentIds: group.segmentIds.slice(0, 16),
      segmentIdsTruncated: group.segmentIds.length > 16,
      chapterKeys: group.chapterKeys.slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count || b.chapterKeys.length - a.chapterKeys.length)
    .slice(0, MAX_REPEATED_EXPRESSION_GROUPS);
}

/**
 * 提取译文中的引号跨度内容。
 */
function targetQuotationSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const patterns = [
    /“([^”]{1,3000})”/gu,
    /"([^"]{1,3000})"/gu,
    /「([^」]{1,3000})」/gu,
    /『([^』]{1,3000})』/gu,
    /‘([^’]{8,3000})’/gu,
    /'([^']{8,3000})'/gu,
  ];
  const spans: Array<{ start: number; end: number; text: string }> = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value = match[1] || '';
    const start = (match.index ?? 0) + match[0].indexOf(value);
    if (value.trim()) spans.push({ start, end: start + value.length, text: value.trim() });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * 检测重复原文表达在不同位置的译法差异。
 */
export function repeatedExpressionFindings(
  segments: Array<{ id: string; text: string; contextPath: string; ordinal?: number }>,
  translations: Map<string, string>,
  scopedIds?: Set<string>,
  sourceFeatureIndex?: StoredSourceFeatureIndex | null,
) {
  const scanSegments: BookScanSegment[] = segments.map((segment, index) => ({
    id: segment.id,
    ordinal: index,
    text: segment.text,
    kind: 'paragraph',
    contextPath: segment.contextPath,
  }));
  const fallbackScan = sourceFeatureIndex
    ? null
    : scanBookSegments(scanSegments, { maxRepeatedPhraseGroups: MAX_REPEATED_EXPRESSION_GROUPS });
  const repeatedPhrases = sourceFeatureIndex
    ? repeatedPhraseCandidatesFromSourceIndex(segments, sourceFeatureIndex)
    : fallbackScan!.repeatedPhrases;
  const sourceById = new Map(segments.map((segment) => [segment.id, segment]));
  const textUnits = sourceFeatureIndex
    ? Array.from(sourceFeatureIndex.segments.entries()).flatMap(([segmentId, features]) => {
        const segment = sourceById.get(segmentId);
        return segment ? features.textUnits.map((unit) => ({
          segmentId, ordinal: segment.ordinal ?? 0, chapterKey: segment.contextPath,
          unitType: unit.unitType, normalized: unit.normalized, start: unit.start, end: unit.end,
        })) : [];
      })
    : fallbackScan!.textUnits;
  const quoteUnitsBySegment = new Map<string, number>();
  for (const unit of textUnits) {
    if (unit.unitType === 'quotation') quoteUnitsBySegment.set(unit.segmentId, (quoteUnitsBySegment.get(unit.segmentId) || 0) + 1);
  }

  type AlignedRow = { id: string; text: string };
  type AlignmentGroup = { method: 'whole-segment' | 'quoted-span'; rows: AlignedRow[] };
  const findings: any[] = [];
  for (const phrase of repeatedPhrases) {
    const occurrenceUnits = textUnits.filter((unit) =>
      unit.unitType === phrase.unitType && unit.normalized === phrase.normalized &&
      (!scopedIds || scopedIds.has(unit.segmentId)));
    const ids = Array.from(new Set(occurrenceUnits.map((unit) => unit.segmentId)));
    if (ids.length < 2) continue;
    const groups = new Map<AlignmentGroup['method'], AlignmentGroup>();
    const unresolvedIds: string[] = [];

    for (const id of ids) {
      const source = sourceById.get(id);
      const translation = translations.get(id) || '';
      if (!source || !translation.trim()) continue;
      let alignedText = '';
      let method: AlignmentGroup['method'] | null = null;

      // Comparing full translations is valid only when the repeated sentence is the whole source
      // segment. Embedded source sentences must not inherit differences from their surrounding prose.
      if (phrase.unitType === 'sentence' && normalizedPhrase(source.text) === phrase.normalized) {
        alignedText = translation;
        method = 'whole-segment';
      } else if (phrase.unitType === 'quotation') {
        const translatedQuotes = targetQuotationSpans(translation);
        if (translatedQuotes.length === 1) {
          alignedText = translatedQuotes[0]!.text;
          method = 'quoted-span';
        } else if (translatedQuotes.length === 0 && quoteUnitsBySegment.get(id) === 1 &&
          /\b(said|asked|replied|answered|whispered|shouted|murmured|called|cried|remarked|added|insisted|told)\b/i.test(source.text) &&
          !/(?:说道|说着|说|问道|答道|低声|大喊|喊道|回答|whispered|said|asked|replied)/i.test(translation)) {
          // Some translation styles omit quotation marks while omitting source-language speaker
          // attribution entirely. Only use the entire target as the quote when that structure is clear.
          alignedText = translation;
          method = 'quoted-span';
        }
      }
      if (!method || !alignedText.trim()) {
        unresolvedIds.push(id);
        continue;
      }
      const group = groups.get(method) || { method, rows: [] };
      group.rows.push({ id, text: alignedText });
      groups.set(method, group);
    }

    for (const group of groups.values()) {
      if (group.rows.length < 2) continue;
      const variants = new Map<string, string[]>();
      for (const row of group.rows) {
        const key = normalizedPhrase(row.text);
        const variantIds = variants.get(key) || [];
        variantIds.push(row.id);
        variants.set(key, variantIds);
      }
      if (variants.size <= 1) continue;

      const alignedIds = group.rows.map((row) => row.id);
      const maxListedIds = MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING;
      const uniqueKey = phrase.normalized + ':' + group.method;
      findings.push({
        findingId: stableFindingId('repeated-expression-drift', alignedIds.slice(0, 32), uniqueKey),
        type: 'repeated-expression-drift',
        category: 'consistency',
        severity: 'warning',
        confidence: group.method === 'whole-segment' ? 'deterministic-whole-segment-match' : 'deterministic-quoted-span-match',
        repairable: alignedIds.length <= MAX_BULK_REPAIR_SEGMENTS,
        segmentIds: alignedIds.slice(0, maxListedIds),
        occurrenceCount: alignedIds.length,
        segmentIdsTruncated: alignedIds.length > maxListedIds,
        sourceExcerpt: phrase.text,
        alignmentMethod: group.method,
        alignedOccurrenceCount: group.rows.length,
        unresolvedOccurrenceCount: unresolvedIds.length,
        variants: Array.from(variants.entries()).map(([normalizedTranslation, variantIds]) => ({
          segmentIds: variantIds.slice(0, maxListedIds),
          occurrenceCount: variantIds.length,
          segmentIdsTruncated: variantIds.length > maxListedIds,
          normalizedTranslation,
          sampleTranslation: (group.rows.find((row) => variantIds.includes(row.id))?.text || '').slice(0, 320),
        })),
        explanation: group.method === 'whole-segment'
          ? '相同原文句子本身在不同位置存在不同译法；请判断差异是否由语境驱动。'
          : '相同原文引语在不同位置的对应译文引语存在差异；只比较了可定位的引语内容，没有比较周围叙述。',
      });
    }

    // Embedded, unquoted phrases cannot be aligned to target text reliably using string heuristics.
    // Keep them visible as a review task, but do not call whole-paragraph variation a proven drift.
    if (!groups.size && unresolvedIds.length >= 2) {
      findings.push({
        findingId: stableFindingId('repeated-expression-alignment-review', unresolvedIds.slice(0, 32), phrase.normalized),
        type: 'repeated-expression-alignment-review',
        category: 'consistency',
        severity: 'info',
        confidence: 'source-match-target-alignment-unavailable',
        repairable: false,
        segmentIds: unresolvedIds.slice(0, MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING),
        occurrenceCount: unresolvedIds.length,
        segmentIdsTruncated: unresolvedIds.length > MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING,
        sourceExcerpt: phrase.text,
        explanation: '原文中存在重复句子，但它嵌入了不同上下文，系统无法可靠定位对应译文片段。为避免误报，没有将完整段落译文的差异判定为重复表达漂移；建议人工复核或在未来使用经过验证的句段对齐。',
      });
    }
  }
  return findings;
}
