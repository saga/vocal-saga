/**
 * Storage 层单测。
 *
 * 覆盖：
 *   - MapStorage: get/set/getJSON/setJSON/delete/list 的语义 + 跨实例共享 storeName
 *   - 静态方法 reset / resetAll 的隔离效果
 *   - JSON 解析坏数据时 getJSON 返回 null（fail-soft）
 *   - 全局注册表 setDefaultStorage / getDefaultStorage / clearDefaultStorage
 *
 * 故意不测 CloudflareKVStorage：它需要真实 Worker binding，
 * 单测里用 mock 反而把单测变成 mock 测试，价值低。集成覆盖留给 e2e。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MapStorage,
  CloudflareKVStorage,
  setDefaultStorage,
  getDefaultStorage,
  clearDefaultStorage,
} from '../lib/storage';

describe('MapStorage', () => {
  beforeEach(() => {
    // 每个测试都从干净状态出发
    MapStorage.resetAll();
  });

  it('stores and retrieves a string', async () => {
    const s = new MapStorage('t1');
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
  });


  it('setJSON + getJSON round-trips objects and arrays', async () => {
    const s = new MapStorage('t1');
    const obj = { a: 1, b: ['x', 'y'], nested: { deep: true } };
    await s.setJSON('obj', obj);
    expect(await s.getJSON('obj')).toEqual(obj);
  });


  it('getJSON returns null on corrupt JSON (fail-soft)', async () => {
    const s = new MapStorage('t1');
    await s.set('bad', '{not valid json');
    expect(await s.getJSON('bad')).toBeNull();
  });

  it('delete removes the key', async () => {
    const s = new MapStorage('t1');
    await s.set('k', 'v');
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
  });


  it('same storeName shares data across instances', async () => {
    const a = new MapStorage('shared');
    const b = new MapStorage('shared');
    await a.set('k', 'from-a');
    expect(await b.get('k')).toBe('from-a');
  });


  it('reset(StoreName) clears only that store', async () => {
    const a = new MapStorage('storeA');
    const b = new MapStorage('storeB');
    await a.set('k', '1');
    await b.set('k', '2');
    MapStorage.reset('storeA');
    expect(await a.get('k')).toBeNull();
    expect(await b.get('k')).toBe('2');
  });

});

describe('CloudflareKVStorage', () => {
  it('applies the logical cache TTL as a KV expiration', async () => {
    const put = async () => {};
    const kv: any = { put, list: async () => ({ keys: [], list_complete: true }) };
    const storage = new CloudflareKVStorage(kv);
    const spy = vi.spyOn(kv, 'put');
    await storage.setJSON('cache:test:key', { ok: true }, 7 * 24 * 60 * 60 * 1000);
    expect(spy).toHaveBeenCalledWith(
      'cache:test:key',
      JSON.stringify({ ok: true }),
      { expirationTtl: 7 * 24 * 60 * 60 },
    );
  });

  it('lists every KV page until list_complete', async () => {
    const calls: any[] = [];
    const kv: any = {
      list: async (options?: any) => {
        calls.push(options);
        if (!options?.cursor) {
          return { keys: [{ name: 'a' }], list_complete: false, cursor: 'next-page' };
        }
        return { keys: [{ name: 'b' }], list_complete: true };
      },
    };
    const storage = new CloudflareKVStorage(kv);
    expect(await storage.list()).toEqual(['a', 'b']);
    expect(calls).toEqual([undefined, { cursor: 'next-page' }]);
  });
});

describe('default storage registry', () => {
  beforeEach(() => {
    clearDefaultStorage();
  });

  it('getDefaultStorage throws when nothing configured', () => {
    expect(() => getDefaultStorage()).toThrow(/Default storage not configured/);
  });

  it('setDefaultStorage + getDefaultStorage round-trips the same instance', () => {
    const s = new MapStorage('reg');
    setDefaultStorage(s);
    expect(getDefaultStorage()).toBe(s);
  });

  it('clearDefaultStorage removes the binding so next get throws', () => {
    setDefaultStorage(new MapStorage('reg'));
    clearDefaultStorage();
    expect(() => getDefaultStorage()).toThrow(/Default storage not configured/);
  });

});
