import { runOpenCode } from './opencode.ts';
import { runWorkbuddy, runWorkbuddyJson, runWorkbuddyStructured } from './workbuddy.ts';
import { parseJsonValue } from '../json.ts';
import { logError, logInfo } from '../log.ts';
import { formatTurnUsageLog, type TurnUsage } from './usage.ts';
import { applyCodeBuddyTaskPrompt, type CodeBuddyTaskProfile } from './taskProfiles.ts';

type AgentSpec = { provider: string; model: string };

function isWorkflowManaged(sessionScope?: string): boolean {
  return !!sessionScope && (sessionScope.startsWith('document:') || sessionScope.startsWith('context-graph:'));
}

function describeTask(requestId: string, sessionScope?: string): string {
  if (requestId.includes('style-review')) return '人物声音/文风审校';
  if (requestId.includes('-review-') || sessionScope?.includes(':review:')) return '准确性/术语审校';
  if (sessionScope?.startsWith('context-graph:') || requestId.startsWith('context-graph:')) return '全书预处理';
  if (sessionScope?.includes(':translation:') || /-b\d+-a\d+$/.test(requestId)) return '文档初译';
  if (requestId.includes('literary')) return '文学分析';
  return '通用模型请求';
}

/**
 * 每次模型调用都要在文件日志里留下「耗时 / 输出量 / token」。
 *
 * 这里曾经对 workflow 调用直接 return，理由是「它们有自己的事件」。但事件在 SQLite 里，
 * 文件日志是排查时第一眼看到的东西：文档初译因此完全没有调用级日志，一次 run 里
 * 每个批次花了多久、产出多少字，只能在 DB 里拼。代价远大于那点日志量。
 */
function logModelStart(
  agent: AgentSpec, prompt: string, systemPrompt: string, requestId: string,
  sessionScope: string | undefined, mode: string,
): void {
  logInfo('model', describeTask(requestId, sessionScope) + ' · 开始 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 模式=' + mode + ' · 输入=' + prompt.length.toLocaleString() +
    ' 字符 · 系统指令=' + systemPrompt.length.toLocaleString() + ' 字符' +
    (isWorkflowManaged(sessionScope) ? ' · 工作流' : ''));
}

function compactOutputSummary(value: unknown): string {
  if (typeof value === 'string') return '文本 ' + value.length + ' 字符';
  if (Array.isArray(value)) return '数组 ' + value.length + ' 项';
  if (!value || typeof value !== 'object') return typeof value;
  const row = value as Record<string, unknown>;
  const counts: string[] = [];
  for (const key of ['translations', 'findings', 'characters', 'entities', 'relationships', 'chapterSummaries', 'openQuestions']) {
    if (Array.isArray(row[key])) counts.push(key + '=' + (row[key] as unknown[]).length);
  }
  return counts.length ? counts.join(' ') : 'JSON 字段 ' + Object.keys(row).slice(0, 8).join(', ');
}

function logModelSuccess(
  agent: AgentSpec, output: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string, usage: TurnUsage | null = null,
): void {
  logInfo('model', describeTask(requestId, sessionScope) + ' · 完成 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 耗时=' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's · 输出=' + compactOutputSummary(output) +
    ' · ' + formatTurnUsageLog(usage) + ' · 模式=' + mode +
    (isWorkflowManaged(sessionScope) ? ' · 工作流' : ''));
}

function logModelFailure(
  agent: AgentSpec, error: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const duration = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
  logError('model', describeTask(requestId, sessionScope) + ' · 失败 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') + ' · 耗时=' + duration + ' · ' + message +
    (isWorkflowManaged(sessionScope) ? ' · 工作流' : ''));
  if (process.env.LOCAL_AGENT_LOG_LEVEL === 'debug' && error instanceof Error && error.stack) {
    logError('model', error.stack);
  }
}

export interface AgentRunResult<T> {
  result: T;
  usage: TurnUsage | null;
  /** 可续跑的工作流所用的持久 CodeBuddy query() 会话存在时才有。 */
  sessionId?: string;
}

/**
 * 统一的文本模型调用入口：按 provider 分派到 Workbuddy/OpenCode，应用 taskProfile 的 Prompt/模型覆盖，
 * 记录开始/完成/失败日志，返回文本与 usage。
 */
export async function runAgent(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<AgentRunResult<string>> {
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model && taskProfile.model.toLowerCase() !== 'auto'
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, '文本');
  try {
    let output: string;
    let usage: TurnUsage | null = null;
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddy(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, taskProfile);
      output = r.text;
      usage = r.usage;
    } else if (effectiveAgent.provider === 'opencode') {
      output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, output, requestId, sessionScope, startedAt, '文本', usage);
    return { result: output, usage };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '文本');
    throw error;
  }
}

/**
 * 统一的 JSON 对象模型调用入口：要求返回 JSON 对象（数组视为失败），应用 taskProfile，记录日志。
 */
export async function runAgentJson(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: { timeoutMs?: number } = {},
): Promise<AgentRunResult<Record<string, any>>> {
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model && taskProfile.model.toLowerCase() !== 'auto'
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, 'JSON 对象');
  try {
    let parsed: Record<string, any>;
    let usage: TurnUsage | null = null;
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddyJson(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile, options);
      parsed = r.parsed;
      usage = r.usage;
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt, options.timeoutMs);
      const value = parseJsonValue(output, 'request=' + String(requestId).slice(0, 40));
      if (!value || Array.isArray(value)) throw new Error('OpenCode 返回内容不是预期 JSON 对象');
      parsed = value as Record<string, any>;
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, parsed, requestId, sessionScope, startedAt, 'JSON 对象', usage);
    return { result: parsed, usage };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, 'JSON 对象');
    throw error;
  }
}

/**
 * 统一的结构化 JSON 模型调用入口：允许返回对象或数组，支持持久化 session 与超时覆盖，记录日志。
 */
export async function runAgentStructured(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: {
    timeoutMs?: number;
    sessionId?: string;
    persistSession?: boolean;
    onSessionId?: (sessionId: string) => void;
  } = {},
): Promise<AgentRunResult<Record<string, any> | any[]>> {
  const startedAt = Date.now();
  const effective = taskProfile ? applyCodeBuddyTaskPrompt(prompt, systemPrompt, taskProfile) : { prompt, systemPrompt };
  const effectiveAgent = agent.provider === 'workbuddy' && taskProfile?.model && taskProfile.model.toLowerCase() !== 'auto'
    ? { ...agent, model: taskProfile.model }
    : agent;
  logModelStart(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, '结构化 JSON');
  try {
    let result: Record<string, any> | any[];
    let usage: TurnUsage | null = null;
    let sessionId: string | undefined;
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddyStructured(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile, options);
      result = r.parsed;
      usage = r.usage;
      sessionId = r.sessionId;
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt, options.timeoutMs);
      const value = parseJsonValue(output, 'request=' + String(requestId).slice(0, 40));
      if (value === null) throw new Error('OpenCode 返回内容不是有效 JSON');
      result = value;
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, result, requestId, sessionScope, startedAt, '结构化 JSON', usage);
    return { result, usage, ...(sessionId ? { sessionId } : {}) };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '结构化 JSON');
    throw error;
  }
}
