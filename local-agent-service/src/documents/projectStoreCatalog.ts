/**
 * 项目目录、不可变来源版本与 catalog 的读写。
 *
 * 每个文档项目拥有独立的 SQLite 数据库，catalog.sqlite 只记录「项目在哪、当前来源是什么」。
 * 启动时的磁盘修复与中断恢复在 projectStoreRecovery；这里只管项目本身的创建、查询与校验。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, mkdirSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeCodeBuddyTaskProfiles } from '../agents/taskProfiles.ts';
import { logInfo, logWarn } from '../log.ts';
import { hash, isoNow, normalizeFormat, parseJson, segmentHash, sourceFingerprint, validateSegments } from './documentStoreUtils.ts';
import { MAX_DOCUMENT_SOURCE_BYTES, normalizeDocumentTranslationStrategy, normalizePromptStyle, type DocumentFormat, type ProjectPrompt, type ProjectSegment } from './documentStrategy.ts';
import { createProjectSchema } from './projectSchema.ts';
import { type ProjectSummary, type CreateProjectInput, type DocumentProjectStore } from './projectStore.ts';

const DEFAULT_SYSTEM_PROMPT = [
  'You are a careful document translation worker. Translate every input segment faithfully into the requested target language.',
  'Preserve meaning, negation, names, dates, numbers, paragraph boundaries and the source author’s tone. Do not add explanations or content that is not in the source.',
  'Return only a JSON object with a translations array. Each item must contain the original id and translated_text. Return each requested id exactly once. Never return HTML or Markdown around the JSON.',
].join('\n');

/**
 * 初始化项目目录与 catalog 数据库。
 * 启动时会从磁盘修复 catalog，并恢复被中断的运行，保证服务重启后状态一致。
 */
export function initialize(store: DocumentProjectStore): void {
  if (store.catalog) return;
  mkdirSync(store.rootDir, { recursive: true });
  store.catalog = new DatabaseSync(path.join(store.rootDir, 'catalog.sqlite'));
  store.catalog.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  store.catalog.exec(
    'CREATE TABLE IF NOT EXISTS document_projects (' +
    'project_id TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL, source_file_name TEXT NOT NULL, ' +
    'source_fingerprint TEXT NOT NULL, db_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);' +
    'CREATE INDEX IF NOT EXISTS idx_document_projects_updated ON document_projects(archived, updated_at DESC);'
  );
  store.repairCatalogFromDisk();
  store.recoverInterruptedRuns();
}

/**
 * 返回 catalog 数据库实例，必要时先初始化。
 */
export function catalogDb(store: DocumentProjectStore): DatabaseSync {
  store.initialize();
  return store.catalog!;
}

/**
 * 根据 projectId 计算项目数据库文件路径，并校验 ID 格式。
 */
export function projectPath(store: DocumentProjectStore, projectId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw Object.assign(new Error('documentId 格式不正确'), { status: 400 });
  return path.join(store.rootDir, projectId, 'project.sqlite');
}

/**
 * 打开（或创建）项目数据库，带缓存。
 * 非创建模式下会校验项目存在于 catalog 且未归档，避免打开孤儿数据库。
 */
export function openProjectDb(store: DocumentProjectStore, projectId: string, create = false): DatabaseSync {
  const cached = store.projectDbs.get(projectId);
  if (cached) return cached;
  const filePath = store.projectPath(projectId);
  if (!create && !store.catalogDb().prepare('SELECT 1 FROM document_projects WHERE project_id = ? AND archived = 0').get(projectId)) {
    throw Object.assign(new Error('找不到文档项目：' + projectId), { status: 404 });
  }
  if (create) mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  createProjectSchema(db);
  store.projectDbs.set(projectId, db);
  return db;
}

/**
 * 扫描磁盘上的项目目录，将缺失的 catalog 记录补回 catalog.sqlite。
 * 用于服务重启或数据库损坏恢复，避免已持久化的项目在列表中消失。
 */
export function repairCatalogFromDisk(store: DocumentProjectStore): void {
  const catalog = store.catalog!;
  for (const entry of readdirSync(store.rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const filePath = path.join(store.rootDir, entry.name, 'project.sqlite');
    try {
      const db = new DatabaseSync(filePath);
      createProjectSchema(db);
      const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      const revisionId = meta.get('current_source_revision_id') || '';
      const revision = revisionId
        ? db.prepare('SELECT source_fingerprint, segment_count, file_name, format FROM source_revisions WHERE revision_id = ?').get(revisionId) as any
        : undefined;
      if (meta.get('project_id') && revision) {
        const now = isoNow();
        catalog.prepare(
          'INSERT INTO document_projects(project_id, title, format, source_file_name, source_fingerprint, db_path, created_at, updated_at, archived) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(project_id) DO UPDATE SET title=excluded.title, format=excluded.format, source_file_name=excluded.source_file_name, source_fingerprint=excluded.source_fingerprint, db_path=excluded.db_path'
        ).run(entry.name, meta.get('title') || revision.file_name, revision.format, revision.file_name, revision.source_fingerprint,
          filePath, meta.get('created_at') || now, meta.get('updated_at') || now);
      }
      db.close();
    } catch (error) {
      logWarn('document-projects', 'catalog repair skipped ' + entry.name + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
}

/**
 * 写入或更新项目元数据键值。
 */
export function projectMeta(store: DocumentProjectStore, db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO project_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

/**
 * 向数据库插入一个新的不可变来源版本及其片段。
 * 仅写入数据，不切换 catalog；调用方负责事务与 catalog 更新。
 */
export function insertSourceRevision(store: DocumentProjectStore, db: DatabaseSync, projectId: string, title: string, format: DocumentFormat, fileName: string, segments: ProjectSegment[], revisionId: string = randomUUID(), sourceFile?: { relativePath: string; sha256: string; size: number }) {
  const fingerprint = sourceFingerprint(segments);
  const createdAt = isoNow();
  db.prepare('INSERT INTO source_revisions(revision_id, file_name, format, source_fingerprint, parser_version, segment_count, source_file_path, source_file_hash, source_file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(revisionId, fileName, format, fingerprint, 'segment-contract-v1', segments.length,
      sourceFile?.relativePath ?? null, sourceFile?.sha256 ?? null, sourceFile?.size ?? null, createdAt);
  const insert = db.prepare('INSERT INTO source_segments(source_revision_id, segment_id, ordinal, text, kind, context_path, page, level, marker, path, start_time, end_time, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  segments.forEach((segment, index) => insert.run(revisionId, segment.id, index, segment.text, segment.kind || 'paragraph',
    segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? null,
    segment.path ?? null, segment.start ?? null, segment.end ?? null, segmentHash(segment)));
  store.projectMeta(db, 'project_id', projectId);
  store.projectMeta(db, 'title', title);
  store.projectMeta(db, 'format', format);
  store.projectMeta(db, 'source_file_name', fileName);
  store.projectMeta(db, 'current_source_revision_id', revisionId);
  store.projectMeta(db, 'updated_at', createdAt);
  return { revisionId, fingerprint, createdAt };
}

/**
 * 创建项目并建立第一份不可变来源版本。
 * 项目目录、项目数据库、来源片段、Prompt revision 与 catalog 记录必须一起形成可恢复的项目；
 * 重复来源解析由 resolveProjectForSource 负责，不能依赖客户端会话缓存去重。
 */
export function createProject(store: DocumentProjectStore, input: CreateProjectInput): ProjectSummary {
  // 先初始化 catalog，再创建项目目录；否则启动修复可能先发现这个新目录，
  // 抢在 createProject 之前把 catalog 行插进去。
  store.catalogDb();
  const segments = validateSegments(input.segments);
  const title = (input.title || input.sourceFileName || '未命名文档').trim().slice(0, 500) || '未命名文档';
  const format = normalizeFormat(input.format);
  const fileName = (input.sourceFileName || title).trim().slice(0, 500) || title;
  const projectId = randomUUID();
  const filePath = store.projectPath(projectId);
  const db = store.openProjectDb(projectId, true);
  const now = isoNow();
  const revision = store.insertSourceRevision(db, projectId, title, format, fileName, segments);
  store.projectMeta(db, 'created_at', now);
  const prompt = input.prompt || {};
  store.savePromptRevision(projectId, {
    name: '初始 Prompt',
    systemPrompt: prompt.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: prompt.userPromptTemplate || '',
    sourceLang: prompt.sourceLang || 'auto',
    targetLang: prompt.targetLang || 'zh',
    provider: prompt.provider || 'workbuddy',
    model: prompt.model || 'auto',
    translationMode: prompt.translationMode || 'technical',
    literaryReview: Boolean(prompt.literaryReview),
    glossary: prompt.glossary,
    translationStrategy: prompt.translationStrategy,
  });
  store.catalogDb().prepare(
    'INSERT INTO document_projects(project_id, title, format, source_file_name, source_fingerprint, db_path, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).run(projectId, title, format, fileName, revision.fingerprint, filePath, now, now);
  // 初次建项目时可以把读者旧版的 Voice Bible 迁移一次；之后的记忆写入
  // 必须走显式的 /literary-memory 接口，绝不能再塞进 Prompt/Run 的请求体。
  if (prompt.literaryMemory !== undefined) store.saveLiteraryMemory(projectId, prompt.literaryMemory);
  // 导入一本书是最高频、最需要事后追溯的操作。此前这里一行都不打，
  // 文件日志里完全看不出「这本书是什么时候、以多少片段导进来的」。
  logInfo('document-projects', 'project created · project=' + projectId +
    ' · format=' + format +
    ' · segments=' + segments.length +
    ' · chars=' + segments.reduce((sum, item) => sum + String(item.text || '').length, 0) +
    ' · title=' + title.slice(0, 80) +
    ' · file=' + fileName.slice(0, 120) +
    ' · mode=' + (prompt.translationMode || 'technical'));
  return store.getProject(projectId)!;
}

/**
 * 为已有项目切换到新的不可变原文版本，而不是原地改写旧片段。
 * 活跃 Run/预处理会阻止版本切换；新的 revision 会重新计算稳定片段 ID 与 source hash，
 * 旧 Run、审计报告和 TranslationBrief 快照仍绑定其创建时的 revision。
 */
export function createSourceRevision(store: DocumentProjectStore, projectId: string, input: Omit<CreateProjectInput, 'prompt'>, sourceFile?: { revisionId: string; relativePath: string; sha256: string; size: number }): ProjectSummary {
  const segments = validateSegments(input.segments);
  const current = store.getProject(projectId);
  if (!current) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
  const title = (input.title || current.title).trim().slice(0, 500) || current.title;
  const format = normalizeFormat(input.format || current.format);
  const fileName = (input.sourceFileName || current.sourceFileName).trim().slice(0, 500);
  const db = store.openProjectDb(projectId);
  db.exec('BEGIN IMMEDIATE');
  let revision: any;
  try {
    // 这几个检查必须和版本切换处在同一个 SQLite 写事务里。
    const activeRun = db.prepare(
      "SELECT run_id, status FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') LIMIT 1"
    ).get() as { run_id?: string; status?: string } | undefined;
    if (activeRun?.run_id) {
      throw Object.assign(
        new Error('翻译运行 ' + activeRun.run_id + ' 仍处于 ' + activeRun.status + ' 状态，不能切换原文版本。请先完成、取消或明确处理本次运行。'),
        { status: 409 },
      );
    }
    const graphTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_graph_runs'"
    ).get();
    if (graphTable) {
      const activeGraph = db.prepare(
        "SELECT run_id FROM context_graph_runs WHERE status IN ('queued','running') ORDER BY started_at DESC LIMIT 1"
      ).get() as { run_id?: string } | undefined;
      if (activeGraph?.run_id) {
        throw Object.assign(
          new Error('全书预处理 ' + activeGraph.run_id + ' 仍在运行，不能切换原文版本。请等待预处理结束后再重试。'),
          { status: 409 },
        );
      }
    }
    revision = store.insertSourceRevision(db, projectId, title, format, fileName, segments,
      sourceFile?.revisionId, sourceFile ? { relativePath: sourceFile.relativePath, sha256: sourceFile.sha256, size: sourceFile.size } : undefined);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction may already have committed */ }
    throw error;
  }
  store.catalogDb().prepare('UPDATE document_projects SET title = ?, format = ?, source_file_name = ?, source_fingerprint = ?, updated_at = ? WHERE project_id = ?')
    .run(title, format, fileName, revision.fingerprint, revision.createdAt, projectId);
  return store.getProject(projectId)!;
}

/**
 * 原始文件更新先写入不可变文件，再在 SQLite 事务中登记文件元数据并切换 current revision。
 * 事务失败会清理新文件；异常退出最多留下无引用文件，不会让 current revision 指向缺失文件。
 */
export async function createSourceRevisionWithFile(store: DocumentProjectStore, projectId: string, input: Omit<CreateProjectInput, 'prompt'>, fileName: string, bytes: Uint8Array): Promise<{ project: ProjectSummary; sourceFile: { saved: true; size: number; sha256: string; sourceRevisionId: string } }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw Object.assign(new Error('原始文件内容为空'), { status: 400 });
  }
  if (bytes.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
    throw Object.assign(new Error('原始文件超过 ' + Math.round(MAX_DOCUMENT_SOURCE_BYTES / 1024 / 1024) + ' MiB 上限；可通过 LOCAL_AGENT_MAX_DOCUMENT_SOURCE_MB 调整本机导入上限'), { status: 413 });
  }
  const current = store.getProject(projectId);
  if (!current) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
  const format = normalizeFormat(input.format || current.format);
  const cleanName = path.basename(String(fileName || '')).replace(/[\x00-\x1f]/g, '').slice(0, 240) || ('source.' + format);
  const extension = path.extname(cleanName).replace(/^\./, '').toLowerCase();
  if (extension && extension !== format.toLowerCase()) {
    throw Object.assign(new Error('原始文件扩展名与项目格式不匹配'), { status: 400 });
  }
  const revisionId = randomUUID();
  const relativePath = path.join('sources', revisionId + '.' + format);
  const revisionDir = path.dirname(store.projectPath(projectId));
  const targetPath = path.resolve(revisionDir, relativePath);
  const tempPath = targetPath + '.tmp';
  if (!targetPath.startsWith(revisionDir + path.sep)) throw new Error('原始文件路径不安全');
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const copied = Buffer.from(bytes);
  const sourceHash = createHash('sha256').update(copied).digest('hex');
  let targetCreated = false;
  try {
    await writeFile(tempPath, copied, { flag: 'wx' });
    await rename(tempPath, targetPath);
    targetCreated = true;
    const title = (input.title || current.title).trim().slice(0, 500) || current.title;
    const project = store.createSourceRevision(projectId, {
      ...input, title, format, sourceFileName: cleanName,
    }, { revisionId, relativePath, sha256: sourceHash, size: copied.byteLength });
    const sourceFile = {
      saved: true as const, size: copied.byteLength, sha256: sourceHash, sourceRevisionId: revisionId,
    };
    store.addEvent(projectId, null, 'source.file-saved', {
      sourceRevisionId: revisionId, fileName: cleanName, size: copied.byteLength, sha256: sourceHash,
    });
    return { project, sourceFile };
  } catch (error) {
    const currentRevision = store.openProjectDb(projectId).prepare(
      "SELECT value FROM project_meta WHERE key = 'current_source_revision_id'",
    ).get() as { value?: string } | undefined;
    if (currentRevision?.value !== revisionId) {
      await unlink(tempPath).catch(() => undefined);
      if (targetCreated) await unlink(targetPath).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * 原始源文不存进 SQLite，而是放在文档项目自己的目录里。
 * 内容本身不以大 blob 的形式存进任何一个 SQLite 库。每个版本按
 * 版本 UUID 生成不可变文件名；重复导入永远不会覆盖旧文件。
 */
export async function storeSourceFile(store: DocumentProjectStore, projectId: string, fileName: string, bytes: Uint8Array): Promise<{ saved: true; size: number; sha256: string; sourceRevisionId: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw Object.assign(new Error('原始文件内容为空'), { status: 400 });
  }
  if (bytes.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
    throw Object.assign(new Error('原始文件超过 ' + Math.round(MAX_DOCUMENT_SOURCE_BYTES / 1024 / 1024) + ' MiB 上限；可通过 LOCAL_AGENT_MAX_DOCUMENT_SOURCE_MB 调整本机导入上限'), { status: 413 });
  }
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const revision = db.prepare('SELECT format FROM source_revisions WHERE revision_id = ?').get(currentSourceRevisionId) as { format?: string } | undefined;
  if (!revision?.format) throw Object.assign(new Error('找不到当前来源版本'), { status: 404 });
  const cleanName = path.basename(String(fileName || '')).replace(/[\x00-\x1f]/g, '').slice(0, 240) || ('source.' + revision.format);
  const extension = path.extname(cleanName).replace(/^\./, '').toLowerCase();
  if (extension && extension !== revision.format.toLowerCase()) {
    throw Object.assign(new Error('原始文件扩展名与项目格式不匹配'), { status: 400 });
  }
  const revisionDir = path.dirname(store.projectPath(projectId));
  const relativePath = path.join('sources', currentSourceRevisionId + '.' + revision.format);
  const targetPath = path.resolve(revisionDir, relativePath);
  if (!targetPath.startsWith(revisionDir + path.sep)) throw new Error('原始文件路径不安全');
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const copied = Buffer.from(bytes);
  const sourceHash = createHash('sha256').update(copied).digest('hex');
  await writeFile(targetPath, copied, { flag: 'wx' }).catch(async (error: any) => {
    // 网络超时后重试，可能发现那个不可变文件其实已经写好了。
    // 只有字节完全一致时才复用它；绝不悄悄替换已有的源文版本。
    if (error?.code !== 'EEXIST') throw error;
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(targetPath);
    if (createHash('sha256').update(existing).digest('hex') !== sourceHash) {
      throw Object.assign(new Error('此来源版本已有不同的原始文件，拒绝覆盖'), { status: 409 });
    }
  });
  db.prepare('UPDATE source_revisions SET source_file_path = ?, source_file_hash = ?, source_file_size = ? WHERE revision_id = ?')
    .run(relativePath, sourceHash, copied.byteLength, currentSourceRevisionId);
  store.addEvent(projectId, null, 'source.file-saved', { sourceRevisionId: currentSourceRevisionId, fileName: cleanName, size: copied.byteLength, sha256: sourceHash });
  return { saved: true, size: copied.byteLength, sha256: sourceHash, sourceRevisionId: currentSourceRevisionId };
}

/**
 * 保存 Prompt 修订。相同 fingerprint 的修订会复用已有记录，避免重复写入。
 * 文学记忆不参与 Prompt fingerprint，必须通过独立接口更新。
 */
export function savePromptRevision(store: DocumentProjectStore, projectId: string, prompt: ProjectPrompt & { name?: string }): any {
  if (prompt.literaryMemory !== undefined) {
    throw Object.assign(
      new Error('文学记忆必须通过项目的 /literary-memory 接口显式更新，不能随 Prompt 修订或 Run 创建隐式覆盖。'),
      { status: 400 },
    );
  }
  const db = store.openProjectDb(projectId);
  const config = {
    sourceLang: prompt.sourceLang || 'auto',
    targetLang: prompt.targetLang || 'zh',
    promptStyle: normalizePromptStyle(prompt.promptStyle),
    provider: prompt.provider || 'workbuddy',
    model: prompt.model || 'auto',
    translationMode: prompt.translationMode === 'literary' ? 'literary' : 'technical',
    literaryReview: Boolean(prompt.literaryReview),
    glossary: prompt.glossary ?? null,
    translationStrategy: normalizeDocumentTranslationStrategy(prompt.translationStrategy),
    taskProfiles: normalizeCodeBuddyTaskProfiles(prompt.taskProfiles),
    // 动态书籍记忆存入独立 literary_memory_revisions，不参与静态 Prompt fingerprint。
  };
  const systemPrompt = String(prompt.systemPrompt || DEFAULT_SYSTEM_PROMPT).slice(0, 50000);
  const userPromptTemplate = String(prompt.userPromptTemplate || '').slice(0, 30000);
  const fingerprint = hash(JSON.stringify({ systemPrompt, userPromptTemplate, config }));
  const existing = db.prepare('SELECT * FROM prompt_revisions WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint);
  if (existing) return existing;
  const id = randomUUID();
  const createdAt = isoNow();
  db.prepare('INSERT INTO prompt_revisions(prompt_revision_id, name, system_prompt, user_prompt_template, config_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, (prompt.name || 'Prompt').slice(0, 200), systemPrompt, userPromptTemplate, JSON.stringify(config), fingerprint, createdAt);
  return db.prepare('SELECT * FROM prompt_revisions WHERE prompt_revision_id = ?').get(id);
}

/**
 * 列出项目（默认排除已归档）。
 */
export function listProjects(store: DocumentProjectStore, includeArchived = false): ProjectSummary[] {
  const sql = 'SELECT * FROM document_projects ' + (includeArchived ? '' : 'WHERE archived = 0 ') + 'ORDER BY updated_at DESC';
  return (store.catalogDb().prepare(sql).all() as any[]).map((row) => store.summaryFromCatalog(row));
}

/**
 * 读取项目摘要。
 */
export function getProject(store: DocumentProjectStore, projectId: string): ProjectSummary | null {
  const row = store.catalogDb().prepare('SELECT * FROM document_projects WHERE project_id = ? AND archived = 0').get(projectId) as any;
  if (!row) return null;
  return store.summaryFromCatalog(row);
}

/**
 * 将解析后的文档解析到已有持久化项目，不信任扩展本地项目映射。
 * 精确 source fingerprint 可安全水合；同名/标题匹配仅作为变更候选，不得继承新文档的旧译文。
 */
export function resolveProjectForSource(store: DocumentProjectStore, input: CreateProjectInput): {
    exactProject: ProjectSummary | null;
    relatedProject: ProjectSummary | null;
  } {
  const segments = validateSegments(input.segments);
  const format = normalizeFormat(input.format);
  const title = (input.title || input.sourceFileName || '').trim().toLocaleLowerCase();
  const fileName = (input.sourceFileName || input.title || '').trim().toLocaleLowerCase();
  const fingerprint = sourceFingerprint(segments);
  const projects = store.listProjects().filter((project) => project.format === format);
  const score = (project: ProjectSummary) =>
    (project.sourceFileName.trim().toLocaleLowerCase() === fileName ? 4 : 0) +
    (project.title.trim().toLocaleLowerCase() === title ? 2 : 0);
  const newestFirst = (a: ProjectSummary, b: ProjectSummary) =>
    score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt);
  const exactProject = projects
    .filter((project) => project.sourceFingerprint === fingerprint)
    .sort(newestFirst)[0] || null;
  const relatedProject = exactProject ? null : projects
    .filter((project) =>
      project.sourceFileName.trim().toLocaleLowerCase() === fileName ||
      project.title.trim().toLocaleLowerCase() === title)
    .sort(newestFirst)[0] || null;
  return { exactProject, relatedProject };
}

/**
 * 检查导入文件是否与当前来源版本已附带的原始文件字节完全一致。
 * 用于区分解析器版本变化与真正的文档变化，不信任文件名或浏览器生成的片段指纹。
 */
export function matchesStoredSourceFile(store: DocumentProjectStore, projectId: string, bytes: Uint8Array): boolean {
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const row = db.prepare(
    'SELECT source_file_hash, source_file_size FROM source_revisions WHERE revision_id = ?'
  ).get(currentSourceRevisionId) as { source_file_hash?: string | null; source_file_size?: number | null } | undefined;
  if (!row?.source_file_hash || row.source_file_size !== bytes.byteLength) return false;
  const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  return digest === row.source_file_hash;
}

/**
 * 从 catalog 行与项目库元数据组装 ProjectSummary。
 */
export function summaryFromCatalog(store: DocumentProjectStore, row: any): ProjectSummary {
  const db = store.openProjectDb(row.project_id);
  const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((item) => [item.key, item.value]));
  const revision = db.prepare('SELECT * FROM source_revisions WHERE revision_id = ?').get(meta.get('current_source_revision_id') || '') as any;
  return {
    projectId: row.project_id,
    title: row.title,
    format: row.format,
    sourceFileName: row.source_file_name,
    sourceFingerprint: row.source_fingerprint,
    currentSourceRevisionId: meta.get('current_source_revision_id') || '',
    segmentCount: Number(revision?.segment_count || 0),
    sourceFileSaved: Boolean(revision?.source_file_path),
    sourceFileSize: Number.isFinite(revision?.source_file_size) ? Number(revision.source_file_size) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived),
  };
}

/**
 * 根据项目数据库元数据修复 catalog 行。
 */
export function repairCatalogRow(store: DocumentProjectStore, projectId: string): void {
  const db = store.openProjectDb(projectId);
  const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  const revisionId = meta.get('current_source_revision_id') || '';
  const revision = db.prepare('SELECT * FROM source_revisions WHERE revision_id = ?').get(revisionId) as any;
  if (!revision) throw new Error('文档项目没有有效来源版本');
  store.catalogDb().prepare('UPDATE document_projects SET title = ?, format = ?, source_file_name = ?, source_fingerprint = ?, updated_at = ? WHERE project_id = ?')
    .run(meta.get('title') || revision.file_name, revision.format, revision.file_name, revision.source_fingerprint, isoNow(), projectId);
}

/**
 * 归档项目（catalog 标记 archived=1）。
 */
export function archiveProject(store: DocumentProjectStore, projectId: string): void {
  const result = store.catalogDb()
    .prepare('UPDATE document_projects SET archived = 1, updated_at = ? WHERE project_id = ? AND archived = 0')
    .run(isoNow(), projectId);
  if (Number(result.changes) > 0) {
    logInfo('document-projects', 'project archived · project=' + projectId);
  }
}

/**
 * 校验项目翻译完整性：缺失、旧来源、旧 Prompt 等。
 */
export function verifyProject(store: DocumentProjectStore, projectId: string): any {
  const project = store.getProject(projectId);
  if (!project) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const segments = db.prepare('SELECT segment_id, source_hash FROM source_segments WHERE source_revision_id = ?').all(currentSourceRevisionId) as any[];
  const latestAccepted = new Map<string, any>();
  const anyAcceptedIds = new Set<string>();
  const currentHashById = new Map<string, string>(segments.map((segment) => [segment.segment_id, segment.source_hash]));
  for (const row of db.prepare('SELECT * FROM translation_results WHERE accepted = 1 ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC').all() as any[]) {
    anyAcceptedIds.add(row.segment_id);
    if (row.source_hash === currentHashById.get(row.segment_id) && !latestAccepted.has(row.segment_id)) {
      latestAccepted.set(row.segment_id, row);
    }
  }
  const latestPrompt = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
  const currentMemory = store.getCurrentLiteraryMemory(projectId);
  const currentFingerprint = latestPrompt
    ? store.makeRunFingerprint(projectId, currentSourceRevisionId, latestPrompt, parseJson<any>(latestPrompt.config_json, {}), currentMemory.fingerprint || null)
    : '';
  const missing: string[] = [];
  const stale: string[] = [];
  const stalePrompt: string[] = [];
  for (const segment of segments) {
    const result = latestAccepted.get(segment.segment_id);
    if (!result) {
      if (anyAcceptedIds.has(segment.segment_id)) stale.push(segment.segment_id);
      else missing.push(segment.segment_id);
      continue;
    }
    if (result.origin !== 'manual' && result.run_fingerprint !== currentFingerprint) stalePrompt.push(segment.segment_id);
  }
  const activeRuns = db.prepare("SELECT run_id, status FROM translation_runs WHERE status IN ('queued','running','paused','awaiting_acceptance','partial') ORDER BY created_at DESC").all();
  return {
    project,
    totalSegments: segments.length,
    acceptedSegments: segments.length - missing.length - stale.length - stalePrompt.length,
    missingSegmentIds: missing,
    staleSourceIds: stale,
    stalePromptIds: stalePrompt,
    activeRuns,
  };
}

/**
 * 返回项目、数据库实例与当前来源版本 ID 的上下文。
 */
export function getProjectContext(store: DocumentProjectStore, projectId: string): any {
  const project = store.getProject(projectId);
  if (!project) throw Object.assign(new Error('找不到文档项目'), { status: 404 });
  const db = store.openProjectDb(projectId);
  const meta = new Map((db.prepare('SELECT key, value FROM project_meta').all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
  return { project, db, currentSourceRevisionId: meta.get('current_source_revision_id') || '' };
}
