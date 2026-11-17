/**
 * 文档双模型初译对比。该能力独立于 translation_runs：只读取当前来源、
 * 项目 Prompt 与同一套 TranslationBrief 构建器，不进入正式翻译/审校/采纳流水线。
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { runAgentStructured } from '../agents/runner.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { parseAgentModel } from '../json.ts';
import { sendApiError, sendJson } from '../middleware.ts';
import { logError } from '../log.ts';
import { getDocumentProjectStore } from './projectStore.ts';
import { buildTranslationBrief } from './translationBrief.ts';
import { buildUserPrompt, parseTranslations } from './translationPrompt.ts';
import { TRANSLATION_SCHEMA, LITERARY_TRANSLATION_CONTRACT, MANDATORY_TRANSLATION_CONTRACT } from './translationSchema.ts';
import { applyRunLanguageDirection } from './languageMatch.ts';
import { buildDocumentBatchSessionScope } from './translationConcurrency.ts';
import { buildCanonicalMarkerReminder, buildCanonicalTermProtections, describeCanonicalMarkerMismatch, maskCanonicalTermText, restoreCanonicalTermMarkers } from './canonicalTermProtection.ts';

type ModelChoice = { provider: 'workbuddy' | 'opencode'; model: string };
type ComparisonContext = { req: Request; res: Response; method: string; pathParts: string[]; store: any; projectId: string };

function ensureSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_translation_comparisons (
      comparison_id TEXT PRIMARY KEY,
      source_revision_id TEXT NOT NULL,
      prompt_revision_id TEXT,
      memory_revision_id TEXT,
      source_lang TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      translation_mode TEXT NOT NULL,
      segment_ids_json TEXT NOT NULL,
      source_json TEXT NOT NULL,
      context_hash TEXT,
      context_chars INTEGER NOT NULL DEFAULT 0,
      model_a_json TEXT NOT NULL,
      model_b_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_comparisons_created
      ON document_translation_comparisons(created_at DESC);
  `);
}

function publicRecord(row: any): any {
  return {
    comparisonId: row.comparison_id,
    sourceRevisionId: row.source_revision_id,
    promptRevisionId: row.prompt_revision_id,
    memoryRevisionId: row.memory_revision_id,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    translationMode: row.translation_mode,
    segmentIds: JSON.parse(row.segment_ids_json),
    source: JSON.parse(row.source_json),
    contextHash: row.context_hash,
    contextChars: row.context_chars,
    modelA: JSON.parse(row.model_a_json),
    modelB: JSON.parse(row.model_b_json),
    createdAt: row.created_at,
  };
}

function readRecord(db: any, id: string): any {
  const row = db.prepare('SELECT * FROM document_translation_comparisons WHERE comparison_id = ?').get(id);
  return row ? publicRecord(row) : null;
}

function updateResult(db: any, id: string, key: 'model_a_json' | 'model_b_json', value: any): void {
  db.prepare('UPDATE document_translation_comparisons SET ' + key + ' = ? WHERE comparison_id = ?')
    .run(JSON.stringify(value), id);
}

async function translateForModel(input: {
  project: any; prompt: any; run: any; memory: any; memoryRevisionId: string | null;
  items: any[]; preceding: any[]; brief: any; choice: ModelChoice; comparisonId: string; slot: 'a' | 'b';
}): Promise<any> {
  const { project, prompt, run, items, preceding, brief, choice, comparisonId, slot } = input;
  const context = { project, prompt, run: { ...run, provider: choice.provider, model: choice.model } , memory: input.memory, memoryRevisionId: input.memoryRevisionId };
  const agent = parseAgentModel(choice.model, choice.provider);
  // 用户在对比面板里明确选择模型；继承 thinking / prompt profile，但不允许项目默认模型覆盖选择。
  const profile = { ...getCodeBuddyTaskProfile(prompt.config || {}, 'translation'), model: '', fallbackModel: '' };
  const protections = run.translationMode === 'literary'
    ? buildCanonicalTermProtections(items, brief?.contextGraph ?? null, run.targetLang)
    : [];
  const source = items.map((item) => maskCanonicalTermText(item.text, protections));
  const userPrompt = buildUserPrompt(prompt.userPromptTemplate || '', items, context, preceding,
    brief?.contextGraph ?? null, brief) + buildCanonicalMarkerReminder(source, protections);
  const systemPrompt = [
    applyRunLanguageDirection(prompt.systemPrompt || '', context.run),
    run.translationMode === 'literary' ? LITERARY_TRANSLATION_CONTRACT : '',
    MANDATORY_TRANSLATION_CONTRACT,
  ].filter(Boolean).join('\\n\\n');
  const requestId = comparisonId + ':' + slot;
  const sessionScope = buildDocumentBatchSessionScope({
    projectId: project.projectId,
    runId: comparisonId + ':' + slot,
    promptRevisionId: run.promptRevisionId || 'comparison',
    role: 'translation',
    batchIndex: 0,
    translationMode: run.translationMode,
  });
  const result = await runAgentStructured(agent, userPrompt, systemPrompt, TRANSLATION_SCHEMA,
    requestId, sessionScope, profile);
  const parsed = parseTranslations(result.result, new Set(items.map((item) => item.id)));
  const translations: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [id, value] of parsed.translations) {
    const item = items.find((entry) => entry.id === id);
    const mismatch = describeCanonicalMarkerMismatch(maskCanonicalTermText(item?.text || '', protections), value, protections);
    if (mismatch.length) { rejected.push(id); continue; }
    translations[id] = restoreCanonicalTermMarkers(value, protections, 'target');
  }
  return {
    provider: choice.provider,
    requestedModel: choice.model,
    effectiveModel: agent.model,
    status: Object.keys(translations).length === items.length ? 'completed' : 'partial',
    contextHash: brief?.contextHash || null,
    contextChars: brief?.contextChars || 0,
    translations,
    missingSegmentIds: items.filter((item) => !translations[item.id]).map((item) => item.id),
    rejectedCanonicalMarkerSegmentIds: rejected,
    diagnostics: parsed.diagnostics,
    usage: result.usage || null,
    error: null,
    finishedAt: new Date().toISOString(),
  };
}

async function runComparison(projectId: string, comparisonId: string, choices: [ModelChoice, ModelChoice], items: any[], preceding: any[], sourceRevisionId: string, prompt: any, memoryResult: any, language: { sourceLang: string; targetLang: string; translationMode: string }, db: any): Promise<void> {
  const store = getDocumentProjectStore();
  const { project } = store.getProjectContext(projectId);
  const record = readRecord(db, comparisonId);
  if (!record) return;
  const run = {
    runId: comparisonId,
    sourceRevisionId,
    promptRevisionId: prompt?.promptRevisionId || prompt?.revisionId || '',
    provider: choices[0].provider,
    model: choices[0].model,
    sourceLang: language.sourceLang,
    targetLang: language.targetLang,
    translationMode: language.translationMode,
  };
  try {
    const context = { project, prompt, run, memory: memoryResult.memory || {}, memoryRevisionId: memoryResult.memoryRevisionId || null };
    if (language.translationMode === 'literary') {
      store.assertLiteraryPreprocessingReady(projectId, sourceRevisionId, language.sourceLang, language.targetLang);
    }
    const brief = language.translationMode === 'literary'
      ? buildTranslationBrief(context, items, preceding)
      : null;
    if (brief && (brief.sourceRevisionId !== sourceRevisionId || brief.sourceSegmentIds.length !== items.length)) {
      throw new Error('预处理上下文与当前原文范围不一致，已停止对比翻译。');
    }
    if (brief) {
      db.prepare('UPDATE document_translation_comparisons SET context_hash = ?, context_chars = ? WHERE comparison_id = ?')
        .run(brief.contextHash, brief.contextChars, comparisonId);
    }
    const base = { project, prompt, run, memory: memoryResult.memory || {}, memoryRevisionId: memoryResult.memoryRevisionId || null, items, preceding, brief, comparisonId };
    await Promise.all(choices.map(async (choice, index) => {
      const key = index === 0 ? 'model_a_json' : 'model_b_json';
      const pending = { provider: choice.provider, requestedModel: choice.model, status: 'running', translations: {}, error: null, startedAt: new Date().toISOString() };
      updateResult(db, comparisonId, key, pending);
      try {
        const result = await translateForModel({ ...base, choice, slot: index === 0 ? 'a' : 'b' });
        updateResult(db, comparisonId, key, result);
      } catch (error) {
        const failed = { ...pending, status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
        updateResult(db, comparisonId, key, failed);
        logError('document-comparison', comparisonId + ' ' + choice.provider + '/' + choice.model + ' · ' + failed.error);
      }
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const key of ['model_a_json', 'model_b_json'] as const) {
      const current = JSON.parse(String((db.prepare('SELECT ' + key + ' AS value FROM document_translation_comparisons WHERE comparison_id = ?').get(comparisonId) as any)?.value || '{}'));
      if (current.status === 'pending') updateResult(db, comparisonId, key, { ...current, status: 'failed', error: message, finishedAt: new Date().toISOString() });
    }
    logError('document-comparison', comparisonId + ' · ' + message);
  }
}

export async function handleDocumentModelComparisonRoute(context: ComparisonContext): Promise<boolean> {
  const { req, res, method, pathParts, projectId, store } = context;
  if (pathParts[4] !== 'model-comparisons') return false;
  const db = store.getProjectContext(projectId).db;
  ensureSchema(db);
  if (pathParts.length === 5 && method === 'GET') {
    const rows = db.prepare('SELECT * FROM document_translation_comparisons ORDER BY created_at DESC LIMIT 100').all();
    sendJson(res, 200, { comparisons: rows.map(publicRecord) });
    return true;
  }
  if (pathParts.length === 6 && method === 'GET') {
    const record = readRecord(db, pathParts[5]!);
    if (!record) sendApiError(res, 404, '找不到模型对比记录');
    else sendJson(res, 200, { comparison: record });
    return true;
  }
  if (pathParts.length === 5 && method === 'POST') {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as any : {};
    const ids = Array.isArray(body.segmentIds) ? Array.from(new Set(body.segmentIds.map(String))) : [];
    const choices = Array.isArray(body.models) ? body.models : [];
    if (!ids.length) { sendApiError(res, 400, '请先选择当前阅读页的原文片段'); return true; }
    if (ids.length > 80) { sendApiError(res, 413, '当前页超过单次对比上限（80 段），请缩小阅读页范围后重试'); return true; }
    if (choices.length !== 2 || choices.some((item: any) => !['workbuddy', 'opencode'].includes(item?.provider) || typeof item?.model !== 'string' || !item.model.trim())) {
      sendApiError(res, 400, '必须提供两个有效的模型配置'); return true;
    }
    if (choices[0].provider === choices[1].provider && choices[0].model.trim() === choices[1].model.trim()) {
      sendApiError(res, 400, '两个模型必须不同'); return true;
    }
    const projectContext = store.getProjectContext(projectId);
    const sourceRevisionId = projectContext.currentSourceRevisionId;
    const prompt = store.listPrompts(projectId)[0];
    if (!prompt) { sendApiError(res, 409, '项目尚未保存翻译提示词，请先完成文档工作区初始化'); return true; }
    const sourceRows = projectContext.db.prepare(
      'SELECT segment_id AS id, ordinal, text, kind, context_path AS contextPath, page, level, marker, path, start_time AS start, end_time AS end ' +
      'FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' + ids.map(() => '?').join(',') + ') ORDER BY ordinal'
    ).all(sourceRevisionId, ...ids) as any[];
    if (sourceRows.length !== ids.length) { sendApiError(res, 409, '所选片段不属于当前原文版本，请刷新阅读页后重试'); return true; }
    const first = sourceRows[0]!;
    const preceding = projectContext.db.prepare(
      'SELECT segment_id AS id, text, kind, context_path AS contextPath, page, level, marker FROM source_segments ' +
      'WHERE source_revision_id = ? AND ordinal < ? AND context_path = ? ORDER BY ordinal DESC LIMIT 6'
    ).all(sourceRevisionId, first.ordinal, first.contextPath || '') as any[];
    preceding.reverse();
    const memory = store.getCurrentLiteraryMemory(projectId);
    const language = {
      sourceLang: String(body.sourceLang || prompt.config?.sourceLang || prompt.sourceLang || 'auto'),
      targetLang: String(body.targetLang || prompt.config?.targetLang || prompt.targetLang || 'zh'),
      translationMode: body.translationMode === 'literary' || prompt.config?.translationMode === 'literary' ? 'literary' : 'technical',
    };
    const comparisonId = randomUUID();
    const now = new Date().toISOString();
    const source = sourceRows.map((item) => ({ id: item.id, text: item.text, kind: item.kind, contextPath: item.contextPath, page: item.page, level: item.level, marker: item.marker }));
    const initial = (choice: ModelChoice) => ({ provider: choice.provider, requestedModel: choice.model, status: 'pending', translations: {}, error: null });
    db.prepare(
      'INSERT INTO document_translation_comparisons(comparison_id, source_revision_id, prompt_revision_id, memory_revision_id, source_lang, target_lang, translation_mode, segment_ids_json, source_json, context_hash, context_chars, model_a_json, model_b_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(comparisonId, sourceRevisionId, prompt.promptRevisionId || prompt.revisionId || null, memory.memoryRevisionId || null,
      language.sourceLang, language.targetLang, language.translationMode, JSON.stringify(ids), JSON.stringify(source), null, 0,
      JSON.stringify(initial(choices[0])), JSON.stringify(initial(choices[1])), now);
    void runComparison(projectId, comparisonId, choices as [ModelChoice, ModelChoice], sourceRows, preceding, sourceRevisionId, prompt, memory, language, db)
      .catch((error) => logError('document-comparison', comparisonId + ' background failure · ' + String(error)));
    sendJson(res, 202, { comparison: readRecord(db, comparisonId) });
    return true;
  }
  return false;
}
