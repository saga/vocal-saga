/**
 * 文学分析与审校共用的纯函数：稳定 ID、置信度归一、证据文本规范化与片段校验。
 *
 * 从 literary 抽出：两端都靠同一套「引文必须能逐字定位」的口径做事，
 * 口径分叉就会出现分析接受、审校拒绝的证据。
 */

/**
 * 根据人物规范原文名生成稳定的字符 ID（char_ + 8 位十六进制哈希）。
 * 使用 FNV-1a 32-bit 变体，对 NFKC 规范化并转小写后的名称计算；
 * 同一规范名在不同章节/运行中得到相同 ID，保证人物身份稳定。
 * @param name 人物规范原文名（canonicalSourceName）。
 * @returns 形如 `char_xxxxxxxx` 的稳定 ID。
 */
export function stableCharacterId(name: string): string {
  let value = 0x811c9dc5;
  const normalized = name.normalize('NFKC').toLocaleLowerCase();
  for (let i = 0; i < normalized.length; i++) value = Math.imul(value ^ normalized.charCodeAt(i), 0x01000193);
  return 'char_' + (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 将任意输入归一化为 [0,1] 区间的置信度分数；null/undefined/空字符串返回 null。
 * 非数字或无法转换的值返回 null，最终结果钳制到 [0,1]。
 * @param value 原始置信度（数字或可转数字字符串）。
 * @returns 有限且在 [0,1] 的数值，或 null。
 */
export function confidenceScore(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const score = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
}

/**
 * 将证据文本 NFKC 规范化、合并空白并转小写，用于原文引文的精确包含校验。
 * @param value 原始证据文本。
 * @returns 规范化后的证据文本。
 */
export function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * 审校 finding 只有在原文引文与译文引文都能在输入原文/初译中逐字定位时，
 * 才能驱动自动修订；仅凭理由或建议不构成证据。
 *
 * 审校发现只有在两段摘录都能在确切的输入源文与草稿中落地时，
 * 才能驱动自动修正。光有一个说得通的理由或建议，不算证据。
 */
export function isLiteraryReviewFindingGrounded(
  source: string,
  draft: string,
  sourceExcerpt: unknown,
  draftExcerpt: unknown,
): boolean {
  const sourceQuote = typeof sourceExcerpt === 'string' ? normalizeEvidenceText(sourceExcerpt) : '';
  const draftQuote = typeof draftExcerpt === 'string' ? normalizeEvidenceText(draftExcerpt) : '';
  return sourceQuote.length >= 2 && draftQuote.length >= 2 &&
    normalizeEvidenceText(source).includes(sourceQuote) &&
    normalizeEvidenceText(draft).includes(draftQuote);
}

/**
 * 判断中文单语编辑 finding 是否有据：targetExcerpt 必须在 draft 中可逐字定位。
 * @param draft 中文初译文本。
 * @param targetExcerpt 模型声称的中文引文。
 * @returns 引文长度 >=2 且在 draft 中可定位时返回 true。
 */
export function isChineseLiteraryFindingGrounded(draft: string, targetExcerpt: unknown): boolean {
  const quote = typeof targetExcerpt === 'string' ? normalizeEvidenceText(targetExcerpt) : '';
  return quote.length >= 2 && normalizeEvidenceText(draft).includes(quote);
}

/**
 * 校验并规范化传入的翻译/审校片段数组。
 * 边界：片段数必须在 1-max 之间；审校片段原文/译文长度上限分别为 4000/5000 字符，超出直接拒绝（不截断）；
 * 分析片段 text 截断到 900 字符。重复 ID 抛出 400 错误。
 * @param input 原始片段数组。
 * @param max 允许的最大片段数。
 * @param type 片段类型：'review' 为审校片段，其他为分析片段。
 * @returns 规范化后的片段数组。
 * @throws 片段数不合法、无有效片段或审校片段超长时抛出带 status=400 的错误。
 */
export function validateSegments(input: any, max: number, type: string) {
  if (!Array.isArray(input) || input.length < 1 || input.length > max) {
    throw Object.assign(new Error('segments 必须是 1-' + max + ' 个片段的数组'), { status: 400 });
  }
  const seen = new Set();
  const segments: any[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    if (seen.has(raw.id)) throw Object.assign(new Error('segments 包含重复 ID：' + raw.id), { status: 400 });
    seen.add(raw.id);
    if (type === 'review') {
      if (typeof raw.source !== 'string' || !raw.source.trim() || typeof raw.draft !== 'string' || !raw.draft.trim()) continue;
      if (raw.source.length > 4000 || raw.draft.length > 5000) {
        throw Object.assign(
          new Error('审校片段超过本机单片段限制（原文 4000、译文 5000 字符）；已拒绝截断输入'),
          { status: 400 },
        );
      }
      segments.push({
        id: raw.id.slice(0, 160), source: raw.source, draft: raw.draft,
        ...(typeof raw.initialDraft === 'string' && raw.initialDraft.length <= 5000
          ? { initialDraft: raw.initialDraft } : {}),
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    } else {
      if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
      segments.push({
        id: raw.id.slice(0, 160), text: raw.text.slice(0, 900),
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 30) : 'paragraph',
        contextPath: typeof raw.contextPath === 'string' ? raw.contextPath.slice(0, 160) : '',
      });
    }
  }
  if (!segments.length) throw Object.assign(new Error('没有有效的片段'), { status: 400 });
  return segments;
}
