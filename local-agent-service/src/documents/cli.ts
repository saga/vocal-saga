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

/** 存储层句柄的类型别名。 */
type Store = ReturnType<typeof getDocumentProjectStore>;
/** 单个子命令的处理函数：拿到 store 与该命令之后的参数（不含命令名本身）。 */
type CliHandler = (store: Store, args: string[]) => Promise<void> | void;

/** 打印用法并以退出码 2 结束——参数错误不是运行失败，用 2 与业务失败区分。 */
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

/** 读并解析 JSON 文件，路径按当前工作目录解析。 */
async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}
/** 统一输出：缩进两格的 JSON 到 stdout，便于管道下游用 jq 处理。 */
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
/** 轮询间隔用的延时。 */
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
/** `import`：从已归一化的片段 JSON 建项目，不做任何解析或预处理。 */
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

/** `context`：查看已持久化的 Context Graph 与分析状态，只读。 */
function showContext(_store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print(getContextGraph(projectId));
}

/** `context-analyze`：对已有项目构建/更新 Context Graph，并等待到终态。 */
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

/** `context-review`：人工裁定单个节点或边的状态，四个参数缺一即打印用法。 */
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

/** `projects`：列出全部文档项目。 */
function listProjects(store: Store): void {
  print({ projects: store.listProjects() });
}

/** `status`：一次给出项目、校验结果与全部运行，排查时的第一站。 */
function showStatus(store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print({ project: store.getProject(projectId), verification: store.verifyProject(projectId), runs: store.listRuns(projectId) });
}

/** `verify`：检查源文映射缺失与过期。 */
function showVerification(store: Store, args: string[]): void {
  const projectId = args[0];
  if (!projectId) usage();
  print(store.verifyProject(projectId));
}

/**
 * `run`：创建并启动一次翻译运行，然后轮询到终态。
 * 范围优先级是 `--chapter` 高于 `--scope`；两者都没给或取值非法时按 stale 处理。
 * 终端状态为 failed / partial 时把退出码置 1，供自动化判断。
 */
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

/** `accept`：采纳某次运行产出的全部候选译文。 */
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

/** `diff`：对比当前已采纳译文与该次运行的候选，标出两者不同的片段。 */
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

/**
 * `export`：导出源文与已采纳译文为 JSON。未翻译的片段照样导出（`translation` 为 null），
 * 并在结果里报出缺失条数，而不是静默跳过。
 */
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
