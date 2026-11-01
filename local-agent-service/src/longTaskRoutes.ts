/**
 * 长任务端点：OpenAI 兼容 chat completions、文学分析、独立审校。
 *
 * 三个端点共享同一套长任务收尾逻辑——记录 requestId/耗时、成功与失败都写 request_history、
 * 失败按端点返回 OpenAI 兼容或标准错误信封。它们与同步 API 的区别就在这里：
 * 无论成败都留痕，便于按 request ID 关联排查。
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { LOG_RESPONSE_PREVIEW, STORE_CONTENT } from './config.ts';
import { requestMetadata, saveHistory } from './db.ts';
import { sendApiError, sendJson } from './middleware.ts';
import { logError, logInfo } from './log.ts';
import { normalizeMessages, parseAgentModel, parseJsonValue } from './json.ts';
import { runAgent, runAgentStructured } from './agents/runner.ts';
import { getCodeBuddyTaskProfile } from './agents/taskProfiles.ts';
import { runLiteraryAnalysis } from './literary.ts';
import {
  buildStandaloneReviewContextGraph,
  buildStandaloneReviewMemory,
  buildStandaloneReviewVoiceContext,
  runLiteraryReviewWithMissingRetry,
} from './documents/translationAgent.ts';

type Agent = { provider: string; model: string };

/** 长任务端点白名单；其余路径由调用方回 404。 */
const SUPPORTED_LONG_TASKS = new Set([
  'POST /v1/chat/completions',
  'POST /api/translate/document/literary/analyze',
  'POST /api/translate/document/literary/review',
]);

export function isSupportedLongTask(req: Request, url: URL): boolean {
  return SUPPORTED_LONG_TASKS.has(req.method + ' ' + url.pathname);
}

/**
 * 文档会话作用域键：按文档指纹/角色/模型/语言方向/Prompt 签名隔离会话。
 *
 * 无效或缺失的 documentSessionId 返回 undefined，保留一次性/共享行为。
 */
function buildDocumentSessionScope(
  body: any,
  agent: Agent,
  role: 'translation' | 'analysis' | 'review',
  metadata?: any,
): string | undefined {
  const source = metadata || body || {};
  const documentSessionId = typeof source.documentSessionId === 'string' ? source.documentSessionId : '';
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(documentSessionId)) return undefined;
  // 提示词一改就必须新建 Session。用户改了系统/用户模板之后还复用旧会话，
  // 会继续用着旧的系统指令。
  const promptSignature = [
    typeof source.systemPromptOverride === 'string' ? source.systemPromptOverride : '',
    typeof source.userPromptTemplate === 'string' ? source.userPromptTemplate : '',
  ].join('\u0000');
  // FNV-1a 哈希：Prompt 变化时生成新的会话作用域，避免复用旧系统指令。
  let promptHash = 0x811c9dc5;
  for (let index = 0; index < promptSignature.length; index++) {
    promptHash = Math.imul(promptHash ^ promptSignature.charCodeAt(index), 0x01000193);
  }
  const parts = [
    role,
    agent.provider,
    agent.model || '<runtime-default>',
    String(source.sourceLang || body?.source || ''),
    String(source.targetLang || body?.target || ''),
    String(source.promptStyle || body?.promptStyle || 'default'),
    String(source.translationMode || body?.translationMode || 'technical'),
    String(source.sessionLane || 'main'),
    String(source.contextVersion || 'book-session-v3'),
    'prompt-' + (promptHash >>> 0).toString(16),
  ];
  return 'document:' + documentSessionId + ':' + parts.map((value) => value.slice(0, 80)).join(':');
}

/** 一次长任务的结果：正文用于写历史，agent 用于日志与错误信封。 */
type LongTaskOutcome = { agent: Agent; output: string };

/**
 * 长任务入口：统一记录开始时间与 request ID，成功/失败都写 request_history 与结构化日志。
 */
export async function handleLongTaskRequest(req: Request, res: Response, url: URL): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  // 请求上下文默认值：body/agent/output 在 try 中填充，catch 中复用。
  let body: any = {};
  let agent: Agent = { provider: 'unknown', model: '' };
  let output = '';
  try {
    body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('JSON 请求体必须是对象'), { status: 400 });
    }
    const outcome = url.pathname === '/v1/chat/completions'
      ? await runChatCompletion(res, url, body, requestId)
      : url.pathname.endsWith('/analyze')
        ? await runLiteraryAnalysisRequest(res, url, body, requestId)
        : await runStandaloneReview(res, url, body, requestId);
    agent = outcome.agent;
    output = outcome.output;

    const durationMs = Date.now() - startedAt;
    saveHistory({ id: requestId, endpoint: url.pathname, agent, body, output,
      durationMs, status: 'success' });
    logInfo('local-agent',
      '[' + requestId + '] success endpoint=' + url.pathname +
      ' provider=' + agent.provider +
      ' model=' + (agent.model || '<runtime-default>') +
      ' durationMs=' + durationMs +
      ' outputChars=' + output.length,
    );
  // 统一错误处理：记录历史与日志，按端点返回 OpenAI 兼容或标准错误信封。
  } catch (error: any) {
    await reportLongTaskFailure({ req, res, url, requestId, startedAt, body, agent, output, error });
  }
}

/** OpenAI 兼容 chat completions：支持文本与 JSON/结构化输出模式。 */
async function runChatCompletion(res: Response, url: URL, body: any, requestId: string): Promise<LongTaskOutcome> {
  if (typeof body.model !== 'string' || !body.model.trim()) throw Object.assign(new Error('model 是必填字段'), { status: 400 });
  const normalized = normalizeMessages(body.messages);
  const agent = parseAgentModel(body.model);
  const jsonMode = body.response_format?.type === 'json_object';
  // 严格 schema 模式：--json-schema 约束解码，逼模型吐完整结构。
  // 用途是重试升级轮（普通 json_object 只保证"是 JSON"，不保证形状）。
  const jsonSchema = body.response_format?.type === 'json_schema' &&
    body.response_format.json_schema && typeof body.response_format.json_schema === 'object' &&
    !Array.isArray(body.response_format.json_schema)
    ? body.response_format.json_schema as Record<string, unknown>
    : undefined;
  if (body.response_format?.type === 'json_schema' && !jsonSchema) {
    throw Object.assign(new Error('response_format.json_schema 必须是非空对象'), { status: 400 });
  }
  const prompt = jsonMode
    ? normalized.userPrompt + '\n\n输出约束：只返回与系统指令和用户请求一致的严格合法 JSON 对象或数组，不要 Markdown、前言或后记。'
    : normalized.userPrompt;
  const requestMeta = requestMetadata(body);
  logInfo('local-agent',
    '[' + requestId + '] start endpoint=' + url.pathname +
    ' provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' inputChars=' + requestMeta.inputChars +
    ' jsonMode=' + String(jsonMode) +
    ' structured=' + String(!!jsonSchema) +
    ' storeContent=' + String(STORE_CONTENT),
  );
  // 为文档任务构建会话作用域，复用同一文档/角色的对话历史。
  const sessionScope = buildDocumentSessionScope(body, agent, 'translation', body.metadata);
  const taskProfiles = body.metadata?.taskProfiles;
  const taskProfile = taskProfiles && typeof taskProfiles === 'object'
    ? getCodeBuddyTaskProfile({ taskProfiles }, 'translation')
    : undefined;
  if (sessionScope) {
    logInfo('local-agent', '[' + requestId + '] session-scope role=translation scope=document-task');
  }
  let turnUsage: { result: unknown; usage: unknown } | null = null;
  let output: string;
  if (jsonSchema) {
    const structured = await runAgentStructured(agent, prompt, normalized.systemPrompt, jsonSchema, requestId, sessionScope, taskProfile);
    output = JSON.stringify(structured.result);
    turnUsage = structured;
  } else {
    const r = await runAgent(agent, prompt, normalized.systemPrompt, requestId, sessionScope, taskProfile);
    output = r.result;
    turnUsage = r;
    if (jsonMode) output = parseJsonObjectOutput(output, requestId, url.pathname, agent);
  }
  // usage 填真实计量值（费用口径 = token 数；CodeBuddy 订阅的 total_cost_usd 恒为 0），
  // 供扩展端与本机客户端展示每轮消耗；计量不可用时保持 0 以兼容 OpenAI 客户端。
  const usageMeta = turnUsage?.usage as { inputTokens?: number; outputTokens?: number } | null | undefined;
  sendJson(res, 200, {
    id: 'chatcmpl-' + requestId, object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: usageMeta?.inputTokens ?? 0,
      completion_tokens: usageMeta?.outputTokens ?? 0,
      total_tokens: (usageMeta?.inputTokens ?? 0) + (usageMeta?.outputTokens ?? 0),
    },
  });
  return { agent, output };
}

/** json_object 模式下的输出校验：不是合法 JSON 就当作失败，避免把半截文本当成结果存进历史。 */
function parseJsonObjectOutput(output: string, requestId: string, pathname: string, agent: Agent): string {
  const parsedOutput = parseJsonValue(output, 'request=' + requestId.slice(0, 40) + ' endpoint=' + pathname);
  if (!parsedOutput) {
    const preview = LOG_RESPONSE_PREVIEW
      ? ' preview=' + JSON.stringify(output.slice(0, 600))
      : ' preview=<disabled>';
    logError('local-agent',
      '[' + requestId + '] invalid-json endpoint=' + pathname +
      ' provider=' + agent.provider +
      ' model=' + (agent.model || '<runtime-default>') +
      ' outputChars=' + output.length + preview,
    );
    throw new Error(
      '本机 Agent 返回内容不是有效 JSON（输出 ' + output.length +
      ' 字符）；详情见本机服务日志。请检查本机模型输出或重试该批次',
    );
  }
  return JSON.stringify(parsedOutput);
}

/** 文学分析端点：调用 runLiteraryAnalysis 生成实体/关系等。 */
async function runLiteraryAnalysisRequest(res: Response, url: URL, body: any, requestId: string): Promise<LongTaskOutcome> {
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  logStart(url.pathname, requestId, agent, body);
  // 分析任务的会话作用域（与翻译/审校隔离）。
  const sessionScope = buildDocumentSessionScope(body, agent, 'analysis');
  const result = await runLiteraryAnalysis(body, requestId, sessionScope);
  sendJson(res, 200, result);
  return { agent, output: JSON.stringify(result) };
}

/**
 * 独立审校端点。
 *
 * 旧的独立 Reviewer 仍服务于「重新审校这个片段」这类显式操作。
 * 给它和 Project Run 一样的确定性规范名保护，
 * 但不要把全书记忆里无关的未来别名发过去。
 * 独立审校不绑定服务端不可变的 Run。绝不要相信客户端给的
 * TranslationBrief/voiceContext；两者都要用本次提交的源文、
 * 以及服务端过滤过的、有源文依据的文学记忆投影重建。
 */
async function runStandaloneReview(res: Response, url: URL, body: any, requestId: string): Promise<LongTaskOutcome> {
  const agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
  logStart(url.pathname, requestId, agent, body);
  // 审校任务的会话作用域（与翻译/分析隔离）。
  const sessionScope = buildDocumentSessionScope(body, agent, 'review');
  // 独立审校：重建来源可信的记忆/Context Graph，不信任客户端提供的 TranslationBrief。
  const precedingSegments = Array.isArray(body.precedingSegments)
    ? body.precedingSegments.slice(-4).flatMap((item: any) => {
        if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) return [];
        return [{
          id: item.id.slice(0, 160),
          text: item.text.slice(-900),
          contextPath: typeof item.contextPath === 'string' ? item.contextPath.slice(0, 160) : '',
        }];
      })
    : [];
  const standaloneInput = { ...body, precedingSegments };
  const safeMemory = buildStandaloneReviewMemory(standaloneInput);
  const safeInput = { ...standaloneInput, memory: safeMemory };
  const reviewInput = {
    ...body,
    memory: safeMemory,
    // 这里是刻意替换而不是展开客户端对象。客户端传来的图谱/哈希、
    // 章节摘要、近期示例、声音上下文，一律不许从这个路由穿过去。
    translationBrief: {
      policyVersion: 'standalone-review-v1-source-grounded',
      precedingSegments,
      glossary: {
        document_terms: safeMemory.entities.map((entity: any) => ({
          source: entity.source,
          target: entity.target,
          aliases: entity.aliases,
          kind: entity.kind,
          reviewStatus: 'confirmed',
        })),
      },
      contextGraph: buildStandaloneReviewContextGraph(safeInput),
      voiceContext: buildStandaloneReviewVoiceContext(safeInput),
    },
  };
  const result = await runLiteraryReviewWithMissingRetry(reviewInput, requestId, sessionScope);
  sendJson(res, 200, result);
  return { agent, output: JSON.stringify(result) };
}

/** 分析/审校共用的启动日志：体积指标口径一致，便于横向比较耗时。 */
function logStart(pathname: string, requestId: string, agent: Agent, body: any): void {
  logInfo('local-agent',
    '[' + requestId + '] start endpoint=' + pathname +
    ' provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' inputChars=' + JSON.stringify(body.segments || []).length +
    ' segments=' + (Array.isArray(body.segments) ? body.segments.length : 0) +
    ' storeContent=' + String(STORE_CONTENT),
  );
}

/** 长任务失败收尾：历史、日志、堆栈与按端点的错误信封。 */
async function reportLongTaskFailure(input: {
  req: Request;
  res: Response;
  url: URL;
  requestId: string;
  startedAt: number;
  body: any;
  agent: Agent;
  output: string;
  error: any;
}): Promise<void> {
  const { res, url, requestId, startedAt, body, agent, output, error } = input;
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const message = error instanceof Error ? error.message : String(error);
  const durationMs = Date.now() - startedAt;
  const requestMeta = requestMetadata(body || {});
  saveHistory({ id: requestId, endpoint: url.pathname, agent, body, output,
    error: message, durationMs, status: 'error' });
  logError('local-agent',
    '[' + requestId + '] failed endpoint=' + url.pathname +
    ' provider=' + agent.provider +
    ' model=' + (agent.model || '<runtime-default>') +
    ' status=' + status +
    ' durationMs=' + durationMs +
    ' inputChars=' + requestMeta.inputChars +
    ' outputChars=' + output.length +
    ' error=' + message,
  );
  if (error instanceof Error && error.stack) {
    logError('local-agent', '[' + requestId + '] stack=' + error.stack);
  }
  if (res.headersSent) {
    res.end();
  } else if (url.pathname === '/v1/chat/completions') {
    // 保持 OpenAI 兼容的错误外壳，别让 SDK 客户端解析失败。
    sendJson(res, status, {
      error: {
        message,
        type: 'local_agent_error',
        request_id: requestId,
        provider: agent.provider,
        model: agent.model || null,
        status,
        duration_ms: durationMs,
        output_chars: output.length,
      },
    });
  } else {
    sendApiError(res, status, message, message, {
      requestId,
      provider: agent.provider,
      model: agent.model || null,
      status,
      durationMs,
    });
  }
}
