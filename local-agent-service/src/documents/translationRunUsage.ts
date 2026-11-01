/**
 * Run 级 token 用量账本。
 *
 * 从 translationAgent 抽出：翻译与审校各自累加，最终在 Run 终结或失败时一次性结清。
 * 账本按 runId 存在进程内，进程重启后归零。
 */
import { addTurnUsage, type TurnUsage } from '../agents/usage.ts';
// 每个 Run 的 token 消耗累计（费用口径）。初译每次模型调用成功后累加，
// run.finished / run.failed 时随事件透出并清理。Review/审校轮各有独立事件，不计入这里。
export const runUsageTotals = new Map<string, TurnUsage | null>();

/** 累加某 Run 的 token 消耗（初译口径）。 */
export function addRunUsage(runId: string, usage: TurnUsage | null): void {
  if (!usage) return;
  runUsageTotals.set(runId, addTurnUsage(runUsageTotals.get(runId) ?? null, usage));
}

/** 取出并清除某 Run 的累计 token 消耗。 */
export function takeRunUsage(runId: string): TurnUsage | null {
  const usage = runUsageTotals.get(runId) ?? null;
  runUsageTotals.delete(runId);
  return usage;
}
