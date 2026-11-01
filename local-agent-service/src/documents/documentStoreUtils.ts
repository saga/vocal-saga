/**
 * 文档项目存储层的纯工具函数：时间戳、哈希、入参校验、片段指纹。
 *
 * 从 projectStore 抽出，保持无状态（除进程内单调时间戳外），便于单独测试。
 */
import { createHash } from 'node:crypto';
import type { DocumentFormat, ProjectSegment } from './documentStrategy.ts';

/**
 * 面向用户的「有片段未完成」提示文案。
 * 措辞刻意强调「不代表质量不合格」——部分未完成常被误读成翻译失败，导致用户丢弃可用的译文。
 */
export function formatFailedSegmentSummary(count: number): string {
  return `本次运行有 ${count} 个片段未能完成，已生成的译文已保留。这不代表译文质量不合格；请查看“未完成片段详情”了解原因，需要时可只重试这些片段。`;
}

/**
 * 进程内单调递增的时间戳。
 *
 * 所有「哪一条更新」的判断都比 created_at / accepted_at，而这些列是毫秒精度的。
 * 同一毫秒内写入的两条记录会打平，比较时旧记录可能压过新记录
 * （典型场景：Agent 候选与人工修订在同一个 tick 内落库）。
 * 这里保证同一进程内不会产生相同的时间戳。
 *
 * 跨进程仍可能打平（本机服务与 CLI 可能同时打开同一个项目库），
 * 因此 acceptCandidates 另用插入顺序（rowid）作为判据。
 */
let lastStampMs = 0;
/** 见上方注释：同进程内保证严格递增，跨进程仍可能打平。 */
export function isoNow(): string {
  const now = Math.max(Date.now(), lastStampMs + 1);
  lastStampMs = now;
  return new Date(now).toISOString();
}
/** SHA-256 十六进制摘要，用于内容指纹与去重键。 */
export function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/**
 * 解析 SQLite 中以文本存放的 JSON 列。非字符串或解析失败一律返回 fallback，
 * 不抛错——历史数据里存在写入中断留下的半截 JSON，读取侧必须能容忍。
 */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
/** 归一化文件格式：容忍大写与前导点（`.EPUB` → epub）；不在白名单内直接 400，不做猜测。 */
export function normalizeFormat(value: string): DocumentFormat {
  const format = value.toLowerCase().replace(/^\./, '');
  if (['epub', 'pdf', 'txt', 'md', 'html', 'docx', 'srt', 'vtt', 'json'].includes(format)) return format as DocumentFormat;
  throw Object.assign(new Error('不支持的文档格式：' + value), { status: 400 });
}
/**
 * 校验并规整上传的片段数组，语义是「宽进严出」：
 *
 * - 结构不合法的单项（无 id / 无 text）**跳过**而不是整体报错——解析器对个别畸形段落的容错不该拖垮整本书；
 * - 重复 id **报错**：id 是回指原文的主键，重复会让候选与审校结果挂到错误的段落上；
 * - 超长字段按上限截断（id 200 / contextPath 500 / path 1000 等），避免异常长串写爆库；
 * - 全部被过滤掉时也报错，因为「零个片段」通常意味着上游解析失败，继续落库只会留下空项目。
 */
export function validateSegments(input: unknown): ProjectSegment[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100_000) {
    throw Object.assign(new Error('segments 必须是 1-100000 个片段的数组'), { status: 400 });
  }
  const seen = new Set<string>();
  const result: ProjectSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string') continue;
    const id = item.id.trim().slice(0, 200);
    if (seen.has(id)) throw Object.assign(new Error('segments 包含重复 ID：' + id), { status: 400 });
    seen.add(id);
    result.push({
      id,
      text: item.text,
      kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'paragraph',
      contextPath: typeof item.contextPath === 'string' ? item.contextPath.slice(0, 500) : '',
      page: Number.isFinite(item.page) ? Number(item.page) : null,
      ...(Number.isFinite(item.level) ? { level: Number(item.level) } : {}),
      ...(typeof item.marker === 'string' ? { marker: item.marker.slice(0, 80) } : {}),
      ...(typeof item.path === 'string' ? { path: item.path.slice(0, 1000) } : {}),
      ...(typeof item.start === 'string' ? { start: item.start.slice(0, 40) } : {}),
      ...(typeof item.end === 'string' ? { end: item.end.slice(0, 40) } : {}),
    });
  }
  if (!result.length) throw Object.assign(new Error('没有可持久化的文档片段'), { status: 400 });
  return result;
}

/**
 * 单段内容指纹。
 *
 * **字段顺序即协议**：数组元素顺序决定哈希值。调整顺序、增删字段都会让所有已存指纹失效，
 * 表现为「源文没改却被判定为已变更」而触发全量重译。改这里前先确认指纹的消费方
 * 能接受一次性的全量失效。
 *
 * 只覆盖影响译文的内容属性，不含 id 与 ordinal——段落搬家不该算内容变更。
 */
export function segmentHash(segment: ProjectSegment): string {
  return hash(JSON.stringify([segment.text, segment.kind || 'paragraph', segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? '', segment.path ?? '', segment.start ?? '', segment.end ?? '']));
}
/**
 * 全书源文指纹：由「id + 单段指纹」按序拼接而成。
 * 用于判断源文是否与上次运行时一致；顺序敏感，段落重排也会被视为变更。
 */
export function sourceFingerprint(segments: ProjectSegment[]): string {
  return hash(JSON.stringify(segments.map((segment) => [segment.id, segmentHash(segment)])));
}
