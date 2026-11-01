/**
 * 文学审校执行：一次请求内完成「准备上下文 → 装 Prompt → 调 Reviewer → 校验证据 → 产出译文」。
 *
 * 从 literary 抽出：审校是本仓最贵的一次调用（占 run 时长的大头），因此输入准备、
 * 结果解析与「什么情况下才允许替换初译」这三件事必须各自可读。
 */
import { runAgentJson } from './agents/runner.ts';
import { REVIEW_TIMEOUT_MS } from './config.ts';
import { formatTurnUsageLog, summarizeTurnUsage } from './agents/usage.ts';
import { getCodeBuddyTaskProfile, resolveEffectiveTaskModel } from './agents/taskProfiles.ts';
import { parseAgentModel } from './json.ts';
import { buildProjectVoiceContext } from './documents/voiceContext.ts';
import { logInfo } from './log.ts';
import { LITERARY_REVIEW_SCHEMA, REVIEW_FOCUS_CATEGORIES } from './literarySchemas.ts';
import {
  isChineseLiteraryFindingGrounded,
  isLiteraryReviewFindingGrounded,
  validateSegments,
} from './literaryShared.ts';
import { buildChineseLiteraryEditingPrompt, buildLiteraryReviewPrompt } from './literaryPrompts.ts';

/** 审校关注点：只查准确性、只查文风，或两者合并成一次调用。 */
type ReviewFocus = 'accuracy' | 'style' | 'combined';

/** 一次审校调用组装好的输入快照，后续不再回查数据库。 */
type PreparedReview = {
  segments: Array<Record<string, any>>;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  translationBrief: Record<string, any> | null;
  voiceContext: Record<string, any>;
  contextGraph: Record<string, any> | null;
  reviewFocus: ReviewFocus;
  chineseMonolingualEdit: boolean;
};

/**
 * 执行文学审校：校验片段、准备上下文、调用 Reviewer、校验 finding 证据并生成最终译文映射。
 * 边界：片段数 1-32；候选译文长度 1-5000；无合规译文时回退初译；finding 最多 240 条。
 * @param body 请求体（含 segments、memory、reviewFocus、translationBrief 等）。
 * @param requestId 请求 ID。
 * @param sessionScope 可选会话范围。
 * @returns 审校结果（translations、reviewedIds、missingIds、findings、usage 等）。
 */
export async function runLiteraryReview(body: any, requestId: string, sessionScope?: string) {
  const prepared = prepareReviewInputs(body);
  const { segments, reviewFocus, chineseMonolingualEdit, translationBrief } = prepared;
  const { systemPrompt, prompt, contextChars } = chineseMonolingualEdit
    ? buildChineseLiteraryEditingPrompt({ body, segments, voiceContext: prepared.voiceContext })
    : buildLiteraryReviewPrompt({
        body, segments, reviewFocus, translationBrief,
        precedingSegments: prepared.precedingSegments,
        voiceContext: prepared.voiceContext,
        contextGraph: prepared.contextGraph,
      });

  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  const reviewProfile = getCodeBuddyTaskProfile(body, reviewFocus === 'style' ? 'styleReview' : 'accuracyReview');
  // 解析模型并执行审校调用（带超时保护）。
  const reviewModel = resolveEffectiveTaskModel(agent.model, reviewProfile);
  const modelRun = await runAgentJson(
    agent, prompt, systemPrompt, LITERARY_REVIEW_SCHEMA, requestId, sessionScope,
    reviewProfile,
    { timeoutMs: REVIEW_TIMEOUT_MS },
  );
  const parsed = modelRun.result;
  // 审校调用的耗时/轮次/模型必须进日志：它现在占整个 run 的 80%+，
  // 只打 token 数无法回答「为什么这一批要一分多钟」。
  if (modelRun.usage) {
    logInfo('literary-review', formatTurnUsageLog(modelRun.usage) +
      ' · sdkLastTurn=' + (modelRun.usage.lastTurnDurationMs != null ? (modelRun.usage.lastTurnDurationMs / 1000).toFixed(1) + 's' : '未计量') +
      ' · turns=' + (modelRun.usage.numTurns ?? '未计量') +
      ' · model=' + reviewModel +
      ' · request=' + requestId.slice(0, 12));
  }
  if (!Array.isArray(parsed.results)) throw new Error('Reviewer 返回格式异常；请重试，扩展端会保留初译');

  const { translations, findings } = collectReviewResults(parsed, segments, reviewFocus, chineseMonolingualEdit);
  const expectedIds = segments.map((item) => item.id);
  return {
    translations,
    ...(chineseMonolingualEdit ? { editorialMode: 'chinese-monolingual' } : {}),
    reviewedIds: expectedIds.filter((id) => typeof translations[id] === 'string'),
    missingIds: expectedIds.filter((id) => typeof translations[id] !== 'string'),
    findings: findings.slice(0, 240),
    promptChars: prompt.length,
    systemPromptChars: systemPrompt.length,
    contextChars,
    translationBriefHash: translationBrief?.contextHash || null,
    // 审校用量随结果一起回传，让调用方能写进 project_events 并计入 run 级合计。
    // 之前审校的 token 只出现在文件日志里，审计账本里查不到，run 级成本永远是残缺的。
    usage: modelRun.usage,
    usageSummary: summarizeTurnUsage(modelRun.usage),
    model: reviewModel,
  };
}

/** 前文片段只保留 id/text/contextPath 三个字段，且必须是有正文的对象。 */
function normalizePrecedingSegments(list: unknown): Array<{ id: string; text: string; contextPath: string }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: any) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
    return [{
      id: item.id.slice(0, 160),
      text: item.text,
      contextPath: typeof item.contextPath === 'string' ? item.contextPath.slice(0, 160) : '',
    }];
  });
}

/**
 * 审校输入：片段、前文、声音上下文与图谱。
 * Project 翻译会把当次不可变的 TranslationBrief 一起传进来，standalone 审校则回退到有界检索。
 */
function prepareReviewInputs(body: any): PreparedReview {
  // 校验并规范化审校片段（1-32 个，原文/译文长度受限）。
  const segments = validateSegments(body.segments, 32, 'review');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const suppliedPrecedingSegments = normalizePrecedingSegments(body.precedingSegments);
  // 项目翻译传入的，正是初译用过的那份不可变 TranslationBrief。
  // 独立审校请求则回退到有界的旧检索路径。
  const translationBrief = body.translationBrief && typeof body.translationBrief === 'object'
    ? body.translationBrief as Record<string, any>
    : null;
  const precedingSegments = Array.isArray(translationBrief?.precedingSegments)
    ? normalizePrecedingSegments(translationBrief.precedingSegments)
    : suppliedPrecedingSegments;
  const voiceContext = translationBrief?.voiceContext && typeof translationBrief.voiceContext === 'object'
    ? translationBrief.voiceContext
    : body.voiceContext && typeof body.voiceContext === 'object'
      ? body.voiceContext
      : buildProjectVoiceContext(
          memory,
          segments.map((segment) => ({ id: segment.id, text: segment.source, contextPath: segment.contextPath })),
          segments[0]?.contextPath || (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
          precedingSegments,
        );
  const contextGraph = translationBrief?.contextGraph && typeof translationBrief.contextGraph === 'object'
    ? translationBrief.contextGraph
    : null;
  const reviewFocus: ReviewFocus = body.reviewFocus === 'style'
    ? 'style'
    : body.reviewFocus === 'combined' ? 'combined' : 'accuracy';
  const chineseMonolingualEdit = body.chineseMonolingualEdit === true &&
    reviewFocus === 'style' && /^zh(?:[-_]|$)/i.test(String(body.target || 'zh'));
  return { segments, precedingSegments, translationBrief, voiceContext, contextGraph, reviewFocus, chineseMonolingualEdit };
}

/**
 * 逐片段决定最终译文。三种情况才允许替换初译：可核对的 must_fix、有据的中文单语编辑、
 * 有据的文风修订；其余一律保留初译，避免无依据改写。
 */
function collectReviewResults(
  parsed: Record<string, any>,
  segments: Array<Record<string, any>>,
  reviewFocus: ReviewFocus,
  chineseMonolingualEdit: boolean,
): { translations: Record<string, string>; findings: any[] } {
  const byId = new Map(segments.map((item) => [item.id, item]));
  const translations: Record<string, string> = {};
  const findings: any[] = [];
  for (const raw of parsed.results.slice(0, 32)) {
    if (!raw || typeof raw.id !== 'string' || !byId.has(raw.id)) continue;
    const original = byId.get(raw.id);
    // 候选译文：中文单语编辑取 editedText，其他审校取 finalTranslation；长度 1-5000 才可用。
    let candidateText = (chineseMonolingualEdit
      ? typeof raw.editedText === 'string' ? raw.editedText.trim() : ''
      : typeof raw.finalTranslation === 'string' ? raw.finalTranslation.trim() : '');
    const candidateUsable = candidateText.length > 0 && candidateText.length <= 5000;
    if (!candidateUsable) candidateText = original.draft;
    const candidateFindings = collectSegmentFindings({
      raw, original, candidateText, candidateUsable, reviewFocus, chineseMonolingualEdit,
    });
    const hasMustFixFinding = candidateFindings.some((finding) => finding.priority === 'must_fix');
    if (hasMustFixFinding) {
      for (const finding of candidateFindings) {
        if (finding.category === 'style') finding.applicationStatus = 'applied';
      }
    }
    findings.push(...candidateFindings);
    // 已通过原文/译文证据校验的 Reviewer 文风修订默认应用；机器建议不是用户确认，
    // 用户仍可在译文中事后修改。中文单语编辑同样先产出候选，随后由双语审校验证。
    const hasGroundedChineseEdit = chineseMonolingualEdit && candidateUsable &&
      candidateText !== original.draft && candidateFindings.length > 0;
    const hasGroundedStyleEdit = reviewFocus !== 'accuracy' && candidateUsable &&
      candidateText !== original.draft && candidateFindings.some((finding) => finding.category === 'style');
    // 有 must_fix 时采用候选译文；否则仅在有 grounded 文风/中文编辑时才替换，避免无依据改写。
    translations[raw.id] = hasMustFixFinding && candidateUsable
      ? candidateText
      : hasGroundedChineseEdit || hasGroundedStyleEdit ? candidateText : original.draft;
  }
  return { translations, findings };
}

/**
 * 单片段 finding 收集：类别必须属于本阶段职责，证据必须能逐字定位。
 * 没有可用候选译文时，所有 finding 降级为 optional——因为没有东西可以自动应用。
 */
function collectSegmentFindings(input: {
  raw: any;
  original: Record<string, any>;
  candidateText: string;
  candidateUsable: boolean;
  reviewFocus: ReviewFocus;
  chineseMonolingualEdit: boolean;
}): any[] {
  const { raw, original, candidateText, candidateUsable, reviewFocus, chineseMonolingualEdit } = input;
  const candidateFindings: any[] = [];
  if (!Array.isArray(raw.findings)) return candidateFindings;
  for (const item of raw.findings.slice(0, 12)) {
    // 准确性/实体错误必须修复；具体文风问题作为可选的受控修订依据。
    if (!item || !REVIEW_FOCUS_CATEGORIES[reviewFocus].includes(String(item.category))) continue;
    const sourceExcerpt = chineseMonolingualEdit ? '' :
      typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.trim().slice(0, 240) : '';
    const targetExcerpt = chineseMonolingualEdit
      ? typeof item.targetExcerpt === 'string' ? item.targetExcerpt.trim().slice(0, 240) : ''
      : '';
    const draftExcerpt = chineseMonolingualEdit ? targetExcerpt :
      typeof item.draftExcerpt === 'string' ? item.draftExcerpt.trim().slice(0, 240) : '';
    if (chineseMonolingualEdit && candidateText === original.draft) continue;
    // 单语发现只能锚定在编辑当时看到的那份确切中文草稿上。
    if (chineseMonolingualEdit
      ? !isChineseLiteraryFindingGrounded(original.draft, targetExcerpt)
      : !isLiteraryReviewFindingGrounded(original.source, original.draft, sourceExcerpt, draftExcerpt)) continue;
    const priority = item.category === 'style' ? 'optional' : 'must_fix';
    const finding = {
      id: raw.id, category: item.category, priority,
      sourceExcerpt,
      draftExcerpt,
      ...(chineseMonolingualEdit ? { targetExcerpt, editorialMode: 'chinese-monolingual' } : {}),
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 400) : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.slice(0, 400) : '',
      ...styleDimensionFields(item, chineseMonolingualEdit),
      ...(item.category === 'style' && candidateUsable ? {
        proposedTranslation: candidateText,
        applicationStatus: 'pending' as const,
      } : {}),
    };
    if (finding.reason || finding.suggestion) candidateFindings.push(finding);
  }
  if (candidateFindings.length && !candidateUsable) {
    for (const finding of candidateFindings) {
      finding.priority = 'optional';
      finding.reason = (finding.reason ? finding.reason + '；' : '') + '本机未返回长度合规的完整修正译文，因此没有自动覆盖初译';
    }
  }
  return candidateFindings;
}

/** 文风 finding 的可选维度字段；类型不符或维度不在白名单时整体不输出。 */
function styleDimensionFields(item: any, chineseMonolingualEdit: boolean): Record<string, unknown> {
  if (item.category !== 'style') return {};
  if (!chineseMonolingualEdit &&
      !['character_voice', 'register', 'narrative_style', 'pacing', 'chinese_literary_editing'].includes(item.dimension)) return {};
  return {
    dimension: chineseMonolingualEdit ? 'chinese_literary_editing' : item.dimension,
    ...(typeof item.editingAspect === 'string' &&
        ['pronoun', 'particle', 'syntax', 'translationese', 'redundancy', 'diction', 'rhythm', 'register'].includes(item.editingAspect)
      ? { editingAspect: item.editingAspect } : {}),
    ...(typeof item.characterId === 'string' ? { characterId: item.characterId.slice(0, 100) } : {}),
    ...(typeof item.relatedCharacterId === 'string' ? { relatedCharacterId: item.relatedCharacterId.slice(0, 100) } : {}),
    ...(Array.isArray(item.evidenceSegmentIds)
      ? { evidenceSegmentIds: item.evidenceSegmentIds.filter((id: unknown) => typeof id === 'string').slice(0, 8).map((id: string) => id.slice(0, 160)) }
      : {}),
  };
}
