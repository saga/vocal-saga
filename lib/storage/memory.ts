/**
 * 内存 Map 实现的 StorageAdapter。用于：
 *   - 单元测试（不需要 mock @netlify/blobs / @cloudflare/workers-types）
 *   - 本地开发（不需要连云）
 *
 * 用一个进程级 Map 维护所有 store 的数据，storeName 之间互不影响。
 */
import type { StorageAdapter } from './types';

interface MemoryStorageGlobal {
  __memStores?: Record<string, Map<string, string>>;
}

function getAll(): Record<string, Map<string, string>> {
  const g = globalThis as unknown as MemoryStorageGlobal;
  if (!g.__memStores) g.__memStores = {};
  return g.__memStores;
}

export class MapStorage implements StorageAdapter {
  private map: Map<string, string>;

  constructor(public readonly storeName: string = '_default') {
    const all = getAll();
    if (!all[storeName]) all[storeName] = new Map();
    this.map = all[storeName]!;
  }

  /** 清空指定 store（test 用）。原地 clear 已有 map，保留实例的引用一致性 */
  static reset(storeName: string = '_default'): void {
    const all = getAll();
    all[storeName]?.clear();
  }

  /** 清空所有 store */
  static resetAll(): void {
    const all = getAll();
    for (const m of Object.values(all)) m.clear();
  }

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const v = this.map.get(key);
    if (v === undefined) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async setJSON(key: string, value: unknown, _ttlMs?: number): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}
