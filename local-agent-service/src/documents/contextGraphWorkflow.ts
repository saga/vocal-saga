/**
 * Declarative Context Graph workflow used by strategy B.
 *
 * A is the existing single structured-output call (control group).
 * B runs independently checkpointed turns; stages in the same dependency wave run in parallel,
 * each branch keeps its own persistent CodeBuddy session (a branch may continue its parent
 * stage's session when it depends on it, so the sample payload is not resent).
 * SQLite checkpoints, not the model session, are the source of truth for completed work.
 */
export const CONTEXT_GRAPH_WORKFLOW_VERSION = 'context-graph-workflow-v2-canonical-entity-quality';

export const CONTEXT_GRAPH_WORKFLOW_STAGES = [
  {
    id: 'style',
    label: '文风基准',
    phase: 'workflow-style',
    fields: [
      'bookSummary', 'narrativeStyle', 'styleRegister', 'styleRhythm', 'styleDialogue',
      'styleDiction', 'styleRules', 'styleAvoid', 'styleEvidence',
    ],
  },
  { id: 'characters', label: '人物与角色声音', phase: 'workflow-characters', fields: ['characters'] },
  { id: 'entities', label: '实体与规范译名', phase: 'workflow-entities', fields: ['entities'] },
  { id: 'relationships', label: '人物/实体关系', phase: 'workflow-relationships', fields: ['relationships'] },
  { id: 'chapters', label: '章节摘要与待确认问题', phase: 'workflow-chapters', fields: ['chapterSummaries', 'openQuestions'] },
] as const;

export type ContextGraphWorkflowStageId = typeof CONTEXT_GRAPH_WORKFLOW_STAGES[number]['id'];
export type ContextGraphAnalysisStrategy = 'A' | 'B';

/**
 * 阶段依赖波次：同一波次内互不依赖，可以并行；波次之间必须串行。
 *
 * - style / characters / entities 只依赖样本原文与扫描线索，互不引用彼此的输出。
 * - relationships 需要 characters + entities 的规范名称（见 compactPriorOutputs）。
 * - chapters 需要 style 的 bookSummary（见 compactPriorOutputs）。
 *
 * 实测（同一本书 6196 段）：串行 218s → 两波并行 170s。
 * 并发会让单次调用变慢约 1.9x（同一个模型端点争用），所以收益只有 1.28x，不是理论上的 2x。
 */
export const CONTEXT_GRAPH_STAGE_WAVES = [
  ['style', 'characters', 'entities'],
  ['relationships', 'chapters'],
] as const satisfies readonly (readonly ContextGraphWorkflowStageId[])[];

/**
 * 并行阶段续聊哪个已完成阶段的持久化 Session。
 *
 * 并行本身会破坏"单一 Session 顺序续聊"的假设：如果每个阶段都开新 Session，
 * 每个阶段都要重发一遍全书样本。chapters 依赖 style、relationships 依赖 characters，
 * 所以这两条链路可以复用父阶段的 Session，只发增量指令。
 */
export const CONTEXT_GRAPH_STAGE_SESSION_PARENT: Partial<Record<ContextGraphWorkflowStageId, ContextGraphWorkflowStageId>> = {
  chapters: 'style',
  relationships: 'characters',
};

/** 阶段所属波次序号；未知阶段返回 -1。 */
export function contextGraphStageWave(stageId: string): number {
  for (let index = 0; index < CONTEXT_GRAPH_STAGE_WAVES.length; index++) {
    if ((CONTEXT_GRAPH_STAGE_WAVES[index] as readonly string[]).includes(stageId)) return index;
  }
  return -1;
}

const STAGE_INSTRUCTIONS: Record<ContextGraphWorkflowStageId, string> = {
  style: [
    '只完成本阶段：bookSummary、narrativeStyle、styleRegister、styleRhythm、styleDialogue、styleDiction、styleRules、styleAvoid、styleEvidence。',
    '叙述声音、语域、节奏与句法、对白特征、措辞与词汇必须分别填写，不能因为证据不是绝对确定就返回空字符串。请根据已提供的样本给出具体、可用于翻译的观察，并说明观察范围；避免泛化套话。',
    '每个文风维度优先引用本次样本中可核验的 segmentId 和连续短引文。styleRules 至少给出一条有针对性的翻译建议；styleAvoid 可为空数组，但不能臆造原文没有的问题。',
    '不要在本阶段生成人物、实体、关系或章节摘要。只返回本阶段 Schema 中定义的 JSON 字段。',
  ].join('\n'),
  characters: [
    '只完成人物识别。交叉核对 scan hints 的高频名称、跨章节出现情况、早中晚段样本和对白线索；不要仅凭统计线索造成人物。',
    '人物需要稳定 name、aliases、目标语言 suggestedTranslation、role、traits、voice 和可核验 evidence。无法确定的属性应保守描述；没有合格证据的候选不要输出。',
    'voice 应描述可观察的措辞、句法、礼貌、语气和表达习惯，不要用人物身份刻板印象替代文本证据。只返回 characters 字段。',
  ].join('\n'),
  entities: [
    '只完成非人物、且确有跨章一致性价值的命名实体识别，例如虚构氏族/王朝/派系、专有组织、人物相关组织、作品、特殊物件和有专属含义的术语。不要把普通名词、通用头衔、常见国名/语言名/民族称谓、度量单位或词汇例句塞进全书实体表；这些由普通翻译处理。',
    '一条 entity 只能有一个 canonical name 和一个 target。不得把同一语义场中的多个词、国家或语言名称合成一个实体。不要输出斜杠清单、逗号清单或括号注释形式的目标译名。若名称的作品专属意义不清楚，宁可不输出实体，也不要把常见词永久化。',
    '必须覆盖重要虚构专名，包括虚构家族/宗族/氏族/王朝/派系。虚构专名不得被归化成其现实历史原型或相似名称；现实原型不是源文别名，不能写入 aliases。suggestedTranslation 是本书本次运行的预选规范译名，不是已获用户确认的全局事实。',
    '实体需要稳定 name、aliases、规范 kind、significance、suggestedTranslation 和可核验 evidence。目标译名必须是目标语言中完整、自然的单一名称；中文人名不得出现不合理的拉丁字母/汉字混排（如 achi子），不得保留源词片段、清单分隔符或解释性括注。默认不把单次普通词汇登记为概念；只有在原文证据支持其跨章节具有作品专属含义时，才可附 bookSpecificMeaning=true，并在 significance 中具体说明；常见国名、语言名、普通宗教通名不得仅靠该标记绕过反复出现和意义证据要求。证据不足时 target 留空，不得猜测。只返回 entities 字段。',
  ].join('\n'),
  relationships: [
    '只识别由样本文本直接支持的人物/实体关系。优先复用之前阶段已经识别的规范 name；from/to 必须能在人物或实体清单中精确对应。',
    '每条关系都必须给出可核验 evidence。区分亲属、上下级、所属、拥有、地点关联等类型；不要基于常识推断关系，不要输出自环或只有猜测的关系。只返回 relationships 字段。',
  ].join('\n'),
  chapters: [
    '只完成章节摘要和 openQuestions。chapter 必须与本次原文样本对应的章节标题完全匹配；摘要只概括可见证据，不得推测结局或使用未出现的后文信息。',
    '章节摘要需要可核验的 evidence，且证据必须属于摘要对应章节。openQuestions 记录样本中的歧义、候选未能纳入的高频名称及需要人工确认的事项。只返回 chapterSummaries、openQuestions。',
  ].join('\n'),
};

function compactPriorOutputs(stageId: ContextGraphWorkflowStageId, prior: Record<string, any>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  if (stageId === 'relationships' || stageId === 'chapters') {
    if (Array.isArray(prior.characters)) compact.characters = prior.characters.map((item: any) => ({
      name: item?.name, aliases: item?.aliases, suggestedTranslation: item?.suggestedTranslation, role: item?.role,
    }));
    if (stageId === 'relationships' && Array.isArray(prior.entities)) compact.entities = prior.entities.map((item: any) => ({
      name: item?.name, aliases: item?.aliases, kind: item?.kind, suggestedTranslation: item?.suggestedTranslation,
    }));
  }
  if (stageId === 'chapters' && typeof prior.bookSummary === 'string') compact.bookSummary = prior.bookSummary;
  return compact;
}

/** Build a stage-scoped prompt. Persistent sessions reuse the initial source/sample payload instead of resending it. */
export function buildContextGraphWorkflowPrompt(
  stageId: ContextGraphWorkflowStageId,
  basePrompt: string,
  priorOutputs: Record<string, any>,
  hasPersistentSession: boolean,
): string {
  const stage = CONTEXT_GRAPH_WORKFLOW_STAGES.find((item) => item.id === stageId);
  if (!stage) throw new Error('未知 Context Graph 工作流阶段：' + stageId);
  const parts = [
    hasPersistentSession
      ? '继续同一个 Context Graph 分析 Session。源文样本和扫描线索已在前序轮次中给出，请严格基于那些原文证据继续本阶段。'
      : basePrompt,
    '【持久化工作流阶段】' + stage.label + ' (' + stageId + ')',
    STAGE_INSTRUCTIONS[stageId],
  ];
  const previous = compactPriorOutputs(stageId, priorOutputs);
  if (Object.keys(previous).length) {
    parts.push('之前阶段已保存的结果（仅作为名称与术语参照；不要复制无关字段）：' + JSON.stringify(previous));
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Return a schema containing only this stage's fields, all of which are required by structured output. */
export function buildContextGraphWorkflowSchema(
  analysisSchema: Record<string, any>,
  stageId: ContextGraphWorkflowStageId,
): Record<string, unknown> {
  const stage = CONTEXT_GRAPH_WORKFLOW_STAGES.find((item) => item.id === stageId);
  if (!stage) throw new Error('未知 Context Graph 工作流阶段：' + stageId);
  const properties = analysisSchema?.properties || {};
  const missing = stage.fields.filter((field) => !Object.prototype.hasOwnProperty.call(properties, field));
  if (missing.length) throw new Error('Context Graph Schema 缺少阶段字段：' + missing.join(', '));
  return {
    type: 'object',
    properties: Object.fromEntries(stage.fields.map((field) => [field, properties[field]])),
    required: [...stage.fields],
  };
}

/**
 * Strategy selection.
 *
 * B is the default: its stages are checkpointed and now run in dependency waves, so it finishes
 * roughly twice as fast as A and shows per-stage progress. A is a single monolithic call that
 * produces ~42K output tokens in one turn with no intermediate progress, so it is kept only as
 * an explicit control/fallback via `LOCAL_AGENT_CONTEXT_GRAPH_STRATEGY=a`.
 */
export function chooseContextGraphStrategy(
  mode: unknown,
  _lastStrategy: ContextGraphAnalysisStrategy | null,
): ContextGraphAnalysisStrategy {
  return String(mode ?? 'b').trim().toLowerCase() === 'a' ? 'A' : 'B';
}
