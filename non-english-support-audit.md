# local-agent-service 非英文原文支持审计

审计范围：`local-agent-service/src/documents/`（bookScan / contextGraph / translationAgent / qualityAudit）
审计方式：源码审查 + 对 `scanBookSegments`、`numericTokens`、`numericQuantityUnits`、`englishResidueFindings` 直接跑构造样本
结论日期：2026-10-30

---

## TL;DR

**翻译本体没问题，预处理和质量审计对非英文原文基本失效。**

- 真正交给模型翻译的原文是整段原文 + `sourceLang/targetLang` 显式声明，模型侧能力不受影响。
- 但**喂给模型的启发式索引**（人物候选、对白分布、数量样本）和**翻译后的确定性审计**几乎全是英文（+ 中文）规则。
- 后果分三层：① 非英文书的**人物覆盖率和抽样质量下降**；② 非英文书的**质量审计报告出现系统性误报**；③ 这些误报不会自动返工，但会污染报告、误导人工返工。

严重度排序：**P0 = 数字/单位审计全量误报** > **P1 = 名称候选失效** > **P1 = 对白识别失效** > **P2 = 残留检测只认英文**。

---

## 一、不受影响的部分

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 翻译请求 | `translationAgent.ts:813` | `'请翻译下面 JSON 中的 segments。源语言：' + sourceLang + '；目标语言：' + targetLang` — 语言对是显式传的 |
| 翻译契约 | `translationAgent.ts:117-140` | 规则是语言无关的（专名/头衔/声音/优先级）；`英文 Lady` 只是举例，不是硬编码路径 |
| 全书分析 prompt | `contextGraph.ts:786` | 显式要求 `suggestedTranslation` 必须用目标语言，不保留源语言拼写；语言无关 |
| 章节切分 | `bookScan.ts:126-144` | 依赖扩展传入的 `contextPath`，与语言无关 |
| 重复句索引 | `bookScan.ts:229` | 句子切分 `[^.!?。！？\n]+`，覆盖 fr/de/it（句号）和 ja（句号） |
| 引用文本抽取 | `bookScan.ts:149-157` | 已覆盖 `“”`、`""`、`「」`、`『』`、`‘’` — 日文引号是好的 |

---

## 二、P0：数字/单位审计对非英文源 100% 误报

### 现象

`numericFindings`（`qualityAudit.ts:229`）比较原文和译文的数字序列与单位序列。原文侧只认英文数词和中文数词，**非英文源侧永远返回空**，而译文侧（中文）能识别出来，于是每一条"数字+单位"的句子都被判为不一致。

实测（构造样本，原文正确翻译）：

```
fr | src=[]/[]            tgt=["3"]/["length:meter"] => flag=true
de | src=[]/[]            tgt=["3"]/["length:meter"] => flag=true
it | src=[]/[]            tgt=["3"]/["length:meter"] => flag=true
ja | src=[]/[]            tgt=["3"]/["length:meter"] => flag=true
en | src=["3"]/["length:meter"] tgt=["3"]/["length:meter"] => flag=false
```

样本：`Il marcha trois mètres.` → `他走了三米。` / `Er ging drei Meter.` → `他走了三米。` / `三メートル歩いた。` → `走了三米。`

### 根因

| 位置 | 内容 |
| --- | --- |
| `qualityAudit.ts:57-64` | `ENGLISH_NUMBER_VALUES` / `ENGLISH_NUMBER_SCALES` 只有英文数词 |
| `qualityAudit.ts:142` | `numericTokens` 的分词是 `\d+…\|[零〇一…]+\|[a-z]+` — `trois`/`drei`/`tre` 落进 `[a-z]+` 后查表失败，直接丢弃 |
| `qualityAudit.ts:181-207` | `QUANTITY_UNIT_CANONICAL` 只有 en + zh，没有 `mètre/Meter/metro/メートル` |
| `qualityAudit.ts:209-229` | `numericQuantityUnits` 只有 `englishPattern` + `chinesePattern` |

### 影响

- 非英文书的审计报告里，**每一条含数量单位的正确译文都会被标 `numeric-token-mismatch`（severity=`warning`, repairable=true）**。
- 不会触发自动返工（自动返工只处理 `missing-translation`，见 `translationAgent.ts:2141`），但会：① 淹没真实 finding；② 抬高 `findingCount`；③ 用户点"返工"会去改本来正确的句子。
- 英文源完全正常，所以这个 bug 在 Project Hail Mary 这类英文书上一直没暴露。

### 修复方向

`numericTokens` 和 `numericQuantityUnits` 需要按 `sourceLang` 分支。最小改动：
1. 加 `FR/DE/IT_NUMBER_VALUES` 词表（`deux/trois`… `zwei/drei`… `due/tre`…），日文走汉字数词已有路径（`二/三` 能被 `parseChineseNumber` 解析）。
2. `QUANTITY_UNIT_CANONICAL` 补 `mètre(s)/Meter/metro/metri/メートル` 等。
3. 若某语言没有词表，**应该直接跳过 numeric 检查**，而不是拿空数组去比对——现在的行为是"识别不到 = 一定不一致"，这是错误的默认值。

---

## 三、P1：名称候选（人物索引）对非英文源失效

`bookScan` 产出的 `nameCandidates` 是全书分析抽样和"覆盖完整性检查"的唯一依据。

### 实测

原文：`Émile ouvrit la porte. Émile sourit.` ×2 段 + `Herr Müller kam.` ×2 段 + `«Bonsoir», dit Émile.`

```
mentions: Bonsoir/single-name, Bonsoir/single-name, Müller/single-name
candidates: [ 'Müller(2)' ]
dialogue: 0 / 4
```

**主角 `Émile` 出现 4 次 → 0 条 mention。** 问候语 `Bonsoir` → 被当成人物候选。

另一组德文样本（`Herr Müller ging durch die Stadt. Die Frau sah den Mann…`）：

```
nameCandidates: Mann(2), Stadt(2)
```

即：**"男人""城市"成了人物候选，真名反而消失。**

### 根因

| 位置 | 问题 |
| --- | --- |
| `bookScan.ts:89` | `NAME_PATTERN = /\b\p{Lu}\p{Ll}{2,}…/gu` — `\b` 基于 `\w`（ASCII），`É` 不是 `\w`，所以**首字母带变音符号的名字整条不匹配**（`Émile`、`Ödön`、`Ángel`） |
| `bookScan.ts:89` | 要求 `\p{Lu}\p{Ll}{2,}`（≥3 字符、首大写次小写）→ **日文完全无法匹配**（无大小写 + 无 `\b`），实测 `mentions=0` |
| `bookScan.ts:85-87` | `TITLE_PREFIX_WORDS` 只有英文头衔；`M./Mme/Herr/Frau/Sig./Signor` 不在其中 → 头衔被当成名字 |
| `bookScan.ts:73-83` | `NAME_STOP_WORDS` 只有英文虚词 → 德文/法文/意大利文虚词不过滤 |
| `bookScan.ts:91` | `TITLED_NAME_PATTERN` 只认英文头衔词表 |

### 德语特有的放大效应

德语**所有名词首字母大写**，`NAME_PATTERN` 会把每一个普通名词都收成 `single-name` 候选（`Stadt`、`Mann`、`Frau`、`Zeit`、`Haus`…）。`planBookSamples`（`bookScan.ts:555-562`）给名称候选留了 18 个 × 3 个时间点 = 最多 24 个抽样位；在德文书上这些位会被普通名词吃满，**真正的人物反而拿不到抽样预算**。

### 影响

- `scanHints.nameCandidates` 为空或全是噪声 → 全书分析的抽样从"按人物分布"退化成"均匀撒点"。
- prompt 里那条硬性覆盖检查（`contextGraph.ts:790`：「某候选若 mentions ≥ 20、chapterCount ≥ 3、dialogueSegmentCount ≥ 10，就必须有对应 characters 项」）在候选为空时**形同不存在**，人物漏检不再有任何兜底。
- `diagnostics.targetedNameCount = 0`，前端/日志里能直接看出来。

---

## 四、P1：对白识别对 fr / de / it 完全失效

`isDialogueSegment`（`bookScan.ts:166`）只数 `[“”「」『』"]`，`SPEECH_VERBS`（`:88`）只有英文动词。

实测：

```
de: 0/3    fr: 0/3    it: 0/3    ja: 1/3    en: 2/3
```

### 根因

- `bookScan.ts:149-157` `quoteSpans` **没有 `«…»`（法/意）也没有 `„…"`（德）**。
- `bookScan.ts:168` `quoteCount` 的字符集同样不含 `«»„`。德文 `„Text“` 里只有收尾的 `“` 被数到，`quoteCount` 永远是 1，够不到 `>= 2` 的阈值。
- `bookScan.ts:88` `SPEECH_VERBS` 是英文正则（`said|asked|replied…`），法/德/意的 `dit / sagte / disse` 全不认。
- `bookScan.ts:169` `emDashDialogue` 要求 `[—–]\s*\p{Lu}`，法文 `— Bonjour` 能命中，但德文破折号对白通常后接小写（`— ich weiß nicht`）→ 漏。

### 影响

`dialogueSegmentCount` 进 `scanHints`，`planBookSamples` 的 `dialogue-density` 阶段（`bookScan.ts:569-583`）**完全没有输入**。对白是判断人物声音的核心证据，对白抽样为空 → 人物 voice 描述只能靠叙述句猜，`voiceContext` 的对白规则质量直接下降。

---

## 五、P2：残留检测只认英文

`englishResidueFindings`（`qualityAudit.ts:682`）的 `phrasePattern` / `wordPattern` 都是 `[A-Za-z]`。

实测（中文译文里故意留外文）：

```
'他 je ne sais pas 地走开了。'      → 命中（4 词）
'他说 das ist nicht gut，然后离开。' → 命中（4 词）
'他不知道 what happened next 的事情。' → 命中（英文）
```

**未命中**：`«Non»`、`Merci`、`Ach so`（< 4 词且无英文功能词）；**带变音符号的整词一律不可见**——`déjà`、`était`、`schön` 被 `[A-Za-z]` 切成单字母碎片，永远不匹配。

日文残留（译文里留了假名/汉字）**结构上不可检测**：`wordPattern` 不含 CJK。

### 影响

severity 是 `review`（非阻塞提示），所以危害有限；但"非英文源漏译的外文片段"这一类问题在这条链路上是**零覆盖**。同时 `targetLang` 非中文时整条检查直接 return（`qualityAudit.ts:687`）——如果以后做中译外，这里也是空的。

---

## 六、其他英文硬编码（低优先级）

| 位置 | 内容 | 影响 |
| --- | --- | --- |
| `contextGraph.ts:1505` | 关系端点归一化只处理英文冠词 `^(the\|a\|an)\s+` | 模型返回 `le Roi` / `der König` 时找不到节点，关系被丢弃（计入 `droppedMissingEndpoint`） |
| `qualityAudit.ts:41` `containsName` | 拉丁名走 `[^a-z0-9]` 边界匹配 | 非拉丁源名退化为子串匹配，短名会误命中 |
| `voiceContext.ts:194` | `validateCanonicalTarget({ targetLang: 'zh' })` 硬编码中文 | 只做中文目标校验，符合当前产品定位 |
| `canonicalEntityPolicy.ts:153` | `AC/DC` 这类拉丁缩写规则 | 语言无关，但注释假设拉丁 |

---

## 七、建议修复顺序

1. **P0 — 让 numeric 检查在无法识别源语言数字时跳过，而不是判"不一致"**（`qualityAudit.ts:229-253`）。这是一行级的语义修正，能立刻消除非英文书的系统性误报。
2. **P1 — `bookScan.ts` 语言分支**：
   - `quoteSpans` / `quoteCount` 补 `«»`、`„"`；
   - `SPEECH_VERBS` 按语言拆成 `{ en, fr, de, it, ja }`；
   - `NAME_PATTERN` 去掉 `\b`，改用 `(?<![\p{L}])` lookbehind，让 `Émile` 能被匹配；
   - 日文单独走一个 CJK 姓名启发式（`\p{Script=Han}{2,4}` + 敬称 `さん/様/氏/君`），否则日文书永远是 0；
   - 德文给 `NAME_STOP_WORDS` 加一份德语高频名词停用表，或者干脆对德语禁用 `single-name` 类别、只保留 `compound-name` / `titled-name`。
3. **P2 — 残留检测按 `sourceLang` 选词表**，非英文源时至少覆盖 `[A-Za-zÀ-ÿ]` 全拉丁扩展。
4. **P2 — `contextGraph.ts:1505`** 冠词归一化按 `sourceLang` 扩展。

---

## 八、验证方式

本次审计的全部结论可用以下方式复现：把样本段落喂给 `scanBookSegments`（`bookScan.ts:527`）观察 `nameCandidates` / `dialogueSegmentCount` / `quantityMentions`；把原文-译文对喂给 `numericTokens` + `numericQuantityUnits` 观察 `flag`。

建议补一组非英文回归测试，断言：

- `scanBookSegments` 对 `Émile` ×4 必须产出 `nameCandidates` 含 `Émile`；
- 法/德/意 `«»` / `„"` 对白段 `isDialogueSegment` 为 true；
- `Il marcha trois mètres.` → `他走了三米。` 必须**不**产出 `numeric-token-mismatch`。
