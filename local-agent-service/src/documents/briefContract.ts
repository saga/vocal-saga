/**
 * TranslationBrief 的数据契约：版本号、尺寸上限与结构定义。
 *
 * 从 translationBrief 抽出：契约被构造端（temporal memory / source context）与消费端
 * （translationAgent、两个 Reviewer、轨迹面板）同时依赖，单独成模块后不需要为了一个类型
 * 去导入整条构造链。
 */

export const TRANSLATION_BRIEF_POLICY_VERSION = 'translation-brief-v12-ranked-budgeted-memory';
// 历史示例是文风证据，不是章节逐字记录。
export const MAX_ACCEPTED_EXAMPLES = 8;
/** 单个已采纳示例的字符上限；超出部分截断，保证示例总量可控。 */
export const MAX_ACCEPTED_EXAMPLE_CHARS = 4_000;
// TranslationBrief 序列化绝对上限；超过时必须先裁剪可选记忆，不能静默发送超大上下文。
export const MAX_TRANSLATION_BRIEF_CHARS = 1_000_000;

/** 组翻译简报时用的片段视图，带版式元信息以便还原结构。 */
export interface BriefSegment {
  id: string;
  text: string;
  contextPath?: string;
  kind?: string;
  page?: number | null;
  level?: number | null;
  marker?: string | null;
}

/**
 * 一次翻译批次的自包含输入：策略版本、源文版本、记忆版本与各类参考数据。
 * 它被持久化并在重放时原样复用，因此字段只增不改、不改语义。
 */
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
