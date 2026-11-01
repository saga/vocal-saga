/**
 * 文档项目存储层的纯工具函数：时间戳、哈希、入参校验、片段指纹。
 *
 * 从 projectStore 抽出，保持无状态（除进程内单调时间戳外），便于单独测试。
 */
import { createHash } from 'node:crypto';
import type { DocumentFormat, ProjectSegment } from './documentStrategy.ts';

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
export function isoNow(): string {
  const now = Math.max(Date.now(), lastStampMs + 1);
  lastStampMs = now;
  return new Date(now).toISOString();
}
export function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
export function normalizeFormat(value: string): DocumentFormat {
  const format = value.toLowerCase().replace(/^\./, '');
  if (['epub', 'pdf', 'txt', 'md', 'html', 'docx', 'srt', 'vtt', 'json'].includes(format)) return format as DocumentFormat;
  throw Object.assign(new Error('不支持的文档格式：' + value), { status: 400 });
}
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

export function segmentHash(segment: ProjectSegment): string {
  return hash(JSON.stringify([segment.text, segment.kind || 'paragraph', segment.contextPath || '', segment.page ?? null, segment.level ?? null, segment.marker ?? '', segment.path ?? '', segment.start ?? '', segment.end ?? '']));
}
export function sourceFingerprint(segments: ProjectSegment[]): string {
  return hash(JSON.stringify(segments.map((segment) => [segment.id, segmentHash(segment)])));
}
