/**
 * Bounded EPUB/PDF translation Agent —— 对外入口。
 *
 * This deliberately follows the agentic-data-architect boundary:
 * - the model proposes translations/reviews;
 * - the host owns workflow state, persistence, retries, identity checks and gates;
 * - candidates are accepted only through the Store's validated transaction, which protects newer manual edits and source hashes;
 * - all long-running progress is persisted as project events, not only sent over HTTP.
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
