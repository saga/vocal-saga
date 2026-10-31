/**
 * HTTP adapter for the durable document-project API.
 * Request handling is deliberately thin: project state and transitions live in projectStore,
 * while model execution is owned by translationAgent. This keeps UI and CLI on one contract.
 */
import type { Request, Response } from 'express';
import { getDocumentProjectStore, MAX_DOCUMENT_SOURCE_BYTES } from './projectStore.ts';
import { startProjectTranslationRun, isProjectRunActive } from './translationAgent.ts';
import { scheduleChineseEditorialProfileRefresh } from './chineseEditorialProfile.ts';
import { sendApiError, sendJson } from '../middleware.ts';
import { parseDocumentFile } from './ingest.ts';
import { startContextGraphAnalysis, getContextGraph, getContextGraphStatus, reviewContextGraphItem } from './contextGraph.ts';
import {
  runProjectQualityAudit,
  createQualityRepairRun,
  createProjectQualityEvaluation,
  submitProjectQualityEvaluationReviews,
  getProjectQualityEvaluation,
} from './qualityAudit.ts';

function bodyObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON 请求体必须是对象'), { status: 400 });
  }
  return value as Record<string, any>;
}
function routeError(res: Response, error: unknown): void {
  const value = error as { status?: number; message?: string };
  const status = Number.isInteger(value?.status) && Number(value.status) >= 400 && Number(value.status) < 600
    ? Number(value.status) : 500;
  const message = value?.message || String(error);
  sendApiError(res, status, message);
}
async function readRawSourceBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw Object.assign(new Error('原始文档超过 ' + Math.round(maxBytes / 1024 / 1024) + ' MiB 上限'), { status: 413 });
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function decoded(segment: string): string {
  try { return decodeURIComponent(segment); }
  catch { throw Object.assign(new Error('URL 路径编码无效'), { status: 400 }); }
}

/**
 * 处理 /api/documents/projects 路由族。
 *
 * 返回 true 表示该请求已由此模块处理（包括已返回的错误响应），false 表示路径不属于该路由族。
 * 本模块应保持为薄 HTTP adapter：参数校验后委托 Store/Agent/ContextGraph/QualityAudit，
 * 不在路由中另造一套 Run 状态或持久化规则。
 */
export async function handleDocumentProjectRequest(req: Request, res: Response, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/documents/projects')) return false;
  try {
    const method = req.method.toUpperCase();
    const pathParts = url.pathname.split('/').filter(Boolean).map(decoded);
    // api / documents / projects
    if (pathParts.length === 3 && method === 'GET') {
      sendJson(res, 200, { projects: getDocumentProjectStore().listProjects() });
      return true;
    }
    if (pathParts.length === 3 && method === 'POST') {
      const body = bodyObject(req.body);
      const store = getDocumentProjectStore();
      const input = {
        title: String(body.title || body.fileName || '未命名文档'),
        format: String(body.format || ''),
        sourceFileName: typeof body.sourceFileName === 'string' ? body.sourceFileName : body.fileName,
        segments: body.segments,
        prompt: body.prompt && typeof body.prompt === 'object' ? body.prompt : undefined,
      };

      // Make concurrent auto-initialization idempotent. The explicit "separate project" action
      // opts out; every ordinary creation first reuses an exact source match or rejects a
      // same-name/source-changed candidate so the client can ask for an explicit decision.
      if (body.allowDuplicate !== true) {
        const resolution = store.resolveProjectForSource(input);
        if (resolution.exactProject) {
          sendJson(res, 200, { project: resolution.exactProject, reusedExisting: true });
          return true;
        }
        if (resolution.relatedProject) {
          throw Object.assign(
            new Error('已存在来源不同的同名文档项目。请明确更新现有来源版本或选择另建项目。'),
            { status: 409 },
          );
        }
      }

      const project = store.createProject(input);
      sendJson(res, 201, { project, reusedExisting: false });
      return true;
    }

    if (pathParts.length < 4) {
      sendApiError(res, 404, '未知文档项目端点');
      return true;
    }
    const store = getDocumentProjectStore();
    // Resolve from the service catalog so extension IndexedDB/session loss cannot create duplicate projects.
    if (pathParts.length === 4 && pathParts[3] === 'resolve' && method === 'POST') {
      const body = bodyObject(req.body);
      const resolution = store.resolveProjectForSource({
        title: String(body.title || ''),
        format: String(body.format || ''),
        sourceFileName: typeof body.sourceFileName === 'string' ? body.sourceFileName : undefined,
        segments: body.segments,
      });
      sendJson(res, 200, resolution);
      return true;
    }
    // Import raw files within the local service. The extension does not parse or split documents.
    if (pathParts.length === 4 && pathParts[3] === 'import-file' && method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase();
      if (!['application/octet-stream', 'application/epub+zip', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown', 'text/html'].includes(contentType)) {
        sendApiError(res, 415, '文件导入需要使用 application/octet-stream 或与文件格式匹配的 Content-Type', '文件导入需要使用 application/octet-stream 或与文件格式匹配的 Content-Type');
        return true;
      }
      const encodedName = String(req.headers['x-source-file-name'] || '');
      let fileName = encodedName;
      try { if (encodedName) fileName = decodeURIComponent(encodedName); }
      catch { throw Object.assign(new Error('X-Source-File-Name 编码无效'), { status: 400 }); }
      if (!fileName || fileName.includes('/') || fileName.includes('\\')) throw Object.assign(new Error('X-Source-File-Name 必须是文件名，不得包含路径'), { status: 400 });
      const bytes = await readRawSourceBody(req, MAX_DOCUMENT_SOURCE_BYTES);
      if (req.headers['x-import-mode'] !== 'separate') {
        const sameSourceProject = store.listProjects()
          .filter((candidate) => candidate.sourceFileSaved &&
            candidate.sourceFileName.toLocaleLowerCase() === fileName.toLocaleLowerCase() &&
            candidate.sourceFileSize === bytes.byteLength)
          .find((candidate) => store.matchesStoredSourceFile(candidate.projectId, bytes));
        if (sameSourceProject) {
          sendJson(res, 200, {
            project: store.getProject(sameSourceProject.projectId),
            reusedExisting: true,
            sourceFileHashMatched: true,
          });
          return true;
        }
      }
      const parsed = await parseDocumentFile(fileName, bytes);
      const encodedTitle = String(req.headers['x-project-title'] || '');
      let title = parsed.title;
      try { if (encodedTitle) title = decodeURIComponent(encodedTitle).trim().slice(0, 500) || title; }
      catch { throw Object.assign(new Error('X-Project-Title 编码无效'), { status: 400 }); }
      const sourceInput = {
        title, format: parsed.format, sourceFileName: fileName, segments: parsed.segments,
      };
      const resolution = req.headers['x-import-mode'] === 'separate'
        ? { exactProject: null, relatedProject: null }
        : store.resolveProjectForSource({ ...sourceInput, prompt: { translationMode: 'literary' } });

      if (resolution.exactProject) {
        const sourceFile = resolution.exactProject.sourceFileSaved
          ? undefined
          : await store.storeSourceFile(resolution.exactProject.projectId, fileName, bytes);
        sendJson(res, 200, {
          project: store.getProject(resolution.exactProject.projectId),
          ...(sourceFile ? { sourceFile } : {}),
          reusedExisting: true,
        });
        return true;
      }

      // A legacy project may have been segmented by an older extension parser. If its immutable
      // original file matches exactly, reuse its SQLite segments rather than misclassifying the
      // new server parser's different segmentation as a user-edited source.
      if (resolution.relatedProject?.sourceFileSaved &&
          store.matchesStoredSourceFile(resolution.relatedProject.projectId, bytes)) {
        sendJson(res, 200, {
          project: store.getProject(resolution.relatedProject.projectId),
          reusedExisting: true,
          parserVersionMigrationSuggested: false,
        });
        return true;
      }

      // Never silently create a second project for a same-name book with different content.
      // The server parsed this file already, so return the parsed preview for the existing
      // source-change confirmation workflow instead of asking the extension to parse the binary.
      if (resolution.relatedProject) {
        sendJson(res, 200, {
          sourceChanged: true,
          relatedProject: resolution.relatedProject,
          document: {
            title: parsed.title || title,
            format: parsed.format,
            segments: parsed.segments,
          },
        });
        return true;
      }

      const project = store.createProject({
        ...sourceInput, prompt: { translationMode: 'literary' },
      });
      try {
        const sourceFile = await store.storeSourceFile(project.projectId, fileName, bytes);
        // Opening/importing a book must not automatically start a long analysis. The explicit
        // UI action or a persisted literary Run owns Context Graph preprocessing.
        sendJson(res, 201, { project, sourceFile, reusedExisting: false });
      } catch (error) {
        try { store.archiveProject(project.projectId); } catch { /* preserve the original error */ }
        throw error;
      }
      return true;
    }
    const projectId = pathParts[3]!;
    // Every nested route, including run resume/accept/cancel, must reject archived projects.
    // The per-process SQLite connection cache must not turn an archived project into a live one.
    if (!store.getProject(projectId)) {
      sendApiError(res, 404, '找不到文档项目或项目已归档');
      return true;
    }

    if (pathParts.length === 4 && method === 'GET') {
      const project = store.getProject(projectId);
      if (!project) { sendApiError(res, 404, '找不到文档项目'); return true; }
      sendJson(res, 200, { project, verification: store.verifyProject(projectId), runs: store.listRuns(projectId, 10) });
      return true;
    }
    if (pathParts.length === 4 && method === 'DELETE') {
      store.archiveProject(projectId);
      sendJson(res, 200, { archived: true, projectId });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'source-file' && method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase();
      if (!['application/octet-stream', 'application/pdf', 'application/epub+zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(contentType)) {
        sendApiError(res, 415, '原始文档上传需要使用二进制 Content-Type', '原始文档上传需要使用二进制 Content-Type');
        return true;
      }
      const encodedName = String(req.headers['x-source-file-name'] || '');
      let fileName = encodedName;
      try { if (encodedName) fileName = decodeURIComponent(encodedName); }
      catch { throw Object.assign(new Error('X-Source-File-Name 编码无效'), { status: 400 }); }
      if (!fileName || fileName.includes('/') || fileName.includes('\\')) throw Object.assign(new Error('X-Source-File-Name 必须是文件名，不得包含路径'), { status: 400 });
      const bytes = await readRawSourceBody(req, MAX_DOCUMENT_SOURCE_BYTES);
      if (req.headers['x-source-action'] === 'update-revision') {
        const parsed = await parseDocumentFile(fileName, bytes);
        const project = store.createSourceRevision(projectId, {
          title: parsed.title || store.getProject(projectId)!.title,
          format: parsed.format,
          sourceFileName: fileName,
          segments: parsed.segments,
        });
        const sourceFile = await store.storeSourceFile(projectId, fileName, bytes);
        sendJson(res, 201, { project: store.getProject(projectId), sourceFile });
        return true;
      }
      const saved = await store.storeSourceFile(projectId, fileName, bytes);
      sendJson(res, 200, saved);
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'source' && method === 'POST') {
      const body = bodyObject(req.body);
      const project = store.createSourceRevision(projectId, {
        title: String(body.title || ''),
        format: String(body.format || ''),
        sourceFileName: typeof body.sourceFileName === 'string' ? body.sourceFileName : undefined,
        segments: body.segments,
      });
      sendJson(res, 201, { project });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'translations' && pathParts[5] === 'import' && method === 'POST') {
      const body = bodyObject(req.body);
      const result = store.importAcceptedTranslations(projectId, body.items);
      sendJson(res, 200, result);
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'segments' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const rawOffset = url.searchParams.get('offset');
      const parsedLimit = rawLimit === null ? 250 : Number(rawLimit);
      const parsedOffset = rawOffset === null ? 0 : Number(rawOffset);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
        throw Object.assign(new Error('limit 必须是 1-1000 的整数'), { status: 400 });
      }
      if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
        throw Object.assign(new Error('offset 必须是非负整数'), { status: 400 });
      }
      const runId = url.searchParams.get('runId') || undefined;
      sendJson(res, 200, {
        project: store.getProject(projectId),
        segments: store.getSegments(projectId, { limit: parsedLimit, offset: parsedOffset, runId }),
        limit: parsedLimit,
        offset: parsedOffset,
      });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'segments' && pathParts[6] === 'translation' && method === 'PUT') {
      const body = bodyObject(req.body);
      if (typeof body.text !== 'string') {
        throw Object.assign(new Error('text 必须是字符串；如需清空译文，请显式传入空字符串'), { status: 400 });
      }
      const saved = store.saveManualEdit(projectId, pathParts[5]!, body.text);
      sendJson(res, 200, saved);
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'prompts' && method === 'GET') {
      sendJson(res, 200, { prompts: store.listPrompts(projectId) });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'prompts' && method === 'POST') {
      const body = bodyObject(req.body);
      const prompt = store.savePrompt(projectId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined,
        userPromptTemplate: typeof body.userPromptTemplate === 'string' ? body.userPromptTemplate : undefined,
        sourceLang: typeof body.sourceLang === 'string' ? body.sourceLang : undefined,
        targetLang: typeof body.targetLang === 'string' ? body.targetLang : undefined,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        translationMode: body.translationMode === 'literary' ? 'literary' : 'technical',
        literaryReview: body.literaryReview === true,
        glossary: body.glossary,
        translationStrategy: body.translationStrategy && typeof body.translationStrategy === 'object'
          ? body.translationStrategy : undefined,
        taskProfiles: body.taskProfiles && typeof body.taskProfiles === 'object' ? body.taskProfiles : undefined,
        literaryMemory: body.literaryMemory,
      });
      sendJson(res, 201, { prompt, literaryMemory: store.getCurrentLiteraryMemory(projectId) });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'context-graph' && pathParts[5] === 'status' && method === 'GET') {
      sendJson(res, 200, { contextGraph: getContextGraphStatus(projectId) });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'context-graph' && method === 'GET') {
      sendJson(res, 200, { contextGraph: getContextGraph(projectId) });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'context-graph' && pathParts[5] === 'analyze' && method === 'POST') {
      sendJson(res, 202, { preprocessing: startContextGraphAnalysis(projectId) });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'context-graph' && pathParts[5] === 'review' && method === 'POST') {
      const body = bodyObject(req.body);
      if (!['node', 'edge'].includes(body.type) || typeof body.id !== 'string' ||
          !['candidate', 'confirmed', 'rejected'].includes(body.status)) {
        throw Object.assign(new Error('review 需要 type=node|edge、id 和 status=candidate|confirmed|rejected'), { status: 400 });
      }
      sendJson(res, 200, { review: reviewContextGraphItem(projectId, body.type, body.id, body.status) });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'literary-memory' && method === 'GET') {
      sendJson(res, 200, {
        current: store.getCurrentLiteraryMemory(projectId),
        revisions: store.listLiteraryMemoryRevisions(projectId),
      });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'literary-memory' && method === 'POST') {
      const body = bodyObject(req.body);
      const saved = store.saveLiteraryMemory(projectId, body.memory);
      sendJson(res, 201, { ...saved, current: store.getCurrentLiteraryMemory(projectId) });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'literary-memory' &&
        pathParts[5] === 'chinese-editorial-profile' && pathParts[6] === 'review' && method === 'POST') {
      const body = bodyObject(req.body || {});
      if (body.action !== 'confirm' && body.action !== 'reject') {
        throw Object.assign(new Error('action 必须是 confirm 或 reject'), { status: 400 });
      }
      const current = store.getCurrentLiteraryMemory(projectId);
      const profile = current.memory.chineseEditorialProfile;
      const projectContext = store.getProjectContext(projectId);
      if (!profile || profile.sourceRevisionId !== projectContext.currentSourceRevisionId ||
          !Array.isArray(profile.evidenceRefs) ||
          new Set(profile.evidenceRefs.map((item: any) => String(item.segmentId || '')).filter(Boolean)).size < 3) {
        throw Object.assign(new Error('当前来源版本没有可确认的中文编辑档案，或档案证据已失效。'), { status: 409 });
      }
      if (body.action === 'confirm' && profile.status === 'rejected') {
        throw Object.assign(new Error('已拒绝的编辑档案不能直接确认，请先重新分析生成新候选。'), { status: 409 });
      }
      const nextMemory = {
        ...current.memory,
        chineseEditorialProfile: {
          ...profile,
          status: body.action === 'confirm' ? 'confirmed' : 'rejected',
          ...(body.action === 'confirm'
            ? { confirmationSource: 'user-confirmed', confirmedAt: new Date().toISOString() }
            : { confirmationSource: undefined, confirmedAt: undefined }),
        },
      };
      const saved = store.saveLiteraryMemory(projectId, nextMemory);
      store.appendEvent(projectId, null, 'chinese-editorial-profile.user-reviewed', {
        action: body.action,
        memoryRevisionId: saved.memoryRevisionId,
        sourceRevisionId: profile.sourceRevisionId,
      });
      sendJson(res, 200, { ...saved, current: store.getCurrentLiteraryMemory(projectId) });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'runs' && pathParts[6] === 'translation-briefs' && method === 'GET') {
      const runId = pathParts[5]!;
      // includeContent is explicit here because the API user is requesting this run's auditable retrieval snapshot.
      sendJson(res, 200, { runId, translationBriefs: store.listTranslationBriefSnapshots(projectId, runId, true) });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'runs' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw Object.assign(new Error('limit 必须是 1-200 的整数'), { status: 400 });
      }
      sendJson(res, 200, { runs: store.listRuns(projectId, limit) });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'runs' && method === 'POST') {
      const body = bodyObject(req.body);
      const run = store.createRun(projectId, {
        promptRevisionId: typeof body.promptRevisionId === 'string' ? body.promptRevisionId : undefined,
        prompt: body.prompt && typeof body.prompt === 'object' ? body.prompt : undefined,
        scope: body.scope && typeof body.scope === 'object' ? body.scope : { type: 'stale' },
      });
      if (run.counts.total > 0) startProjectTranslationRun(projectId, run.runId);
      sendJson(res, 202, { run, started: run.counts.total > 0 });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'runs' && pathParts[6] === 'resume' && method === 'POST') {
      const runId = pathParts[5]!;
      const run = store.getRun(projectId, runId);
      const currentSourceRevisionId = store.getProjectContext(projectId).currentSourceRevisionId;
      if (run.sourceRevisionId !== currentSourceRevisionId) {
        sendApiError(
          res, 409,
          '这次运行使用的是旧原文版本，不能恢复到当前文档。请基于当前原文创建新的运行。',
          '这次运行使用的是旧原文版本，不能恢复到当前文档。请基于当前原文创建新的运行。',
          { run },
        );
        return true;
      }
      if (!['paused', 'queued', 'failed', 'partial'].includes(run.status)) {
        sendApiError(res, 409, '当前运行状态不允许恢复：' + run.status, '当前运行状态不允许恢复：' + run.status, { run });
        return true;
      }
      if (isProjectRunActive(runId)) {
        sendJson(res, 200, { run, alreadyRunning: true });
        return true;
      }
      if (!store.setRunStatus(projectId, runId, 'queued', null)) {
        sendApiError(res, 409, '运行已结束，不能继续恢复：' + store.getRunStatus(projectId, runId), '运行已结束，不能继续恢复：' + store.getRunStatus(projectId, runId), { run: store.getRun(projectId, runId) });
        return true;
      }
      const started = startProjectTranslationRun(projectId, runId);
      sendJson(res, 202, { run: store.getRun(projectId, runId), ...started });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'runs' && pathParts[6] === 'cancel' && method === 'POST') {
      const runId = pathParts[5]!;
      const run = store.getRun(projectId, runId);
      if (['completed', 'cancelled', 'failed'].includes(run.status)) {
        sendApiError(res, 409, '运行已经结束：' + run.status, '运行已经结束：' + run.status, { run });
        return true;
      }
      if (!store.setRunStatus(projectId, runId, 'cancelled', '用户请求停止')) {
        const latest = store.getRun(projectId, runId);
        sendApiError(res, 409, '运行已结束，不能取消：' + latest.status, '运行已结束，不能取消：' + latest.status, { run: latest });
        return true;
      }
      store.markRunSegments(projectId, runId, run.segments.filter((item: any) => ['pending', 'running'].includes(item.status)).map((item: any) => item.id), 'cancelled');
      sendJson(res, 200, { run: store.getRun(projectId, runId) });
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'runs' && pathParts[6] === 'accept' && method === 'POST') {
      const body = bodyObject(req.body || {});
      const run = store.acceptCandidates(projectId, pathParts[5]!, Array.isArray(body.segmentIds) ? body.segmentIds.map(String) : undefined);
      scheduleChineseEditorialProfileRefresh(projectId, pathParts[5]!);
      sendJson(res, 200, { run });
      return true;
    }
    if (pathParts.length === 8 && pathParts[4] === 'runs' && pathParts[6] === 'findings' && method === 'POST') {
      const body = bodyObject(req.body);
      if (body.action !== 'apply' && body.action !== 'dismiss') {
        throw Object.assign(new Error('action 必须是 apply 或 dismiss'), { status: 400 });
      }
      const findingId = Number(pathParts[7]);
      if (!Number.isSafeInteger(findingId) || findingId < 1) {
        throw Object.assign(new Error('findingId 必须是正整数'), { status: 400 });
      }
      const result = store.setReviewFindingDisposition(projectId, pathParts[5]!, findingId, body.action);
      if (body.action === 'apply') scheduleChineseEditorialProfileRefresh(projectId, pathParts[5]!);
      sendJson(res, 200, { result, run: store.getRun(projectId, pathParts[5]!) });
      return true;
    }

    if (pathParts.length === 5 && pathParts[4] === 'quality-audit' && method === 'GET') {
      const auditId = url.searchParams.get('auditId') || undefined;
      const report = store.getQualityAudit(projectId, auditId);
      if (!report) { sendApiError(res, 404, '尚无质量审计报告，请先执行 POST /quality-audit'); return true; }
      sendJson(res, 200, { report });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'quality-audit' && method === 'POST') {
      const body = req.body == null ? {} : bodyObject(req.body);
      const report = runProjectQualityAudit(projectId, typeof body.runId === 'string' ? body.runId : undefined);
      sendJson(res, 200, { report });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'quality-audit' && pathParts[5] === 'repair' && method === 'POST') {
      const body = bodyObject(req.body);
      const repair = createQualityRepairRun(
        projectId,
        String(body.auditId || ''),
        Array.isArray(body.findingIds) ? body.findingIds.map(String) : [],
        Array.isArray(body.segmentIds) ? body.segmentIds.map(String) : [],
      );
      if (repair.run.counts.total > 0) startProjectTranslationRun(projectId, repair.run.runId);
      sendJson(res, 202, { repair, started: repair.run.counts.total > 0 });
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'quality-evaluations' && method === 'POST') {
      const body = bodyObject(req.body);
      if (typeof body.beforeRunId !== 'string' || !body.beforeRunId.trim() ||
          typeof body.afterRunId !== 'string' || !body.afterRunId.trim()) {
        throw Object.assign(new Error('beforeRunId 和 afterRunId 必须是非空字符串'), { status: 400 });
      }
      const evaluation = createProjectQualityEvaluation(projectId, body.beforeRunId.trim(), body.afterRunId.trim());
      sendJson(res, 201, { evaluation });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'quality-evaluations' && method === 'GET') {
      sendJson(res, 200, getProjectQualityEvaluation(projectId, pathParts[5]!));
      return true;
    }
    if (pathParts.length === 7 && pathParts[4] === 'quality-evaluations' && pathParts[6] === 'reviews' && method === 'POST') {
      const body = bodyObject(req.body);
      const result = submitProjectQualityEvaluationReviews(projectId, pathParts[5]!, body.reviews);
      sendJson(res, 200, result);
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'verify' && method === 'GET') {
      sendJson(res, 200, store.verifyProject(projectId));
      return true;
    }
    if (pathParts.length === 5 && pathParts[4] === 'events' && method === 'GET') {
      const rawAfter = url.searchParams.get('after');
      const rawLimit = url.searchParams.get('limit');
      const after = rawAfter === null ? 0 : Number(rawAfter);
      const limit = rawLimit === null ? 200 : Number(rawLimit);
      const latest = url.searchParams.get('latest') === 'true';
      if (!Number.isSafeInteger(after) || after < 0) {
        throw Object.assign(new Error('after 必须是非负整数'), { status: 400 });
      }
      // Initial trajectory hydration needs the newest window, not the first 5,000 historical rows.
      // Keep incremental polling bounded, while allowing a larger latest-only snapshot.
      const maxLimit = latest && after === 0 ? 5000 : 1000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
        throw Object.assign(new Error('limit 必须是 1-' + maxLimit + ' 的整数'), { status: 400 });
      }
      const runId = url.searchParams.get('runId') || undefined;
      sendJson(res, 200, { events: store.getEvents(projectId, runId, after, limit, latest) });
      return true;
    }
    if (pathParts.length === 6 && pathParts[4] === 'runs' && method === 'GET') {
      sendJson(res, 200, { run: store.getRun(projectId, pathParts[5]!) });
      return true;
    }

    sendApiError(res, 404, '未知文档项目端点：' + method + ' ' + url.pathname);
    return true;
  } catch (error) {
    routeError(res, error);
    return true;
  }
}
