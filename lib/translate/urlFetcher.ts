/**
 * 服务端 URL fetcher：用 linkedom 解析 HTML 成可被 blockExtractor 使用的 Document。
 *
 * 为什么选 linkedom（而不是 jsdom / cheerio）：
 *   - jsdom 拉进旧版 undici，里面引用 `MessagePort` 全局，Cloudflare Workers
 *     运行时没有这个符号，模块加载就 ReferenceError。Workers / Pages 上 URL
 *     翻译功能完全不可用。
 *   - cheerio 用 css-select 模拟 DOM，没有 `createTreeWalker` / `NodeFilter`，
 *     改写 extractBlocks 成本太高。
 *   - linkedom 是纯 JS、triple-linked-list 的 DOM 实现，零 Node 内置依赖，
 *     在 Workers / V8 isolate / Node 都能跑，API 表面（querySelector /
 *     children / dataset / outerHTML 等）和 jsdom 高度一致。
 *
 * 与 fanyi-extension 的 browser 版本区别：
 *   - fetch + 注入 HTML 字符串，而非拿 document
 *   - linkedom 不执行 <script>、不拉外链，省冷启动时间
 *
 * 为什么需要 `injectGlobalWindow(document)`：
 *   - blockExtractor 内仍残留 `window.location.href` / `window.getComputedStyle`
 *     （fanyi-extension 原样移植，没改调用形态）
 *   - linkedom 不挂全局 `window` / `document`，需要手动设一下，
 *     让 server-side 调用和 browser 调用共享同一份规则代码。
 *   - 只在 Node 环境下生效（避免污染 Workers 进程的 isolate globalThis）。
 */
import { parseHTML } from 'linkedom';
import { assertPublicUrl } from '../urlUtils';
import { inlineExternalStylesheets } from './cssInliner';

export interface FetchedPage {
  url: string;
  finalUrl: string;
  /** Every URL visited in order, including the initial URL and final destination. */
  redirectChain: string[];
  doc: Document;
  html: string;
  status: number;
}

/**
 * 重定向最大跟随次数。
 *
 * 超过即抛错，避免攻击者用重定向环把请求挂死在重定向链上消耗资源。
 */
const MAX_REDIRECTS = 5;

/**
 * 判定响应是否为需要跟随的重定向。
 * 只认带语义的 3xx；300 Multiple Choices / 304 Not Modified 不跟随。
 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 手动跟随重定向，每一跳都对目标地址重新执行 SSRF 校验。
 *
 * ## 为什么不能直接用 `redirect: 'follow'`
 *
 * 内置跟随会在运行时内部完成整条重定向链，最终只把 `response.url` 暴露出来。
 * 入口处那次 `assertPublicUrl` 只校验了**链首**，而链尾可能已经跳到内网：
 *
 *   https://evil.example/redir  →  302  →  http://169.254.169.254/latest/meta-data/
 *
 * 公网页面作为链首能通过校验，云元数据服务则被整条绕过（连端口白名单一起绕过）。
 * 因此改为 `redirect: 'manual'`，自己逐跳解析 `Location` 并校验。
 *
 * 注意：`Location` 可以是相对路径，必须按**当前跳的 URL** 解析成绝对 URL 后再校验，
 * 否则攻击者可用相对 Location 拼接出非预期目标。
 *
 * @throws 命中 SSRF 拒绝规则、Location 非法或超过 MAX_REDIRECTS 时抛错
 */
async function fetchWithGuardedRedirects(
  startUrl: string,
  init: RequestInit,
  signal: AbortSignal,
  guard: (url: string) => void,
): Promise<{ response: Response; finalUrl: string; redirectChain: string[] }> {
  let currentUrl = startUrl;
  const redirectChain = [startUrl];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 每一跳都校验：首跳校验链首，后续跳校验解析后的 Location 绝对地址
    guard(currentUrl);

    const response = await fetch(currentUrl, { ...init, redirect: 'manual', signal });

    // 非重定向（或 3xx 但没有 Location，无法继续跟随）：原样返回给调用方处理
    if (!isRedirectStatus(response.status)) return { response, finalUrl: currentUrl, redirectChain };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: currentUrl, redirectChain };

    // 丢弃重定向响应的 body，避免占用连接与内存
    try {
      await response.body?.cancel();
    } catch {
      /* 部分运行时不支持 cancel，忽略 */
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error(`invalid redirect location: ${location}`);
    }
    currentUrl = next.href;
    redirectChain.push(currentUrl);
  }

  throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
}

export async function fetchPage(
  url: string,
  opts: {
    timeoutMs?: number;
    userAgent?: string;
    /**
     * 覆盖默认的 SSRF 校验函数，逐跳（含重定向每一跳）调用。
     *
     * **仅用于单元测试**：测试用 `http://127.0.0.1:<随机端口>` 起本地 HTTP server，
     * 必然命中 assertPublicUrl 的 loopback 与端口白名单规则，需要放行该地址。
     *
     * 生产路由不传本参数，使用默认的 `assertPublicUrl`。
     *
     * 与布尔开关的区别：这里只能**替换**校验实现，不能关闭校验本身，
     * 因此不存在"忘记传参就不设防"的失效路径。
     */
    ssrfGuard?: (url: string) => void;
  } = {}
): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // 默认启用 SSRF 防护：fail-safe，忘记传参也仍然是安全的
  const guard = opts.ssrfGuard ?? assertPublicUrl;
  const userAgent =
    opts.userAgent ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let finalUrl: string;
  let redirectChain: string[];
  try {
    const guarded = await fetchWithGuardedRedirects(
      url,
      {
        headers: {
          'User-Agent': userAgent,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          // Client Hints：O'Reilly 等站点会检查这些头判断是否为真实浏览器
          'Sec-Ch-Ua': '"Not/A.Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        signal: controller.signal,
      },
      controller.signal,
      guard,
    );
    response = guarded.response;
    finalUrl = guarded.finalUrl;
    redirectChain = guarded.redirectChain;
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error(`fetch page timeout (${timeoutMs}ms)`);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const diagnosticUrl = (value: string): string => {
      try {
        const parsed = new URL(value);
        return parsed.origin + parsed.pathname;
      } catch {
        return '(invalid URL)';
      }
    };
    const redirectSummary = redirectChain.map(diagnosticUrl).join(' -> ');
    throw new Error(
      `fetch ${diagnosticUrl(url)} failed: HTTP ${response.status}; ` +
      `finalUrl=${diagnosticUrl(finalUrl)}; redirectChain=${redirectSummary}`,
    );
  }

  // 把外联样式表抓下来内联进 <style>，让翻译结果页自包含。
  // 不这样做的话，缓存页里的哈希文件名（/assets/app-XXXX.css）在原站发版后
  // 404 → Chrome ORB 拦掉 → 页面布局类全部失效、图片按原始尺寸渲染。
  // 抓取前对每张样式表复用同一个 guard，页面里的 <link href> 是不可信输入。
  let sourceHtml: string;
  try {
    sourceHtml = await response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`fetch page body timeout (${timeoutMs}ms)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const finalHtml = await inlineExternalStylesheets(sourceHtml, {
    baseUrl: finalUrl,
    ssrfGuard: guard,
  });

  // linkedom 没有 `url` 选项 —— 自己手动设置 baseURI（影响 a.href 解析）。
  // parseHTML 返回的是 Window-like 对象的 defaultView；.document 拿 Document。
  const { document } = parseHTML(finalHtml) as unknown as {
    document: Document;
  };
  try {
    // baseURI 改了之后，a / link / form 的相对 URL 解析才能用。
    // linkedom 不一定支持，但设了不报错。
    if (document.documentElement) {
      (document.documentElement as unknown as { baseURI?: string }).baseURI = finalUrl;
    }
  } catch {
    /* ignore */
  }

  return {
    url,
    finalUrl,
    redirectChain,
    doc: document,
    html: finalHtml,
    status: response.status,
  };
}
