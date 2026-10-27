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

export interface WorkbuddyAgent {
  provider: string;
  model: string;
}

export function buildCombinedPrompt(prompt: string, systemPrompt: string): string {
  return [systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '', 'USER REQUEST:\n' + prompt]
    .filter(Boolean).join('\n\n');
}

/**
 * query() exposes the documented Options contract (thinking/effort/fallbackModel).
 * V2 SessionOptions currently documents a narrower contract, so task profiles use query()
 * rather than silently passing unsupported fields to unstable_v2_createSession().
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

async function queryWorkbuddyRaw(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  options: Record<string, any>,
  _requestId = 'unknown',
  timeoutMs = REQUEST_TIMEOUT_MS,
  onSessionId?: (sessionId: string) => void,
  contextWindow?: number,
): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null; sessionId?: string; resolvedModels: string[] }> {
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
      + ' · 上限可用 LOCAL_AGENT_TIMEOUT_MS（单次调用）/ LOCAL_AGENT_ANALYSIS_TIMEOUT_MS（全书预处理）调整');
    requestInterrupt();
    rejectTimeout(timeoutError());
  }, timeoutMs);
  timer.unref?.();

  let text = '';
  let structuredOutput: unknown;
  let usage: TurnUsage | null = null;
  let sessionId: string | undefined;
  const resolvedModels = new Set<string>();
  let messageCount = 0;
  let iterator: AsyncIterator<unknown> | undefined;

  try {
    // Start the deadline before the dynamic SDK import so a stalled initialization also fails visibly.
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
        // Only the temporary project seed is loaded. Host settings/Skills/MCP remain disabled.
        settingSources: ['project'],
      };
    }

    query = sdk.query({ prompt: buildCombinedPrompt(prompt, systemPrompt), options: effectiveOptions });
    if (timedOut) requestInterrupt();

    iterator = query[Symbol.asyncIterator]();
    const consume = (async () => {
      try {
        for (;;) {
          // Interrupt alone may not end stream(); the race makes the request deadline authoritative.
          const next = await Promise.race([iterator!.next(), timeoutPromise]);
          if (next.done) break;
          const message = next.value;
          const raw: any = message && typeof message === 'object' ? message : {};
          messageCount += 1;
          // SDK init events carry the durable session_id needed to resume a later workflow stage.
          const observedSessionId = [raw.session_id, raw.sessionId, raw.session?.id, raw.message?.session_id]
            .find((value) => typeof value === 'string' && value.trim());
          if (typeof observedSessionId === 'string' && observedSessionId !== sessionId) {
            sessionId = observedSessionId;
            onSessionId?.(sessionId);
          }
          if (raw.type === 'assistant' && raw.message && typeof raw.message.model === 'string') {
            const model = raw.message.model.trim();
            if (model && model.toLowerCase() !== 'auto') resolvedModels.add(model);
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
            if (raw.modelUsage && typeof raw.modelUsage === 'object') {
              for (const model of Object.keys(raw.modelUsage)) {
                if (model && model.toLowerCase() !== 'auto') resolvedModels.add(model);
              }
            }
            usage = parseTurnUsage(raw);
          }
        }
      } finally {
        // Stop local consumption after timeout; late messages must not mutate the host run.
        if (timedOut && iterator?.return) {
          void Promise.resolve(iterator.return()).catch(() => {});
        }
      }
    })();

    // Long tasks may be quiet for minutes; heartbeats are telemetry, not a progress guarantee.
    if (timeoutMs > 60_000) {
      heartbeat = setInterval(() => {
        logInfo('agent', '调用仍在进行 · 已等待 ' + ((Date.now() - startedAt) / 1000).toFixed(0) + 's'
          + ' · 事件 ' + messageCount + ' 条 · 已收文本 ' + text.length + ' 字 · request=' + String(_requestId).slice(0, 40));
      }, 30_000);
      heartbeat.unref?.();
    }

    await Promise.race([consume, timeoutPromise]);
    if (timedOut) throw timeoutError();
    return { text: text.trim(), structuredOutput, usage, resolvedModels: Array.from(resolvedModels), ...(sessionId ? { sessionId } : {}) };
  } catch (error) {
    if (timedOut) throw timeoutError();
    if (query) {
      requestInterrupt();
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
    }
    // Keep configuration/input validation errors readable when no SDK query was created.
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    contextWorkspace?.cleanup();
  }
}

function createCodeBuddyContextWindowWorkspace(contextWindow: number): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'vocal-saga-codebuddy-context-window-'));
  try {
    const configDir = path.join(cwd, '.codebuddy');
    mkdirSync(configDir, { recursive: true });
    // Preserve only project-level model definitions. The file may contain an API key,
    // so the temporary copy is owner-readable only and removed with the workspace.
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

export async function runWorkbuddy(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
): Promise<{ text: string; usage: TurnUsage | null; resolvedModels?: string[] }> {
  // Task profiles must go through query() so thinking/effort/fallbackModel are honored.
  if (taskProfile) {
    const result = await queryWorkbuddyRaw(
      agent, prompt, systemPrompt, buildWorkbuddyOptions(agent, undefined, taskProfile), requestId,
      REQUEST_TIMEOUT_MS, undefined, taskProfile.contextWindow,
    );
    if (!result.text) throw new Error('Workbuddy 已结束，但没有返回译文');
    return { text: result.text, usage: result.usage, resolvedModels: result.resolvedModels };
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

export function resolveWorkbuddyStructured(structuredOutput: unknown, text: string): Record<string, any> | any[] {
  if (structuredOutput && typeof structuredOutput === 'object') {
    return structuredOutput as Record<string, any> | any[];
  }
  const parsed = parseJsonValue(text);
  if (parsed !== null) return parsed;
  throw new Error('Workbuddy 返回内容不是有效 JSON');
}

export function resolveWorkbuddyJson(structuredOutput: unknown, text: string): Record<string, any> {
  const parsed = resolveWorkbuddyStructured(structuredOutput, text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
}

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
): Promise<{ parsed: Record<string, any> | any[]; usage: TurnUsage | null; sessionId?: string; resolvedModels?: string[] }> {
  let result: { text: string; structuredOutput: unknown; usage: TurnUsage | null; sessionId?: string };
  // 长任务（全书预处理）显式放宽上限；普通翻译批次沿用 REQUEST_TIMEOUT_MS。
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (taskProfile || options.persistSession || options.sessionId) {
    // Persistent workflow turns must bypass the shared pool so they can resume their exact SDK Session.
    // Query Options formally supports reasoning settings; SessionOptions does not expose them.
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
    parsed: resolveWorkbuddyStructured(result.structuredOutput, result.text),
    usage: result.usage,
    resolvedModels: result.resolvedModels || [],
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

export async function runWorkbuddyJson(
  agent: WorkbuddyAgent,
  prompt: string,
  systemPrompt: string,
  schema: Record<string, unknown>,
  requestId = 'unknown',
  sessionScope?: string,
  taskProfile?: CodeBuddyTaskProfile,
  options: { timeoutMs?: number } = {},
): Promise<{ parsed: Record<string, any>; usage: TurnUsage | null; resolvedModels?: string[] }> {
  const result = await runWorkbuddyStructured(agent, prompt, systemPrompt, schema, requestId, sessionScope, taskProfile, options);
  if (!result.parsed || typeof result.parsed !== 'object' || Array.isArray(result.parsed)) {
    throw new Error('Workbuddy 返回内容不是预期 JSON 对象');
  }
  return { parsed: result.parsed as Record<string, any>, usage: result.usage, resolvedModels: result.resolvedModels || [] };
}
