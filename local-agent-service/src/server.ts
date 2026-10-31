/**
 * 本机 Agent 服务入口模块。
 *
 * 运行时配置与业务逻辑已经拆分到 config/db/agents/literary/routes 等模块，
 * 本文件负责组装 Express 应用并重新导出测试/外部调用需要的公共 API。
 */
import express, { type Request, type Response, type NextFunction } from 'express';

import {
  DEFAULT_PROVIDER, DEFAULT_WORKBUDDY_MODEL, HOST, PORT, MAX_BODY_BYTES, MAX_DOCUMENT_BODY_BYTES, DATABASE_PATH, STORE_CONTENT,
  ALLOWED_HOSTS, LOCAL_TOKEN, WORKBUDDY_FREE_MODELS, REQUEST_TIMEOUT_MS, ANALYSIS_TIMEOUT_MS,
} from './config.ts';
import { initDatabase } from './db.ts';
import { sendApiError, sendJson, addCors, isAllowedHost, assertExposureIsSafe, requestHostname } from './middleware.ts';
import { handleRequest } from './routes.ts';
import { getTextPool } from './agents/workbuddyPool.ts';
import { getDocumentProjectStore } from './documents/projectStore.ts';
import {
  logError, logWarn, logInfo, requestPath, summarizeError, errorStackTail,
  isPollingRequest, createPollingRollup, recordPollingRequest, resetPollingRollup, formatPollingSummary,
} from './log.ts';

// 兼容旧入口与测试：继续从 server.ts 导出这些函数。
export { parseAgentModel, buildAgentPrompt, parseJsonObject, parseJsonValue, normalizeMessages } from './json.ts';
export { validateSegments } from './literary.ts';

const app = express();
app.disable('x-powered-by');

/**
 * 组装并启动本机 HTTP 服务。
 *
 * 启动顺序属于安全契约：先确认只能监听 loopback、校验远程暴露配置并修复持久化存储，
 * 然后才注册来源/Host 检查与 body parser，最后开始监听。不要把大请求体解析移到安全校验之前。
 */
export function startLocalAgentServer() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    throw new Error('LOCAL_AGENT_HOST 必须是 loopback 地址（默认 127.0.0.1），本服务不允许监听局域网');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('LOCAL_AGENT_PORT 不合法');
  // 监听地址仍是 loopback：隧道/反代从本机连进来，不需要也不允许直接监听局域网。
  // 对外开放只靠 ALLOWED_HOSTS 放行 Host 头，因此必须先确认 token 存在。
  assertExposureIsSafe(ALLOWED_HOSTS, LOCAL_TOKEN);
  initDatabase();
  // Create/repair the catalog and mark interrupted document runs resumable before serving requests.
  getDocumentProjectStore();

  // 请求日志必须挂在来源校验之前：这样被 CORS/Host 拦掉的请求（浏览器只看到 Failed to fetch）
  // 也能在终端留下痕迹，否则「请求根本没到」「被 403 拦了」两种情况无法区分。
  // 轮询型 GET（run 详情、事件流、预处理状态）成功时静默，改成每分钟一行汇总；
  // 出错、慢请求和所有写操作照常逐条输出。
  const SLOW_REQUEST_MS = 3000;
  const POLLING_SUMMARY_MS = 60_000;
  const polling = createPollingRollup();
  const flushPolling = () => {
    const summary = formatPollingSummary(polling);
    resetPollingRollup(polling);
    if (summary) logInfo('http', summary);
  };
  const pollingTimer = setInterval(flushPolling, POLLING_SUMMARY_MS);
  // 定时器不能拖住进程退出：测试会多次调用 startLocalAgentServer。
  pollingTimer.unref();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const path = requestPath(req.originalUrl);
    res.on('finish', () => {
      const duration = Date.now() - startedAt;
      const status = res.statusCode;
      if (status < 400 && isPollingRequest(req.method, path) && duration < SLOW_REQUEST_MS) {
        recordPollingRequest(polling, path, duration);
        return;
      }
      const origin = typeof req.headers.origin === 'string' ? ' · origin=' + req.headers.origin : '';
      const line = req.method + ' ' + path + ' → ' + status + ' · ' + duration + 'ms' + (status >= 400 ? origin : '');
      if (status >= 500) logError('http', line);
      else if (status >= 400 || duration >= SLOW_REQUEST_MS) logWarn('http', line);
      else logInfo('http', line);
    });
    next();
  });

  // Run the origin/Host checks before parsing potentially large request bodies.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!addCors(req, res)) {
      sendApiError(res, 403, '本机服务不接受普通网页来源；请从浏览器扩展或本机命令行调用');
      return;
    }
    const hostname = requestHostname(req);
    if (!isAllowedHost(hostname, ALLOWED_HOSTS)) {
      sendApiError(res, 403, '此服务只允许通过 localhost/127.0.0.1 或已配置的隧道域名访问');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  // 文档项目创建会把整本书的片段正文塞进一个 JSON 请求，其余接口没有这种体量。
  // body-parser 2.x 靠 onFinished.isFinished(req) 判断流已读完，先跑的解析器会消费掉请求流，
  // 后面的全局解析器因此直接 next() 跳过，所以放宽的那个必须挂在前面。
  app.use('/api/documents', express.json({ limit: MAX_DOCUMENT_BODY_BYTES, strict: true }));
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));
  app.use((req: Request, res: Response) => {
    void handleRequest(req, res).catch((error) => {
      // 之前这里直接回 500、终端什么都不打印：故障现场只剩浏览器里的一句错误。
      const tail = errorStackTail(error);
      logError('http', req.method + ' ' + requestPath(req.originalUrl) + ' 未处理异常 · ' + summarizeError(error) + (tail ? ' · ' + tail : ''));
      if (!res.headersSent) sendApiError(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    });
  });
  app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
    const status = error?.status === 413 ? 413 : error?.status === 400 ? 400 : 500;
    const limitMb = Math.round(
      (req.originalUrl.split('?')[0]!.startsWith('/api/documents') ? MAX_DOCUMENT_BODY_BYTES : MAX_BODY_BYTES) / 1024 / 1024,
    );
    logWarn('http', req.method + ' ' + requestPath(req.originalUrl) + ' 请求被拒绝 → ' + status + ' · ' + summarizeError(error));
    const message = status === 413
      ? '请求体超过 ' + limitMb + ' MiB 上限'
      : status === 400
        ? '请求体不是有效的 JSON'
        : '本机服务内部错误';
    sendApiError(res, status, message);
  });

  const server = app.listen(PORT, HOST, () => {
    logInfo('local-agent', 'listening on http://' + HOST + ':' + PORT + ' · pid=' + process.pid);
    logInfo('local-agent', 'provider default: ' + DEFAULT_PROVIDER);
    // 空模型不会报错，只会让 CLI 静默用账号默认模型（计费且可能不支持 json-schema），
    // 所以启动时把解析结果打出来，并说明没选上的原因与可选项。
    logInfo('local-agent', 'workbuddy model: ' + (DEFAULT_WORKBUDDY_MODEL || '<CLI 默认模型>'));
    if (!DEFAULT_WORKBUDDY_MODEL) {
      logInfo('local-agent', '未自动选模型：偏好表里的模型都不在目录中'
        + (WORKBUDDY_FREE_MODELS.length
          ? '（当前可用的免费模型：' + WORKBUDDY_FREE_MODELS.join(', ') + '）'
          : '（目录里也没有 credits=0 的模型）')
        + '，可用 LOCAL_WORKBUDDY_MODEL 指定');
    }
    logInfo('local-agent', 'SQLite: ' + DATABASE_PATH);
    logInfo('local-agent', 'prompt/translation content storage: ' + String(STORE_CONTENT));
    // 超时是排查「卡住 / 报超时」时最需要的第一手信息，启动即可见，
    // 不用去翻代码猜当前生效的上限。
    logInfo('local-agent', 'timeouts: 单次调用 ' + (REQUEST_TIMEOUT_MS / 1000).toFixed(0)
      + 's · 全书预处理 ' + (ANALYSIS_TIMEOUT_MS / 1000).toFixed(0) + 's');
    // 仅默认 Provider 为 Workbuddy 时预热会话池，避免 OpenCode 模式启动无用 CLI。
    // 预热只 boot 进程、不调用模型；失败时首单仍可懒创建。测试可设 LOCAL_AGENT_PREWARM=false 关闭。
    if (DEFAULT_PROVIDER === 'workbuddy' && (process.env.LOCAL_AGENT_PREWARM || 'true').trim().toLowerCase() !== 'false') {
      void getTextPool().prewarm({ provider: 'workbuddy', model: DEFAULT_WORKBUDDY_MODEL })
        // 预热失败本身不影响首单（首单会懒创建），但终端要留下原因，
        // 否则「CLI 起不来」只能靠后面的调用失败去猜。
        .catch((error) => logWarn('pool', '预热失败（首单将懒创建会话）· ' + summarizeError(error)));
    }
  });

  /**
   * 端口冲突必须吵闹地失败。
   *
   * 之前重复启动时新进程只会在终端留下几行启动日志，扩展却仍然连到旧实例上，
   * 于是「我明明起了服务，为什么这个终端的日志一动不动」会反复浪费排查时间。
   */
  server.on('error', (error: any) => {
    if (error?.code === 'EADDRINUSE') {
      logError('local-agent', '端口 ' + PORT + ' 已被占用：另一个 local-agent-service 实例正在运行，本进程退出。'
        + ' 查看占用进程：lsof -nP -iTCP:' + PORT + ' -sTCP:LISTEN');
    } else {
      logError('local-agent', '监听 ' + HOST + ':' + PORT + ' 失败：' + (error?.message || String(error)));
    }
    process.exit(1);
  });

  // 关服时把还没打出去的轮询汇总补上，并释放定时器（否则多次启动会累积 interval）。
  server.on('close', () => {
    clearInterval(pollingTimer);
    flushPolling();
  });
}
