/**
 * Context Graph 公共入口：分析、查询与批次快照分别在同目录的 contextGraph* 模块里，
 * 这里只把对外契约集中再导出，调用方不需要知道内部分了几个文件。
 */

export {
  CONTEXT_GRAPH_ANALYSIS_VERSION,
  DEFAULT_CONTEXT_GRAPH_SYSTEM_PROMPT,
  ANALYSIS_SCHEMA,
  BOOK_SCAN_INDEX_VERSION,
  persistSourceFeatureIndex,
  readSourceFeatureIndex,
  ensureSourceFeatureIndex,
} from './contextGraphSchema.ts';
export type {
  StoredSegmentFeatures,
  StoredSourceFeatureIndex,
} from './contextGraphSchema.ts';
export {
  resetChapterSummariesForReanalysis,
  clearReplaceableModelGeneratedContextGraphItems,
  contextGraphCandidateDisposition,
  selectRecentPriorChapterSummaries,
} from './contextGraphStore.ts';
export type {
  ContextGraphCandidateDisposition,
} from './contextGraphStore.ts';
export {
  getDefaultContextGraphUserPromptTemplate,
} from './contextGraphPrompts.ts';
export {
  startContextGraphAnalysis,
} from './contextGraphRun.ts';
export {
  getContextGraphStatus,
  getContextGraph,
  reviewContextGraphItems,
  reviewContextGraphItem,
} from './contextGraphQuery.ts';
export {
  buildProjectContextGraphBundle,
} from './contextGraphBundle.ts';
