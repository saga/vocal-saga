/**
 * Bounded EPUB/PDF translation Agent —— 对外入口。
 *
 * 这里刻意遵循 agentic-data-architect 的边界：
 * - 模型只负责提出译文与审校意见；
 * - 宿主负责工作流状态、持久化、重试、身份校验与各类闸门；
 * - 候选译文只能经由 Store 校验过的事务被采纳，那里会保护更新的手工编辑与源文哈希；
 * - 所有耗时进度都落成项目事件，而不只是走 HTTP 返回。
 *
 * 实现按职责拆在同目录的若干模块里：契约（translationSchema）、并发预算（translationConcurrency）、
 * 批次切分（translationBatchPlan）、审校策略（translationReviewPolicy）、提示与调用
 * （translationPrompt / translationBatchCall）、文学审校（translationLiteraryReview）、
 * 批次执行（translationRunBatch）与 Run 生命周期（translationRun）。
 * 本文件只保留公开出口，调用方不需要知道某件事被搬到了哪个文件。
 */
export type { DocumentBatchRole, DocumentRunConcurrencyBudget, ConcurrencyLimiter } from './translationConcurrency.ts';
export {
  resolveDocumentRunConcurrencyBudget,
  buildDocumentBatchSessionScope,
  runWithConcurrency,
  createConcurrencyLimiter,
} from './translationConcurrency.ts';

export {
  selectVerifiedStyleReviewCandidates,
  resolveBilingualVerifiedChineseEdits,
  isReviewWorthSending,
  buildDeterministicBatchReview,
} from './translationReviewPolicy.ts';

export { buildBatches, mergeShortTailBatch, chunkMissingTranslationItems } from './translationBatchPlan.ts';

export {
  buildStandaloneReviewMemory,
  buildStandaloneReviewVoiceContext,
  buildStandaloneReviewContextGraph,
} from './translationStandaloneContext.ts';

export { buildUserPrompt } from './translationPrompt.ts';

export { mergeConfirmedMemoryNameMappings, runLiteraryReviewWithMissingRetry } from './translationLiteraryReview.ts';

export type { PreparedRunExecution } from './translationRun.ts';
export {
  isContextGraphReadyForTranslationRun,
  autoAcceptFinishedRunCandidates,
  startProjectTranslationRun,
  isProjectRunActive,
} from './translationRun.ts';
