/**
 * 本机服务的终端日志格式。
 *
 * 目标是「出问题能在终端直接定位」：每条日志带作用域与本地时间戳，便于和扩展端、终端
 * 操作时间对齐；错误统一带一行摘要，栈只保留尾部若干行，避免刷屏盖住上下文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/** 本地日期时间戳，便于跨天关联服务日志。 */
export function logStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
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
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
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
