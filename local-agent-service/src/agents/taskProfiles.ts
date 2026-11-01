/**
 * Explicit CodeBuddy execution profiles for translation and book-analysis tasks.
 * Only SDK-supported settings are emitted; deprecated maxThinkingTokens and undocumented
 * effort CLI flags are intentionally not used.
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
  /** Optional SDK model ID override for this task. */
  model: string;
  /** Optional context-window tier (token count), omitted to preserve model defaultLength. */
  contextWindow?: number;
  /** Optional SDK fallbackModel used when the preferred model is unavailable. */
  fallbackModel: string;
  thinkingMode: CodeBuddyThinkingMode;
  /** Used only when thinkingMode='enabled'. */
  thinkingBudgetTokens: number;
  effort: CodeBuddyEffort;
  /** Added before built-in/mandatory instructions, so host contracts stay later in the prompt. */
  systemPromptAppendix: string;
  /** Wraps the service-generated task input using {{CONTENT}}; omitted means the built-in input is used. */
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

/** Merge partial/old stored settings with explicit task defaults and hard bounds. */
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

/** Get an effective profile from either the UI's taskProfiles object or a legacy request body. */
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
 * Apply task prompt fields without replacing the service's mandatory output/security contracts.
 * The user template receives the complete built-in task input; absent {{CONTENT}} is appended
 * rather than silently dropping the actual task payload.
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

/** Convert the persisted profile to the official SDK's thinking option. */
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
