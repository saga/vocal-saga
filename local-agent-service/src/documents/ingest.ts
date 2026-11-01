/**
 * Local-only document ingestion. The extension is deliberately not involved in file parsing.
 * Supports text EPUB, DOCX, UTF-8/UTF-16 text, Markdown, HTML and text-layer PDFs.
 */
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { MAX_DOCUMENT_SOURCE_BYTES, type DocumentFormat, type ProjectSegment } from './projectStore.ts';

const configuredExpandedLimitMb = Number.parseInt(process.env.LOCAL_AGENT_MAX_DOCUMENT_EXPANDED_MB || '1024', 10);
const MAX_EXPANDED_BYTES =
  (Number.isFinite(configuredExpandedLimitMb) && configuredExpandedLimitMb >= 80 ? configuredExpandedLimitMb : 1024) * 1024 * 1024;
const MAX_SEGMENTS = 100_000;
const PDF_EXTRACTION_TIMEOUT_MS = Math.max(20_000, Number.parseInt(process.env.LOCAL_AGENT_PDF_TIMEOUT_MS || '180000', 10) || 180_000);

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    let body = Buffer.from(buffer.subarray(2));
    if (body.length % 2) body = Buffer.from(body.subarray(0, body.length - 1));
    body.swap16();
    return body.toString('utf16le');
  }
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    fail('文本文件不是有效的 UTF-8/UTF-16。请先转为 UTF-8 后重新导入。', 415);
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, token: string) => {
    if (token[0] === '#') {
      const hex = token[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[token.toLowerCase()] ?? match;
  });
}

function cleanText(value: string): string {
  return decodeEntities(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|pre|h[1-6]|section|article|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n'))
    .split('\n').map((line) => line.trim()).join('\n').trim();
}

function xmlAttributes(source: string): Record<string, string> {
  const output: Record<string, string> = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) output[match[1]!] = decodeEntities(match[3] ?? match[4] ?? '');
  return output;
}

/**
 * 解析 ZIP 中央目录，返回条目 Map；执行路径安全与展开体积上限校验，不支持加密/ZIP64/跨磁盘。
 */
function zipDirectory(buffer: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  const lower = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= lower; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('压缩文档不是有效 ZIP/EPUB 文件。');
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    fail('暂不支持跨磁盘 ZIP 文件。', 415);
  }
  const entriesCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entriesCount === 0xffff || centralOffset === 0xffffffff) fail('暂不支持 ZIP64 文档。', 415);
  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  let expandedTotal = 0;
  for (let i = 0; i < entriesCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail('ZIP 中央目录损坏。');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) fail('ZIP 中央目录越界。');
    if (flags & 1) fail('暂不支持加密 ZIP 文档。', 415);
    if (method !== 0 && method !== 8) fail('ZIP 使用了不支持的压缩方式：' + method, 415);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    const name = path.posix.normalize(rawName);
    if (name.startsWith('../') || name === '..' || name.startsWith('/')) fail('ZIP 包含不安全的文件路径。');
    expandedTotal += size;
    if (expandedTotal > MAX_EXPANDED_BYTES) fail('解压后的文档超过 ' + Math.round(MAX_EXPANDED_BYTES / 1024 / 1024) + ' MiB 安全上限。', 413);
    if (!rawName.endsWith('/')) entries.set(name, { name, method, compressedSize, size, localOffset });
    offset = end;
  }
  return entries;
}

/**
 * 读取并解压单个 ZIP 条目；校验本地头与大小，解压失败/超限抛错。
 */
function zipRead(buffer: Buffer, entries: Map<string, ZipEntry>, entryName: string): Buffer {
  const entry = entries.get(path.posix.normalize(entryName.replace(/\\/g, '/')));
  if (!entry) fail('压缩文档缺少必要文件：' + entryName);
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) fail('ZIP 本地文件头损坏。');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) fail('ZIP 数据块越界。');
  const compressed = buffer.subarray(dataStart, dataEnd);
  let result: Buffer;
  try {
    result = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    fail('ZIP 文档解压失败或超过安全上限。');
  }
  if (result.length !== entry.size) fail('ZIP 文件大小校验失败。');
  return result;
}

function normalizePath(baseFile: string, href: string): string {
  const cleanHref = decodeURIComponent(href.split('#')[0]!.split('?')[0]!).replace(/\\/g, '/');
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), cleanHref)).replace(/^\.\/+/, '');
}

function headingFromHtml(html: string): string {
  const match = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i)
    || html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match ? cleanText(match[1]!).replace(/\s+/g, ' ').slice(0, 160) : '';
}

function htmlBlocks(html: string): Array<{ text: string; kind: string; level?: number }> {
  const content = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, ' ');
  const blocks: Array<{ text: string; kind: string; level?: number }> = [];
  const blockPattern = /<(h[1-6]|p|blockquote|li|pre)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of content.matchAll(blockPattern)) {
    const tag = match[1]!.toLowerCase();
    const text = cleanText(match[2]!).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    blocks.push({ text, kind: tag.startsWith('h') ? 'heading' : tag === 'blockquote' ? 'quote' : tag === 'li' ? 'list-item' : 'paragraph', ...(tag.startsWith('h') ? { level: Number(tag.slice(1)) } : {}) });
  }
  if (!blocks.length) {
    const fallback = cleanText(content).split(/\n+/).map((text) => text.trim()).filter((text) => text.length > 1);
    for (const text of fallback) blocks.push({ text, kind: 'paragraph' });
  }
  return blocks;
}

/** Keep long no-blank-line input and unusually large EPUB/DOCX paragraphs within batch limits. */
/**
 * 将超长文本按标点/空白切分为 <= maxChars 的块；避免拆分 UTF-16 代理对。
 */
function splitLongText(value: string, maxChars = 1800): string[] {
  let remaining = value.trim();
  const chunks: string[] = [];
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    let cut = -1;
    const punctuation = /[.!?。！？…;；](?:["'”’」』）)]*)/gu;
    for (const match of window.matchAll(punctuation)) {
      const end = match.index! + match[0].length;
      if (end >= Math.floor(maxChars * 0.55) && end <= maxChars) cut = end;
    }
    if (cut < 0) {
      const whitespace = window.lastIndexOf(' ');
      if (whitespace >= Math.floor(maxChars * 0.75)) cut = whitespace;
    }
    if (cut < 1) cut = maxChars;
    // Never separate a UTF-16 surrogate pair at a hard boundary.
    if (cut < remaining.length) {
      const before = remaining.charCodeAt(cut - 1);
      const after = remaining.charCodeAt(cut);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) cut--;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function stableId(prefix: string, index: number): string {
  const safe = prefix.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'section';
  return safe + '-' + String(index + 1).padStart(5, '0');
}

function segmentsFromBlocks(
  blocks: Array<{ text: string; kind: string; level?: number }>,
  format: DocumentFormat,
  sourcePath: string,
  idPrefix: string,
  initialChapter: string,
  startOrdinal = 0,
): ProjectSegment[] {
  const result: ProjectSegment[] = [];
  const hasHeadings = blocks.some((block) => block.kind === 'heading');
  const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  // Plain-text exports often have no heading markers. Divide these into stable virtual sections
  // so summaries/retrieval stay local instead of treating the complete novel as one chapter.
  const autoPartition = !hasHeadings && (blocks.length > 20 || totalChars > 20_000);
  let chapter = initialChapter || '正文';
  let autoChapter = 1;
  let groupBlocks = 0;
  let groupChars = 0;
  let ordinal = startOrdinal;

  for (const block of blocks) {
    if (hasHeadings && block.kind === 'heading') chapter = block.text.slice(0, 160);
    const chunks = splitLongText(block.text);
    chunks.forEach((chunk, chunkIndex) => {
      if (!hasHeadings && autoPartition) {
        if (groupBlocks > 0 && (groupBlocks >= 40 || groupChars + chunk.length > 20_000)) {
          autoChapter++;
          groupBlocks = 0;
          groupChars = 0;
        }
        chapter = '自动分段 ' + String(autoChapter).padStart(2, '0');
        groupBlocks++;
        groupChars += chunk.length;
      }
      result.push({
        id: stableId(idPrefix || sourcePath || format, ordinal++),
        text: chunk,
        kind: chunkIndex === 0 ? block.kind : 'paragraph',
        contextPath: chapter,
        ...(chunkIndex === 0 && block.level ? { level: block.level } : {}),
        ...(sourcePath ? { path: sourcePath } : {}),
      });
    });
    if (result.length + startOrdinal > MAX_SEGMENTS) {
      fail('文档片段超过 ' + MAX_SEGMENTS + ' 项上限；可调整服务端解析策略后重新导入。', 413);
    }
  }
  return result;
}

function appendTextSegments(
  segments: ProjectSegment[],
  text: string,
  format: DocumentFormat,
  sourcePath = '',
): void {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!normalized) fail('文档中没有可提取的文本内容。', 415);
  const lines = normalized.split('\n');
  const blocks: Array<{ text: string; kind: string; level?: number }> = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join('\n').trim();
    if (value) {
      const single = value.replace(/\s+/g, ' ').trim();
      const heading = /^#{1,6}\s+/.test(single) ||
        /^(chapter|chap\.?|part|book|prologue|epilogue|interlude|appendix)\s+[\wivxlcdm\d-]*\s*[:.\-]?\s*.{0,100}$/i.test(single) ||
        /^第.{1,40}[章节回卷部篇幕]\s*.*$/.test(single) ||
        (/^[A-Z0-9][A-Z0-9 .:'’\-]{0,55}$/.test(single) && single.length > 2 && single.length < 56);
      blocks.push({ text: single.replace(/^#{1,6}\s+/, ''), kind: heading ? 'heading' : 'paragraph', ...(heading ? { level: 1 } : {}) });
    }
    current = [];
  };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    current.push(line.trim());
  }
  flush();

  const parsed = segmentsFromBlocks(
    blocks, format, sourcePath, sourcePath || format,
    path.basename(sourcePath || '正文'), segments.length,
  );
  segments.push(...parsed);
}

function parsePlainDocument(bytes: Buffer, format: DocumentFormat, fileName: string): ProjectSegment[] {
  const text = decodeText(bytes);
  const filePath = path.basename(fileName);
  if (format === 'html') {
    const blocks = htmlBlocks(text);
    if (!blocks.length) fail('HTML 中没有可提取的正文。', 415);
    const initialChapter = headingFromHtml(text) || path.basename(fileName, path.extname(fileName));
    return segmentsFromBlocks(blocks, format, filePath, filePath, initialChapter);
  }
  const segments: ProjectSegment[] = [];
  appendTextSegments(segments, text, format, filePath);
  return segments;
}

/**
 * 解析 DOCX：读取 word/document.xml，按段落提取文本，识别 Heading 样式为章节标题。
 */
function parseDocx(bytes: Buffer, fileName: string): ProjectSegment[] {
  const entries = zipDirectory(bytes);
  const documentXml = zipRead(bytes, entries, 'word/document.xml').toString('utf8');
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p\s*>/gi;
  const blocks: Array<{ text: string; kind: string; level?: number }> = [];
  for (const match of documentXml.matchAll(paragraphPattern)) {
    const xml = match[1]!;
    const pieces = Array.from(xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>/gi), (item) => decodeEntities(item[1]!));
    const text = pieces.join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const style = xml.match(/<w:pStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const heading = /^Heading[1-6]$/i.test(style) || /^Title$/i.test(style) ||
      /^第.{1,40}[章节回卷部篇幕]\s*.*$/.test(text) ||
      /^(chapter|part|prologue|epilogue)\b/i.test(text);
    blocks.push({
      text, kind: heading ? 'heading' : 'paragraph',
      ...(heading ? { level: Number(style.match(/\d/)?.[0] || 1) } : {}),
    });
  }
  if (!blocks.length) fail('DOCX 中没有可提取的文字。', 415);
  return segmentsFromBlocks(
    blocks, 'docx', 'word/document.xml', 'docx',
    path.basename(fileName, path.extname(fileName)),
  );
}

/**
 * 解析 EPUB：读 container.xml→OPF，按 spine 顺序提取 XHTML 块，保留章节/路径与稳定片段 ID。
 */
function parseEpub(bytes: Buffer, fileName: string): ProjectSegment[] {
  const entries = zipDirectory(bytes);
  if (!entries.has('META-INF/container.xml')) fail('EPUB 缺少 META-INF/container.xml。');
  const container = zipRead(bytes, entries, 'META-INF/container.xml').toString('utf8');
  const rootPath = container.match(/<rootfile\b([^>]*)\/?>/i);
  const opfPath = rootPath ? xmlAttributes(rootPath[1]!)['full-path'] : '';
  if (!opfPath) fail('EPUB 元数据中找不到 OPF rootfile。');
  const opf = zipRead(bytes, entries, opfPath).toString('utf8');
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const match of opf.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = xmlAttributes(match[1]!);
    if (attrs.id && attrs.href) manifest.set(attrs.id, { href: attrs.href, mediaType: attrs['media-type'] || '', properties: attrs.properties || '' });
  }
  const itemOrder: string[] = [];
  for (const match of opf.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const attrs = xmlAttributes(match[1]!);
    if (attrs.idref) itemOrder.push(attrs.idref);
  }
  if (!itemOrder.length) fail('EPUB spine 为空，无法确定小说正文顺序。');
  const segments: ProjectSegment[] = [];
  let chapterNumber = 0;
  for (const id of itemOrder) {
    const item = manifest.get(id);
    if (!item || (!/xhtml|html/i.test(item.mediaType) && !/\.(xhtml?|html?)$/i.test(item.href))) continue;
    const partPath = normalizePath(opfPath, item.href);
    const entry = entries.get(partPath);
    if (!entry) continue;
    const html = zipRead(bytes, entries, partPath).toString('utf8');
    const blocks = htmlBlocks(html);
    if (!blocks.length) continue;
    chapterNumber++;
    let chapter = headingFromHtml(html) || path.basename(item.href, path.extname(item.href)).replace(/[_-]+/g, ' ');
    if (!chapter || /^\d+$/.test(chapter)) chapter = '第 ' + chapterNumber + ' 节';
    chapter = chapter.slice(0, 160);
    let localIndex = 0;
    for (const block of blocks) {
      if (block.kind === 'heading' && !segments.some((segment) => segment.contextPath === block.text)) {
        // A visible section heading is more useful than the XHTML file name, but keep one chapter
        // path per spine document so chronology and chapter retrieval remain stable.
        if (block.text.length <= 160 && (localIndex === 0 || block.level === 1)) chapter = block.text;
      }
      const chunks = splitLongText(block.text);
      chunks.forEach((chunk, chunkIndex) => {
        segments.push({
          id: stableId(partPath, segments.length),
          text: chunk,
          kind: chunkIndex === 0 ? block.kind : 'paragraph',
          contextPath: chapter,
          ...(chunkIndex === 0 && block.level ? { level: block.level } : {}),
          path: partPath,
        });
        localIndex++;
      });
      if (segments.length > MAX_SEGMENTS) fail('EPUB 正文片段超过 ' + MAX_SEGMENTS + ' 项上限；请调整服务端解析策略或拆分文档。', 413);
    }
  }
  if (!segments.length) fail('EPUB spine 中没有可提取的 XHTML 正文。', 415);
  const title = opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title\s*>/i)?.[1];
  if (title) {
    // Store title as an event-free project segment only when the first spine has no visible title.
    const decodedTitle = cleanText(title).slice(0, 160);
    if (decodedTitle && !segments.some((segment) => segment.kind === 'heading' && segment.text === decodedTitle)) {
      segments.unshift({ id: 'epub-title', text: decodedTitle, kind: 'heading', contextPath: decodedTitle, path: opfPath });
    }
  }
  return segments;
}

/**
 * 通过 pdftotext 提取 PDF 文本层；超时/无 pdftotext/无文本层时抛错（不执行 OCR）。
 */
async function extractPdfText(bytes: Buffer): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(Object.assign(new Error('PDF 文本提取超时（' + Math.round(PDF_EXTRACTION_TIMEOUT_MS / 1000) + ' 秒）。可通过 LOCAL_AGENT_PDF_TIMEOUT_MS 调整。'), { status: 408 }));
    }, PDF_EXTRACTION_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_EXPANDED_BYTES) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(Object.assign(new Error('PDF 提取文本超过 ' + Math.round(MAX_EXPANDED_BYTES / 1024 / 1024) + ' MiB 上限。'), { status: 413 }));
        }
      } else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 4000) stderr.push(Buffer.from(chunk)); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error.code === 'ENOENT') reject(Object.assign(new Error('本机未安装 pdftotext；纯文字 PDF 解析需要安装 Poppler（macOS 可执行 brew install poppler）。不会执行 OCR。'), { status: 415 }));
      else reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(Object.assign(new Error('PDF 文本提取失败：' + Buffer.concat(stderr).toString('utf8').slice(0, 500)), { status: 415 }));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8');
      if (!text.trim()) {
        reject(Object.assign(new Error('PDF 没有可提取的文本层；本服务不执行 OCR。'), { status: 415 }));
        return;
      }
      resolve(text);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

/**
 * 根据文件扩展名推断格式，仅支持 epub/pdf/txt/md/html/docx，否则抛 415。
 */
export function inferDocumentFormat(fileName: string): DocumentFormat {
  const extension = path.extname(path.basename(fileName)).toLowerCase().replace(/^\./, '');
  if (['epub', 'pdf', 'txt', 'md', 'html', 'docx'].includes(extension)) return extension as DocumentFormat;
  fail('当前文件解析器支持 EPUB、DOCX、PDF（需要 pdftotext）、TXT、Markdown、HTML；收到格式：' + (extension || '无扩展名'), 415);
}

/**
 * 原始文件导入的统一入口：识别格式、抽取文本/结构并产出标准 Source Segment。
 * 各解析器必须遵守输入文件与解压展开体积上限，保留章节/路径/页码等可用元数据，
 * 并生成稳定片段 ID；这里不启动翻译，也不直接写项目数据库。
 */
export async function parseDocumentFile(fileName: string, source: Uint8Array): Promise<{ format: DocumentFormat; title: string; segments: ProjectSegment[] }> {
  const bytes = Buffer.from(source);
  if (!bytes.length) fail('原始文件内容为空。');
  if (bytes.length > MAX_DOCUMENT_SOURCE_BYTES) fail('原始文档超过 ' + Math.round(MAX_DOCUMENT_SOURCE_BYTES / 1024 / 1024) + ' MiB 上限。', 413);
  const format = inferDocumentFormat(fileName);
  if (format === 'epub' || format === 'docx') {
    if (bytes.length < 4) fail('文件内容过短，不是有效的压缩文档。');
    if (bytes.readUInt32LE(0) !== 0x04034b50 && bytes.readUInt32LE(0) !== 0x06054b50) fail('文件扩展名与 ZIP 文件内容不匹配。');
  }
  if (format === 'pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('文件扩展名与 PDF 内容不匹配。');
  let segments: ProjectSegment[];
  if (format === 'epub') segments = parseEpub(bytes, fileName);
  else if (format === 'docx') segments = parseDocx(bytes, fileName);
  else if (format === 'pdf') segments = [];
  else segments = parsePlainDocument(bytes, format, fileName);
  if (format === 'pdf') {
    const text = await extractPdfText(bytes);
    appendTextSegments(segments, text, format, path.basename(fileName));
  }
  if (!segments.length) fail('文档中没有可导入的正文片段。', 415);
  return {
    format,
    title: path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' ').trim() || '未命名文档',
    segments,
  };
}
