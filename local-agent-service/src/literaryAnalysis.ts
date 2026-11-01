/**
 * 单章文学分析：把一批原文片段变成书籍记忆增量（实体、关系、文风指南、人物声音）。
 *
 * 从 literary 抽出：分析侧的输入是有界的本章片段，输出全部是 suggested/candidate，
 * 不含任何人工确认语义——这一点与审校侧不同，必须分开维护。
 */
import { runAgentJson } from './agents/runner.ts';
import { formatTurnUsageLog } from './agents/usage.ts';
import { getCodeBuddyTaskProfile } from './agents/taskProfiles.ts';
import { parseAgentModel } from './json.ts';
import { logInfo } from './log.ts';
import {
  isWorthCanonicalEntityMapping,
  normalizeCanonicalEntityKind,
  splitCompoundCanonicalName,
  validateCanonicalTarget,
} from './documents/canonicalEntityPolicy.ts';
import {
  DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT,
  DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE,
  LITERARY_ANALYSIS_SCHEMA,
} from './literarySchemas.ts';
import { sanitizeProjectLiteraryMemory } from './documents/voiceContext.ts';
import { validateSegments } from './literaryShared.ts';
import { stabilizeVoiceAnalysis } from './literaryVoiceStabilize.ts';


/**
 * 为文学分析 Prompt 构建有界大小的书籍记忆上下文。
 * 对 sanitize 后的记忆做截断与优先级裁剪，确保 JSON 序列化长度不超过 24000 字符；
 * 低优先级整条记录被丢弃而非截断字符串，保证 JSON 有效。
 * @param input 原始项目文学记忆（unknown）。
 * @returns 可直接注入 Prompt 的记忆上下文对象。
 */
export function buildAnalysisMemoryContext(input: unknown): Record<string, unknown> {
  const memory = sanitizeProjectLiteraryMemory(input);
  const result: Record<string, any> = {
    version: 2,
    entities: memory.entities.slice(0, 60),
    relationships: memory.relationships.slice(0, 40),
    styleGuide: memory.styleGuide,
    chapterSummaries: memory.chapterSummaries.slice(-4),
    recentExamples: memory.recentExamples.slice(-2),
    characterVoices: memory.characterVoices.slice(0, 20).map((profile: any) => ({
      characterId: profile.characterId, canonicalSourceName: profile.canonicalSourceName,
      targetName: profile.targetName, aliases: profile.aliases, status: profile.status,
      voiceCore: profile.voiceCore, evidence: profile.evidence.slice(0, 2),
      contrastRules: profile.contrastRules.slice(0, 3),
    })),
    relationshipVoiceRules: memory.relationshipVoiceRules.filter((rule: any) => rule.status === 'confirmed').slice(0, 24),
    voiceAnchors: memory.voiceAnchors.filter((anchor: any) => anchor.status === 'approved').slice(-16),
  };
  // 要保持 JSON 合法，就整条丢掉优先级更低的记录，而不是去切序列化后的字符串。
  while (JSON.stringify(result).length > 24000 && result.characterVoices.some((profile: any) => profile.evidence.length > 1)) {
    result.characterVoices.forEach((profile: any) => { profile.evidence = profile.evidence.slice(0, 1); });
  }
  while (JSON.stringify(result).length > 24000 && result.voiceAnchors.length) result.voiceAnchors.shift();
  while (JSON.stringify(result).length > 24000 && result.relationshipVoiceRules.length) result.relationshipVoiceRules.pop();
  while (JSON.stringify(result).length > 24000 && result.characterVoices.length) result.characterVoices.pop();
  while (JSON.stringify(result).length > 24000 && result.entities.length) result.entities.pop();
  while (JSON.stringify(result).length > 24000 && result.relationships.length) result.relationships.pop();
  while (JSON.stringify(result).length > 24000 && result.chapterSummaries.length) result.chapterSummaries.shift();
  return result;
}

/**
 * 执行一章的文学分析：校验片段、构建 Prompt、调用模型、稳定化声音画像并返回记忆增量。
 * 边界：片段数 1-24；实体/关系数组缺失则抛错；summary 截断 420 字符。
 * @param body 请求体（含 segments、memory、target、chapterTitle、model 等）。
 * @param requestId 请求 ID，用于日志与模型调用。
 * @param sessionScope 可选会话范围。
 * @returns { analyzed, chapterTitle, memory }。
 */
export async function runLiteraryAnalysis(body: any, requestId: string, sessionScope?: string) {
  const chapterTitle = typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0, 160) : '未命名章节';
  // 校验并规范化本章片段（1-24 个）。
  const segments = validateSegments(body.segments, 24, 'analyze');
  const memory = body.memory && typeof body.memory === 'object' ? body.memory : {};
  const prompt = buildAnalysisPrompt(body, chapterTitle, segments, memory);
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  // 解析模型并执行 Agent JSON 调用（单次分析）。
  const modelRun = await runAgentJson(
    agent, prompt, DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT, LITERARY_ANALYSIS_SCHEMA, requestId, sessionScope,
    getCodeBuddyTaskProfile(body, 'literaryAnalysis'),
  );
  const parsed = modelRun.result;
  if (modelRun.usage) logInfo('literary-analyze', formatTurnUsageLog(modelRun.usage) + ' · request=' + requestId.slice(0, 12));
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relationships)) {
    throw new Error('本章分析结果不是预期 JSON；请重试分析');
  }
  const summary = typeof parsed.chapterSummary === 'string' ? parsed.chapterSummary.slice(0, 420) : '';
  const targetLang = String(body.target || 'zh');
  return {
    analyzed: true,
    chapterTitle,
    memory: {
      version: 2,
      entities: normalizeAnalyzedEntities(parsed.entities, targetLang),
      relationships: parsed.relationships.slice(0, 160).map((item: any) => ({ ...item, reviewStatus: 'suggested' })),
      styleGuide: parsed.styleGuide && typeof parsed.styleGuide === 'object' ? parsed.styleGuide : {},
      chapterSummaries: summary ? [{ chapter: chapterTitle, summary }] : [],
      recentExamples: [],
      ...stabilizeVoiceAnalysis(memory, parsed, segments),
    },
  };
}

/** 模板占位符单次替换：源文里出现同形文本时不会被二次解释。 */
function buildAnalysisPrompt(
  body: any,
  chapterTitle: string,
  segments: Array<Record<string, any>>,
  memory: unknown,
): string {
  const promptValues: Record<string, string> = {
    TARGET_LANGUAGE: body.target || 'zh',
    CHAPTER_TITLE: chapterTitle,
    BOOK_MEMORY_JSON: JSON.stringify(buildAnalysisMemoryContext(memory)),
    CHAPTER_SEGMENTS_JSON: JSON.stringify(segments),
  };
  // 单趟替换，避免把源文或书籍记忆里长得像占位符的文本也当成占位符。
  return DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE.replace(
    /\{\{(TARGET_LANGUAGE|CHAPTER_TITLE|BOOK_MEMORY_JSON|CHAPTER_SEGMENTS_JSON)\}\}/g,
    (_match, key: string) => promptValues[key] ?? '',
  );
}

/**
 * 实体候选过滤：复合名不允许整体当成一个实体，非人物实体必须值得建映射，
 * 译名必须通过目标语质量校验。三条都不满足就丢弃，不写进记忆。
 */
function normalizeAnalyzedEntities(rawEntities: any[], targetLang: string): any[] {
  return rawEntities.slice(0, 120).flatMap((item: any) => {
    const source = typeof item?.source === 'string' ? item.source.trim() : '';
    const target = typeof item?.target === 'string' ? item.target.trim() : '';
    if (!source || !target || splitCompoundCanonicalName(source) || splitCompoundCanonicalName(target)) return [];
    const kind = normalizeCanonicalEntityKind(item.kind);
    if (kind !== 'person' && !isWorthCanonicalEntityMapping({ source, kind, significance: item.description || item.significance, explicitBookSpecificMeaning: item.bookSpecificMeaning === true })) return [];
    if (!validateCanonicalTarget({ source, target, targetLang, kind }).valid) return [];
    return [{ ...item, kind, reviewStatus: 'suggested', confirmationSource: 'evidence-verified', targetConfidence: 'candidate', targetEvidenceRefs: [] }];
  });
}
