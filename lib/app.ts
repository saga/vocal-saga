/**
 * 注入翻译显示所需的 CSS 到 HTML <head> 中。
 * /force/ 和 /translate/ 路径返回的翻译 HTML 包含 .fanyi-original / .fanyi-translation
 * 等 span 元素，但没有扩展端的 <style> 注入，必须由服务端补上。
 */
export const TRANSLATION_CSS = [
  '.fanyi-original{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:0!important}',
  '.fanyi-translation{display:block!important;position:static!important;float:none!important;',
  'clear:both!important;margin:0!important;padding:.15em .6em 0 0!important;',
  // 兜底：旧版本注入的 `border-left: 3px solid currentColor` 在多数页面解析为黑色，
  // 表现为中文译文段前的竖黑条。强制覆盖，确保历史缓存也被修正。
  'border-left:0!important;border-left-width:0!important;max-width:100%!important;',
  'box-sizing:border-box!important;order:1!important;margin-top:.3em!important}',
  // 媒体元素兜底约束：原站 CSS 缺失/被拦截时（典型：内容哈希 CSS 404 后
  // Chrome ORB 拦掉整张样式表），`width:100%` 类的布局类全部失效，图片会
  // 按原始像素宽度（2560px）渲染，撑出横向滚动条。这里兜底压回容器内。
  // height:auto 必须同时给，否则只压宽度不压高度会把图片压扁。
  'img,video,picture,figure,table,iframe{max-width:100%!important}',
  'img,video{height:auto!important}',
  // 展示期标记兜底：processTranslationHtml 在渲染 D1 缓存时，会先跑
  // applySiteDisplayRules（removeSelectors 打 data-fanyi-remove）和
  // applyGlobalNoiseFromUrl（标记 sidebar / 分享栏 / 弹窗）。
  // 这些标记依赖下面两组规则才能真正隐藏/弱化元素，但早期版本注入的
  // TRANSLATION_CSS 漏掉了它们，导致：
  //   1) Oreilly 的 #right-rail 被打上 data-fanyi-remove 却仍显示（article/588）；
  //   2) 通用噪声（aside / 浮窗 / 订阅弹窗）被打标却不生效。
  // 这里补齐，与 pipeline.ts 的 fanyi-bilingual-styles 保持一致。
  '[data-fanyi-remove="true"]{display:none!important;visibility:hidden!important;pointer-events:none!important}',
  '[data-fanyi-low-priority="true"]{opacity:.35;filter:grayscale(60%);transition:opacity .2s ease,filter .2s ease}',
  '[data-fanyi-low-priority="true"]:hover{opacity:1;filter:none}',
  // 动态注入的通知/订阅弹窗兜底隐藏（InfoWorld 等站点的 subscribers notification prompt）
  '[class*="notification"],[id*="notification"],[class*="subscribers"],[id*="subscribers"],[class*="push-notification"],[id*="push-notification"]{display:none!important}',
].join('');

export function injectTranslationCss(html: string): string {
  const styleTag = `<style data-fanyi-css>${TRANSLATION_CSS}</style>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${styleTag}</head>`);
  }
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${styleTag}`);
  }
  if (html.includes('<body')) {
    return html.replace(/(<body[^>]*>)/, `$1${styleTag}`);
  }
  if (html.includes('<html')) {
    return html.replace(/(<html[^>]*>)/, `$1${styleTag}`);
  }
  return styleTag + html;
}

/**
 * 平台无关的 Hono 应用工厂。
 *
 * Cloudflare Worker 入口注入 Cloudflare KV StorageAdapter；单元测试可以注入 MapStorage。
 */

import { Hono } from 'hono';
import { Instapaper, OAuth } from 'instapaper-api';
import { cors } from 'hono/cors';
import { translateText, translateUrl, translateHtml, translateBlocks } from './translate/pipeline';
import { createStructuredDocument } from './translate/document';
import type { ParsedDocument } from './translate/document';
import { hasDocumentRoot, validateTranslationCompleteness } from './translate/translationValidator';
import { simpleHash } from './translate/cacheKey';
import { buildPageCacheFingerprint } from './translate/pageCacheKey';
import {
  savePageTranslation, describeD1Error, utf8ByteLength,
  getD1Databases, createD1FailoverDatabase, readPageTranslationCandidates,
  type PageTranslationCandidate,
} from './translate/pageStore';
import type { PromptStyle, TranslationMode } from './translate/service/shared';
import { setDefaultStorage, type StorageAdapter } from './storage';
import { requireAuth } from './auth';
import { extractClientInfo, formatClientLabel } from './clientInfo';
import { normalizeUrl, cacheKeyUrl, assertPublicUrl } from './urlUtils';
import { looksLikeDomainParkingHtml } from './translate/pageGuard';
import { injectRedirectGuard } from './redirectGuard';
import { stripDangerousScripts, stripNavigationScripts } from './spaGuard';
import { devirtualizeLayout } from './devirtualize';
import { applyGlobalNoiseFromUrl } from './translate/contentHelper';
import { applySiteDisplayRules } from './translate/displayRules';
import { inlineExternalStylesheets } from './translate/cssInliner';
import {
  CF_BASE,
  DS_BASE,
  NVIDIA_BASE,
  OPENROUTER_BASE,
  DS_MODELS,
  resolveModel,
} from './modelResolver';
import {
  setDSApiKey,
  setOpenrouterApiKey,
  setNvidiaApiKey,
  setGeminiApiKey1,
  setGeminiApiKey2,
  setOpencodeApiKey,
  setCfAccountId,
  setCfApiToken,
  setAuthKey,
  getDSApiKey,
  getOpenrouterApiKey,
  getNvidiaApiKey,
  getGeminiApiKey1,
  getGeminiApiKey2,
  getOpencodeApiKey,
  getCfAccountId,
  getCfApiToken,
} from './config';

/**
 * 校验缓存的翻译 HTML 是否结构完整。
 * 旧版 pipeline 曾输出缺少 <html> 标签、<head> 被吞掉的损坏 HTML，
 * 导致页面 CSS 全部丢失。某些损坏缓存虽保留 <html>，但原页面内联
 * 样式被清空，只剩 OneTrust / fanyi 样式，也要视为 miss 重新翻译。
 */
export function isHealthyCachedHtml(html: string): boolean {
  // Structural completeness is not enough: a registrar parking page can have
  // valid HTML, CSS, and translated spans. Never serve it as a healthy translation.
  if (looksLikeDomainParkingHtml(html)) {
    console.warn('[isHealthyCachedHtml] rejecting likely domain-parking page');
    return false;
  }

  // ── 结构检查（保留原有逻辑） ──
  // 旧版 pipeline 曾输出缺少 <html> 标签、<head> 被吞掉的损坏 HTML，
  // 导致页面 CSS 全部丢失。某些损坏缓存虽保留 <html>，但原页面内联
  // 样式被清空，只剩 OneTrust / fanyi 双语样式，也要视为 miss 重新翻译。
  //
  // 注意：文档根节点判定统一走 hasDocumentRoot（见 translationValidator.ts）。
  // 早期版本要求必须存在字面量 `<html` 标签，过严。旧 pipeline 有一类产物
  // 形如 `<!doctype html>\n<body ...><head><base …><style …>` —— `<body>` 排在
  // `<head>` 前且整个文档没有 `<html>` 包裹（openai.com 缓存 id=608 即如此）。
  // 浏览器解析时会自动补出 <html>，且 <head> 内的 base/style 在 "in body" 模式下
  // 仍按 in-head 规则处理，页面照样正常渲染。这类文档被判 unhealthy 会导致：
  //   缓存 miss → 重新 fetch 源站 → 源站现在 403 → 用户看到 500 而不是已有译文。
  // 因此这里放宽为「有 <!doctype html> 或有 <html> 标签」即可，真正的样式完整性
  // 由下面的外联/内联样式检查把关（缺 CSS 的缓存照样会被判 miss）。
  if (!hasDocumentRoot(html)) return false;

  let structurallyHealthy = false;
  // 有外联样式表 → 健康
  if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(html)) {
    structurallyHealthy = true;
  } else {
    // 有原页面内联样式（非 OneTrust、非 fanyi 双语样式）→ 健康
    const styleBlocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
    structurallyHealthy = styleBlocks.some((block) => {
      const contentStart = block.slice(block.indexOf('>') + 1).trimStart();
      return (
        !contentStart.startsWith('#onetrust-banner-sdk') &&
        !contentStart.startsWith('/* 双语对照样式')
      );
    });
  }
  if (!structurallyHealthy) return false;

  // ── <base> 位置检查 ──
  // 旧缓存里 <base> 可能位于相对 CSS 之后，浏览器会用代理域解析这些资源，
  // 导致 arxiv / ar5iv 等页面的 CSS 404、排版全乱。若 <head> 中任何相对路径
  // stylesheet 出现在 <base> 之前，视为损坏并触发重新翻译。
  const headMatch = html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i);
  if (headMatch) {
    const headSection = headMatch[0];
    const baseMatch = headSection.match(/<base\b/i);
    if (baseMatch && baseMatch.index !== undefined) {
      const beforeBase = headSection.slice(0, baseMatch.index);
      const linkMatches = beforeBase.match(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi) || [];
      if (linkMatches.some((link) => /\shref\s*=\s*["']\/[^"']*["']/i.test(link))) {
        console.warn('[isHealthyCachedHtml] <base> appears after relative stylesheet, treating as unhealthy');
        return false;
      }
    }
  }

  // ── 翻译完整性校验（S7 新增） ──
  // 原有检查只看 HTML 结构 + 样式表，不检查翻译是否完整。
  // 调用 validateTranslationCompleteness 校验翻译标记存在 + 内容非空。
  const validation = validateTranslationCompleteness(html);
  if (!validation.healthy) {
    console.warn(`[isHealthyCachedHtml] translation validation failed: ${validation.reason}`);
    return false;
  }

  // ── 外联样式表存活性 ──
  // 缓存里引用的是抓取当时的哈希文件名，原站一发版就 404。此时页面结构
  // 完好、译文也完整，但样式全丢（Tailwind 布局类失效、图片按原尺寸渲染），
  // 用户看到的就是"样式乱了"。探针确认死链后判为不健康，让上层重新翻译；
  // 重新翻译时会走 cssInliner 把样式内联，之后就再也不会烂。
  return true;
}

// ── 工厂 ────────────────────────────────────────────────────
export function createApp(env?: Record<string, unknown>, storage?: StorageAdapter): Hono {
  if (storage) setDefaultStorage(storage);

  // 配置注入（单一入口）：优先从 CF env bindings 读取（生产路径），
  // env 缺失时回退 process.env（Node 测试兼容入口）。
  // 注入后所有 service / modelResolver / auth 统一走 config getter，不再直接读 process.env。
  const getEnv = (key: string): string => {
    const fromEnv = env?.[key];
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
    return process.env[key] || '';
  };
  const dsKey = getEnv('DEEPSEEK_API_KEY');
  const openrouterKey = getEnv('OPENROUTER_API_KEY');
  const nvidiaKey = getEnv('NVIDIA_API_KEY');
  const geminiKey1 = getEnv('GEMINI_API_KEY');
  const geminiKey2 = getEnv('GEMINI_API_KEY_2');
  const opencodeKey = getEnv('OPENCODE_API_KEY');
  const cfAccountId = getEnv('CLOUDFLARE_ACCOUNT_ID');
  const cfApiToken = getEnv('CLOUDFLARE_API_TOKEN');
  const authKey = getEnv('AUTH_KEY');
  // Instapaper：个人 Access Token 可直接保存；OAuth 凭据用于授权回调流程。
  const instapaperAccessToken = getEnv('INSTAPAPER_ACCESS_TOKEN');
  const instapaperClientId = getEnv('INSTAPAPER_CLIENT_ID');
  const instapaperClientSecret = getEnv('INSTAPAPER_CLIENT_SECRET');
  if (dsKey) setDSApiKey(dsKey);
  if (openrouterKey) setOpenrouterApiKey(openrouterKey);
  if (nvidiaKey) setNvidiaApiKey(nvidiaKey);
  if (geminiKey1) setGeminiApiKey1(geminiKey1);
  if (geminiKey2) setGeminiApiKey2(geminiKey2);
  if (opencodeKey) setOpencodeApiKey(opencodeKey);
  if (cfAccountId) setCfAccountId(cfAccountId);
  if (cfApiToken) setCfApiToken(cfApiToken);
  if (authKey) setAuthKey(authKey);

  // 简单的 HTML 转义，防止列表页 title XSS
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const app = new Hono();
  app.use('*', cors());

  // Instapaper v2 SDK 在服务端/Workers 运行；Access Token 和 OAuth Client Secret 绝不返回浏览器。
  const INSTAPAPER_CALLBACK_URL = 'https://s.sunxiunan.com/instapaper';
  const INSTAPAPER_TOKEN_KV_KEY = 'vocal-saga:instapaper:access-token';
  const INSTAPAPER_STATE_COOKIE = 'vocal_saga_instapaper_state';

  /** 构造统一的授权回调结果页，避免把 OAuth code 或 access token 写进页面。 */
  const instapaperCallbackPage = (
    status: number,
    heading: string,
    message: string,
    clearStateCookie = false,
  ): Response => {
    const clearCookie = clearStateCookie
      ? INSTAPAPER_STATE_COOKIE + '=; Max-Age=0; Path=/instapaper; HttpOnly; Secure; SameSite=Lax'
      : '';
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    if (clearCookie) headers.set('Set-Cookie', clearCookie);
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Instapaper · Vocal Saga</title></head>' +
      '<body style="font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#1f2937">' +
      '<h1>' + escapeHtml(heading) + '</h1><p>' + escapeHtml(message) + '</p>' +
      '<p><a href="/translate.html">返回 Vocal Saga 翻译工具</a></p></body></html>';
    return new Response(html, { status, headers });
  };

  /** OAuth 回调获得的 token 存在 Cloudflare KV；部署 Secret 仍是首次配置的 fallback。 */
  async function getInstapaperAccessToken(c: any): Promise<string> {
    const kv = (c.env as any)?.VOCAL_SAGA_KV;
    try {
      if (kv && typeof kv.get === 'function') {
        const stored = await kv.get(INSTAPAPER_TOKEN_KV_KEY);
        if (typeof stored === 'string' && stored.trim()) return stored.trim();
      }
    } catch (error) {
      console.warn('[Instapaper] Could not read OAuth token from KV:', (error as Error)?.message);
    }
    return instapaperAccessToken;
  }

  /**
   * POST /api/instapaper/connect —— 由已有 Vocal Saga AUTH_KEY 保护的 OAuth 发起端。
   * state 放在 SameSite=Lax + HttpOnly cookie 中，防止跨站伪造授权回调。
   */
  app.post('/api/instapaper/connect', requireAuth, (c) => {
    if (!instapaperClientId || !instapaperClientSecret) {
      return c.json({
        error: 'OAuth 尚未配置；请设置 INSTAPAPER_CLIENT_ID 和 INSTAPAPER_CLIENT_SECRET。已有 INSTAPAPER_ACCESS_TOKEN 时仍可直接保存文章。',
      }, 503);
    }
    try {
      const state = crypto.randomUUID();
      const oauth = new OAuth({
        clientId: instapaperClientId,
        clientSecret: instapaperClientSecret,
        redirectUri: INSTAPAPER_CALLBACK_URL,
      });
      const authorizationUrl = oauth.authorizationUrl({ state });
      return new Response(JSON.stringify({ authorizationUrl }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': INSTAPAPER_STATE_COOKIE + '=' + state + '; Max-Age=600; Path=/instapaper; HttpOnly; Secure; SameSite=Lax',
        },
      });
    } catch (error) {
      console.error('[Instapaper] Could not start OAuth:', (error as Error)?.message);
      return c.json({ error: '无法开始 Instapaper 授权，请检查 OAuth 配置。' }, 500);
    }
  });

  /**
   * GET /instapaper —— Instapaper OAuth callback URI。
   * code 只用于服务端 exchange；长期 token 存 KV，不进入 URL 以外的客户端可读数据。
   */
  app.get('/instapaper', async (c) => {
    const code = c.req.query('code') || '';
    const oauthError = c.req.query('error') || '';
    if (!code && !oauthError) {
      return instapaperCallbackPage(
        200,
        'Instapaper 集成',
        '这是 Instapaper OAuth 回调地址。请从 Vocal Saga 翻译工具发起授权；保存文章请返回翻译工具。',
      );
    }

    const state = c.req.query('state') || '';
    const cookieHeader = c.req.header('cookie') || '';
    const stateCookie = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(INSTAPAPER_STATE_COOKIE + '='));
    const expectedState = stateCookie
      ? stateCookie.slice((INSTAPAPER_STATE_COOKIE + '=').length)
      : '';
    if (!state || !expectedState || state !== expectedState) {
      return instapaperCallbackPage(400, '授权验证失败', 'OAuth state 不匹配或已过期，请回到工具重新发起授权。', true);
    }
    if (oauthError) {
      return instapaperCallbackPage(400, '未完成授权', 'Instapaper 未完成授权。你可以返回工具继续使用已配置的 Access Token。', true);
    }
    if (!instapaperClientId || !instapaperClientSecret) {
      return instapaperCallbackPage(503, '授权配置缺失', '服务端尚未配置 INSTAPAPER_CLIENT_ID / INSTAPAPER_CLIENT_SECRET。', true);
    }

    try {
      const oauth = new OAuth({
        clientId: instapaperClientId,
        clientSecret: instapaperClientSecret,
        redirectUri: INSTAPAPER_CALLBACK_URL,
      });
      const token = await oauth.exchangeCode(code);
      const kv = (c.env as any)?.VOCAL_SAGA_KV;
      if (!kv || typeof kv.put !== 'function') {
        return instapaperCallbackPage(503, '无法保存授权', 'Cloudflare KV 不可用，无法持久化 Instapaper Access Token。', true);
      }
      await kv.put(INSTAPAPER_TOKEN_KV_KEY, token.access_token);
      return instapaperCallbackPage(200, 'Instapaper 已连接', '授权已完成。之后通过 Vocal Saga 保存的文章会进入这个 Instapaper 账号。', true);
    } catch (error) {
      const detail = (error as Error)?.message || '未知错误';
      console.error('[Instapaper] OAuth callback failed:', detail);
      return instapaperCallbackPage(502, '授权失败', 'Instapaper 未能完成授权交换，请重试；服务端没有保存新的 Access Token。', true);
    }
  });

  /**
   * POST /api/instapaper/save —— 保存 URL 到配置的 Instapaper 账号。
   * 写入操作必须通过 Vocal Saga 自身 AUTH_KEY 鉴权，不能开放成匿名代理。
   */
  app.post('/api/instapaper/save', requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    const rawTitle = body?.title;
    if (!rawUrl || rawUrl.length > 4096) {
      return c.json({ error: 'url is required and must be at most 4096 characters' }, 400);
    }
    if (rawTitle !== undefined && typeof rawTitle !== 'string') {
      return c.json({ error: 'title must be a string' }, 400);
    }
    const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (title.length > 500) return c.json({ error: 'title must be at most 500 characters' }, 400);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        return c.json({ error: 'url must be a valid http(s) URL without embedded credentials' }, 400);
      }
    } catch {
      return c.json({ error: 'url must be a valid http(s) URL' }, 400);
    }

    const accessToken = await getInstapaperAccessToken(c);
    if (!accessToken) {
      return c.json({
        error: 'Instapaper 未配置；请在 Cloudflare 设置 INSTAPAPER_ACCESS_TOKEN，或先完成 OAuth 连接。',
      }, 503);
    }

    try {
      const client = new Instapaper({ accessToken });
      const saved = await client.bookmarks.save({
        url: parsedUrl.toString(),
        ...(title ? { title } : {}),
      });
      return c.json({
        saved: true,
        bookmark: {
          id: saved.id,
          url: saved.url || parsedUrl.toString(),
          title: saved.title || title || parsedUrl.hostname,
        },
      });
    } catch (error) {
      const err = error as Error & { status?: number };
      const upstreamStatus = Number(err?.status);
      const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 500
        ? upstreamStatus
        : 502;
      console.error('[Instapaper] Save failed:', err?.message || 'unknown error');
      return c.json({
        error: 'Instapaper 保存失败',
        detail: (err?.message || '请稍后重试').slice(0, 300),
      }, status as any);
    }
  });

  /**
   * 翻译 HTML 处理 pipeline：导航清理 → 去虚拟化 → 注入 CSS → 注入守卫。
   *
   * 接受可选 pageUrl：
   *   - 提供时，对白名单 host（x.com / twitter.com）重新应用全局噪声标记，
   *     修复早期翻译时规则尚未完善导致 .fanyi-remove 缺失的历史缓存；
   *   - 不提供则不重新应用（原始翻译 pipeline 已自带 markGlobalNoise）。
   *
   * 应用对象：所有缓存 HTML 路径（/article/:id 等）。
   *
   * 最后一步应用站点展示期规则（去侧边栏 / 加宽等）。它放在最末是因为
   * 可能追加 <script>，不能被前面的脚本清理步骤误删；也因为历史缓存是
   * 在这些规则写出来之前翻译的，只有展示期补得上。
   *
   * 注意：这里**不做**外联样式表内联 —— 那是抓取期（cssInliner）的职责，
   * 放到渲染路径上会给每次 /article/:id 增加若干个网络往返。
   */
  const processTranslationHtml = (html: string, pageUrl?: string): string => {
    const reread = pageUrl ? applyGlobalNoiseFromUrl(html, pageUrl) : html;
    const processed = injectRedirectGuard(
      injectTranslationCss(devirtualizeLayout(stripDangerousScripts(reread))),
    );
    return pageUrl ? applySiteDisplayRules(processed, pageUrl) : processed;
  };

  /**
   * 展示历史缓存前，尝试把遗留 CSS 外链升级为当前版本的样式快照。
   * 这样旧 /article/:id 不需要等用户重新翻译，就能补齐还可访问的 CSS；
   * 若关键 CSS 已失效，cssInliner 会明确切换为 Reader，而不是继续输出半残布局。
   */
  const renderCachedTranslationHtml = async (
    html: string,
    pageUrl: string,
    db?: any,
    cacheId?: number | string,
  ): Promise<string> => {
    let baseUrl = pageUrl;
    const baseMatch = html.match(/<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
    if (baseMatch?.[1]) {
      try {
        baseUrl = new URL(baseMatch[1].replace(/&amp;/g, '&'), pageUrl).href;
      } catch {
        // 坏的历史 base 不应阻止缓存页面显示；退回记录中的原 URL。
      }
    }
    let refreshed = html;
    try {
      refreshed = await inlineExternalStylesheets(html, { baseUrl, timeoutMs: 2500 });
    } catch (error) {
      console.warn('[CachedCss] failed to upgrade cached stylesheet snapshot:', (error as Error)?.message);
    }
    if (refreshed !== html && db && cacheId !== undefined && cacheId !== null) {
      try {
        // db 可能是故障转移包装器：解出实际读到该行的库，否则会用备用库的 id
        // 覆盖主库里同号的不相干记录。
        const writeDb = typeof db.getLastReadDb === 'function'
          ? (db.getLastReadDb() ?? db)
          : db;
        await writeDb.prepare('UPDATE translations SET html = ? WHERE id = ?').bind(refreshed, Number(cacheId)).run();
      } catch (error) {
        // 展示路径不应因历史缓存回写失败而报错；本次响应仍使用刷新后的 HTML。
        console.warn('[CachedCss] could not persist upgraded cached HTML:', (error as Error)?.message);
      }
    }
    return processTranslationHtml(refreshed, pageUrl);
  };

  /**
   * 从跨库候选行里挑一条可用缓存。
   *
   * requireHash=true 用于 /fanyi/page 扩展链路：空 content_hash 的行来自浏览器直访
   * 路径，block ID 是服务端分配的，与扩展端 walker 编号体系不同，不能当命中返回。
   * stale 只在「客户端带了指纹、且存在健康的但指纹不同的行」时为 true，
   * 供 /fanyi/page/check 返回 410 让扩展端重新 POST。
   */
  const pickPageCacheHit = (
    candidates: PageTranslationCandidate[],
    expectedHash: string | null,
    requireHash: boolean,
  ): { hit: PageTranslationCandidate | null; stale: boolean } => {
    let stale = false;
    for (const candidate of candidates) {
      const row = candidate.row;
      const hashValid = Boolean(row?.content_hash);
      if (requireHash && !hashValid) continue;
      if (!isHealthyCachedHtml(row?.html)) continue;
      if (expectedHash && hashValid && expectedHash !== row.content_hash) {
        stale = true;
        continue;
      }
      return { hit: candidate, stale };
    }
    return { hit: null, stale };
  };
  // 原始 HTML 处理 pipeline：仅导航清理 → 注入守卫
  const processOriginalHtml = (html: string) =>
    injectRedirectGuard(stripNavigationScripts(html));

  /**
   * 把任意错误信息清理成可放进 HTTP header 的安全字符串：
   * - 去掉控制字符 / 换行（header 不允许 \r\n）
   * - 截断到 200 字符，避免 header 过长
   * - 兜底空字符串
   *
   * 用于 X-Translate-Warning header，让扩展端能程序化感知 D1 save 失败。
   */
  const sanitizeHeaderValue = (msg: string): string =>
    (msg || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);

  /**
   * 在翻译结果 HTML 的 <body> 起始处注入一个小尺寸警告条：
   * - 仅在 D1 save 失败时调用，让前端（扩展双语视图 + 浏览器直访）都能看到
   * - 固定在右上角、12px 字号、琥珀色配色，避免大面积红色干扰阅读
   * - 纯内联样式 + <details> 原生折叠，不依赖 JS，与已有重定向守卫脚本无冲突
   *
   * @param html 已经过 processTranslationHtml 处理的最终 HTML
   * @param message 来自 catch (e) 的原始错误信息（会被转义 + 截断）
   */
  const injectSaveWarningBanner = (html: string, message: string): string => {
    // 转义 < > & 防止错误信息破坏 HTML 结构
    const safe = (message || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 200)
      .trim();
    const banner =
      '<details data-vs-save-warning open style="position:fixed;top:8px;right:8px;z-index:99999;' +
      'max-width:360px;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;">' +
      '<summary style="padding:6px 10px;font-size:12px;line-height:1.4;cursor:pointer;' +
      'background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:4px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.15);list-style:none;">' +
      '译文已生成，但保存失败（翻译记录里不会出现这条，点击折叠）' +
      '</summary>' +
      '<div style="margin-top:4px;padding:6px 10px;font-size:11px;line-height:1.5;' +
      'background:#fffbeb;color:#78350f;border:1px solid #fde68a;border-radius:4px;' +
      'word-break:break-all;max-height:120px;overflow:auto;">' + safe + '</div>' +
      '</details>';
    // 注入到 <body ...> 之后；若无 <body>，附加到开头
    if (/<body[^>]*>/i.test(html)) {
      return html.replace(/<body[^>]*>/i, (m) => m + banner);
    }
    return banner + html;
  };

  // 每页记录数
  const PAGE_SIZE = 30;

  /**
   * 渲染翻译记录列表页（带分页导航）。
   * 供 GET / 和 GET /page/:page 共用。
   *
   * @param page 当前页码（从 1 开始）
   * @param rows 当前页的记录数组
   * @param total 总记录数（用于计算总页数）
   */
  function renderListPage(page: number, rows: any[], total: number): Response {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);

    // 构建 HTML 列表页
    const items = rows.map((r: any) => {
      const url = `${r.url}`;
      const displayTitle = r.title || r.url;
      // 两个 D1 的 id 各自自增，同一个数字在两边是不同文章；备用库的记录必须带上来源参数，
      // 否则 /article/:id 会落到主库同号记录上。主库保持不带参数，历史链接形态不变。
      const dbIndex = Number(r.dbIndex) > 1 ? Number(r.dbIndex) : 1;
      const articleHref = dbIndex > 1 ? `/article/${r.id}?db=${dbIndex}` : `/article/${r.id}`;
      const sourceTag = dbIndex > 1 ? `<span class="src">库 ${dbIndex}</span>` : '';
      return `<li style="margin-bottom:16px;line-height:1.6">
        <a href="${articleHref}" style="font-size:16px;text-decoration:none;color:#2563eb;font-weight:500">${escapeHtml(displayTitle)}</a>${sourceTag}
        <br><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:#9ca3af;font-size:12px;text-decoration:none">${escapeHtml(url)}</a>
        <button type="button" class="del" data-delete-id="${escapeHtml(String(r.id))}" data-delete-db="${dbIndex}" data-delete-title="${escapeHtml(displayTitle)}">删除</button>
      </li>`;
    }).join('\n');

    // 分页导航：上一页 / 页码 / 下一页
    const prevLink = safePage > 1
      ? `<a href="/page/${safePage - 1}" style="margin:0 6px;text-decoration:none;color:#2563eb">← 上一页</a>`
      : `<span style="margin:0 6px;color:#d1d5db">← 上一页</span>`;
    const nextLink = safePage < totalPages
      ? `<a href="/page/${safePage + 1}" style="margin:0 6px;text-decoration:none;color:#2563eb">下一页 →</a>`
      : `<span style="margin:0 6px;color:#d1d5db">下一页 →</span>`;
    const pager = total > 0
      ? `<div style="margin-top:32px;text-align:center;font-size:14px">${prevLink}<span style="margin:0 6px;color:#6b7280">${safePage} / ${totalPages}</span>${nextLink}</div>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>翻译记录${safePage > 1 ? ` · 第 ${safePage} 页` : ''}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f2937; }
  h1 { font-size: 24px; margin-bottom: 24px; }
  ul { list-style: none; padding: 0; }
  a:hover { text-decoration: underline !important; }
  .empty { color: #9ca3af; font-size: 15px; }
  .src { margin-left:8px; font-size:11px; color:#9ca3af; background:#f3f4f6; padding:2px 6px; border-radius:4px; }
  .del { margin-left:10px; font-size:12px; color:#dc2626; background:none; border:1px solid #fecaca; border-radius:4px; padding:2px 8px; cursor:pointer; }
  .del:hover { background:#fef2f2; }
  .del:disabled { opacity:.5; cursor:default; }
  .tools { margin-top:32px; font-size:12px; }
  .tools button { color:#9ca3af; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; }
</style>
</head>
<body>
<h1>翻译记录</h1>
${items ? `<ul>${items}</ul>` : '<p class="empty">暂无翻译记录</p>'}
${pager}
<div class="tools"><button type="button" id="set-admin-key">设置管理密钥</button></div>
<script>
(function () {
  var STORAGE_KEY = 'vocal-saga:admin-key';
  function readKey() {
    try {
      var saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) return saved;
    } catch (e) {}
    var key = window.prompt('请输入管理密钥（AUTH_KEY）');
    if (!key) return null;
    try { sessionStorage.setItem(STORAGE_KEY, key); } catch (e) {}
    return key;
  }
  function removeKey() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  function deleteRow(button) {
    var id = button.getAttribute('data-delete-id');
    var dbIndex = button.getAttribute('data-delete-db') || '1';
    var title = button.getAttribute('data-delete-title') || ('#' + id);
    if (!window.confirm('确定删除「' + title + '」这条翻译记录吗？删除后无法恢复。')) return;
    var key = readKey();
    if (!key) return;
    button.disabled = true;
    fetch('/api/translations/' + encodeURIComponent(id) + '?db=' + encodeURIComponent(dbIndex), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + key }
    }).then(function (res) {
      if (res.status === 401) {
        removeKey();
        throw new Error('管理密钥不正确，已清除，请重试。');
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ('删除失败（HTTP ' + res.status + '）'));
        return body;
      });
    }).then(function () {
      window.location.reload();
    }).catch(function (err) {
      window.alert(err && err.message ? err.message : String(err));
      button.disabled = false;
    });
  }
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    var button = target.closest('button[data-delete-id]');
    if (button) { deleteRow(button); return; }
    if (target.closest('#set-admin-key')) {
      // 不把已存的密钥预填进 prompt，避免明文回显。
      var hasKey = false;
      try { hasKey = Boolean(sessionStorage.getItem(STORAGE_KEY)); } catch (e) {}
      var key = window.prompt(hasKey ? '已设置管理密钥；输入新值覆盖，留空清除：' : '设置管理密钥：', '');
      if (key === null) return;
      if (key.trim()) {
        try { sessionStorage.setItem(STORAGE_KEY, key.trim()); } catch (e) {}
      } else {
        removeKey();
      }
    }
  });
})();
</script>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  /**
   * 列表行排序：两个 D1 的 id 各自自增，跨库不可比，先按 created_at 倒序，
   * 同一时刻再用 id 兜底，保证同一批写入的顺序稳定。
   */
  function compareListRows(a: any, b: any): number {
    const byTime = String(b.created_at || '').localeCompare(String(a.created_at || ''));
    if (byTime !== 0) return byTime;
    return Number(b.id) - Number(a.id);
  }

  /**
   * 跨库合并取一页记录。
   *
   * 不能只查主库：备用库里是加主库之前的历史译文，主库一旦有数据，
   * 单库查询就再也返回不到它们。每个库先各取「offset + PAGE_SIZE」条，
   * 合并排序后再切出目标页，否则第 N 页的边界会算错。
   *
   * 单库部署（只有 DB999）时行为与逐库查询一致。
   */
  async function fetchListPage(databases: any[], page: number): Promise<{ rows: any[]; total: number }> {
    const targets = databases.filter(Boolean);
    if (!targets.length) return { rows: [], total: 0 };
    const offset = (page - 1) * PAGE_SIZE;
    const limit = offset + PAGE_SIZE;
    const perDatabase = await Promise.all(targets.map(async (db, index) => {
      try {
        const [dataResult, countResult] = await Promise.all([
          db.prepare(
            'SELECT id, url, title, source_lang, target_lang, created_at FROM translations ' +
            'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
          ).bind(limit, 0).all(),
          db.prepare('SELECT COUNT(*) as total FROM translations').first(),
        ]);
        // dbIndex 从 1 开始，与 getD1Databases 的顺序一致，供详情链接回查来源库。
        const rows = (dataResult?.results || []).map((row: any) => ({ ...row, dbIndex: index + 1 }));
        return { rows, total: Number(countResult?.total || 0) };
      } catch (e) {
        console.error('[D1] list error:', e);
        return { rows: [], total: 0 };
      }
    }));
    const merged = perDatabase.flatMap((item) => item.rows).sort(compareListRows);
    return {
      rows: merged.slice(offset, offset + PAGE_SIZE),
      total: perDatabase.reduce((sum, item) => sum + item.total, 0),
    };
  }

  // ── GET / — 首页，渲染第 1 页 ────────────────────────
  app.get('/', async (c) => {
    const { rows, total } = await fetchListPage(getD1Databases(c.env), 1);
    return renderListPage(1, rows, total);
  });

  // ── GET /page/:page — 分页列表 ──────────────────────
  // 必须在 /:id 之前注册，否则 /page/1 会被 :id 捕获
  app.get('/page/:page', async (c) => {
    const pageStr = c.req.param('page');
    const page = parseInt(pageStr, 10);
    if (!Number.isFinite(page) || page < 1) return c.notFound();
    const { rows, total } = await fetchListPage(getD1Databases(c.env), page);
    return renderListPage(page, rows, total);
  });

  // ── GET /article/:id — 从 D1 取出第 N 次翻译结果展示 ────────
  app.get('/article/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.notFound();
    const dbDatabases = getD1Databases(c.env);
    // ?db=N 指定来源库：两个库的 id 各自自增，同一个数字在两边是不同文章。
    // 列表页为备用库的记录带上这个参数；不带则沿用主库优先的故障转移查询。
    const requestedDb = Number(c.req.query('db'));
    const db = Number.isInteger(requestedDb) && requestedDb >= 1 && requestedDb <= dbDatabases.length
      ? dbDatabases[requestedDb - 1]
      : createD1FailoverDatabase(dbDatabases);
    if (!db) return c.json({ error: 'D1 not available' }, 500);
    try {
      const row: any = await db.prepare(
        'SELECT id, url, source_lang, target_lang, html FROM translations WHERE id = ?'
      ).bind(Number(id)).first();
      if (!row) return c.json({ error: 'translation not found' }, 404);

      // 若当前记录健康，直接返回（保持 /article/:id 的语义）
      if (isHealthyCachedHtml(row.html)) {
        // 传入 row.url：对白名单 host 重新应用全局噪声标记，修复旧缓存里
        // .fanyi-remove 缺失导致侧边栏不隐藏的问题（典型：x.com 文章页）。
        return new Response(await renderCachedTranslationHtml(row.html, row.url || '', db, row.id), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 当前记录损坏时，先查同一 URL+语言是否有更新的健康缓存。
      // 典型场景：/fanyi/page 保存了带 content_hash 的记录（id=432），而
      // /translate/* 后来保存了 URL 级记录（id=433），后者应能被 /article/:id 使用。
      const latest: any = await db.prepare(
        'SELECT id, html FROM translations WHERE url = ? AND source_lang = ? AND target_lang = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(row.url, row.source_lang, row.target_lang).first();
      if (latest && isHealthyCachedHtml(latest.html)) {
        console.log(`[D1] article/${id} found newer healthy cache for same URL, serving it`);
        return new Response(await renderCachedTranslationHtml(latest.html, row.url || '', db, latest.id), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 没有可用缓存时重定向到重新翻译，避免展示无 CSS 的畸形页面
      console.warn(`[D1] article/${id} cached HTML is unhealthy, redirecting to re-translate`);
      if (row.url) {
        return c.redirect(`/translate/${encodeURIComponent(row.url.replace(/^https?:\/\//i, ''))}`);
      }
      return c.json({ error: 'cached translation is corrupted' }, 500);
    } catch (e) {
      console.error('[D1] fetch error:', e);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /**
   * DELETE /api/translations/:id —— 删除一条翻译记录。
   *
   * 必须指定来源库：两个 D1 的 id 各自自增，同一个数字在主库和备用库是不同文章，
   * 不带 ?db=N 的故障转移查询会删到主库的同号记录。列表页已把 dbIndex 写进按钮。
   * 删除走 AUTH_KEY 鉴权，密钥由浏览器在管理操作时临时提供，不写进列表页 HTML。
   */
  app.delete('/api/translations/:id', requireAuth, async (c) => {
    // 全局 cors() 放开了跨域读取，但删除只允许本站页面发起；浏览器 fetch 必带 Origin，
    // 命令行调用不带 Origin 时仍由 AUTH_KEY 把关。
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'cross-origin delete denied' }, 403);
    }
    const idText = c.req.param('id');
    if (!/^\d+$/.test(idText)) return c.json({ error: 'invalid id' }, 400);
    const databases = getD1Databases(c.env);
    const dbIndex = Number(c.req.query('db') ?? '1');
    if (!Number.isInteger(dbIndex) || dbIndex < 1 || dbIndex > databases.length) {
      return c.json({ error: 'invalid database index' }, 400);
    }
    const db = databases[dbIndex - 1];
    try {
      const result: any = await db.prepare('DELETE FROM translations WHERE id = ?')
        .bind(Number(idText)).run();
      // D1 的 run() 返回 meta.changes；保留 changes 兜底以兼容绑定代理。
      const deleted = Number(result?.meta?.changes ?? result?.changes ?? 0);
      console.log(`[D1] delete translation id=${idText} db=${dbIndex} deleted=${deleted}`);
      if (deleted < 1) return c.json({ error: 'translation not found' }, 404);
      return c.json({ ok: true, id: Number(idText), db: dbIndex, deleted });
    } catch (e) {
      console.error('[D1] delete error:', e);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ── POST /api/v1/chat/completions ─────────────────────
  app.post('/api/v1/chat/completions', requireAuth, async (c) => {

    const body = await c.req.json().catch(() => ({} as any));
    const { stream, _backend } = body;
    const resolved = resolveModel(body?.model, _backend);
    if (resolved.error) {
      return c.json({ error: resolved.error }, 400);
    }
    const updated = { ...body, model: resolved.model };
    const backend = resolved.backend;

    if (backend !== 'deepseek' && !updated.model) {
      return c.json({ error: 'model is required for this backend', backend }, 400);
    }

    console.log(`[req] model=${resolved.model} backend=${backend} stream=${!!stream} msgs=${updated.messages?.length ?? 0}`);

    if (backend === 'deepseek') {
      if (updated.thinking === undefined) {
        updated.thinking = { type: 'disabled' };
      }
      if (updated.temperature === undefined) {
        updated.temperature = 0.1;
      }
      if (updated.user_id === undefined && !updated.user) {
        updated.user_id = 'vocal-saga';
      }
    }

    let targetUrl: string, headers: Record<string, string>;

    if (backend === 'cloudflare') {
      if (!getCfAccountId() || !getCfApiToken()) {
        return c.json({ error: 'Cloudflare AI not configured' }, 500);
      }
      targetUrl = `${CF_BASE()}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getCfApiToken()}`, 'Content-Type': 'application/json' };
    } else if (backend === 'nvidia') {
      if (!getNvidiaApiKey()) {
        return c.json({ error: 'NVIDIA Build not configured' }, 500);
      }
      targetUrl = `${NVIDIA_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getNvidiaApiKey()}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
    } else if (backend === 'openrouter') {
      if (!getOpenrouterApiKey()) {
        return c.json({ error: 'OpenRouter not configured' }, 500);
      }
      targetUrl = `${OPENROUTER_BASE}/v1/chat/completions`;
      headers = { 'Authorization': `Bearer ${getOpenrouterApiKey()}`, 'Content-Type': 'application/json' };
    } else {
      if (!getDSApiKey()) {
        return c.json({ error: 'DeepSeek not configured' }, 500);
      }
      targetUrl = `${DS_BASE}/v1/chat/completions`;
      headers = { Authorization: `Bearer ${getDSApiKey()}`, 'Content-Type': 'application/json' };
    }

    const startedAt = Date.now();
    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(updated),
      });

      const latency = Date.now() - startedAt;

      if (!upstream.ok) {
        const errData = await upstream.json();
        console.error(`[resp] status=${upstream.status} latency=${latency}ms error=${JSON.stringify(errData)}`);
        return c.json(errData, upstream.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503);
      }

      if (stream && upstream.body) {
        console.log(`[resp] status=${upstream.status} latency=${latency}ms stream=started`);
        // 把上游 ReadableStream 直接透传
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      const data = (await upstream.json()) as Record<string, any>;
      const usage = data.usage;
      console.log(`[resp] status=${upstream.status} latency=${latency}ms` +
        (usage ? ` tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens}` : ''));
      return c.json({ ...data, _backend: backend });
    } catch (err) {
      console.error(`[resp] error="${(err as Error).message}" latency=${Date.now() - startedAt}ms`);
      return c.json({ error: 'Upstream request failed', detail: (err as Error).message }, 502);
    }
  });

  // ── GET /fanyi/page/check ────────────────────────────
  // 浏览器扩展代理：先查询服务端是否已有该 URL 的翻译缓存，
  // 命中则直接返回缓存的 bilingual HTML，未命中返回 204。
  // 这样扩展端在 cache 命中时可以避免本地 prepareHtmlForServer 等重计算。
  app.get('/fanyi/page/check', async (c) => {
    const url = c.req.query('url');
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    // 单次翻译会话标识（扩展端 check→page 共享），用于关联整条链路日志。
    const sid = c.req.header('x-session-id') || '-';

    const source = c.req.query('source') || 'en';
    const target = c.req.query('target') || 'zh';
    const provider = c.req.query('provider') || 'deepseek';
    const promptStyle = c.req.query('promptStyle') || 'default';
    // Cloud webpage translation is always technical; literary workflows stay local/document-only.
    const translationMode: TranslationMode = 'technical';
    const qualityMode = c.req.query('qualityMode') === 'enhanced' ? 'enhanced' : 'fast';
    // 客户端内容指纹与服务端当前的翻译配置/站点规则共同决定缓存是否可复用。
    const clientContentHash = c.req.query('contentHash');
    const expectedContentHash = clientContentHash
      ? buildPageCacheFingerprint(clientContentHash, url, provider, promptStyle, translationMode, undefined, qualityMode)
      : null;

    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'en';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    const dbDatabases = getD1Databases(c.env);
    try {
      // 逐库读取候选行再挑选：只看主库最新一条会让主库的 stale/损坏记录遮住
      // 备用库（以及主库里更早）的有效缓存。空 content_hash 的行来自浏览器直访
      // 路径，block ID 体系与扩展端 walker 不同，必须视为未命中。
      const candidates = await readPageTranslationCandidates(dbDatabases, {
        url: cacheKeyUrl(url),
        sourceLang: sourceStored,
        targetLang: targetStored,
      });
      const { hit, stale } = pickPageCacheHit(candidates, expectedContentHash, true);
      if (hit) {
        console.log(`[fanyi/page/check] D1 cache hit for ${url} sid=${sid}`);
        return new Response(
          await renderCachedTranslationHtml(hit.row.html, url, hit.db, hit.row.id),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              'X-Translate-Source': 'd1-cache',
            },
          },
        );
      }
      if (stale && expectedContentHash) {
        console.log(`[fanyi/page/check] D1 cache stale for ${url} (content_hash mismatch) sid=${sid}`);
        return new Response(null, { status: 410 });
      }
    } catch (e) {
      console.error('[D1] lookup error:', e);
      // 查询失败不阻塞翻译，让扩展端 fallback 到 POST /fanyi/page
    }

    return new Response(null, { status: 204 });
  });

  // ── POST /fanyi/page ─────────────────────────────────
  // 浏览器扩展代理：接收扩展传来的预标记 HTML，返回 bilingual 双语对照 HTML。
  // provider 可选 deepseek / openrouter / nvidia / cloudflare：
  //   - 选择 deepseek 时，必须提供 apiKey，服务端用此 Key 调用 DeepSeek；
  //   - 选择其他 provider 时，使用服务端配置的对应 Key。
  // 用于绕过 Cloudflare Challenge 等反爬场景——扩展在真实浏览器中拿到 HTML，
  // 传给服务端翻译，服务端不再直接 fetch 目标 URL。
  app.post('/fanyi/page', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const { html, url } = body;

    // 客户端浏览器信息：优先用扩展端带来的精确 client 对象，缺失时由 UA header 推导。
    // 用于错误日志定位「某浏览器失败」类问题（如 Firefox Android vs Chrome）。
    const clientInfo = extractClientInfo({
      client: body.client,
      userAgentHeader: c.req.header('user-agent'),
    });
    const clientLabel = formatClientLabel(clientInfo);
    // 单次翻译会话标识（扩展端 check→page 共享），用于关联整条链路日志。
    const sid = c.req.header('x-session-id') || body.sessionId || '-';

    if (!html || typeof html !== 'string' || html.length === 0) {
      return c.json({ error: 'html is required' }, 400);
    }
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    // /fanyi/page 固定为 bilingual 模式
    const mode = 'bilingual' as const;

    // 翻译文风：从 body 读取，不传时下游默认 'default'（向后兼容）
    const promptStyle = body.promptStyle as PromptStyle | undefined;
    // Legacy clients may still send translationMode=literary; the remote web API
    // intentionally keeps this route lightweight and never invokes literary review.
    const translationMode: TranslationMode = 'technical';
    const qualityMode = body.qualityMode === 'enhanced' ? 'enhanced' : 'fast';

    // provider 字段统一命名（扩展端 / 服务端一致），避免与 TranslationService 类混淆
    const provider = body.provider || c.req.query('provider') || 'deepseek';
    const VALID_PROVIDERS = ['deepseek', 'openrouter', 'nvidia', 'cloudflare', 'gemini', 'opencode'];
    if (!VALID_PROVIDERS.includes(provider)) {
      return c.json({ error: 'provider must be one of deepseek, openrouter, nvidia, cloudflare, gemini, opencode' }, 400);
    }

    // deepseek 必须提供 apiKey（客户端 Key），其他 provider 使用服务端 Key
    const apiKey = body.apiKey;
    if (provider === 'deepseek' && (!apiKey || typeof apiKey !== 'string')) {
      return c.json({ error: 'apiKey is required' }, 400);
    }

    const source = body.source || c.req.query('source');
    const target = body.target || c.req.query('target') || 'zh';

    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'en';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    // JS 的 string.length 是 UTF-16 code unit 数，不是网络传输字节数。同时记录字符数和 UTF-8 字节数，
    // 以便排查大页面请求；这里不设置应用层 HTML 大小上限。
    const htmlUtf8Bytes = new TextEncoder().encode(html).byteLength;
    console.log(`[fanyi/page] url=${url} src=${sourceStored} tgt=${targetStored} mode=${mode} provider=${provider} quality=${qualityMode} htmlChars=${html.length} htmlUtf8Bytes=${htmlUtf8Bytes} client=${clientLabel} sid=${sid}`);

    // ── D1 缓存：同 URL+source+target 已存在且 content_hash 匹配则直接返回 ──
    // content_hash 的语义是「这份缓存的 block id 映射是否仍然有效」：
    // /fanyi/page 收到的 HTML 由扩展端预标记 block id，译文回填完全依赖这套 id，
    // 只要 id→元素映射不变缓存就仍然可用。因此优先采用客户端传来的**结构指纹**
    // （block id+tag 序列），它比 simpleHash(html) 更贴合真实失效条件 ——
    // html 里任何无关变化（点赞数、广告位、CSRF token）都会让 simpleHash 失效，
    // 而 id 映射没变时缓存其实仍然有效（白白重译一次）。
    //
    // 旧版扩展不传 contentHash → 退回 simpleHash(html)，保持向后兼容。
    // 两者的字符串形态不同（指纹是 "b1:h3|b2:p|..."，simpleHash 是数字），
    // 所以升级后的第一次访问必然不匹配 → 重新翻译并写入新形态，只付一次代价。
    const clientContentHash =
      typeof body.contentHash === 'string' && body.contentHash.length > 0
        ? body.contentHash
        : String(simpleHash(html));
    const contentHash = buildPageCacheFingerprint(clientContentHash, url, provider, promptStyle, translationMode, undefined, qualityMode);
    const dbDatabases = getD1Databases(c.env);
    const cacheKey = cacheKeyUrl(url);
    try {
      // 与 /fanyi/page/check 用同一套跨库挑选逻辑，避免两条链路对同一份缓存
      // 给出不同结论。空 content_hash 的行属于浏览器直访路径，必须视为未命中。
      const candidates = await readPageTranslationCandidates(dbDatabases, {
        url: cacheKey,
        sourceLang: sourceStored,
        targetLang: targetStored,
      });
      const { hit, stale } = pickPageCacheHit(candidates, contentHash, true);
      if (hit) {
        console.log(`[fanyi/page] D1 cache hit for ${url} sid=${sid}`);
        return new Response(
          await renderCachedTranslationHtml(hit.row.html, url, hit.db, hit.row.id),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600',
              'X-Translate-Source': 'd1-cache',
            },
          },
        );
      }
      if (stale) {
        console.log(`[fanyi/page] D1 cache stale for ${url} (content_hash mismatch), re-translating sid=${sid}`);
      }
    } catch (e) {
      console.error('[D1] lookup error:', e);
      // 查询失败不阻塞翻译，继续走正常流程
    }

    try {
      const result = await translateHtml({
        html,
        url,
        blocks: Array.isArray(body.blocks) ? body.blocks : undefined,
        source: sourceStored,
        target: targetStored,
        mode,
        provider,
        apiKey,
        promptStyle,
        translationMode,
        qualityMode,
      });

      // 翻译 0 个 block → 不缓存 D1，直接返回错误
      if (result.translatedBlocks === 0 && result.blocks > 0) {
        return c.json({
          error: 'Translation produced no results',
          detail: `${result.blocks} blocks extracted but 0 translated — ${result.failureDetail
            || `provider=${provider} returned no usable translations; check upstream logs`}`,
        }, 500);
      }

      // 写入 D1：SQLite UPSERT，www 和非 www 共享同一缓存
      // content_hash 纳入 UNIQUE 约束：内容变化时插入新行，内容不变时更新已有行
      // save 失败不阻塞翻译返回，但要把错误 surface 给前端（header + HTML banner），
      // 否则前端拿不到任何信号、下次访问会重复翻译却无人察觉
      let saveError: string | null = null;
      if (dbDatabases.length) {
        const htmlBytes = utf8ByteLength(result.html);
        try {
          await savePageTranslation(
            dbDatabases,
            {
              url: cacheKey,
              title: result.title || '',
              sourceLang: sourceStored,
              targetLang: targetStored,
              html: result.html,
              contentHash,
            },
            {
              onAttemptError: (error, attempt, willRetry) => {
                console.error(
                  `[D1] save attempt ${attempt} failed for ${url} sid=${sid} htmlBytes=${htmlBytes} ` +
                    `willRetry=${willRetry}: ${describeD1Error(error)}`,
                );
              },
            },
          );
        } catch (e) {
          saveError = describeD1Error(e) || 'D1 write failed';
          console.error(`[D1] save failed for ${url} sid=${sid} htmlBytes=${htmlBytes}: ${saveError}`);
        }
      }

      const finalHtml = saveError
        ? injectSaveWarningBanner(processTranslationHtml(result.html), saveError)
        : processTranslationHtml(result.html);

      return new Response(finalHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Translate-Blocks': String(result.blocks),
          'X-Translate-Chunks': String(result.chunks),
          'X-Translate-Duration-Ms': String(result.duration_ms),
          // Expose the destination path for redirect troubleshooting; omit query/hash values.
          'X-Translate-Final-Url': (() => {
            try {
              const finalUrl = new URL(result.finalUrl);
              return finalUrl.origin + finalUrl.pathname;
            } catch {
              return '';
            }
          })(),
          // save 失败时透出错误信息，让扩展端能 toast 提示
          ...(saveError ? { 'X-Translate-Warning': sanitizeHeaderValue(saveError) } : {}),
        },
      });
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      const rejectedParkingPage = message.includes('likely domain-parking page');
      console.error(`[fanyi/page] error: ${message} | client=${clientLabel} sid=${sid}`);
      return c.json({
        error: message,
        client: clientInfo,
        sessionId: sid,
        ...(rejectedParkingPage ? { code: 'DOMAIN_PARKING_PAGE' } : {}),
      }, rejectedParkingPage ? 422 : 500);
    }
  });

  // ── GET /api/v1/models ────────────────────────────────
  app.get('/api/v1/models', (c) => {
    const models: any[] = [];
    if (getDSApiKey()) {
      for (const id of DS_MODELS) {
        models.push({ id, object: 'model', owned_by: 'deepseek' });
      }
    }
    return c.json({ object: 'list', data: models });
  });

  // ── GET /api/hello ────────────────────────────────────
  app.get('/api/hello', (c) => {
    const name = c.req.query('name') || 'world';
    return c.json({ message: `Hello, ${name}!`, timestamp: new Date().toISOString() });
  });

  // ── 翻译代理 ──────────────────────────────────────────
  app.post('/api/translate/text', async (c) => {
    const { text, source, target, glossary, promptStyle, translationMode } = await c.req.json().catch(() => ({} as any));
    if (!text || typeof text !== 'string') {
      return c.json({ error: 'text is required' }, 400);
    }
    console.log(`[translate/text] chars=${text.length} src=${source || 'en'} tgt=${target || 'zh'}`);
    try {
      const result = await translateText({
        text,
        source,
        target,
        glossary,
        promptStyle: promptStyle as PromptStyle | undefined,
        translationMode: translationMode === 'literary' ? 'literary' : 'technical',
      });
      console.log(`[translate/text] chunks=${result.chunks} duration=${result.duration_ms}ms`);
      return c.json(result);
    } catch (err) {
      console.error('[translate/text] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * POST /api/translate/url
   *
   * UI endpoint for URL translation. Reuses the same validated/cached URL handler
   * as the public /translate/* routes, but wraps the resulting HTML and metrics as JSON.
   */
  app.post('/api/translate/url', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    if (typeof body?.url !== 'string' || !body.url.trim() || body.url.length > 4096) {
      return c.json({ error: 'url is required and must be at most 4096 characters' }, 400);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url.trim());
    } catch {
      return c.json({ error: 'url must be a valid http(s) URL' }, 400);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      return c.json({ error: 'url must be a valid http(s) URL without embedded credentials' }, 400);
    }
    try {
      assertPublicUrl(parsedUrl.toString());
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const supportedProviders = ['deepseek', 'openrouter', 'nvidia', 'cloudflare', 'mimo', 'gemini', 'opencode'];
    if (body.provider !== undefined && !supportedProviders.includes(body.provider)) {
      return c.json({ error: 'provider is not supported', supportedProviders }, 400);
    }
    const validStyles = ['default', 'jinyong', 'acheng', 'wangxiaobo', 'ja-source-natural'];
    const promptStyle = typeof body.promptStyle === 'string' && validStyles.includes(body.promptStyle)
      ? body.promptStyle as PromptStyle
      : undefined;
    const translationMode: TranslationMode = body.translationMode === 'literary' ? 'literary' : 'technical';
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'auto';
    const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : 'zh';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 200) : undefined;

    const response = await handleTranslateRequest(c, parsedUrl.toString(), false, body.provider || 'deepseek', model, {
      source, target, promptStyle, translationMode,
    });
    if (response.status !== 200) {
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = { error: responseText || `URL translation failed with status ${response.status}` };
      }
      return new Response(JSON.stringify(payload), {
        status: response.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const html = await response.text();
    const headers = response.headers;
    return c.json({
      html,
      blocks: Number(headers.get('X-Translate-Blocks') || 0),
      chunks: Number(headers.get('X-Translate-Chunks') || 0),
      duration_ms: Number(headers.get('X-Translate-Duration-Ms') || 0),
      finalUrl: headers.get('X-Translate-Final-Url') || parsedUrl.toString(),
      cacheSource: headers.get('X-Translate-Source') || 'fresh',
    });
  });

  /**
   * POST /api/translate/document/segments
   *
   * 只接受扩展已解析好的结构化片段，并对本次请求做一次有界翻译。
   * Worker 不负责文档解析、跨章节记忆、审校循环、全文导出或断点恢复；
   * 这些长任务由扩展和本机 local-agent-service 管理。
   */
  app.post('/api/translate/document/segments', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const {
      fileName, title, format, segments, warnings, source, target, glossary,
      promptStyle, translationMode, translate, provider, model, apiKey, forceRefresh,
      documentSystemPromptOverride, documentUserPromptTemplate,
    } = body || {};

    if (typeof fileName !== 'string' || !fileName.trim()) {
      return c.json({ error: 'fileName is required' }, 400);
    }

    const startedAt = Date.now();
    const payloadBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    const maxRequestBytes = 5 * 1024 * 1024;
    if (payloadBytes > maxRequestBytes) {
      return c.json({
        error: '结构化文档请求体超过 5 MiB。请缩小批次后重试。',
        payloadBytes,
        maxBytes: maxRequestBytes,
      }, 413);
    }

    let doc: ParsedDocument;
    try {
      doc = createStructuredDocument({ fileName, title, format, segments, warnings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('不支持') ? 415 : message.includes('超过') ? 413 : 400;
      return c.json({ error: message }, status);
    }

    if (translate === false) {
      return c.json({
        fileName,
        title: doc.title,
        format: doc.format,
        segments: doc.segments,
        charCount: doc.meta.charCount,
        segmentCount: doc.segments.length,
        warnings: doc.meta.warnings,
        translated: false,
      });
    }
    if (!doc.segments.length) {
      return c.json({ error: '没有可翻译片段', warnings: doc.meta.warnings }, 400);
    }

    const supportedProviders = ['deepseek', 'openrouter', 'nvidia', 'cloudflare', 'mimo', 'gemini', 'opencode'];
    if (provider !== undefined && !supportedProviders.includes(provider)) {
      return c.json({ error: 'provider is not supported', supportedProviders }, 400);
    }

    try {
      // 一个请求仅调用一次 translateBlocks；底层负责单次请求内必要的 chunk 切分、
      // 有界并发、缓存和缺失 ID 重试，不执行文档级多阶段编排。
      const result = await translateBlocks({
        blocks: doc.segments.map((segment) => ({
          id: segment.id,
          text: segment.text,
          contextPath: segment.contextPath,
          kind: segment.kind,
          level: segment.level,
          marker: segment.marker,
        })),
        source: typeof source === 'string' ? source : 'auto',
        target: typeof target === 'string' ? target : 'zh',
        glossary,
        promptStyle: promptStyle as PromptStyle | undefined,
        translationMode: translationMode === 'literary' ? 'literary' : 'technical',
        concurrency: 4,
        provider,
        model: typeof model === 'string' ? model : undefined,
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        skipCache: forceRefresh === true,
        systemPromptOverride: typeof documentSystemPromptOverride === 'string'
          ? documentSystemPromptOverride.slice(0, 30_000)
          : undefined,
        userPromptTemplate: typeof documentUserPromptTemplate === 'string'
          ? documentUserPromptTemplate.slice(0, 30_000)
          : undefined,
      });

      const translations = Object.fromEntries(result);
      const missingSegmentIds = doc.segments
        .filter((segment) => typeof translations[segment.id] !== 'string' || !translations[segment.id]!.trim())
        .map((segment) => segment.id);
      return c.json({
        fileName,
        title: doc.title,
        format: doc.format,
        translations,
        segmentCount: doc.segments.length,
        charCount: doc.meta.charCount,
        completedSegmentCount: doc.segments.length - missingSegmentIds.length,
        missingSegmentIds,
        complete: missingSegmentIds.length === 0,
        errors: missingSegmentIds.length
          ? ['未返回有效译文的片段：' + missingSegmentIds.slice(0, 20).join(', ')]
          : [],
        warnings: doc.meta.warnings,
        total_ms: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[document/segments] translation failed:', error);
      return c.json({ error: message }, 502);
    }
  });

  /**
   * 公共翻译 handler，供 /translate/*、/s/*、/force/*、/openrt/*、/nvd/*、/gemini/*、/oc/* 使用。
   * @param force 跳过 D1 缓存，强制重新翻译并覆盖写入
   * @param provider LLM 提供方：'deepseek'（默认）、'openrouter'、'nvidia'、'cloudflare'、'mimo'、'gemini'、'opencode'
   * @param model 可选模型名（用于 NVIDIA / Gemini 等多模型服务）
   */
  async function handleTranslateRequest(
    c: any,
    rawPath: string,
    force = false,
    provider: 'deepseek' | 'openrouter' | 'nvidia' | 'cloudflare' | 'mimo' | 'gemini' | 'opencode' = 'deepseek',
    model?: string,
    options?: { source?: string; target?: string; promptStyle?: PromptStyle; translationMode?: TranslationMode },
  ) {
    if (!rawPath) {
      return c.json({ error: 'target url is required in path' }, 400);
    }

    const normalized = normalizeUrl(rawPath);
    if (!normalized) {
      return c.json({ error: 'target url is empty after normalization' }, 400);
    }
    const url = `https://${normalized}`;

    const source = options?.source ?? c.req.query('source');
    const target = options?.target ?? c.req.query('target') ?? 'zh';
    // URL translation supports bilingual rendering only. Literary/technical is a prompt mode.
    const mode = 'bilingual' as const;
    const requestedStyle = options?.promptStyle ?? c.req.query('style');
    const validStyles = ['default', 'jinyong', 'acheng', 'wangxiaobo', 'ja-source-natural'];
    const promptStyle = typeof requestedStyle === 'string' && validStyles.includes(requestedStyle)
      ? requestedStyle as PromptStyle
      : undefined;
    const requestedTranslationMode = options?.translationMode ?? c.req.query('translationMode');
    const translationMode: TranslationMode = requestedTranslationMode === 'literary' ? 'literary' : 'technical';

    // Use the same normalized language values for cache identity and the actual model call.
    const VALID_LANG_RE = /^(auto|[a-zA-Z]{2,3})(-[a-zA-Z]{2,3})?$/;
    const sourceStored = source && VALID_LANG_RE.test(source) ? source : 'auto';
    const targetStored = VALID_LANG_RE.test(target) ? target : 'zh';

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    if (parsed.protocol !== 'https:') {
      // 强制 https（用户输入 http:// 也强制升 https，避免明文抓取）
      return c.json({ error: 'url must be https' }, 400);
    }
    // SSRF 防护：拒绝私网/保留/链路本地地址，防止服务端被用作内网探测代理
    try {
      assertPublicUrl(url);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    console.log(`[translate/url-page] url=${url} src=${sourceStored} tgt=${targetStored} mode=${mode} promptStyle=${promptStyle || 'default'} translationMode=${translationMode} provider=${provider} force=${force}`);

    // A URL result is reusable only when provider/model/style/mode/site rules/prompt revision match.
    // The previous empty content_hash allowed every provider and style to overwrite the same D1 row.
    const dbDatabases = getD1Databases(c.env);
    const cacheKey = cacheKeyUrl(url);
    const contentHash = buildPageCacheFingerprint('url-direct-v1', url, provider, promptStyle, translationMode, model);
    // 缓存行提升到 try 之外：源站抓取失败（403 / 超时）时用它兜底返回旧译文，
    // 而不是给用户一个 500。见下方 catch 分支。
    let cachedRow: any = null;
    if (!force) {
      try {
        // 按 hash 逐库查：主库有其它 provider/style 的旧行时，备用库里匹配的
        // 那一行仍然要能命中；同时记下行所属的真实库，供 CSS 快照回写。
        const candidates = await readPageTranslationCandidates(dbDatabases, {
          url: cacheKey,
          sourceLang: sourceStored,
          targetLang: targetStored,
          contentHash,
        });
        const cached = candidates[0] ?? null;
        cachedRow = cached ? { ...cached.row, db: cached.db } : null;
        if (cached && isHealthyCachedHtml(cached.row.html)) {
          console.log(`[translate/url-page] D1 cache hit for ${url}`);
          return new Response(
            await renderCachedTranslationHtml(cached.row.html, url, cached.db, cached.row.id),
            {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
                'X-Translate-Source': 'd1-cache',
              },
            },
          );
        }
        if (cached) {
          console.warn(`[translate/url-page] D1 cache for ${url} is unhealthy, treating as miss`);
        }
      } catch (e) {
        console.error('[D1] lookup error:', e);
        // 查询失败不阻塞翻译，继续走正常流程
      }
    }

    try {
      const result = await translateUrl({
        url,
        source: sourceStored,
        target: targetStored,
        mode,
        provider,
        model,
        promptStyle,
        translationMode,
        skipCache: force,
      });
      console.log(`[translate/url-page] blocks=${result.blocks} translated=${result.translatedBlocks} chunks=${result.chunks} duration=${result.duration_ms}ms`);

      // 翻译 0 个 block → 服务端翻译失败，不缓存 D1，返回错误
      if (result.translatedBlocks === 0 && result.blocks > 0) {
        return c.json({
          error: 'Translation produced no results',
          detail: `${result.blocks} blocks extracted but 0 translated — ${result.failureDetail
            || `provider=${provider} returned no usable translations; check upstream logs`}`,
        }, 500);
      }

      // 写入 D1：SQLite UPSERT（ON CONFLICT DO UPDATE），不再需要 force 时先 DELETE
      // 用 cacheKey 存储：www 和非 www 共享同一缓存
      // URL 翻译不跟踪输入内容哈希，content_hash 用空串占位（UNIQUE 约束要求非 NULL 才能触发冲突更新）
      // save 失败不阻塞翻译返回，但要把错误 surface 给前端（header + HTML banner），
      // 否则用户直访该 URL 时无法察觉缓存失效、每次访问都重复翻译
      let saveError: string | null = null;
      if (dbDatabases.length) {
        const htmlBytes = utf8ByteLength(result.html);
        try {
          await savePageTranslation(
            dbDatabases,
            {
              url: cacheKey,
              title: result.title || '',
              sourceLang: sourceStored,
              targetLang: targetStored,
              html: result.html,
              contentHash,
            },
            {
              onAttemptError: (error, attempt, willRetry) => {
                console.error(
                  `[D1] save attempt ${attempt} failed for ${url} htmlBytes=${htmlBytes} ` +
                    `willRetry=${willRetry}: ${describeD1Error(error)}`,
                );
              },
            },
          );
        } catch (e) {
          saveError = describeD1Error(e) || 'D1 write failed';
          console.error(`[D1] save failed for ${url} htmlBytes=${htmlBytes}: ${saveError}`);
        }
      }
      const finalHtml = saveError
        ? injectSaveWarningBanner(processTranslationHtml(result.html), saveError)
        : processTranslationHtml(result.html);
      return new Response(finalHtml, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // 翻译结果比原页面更"耐用"，给个 1h 客户端缓存
          'Cache-Control': 'public, max-age=3600',
          // 暴露给浏览器方便看耗时 / 命中情况
          'X-Translate-Blocks': String(result.blocks),
          'X-Translate-Chunks': String(result.chunks),
          'X-Translate-Duration-Ms': String(result.duration_ms),
          // Expose final destination on fresh server-fetch responses; strip query/hash values.
          'X-Translate-Final-Url': (() => {
            try {
              const finalUrl = new URL(result.finalUrl);
              return finalUrl.origin + finalUrl.pathname;
            } catch {
              return '';
            }
          })(),
          // save 失败时透出错误信息，前端可程序化感知
          ...(saveError ? { 'X-Translate-Warning': sanitizeHeaderValue(saveError) } : {}),
        },
      });
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      const rejectedParkingPage = message.includes('likely domain-parking page');
      console.error(`[translate/url-page] error url=${url}:`, message);
      // A stale-cache fallback must not resurrect the same parking page that caused
      // the live fetch to be rejected.
      if (cachedRow?.html && !looksLikeDomainParkingHtml(cachedRow.html)) {
        console.warn(`[translate/url-page] serving stale D1 cache for ${url} after failure`);
        return new Response(await renderCachedTranslationHtml(cachedRow.html, url, cachedRow.db, cachedRow.id), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=600',
            'X-Translate-Source': 'd1-stale-fallback',
            'X-Translate-Warning': sanitizeHeaderValue(message),
          },
        });
      }
      return c.json({
        error: message,
        ...(rejectedParkingPage ? { code: 'DOMAIN_PARKING_PAGE' } : {}),
      }, rejectedParkingPage ? 422 : 500);
    }
  }

  /**
   * 把 /s/<domain-or-shorthand>/<path> 转成完整 URL。
   * 规则：
   *   - 单单词无点号 → www.<word>.com（如 /s/medium/article → https://www.medium.com/article）
   *   - 含点号则当完整域名用（如 /s/example.com/xxx → https://example.com/xxx）
   */
  app.get('/s/*', async (c) => {
    let raw = decodeURIComponent(c.req.path.slice('/s/'.length));
    if (!raw) {
      return c.json({ error: 'target is required after /s/' }, 400);
    }

    // 剥离 scheme（兼容 /s/https://github.com/... 和 /s/github.com/...）
    raw = raw.replace(/^https?:\/\//i, '');

    const slashIdx = raw.indexOf('/');
    const firstSeg = slashIdx < 0 ? raw : raw.slice(0, slashIdx);
    const rest = slashIdx < 0 ? '' : raw.slice(slashIdx + 1);

    // 单单词无点号 → 自动补成 www.<word>.com
    const host = firstSeg.includes('.') ? firstSeg : `www.${firstSeg}.com`;

    const resolved = rest ? `https://${host}/${rest}` : `https://${host}`;
    return handleTranslateRequest(c, resolved);
  });

  /**
   * GET /translate/<target-without-scheme>
   *
   * 浏览器直访入口：把目标 URL 抓下来 + 翻译 + 双语回填，返回渲染好的 HTML。
   * 路径里的 `target` 是去掉 `https://` 后的剩余部分（如 `example.com/foo`），
   * 浏览器地址栏直接拼就能用，不需要带 Authorization header。
   *
   * 路径格式：
   *   - /translate/example.com              → https://example.com
   *   - /translate/example.com/foo/bar      → https://example.com/foo/bar
   *   - /translate/https%3A%2F%2Fx.com%2Fy  → https://x.com/y （含 scheme 的 URL 自动剥）
   *
   * Query params（可选）：
 *   - source / target: ISO 代码，默认 auto / zh
 *   - mode: 已废弃，全局固定为 bilingual
 *
   * Auth: 故意不校验。原因：浏览器直访是核心使用场景，Authorization header
   *       没法在地址栏导航时附带。这个端点等同于「公开代理」，信任部署在
   *       自己域上、需要谨慎开放（建议加 Cloudflare Access / WAF 限流）。
   */
  app.get('/translate/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/translate/'.length));
    return handleTranslateRequest(c, raw);
  });

  // ── 强制翻译：跳过 D1 缓存，强制重新抓取+翻译 ──────────
  // 流量限制：每 IP 每分钟最多 1 次（防滥用）
  const forceRateLimit = new Map<string, number>();
  const FORCE_RATE_LIMIT_MS = 30_000; //

  app.get('/force/*', (c) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    const last = forceRateLimit.get(ip) || 0;
    if (now - last < FORCE_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((FORCE_RATE_LIMIT_MS - (now - last)) / 1000);
      return c.json({ error: `Rate limit: 1 request per 30s. Retry after ${retryAfter}s` }, 429);
    }
    forceRateLimit.set(ip, now);
    // 清理过期条目（防止内存泄漏）
    if (forceRateLimit.size > 1000) {
      for (const [key, ts] of forceRateLimit) {
        if (now - ts > FORCE_RATE_LIMIT_MS) forceRateLimit.delete(key);
      }
    }
    const raw = decodeURIComponent(c.req.path.slice('/force/'.length));
    return handleTranslateRequest(c, raw, /* force */ true);
  });

  // ── OpenRouter 免费模型翻译：使用 openrouter/free ──────────
  app.get('/openrt/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/openrt/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'openrouter');
  });

  // ── NVIDIA 翻译：使用 build.nvidia.com ──────────
  // /nvd/{url} → moonshotai/kimi-k2.6
  // /nvd/deepseek/{url} → deepseek-ai/deepseek-v4-flash
  // /nvd/qwen/{url} → qwen/qwen3-next-80b-a3b-instruct
  app.get('/nvd/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/nvd/'.length));
    let urlPath = raw;
    let model: string | undefined = 'stepfun-ai/step-3.7-flash';
    if (raw.startsWith('deepseek/')) {
      urlPath = raw.slice('deepseek/'.length);
      model = 'deepseek-ai/deepseek-v4-flash';
    } else if (raw.startsWith('qwen/')) {
      urlPath = raw.slice('qwen/'.length);
      model = 'qwen/qwen3-next-80b-a3b-instruct';
    }
    return handleTranslateRequest(c, urlPath, /* force */ false, /* provider */ 'nvidia', model);
  });

  // ── MiMo 翻译：使用 MiMo Auto 免费 API ──────────
  app.get('/mimo/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/mimo/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'mimo');
  });

  // ── Gemini 翻译：使用 Google Gemini 原生 API ──────────
  // /gemini/{url} → gemini-3.1-flash-lite
  app.get('/gemini/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/gemini/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'gemini', 'gemini-3.1-flash-lite');
  });

  // ── OpenCode 翻译：使用 opencode.ai/zen OpenAI 兼容 API ──────────
  // /oc/{url} → big-pickle 模型
  app.get('/oc/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/oc/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'opencode');
  });

  // ── Cloudflare AI 翻译：通过 CF REST API 调用 Workers AI ──────────
  app.get('/cf/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/cf/'.length));
    return handleTranslateRequest(c, raw, /* force */ false, /* provider */ 'cloudflare');
  });

  // ── 原始页面：抓取 URL 并返回原始 HTML，不做翻译 ──────────
  // /original/{url} 和 /o/{url} 是别名
  // 使用 <base> 标签让浏览器原生解析相对 URL
  async function handleOriginalRequest(c: any, rawPath: string) {
    if (!rawPath) {
      return c.json({ error: 'target url is required' }, 400);
    }
    const normalized = normalizeUrl(rawPath);
    if (!normalized) {
      return c.json({ error: 'target url is empty after normalization' }, 400);
    }
    const url = `https://${normalized}`;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }
    // SSRF 防护：拒绝私网/保留/链路本地地址
    try {
      assertPublicUrl(url);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    try {
      const { parseHTML } = await import('linkedom');
      const { fetchPage } = await import('./translate/urlFetcher');
      const page = await fetchPage(url);

      // 注入 <base> 标签让浏览器原生解析相对 URL（图片、链接等）。
      // 原页面若把 <base> 放在相对 CSS/JS 之后，必须移到 <head> 最前面，
      // 否则浏览器仍用当前页面地址解析这些资源（如 arxiv / ar5iv）。
      const baseUrl = page.finalUrl.replace(/\/?$/, '/');
      const { document } = parseHTML(page.html) as { document: Document };
      const head = document.head;
      const existingBase = document.querySelector('head > base');
      if (existingBase) {
        existingBase.setAttribute('href', baseUrl);
        if (head && head.firstChild !== existingBase) {
          head.insertBefore(existingBase, head.firstChild);
        }
      } else {
        const base = document.createElement('base');
        base.setAttribute('href', baseUrl);
        if (head) head.insertBefore(base, head.firstChild);
      }

      const html = '<!doctype html>\n' + document.documentElement.outerHTML;
      return new Response(processOriginalHtml(html), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Original-Url': page.finalUrl,
        },
      });
    } catch (err) {
      console.error('[original] error:', err);
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  app.get('/original/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/original/'.length));
    return handleOriginalRequest(c, raw);
  });

  app.get('/o/*', (c) => {
    const raw = decodeURIComponent(c.req.path.slice('/o/'.length));
    return handleOriginalRequest(c, raw);
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}
