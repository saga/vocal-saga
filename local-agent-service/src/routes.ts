/**
 * 通用 HTTP 路由分发入口（本机 Agent 服务的总路由）。
 *
 * 职责划分：
 *  - 前置校验（健康检查 / 鉴权 / 诊断）与同步 API（模型目录、历史、缓存、文档会话、
 *    批次规划、任务 Prompt）交给 localApiRoutes。
 *  - 文档项目相关 API（/api/documents/projects/*）优先委托给 projectRoutes.handleDocumentProjectRequest，
 *    本函数不重复实现其持久化/Run 生命周期。
 *  - 长任务（chat completions、文学分析、独立审校）交给 longTaskRoutes，由它统一记录
 *    requestId/request_history 与成功失败日志。
 *
 * 设计约定：
 *  - 每个分支处理完后立即 sendJson/sendApiError 并 return，避免落入后续分支。
 *  - 本函数只做分发与顺序编排；参数校验、持久化与长任务生命周期各自归其所属模块。
 */
import type { Request, Response } from 'express';
import { MAX_BODY_BYTES as _MAX_BODY_BYTES } from './config.ts';
import { db as database } from './db.ts';
import { sendApiError } from './middleware.ts';
import { handleDocumentProjectRequest } from './documents/projectRoutes.ts';
import { handleApiPreflight, handleLocalApiRoutes } from './localApiRoutes.ts';
import { handleLongTaskRequest, isSupportedLongTask } from './longTaskRoutes.ts';

// Keep the constant referenced so TypeScript does not drop the side-effect-free import in tests.
void _MAX_BODY_BYTES;

/**
 * @param req Express 请求对象
 * @param res Express 响应对象
 */
export async function handleRequest(req: Request, res: Response): Promise<void> {
  // 取得已初始化的 SQLite 连接（启动时由 db.ts 建立）；后续所有分支共享同一连接。
  const db = database!;
  // 将原始 URL 解析为标准 URL 对象，便于按 pathname/method 分发；host 仅作占位。
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (handleApiPreflight(req, res, url)) return;

  // 文档项目 API 优先委托给 projectRoutes：持久化/Run 生命周期由其处理，本函数不重复实现。
  if (await handleDocumentProjectRequest(req, res, url)) return;

  if (await handleLocalApiRoutes(req, res, url, db)) return;

  // 未知端点返回 404：只有白名单内的长任务才会继续往下走。
  if (!isSupportedLongTask(req, url)) {
    sendApiError(res, 404, '未知端点：' + req.method + ' ' + url.pathname, { message: '未知端点：' + req.method + ' ' + url.pathname, type: 'not_found_error' });
    return;
  }

  await handleLongTaskRequest(req, res, url);
}
