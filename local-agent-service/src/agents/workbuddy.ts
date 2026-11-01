import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJsonValue } from '../json.ts';
import { getTextPool } from './workbuddyPool.ts';
import { parseTurnUsage, type TurnUsage } from './usage.ts';
import { codeBuddyThinkingOption, type CodeBuddyTaskProfile } from './taskProfiles.ts';
import {
  getCodeBuddyContextWindowOption,
  readModelCatalog,
  resolveCodeBuddyContextWindow,
  resolveWorkbuddyModel,
} from './modelCatalog.ts';
import { logInfo, logWarn } from '../log.ts';

const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const JSON_MODE_MAX_TURNS = 5;

/** workbuddy 通道的调用参数：模型、会话作用域与是否复用会话。 */
export interface WorkbuddyAgent {
  provider: string;
  model: string;
}

/**
 * 将 system 与 user prompt 合并为 SDK 所需的单一 prompt 文本，system 部分带 "SYSTEM INSTRUCTIONS:" 前缀。
 */
export function buildCombinedPrompt(prompt: string, systemPrompt: string): string {
  return [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
}

/**
 * 构造 CodeBuddy SDK 的调用选项：无 schema 时禁用工具、maxTurns=1；有 schema 时启用 StructuredOutput 工具
 * 并通过 json_schema 约束输出。canUseTool 仅允许 StructuredOutput，拒绝其余工具。
 */
export function buildWorkbuddyOptions(
  agent: WorkbuddyAgent,
  schema?: Record<string, unknown>,
  taskProfile?: CodeBuddyTaskProfile,
  workflowSession: { sessionId?: string; persistSession?: boolean } = {},
) {
  const canUseTool = async (toolName: string) => {
    if (schema && toolName === STRUCTURED_OUTPUT_TOOL) return { behavior: 'allow' as const };
    return { behavior: 'deny' as const, message: '本机翻译 Provider 不允许执行工具：' + toolName };
  };
  const base = {
    ...(agent.model ? { model: agent.model } : {}),
    ...(taskProfile?.fallbackModel ? { fallbackModel: taskProfile.fallbackModel } : {}),
    cwd: WORK_DIR,
    permissionMode: 'default' as const,
    settingSources: [],
    persistSession: workflowSession.persistSession ?? false,
    ...(workflowSession.sessionId ? { resume: workflowSession.sessionId } : {}),
    thinking: taskProfile ? codeBuddyThinkingOption(taskProfile) : schema
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const },
    effort: taskProfile?.effort || (schema ? 'medium' as const : 'low' as const),
    canUseTool,
  };
  if (!schema) return { ...base, tools: [], allowedTools: [], maxTurns: 1 };
  return {
    ...base,
    tools: [STRUCTURED_OUTPUT_TOOL],
    allowedTools: [STRUCTURED_OUTPUT_TOOL],
    maxTurns: JSON_MODE_MAX_TURNS,
    outputFormat: { type: 'json_schema' as const, schema },
    extraArgs: { 'json-schema': JSON.stringify(schema) },
  };
}

/**
 * 底层 Workbuddy 调用：动态导入 SDK，发起 query，流式消费消息，提取文本/structuredOutput/usage/sessionId。
 * 带超时、心跳日志、中断与临时 context window 工作区清理；contextWindow 指定时校验模型档位并创建临时 cwd。
 */
async function queryWorkbuddyRaw(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
  _requestId = 'unknown',
  timeoutMs = REQUEST_TIMEOUT_MS,
  onSessionId?: (sessionId: string) => void,
  contextWindow?: number,
): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null; sessionId?: string }> {
  const startedAt = Date.now();
  let effectiveOptions = options;
  let contextWorkspace: { cwd: string; cleanup: () => void } | undefined;
  let query: (AsyncIterable<unknown> & { interrupt?: () => unknown }) | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let rejectTimeout!: (error: Error) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const requestInterrupt = (): void => {
    if (!query) return;
    try { Promise.resolve(query.interrupt?.()).catch(() => {}); } catch { /* timeout remains authoritative */ }
  };
  const timeoutError = () => new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）');
  timer = setTimeout(() => {
    timedOut = true;
    logWarn('agent', '一次性调用超时 · ' + (timeoutMs / 1000).toFixed(0) + 's · request=' + String(_requestId).slice(0, 40)
      + ' · 上限可用 LOCAL_AGENT_TIMEOUT_MS（普通调用）/ LOCAL_AGENT_REVIEW_TIMEOUT_MS（审校）/ LOCAL_AGENT_ANALYSIS_TIMEOUT_MS（全书预处理）调整');
    requestInterrupt();
    rejectTimeout(timeoutError());
  }, timeoutMs);
  timer.unref?.();

  let text = '';
  let structuredOutput: unknown;
  let usage: TurnUsage | null = null;
  let sessionId: string | undefined;
  let messageCount = 0;
  let iterator: AsyncIterator<unknown> | undefined;

  try {
    // 先开始计时，再动态导入 SDK：这样初始化卡住也能显式失败。
    const sdk = await Promise.race([import('@tencent-ai/agent-sdk'), timeoutPromise]);
    if (contextWindow !== undefined) {
      const catalog = readModelCatalog({ projectRoot: WORK_DIR });
      const effectiveModel = resolveWorkbuddyModel(agent.model, catalog) || agent.model;
      const model = catalog.find((item) => item.id === effectiveModel);
      const validTier = resolveCodeBuddyContextWindow(model, contextWindow);
      const option = getCodeBuddyContextWindowOption(model, contextWindow);
      if (validTier === undefined || !option?.options.some((item) => item.value === String(contextWindow))) {
        throw new Error('当前 Workbuddy 模型不支持指定的 context window 档位；请刷新配置选项后重试');
      }
      contextWorkspace = createCodeBuddyContextWindowWorkspace(validTier);
      effectiveOptions = {
        ...options,
        cwd: contextWorkspace.cwd,
        // 只加载临时的项目级种子配置。宿主的设置、Skills、MCP 全部保持关闭。
        settingSources: ['project'],
      };
    }

    query = sdk.query({ prompt: buildCombinedPrompt(prompt, systemPrompt), options: effectiveOptions });
    if (timedOut) requestInterrupt();

    iterator = query[Symbol.asyncIterator]();
    const consume = (async () => {
      try {
        for (;;) {
          // 光靠 Interrupt 未必能让 stream() 结束；这个竞速让请求截止时间说了算。
          const next = await Promise.race([iterator!.next(), timeoutPromise]);
          if (next.done) break;
          const message = next.value;
          const raw: any = message && typeof message === 'object' ? message : {};
          messageCount += 1;
          // SDK 的 init 事件带着持久的 session_id，后续工作流阶段要靠它续聊。
          const observedSessionId = [raw.session_id, raw.sessionId, raw.session?.id, raw.message?.session_id]
            .find((value) => typeof value === 'string' && value.trim());
          if (typeof observedSessionId === 'string' && observedSessionId !== sessionId) {
            sessionId = observedSessionId;
            onSessionId?.(sessionId);
          }
          if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
            for (const part of raw.message.content) {
              if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                text += (text ? '\n' : '') + part.text;
              }
            }
          }
          if (raw.type === 'result') {
            if (raw.subtype && raw.subtype !== 'success') {
              throw new Error('Workbuddy 执行失败：' + String(raw.error?.message || raw.error || raw.subtype));
            }
            if (raw.structured_output !== undefined) structuredOutput = raw.structured_output;
            usage = parseTurnUsage(raw);
          }
        }
      } finally {
        // 超时之后停止本地消费；迟到的消息不得再改动宿主 Run。
        if (timedOut && iterator?.return) {
          void Promise.resolve(iterator.return()).catch(() => {});
        }
      }
    })();

    // 长任务可能几分钟没动静；心跳是遥测，不构成进度承诺。
    if (timeoutMs > 60_000) {
      heartbeat = setInterval(() => {
        logInfo('agent', '调用仍在进行 · 已等待 ' + ((Date.now() - startedAt) / 1000).toFixed(0) + 's'
          + ' · 事件 ' + messageCount + ' 条 · 已收文本 ' + text.length + ' 字 · request=' + String(_requestId).slice(0, 40));
      }, 30_000);
      heartbeat.unref?.();
    }

    await Promise.race([consume, timeoutPromise]);
    if (timedOut) throw timeoutError();
    return { text: text.trim(), structuredOutput, usage, ...(sessionId ? { sessionId } : {}) };
  } catch (error) {
    if (timedOut) throw timeoutError();
    if (query) {
      requestInterrupt();
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
    }
    // 一个 SDK query 都没建起来时，配置或入参校验错误也要保持可读。
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    contextWorkspace?.cleanup();
  }
}

/**
 * 为指定 context window 档位创建临时工作目录：复制 models.json（mode 0o600）并写入 settings.json，
 * 调用结束后由 cleanup 删除。失败时清理目录并抛错。
 */
function createCodeBuddyContextWindowWorkspace(contextWindow: number): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'vocal-saga-codebuddy-context-window-'));
  try {
    const configDir = path.join(cwd, '.codebuddy');
    mkdirSync(configDir, { recursive: true });
    // 只保留项目级的模型定义。这个文件可能含 API key，
    // 所以临时副本仅属主可读，并随工作区一起删除。
    const sourceModels = path.join(WORK_DIR, '.codebuddy', 'models.json');
    if (existsSync(sourceModels)) {
      writeFileSync(path.join(configDir, 'models.json'), readFileSync(sourceModels), { mode: 0o600 });
    }
    writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ contextWindow }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/**
 * 文本模式 Workbuddy 调用：有 taskProfile 时走 query()（支持 thinking/effort），否则走共享文本池。
 * 返回文本与 usage；空输出抛错。
 */
export async function runWorkbuddy(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<{ text: string; usage: TurnUsage | null }> {
  // 任务档案必须走 query()，thinking/effort/fallbackModel 才会被采纳。
  if (taskProfile) {
    const result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, undefined, taskProfile), requestId,
      REQUEST_TIMEOUT_MS, undefined, taskProfile.contextWindow,
    );
    if (!result.text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return { text: result.text, usage: result.usage };
  }
  const pool = getTextPool();
  const index = await pool.acquire(agent, sessionScope || 'shared-text-translation');
  try {
    const firstMessage = !sessionScope || pool.isFresh(index)
      ? buildCombinedPrompt(prompt, systemPrompt)
      : prompt;
    const result = await pool.runPrompt(index, firstMessage, requestId);
    if (!result.text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return { text: result.text, usage: result.usage };
  } finally {
    pool.release(index);
  }
}

/**
 * 优先使用 SDK 返回的 structuredOutput；否则从文本中解析 JSON（含数组）。解析失败抛错。
 */
export function resolveWorkbuddyStructured(structuredOutput: unknown, text: string, context = ''): Record<string, any> | any[] {
  if (structuredOutput && typeof structuredOutput === 'object') {
    return structuredOutput as Record<string, any> | any[];
  }
  const parsed = parseJsonValue(text, context);
  if (parsed !== null) return parsed;
  throw new Error('Workbuddy 返回内容不是有效 JSON');
}

/**
 * 在 resolveWorkbuddyStructured 基础上要求结果为 JSON 对象（非数组）。
 */
export function resolveWorkbuddyJson(structuredOutput: unknown, text: string, context = ''): Record<string, any> {
  const parsed = resolveWorkbuddyStructured(structuredOutput, text, context);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
}

/**
 * 结构化 Workbuddy 调用：根据 taskProfile/sessionScope 决定走 query() 或共享池，支持超时与 session 恢复。
 * 返回 parsed + usage + sessionId。
 */
export async function runWorkbuddyStructured(
  agent: WorkbuddyAgent,
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
): Promise<{ parsed: Record<string, any> | any[]; usage: TurnUsage | null; sessionId?: string }> {
  let result: { text: string; structuredOutput: unknown; usage: TurnUsage | null; sessionId?: string };
  // 长任务（全书预处理）显式放宽上限；普通翻译批次沿用 REQUEST_TIMEOUT_MS。
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (taskProfile || options.persistSession || options.sessionId) {
    // 持久化工作流的轮次必须绕过共享池，才能续上它那个确切的 SDK 会话。
    // Query Options 正式支持推理相关设置；SessionOptions 不暴露它们。
    result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt,
      buildWorkbuddyOptions(agent, schema, taskProfile, options),
      requestId, timeoutMs, options.onSessionId, taskProfile?.contextWindow,
    );
  } else if (sessionScope) {
    const pool = getTextPool();
    const index = await pool.acquire(agent, sessionScope, schema);
    try {
      const promptForTurn = pool.isFresh(index) ? buildCombinedPrompt(prompt, systemPrompt) : prompt;
      const value = await pool.runPrompt(index, promptForTurn, requestId, timeoutMs);
      result = { text: value.text, structuredOutput: value.structuredOutput, usage: value.usage };
    } finally {
      pool.release(index);
    }
  } else {
    result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, schema, undefined, options),
      requestId, timeoutMs, options.onSessionId,
    );
  }
  return {
    parsed: resolveWorkbuddyStructured(result.structuredOutput, result.text, 'request=' + String(requestId).slice(0, 40)),
    usage: result.usage,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

/**
 * 在 runWorkbuddyStructured 基础上要求结果为 JSON 对象。
 */
export async function runWorkbuddyJson(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: { timeoutMs?: number } = {},
): Promise<{ parsed: Record<string, any>; usage: TurnUsage | null }> {
  const result = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope, taskProfile, options);
  if (!result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
    throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
  }
  return { parsed: result.parsed as Record<string, any>, usage: result.usage };
}
