/**
 * 整页译文的 D1 持久化。
 *
 * 写入本身是幂等 UPSERT，但 D1 只对只读查询自动重试，写操作失败不会重试：
 * 一次 "Network connection lost." 或底层 DO 重置，译文就永久不进记录列表，
 * 用户只看到“翻译成功但 s.sunxiunan.com 没有这条记录”。
 *
 * 这里按 D1 官方建议做有界应用层重试，只重试可重试的错误类型；
 * 同时把错误消息（含 cause）显式取出来，否则 Cloudflare 日志里只剩 stack。
 */

export interface PageTranslationRow {
  url: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  html: string;
  contentHash: string;
}

export interface SavePageTranslationOptions {
  /** 额外重试次数。默认 2（最多 3 次写入）。 */
  retries?: number;
  /** 首次重试等待毫秒，之后指数退避。默认 200ms。 */
  baseDelayMs?: number;
  /** 注入 sleep，便于测试。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次失败后的回调，用于带上下文记录日志。 */
  onAttemptError?: (error: unknown, attempt: number, willRetry: boolean) => void;
}

/** D1 里表示暂时性故障的错误片段（大小写不敏感）。 */
const TRANSIENT_ERROR_PATTERNS = [
  'network connection lost',
  'object was reset',
  'object to be reset',
  'exceeded timeout',
  'db is overloaded',
  'requests queued',
  'cannot resolve d1 db',
  'replica disconnected from primary',
  'internal error in d1 db storage',
  'internal error while starting up',
];

/**
 * 判断错误是否值得重试。
 *
 * 只有 D1 明确归类为暂时性故障的错误才重试；schema 错误、类型错误、
 * UNIQUE 约束等重试也不会变好，立即失败可以少等一轮。
 * 错误消息为空时按可重试处理：底层 DO 重置就是这种形态（只有 stack，没有 message）。
 */
export function isTransientD1Error(error: unknown): boolean {
  const message = extractD1Message(error).toLowerCase();
  if (!message) return true;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/** 取错误自身的 message 与 cause.message；名字（如 "Error"）不算有效信息。 */
function extractD1Message(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  const err = error as { message?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof err.message === 'string' && err.message.trim()) parts.push(err.message.trim());
  const cause = err.cause as { message?: unknown } | undefined;
  if (cause && typeof cause.message === 'string' && cause.message.trim()) {
    parts.push(cause.message.trim());
  }
  return parts.join(' | ');
}

/** 提取错误的所有可读信息，避免日志里只剩 stack。 */
export function describeD1Error(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const err = error as { name?: unknown; message?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof err.message === 'string' && err.message.trim()) parts.push(err.message.trim());
  const cause = err.cause as { message?: unknown } | undefined;
  if (cause && typeof cause.message === 'string' && cause.message.trim()) {
    parts.push(`cause: ${cause.message.trim()}`);
  }
  if (parts.length > 0) return parts.join(' | ');
  const name = typeof err.name === 'string' ? err.name.trim() : '';
  if (name) return name;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const UPSERT_SQL = `
  INSERT INTO translations (url, title, source_lang, target_lang, html, content_hash)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(url, source_lang, target_lang, content_hash)
  DO UPDATE SET
    title = excluded.title,
    html = excluded.html,
    created_at = CURRENT_TIMESTAMP
`;

/**
 * 写入一条整页译文；失败时按暂时性错误重试，最终仍失败则抛出最后一次的错误。
 *
 * UPSERT 本身幂等，重复写入只会刷新 created_at，因此重试是安全的。
 */
export async function savePageTranslation(
  db: any,
  row: PageTranslationRow,
  options: SavePageTranslationOptions = {},
): Promise<void> {
  if (!db) return;

  const retries = Math.max(0, options.retries ?? 2);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await db
        .prepare(UPSERT_SQL)
        .bind(row.url, row.title || '', row.sourceLang, row.targetLang, row.html, row.contentHash)
        .run();
      return;
    } catch (error) {
      lastError = error;
      const transient = isTransientD1Error(error);
      const willRetry = transient && attempt < retries;
      options.onAttemptError?.(error, attempt + 1, willRetry);
      if (!willRetry) break;
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

/** 按 UTF-8 计算 HTML 字节数，用于日志和 D1 行大小预警。 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
