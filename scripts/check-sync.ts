#!/usr/bin/env npx tsx
// 跨项目同步校验脚本
// 按下方静态同步清单比较两端文件；调整清单时必须同步更新 CROSS_PROJECT_SYNC.md
// 用法:npx tsx scripts/check-sync.ts
// CI 中有差异则 exit 1

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VOCAL_SAGA = path.resolve(process.env.VOCAL_SAGA_PATH || path.join(SCRIPT_DIR, '..'));
const FANYI_EXTENSION = path.resolve(process.env.FANYI_EXTENSION_PATH || path.join(VOCAL_SAGA, '..', 'fanyi-extension'));

if (!fs.existsSync(path.join(VOCAL_SAGA, 'package.json'))) {
  console.error(`找不到 vocal-saga 仓库：${VOCAL_SAGA}；可用 VOCAL_SAGA_PATH 指定路径。`);
  process.exit(2);
}
if (!fs.existsSync(path.join(FANYI_EXTENSION, 'package.json'))) {
  console.error(`找不到 fanyi-extension 仓库：${FANYI_EXTENSION}；请将两个仓库放在同一父目录，或设置 FANYI_EXTENSION_PATH。`);
  process.exit(2);
}

// 字节级同步模块对照表（来自 CROSS_PROJECT_SYNC.md §一）。cacheKey 与 service/_service
// 有意保留平台扩展字段，按文档中的语义契约维护，不纳入字节级比较；纯函数 document 模块纳入逐字节校验。
const SYNC_PAIRS: Array<{ name: string; server: string; extension: string }> = [
  { name: 'chunkRetry', server: 'lib/translate/chunkRetry.ts', extension: 'src/entrypoints/utils/chunkRetry.ts' },
  { name: 'translationQueue', server: 'lib/translate/translationQueue.ts', extension: 'src/entrypoints/utils/translationQueue.ts' },
  { name: 'document/types', server: 'lib/translate/document/types.ts', extension: 'src/entrypoints/utils/document/types.ts' },
  { name: 'document/detect', server: 'lib/translate/document/detect.ts', extension: 'src/entrypoints/utils/document/detect.ts' },
  { name: 'document/batcher', server: 'lib/translate/document/batcher.ts', extension: 'src/entrypoints/utils/document/batcher.ts' },
  { name: 'document/export', server: 'lib/translate/document/export.ts', extension: 'src/entrypoints/utils/document/export.ts' },
  { name: 'document/parser-text', server: 'lib/translate/document/parsers/text.ts', extension: 'src/entrypoints/utils/document/parsers/text.ts' },
  { name: 'document/parser-subtitle', server: 'lib/translate/document/parsers/subtitle.ts', extension: 'src/entrypoints/utils/document/parsers/subtitle.ts' },
  { name: 'document/parser-html', server: 'lib/translate/document/parsers/html.ts', extension: 'src/entrypoints/utils/document/parsers/html.ts' },
  { name: 'document/parser-json', server: 'lib/translate/document/parsers/json.ts', extension: 'src/entrypoints/utils/document/parsers/json.ts' },
  { name: 'service/streamParser', server: 'lib/translate/service/streamParser.ts', extension: 'src/entrypoints/service/streamParser.ts' },
  { name: 'service/glossaryTerms', server: 'lib/translate/service/glossaryTerms.ts', extension: 'src/entrypoints/service/glossaryTerms.ts' },
  { name: 'service/prompt-contract', server: 'lib/translate/service/prompt-contract.ts', extension: 'src/entrypoints/service/prompt-contract.ts' },
  { name: 'service/prompt-style', server: 'lib/translate/service/prompt-style.ts', extension: 'src/entrypoints/service/prompt-style.ts' },
  { name: 'service/default-prompt', server: 'lib/translate/service/default-prompt.ts', extension: 'src/entrypoints/service/default-prompt.ts' },
  { name: 'service/jinyong-prompt', server: 'lib/translate/service/jinyong-prompt.ts', extension: 'src/entrypoints/service/jinyong-prompt.ts' },
  { name: 'service/acheng-prompt', server: 'lib/translate/service/acheng-prompt.ts', extension: 'src/entrypoints/service/acheng-prompt.ts' },
  { name: 'service/wangxiaobo-prompt', server: 'lib/translate/service/wangxiaobo-prompt.ts', extension: 'src/entrypoints/service/wangxiaobo-prompt.ts' },
  { name: 'glossaryExtractor', server: 'lib/translate/glossaryExtractor.ts', extension: 'src/entrypoints/utils/glossaryExtractor.ts' },
  { name: 'languageDetector', server: 'lib/translate/languageDetector.ts', extension: 'src/entrypoints/utils/languageDetector.ts' },
  { name: 'tech-products.json', server: 'lib/translate/tech-products.json', extension: 'src/entrypoints/utils/tech-products.json' },
  { name: 'rules/github', server: 'lib/translate/rules/github-rules.ts', extension: 'src/rules/github-rules.ts' },
  { name: 'rules/fortune', server: 'lib/translate/rules/fortune-rules.ts', extension: 'src/rules/fortune-rules.ts' },
  { name: 'rules/hackernews', server: 'lib/translate/rules/hackernews-rules.ts', extension: 'src/rules/hackernews-rules.ts' },
  { name: 'rules/reddit', server: 'lib/translate/rules/reddit-rules.ts', extension: 'src/rules/reddit-rules.ts' },
];

interface DiffResult {
  name: string;
  status: 'identical' | 'different' | 'missing';
  details?: string;
}

function checkPair(pair: { name: string; server: string; extension: string }): DiffResult {
  const serverPath = path.join(VOCAL_SAGA, pair.server);
  const extPath = path.join(FANYI_EXTENSION, pair.extension);

  if (!fs.existsSync(serverPath)) {
    return { name: pair.name, status: 'missing', details: `server 文件不存在: ${pair.server}` };
  }
  if (!fs.existsSync(extPath)) {
    return { name: pair.name, status: 'missing', details: `extension 文件不存在: ${pair.extension}` };
  }

  const serverContent = fs.readFileSync(serverPath, 'utf-8');
  const extContent = fs.readFileSync(extPath, 'utf-8');

  // 标准化相对 import 前缀与换行符；保留代码空白，避免把格式之外的差异抹掉。
  const normalize = (s: string) =>
    s.replace(/from\s+['"]\.\.?\//g, 'from \'./')
     .replace(/\r\n/g, '\n')
     .trim();

  if (normalize(serverContent) === normalize(extContent)) {
    return { name: pair.name, status: 'identical' };
  }

  // 生成简要 diff
  const serverLines = normalize(serverContent).split('\n');
  const extLines = normalize(extContent).split('\n');
  const maxLines = Math.max(serverLines.length, extLines.length);
  const diffs: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    if (serverLines[i] !== extLines[i]) {
      diffs.push(`  L${i + 1}:\n    server:     ${serverLines[i] ?? '(无)'}\n    extension:  ${extLines[i] ?? '(无)'}`);
      if (diffs.length >= 5) break; // 只显示前 5 处差异
    }
  }

  return { name: pair.name, status: 'different', details: diffs.join('\n') };
}

// 主逻辑
console.log('═══════════════════════════════════════════════');
console.log('  跨项目同步校验');
console.log('═══════════════════════════════════════════════\n');

const results = SYNC_PAIRS.map(checkPair);

const identical = results.filter(r => r.status === 'identical');
const different = results.filter(r => r.status === 'different');
const missing = results.filter(r => r.status === 'missing');

console.log(`✓ 完全一致: ${identical.length}/${results.length}`);
for (const r of identical) {
  console.log(`  ✓ ${r.name}`);
}

if (different.length > 0) {
  console.log(`\n✗ 有差异: ${different.length}`);
  for (const r of different) {
    console.log(`  ✗ ${r.name}`);
    if (r.details) console.log(r.details);
  }
}

if (missing.length > 0) {
  console.log(`\n⚠ 文件缺失: ${missing.length}`);
  for (const r of missing) {
    console.log(`  ⚠ ${r.name}: ${r.details}`);
  }
}

console.log('');
if (different.length > 0 || missing.length > 0) {
  console.log('结果: FAIL — 存在差异,请检查并同步');
  process.exit(1);
} else {
  console.log('结果: PASS — 所有"完全一致"模块均一致');
  process.exit(0);
}
