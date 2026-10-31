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

export type ChineseEditorialProfileReviewAction = 'confirm' | 'reject' | 'accept-update' | 'reject-update';

export function applyChineseEditorialProfileReview(
  profile: Record<string, any> | null | undefined,
  action: ChineseEditorialProfileReviewAction,
  currentSourceRevisionId: string,
  now = new Date().toISOString(),
): Record<string, any> {
  const hasEvidence = (candidate: any) => candidate &&
    candidate.sourceRevisionId === currentSourceRevisionId &&
    Array.isArray(candidate.evidenceRefs);
  // Explicit rejection is always available; it must not be blocked by evidence thresholds.
  if (action === 'reject') {
    return { ...profile, status: 'rejected', confirmationSource: undefined, confirmedAt: undefined };
  }
  if (action === 'reject-update') {
    return { ...profile, pendingUpdate: undefined };
  }
  if (action === 'accept-update' || action === 'reject-update') {
    const pending = profile?.pendingUpdate;
    if (profile?.status !== 'confirmed' || !hasEvidence(pending)) {
      throw Object.assign(new Error('没有当前来源版本下可处理的中文编辑档案更新，或更新证据已失效。'), { status: 409 });
    }
    if (pending.basedOnFingerprint && pending.basedOnFingerprint !== profile.sampleFingerprint) {
      throw Object.assign(new Error('待更新档案的基准版本已变化，请重新生成更新候选。'), { status: 409 });
    }
    return action === 'accept-update'
      ? {
          ...pending,
          status: 'confirmed',
          confirmationSource: 'user-confirmed',
          confirmedAt: now,
          profileVersion: Math.max(1, Number(profile.profileVersion) || 1) + 1,
          previousFingerprint: profile.sampleFingerprint || null,
          acceptedUpdateAt: now,
        }
      : {
          ...profile,
          pendingUpdate: undefined,
          lastRejectedUpdate: { sampleFingerprint: pending.sampleFingerprint, rejectedAt: now },
        };
  }
  if (!hasEvidence(profile)) {
    throw Object.assign(new Error('当前来源版本没有可确认的中文编辑档案，或档案证据已失效。'), { status: 409 });
  }
  if (action === 'confirm' && profile.status === 'rejected') {
    throw Object.assign(new Error('已拒绝的编辑档案不能直接确认，请先重新分析生成新候选。'), { status: 409 });
  }
  return {
    ...profile,
    status: action === 'confirm' ? 'confirmed' : 'rejected',
    ...(action === 'confirm'
      ? { confirmationSource: 'user-confirmed', confirmedAt: now }
      : { confirmationSource: undefined, confirmedAt: undefined }),
  };
}

/**
 * Build a book-level Chinese target voice from accepted translations only.
 * Source text is used locally for deterministic sample selection and is never placed in the model prompt.
 */
export async function refreshChineseEditorialProfile(projectId: string, runId: string): Promise<void> {
  const store = getDocumentProjectStore();
  const context = store.getRunContext(projectId, runId);
  const run = context.run as Record<string, any>;
  if (run.translationMode !== 'literary' || !/^zh(?:-|$)/iu.test(String(run.targetLang || 'zh'))) return;

  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const revisionId = String(run.sourceRevisionId || '');
  if (!revisionId || revisionId !== currentSourceRevisionId) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'source-revision-mismatch',
      runSourceRevisionId: revisionId,
      currentSourceRevisionId,
    });
    return;
  }

  const rows = db.prepare(
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
  ).all(revisionId) as Array<{
    id: string; ordinal: number; sourceText: string; kind: string; contextPath: string; targetText: string;
  }>;

  const distinctChapters = new Set(rows.map((row) => row.contextPath).filter(Boolean));
  if (rows.length < 8 || (distinctChapters.size < 2 && rows.length < 12)) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'insufficient-accepted-samples',
      acceptedSegmentCount: rows.length,
      chapterCount: distinctChapters.size || (rows.length ? 1 : 0),
      minimumAcceptedSegments: distinctChapters.size < 2 ? 12 : 8,
    });
    return;
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
    return;
  }

  const sampleFingerprint = fingerprint({
    revisionId,
    samples: samples.map((sample) => [sample.segmentId, sample.targetText]),
  });
  const current = store.getCurrentLiteraryMemory(projectId);
  const existing = current.memory.chineseEditorialProfile;
  if (existing?.status === 'confirmed' && existing.sourceRevisionId === revisionId &&
      (existing.sampleFingerprint === sampleFingerprint ||
       existing.pendingUpdate?.sampleFingerprint === sampleFingerprint)) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: existing.sampleFingerprint === sampleFingerprint
        ? 'confirmed-profile-sample-unchanged' : 'same-pending-update-already-exists',
      profileFingerprint: existing.sampleFingerprint || null,
      pendingUpdateFingerprint: existing.pendingUpdate?.sampleFingerprint || null,
    });
    return;
  }
  if (existing?.status === 'candidate' && existing.sourceRevisionId === revisionId &&
      existing.sampleFingerprint === sampleFingerprint && existing.analysisVersion === ANALYSIS_VERSION) {
    store.appendEvent(projectId, runId, 'chinese-editorial-profile.skipped', {
      reason: 'same-sample-profile-already-exists',
      sampleFingerprint,
    });
    return;
  }

  const agent = parseAgentModel(String(run.model || 'auto'), String(run.provider || 'workbuddy'));
  const rawTaskProfile = getCodeBuddyTaskProfile(context.prompt?.config || {}, 'styleReview');
  // A profile-generation task uses the configured model/effort, but not a user-authored style-review
  // template that may contain instructions for segment-level findings.
  const taskProfile = { ...rawTaskProfile, userPromptTemplate: '', systemPromptAppendix: '' };
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

  store.appendEvent(projectId, runId, 'chinese-editorial-profile.analysis.started', {
    analysisVersion: ANALYSIS_VERSION,
    acceptedSegmentCount: rows.length,
    selectedSampleCount: samples.length,
    chapterCount: distinctChapters.size || 1,
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
    'chinese-editorial-profile:' + revisionId + ':' + sampleFingerprint.slice(0, 12),
    'document:' + projectId + ':chinese-editorial-profile:' + revisionId,
    taskProfile,
    { timeoutMs: ANALYSIS_TIMEOUT_MS },
  );
  const output = result.result as Record<string, any>;
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
  const evidenceRefs = (Array.isArray(output?.observations) ? output.observations : []).flatMap((item: any) => {
    const segmentId = cleanText(item?.segmentId, 160);
    const targetExcerpt = cleanText(item?.targetExcerpt, 240);
    const observation = cleanText(item?.observation, 240);
    const aspect = ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction', 'consistency'].includes(String(item?.aspect))
      ? String(item.aspect) : '';
    const sample = sampleById.get(segmentId);
    return sample && targetExcerpt.length >= 4 && sample.includes(targetExcerpt) && observation && aspect
      ? [{ segmentId, targetExcerpt, observation, aspect }]
      : [];
  }).filter((item: any, index: number, all: any[]) =>
    all.findIndex((other) => other.segmentId === item.segmentId && other.targetExcerpt === item.targetExcerpt) === index
  ).slice(0, 24);
  const evidenceSegmentCount = new Set(evidenceRefs.map((item: any) => item.segmentId)).size;
  if (!Object.values(profile).some((value) => Array.isArray(value) ? value.length > 0 : !!value)) {
    throw new Error('中文 Editorial Profile 输出缺少可用的风格内容。');
  }

  // Reload after the model call. If the user confirmed the base profile while analysis ran,
  // preserve it and attach the newly generated profile as a separately reviewable update.
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
    sampleCount: samples.length,
    chapterCount: distinctChapters.size || 1,
    generatedAt,
    profile,
    evidenceRefs,
  };
  const isConfirmedBase = latestProfile?.status === 'confirmed' &&
    latestProfile.sourceRevisionId === revisionId;
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
      sampleCount: samples.length,
      evidenceCount: evidenceRefs.length,
      evidenceSegmentCount,
      durationMs: Date.now() - startedAt,
      adoptionSource: 'model-default',
      usage: result.usage || null,
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
    sampleCount: samples.length,
    evidenceCount: evidenceRefs.length,
    evidenceSegmentCount,
    durationMs: Date.now() - startedAt,
    adoptionSource: 'model-default',
    usage: result.usage || null,
  });
}

/** Idempotent background trigger used after candidate acceptance and completed runs. */
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
