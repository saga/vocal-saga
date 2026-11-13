/**
 * 缓存层（跨平台：Netlify Blobs / Cloudflare KV / 内存）。
 *
 * 与 fanyi-extension 的 @wxt-dev/storage 实现的区别：
 *   - WXT 版本：所有 key 存在同一个大对象下（O(N) 序列化）
 *   - 现在版本：每个 key 独立存储（O(1) 读写）
 *   - 公共 API（get / set / remove / clear / getStats）保持一致，
 *     translateApi.ts 等调用方无需改动
 *
 * 缓存层：
 *   - 进程内 Map（首次访问后命中率高时省一次持久层 roundtrip）
 *   - 持久层（通过 default storage 注入，Netlify Blobs / Cloudflare KV / 内存）
 *
 * 命名空间：所有 cache key 共享一个 default storage，命名通过 `cache:{name}:{key}`
 * 前缀区分，避免在云上配置多个 store / binding。
 */

import { getDefaultStorage, type StorageAdapter } from '../storage';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class CacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private _storage: StorageAdapter | null = null;
  private prefix: string;
  /** 内存缓存最大条目数，超过时淘汰最早插入的 20% */
  private readonly maxMemoryEntries: number;
  /**
   * 延迟到首次访问再解析 storage。原因：CF Workers/Pages 在 isolate 启动时
   * 就会 eager 加载模块（早于首个请求），而 platform shim 里的 setDefaultStorage
   * 要等 `env` 可用才能跑（要么 lazy 单例，要么 per-request 桥接）。
   * 同步调 getDefaultStorage() 会抛 "Default storage not configured"。
   * 通过 getter + 缓存，第一次 get/set 时才解析。
   */
  private get storage(): StorageAdapter {
    if (!this._storage) this._storage = getDefaultStorage();
    return this._storage;
  }

  constructor(
    private storeName: string,
    private defaultTTL = 24 * 60 * 60 * 1000,
    storage?: StorageAdapter,
    maxMemoryEntries = 500,
  ) {
    this._storage = storage ?? null;
    this.prefix = `cache:${storeName}:`;
    this.maxMemoryEntries = Math.max(1, Math.floor(maxMemoryEntries));
  }

  async get<T>(key: string): Promise<T | null> {
    // 1) 内存层
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && !this.isExpired(memoryEntry)) {
      return memoryEntry.data as T;
    }
    if (memoryEntry) {
      this.memoryCache.delete(key);
    }

    // 2) 持久层
    try {
      const entry = await this.storage.getJSON<CacheEntry<T>>(this.prefix + key);
      if (entry) {
        if (!this.isExpired(entry)) {
          this.memoryCache.set(key, entry);
          this.evictIfNeeded();
          return entry.data;
        }
        // 过期 → 顺手删
        await this.storage.delete(this.prefix + key).catch(() => {});
      }
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] get failed for ${key}:`, (err as Error).message);
    }

    return null;
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    };

    this.memoryCache.set(key, entry);
    this.evictIfNeeded();

    try {
      await this.storage.setJSON(this.prefix + key, entry, entry.ttl);
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] set failed for ${key}:`, (err as Error).message);
    }
  }

  async remove(key: string): Promise<void> {
    this.memoryCache.delete(key);
    try {
      await this.storage.delete(this.prefix + key);
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] remove failed for ${key}:`, (err as Error).message);
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      const allKeys = await this.storage.list();
      const ours = allKeys.filter((k) => k.startsWith(this.prefix));
      await Promise.all(ours.map((k) => this.storage.delete(k)));
    } catch (err) {
      console.warn(`[CacheManager:${this.storeName}] clear failed:`, (err as Error).message);
    }
  }

  async getStats(): Promise<{ memorySize: number; storageSize: number }> {
    let storageSize = 0;
    try {
      const allKeys = await this.storage.list();
      storageSize = allKeys.filter((k) => k.startsWith(this.prefix)).length;
    } catch {
      // ignore
    }
    return {
      memorySize: this.memoryCache.size,
      storageSize,
    };
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  /** 超过 maxMemoryEntries 时淘汰最早插入的 20%（Map 保持插入顺序） */
  private evictIfNeeded(): void {
    if (this.memoryCache.size <= this.maxMemoryEntries) return;
    const toDelete = Math.ceil(this.maxMemoryEntries * 0.2);
    let deleted = 0;
    for (const key of this.memoryCache.keys()) {
      if (deleted >= toDelete) break;
      this.memoryCache.delete(key);
      deleted++;
    }
  }
}

// 30 天默认 TTL（与 fanyi-extension 行为一致）
// 单例依赖 setDefaultStorage() 在启动时被调用；test 时由 tests/setup.ts 注入 MapStorage
export const analysisCache = new CacheManager('analysis', 30 * 24 * 60 * 60 * 1000);
export const translationCache = new CacheManager('translations', 30 * 24 * 60 * 60 * 1000);
