/**
 * 审校策略：哪些片段值得送审、弱档的确定性检查、以及候选的采纳资格。
 *
 * 从 translationAgent 抽出：全是纯判定逻辑，输入片段与模型返回，输出候选或 finding，
 * 不写库也不发请求。
 */
import { terminologyFindings } from './qualityNames.ts';
import { numericFindings } from './qualityNumeric.ts';
import { englishResidueFindings } from './qualityResidueFindings.ts';
import { type TranslationItem } from './translationSchema.ts';
/**
 * 仅接受带有对应、已验证 style finding 的完整修订；中文单语编辑延后到后续双语审校处理。
 */
export function selectVerifiedStyleReviewCandidates(
  styleReview: Record<string, any>,
  currentTranslations: Map<string, string>,
  allowedSegmentIds: readonly string[],
): Array<{ segmentId: string; text: string }> {
  if (styleReview.editorialMode === 'chinese-monolingual') return [];
  const allowed = new Set(allowedSegmentIds);
  const findings = Array.isArray(styleReview.findings) ? styleReview.findings : [];
  return Object.entries(styleReview.translations || {}).flatMap(([segmentId, edited]) => {
    const draft = currentTranslations.get(segmentId);
    if (!allowed.has(segmentId) || typeof edited !== 'string' || !edited.trim() || edited === draft) return [];
    const grounded = findings.some((finding: any) =>
      finding?.id === segmentId && finding.category === 'style' && finding.proposedTranslation === edited);
    return grounded ? [{ segmentId, text: edited }] : [];
  });
}

/**
 * 中文单语编辑在双语审校明确覆盖并返回完整译文后才可写入候选；未覆盖则恢复初译。
 */
export function resolveBilingualVerifiedChineseEdits(
  initialDrafts: Map<string, string>,
  chineseEditorialEdits: Map<string, string>,
  bilingualReview: Record<string, any>,
): {
  candidates: Array<{ segmentId: string; text: string }>;
  verified: Array<{ segmentId: string; text: string }>;
  fallbacks: Array<{ segmentId: string; text: string }>;
} {
  const reviewed = new Set(Array.isArray(bilingualReview.reviewedIds) ? bilingualReview.reviewedIds : []);
  const missing = new Set(Array.isArray(bilingualReview.missingIds) ? bilingualReview.missingIds : []);
  const translations = bilingualReview.translations && typeof bilingualReview.translations === 'object'
    ? bilingualReview.translations : {};
  const candidates: Array<{ segmentId: string; text: string }> = [];
  const verified: Array<{ segmentId: string; text: string }> = [];
  const fallbacks: Array<{ segmentId: string; text: string }> = [];
  for (const [segmentId, edited] of chineseEditorialEdits) {
    const initial = initialDrafts.get(segmentId);
    const reviewedText = translations[segmentId];
    if (initial === undefined) continue;
    if (reviewed.has(segmentId) && !missing.has(segmentId) &&
        typeof reviewedText === 'string' && reviewedText.trim()) {
      verified.push({ segmentId, text: reviewedText });
      if (reviewedText !== initial) candidates.push({ segmentId, text: reviewedText });
    } else {
      fallbacks.push({ segmentId, text: initial });
    }
  }
  return { candidates, verified, fallbacks };
}

/**
 * 模型审校覆盖范围。文学文本不能按字符长度、标点或大写字母猜测价值：
 * 短句、对白、留白和章节题记可能承载关键语气与节奏；medium/strong 都覆盖全部有效译文。
 */
export function selectModelReviewTargets<T>(items: T[], reviewStrength: string): T[] {
  return reviewStrength === 'medium' || reviewStrength === 'strong' ? items : [];
}

/**
 * 「弱」档审校：不调用模型，只跑全书质量审计已经在用的确定性检查。
 * 输出仍然只是 finding 提示：数字与英文残留一律 optional，只有对照已确认规范译名的漂移
 * 保留 must_fix——这是既有策略，不因审校强度而下调。
 */
export function buildDeterministicBatchReview(input: {
  items: TranslationItem[];
  translations: Map<string, string>;
  memory: Record<string, any> | null;
  sourceLang: string;
  targetLang: string;
}): Array<{ segmentId: string; finding: Record<string, any> }> {
  const scoped = input.items
    .filter((item) => (input.translations.get(item.id) || '').trim().length > 0)
    .map((item) => ({ id: item.id, text: item.text, contextPath: item.contextPath || '' }));
  if (!scoped.length) return [];
  const drafts = new Map(scoped.map((item) => [item.id, input.translations.get(item.id) || '']));
  const raw = [
    ...numericFindings(scoped, drafts, input.sourceLang),
    ...terminologyFindings(scoped, drafts, input.memory || {}),
    ...englishResidueFindings(scoped, drafts, input.targetLang, input.sourceLang),
  ];
  const seen = new Set<string>();
  const findings: Array<{ segmentId: string; finding: Record<string, any> }> = [];
  for (const item of raw) {
    const segmentId = Array.isArray(item?.segmentIds) ? String(item.segmentIds[0] || '') : '';
    if (!segmentId || !drafts.has(segmentId)) continue;
    const key = segmentId + ':' + String(item.type || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const isTerminology = item.category === 'terminology';
    findings.push({
      segmentId,
      finding: {
        id: segmentId,
        category: isTerminology ? 'terminology' : 'style',
        priority: isTerminology ? 'must_fix' : 'optional',
        dimension: 'deterministic_check',
        detector: item.type,
        confidence: item.confidence || 'heuristic',
        reviewStrength: 'weak',
        reason: String(item.explanation || ''),
        suggestion: '',
      },
    });
  }
  return findings.slice(0, 200);
}
