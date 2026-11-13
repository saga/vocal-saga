/**
 * URL 工具函数：标准化、缓存 key 生成。
 *
 * 从 lib/app.ts 提取，保持主文件干净。
 */

/**
 * URL 标准化：统一格式以便缓存命中和去重。
 *
 * 规则：
 *   1. 剥离 http:// 或 https:// 前缀
 *   2. 无 "." 的首段域名自动补 .com（如 towardsdatascience → towardsdatascience.com）
 *
 * 注意：www.example.com 和 example.com 暂时保留为两个不同 URL，不做去重。
 */
export function normalizeUrl(rawPath: string): string {
  // 1) 剥 scheme
  let normalized = rawPath.replace(/^https?:\/\//i, '');

  // 2) 无 "." 的首段域名补 .com（如 /translate/towardsdatascience/article → towardsdatascience.com/article）
  const slashIdx = normalized.indexOf('/');
  const hostPart = slashIdx < 0 ? normalized : normalized.slice(0, slashIdx);
  const pathPart = slashIdx < 0 ? '' : normalized.slice(slashIdx);
  if (hostPart && !hostPart.includes('.')) {
    normalized = hostPart + '.com' + pathPart;
  }

  return normalized;
}

/**
 * 缓存 key 直接用完整 URL（保留 scheme 和 www）。
 * www.example.com 和 example.com 暂时视为不同 URL。
 */
/** Remove query strings, fragments, and embedded credentials from URLs used in logs. */
export function safeLogUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname;
  } catch {
    return '(invalid URL)';
  }
}

export function cacheKeyUrl(url: string): string {
  return url;
}

// =============================================================================
// SSRF 防护
// =============================================================================
//
// /translate/*、/original/* 等端点接受用户输入的 URL 并由服务端 fetch，
// 存在 SSRF（Server-Side Request Forgery）风险：攻击者可让服务端访问内网
// 服务、云元数据接口（如 AWS 的 169.254.169.254）或被用作代理探测。
// assertPublicUrl 在 fetchPage 之前拦截这些地址。

/**
 * 校验目标 URL 是否可公开访问，拒绝私网/保留/链路本地地址。
 *
 * 校验维度：
 *   - 协议：仅允许 http/https
 *   - 端口：仅允许空（默认 80/443）、80、443
 *   - 主机名：拒绝 localhost、.localhost、.internal、.local 后缀
 *   - IPv4：拒绝 0.0.0.0/8、10/8、127/8（loopback）、169.254/16（链路本地，
 *     含 AWS 元数据）、172.16/12、192.168/16、100.64/10（CGNAT）、
 *     192.0.0/24、192.0.2/24、198.18/15、198.51.100/24、203.0.113/24、
 *     224.0.0.0/4（multicast 及保留段）
 *   - IPv6：拒绝 ::1、::、fe80::/10（链路本地）、fc00::/7（unique-local）、
 *     ff00::/8（multicast）、IPv4-mapped/compatible 私网地址
 *
 * 注意：DNS rebinding 在 CF Workers 上难以完全防御（fetch 时不暴露解析后的
 * IP），本函数仅拦截 IP 字面量与已知内部域名，已能挡住绝大多数直接攻击。
 *
 * @throws Error 当 URL 非法或命中拒绝规则时，message 描述拒绝原因
 */
export function assertPublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid url');
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`protocol not allowed: ${protocol.replace(':', '')}`);
  }

  // 端口校验：仅允许空（默认端口）、80、443。阻止通过非标准端口访问内网服务。
  const port = parsed.port;
  if (port !== '' && port !== '80' && port !== '443') {
    throw new Error(`port not allowed: ${port} (only 80/443 allowed)`);
  }

  // hostname：标准 URL API 对 IPv6 返回带方括号的形式（[::1]），统一去除。
  // 去除 FQDN 尾点（如 "localhost."）避免绕过。
  let host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host === '') {
    throw new Error('empty host');
  }

  // 主机名黑名单：localhost 及常见内部域名后缀
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('localhost not allowed');
  }
  if (host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`internal/local domain not allowed: ${host}`);
  }

  // IPv4 字面量校验
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) {
      throw new Error(`private/reserved ipv4 not allowed: ${host}`);
    }
    return;
  }

  // IPv6 字面量校验（含冒号）
  if (host.includes(':')) {
    if (isPrivateIPv6(host)) {
      throw new Error(`private/reserved ipv6 not allowed: ${host}`);
    }
  }
}

/**
 * IPv4 私网/保留地址判定。
 * 返回 true 表示该地址属于私网/保留段，不允许被服务端 fetch。
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true; // 非法格式，拒绝
  const octets: number[] = [];
  for (const p of parts) {
    // 拒绝非法字符。前导零已由 WHATWG URL 规范化消除（010.0.0.1 → 8.0.0.1），
    // 此处只校验字面量合法性。
    if (!/^\d{1,3}$/.test(p)) return true;
    const n = Number(p);
    if (n > 255) return true;
    octets.push(n);
  }
  const [a, b, c] = octets;
  if (a === 0) return true;                          // 0.0.0.0/8 本网络
  if (a === 10) return true;                         // 10.0.0.0/8 私网
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 链路本地（含 AWS metadata 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 私网
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true;   // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && c === 2) return true;   // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast 及 E 类保留
  return false;
}

/**
 * IPv6 私网/保留地址判定（覆盖常见攻击形式）。
 * 返回 true 表示该地址属于私网/保留段，不允许被服务端 fetch。
 *
 * 采用前缀 startsWith 匹配，覆盖：
 *   - ::1（loopback）、::（unspecified）
 *   - fe80::/10（fe8x/fe9x/feax/febx 开头，链路本地）
 *   - fc00::/7（fc/fd 开头，unique-local）
 *   - ff00::/8（ff 开头，multicast）
 *   - IPv4-mapped（::ffff:a.b.c.d）与 IPv4-compatible（::a.b.c.d）转交 IPv4 判定
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // 链路本地 fe80::/10：第一组范围 fe80-febf
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // unique-local fc00::/7：fc/fd 开头
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  // IPv4-mapped ::ffff:a.b.c.d（点分十进制形式，少数运行时保留此格式）
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  // IPv4-mapped ::ffff:XXYY:ZZWW（hex 形式，WHATWG URL 把点分十进制规范化为 hex）
  // 例：::ffff:7f00:1 → 127.0.0.1；::ffff:a9fe:a9fe → 169.254.169.254
  const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // IPv4-compatible ::a.b.c.d（已废弃但仍有风险）
  const v4Compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) return isPrivateIPv4(v4Compat[1]);
  return false;
}
