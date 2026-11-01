/**
 * 质量审计的公共底座：审计上限常量、文本归一化、名称包含判断、finding 稳定 id。
 *
 * 从 qualityAudit 抽出：几乎每类审计都要用这几个函数，但它们不依赖任何审计规则，
 * 单独成模块后各类检查可以按类别拆分而不用互相导入。
 */


export const MAX_REPEATED_EXPRESSION_GROUPS = 300;

export const MAX_REPEATED_EXPRESSION_LOCATIONS_PER_FINDING = 500;

export const MAX_BULK_REPAIR_SEGMENTS = 100;

/**
 * 抛出带 HTTP 状态码的错误，用于 API/业务校验失败时中断流程。
 */
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

/**
 * 将输入标准化为 NFKC 归一化、小写、空格折叠后的字符串，用于文本比较。
 */
export function normalized(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 在 normalized 基础上移除非字母数字字符，得到适合短语匹配的字符串。
 */
export function normalizedPhrase(value: unknown): string {
  return normalized(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 判断源文本中是否包含指定名称（拉丁语系按词边界，其他按子串）。
 */
export function containsName(source: string, name: string): boolean {
  const candidate = normalized(name);
  if (!candidate) return false;
  if (/^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(candidate)) {
    const haystack = ' ' + normalized(source).replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim() + ' ';
    const needle = candidate.replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim();
    return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
  }
  return Array.from(candidate).length >= 2 && normalized(source).includes(candidate);
}

/**
 * 判断译文中是否出现了目标术语/名称（拉丁语系按词边界，其他按归一化子串）。
 */
export function targetPresent(translation: string, target: string): boolean {
  const latinTarget = /^[\p{Script=Latin}\p{M}\p{N} ._'’-]+$/u.test(target);
  if (latinTarget) {
    const haystack = ' ' + normalized(translation).replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim() + ' ';
    const needle = target.replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ').trim();
    return !needle || haystack.includes(' ' + needle + ' ');
  }
  const needle = normalizedPhrase(target).replace(/\s+/g, '');
  if (!needle) return true;
  const haystack = normalizedPhrase(translation).replace(/\s+/g, '');
  return haystack.includes(needle);
}

/**
 * 基于类型、ID 与详情生成稳定的 findingId（FNV-1a 32 位哈希）。
 */
export function stableFindingId(type: string, ids: string[], detail: string): string {
  let hash = 0x811c9dc5;
  const input = type + ':' + ids.join(',') + ':' + detail;
  for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193);
  return 'qf_' + (hash >>> 0).toString(16).padStart(8, '0');
}
