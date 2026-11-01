/**
 * 面向自动化、调试与批量文档运行的命令行入口。
 * 它接受归一化后的片段 JSON，或在 local-agent-service 内部解析原始文本文档；
 * 导入文件的命令不经过扩展。
 *
 * 命令放在注册表里：新增子命令只需加一条，不必再往分发函数里塞分支。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocumentProjectStore } from './projectStore.ts';
import { startProjectTranslationRun } from './translationAgent.ts';
import { parseDocumentFile } from './ingest.ts';
import { startContextGraphAnalysis, getContextGraph, getContextGraphStatus, reviewContextGraphItem } from './contextGraph.ts';
import { logError, logProgress } from '../log.ts';

type Store = ReturnType<typeof getDocumentProjectStore>;
type CliHandler = (store: Store, args: string[]) => Promise<void> | void;

function usage(): never {
  console.error([
    'Usage: npm run doc -- <command> [arguments]',
    '  import <segments.json>                         create a project from normalized segments',
    '  import-file <document.epub|docx|pdf|txt|md|html> [--title=TITLE] [--skip-analysis]  parse locally and preprocess the book',
    '  context <documentId>                           inspect the persisted Context Graph and analysis status',
    '  context-analyze <documentId>                    build/update the Context Graph for an existing project',
    '  context-review <documentId> <node|edge> <id> <candidate|confirmed|rejected>  review one graph item',
    '  projects                                      list document projects',
    '  status <documentId>                           inspect project, runs and stale segments',
    '  run <documentId> [--scope=stale|all|failed] [--chapter=TITLE] [--prompt-file=FILE]',
    '  accept <documentId> <runId>                   accept all candidate translations from a run',
    '  verify <documentId>                           check missing and stale source mappings',
    '  diff <documentId> <runId>                     compare current accepted text with run candidates',
    '  export <documentId> <output.json>             export source + accepted translations',
  ].join('\n'));
  process.exit(2);
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** 取 `--name=value` 形式的参数；缺省返回 undefined。 */
function flag(args: string[], name: string): string | undefined {
  return args.find((item) => item.startsWith(name + '='))?.slice(name.length + 1);
}

export async function runDocumentCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  const store = getDocumentProjectStore();
  if (!command || command === '--help' || command === '-h') usage();
  const handler = COMMANDS[command];
  if (!handler) usage();
  await handler(store, args);
}

const COMMANDS: Record<string, CliHandler> = {
  import: importSegments,
  'import-file': importDocumentFile,
  context: showContext,
  'context-analyze': analyzeContext,
  'context-review': reviewContextItem,
  projects: listProjects,
  status: showStatus,
  verify: showVerification,
  run: startRun,
  accept: acceptRun,
  diff: diffRun,
  export: exportProject,
};

/** 从规范化片段 JSON 建项目：不解析原文，调用方负责分段。 */
async function importSegments(store: Store, args: string[]): Promise<void> {
  const inputPath = args[0];
  if (!inputPath) usage();
  const input = await readJson(inputPath);
  const project = store.createProject({
    title: String(input.title || input.fileName || path.basename(inputPath)),
    format: String(input.format || path.extname(inputPath).slice(1) || 'txt'),
    sourceFileName: typeof input.sourceFileName === 'string' ? input.sourceFileName : path.basename(inputPath),
    segments: input.segments,
    prompt: input.prompt,
  });
  print({ created: true, project });
}

/** 本地解析原始文档并建项目，默认接着跑全书预处理。 */
async function importDocumentFile(store: Store, args: string[]): Promise<void> {
  const sourceArg = args[0];
  if (!sourceArg) usage();
  const sourcePath = path.resolve(sourceArg);
  const fileName = path.basename(sourcePath);
  const bytes = await readFile(sourcePath);
  const parsed = await parseDocumentFile(fileName, bytes);
  const title = flag(args, '--title')?.trim() || parsed.title;
  const project = store.createProject({
    title, format: parsed.format, sourceFileName: fileName, segments: parsed.segments, prompt: { translationMode: 'literary' },
  });
  let sourceFile: unknown;
  try {
    sourceFile = await store.storeSourceFile(project.projectId, fileName, bytes);
  } catch (error) {
    // 原文落盘失败时项目没有可恢复的来源，直接归档，别留下半成品项目。
    try { store.archiveProject(project.projectId); } catch { /* retain the source persistence error */ }
    throw error;
  }
  if (args.includes('--skip-analysis')) {
    print({ created: true, project, sourceFile, preprocessing: { status: 'skipped' } });
    return;
  }
  const preprocessing = startContextGraphAnalysis(project.projectId);
  print({ created: true, project, sourceFile, preprocessing });
  const status = await waitForContextGraph(project.projectId, preprocessing.runId);
  print({ projectId: project.projectId, preprocessing: status });
  if (status.status !== 'completed') process.exitCode = 1;
}

function showContext(_store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print(getContextGraph(projectId));
}

async function analyzeContext(_store: Store, args: string[]): Promise<void> {
  const projectId = args[0];
  if (!projectId) usage();
  const started = startContextGraphAnalysis(projectId);
  print({ preprocessing: started });
  const status = await waitForContextGraph(projectId, started.runId);
  print({ preprocessing: status });
  if (status.status !== 'completed') process.exitCode = 1;
}

/** 轮询全书预处理，直到离开 queued/running；期间每秒打一行进度。 */
async function waitForContextGraph(projectId: string, runId: string): Promise<any> {
  let status = getContextGraphStatus(projectId, runId);
  while (status.status === 'queued' || status.status === 'running') {
    await sleep(1000);
    status = getContextGraphStatus(projectId, runId);
    logProgress('context-graph', String(status.status) + ' phase=' + String(status.phase));
  }
  return status;
}

function reviewContextItem(_store: Store, args: string[]): void {
  const [projectId, kind, itemId, decision] = args;
  if (!projectId || !['node', 'edge'].includes(kind || '') || !itemId ||
      !['candidate', 'confirmed', 'rejected'].includes(decision || '')) usage();
  print(reviewContextGraphItem(
    projectId,
    kind as 'node' | 'edge',
    itemId,
    decision as 'candidate' | 'confirmed' | 'rejected',
  ));
}

function listProjects(store: Store): void {
  print({ projects: store.listProjects() });
}

function showStatus(store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print({ project: store.getProject(projectId), verification: store.verifyProject(projectId), runs: store.listRuns(projectId) });
}

function showVerification(store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print(store.verifyProject(projectId));
}

async function startRun(store: Store, args: string[]): Promise<void> {
  const projectId = args[0];
  if (!projectId) usage();
  const scopeArg = flag(args, '--scope') || 'stale';
  const chapter = flag(args, '--chapter');
  const promptFile = flag(args, '--prompt-file');
  const prompt = promptFile ? await readJson(promptFile) : undefined;
  const scope = chapter
    ? { type: 'chapter' as const, chapter }
    : { type: (['all', 'stale', 'failed'].includes(scopeArg) ? scopeArg : 'stale') as 'all' | 'stale' | 'failed' };
  const run = store.createRun(projectId, { scope, prompt });
  if (run.counts.total === 0) {
    print({ message: '所选范围没有需要处理的片段', run });
    return;
  }
  startProjectTranslationRun(projectId, run.runId);
  let current = run;
  while (true) {
    await sleep(1000);
    current = store.getRun(projectId, run.runId);
    logProgress('document-agent', current.status + ' ' + JSON.stringify(current.counts));
    if (!['queued', 'running'].includes(current.status)) break;
  }
  print({ run: current, next: describeNextStep(current.status) });
  if (current.status === 'failed' || current.status === 'partial') process.exitCode = 1;
}

/** 终态后的下一步提示：CLI 是给自动化用的，必须明确告诉人该做什么。 */
function describeNextStep(status: string): string {
  switch (status) {
    case 'awaiting_acceptance': return '请检查候选译文，再运行 accept';
    case 'paused': return '任务已暂停；可从扩展工作区恢复中断任务，或检查运行状态后重新执行失败范围';
    case 'cancelled': return '任务已停止；已经保存的候选仍保留';
    case 'failed': case 'partial': return '请检查失败项与 verify 输出后重试';
    default: return '请检查 verify 输出';
  }
}

function acceptRun(store: Store, args: string[]): void {
  const [projectId, runId] = args;
  if (!projectId || !runId) usage();
  print({ run: store.acceptCandidates(projectId, runId) });
}

/** 分页拉全量片段：单次查询有上限，长书必须按页取。 */
function collectSegments(store: Store, projectId: string, total: number, filter: Record<string, unknown> = {}): any[] {
  const all: any[] = [];
  const limit = 1000;
  for (let offset = 0; offset < total; offset += limit) {
    all.push(...store.getSegments(projectId, { limit, offset, ...filter }));
  }
  return all;
}

function diffRun(store: Store, args: string[]): void {
  const [projectId, runId] = args;
  if (!projectId || !runId) usage();
  const run = store.getRun(projectId, runId);
  const ids = new Set(run.segments.map((segment: any) => segment.id));
  const project = store.getProject(projectId);
  const totalSegments = project?.segmentCount ?? run.segments.length;
  const all = collectSegments(store, projectId, totalSegments, { runId });
  print({
    runId: run.runId,
    status: run.status,
    differences: all.filter((segment: any) => ids.has(segment.id) && segment.candidateTranslation != null)
      .map((segment: any) => ({
        id: segment.id,
        source: segment.text,
        accepted: segment.acceptedTranslation,
        candidate: segment.candidateTranslation,
        changed: segment.acceptedTranslation !== segment.candidateTranslation,
      })),
  });
}

async function exportProject(store: Store, args: string[]): Promise<void> {
  const [projectId, outputArg] = args;
  if (!projectId || !outputArg) usage();
  const verification = store.verifyProject(projectId);
  const all = collectSegments(store, projectId, verification.totalSegments);
  const outputPath = path.resolve(outputArg);
  await writeFile(outputPath, JSON.stringify({
    project: verification.project,
    exportedAt: new Date().toISOString(),
    segments: all.map((segment: any) => ({
      id: segment.id, text: segment.text, kind: segment.kind, contextPath: segment.contextPath,
      page: segment.page, translation: segment.acceptedTranslation,
    })),
  }, null, 2), 'utf8');
  print({ outputPath, segmentCount: all.length, missingTranslations: all.filter((segment) => !segment.acceptedTranslation).length });
}

if (import.meta.url === new URL(process.argv[1] ? 'file://' + path.resolve(process.argv[1]) : import.meta.url).href) {
  runDocumentCli().catch((error) => {
    logError('document-cli', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
