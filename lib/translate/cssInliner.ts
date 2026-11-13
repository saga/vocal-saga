/**
 * 外联样式快照与阅读模式降级。
 *
 * 目标不是依赖某个站点的 CSS 永远在线，而是在生成翻译页面时把样式依赖固定下来：
 * 1. 以较宽的预算收集所有主要 stylesheet；
 * 2. 递归内联可处理的 @import；
 * 3. 将 CSS url() 按原始 CSS 文件地址转换为绝对 URL；
 * 4. 把快照完整性写入 HTML；
 * 5. 任一关键样式无法完整收集时，清除不完整的站点样式并切换到统一 Reader 模式。
 *
 * Reader 模式是系统级后备，不是某个域名的补丁。缓存页面也可以重复调用本模块，
 * 从而把旧版本留下的外链 CSS 升级为自包含快照。
 */
import { parseHTML } from 'linkedom';
import { assertPublicUrl } from '../urlUtils';

export interface InlineCssOptions {
  /** 解析页面相对样式 URL 的基准地址（通常为重定向后的最终 URL）。 */
  baseUrl: string;
  /** 单个 CSS 文件的字节上限。默认 1 MiB。 */
  maxBytesPerSheet?: number;
  /** 整个快照中 CSS 文本的字节上限。默认 4 MiB。 */
  maxBytesTotal?: number;
  /** 单次 CSS 请求超时（毫秒）。默认 8000。 */
  timeoutMs?: number;
  /** 最多直接收集的 stylesheet 数量。默认 24，超限时显式降级。 */
  maxSheets?: number;
  /** @import 最大递归深度。默认 4。 */
  maxImportDepth?: number;
  /** CSS 资源最大请求数（含 @import）。默认 48。 */
  maxRequests?: number;
  /** 可注入 fetch 实现（测试用）。 */
  fetchFn?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** 样式表单项失败时的回调（默认 console.warn）。 */
  onError?: (url: string, reason: string) => void;
  /** 抓取前对每个资源 URL 校验；生产环境默认 assertPublicUrl。 */
  ssrfGuard?: (url: string) => void;
}

const DEFAULT_MAX_BYTES_PER_SHEET = 1024 * 1024;
const DEFAULT_MAX_BYTES_TOTAL = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SHEETS = 24;
const DEFAULT_MAX_IMPORT_DEPTH = 4;
const DEFAULT_MAX_REQUESTS = 48;
const SNAPSHOT_ATTRIBUTE = 'data-fanyi-css-snapshot';
const SNAPSHOT_COMPLETE = 'v2-complete';
const SNAPSHOT_READER = 'v2-reader';

const STYLESHEET_LINK_RE = /<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet/i;
const INLINED_STYLE_RE = /<style\b[^>]*\bdata-fanyi-inlined-css\s*=/i;
const IMPORT_STYLE_RE = /<style\b[^>]*>[\s\S]*?@import\b/i;

/** 只判断源站自带的内联样式，不把翻译扩展自己的样式当作源站 CSS。 */
function hasInlineSiteStyles(html: string): boolean {
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    const body = (match[2] || '').trim();
    if (!body) continue;
    if (/data-fanyi-css|data-fanyi-reader-css|data-fanyi-inlined-css|id=["']fanyi-bilingual-styles["']/i.test(attrs)) continue;
    if (body.startsWith('#onetrust-banner-sdk') || body.startsWith('/* 双语对照样式')) continue;
    return true;
  }
  return false;
}


/** 页面处于 Reader 降级模式时，不再反复尝试恢复注定不完整的旧样式。 */
function hasSnapshotMarker(html: string, marker: string): boolean {
  return new RegExp('\\b' + SNAPSHOT_ATTRIBUTE + '\\s*=\\s*["\']' + marker + '["\']', 'i').test(html);
}

export async function inlineExternalStylesheets(
  html: string,
  options: InlineCssOptions,
): Promise<string> {
  if (hasSnapshotMarker(html, SNAPSHOT_READER)) return html;

  const hasLinkedCss = STYLESHEET_LINK_RE.test(html);
  const hasPreviouslyInlinedCss = INLINED_STYLE_RE.test(html);
  const hasInlineImport = IMPORT_STYLE_RE.test(html);
  const hasTranslationMarkup = /class=["'][^"']*fanyi-(?:translation|original)\b/i.test(html);
  const hasInlineSiteCss = hasInlineSiteStyles(html);

  // 旧缓存可能已经丢失所有源站 CSS，导致只剩翻译标记和基础浏览器样式。
  // 对这种页面也不能直接放行；转成 Reader 布局才有确定的可读性兜底。
  if (!hasLinkedCss && !hasPreviouslyInlinedCss && !hasInlineImport) {
    if (!hasTranslationMarkup || hasInlineSiteCss) return html;
    let document: Document;
    try {
      ({ document } = parseHTML(html) as unknown as { document: Document });
    } catch {
      return html;
    }
    if (!document.documentElement) return html;
    applyReaderFallback(document);
    document.documentElement.setAttribute(SNAPSHOT_ATTRIBUTE, SNAPSHOT_READER);
    document.documentElement.setAttribute('data-fanyi-render-mode', 'reader');
    return '<!doctype html>\n' + document.documentElement.outerHTML;
  }

  // 已有完整快照且没有残留 stylesheet 链接：不再解析大 HTML。
  if (hasSnapshotMarker(html, SNAPSHOT_COMPLETE) && !hasLinkedCss) return html;

  const maxBytesPerSheet = options.maxBytesPerSheet ?? DEFAULT_MAX_BYTES_PER_SHEET;
  const maxBytesTotal = options.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSheets = options.maxSheets ?? DEFAULT_MAX_SHEETS;
  const maxImportDepth = options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const doFetch = options.fetchFn ?? defaultFetch;
  const onError = options.onError ?? defaultOnError;
  const guard = options.ssrfGuard ?? assertPublicUrl;

  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return html;
  }
  if (!document.documentElement) return html;

  const allLinks = collectStylesheetLinks(document, maxSheets + 1);
  const sheetLimitExceeded = allLinks.length > maxSheets;
  const links = allLinks.slice(0, maxSheets);
  const fetchState: CssFetchState = {
    requestCount: 0,
    cache: new Map<string, CssResult>(),
    maxRequests,
    timeoutMs,
    maxBytesPerSheet,
    maxImportDepth,
    doFetch,
    guard,
    onError,
  };

  let complete = !sheetLimitExceeded;
  if (sheetLimitExceeded) {
    onError(options.baseUrl, 'stylesheet count exceeds configured limit (' + maxSheets + ')');
  }

  // 修复历史版本已内联的 CSS：原始 URL 记录在 data-fanyi-inlined-css 中。
  const existingStyleNodes = Array.from(document.querySelectorAll('style'));
  for (const style of existingStyleNodes) {
    const sourceUrl = style.getAttribute('data-fanyi-inlined-css') || options.baseUrl;
    const originalCss = style.textContent || '';
    if (!originalCss.trim()) continue;
    const expanded = await expandCssImports(originalCss, sourceUrl, fetchState, 0, new Set<string>());
    style.textContent = rewriteCssUrls(expanded.css, sourceUrl);
    if (!expanded.complete) complete = false;
  }

  // 并发抓取各主样式表；最终按 DOM 原顺序替换，保持 CSS cascade 顺序。
  const fetched = await Promise.all(
    links.map(async (link) => {
      const absolute = resolveStylesheetHref(link.href, options.baseUrl);
      if (!absolute) {
        onError(link.href, 'invalid stylesheet URL');
        return { link, absolute: link.href, css: '', complete: false };
      }
      const result = await fetchCssBundle(absolute, fetchState, 0);
      return { link, absolute, css: result.css, complete: result.complete };
    }),
  );

  let totalBytes = existingStyleNodes.reduce(
    (total, style) => total + utf8ByteLength(style.textContent || ''),
    0,
  );
  let inlined = 0;
  for (const item of fetched) {
    if (!item.complete || !item.css) {
      complete = false;
      continue;
    }
    const cssBytes = utf8ByteLength(item.css);
    if (totalBytes + cssBytes > maxBytesTotal) {
      onError(item.absolute, 'total CSS budget exceeded (' + maxBytesTotal + ' bytes)');
      complete = false;
      continue;
    }
    totalBytes += cssBytes;
    replaceLinkWithStyle(document, item.link, item.absolute, item.css);
    inlined += 1;
  }

  if (links.length > 0 && inlined !== links.length) complete = false;
  if (complete) {
    document.documentElement.setAttribute(SNAPSHOT_ATTRIBUTE, SNAPSHOT_COMPLETE);
    document.documentElement.removeAttribute('data-fanyi-render-mode');
  } else {
    // 部分样式与原始外链混在一起最容易产生“页面能打开但排版塌陷”的状态。
    // 与其留下不确定的 CSS 组合，不如完全切换到稳定的 Reader 模板。
    applyReaderFallback(document);
    document.documentElement.setAttribute(SNAPSHOT_ATTRIBUTE, SNAPSHOT_READER);
    document.documentElement.setAttribute('data-fanyi-render-mode', 'reader');
    console.warn('[cssInliner] stylesheet snapshot incomplete; switched to Reader mode');
  }

  return '<!doctype html>\n' + document.documentElement.outerHTML;
}

function defaultFetch(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    signal,
    redirect: 'manual',
    headers: { Accept: 'text/css,*/*;q=0.1' },
  });
}

function defaultOnError(url: string, reason: string): void {
  console.warn('[cssInliner] ' + url + ': ' + reason);
}

interface SheetLink {
  el: Element;
  href: string;
  media: string;
}

interface CssFetchState {
  requestCount: number;
  cache: Map<string, CssResult>;
  maxRequests: number;
  timeoutMs: number;
  maxBytesPerSheet: number;
  maxImportDepth: number;
  doFetch: (url: string, signal: AbortSignal) => Promise<Response>;
  guard: (url: string) => void;
  onError: (url: string, reason: string) => void;
}

interface CssResult {
  css: string;
  complete: boolean;
}

/** 收集 stylesheet 链接；只多读取一项就能判断是否触发数量上限。 */
function collectStylesheetLinks(doc: Document, maxSheets: number): SheetLink[] {
  const out: SheetLink[] = [];
  for (const el of Array.from(doc.querySelectorAll('link'))) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = (el.getAttribute('href') || '').trim();
    if (!href || /^(?:data|blob|javascript):/i.test(href)) continue;
    if (out.length >= maxSheets) break;
    out.push({ el, href, media: (el.getAttribute('media') || '').trim() });
  }
  return out;
}

function resolveStylesheetHref(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function isCssResponse(response: Response): boolean {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  if (!ct) return true;
  const mime = ct.split(';')[0].trim();
  return mime === 'text/css' || mime.endsWith('+css') || mime === 'text/plain';
}

async function fetchCssBundle(
  url: string,
  state: CssFetchState,
  depth: number,
  ancestors: Set<string> = new Set<string>(),
): Promise<CssResult> {
  let absolute: string;
  try {
    absolute = new URL(url).href;
  } catch {
    return { css: '', complete: false };
  }
  // 循环只按当前递归路径识别；不同并发 stylesheet 可独立请求，避免 Promise 等待环。
  if (ancestors.has(absolute)) return { css: '', complete: true };
  const cached = state.cache.get(absolute);
  if (cached) return cached;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(absolute);
  const result = await fetchCssBundleInternal(absolute, state, depth, nextAncestors);
  if (result.complete) state.cache.set(absolute, result);
  return result;
}
async function fetchCssBundleInternal(
  absolute: string,
  state: CssFetchState,
  depth: number,
  ancestors: Set<string>,
): Promise<CssResult> {
  if (depth > state.maxImportDepth) {
    state.onError(absolute, '@import depth exceeds ' + state.maxImportDepth);
    return { css: '', complete: false };
  }
  if (state.requestCount >= state.maxRequests) {
    state.onError(absolute, 'CSS request count exceeds ' + state.maxRequests);
    return { css: '', complete: false };
  }
  state.requestCount += 1;
  try {
    state.guard(absolute);
  } catch (error) {
    state.onError(absolute, 'blocked: ' + (error as Error).message);
    return { css: '', complete: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeoutMs);
  let redirectTo: string | undefined;
  let sourceCss = '';

  try {
    const response = await state.doFetch(absolute, controller.signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        state.onError(absolute, 'HTTP ' + response.status + ' without Location');
        return { css: '', complete: false };
      }
      try {
        redirectTo = new URL(location, absolute).href;
      } catch {
        state.onError(absolute, 'invalid CSS redirect Location');
        return { css: '', complete: false };
      }
      try {
        await response.body?.cancel();
      } catch {
        /* ignore cancellation errors */
      }
    } else {
      if (!response.ok) {
        state.onError(absolute, 'HTTP ' + response.status);
        return { css: '', complete: false };
      }
      if (!isCssResponse(response)) {
        state.onError(absolute, 'not CSS: ' + (response.headers.get('content-type') ?? 'unknown'));
        return { css: '', complete: false };
      }
      sourceCss = await readCssTextWithLimit(response, state.maxBytesPerSheet);
    }
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'request or response body timeout (' + state.timeoutMs + 'ms)'
      : (error as Error)?.message ?? String(error);
    state.onError(absolute, reason);
    return { css: '', complete: false };
  } finally {
    clearTimeout(timer);
  }

  // Redirects are fetched only after the current hop's timeout is released.
  // fetchCssBundle re-runs the SSRF guard for every redirect target.
  if (redirectTo) return fetchCssBundle(redirectTo, state, depth, ancestors);

  if (sourceCss.trimStart().startsWith('<')) {
    state.onError(absolute, 'response looks like HTML, not CSS');
    return { css: '', complete: false };
  }
  const expanded = await expandCssImports(sourceCss, absolute, state, depth, ancestors);
  const cleaned = expanded.css.replace(/^\\s*@charset\\s+(['"]).*?\\1\\s*;\\s*/i, '');
  return { css: rewriteCssUrls(cleaned, absolute), complete: expanded.complete };
}

/** Read CSS incrementally so the per-sheet byte limit also bounds peak response memory. */
async function readCssTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* ignore */ }
    throw new Error('stylesheet exceeds ' + maxBytes + ' bytes');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('stylesheet exceeds ' + maxBytes + ' bytes');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
/**
 * 递归展开基础 @import 语法。media 条件保留在 @media 中。
 * layer()/supports() 的复杂组合不猜测语义；标记不完整，最终走 Reader 降级。
 */
async function expandCssImports(
  sourceCss: string,
  sourceUrl: string,
  state: CssFetchState,
  depth: number,
  ancestors: Set<string>,
): Promise<CssResult> {
  const importRe =
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;
  let cursor = 0;
  let output = '';
  let complete = true;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(sourceCss)) !== null) {
    output += sourceCss.slice(cursor, match.index);
    cursor = importRe.lastIndex;

    const href = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    const condition = (match[6] || '').trim();
    const absolute = resolveStylesheetHref(href, sourceUrl);
    if (!absolute) {
      state.onError(sourceUrl, 'could not resolve @import: ' + href);
      complete = false;
      continue;
    }

    // layer()/supports() 的组合需要精确保留级联语义；避免静默改写优先级。
    if (/\b(?:layer|supports)\s*\(/i.test(condition)) {
      state.onError(absolute, 'unsupported @import condition: ' + condition);
      complete = false;
      continue;
    }

    const nested = await fetchCssBundle(absolute, state, depth + 1, ancestors);
    if (!nested.complete) {
      complete = false;
      continue;
    }
    if (!nested.css) continue;

    if (condition && condition.toLowerCase() !== 'all') {
      output += '@media ' + condition + '{\n' + nested.css + '\n}\n';
    } else {
      output += nested.css + '\n';
    }
  }

  output += sourceCss.slice(cursor);
  return { css: output, complete };
}

/**
 * CSS url() 相对路径必须以 stylesheet 自身 URL 为基准，而不是翻译页的 <base>。
 * 绝对 URL、data/blob、fragment 和 var(...) 保持原样。
 */
function rewriteCssUrls(css: string, stylesheetUrl: string): string {
  return css.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi,
    (whole, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const value = ((quote ? quoted : bare) ?? '').trim();
      if (!value || /^(?:data:|blob:|https?:|\/\/|#|var\()/i.test(value)) {
        return whole;
      }
      let resolved: URL;
      try {
        resolved = new URL(value, stylesheetUrl);
      } catch {
        return whole;
      }
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return whole;
      const escaped = resolved.href.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
      return 'url("' + escaped + '")';
    },
  );
}

function replaceLinkWithStyle(doc: Document, link: SheetLink, absolute: string, css: string): void {
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-inlined-css', absolute);
  if (link.media) style.setAttribute('media', link.media);
  const body = css.replace(/<\/style/gi, '<\\/style');
  style.textContent = needsMediaWrap(link.media) ? '@media ' + link.media + '{' + body + '}' : body;
  link.el.replaceWith(style);
}

function needsMediaWrap(media: string): boolean {
  if (!media) return false;
  const normalized = media.trim().toLowerCase();
  return normalized !== 'all' && normalized !== 'screen';
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * 样式快照不完整时采用完全可控的 Reader 样式，而不是混用部分旧 CSS。
 * 这保证“能读”是确定行为；视觉上无法复刻的导航/动效会被有意放弃。
 */
/**
 * 历史翻译缓存可能已带 block id，但不会再经过 prepareDocument。
 * 从所有已翻译块求最低公共祖先，聚焦阅读正文并隐藏路径外的站点 chrome。
 */
function focusCachedReaderRoot(doc: Document): void {
  const blocks = Array.from(doc.querySelectorAll('[data-fanyi-block-id]'));
  if (blocks.length === 0 || !doc.body) return;
  let root: Element | null = blocks[0];
  while (root && !blocks.every((block) => root!.contains(block))) root = root.parentElement;
  if (!root || root === doc.body || root === doc.documentElement) return;
  root.setAttribute('data-fanyi-reader-content', 'true');
  let branch: Element = root;
  while (branch.parentElement && branch.parentElement !== doc.body && branch.parentElement !== doc.documentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== branch) sibling.setAttribute('data-fanyi-reader-hidden', 'true');
    }
    branch = parent;
  }
  if (branch.parentElement === doc.body) {
    for (const sibling of Array.from(doc.body.children)) {
      if (sibling !== branch) sibling.setAttribute('data-fanyi-reader-hidden', 'true');
    }
  }
}

function applyReaderFallback(doc: Document): void {
  focusCachedReaderRoot(doc);
  doc.querySelectorAll('link[rel]').forEach((el) => {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const as = (el.getAttribute('as') || '').toLowerCase();
    if (rel.includes('stylesheet') || (rel.includes('preload') && as === 'style')) {
      el.remove();
    }
  });
  doc.querySelectorAll('style').forEach((el) => el.remove());

  const head = doc.head || doc.documentElement;
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-reader-css', 'true');
  style.textContent = [
    '/* Generic Reader fallback: deliberately independent from source-site CSS. */',
    'html[data-fanyi-render-mode="reader"], html[data-fanyi-render-mode="reader"] body {',
    '  display:block!important; width:100%!important; min-width:0!important; max-width:100%!important;',
    '  min-height:100%!important; margin:0!important; padding:0!important; overflow-x:hidden!important;',
    '  background:#fff!important; color:#222!important; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] body {',
    '  box-sizing:border-box!important; padding:clamp(16px,4vw,48px)!important;',
    '  font-size:18px!important; line-height:1.8!important; overflow-wrap:anywhere!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] *, html[data-fanyi-render-mode="reader"] *::before, html[data-fanyi-render-mode="reader"] *::after {',
    '  box-sizing:border-box!important; min-width:0!important; max-width:100%!important;',
    '  transform:none!important; animation:none!important; transition:none!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] [data-fanyi-reader-hidden="true"],',
    'html[data-fanyi-render-mode="reader"] [data-fanyi-remove="true"] { display:none!important; }',
    'html[data-fanyi-render-mode="reader"] [data-fanyi-reader-content="true"] {',
    '  display:block!important; position:static!important; float:none!important; inset:auto!important;',
    '  width:100%!important; max-width:880px!important; height:auto!important; min-height:0!important;',
    '  margin:0 auto!important; padding:0!important; overflow:visible!important; contain:none!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] h1 { font-size:2.15rem!important; line-height:1.25!important; margin:0 0 1.2rem!important; }',
    'html[data-fanyi-render-mode="reader"] h2 { font-size:1.7rem!important; line-height:1.35!important; margin:2rem 0 .8rem!important; }',
    'html[data-fanyi-render-mode="reader"] h3, html[data-fanyi-render-mode="reader"] h4 { font-size:1.3rem!important; line-height:1.4!important; margin:1.6rem 0 .6rem!important; }',
    'html[data-fanyi-render-mode="reader"] p, html[data-fanyi-render-mode="reader"] li, html[data-fanyi-render-mode="reader"] blockquote {',
    '  font-size:1rem!important; line-height:1.8!important; margin:.75rem 0!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] img, html[data-fanyi-render-mode="reader"] video, html[data-fanyi-render-mode="reader"] canvas, html[data-fanyi-render-mode="reader"] iframe {',
    '  display:block!important; width:auto!important; height:auto!important; max-width:100%!important; max-height:80vh!important; margin:1.2rem auto!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] svg { max-width:100%!important; max-height:75vh!important; }',
    'html[data-fanyi-render-mode="reader"] button svg, html[data-fanyi-render-mode="reader"] a svg,',
    'html[data-fanyi-render-mode="reader"] [role="button"] svg, html[data-fanyi-render-mode="reader"] svg[class*="icon"],',
    'html[data-fanyi-render-mode="reader"] svg[class*="Icon"] {',
    '  display:inline-block!important; width:1.25em!important; height:1.25em!important;',
    '  max-width:1.5em!important; max-height:1.5em!important; vertical-align:middle!important;',
    '}',
    'html[data-fanyi-render-mode="reader"] pre { max-width:100%!important; overflow:auto!important; padding:1rem!important; background:#f5f5f5!important; border-radius:8px!important; }',
    'html[data-fanyi-render-mode="reader"] code { white-space:pre-wrap!important; overflow-wrap:anywhere!important; }',
    'html[data-fanyi-render-mode="reader"] table { display:block!important; width:100%!important; max-width:100%!important; overflow-x:auto!important; border-collapse:collapse!important; }',
    'html[data-fanyi-render-mode="reader"] th, html[data-fanyi-render-mode="reader"] td { padding:.5rem!important; border:1px solid #ddd!important; }',
    'html[data-fanyi-render-mode="reader"] a { color:#075fc7!important; text-decoration:underline!important; }',
    'html[data-fanyi-render-mode="reader"] .fanyi-translation { display:block!important; margin:.2em 0 .8em!important; }',
    'html[data-fanyi-render-mode="reader"] .fanyi-inline-translation { display:inline!important; }',
  ].join('\n');
  head.appendChild(style);
}
