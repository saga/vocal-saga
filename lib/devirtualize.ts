/**
 * Virtual Layout 去虚拟化 — 服务端 DOM rewrite。
 *
 * ## 背景
 * X/Twitter、Reddit 等 SPA-first 网站使用 Virtual Scroller 渲染列表。
 * Virtual Scroller 通过 inline style 给每个列表项设置：
 *
 *   position: absolute; transform: translateY(5227px); top: 0;
 *
 * 这些位置由 JS 动态计算。删除 SPA chunk 后 JS 不执行，
 * transform 停留在初始值，导致所有列表项重叠在一起。
 *
 * ## 方案
 * 在服务端解析 HTML，移除 virtual 定位的 inline style，
 * 让浏览器用普通 block flow 自动排版。
 *
 * 只移除与 virtual 布局相关的属性（position/transform/top/left），
 * 保留颜色、字体、边距等其他样式。
 *
 * ## 处理范围
 * 1. `[data-testid="cellInnerDiv"]` 及其祖先链 — Twitter 虚拟列表项
 * 2. 带 `translate` 的 inline style — 通用虚拟滚动项
 * 3. `[aria-label="Timeline"]` 容器 — 移除固定高度和 overflow 限制
 */

import { parseHTML } from 'linkedom';

/**
 * 从 inline style 字符串中移除 virtual 定位属性。
 *
 * 移除：position:absolute/fixed → static, transform, top, left
 * 保留：color, font, margin, padding, width, display 等
 */
function cleanVirtualStyle(style: string): string {
  return style
    // position: absolute/fixed → static（让元素回到文档流）
    .replace(/position\s*:\s*absolute\s*;?/gi, 'position:static;')
    .replace(/position\s*:\s*fixed\s*;?/gi, 'position:static;')
    // 移除 transform（translateY 定位由 JS 算的，删了让浏览器自己排）
    .replace(/transform\s*:\s*[^;]+;?/gi, '')
    // 移除 top/left（absolute 定位用的）
    .replace(/top\s*:\s*[^;]+;?/gi, '')
    .replace(/left\s*:\s*[^;]+;?/gi, '')
    // 清理多余分号
    .replace(/;{2,}/g, ';')
    .replace(/^;|;$/g, '')
    .trim();
}

/**
 * 从 inline style 中移除高度限制和 overflow。
 *
 * Virtual Scroller 容器通常有固定 height + overflow:auto，
 * 删除后让内容自然展开。
 */
function removeHeightConstraints(style: string): string {
  return style
    .replace(/height\s*:\s*[^;]+;?/gi, '')
    .replace(/max-height\s*:\s*[^;]+;?/gi, '')
    .replace(/overflow\s*:[^;]+;?/gi, 'overflow:visible;')
    .replace(/;{2,}/g, ';')
    .replace(/^;|;$/g, '')
    .trim();
}

/**
 * 对单个元素执行 virtual style 清理。
 * 如果元素的 inline style 包含 position:absolute/fixed 或 translate，
 * 清理这些属性。
 */
function cleanElementIfVirtual(el: Element): boolean {
  const style = el.getAttribute('style');
  if (!style) return false;

  // 只处理包含 absolute/fixed/translate 的元素
  const needClean =
    /position\s*:\s*absolute/i.test(style) ||
    /position\s*:\s*fixed/i.test(style) ||
    /translate/i.test(style);

  if (!needClean) return false;

  const cleaned = cleanVirtualStyle(style);
  if (cleaned) {
    el.setAttribute('style', cleaned);
  } else {
    el.removeAttribute('style');
  }
  return true;
}

/**
 * 对元素及其所有祖先执行 virtual style 清理。
 */
function cleanElementAndAncestors(el: Element, document: Document): number {
  let count = 0;
  let current: Element | null = el;
  while (current && current.tagName !== 'HTML' && current !== document.documentElement) {
    if (cleanElementIfVirtual(current)) count++;
    current = current.parentElement;
  }
  return count;
}

/**
 * 对 Timeline 容器及其祖先链移除高度限制。
 */
function cleanTimelineContainer(el: Element, document: Document): void {
  let current: Element | null = el;
  while (current && current.tagName !== 'HTML' && current !== document.documentElement) {
    const style = current.getAttribute('style');
    if (style && (/height/i.test(style) || /overflow/i.test(style))) {
      const cleaned = removeHeightConstraints(style);
      if (cleaned) {
        current.setAttribute('style', cleaned);
      } else {
        current.removeAttribute('style');
      }
    }
    current = current.parentElement;
  }
}

/**
 * 折叠面板的状态属性。SPA 文档站靠它们配合 CSS 变体把内容裁到 height:0 /
 * clip-path:inset(...)，只摘掉 hidden 仍然是一片空白，必须一起清掉。
 */
const COLLAPSED_STATE_ATTRS = [
  'data-closed',
  'data-hidden',
  'data-starting-style',
  'data-ending-style',
  'data-animating',
] as const;

/**
 * 展开「内容仍在 DOM 里、但被折叠状态藏住」的区域。
 *
 * ## 背景
 * 文档站（如 platform.claude.com）把示例代码放进 accordion：
 *   <div role="region" hidden="until-found" data-closed data-starting-style data-animating>
 *     <pre><code>…</code></pre>
 *   </div>
 * `hidden=until-found` 在规范里等价于 content-visibility:hidden；站点 CSS 又给
 * `[data-starting-style]` 加了 height:0 和 clip-path。这些内容依赖 React 挂载后
 * 点击展开。翻译页会移除 SPA chunk / hydration 脚本（见 spaGuard），交互永远不会
 * 触发，于是缓存页里整块代码凭空「消失」（article/83）。
 *
 * ## 处理范围
 * 只认内容面板，避开同样带 hidden 的下拉菜单、弹窗、响应式占位：
 *   1. 原生 <details> → 补 open
 *   2. hidden="until-found" / role=region+hidden / AccordionPanel+hidden → 清状态
 * 展开后打上 data-fanyi-expanded，由 TRANSLATION_CSS 兜底覆盖站点残留的隐藏样式。
 */
function expandCollapsedContent(document: Document): number {
  let count = 0;

  document.querySelectorAll('details').forEach((node) => {
    const el = node as Element;
    if (el.hasAttribute('open')) return;
    el.setAttribute('open', '');
    el.setAttribute('data-fanyi-expanded', 'true');
    count++;
  });

  document.querySelectorAll(
    '[hidden="until-found"], [role="region"][hidden], [data-cds="AccordionPanel"][hidden]',
  ).forEach((node) => {
    const el = node as Element;
    el.removeAttribute('hidden');
    for (const attr of COLLAPSED_STATE_ATTRS) el.removeAttribute(attr);
    el.setAttribute('data-fanyi-expanded', 'true');

    // 父层 accordion item / header 仍是收起态：caret 会指错方向，
    // 站点 CSS 也可能继续裁剪面板。同步成展开态。
    const parent = el.parentElement;
    if (parent) {
      parent.removeAttribute('data-closed');
      parent.removeAttribute('data-hidden');
      parent.setAttribute('data-panel-open', '');
      parent.querySelectorAll('[aria-expanded="false"]').forEach((trigger) => {
        (trigger as Element).setAttribute('aria-expanded', 'true');
      });
    }
    count++;
  });

  return count;
}

/**
 * 去虚拟化布局 — 服务端 DOM rewrite。
 *
 * 解析 HTML，移除 Virtual Scroller 的 inline 定位样式，
 * 让浏览器用普通 block flow 自动排版。
 *
 * @param html 原始 HTML 字符串
 * @returns 去虚拟化后的 HTML 字符串
 */
export function devirtualizeLayout(html: string): string {
  const { document } = parseHTML(html) as unknown as { document: Document };

  let totalCleaned = 0;

  // 1. 清理 cellInnerDiv 及其祖先链（Twitter 虚拟列表项）
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
  cells.forEach((cell) => {
    totalCleaned += cleanElementAndAncestors(cell as Element, document);
  });

  // 2. 清理带 translate 的元素（通用虚拟滚动项）
  document.querySelectorAll('[style*="translate"]').forEach((el) => {
    if (cleanElementIfVirtual(el as Element)) totalCleaned++;
  });

  // 3. 清理 Timeline 容器的高度限制
  const timelines = document.querySelectorAll('[aria-label="Timeline"]');
  timelines.forEach((tl) => {
    cleanTimelineContainer(tl as Element, document);
  });

  // 4. 清理 [data-testid="primaryColumn"] 容器（Twitter 主列高度限制）
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  if (primaryColumn) {
    cleanTimelineContainer(primaryColumn as Element, document);
  }

  // 5. 移除阻挡正文的 modal / overlay
  // SPA 站点（如 Substack）的 SSR HTML 中包含订阅弹窗等 modal，
  // 正常情况下由 SPA 脚本控制显隐。删除 SPA chunk 后脚本不执行，
  // modal 残留在页面上遮挡正文内容。
  const modals = document.querySelectorAll(
    '[role="dialog"][aria-label*="subscribe" i], ' +
    '[role="dialog"][aria-label*="modal" i], ' +
    '[class*="subscribeDialog" i], ' +
    '[class*="paywall-modal" i]',
  );
  modals.forEach((el) => {
    (el as Element).remove();
    totalCleaned++;
  });

  // 6. 移除 SVG 内的 <title> 元素
  // HTML5 规范将 SVG <title> 视为 "HTML integration point"，
  // 其内容按 HTML 规则解析。在 HTML 模式下 <path .../> 的自闭合斜杠被忽略，
  // 导致 <path> 不自闭合，后续的 HTML 内容（包括正文 div）被解析为 <path> 的子元素，
  // 最终被困在 20x20px 的 SVG 图标内不可见。
  // 移除 SVG <title>（仅用于无障碍 tooltip，翻译页不需要）可避免此问题。
  document.querySelectorAll('svg title').forEach((el) => {
    (el as Element).remove();
    totalCleaned++;
  });

  // 7. 展开 SPA 折叠面板（accordion / <details>）
  // 内容已经在缓存 HTML 里，但静态页没有 JS 可展开；不处理就等于内容丢失。
  const expanded = expandCollapsedContent(document);

  if (totalCleaned > 0 || expanded > 0) {
    console.log(
      `[devirtualize] 清理了 ${totalCleaned} 个元素的 virtual 定位样式` +
      (expanded > 0 ? `，展开了 ${expanded} 个折叠区域` : ''),
    );
  }

  return document.toString();
}
