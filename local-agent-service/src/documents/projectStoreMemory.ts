/**
 * 提示词、文学记忆与翻译上下文增量。
 *
 * 文学记忆按「合并增量 → 校验 → 落库」推进：模型给出的记忆先进入 translation context delta，
 * 采纳时再合并进主记忆，校验不过就不写。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { hash, isoNow, parseJson } from './documentStoreUtils.ts';
import { type ProjectPrompt } from './documentStrategy.ts';
import { sourceLanguageMatches } from './languageMatch.ts';
import { type DocumentProjectStore } from './projectStore.ts';
import { sanitizeProjectLiteraryMemory } from './voiceContext.ts';

/**
 * 保存 Prompt 修订并记录 prompt.saved 事件，更新项目 updated_at。
 */
export function savePrompt(store: DocumentProjectStore, projectId: string, prompt: ProjectPrompt & { name?: string }): any {
  const result = store.savePromptRevision(projectId, prompt);
  if (prompt.literaryMemory !== undefined) store.saveLiteraryMemory(projectId, prompt.literaryMemory);
  store.catalogDb().prepare('UPDATE document_projects SET updated_at = ? WHERE project_id = ?').run(isoNow(), projectId);
  store.addEvent(projectId, null, 'prompt.saved', { promptRevisionId: result.prompt_revision_id, fingerprint: result.fingerprint });
  return store.publicPrompt(result);
}

/**
 * 列出项目的所有 Prompt 修订，按创建时间倒序。
 */
export function listPrompts(store: DocumentProjectStore, projectId: string): any[] {
  const db = store.openProjectDb(projectId);
  return (db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC, rowid DESC').all() as any[]).map((row) => store.publicPrompt(row));
}

/**
 * 将 prompt_revisions 数据库行转换为对外返回的 Prompt 结构。
 */
export function publicPrompt(store: DocumentProjectStore, row: any): any {
  return {
    promptRevisionId: row.prompt_revision_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    userPromptTemplate: row.user_prompt_template,
    config: parseJson(row.config_json, {}),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
}

/**
 * 保存一版文学记忆，按内容指纹幂等：内容不变就不再产生新版本。
 *
 * 写入前必须先过 validateLiteraryMemoryAgainstProject——记忆里引用的实体、片段、
 * 源文版本都要能对上当前项目，否则一旦落库，后续检索会拿着悬空引用去查。
 */
export function saveLiteraryMemory(store: DocumentProjectStore, projectId: string, input: unknown): any {
  const db = store.openProjectDb(projectId);
  const memory = store.validateLiteraryMemoryAgainstProject(projectId, input);
  const memoryJson = JSON.stringify(memory);
  const fingerprint = hash(memoryJson);
  const existing = db.prepare('SELECT * FROM literary_memory_revisions WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1').get(fingerprint) as any;
  const reusedRevision = !!existing;
  const memoryRevisionId = existing?.memory_revision_id || randomUUID();
  const createdAt = existing?.created_at || isoNow();
  if (existing) {
    store.projectMeta(db, 'current_literary_memory_revision_id', existing.memory_revision_id);
  } else {
    db.prepare('INSERT INTO literary_memory_revisions(memory_revision_id, version, memory_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(memoryRevisionId, 2, memoryJson, fingerprint, createdAt);
    store.projectMeta(db, 'current_literary_memory_revision_id', memoryRevisionId);
  }

  const characterProfiles = memory.characterVoices.slice(0, 80).map((profile: any) => ({
    characterId: String(profile.characterId || '').slice(0, 100),
    canonicalSourceName: String(profile.canonicalSourceName || '').slice(0, 120),
    targetName: String(profile.targetName || '').slice(0, 120),
    aliases: (Array.isArray(profile.aliases) ? profile.aliases : []).slice(0, 12)
      .map((alias: unknown) => String(alias).slice(0, 80)),
    status: String(profile.status || ''),
    hasRole: !!String(profile.role || '').trim(),
    traitCount: Array.isArray(profile.traits) ? profile.traits.length : 0,
    voiceDimensionKeys: profile.voiceCore && typeof profile.voiceCore === 'object'
      ? Object.keys(profile.voiceCore).slice(0, 10) : [],
    evidenceCount: Array.isArray(profile.evidence) ? profile.evidence.length : 0,
  }));
  const literaryEntities = memory.entities.slice(0, 120).map((entity: any) => ({
    source: String(entity.source || '').slice(0, 120),
    target: String(entity.target || '').slice(0, 120),
    aliases: (Array.isArray(entity.aliases) ? entity.aliases : []).slice(0, 8)
      .map((alias: unknown) => String(alias).slice(0, 80)),
    kind: String(entity.kind || ''),
    reviewStatus: String(entity.reviewStatus || ''),
    evidenceRefCount: Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs.length : 0,
  }));
  const statusCount = (status: string) => memory.characterVoices.filter((profile: any) => profile.status === status).length;
  const payload = {
    memoryRevisionId, fingerprint, reusedRevision,
    entityCount: memory.entities.length,
    characterCount: memory.characterVoices.length,
    confirmedCharacterCount: statusCount('confirmed'),
    evidenceVerifiedCharacterCount: memory.characterVoices.filter((profile: any) =>
      profile.status === 'confirmed' && profile.confirmationSource === 'evidence-verified').length,
    userConfirmedCharacterCount: memory.characterVoices.filter((profile: any) =>
      profile.status === 'confirmed' && profile.confirmationSource === 'user-confirmed').length,
    candidateCharacterCount: statusCount('candidate'),
    rejectedCharacterCount: statusCount('rejected'),
    relationshipCount: memory.relationships.length,
    relationshipVoiceRuleCount: memory.relationshipVoiceRules.length,
    voiceAnchorCount: memory.voiceAnchors.length,
    literaryEntities,
    characterProfiles,
  };
  // 即使指纹已存在也要发这条事件：它记录的是「界面确实走到了图谱→记忆的同步路径」，
  // 而不只是「插入了新版本」。
  store.appendEvent(projectId, null, 'literary-memory.saved', payload);
  return { memoryRevisionId, fingerprint, version: existing?.version || 2, createdAt };
}

/**
 * 读取当前文学记忆 revision；兼容旧版本把记忆嵌入 Prompt 的情况，并在必要时升级为新 revision。
 */
export function getCurrentLiteraryMemory(store: DocumentProjectStore, projectId: string): any {
  const db = store.openProjectDb(projectId);
  let revisionId = db.prepare('SELECT value FROM project_meta WHERE key = ?').get('current_literary_memory_revision_id') as { value?: string } | undefined;
  // 兼容早期 Project API：历史 Prompt 把整本书的记忆放在 config_json 内。首次读取时迁移一次。
  if (!revisionId?.value) {
    const prompt = db.prepare('SELECT * FROM prompt_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as any;
    const oldConfig = prompt ? parseJson<any>(prompt.config_json, {}) : {};
    if (oldConfig.literaryMemory) {
      const saved = store.saveLiteraryMemory(projectId, oldConfig.literaryMemory);
      revisionId = { value: saved.memoryRevisionId };
    }
  }
  if (!revisionId?.value) {
    return { memoryRevisionId: null, fingerprint: null, memory: sanitizeProjectLiteraryMemory({}) };
  }
  const row = db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(revisionId.value) as any;
  if (!row) return { memoryRevisionId: null, fingerprint: null, memory: sanitizeProjectLiteraryMemory({}) };
  const stored = parseJson(row.memory_json, sanitizeProjectLiteraryMemory({}));
  const validated = store.validateLiteraryMemoryAgainstProject(projectId, stored);
  const validatedFingerprint = hash(JSON.stringify(validated));
  if (validatedFingerprint !== row.fingerprint) {
    // 旧版本写入的未核验画像/锚点在首次读取时产生一个兼容的新 revision，不修改任何历史 Run 引用的快照。
    const saved = store.saveLiteraryMemory(projectId, validated);
    const upgraded = db.prepare('SELECT * FROM literary_memory_revisions WHERE memory_revision_id = ?').get(saved.memoryRevisionId) as any;
    return {
      memoryRevisionId: upgraded.memory_revision_id,
      fingerprint: upgraded.fingerprint,
      memory: parseJson(upgraded.memory_json, sanitizeProjectLiteraryMemory({})),
      createdAt: upgraded.created_at,
    };
  }
  return { memoryRevisionId: row.memory_revision_id, fingerprint: row.fingerprint, memory: validated, createdAt: row.created_at };
}

/**
 * 列出最近的文学记忆修订（最多 100 条）。
 */
export function listLiteraryMemoryRevisions(store: DocumentProjectStore, projectId: string): any[] {
  return (store.openProjectDb(projectId).prepare('SELECT memory_revision_id, version, fingerprint, created_at FROM literary_memory_revisions ORDER BY created_at DESC LIMIT 100').all() as any[])
    .map((row) => ({ memoryRevisionId: row.memory_revision_id, version: row.version, fingerprint: row.fingerprint, createdAt: row.created_at }));
}

/**
 * 文学预处理就绪性显式校验辅助函数，供调用方要求项目已预处理时使用。
 * 不应在 Run 创建时调用：queued 文学 Run 必须进入服务端 executeRun 门禁，由其启动预处理并持久化等待/失败事件。
 */
export function assertLiteraryPreprocessingReady(store: DocumentProjectStore, projectId: string, sourceRevisionId: string, sourceLang: string, targetLang: string): void {
  const db = store.openProjectDb(projectId);
  const currentSourceRevisionId = String(
    (db.prepare("SELECT value FROM project_meta WHERE key = 'current_source_revision_id'").get() as { value?: string } | undefined)?.value || '',
  );
  if (sourceRevisionId !== currentSourceRevisionId) {
    throw Object.assign(new Error('预处理检查对应的原文版本已变化，请基于当前原文重新分析。'), { status: 409 });
  }
  const graphTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_graph_runs'"
  ).get();
  if (!graphTable) {
    throw Object.assign(new Error('文学翻译的全书预处理尚未运行。请先在 UI 的“人物与预处理”中启动，或执行 npm run doc -- context-analyze ' + projectId + '。'), { status: 409 });
  }
  let preprocessing = db.prepare(
    'SELECT run_id, status, progress_json, error FROM context_graph_runs WHERE source_revision_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1'
  ).get(sourceRevisionId) as { run_id?: string; status?: string; progress_json?: string; error?: string } | undefined;
  // 补一次终态写入：完成事件已经落盘，但之后的状态更新丢了。
  if (preprocessing && (preprocessing.status === 'queued' || preprocessing.status === 'running') && preprocessing.run_id) {
    const completion = db.prepare(
      "SELECT payload_json FROM project_events WHERE run_id = ? AND event_type = 'context-graph.completed' ORDER BY created_at DESC LIMIT 1"
    ).get(preprocessing.run_id) as { payload_json?: string } | undefined;
    let completionPayload: any = {};
    try { completionPayload = JSON.parse(completion?.payload_json || '{}'); } catch { completionPayload = {}; }
    const expectedSourceLang = sourceLang || 'auto';
    const expectedTargetLang = targetLang || 'zh';
    if (completionPayload.analysisVersion === 'context-graph-v5-language-pinned' &&
        completionPayload.sourceLang === expectedSourceLang &&
        completionPayload.targetLang === expectedTargetLang) {
      const completedAt = isoNow();
      db.prepare(
        "UPDATE context_graph_runs SET status = 'completed', phase = 'completed', finished_at = COALESCE(finished_at, ?), error = NULL WHERE run_id = ? AND status IN ('queued','running')"
      ).run(completedAt, preprocessing.run_id);
      preprocessing = db.prepare(
        'SELECT run_id, status, progress_json, error FROM context_graph_runs WHERE run_id = ?'
      ).get(preprocessing.run_id) as { run_id?: string; status?: string; progress_json?: string; error?: string } | undefined;
      store.addEvent(projectId, preprocessing?.run_id || null, 'context-graph.recovered', {
        reason: 'completion-event-with-stale-running-status',
        sourceRevisionId,
      });
    }
  }
  if (!preprocessing) {
    throw Object.assign(new Error('当前原文版本还没有 Context Graph 预处理记录。请先完成全书预处理再翻译。'), { status: 409 });
  }
  if (preprocessing.status === 'queued' || preprocessing.status === 'running') {
    throw Object.assign(new Error('全书预处理仍在运行（' + preprocessing.run_id + '），完成后再启动翻译。'), { status: 409 });
  }
  if (preprocessing.status !== 'completed') {
    throw Object.assign(new Error('全书预处理未成功：' + (preprocessing.error || preprocessing.status) + '。请在 UI 的“人物与预处理”中重新分析，或执行 npm run doc -- context-analyze ' + projectId + '。'), { status: 409 });
  }
  const preprocessingProgress = parseJson<any>(preprocessing.progress_json, {});
  if (preprocessingProgress.analysisVersion !== 'context-graph-v5-language-pinned') {
    throw Object.assign(new Error('全书预处理版本过旧，请重新分析后再翻译：UI 中点击“重新分析全书”，或执行 npm run doc -- context-analyze ' + projectId + '。'), { status: 409 });
  }
  const expectedSourceLang = sourceLang || 'auto';
  const expectedTargetLang = targetLang || 'zh';
  if (!sourceLanguageMatches(preprocessingProgress.sourceLang, expectedSourceLang) ||
      preprocessingProgress.targetLang !== expectedTargetLang) {
    throw Object.assign(new Error(
      '全书预处理语言与当前翻译配置不一致（预处理 ' +
      (preprocessingProgress.sourceLang || 'auto') + '→' + (preprocessingProgress.targetLang || 'zh') +
      '，当前 ' + expectedSourceLang + '→' + expectedTargetLang + '）。请重新分析全书：UI 中点击“重新分析全书”，或执行 npm run doc -- context-analyze ' + projectId + '。',
    ), { status: 409 });
  }
}

/**
 * 文学记忆是独立的不可变业务资产，不应混进 Prompt fingerprint。
 * 角色画像按证据与状态维护；每个 Run 固定引用一个 memory revision，方便复现。
 */
export function validateLiteraryMemoryAgainstProject(store: DocumentProjectStore, projectId: string, input: unknown): Record<string, any> {
  const memory = sanitizeProjectLiteraryMemory(input);
  const { db, currentSourceRevisionId } = store.getProjectContext(projectId);
  const sourceRows = db.prepare(
    'SELECT segment_id, text, source_hash FROM source_segments WHERE source_revision_id = ?'
  ).all(currentSourceRevisionId) as Array<{ segment_id: string; text: string; source_hash: string }>;
  const sources = new Map(sourceRows.map((row) => [row.segment_id, row]));
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const latestAccepted = new Map<string, { translation: string; sourceHash: string }>();
  const acceptedRows = db.prepare(
    'SELECT segment_id, translation_text, source_hash FROM translation_results ' +
    'WHERE accepted = 1 AND source_revision_id = ? ' +
    'ORDER BY COALESCE(accepted_at, created_at) DESC, created_at DESC, rowid DESC'
  ).all(currentSourceRevisionId) as Array<{ segment_id: string; translation_text: string; source_hash: string }>;
  for (const row of acceptedRows) {
    if (!latestAccepted.has(row.segment_id)) {
      latestAccepted.set(row.segment_id, { translation: row.translation_text, sourceHash: row.source_hash });
    }
  }
  const validEvidence = (segmentId: unknown, quote: unknown): boolean => {
    if (typeof segmentId !== 'string' || typeof quote !== 'string' || !quote.trim()) return false;
    const source = sources.get(segmentId);
    return !!source && normalize(source.text).includes(normalize(quote));
  };

  memory.characterVoices = memory.characterVoices.map((profile: any) => {
    const evidence = profile.evidence.filter((item: any) => validEvidence(item.segmentId, item.sourceQuote));
    const evidenceSegmentCount = new Set(evidence.map((item: any) => item.segmentId)).size;
    const evidenceDimensionCount = new Set(evidence.map((item: any) => item.dimension)).size;
    const hasSubstantiveVoiceCore = Object.values(profile.voiceCore || {})
      .some((value: any) => typeof value === 'string' ? !!value.trim() : Array.isArray(value) && value.length > 0);
    // 只有当若干段位置相互独立的源文摘录同时支撑多个声音维度时，
    // 候选声音档案才能不经用户点击就变成「证据已核实」。
    // 模型自报的置信度刻意不参与这个判定。
    const evidenceVerified = (profile.status === 'candidate' ||
        (profile.status === 'confirmed' && profile.confirmationSource === 'evidence-verified')) &&
      profile.evidenceTruncated !== true &&
      evidenceSegmentCount >= 3 &&
      evidenceDimensionCount >= 2 &&
      hasSubstantiveVoiceCore;
    const userConfirmed = profile.status === 'confirmed' &&
      profile.confirmationSource === 'user-confirmed';
    const legacyConfirmed = profile.status === 'confirmed' &&
      profile.confirmationSource === 'legacy-unknown' &&
      evidence.length > 0;
    const modelDefault = profile.status === 'confirmed' && profile.confirmationSource === 'model-default';
    const status = profile.status === 'rejected'
      ? 'rejected'
      : evidenceVerified || userConfirmed || legacyConfirmed || modelDefault
        ? 'confirmed'
        : 'candidate';
    // 摘录缺失或不合法只会降低证据质量，不影响是否采纳。模型默认档案
    // 仍可带着幸存的观察继续使用，读者之后可以再纠正。
    const questions = Array.isArray(profile.openQuestions) ? [...profile.openQuestions] : [];
    return {
      ...profile, evidence, status,
      ...(status === 'confirmed' && evidenceVerified
        ? { confirmationSource: 'evidence-verified' }
        : status === 'confirmed' && userConfirmed
          ? { confirmationSource: 'user-confirmed' }
          : status === 'confirmed' && modelDefault
            ? { confirmationSource: 'model-default' }
            : status === 'confirmed' && legacyConfirmed
              ? { confirmationSource: 'legacy-unknown' }
              : { confirmationSource: undefined }),
      openQuestions: Array.from(new Set(questions)).slice(0, 8),
    };
  });
  const characterIds = new Set(memory.characterVoices.map((profile: any) => profile.characterId));
  const confirmedCharacterIds = new Set(memory.characterVoices.filter((profile: any) => profile.status === 'confirmed').map((profile: any) => profile.characterId));
  memory.characterVoices = memory.characterVoices.map((profile: any) => ({
    ...profile,
    contrastRules: profile.contrastRules.flatMap((rule: any) => {
      const evidenceSegmentIds = rule.evidenceSegmentIds.filter((id: string) => sources.has(id));
      return characterIds.has(rule.otherCharacterId) && evidenceSegmentIds.length
        ? [{ ...rule, evidenceSegmentIds }] : [];
    }),
  }));
  memory.relationshipVoiceRules = memory.relationshipVoiceRules.flatMap((rule: any) => {
    const evidenceSegmentIds = rule.evidenceSegmentIds.filter((id: string) => sources.has(id));
    const status = rule.status === 'rejected' ? 'rejected'
      : confirmedCharacterIds.has(rule.speakerId) && confirmedCharacterIds.has(rule.addresseeId) ? 'confirmed' : 'candidate';
    return characterIds.has(rule.speakerId) && characterIds.has(rule.addresseeId)
      ? [{ ...rule, evidenceSegmentIds, status,
          ...(status === 'confirmed' ? { confirmationSource: rule.confirmationSource || 'model-default' } : { confirmationSource: undefined }) }] : [];
  });
  memory.entities = memory.entities.map((entity: any) => {
    const evidenceRefs = (Array.isArray(entity.evidenceRefs) ? entity.evidenceRefs : [])
      .filter((ref: any) => validEvidence(ref.segmentId, ref.sourceQuote));
    const targetEvidenceRefs = (Array.isArray(entity.targetEvidenceRefs) ? entity.targetEvidenceRefs : [])
      .filter((ref: any) => {
        const segmentId = String(ref?.segmentId || '');
        const source = sources.get(segmentId);
        const accepted = latestAccepted.get(segmentId);
        const targetSurface = typeof ref?.targetSurface === 'string' ? ref.targetSurface.trim() : '';
        return !!targetSurface && validEvidence(segmentId, ref?.sourceQuote) && !!source && !!accepted &&
          accepted.sourceHash === source.source_hash && normalize(accepted.translation).includes(normalize(targetSurface));
      });
    const targetEvidenceCount = new Set(targetEvidenceRefs
      .filter((ref: any) => normalize(String(ref.targetSurface || '')) === normalize(String(entity.target || '')))
      .map((ref: any) => String(ref.segmentId || '')).filter(Boolean)).size;
    const invalidMachineConfirmation = ['evidence-verified', 'model-default', 'consolidated'].includes(String(entity.confirmationSource || '')) && evidenceRefs.length === 0;
    const reviewStatus = invalidMachineConfirmation ? 'suggested' : entity.reviewStatus;
    // 只有至少两个不同片段的已采纳译文实际包含该译名，才算 corroborated。
    // 模型自己提交的 targetEvidenceRefs 不能单独把一个译名升级成强映射。
    const targetConfidence = reviewStatus === 'confirmed' && targetEvidenceCount >= 2
      ? 'corroborated' : 'candidate';
    return {
      ...entity, evidenceRefs, targetEvidenceRefs, targetConfidence, reviewStatus,
      ...(invalidMachineConfirmation ? { confirmationSource: undefined } : {}),
    };
  });
  memory.relationships = memory.relationships.map((relation: any) => {
    const evidenceRefs = (Array.isArray(relation.evidenceRefs) ? relation.evidenceRefs : [])
      .filter((ref: any) => validEvidence(ref.segmentId, ref.sourceQuote));
    const invalidMachineConfirmation = ['evidence-verified', 'model-default'].includes(String(relation.confirmationSource || '')) && evidenceRefs.length === 0;
    return {
      ...relation, evidenceRefs,
      ...(invalidMachineConfirmation ? { reviewStatus: 'suggested', confirmationSource: undefined } : {}),
    };
  });
  memory.voiceAnchors = memory.voiceAnchors.map((anchor: any) => {
    const sourceValid = validEvidence(anchor.segmentId, anchor.source);
    const attributionValid = !anchor.attributionEvidence ||
      validEvidence(anchor.segmentId, anchor.attributionEvidence);
    const speakerConfirmed = memory.characterVoices.some((profile: any) =>
      profile.characterId === anchor.speakerId && profile.status === 'confirmed');
    const accepted = latestAccepted.get(anchor.segmentId);
    const currentSource = sources.get(anchor.segmentId);
    // 来自旧源文版本的译文，不能作为新锚点的目标，
    // 哪怕原文被改过之后某个子串恰好还能对上。
    const targetValid = !!accepted && !!currentSource &&
      accepted.sourceHash === currentSource.source_hash &&
      !!accepted.translation.trim() &&
      normalize(accepted.translation).includes(normalize(anchor.target));
    const approved = anchor.status !== 'rejected' && sourceValid && attributionValid && speakerConfirmed && targetValid;
    const status = anchor.status === 'rejected' ? 'rejected' : approved ? 'approved' : 'candidate';
    return {
      ...anchor,
      status,
      ...(status === 'approved' ? {} : { confirmationSource: undefined }),
    };
  });
  if (memory.chineseEditorialProfile) {
    const profile = memory.chineseEditorialProfile;
    const evidenceRefs = profile.evidenceRefs.filter((ref: any) => {
      const source = sources.get(String(ref.segmentId || ''));
      const accepted = latestAccepted.get(String(ref.segmentId || ''));
      return !!source && !!accepted && accepted.sourceHash === source.source_hash &&
        typeof ref.targetExcerpt === 'string' && normalize(accepted.translation).includes(normalize(ref.targetExcerpt));
    });
    const evidenceSegmentCount = new Set(evidenceRefs.map((ref: any) => String(ref.segmentId))).size;
    const revisionMatches = profile.sourceRevisionId === currentSourceRevisionId;
    const canRemainActive = revisionMatches && profile.status !== 'rejected';
    memory.chineseEditorialProfile = {
      ...profile,
      evidenceRefs,
      status: profile.status === 'rejected' ? 'rejected' : canRemainActive ? 'confirmed' : 'candidate',
      ...(canRemainActive
        ? { confirmationSource: profile.confirmationSource || 'model-default' }
        : { confirmationSource: undefined, confirmedAt: undefined }),
    };
  }
  // 这里曾经每次读取项目都打一行 "literary memory validated"。它没有诊断价值，
  // 却在日志里刷了 763 行，把真正的项目操作（创建/导入/归档）完全盖住。删除，不是降级。
  return memory;
}

/**
 * 计算 Context Graph 的 fingerprint，用于文学检索版本追踪。
 * 图谱更新必须像 Prompt/记忆修订一样使已采纳输出失效；旧版数据库可能没有图谱表，此时返回 null 而不报错。
 */
export function contextGraphFingerprint(store: DocumentProjectStore, projectId: string, sourceRevisionId: string): string | null {
  const db = store.openProjectDb(projectId);
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_graph_nodes'"
  ).get();
  if (!exists) return null;
  const meta = db.prepare(
    "SELECT key, value FROM context_graph_meta WHERE source_revision_id = ? AND key IN (" +
      "'narrativeStyle','styleRegister','styleRhythm','styleDialogue','styleDiction','styleRules','styleAvoid','styleEvidence'," +
      "'styleFieldCoverage','stylePolicyVersion') ORDER BY key"
  ).all(sourceRevisionId) as any[];
  const latestAnalysis = db.prepare(
    "SELECT progress_json FROM context_graph_runs WHERE source_revision_id = ? AND status = 'completed' ORDER BY started_at DESC, rowid DESC LIMIT 1"
  ).get(sourceRevisionId) as { progress_json?: string } | undefined;
  let analysisIdentity: unknown = null;
  try {
    const progress = JSON.parse(latestAnalysis?.progress_json || '{}');
    analysisIdentity = {
      analysisVersion: progress.analysisVersion || null,
      workflowVersion: progress.workflowVersion || null,
      sourceLang: progress.sourceLang || null,
      targetLang: progress.targetLang || null,
    };
  } catch { analysisIdentity = null; }
  const nodes = db.prepare(
    'SELECT node_id, kind, status, attributes_json FROM context_graph_nodes WHERE source_revision_id = ? ORDER BY node_id'
  ).all(sourceRevisionId) as any[];
  const edges = db.prepare(
    'SELECT edge_id, source_node_id, target_node_id, kind, status, attributes_json FROM context_graph_edges WHERE source_revision_id = ? ORDER BY edge_id'
  ).all(sourceRevisionId) as any[];
  const evidence = db.prepare(
    'SELECT node_id, edge_id, segment_id, quote, role FROM context_graph_evidence WHERE source_revision_id = ? ORDER BY evidence_id'
  ).all(sourceRevisionId) as any[];
  const chapters = db.prepare(
    'SELECT chapter_key, summary, summary_kind FROM context_graph_chapters WHERE source_revision_id = ? ORDER BY chapter_order, chapter_key'
  ).all(sourceRevisionId) as any[];
  return hash(JSON.stringify({ analysisIdentity, meta, nodes, edges, evidence, chapters }));
}

/**
 * 原子保存本批次实际使用的 TranslationBrief 快照。
 * 只有 queued/running 的 Run 且 source/prompt/memory revision 全部与 Run 一致时才允许提交；
 * 返回 false 表示 Run 已离开活动状态，调用方必须丢弃该批次而非继续调用模型。
 */
export function saveTranslationBriefSnapshot(store: DocumentProjectStore, projectId: string, runId: string, batchIndex: number, brief: Record<string, any>): boolean {
  const { db } = store.getProjectContext(projectId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare(
      'SELECT status, source_revision_id, prompt_revision_id, literary_memory_revision_id FROM translation_runs WHERE run_id = ?',
    ).get(runId) as any;
    if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
    if (!['queued', 'running'].includes(String(run.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    if (brief.sourceRevisionId !== run.source_revision_id || brief.promptRevisionId !== run.prompt_revision_id ||
        (brief.memoryRevisionId || null) !== (run.literary_memory_revision_id || null)) {
      throw Object.assign(new Error('TranslationBrief 版本与 Run 快照不一致，拒绝持久化。'), { status: 409 });
    }
    db.prepare(
      'INSERT INTO translation_briefs(run_id, batch_index, source_revision_id, prompt_revision_id, memory_revision_id, brief_hash, brief_chars, source_segment_ids_json, brief_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, batch_index) DO UPDATE SET ' +
      'brief_hash=excluded.brief_hash, brief_chars=excluded.brief_chars, source_segment_ids_json=excluded.source_segment_ids_json, brief_json=excluded.brief_json, created_at=excluded.created_at',
    ).run(
      runId, batchIndex, run.source_revision_id, run.prompt_revision_id, run.literary_memory_revision_id || null,
      String(brief.contextHash || ''), Number(brief.contextChars || 0), JSON.stringify(brief.sourceSegmentIds || []),
      JSON.stringify(brief), isoNow(),
    );
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * 列出 Run 的 TranslationBrief 快照，可选包含完整内容。
 */
export function listTranslationBriefSnapshots(store: DocumentProjectStore, projectId: string, runId: string, includeContent = false): any[] {
  const db = store.openProjectDb(projectId);
  const rows = db.prepare(
    'SELECT run_id, batch_index, source_revision_id, prompt_revision_id, memory_revision_id, brief_hash, brief_chars, source_segment_ids_json, brief_json, created_at ' +
    'FROM translation_briefs WHERE run_id = ? ORDER BY batch_index'
  ).all(runId) as any[];
  return rows.map((row) => ({
    runId: row.run_id, batchIndex: row.batch_index, sourceRevisionId: row.source_revision_id,
    promptRevisionId: row.prompt_revision_id, memoryRevisionId: row.memory_revision_id || null,
    contextHash: row.brief_hash, contextChars: row.brief_chars,
    sourceSegmentIds: parseJson(row.source_segment_ids_json, []), createdAt: row.created_at,
    ...(includeContent ? { brief: parseJson(row.brief_json, {}) } : {}),
  }));
}

/**
 * 保存由初译响应产生、已由服务端核验证据的上下文增量。
 * 以批次首个来源片段作为幂等键，暂停后重新调度批次时可安全替换同批旧结果。
 */
export function saveTranslationContextDelta(store: DocumentProjectStore, projectId: string, runId: string, batchIndex: number, firstSegmentId: string, sourceSegmentIds: string[], delta: Record<string, any>, validation: Record<string, any>): boolean {
  const { db } = store.getProjectContext(projectId);
  const run = db.prepare('SELECT source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as any;
  if (!run) throw Object.assign(new Error('找不到翻译运行：' + runId), { status: 404 });
  const first = db.prepare(
    'SELECT ordinal FROM source_segments WHERE source_revision_id = ? AND segment_id = ?'
  ).get(run.source_revision_id, firstSegmentId) as { ordinal?: number } | undefined;
  if (!first || !Number.isFinite(Number(first.ordinal))) {
    throw Object.assign(new Error('上下文增量引用了不属于当前来源版本的首片段。'), { status: 409 });
  }
  const ids = Array.from(new Set(sourceSegmentIds.filter((id) => typeof id === 'string' && id.trim()))).slice(0, 32);
  if (!ids.length || ids[0] !== firstSegmentId) {
    throw Object.assign(new Error('上下文增量必须以当前批次的首个来源片段作为幂等键。'), { status: 400 });
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT segment_id FROM source_segments WHERE source_revision_id = ? AND segment_id IN (' + placeholders + ')'
  ).all(run.source_revision_id, ...ids) as Array<{ segment_id: string }>;
  if (rows.length !== ids.length) {
    throw Object.assign(new Error('上下文增量包含不属于当前来源版本的片段 ID。'), { status: 409 });
  }
  const deltaJson = JSON.stringify(delta || {});
  const validationJson = JSON.stringify(validation || {});
  if (Buffer.byteLength(deltaJson, 'utf8') > 48_000 || Buffer.byteLength(validationJson, 'utf8') > 8_000) {
    throw Object.assign(new Error('上下文增量超过持久化大小上限。'), { status: 413 });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const latestRun = db.prepare('SELECT status, source_revision_id FROM translation_runs WHERE run_id = ?').get(runId) as any;
    if (!latestRun || latestRun.source_revision_id !== run.source_revision_id) {
      throw Object.assign(new Error('运行的来源版本已变化，拒绝写入上下文增量。'), { status: 409 });
    }
    if (!['queued', 'running'].includes(String(latestRun.status))) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare(
      'INSERT INTO translation_context_deltas(run_id, first_segment_id, batch_index, first_ordinal, source_segment_ids_json, delta_json, validation_json, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, first_segment_id) DO UPDATE SET ' +
      'batch_index=excluded.batch_index, first_ordinal=excluded.first_ordinal, source_segment_ids_json=excluded.source_segment_ids_json, ' +
      'delta_json=excluded.delta_json, validation_json=excluded.validation_json, created_at=excluded.created_at'
    ).run(runId, firstSegmentId, batchIndex, Number(first.ordinal), JSON.stringify(ids), deltaJson, validationJson, isoNow());
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * 返回按原文顺序排列的持久化增量；执行恢复时可重建每一波的只读记忆投影。
 */
export function listTranslationContextDeltas(store: DocumentProjectStore, projectId: string, runId: string): any[] {
  const db = store.openProjectDb(projectId);
  const rows = db.prepare(
    'SELECT run_id, first_segment_id, batch_index, first_ordinal, source_segment_ids_json, delta_json, validation_json, created_at ' +
    'FROM translation_context_deltas WHERE run_id = ? ORDER BY first_ordinal, first_segment_id'
  ).all(runId) as any[];
  return rows.map((row) => ({
    runId: row.run_id,
    firstSegmentId: row.first_segment_id,
    batchIndex: Number(row.batch_index),
    firstOrdinal: Number(row.first_ordinal),
    sourceSegmentIds: parseJson(row.source_segment_ids_json, []),
    delta: parseJson(row.delta_json, {}),
    validation: parseJson(row.validation_json, {}),
    createdAt: row.created_at,
  }));
}
