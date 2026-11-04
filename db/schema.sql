-- Vocal Saga 翻译结果持久化表
-- 新数据库可执行：wrangler d1 execute <database-name> --file=db/schema.sql
-- Worker 写入前也会检查并自动创建/升级此表结构。
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
) STRICT;
