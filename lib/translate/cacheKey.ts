import type { Glossary } from './service/_service';

export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & 0x7fffffff;
  }
  return hash;
}

export function generateTranslationCacheKey(
  jsonContent: string,
  sourceLang: string,
  targetLang: string,
  provider?: string,
  promptStyle?: string,
  glossary?: Glossary,
  sitePrompt?: string,
  translationMode?: string,
  model?: string,
): string {
  // 把 provider / promptStyle / glossary / sitePrompt 都纳入 hash，
  // 避免切换 LLM、文风、改术语表、改站点规则后读到旧脏缓存（分析报告 P0）。
  // 关键：这些维度只在“显式传入且非空”时才追加到 extra，因此：
  //   - 旧调用方没传 glossary/sitePrompt 时 extra 与改动前完全一致 → key 不变，向后兼容
  //   - 用户没术语表（glossary 为空/undefined）时 key 也不变，不无谓地 bust 缓存
  const base = provider || promptStyle ? `${provider ?? ''}:${promptStyle ?? ''}` : '';
  // Bump this revision when translation instructions change, so bad older translations cannot be reused.
  const extra =
    'translation-prompt-v5|' + base +
    (glossary?.document_terms?.length
      ? `|g${simpleHash(JSON.stringify(glossary.document_terms))}`
      : '') +
    (glossary?.site_instructions?.length
      ? `|s${simpleHash(JSON.stringify(glossary.site_instructions))}`
      : '') +
    (glossary?.document_system_prompt_override?.trim()
      ? `|sys${simpleHash(glossary.document_system_prompt_override)}`
      : '') +
    (glossary?.document_user_prompt_template?.trim()
      ? `|usr${simpleHash(glossary.document_user_prompt_template)}`
      : '') +
    (sitePrompt?.trim() ? `|r${simpleHash(sitePrompt)}` : '') +
    (translationMode ? `|m${translationMode}` : '') +
    (model?.trim() ? `|model${simpleHash(model.trim())}` : '');
  const contentHash = simpleHash(jsonContent + extra);
  const contentPrefix = jsonContent.substring(0, 200);
  const prefixHash = simpleHash(contentPrefix + extra);
  return `translation_${sourceLang}_${targetLang}_${contentHash}_${prefixHash}`;
}
