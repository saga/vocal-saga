/**
 * 本机服务的终端日志格式。
 *
 * 目标是「出问题能在终端直接定位」：每条日志带作用域与本地时间戳，便于和扩展端、终端
 * 操作时间对齐；错误统一带一行摘要，栈只保留尾部若干行，避免刷屏盖住上下文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/** 本地时间戳（时:分:秒），与 `[agent …]` 现有格式一致。 */
export function logStamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 日志文件路径。优先读取 LOCAL_AGENT_LOG_FILE；未设置时写入数据目录下的 logs/local-agent.log，
 * 便于离线排查（与 diagnose 脚本扫描的 logs 目录一致）。
 */
export function getLogFilePath(): string {
  const explicit = (process.env.LOCAL_AGENT_LOG_FILE || '').trim();
  if (explicit) return path.resolve(explicit);
  const dataDir = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
  return path.join(dataDir, 'logs', 'local-agent.log');
}

/** 追加一行到日志文件；失败时静默，避免日志本身影响主流程。 */
export function appendLogToFile(line: string): void {
  try {
    const file = getLogFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\\n', { encoding: 'utf8' });
  } catch {
    // 日志落盘失败不应影响主流程；终端输出仍保留。
  }
}

export function formatLogLine(scope: string, message: string): string {
  return '[' + scope + ' ' + logStamp() + '] ' + message;
}

export function logInfo(scope: string, message: string): void {
  const line = formatLogLine(scope, message);
  console.info(line);
  appendLogToFile(line);
}

export function logWarn(scope: string, message: string): void {
  const line = formatLogLine(scope, message);
  console.warn(line);
  appendLogToFile(line);
}

export function logError(scope: string, message: string): void {
  const line = formatLogLine(scope, message);
  console.error(line);
  appendLogToFile(line);
}

/**
 * 进度/状态行：走 stderr，避免污染 CLI 的 JSON stdout，同时保持统一时间戳格式。
 * 语义上是「正在进行」而非「出错」，所以不占用 logError 的红色级别。
 */
export function logProgress(scope: string, message: string): void {
  const line = formatLogLine(scope, message);
  console.error(line);
  appendLogToFile(line);
}

/** 单行错误摘要：去掉换行、限制长度，日志里永远只占一行。 */
export function summarizeError(error: unknown, limit = 300): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** 错误栈尾部：保留最后几帧，足以看出是谁抛的，又不至于淹没日志。 */
export function errorStackTail(error: unknown, frames = 4): string {
  if (!(error instanceof Error) || !error.stack) return '';
  const lines = error.stack.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, frames).join(' ← ');
}

/** 日志里只描述请求路径，丢掉查询串，避免 cursor 之类的滚动参数刷屏。 */
export function requestPath(url: string): string {
  return (url.split('?')[0] || '/').slice(0, 200);
}

/**
 * 轮询型请求：扩展按 1–2 秒间隔重复发出，正常运行时每秒一条日志。
 *
 * 这类请求成功且不慢时没有信息量，只会把真正的信号挤出屏幕，所以默认静默。
 * 判定必须覆盖子路径：`/context-graph/status` 曾经因为只匹配 `/context-graph$`
 * 而漏网，实测占全量日志的 27%（2192/7934 行）。
 */
const POLLING_PATH_PATTERNS: readonly RegExp[] = [
  /\/runs\/[^/]+$/,          // 运行详情轮询
  /\/events$/,               // 事件流
  /\/context-graph(\/.*)?$/, // 预处理状态（含 /context-graph/status）
];

export function isPollingRequest(method: string, path: string): boolean {
  return method === 'GET' && POLLING_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** 汇总行里把 UUID 折成 :id，避免同一接口因为 id 不同被拆成十几行。 */
export function collapsePath(path: string): string {
  return path.replace(/\/projects\/[^/]+/, '/projects/:id').replace(/\/runs\/[^/]+/, '/runs/:id');
}

/** 静默请求的滚动窗口：只记次数和最慢耗时，够判断「在轮询且服务正常」。 */
export interface PollingRollup {
  counts: Map<string, number>;
  maxDurationMs: number;
  since: number;
}

export function createPollingRollup(): PollingRollup {
  return { counts: new Map(), maxDurationMs: 0, since: 0 };
}

export function recordPollingRequest(rollup: PollingRollup, path: string, durationMs: number, now = Date.now()): void {
  if (!rollup.since) rollup.since = now;
  const key = collapsePath(path);
  rollup.counts.set(key, (rollup.counts.get(key) || 0) + 1);
  if (durationMs > rollup.maxDurationMs) rollup.maxDurationMs = durationMs;
}

export function resetPollingRollup(rollup: PollingRollup): void {
  rollup.counts.clear();
  rollup.maxDurationMs = 0;
  rollup.since = 0;
}

/**
 * 一行汇总替代整个窗口的轮询日志；窗口内没有静默请求时返回 null（不打空行）。
 * 只列前三个接口，其余折叠成 `+N`，避免汇总行自己又变长。
 */
export function formatPollingSummary(rollup: PollingRollup, now = Date.now()): string | null {
  const total = [...rollup.counts.values()].reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const ranked = [...rollup.counts.entries()].sort((a, b) => b[1] - a[1]);
  const detail = ranked.slice(0, 3).map(([path, count]) => path + ' ×' + count).join(' · ');
  const rest = ranked.length > 3 ? ' · +' + (ranked.length - 3) + ' 个接口' : '';
  const seconds = Math.max(1, Math.round((now - rollup.since) / 1000));
  return '轮询汇总 · 最近 ' + seconds + 's 静默 ' + total + ' 次（' + detail + rest + ' · 最慢 ' + rollup.maxDurationMs + 'ms）';
}
