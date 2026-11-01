/**
 * Run 级并发预算与会话作用域。
 *
 * 从 translationAgent 抽出：翻译/审校的并发额度、会话槽位复用条件与有界 worker 池，
 * 都是与具体批次内容无关的调度机制，改动时不该牵动翻译主流程。
 */
import { positiveIntegerEnv } from '../config.ts';
/**
 * 每个 Run 的调度上限。默认六会话池下，文学 Run 最多给四个翻译 worker、
 * 两个审校；不需要审校的 Run 可以把六个槽位全用于翻译。
 * 会话池是所有重叠 Run 之上的最终全局并发闸门。
 */
export const CONFIGURED_TRANSLATION_CONCURRENCY = positiveIntegerEnv('LOCAL_AGENT_DOCUMENT_TRANSLATION_CONCURRENCY', 6);

/** 审校并发的配置上限；实际并发还会被会话池大小压住，取两者较小值。 */
export const CONFIGURED_REVIEW_CONCURRENCY = positiveIntegerEnv('LOCAL_AGENT_DOCUMENT_REVIEW_CONCURRENCY', 4);

// 翻译排空后的审校并发上限。默认不额外限制，直接吃满会话池；
// 想保留翻译期那种克制行为的机器可以调小。
export const CONFIGURED_REVIEW_DRAIN_CONCURRENCY = positiveIntegerEnv('LOCAL_AGENT_DOCUMENT_REVIEW_DRAIN_CONCURRENCY', 64);

/** 批次角色：'translation' 为翻译批次，'review' 为审校批次。 */
export type DocumentBatchRole = 'translation' | 'review';

/** Run 级并发预算：池大小、翻译/审校并发上限与是否拆分审校。 */
export interface DocumentRunConcurrencyBudget {
  poolSize: number;
  translationConcurrency: number;
  reviewConcurrency: number;
  detachReviews: boolean;
}

/** Allocate run-level workers without exceeding the actual session-pool capacity. 分配 Run 级并发预算，翻译与审校共享会话池且不超容量。 */
export function resolveDocumentRunConcurrencyBudget(
  requestedPoolSize: number,
  reviewEnabled: boolean,
  translationLimit: number,
  reviewLimit: number,
): DocumentRunConcurrencyBudget {
  const poolSize = Math.max(1, Math.floor(requestedPoolSize) || 1);
  const translationCap = Math.max(1, Math.floor(translationLimit) || 1);
  const reviewCap = Math.max(1, Math.floor(reviewLimit) || 1);
  const reviewConcurrency = reviewEnabled
    ? poolSize > 1 ? Math.min(reviewCap, poolSize - 1) : 1
    : 0;
  const translationConcurrency = poolSize > 1
    ? Math.min(translationCap, Math.max(1, poolSize - reviewConcurrency))
    : 1;
  return {
    poolSize,
    translationConcurrency,
    reviewConcurrency,
    detachReviews: poolSize > 1 && reviewEnabled,
  };
}

/** Stable for retries of one batch, distinct across batches and runs. 生成批次会话作用域，同批次重试稳定、跨批次/Run 唯一。 */
export function buildDocumentBatchSessionScope(input: {
  projectId: string;
  runId: string;
  promptRevisionId: string;
  role: DocumentBatchRole;
  batchIndex: number;
  translationMode?: string;
  memoryRevisionId?: string | null;
}): string {
  const lane = input.role === 'translation'
    ? (input.translationMode === 'literary' ? 'book' : 'technical')
    : (input.memoryRevisionId || 'no-memory');
  return 'document:' + input.projectId + ':run:' + input.runId + ':' +
    input.role + ':' + input.promptRevisionId + ':' + lane + ':b' + input.batchIndex;
}

/**
 * 以固定并发执行有限列表；worker 出错不提前拒绝，所有 worker 完成后抛出首个错误；shouldStop 可阻止新任务启动。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  if (!items.length) return;
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let cursor = 0;
  let stopAfterFailure = false;
  const worker = async (): Promise<void> => {
    while (true) {
      if (stopAfterFailure || shouldStop?.()) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await task(items[index]!, index);
      } catch (error) {
        // 让已经在飞的同批工作自然结束；但出现致命的调度/持久化错误之后，
        // 不再分配新批次。
        stopAfterFailure = true;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: limit }, () => worker()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * 可调并发闸门。
 *
 * 原来的实现把上限冻结在创建那一刻，于是「翻译排空后把空闲槽位让给审校」做不到：
 * 翻译全部结束后，审校闸门仍然是 1，3 个会话槽位空转到 run 结束。实测一次 386s 的
 * run 里有 284s（74%）是翻译做完之后在等串行审校。
 *
 * setConcurrency 只调上限、不抢占：调高时按顺序唤醒等待者，调低时不会中断在跑的任务。
 */
export interface ConcurrencyLimiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** 调整上限；返回实际生效值。 */
  setConcurrency(next: number): number;
  /** 当前上限。 */
  getConcurrency(): number;
  /** 在跑 + 排队的任务数，用于判断是否还有活干。 */
  pending(): number;
}

/**
 * 创建可动态调整上限的 FIFO 并发闸门。
 * @param concurrency 初始并发上限
 * @returns 并发闸门函数，附带 setConcurrency/getConcurrency/pending 方法
 */
export function createConcurrencyLimiter(concurrency: number): ConcurrencyLimiter {
  let limit = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];
  const limiter = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  limiter.setConcurrency = (next: number): number => {
    const value = Math.max(1, Math.floor(next) || 1);
    if (value === limit) return limit;
    limit = value;
    // 扩容后把空出来的许可直接交给排队者，否则要等下一个任务自然结束才会下沉。
    while (active < limit && waiting.length) {
      const wake = waiting.shift();
      if (!wake) break;
      active++;
      wake();
    }
    return limit;
  };
  limiter.getConcurrency = () => limit;
  limiter.pending = () => active + waiting.length;
  return limiter;
}
