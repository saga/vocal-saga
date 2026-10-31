#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLiteraryReview } from '../src/literary.ts';

const MAX_BATCH_SIZE = 32;

export function parseJsonl(text) {
  return String(text || '').split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) { throw new Error('JSONL 第 ' + (index + 1) + ' 行无法解析：' + (error instanceof Error ? error.message : String(error))); }
  });
}

export function validateBenchmarkDataset(rows, { allowSmall = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('Benchmark dataset 必须是 JSONL 对象数组。');
  if (rows.length > 200 || (!allowSmall && rows.length < 100) || (allowSmall && rows.length < 1)) {
    throw new Error(allowSmall
      ? 'Smoke dataset 必须包含 1-200 段。'
      : '正式 Benchmark 必须包含 100-200 段；少量样本只能使用 --allow-small 做连通性检查。');
  }
  const seen = new Set();
  let targetLang = '';
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('第 ' + (index + 1) + ' 条必须是对象。');
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const source = typeof row.source === 'string' ? row.source.trim() : '';
    const draft = typeof row.draft === 'string' ? row.draft.trim() : '';
    const genre = typeof row.genre === 'string' ? row.genre.trim() : '';
    const lang = typeof row.targetLang === 'string' && row.targetLang.trim() ? row.targetLang.trim() : 'zh-CN';
    if (!id || !source || !draft || !genre) throw new Error('第 ' + (index + 1) + ' 条缺少 id/source/draft/genre。');
    if (seen.has(id)) throw new Error('Benchmark segment ID 重复：' + id);
    seen.add(id);
    if (!/^zh(?:-CN|-TW)?$/iu.test(lang)) throw new Error('只支持中文目标语言，segment=' + id + ' targetLang=' + lang);
    if (targetLang && targetLang !== lang) throw new Error('同一 Benchmark 不允许混合目标语言。');
    targetLang = lang;
    const rights = row.rights && typeof row.rights === 'object' ? row.rights : {};
    if (!['public-domain', 'user-owned', 'licensed'].includes(String(rights.basis || '')) ||
        typeof rights.reference !== 'string' || !rights.reference.trim()) {
      throw new Error('segment=' + id + ' 必须声明 rights.basis（public-domain/user-owned/licensed）和 rights.reference。');
    }
    return {
      id, source, draft, genre, targetLang: lang,
      rights: { basis: rights.basis, reference: rights.reference.trim(), notes: typeof rights.notes === 'string' ? rights.notes.trim() : '' },
    };
  });
}

export function summarizeEditorOutput(rows, output) {
  const translations = output?.translations && typeof output.translations === 'object' ? output.translations : {};
  const reviewed = rows.filter((row) => typeof translations[row.id] === 'string');
  const edited = reviewed.filter((row) => translations[row.id] !== row.draft);
  const findings = Array.isArray(output?.findings) ? output.findings : [];
  const aspectCounts = {};
  for (const finding of findings) {
    const aspect = typeof finding.editingAspect === 'string' ? finding.editingAspect : 'unspecified';
    aspectCounts[aspect] = (aspectCounts[aspect] || 0) + 1;
  }
  return {
    segmentCount: rows.length,
    reviewedCount: reviewed.length,
    editedCount: edited.length,
    unchangedCount: reviewed.length - edited.length,
    missingCount: rows.length - reviewed.length,
    editRatePercent: reviewed.length ? Math.round(edited.length / reviewed.length * 1000) / 10 : null,
    unchangedRatePercent: reviewed.length ? Math.round((reviewed.length - edited.length) / reviewed.length * 1000) / 10 : null,
    findingCount: findings.length,
    editingAspectCounts: aspectCounts,
  };
}

export function buildBlindReviewPacket(rows, first, second, swap = false) {
  const firstTranslations = first?.translations || {};
  const secondTranslations = second?.translations || {};
  const modelA = swap ? secondTranslations : firstTranslations;
  const modelB = swap ? firstTranslations : secondTranslations;
  const items = rows.map((row) => ({
    id: row.id,
    genre: row.genre,
    targetLang: row.targetLang,
    source: row.source,
    initialDraft: row.draft,
    candidateA: typeof modelA[row.id] === 'string' ? modelA[row.id] : row.draft,
    candidateB: typeof modelB[row.id] === 'string' ? modelB[row.id] : row.draft,
  }));
  return {
    packet: {
      version: 1,
      instructions: '候选 A/B 的模型身份已隐藏。先独立评价中文自然度、叙述声音、人物差异、文学节奏和过度编辑，再对照原文评价忠实度。不要因为改动更多就给更高分。',
      rubric: {
        chineseNaturalness: '中文是否自然、准确、成熟；是否残留翻译腔。',
        narrativeVoice: '是否保留叙述距离、语域、语气和作者声音。',
        characterVoice: '人物对白是否有差异；是否凭空添加口头禅、方言或情绪。',
        literaryRhythm: '是否尊重长句、重复、停顿、留白和修辞。',
        fidelity: '是否漏译、增译，或改变视角、否定、指代、时态和语气强度。',
        overEditing: '是否为了润色而破坏原稿已有的准确表达或文学效果。',
      },
      items,
    },
    mapping: {
      candidateA: swap ? 'second' : 'first',
      candidateB: swap ? 'first' : 'second',
    },
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/gu, '""') + '"';
}

function humanReviewCsv(rows) {
  const columns = [
    'id', 'candidateA_naturalness', 'candidateB_naturalness',
    'candidateA_voice', 'candidateB_voice', 'candidateA_rhythm', 'candidateB_rhythm',
    'candidateA_fidelity', 'candidateB_fidelity', 'candidateA_over_edit',
    'candidateB_over_edit', 'preference', 'critical_error', 'notes',
  ];
  return [columns.join(','), ...rows.map((row) => csvCell(row.id) + ',' + columns.slice(1).map(() => '""').join(','))].join('\n') + '\n';
}

async function runEditorModel(rows, config, modelKey, targetLang, runId, batchSize) {
  const translations = {};
  const findings = [];
  const batches = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const body = {
      target: targetLang,
      chapterTitle: 'Chinese literary benchmark',
      provider: config.provider,
      runtime: config.provider,
      model: config.model,
      taskProfiles: {
        styleReview: { model: config.model, thinkingMode: 'disabled', effort: 'low' },
        accuracyReview: { model: config.accuracyModel, thinkingMode: 'disabled', effort: 'low' },
      },
      reviewFocus: 'style',
      chineseMonolingualEdit: true,
      voiceContext: {},
      translationBrief: null,
      precedingSegments: [],
      segments: batch.map((row) => ({
        id: row.id, source: row.source, draft: row.draft, kind: 'paragraph', contextPath: row.genre,
      })),
    };
    const result = await runLiteraryReview(body, runId + ':' + modelKey + ':style:' + Math.floor(offset / batchSize),
      'document:chinese-literary-benchmark:' + runId + ':' + modelKey);
    Object.assign(translations, result.translations || {});
    findings.push(...(result.findings || []));
    batches.push({
      batchIndex: Math.floor(offset / batchSize),
      reviewedCount: (result.reviewedIds || []).length,
      missingCount: (result.missingIds || []).length,
      findingCount: (result.findings || []).length,
      promptChars: result.promptChars,
      contextChars: result.contextChars,
    });
  }
  const output = { translations, findings, batches };
  return { ...output, metrics: summarizeEditorOutput(rows, output) };
}

async function runAccuracyScreen(rows, editorOutput, config, candidateKey, targetLang, runId, batchSize) {
  const results = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const body = {
      target: targetLang,
      chapterTitle: 'Chinese literary benchmark fidelity review',
      provider: config.provider,
      runtime: config.provider,
      model: config.accuracyModel,
      taskProfiles: {
        accuracyReview: { model: config.accuracyModel, thinkingMode: 'disabled', effort: 'medium' },
      },
      reviewFocus: 'accuracy',
      chineseMonolingualEdit: false,
      voiceContext: {},
      translationBrief: null,
      precedingSegments: [],
      segments: batch.map((row) => ({
        id: row.id,
        source: row.source,
        draft: typeof editorOutput.translations[row.id] === 'string' ? editorOutput.translations[row.id] : row.draft,
        initialDraft: row.draft,
        kind: 'paragraph',
        contextPath: row.genre,
      })),
    };
    const result = await runLiteraryReview(body, runId + ':' + candidateKey + ':accuracy:' + Math.floor(offset / batchSize),
      'document:chinese-literary-benchmark:' + runId + ':' + candidateKey + ':accuracy');
    results.push({
      batchIndex: Math.floor(offset / batchSize),
      reviewedCount: (result.reviewedIds || []).length,
      missingCount: (result.missingIds || []).length,
      findings: result.findings || [],
      translations: result.translations || {},
    });
  }
  const findings = results.flatMap((item) => item.findings);
  return {
    batchCount: results.length,
    reviewedCount: results.reduce((sum, item) => sum + item.reviewedCount, 0),
    missingCount: results.reduce((sum, item) => sum + item.missingCount, 0),
    accuracyFindingCount: findings.filter((item) => item.category === 'accuracy').length,
    terminologyFindingCount: findings.filter((item) => item.category === 'terminology').length,
    findings,
    batches: results.map(({ findings: batchFindings, ...batch }) => batch),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    if (['allow-small', 'validate-only'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset) throw new Error('用法：npm run benchmark:chinese-literary -- --dataset <dataset.jsonl> --model-a <model> --model-b <model> --accuracy-model <model> --provider <workbuddy|opencode> --output <dir>');
  const datasetPath = path.resolve(args.dataset);
  const rows = validateBenchmarkDataset(parseJsonl(await readFile(datasetPath, 'utf8')), { allowSmall: !!args['allow-small'] });
  const datasetHash = sha256(JSON.stringify(rows));
  if (args['validate-only']) {
    process.stdout.write(JSON.stringify({ valid: true, segmentCount: rows.length, targetLang: rows[0].targetLang, datasetHash }, null, 2) + '\n');
    return;
  }
  const provider = String(args.provider || process.env.CHINESE_LITERARY_BENCHMARK_PROVIDER || 'workbuddy');
  const modelA = String(args['model-a'] || process.env.CHINESE_LITERARY_BENCHMARK_MODEL_A || '');
  const modelB = String(args['model-b'] || process.env.CHINESE_LITERARY_BENCHMARK_MODEL_B || '');
  const accuracyModel = String(args['accuracy-model'] || process.env.CHINESE_LITERARY_BENCHMARK_ACCURACY_MODEL || '');
  if (!['workbuddy', 'opencode'].includes(provider) || !modelA || !modelB || !accuracyModel || modelA === modelB) {
    throw new Error('必须提供不同的 model-a/model-b、accuracy-model 和有效 provider；不会静默回退到未验证模型。');
  }
  const batchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, Number(args['batch-size']) || 16));
  const runId = randomUUID();
  const outputDir = path.resolve(args.output || path.join('benchmarks', 'results', new Date().toISOString().replace(/[:.]/gu, '-')));
  await mkdir(outputDir, { recursive: true });
  const config = { provider, accuracyModel };
  process.stdout.write('Running model A candidate generation...\n');
  const first = await runEditorModel(rows, { ...config, model: modelA }, 'first', rows[0].targetLang, runId, batchSize);
  process.stdout.write('Running model B candidate generation...\n');
  const second = await runEditorModel(rows, { ...config, model: modelB }, 'second', rows[0].targetLang, runId, batchSize);
  process.stdout.write('Running the same bilingual fidelity reviewer against both candidate sets...\n');
  const fidelityFirst = await runAccuracyScreen(rows, first, config, 'first', rows[0].targetLang, runId, batchSize);
  const fidelitySecond = await runAccuracyScreen(rows, second, config, 'second', rows[0].targetLang, runId, batchSize);

  const swap = Math.random() < 0.5;
  const blind = buildBlindReviewPacket(rows, first, second, swap);
  const modelResults = {
    runId, datasetHash, segmentCount: rows.length, targetLang: rows[0].targetLang,
    provider,
    models: {
      first: { model: modelA, editorMetrics: first.metrics, fidelity: fidelityFirst },
      second: { model: modelB, editorMetrics: second.metrics, fidelity: fidelitySecond },
    },
    outputs: { first, second },
  };
  const mapping = {
    runId, datasetHash,
    candidateA: swap ? { provider, model: modelB } : { provider, model: modelA },
    candidateB: swap ? { provider, model: modelA } : { provider, model: modelB },
  };
  const manifest = {
    version: 1, runId, createdAt: new Date().toISOString(), datasetPath,
    datasetHash, segmentCount: rows.length, targetLang: rows[0].targetLang,
    provider, batchSize, accuracyModel,
    note: 'Candidate A/B packet is blinded. Keep blind-mapping.json separate from human reviewers until all reviews are submitted.',
  };
  await Promise.all([
    writeFile(path.join(outputDir, 'blind-review-packet.json'), JSON.stringify(blind.packet, null, 2) + '\n', 'utf8'),
    writeFile(path.join(outputDir, 'blind-mapping.json'), JSON.stringify(mapping, null, 2) + '\n', 'utf8'),
    writeFile(path.join(outputDir, 'model-results.json'), JSON.stringify(modelResults, null, 2) + '\n', 'utf8'),
    writeFile(path.join(outputDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    writeFile(path.join(outputDir, 'human-review-template.csv'), humanReviewCsv(blind.packet.items), 'utf8'),
  ]);
  process.stdout.write(JSON.stringify({
    completed: true, runId, segmentCount: rows.length, outputDir,
    files: ['blind-review-packet.json', 'blind-mapping.json', 'model-results.json', 'run-manifest.json', 'human-review-template.csv'],
    modelA: first.metrics, modelB: second.metrics,
  }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
