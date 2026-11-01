/**
 * 文档项目存储的门面。
 *
 * 每个文档项目拥有自己的 SQLite 文件，catalog.sqlite 记录项目位置与当前来源版本；
 * 项目数据库是来源版本、提示词、Run、候选译文与人工修订的唯一真相。
 *
 * 实作按域分布在同目录的 projectStore* 模块里，这里只保留类形态与转发，
 * 让调用方继续以「一个 store 实例」的方式使用，不必关心实现落在哪个文件。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.ts';
import { sourceFingerprint } from './documentStoreUtils.ts';
import { type DocumentFormat, type ProjectPrompt, type ProjectSegment, type RunStatus } from './documentStrategy.ts';
import {
  initialize, catalogDb, projectPath, openProjectDb, repairCatalogFromDisk, projectMeta, insertSourceRevision,
  createProject, createSourceRevision, createSourceRevisionWithFile, storeSourceFile, savePromptRevision,
  listProjects, getProject, resolveProjectForSource, matchesStoredSourceFile, summaryFromCatalog, repairCatalogRow,
  archiveProject, verifyProject, getProjectContext,
} from './projectStoreCatalog.ts';
import { recoverInterruptedRuns, recoverAwaitingAcceptanceRun } from './projectStoreRecovery.ts';
import {
  createRun, appendEvent, addEvent, makeRunFingerprint, listRuns, getRun, getRunStatus, setRunStatus,
  markRunSegments, finishRun, getRunContext, runSummary, getRunSegmentIds, getRunSegmentsForExecution,
  getPrecedingSegments, getSegments, getEvents,
} from './projectStoreRuns.ts';
import {
  savePrompt, listPrompts, publicPrompt, saveLiteraryMemory, getCurrentLiteraryMemory, listLiteraryMemoryRevisions,
  assertLiteraryPreprocessingReady, validateLiteraryMemoryAgainstProject, contextGraphFingerprint, saveTranslationBriefSnapshot,
  listTranslationBriefSnapshots, saveTranslationContextDelta, listTranslationContextDeltas,
} from './projectStoreMemory.ts';
import {
  saveCandidates, saveCandidate, saveFindings, saveFinding, markChineseEditorialFindingsReviewed, setReviewFindingDisposition,
  acceptCandidates, importAcceptedTranslations, saveManualEdit,
} from './projectStoreReview.ts';
import {
  saveQualityAudit, getQualityAudit, saveQualityEvaluation, getQualityEvaluation, updateQualityEvaluationReviews,
} from './projectStoreQuality.ts';

/** 项目列表用的摘要视图，不含片段正文，只带计数与指纹。 */
export interface ProjectSummary {
  projectId: string;
  title: string;
  format: DocumentFormat;
  sourceFileName: string;
  sourceFingerprint: string;
  currentSourceRevisionId: string;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  sourceFileSaved: boolean;
  sourceFileSize: number | null;
}

/** 建项目入参。`segments` 会先过 validateSegments 才落库；`title` 必填，缺省值由调用方（路由/CLI）给出。 */
export interface CreateProjectInput {
  title: string;
  format: string;
  sourceFileName?: string;
  segments: ProjectSegment[];
  prompt?: ProjectPrompt;
}

/**
 * 建运行入参。`scope` 决定处理哪些片段：默认 stale（源文或提示词已变的），
 * 也可指定 all / failed / ids / chapter；`prompt` 不填则沿用项目当前提示词。
 */
export interface CreateRunInput {
  promptRevisionId?: string;
  prompt?: ProjectPrompt;
  parentRunId?: string;
  scope?: { type?: 'all' | 'stale' | 'failed' | 'ids' | 'chapter'; ids?: string[]; chapter?: string };
}

/**
 * 文档项目的门面。实作按域分布在同一目录的 projectStore* 模块里，这里只做转发与单例管理。
 * 每个项目一个独立 SQLite 文件，`catalog` 是记录项目清单的总库。
 */
export class DocumentProjectStore {
  catalog?: DatabaseSync;

  readonly projectDbs = new Map<string, DatabaseSync>();

  readonly rootDir: string;

  constructor(rootDir = path.join(DATA_DIR, 'documents')) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * 初始化项目目录与 catalog 数据库。
   * 启动时会从磁盘修复 catalog，并恢复被中断的运行，保证服务重启后状态一致。
   */
  initialize(): void {
    return initialize(this);
  }

  /**
   * 服务重启后恢复处于 awaiting_acceptance 的 Run。
   * 先在事务内完成文学记忆增量合并（仅 literary 模式且原文未变化），再采纳候选译文，保证最终化幂等。
   * 内部使用：实现位于 projectStoreRecovery.ts。
   */
  recoverAwaitingAcceptanceRun(projectId: string, runId: string): void {
    return recoverAwaitingAcceptanceRun(this, projectId, runId);
  }

  /**
   * 返回 catalog 数据库实例，必要时先初始化。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  catalogDb(): DatabaseSync {
    return catalogDb(this);
  }

  /**
   * 根据 projectId 计算项目数据库文件路径，并校验 ID 格式。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  projectPath(projectId: string): string {
    return projectPath(this, projectId);
  }

  /**
   * 打开（或创建）项目数据库，带缓存。
   * 非创建模式下会校验项目存在于 catalog 且未归档，避免打开孤儿数据库。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  openProjectDb(projectId: string, create = false): DatabaseSync {
    return openProjectDb(this, projectId, create);
  }

  /**
   * 扫描磁盘上的项目目录，将缺失的 catalog 记录补回 catalog.sqlite。
   * 用于服务重启或数据库损坏恢复，避免已持久化的项目在列表中消失。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  repairCatalogFromDisk(): void {
    return repairCatalogFromDisk(this);
  }

  /**
   * 服务启动时恢复被中断的运行。
   * 将 running 片段归一化为 pending，根据终态事件或缺失终态事件把 Run/Context Graph
   * 收敛到明确状态，并恢复所有 awaiting_acceptance 的最终化流程。
   * 内部使用：实现位于 projectStoreRecovery.ts。
   */
  recoverInterruptedRuns(): void {
    return recoverInterruptedRuns(this);
  }

  /**
   * 写入或更新项目元数据键值。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  projectMeta(db: DatabaseSync, key: string, value: string): void {
    return projectMeta(this, db, key, value);
  }

  /**
   * 向数据库插入一个新的不可变来源版本及其片段。
   * 仅写入数据，不切换 catalog；调用方负责事务与 catalog 更新。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  insertSourceRevision(
    db: DatabaseSync, projectId: string, title: string, format: DocumentFormat, fileName: string,
    segments: ProjectSegment[], revisionId: string = randomUUID(),
    sourceFile?: { relativePath: string; sha256: string; size: number },
  ) {
    return insertSourceRevision(this, db, projectId, title, format, fileName, segments, revisionId, sourceFile);
  }

  /**
   * 创建项目并建立第一份不可变来源版本。
   * 项目目录、项目数据库、来源片段、Prompt revision 与 catalog 记录必须一起形成可恢复的项目；
   * 重复来源解析由 resolveProjectForSource 负责，不能依赖客户端会话缓存去重。
   */
  createProject(input: CreateProjectInput): ProjectSummary {
    return createProject(this, input);
  }

  /**
   * 为已有项目切换到新的不可变原文版本，而不是原地改写旧片段。
   * 活跃 Run/预处理会阻止版本切换；新的 revision 会重新计算稳定片段 ID 与 source hash，
   * 旧 Run、审计报告和 TranslationBrief 快照仍绑定其创建时的 revision。
   */
  createSourceRevision(
    projectId: string,
    input: Omit<CreateProjectInput, 'prompt'>,
    sourceFile?: { revisionId: string; relativePath: string; sha256: string; size: number },
  ): ProjectSummary {
    return createSourceRevision(this, projectId, input, sourceFile);
  }

  /**
   * 原始文件更新先写入不可变文件，再在 SQLite 事务中登记文件元数据并切换 current revision。
   * 事务失败会清理新文件；异常退出最多留下无引用文件，不会让 current revision 指向缺失文件。
   */
  async createSourceRevisionWithFile(
    projectId: string,
    input: Omit<CreateProjectInput, 'prompt'>,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ project: ProjectSummary; sourceFile: { saved: true; size: number; sha256: string; sourceRevisionId: string } }> {
    return createSourceRevisionWithFile(this, projectId, input, fileName, bytes);
  }

  /**
   * 原始源文不存进 SQLite，而是放在文档项目自己的目录里。
   * 内容本身不以大 blob 的形式存进任何一个 SQLite 库。每个版本按
   * 版本 UUID 生成不可变文件名；重复导入永远不会覆盖旧文件。
   */
  async storeSourceFile(projectId: string, fileName: string, bytes: Uint8Array): Promise<{ saved: true; size: number; sha256: string; sourceRevisionId: string }> {
    return storeSourceFile(this, projectId, fileName, bytes);
  }

  /**
   * 保存 Prompt 修订。相同 fingerprint 的修订会复用已有记录，避免重复写入。
   * 文学记忆不参与 Prompt fingerprint，必须通过独立接口更新。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  savePromptRevision(projectId: string, prompt: ProjectPrompt & { name?: string }): any {
    return savePromptRevision(this, projectId, prompt);
  }

  /**
   * 保存 Prompt 修订并记录 prompt.saved 事件，更新项目 updated_at。
   */
  savePrompt(projectId: string, prompt: ProjectPrompt & { name?: string }): any {
    return savePrompt(this, projectId, prompt);
  }

  /**
   * 文学记忆是独立的不可变业务资产，不应混进 Prompt fingerprint。
   * 角色画像按证据与状态维护；每个 Run 固定引用一个 memory revision，方便复现。
   * 内部使用：实现位于 projectStoreMemory.ts。
   */
  validateLiteraryMemoryAgainstProject(projectId: string, input: unknown): Record<string, any> {
    return validateLiteraryMemoryAgainstProject(this, projectId, input);
  }

  saveLiteraryMemory(projectId: string, input: unknown): any {
    return saveLiteraryMemory(this, projectId, input);
  }

  /**
   * 读取当前文学记忆 revision；兼容旧版本把记忆嵌入 Prompt 的情况，并在必要时升级为新 revision。
   */
  getCurrentLiteraryMemory(projectId: string): any {
    return getCurrentLiteraryMemory(this, projectId);
  }

  /**
   * 列出最近的文学记忆修订（最多 100 条）。
   */
  listLiteraryMemoryRevisions(projectId: string): any[] {
    return listLiteraryMemoryRevisions(this, projectId);
  }

  /**
   * 将 prompt_revisions 数据库行转换为对外返回的 Prompt 结构。
   * 内部使用：实现位于 projectStoreMemory.ts。
   */
  publicPrompt(row: any): any {
    return publicPrompt(this, row);
  }

  /**
   * 列出项目的所有 Prompt 修订，按创建时间倒序。
   */
  listPrompts(projectId: string): any[] {
    return listPrompts(this, projectId);
  }

  /**
   * 计算 Context Graph 的 fingerprint，用于文学检索版本追踪。
   * 图谱更新必须像 Prompt/记忆修订一样使已采纳输出失效；旧版数据库可能没有图谱表，此时返回 null 而不报错。
   * 内部使用：实现位于 projectStoreMemory.ts。
   */
  contextGraphFingerprint(projectId: string, sourceRevisionId: string): string | null {
    return contextGraphFingerprint(this, projectId, sourceRevisionId);
  }

  /**
   * 计算 Run 指纹，综合 Prompt、记忆、图谱、语言方向、Provider/模型与 Pipeline 版本。
   * 用于判断已有译文是否因上下文变化而过期。
   * 内部使用：实现位于 projectStoreRuns.ts。
   */
  makeRunFingerprint(
    projectId: string, sourceRevisionId: string, promptRow: any,
    config: any, literaryMemoryFingerprint: string | null,
  ): string {
    return makeRunFingerprint(this, projectId, sourceRevisionId, promptRow, config, literaryMemoryFingerprint);
  }

  /**
   * 文学预处理就绪性显式校验辅助函数，供调用方要求项目已预处理时使用。
   * 不应在 Run 创建时调用：queued 文学 Run 必须进入服务端 executeRun 门禁，由其启动预处理并持久化等待/失败事件。
   */
  assertLiteraryPreprocessingReady(
    projectId: string,
    sourceRevisionId: string,
    sourceLang: string,
    targetLang: string,
  ): void {
    return assertLiteraryPreprocessingReady(this, projectId, sourceRevisionId, sourceLang, targetLang);
  }

  /**
   * 持久化一次翻译执行计划。
   * 在返回 Run 前固定 sourceRevision、promptRevision、literaryMemoryRevision 和片段范围，
   * 同时建立 run_segments；执行 worker 只能按这份快照工作，不能在恢复时悄悄读取最新 Prompt/记忆。
   */
  createRun(projectId: string, input: CreateRunInput = {}): any {
    return createRun(this, projectId, input);
  }

  /**
   * 直接写入一条项目事件，不打印工作流日志。
   * 内部使用：实现位于 projectStoreRuns.ts。
   */
  addEvent(projectId: string, runId: string | null, type: string, payload: unknown): void {
    return addEvent(this, projectId, runId, type, payload);
  }

  /**
   * 将结构化事件写入项目事件账本，并同步输出工作流日志。
   * SQLite event 是 UI 轮询、故障排查和运行追踪的持久化事实来源；console 日志不能替代它。
   */
  appendEvent(projectId: string, runId: string | null, type: string, payload: unknown): void {
    return appendEvent(this, projectId, runId, type, payload);
  }

  /**
   * 原子保存本批次实际使用的 TranslationBrief 快照。
   * 只有 queued/running 的 Run 且 source/prompt/memory revision 全部与 Run 一致时才允许提交；
   * 返回 false 表示 Run 已离开活动状态，调用方必须丢弃该批次而非继续调用模型。
   */
  saveTranslationBriefSnapshot(projectId: string, runId: string, batchIndex: number, brief: Record<string, any>): boolean {
    return saveTranslationBriefSnapshot(this, projectId, runId, batchIndex, brief);
  }

  /**
   * 保存由初译响应产生、已由服务端核验证据的上下文增量。
   * 以批次首个来源片段作为幂等键，暂停后重新调度批次时可安全替换同批旧结果。
   */
  saveTranslationContextDelta(
    projectId: string,
    runId: string,
    batchIndex: number,
    firstSegmentId: string,
    sourceSegmentIds: string[],
    delta: Record<string, any>,
    validation: Record<string, any>,
  ): boolean {
    return saveTranslationContextDelta(this, projectId, runId, batchIndex, firstSegmentId, sourceSegmentIds, delta, validation);
  }

  /**
   * 返回按原文顺序排列的持久化增量；执行恢复时可重建每一波的只读记忆投影。
   */
  listTranslationContextDeltas(projectId: string, runId: string): any[] {
    return listTranslationContextDeltas(this, projectId, runId);
  }

  /**
   * 列出 Run 的 TranslationBrief 快照，可选包含完整内容。
   */
  listTranslationBriefSnapshots(projectId: string, runId: string, includeContent = false): any[] {
    return listTranslationBriefSnapshots(this, projectId, runId, includeContent);
  }

  /**
   * 保存质量审计报告（按 auditId 幂等更新）。
   */
  saveQualityAudit(projectId: string, report: Record<string, any>): void {
    return saveQualityAudit(this, projectId, report);
  }

  /**
   * 读取质量审计报告（未指定 auditId 时取最新）。
   */
  getQualityAudit(projectId: string, auditId?: string): any | null {
    return getQualityAudit(this, projectId, auditId);
  }

  /**
   * 保存质量对照评测（M4 A/B 映射与盲评）。
   */
  saveQualityEvaluation(projectId: string, report: Record<string, any>, blindMapping: Record<string, unknown>, blindReviews: unknown[] = []): void {
    return saveQualityEvaluation(this, projectId, report, blindMapping, blindReviews);
  }

  /**
   * 读取质量对照评测。
   */
  getQualityEvaluation(projectId: string, evaluationId: string): any | null {
    return getQualityEvaluation(this, projectId, evaluationId);
  }

  /**
   * 更新质量对照评测的盲评结果。
   */
  updateQualityEvaluationReviews(projectId: string, evaluationId: string, reviews: unknown[]): any {
    return updateQualityEvaluationReviews(this, projectId, evaluationId, reviews);
  }

  /**
   * 读取项目事件，支持按 runId/after 游标分页。
   */
  getEvents(projectId: string, runId?: string, after = 0, limit = 200, latest = false): any[] {
    return getEvents(this, projectId, runId, after, limit, latest);
  }

  /**
   * 列出项目（默认排除已归档）。
   */
  listProjects(includeArchived = false): ProjectSummary[] {
    return listProjects(this, includeArchived);
  }

  /**
   * 将解析后的文档解析到已有持久化项目，不信任扩展本地项目映射。
   * 精确 source fingerprint 可安全水合；同名/标题匹配仅作为变更候选，不得继承新文档的旧译文。
   */
  resolveProjectForSource(input: CreateProjectInput): {
    exactProject: ProjectSummary | null;
    relatedProject: ProjectSummary | null;
  } {
    return resolveProjectForSource(this, input);
  }

  /**
   * 检查导入文件是否与当前来源版本已附带的原始文件字节完全一致。
   * 用于区分解析器版本变化与真正的文档变化，不信任文件名或浏览器生成的片段指纹。
   */
  matchesStoredSourceFile(projectId: string, bytes: Uint8Array): boolean {
    return matchesStoredSourceFile(this, projectId, bytes);
  }

  /**
   * 读取项目摘要。
   */
  getProject(projectId: string): ProjectSummary | null {
    return getProject(this, projectId);
  }

  /**
   * 从 catalog 行与项目库元数据组装 ProjectSummary。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  summaryFromCatalog(row: any): ProjectSummary {
    return summaryFromCatalog(this, row);
  }

  /**
   * 返回项目、数据库实例与当前来源版本 ID 的上下文。
   */
  getProjectContext(projectId: string): any {
    return getProjectContext(this, projectId);
  }

  /**
   * 分页读取当前来源版本的片段，并附带已采纳/候选译文。
   */
  getSegments(projectId: string, options: { limit?: number; offset?: number; runId?: string } = {}): any[] {
    return getSegments(this, projectId, options);
  }

  /**
   * 返回 Run 的不可变片段成员列表，不加载原文或译文正文。
   */
  getRunSegmentIds(projectId: string, runId: string): string[] {
    return getRunSegmentIds(this, projectId, runId);
  }

  /**
   * 读取 Run 中待处理（pending/failed）的片段及其原文信息，供执行器使用。
   */
  getRunSegmentsForExecution(projectId: string, runId: string): any[] {
    return getRunSegmentsForExecution(this, projectId, runId);
  }

  /**
   * 取若干前置源文片段，用于解析对白与指代。
   * 这些行永远属于本次 Run 锁定的同一个不可变源文版本。
   * 它们只是上下文：调用方绝不能为它们创建 run_segments 或输出 id。
   */
  getPrecedingSegments(projectId: string, runId: string, firstSegmentId: string, limit = 4): any[] {
    return getPrecedingSegments(this, projectId, runId, firstSegmentId, limit);
  }

  /**
   * 读取 Run 创建时绑定的项目、Prompt 和文学记忆快照。
   * 旧 Run 缺少 memory revision 外键时只允许回退到对应旧 Prompt 中迁移的记忆，
   * 不得将当前最新的 Voice Bible 套用到历史 Run。
   */
  getRunContext(projectId: string, runId: string): any {
    return getRunContext(this, projectId, runId);
  }

  /**
   * 列出项目的翻译运行，按创建时间倒序。
   */
  listRuns(projectId: string, limit = 50): any[] {
    return listRuns(this, projectId, limit);
  }

  /**
   * 读取单个 Run 的详细信息（含片段与审校发现）。
   */
  getRun(projectId: string, runId: string): any {
    return getRun(this, projectId, runId);
  }

  /**
   * 将 translation_runs 数据库行转换为 Run 摘要，可选包含片段与审校发现。
   * 内部使用：实现位于 projectStoreRuns.ts。
   */
  runSummary(db: DatabaseSync, row: any, includeSegments = false): any {
    return runSummary(this, db, row, includeSegments);
  }

  /**
   * 读取 Run 当前状态。
   */
  getRunStatus(projectId: string, runId: string): RunStatus {
    return getRunStatus(this, projectId, runId);
  }

  /**
   * 在 SQLite 写事务中执行 Run 状态转换。
   * completed/cancelled 是不可被延迟 worker 逆转的终态；false 表示状态门拒绝本次转换，
   * 调用者必须停止后续持久化，不能把内存中的任务状态当作成功提交的依据。
   */
  setRunStatus(projectId: string, runId: string, status: RunStatus, error?: string | null): boolean {
    return setRunStatus(this, projectId, runId, status, error);
  }

  /**
   * 批量更新 Run 片段状态；running 状态会递增 attempts。
   */
  markRunSegments(projectId: string, runId: string, segmentIds: string[], status: string, error?: string | null): boolean {
    return markRunSegments(this, projectId, runId, segmentIds, status, error);
  }

  /**
   * 原子提交一个模型批次的候选译文与审校发现，仅在 Run 活动时允许。
   * 状态检查与所有写入共享 BEGIN IMMEDIATE，防止取消/暂停请求在检查与迟到写入之间交错。
   */
  saveCandidates(
    projectId: string,
    runId: string,
    items: Array<{ segmentId: string; text: string }>,
    reviewFindings: Array<{ segmentId: string; finding: any }> = [],
  ): boolean {
    return saveCandidates(this, projectId, runId, items, reviewFindings);
  }

  /**
   * 保存单条候选译文；Run 非活动时抛出 409。
   */
  saveCandidate(projectId: string, runId: string, segmentId: string, text: string): void {
    return saveCandidate(this, projectId, runId, segmentId, text);
  }

  /**
   * 保存审校发现（委托 saveCandidates，仅 findings）。
   */
  saveFindings(projectId: string, runId: string, findings: Array<{ segmentId: string; finding: any }>): boolean {
    return saveFindings(this, projectId, runId, findings);
  }

  /**
   * 仅在对应双语准确性审校返回完整结果后，标记中文单语编辑提案。
   * 最终经验证的候选替换预审提案，避免用户应用过期的中间编辑。
   */
  markChineseEditorialFindingsReviewed(
    projectId: string,
    runId: string,
    results: Array<{ segmentId: string; status: 'verified' | 'corrected' | 'reverted'; proposedTranslation: string }>,
  ): boolean {
    return markChineseEditorialFindingsReviewed(this, projectId, runId, results);
  }

  /**
   * 保存单条审校发现；Run 非活动时抛出 409。
   */
  saveFinding(projectId: string, runId: string, segmentId: string, finding: any): void {
    return saveFinding(this, projectId, runId, segmentId, finding);
  }

  /**
   * 采纳或驳回可选文风建议。采纳是显式用户决策，仅当建议仍针对当前原文时才记录新的已采纳人工译文。
   */
  setReviewFindingDisposition(
    projectId: string,
    runId: string,
    findingId: number,
    action: 'apply' | 'dismiss',
  ): any {
    return setReviewFindingDisposition(this, projectId, runId, findingId, action);
  }

  /**
   * 根据片段级状态汇总 Run 终态，而不是单凭 Promise 是否结束决定成功。
   * 未处理片段导致 paused；存在候选时进入 awaiting_acceptance；失败与已有成功结果组合为
   * partial/failed。此函数不自动采纳 candidate。
   */
  finishRun(projectId: string, runId: string): any {
    return finishRun(this, projectId, runId);
  }

  /**
   * 候选译文的唯一采纳事务边界。
   * Run 状态检查、候选选择、source hash 对齐、人工编辑保护和 accepted 标记在同一写事务中完成；
   * 允许经过验证的 Run 终结流程自动调用，但不得绕过版本及人工修订保护。
   */
  acceptCandidates(projectId: string, runId: string, segmentIds?: string[]): any {
    return acceptCandidates(this, projectId, runId, segmentIds);
  }

  /**
   * 将旧阅读器/IndexedDB 已有的译文一次性纳入项目版本库。只填充当前来源中尚无
   * accepted 译文的片段，不覆盖本机 workspace 已经版本化的人工修订或 Agent 结果。
   * 当前 Prompt 指纹作为导入基线，避免第一次切换到 workspace 后把整本旧译文全部判过期。
   */
  importAcceptedTranslations(projectId: string, items: unknown): { imported: number; skipped: number } {
    return importAcceptedTranslations(this, projectId, items);
  }

  /**
   * 保存用户手动编辑的译文，origin=manual 且自动采纳。
   */
  saveManualEdit(projectId: string, segmentId: string, text: string): any {
    return saveManualEdit(this, projectId, segmentId, text);
  }

  /**
   * 校验项目翻译完整性：缺失、旧来源、旧 Prompt 等。
   */
  verifyProject(projectId: string): any {
    return verifyProject(this, projectId);
  }

  /**
   * 归档项目（catalog 标记 archived=1）。
   */
  archiveProject(projectId: string): void {
    return archiveProject(this, projectId);
  }

  /**
   * 根据项目数据库元数据修复 catalog 行。
   * 内部使用：实现位于 projectStoreCatalog.ts。
   */
  repairCatalogRow(projectId: string): void {
    return repairCatalogRow(this, projectId);
  }
}

let sharedStore: DocumentProjectStore | null = null;

/** 进程内共享的 store 实例；首次调用时创建并完成初始化。 */
export function getDocumentProjectStore(): DocumentProjectStore {
  if (!sharedStore) {
    sharedStore = new DocumentProjectStore();
    sharedStore.initialize();
  }
  return sharedStore;
}

/** 仅测试使用：丢弃共享实例，下一次 getDocumentProjectStore 会重新初始化。 */
export function resetDocumentProjectStoreForTests(): void {
  sharedStore = null;
}
