/**
 * 文学分析与审校的对外出口。
 *
 * 实现在同目录的五个模块里：模型契约（literarySchemas）、共用纯函数（literaryShared）、
 * 单章分析（literaryAnalysis）、画像稳定化（literaryVoiceStabilize）、
 * Prompt 装配（literaryPrompts）与审校执行（literaryReviewRun）。
 * 这里只保留出口与内置 Prompt 预览，引用方无需感知拆分。
 */
import { buildLiteraryReviewPrompt } from './literaryPrompts.ts';
import { DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT, DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE } from './literarySchemas.ts';

export {
  DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT,
  DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE,
  LITERARY_ANALYSIS_SCHEMA,
  LITERARY_REVIEW_SCHEMA,
} from './literarySchemas.ts';
export {
  isChineseLiteraryFindingGrounded,
  isLiteraryReviewFindingGrounded,
  validateSegments,
} from './literaryShared.ts';
export { stabilizeVoiceAnalysis } from './literaryVoiceStabilize.ts';
export { runLiteraryAnalysis } from './literaryAnalysis.ts';
export {
  buildChineseLiteraryEditingPrompt,
  buildChineseTargetOnlyVoiceContext,
  buildLiteraryReviewPrompt,
} from './literaryPrompts.ts';
export { runLiteraryReview } from './literaryReviewRun.ts';

/** Actual built-in reviewer/analysis prompts used by the service; exposed read-only for the extension UI. */
/**
 * 生成内置审校/分析 Prompt 的只读预览，供扩展 UI 展示。
 * 使用占位符片段构造示例 Prompt，不执行模型调用。
 * @returns 系统 Prompt 与用户 Prompt 模板预览。
 */
export function getDefaultLiteraryTaskPromptPreviews(): {
  systemPrompts: { literaryAnalysis: string; accuracyReview: string; styleReview: string };
  userPromptTemplates: { literaryAnalysis: string; accuracyReview: string; styleReview: string };
} {
  const previewSegment = [{
    id: '{{SEGMENT_ID}}',
    source: '{{SOURCE_TEXT}}',
    draft: '{{DRAFT_TRANSLATION}}',
    contextPath: '{{CHAPTER_PATH}}',
  }];
  const common = {
    body: { target: '{{TARGET_LANGUAGE}}', chapterTitle: '{{CHAPTER_TITLE}}', glossary: '{{GLOSSARY_JSON}}' },
    segments: previewSegment,
    translationBrief: null,
    precedingSegments: [{ id: '{{PREVIOUS_SEGMENT_ID}}', text: '{{PREVIOUS_SOURCE_TEXT}}', contextPath: '{{PREVIOUS_CHAPTER_PATH}}' }],
    voiceContext: { templatePlaceholder: '{{VOICE_CONTEXT_JSON}}' },
    contextGraph: { templatePlaceholder: '{{CONTEXT_GRAPH_JSON}}' },
  };
  const accuracy = buildLiteraryReviewPrompt({ ...common, reviewFocus: 'accuracy' });
  const style = buildLiteraryReviewPrompt({ ...common, reviewFocus: 'style' });
  return {
    systemPrompts: {
      literaryAnalysis: DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT,
      accuracyReview: accuracy.systemPrompt,
      styleReview: style.systemPrompt,
    },
    userPromptTemplates: {
      literaryAnalysis: DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE,
      accuracyReview: accuracy.prompt,
      styleReview: style.prompt,
    },
  };
}
