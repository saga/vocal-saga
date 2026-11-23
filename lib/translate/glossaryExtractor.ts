import nlp from 'compromise/two';
import type { Glossary } from './service/_service';
import techProductsData from './tech-products.json';

const TECH_PRODUCTS = new Set<string>(techProductsData.products as string[]);
// Canonical casing map for known products: lowercased key → official spelling
// (e.g. "github" -> "GitHub", "dbt" -> "dbt"). Used at the end of
// extractGlossaryLocal to force a known product's casing regardless of
// which form the article happens to surface first ("DBT" vs "dbt" vs
// "Dbt"). Without this, a race between the article's first occurrence
// and the canonical form can leave the wrong casing in the glossary.
const CANONICAL_PRODUCTS = new Map(
  [...TECH_PRODUCTS].map((p) => [p.toLowerCase(), p])
);
const KNOWN_PUBLICATIONS = new Set<string>(
  (techProductsData.publications as string[]).flatMap((p) => p.toLowerCase().split(/\s+/))
);
const FULL_PUBLICATIONS = techProductsData.publications as string[];

// Tech-domain anchors
const TECH_ANCHORS = new Set([
  'AI', 'ML', 'LLM', 'RAG', 'NLP', 'GPU', 'CPU', 'TPU', 'NPU',  
  'API', 'GraphQL', 'gRPC', 'SQL', 'NoSQL', 'MCP', 'RBAC', 'PII',
  'TLS', 'SSL', 'SDK', 'IDE', 'CDN', 'DDoS', 'SaaS', 'PaaS', 'IaaS', 'FaaS',
  'ETL', 'ELT', 'JVM', 'WASM', 'K8s',
  'Kafka', 'Flink', 'Spark', 'Airflow', 
   'Postgres', 'Redis', 'MongoDB', 'Elasticsearch', 'ClickHouse',
  'Docker', 'Kubernetes', 'PyTorch', 'TensorFlow', 'LangChain', 'LangGraph', 'Ollama',
  'Anthropic',
]);

const TECH_ANCHORS_LOWER = new Set(
  [...TECH_ANCHORS].map((w) => w.toLowerCase())
);

const BLOCKED_TAIL_NOUNS = new Set([
  'apps', 'services', 'tools', 'users', 'systems', 'solutions', 'platforms',
  'products', 'projects', 'features', 'components', 'modules',
  'issues', 'questions', 'topics', 'items', 'things', 'stuff', 'aspects',
  'elements', 'factors', 'areas', 'parts', 'pieces',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'nor', 'yet', 'so',
  'for', 'in', 'on', 'at', 'to', 'of', 'by', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'shall', 'may', 'might',
  'must', 'can', 'need', 'dare', 'ought', 'used',
  'it', 'its', 'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our',
  'they', 'them', 'their', 'you', 'your', 'my', 'me', 'mine', 'yours',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'some', 'any', 'no', 'none', 'much', 'many',
  'other', 'another', 'such', 'same', 'own', 'than', 'then', 'too', 'very',
  'also', 'just', 'only', 'even', 'still', 'already', 'never', 'always',
  'here', 'there', 'now', 'well', 'about', 'above', 'below', 'under', 'over',
  'after', 'before', 'between', 'through', 'during', 'without', 'within',
  'along', 'across', 'against', 'into', 'onto', 'upon', 'out', 'off', 'up', 'down',
  'if', 'while', 'although', 'though', 'because', 'since', 'until', 'unless',
  'whether', 'rather', 'instead', 'however', 'therefore', 'thus', 'hence',
  'else', 'ever', 'once', 'again', 'further', 'back',
  'i', 'am', 'been', 'get', 'got', 'let', 'make', 'go', 'come', 'take',
  'give', 'see', 'know', 'think', 'say', 'tell', 'ask', 'use', 'find',
  'want', 'look', 'try', 'help', 'show', 'hear', 'play', 'run', 'move', 'live',
  'put', 'set', 'add', 'keep', 'start', 'stop', 'turn', 'call',
  'work', 'seem', 'feel', 'leave', 'bring', 'begin',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'great', 'small', 'large', 'big', 'long', 'short', 'high', 'low',
  'right', 'left', 'early', 'late', 'hard', 'easy', 'best', 'worst',
  'true', 'false', 'real', 'sure', 'able', 'free', 'full', 'empty',
  'different', 'important', 'possible', 'public', 'private', 'certain',
  'general', 'local', 'social', 'national', 'natural', 'political',
  'point', 'way', 'day', 'time', 'year', 'people', 'man', 'woman',
  'child', 'world', 'life', 'hand', 'part', 'place', 'case', 'week',
  'company', 'system', 'program', 'question', 'home', 'water', 'room',
  'area', 'money', 'story', 'fact', 'month', 'lot', 'right', 'study',
  'book', 'eye', 'job', 'word', 'business', 'issue', 'side', 'kind',
  'head', 'house', 'service', 'friend', 'father', 'mother', 'power',
  'hour', 'game', 'line', 'end', 'member', 'law', 'car', 'city',
  'community', 'name', 'president', 'team', 'minute', 'idea', 'body',
  'information', 'back', 'parent', 'face', 'level', 'office', 'door',
  'health', 'person', 'art', 'war', 'history', 'party', 'result',
  'customer', 'server', 'database', 'network', 'process', 'model', 'tool',
  'feature', 'platform', 'product', 'project', 'team', 'user',
  'ive', 'dont', 'youre', 'were', 'theyre', 'im', 'id', 'ill', 'hes', 'shes',
  'morning', 'reason', 'research', 'girl', 'guy', 'moment', 'air',
  'teacher', 'force', 'education', 'foot', 'boy', 'age', 'policy',
  'music', 'market', 'sense', 'thing', 'things', 'love', 'class', 'state',
  'don', 'doesn', 'didn', 'won', 'wasn', 'weren', 'isn', 'aren',
  'hasn', 'haven', 'hadn', 'wouldn', 'couldn', 'shouldn', 'mustn',
  've', 'll', 're', 'shan',
]);

const ACRONYM_EXCLUSIONS = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'ALL', 'CAN', 'HAS', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'USE', 'VIA', 'WHO', 'ITS', 'MAY', 'NOR',
  'SINCE', 'INTO', 'FROM', 'THIS', 'THAT', 'WITH', 'SUCH', 'EACH', 'WHEN',
  'WHERE', 'WHICH', 'WHILE', 'OVER', 'BOTH', 'THEN', 'THAN', 'THEY', 'THEM',
  'THEIR', 'THESE', 'THOSE', 'BEEN', 'BEING', 'HAVE', 'WILL', 'WOULD',
  'COULD', 'SHOULD', 'ABOUT', 'OTHER', 'ALSO', 'SOME', 'VERY', 'JUST',
  'MUST', 'DOER', 'VS', 'GET', 'SET', 'PUT', 'LET', 'SEE', 'SAY', 'DAY',
  'WAY', 'OWN', 'TOO', 'ANY', 'TRY', 'RUN', 'ADD', 'END', 'TOP',
  'BIG', 'BAD', 'RED', 'MAN', 'OLD', 'NEW', 'HOT', 'FAR', 'OFF', 'LOT',
  'AGE', 'AGO', 'DUE', 'YET', 'NON', 'PER', 'SUB', 'PRE', 'PRO', 'POST',
  'SELF', 'TRUE', 'NULL', 'VOID', 'TYPE', 'LIKE', 'EVEN', 'WELL', 'BACK',
  'NEXT', 'LAST', 'BEST', 'DONE', 'MADE', 'GONE', 'TOLD', 'CAME', 'WENT',
  'TOOK', 'SAID', 'KNEW', 'GOT', 'NEED', 'MAKE', 'HELP', 'WORK',
  'PART', 'GOOD', 'LOOK', 'COME', 'CALL', 'KEEP', 'GIVE',
  'TURN', 'MOVE', 'LIVE', 'SHOW', 'FIND', 'HAND', 'HEAD', 'SIDE', 'LINE',
  'CASE', 'POINT', 'MEAN', 'USED', 'SEEM', 'WANT', 'FACT', 'FORM', 'SURE',
  'ABLE', 'ELSE', 'EVER', 'STILL',
  'ISBN', 'HTML', 'JSON', 'ACM', 'BETA', 'MATH',
]);

const ACRONYM_PATTERN = /\b(?:[A-Z]{2,}|[a-z]+[A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;

function cleanTerm(term: string): string {
  // split() always yields at least one element, but guard the indexed slot for the checker
  // before continuing the chain (a bare `?? ''` mid-chain would capture the following calls).
  const head = term
    .replace(/^[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+/, '')
    .replace(/[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+$/, '')
    .replace(/['’]s$/i, '')
    .split(/\.[A-Z]/)[0] ?? '';
  return head
    .replace(/['’]/g, '')
    .trim();
}

function extractAcronyms(text: string): string[] {
  const found = new Map<string, number>();
  for (const match of text.matchAll(ACRONYM_PATTERN)) {
    const word = match[0];
    if (!ACRONYM_EXCLUSIONS.has(word)) {
      found.set(word, (found.get(word) || 0) + 1);
    }
  }
  const result: string[] = [];
  for (const [word, count] of found) {
    if (/^[A-Z]{5,}$/.test(word) && !/\d/.test(word) && count < 2) {
      continue;
    }
    result.push(word);
  }
  return result;
}

// =============================================================================
// Context-aware Product Name Extraction
// =============================================================================
//
// 识别 AI 厂商的完整产品名（Named Entity），而非单个普通词。
// 核心思路：以 vendor prefix（Claude/GPT/Gemini/Llama/...）为锚，向右吸收
// 0-3 个"产品 token"（大写词 / 版本号 / 参数规模），组成完整产品名加入 glossary。
//
// 这样 "Claude Sonnet 4.5" 作为整体保留，而 "A sonnet consists of..."
// 里的 "sonnet"（小写、非 prefix）不会被误伤，仍翻译为"十四行诗"。
//
// 覆盖：Claude Sonnet/Opus/Haiku、GPT-5、Gemini 2.5 Pro、Llama 4 Scout、
// Qwen3-235B、DeepSeek R1、Mistral Large、Command A 等。

const AI_VENDOR_PREFIXES = [
  'Claude', 'GPT', 'Gemini', 'Llama', 'Qwen',
  'Mistral', 'DeepSeek', 'Grok', 'Nova', 'Command', 'Phi',
];

let compiledProductRe: RegExp | null = null;
function getProductRe(): RegExp {
  if (compiledProductRe) return compiledProductRe;
  const escaped = AI_VENDOR_PREFIXES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  // tail token：
  //   - prefix 直接跟数字版本（Qwen3 / GPT5）
  //   - 空格或连字符 + 大写词（Sonnet / Opus / Pro / Flash / Scout / Large / Code / Desktop）
  //   - 空格或连字符 + 版本号（4 / 4.1 / 2.5 / 5）
  //   - 空格或连字符 + 参数规模（235B / 70B）
  const tailToken =
    '[0-9]+(?:\\.[0-9]+)?[A-Za-z]*' +                         // 直接跟数字（Qwen3）
    '|[\\s\\-]+(?:[A-Z][A-Za-z]*|[0-9]+(?:\\.[0-9]+)?[A-Za-z]*)'; // 空格/连字符 + token
  compiledProductRe = new RegExp(
    `\\b(?:${escaped.join('|')})(?:${tailToken}){0,3}`,
    'g'
  );
  return compiledProductRe;
}

/**
 * 从文本中提取 AI 产品名（上下文感知）。
 * 只匹配以 vendor prefix 开头的完整产品名，不会误伤普通英文词。
 */
function extractProductNames(text: string): string[] {
  const re = getProductRe();
  const results = new Set<string>();
  for (const m of text.matchAll(re)) {
    const name = m[0].replace(/[\s\-]+$/, '').trim();
    if (name.length >= 3) {
      results.add(name);
    }
  }
  return [...results];
}

function extractNamedEntities(doc: any): string[] {
  const entities = new Set<string>();
  const fullText = doc.text();

  const possessiveRanges: Array<[number, number]> = [];
  {
    // Build [start, end) ranges for every possessive match. We use
    // sequential indexOf to handle repeated phrases (e.g. "Netflix's ...
    // Netflix's ... Netflix's") — using fullText.indexOf(text) without
    // a fromIndex would collapse every match to the first occurrence and
    // make later occurrences look non-possessive, so isPossessive would
    // return false and the name would leak into the glossary.
    let searchFrom = 0;
    for (const t of doc.match('#Possessive+').out('array')) {
      const idx = fullText.indexOf(t, searchFrom);
      if (idx >= 0) {
        possessiveRanges.push([idx, idx + t.length]);
        searchFrom = idx + t.length;
      }
    }
  }
  const isPossessive = (word: string): boolean => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<=^|[^a-zA-Z0-9_])${escaped}(?=[^a-zA-Z0-9_]|$)`, 'g');

    let allPossessive = true;
    let hasMatch = false;

    for (const match of fullText.matchAll(regex)) {
      hasMatch = true;
      const idx = match.index;
      if (idx === undefined) continue;

      const inRange = possessiveRanges.some(([s, e]) => idx >= s && idx < e);
      if (!inRange) {
        allPossessive = false;
        break;
      }
    }
    return hasMatch ? allPossessive : false;
  };

  if (typeof doc.acronyms === 'function') {
    for (const ac of doc.acronyms().out('array')) {
      const cleaned = cleanTerm(ac);
      if (cleaned.length < 2 || cleaned.length >= 20) continue;
      if (cleaned.includes(' ')) continue;
      if (ACRONYM_EXCLUSIONS.has(cleaned.toUpperCase())) continue;
      if (isCommonNoun(cleaned)) continue;
      if (/^[A-Z]{5,}$/.test(cleaned) && !/\d/.test(cleaned)) {
        const occurrences = (fullText.match(new RegExp(`(?<=^|[^a-zA-Z0-9_])${cleaned}(?=[^a-zA-Z0-9_]|$)`, 'g')) || []).length;
        if (occurrences < 2) continue;
      }
      entities.add(cleaned);
    }
  }

  if (typeof doc.people === 'function') {
    for (const person of doc.people().out('array')) {
      const cleaned = cleanTerm(person);
      if (cleaned.length < 2) continue;
      if (cleaned.includes(' ')) {
        for (const tok of cleaned.split(/\s+/)) {
          if (tok.length >= 2 && !isCommonNoun(tok) && !isStopword(tok)) {
            entities.add(tok);
          }
        }
      } else {
        if (!isCommonNoun(cleaned) && !isStopword(cleaned)) entities.add(cleaned);
      }
    }
  }

  const brandRegex = /(?:^|[^a-zA-Z0-9])([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;
  for (const m of fullText.matchAll(brandRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    if (isPossessive(word)) continue;
    entities.add(word);
  }

  const singleCapRegex = /(?<=[a-z,;:] )([A-Z][a-z]{2,})\b/g;
  for (const m of fullText.matchAll(singleCapRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    if (STOPWORDS.has(word.toLowerCase())) continue;
    if (isPossessive(word)) continue;
    if (KNOWN_PUBLICATIONS.has(word.toLowerCase())) continue;
    entities.add(word);
  }

  // Sentence-initial capitalized words: compromise's PoS tagger often
  // fails to label a single capitalized word at the start of a sentence
  // (or after a newline) as #ProperNoun, so #ProperNoun+ misses
  // brands like "Anthropic" or "Microsoft" when they appear in isolation.
  // We backstop this with a regex that captures `[A-Z][a-z]{2,}` at
  // sentence start, filtered through the same noise gates
  // (isCommonNoun / isStopword / KNOWN_PUBLICATIONS / isPossessive).
  //
  // Frequency gate: words that appear fewer than 3 times total are only
  // kept if they are known tech anchors (e.g. "Anthropic", "Kubernetes").
  // This prevents generic words like "Governance" or "Multiple" from
  // sneaking in on a single sentence-start mention.
  //
  // NOTE: lookbehind-based pattern `(?<=^|[.!?]\\s+|\n)` would fail when
  // whitespace (spaces/tabs) follows the newline before the capital word
  // (e.g. "\n  Anthropic").  Instead we use a non-escaped capturing
  // group so \n + optional spaces are consumed as part of the match.
  const sentenceStartCapRegex = /(?:^|[.!?]\s+|\n\s*)([A-Z][a-z]{2,})\b/g;
  const sentenceStartWords = [...fullText.matchAll(sentenceStartCapRegex)].map(m => m[1]);
  if (sentenceStartWords.length > 0) {
    // Count every capitalized occurrence in the full text (sentence-initial
    // or mid-sentence) so we know the total frequency.
    const totalCounts = new Map<string, number>();
    for (const m of fullText.matchAll(/(?<![A-Za-z0-9_])([A-Z][a-z]{2,})\b/g)) {
      const w = m[1];
      totalCounts.set(w, (totalCounts.get(w) || 0) + 1);
    }

    for (const word of sentenceStartWords) {
      if (entities.has(word)) continue;
      if (isCommonNoun(word)) continue;
      if (STOPWORDS.has(word.toLowerCase())) continue;
      if (isPossessive(word)) continue;
      if (KNOWN_PUBLICATIONS.has(word.toLowerCase())) continue;

      const total = totalCounts.get(word) || 0;
      if (total < 3 && !TECH_ANCHORS.has(word)) continue;

      entities.add(word);
    }
  }

  for (const pub of FULL_PUBLICATIONS) {
    if (fullText.toLowerCase().includes(pub.toLowerCase())) {
      entities.add(pub);
    }
  }

  const sentenceStartCounts = new Map<string, number>();
  for (const m of fullText.matchAll(/(?:^|[.!?]\s+|\n)([A-Z][A-Za-z]+)/g)) {
    const w = m[1].toLowerCase();
    sentenceStartCounts.set(w, (sentenceStartCounts.get(w) || 0) + 1);
  }
  const properNounCounts = new Map<string, number>();

  for (const pn of doc.match('#ProperNoun+').not('(#Pronoun|#Conjunction|#Preposition|#Determiner|#Adverb)').out('array')) {
    const cleaned = cleanTerm(pn);
    if (cleaned.includes(' ')) continue;
    if (cleaned.length < 3) continue;
    if (isStopword(cleaned)) continue;
    if (isCommonNoun(cleaned)) continue;
    if (isPossessive(cleaned)) continue;
    if (KNOWN_PUBLICATIONS.has(cleaned.toLowerCase())) continue;
    properNounCounts.set(cleaned, (properNounCounts.get(cleaned) || 0) + 1);
  }
  for (const [word, count] of properNounCounts) {
    const startCount = sentenceStartCounts.get(word.toLowerCase()) || 0;
    if (count > 1 && startCount >= count) continue;
    entities.add(word);
  }

  return [...entities];
}

const COMMON_NOUN_FALSE_POSITIVES = new Set([
  'Actually', 'Coding', 'Flash', 'How', 'Pro', 'Scout', 'Setup', 'Studio',
  'Why', 'When', 'Where', 'What', 'Which', 'Who',
  'Today', 'Tomorrow', 'Yesterday', 'Nothing', 'Everything', 'Something',
  'Anything', 'Everyone', 'Anyone', 'Someone', 'Nobody', 'Everybody',
  'Each', 'Every', 'Other', 'Another', 'Either', 'Neither',
  'Most', 'Some', 'Many', 'Several', 'Few', 'All', 'Both', 'None',
  'Future', 'Past', 'Present', 'Now', 'Then', 'Here', 'There',
  'Above', 'Below', 'Inside', 'Outside', 'Before', 'After', 'During',
  'Until', 'Since', 'While', 'Because', 'Although', 'However',
  'Moreover', 'Furthermore', 'Therefore', 'Otherwise', 'Instead',
  'Besides', 'Anyway', 'Somewhere', 'Nowhere', 'Everywhere',
  'People', 'Year', 'Day', 'Week', 'Month', 'Time', 'Real', 'End',
  'Beginning', 'Start', 'Middle', 'Top', 'Bottom', 'Left', 'Right',
  'Front', 'Back', 'Up', 'Down', 'Side', 'Part', 'Section',
  'Chapter', 'Page', 'Figure', 'Table', 'Section', 'Appendix',
  'Section', 'Note', 'Warning', 'Caution', 'Tip', 'Example',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Microservices', 'Microservice', 'Services', 'Service', 'Topology', 'Connector',
  'Architecture', 'Pipeline', 'Aggregator', 'Stream', 'Streams',
  'Consumer', 'Producer', 'Broker', 'Cluster', 'Node', 'Nodes',
  'Worker', 'Workers', 'Shard', 'Shards', 'Layer', 'Layers',
  'Gateway', 'Gateways', 'Balancer', 'Balancers', 'Database', 'Databases',
  'Query', 'Queries', 'Index', 'Snapshot', 'Snapshots', 'Cache', 'Bucket',
  'Endpoint', 'Endpoints', 'Protocol', 'Protocols', 'Metric', 'Metrics',
  'Trace', 'Tracer', 'Spans', 'Span', 'Log', 'Logs', 'Filter', 'Filters',
  'Graph', 'Graphs', 'Node', 'Nodes', 'Edge', 'Edges', 'Vertex', 'Vertices',
  'Table', 'Tables', 'Column', 'Columns', 'Row', 'Rows', 'Field', 'Fields',
  'View', 'Views', 'Model', 'Models', 'Schema', 'Index', 'Constraint',
  'Tier', 'Tiers', 'Region', 'Regions', 'Zone', 'Zones', 'Domain', 'Domains',
  'Flow', 'Logs', 'Path', 'Paths', 'Edge', 'Edges', 'Source', 'Sources',
  'Request', 'Response', 'Status', 'Payload', 'Header', 'Headers',
  'Service', 'Services', 'Process', 'Process', 'Thread', 'Threads',
  'Context', 'Scope', 'Token', 'Tokens', 'Session', 'Sessions',
  'Pipeline', 'Pipelines', 'Job', 'Jobs', 'Task', 'Tasks', 'Batch', 'Batches',
  'Customer', 'Server', 'Database', 'Network', 'Process', 'Model', 'Tool',
  'Feature', 'Platform', 'Product', 'Project', 'User', 'Customer',
  'Stakes', 'Controls', 'Tooling', 'Industries', 'Agencies', 'Vendors',
  'Practices', 'Patterns', 'Concerns', 'Requirements', 'Constraints',
  'Security', 'Privacy', 'Latency', 'Throughput', 'Compliance',
  'Developer', 'Engineer', 'Operator', 'Admin', 'Architect',
]);

function isCommonNoun(word: string): boolean {
  if (COMMON_NOUN_FALSE_POSITIVES.has(word)) return true;
  return COMMON_NOUN_FALSE_POSITIVES.has(
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  );
}

function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

function hasSubstantiveWord(words: string[]): boolean {
  return words.some(w => !isStopword(w));
}

const NOUN_CHAIN_BREAKERS = new Set([
  'targets', 'offers', 'provides', 'builds', 'uses', 'runs',
  'manages', 'handles', 'supports', 'creates', 'includes',
  'helps', 'makes', 'allows', 'enables', 'gives', 'takes',
  'shows', 'works', 'ships', 'brings',
  'sets', 'gets', 'needs', 'wants', 'starts', 'stops',
  'finds', 'holds', 'sends', 'leaves', 'follows', 'removes',
  'applies', 'produces', 'contains', 'represents', 'generates',
  'delivers', 'executes', 'processes', 'publishes', 'schedules',
  'configures', 'validates', 'transforms', 'converts', 'maps',
  'tracks', 'monitors', 'alerts', 'fetches', 'queries',
  // API / endpoint verbs (common in API docs: "endpoint returns data")
  'returns', 'retrieves', 'cancels', 'lists', 'searches', 'marks',
  // Infrastructure / operations
  'hosts', 'serves', 'stores', 'loads', 'caches', 'syncs',
  'routes', 'migrates', 'streams', 'batches',
  // Development / CI / deployment
  'commits', 'merges', 'deploys', 'refactors',
  'installs', 'updates', 'upgrades', 'logs',
  // Data / ML
  'trains', 'predicts', 'classifies', 'embeds',
  'encodes', 'decodes', 'normalizes',
  'aggregates', 'indexes', 'replicates',
  // General engineering
  'evaluates', 'estimates', 'performs', 'implements',
  'integrates', 'optimizes', 'simplifies', 'automates',
  'analyzes', 'compiles', 'initializes',
  'responds', 'notifies', 'subscribes', 'broadcasts',
]);

const STRONG_VERBS = new Set([
  'feels', 'seems', 'looks', 'sounds',
  'helps', 'lets', 'allows', 'enables',
  // Sense-like / copula verbs (never nouns in tech writing)
  'appears', 'becomes', 'remains',
  // Modal-like / causative (almost never nouns)
  'involves', 'requires', 'ensures', 'prevents',
  // Meta-discourse verbs (describe documentation or code behavior)
  'specifies', 'defines', 'describes', 'indicates',
  'suggests', 'demonstrates', 'recommends', 'mentions',
  'expects',
]);

function extractFrequentTerms(doc: ReturnType<typeof nlp>): string[] {
  const phraseCounts = new Map<string, number>();
  const phraseOriginals = new Map<string, string>();

  const patterns = ['#Noun+', '#Noun #Gerund', '#Noun #Noun #Gerund'];
  for (const pattern of patterns) {
    for (const phrase of doc.match(pattern).not('(#Pronoun|#Preposition|#Conjunction)').out('array')) {
      const cleaned = cleanTerm(phrase);
      if (cleaned.length < 3 || cleaned.length > 60) continue;
      if (/[,;:—–]/.test(cleaned)) continue;

      const words = cleaned.split(/\s+/);
      if (!hasSubstantiveWord(words)) continue;

      const breakIndex = words.findIndex((word, index) => {
        if (index === 0) return false;
        const wLower = word.toLowerCase();
        return NOUN_CHAIN_BREAKERS.has(wLower) || STRONG_VERBS.has(wLower);
      });
      let finalWords = words;
      if (breakIndex !== -1) {
        finalWords = words.slice(0, breakIndex);
        if (finalWords.length === 0 || !hasSubstantiveWord(finalWords)) continue;
      }
      const finalCleaned = finalWords.join(' ');

      const firstWord = finalWords[0];
      if (firstWord === undefined || isStopword(firstWord)) continue;
      if (finalWords.length === 1 && isCommonNoun(firstWord)) continue;
      if (finalWords.length === 1) {
        const w = firstWord;
        if (/^[A-Z][a-z]+(?:er|est|ing)$/.test(w) && !/^[A-Z]{2,}$/.test(w)) continue;
      }

      if (/['']s\b/.test(finalCleaned)) continue;
      if (finalWords.every((w) => isCommonNoun(w))) continue;
      const lastWord = finalWords[finalWords.length - 1];
      if (finalWords.length >= 2 && lastWord !== undefined && BLOCKED_TAIL_NOUNS.has(lastWord.toLowerCase())) continue;
      if (finalWords.length === 1 && finalCleaned.length < 4 && !/[A-Z]/.test(finalCleaned)) continue;

      const key = finalCleaned.toLowerCase();
      phraseCounts.set(key, (phraseCounts.get(key) || 0) + 1);
      if (!phraseOriginals.has(key)) {
        phraseOriginals.set(key, finalCleaned);
      }
    }
  }

  const merged = new Map<string, number>();
  const mergedOriginals = new Map<string, string>();
  const processed = new Set<string>();

  const tokenWordCount = new Map<string, number>();
  for (const phrase of phraseCounts.keys()) {
    const ws = phrase.split(/\s+/);
    if (ws.length === 1) {
      const word = ws[0];
      if (word === undefined) continue;
      tokenWordCount.set(word, (tokenWordCount.get(word) || 0) + 1);
    }
  }

  for (const [key, count] of phraseCounts.entries()) {
    if (processed.has(key)) continue;

    let totalCount = count;
    const words = key.split(/\s+/);
    if (words.length === 1 && key.length >= 4 && !/^\d+$/.test(key)) {
      const singular = key.replace(/s$/, '');
      if (singular !== key && phraseCounts.has(singular) && (tokenWordCount.get(singular) || 0) > 0) {
        totalCount += phraseCounts.get(singular)!;
        processed.add(singular);
      }
    }

    const plural = key + 's';
    if (plural !== key && !processed.has(plural) && phraseCounts.has(plural)) {
      totalCount += phraseCounts.get(plural)!;
      processed.add(plural);
    }

    processed.add(key);
    merged.set(key, totalCount);
    mergedOriginals.set(key, phraseOriginals.get(key) || key);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);

  for (const [key, count] of sorted) {
    const isSingleWord = !key.includes(' ');
    const hasAnchor = key.split(/\s+/).some((w) => TECH_ANCHORS_LOWER.has(w));
    if (isSingleWord && count < 3 && !hasAnchor) continue;
    if (!isSingleWord && count < 2 && !hasAnchor) continue;

    const term = mergedOriginals.get(key) || key;
    if (seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    result.push(term);
  }

  return result;
}

export function extractGlossaryLocal(
  fullText: string,
  emphasizedTerms: string[] = []
): Glossary {
  if (!fullText) return { document_terms: [] };
  const termSet = new Set<string>();

  const safeText = fullText
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length))
    .replace(/https?:\/\/[^\s]+/g, (m) => ' '.repeat(m.length));

  const acronyms = extractAcronyms(safeText);
  for (const acronym of acronyms) {
    termSet.add(acronym);
  }

  // Context-aware AI 产品名提取（Claude Sonnet 4.5 / GPT-5 / Gemini 2.5 Pro ...）
  // 在 nlp 之前提取，确保完整产品名作为整体加入 glossary，
  // 避免被后续 nlp 拆分成 Claude / Sonnet / 4.5 单个词。
  const productNames = extractProductNames(safeText);
  for (const name of productNames) {
    termSet.add(name);
  }

  {
    const validProducts = [...TECH_PRODUCTS].filter((p) => p.length >= 2);
    if (validProducts.length > 0) {
      const escaped = validProducts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
      const productRe = new RegExp(
        `(?<=^|[^A-Za-z0-9_])(?:${escaped.join('|')})(?=[^A-Za-z0-9_]|$)`,
        'gi'
      );
      for (const m of safeText.matchAll(productRe)) {
        const product = m[0];
        const exists = [...termSet].some(
          (k) => k.toLowerCase() === product.toLowerCase()
        );
        if (!exists) termSet.add(product);
      }
    }
  }

  const doc = nlp(safeText) as any;

  // TAGGING INTERVENTION
  // 1. Force-tag high-frequency pure verbs so they don't enter #Noun+ chains
  doc.match('(feels|seems|looks|sounds|helps|lets|allows|enables)').tag('Verb').unTag('Noun');

  // 2. Dynamic context: when a Noun is followed by a function word, it's
  //    almost certainly a verb used as the predicate (e.g. "system targets the…")
  doc.match('[#Noun] (the|a|an|to|with|for|by|its|their|our|us|them)').tag('Verb').unTag('Noun');

  // 3. Strip ProperNoun from sentence-leading function words
  doc
    .match('^(#Adverb|#Conjunction|#Pronoun|#Preposition|#Determiner)')
    .unTag('ProperNoun');

  const namedEntities = extractNamedEntities(doc);
  for (const entity of namedEntities) {
    termSet.add(entity);
  }

  const frequentTerms = extractFrequentTerms(doc);
  for (const term of frequentTerms) {
    if (!termSet.has(term)) {
      termSet.add(term);
    }
  }

  for (const term of emphasizedTerms) {
    const trimmed = term.trim();
    if (trimmed.length > 1 && trimmed.length < 80) {
      termSet.add(trimmed);
    }
  }

  const allTerms = [...termSet];

  // Case dedup + canonical product casing
  const uniqueTerms = new Map<string, string>();
  for (const term of allTerms) {
    const lower = term.toLowerCase();

    if (CANONICAL_PRODUCTS.has(lower)) {
      uniqueTerms.set(lower, CANONICAL_PRODUCTS.get(lower)!);
      continue;
    }

    if (!uniqueTerms.has(lower)) {
      uniqueTerms.set(lower, term);
    } else if (term !== term.toUpperCase() && /[a-z]/.test(term) && /^[A-Z]/.test(term)) {
      uniqueTerms.set(lower, term);
    }
  }

  // Collapse singular/plural pairs
  const merged = new Map<string, string>();
  for (const [key, term] of uniqueTerms) {
    if (merged.has(key)) continue;

    const singular = key.replace(/s$/, '');
    const plural = key + 's';
    const twinKey = singular !== key && uniqueTerms.has(singular)
      ? singular
      : plural !== key && uniqueTerms.has(plural)
        ? plural
        : null;

    if (twinKey) {
      const twinTerm = uniqueTerms.get(twinKey)!;
      const preferTitleCase = (a: string, b: string): string => {
        const aTitle = /^[A-Z]/.test(a) && a !== a.toUpperCase();
        const bTitle = /^[A-Z]/.test(b) && b !== b.toUpperCase();
        if (aTitle && !bTitle) return a;
        if (bTitle && !aTitle) return b;
        return a;
      };
      const winner = preferTitleCase(term, twinTerm);
      const canonicalKey = key.length <= twinKey.length ? key : twinKey;
      merged.set(canonicalKey, winner);
    } else {
      merged.set(key, term);
    }
  }

  // Filter generic noise, score, limit
  const scored = [...merged.values()]
    .map((term) => ({ term, score: scoreTerm(term, fullText) }))
    .filter((s) => !isGenericNoise(s.term))
    .filter((s) => !isSentenceStartMisident(s.term, fullText))
    .sort((a, b) => b.score - a.score);

  const finalTerms = scored.slice(0, MAX_GLOSSARY_TERMS).map((s) => s.term);

  return {
    document_terms: finalTerms,
  };
}

const GENERIC_NOISE = new Set([
  // Demonyms, language names, and nationality adjectives are translatable
  // vocabulary, not terms that should be kept in English.
  'english', 'dutch', 'spanish', 'portuguese', 'french', 'german', 'italian',
  'russian', 'japanese', 'chinese', 'korean', 'greek', 'latin', 'arabic',
  'turkish', 'polish', 'swedish', 'norwegian', 'danish', 'finnish', 'irish',
  'scottish', 'welsh', 'british', 'american', 'canadian', 'australian',
  'european', 'asian', 'african', 'indian', 'brazilian', 'mexican', 'persian',
  'ottoman',
  'services', 'service', 'systems', 'system', 'traces', 'trace',
  'tools', 'tool', 'logs', 'log', 'metrics', 'metric', 'data',
  'engineers', 'engineer', 'teams', 'team', 'users', 'user',
  'context', 'details', 'support', 'requests', 'request',
  'queries', 'query', 'edges', 'edge', 'paths', 'path',
  'sources', 'source', 'levels', 'level', 'environments', 'environment',
  'solutions', 'solution', 'attempts', 'attempt', 'patterns', 'pattern',
  'questions', 'question', 'failures', 'failure', 'changes', 'change',
  'views', 'view', 'layers', 'layer', 'snapshots', 'snapshot',
  'workloads', 'workload', 'hops', 'hop', 'gateways', 'gateway',
  'balancers', 'balancer', 'events', 'event', 'pipelines', 'pipeline',
  'connections', 'connection', 'storage', 'costs', 'cost',
  'incidents', 'incident', 'limitations', 'limitation',
  'processors', 'processor', 'consumers', 'consumer',
  'protocols', 'protocol', 'endpoints', 'endpoint',
  'dependencies', 'dependency', 'graphs', 'graph',
  'response', 'requirement', 'requirements',
  'multi-region', 'real-time', 'sub-second',
]);

function isGenericNoise(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (GENERIC_NOISE.has(normalized)) return true;
  if (
    !term.includes(' ') &&
    /^[a-z]+s$/.test(term) &&
    term.length <= 10 &&
    !TECH_PRODUCTS.has(normalized)
  ) {
    return true;
  }
  return false;
}

/**
 * Compromise 经常把"句首大写"的普通词识别为 proper noun：
 * "Boost the cash flow" → "Boost" 进入 candidates
 * "Forecast says ..." → "Forecast" 进入 candidates
 * "Soars in 2026" → "Soars" 进入 candidates
 * "Tech companies ..." → "Tech" 进入 candidates
 *
 * 这些词应该被翻译成中文（"提升"/"预测"/"飙升"/"科技"），但被
 * compromise 当成命名实体，污染了 glossary，最终导致模型把它们所在
 * 的整段回传为 no-op 翻译。
 *
 * 修复策略：单 capitalized 普通词（Boost/Forecast/Soars/Cash/Tech）
 * 出现在句首 + 不在白名单 + 出现次数 ≤ 1 → 当句首误识丢弃。
 *
 * 已知品牌（Anthropic/Microsoft/Google/Apple/...）即使在句首也保留。
 * 它们的 frequency 一般 ≥ 2 或命中下面白名单。
 *
 * 多词短语（"Goldman Sachs Research"）不受影响 — `term.includes(' ')`
 * 直接 return false 走绿色通道。
 */
const KNOWN_BRANDS_AT_SENTENCE_START = new Set([
  // Tech
  'Anthropic', 'Microsoft', 'Google', 'Apple', 'Amazon', 'Meta', 'Tesla',
  'Nvidia', 'Intel', 'Oracle', 'IBM', 'Adobe', 'Salesforce', 'Netflix',
  'Spotify', 'Uber', 'Airbnb', 'Twitter', 'Facebook', 'Linkedin',
  // AI companies / products
  'Openai', 'Deepseek', 'Claude', 'Gemini', 'Copilot', 'Cursor',
  // Frameworks
  'React', 'Vue', 'Angular', 'Svelte', 'Django', 'Flask', 'Rails',
  'Laravel', 'Symfony', 'Fastapi', 'Express', 'Koa', 'Nestjs',
  'Spring', 'Hibernate', 'Tomcat', 'Webpack', 'Vite', 'Rollup',
  'Babel', 'Eslint', 'Prettier', 'Jest', 'Mocha', 'Cypress', 'Playwright',
  'Puppeteer', 'Selenium',
  // Cloud / infra
  'Docker', 'Kubernetes', 'Postgres', 'Postgresql', 'Mysql', 'Redis',
  'Mongodb', 'Elasticsearch', 'Kafka', 'Rabbitmq', 'Nginx', 'Apache',
  'Terraform', 'Pulumi', 'Ansible', 'Puppet', 'Chef', 'Vagrant',
  // Tools
  'Github', 'Gitlab', 'Bitbucket', 'Jenkins', 'Circleci', 'Travis',
  'Datadog', 'Splunk', 'Pagerduty', 'Opsgenie',
  // 人物
  'Goldman', 'Sachs', 'Morgan', 'Stanley', 'Jpmorgan', 'Citigroup',
  'Schneider', 'Schroeder', 'Pichai', 'Nadella', 'Altman',
  // 中文网站中常见的英文专名
  'Asml', 'Tsmc', 'Samsung', 'Huawei', 'Tencent', 'Alibaba', 'Bytedance',
  'Baidu', 'Xiaomi',
  // 其他常见专名
  'S&P', 'Nasdaq', 'Nyse',
]);

function isSentenceStartMisident(term: string, fullText: string): boolean {
  // 只针对"单 capitalized 词"
  if (term.includes(' ')) return false;
  if (!/^[A-Z][a-z]+$/.test(term)) return false;

  // 已知品牌豁免
  if (KNOWN_BRANDS_AT_SENTENCE_START.has(term)) return false;
  if (KNOWN_BRANDS_AT_SENTENCE_START.has(term.toLowerCase())) return false;
  if (TECH_ANCHORS_LOWER.has(term.toLowerCase())) return false;
  if (TECH_PRODUCTS.has(term)) return false;
  if (TECH_PRODUCTS.has(term.toLowerCase())) return false;
  if (KNOWN_PUBLICATIONS.has(term.toLowerCase())) return false;

  // 检查 term 是否出现在句首 + 出现次数 <= 1（首次即句首）
  // 全词匹配，统计位置和次数
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchRe = new RegExp(
    `\\b${escaped}\\b`,
    'g',
  );
  const matches = fullText.match(matchRe) || [];

  if (matches.length >= 2) {
    // 出现 ≥ 2 次 → 大概率不是误识
    return false;
  }

  // 出现 ≤ 1 次，且这个 1 次正好在句首
  const sentenceStartRe = new RegExp(
    `(^|[.!?\\n]\\s*|\\A\\s*)${escaped}(?=\\s|$|[,;:])`,
  );
  return sentenceStartRe.test(fullText);
}

function isPhraseSubsuming(kept: string, term: string): boolean {
  if (!kept.includes(' ') && !term.includes(' ')) return false;

  if (kept.includes(' ') && !term.includes(' ')) {
    if (/^[A-Z]{2,}$/.test(term)) return false;
    // Don't let a longer phrase swallow a known tech product whose
    // canonical form would otherwise be the most useful glossary entry
    // (e.g. "Dbt helps" / "dbt project" must not subsume "dbt").
    if (TECH_PRODUCTS.has(term.toLowerCase())) return false;
    const re = new RegExp(`(?<=^|[^a-zA-Z0-9_])${escapeRegExp(term)}(?=[^a-zA-Z0-9_]|$)`, 'i');
    return re.test(kept);
  }

  if (kept.includes(' ') && term.includes(' ')) {
    return kept.toLowerCase().includes(term.toLowerCase());
  }

  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ACRONYM_BONUS = 1000;
const PROPER_NOUN_BONUS = 500;
const LENGTH_WEIGHT = 10;
const FREQUENCY_WEIGHT = 1;
const MAX_GLOSSARY_TERMS = 50;

function scoreTerm(term: string, fullText: string): number {
  if (/^[A-Z]{2,6}$/.test(term)) return ACRONYM_BONUS + term.length * LENGTH_WEIGHT;

  const hasUpper = /[A-Z]/.test(term);
  const startsUpper = /^[A-Z]/.test(term);
  if (hasUpper && (startsUpper || /[a-z]/.test(term))) {
    return PROPER_NOUN_BONUS + term.length * LENGTH_WEIGHT;
  }

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<=^|[^a-zA-Z0-9_])${escaped}(?=[^a-zA-Z0-9_]|$)`, 'gi');
  const occurrences = (fullText.match(regex) || []).length;
  return occurrences * FREQUENCY_WEIGHT + term.length * LENGTH_WEIGHT * 0.1;
}
