/**
 * TranslationBrief 的数据契约：版本号、尺寸上限与结构定义。
 *
 * 从 translationBrief 抽出：契约被构造端（temporal memory / source context）与消费端
 * （translationAgent、两个 Reviewer、轨迹面板）同时依赖，单独成模块后不需要为了一个类型
 * 去导入整条构造链。
 */

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v10-bounded-examples';
// 历史示例是文风证据，不是章节逐字记录。
export const MAX_ACCEPTED_EXAMPLES = 8;
export const MAX_ACCEPTED_EXAMPLE_CHARS = 4_000;
// 序列化安全上限的绝对天花板。
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
  /** 本次 run 级波次快照里合并的、按源文顺序排列的上下文增量条数。 */
  contextDeltaCount: number;
  sourceSegmentIds: string[];
  chapterPath: string;
  glossary: unknown;
  precedingSegments: Array<{ id: string; text: string; contextPath: string }>;
  contextGraph: Record<string, any> | null;
  voiceContext: Record<string, any>;
  /** 供轨迹与审计日志用的检索、时间边界与预算裁剪计数器。 */
  contextDiagnostics: Record<string, unknown>;
  contextChars: number;
  contextHash: string;
}
