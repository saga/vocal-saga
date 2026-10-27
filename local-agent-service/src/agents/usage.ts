/**
 * WorkBuddy 每轮调用的 token 消耗（费用口径）。
 *
 * 来源：Agent SDK `result` 消息（SDK 0.3.276 + CodeBuddy 网关）：
 *   usage: { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }
 * CodeBuddy 的 input_tokens 是本次输入总量，cache read/write 是该总量的拆分字段，不能再次加到总输入上。
 *   total_cost_usd / duration_ms / num_turns
 * CodeBuddy 订阅不计按 token 的美元费用（实测 total_cost_usd=0），
 * 因此对外展示以 token 数为准，cost 仅在 >0 时透出。
 */

export interface TurnUsage {
  /** CodeBuddy 报告的总输入 token（包含缓存命中/写入）；缓存字段是拆分，不应重复相加。 */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 缓存读命中（不计费或低价；单独列出便于解释「为什么 input 很小」） */
  cacheReadTokens: number;
  /** 缓存写入（长会话首轮较高） */
  cacheCreationTokens: number;
  /** 网关给出的美元费用；订阅模式下为 0 */
  totalCostUsd: number | null;
  /** 本轮总耗时（SDK 计时，含排队） */
  durationMs: number | null;
  /** 本轮 agent 轮数（文本翻译通常为 1） */
  numTurns: number | null;
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
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
  const durationMs = Number(raw?.duration_ms);
  const numTurns = Number(raw?.num_turns);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
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
    durationMs: null, // 合计不再表示单轮耗时
    numTurns: a.numTurns != null || b.numTurns != null
      ? (a.numTurns ?? 0) + (b.numTurns ?? 0)
      : null,
  };
}

/** 面向日志/事件的可读摘要；inputTokens 已是总输入，缓存字段只描述其中的组成。 */
export function summarizeTurnUsage(usage: TurnUsage | null): Record<string, unknown> | null {
  if (!usage) return null;
  const totalInputTokens = usage.inputTokens;
  const cachedInputTokens = usage.cacheReadTokens + usage.cacheCreationTokens;
  const summary: Record<string, unknown> = {
    inputTokens: usage.inputTokens,
    uncachedInputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + usage.outputTokens,
  };
  if (usage.totalCostUsd != null) summary.totalCostUsd = usage.totalCostUsd;
  if (usage.durationMs != null) summary.durationMs = usage.durationMs;
  if (usage.numTurns != null) summary.numTurns = usage.numTurns;
  return summary;
}

/** 终端日志用的一行摘要。缓存统计作为总输入的组成部分单独展示，不作为额外增量。 */
export function formatTurnUsageLog(usage: TurnUsage | null): string {
  if (!usage) return 'token=未计量';
  const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const parts = [
    'in=' + usage.inputTokens.toLocaleString(),
    'uncached=' + uncached.toLocaleString(),
    usage.cacheReadTokens > 0 ? 'cache-read=' + usage.cacheReadTokens.toLocaleString() : '',
    usage.cacheCreationTokens > 0 ? 'cache-write=' + usage.cacheCreationTokens.toLocaleString() : '',
    'out=' + usage.outputTokens.toLocaleString(),
    usage.totalCostUsd != null ? 'cost=$' + usage.totalCostUsd.toFixed(4) : '',
  ].filter(Boolean);
  return 'token ' + parts.join(' ');
}
