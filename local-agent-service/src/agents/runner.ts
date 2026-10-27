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

function logModelStart(
  agent: AgentSpec, prompt: string, systemPrompt: string, requestId: string,
  sessionScope: string | undefined, mode: string,
): void {
  if (isWorkflowManaged(sessionScope)) return;
  logInfo('model', describeTask(requestId, sessionScope) + ' · 开始 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 模式=' + mode + ' · 输入=' + prompt.length.toLocaleString() +
    ' 字符 · 系统指令=' + systemPrompt.length.toLocaleString() + ' 字符');
}

function logModelSuccess(
  agent: AgentSpec, output: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string, usage: TurnUsage | null = null,
): void {
  if (isWorkflowManaged(sessionScope)) return;
  logInfo('model', describeTask(requestId, sessionScope) + ' · 完成 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') +
    ' · 耗时=' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's · 输出=' + compactOutputSummary(output) +
    ' · ' + formatTurnUsageLog(usage) + ' · 模式=' + mode);
}

function logModelFailure(
  agent: AgentSpec, error: unknown, requestId: string, sessionScope: string | undefined,
  startedAt: number, mode: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const duration = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
  if (isWorkflowManaged(sessionScope)) return;
  logError('model', describeTask(requestId, sessionScope) + ' · 失败 · request=' + requestId.slice(0, 12) +
    ' · ' + agent.provider + '/' + (agent.model || '运行时默认模型') + ' · 耗时=' + duration + ' · ' + message);
  if (process.env.LOCAL_AGENT_LOG_LEVEL === 'debug' && error instanceof Error && error.stack) {
    logError('model', error.stack);
  }
}

export interface AgentRunResult<T> {
  result: T;
  usage: TurnUsage | null;
  /** User/provider configuration before per-task model overrides. */
  requestedModel?: string;
  /** Model passed to the underlying provider after task-profile resolution. */
  effectiveModel?: string;
  /** Models actually reported by the provider, including fallbacks if any. */
  resolvedModels?: string[];
  provider?: string;
  /** Present for persistent CodeBuddy query() sessions used by resumable workflows. */
  sessionId?: string;
}

/** Unified model invocation; document tasks can supply immutable per-task settings. */
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
    let resolvedModels: string[] = [];
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddy(effectiveAgent, effective.prompt, effective.systemPrompt, requestId, sessionScope, taskProfile);
      output = r.text;
      usage = r.usage;
      resolvedModels = r.resolvedModels || [];
    } else if (effectiveAgent.provider === 'opencode') {
      output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, output, requestId, sessionScope, startedAt, '文本', usage);
    return {
      result: output,
      usage,
      provider: effectiveAgent.provider,
      requestedModel: agent.model || '<runtime-default>',
      effectiveModel: effectiveAgent.model || '<runtime-default>',
      resolvedModels,
    };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '文本');
    throw error;
  }
}

export async function runAgentJson(
  agent: AgentSpec,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
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
    let resolvedModels: string[] = [];
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddyJson(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile);
      parsed = r.parsed;
      usage = r.usage;
      resolvedModels = r.resolvedModels || [];
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
      const value = parseJsonValue(output);
      if (!value || Array.isArray(value)) throw new Error('OpenCode 返回内容不是预期 JSON 对象');
      parsed = value as Record<string, any>;
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, parsed, requestId, sessionScope, startedAt, 'JSON 对象', usage);
    return {
      result: parsed,
      usage,
      provider: effectiveAgent.provider,
      requestedModel: agent.model || '<runtime-default>',
      effectiveModel: effectiveAgent.model || '<runtime-default>',
      resolvedModels,
    };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, 'JSON 对象');
    throw error;
  }
}

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
    let resolvedModels: string[] = [];
    if (effectiveAgent.provider === 'workbuddy') {
      const r = await runWorkbuddyStructured(effectiveAgent, effective.prompt, effective.systemPrompt, schema, requestId, sessionScope, taskProfile, options);
      result = r.parsed;
      usage = r.usage;
      sessionId = r.sessionId;
      resolvedModels = r.resolvedModels || [];
    } else if (effectiveAgent.provider === 'opencode') {
      const output = await runOpenCode(effectiveAgent, effective.prompt, effective.systemPrompt);
      const value = parseJsonValue(output);
      if (value === null) throw new Error('OpenCode 返回内容不是有效 JSON');
      result = value;
    } else {
      throw new Error('不支持的本机 Agent：' + effectiveAgent.provider);
    }
    logModelSuccess(effectiveAgent, result, requestId, sessionScope, startedAt, '结构化 JSON', usage);
    return {
      result,
      usage,
      provider: effectiveAgent.provider,
      requestedModel: agent.model || '<runtime-default>',
      effectiveModel: effectiveAgent.model || '<runtime-default>',
      resolvedModels,
      ...(sessionId ? { sessionId } : {}),
    };
  } catch (error) {
    logModelFailure(effectiveAgent, error, requestId, sessionScope, startedAt, '结构化 JSON');
    throw error;
  }
}
