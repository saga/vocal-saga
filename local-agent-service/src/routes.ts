import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PROVIDER,
  DEFAULT_WORKBUDDY_MODEL,
  LOG_RESPONSE_PREVIEW,
  MAX_BODY_BYTES as _MAX_BODY_BYTES,
  STORE_CONTENT,
  DATA_DIR, DATABASE_PATH, WORK_DIR, ENV_FILE_PATH, DOCUMENTS_DIR,
} from './config.ts';
import { db as database } from './db.ts';
import {
  saveHistory, requestMetadata, getTranslationCache, setTranslationCache,
  normalizeDocumentSegments, saveDocumentSession,
} from './db.ts';
import { authorize, sendApiError, sendJson } from './middleware.ts';
import { logError, logInfo, logWarn } from './log.ts';
import { parseAgentModel, buildAgentPrompt, normalizeMessages, parseJsonValue } from './json.ts';
import { runAgent, runAgentStructured } from './agents/runner.ts';
import { getCodeBuddyTaskProfile } from './agents/taskProfiles.ts';
import {
  getCodeBuddyContextWindowOption,
  readModelCatalog,
  resolveWorkbuddyModel,
} from './agents/modelCatalog.ts';
import { validateSegments, runLiteraryAnalysis, getDefaultLiteraryTaskPromptPreviews } from './literary.ts';
import { DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT, getDefaultContextGraphUserPromptTemplate } from './documents/contextGraph.ts';
import path from 'node:path';
import { handleDocumentProjectRequest } from './documents/projectRoutes.ts';
import { buildStandaloneReviewContextGraph, buildStandaloneReviewMemory, buildStandaloneReviewVoiceContext, runLiteraryReviewWithMissingRetry } from './documents/translationAgent.ts';

// Keep the constant referenced so TypeScript does not drop the side-effect-free import in tests.
void _MAX_BODY_BYTES;

/**
 * Document sessions are opt-in and strictly scoped to one stable document fingerprint,
 * task role, model, language direction and prompt profile. Invalid/missing IDs retain the
 * existing one-off/shared behavior instead of creating an unbounded set of arbitrary sessions.
 */
function buildDocumentSessionScope(
  body: any,
  agent: { provider: string; model: string },
  role: 'translation' | 'analysis' | 'review',
  metadata?: any,
): string | undefined {
  const source = metadata || body || {};
  const documentSessionId = typeof source.documentSessionId === 'string' ? source.documentSessionId : '';
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(documentSessionId)) return undefined;
  // Prompt edits must create a new Session. Reusing a previous conversation after the user
  // changes the system/user template would continue using the old system instructions.
  const promptSignature = [
    typeof source.systemPromptOverride === 'string' ? source.systemPromptOverride : '',
    typeof source.userPromptTemplate === 'string' ? source.userPromptTemplate : '',
  ].join('\u0000');
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

/**
 * 通用 HTTP 路由分发入口。文档项目 API 优先委托给 projectRoutes，其他接口由本模块处理。
 * /api 与 /v1 路径在进入业务分支前统一鉴权；本函数只负责请求/响应适配，
 * 持久化、Run 状态转换和长任务生命周期分别归 DocumentProjectStore 与 translationAgent。
 */
export async function handleRequest(req: Request, res: Response): Promise<void> {
  const db = database!;
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true, service: 'vocal-saga-local-agent', version: '1.0.0',
      providers: ['workbuddy', 'opencode'], defaultProvider: DEFAULT_PROVIDER,
      database: path.basename(DATABASE_PATH), storeContent: STORE_CONTENT,
    });
    return;
  }
  // authorize via middleware.ts
  if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) && !authorize(req)) {
    sendApiError(res, 401, '本机服务 Token 不正确或未提供', { message: '本机服务 Token 不正确或未提供', type: 'authentication_error' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/settings/diagnostics') {
    sendJson(res, 200, {
      paths: {
        dataDirectory: DATA_DIR,
        database: DATABASE_PATH,
        documentProjects: DOCUMENTS_DIR,
        workspace: WORK_DIR,
        envFile: ENV_FILE_PATH,
      },
      storage: {
        storeContent: STORE_CONTENT,
        sourceFiles: 'per-project source files under the document project directory; segments-only projects may not have original file bytes',
      },
    });
    return;
  }

  if (await handleDocumentProjectRequest(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [
      { id: 'workbuddy', object: 'model', owned_by: 'local' },
      { id: 'opencode', object: 'model', owned_by: 'local' },
    ] });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/codebuddy/models') {
    const catalog = readModelCatalog({ projectRoot: WORK_DIR });
    sendJson(res, 200, {
      object: 'list',
      data: catalog.map((item) => ({ id: item.id, object: 'model', owned_by: 'codebuddy', credits: item.credits })),
    });
    return;
  }
  // Context-window tiers are config options, not model-list metadata. Clients should refresh
  // this endpoint whenever the selected model changes and display a selector only when one exists.
  if (req.method === 'GET' && url.pathname === '/api/codebuddy/config-options') {
    const catalog = readModelCatalog({ projectRoot: WORK_DIR });
    const requestedModel = (url.searchParams.get('model') || '').trim();
    const modelId = requestedModel && requestedModel.toLowerCase() !== 'auto'
      ? requestedModel
      : DEFAULT_WORKBUDDY_MODEL || resolveWorkbuddyModel(undefined, catalog);
    const model = catalog.find((item) => item.id === modelId);
    const currentValue = url.searchParams.get('currentValue')
      ?? url.searchParams.get('context_window')
      ?? undefined;
    const option = model ? getCodeBuddyContextWindowOption(model, currentValue) : undefined;
    sendJson(res, 200, {
      model: modelId,
      configOptions: option ? [option] : [],
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const rows = db.prepare(
      'SELECT id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error ' +
      'FROM request_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    sendJson(res, 200, { rows, storeContent: STORE_CONTENT });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    db.exec('DELETE FROM request_history;');
    sendJson(res, 200, { cleared: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/cache/translation/get') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500) { sendApiError(res, 400, 'cacheKey 必须是 1-500 字符'); return; }
    const value = getTranslationCache(cacheKey);
    sendJson(res, 200, { hit: value !== null, value });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/set') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500 || !Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) {
      sendApiError(res, 400, 'cacheKey 与 value 为必填字段'); return;
    }
    const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;
    const ttlMs = req.body.ttlMs === undefined ? defaultTtlMs : req.body.ttlMs;
    // Keep cache lifetime bounded: zero expires immediately; negative/non-numeric values are invalid.
    if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 365 * 24 * 60 * 60 * 1000) {
      sendApiError(res, 400, 'ttlMs 必须是 0 到 365 天之间的整数'); return;
    }
    setTranslationCache(cacheKey, req.body.value, ttlMs);
    sendJson(res, 200, { saved: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/delete') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500) {
      sendApiError(res, 400, 'cacheKey 必须是 1-500 字符');
      return;
    }
    db.prepare('DELETE FROM translation_cache WHERE cache_key = ?').run(cacheKey);
    sendJson(res, 200, { deleted: true });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/cache/translation') {
    db.prepare('DELETE FROM translation_cache').run();
    sendJson(res, 200, { cleared: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/session/summary') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return; }
    const row = db.prepare('SELECT session_id, title, format, updated_at FROM document_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) { sendJson(res, 200, { found: false }); return; }
    sendJson(res, 200, {
      found: true,
      session: { sessionId: row.session_id, title: row.title, format: row.format, updatedAt: row.updated_at },
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/session/get') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return; }
    const row = db.prepare('SELECT session_id, title, format, updated_at, payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) { sendJson(res, 200, { found: false }); return; }
    try { sendJson(res, 200, { found: true, session: { sessionId: row.session_id, title: row.title, format: row.format, updatedAt: row.updated_at, payload: JSON.parse(row.payload_json) } }); }
    catch (error) {
      // 损坏的会话会被删除：这是数据丢失，必须在终端留痕，不能静默当成「没找到」。
      logWarn('local-agent', '文档会话数据损坏，已删除 · session=' + sessionId.slice(0, 40) + ' · ' +
        (error instanceof Error ? error.message : String(error)));
      db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId);
      sendJson(res, 200, { found: false });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/session/save') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return; }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'payload')) { sendApiError(res, 400, 'payload 为必填字段'); return; }
    saveDocumentSession(sessionId, typeof req.body.title === 'string' ? req.body.title : '未命名文档',
      typeof req.body.format === 'string' ? req.body.format : 'txt', req.body.payload, req.body.mergeExisting === true);
    sendJson(res, 200, { saved: true, updatedAt: new Date().toISOString() });
    return;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/documents/session/')) {
    let sessionId = '';
    try { sessionId = decodeURIComponent(url.pathname.slice('/api/documents/session/'.length)).trim(); }
    catch { sendApiError(res, 400, 'sessionId 编码无效'); return; }
    if (!sessionId || sessionId.length > 500 || sessionId.includes('/')) { sendApiError(res, 400, 'sessionId 必须是有效的 1-500 字符路径参数'); return; }
    db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId);
    sendJson(res, 200, { deleted: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/documents/batches') {
    const segments = normalizeDocumentSegments(req.body?.segments);
    const maxChars = Number.isFinite(req.body?.budget?.maxChars) ? Math.max(100, Math.min(50000, Math.floor(req.body.budget.maxChars))) : 3000;
    const maxSegments = Number.isFinite(req.body?.budget?.maxSegments) ? Math.max(1, Math.min(500, Math.floor(req.body.budget.maxSegments))) : 24;
    const splitOnContextChange = req.body?.budget?.splitOnContextChange === true;
    const batches: Array<Array<{ id: string }>> = [];
    let current: Array<{ id: string }> = [];
    let chars = 0;
    let currentGroup = '';
    for (const segment of segments) {
      const group = segment.contextPath + '|page:' + (segment.page ?? '');
      if (current.length && (chars + segment.text.length > maxChars || current.length >= maxSegments ||
          (splitOnContextChange && group !== currentGroup))) {
        batches.push(current); current = []; chars = 0;
      }
      if (!current.length) currentGroup = group;
      current.push({ id: segment.id }); chars += segment.text.length;
    }
    if (current.length) batches.push(current);
    sendJson(res, 200, { batches, totalSegments: segments.length, totalChars: segments.reduce((n: number, item: any) => n + item.text.length, 0) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config/task-prompts') {
    const literaryPrompts = getDefaultLiteraryTaskPromptPreviews();
    sendJson(res, 200, {
      prompts: {
        accuracyReview: literaryPrompts.systemPrompts.accuracyReview,
        styleReview: literaryPrompts.systemPrompts.styleReview,
        literaryAnalysis: literaryPrompts.systemPrompts.literaryAnalysis,
        contextGraph: DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
      },
      userPromptTemplates: {
        accuracyReview: literaryPrompts.userPromptTemplates.accuracyReview,
        styleReview: literaryPrompts.userPromptTemplates.styleReview,
        literaryAnalysis: literaryPrompts.userPromptTemplates.literaryAnalysis,
        contextGraph: getDefaultContextGraphUserPromptTemplate(),
      },
    });
    return;
  }

  const supported = new Set([
    'POST /v1/chat/completions',
    'POST /api/translate/document/literary/analyze',
    'POST /api/translate/document/literary/review',
  ]);
  if (!supported.has(req.method + ' ' + url.pathname)) {
    sendApiError(res, 404, '未知端点：' + req.method + ' ' + url.pathname, { message: '未知端点：' + req.method + ' ' + url.pathname, type: 'not_found_error' });
    return;
  }

  const startedAt = Date.now();
  const requestId = randomUUID();
  let body: any = {};
  let agent: { provider: string; model: string } = { provider: 'unknown', model: '' };
  let output = '';
  try {
    body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('JSON 请求体必须是对象'), { status: 400 });
    }
    if (url.pathname === '/v1/chat/completions') {
      if (typeof body.model !== 'string' || !body.model.trim()) throw Object.assign(new Error('model 是必填字段'), { status: 400 });
      const normalized = normalizeMessages(body.messages);
      agent = parseAgentModel(body.model);
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
      const sessionScope = buildDocumentSessionScope(body, agent, 'translation', body.metadata);
      const taskProfiles = body.metadata?.taskProfiles;
      const taskProfile = taskProfiles && typeof taskProfiles === 'object'
        ? getCodeBuddyTaskProfile({ taskProfiles }, 'translation')
        : undefined;
      if (sessionScope) {
        logInfo('local-agent', '[' + requestId + '] session-scope role=translation scope=document-task');
      }
      let turnUsage: { result: unknown; usage: unknown } | null = null;
      if (jsonSchema) {
        const structured = await runAgentStructured(agent, prompt, normalized.systemPrompt, jsonSchema, requestId, sessionScope, taskProfile);
        output = JSON.stringify(structured.result);
        turnUsage = structured;
      } else {
        const r = await runAgent(agent, prompt, normalized.systemPrompt, requestId, sessionScope, taskProfile);
        output = r.result;
        turnUsage = r;
        if (jsonMode) {
          const parsedOutput = parseJsonValue(output, 'request=' + requestId.slice(0, 40) + ' endpoint=' + url.pathname);
          if (!parsedOutput) {
            const preview = LOG_RESPONSE_PREVIEW
              ? ' preview=' + JSON.stringify(output.slice(0, 600))
              : ' preview=<disabled>';
            logError('local-agent',
              '[' + requestId + '] invalid-json endpoint=' + url.pathname +
              ' provider=' + agent.provider +
              ' model=' + (agent.model || '<runtime-default>') +
              ' outputChars=' + output.length + preview,
            );
            throw new Error(
              '本机 Agent 返回内容不是有效 JSON（输出 ' + output.length +
              ' 字符）；详情见本机服务日志。请检查本机模型输出或重试该批次',
            );
          }
          output = JSON.stringify(parsedOutput);
        }
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
    } else if (url.pathname.endsWith('/analyze')) {
      agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
      logInfo('local-agent',
        '[' + requestId + '] start endpoint=' + url.pathname +
        ' provider=' + agent.provider +
        ' model=' + (agent.model || '<runtime-default>') +
        ' inputChars=' + JSON.stringify(body.segments || []).length +
        ' segments=' + (Array.isArray(body.segments) ? body.segments.length : 0) +
        ' storeContent=' + String(STORE_CONTENT),
      );
      const sessionScope = buildDocumentSessionScope(body, agent, 'analysis');
      const result = await runLiteraryAnalysis(body, requestId, sessionScope);
      output = JSON.stringify(result);
      sendJson(res, 200, result);
    } else {
      agent = parseAgentModel(body.model || 'auto', body.runtime || body.provider || '');
      logInfo('local-agent',
        '[' + requestId + '] start endpoint=' + url.pathname +
        ' provider=' + agent.provider +
        ' model=' + (agent.model || '<runtime-default>') +
        ' inputChars=' + JSON.stringify(body.segments || []).length +
        ' segments=' + (Array.isArray(body.segments) ? body.segments.length : 0) +
        ' storeContent=' + String(STORE_CONTENT),
      );
      const sessionScope = buildDocumentSessionScope(body, agent, 'review');
      // The legacy standalone Reviewer is still used for explicit "re-review this segment"
      // actions. Give it the same deterministic canonical-name protection as Project Runs,
      // without sending unrelated future aliases from the whole-book memory.
      // Standalone re-review is not tied to an immutable server Run. Never trust a client-supplied
      // TranslationBrief/voiceContext; reconstruct both from the current submitted source and
      // the server-filtered, source-grounded literary-memory projection.
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
        // Deliberately replace rather than spread the supplied object. No client graph/hash,
        // chapter summary, recent example or voice context is allowed through this route.
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
      output = JSON.stringify(result);
      sendJson(res, 200, result);
    }
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
  } catch (error: any) {
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
    const { LOG_RESPONSE_PREVIEW: _ignored } = await import('./config.ts');
    void _ignored;
    if (res.headersSent) {
      res.end();
    } else if (url.pathname === '/v1/chat/completions') {
      // Keep the OpenAI-compatible error envelope stable for SDK clients.
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
}

