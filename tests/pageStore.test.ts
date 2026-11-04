import { describe, it, expect, vi } from 'vitest';
import {
  describeD1Error,
  isTransientD1Error,
  savePageTranslation,
} from '../lib/translate/pageStore';

interface FakeDb {
  runs: any[][];
  prepare: (sql: string) => any;
}

/** 按给定错误序列构造 D1 替身：第 N 次 run() 抛对应错误，undefined 表示成功。 */
function createFakeDb(errors: Array<unknown | undefined>): FakeDb {
  const runs: any[][] = [];
  let call = 0;
  return {
    runs,
    prepare: () => ({
      bind: (...args: any[]) => ({
        run: async () => {
          const error = errors[call];
          call += 1;
          if (error) throw error;
          runs.push(args);
          return { success: true };
        },
      }),
    }),
  };
}

const baseRow = {
  url: 'https://example.com/page',
  title: 'Example',
  sourceLang: 'auto',
  targetLang: 'zh',
  html: '<html><body>hi</body></html>',
  contentHash: 'abc123',
};

const sleep = () => Promise.resolve();

describe('isTransientD1Error', () => {
  it('把 D1 暂时性故障判为可重试', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'))).toBe(true);
  });

  it('把 schema / 类型错误判为不可重试', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: table translations has no column named content_hash: SQLITE_ERROR'))).toBe(false);
    expect(isTransientD1Error(new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\''))).toBe(false);
  });

  it('没有 message 的底层错误按可重试处理', () => {
    const empty = new Error('');
    expect(isTransientD1Error(empty)).toBe(true);
  });
});

describe('describeD1Error', () => {
  it('同时取 message 与 cause.message', () => {
    const error = new Error('D1_ERROR: Network connection lost.');
    (error as any).cause = new Error('socket closed');
    expect(describeD1Error(error)).toContain('Network connection lost');
    expect(describeD1Error(error)).toContain('cause: socket closed');
  });

  it('空错误不返回空字符串以外的东西', () => {
    expect(describeD1Error(null)).toBe('');
  });
});

describe('savePageTranslation', () => {
  it('第一次写入成功时不重试', async () => {
    const db = createFakeDb([undefined]);
    await savePageTranslation(db, baseRow, { sleep });
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toEqual([
      baseRow.url,
      baseRow.title,
      baseRow.sourceLang,
      baseRow.targetLang,
      baseRow.html,
      baseRow.contentHash,
    ]);
  });

  it('暂时性错误会重试并在下一次成功', async () => {
    const db = createFakeDb([new Error('D1_ERROR: Network connection lost.'), undefined]);
    const onAttemptError = vi.fn();
    await savePageTranslation(db, baseRow, { sleep, onAttemptError });
    expect(db.runs).toHaveLength(1);
    expect(onAttemptError).toHaveBeenCalledTimes(1);
    expect(onAttemptError.mock.calls[0][2]).toBe(true); // willRetry
  });

  it('重试用尽后抛出最后一次错误', async () => {
    const db = createFakeDb([
      new Error('D1_ERROR: Network connection lost.'),
      new Error('D1_ERROR: Network connection lost.'),
      new Error('D1_ERROR: Network connection lost.'),
    ]);
    await expect(savePageTranslation(db, baseRow, { sleep })).rejects.toThrow('Network connection lost');
    expect(db.runs).toHaveLength(0);
  });

  it('不可重试的错误只尝试一次', async () => {
    const db = createFakeDb([new Error('D1_ERROR: table translations has no column named content_hash')]);
    await expect(savePageTranslation(db, baseRow, { sleep })).rejects.toThrow('content_hash');
    expect(db.runs).toHaveLength(0);
  });

  it('主库 SW998 写入成功时不触碰备用库 DB999', async () => {
    const primary = createFakeDb([undefined]);
    const fallback = createFakeDb([undefined]);
    await savePageTranslation([primary, fallback], baseRow, { sleep });
    expect(primary.runs).toHaveLength(1);
    expect(fallback.runs).toHaveLength(0);
  });

  it('主库最终失败后才写入备用库 DB999', async () => {
    const primary = createFakeDb([new Error('D1_ERROR: table translations has no column named content_hash')]);
    const fallback = createFakeDb([undefined]);
    await savePageTranslation([primary, fallback], baseRow, { sleep });
    expect(primary.runs).toHaveLength(0);
    expect(fallback.runs).toHaveLength(1);
  });

  it('主库暂时性错误先完成重试，仍失败才切换备用库', async () => {
    const primary = createFakeDb([
      new Error('D1_ERROR: Network connection lost.'),
      new Error('D1_ERROR: Network connection lost.'),
      new Error('D1_ERROR: Network connection lost.'),
    ]);
    const fallback = createFakeDb([undefined]);
    await savePageTranslation([primary, fallback], baseRow, { sleep });
    expect(primary.runs).toHaveLength(0);
    expect(fallback.runs).toHaveLength(1);
  });

  it('没有数据库时直接返回', async () => {
    await expect(savePageTranslation(null, baseRow, { sleep })).resolves.toBeUndefined();
  });
});
