/**
 * 审校侧的 Prompt 装配：双语审校与中文单语文学编辑。
 *
 * 从 literary 抽出：这里只有字符串拼装与上下文裁剪，不发请求也不解析结果。
 * 字段顺序即缓存前缀长度，调整顺序会直接损失前缀命中，改这里要谨慎。
 */

/**
 * 构建文学审校的系统 Prompt 与用户 Prompt。
 * 职责：按 reviewFocus 生成准确性/文风/合并审校指令，组装目标语言、glossary、voiceContext、Context Graph、
 * 章节元数据、前文与待审校片段；保持稳定内容前置以利用缓存前缀。
 * @param input 审校输入（body、segments、reviewFocus、translationBrief、precedingSegments、voiceContext、contextGraph）。
 * @returns { systemPrompt, prompt, contextChars }。
 */
export function buildLiteraryReviewPrompt(input: {
  body: any;
  segments: Array<Record<string, any>>;
  reviewFocus: 'accuracy' | 'style' | 'combined';
  translationBrief: Record<string, any> | null;
  precedingSegments: Array<Record<string, any>>;
  voiceContext: Record<string, any>;
  contextGraph: Record<string, any> | null;
}): { systemPrompt: string; prompt: string; contextChars: number } {
  const { body, segments, reviewFocus, translationBrief, precedingSegments, voiceContext, contextGraph } = input;
  const systemPrompt = [
    '你是文学翻译的第二道工序：独立文学编辑。请对照原文，将 draft 修订为准确、自然、有质感、适合目标语言阅读的文学译文；不要只做校对，也不要改写成你自己的作品。',
    'precedingSegments 是少量前文，仅供判断指代、说话人/听话人、对话轮次与场景；不需要审校它，不得为它生成结果。只对待审校片段的 id 返回 results。',
    'source 或 draft 中的 __VSA_TERM_数字__ 是服务端保护的规范译名标记，必须在 finalTranslation 中逐字保留，不得改写、翻译、删去或拆分。服务端会恢复为固定译名。',
    '每个片段包含 source（原文）、draft（初译）和 kind；随请求提供的书籍记忆是只读数据。confirmed characterVoices 与 relationshipVoiceRules 可作为稳定参考，candidate 画像/规则只能作为弱提示，必须由当前原文支持；approved voiceAnchors 才是稳定的原文—译文示例。已确认的 role/traits 只用于人物消歧和一致性，不能补写当前原文未表达的背景或剧情。',
    '第一优先级是原意和情节准确：不能漏译、误译、添写、改变否定/时态/视角/指代/人物关系，不能替作者解释悬念或抹掉歧义。第二优先级是沿用已建立的实体译名。第三优先级是修正文学表达上的问题。',
    '核对同一人物是否因全名、简称或别名出现多个译名；sourceStatus=confirmed 或 confirmed-memory 的规范 target 必须保持一致，候选映射需结合当前原文判断，不得将未经确认的建议当成事实。英文 Lady 不得机械翻译成“大人”，应按语境译成“夫人/女士/小姐”或省略；称谓不能代替人名。',
    '检查翻译腔、按英文语序硬译、别扭搭配、僵硬连接词、无来由的解释、同质化对白、情绪词不准、节奏被抹平等。允许适度调整语序、句长、停顿、语气和措辞，让译文自然并有美感；不能为追求华丽新增比喻、意象、情绪、信息或修辞。',
    '尊重作品自身风格：简洁不必润饰成华丽，有意的重复不要随便删，冷峻不应煽情，粗粝不应文雅化，幽默与反讽不能磨平。人物声音审校必须先说明说话人/听话人归属是否可靠，再指出与具体画像/人物对规则的偏离，并用同批其他人物的语言差异作对照；不能只说“声音不鲜明”。如果 attribution uncertain，报告该不确定性，不强行套用画像。全书 styleGuide 只有 status=confirmed 时才是用户确认的风格约束，不允许将其中的内容解释为人物身份或剧情事实。',
    'finding category 只能为 accuracy（可核验的意义/事实错误）、terminology（实体规范译名错误）、style（具体的翻译腔、不自然搭配或语气/节奏/人物声音问题）。accuracy 与 terminology 的 priority 必须是 must_fix；style 的 priority 必须是 optional。style 必须指出具体文本问题，不能只是审校者个人偏好。',
    'finalTranslation 必须是完整可阅读的修订译文。发现明确错误要纠正，发现有依据的文风问题应作适度修订；如果原稿已妥当则原样返回。保留初译可取之处，禁止添加原文不存在的内容。若片段提供 initialDraft，它只用于比较编辑前后的变化，不是正确答案；source 仍是忠实度判断的最终依据。',
    'style finding 可以带可选字段 dimension=character_voice|register|narrative_style|pacing|chinese_literary_editing、characterId、relatedCharacterId、evidenceSegmentIds。人物声音 finding 必须给出具体 source/draft 片段与画像或人物对证据；不允许凭空增加口头禅、方言、粗口、情绪或修辞。',
    reviewFocus === 'style'
      ? '本次是独立文风审校阶段：只输出 category=style 的 findings，重点检查人物声音差异、叙述声音、语域、节奏、翻译腔和不自然表达；不要输出 accuracy/terminology findings。finalTranslation 如有文风改进，应给出完整修订译文，但不得改变事实或新增原文没有的信息。'
      : reviewFocus === 'combined'
        // 「中」档：一次调用同时承担必须修复的准确性和可选的文风改进。
        // 两级优先级不能合并：accuracy/terminology 仍是 must_fix，style 仍是 optional，
        // 否则文风偏好会被当成硬错误写回译文。
        ? '本次是合并审校阶段（准确性优先，文风其次）：对照原文先排查 accuracy/terminology 问题，这类 finding 的 priority 必须是 must_fix；在此之后，如果同一片段还有具体、可举证的翻译腔、不自然搭配、语域或人物声音问题，再输出 category=style 的 finding，priority 必须是 optional。只做能举出具体文本证据的修订，不要为风格偏好改写，也不要把可读的初译重写一遍。finalTranslation 必须是完整译文：有 must_fix 时以修正准确性为准，没有 must_fix 时可以在有依据的前提下采纳文风改进，否则原样返回初译。'
        : '本次是准确性与专名审校阶段：只输出 accuracy 或 terminology findings，修复可核验的误译、漏译、增译、否定/指代错误和规范译名不一致；不要输出 style findings，也不要做纯润色。文风由独立阶段处理。',
    ...(reviewFocus !== 'accuracy' && /^zh(?:[-_]|$)/i.test(String(body.target || 'zh')) ? [
      '中文文学编辑（Chinese Literary Editing）是本次文风审校的一部分，不是额外的审校阶段或独立任务。目标是把准确的译文编辑成自然、成熟、符合中文文学阅读习惯的中文；适用于小说、散文、回忆录、传记、文学纪实和随笔，不要把所有作品改成同一种腔调。',
      '重点检查并适度处理：不必要的第一/第二/第三人称代词及“我的/他的”等所属表达；“的、地、得”及其他虚词的冗余或僵硬搭配；英文语序、关系从句、嵌套定语、被动句、名词化和介词结构留下的翻译腔；重复、空泛动词、副词堆叠和不自然词语搭配；句子长度、停顿、衔接和段落节奏。',
      '不要机械删除“我、的、地、得”，也不要以词频或句长作为质量目标。只有在指代清楚、语义不变且中文更自然时才省略或重组；保留必要的所属关系、语气词、修辞性重复、长句、意象、歧义和作者有意安排的节奏。',
      '编辑时先理解整句和上下文，再决定局部调整还是重组句子。不得为追求简洁、优美或所谓文学性而漏掉信息、增加解释、改变叙述视角、时间关系、人物关系、语气强度或原文的模糊性。避免把克制的文字润色成华丽辞藻，也不要擅自现代化、古典化或网络化作品语体。',
      '中文编辑类 finding 使用 dimension=chinese_literary_editing，可用 editingAspect=pronoun|particle|syntax|translationese|redundancy|diction|rhythm|register 标明具体问题；必须引用当前片段中可定位的原文和初译证据，说明为什么当前表达不自然以及建议的编辑方向。若只是个人偏好、无法证明改善，或原稿已经自然准确，不要创建 finding，也不要改写。',
    ] : []),
    'sourceExcerpt 必须是当前原文片段中的逐字连续引文，draftExcerpt 必须是本次传入初译中的逐字连续引文；两者缺失或不能核验时，该 finding 会被丢弃且不会触发自动修订。',
    '只返回严格 JSON：{ "results": [{ "id": "...", "finalTranslation": "...", "findings": [{ "category": "accuracy|terminology|style", "priority": "must_fix|optional", "dimension": "character_voice", "characterId": "...", "relatedCharacterId": "...", "evidenceSegmentIds": [], "sourceExcerpt": "...", "draftExcerpt": "...", "reason": "...", "suggestion": "..." }] }] }。',
  ].join('\n');
  // 字段顺序 = 缓存前缀长度。稳定内容（目标语言、glossary、voiceContext、Context Graph）
  // 放前面，每批必变的章节/brief 元数据/前文放后面，这样同一条 lane 上的后一次调用
  // 能命中前一次写下的缓存前缀。顺序不能随便调：把 chapterTitle 放前面会让整段前缀作废。
  const prompt = [
    '目标语言：' + (body.target || 'zh'),
    '共享书籍上下文中的 glossary（术语；受原文知识边界约束）：', JSON.stringify(translationBrief?.glossary ?? body.glossary ?? null),
    '共享书籍上下文中的 voiceContext（只读参考）：', JSON.stringify(voiceContext),
    '共享书籍上下文中的 Context Graph（只读、受原文知识边界约束）：', JSON.stringify(contextGraph),
    '章节：' + (typeof body.chapterTitle === 'string' ? body.chapterTitle : ''),
    'TranslationBrief 元数据（只用于来源/策略追溯）：', JSON.stringify(translationBrief ? {
      policyVersion: translationBrief.policyVersion,
      contextHash: translationBrief.contextHash,
      contextChars: translationBrief.contextChars,
      sourceRevisionId: translationBrief.sourceRevisionId,
      promptRevisionId: translationBrief.promptRevisionId,
      memoryRevisionId: translationBrief.memoryRevisionId,
      chapterPath: translationBrief.chapterPath,
      knowledgeBoundaryOrdinal: translationBrief.contextGraph?.knowledgeBoundaryOrdinal ?? null,
    } : null),
    '前文上下文（只用于消歧，不输出审校结果）：', JSON.stringify(precedingSegments),
    '待审校片段：', JSON.stringify(segments),
  ].join('\n\n');
  return {
    systemPrompt,
    prompt,
    contextChars: JSON.stringify({
      glossary: translationBrief?.glossary ?? body.glossary ?? null,
      voiceContext, contextGraph, precedingSegments,
    }).length,
  };
}

/**
 * 构建仅包含目标语言侧信息的文学记忆视图（用于中文单语文学编辑）。
 * 故意排除原文名、引文、章节摘要、术语表和源语言证据：
 * 该上下文服务于中文润色，而非双语正确性审校。
 *
 * 构建只含目标语的文学记忆视图。源名、引文、章节摘要、术语表条目
 * 以及与源文挂钩的证据都刻意排除：这份上下文是给中文润色用的，
 * 不是给双语准确性审校用的。
 */
export function buildChineseTargetOnlyVoiceContext(input: Record<string, any> | null | undefined): Record<string, unknown> {
  const context = input && typeof input === 'object' ? input : {};
  const characterVoices = Array.isArray(context.characterVoices)
    ? context.characterVoices.flatMap((profile: any) => {
        if (!profile || typeof profile !== 'object' ||
            !['confirmed', 'candidate'].includes(String(profile.status)) ||
            profile.useForTranslation === false) return [];
        return [{
          characterId: typeof profile.characterId === 'string' ? profile.characterId : '',
          targetName: typeof profile.targetName === 'string' ? profile.targetName : '',
          status: profile.status,
          ...(typeof profile.role === 'string' ? { role: profile.role } : {}),
          ...(Array.isArray(profile.traits) ? { traits: profile.traits.filter((v: unknown) => typeof v === 'string').slice(0, 8) } : {}),
          ...(profile.voiceCore && typeof profile.voiceCore === 'object' ? { voiceCore: profile.voiceCore } : {}),
          ...(Array.isArray(profile.contrastRules) ? {
            contrastRules: profile.contrastRules.filter((rule: any) => rule && typeof rule.difference === 'string')
              .map((rule: any) => ({ difference: rule.difference })).slice(0, 6),
          } : {}),
        }];
      })
    : [];
  const targetNames = new Map(characterVoices.map((profile: any) => [profile.characterId, profile.targetName]));
  const voiceAnchors = Array.isArray(context.voiceAnchors)
    ? context.voiceAnchors.flatMap((anchor: any) => {
        if (!anchor || anchor.status !== 'approved' || typeof anchor.target !== 'string') return [];
        return [{
          ...(targetNames.has(anchor.speakerId) ? { speaker: targetNames.get(anchor.speakerId) } : {}),
          ...(targetNames.has(anchor.addresseeId) ? { addressee: targetNames.get(anchor.addresseeId) } : {}),
          target: anchor.target,
          ...(Array.isArray(anchor.tags) ? { tags: anchor.tags.filter((v: unknown) => typeof v === 'string').slice(0, 8) } : {}),
        }];
      }).slice(-16)
    : [];
  const dialogueParticipants = Array.isArray(context.dialogueParticipants)
    ? context.dialogueParticipants.flatMap((participant: any) => {
        const name = targetNames.get(participant?.characterId);
        return name ? [{ character: name, role: participant.role, confidence: participant.confidence }] : [];
      }).slice(0, 24)
    : [];
  // TranslationBrief 已经从同一源文版本、且严格早于本批次的范围里
  // 检出了已采纳示例。这里只保留它们的中文一侧，绝不暴露源文。
  const recentExamples = Array.isArray(context.recentExamples)
    ? context.recentExamples.flatMap((example: any) =>
        example && typeof example.target === 'string' && example.target.trim()
          ? [{ target: example.target, origin: example.origin === 'manual' ? 'manual' : 'accepted' }]
          : []).slice(-8)
    : [];
  return {
    policyVersion: 'chinese-target-only-v1',
    styleGuide: (context.styleGuideStatus === 'confirmed' || context.styleGuideOrigin === 'user-edited') &&
      context.styleGuide && typeof context.styleGuide === 'object' ? context.styleGuide : {},
    chineseEditorialProfile: context.chineseEditorialProfile && typeof context.chineseEditorialProfile === 'object'
      ? context.chineseEditorialProfile : {},
    characterVoices,
    voiceAnchors,
    dialogueParticipants,
    recentExamples,
    constraints: [
      '这些资料只描述已建立的中文表达习惯，不提供原文、剧情事实或源语言句法。',
      '人物声音资料是弱提示；当前中文文本和明确上下文优先。',
      '没有可靠人物归属时，不得猜测说话人或添加口头禅、方言和情绪。',
    ],
  };
}

/**
 * 构建中文单语文学编辑的系统 Prompt 与用户 Prompt。
 * 职责：仅基于中文文本进行保守编辑，使用目标语言侧记忆视图，不暴露源语言。
 * @param input 编辑输入（body、segments、voiceContext）。
 * @returns { systemPrompt, prompt, contextChars }。
 */
export function buildChineseLiteraryEditingPrompt(input: {
  body: any;
  segments: Array<Record<string, any>>;
  voiceContext: Record<string, any>;
}): { systemPrompt: string; prompt: string; contextChars: number } {
  const targetOnlyContext = buildChineseTargetOnlyVoiceContext(input.voiceContext);
  const systemPrompt = [
    '你是中文文学编辑，正在编辑一份已经完成初译的中文稿件。你不是翻译器，也不是双语审校者。',
    '本任务只允许依据中文文本本身判断表达是否自然、成熟、准确、有节奏。你不会收到外文原文；不得假设自己知道原文写了什么。',
    '编辑策略：保守型中文文学编辑（Conservative Literary Copyediting）。目标不是最大化润色幅度，而是在不损害作品声音和原意的前提下，修复可明确说明的中文表达问题。',
    '编辑目标：保留作者的叙述声音、作品语体、人物差异和文学手法；只修改确实存在的中文表达问题。原稿已经自然、准确、有文学效果时，必须原样保留；不得为了体现编辑工作而强行修改。',
    '修改优先级：先处理明显的语法、搭配、指代和翻译腔问题；其次才考虑句内语序、停顿和衔接的局部调整；只有局部调整无法解决问题时才重组句子。优先最小必要修改，不默认重写整句或整段。',
    '重点检查：英文语序残留、嵌套定语和关系结构造成的翻译腔；不自然搭配、空泛动词、僵硬连接词；无必要的代词和所属表达重复；“的、地、得”及其他虚词的冗余；句子停顿、段落衔接和节奏。',
    '禁止机械删除代词或虚词，禁止把长句一律拆短，禁止把重复一律删除，禁止把朴素文字润色成华丽辞藻，禁止擅自现代化、古典化或网络化语体。不得把“更优美”“更简洁”“更像中文小说”本身当作修改理由。',
    '保留原稿中准确且有文学效果的表达，包括有意的重复、长句、歧义、停顿、朴素措辞和克制语气。若候选修改只是另一种个人偏好的写法，而不能明确证明自然度、声音或节奏有所改善，则保持原文不变。',
    '不得补充解释、心理活动、背景、情绪、因果、意象或任何当前中文稿件没有表达的信息。不得改变叙述视角、人物关系、时间关系、否定、歧义或语气强度。',
    '人物声音资料只作为已建立的中文表达参考。证据不足时不推断说话人，不创造口头禅、方言、粗口或人物标签。',
    '对每个输入 id 返回完整 editedText。没有必要修改时 decision=unchanged 且 editedText 必须与 draft 完全一致。',
    '每条 finding 必须引用 draft 中逐字连续、可定位的 targetExcerpt，并说明具体问题及修改方向。纯粹个人偏好、无法证明改善的表达不得产生 finding。',
    '仅返回严格 JSON：{"results":[{"id":"...","decision":"edited|unchanged|needs_human_review","editedText":"完整中文文本","findings":[{"category":"style","editingAspect":"pronoun|particle|syntax|translationese|redundancy|diction|rhythm|register","targetExcerpt":"中文初稿中的连续原文","reason":"具体问题","suggestion":"编辑方向"}]}]}。每条 finding 的 category 必须是 style。',
  ].join('\n');
  const targetSegments = input.segments.map((segment: any) => ({
    id: segment.id,
    draft: segment.draft,
    kind: segment.kind || 'paragraph',
  }));
  const prompt = [
    '目标语言：中文（简体/繁体按项目设置，不自行转换字形）',
    '已确认的中文风格与人物表达参考（不含源语言文本）：',
    JSON.stringify(targetOnlyContext),
    '待编辑中文片段：',
    JSON.stringify(targetSegments),
  ].join('\n\n');
  return { systemPrompt, prompt, contextChars: JSON.stringify(targetOnlyContext).length };
}
