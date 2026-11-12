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
 * 确保目标 D1 具备当前翻译缓存 schema。
 *
 * 老版本 schema 缺少 content_hash，且使用三列 UNIQUE；仅 ADD COLUMN 无法让
 * ON CONFLICT(url, source_lang, target_lang, content_hash) 生效，因此需要重建旧表。
 * 每个 D1 实例在当前 Worker isolate 内只检查一次；主库与备用库分别检查。
 */
const schemaReady = new WeakMap<object, Promise<void>>();

const CREATE_TRANSLATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT DEFAULT '',
    source_lang TEXT DEFAULT 'en',
    target_lang TEXT DEFAULT 'zh',
    html TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(url, source_lang, target_lang, content_hash)
  ) STRICT
`;

function quoteSqlIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function ensurePageTranslationSchemaOnce(db: any): Promise<void> {
  const tableInfo = await db.prepare("PRAGMA table_info('translations')").all();
  const columns: Array<{ name: string }> = tableInfo?.results ?? [];

  if (columns.length === 0) {
    await db.prepare(CREATE_TRANSLATIONS_SQL).run();
    return;
  }

  const columnNames = new Set(columns.map((column) => column.name));
  const indexList = await db.prepare("PRAGMA index_list('translations')").all();
  const indexes: Array<{ name: string; unique: number }> = indexList?.results ?? [];
  let hasFingerprintUnique = false;

  for (const index of indexes) {
    if (!index.unique || !index.name) continue;
    const indexInfo = await db.prepare(
      `PRAGMA index_info(${quoteSqlIdentifier(index.name)})`,
    ).all();
    const indexColumns = (indexInfo?.results ?? [])
      .sort((a: any, b: any) => a.seqno - b.seqno)
      .map((item: any) => item.name);
    if (indexColumns.join(',') === 'url,source_lang,target_lang,content_hash') {
      hasFingerprintUnique = true;
      break;
    }
  }

  const requiredColumns = [
    'id', 'url', 'title', 'source_lang', 'target_lang', 'html', 'content_hash', 'created_at',
  ];
  const hasAllColumns = requiredColumns.every((name) => columnNames.has(name));
  if (hasAllColumns && hasFingerprintUnique) return;

  // url/html 是保留旧译文所必需的字段；遇到未知结构时拒绝破坏性重建。
  if (!columnNames.has('url') || !columnNames.has('html')) {
    throw new Error('Unsupported translations table schema: required url/html columns are missing');
  }

  // 兼容旧表：保留已有译文和 id，补齐字段，并替换旧的三列唯一约束。
  const expression = (name: string, fallback: string) =>
    columnNames.has(name) ? quoteSqlIdentifier(name) : fallback;
  const statements = [
    db.prepare(`
      CREATE TABLE IF NOT EXISTS translations__schema_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT DEFAULT '',
        source_lang TEXT DEFAULT 'en',
        target_lang TEXT DEFAULT 'zh',
        html TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(url, source_lang, target_lang, content_hash)
      ) STRICT
    `),
    db.prepare(`
      INSERT OR IGNORE INTO translations__schema_v2
        (id, url, title, source_lang, target_lang, html, content_hash, created_at)
      SELECT
        ${expression('id', 'NULL')},
        ${expression('url', "''")},
        ${expression('title', "''")},
        ${expression('source_lang', "'en'")},
        ${expression('target_lang', "'zh'")},
        ${expression('html', "''")},
        ${expression('content_hash', "''")},
        ${expression('created_at', "datetime('now')")}
      FROM translations
    `),
    db.prepare('DROP TABLE translations'),
    db.prepare('ALTER TABLE translations__schema_v2 RENAME TO translations'),
  ];
  await db.batch(statements);
}

/** 确保表存在且 schema 与当前 UPSERT 冲突目标一致。 */
export async function ensurePageTranslationSchema(db: any): Promise<void> {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
    throw new Error('A valid D1 database binding is required');
  }
  let pending = schemaReady.get(db);
  if (!pending) {
    pending = ensurePageTranslationSchemaOnce(db).catch((error) => {
      schemaReady.delete(db);
      throw error;
    });
    schemaReady.set(db, pending);
  }
  await pending;
}

/**
 * 写入一条整页译文；失败时按暂时性错误重试，最终仍失败则抛出最后一次的错误。
 *
 * UPSERT 本身幂等，重复写入只会刷新 created_at，因此重试是安全的。
 */

/** SW998 (swdb998) 为主库，DB999 为备用库。 */
export function getD1Databases(env: any): any[] {
  const candidates = [env?.SW998, env?.DB999].filter(Boolean);
  return candidates.filter((db, index) => candidates.indexOf(db) === index);
}

/**
 * 查询按主库优先；主库查询失败或无结果时读取备用库。
 * 页面 UPSERT 请直接调用 savePageTranslation(getD1Databases(env), row)。
 *
 * 注意：first() 只看「有没有行」，不判断这行能不能用。缓存查询需要跨库挑选
 * content_hash 匹配且 HTML 健康的行，请用 readPageTranslationCandidates()。
 */
export function createD1FailoverDatabase(databases: any[]): any | undefined {
  if (!databases.length) return undefined;

  // 记录最近一次成功读取的库。两个 D1 的 id 各自自增，展示路径在读到备用库
  // 记录后若把 CSS 快照回写到主库，会覆盖主库里同号的不相干记录。
  let lastReadDb: any;

  const execute = async (sql: string, args: any[], method: 'first' | 'all' | 'run') => {
    let lastError: unknown;
    let lastResult: any;
    for (const db of databases) {
      try {
        const statement = db.prepare(sql).bind(...args);
        const result = await statement[method]();
        lastReadDb = db;
        lastResult = result;
        if (method === 'first' && result == null) continue;
        if (method === 'all' && (!result?.results || result.results.length === 0)) continue;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastResult !== undefined) return lastResult;
    if (lastError) throw lastError;
    return method === 'all' ? { results: [] } : null;
  };

  const writeTarget = () => lastReadDb ?? databases[0];

  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            first: () => execute(sql, args, 'first'),
            all: () => execute(sql, args, 'all'),
            // 「读哪库就写哪库」；纯写入（无前置读取）仍落到主库。
            run: async () => writeTarget().prepare(sql).bind(...args).run(),
          };
        },
        first: () => execute(sql, [], 'first'),
        all: () => execute(sql, [], 'all'),
      };
    },
    /** 供调用方显式取得真实库绑定（例如把命中的缓存行回写 CSS 快照）。 */
    getLastReadDb: () => lastReadDb,
  };
}

export interface PageTranslationCandidate {
  row: any;
  /** 该行所在的真实 D1 绑定，不是故障转移包装器：回写必须落在同一个库。 */
  db: any;
  dbIndex: number;
}

const CANDIDATE_SELECT_BASE = `
  SELECT id, html, content_hash, created_at FROM translations
  WHERE url = ? AND source_lang = ? AND target_lang = ?`;
const CANDIDATE_SELECT_TAIL = `
  ORDER BY created_at DESC, id DESC LIMIT ?`;

/**
 * 跨库读取同一 url+lang 的候选缓存行，最新优先。
 *
 * 必须逐库查，不能用 createD1FailoverDatabase 的 first()：它只要在主库拿到任意
 * 一行就返回，主库的一条 stale / 空 content_hash / 损坏记录会让备用库的有效缓存
 * 永远读不到。同理，UNIQUE 含 content_hash，同一 url 可有多行，只取最新一条也会
 * 遮住更早的匹配行，因此每库取最近若干行（默认 10）再交由调用方挑选。
 * 单个库查询失败不影响其他库。
 */
export async function readPageTranslationCandidates(
  databases: any[],
  params: {
    url: string;
    sourceLang: string;
    targetLang: string;
    contentHash?: string;
    limit?: number;
  },
): Promise<PageTranslationCandidate[]> {
  const targets = (databases || []).filter(Boolean);
  if (!targets.length) return [];
  const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 10)));
  // hash 条件下推到 SQL，否则同 url 的多行（UNIQUE 含 content_hash）会把匹配行
  // 挤出 LIMIT 窗口。
  const matchHash = Boolean(params.contentHash);
  const sql = CANDIDATE_SELECT_BASE
    + (matchHash ? ' AND content_hash = ?' : '')
    + CANDIDATE_SELECT_TAIL;
  const args = matchHash
    ? [params.url, params.sourceLang, params.targetLang, params.contentHash, limit]
    : [params.url, params.sourceLang, params.targetLang, limit];

  const perDatabase = await Promise.all(targets.map(async (db, index) => {
    try {
      const result: any = await db.prepare(sql).bind(...args).all();
      const rows: any[] = result?.results ?? [];
      return rows
        .filter((row) => !params.contentHash || row?.content_hash === params.contentHash)
        .map((row) => ({ row, db, dbIndex: index + 1 }));
    } catch (error) {
      console.error('[D1] cache candidate lookup error:', error);
      return [];
    }
  }));

  return perDatabase.flat().sort((a, b) =>
    String(b.row?.created_at || '').localeCompare(String(a.row?.created_at || '')) ||
    Number(b.row?.id || 0) - Number(a.row?.id || 0));
}

export async function savePageTranslation(
  db: any | any[],
  row: PageTranslationRow,
  options: SavePageTranslationOptions = {},
): Promise<void> {

  const databases = (Array.isArray(db) ? db : [db]).filter(Boolean);
  if (!databases.length) return;

  const retries = Math.max(0, options.retries ?? 2);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  let globalAttempt = 0;

  // 主库先完成全部暂时性重试；最终失败后才进入备用库。
  for (let databaseIndex = 0; databaseIndex < databases.length; databaseIndex++) {
    const currentDb = databases[databaseIndex];
    for (let attempt = 0; attempt <= retries; attempt++) {
      globalAttempt++;
      try {
        // 每个目标库独立校验/升级 schema；schema 缺失时先建表，再执行 UPSERT。
        await ensurePageTranslationSchema(currentDb);
        await currentDb
          .prepare(UPSERT_SQL)
          .bind(row.url, row.title || '', row.sourceLang, row.targetLang, row.html, row.contentHash)
          .run();
        if (databaseIndex > 0) {
          console.warn('[D1] primary database failed; translation saved to fallback database #' + (databaseIndex + 1));
        }
        return;
      } catch (error) {
        lastError = error;
        const transient = isTransientD1Error(error);
        const willRetry = transient && attempt < retries;
        options.onAttemptError?.(error, globalAttempt, willRetry || databaseIndex < databases.length - 1);
        if (!willRetry) break;
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
    if (databaseIndex < databases.length - 1) {
      console.warn('[D1] database #' + (databaseIndex + 1) + ' exhausted; trying fallback database #' + (databaseIndex + 2) + ': ' + describeD1Error(lastError));
    }
  }

  throw lastError;

}

/** 按 UTF-8 计算 HTML 字节数，用于日志和 D1 行大小预警。 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
