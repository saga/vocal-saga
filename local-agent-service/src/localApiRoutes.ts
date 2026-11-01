/**
 * 本机服务的同步 API：健康检查、鉴权、诊断、模型目录、历史、缓存、文档会话与批次规划。
 *
 * 这些端点都是「一次请求一次响应」，不进入长任务生命周期，因此与 chat/analyze/review
 * 的日志与 request_history 口径分开：这里失败直接返回错误信封，不留请求记录。
 */
import type { Request, Response } from 'express';
import path from 'node:path';
import {
  DATA_DIR,
  DATABASE_PATH,
  DEFAULT_PROVIDER,
  DEFAULT_WORKBUDDY_MODEL,
  DOCUMENTS_DIR,
  ENV_FILE_PATH,
  STORE_CONTENT,
  WORK_DIR,
} from './config.ts';
import {
  getTranslationCache,
  normalizeDocumentSegments,
  saveDocumentSession,
  setTranslationCache,
  type db as database,
} from './db.ts';
import { authorize, sendApiError, sendJson } from './middleware.ts';
import { logWarn } from './log.ts';
import {
  getCodeBuddyContextWindowOption,
  readModelCatalog,
  resolveWorkbuddyModel,
} from './agents/modelCatalog.ts';
import { getDefaultLiteraryTaskPromptPreviews } from './literary.ts';
import {
  DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
  getDefaultContextGraphUserPromptTemplate,
} from './documents/contextGraph.ts';

/** 已初始化的数据库句柄类型，去掉 undefined，省去调用点的空判断。 */
type SqliteDb = NonNullable<typeof database>;

/**
 * 进入业务分支前的公共前置：健康检查、统一鉴权与诊断信息。
 *
 * @returns 已处理并写完响应时为 true，调用方应立即返回。
 */
export function handleApiPreflight(req: Request, res: Response, url: URL): boolean {
  // 健康检查：不鉴权，供扩展/CLI/监控探测服务是否存活及基础配置。
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true, service: 'vocal-saga-local-agent', version: '1.0.0',
      providers: ['workbuddy', 'opencode'], defaultProvider: DEFAULT_PROVIDER,
      database: path.basename(DATABASE_PATH), storeContent: STORE_CONTENT,
    });
    return true;
  }
  // 鉴权：/v1/ 与 /api/ 路径在进入业务分支前统一鉴权；未通过返回 401。
  if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) && !authorize(req)) {
    sendApiError(res, 401, '本机服务 Token 不正确或未提供', { message: '本机服务 Token 不正确或未提供', type: 'authentication_error' });
    return true;
  }
  // 诊断信息：返回服务实际运行配置的路径与存储策略，供设置页展示（不暴露密钥）。
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
    return true;
  }
  return false;
}

/**
 * 本机同步 API 的分发：模型目录、请求历史、翻译缓存、文档会话、批次规划与任务 Prompt。
 *
 * @returns 已处理并写完响应时为 true。
 */
export async function handleLocalApiRoutes(req: Request, res: Response, url: URL, db: SqliteDb): Promise<boolean> {
  return handleModelCatalog(req, res, url)
    || handleHistoryRoutes(req, res, url, db)
    || handleTranslationCacheRoutes(req, res, url, db)
    || handleDocumentSessionRoutes(req, res, url, db)
    || handleDocumentBatchPlanning(req, res, url)
    || handleTaskPromptPreviews(req, res, url);
}

/** OpenAI 兼容模型列表 + CodeBuddy 模型目录与上下文窗口档位。 */
function handleModelCatalog(req: Request, res: Response, url: URL): boolean {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [
      { id: 'workbuddy', object: 'model', owned_by: 'local' },
      { id: 'opencode', object: 'model', owned_by: 'local' },
    ] });
    return true;
  }
  if (url.pathname === '/api/codebuddy/models') {
    const catalog = readModelCatalog({ projectRoot: WORK_DIR });
    sendJson(res, 200, {
      object: 'list',
      data: catalog.map((item) => ({ id: item.id, object: 'model', owned_by: 'codebuddy', credits: item.credits })),
    });
    return true;
  }
  // CodeBuddy 上下文窗口档位：按所选模型返回可选配置，前端仅在存在时展示选择器。
  if (url.pathname === '/api/codebuddy/config-options') {
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
    return true;
  }
  return false;
}

/** 请求历史查询与清空。 */
function handleHistoryRoutes(req: Request, res: Response, url: URL, db: SqliteDb): boolean {
  // 请求历史查询：按时间倒序返回最近 N 条（上限 100），含请求/响应摘要。
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const rows = db.prepare(
      'SELECT id, created_at, endpoint, provider, model, status, duration_ms, input_chars, output_chars, request_json, response_text, error ' +
      'FROM request_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    sendJson(res, 200, { rows, storeContent: STORE_CONTENT });
    return true;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    db.exec('DELETE FROM request_history;');
    sendJson(res, 200, { cleared: true });
    return true;
  }
  return false;
}

/** 翻译缓存的读写与清理。 */
function handleTranslationCacheRoutes(req: Request, res: Response, url: URL, db: SqliteDb): boolean {
  // 翻译缓存读取：按 cacheKey 查询，命中返回 value。
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/get') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500) { sendApiError(res, 400, 'cacheKey 必须是 1-500 字符'); return true; }
    const value = getTranslationCache(cacheKey);
    sendJson(res, 200, { hit: value !== null, value });
    return true;
  }
  // 翻译缓存写入：校验 cacheKey/value/ttlMs，ttlMs 为 0 立即过期，最大 365 天。
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/set') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500 || !Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) {
      sendApiError(res, 400, 'cacheKey 与 value 为必填字段'); return true;
    }
    const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;
    const ttlMs = req.body.ttlMs === undefined ? defaultTtlMs : req.body.ttlMs;
    // 让缓存时长有界：0 表示立即过期；负数或非数字都算非法。
    if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 365 * 24 * 60 * 60 * 1000) {
      sendApiError(res, 400, 'ttlMs 必须是 0 到 365 天之间的整数'); return true;
    }
    setTranslationCache(cacheKey, req.body.value, ttlMs);
    sendJson(res, 200, { saved: true });
    return true;
  }
  // 翻译缓存按 key 删除。
  if (req.method === 'POST' && url.pathname === '/api/cache/translation/delete') {
    const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey : '';
    if (!cacheKey || cacheKey.length > 500) {
      sendApiError(res, 400, 'cacheKey 必须是 1-500 字符');
      return true;
    }
    db.prepare('DELETE FROM translation_cache WHERE cache_key = ?').run(cacheKey);
    sendJson(res, 200, { deleted: true });
    return true;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/cache/translation') {
    db.prepare('DELETE FROM translation_cache').run();
    sendJson(res, 200, { cleared: true });
    return true;
  }
  return false;
}

/** 文档会话的摘要、读取、保存与删除。 */
function handleDocumentSessionRoutes(req: Request, res: Response, url: URL, db: SqliteDb): boolean {
  // 文档会话摘要查询：仅返回元信息（不含 payload），供 UI 展示。
  if (req.method === 'POST' && url.pathname === '/api/documents/session/summary') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return true; }
    const row = db.prepare('SELECT session_id, title, format, updated_at FROM document_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) { sendJson(res, 200, { found: false }); return true; }
    sendJson(res, 200, {
      found: true,
      session: { sessionId: row.session_id, title: row.title, format: row.format, updatedAt: row.updated_at },
    });
    return true;
  }
  // 文档会话读取：返回完整 payload；损坏数据会被删除并返回 found=false。
  if (req.method === 'POST' && url.pathname === '/api/documents/session/get') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return true; }
    const row = db.prepare('SELECT session_id, title, format, updated_at, payload_json FROM document_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) { sendJson(res, 200, { found: false }); return true; }
    try {
      sendJson(res, 200, { found: true, session: { sessionId: row.session_id, title: row.title, format: row.format, updatedAt: row.updated_at, payload: JSON.parse(row.payload_json) } });
    } catch (error) {
      // 损坏的会话会被删除：这是数据丢失，必须在终端留痕，不能静默当成「没找到」。
      logWarn('local-agent', '文档会话数据损坏，已删除 · session=' + sessionId.slice(0, 40) + ' · ' +
        (error instanceof Error ? error.message : String(error)));
      db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId);
      sendJson(res, 200, { found: false });
    }
    return true;
  }
  // 文档会话保存：支持 mergeExisting 增量合并 checkpoint。
  if (req.method === 'POST' && url.pathname === '/api/documents/session/save') {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 500) { sendApiError(res, 400, 'sessionId 必须是 1-500 字符'); return true; }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'payload')) { sendApiError(res, 400, 'payload 为必填字段'); return true; }
    saveDocumentSession(sessionId, typeof req.body.title === 'string' ? req.body.title : '未命名文档',
      typeof req.body.format === 'string' ? req.body.format : 'txt', req.body.payload, req.body.mergeExisting === true);
    sendJson(res, 200, { saved: true, updatedAt: new Date().toISOString() });
    return true;
  }
  // 文档会话删除：按路径参数 sessionId 删除。
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/documents/session/')) {
    let sessionId = '';
    try { sessionId = decodeURIComponent(url.pathname.slice('/api/documents/session/'.length)).trim(); }
    catch { sendApiError(res, 400, 'sessionId 编码无效'); return true; }
    if (!sessionId || sessionId.length > 500 || sessionId.includes('/')) { sendApiError(res, 400, 'sessionId 必须是有效的 1-500 字符路径参数'); return true; }
    db.prepare('DELETE FROM document_sessions WHERE session_id = ?').run(sessionId);
    sendJson(res, 200, { deleted: true });
    return true;
  }
  return false;
}

/** 翻译批处理规划：按预算（字符数/段数/上下文切换）将分段切分为批次。 */
function handleDocumentBatchPlanning(req: Request, res: Response, url: URL): boolean {
  if (req.method === 'POST' && url.pathname === '/api/documents/batches') {
  const segments = normalizeDocumentSegments(req.body?.segments);
  const maxChars = Number.isFinite(req.body?.budget?.maxChars) ? Math.max(100, Math.min(50000, Math.floor(req.body.budget.maxChars))) : 3000;
  const maxSegments = Number.isFinite(req.body?.budget?.maxSegments) ? Math.max(1, Math.min(500, Math.floor(req.body.budget.maxSegments))) : 24;
  const splitOnContextChange = req.body?.budget?.splitOnContextChange === true;
  const batches: Array<Array<{ id: string }>> = [];
  let current: Array<{ id: string }> = [];
  let chars = 0;
  let currentGroup = '';
  // 贪心分批：超预算或上下文切换时切分新批次。
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
    return true;
  }
  return false;
}

/** 任务 Prompt 预览：返回文学分析/审校/Context Graph 的默认系统与用户 Prompt 模板。 */
function handleTaskPromptPreviews(req: Request, res: Response, url: URL): boolean {
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
    return true;
  }
  return false;
}
