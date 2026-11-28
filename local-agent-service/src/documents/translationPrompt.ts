/**
 * 提示装配与模型输出解析。
 *
 * 从 translationAgent 抽出：把模板、片段、上下文记忆与 TranslationBrief 拼成一次请求的
 * 输入，再把模型返回解析回 id→译文。解析口径改动只会影响这两个函数。
 */
import { buildCanonicalTermProtections, maskCanonicalTermText } from './canonicalTermProtection.ts';
import { sourceLanguagePromptLabel } from './languageMatch.ts';
import { type TranslationBrief } from './translationBrief.ts';
import { buildProjectVoiceContext } from './voiceContext.ts';
import { type TranslationItem } from './translationSchema.ts';
/**
 * 批次级输出约束：精确 ID 列表与数量只能放在 User Prompt 末尾。
 *
 * Schema 必须跨批次逐字稳定，才能参与 Hy4 flash 等 Provider 的严格前缀缓存；
 * 本批 ID 枚举属于动态内容，不能写进 Schema 或稳定前缀。缺失/重复/越界由
 * parseTranslations() 校验，缺失片段交给上层有界重试。
 */
export function buildBatchOutputConstraint(items: readonly TranslationItem[]): string {
  if (items.length < 1) return '';
  const ids = items.map((item) => item.id).join(', ');
  return [
    '本批输出约束（只适用于本批，不属于可复用规则）：',
    'translations 必须恰好包含 ' + items.length + ' 项；每项的 id 必须逐字取自下面的列表，且每个 id 恰好出现一次：',
    ids,
    '不要输出 precedingSegments 的 id，也不要新增、合并、改写或重复任何 id。',
  ].join('\n');
}

/**
 * 构建批次的用户 Prompt：注入上下文、保护强规范译名、序列化 segments/glossary/brief。
 * @returns 完整用户 Prompt 字符串
 */
export function buildUserPrompt(template: string, items: TranslationItem[], context: any, precedingSegments: TranslationItem[] = [], contextGraph: Record<string, unknown> | null = null, translationBrief?: TranslationBrief): string {
  const promptPrecedingSegments = translationBrief?.precedingSegments ?? precedingSegments.slice(-6).map((item) => ({
    id: item.id, text: item.text, contextPath: item.contextPath || '',
  }));
  const effectiveContextGraph = context.run.translationMode === 'literary'
    ? translationBrief?.contextGraph ?? contextGraph : null;
  const termProtections = context.run.translationMode === 'literary'
    ? buildCanonicalTermProtections(items, effectiveContextGraph, String(context.run.targetLang || 'zh'))
    : [];
  const payloadItems = items.map((item) => ({
    ...item,
    text: maskCanonicalTermText(item.text, termProtections),
  }));
  // Cache-friendly ordering: invariant run metadata and reusable literary context lead;
  // preceding/batch-specific source text stays at the end of the serialized payload.
  const payload = JSON.stringify({
    sourceLang: context.run.sourceLang,
    targetLang: context.run.targetLang,
    translationMode: context.run.translationMode,
    document: context.project.title,
    format: context.project.format,
    glossary: context.run.translationMode === 'literary'
      ? translationBrief?.glossary ?? { document_terms: [] }
      : context.prompt.config?.glossary ?? null,
    voiceContext: context.run.translationMode === 'literary'
      ? translationBrief?.voiceContext ?? buildProjectVoiceContext(context.memory, items, items[0]?.contextPath || context.project.title, precedingSegments)
      : null,
    contextGraph: effectiveContextGraph,
    // These metadata can vary by batch, so they follow invariant run-level context.
    translationBrief: translationBrief ? {
      policyVersion: translationBrief.policyVersion,
      contextHash: translationBrief.contextHash,
      contextChars: translationBrief.contextChars,
      sourceRevisionId: translationBrief.sourceRevisionId,
      promptRevisionId: translationBrief.promptRevisionId,
      memoryRevisionId: translationBrief.memoryRevisionId,
      contextDeltaCount: translationBrief.contextDeltaCount,
      chapterPath: translationBrief.chapterPath || null,
      knowledgeBoundaryOrdinal: (translationBrief.contextGraph as any)?.knowledgeBoundaryOrdinal ?? null,
    } : null,
    // 前文只用于指代/对白轮次解析，不属于本次输出范围；不得重新翻译或输出其 ID。
    precedingSegments: promptPrecedingSegments,
    segments: payloadItems.map((item) => ({
      id: item.id,
      text: item.text,
      kind: item.kind || 'paragraph',
      ...(item.contextPath ? { contextPath: item.contextPath } : {}),
      ...(item.page != null ? { page: item.page } : {}),
      ...(item.level != null ? { level: item.level } : {}),
      ...(item.marker ? { marker: item.marker } : {}),
    })),
  });
  if (template.includes('{{CONTENT}}')) return template.replaceAll('{{CONTENT}}', payload);
  if (template.includes('{{CONTENT_JSON}}')) return template.replaceAll('{{CONTENT_JSON}}', payload);
  if (template.trim()) return template + '\n\n请处理以下 JSON 数据：\n' + payload;
  return [
    '请翻译下面 JSON 中的 segments。源语言：' + sourceLanguagePromptLabel(context.run.sourceLang) + '；目标语言：' + context.run.targetLang + '。',
    '保持每个片段独立，完整保留专名、数字、否定、时态、指代和段落语义。',
    payload,
  ].join('\n\n');
}

/** 解析模型输出时的诊断计数，用来说明「返回了 N 项，为什么只采用 M 项」。 */
export interface TranslationParseDiagnostics {
  duplicateSegmentIds: string[];
  duplicateCount: number;
  unexpectedOutputIds: string[];
  unexpectedCount: number;
  malformedRowCount: number;
}

/**
 * 规范化结构化翻译响应，并记录重复 ID、未知 ID 与格式错误。
 * 这里只接受当前请求的 expectedIds；未知输出不得写入项目，重复 ID 不以“最后一项覆盖前项”
 * 的方式悄悄改变结果。缺失 ID 由上层进行有界重试。
 */
export function parseTranslations(value: unknown, expectedIds: Set<string>): {
  translations: Map<string, string>;
  diagnostics: TranslationParseDiagnostics;
} {
  const outer = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rows = Array.isArray(outer.translations) ? outer.translations : Array.isArray(value) ? value : [];
  const translations = new Map<string, string>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const unexpectedIds = new Set<string>();
  let duplicateCount = 0;
  let unexpectedCount = 0;
  let malformedRowCount = Array.isArray(outer.translations) || Array.isArray(value) ? 0 : 1;

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      malformedRowCount++;
      continue;
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim().slice(0, 160) : '';
    if (!id) {
      malformedRowCount++;
      continue;
    }
    const duplicate = seenIds.has(id);
    seenIds.add(id);
    if (duplicate) {
      duplicateCount++;
      if (expectedIds.has(id)) {
        duplicateIds.add(id);
        // A duplicated ID is ambiguous: discard the first value as well, so the
        // caller treats this segment as missing and retries only that segment.
        translations.delete(id);
      }
    }
    if (!expectedIds.has(id)) {
      unexpectedCount++;
      unexpectedIds.add(id);
      continue;
    }
    if (duplicate) continue;

    const text = typeof row.translated_text === 'string'
      ? row.translated_text
      : typeof row.translation === 'string'
        ? row.translation
        : typeof row.text === 'string'
          ? row.text
          : '';
    if (!text.trim() || text.length > 20000) {
      malformedRowCount++;
      continue;
    }
    translations.set(id, text);
  }

  return {
    translations,
    diagnostics: {
      duplicateSegmentIds: Array.from(duplicateIds).slice(0, 20),
      duplicateCount,
      unexpectedOutputIds: Array.from(unexpectedIds).map((id) => id.slice(0, 160)).slice(0, 20),
      unexpectedCount,
      malformedRowCount,
    },
  };
}
