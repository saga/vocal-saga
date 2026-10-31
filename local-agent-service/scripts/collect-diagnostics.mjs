#!/usr/bin/env node
/**
 * Collect a privacy-conscious Local Agent support bundle.
 *
 * Usage:
 *   npm run diagnose:bundle
 *   npm run diagnose:bundle -- --analyze
 *   npm run diagnose:bundle -- --since-hours 12 --analyze
 *
 * --analyze explicitly sends the sanitized diagnostic summary (not source text,
 * prompts, translations, or SQLite content) to the already-authenticated CodeBuddy SDK.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sinceHours = Math.max(1, Math.min(24 * 30, Number(value('--since-hours', '72')) || 72));
const analyze = flag('--analyze');
const dataDir = path.resolve(process.env.LOCAL_AGENT_DATA_DIR || path.join(home, '.vocal-saga-local-agent'));
const logFile = path.resolve(process.env.LOCAL_AGENT_LOG_FILE || path.join(dataDir, 'logs', 'local-agent.log'));
const dbFile = path.resolve(process.env.LOCAL_AGENT_DATABASE || path.join(dataDir, 'local-agent.sqlite'));
const outputRoot = path.resolve(value('--out', path.join(serviceDir, 'diagnostic-bundles')));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const bundleDir = path.join(outputRoot, 'local-agent-diagnostics-' + timestamp);
const collectedAt = new Date();
const since = Date.now() - sinceHours * 60 * 60 * 1000;
fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|local_agent_token)\s*[:=]\s*)["']?[^\s"',;]+/gi,
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(gh[pousr]_[A-Za-z0-9]{20,})/g,
];
function redact(input) {
  let text = String(input ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1[REDACTED]');
  // Avoid leaking home directory/user names in paths.
  if (home) text = text.split(home).join('~');
  return text;
}
function write(name, data) {
  fs.writeFileSync(path.join(bundleDir, name), data, { encoding: 'utf8', mode: 0o600 });
}
function copyRecentLog(source, targetName) {
  if (!fs.existsSync(source)) return { found: false, path: source };
  const stat = fs.statSync(source);
  const raw = fs.readFileSync(source, 'utf8');
  const lines = raw.split(/\r?\n/);
  const selected = lines.filter((line) => {
    const match = line.match(/\[(?:[^\]]+ )?(\d{1,2}:\d{2}:\d{2})\]/);
    return !match || stat.mtimeMs >= since;
  }).slice(-12000);
  write(targetName, redact(selected.join('\n')));
  return { found: true, bytes: stat.size, includedLines: selected.length, modifiedAt: stat.mtime.toISOString() };
}
function run(command, commandArgs, timeout = 8000) {
  const result = spawnSync(command, commandArgs, { cwd: serviceDir, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: redact((result.stdout || '').slice(0, 12000)),
    stderr: redact((result.stderr || '').slice(0, 4000)),
    error: result.error ? String(result.error.message) : undefined,
  };
}
function sqliteOverview() {
  if (!fs.existsSync(dbFile)) return { found: false };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const result = [];
    for (const row of tables) {
      const table = String(row.name);
      // Table names come from sqlite_master; quote identifiers before interpolation.
      const quoted = '"' + table.replace(/"/g, '""') + '"';
      const columns = db.prepare('PRAGMA table_info(' + quoted + ')').all().map((c) => String(c.name));
      const count = db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get()?.count ?? 0;
      result.push({ table, rowCount: Number(count), columns: columns.filter((c) => !/prompt|response|content|translation|source|text|payload|body/i.test(c)) });
    }
    return { found: true, sizeBytes: fs.statSync(dbFile).size, tables: result };
  } finally {
    db.close();
  }
}
function collectLogFiles() {
  // Only collect this service's own logs. SDK/CLI transcript directories may contain full user prompts or book text.
  const files = [];
  for (const root of [path.join(dataDir, 'logs')]) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.(log|jsonl|txt)$/i.test(entry.name)) {
          const stat = fs.statSync(full);
          if (full !== logFile && stat.mtimeMs >= since && stat.size <= 20 * 1024 * 1024) files.push({ full, root, stat });
        }
      }
    };
    walk(root);
  }
  return files.slice(0, 30).map((file, index) => {
    const rel = path.relative(file.root, file.full);
    const target = 'logs/' + String(index + 1).padStart(2, '0') + '-' + path.basename(rel);
    const lines = fs.readFileSync(file.full, 'utf8').split(/\r?\n/).slice(-8000);
    write(target, redact(lines.join('\n')));
    return { file: target, source: '~/' + path.relative(home, file.full), bytes: file.stat.size, includedLines: lines.length };
  });
}
function localFindings(logText) {
  const patterns = [
    ['errors', /\b(error|failed|failure|exception|uncaught|unhandled)\b/gi],
    ['timeouts', /timeout|超时|timed out/gi],
    ['retries', /retry|重试|fallback/gi],
    ['empty-or-invalid-output', /空内容|invalid json|不是有效 json|structured output/gi],
    ['queue-wait', /排队等待|queue wait/gi],
    ['cancellation', /cancel|取消|interrupt/gi],
  ];
  return Object.fromEntries(patterns.map(([name, pattern]) => [name, (logText.match(pattern) || []).length]));
}
async function runCodeBuddyAnalysis(summary) {
  const sdk = await import('@tencent-ai/agent-sdk');
  const prompt = [
    '你是本机翻译 Agent 服务的运行诊断助手。只根据下面脱敏后的运行元数据和日志摘要分析。',
    '输出中文，按：1. 主要异常/可能根因 2. 证据（引用日志原句，最多 8 条）3. 影响范围 4. 建议优先级排序 5. 还缺少什么观测信息。',
    '不要把相关性说成因果；信息不足时明确写未知。不要建议上传源文、译文或密钥。',
    JSON.stringify(summary, null, 2),
  ].join('\n\n');
  const stream = sdk.query({
    prompt,
    options: {
      cwd: serviceDir,
      settingSources: [],
      persistSession: false,
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
    },
  });
  let output = '';
  for await (const message of stream) {
    const raw = message && typeof message === 'object' ? message : {};
    if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
      for (const part of raw.message.content) if (part?.type === 'text' && typeof part.text === 'string') output += part.text;
    }
    if (raw.type === 'result' && raw.subtype && raw.subtype !== 'success') {
      throw new Error('CodeBuddy analysis failed: ' + String(raw.subtype));
    }
  }
  return output.trim();
}

const logMeta = copyRecentLog(logFile, 'local-agent.log');
const additionalLogs = collectLogFiles();
const primaryLog = fs.existsSync(path.join(bundleDir, 'local-agent.log'))
  ? fs.readFileSync(path.join(bundleDir, 'local-agent.log'), 'utf8') : '';
const packageJson = JSON.parse(fs.readFileSync(path.join(serviceDir, 'package.json'), 'utf8'));
const summary = {
  generatedAt: collectedAt.toISOString(),
  windowHours: sinceHours,
  host: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version, cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
  service: { package: packageJson.name, version: packageJson.version, configuredProvider: process.env.LOCAL_AGENT_PROVIDER || 'workbuddy', configuredPort: process.env.LOCAL_AGENT_PORT || '8789', poolSize: process.env.LOCAL_AGENT_POOL_SIZE || 'default', timeoutMs: process.env.LOCAL_AGENT_TIMEOUT_MS || 'default', analysisTimeoutMs: process.env.LOCAL_AGENT_ANALYSIS_TIMEOUT_MS || 'default' },
  paths: { dataDir: '~/' + path.relative(home, dataDir), logFile: '~/' + path.relative(home, logFile), database: '~/' + path.relative(home, dbFile) },
  primaryLog: logMeta,
  additionalLogs,
  sqlite: (() => { try { return sqliteOverview(); } catch (error) { return { found: true, error: redact(error instanceof Error ? error.message : String(error)) }; } })(),
  checks: {
    health: run(process.execPath, ['-e', "fetch('http://127.0.0.1:'+(process.env.LOCAL_AGENT_PORT||8789)+'/health').then(async r=>{console.log('HTTP '+r.status);console.log((await r.text()).slice(0,1000));}).catch(e=>{console.error(e.message);process.exitCode=1})"]),
    codebuddyCli: run('codebuddy', ['--version']),
    opencodeCli: run('opencode', ['--version']),
  },
  logSignals: localFindings(primaryLog),
};
write('summary.json', JSON.stringify(summary, null, 2) + '\n');
write('README.txt', [
  'Vocal Saga Local Agent diagnostic bundle',
  'Generated: ' + collectedAt.toISOString(),
  'Window: last ' + sinceHours + ' hours (log-file tail is capped)',
  '',
  'Privacy: SQLite row contents and known prompt/source/translation preview log lines are excluded.',
  'Only this service\'s own logs are collected; SDK transcript directories are deliberately excluded.',
  'Logs are secret-redacted, but manually inspect this archive before sharing.',
  'summary.json includes environment/runtime metadata and aggregate SQLite table counts.',
  analyze ? 'CodeBuddy analysis was explicitly requested; see codebuddy-analysis.md.' : 'No model analysis was run. Re-run with --analyze to use the local CodeBuddy SDK.',
].join('\n') + '\n');

if (analyze) {
  try {
    const analysis = await runCodeBuddyAnalysis({ ...summary, logExcerpt: primaryLog.slice(-18000) });
    write('codebuddy-analysis.md', analysis + '\n');
  } catch (error) {
    write('codebuddy-analysis-error.txt', redact(error instanceof Error ? error.stack || error.message : String(error)) + '\n');
  }
}

const archivePath = bundleDir + '.tar.gz';
const tar = spawnSync('tar', ['-czf', archivePath, '-C', outputRoot, path.basename(bundleDir)], { encoding: 'utf8' });
if (tar.status !== 0) {
  console.error('Bundle collected at: ' + bundleDir);
  console.error(tar.stderr || 'tar failed');
  process.exitCode = 1;
} else {
  console.log('Diagnostic bundle: ' + archivePath);
  console.log('Files: ' + fs.readdirSync(bundleDir).length + ' · log signals: ' + JSON.stringify(summary.logSignals));
  console.log('Review the archive manually before uploading it to ChatGPT.');
}
