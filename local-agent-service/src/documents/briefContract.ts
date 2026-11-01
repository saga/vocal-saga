/**
 * TranslationBrief 的数据契约：版本号、尺寸上限与结构定义。
 *
 * 从 translationBrief 抽出：契约被构造端（temporal memory / source context）与消费端
 * （translationAgent、两个 Reviewer、轨迹面板）同时依赖，单独成模块后不需要为了一个类型
 * 去导入整条构造链。
 */

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v10-bounded-examples';
// Historical examples are style evidence, not a chapter transcript.
export const MAX_ACCEPTED_EXAMPLES = 8;
export const MAX_ACCEPTED_EXAMPLE_CHARS = 4_000;
// Absolute serialization safety ceiling.
export const MAX_TRANSLATION_BRIEF_CHARS = 1_000_000;

export interface BriefSegment {
  id: string;
  text: string;
  contextPath?: string;
  kind?: string;
  page?: number | null;
  level?: number | null;
  marker?: string | null;
}

export interface TranslationBrief {
  version: 1;
  policyVersion: string;
  sourceRevisionId: string;
  promptRevisionId: string;
  memoryRevisionId: string | null;
  /** Count of source-ordered context deltas merged for this run-local wave snapshot. */
  contextDeltaCount: number;
  sourceSegmentIds: string[];
  chapterPath: string;
  glossary: unknown;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  contextGraph: Record<string, any> | null;
  voiceContext: Record<string, any>;
  /** Retrieval, temporal-boundary and budget-trimming counters for the trajectory/audit log. */
  contextDiagnostics: Record<string, unknown>;
  contextChars: number;
  contextHash: string;
}
