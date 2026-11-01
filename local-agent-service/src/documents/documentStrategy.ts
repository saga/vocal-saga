/**
 * 文档项目的领域类型与策略归一化。
 *
 * 从 projectStore 抽出：这些是纯数据契约与入参校验，不接触数据库，
 * 单独成文件后存储层只负责读写，类型定义可以被路由/Agent/测试直接复用。
 */
export type DocumentFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'html' | 'docx' | 'srt' | 'vtt' | 'json';

const configuredSourceLimitMb = Number.parseInt(process.env.LOCAL_AGENT_MAX_DOCUMENT_SOURCE_MB || '512', 10);
export const MAX_DOCUMENT_SOURCE_BYTES =
  (Number.isFinite(configuredSourceLimitMb) && configuredSourceLimitMb >= 20 ? configuredSourceLimitMb : 512) * 1024 * 1024;

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_acceptance' | 'partial' | 'completed' | 'failed' | 'cancelled';

export interface ProjectSegment {
  id: string;
  text: string;
  kind?: string;
  contextPath?: string;
  page?: number | null;
  level?: number;
  marker?: string;
  /** EPUB spine 的 href / 原始文档部件路径，用于重建源文版式。 */
  path?: string;
  start?: string;
  end?: string;
}

export type DocumentReviewStrength = 'strong' | 'medium' | 'weak' | 'off';

export const DOCUMENT_REVIEW_STRENGTHS: readonly DocumentReviewStrength[] = ['strong', 'medium', 'weak', 'off'];

export function normalizeDocumentReviewStrength(input: unknown): DocumentReviewStrength {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return (DOCUMENT_REVIEW_STRENGTHS as readonly string[]).includes(value)
    ? value as DocumentReviewStrength
    : DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.reviewStrength;
}

export interface DocumentTranslationStrategy {
  /** 单个模型请求允许的最大源文片段数。 */
  maxBatchSegments: number;
  /** 单个批次的源文字符上限，不含提示词与上下文开销。 */
  maxBatchSourceChars: number;
  /** 期望的初译批并发数；实际上限由提供方会话池决定。 */
  translationConcurrency: number;
  /** 期望的审校并发数；实际上限由提供方会话池决定。 */
  reviewConcurrency: number;
  /**
   * 审校强度。只有 strong 会真的占用 reviewConcurrency 个槽位。
   * - strong：文风审校 + 准确性审校，两次模型调用（历史行为）
   * - medium：一次合并审校调用，兼顾 must_fix 与文风 findings
   * - weak：不调模型，只做数字/专名/英文残留等确定性检查
   * - off：不审校
   */
  reviewStrength: DocumentReviewStrength;
  /** 用于消歧的前文片段条数，这些片段不会被重新翻译。 */
  precedingContextSegments: number;
  /** TranslationBrief 中可选历史已采纳示例的软字符预算。 */
  contextBudgetChars: number;
  /** 批次的总尝试次数，包含首次模型请求。 */
  maxModelAttempts: number;
}

export const DEFAULT_DOCUMENT_TRANSLATION_STRATEGY: DocumentTranslationStrategy = {
  maxBatchSegments: 16,
  maxBatchSourceChars: 8000,
  translationConcurrency: 4,
  reviewConcurrency: 2,
  reviewStrength: 'medium',
  precedingContextSegments: 4,
  contextBudgetChars: 18000,
  maxModelAttempts: 2,
};

/** 校验界面/接口传入的值，对手工构造的请求也保住硬上限。 */
export function normalizeDocumentTranslationStrategy(input: unknown): DocumentTranslationStrategy {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const integer = (key: keyof DocumentTranslationStrategy, fallback: number, min: number, max: number) => {
    const value = raw[key];
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
  };
  return {
    maxBatchSegments: integer('maxBatchSegments', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.maxBatchSegments, 4, 24),
    maxBatchSourceChars: integer('maxBatchSourceChars', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.maxBatchSourceChars, 2000, 12000),
    translationConcurrency: integer('translationConcurrency', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.translationConcurrency, 1, 6),
    reviewConcurrency: integer('reviewConcurrency', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.reviewConcurrency, 1, 4),
    reviewStrength: normalizeDocumentReviewStrength(raw.reviewStrength),
    precedingContextSegments: integer('precedingContextSegments', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.precedingContextSegments, 0, 6),
    contextBudgetChars: integer('contextBudgetChars', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.contextBudgetChars, 4000, 18000),
    maxModelAttempts: integer('maxModelAttempts', DEFAULT_DOCUMENT_TRANSLATION_STRATEGY.maxModelAttempts, 1, 2),
  };
}

/** 文风是提示词的一部分：随项目保存，重新生成提示词时保持同一文风。 */
const DOCUMENT_PROMPT_STYLES = ['default', 'jinyong', 'acheng', 'wangxiaobo', 'ja-source-natural'] as const;

export function normalizePromptStyle(input: unknown): string {
  const value = String(input ?? '').trim();
  return (DOCUMENT_PROMPT_STYLES as readonly string[]).includes(value) ? value : 'default';
}

export interface ProjectPrompt {
  name?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
  sourceLang?: string;
  targetLang?: string;
  /** 生成 systemPrompt 时使用的文风；随项目保存，打开项目时按它重建提示词。 */
  promptStyle?: string;
  provider?: string;
  model?: string;
  translationMode?: 'technical' | 'literary';
  literaryReview?: boolean;
  glossary?: unknown;
  translationStrategy?: Partial<DocumentTranslationStrategy>;
  /** 每个任务不可变的 CodeBuddy 推理与补充提示词设置。 */
  taskProfiles?: unknown;
  /** 已确认的书籍实体与文风记忆，作为只读 Agent 上下文传入。 */
  literaryMemory?: unknown;
}
