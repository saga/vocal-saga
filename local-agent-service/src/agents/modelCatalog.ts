/**
 * CodeBuddy 模型目录读取。
 *
 * CLI 的产品配置里带一份完整模型列表，每个模型有 `credits` 费率字段
 * （实际形态有三种："x0.00"、"x0.34 credits"、""）。本模块只做两件事：
 * 找到这份配置，以及按规则挑出「确认免费」的目标模型。
 *
 * 配置来源按可靠性排序：
 *   1. ACC_PRODUCT_CONFIG_PATH —— CLI 自己落盘的明文 JSON
 *   2. ~/.codebuddy/local_storage/*.info —— 缓存副本（两种编码都见过，见 decodeProductConfig）
 * 两者都拿不到时返回空数组，调用方回退到 CLI 运行时默认模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** 模型目录里的一条记录。未识别的字段不在此声明，避免把上游内部结构当成稳定契约。 */
export interface CatalogModel {
  id: string;
  /** 每单位用量消耗的 credits；0 表示免费，无法解析时为 null。 */
  credits: number | null;
  /** 物理输入 token 上限；不代表当前选择的上下文环预算。 */
  maxInputTokens?: number;
  /** 原样保留模型级档位元数据，由 config-options helper 做严格验证。 */
  contextWindow?: { supportedLengths?: unknown; defaultLength?: unknown };
}

/** 喂给 CLI 的上下文窗口档位选项，字段名与取值形态需要与 CLI 的 schema 完全一致。 */
export interface CodeBuddyContextWindowOption {
  type: 'select';
  id: 'context_window';
  name: 'Context window';
  description: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

/** 把数字或纯数字字符串收敛成正安全整数；其余一律返回 undefined，由调用方决定回落策略。 */
function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 将 token 数格式化为可读档位字符串：百万级用 M，千级用 K，其余显示完整数字+tokens。
 */
export function formatCodeBuddyContextWindow(tokens: number): string {
  if (tokens % 1_000_000 === 0) return String(tokens / 1_000_000) + 'M';
  if (tokens % 1_000 === 0) return String(tokens / 1_000) + 'K';
  return tokens.toLocaleString('en-US') + ' tokens';
}

/**
 * 归一化模型的 context window 配置：校验 supportedLengths 全为正整数且 <= maxInputTokens，
 * 至少 2 个档位；defaultLength 不合法时回退到最小档位。不满足则返回 undefined（不提供选择器）。
 */
export function normalizeCodeBuddyContextWindow(model: CatalogModel | null | undefined): {
  maxInputTokens: number; supportedLengths: number[]; defaultLength: number;
} | undefined {
  const maxInputTokens = positiveInteger(model?.maxInputTokens);
  const rawLengths = model?.contextWindow && typeof model.contextWindow === 'object'
    ? model.contextWindow.supportedLengths
    : undefined;
  if (!maxInputTokens || !Array.isArray(rawLengths)) return undefined;
  const parsed = rawLengths.map(positiveInteger);
  if (parsed.some((value) => value === undefined)) return undefined;
  const supportedLengths = [...new Set(parsed as number[])].sort((a, b) => a - b);
  if (supportedLengths.length < 2 || supportedLengths.some((length) => length > maxInputTokens)) return undefined;
  const configuredDefault = positiveInteger(model?.contextWindow?.defaultLength);
  const defaultLength = configuredDefault !== undefined && supportedLengths.includes(configuredDefault)
    ? configuredDefault
    : supportedLengths[0]!;
  return { maxInputTokens, supportedLengths, defaultLength };
}

/**
 * 校验 requested 是否为该模型支持的 context window 档位；合法返回该值，否则 undefined。
 */
export function resolveCodeBuddyContextWindow(
  model: CatalogModel | null | undefined,
  requested: unknown,
): number | undefined {
  const config = normalizeCodeBuddyContextWindow(model);
  const value = positiveInteger(requested);
  if (!config || value === undefined || !config.supportedLengths.includes(value) || value > config.maxInputTokens) {
    return undefined;
  }
  return value;
}

/**
 * 生成前端可渲染的 context window 选择器；无有效配置时返回 undefined。
 */
export function getCodeBuddyContextWindowOption(
  model: CatalogModel | null | undefined,
  currentValue?: unknown,
): CodeBuddyContextWindowOption | undefined {
  const config = normalizeCodeBuddyContextWindow(model);
  if (!config) return undefined;
  const selected = resolveCodeBuddyContextWindow(model, currentValue) ?? config.defaultLength;
  return {
    type: 'select',
    id: 'context_window',
    name: 'Context window',
    description: 'Select the context budget for this model. The model input-token limit remains unchanged.',
    currentValue: String(selected),
    options: config.supportedLengths.map((tokens) => ({
      value: String(tokens),
      name: formatCodeBuddyContextWindow(tokens),
    })),
  };
}

/**
 * 自动选模型的一条偏好规则。
 *
 * `credits` 是价格闸门：写了就必须**精确等于**该值才采用，省略则不限制价格。
 * 闸门的作用是防止厂商调价后悄悄换成更贵的档位 —— 例如 deepseek-v4.1-flash 只在 0.08 时用，
 * 一旦涨到 0.11 就跳过，继续往后退。
 */
export interface PreferredModel {
  id: string;
  credits?: number;
}

/**
 * 偏好顺序，逐个退让。
 *
 * 选型依据是「够快 + 够便宜」，不再强求免费：
 *   - glm-5.3-flash 0.06 credits，目前最快的廉价档，做文档翻译的主模型；
 *   - deepseek-v4.1-flash 0.08 credits，速度接近，价格被闸门锁死；
 *   - deepseek-v4.1-flash / step-5-preview 作为免费的兜底（deepseek 有时会变成 0.11，那就跳过）。
 * hy3 曾经是免费兜底，但实测太慢（单轮 5s 起步、冷启动 40s+），已从表里移除。
 */
export const PREFERRED_MODELS: readonly PreferredModel[] = [
  { id: 'deepseek-v4.1-flash', credits: 0 },
  { id: 'glm-5.3-flash' },
  { id: 'hy3' },
];

/** 偏好表第一位，便于日志和测试引用。 */
export const PREFERRED_WORKBUDDY_MODEL = PREFERRED_MODELS[0]!.id;

/** 兜底模型 hy3 允许作为 fallback；不再全局排除。 */
const EXCLUDED_MODELS = new Set<string>();

/**
 * 解析 credits 字段。
 *
 * 真实取值：`"x0.00"`（免费）、`"x0.34 credits"`（带单位）、`""`（未填，如 default-model）。
 * 只有能确定解析出数字时才算数 —— 空串和未知格式返回 null，避免把「没填」误判成「免费」。
 */
export function parseCredits(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^x?\s*(-?\d+(?:\.\d+)?)/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 从产品配置对象里抽取模型列表；结构不符时返回空数组。 */
function modelsFromConfig(raw: unknown): CatalogModel[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: any) => {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) return [];
    const maxInputTokens = positiveInteger(item.maxInputTokens);
    const contextWindow = item.contextWindow && typeof item.contextWindow === 'object' && !Array.isArray(item.contextWindow)
      ? { supportedLengths: item.contextWindow.supportedLengths, defaultLength: item.contextWindow.defaultLength }
      : undefined;
    return [{
      id,
      credits: parseCredits(item.credits),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    }];
  });
}

/**
 * 把一份缓存文本解成模型列表。
 *
 * local_storage 的编码形态随 CLI 版本变过，两种都得认：
 *   1. 明文产品配置 JSON —— `{"$schema":"product-schema.json","models":[...]}`
 *   2. JSON 字符串 → base64 → gzip → 产品配置 JSON（更早的写法）
 * 2026-10-18 就踩过：新版把产品配置直接明文落盘，旧解码器一律抛「incorrect header check」，
 * 结果整份目录读成空数组，自动选模型静默失效。
 */
function decodeProductConfig(text: string): CatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const direct = modelsFromConfig(parsed);
  if (direct.length) return direct;
  if (typeof parsed !== 'string') return [];
  try {
    const decoded = zlib.gunzipSync(Buffer.from(parsed, 'base64')).toString('utf8');
    return modelsFromConfig(JSON.parse(decoded));
  } catch {
    return [];
  }
}

/** 从 `ACC_PRODUCT_CONFIG_PATH` 指向的产品配置文件读模型目录；未配置或读取失败都返回空表。 */
function readFromEnvPath(): CatalogModel[] {
  const file = (process.env.ACC_PRODUCT_CONFIG_PATH || '').trim();
  if (!file) return [];
  try {
    return decodeProductConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** 扫描 CodeBuddy 本地 storage 目录，按 mtime 从新到旧逐个尝试解析出模型目录。 */
function readFromLocalStorage(dirOverride?: string): CatalogModel[] {
  const dir = dirOverride || path.join(os.homedir(), '.codebuddy', 'local_storage');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // 按 mtime 从新到旧全量尝试，不设固定窗口。
  // 曾按「最近 6 份」截断，结果 CLI 一次刷新写入 4 个非产品配置的缓存条目，
  // 把真正的产品配置挤出窗口，目录读空 —— 而漏读的代价是整个自动选模型失效，
  // 多读几个文件的代价只是一次 JSON.parse，不值得为省这点开销引入随机失效。
  const files = names
    .filter((name) => name.endsWith('.info'))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { full: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { full } of files) {
    try {
      const models = decodeProductConfig(fs.readFileSync(full, 'utf8').trim());
      if (models.length) return models;
    } catch {
      // 不是产品配置、或文件正在被写 —— 继续试下一份
    }
  }
  return [];
}

/**
 * 读取模型目录；拿不到时返回空数组（不抛错，调用方据此回退）。
 * `localStorageDir` 仅供测试注入，生产调用不传。
 */
function readModelsJson(filePath: string | undefined): CatalogModel[] {
  if (!filePath) return [];
  try {
    return modelsFromConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    // models.json 缺失或格式不对，都不能把模型目录搞挂。
    return [];
  }
}

/** 合并两份目录：按 id 覆盖，overrides 优先，但 credits 允许从 base 继承（见下方注释）。 */
function mergeCatalog(base: readonly CatalogModel[], overrides: readonly CatalogModel[]): CatalogModel[] {
  const merged = new Map<string, CatalogModel>(base.map((model): [string, CatalogModel] => [model.id, model]));
  for (const override of overrides) {
    const previous = merged.get(override.id);
    merged.set(override.id, {
      ...previous,
      ...override,
      // models.json 常常不写 credits；这种情况下沿用产品目录里的价格。
      credits: override.credits ?? previous?.credits ?? null,
    });
  }
  return [...merged.values()];
}

/**
 * 先读产品目录，再按 CodeBuddy 文档写明的优先级套用 models.json：
 * 内置/产品默认 < 用户 ~/.codebuddy/models.json < 项目 .codebuddy/models.json。
 * projectRoot 就是传给 SDK 的 cwd；路径可注入，便于测试。
 */
export function readModelCatalog(options: {
  localStorageDir?: string;
  userModelsPath?: string;
  projectRoot?: string;
} = {}): CatalogModel[] {
  const fromEnv = readFromEnvPath();
  const base = fromEnv.length ? fromEnv : readFromLocalStorage(options.localStorageDir);
  const userModelsPath = options.userModelsPath ?? path.join(os.homedir(), '.codebuddy', 'models.json');
  const userModels = readModelsJson(userModelsPath);
  const projectModels = options.projectRoot
    ? readModelsJson(path.join(options.projectRoot, '.codebuddy', 'models.json'))
    : [];
  return mergeCatalog(mergeCatalog(base, userModels), projectModels);
}

/**
 * 从目录里挑模型：按 PREFERRED_MODELS 的顺序找第一个「在目录里、且满足价格闸门」的。
 *
 * 这里**不再**要求「目录里必须存在 gpt-* 才算完整目录」。那个判据来自早期实现，
 * 用某个厂商的模型是否下发来反推目录完整性；一旦该厂商整批下线（2026-10-18 就发生过，
 * gpt-* 全部消失、deepseek 也变成 0.11 credits），完整目录会被误判成残缺目录，
 * 结果一个模型都选不出来。credits 本身已经是价格的直接证据，
 * 不需要再借道第三方模型来间接证明。
 *
 * 偏好表全部落空时退到「目录里第一个免费的」（排除 EXCLUDED_MODELS）；
 * 连免费模型都没有才返回 null（不猜、不硬编码），由调用方回退 CLI 默认模型。
 */
export function pickPreferredWorkbuddyModel(catalog: readonly CatalogModel[]): string | null {
  for (const rule of PREFERRED_MODELS) {
    const hit = catalog.find((model) => model.id === rule.id
      && (rule.credits === undefined || model.credits === rule.credits));
    if (hit) return hit.id;
  }
  // 兜底：目录顺序即产品侧的推荐顺序，取第一个确认免费且没被排除的。
  const free = catalog.filter((model) => model.credits === 0 && !EXCLUDED_MODELS.has(model.id));
  return free.length ? free[0]!.id : null;
}

/**
 * 把「显式配置」与「目录挑选」合成最终的默认模型。
 *
 * `auto` 必须当成「没配置」：扩展侧默认就发 model: "auto"，用户也习惯这么写。
 * 若把它原样当成模型 id，下游 parseAgentModel 会把 'auto' 归一成空串，
 * 于是 CLI 拿不到 --model，静默回退到账号默认模型（计费、且未必支持 json-schema），
 * 表面上一切正常，实际每次调用都在用错模型。空值同理。
 */
export function resolveWorkbuddyModel(
  explicit: string | undefined,
  catalog: readonly CatalogModel[],
): string {
  const value = (explicit || '').trim();
  if (value && value.toLowerCase() !== 'auto') return value;
  return pickPreferredWorkbuddyModel(catalog) || '';
}
