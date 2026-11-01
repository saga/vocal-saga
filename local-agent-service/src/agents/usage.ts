/**
 * WorkBuddy 每轮调用的 token 消耗（费用口径）。
 *
 * 来源：Agent SDK `result` 消息（实测 SDK 0.3.276 + CodeBuddy 网关）：
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }
 *   total_cost_usd / duration_ms / num_turns
 * CodeBuddy 订阅不计按 token 的美元费用（实测 total_cost_usd=0），
 * 因此对外展示以 token 数为准，cost 仅在 >0 时透出。
 */

export interface TurnUsage {
  /**
   * 本次请求的输入 token **总量**。
   *
   * 网关的 `input_tokens` 已经包含缓存读写（实测 49 次调用里恒等于
   * `cache_read_input_tokens + cache_creation_input_tokens`），所以它本身就是总输入；
   * 不要再与两个 cache 字段相加，否则会把输入算成两倍（见 totalInputTokens()）。
   */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 缓存读命中（不计费或低价；单独列出便于解释「为什么 input 很小」） */
  cacheReadTokens: number;
  /** 缓存写入（长会话首轮较高） */
  cacheCreationTokens: number;
  /** 网关给出的美元费用；订阅模式下为 0 */
  totalCostUsd: number | null;
  /**
   * SDK 的 `duration_ms`，**只覆盖最后一轮**。
   *
   * 多轮（工具调用往返）时它严重低估真实耗时：实测一个 6 轮的批次报 13,537ms，
   * 而实际墙钟是 61,037ms（22%）。做耗时统计请用 `batch.model.response.durationMs`
   * 或 runner 的「完成 · 耗时=」。
   */
  lastTurnDurationMs: number | null;
  /** 本轮 agent 轮数（文本翻译通常为 1） */
  numTurns: number | null;
}

/** 把未知值收敛为非负整数；非法值返回 0，用于 token 计数这类不该抛错的地方。 */
function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 真实输入 token 总量。
 *
 * 两种网关语义都成立时都不能算错：
 * - 包含式（当前实测）：`input_tokens == cacheRead + cacheCreation` → 直接取 input。
 * - 分离式（旧版/其它网关）：`input_tokens` 只算未命中部分 → 需要相加。
 *
 * 取两者较大值：包含式下相等不会翻倍，分离式下取到更大的合计而不会漏计。
 */
export function totalInputTokens(usage: Pick<TurnUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>): number {
  const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
  return Math.max(usage.inputTokens, cached);
}

/** 从 SDK result 消息解析 usage；字段缺失或类型不符时返回 null（调用方按无计量处理）。 */
export function parseTurnUsage(result: unknown): TurnUsage | null {
  const raw = result as { usage?: unknown; total_cost_usd?: unknown; duration_ms?: unknown; num_turns?: unknown } | null;
  const usage = raw?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = nonNegativeInt(usage.input_tokens);
  const outputTokens = nonNegativeInt(usage.output_tokens);
  const cacheReadTokens = nonNegativeInt(usage.cache_read_input_tokens);
  const cacheCreationTokens = nonNegativeInt(usage.cache_creation_input_tokens);
  // usage 全为 0 说明网关没给真实计量，按无数据处理。
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheCreationTokens) return null;
  const cost = Number(raw?.total_cost_usd);
  const lastTurnDurationMs = Number(raw?.duration_ms);
  const numTurns = Number(raw?.num_turns);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
    lastTurnDurationMs: Number.isFinite(lastTurnDurationMs) && lastTurnDurationMs >= 0
      ? Math.round(lastTurnDurationMs)
      : null,
    numTurns: Number.isFinite(numTurns) && numTurns > 0 ? Math.round(numTurns) : null,
  };
}

/** 累加两个 usage（任一为 null 则返回另一个的浅拷贝或 null）。 */
export function addTurnUsage(a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    totalCostUsd: a.totalCostUsd != null || b.totalCostUsd != null
      ? (a.totalCostUsd ?? 0) + (b.totalCostUsd ?? 0)
      : null,
    lastTurnDurationMs: null, // 合计不再表示单轮耗时
    numTurns: a.numTurns != null || b.numTurns != null
      ? (a.numTurns ?? 0) + (b.numTurns ?? 0)
      : null,
  };
}

/** 面向日志/事件的可读摘要：输入(含缓存)/输出 token 与费用。 */
export function summarizeTurnUsage(usage: TurnUsage | null): Record<string, unknown> | null {
  if (!usage) return null;
  const totalIn = totalInputTokens(usage);
  const summary: Record<string, unknown> = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    totalInputTokens: totalIn,
    totalTokens: totalIn + usage.outputTokens,
  };
  if (usage.totalCostUsd != null) summary.totalCostUsd = usage.totalCostUsd;
  if (usage.lastTurnDurationMs != null) summary.lastTurnDurationMs = usage.lastTurnDurationMs;
  if (usage.numTurns != null) summary.numTurns = usage.numTurns;
  return summary;
}

/**
 * 终端日志用的一行摘要。
 *
 * `hit` 是缓存读命中、`new` 是缓存写入，分开打印才能看出命中率——
 * 旧版打的是 `cache = hit + new`，而网关的 `in` 本来就等于两者之和，
 * 于是每一行都显示 `in=X cache=X`，看起来永远 100% 命中，实际什么也没说明。
 */
export function formatTurnUsageLog(usage: TurnUsage | null): string {
  if (!usage) return 'token=未计量';
  const parts = [
    'in=' + usage.inputTokens.toLocaleString(),
    'hit=' + usage.cacheReadTokens.toLocaleString(),
    'new=' + usage.cacheCreationTokens.toLocaleString(),
    'out=' + usage.outputTokens.toLocaleString(),
    usage.totalCostUsd != null ? 'cost=$' + usage.totalCostUsd.toFixed(4) : '',
  ].filter(Boolean);
  return 'token ' + parts.join(' ');
}
