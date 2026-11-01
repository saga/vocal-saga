import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { LOCAL_TOKEN } from './config.ts';

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Host 头白名单判定。
 *
 * loopback 永远放行（本机/扩展/CLI 的默认路径）。其余主机名必须命中
 * LOCAL_AGENT_ALLOWED_HOSTS：精确匹配，或 `*.example.com` 形式的子域通配。
 * 通配用 `.example.com` 做后缀比较，因此 `evil-example.com` 不会被误放行。
 */
export function isAllowedHost(host: string, allowedHosts: readonly string[]): boolean {
  if (isLoopbackHost(host)) return true;
  return allowedHosts.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );
}

/**
 * 暴露到公网却没有 token，等于把本机执行入口开放给任何人。
 * 这不是可降级的配置错误，启动阶段直接拒绝，避免"配了域名忘了设 token"。
 */
export function assertExposureIsSafe(allowedHosts: readonly string[], token: string): void {
  if (allowedHosts.length > 0 && !token) {
    throw new Error(
      'LOCAL_AGENT_ALLOWED_HOSTS 已配置（服务可被非本机访问），必须同时设置 LOCAL_AGENT_TOKEN',
    );
  }
}

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

/**
 * 向后兼容的接口错误外壳。保留端点原有的 `error` 值（字符串或对象），
 * 同时在上层给出 message 和稳定的机器可读 code。
 */
export function sendApiError(
  res: Response,
  status: number,
  message: string,
  legacyError: string | Record<string, unknown> = message,
  details: Record<string, unknown> = {},
): void {
  const code = status === 400 ? 'BAD_REQUEST'
    : status === 401 ? 'UNAUTHENTICATED'
      : status === 403 ? 'FORBIDDEN_ORIGIN'
        : status === 404 ? 'NOT_FOUND'
          : status === 408 ? 'REQUEST_TIMEOUT'
            : status === 409 ? 'CONFLICT'
              : status === 413 ? 'PAYLOAD_TOO_LARGE'
                : status === 422 ? 'VALIDATION_ERROR'
                  : status === 429 ? 'RATE_LIMITED'
                    : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  sendJson(res, status, { ...details, error: legacyError, message, code });
}

export function addCors(req: Request, res: Response): boolean {
  // 就算是回环地址上的服务，浏览器里打开的网页也可能打到它。
  // 只放行浏览器扩展的来源；没有 Origin 头的命令行客户端允许通过。
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return false; }
    if (!['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(parsed.protocol) || !parsed.hostname) {
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Source-File-Name');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/** 从 Host 头取出主机名：去端口、去 IPv6 方括号、转小写。 */
export function requestHostname(req: Request): string {
  const hostHeader = String(req.headers.host || '').trim().toLowerCase();
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']'));
  return hostHeader.replace(/:\d+$/, '');
}

/**
 * 统一鉴权：loopback 默认可用；通过配置域名访问的隧道/代理请求必须提供匹配的 Bearer Token。
 * 该函数依赖更早执行的 CORS/Host 检查形成纵深防御；不能把“允许 loopback”理解为允许普通网页来源。
 */
export function authorize(req: Request): boolean {
  // 本机（loopback）请求不要求 token：默认配置即可用，扩展和 CLI 不需要额外设置。
  // 安全性由另外两层保证：CORS 只放行浏览器扩展来源；Host 白名单挡住 DNS rebinding。
  if (isLoopbackHost(requestHostname(req))) return true;
  // 非 loopback 只可能来自隧道或反向代理，必须有 token 且匹配。
  // 注意顺序：先判 loopback 再判 token 是否为空，否则未设 token 时公网会直接放行。
  if (!LOCAL_TOKEN) return false;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(LOCAL_TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
