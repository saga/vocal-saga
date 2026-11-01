/**
 * 工作流事件 → 终端日志的映射。
 *
 * 从 projectStore 抽出：这里只做「事件类型 → 中文摘要 + 级别」的翻译，
 * 不落库、不依赖存储类，因此可以独立演进事件文案。
 *
 * 事件文案放在注册表里而不是 switch：新增事件只加一条，不需要改分发逻辑，
 * 也不会因为漏写分支而让新事件被静默丢弃。
 */
import { formatLogLine } from '../log.ts';

type LogLevel = 'info' | 'warn' | 'error';
type EventPayload = Record<string, any>;
type LogEntry = { message: string; level?: LogLevel };
type EventFormatter = (payload: EventPayload, ctx: { batch: string }) => LogEntry;

function traceDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms >= 60000 ? Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's' : (ms / 1000).toFixed(1) + 's';
}

function traceStage(value: unknown): string {
  switch (String(value || '')) {
    case 'translate': return '初译';
    case 'review': return '准确性/术语审校';
    case 'style-review': return '人物声音/文风审校';
    case 'validate': return '结果校验';
    case 'sample': return '全书扫描';
    case 'model-analysis': return '全书人物与译名分析';
    default: return String(value || 'Agent');
  }
}

/** 单行摘要：所有自由文本字段都压成一行并截断，避免把整段原文刷进终端。 */
function oneLine(value: unknown, max: number, fallback: string): string {
  return String(value || fallback).replace(/\s+/g, ' ').slice(0, max);
}

const warn = (message: string): LogEntry => ({ message, level: 'warn' });
const failed = (message: string): LogEntry => ({ message, level: 'error' });

const EVENT_FORMATTERS: Record<string, EventFormatter> = {
  // ——— 计划与 Run 生命周期 ———
  'plan.ready': (p) => ({
    message: '执行计划就绪 · ' + (p.segmentCount ?? '?') + ' 段 / ' + (p.batchCount ?? '?') + ' 批 · 初译并发 ' +
      (p.translationConcurrency ?? '?') + ' · 审校并发 ' + (p.reviewConcurrency ?? 0),
  }),
  'run.context.ready': (p) => ({
    message: '运行上下文已固定 · ' + (p.provider || '?') + ' / ' + (p.model || '运行时默认模型') + ' · ' +
      (p.sourceLang || '?') + '→' + (p.targetLang || '?') + ' · 实体 ' + (p.memoryEntities ?? 0) +
      ' · 人物声音 ' + (p.characterVoices ?? 0),
  }),
  'run.finished': (p) => {
    const counts = p.counts && typeof p.counts === 'object' ? p.counts : {};
    const entry: LogEntry = {
      message: '运行结束 · 状态 ' + (p.status || '未知') + ' · 候选 ' + (counts.candidate ?? 0) +
        ' · 已接受 ' + (counts.accepted ?? 0) + ' · 未完成 ' + (counts.failed ?? 0) +
        (p.error ? ' · ' + String(p.error).slice(0, 200) : ''),
    };
    if (p.status === 'failed' || p.status === 'partial') entry.level = 'warn';
    return entry;
  },
  'run.start-discarded': (p) => warn('运行未启动即被丢弃 · ' + String(p.reason || '运行已进入终态')),
  'run.failed': (p) => failed('运行失败 · ' + oneLine(p.error, 240, '未知错误')),

  // ——— 批次初译 ———
  'batch.started': (p, ctx) => ({
    message: '初译开始 ' + ctx.batch + ' · ' + (Array.isArray(p.segmentIds) ? p.segmentIds.length : '?') +
      ' 段 · 前文 ' + (p.precedingContextCount ?? 0) + ' 段 · ' + (p.chapter || '按文档顺序'),
  }),
  'batch.prompt.ready': (p, ctx) => {
    const mappings = Array.isArray(p.contextGraphNameMappingPreview)
      ? p.contextGraphNameMappingPreview.slice(0, 4).map((item: any) => String(item.source || '') + '→' + String(item.target || '')).join('、')
      : '';
    return {
      message: '模型调用开始 · ' + traceStage(p.stage) + ' ' + ctx.batch + ' · ' + (p.provider || '?') + ' / ' +
        (p.model || '运行时默认模型') + ' · 输入 ' + (p.sourceChars ?? '?') + ' 字符 · 上下文 ' +
        (p.translationBriefChars ?? 0) + ' 字符 · 规范译名 ' + (p.contextGraphNameMappingCount ?? 0) +
        (mappings ? '（' + mappings + '）' : ''),
    };
  },
  'batch.model.response': (p, ctx) => {
    const entry: LogEntry = {
      message: '模型返回 · ' + traceStage(p.stage) + ' ' + ctx.batch + ' · ' + (p.returnedSegments ?? 0) + '/' +
        (p.requestedSegments ?? 0) + ' 段 · ' + (traceDuration(p.durationMs) || '耗时未知') +
        (p.missingCount ? ' · 缺少 ' + p.missingCount + ' 段，将定向重试' : ''),
    };
    if (p.missingCount) entry.level = 'warn';
    return entry;
  },
  'batch.translation.completed': (p, ctx) => {
    const failedIds = Array.isArray(p.failedIds) ? p.failedIds : [];
    const entry: LogEntry = {
      message: '初译候选已保存 ' + ctx.batch + ' · ' + (p.candidateCount ?? 0) + ' 段' +
        (failedIds.length ? ' · 未完成 ' + failedIds.length + ' 段' : '') +
        ' · 审校' + (p.reviewScheduled ? '已排队' : '未启用'),
    };
    if (failedIds.length) entry.level = 'warn';
    return entry;
  },
  'batch.completed': (p, ctx) => {
    const failedIds = Array.isArray(p.failedIds) ? p.failedIds : [];
    const entry: LogEntry = {
      message: '批次流程结束 ' + ctx.batch + ' · 候选 ' + (p.candidateCount ?? 0) + ' 段 · 未完成 ' + failedIds.length + ' 段',
    };
    if (failedIds.length) entry.level = 'warn';
    return entry;
  },
  'batch.partial': (p, ctx) => warn('批次响应不完整 ' + ctx.batch + ' · 第 ' + (p.attempt ?? '?') + ' 次 · 缺少 ' +
    (Array.isArray(p.missingIds) ? p.missingIds.length : 0) + ' 段，开始定向重试'),
  'batch.output.validation': (p, ctx) => warn('输出结构校验 ' + ctx.batch + ' · 重复 ID ' + (p.duplicateCount ?? 0) +
    ' · 未知 ID ' + (p.unexpectedCount ?? 0) + ' · 格式错误 ' + (p.malformedRowCount ?? 0)),
  'batch.discarded': (p, ctx) => warn('批次被丢弃 ' + ctx.batch + ' · ' + oneLine(p.reason || p.error, 240, '未说明原因')),

  // ——— 阶段与模型调用 ———
  'stage.started': (p, ctx) => ({ message: String(p.label || traceStage(p.stage)) + '开始 ' + ctx.batch }),
  'stage.completed': (p, ctx) => ({
    message: String(p.label || traceStage(p.stage)) + '完成 ' + ctx.batch +
      (p.durationMs != null ? ' · ' + traceDuration(p.durationMs) : '') +
      (p.findingCount != null ? ' · 发现 ' + p.findingCount + ' 项' : '') +
      (p.revisedCount != null ? ' · 修订候选 ' + p.revisedCount + ' 段' : '') +
      (p.styleFindingCount != null ? ' · 文风建议 ' + p.styleFindingCount + ' 项' : ''),
  }),
  'stage.warning': (p, ctx) => warn(traceStage(p.stage) + '告警 ' + ctx.batch + ' · ' +
    oneLine(p.warning || p.error, 220, '阶段未完整执行')),
  'model.call.failed': (p, ctx) => failed('模型调用失败 · ' + traceStage(p.stage) + ' ' + ctx.batch + ' · ' +
    oneLine(p.error, 240, '未知错误')),
  'review.audit.failed': (p, ctx) => warn('审校失败 · ' + traceStage(p.stage) + ' ' + ctx.batch + ' · ' +
    oneLine(p.error || p.reason, 240, '未知错误') + '（保留初译，不阻塞运行）'),
  'review.discarded': (p, ctx) => warn('审校结果被丢弃 ' + ctx.batch + ' · ' +
    oneLine(p.reason || p.error, 240, '未说明原因')),
  'translation.context-delta.discarded': (p, ctx) => warn('上下文增量被丢弃 ' + ctx.batch + ' · ' +
    oneLine(p.reason || p.error, 240, '未说明原因')),

  // ——— 上下文装配 ———
  'translation-brief.ready': (p, ctx) => ({
    message: 'TranslationBrief 已组装 ' + ctx.batch + ' · ' + (p.contextChars ?? 0) + ' 字符 · 实体 ' +
      (p.entityCount ?? 0) + ' · 人物声音 ' + (p.characterVoiceCount ?? 0) + ' · 规范译名 ' + (p.nameMappingCount ?? 0),
  }),
  'review.context.ready': (p, ctx) => ({
    message: '审校上下文就绪 ' + ctx.batch + ' · 原文 ' + (p.segmentCount ?? 0) + ' 段 · 注入实体 ' +
      (p.injectedEntities ?? 0) + ' · 人物声音 ' + (p.injectedCharacterVoices ?? 0) + ' · 锚点 ' + (p.injectedVoiceAnchors ?? 0),
  }),

  // ——— 文学记忆 ———
  'literary-memory.saved': (p) => {
    const profiles = Array.isArray(p.characterProfiles) ? p.characterProfiles : [];
    const kings = profiles.filter((profile: any) =>
      /\b(?:the\s+)?king\b/iu.test(String(profile.canonicalSourceName || '')) ||
      (Array.isArray(profile.aliases) && profile.aliases.some((alias: unknown) => /\b(?:the\s+)?king\b/iu.test(String(alias)))));
    const entry: LogEntry = {
      message: '文学记忆已保存 · 实体 ' + (p.entityCount ?? '?') +
        ' · 人物声音 ' + (p.characterCount ?? '?') +
        '（确认 ' + (p.confirmedCharacterCount ?? '?') + ' / 候选 ' + (p.candidateCharacterCount ?? '?') +
        ' / 拒绝 ' + (p.rejectedCharacterCount ?? '?') + '）' +
        (kings.length ? ' · King画像 ' + kings.map((profile: any) =>
          String(profile.canonicalSourceName || '?') + ':' + String(profile.status || '?')).join('、')
          : ' · 未保存 King/the King 声音画像'),
    };
    if (!kings.length) entry.level = 'warn';
    return entry;
  },

  // ——— 全书预处理 ———
  'context-graph.phase': (p) => ({
    message: '全书预处理 · ' + traceStage(p.phase) + ' · ' +
      (p.sampleCount != null ? '样本 ' + p.sampleCount + ' 段' : (p.segmentCount ?? '?') + ' 段原文') +
      (p.sourceLang ? ' · ' + p.sourceLang + '→' + (p.targetLang || '?') : '') +
      (p.model ? ' · ' + (p.provider || '?') + ' / ' + p.model : ''),
  }),
  'context-graph.scan.completed': (p) => ({
    message: '全书扫描完成 · ' + (p.segmentCount ?? '?') + ' 段 / ' + (p.chapterCount ?? '?') + ' 章 · 名称候选 ' +
      (p.nameCandidateCount ?? 0) + ' · 抽样 ' + (p.sampleCount ?? 0) + ' 段',
  }),
  'context-graph.output-audit': (p) => {
    const raw = p.rawCounts && typeof p.rawCounts === 'object' ? p.rawCounts : {};
    const saved = p.persistedCounts && typeof p.persistedCounts === 'object' ? p.persistedCounts : {};
    const evidence = p.evidenceValidation && typeof p.evidenceValidation === 'object' ? p.evidenceValidation : {};
    const gaps = describeCharacterCoverageGaps(p.candidateCoverage);
    const dropped = describeDroppedCharacters(p.modelCharacters);
    const reasons = evidence.byReason && typeof evidence.byReason === 'object'
      ? Object.entries(evidence.byReason).map(([reason, count]) => reason + ':' + String(count)).join('、')
      : '';
    const entry: LogEntry = {
      message: '模型输出与证据校验 · 原始人物 ' + (raw.characters ?? '?') + ' / 保存人物 ' + (saved.characters ?? '?') +
        ' · 原始实体 ' + (raw.entities ?? '?') + ' / 保存实体 ' + (saved.entities ?? '?') +
        ' · 无效证据 ' + (evidence.invalidEvidenceCount ?? '?') +
        (reasons ? '（' + reasons + '）' : '') +
        (gaps.length ? ' · 高频名称未列为人物：' + gaps.join('、') : '') +
        (dropped.length ? ' · 因证据被丢弃：' + dropped.join('；') : ''),
    };
    if (Number(evidence.invalidEvidenceCount) > 0 || gaps.length || dropped.length) entry.level = 'warn';
    return entry;
  },
  'context-graph.completed': (p) => ({
    message: '全书预处理完成 · 人物 ' + (p.characterCount ?? 0) + ' · 实体 ' + (p.entityCount ?? 0) + ' · 关系 ' +
      (p.relationshipCount ?? 0) + ' · 规范译名 ' + (p.canonicalNameMappingCount ?? 0) +
      ' · 无效证据 ' + (p.invalidEvidenceCount ?? 0),
  }),
  'context-graph.failed': (p) => failed('全书预处理失败 · ' + oneLine(p.error, 240, '未知错误')),
};

/** 高频但未被模型列为人物：这是全书分析漏人的主要信号。 */
function describeCharacterCoverageGaps(coverageRaw: unknown): string[] {
  const coverage = Array.isArray(coverageRaw) ? coverageRaw : [];
  return coverage
    .filter((item: any) => Number(item.mentions) >= 20 && Number(item.chapterCount) >= 3 && !item.returnedAsCharacter)
    .slice(0, 4)
    .map((item: any) => String(item.name || '') + '（' + item.mentions + ' 次）')
    .filter(Boolean);
}

/** 因证据校验不通过而被丢弃的人物，附上各自的失败原因计数。 */
function describeDroppedCharacters(charactersRaw: unknown): string[] {
  if (!Array.isArray(charactersRaw)) return [];
  return charactersRaw
    .filter((item: any) => item.disposition === 'dropped-no-valid-evidence')
    .slice(0, 4)
    .map((item: any) => {
      const reasons = Object.entries(item.invalidEvidenceReasons || {})
        .map(([reason, count]) => reason + ':' + String(count)).join(',');
      return String(item.name || '<无名>') + (reasons ? ' [' + reasons + ']' : '');
    });
}

/** 只打印用户能据此采取行动的工作流里程碑；绝不打印整本小说正文或提示词。 */
export function logWorkflowEvent(runId: string | null, type: string, rawPayload: unknown): void {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload as EventPayload : {};
  const run = runId ? runId.slice(0, 8) : 'project';
  const batch = payload.batchIndex
    ? '批次 ' + payload.batchIndex + (payload.batchCount ? '/' + payload.batchCount : '')
    : '';
  const entry = resolveLogEntry(type, payload, batch);
  if (!entry) return;
  const line = formatLogLine('agent', 'run=' + run + ' ' + entry.message);
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.info(line);
}

/**
 * 查表，并保留兜底：未登记的失败类事件也必须出现在终端。
 * 之前只给已知类型写文案，新增事件会掉进兜底被静默丢弃，
 * 于是「批次没了、Run 却还在跑」这类问题在日志里完全看不出来。
 */
function resolveLogEntry(type: string, payload: EventPayload, batch: string): LogEntry | null {
  const formatter = EVENT_FORMATTERS[type];
  if (formatter) return formatter(payload, { batch });
  if (/(?:failed|discarded|error|timeout)$/i.test(type)) {
    return warn(type + ' · ' + oneLine(payload.error || payload.reason || JSON.stringify(payload), 240, ''));
  }
  return null;
}
