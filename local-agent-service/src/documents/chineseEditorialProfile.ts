import { createHash } from 'node:crypto';
import { ANALYSIS_TIMEOUT_MS } from '../config.ts';
import { parseAgentModel } from '../json.ts';
import { runAgentStructured } from '../agents/runner.ts';
import { getCodeBuddyTaskProfile } from '../agents/taskProfiles.ts';
import { planBookSamples, type BookScanSegment } from './bookScan.ts';
import { getDocumentProjectStore } from './projectStore.ts';

const ANALYSIS_VERSION = 'chinese-editorial-profile-v1';
const activeAnalyses = new Map<string, Promise<void>>();

const PROFILE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'observations'],
  properties: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'rules', 'avoid'],
      properties: {
        narrativeVoice: { type: 'string' },
        register: { type: 'string' },
        rhythm: { type: 'string' },
        dialogue: { type: 'string' },
        diction: { type: 'string' },
        rules: { type: 'array', items: { type: 'string' } },
        avoid: { type: 'array', items: { type: 'string' } },
      },
    },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aspect', 'segmentId', 'targetExcerpt', 'observation'],
        properties: {
          aspect: { type: 'string', enum: ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'consistency'] },
          segmentId: { type: 'string' },
          targetExcerpt: { type: 'string' },
          observation: { type: 'string' },
        },
      },
    },
  },
};

type ProfileStore = ReturnType<typeof getDocumentProjectStore>;
type AcceptedRow = {
  id: string; ordinal: number; sourceText: string; kind: string; contextPath: string; targetText: string;
};
type ProfileSample = { segmentId: string; targetText: string };
type ProfileEvidenceRef = { segmentId: string; targetExcerpt: string; observation: string; aspect: string };
type GeneratedProfile = { profile: Record<string, any>; evidenceRefs: ProfileEvidenceRef[] };

/** 通过门禁后仍需的信息：Store、运行上下文、来源修订号与增量查询句柄。 */
type ProfileRefreshContext = {
  store: ProfileStore;
  context: ReturnType<ProfileStore['getRunContext']>;
  run: Record<string, any>;
  db: any;
  revisionId: string;
};

function cleanText(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    const text = cleanText(item, maxChars);
    return text ? [text] : [];
  }))).slice(0, maxItems);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export type ChineseEditorialProfileReviewAction = 'reject';

/**
 * 应用中文编辑档案的人工审核动作。当前仅支持 'reject'（停用），将档案标记为 rejected 并清除确认信息。
 * 任何其它 action 抛错，因为档案默认启用、无需确认。
 */
export function applyChineseEditorialProfileReview(
  profile: Record<string, any> | null | undefined,
  action: ChineseEditorialProfileReviewAction,
  _currentSourceRevisionId: string,
  _now = new Date().toISOString(),
): Record<string, any> {
  if (action !== 'reject') throw new Error('中文文学编辑档案默认启用；只允许明确停用/拒绝，不需要确认。');
  return { ...profile, status: 'rejected', confirmationSource: undefined, confirmedAt: undefined };
}

/**
 * Build a book-level Chinese target voice from accepted translations only.
 * Source text is used locally for deterministic sample selection and is never placed in the model prompt.
 *
 * 从已采纳译文构建书级中文目标语表达档案：校验运行模式/语言/来源版本，查询采纳样本，
 * 确定性抽样，调用模型归纳风格档案，证据校验后自动采纳/更新 LiteraryMemory。
 * 样本指纹 unchanged 或用户拒绝/用户管理时跳过。
 */
export async function refreshChineseEditorialProfile(projectId: string, runId: string): Promise<void> {
  const ctx = resolveProfileRefreshContext(projectId, runId);
  if (!ctx) return;
  const { store } = ctx;

  const selection = selectProfileSamples(store, projectId, runId, loadAcceptedSampleRows(ctx.db, ctx.revisionId));
  if (!selection) return;
  const { samples, chapterCount, acceptedCount } = selection;

  const sampleFingerprint = fingerprint({
    revisionId: ctx.revisionId,
    samples: samples.map((sample) => [sample.segmentId, sample.targetText]),
  });
  if (isProfileRefreshRedundant(store, projectId, runId, ctx.revisionId, sampleFingerprint)) return;

  const agent = parseAgentModel(String(ctx.run.model || 'auto'), String(ctx.run.provider || 'workbuddy'));
  const rawTaskProfile = getCodeBuddyTaskProfile(ctx.context.prompt?.config || {}, 'styleReview');
  // A profile-generation task uses the configured model/effort, but not a user-authored style-review
  // template that may contain instructions for segment-level findings.
  const taskProfile = { ...rawTaskProfile, userPromptTemplate: '', systemPromptAppendix: '' };
  const { prompt, systemPrompt } = buildProfilePrompts(samples);

  store.appendEvent(projectId, runId, 'chinese-editorial-profile.analysis.started', {
    analysisVersion: ANALYSIS_VERSION,
    acceptedSegmentCount: acceptedCount,
    selectedSampleCount: samples.length,
    chapterCount,
    sampleFingerprint,
    provider: agent.provider,
    model: agent.model || '<runtime-default>',
  });
  const startedAt = Date.now();
  const result = await runAgentStructured(
    agent,
    prompt,
    systemPrompt,
    PROFILE_SCHEMA,
    'chinese-editorial-profile:' + ctx.revisionId + ':' + sampleFingerprint.slice(0, 12),
    'document:' + projectId + ':chinese-editorial-profile:' + ctx.revisionId,
    taskProfile,
    { timeoutMs: ANALYSIS_TIMEOUT_MS },
  );

  await adoptGeneratedProfile({
    store, projectId, runId,
    revisionId: ctx.revisionId,
    generated: parseGeneratedProfile(result.result, samples),
    sampleFingerprint,
    sampleCount: samples.length,
    chapterCount,
    startedAt,
    usage: result.usage || null,
  });
}

/**
 * 门禁：只有中文文学模式的 Run 才生成档案，且 Run 的来源修订必须仍是项目的当前修订。
 * 返回 null 表示本次不生成（已经记录了跳过原因）。
 */
function resolveProfileRefreshContext(projectId: string, runId: string): ProfileRefreshContext | null {
  const store = getDocumentProjectStore();
  const context = store.getRunContext(projectId, runId);
  const run = context.run as Record<string, any>;
  if (run.translationMode !== 'literary' || !/^zh(?:-|$)/iu.test(String(run.targetLang || 'zh'))) return null;

  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const revisionId = String(run.sourceRevisionId || '');
  if (!revisionId || revisionId !== currentSourceRevisionId) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'source-revision-mismatch',
      runSourceRevisionId: revisionId,
      currentSourceRevisionId,
    });
    return null;
  }
  return { store, context, run, db, revisionId };
}

/** 每个片段只取最新一条、且来源哈希与当前原文一致的已采纳译文。 */
function loadAcceptedSampleRows(db: any, revisionId: string): AcceptedRow[] {
  return db.prepare(
    'SELECT s.segment_id AS id, s.ordinal, s.text AS sourceText, s.kind, s.context_path AS contextPath, ' +
      'tr.translation_text AS targetText ' +
    'FROM source_segments s JOIN translation_results tr ' +
      'ON tr.source_revision_id = s.source_revision_id AND tr.segment_id = s.segment_id ' +
    'WHERE s.source_revision_id = ? AND tr.accepted = 1 AND tr.source_hash = s.source_hash ' +
      'AND tr.rowid = (SELECT latest.rowid FROM translation_results latest ' +
        'WHERE latest.source_revision_id = s.source_revision_id AND latest.segment_id = s.segment_id ' +
          'AND latest.accepted = 1 AND latest.source_hash = s.source_hash ' +
        'ORDER BY COALESCE(latest.accepted_at, latest.created_at) DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1) ' +
    'ORDER BY s.ordinal'
  ).all(revisionId) as AcceptedRow[];
}

/**
 * 样本量下限：单章至少要 8 段，跨章可以少到 8 段的同一口径。
 * 抽样后再要求 8 段有非空译文，否则模型看不到足够的连续文本，规则必然泛化。
 */
function selectProfileSamples(
  store: ProfileStore,
  projectId: string,
  runId: string,
  rows: AcceptedRow[],
): { samples: ProfileSample[]; chapterCount: number; acceptedCount: number } | null {
  const distinctChapters = new Set(rows.map((row) => row.contextPath).filter(Boolean));
  if (rows.length < 8 || (distinctChapters.size < 2 && rows.length < 12)) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'insufficient-accepted-samples',
      acceptedSegmentCount: rows.length,
      chapterCount: distinctChapters.size || (rows.length ? 1 : 0),
      minimumAcceptedSegments: distinctChapters.size < 2 ? 12 : 8,
    });
    return null;
  }

  const sourceSamples: BookScanSegment[] = rows.map((row) => ({
    id: String(row.id),
    ordinal: Number(row.ordinal),
    text: String(row.sourceText || ''),
    kind: String(row.kind || 'paragraph'),
    contextPath: String(row.contextPath || ''),
  }));
  const samplePlan = planBookSamples(sourceSamples, undefined, 24);
  const targetById = new Map(rows.map((row) => [String(row.id), String(row.targetText || '')]));
  const samples = samplePlan.samples.flatMap(({ segment }) => {
    const targetText = targetById.get(segment.id) || '';
    return targetText.trim() ? [{ segmentId: segment.id, targetText: targetText.slice(0, 1600) }] : [];
  });
  if (samples.length < 8) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'book-scan-sample-coverage-too-small',
      acceptedSegmentCount: rows.length,
      selectedSampleCount: samples.length,
    });
    return null;
  }
  return { samples, chapterCount: distinctChapters.size || 1, acceptedCount: rows.length };
}

/**
 * 已采纳样本没变就不必再调模型：同指纹的生效档案、同指纹的待采纳更新、或同指纹同版本号的候选档案，
 * 都视为「本次分析不会产生新信息」。
 */
function isProfileRefreshRedundant(
  store: ProfileStore,
  projectId: string,
  runId: string,
  revisionId: string,
  sampleFingerprint: string,
): boolean {
  const existing = store.getCurrentLiteraryMemory(projectId).memory.chineseEditorialProfile;
  if (existing?.status === 'confirmed' && existing.sourceRevisionId === revisionId &&
      (existing.sampleFingerprint === sampleFingerprint ||
       existing.pendingUpdate?.sampleFingerprint === sampleFingerprint)) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: existing.sampleFingerprint === sampleFingerprint
        ? 'confirmed-profile-sample-unchanged' : 'same-pending-update-already-exists',
      profileFingerprint: existing.sampleFingerprint || null,
      pendingUpdateFingerprint: existing.pendingUpdate?.sampleFingerprint || null,
    });
    return true;
  }
  if (existing?.status === 'candidate' && existing.sourceRevisionId === revisionId &&
      existing.sampleFingerprint === sampleFingerprint && existing.analysisVersion === ANALYSIS_VERSION) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'same-sample-profile-already-exists',
      sampleFingerprint,
    });
    return true;
  }
  return false;
}

/** 提示只含中文译文：不给原文，避免模型把翻译判断混进风格归纳。 */
function buildProfilePrompts(samples: ProfileSample[]): { prompt: string; systemPrompt: string } {
  const prompt = [
    '任务：从一组已经由用户采纳的中文文学译文中，归纳这本书稳定的中文目标语表达档案。',
    '输入只有中文译文，不提供外文原文。不要推断剧情事实、人物身份、作者国籍或翻译策略。',
    '只描述文本中可观察到的中文叙述声音、语域、句法节奏、对白习惯、词汇倾向和跨样本一致性。',
    '区分稳定特征与偶发表达；不要把单个句子的选择泛化成全书规则。',
    '规则应可执行、简洁、可用于后续章节的中文编辑；不要强行要求句子变短、减少重复或统一所有人物声音。',
    'observations 必须引用输入样本中真实存在的连续中文片段，并使用对应 segmentId。至少提供 3 条来自不同 segment 的证据。',
    '只返回符合 JSON Schema 的结果。',
    '已采纳中文样本：',
    JSON.stringify(samples.map((sample) => ({ segmentId: sample.segmentId, chineseText: sample.targetText }))),
  ].join('\n\n');
  const systemPrompt = [
    '你是中文文学编辑档案分析员，不是翻译员，也不是改写器。',
    '所有输入均为用户已采纳的中文译文。把它们视为观察材料，不要修改或重写样本。',
    '不得虚构证据。每条 observation 的 targetExcerpt 必须逐字连续出现在其 segmentId 对应的中文样本中。',
    '输出的 profile 只能包含中文目标语风格规范，不能包含原文、源语言名称、剧情摘要或人物事实。',
    '不确定的维度留空，不要为了填满字段而编造规则。',
  ].join('\n');
  return { prompt, systemPrompt };
}

/**
 * 输出清洗：字段裁剪到有界长度，证据逐条回到样本里核对原文连续出现。
 * 空档案直接抛错——宁可整轮失败，也不要让一条只有空规则的档案被当成全书规范。
 */
function parseGeneratedProfile(raw: unknown, samples: ProfileSample[]): GeneratedProfile {
  const output = raw as Record<string, any>;
  const profileInput = output?.profile && typeof output.profile === 'object' ? output.profile : {};
  const profile = {
    narrativeVoice: cleanText(profileInput.narrativeVoice, 1000),
    register: cleanText(profileInput.register, 1000),
    rhythm: cleanText(profileInput.rhythm, 1000),
    dialogue: cleanText(profileInput.dialogue, 1000),
    diction: cleanText(profileInput.diction, 1000),
    rules: cleanList(profileInput.rules, 16, 240),
    avoid: cleanList(profileInput.avoid, 12, 240),
  };
  const sampleById = new Map(samples.map((sample) => [sample.segmentId, sample.targetText]));
  const evidenceRefs: ProfileEvidenceRef[] = (Array.isArray(output?.observations) ? output.observations : []).flatMap((item: any) => {
    const segmentId = cleanText(item?.segmentId, 160);
    const targetExcerpt = cleanText(item?.targetExcerpt, 240);
    const observation = cleanText(item?.observation, 240);
    const aspect = ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'consistency'].includes(String(item?.aspect))
      ? String(item.aspect) : '';
    const sample = sampleById.get(segmentId);
    return sample && targetExcerpt.length >= 4 && sample.includes(targetExcerpt) && observation && aspect
      ? [{ segmentId, targetExcerpt, observation, aspect }]
      : [];
  }).filter((item, index, all) =>
    all.findIndex((other) => other.segmentId === item.segmentId && other.targetExcerpt === item.targetExcerpt) === index
  ).slice(0, 24);
  if (!Object.values(profile).some((value) => Array.isArray(value) ? value.length > 0 : !!value)) {
    throw new Error('中文 Editorial Profile 输出缺少可用的风格内容。');
  }
  return { profile, evidenceRefs };
}

/**
 * 采纳决策：分析期间用户可能已经拒绝或手改过档案，因此必须重新读取记忆再判定。
 * 用户拒绝 → 保持停用；用户管理 → 用户优先；已有生效档案 → 转成待采纳更新并递增版本；
 * 否则首次生成直接生效。所有分支都以事件留痕。
 */
async function adoptGeneratedProfile(args: {
  store: ProfileStore;
  projectId: string;
  runId: string;
  revisionId: string;
  generated: GeneratedProfile;
  sampleFingerprint: string;
  sampleCount: number;
  chapterCount: number;
  startedAt: number;
  usage: unknown;
}): Promise<void> {
  const { store, projectId, runId, revisionId, generated, sampleFingerprint, startedAt } = args;
  const { profile, evidenceRefs } = generated;
  const evidenceSegmentCount = new Set(evidenceRefs.map((item) => item.segmentId)).size;

  // Reload after the model call. Preserve user-managed profiles; replace machine-default profiles automatically.
  const latest = store.getCurrentLiteraryMemory(projectId);
  const latestProfile = latest.memory.chineseEditorialProfile;
  const generatedAt = new Date().toISOString();
  const candidate = {
    version: 1,
    status: 'confirmed',
    confirmationSource: 'model-default',
    sourceRevisionId: revisionId,
    analysisVersion: ANALYSIS_VERSION,
    sampleFingerprint,
    sampleCount: args.sampleCount,
    chapterCount: args.chapterCount,
    generatedAt,
    profile,
    evidenceRefs,
  };
  if (latestProfile?.status === 'rejected' && latestProfile.sourceRevisionId === revisionId) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.update.skipped', {
      reason: 'user-rejected-profile-remains-disabled',
      profileFingerprint: latestProfile.sampleFingerprint || null,
      generatedFingerprint: sampleFingerprint,
    });
    return;
  }
  const isConfirmedBase = latestProfile?.status === 'confirmed' &&
    latestProfile.sourceRevisionId === revisionId;
  const isUserManagedBase = latestProfile?.confirmationSource === 'user-modified' ||
    latestProfile?.confirmationSource === 'user-confirmed';
  if (isConfirmedBase && isUserManagedBase) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.update.skipped', {
      reason: 'user-managed-profile-has-priority',
      profileFingerprint: latestProfile.sampleFingerprint || null,
      generatedFingerprint: sampleFingerprint,
      adoptionSource: latestProfile.confirmationSource,
    });
    return;
  }
  if (isConfirmedBase) {
    if (latestProfile.sampleFingerprint === sampleFingerprint ||
        latestProfile.pendingUpdate?.sampleFingerprint === sampleFingerprint) {
      store.appendEvent(projectId, runId, 'chinese-editorial-profile.analysis.discarded', {
        reason: 'profile-or-pending-update-became-current-during-analysis',
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const nextMemory = {
      ...latest.memory,
      chineseEditorialProfile: {
        ...candidate,
        profileVersion: Math.max(1, Number(latestProfile.profileVersion) || 1) + 1,
        previousFingerprint: latestProfile.sampleFingerprint || null,
        acceptedUpdateAt: generatedAt,
        generatedFromMemoryRevisionId: latest.memoryRevisionId || null,
      },
    };
    const saved = store.saveLiteraryMemory(projectId, nextMemory);
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.update.auto-adopted', {
      memoryRevisionId: saved.memoryRevisionId,
      baseProfileFingerprint: latestProfile.sampleFingerprint || null,
      profileFingerprint: sampleFingerprint,
      analysisVersion: ANALYSIS_VERSION,
      sampleCount: args.sampleCount,
      evidenceCount: evidenceRefs.length,
      evidenceSegmentCount,
      durationMs: Date.now() - startedAt,
      adoptionSource: 'model-default',
      usage: args.usage,
    });
    return;
  }
  const nextMemory = {
    ...latest.memory,
    chineseEditorialProfile: candidate,
  };
  const saved = store.saveLiteraryMemory(projectId, nextMemory);
  store.appendEvent(projectId, runId, 'chinese-editorial-profile.auto-adopted', {
    memoryRevisionId: saved.memoryRevisionId,
    profileFingerprint: sampleFingerprint,
    analysisVersion: ANALYSIS_VERSION,
    sampleCount: args.sampleCount,
    evidenceCount: evidenceRefs.length,
    evidenceSegmentCount,
    durationMs: Date.now() - startedAt,
    adoptionSource: 'model-default',
    usage: args.usage,
  });
}

/**
 * 幂等的后台触发器：同一 projectId:runId 不重复启动；失败记录事件但不阻断翻译采纳。
 */
export function scheduleChineseEditorialProfileRefresh(projectId: string, runId: string): void {
  const key = projectId + ':' + runId;
  if (activeAnalyses.has(key)) return;
  const work = refreshChineseEditorialProfile(projectId, runId)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        getDocumentProjectStore().appendEvent(projectId, runId, 'chinese-editorial-profile.analysis.failed', {
          error: message.slice(0, 500),
        });
      } catch { /* preserve translation acceptance if profile analysis cannot be logged */ }
    })
    .finally(() => activeAnalyses.delete(key));
  activeAnalyses.set(key, work);
}
