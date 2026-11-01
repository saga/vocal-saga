/**
 * 工作流事件 → 终端日志的映射。
 *
 * 从 projectStore 抽出：这里只做「事件类型 → 中文摘要 + 级别」的翻译，
 * 不落库、不依赖存储类，因此可以独立演进事件文案。
 */
import { formatLogLine } from '../log.ts';

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

/** Print only user-actionable workflow milestones; never print full novel text or prompts. */
export function logWorkflowEvent(runId: string | null, type: string, rawPayload: unknown): void {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  const p = rawPayload && typeof rawPayload === 'object' ? rawPayload as Record<string, any> : {};
  const run = runId ? runId.slice(0, 8) : 'project';
  const batch = p.batchIndex ? '批次 ' + p.batchIndex + (p.batchCount ? '/' + p.batchCount : '') : '';
  let message = '';
  let level: 'info' | 'warn' | 'error' = 'info';
  switch (type) {
    case 'plan.ready':
      message = '执行计划就绪 · ' + (p.segmentCount ?? '?') + ' 段 / ' + (p.batchCount ?? '?') + ' 批 · 初译并发 ' + (p.translationConcurrency ?? '?') + ' · 审校并发 ' + (p.reviewConcurrency ?? 0);
      break;
    case 'run.context.ready':
      message = '运行上下文已固定 · ' + (p.provider || '?') + ' / ' + (p.model || '运行时默认模型') + ' · ' + (p.sourceLang || '?') + '→' + (p.targetLang || '?') + ' · 实体 ' + (p.memoryEntities ?? 0) + ' · 人物声音 ' + (p.characterVoices ?? 0);
      break;
    case 'batch.started':
      message = '初译开始 ' + batch + ' · ' + (Array.isArray(p.segmentIds) ? p.segmentIds.length : '?') + ' 段 · 前文 ' + (p.precedingContextCount ?? 0) + ' 段 · ' + (p.chapter || '按文档顺序');
      break;
    case 'batch.prompt.ready': {
      const mappings = Array.isArray(p.contextGraphNameMappingPreview)
        ? p.contextGraphNameMappingPreview.slice(0, 4).map((item: any) => String(item.source || '') + '→' + String(item.target || '')).join('、')
        : '';
      message = '模型调用开始 · ' + traceStage(p.stage) + ' ' + batch + ' · ' + (p.provider || '?') + ' / ' + (p.model || '运行时默认模型') +
        ' · 输入 ' + (p.sourceChars ?? '?') + ' 字符 · 上下文 ' + (p.translationBriefChars ?? 0) + ' 字符 · 规范译名 ' +
        (p.contextGraphNameMappingCount ?? 0) + (mappings ? '（' + mappings + '）' : '');
      break;
    }
    case 'batch.model.response':
      message = '模型返回 · ' + traceStage(p.stage) + ' ' + batch + ' · ' + (p.returnedSegments ?? 0) + '/' + (p.requestedSegments ?? 0) + ' 段 · ' +
        (traceDuration(p.durationMs) || '耗时未知') + (p.missingCount ? ' · 缺少 ' + p.missingCount + ' 段，将定向重试' : '');
      if (p.missingCount) level = 'warn';
      break;
    case 'translation-brief.ready':
      message = 'TranslationBrief 已组装 ' + batch + ' · ' + (p.contextChars ?? 0) + ' 字符 · 实体 ' + (p.entityCount ?? 0) +
        ' · 人物声音 ' + (p.characterVoiceCount ?? 0) + ' · 规范译名 ' + (p.nameMappingCount ?? 0);
      break;
    case 'review.context.ready':
      message = '审校上下文就绪 ' + batch + ' · 原文 ' + (p.segmentCount ?? 0) + ' 段 · 注入实体 ' + (p.injectedEntities ?? 0) +
        ' · 人物声音 ' + (p.injectedCharacterVoices ?? 0) + ' · 锚点 ' + (p.injectedVoiceAnchors ?? 0);
      break;
    case 'batch.translation.completed':
      message = '初译候选已保存 ' + batch + ' · ' + (p.candidateCount ?? 0) + ' 段' +
        (Array.isArray(p.failedIds) && p.failedIds.length ? ' · 未完成 ' + p.failedIds.length + ' 段' : '') +
        ' · 审校' + (p.reviewScheduled ? '已排队' : '未启用');
      if (Array.isArray(p.failedIds) && p.failedIds.length) level = 'warn';
      break;
    case 'batch.completed':
      message = '批次流程结束 ' + batch + ' · 候选 ' + (p.candidateCount ?? 0) + ' 段 · 未完成 ' + (Array.isArray(p.failedIds) ? p.failedIds.length : 0) + ' 段';
      if (Array.isArray(p.failedIds) && p.failedIds.length) level = 'warn';
      break;
    case 'run.finished': {
      const counts = p.counts && typeof p.counts === 'object' ? p.counts : {};
      message = '运行结束 · 状态 ' + (p.status || '未知') + ' · 候选 ' + (counts.candidate ?? 0) +
        ' · 已接受 ' + (counts.accepted ?? 0) + ' · 未完成 ' + (counts.failed ?? 0) + (p.error ? ' · ' + String(p.error).slice(0, 200) : '');
      if (p.status === 'failed' || p.status === 'partial') level = 'warn';
      break;
    }
    case 'stage.started':
      message = String(p.label || traceStage(p.stage)) + '开始 ' + batch;
      break;
    case 'stage.completed':
      message = String(p.label || traceStage(p.stage)) + '完成 ' + batch +
        (p.durationMs != null ? ' · ' + traceDuration(p.durationMs) : '') +
        (p.findingCount != null ? ' · 发现 ' + p.findingCount + ' 项' : '') +
        (p.revisedCount != null ? ' · 修订候选 ' + p.revisedCount + ' 段' : '') +
        (p.styleFindingCount != null ? ' · 文风建议 ' + p.styleFindingCount + ' 项' : '');
      break;
    case 'stage.warning':
      message = traceStage(p.stage) + '告警 ' + batch + ' · ' + String(p.warning || p.error || '阶段未完整执行').replace(/\s+/g, ' ').slice(0, 220);
      level = 'warn';
      break;
    case 'batch.partial':
      message = '批次响应不完整 ' + batch + ' · 第 ' + (p.attempt ?? '?') + ' 次 · 缺少 ' +
        (Array.isArray(p.missingIds) ? p.missingIds.length : 0) + ' 段，开始定向重试';
      level = 'warn';
      break;
    case 'batch.output.validation':
      message = '输出结构校验 ' + batch + ' · 重复 ID ' + (p.duplicateCount ?? 0) + ' · 未知 ID ' + (p.unexpectedCount ?? 0) + ' · 格式错误 ' + (p.malformedRowCount ?? 0);
      level = 'warn';
      break;
    case 'model.call.failed':
      message = '模型调用失败 · ' + traceStage(p.stage) + ' ' + batch + ' · ' + String(p.error || '未知错误').replace(/\s+/g, ' ').slice(0, 240);
      level = 'error';
      break;
    case 'batch.discarded':
      message = '批次被丢弃 ' + batch + ' · ' + String(p.reason || p.error || '未说明原因').replace(/\s+/g, ' ').slice(0, 240);
      level = 'warn';
      break;
    case 'review.audit.failed':
      message = '审校失败 · ' + traceStage(p.stage) + ' ' + batch + ' · ' +
        String(p.error || p.reason || '未知错误').replace(/\s+/g, ' ').slice(0, 240) +
        '（保留初译，不阻塞运行）';
      level = 'warn';
      break;
    case 'review.discarded':
      message = '审校结果被丢弃 ' + batch + ' · ' + String(p.reason || p.error || '未说明原因').replace(/\s+/g, ' ').slice(0, 240);
      level = 'warn';
      break;
    case 'translation.context-delta.discarded':
      message = '上下文增量被丢弃 ' + batch + ' · ' + String(p.reason || p.error || '未说明原因').replace(/\s+/g, ' ').slice(0, 240);
      level = 'warn';
      break;
    case 'run.start-discarded':
      message = '运行未启动即被丢弃 · ' + String(p.reason || '运行已进入终态');
      level = 'warn';
      break;
    case 'run.failed':
      message = '运行失败 · ' + String(p.error || '未知错误').replace(/\s+/g, ' ').slice(0, 240);
      level = 'error';
      break;
    case 'literary-memory.saved': {
      const profiles = Array.isArray(p.characterProfiles) ? p.characterProfiles : [];
      const kings = profiles.filter((profile: any) =>
        /\b(?:the\s+)?king\b/iu.test(String(profile.canonicalSourceName || '')) ||
        (Array.isArray(profile.aliases) && profile.aliases.some((alias: unknown) => /\b(?:the\s+)?king\b/iu.test(String(alias)))));
      message = '文学记忆已保存 · 实体 ' + (p.entityCount ?? '?') +
        ' · 人物声音 ' + (p.characterCount ?? '?') +
        '（确认 ' + (p.confirmedCharacterCount ?? '?') + ' / 候选 ' + (p.candidateCharacterCount ?? '?') + ' / 拒绝 ' + (p.rejectedCharacterCount ?? '?') + '）' +
        (kings.length ? ' · King画像 ' + kings.map((profile: any) =>
          String(profile.canonicalSourceName || '?') + ':' + String(profile.status || '?')).join('、')
          : ' · 未保存 King/the King 声音画像');
      if (!kings.length) level = 'warn';
      break;
    }
    case 'context-graph.phase':
      message = '全书预处理 · ' + traceStage(p.phase) + ' · ' +
        (p.sampleCount != null ? '样本 ' + p.sampleCount + ' 段' : (p.segmentCount ?? '?') + ' 段原文') +
        (p.sourceLang ? ' · ' + p.sourceLang + '→' + (p.targetLang || '?') : '') +
        (p.model ? ' · ' + (p.provider || '?') + ' / ' + p.model : '');
      break;
    case 'context-graph.scan.completed':
      message = '全书扫描完成 · ' + (p.segmentCount ?? '?') + ' 段 / ' + (p.chapterCount ?? '?') + ' 章 · 名称候选 ' +
        (p.nameCandidateCount ?? 0) + ' · 抽样 ' + (p.sampleCount ?? 0) + ' 段';
      break;
    case 'context-graph.output-audit': {
      const raw = p.rawCounts && typeof p.rawCounts === 'object' ? p.rawCounts : {};
      const saved = p.persistedCounts && typeof p.persistedCounts === 'object' ? p.persistedCounts : {};
      const evidence = p.evidenceValidation && typeof p.evidenceValidation === 'object' ? p.evidenceValidation : {};
      const coverage = Array.isArray(p.candidateCoverage) ? p.candidateCoverage : [];
      const gaps = coverage.filter((item: any) =>
        Number(item.mentions) >= 20 && Number(item.chapterCount) >= 3 && !item.returnedAsCharacter)
        .slice(0, 4).map((item: any) => String(item.name || '') + '（' + item.mentions + ' 次）').filter(Boolean);
      const dropped = Array.isArray(p.modelCharacters) ? p.modelCharacters
        .filter((item: any) => item.disposition === 'dropped-no-valid-evidence')
        .slice(0, 4).map((item: any) => {
          const reasons = Object.entries(item.invalidEvidenceReasons || {})
            .map(([reason, count]) => reason + ':' + String(count)).join(',');
          return String(item.name || '<无名>') + (reasons ? ' [' + reasons + ']' : '');
        }) : [];
      const reasons = evidence.byReason && typeof evidence.byReason === 'object'
        ? Object.entries(evidence.byReason).map(([reason, count]) => reason + ':' + String(count)).join('、')
        : '';
      message = '模型输出与证据校验 · 原始人物 ' + (raw.characters ?? '?') + ' / 保存人物 ' + (saved.characters ?? '?') +
        ' · 原始实体 ' + (raw.entities ?? '?') + ' / 保存实体 ' + (saved.entities ?? '?') +
        ' · 无效证据 ' + (evidence.invalidEvidenceCount ?? '?') +
        (reasons ? '（' + reasons + '）' : '') +
        (gaps.length ? ' · 高频名称未列为人物：' + gaps.join('、') : '') +
        (dropped.length ? ' · 因证据被丢弃：' + dropped.join('；') : '');
      if (Number(evidence.invalidEvidenceCount) > 0 || gaps.length || dropped.length) level = 'warn';
      break;
    }
    case 'context-graph.completed':
      message = '全书预处理完成 · 人物 ' + (p.characterCount ?? 0) + ' · 实体 ' + (p.entityCount ?? 0) + ' · 关系 ' +
        (p.relationshipCount ?? 0) + ' · 规范译名 ' + (p.canonicalNameMappingCount ?? 0) + ' · 无效证据 ' + (p.invalidEvidenceCount ?? 0);
      break;
    case 'context-graph.failed':
      message = '全书预处理失败 · ' + String(p.error || '未知错误').replace(/\s+/g, ' ').slice(0, 240);
      level = 'error';
      break;
    default:
      // 兜底：新增的失败类事件类型也必须出现在终端。
      // 之前只给已知类型写文案，新增事件（如 batch.discarded）会掉进这里被静默丢弃，
      // 于是「批次没了、Run 却还在跑」这类问题在日志里完全看不出来。
      if (/(?:failed|discarded|error|timeout)$/i.test(type)) {
        message = type + ' · ' + String(p.error || p.reason || JSON.stringify(p)).replace(/\s+/g, ' ').slice(0, 240);
        level = 'warn';
        break;
      }
      return;
  }
  if (!message) return;
  const line = formatLogLine('agent', 'run=' + run + ' ' + message);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
