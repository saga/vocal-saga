# 文风基准 + 实体译名表 质量问题分析与修改计划

项目：Shogun（`4fa564de-b0ec-485d-88dc-562ad1bf66d3`），当前记忆 revision `2026-10-26T07:22:26Z`
涉及仓库：`vocal-saga/local-agent-service`（服务端）、`fanyi-extension`（扩展）
分析时间：2026-10-26

---

## 结论摘要

| # | 问题 | 性质 | 影响面 |
|---|---|---|---|
| 1 | 文风基准只有「叙述声音」「规则」两项有内容 | 数据其实齐全，是**陈旧的一次性导入 + 空值固化 + 500 字截断** | 后续所有文学翻译的风格约束只生效了 1/5 |
| 2 | `God→上帝`、`Japan→日本`、`England→英格兰` 进入实体译名表 | **没有任何"值得纳入"闸门**，模型产出什么就收什么 | 62 个非人物实体里 50 个已 confirmed，噪声压过有效信息 |
| 3 | `Dozo / neh / Ingeles` 这类斜杠合并实体 | **模型把多个术语塞进一个 entity，服务端原样接受，从不拆分** | 6 条脏节点，其中 1 条目标串是 `船长（敬称）／大人` |
| 4 | `Achiko → achi子` | **目标译名没有语言纯度校验**（拉丁残留无人拦截），且旧记忆 confirmed 后不回看新图谱 | 至少 1 条已确认的错误人名 |

好消息：这些脏映射目前**还没污染译文**。全库 `translation_results` 中 `／`、`achi子`、`英吉利人` 命中数均为 0。属于"污染源已在，污染尚未发生"，现在修成本最低。

---

## 一、文风基准为什么只有两项

### 1.1 数据源是完整的

`context_graph_meta` 实测（当前 revision）：

| 字段 | 长度 |
|---|---|
| narrativeStyle | 626 |
| styleRegister | 618 |
| styleRhythm | 615 |
| styleDialogue | 1000 |
| styleDiction | 733 |
| styleRules | 8 条 |
| styleAvoid | 6 条 |

直接调用 `getContextGraphStatus(projectId)`（`contextGraph.ts:1587`）返回的 `overview` 五个字段全部非空。**所以「载入预处理文风建议」现在点一次就能填满 6 项。**

### 1.2 记忆里存的是另一份更早的数据

`literary_memory_revisions` 当前 revision 的 `styleGuide`：

```
narrativeVoice | 216 字（内容是「第三人称全知叙事，视点在多个人物间切换…」，与图谱那份措辞不同）
register       | 0
rhythm         | 0
dialogue       | 0
diction        | 0
rules          | 12 条（图谱只有 8 条）
avoid          | 0
```

字段数和条数都对不上图谱，说明这份 `styleGuide` 来自**更早的一次分析**（B 方案工作流之前），之后从未重新导入。四个空字段是**显式空串**，不是缺失。

### 1.3 四个具体缺陷

**A. 服务端把"缺失"固化成"空串"** — `voiceContext.ts:219-224`

```ts
const styleGuide = {
  narrativeVoice: text(style.narrativeVoice, 500), register: text(style.register, 500),
  rhythm: text(style.rhythm, 500), dialogue: text(style.dialogue, 500), diction: text(style.diction, 500),
  rules: list(style.rules, 16, 240), avoid: list(style.avoid, 12, 100),
};
```

每次保存记忆都会生成全部 7 个键，缺的写成 `''`。于是一旦某次导入只带了一部分字段，空串就永久留在库里，后续任何"只补非空字段"的合并逻辑都救不回来。

**B. 长度上限不一致，导入即截断** — 图谱侧 `safeText(..., 1000)`（`contextGraph.ts:1181-1184`），扩展侧 `sanitizeLiteraryMemory` 对 5 个字段统一 `safeText(styleRaw[key], 500)`（`literary.ts:413-416`）。`styleDialogue`（1000 字）必然被砍掉一半，`styleDiction`（733）也会被砍。

**C. 导入是一次性手动拷贝，没有"图谱已更新"提示** — `importContextGraphStyleGuide`（`useLiteraryMemoryEditor.ts:529`）只在字段非空时覆盖，且界面上没有任何"图谱有更新版本"的标记。用户不会知道要再点一次。

**D. 指纹只覆盖 2 个字段** — `projectStore.ts:1201`

```sql
SELECT key, value FROM context_graph_meta WHERE source_revision_id = ? AND key IN ('narrativeStyle','styleRules')
```

改 `register`/`rhythm`/`dialogue`/`diction` 不会让已有译文变 `stale`，缓存失效不完整。

### 1.4 修改计划

| 优先级 | 位置 | 改动 |
|---|---|---|
| P0 | `voiceContext.ts:219-224` | 空值不写键（`...(v ? {k: v} : {})`），杜绝空串固化 |
| P0 | `literary.ts:413-416` | 上限从 500 提到 1000，与服务端/图谱对齐；或按字段分别设限 |
| P0 | `useLiteraryMemoryEditor.ts:529` + 面板 | 导入改为「差异合并」：字段非空才覆盖，并统计"本次补全 N 项"；面板顶部显示「图谱文风建议已更新（5 项），点击载入」 |
| P1 | `projectStore.ts:1201` | 指纹纳入全部 5 维 + rules + avoid |
| P2 | `contextGraph.ts` 完成事件 | 图谱完成时把 styleGuide 自动写成 `candidate`（不自动确认），用户只需确认 |

验收：重新导入后 `literary_memory_revisions.styleGuide` 五个字段长度分别为 500/618/615/500/733（截断修好后为原始长度），`rules` 8 条。

---

## 二、为什么显而易见的地名国名也进了表

### 2.1 数据现状

实体译名表 = `literaryMemory.entities.filter(kind !== 'person')`（`useLiteraryMemoryEditor.ts:44`），当前 **62 项，其中 50 项 confirmed**。

明显不该进来的：

```
God        → 上帝        Japan      → 日本        England    → 英格兰
the Queen  → 女王        the Emperor→ 天皇        Heir       → 继承人
longitude  → 经度        pigeon     → 信鸽        saké       → 清酒
samurai    → 武士        ninja      → 忍者        Portuguese → 葡萄牙
Spaniards  → 西班牙      Japmen     → 日本人      cha        → 茶（茶道）
```

这些都是**通用词典就能正确处理的词**，模型不需要任何约定。它们挤占了 62 项里的绝大多数，真正需要约定的（`Anjiro→安次郎`、`Ikawa Jikkyu→井川峠`、`the Black Ships→黑船`）反而被淹没。

### 2.2 根因：整条链路没有任何"值得纳入"的判断

1. **分析模型**把普通名词、国名、语言名、宗教通名都当 entity 产出。提示词（`contextGraph.ts:765/773`）只要求"重要实体"，没有排除清单。
2. **服务端**只校验两件事：name 非空、证据能在原文里找到（`contextGraph.ts:1231-1266`）。`kind` 字段是模型自由填的（实测出现过 `deity/术语`、`country`、`term / language register`、`term/monetary`），根本不是枚举，无法据此过滤。
3. **扩展自动确认**：`autoConfirmLiteraryMemory`（`literary.ts:779-784`）只要 `source + target + evidenceRefs 命中原文` 就置为 `confirmed`，`confirmationSource='evidence-verified'`。**没有 kind 门槛、没有词表、没有目标名质量检查。**

```ts
for (const entity of memory.entities) {
  if (entity.reviewStatus !== 'confirmed' && entity.source && entity.target && refsMatchSource(entity.evidenceRefs)) {
    entity.reviewStatus = 'confirmed';   // ← 唯一条件
    entity.confirmationSource = 'evidence-verified';
  }
}
```

所以 `God→上帝` 因为"证据确实在原文里"就被当成"已纳入规范"。

### 2.3 修改计划

| 优先级 | 位置 | 改动 |
|---|---|---|
| P0 | `literary.ts` 新增 `entityWorthMapping()` | 三道闸：① `kind` 白名单（place/organization/work/artifact/title/person）；② 停用词表（国家、语言、民族、宗教通名、度量单位、常见称谓）；③ 目标名 == 通用直译（`Japan→日本`、`God→上帝` 这类）判为低价值 |
| P0 | `literary.ts:779` | `autoConfirmLiteraryMemory` 先过 `entityWorthMapping()`，不通过则不确认（保留 suggested 或直接剔除） |
| P0 | `contextGraph.ts:765/773` 提示词 | 增加排除条款：国名/语言名/宗教通名/普通名词不产出 entity；只产出"译名存在多种可能、需要全书统一"的专名 |
| P1 | `contextGraph.ts:1231` | `kind` 归一化为固定枚举，非法值落 `other`；`other` 不进入译名表 |
| P1 | `useLiteraryMemoryEditor.ts:44` | 实体译名表默认只显示 `entityWorthMapping` 通过的项；其余折叠为「低价值实体（N）」 |
| P2 | 存量数据 | 一次性脚本把命中闸门的 confirmed 实体降级为 `suggested`，不删（保留可追溯） |

验收：重跑分析后，`God`/`Japan`/`England`/`the Queen`/`Heir`/`longitude` 等不再出现在实体译名表；非人物实体从 62 项降到 15 项以内，且全部是真正需要约定的专名。

---

## 三、斜杠合并实体为什么不拆

### 3.1 证据

`context_graph_nodes` 中 name 含 `/` 的节点：

```
entity    | England / Netherlands / Spain / Portugal / France → 英格兰／尼德兰／西班牙／葡萄牙／法国
entity    | Christian / Jesuits / God                        → 基督徒／耶稣会／上帝
entity    | Dozo / neh / Ingeles                             → 请／呢／英吉利人
entity    | English / England                                → 英格兰
entity    | cutting off / seppuku                            → 切腹
character | Yabu-sama / Lord Yabu                            → 矢部
```

同类问题还有目标侧带斜杠的：`Sire → 船长（敬称）／大人`、`Council → 御众（议和班）`、`Crimson Sky → “绯红天空”`（带引号）、`Erasmus → “厄拉斯谟”号`。

### 3.2 根因

模型在 `workflow-entities` 阶段把"同一语义场的一组词"合并成一个 entity 输出。服务端 `safeText(raw.name, 120)`（`contextGraph.ts:1232`）原样接受，**没有任何拆分或拒绝逻辑**；`suggestedTranslation` 同样原样接受（`contextGraph.ts:1236`），于是"多个源词 ↔ 多个目标词"被当成一条映射。

后果比噪声更严重：`buildCanonicalTermProtections`（`translationAgent.ts:368-421`）只要求 target 非空，会把 `船长（敬称）／大人` 整串当成规范译名注入。目前尚未命中（全库 `／` 命中 0），但只要某一批里出现 `Sire`，输出就会直接蹦出 `船长（敬称）／大人`。

### 3.3 修改计划

| 优先级 | 位置 | 改动 |
|---|---|---|
| P0 | `contextGraph.ts:1231` 前 | `splitCompoundEntityName()`：按 `/`、`／`、`,` 拆分；每个片段都能独立成立且有各自证据 → 拆成多个候选；否则整条丢弃，计入 `entityCandidatesDroppedForCompoundName` |
| P0 | `contextGraph.ts:1236` | `isSingleTargetName()`：目标含 `/`、`／`、`、`、括号注释、引号 → 直接丢弃该 entity（一个源名只能有一个目标） |
| P0 | `translationAgent.ts:381-385` | `buildCanonicalTermProtections` 增加目标合法性检查，非法目标不生成 `__VSA_TERM__` 标记 |
| P1 | `contextGraph.ts:765` 提示词 | 明确禁止："一个 entity 只能对应一个源名称和一个目标译名；多个术语必须分别列出" |
| P2 | 存量数据 | 6 条斜杠节点 + 3 条多目标节点一次性清理（拆分或删除） |

验收：新增单测覆盖 `Dozo / neh / Ingeles`、`England / Netherlands / …`、`Sire → 船长（敬称）／大人` 三种形态；重跑分析后 name 含 `/` 的节点为 0。

---

## 四、`Achiko → achi子` 是怎么来的

### 4.1 证据

```
literary_memory.entities: { source:"Achiko", target:"achi子", kind:"person", reviewStatus:"confirmed" }
characterVoices:          { canonicalSourceName:"Achiko", targetName:"achi子", status:"candidate" }
context_graph_nodes:      { name:"Achiko", status:"candidate", suggestedTranslation:"阿千" }   ← 新分析已经是对的
```

记忆里的值自 2026-10-18 23:10 起就是 `achi子` 且已 confirmed，之后再没变过；图谱后来重新分析得到 `阿千`，但**记忆不回溯**，所以面板上仍是 `achi子`。

### 4.2 根因

1. **模型产出混合写法**：`Achiko` 结尾像日语 `-ko`，模型把 `Achi` 当拉丁词干保留，只补了个"子"。分析提示词只要求"稳定、自然的目标语言规范译名"（`contextGraph.ts:765`），**没有禁止拉丁字母残留**。
2. **服务端无校验**：`safeText(attributes.suggestedTranslation, 120)` 只限长度，不检查字符集。`targetLang` 只校验语言代码一致（`contextGraph.ts:2057`），不校验脚本。
3. **记忆权威性设计**：confirmed 实体不会因为新分析而被覆盖（这是防丢失的正确设计），但 UI 也没有"图谱建议已变化"的提示，用户无从发现。

### 4.3 修改计划

| 优先级 | 位置 | 改动 |
|---|---|---|
| P0 | `contextGraph.ts` 新增 `isValidTargetName(source, target, targetLang)` | 中文目标时：禁止连续 ≥2 个拉丁字母（白名单：DNA、OK 等缩写）；禁止残留源词；禁止 `/`、`（）`、引号；禁止纯数字/纯符号 |
| P0 | 同上，`saveNode` 前调用 | 不合法 → `suggestedTranslation` 置空并计入诊断，不写脏值 |
| P0 | `literary.ts` 实体保存/自动确认路径 | 同一函数复用（扩展侧也要挡，避免用户手输时无提示，但用户手输允许确认提示） |
| P1 | `contextGraph.ts:765` 提示词 | 增加："译名必须是目标语言的完整写法，不得保留拉丁字母、不得加括号注释、不得中英混排" |
| P1 | 实体译名表面板 | confirmed 实体若图谱有新建议且不同 → 显示「图谱建议：阿千（点击采用）」 |
| P2 | 存量数据 | 扫描全部 confirmed 实体，命中 `isValidTargetName` 的降级为 suggested 并提示 |

验收：新增单测覆盖 `Achiko→achi子`（拒绝）、`Achiko→阿千`（通过）、`DNA→DNA`（白名单通过）、`Sire→船长（敬称）／大人`（拒绝）；重跑分析后 memory 中拉丁残留目标为 0。

---

## 五、实施顺序与影响面

```
第 1 步（服务端，1 个 PR）
  contextGraph.ts:  splitCompoundEntityName + isValidTargetName + kind 枚举归一
  voiceContext.ts:  空值不写键
  提示词:           entity 排除清单 + 禁止合并 + 禁止拉丁残留
  → 重跑一次全书分析，脏数据不再新增

第 2 步（扩展，1 个 PR）
  literary.ts:      entityWorthMapping + 自动确认闸门 + 500→1000
  useLiteraryMemoryEditor.ts: 差异导入 + 低价值实体折叠 + 图谱建议提示

第 3 步（存量清理，1 个脚本）
  降级/剔除命中闸门的 confirmed 实体；拆分或删除 6 条斜杠节点
  fingerprint 补齐 5 维
```

风险点：

- **闸门误杀**：`the Council of Regents → 摄政会议` 这类是真正需要的，停用词表必须精确，不能按"含 the"或"含 of"粗暴过滤。建议白名单优先：`place`/`organization`/`work` 一律保留，只过滤 `other` 里的通用词。
- **存量降级不可逆**：只降级不删除，保留 `confirmationSource` 便于回溯。
- **已有译文**：修改 fingerprint 会让已有译文变 stale，需要提前告知用户「确认文风/实体后可能需要重译」。

---

## 六、附带发现（不阻塞，但建议一并处理）

1. `context_graph_meta` 的 `styleRules` 有 8 条、`styleAvoid` 6 条，但扩展导入时只取 `slice(0, 16)` / `slice(0, 12)`，够用；问题在 `sanitizeLiteraryMemory` 对 rules 用 `safeText(value, 240)`，长规则会被截断到 240 字（图谱侧上限也是 240，一致）。
2. 实体 `kind` 在记忆层只剩 `person/place/organization/other/title` 五种，图谱里的 `work`、`artifact` 都落进 `other`，这也是"无法按 kind 过滤"的原因之一。
3. 62 个非人物实体里存在同义重复：`England` / `English` / `English / England` 三条都指向"英格兰"，`rutter` / `rutters` 都指向"航路志"，`Council` / `the Council` / `the Council of Regents` 三条并存。建议在 `mergeTranslationContextDeltasIntoMemory` 的 `sameKind` 匹配之外，增加"目标译名相同则合并"的归并规则。
