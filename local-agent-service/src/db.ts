import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, DATABASE_PATH, WORK_DIR, MAX_HISTORY_ROWS, STORE_CONTENT,
} from './config.ts';

export let db: DatabaseSync | undefined;

/**
 * 初始化通用 API/请求历史数据库并执行兼容性迁移。
 * 文档项目的业务状态另存在 per-project SQLite 中；不要把长文档 Run、候选译文或上下文快照
 * 转存到这个通用请求历史库，以免两套存储出现不一致的双写关系。
 */
export function initDatabase(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  const database = new DatabaseSync(DATABASE_PATH);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS request_history (' +
    'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, endpoint TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, ' +
    'status TEXT NOT NULL, duration_ms INTEGER NOT NULL, input_chars INTEGER NOT NULL, output_chars INTEGER NOT NULL, ' +
    'request_json TEXT, response_text TEXT, error TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_request_history_created_at ON request_history(created_at DESC);' +
    'CREATE TABLE IF NOT EXISTS translation_cache (cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);' +
    'CREATE INDEX IF NOT EXISTS idx_translation_cache_expires ON translation_cache(expires_at);' +
    'CREATE TABLE IF NOT EXISTS document_sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS idx_document_sessions_updated ON document_sessions(updated_at DESC);' +
    'CREATE TABLE IF NOT EXISTS service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);'
  );
  database.prepare(
    'INSERT INTO service_settings(key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run('store_content', String(STORE_CONTENT), new Date().toISOString());
  db = database;
  return database;
}

/**
 * 按 cacheKey 查询未过期的翻译缓存；命中则递增 hits 并解析 JSON，损坏/过期则清理并返回 null。
 * 返回值必须是对象（数组视为无效缓存）。
 */
export function getTranslationCache(cacheKey: string) {
  const row = db!.prepare(
    'SELECT payload_json FROM translation_cache WHERE cache_key = ? AND expires_at > ?'
  ).get(cacheKey, Date.now()) as { payload_json?: string } | undefined;
  if (!row?.payload_json) {
    db!.prepare('DELETE FROM translation_cache WHERE cache_key = ? AND expires_at <= ?').run(cacheKey, Date.now());
    return null;
  }
  db!.prepare('UPDATE translation_cache SET hits = hits + 1 WHERE cache_key = ?').run(cacheKey);
  try {
    const value = JSON.parse(row.payload_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    db!.prepare('DELETE FROM translation_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }
}

/**
 * 写入/更新翻译缓存。cacheKey 长度 1-500，payload 不超过 2 MiB；TTL 钳制在 60s~90 天，默认 7 天。
 * 写入后顺带清理过期行与超出 20000 条的旧/少用行，控制表体积。
 */
export function setTranslationCache(cacheKey: string, value: unknown, ttlMs: number) {
  if (!cacheKey || cacheKey.length > 500) throw Object.assign(new Error('cacheKey 必须是 1-500 字符'), { status: 400 });
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > 2 * 1024 * 1024) {
    throw Object.assign(new Error('单条缓存超过 2 MiB'), { status: 413 });
  }
  const now = Date.now();
  const ttl = Number.isFinite(ttlMs) ? Math.max(60_000, Math.min(ttlMs, 90 * 24 * 60 * 60 * 1000)) : 7 * 24 * 60 * 60 * 1000;
  db!.prepare(
    'INSERT INTO translation_cache(cache_key, payload_json, created_at, expires_at, hits) VALUES (?, ?, ?, ?, 0) ' +
    'ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json, created_at=excluded.created_at, expires_at=excluded.expires_at, hits=0'
  ).run(cacheKey, payload, new Date(now).toISOString(), now + ttl);
  // 顺手清理：过期行，以及最旧、最少使用的行，都设了上界。
  db!.prepare('DELETE FROM translation_cache WHERE expires_at <= ?').run(now);
  db!.prepare('DELETE FROM translation_cache WHERE cache_key IN (SELECT cache_key FROM translation_cache ORDER BY hits ASC, created_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM translation_cache) - 20000))').run();
}

/**
 * 将外部传入的 segment 数组归一化为标准结构：校验 id/text 类型，截断字段长度，page 非数字转 null。
 * 最多 100000 项；非法项被过滤掉，不抛错。
 */
export function normalizeDocumentSegments(input: unknown) {
  if (!Array.isArray(input) || input.length > 100000) throw Object.assign(new Error('segments 必须是数组，最多 100000 项'), { status: 400 });
  return input.flatMap((raw: any) => {
    if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string') return [];
    return [{
      id: raw.id.slice(0, 200),
      text: raw.text,
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 500) : '',
      page: Number.isFinite(raw.page) ? raw.page : null,
    }];
  });
}

/**
 * 保存/更新可恢复的文档会话（document_sessions）。mergeExisting=true 时合并 prior/incoming snapshot，
 * 以 segment id 为 key 合并 translations Map，避免覆盖已有译文。payload 超 5 MiB 抛 413。
 * 表最多保留最近 30 条会话。
 */
export function saveDocumentSession(sessionId: string, title: string, format: string, payload: unknown, mergeExisting = false) {
  if (!sessionId || sessionId.length > 200) throw Object.assign(new Error('sessionId 必须是 1-200 字符'), { status: 400 });
  let storedPayload = payload;
  if (mergeExisting && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const existing = db!.prepare('SELECT payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as { payload_json?: string } | undefined;
    if (existing?.payload_json) {
      try {
        const prior = JSON.parse(existing.payload_json) as Record<string, any>;
        const incoming = payload as Record<string, any>;
        const mergedPayload: Record<string, any> = { ...prior, ...incoming };
        storedPayload = mergedPayload;

        const priorSnapshot = prior.snapshot && typeof prior.snapshot === 'object' && !Array.isArray(prior.snapshot)
          ? prior.snapshot : {};
        const incomingSnapshot = incoming.snapshot && typeof incoming.snapshot === 'object' && !Array.isArray(incoming.snapshot)
          ? incoming.snapshot : {};
        if (prior.snapshot || incoming.snapshot) {
          const translations = new Map<string, string>();
          const mergeTranslations = (value: unknown) => {
            if (!Array.isArray(value)) return;
            for (const entry of value) {
              if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
                translations.set(entry[0], entry[1]);
              }
            }
          };
          mergeTranslations(priorSnapshot.translations);
          mergeTranslations(incomingSnapshot.translations);
          mergeTranslations(incoming.translationDelta);
          mergedPayload.snapshot = {
            ...priorSnapshot,
            ...incomingSnapshot,
            translations: Array.from(translations.entries()),
          };
        }
        delete mergedPayload.translationDelta;
      } catch { /* corrupt prior session is replaced with the new valid snapshot */ }
    }
  }
  const json = JSON.stringify(storedPayload);
  if (Buffer.byteLength(json, 'utf8') > 5 * 1024 * 1024) throw Object.assign(new Error('文档快照超过 5 MiB'), { status: 413 });
  db!.prepare(
    'INSERT INTO document_sessions(session_id, title, format, updated_at, payload_json) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, format=excluded.format, updated_at=excluded.updated_at, payload_json=excluded.payload_json'
  ).run(sessionId, title.slice(0, 500), format.slice(0, 20), new Date().toISOString(), json);
  db!.prepare('DELETE FROM document_sessions WHERE session_id IN (SELECT session_id FROM document_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 30)').run();
}

/**
 * 从请求体提取元数据：model、消息数、输入字符数、响应格式、消息角色列表，用于历史记录与日志。
 */
export function requestMetadata(body: any) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const joined = messages.map((item: any) => typeof item?.content === 'string' ? item.content : '').join('\n');
  return {
    model: typeof body.model === 'string' ? body.model.slice(0, 240) : '',
    messageCount: messages.length,
    inputChars: joined.length,
    responseFormat: body.response_format?.type || 'text',
    messageRoles: messages.map((item: any) => typeof item?.role === 'string' ? item.role : 'unknown'),
  };
}

/**
 * 保存一次 API 调用历史到 request_history：记录端点、provider/model、状态、耗时、输入/输出字符数，
 * 依 STORE_CONTENT 决定是否保存完整请求/响应。超 MAX_HISTORY_ROWS 的旧记录被清理。
 */
export function saveHistory({ id, endpoint, agent, body, output, error, durationMs, status }: any) {
  const record = requestMetadata(body || {});
  const requestJson = STORE_CONTENT
    ? JSON.stringify(body || {})
    : JSON.stringify({ ...record, contentStored: false });
  const responseText = STORE_CONTENT ? (output || null) : null;
  db!.prepare(
    'INSERT INTO request_history (id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, new Date().toISOString(), endpoint, agent?.provider || 'unknown',
    agent?.model || record.model, status, durationMs, record.inputChars,
    (output || '').length, requestJson, responseText, error ? String(error).slice(0, 2000) : null,
  );
  db!.prepare(
    'DELETE FROM request_history WHERE id IN (' +
    'SELECT id FROM request_history ORDER BY created_at DESC LIMIT -1 OFFSET ?)'
  ).run(MAX_HISTORY_ROWS);
}
