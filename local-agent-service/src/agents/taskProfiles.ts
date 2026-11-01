/**
 * 翻译与书籍分析任务使用的 CodeBuddy 执行档案。
 * 只下发 SDK 支持过的设置；已弃用的 maxThinkingTokens
 * 与未文档化的 effort CLI 参数，刻意都不用。
 */
export type CodeBuddyTaskKey =
  | 'translation'
  | 'accuracyReview'
  | 'styleReview'
  | 'literaryAnalysis'
  | 'contextGraph';

export type CodeBuddyThinkingMode = 'disabled' | 'adaptive' | 'enabled';
export type CodeBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CodeBuddyTaskProfile {
  /** 可选：为该任务覆盖 SDK 模型 ID。 */
  model: string;
  /** 可选的上下文窗口档位（token 数）；不填则沿用模型的 defaultLength。 */
  contextWindow?: number;
  /** 可选：首选模型不可用时使用的 SDK fallbackModel。 */
  fallbackModel: string;
  thinkingMode: CodeBuddyThinkingMode;
  /** 只在 thinkingMode='enabled' 时使用。 */
  thinkingBudgetTokens: number;
  effort: CodeBuddyEffort;
  /** 加在内置与强制指令之前，因此宿主契约仍排在提示词靠后位置。 */
  systemPromptAppendix: string;
  /** 用 {{CONTENT}} 包裹服务端生成的任务输入；不填则使用内置输入。 */
  userPromptTemplate: string;
}

export type CodeBuddyTaskProfiles = Record<CodeBuddyTaskKey, CodeBuddyTaskProfile>;

const common = {
  model: '',
  fallbackModel: 'hy3',
  thinkingBudgetTokens: 8192,
  systemPromptAppendix: '',
  userPromptTemplate: '',
};

export const DEFAULT_CODEBUDDY_TASK_PROFILES: CodeBuddyTaskProfiles = {
  translation: {
    ...common,
    model: 'deepseek-v4.1-flash',
    fallbackModel: 'hy3',
    thinkingMode: 'disabled',
    effort: 'low',
  },
  accuracyReview: {
    ...common,
    model: 'deepseek-v4.1-flash',
    fallbackModel: 'hy3',
    thinkingMode: 'adaptive',
    effort: 'medium',
  },
  styleReview: {
    ...common,
    model: 'deepseek-v4.1-flash',
    fallbackModel: 'hy3',
    thinkingMode: 'adaptive',
    effort: 'high',
  },
  literaryAnalysis: {
    ...common,
    model: 'glm-5.3-flash',
    fallbackModel: 'hy3',
    thinkingMode: 'adaptive',
    effort: 'high',
  },
  contextGraph: {
    ...common,
    model: 'glm-5.3-flash',
    fallbackModel: 'hy3',
    thinkingMode: 'adaptive',
    effort: 'high',
  },
};

const validThinkingModes = new Set<CodeBuddyThinkingMode>(['disabled', 'adaptive', 'enabled']);
const validEfforts = new Set<CodeBuddyEffort>(['low', 'medium', 'high', 'xhigh']);

function text(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().slice(0, maxLength);
  return normalized.toLowerCase() === 'auto' ? '' : normalized;
}

/** 把不完整或旧版存储的设置，与任务的显式默认值和硬边界合并。 */
export function normalizeCodeBuddyTaskProfile(
  input: unknown,
  task: CodeBuddyTaskKey,
): CodeBuddyTaskProfile {
  const defaults = DEFAULT_CODEBUDDY_TASK_PROFILES[task];
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const thinkingMode = typeof raw.thinkingMode === 'string' && validThinkingModes.has(raw.thinkingMode as CodeBuddyThinkingMode)
    ? raw.thinkingMode as CodeBuddyThinkingMode
    : defaults.thinkingMode;
  const effort = typeof raw.effort === 'string' && validEfforts.has(raw.effort as CodeBuddyEffort)
    ? raw.effort as CodeBuddyEffort
    : defaults.effort;
  const budgetValue = typeof raw.thinkingBudgetTokens === 'number' || typeof raw.thinkingBudgetTokens === 'string'
    ? Number(raw.thinkingBudgetTokens)
    : defaults.thinkingBudgetTokens;
  const thinkingBudgetTokens = Number.isFinite(budgetValue)
    ? Math.max(1024, Math.min(65536, Math.round(budgetValue)))
    : defaults.thinkingBudgetTokens;
  const contextWindowRaw = raw.contextWindow;
  const contextWindowValue = typeof contextWindowRaw === 'number'
    ? contextWindowRaw
    : typeof contextWindowRaw === 'string' && /^\d+$/.test(contextWindowRaw.trim())
      ? Number(contextWindowRaw.trim())
      : Number.NaN;
  const contextWindow = Number.isSafeInteger(contextWindowValue) && contextWindowValue > 0
    ? contextWindowValue
    : undefined;
  return {
    model: text(raw.model, 200),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    fallbackModel: text(raw.fallbackModel, 200),
    thinkingMode,
    thinkingBudgetTokens,
    effort,
    systemPromptAppendix: text(raw.systemPromptAppendix, 12000),
    userPromptTemplate: text(raw.userPromptTemplate, 30000),
  };
}

/**
 * 将外部配置归一化为五类任务（translation/accuracyReview/styleReview/literaryAnalysis/contextGraph）的完整 profile，
 * 缺失项按 normalizeCodeBuddyTaskProfile 回退到默认值。
 */
export function normalizeCodeBuddyTaskProfiles(input: unknown): CodeBuddyTaskProfiles {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    translation: normalizeCodeBuddyTaskProfile(raw.translation, 'translation'),
    accuracyReview: normalizeCodeBuddyTaskProfile(raw.accuracyReview, 'accuracyReview'),
    styleReview: normalizeCodeBuddyTaskProfile(raw.styleReview, 'styleReview'),
    literaryAnalysis: normalizeCodeBuddyTaskProfile(raw.literaryAnalysis, 'literaryAnalysis'),
    contextGraph: normalizeCodeBuddyTaskProfile(raw.contextGraph, 'contextGraph'),
  };
}

/**
 * 从 UI taskProfiles 或旧版 request body 中取出指定任务的 profile，并归一化。
 * 兼容 root.taskProfiles 与 root.taskProfile 两种传入形态。
 */
export function getCodeBuddyTaskProfile(input: unknown, task: CodeBuddyTaskKey): CodeBuddyTaskProfile {
  const root = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const profiles = root.taskProfiles && typeof root.taskProfiles === 'object' && !Array.isArray(root.taskProfiles)
    ? root.taskProfiles as Record<string, unknown>
    : root;
  return normalizeCodeBuddyTaskProfile(profiles[task] ?? root.taskProfile, task);
}

/**
 * 应用任务提示词字段，但不替换服务端强制要求的输出与安全契约。
 * 用户模板拿到的是完整的内置任务输入；模板里没有 {{CONTENT}} 时，
 * 就把实际任务负载追加在后面，绝不静默丢弃。
 */
export function applyCodeBuddyTaskPrompt(
  prompt: string,
  systemPrompt: string,
  profile: CodeBuddyTaskProfile,
): { prompt: string; systemPrompt: string } {
  let effectivePrompt = prompt;
  const template = profile.userPromptTemplate.trim();
  if (template) {
    effectivePrompt = template.includes('{{CONTENT}}')
      ? template.replaceAll('{{CONTENT}}', prompt)
      : template + '\n\n' + prompt;
  }
  const appendix = profile.systemPromptAppendix.trim();
  return {
    prompt: effectivePrompt,
    systemPrompt: appendix
      ? ['TASK-SPECIFIC SUPPLEMENTAL INSTRUCTIONS (do not override the task contract below):', appendix, systemPrompt]
          .filter(Boolean).join('\n\n')
      : systemPrompt,
  };
}

/** 把持久化的档案转成官方 SDK 的 thinking 选项。 */
export function codeBuddyThinkingOption(profile: CodeBuddyTaskProfile): Record<string, unknown> {
  if (profile.thinkingMode === 'disabled') return { type: 'disabled' };
  if (profile.thinkingMode === 'enabled') {
    return { type: 'enabled', budgetTokens: profile.thinkingBudgetTokens };
  }
  return { type: 'adaptive' };
}

/**
 * 本次调用真正会用的模型名。
 *
 * runner 会在调用前把 agent.model 换成 taskProfile.model，但审计事件记录的是换之前的
 * agent.model（= 池默认模型），于是日志里写着一个模型、实际跑的是另一个。排查速度时
 * 这条会直接把人带偏，所以所有 usage / prompt 事件都必须用这个函数取值。
 */
export function resolveEffectiveTaskModel(baseModel: unknown, profile?: CodeBuddyTaskProfile): string {
  const override = String(profile?.model || '').trim();
  if (override && override.toLowerCase() !== 'auto') return override;
  const base = String(baseModel || '').trim();
  return base || '<runtime-default>';
}
