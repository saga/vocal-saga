import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../lib/translate/cacheManager';
import { MapStorage, type StorageAdapter } from '../lib/storage';

describe('CacheManager', () => {
  let storage: MapStorage;
  let cache: CacheManager;

  beforeEach(() => {
    // 每个测试一个独立的 storage 实例，避免污染
    storage = new MapStorage('test:cache-' + Math.random().toString(36).slice(2));
    cache = new CacheManager('test:cache', 1000, storage);
  });

  // --- set and get ---

  it('stores and retrieves a value', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get<string>('key1');
    expect(result).toBe('value1');
  });



  it('uses custom TTL', async () => {
    await cache.set('key1', 'value1', 100);
    await new Promise((r) => setTimeout(r, 150));
    const result = await cache.get<string>('key1');
    expect(result).toBeNull();
  });


  // --- remove ---

  it('removes a key', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');
    await cache.remove('key1');

    expect(await cache.get<string>('key1')).toBeNull();
    expect(await cache.get<string>('key2')).toBe('value2');
  });

  // --- clear ---


  // --- getStats ---

  it('reports memory and storage stats', async () => {
    await cache.set('key1', 'value1');
    await cache.set('key2', 'value2');

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(2);
    expect(stats.storageSize).toBe(2);
  });


  // --- expiry ---

  it('removes expired entries from memory', async () => {
    await cache.set('key1', 'value1', 50);
    await new Promise((r) => setTimeout(r, 100));

    const result = await cache.get<string>('key1');
    expect(result).toBeNull();

    const stats = await cache.getStats();
    expect(stats.memorySize).toBe(0);
  });

  // --- memory cache (in-session speed) ---


  // --- multiple instances ---


  // --- 持久层异常时不挂（仅 log warn） ---

  function failingStorage(): StorageAdapter {
    return {
      get: async () => { throw new Error('Storage unavailable'); },
      getJSON: async () => { throw new Error('Storage unavailable'); },
      set: async () => {},
      setJSON: async () => { throw new Error('Storage unavailable'); },
      delete: async () => { throw new Error('Storage unavailable'); },
      list: async () => [],
    };
  }

  it('falls back to memory cache when storage get fails', async () => {
    const c = new CacheManager('test:failget', 1000, failingStorage());
    await c.set('key1', 'value1');
    const result = await c.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('still writes to memory cache when storage set fails', async () => {
    const c = new CacheManager('test:failset', 1000, failingStorage());
    await c.set('key1', 'value1');
    const result = await c.get<string>('key1');
    expect(result).toBe('value1');
  });

  it('handles remove when storage is unavailable', async () => {
    const c = new CacheManager('test:failremove', 1000, failingStorage());
    await c.set('key1', 'value1');
    await c.remove('key1');
    expect(await c.get<string>('key1')).toBeNull();
  });

  // --- LRU eviction ---

  it('evicts oldest entries when exceeding maxMemoryEntries', async () => {
    const c = new CacheManager('test:lru', 1000, storage, 5);
    // 填满 5 个
    for (let i = 0; i < 5; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    const stats1 = await c.getStats();
    expect(stats1.memorySize).toBe(5);

    // 第 6 个触发淘汰（删最早 20% = 1 个）
    await c.set('key5', 'value5');
    const stats2 = await c.getStats();
    // 内存大小应 <= 5（淘汰后）
    expect(stats2.memorySize).toBeLessThanOrEqual(5);
    // key0 不应在内存中（但可能在 storage 里）
    // 通过 stats 检查内存大小而非 get（get 会回源 storage）
    expect(stats2.memorySize).toBeLessThanOrEqual(5);
  });

  it('enforces the memory bound when entries are restored from persistent storage', async () => {
    const persistent = new MapStorage('test:lru-restore');
    for (let i = 0; i < 5; i++) {
      await persistent.setJSON(`cache:restore:key${i}`, {
        data: `value${i}`, timestamp: Date.now(), ttl: 10_000,
      });
    }
    const c = new CacheManager('restore', 10_000, persistent, 2);
    for (let i = 0; i < 5; i++) await c.get(`key${i}`);
    expect((await c.getStats()).memorySize).toBeLessThanOrEqual(2);
  });

  it('does not evict when under maxMemoryEntries', async () => {
    const c = new CacheManager('test:lru3', 1000, storage, 10);
    for (let i = 0; i < 5; i++) {
      await c.set(`key${i}`, `value${i}`);
    }
    const stats = await c.getStats();
    expect(stats.memorySize).toBe(5);
    // 没有淘汰，所有 key 都还在
    for (let i = 0; i < 5; i++) {
      expect(await c.get<string>(`key${i}`)).toBe(`value${i}`);
    }
  });


});
