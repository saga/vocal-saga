/**
 * 本机 Agent 服务的运行时配置。
 *
 * 这些常量在模块求值时从 process.env 读取，因此 start.ts 必须先 loadEnvFile，
 * 再动态导入依赖本模块的 server.ts。
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readModelCatalog, resolveWorkbuddyModel } from './agents/modelCatalog.ts';
import { logWarn } from './log.ts';

export const HOST = (process.env.LOCAL_AGENT_HOST || '127.0.0.1').trim();
export const PORT = Number.parseInt(process.env.LOCAL_AGENT_PORT || '8789', 10);
export const DATA_DIR = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(homedir(), '.vocal-saga-local-agent'));
export const DATABASE_PATH = path.resolve(process.env.LOCAL_AGENT_DATABASE || path.join(DATA_DIR, 'local-agent.sqlite'));
export const WORK_DIR = path.resolve(process.env.LOCAL_AGENT_WORKDIR || path.join(DATA_DIR, 'workspace'));
const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE_PATH = path.resolve(process.env.LOCAL_AGENT_ENV_FILE?.trim() || path.join(SERVICE_DIR, '.env'));
export const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');

const configuredToken = (process.env.LOCAL_AGENT_TOKEN || '').trim();
// Token is optional for loopback-only use. Treat the example placeholder as unset.
export const LOCAL_TOKEN = configuredToken && !/replace-with-a-long-random-token/i.test(configuredToken)
  ? configuredToken
  : '';

// 通过 Cloudflare Tunnel 等反向代理暴露到公网时，请求的 Host 头是隧道域名而非 loopback，
// 默认的 Host 校验会一律 403。这里列出额外允许的主机名（逗号分隔，小写），
// `*.example.com` 匹配任意层级子域。留空 = 只允许 localhost/127.0.0.1（默认行为）。
// 注意：非空即代表服务可被非本机访问，必须同时设置 LOCAL_AGENT_TOKEN，见 server.ts 的启动校验。
export const ALLOWED_HOSTS = (process.env.LOCAL_AGENT_ALLOWED_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

export const DEFAULT_PROVIDER = (process.env.LOCAL_AGENT_PROVIDER || 'workbuddy').toLowerCase();
// 显式配置优先；没配（或写成 auto）时从 CodeBuddy 模型目录里挑「确认免费」的模型。
// 目录读不到或没有任何 credits=0 的模型就留空，交给 CLI 运行时默认模型 —— 不猜、不硬编码。
const explicitWorkbuddyModel = (process.env.LOCAL_WORKBUDDY_MODEL || process.env.WORKBUDDY_MODEL || process.env.CODEBUDDY_DEFAULT_MODEL || '').trim();
const workbuddyCatalog = readModelCatalog({ projectRoot: WORK_DIR });
export const DEFAULT_WORKBUDDY_MODEL = resolveWorkbuddyModel(explicitWorkbuddyModel, workbuddyCatalog);
/** 目录里 credits 明确为 0 的模型，启动日志用来说明「为什么没选上」以及可手动指定什么。 */
export const WORKBUDDY_FREE_MODELS = workbuddyCatalog
  .filter((model) => model.credits === 0)
  .map((model) => model.id);
export const DEFAULT_OPENCODE_MODEL = (process.env.LOCAL_OPENCODE_MODEL || process.env.OPENCODE_MODEL || '').trim();

/** Parse optional integer settings without allowing malformed .env values to poison runtime timers/SQL. */
export function positiveIntegerEnv(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logWarn('local-agent', 'Ignoring invalid ' + name + '=' + JSON.stringify(raw) + '; using default ' + fallback);
    return fallback;
  }
  return Math.max(minimum, parsed);
}

export const REQUEST_TIMEOUT_MS = positiveIntegerEnv('LOCAL_AGENT_TIMEOUT_MS', 180_000, 10_000);
// Reviewer calls can use high reasoning effort and operate on longer, multi-segment
// prompts. Keep their deadline separate from ordinary translation/API calls.
export const REVIEW_TIMEOUT_MS = positiveIntegerEnv('LOCAL_AGENT_REVIEW_TIMEOUT_MS', 300_000, 10_000);
// 全书预处理要在一个调用里读完数十段样本，输出人物/实体/关系/章节摘要，
// 单个调用常常超过普通翻译批次的阈值。给这类长任务单独设上限，
// 避免把「正常的慢」误判成超时；仍然保留硬上限，防止真卡死时无限等待。
export const ANALYSIS_TIMEOUT_MS = positiveIntegerEnv('LOCAL_AGENT_ANALYSIS_TIMEOUT_MS', 900_000, 30_000);
// 长驻会话池：大小对齐扩展侧扇出；单会话最多复用轮数（防历史变长导致变慢变贵）。
// 复用轮数只是上限；实际上下文长度、时延与成本取决于 Prompt、输入长度和运行时。
export const WORKBUDDY_POOL_SIZE = positiveIntegerEnv('LOCAL_AGENT_POOL_SIZE', 6, 1);
export const WORKBUDDY_POOL_MAX_USES = positiveIntegerEnv('LOCAL_AGENT_POOL_MAX_USES', 10, 1);
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
// 文档项目创建会把整本书的片段正文放进一个 JSON 请求。20 MiB 源文件解析出的正文按 UTF-8
// 最坏情况（中文 3 字节/字符 + JSON 转义）约为源文件的三倍，远超普通接口的 24 MiB。
// 只对 /api/documents 这一族路由放宽，其他接口仍受 MAX_BODY_BYTES 约束。
export const MAX_DOCUMENT_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_HISTORY_ROWS = positiveIntegerEnv('LOCAL_AGENT_MAX_HISTORY', 500, 50);
export const STORE_CONTENT = (process.env.LOCAL_AGENT_STORE_CONTENT || 'true').toLowerCase() !== 'false';
// Only a failed JSON response is previewed in local terminal logs; set false to suppress text previews.
export const LOG_RESPONSE_PREVIEW = (process.env.LOCAL_AGENT_LOG_RESPONSE_PREVIEW || 'true').toLowerCase() !== 'false';
