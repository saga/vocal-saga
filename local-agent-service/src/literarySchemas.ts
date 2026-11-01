/**
 * 文学分析与审校的模型侧契约：JSON Schema、内置 Prompt 模板与审校类别白名单。
 *
 * 从 literary 抽出：全部是常量，不含流程；改模型输出形状或改默认提示只动这一处。
 */

// 文学分析的 structured output schema，只约束顶层形状，不禁止扩展字段。
export const LITERARY_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entities: { type: 'array' },
    relationships: { type: 'array' },
    styleGuide: { type: 'object' },
    chapterSummary: { type: 'string' },
    characterVoices: { type: 'array' },
    relationshipVoiceRules: { type: 'array' },
    voiceAnchors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anchorId: { type: 'string' }, speakerId: { type: 'string' }, addresseeId: { type: 'string' },
          source: { type: 'string' }, target: { type: 'string' }, chapter: { type: 'string' }, segmentId: { type: 'string' },
          attributionEvidence: { type: 'string' }, attributionConfidence: { type: 'number' },
          status: { type: 'string', enum: ['candidate'] }, tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['speakerId', 'source', 'target', 'segmentId', 'attributionEvidence', 'attributionConfidence'],
      },
    },
    openQuestions: { type: 'array' },
  },
  required: ['entities', 'relationships'],
};

// 审校的 structured output schema，只约束顶层形状，不禁止扩展字段。
export const LITERARY_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: { type: 'array' },
  },
  required: ['results'],
};

/** 文学分析用户 Prompt 模板；占位符为 {{TARGET_LANGUAGE}} 等，单次替换避免源文中的占位符文本被误解释。 */
export const DEFAULT_LITERARY_ANALYSIS_USER_PROMPT_TEMPLATE = [
  '目标语言：{{TARGET_LANGUAGE}}',
  '章节：{{CHAPTER_TITLE}}',
  '当前书籍记忆（只读参考；模型条目不能当作人工确认）：',
  '{{BOOK_MEMORY_JSON}}',
  '本章原文片段：',
  '{{CHAPTER_SEGMENTS_JSON}}',
].join('\n\n');

/** 文学分析系统 Prompt：定义书籍记忆分析器的职责、字段与输出约束。 */
export const DEFAULT_LITERARY_ANALYSIS_SYSTEM_PROMPT = [
  '你是文学作品的书籍记忆分析器，不是翻译器。',
  '只根据给定原文提取记忆，不猜测未出现的事实。新建实体与关系均是建议项，reviewStatus 必须是 suggested；模型不能声称任何条目已经过人工确认。',
  '已有实体的 source→target 规范译名必须沿用，不能擅自更改；人物/事物关系只记录原文支持的明确事实。',
  '实体字段：source、target、kind（person/place/object/organization/concept/other）、aliases、description、evidence、reviewStatus。',
  '同一人物的全名、简称、昵称、不同拼写/音译和可确认的称呼形式，优先归入一个实体的 aliases，只生成一个规范 target；Lady、Lord、-san 是称谓，不应并入人名。证据不足时不要推断两个人是同一人。',
  '关系字段只记录剧情事实：subject、predicate、object、evidence、reviewStatus；人物之间如何说话必须另放 relationshipVoiceRules。',
  '人物声音不是性格形容词。对本章有充分证据的主要人物，输出 characterVoices：characterId（优先沿用已有记忆 ID；否则用 char_ + 同一规范原文名的稳定 ID）、canonicalSourceName、targetName、aliases、status=candidate、confidence、voiceCore、contrastRules、evidence、openQuestions。只挑 3–6 个可以在语言中观察到的特征，涉及语域/句法节奏/词汇/对话策略/情态立场/幽默反讽/口语特征；不能凭性别、年龄、职业或刻板印象推断，不强加口头禅或方言。每条 evidence 必须包含输入中的 segmentId、短原文 sourceQuote、dimension、observation 和 0–1 confidence。',
  'relationshipVoiceRules 是有方向的 speakerId → addresseeId，描述 baselineRegister、addressTerms、directness、emotionalDistance、sceneDependentShift 和 evidenceSegmentIds。关系事实与关系语言规则不能混用。',
  'voiceAnchors 只能取有充分归属证据的短对白，包含 anchorId、speakerId、可选 addresseeId、source、target、chapter、segmentId、attributionEvidence、attributionConfidence、tags，status 必须为 candidate。attributionEvidence 必须是同一个 segmentId 内能逐字定位的原文证据（例如“X said/asked”等明确归属文本），attributionConfidence 必须在 0–1；低于 0.7 或没有明确归属证据时不生成锚点，而写入 openQuestions。不能把说话人猜测写成事实。已存在的 confirmed 画像不能被本次分析静默覆盖，冲突写入 openQuestions。',
  '新人物声音、关系语言规则、声音锚点全部输出 candidate，不能伪称人工审核。只返回 JSON 对象：{ "entities": [], "relationships": [], "styleGuide": {}, "chapterSummary": "", "characterVoices": [], "relationshipVoiceRules": [], "voiceAnchors": [], "openQuestions": [] }。styleGuide 可包含 narrativeVoice、register、rhythm、dialogue、diction、avoid。',
].join('\n');

/** 每个审校阶段只接受它自己负责的 finding 类别；合并阶段两者都收，但优先级规则不变。 */
export const REVIEW_FOCUS_CATEGORIES: Record<'accuracy' | 'style' | 'combined', string[]> = {
  accuracy: ['accuracy', 'terminology'],
  style: ['style'],
  combined: ['accuracy', 'terminology', 'style'],
};
