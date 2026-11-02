import { simpleHash } from './cacheKey';
import { matchSiteRule } from './rules';

// Bump whenever shared translation contracts, style prompts, or review instructions change.
export const TRANSLATION_PROMPT_REVISION = 'web-translation-prompts-2026-11-03-r5';

/**
 * 用于 /fanyi/page 的整页缓存指纹。
 *
 * 客户端 contentHash 描述本次实际抽取的文本/结构；这里再加入翻译配置和
 * 服务端维护的站点规则，防止 provider、文风或站点 prompt 更新后返回旧译文。
 * 只保存短指纹，不保存或回显原文、术语表和站点指令。
 */
export function buildPageCacheFingerprint(
  clientContentHash: string,
  pageUrl: string,
  provider?: string,
  promptStyle?: string,
  translationMode?: string,
  model?: string,
  qualityMode?: string,
): string {
  const rule = matchSiteRule(pageUrl)?.siteRule;
  const ruleContext = rule
    ? {
        hostPattern: rule.hostPattern,
        pathPattern: rule.pathPattern,
        articleRootSelector: rule.articleRootSelector,
        skipSelectors: rule.skipSelectors,
        skipClassPatternExceptions: rule.skipClassPatternExceptions,
        excludeFromTextSelectors: rule.excludeFromTextSelectors,
        translateTables: rule.translateTables,
        blockSelectors: rule.blockSelectors,
        skipTextPatterns: rule.skipTextPatterns,
        documentTerms: rule.documentTerms,
        promptInstructions: rule.promptInstructions,
        removeSelectors: rule.removeSelectors,
        displayCss: rule.displayCss,
        displayJs: rule.displayJs,
      }
    : null;
  const context = JSON.stringify({
    provider: provider || 'deepseek',
    promptStyle: promptStyle || 'default',
    // Page translation no longer runs the literary/document workflow.
    translationMode: 'technical',
    qualityMode: qualityMode === 'enhanced' ? 'enhanced' : 'fast',
    model: model || 'provider-default',
    promptRevision: TRANSLATION_PROMPT_REVISION,
    rule: ruleContext,
  });
  return `page-v4:${clientContentHash}:${simpleHash(context).toString(36)}`;
}
