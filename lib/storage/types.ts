/**
 * 最小 KV 存储接口。
 *
 * 生产实现使用 Cloudflare Workers KV；MapStorage 仅供测试使用。
 *
 * 一律把多个 namespace 折叠到同一个 adapter 上，用 key 前缀（`cache:analysis:`
 * 等）区隔；这样跨平台移植时不需要在两边都建 N 个 binding / store。
 */

export interface StorageAdapter {
  /** 读字符串；不存在或读取失败均返回 null（fail-soft，避免一次坏读阻塞上层） */
  get(key: string): Promise<string | null>;
  /** 读 + JSON.parse */
  getJSON<T = unknown>(key: string): Promise<T | null>;
  /** 写字符串 */
  set(key: string, value: string): Promise<void>;
  /** JSON.stringify 后写入 */
  setJSON(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** 删除单个 key */
  delete(key: string): Promise<void>;
  /** 列出所有 key（adapter 内的全部 key；调用方按前缀过滤） */
  list(): Promise<string[]>;
}
