# Minowara 译名漂移分析报告

**日期：** 2026-10-26  
**仓库：** `saga/vocal-saga`  
**范围：** `local-agent-service` 文学翻译链路；只做根因分析，不修改翻译代码。

## 1. 结论摘要

这不是简单的“模型词库里没有 Minowara”。更有可能的直接原因是：**Minowara 没有以一个已确认的规范专名映射进入本次翻译请求的确定性保护链路，模型因此可以按当前句子的语境自由选择译法。** 第一次按读音生成“米诺原”；第二次看到 “Minowara Shōguns” 以及 samurai families、Emperor、Shōgunate 等日本幕府历史语境，又把这个虚构氏族名归并到它熟悉的真实历史原型“源氏 / Minamoto”，于是生成“源氏一门将军”。

因此，这里至少有两种问题叠加：

1. **专名统一没有被确定性执行。** 同一原文名称被允许因句子语境不同而出现不同译法。
2. **语义类比越界。** 模型把文学作品中的虚构氏族名替换成了它背后的历史原型。即使源氏是作者塑造 Minowara 时参考的历史背景，也不能据此把小说里的名字直接翻成“源氏”。

“米诺原”本身是模型自由生成的一种音译；“源氏”则更像根据历史知识作出的语义归一化。两者都不应取代项目已经采用的规范译名。

## 2. 原文名称的语义边界

这段文本出自 James Clavell 的小说《Shōgun》所使用的日本历史背景与虚构氏族体系。公开资料将 Minowara 描述为小说创作的虚构氏族，并指出其设定借鉴了真实的 Minamoto（源氏）以及 Matsudaira 等家族。参考：[The Escapist — Shōgun: What Is the Minowara Bloodline?](https://www.escapistmagazine.com/shogun-what-is-the-minowara-bloodline/)；相关背景资料：[Learning from Shōgun: Japanese History and Western](https://hirado.nl/shogun.pdf)。

这里必须区分三个层次：

| 层次 | 关系 | 翻译处理 |
|---|---|---|
| 原文专名 | **Minowara**，小说中的虚构氏族名 | 应保留小说自己的命名体系，并采用项目统一的中文译名 |
| 历史原型 | Minamoto / Genji（源氏）等真实氏族 | 用于理解作者的历史借鉴，不应直接替换原文专名 |
| 词组中的类别词 | Minowara Shōguns | 应将规范译名与“将军/将军家/幕府”等类别词自然组合，而不是改掉氏族名 |

所以，如果当前项目既有译文大多使用“蓑原”或“美浓原”，就应在项目术语中选择并确认**一个**规范译名，再将同一名称的所有出现统一处理。不建议把“蓑原”“美浓原”“源氏”同时列作可互换译名。“源氏”在本句中不是可靠的规范译名；它会把小说中的虚构氏族直接变成真实历史氏族，丢失作者刻意构造的名称差异。

报告不替项目做最终的“蓑原”还是“美浓原”选词决定，因为这一点应以项目已经接受的译文、既定翻译方案及人工确认结果为准。

## 3. 代码链路分析

### 3.1 模型生成之前，名称保护是否真的启用，取决于映射状态

主要代码：

- [`translationAgent.ts`](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationAgent.ts#L368-L428)
- [`translationAgent.ts`](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationAgent.ts#L431-L447)
- [现有测试：candidate-only mapping 不强制](https://github.com/saga/vocal-saga/blob/main/local-agent-service/tests/document-agent-prompt.test.mjs#L368-L380)

`buildCanonicalTermProtections()` 并不是把所有识别到的名称都变成硬规则。它只接受以下状态的映射：

- `confirmed-memory`
- `confirmed`
- `auto`

`candidate` 映射被有意排除。对于有效的强映射，服务端会把原文名称替换成类似 `__VSA_TERM_000__` 的标记，模型生成之后再确定性还原成规范中文名。这才是能可靠避免同一名称漂移的关键机制。

仓库测试明确规定：只有 `sourceStatus: 'candidate'` 的映射必须返回空保护列表，不能强制应用。因此，“模型上下文里曾出现过某个译名”“角色卡上看得到某个建议译名”和“本次请求实际强制使用这个译名”是三个不同状态。

### 3.2 Context Graph 的候选专名并不会自动升级为强约束

主要代码：[ `contextGraph.ts`](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/contextGraph.ts#L1828-L1890) 和 [名称映射构造](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/contextGraph.ts#L1990-L2106)。

Context Graph 中的规范译名来自 `suggestedTranslation`，但构造映射时还有几层限制：

1. 原文规范名称必须在当前或前文中可见。
2. 对应证据必须符合当前批次的时间边界。
3. 目标语言必须与当前任务匹配。
4. 如果节点没有确认，系统还要求此前被接受的译文中已经出现过该目标译名，否则就把映射排除。
5. 即使这个候选最终进入 `nameMappings`，代码仍将它标记为 `sourceStatus: 'candidate'`，而不是硬映射。

这套约束是为防止模型从书后章节的身份揭示中提前获得信息，方向本身是合理的。但它意味着：**模型曾经把 Minowara 译成“蓑原”，甚至历史上存在已接受译文，都不必然意味着下一批的 Minowara 会被强制译成“蓑原”。**

### 3.3 LiteraryMemory 里的实体也需要达到正确状态

主要代码：[ `translationBrief.ts`](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationBrief.ts#L796-L882)。

`TranslationBrief` 会将符合条件的项目实体合并到 `contextGraph.nameMappings`：

- 人工确认的实体可以生成 `confirmed-memory` 映射。
- 目标译名有足够独立证据支持时，可以生成 `auto` 映射。
- 其他实体仍保持 `candidate`。

这些强映射再交给 `buildCanonicalTermProtections()`。如果项目中没有 Minowara 的已确认实体映射，或者记录的来源、别名、证据、语言方向不符合注入条件，服务就不会对它建立确定性保护。

换句话说，**并不是模型不能记住译名，而是系统没有把“项目认定的规范名”作为必然生效的结构化事实传到模型输入及输出还原环节。**

### 3.4 术语表不是自动生效的全书人名知识库

主要代码：[ `translationBrief.ts`](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationBrief.ts#L600-L645) 与 [提示词组装](https://github.com/saga/vocal-saga/blob/main/local-agent-service/src/documents/translationAgent.ts#L702-L735)。

文学翻译模式下，`TranslationBrief` 会筛选当前批次相关的已配置术语表，同时组装时间边界受限的记忆和 Context Graph。不能假定“以前翻译过这个名称”就会自动生成一个全书有效、且带硬约束的 glossary 项。提示词里即便含有候选译名，也不能代替确定性保护。

因此，这个故障更像是**项目专名知识的状态与执行链路问题**，而不是简单把 prompt 再加一句“注意人名统一”就能彻底解决的问题。

## 4. 为什么第一处是“米诺原”，第二处却成了“源氏”？

原文的第一次出现强调三个对立氏族之间的政治斗争：

> After sixty years the Minowara prevailed over the Takashima ...

这里模型采用了接近音节的自由音译“米诺原”。当名称再次出现在：

> the Minowara Shōguns dominated the realm ...

它与 “Shōguns”“Emperor”“Imperial line”“samurai families” 以及日本古代政治制度处于同一语境。模型可能把 Minowara 识别为类似 Minamoto 的历史借代，于是将其直接译为“源氏”。这种推断在背景解释层面可以帮助理解作品，但在文学翻译中越过了专名保留的边界。

若两个句子位于**同一次模型请求**，没有确定性保护时，模型依然可能在一段输出中对重复名称作不同处理；若它们位于**不同批次或不同运行**，则当前批次检索到的记忆、先前已接受译文、Context Graph 状态和提示词也可能不同，差异会更明显。

这两个路径都与当前架构相容。仅凭最终译文无法判断它们究竟是否在同一个 batch，也无法确认这次请求中的具体 `nameMappings` 内容；需要该次运行的 prompt audit 或 translation-chain-dump 才能把概率判断落到具体运行证据上。

## 5. 为什么“模型没有这个词”的解释不够

大模型的预训练知识并不是一个可以查询和保证每个小说专名准确性的权威术语库。即使模型从训练资料中知道 Minowara，也可能不知道本项目约定的中文写法；即使知道 Minowara 与源氏有历史原型关系，也可能在某个上下文里过度归一化。

本案例的特征更符合以下链条：

```
Minowara 的项目规范译名没有作为强映射生效
                ↓
原文被直接交给模型自行翻译
                ↓
模型按局部语境选择不同策略
                ↓
音译“米诺原”与历史归并“源氏”同时出现
```

如果 Minowara 已存在确认状态为 `confirmed-memory` 的实体记录，并且运行日志证明本批次的 `nameMappings` 与 `protectedTerms` 均含有该名称，但最终译文仍出现“源氏”，那么这就不是单纯的候选映射缺失；应该继续检查模型请求中的占位符是否完整、marker 计数校验是否通过，以及初译之后是否有 Reviewer 或质量修复环节重新生成了未受相同保护约束的文本。

## 6. 现有项目实践已记录过同类故障

仓库已有 [`yabu-translation-inconsistency-analysis.md`](https://github.com/saga/vocal-saga/blob/main/yabu-translation-inconsistency-analysis.md) 和 [`translation-naming-consistency-plan.md`](https://github.com/saga/vocal-saga/blob/main/translation-naming-consistency-plan.md)，描述了 Yabu 角色卡有“薮”但译文仍出现“矢部”“彌虎”的同类现象。

其中记录的核心机制与本次情况一致：角色卡存在不代表硬映射生效；候选映射被过滤；候选映射需要满足历史已接受译文与时间边界条件；项目记忆和 Context Graph 的确认状态可能不同步；没有 masking 时，模型可以自由产生多个音译。

这说明 Minowara 不是孤立的专名冷僻问题，而是当前文学翻译体系中“专名知识如何成为可执行规范”的系统性问题。已有计划文件仍标明是规划内容，不应将计划中列出的目标误认为所有相关行为都已经实现。

## 7. 修复建议

### P0：先用一次真实运行确定证据，不要仅改 prompt

用仓库现有只读工具对发生问题的项目、Run 和 Batch 导出链路：

```bash
cd local-agent-service
node --import tsx scripts/translation-chain-dump.mjs \
  --project "<项目名或项目 ID>" \
  --run "<实际 Run ID>" \
  --batch <实际 batch index> \
  --term "Minowara" \
  --out /tmp/minowara-translation-chain.json
```

工具会输出关键链路信息而不调用模型、不发 HTTP，也不修改 SQLite。应核对：

- 本次运行的 `translationMode`、source revision、prompt revision 和 memory revision；
- `contextGraph.nameMappings` 中是否有 Minowara、目标译名及 `sourceStatus`；
- 是否发生证据、时间边界、目标语言或先前译名检查排除；
- `buildCanonicalTermProtections` 实际产生了什么映射，初译文本中是否出现对应 marker；
- 实际送出的 prompt 是否携带规范映射；
- Reviewer/修复请求有没有使用相同的专名保护；
- 最终接受译文与首次模型返回值是否一致。

报告生成前未获得本次问题对应的本地 SQLite 数据库或确切 Run 的完整 prompt audit，因此本文对**具体运行是哪一层没有注入映射**保留这一证据限制；代码级的候选映射不强制机制是已确认的。

### P1：把 Minowara 变成一个已确认的项目规范译名

在项目人名/术语管理中，选择已经使用的规范译名（例如项目决定使用“蓑原”时，设置 `Minowara → 蓑原`），并由人工确认。不要仅把目标译名写入候选 Context Graph，也不要把“源氏”登记为 Minowara 的别名。

名称粒度建议以 `Minowara` 为规范来源；“the Minowara”“Minowara Shōguns”等表达根据实际数据和安全规则作为别名或上下文变体处理。类别词 `Shōguns` 仍由普通翻译自然处理。不要把 `Minamoto` / `Genji` 设为同义别名，因为它们是历史原型关联，而不是原文中的等价专名。

### P2：给确认过的文学专名提供跨批次的确定性保护

对已确认且在当前原文中出现的规范名，应该保证从首次出现起就能进入 masking/restore，而不是依赖后续章节的证据或先前译文先出现一次。该行为必须保持现有时间边界对剧情事实、人物关系和身份揭示的约束：**只允许提前使用已确认的纯名称映射，不允许因此提前注入后文剧情。**

同时要对 Reviewer 与修复阶段使用相同的强名称映射，并检查每个 marker 出现与还原次数。否则初译阶段统一了人名，之后的 Reviewer 仍可能再将它改成“源氏”。

### P3：增加针对本例的回归测试

新增一个最小测试，源文包含两处：

- `the Minowara prevailed over the Takashima`
- `the Minowara Shōguns dominated the realm`

当项目中 `Minowara → 蓑原` 已确认时，提示词发送前两处均应被 masking；模型返回后，两处都应还原成同一个规范名，不应出现“米诺原”或“源氏”。还应覆盖候选状态、同一批次/跨批次、名称带修饰语、Reviewer 修订、确认映射冲突，以及后续别名尚未出现时的时间边界测试。

## 8. 诊断结论

对这次译文，最合理的根因判断是：

**第一层根因：Minowara 的项目规范译名没有在这次输出中获得有效的确定性约束，模型可以自由选词。第二层根因：模型利用日本幕府历史语境，将虚构的 Minowara 与其历史原型 Minamoto/源氏混同，导致“米诺原”变成“源氏”。**

解决方向不是要求模型“记住这个词”或单纯添加一句风格提示，而是让项目选定的规范译名成为可审计、版本固定、跨批次稳定、在初译与 Reviewer 中都可执行的结构化映射。最后应通过真实运行链路和针对该原文的回归测试，确认到底是映射从未存在、被边界规则排除、状态仍为 candidate，还是后续某一步覆盖了已统一的名称。
