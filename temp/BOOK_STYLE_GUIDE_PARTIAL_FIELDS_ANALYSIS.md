# 全书文风基准只有“叙述声音 / 规则”有内容的原因分析

## 结论

这不是全书分析失败，也不是文风字段没有生成或没有落库。

本次运行 `6858b35b-e39f-48bd-a164-635024aaa0ba` 的 7 个文风字段全部成功生成并写入 `context_graph_meta`：

| 字段 | 内容长度（字符） |
|---|---:|
| `bookSummary` | 655 |
| `narrativeStyle` | 628 |
| `styleRegister` | 620 |
| `styleRhythm` | 617 |
| `styleDialogue` | 1002 |
| `styleDiction` | 735 |
| `styleAvoid` | 530 |
| `styleRules` | 1032 |
| `styleEvidence` | 3606 |

运行进度中的 `styleFieldCoverage` 也全部为 `true`：

```json
{
  "narrativeStyle": true,
  "styleRegister": true,
  "styleRhythm": true,
  "styleDialogue": true,
  "styleDiction": true
}
```

真正的原因是：**“全书文风基准”面板显示的不是本次分析结果，而是已经保存下来的候选记忆 `literaryMemory.styleGuide`。本次分析结果在 `contextGraphOverview` 中，只有点击“载入预处理文风建议”才会写入这个面板；分析完成后不会自动同步。**

当前面板里已有的“叙述声音”和“规则”，是更早一次候选记忆；其结构（仅 `narrativeVoice` + `rules`）与 v5 的两字段 schema 一致，写入时间也早于 v6、v7 分析。v5 的全书文风 schema 只有 `narrativeStyle` 和 `styleRules` 两个字段，因此当时导入后只可能填出这两项。之后 v6、v7 分析虽然生成了语域、节奏、对白、措辞等新维度，但从未成功导入到 `literaryMemory`。

## 关键证据

### 1. 本次分析结果完整存在

项目数据库：

```text
~/.vocal-saga-local-agent/documents/4fa564de-b0ec-485d-88dc-562ad1bf66d3/project.sqlite
```

`context_graph_meta` 中当前来源版本的所有文风字段均非空：

```sql
SELECT key, length(value)
FROM context_graph_meta
WHERE source_revision_id = (
  SELECT value FROM project_meta WHERE key = 'current_source_revision_id'
)
AND key IN (
  'bookSummary','narrativeStyle','styleRegister','styleRhythm',
  'styleDialogue','styleDiction','styleAvoid','styleRules','styleEvidence'
)
ORDER BY key;
```

本次运行的 stage 结果也记录了非零 `outputCounts`：

```text
bookSummary 653
narrativeStyle 626
styleAvoid 6
styleDialogue 1021
styleDiction 733
styleEvidence 25
styleRegister 618
styleRhythm 615
styleRules 8
```

运行状态为 `completed`，策略 B，5/5 阶段完成。

### 2. 面板显示的 `literaryMemory.styleGuide` 只有两项

最新一条 `literary_memory_revisions` 记录：

```text
memory_revision_id: 146c3244-dd44-4a66-8827-27f133657819
created_at:         2026-10-20T13:54:49.615Z
styleGuideStatus:   candidate
```

其 `styleGuide` 实际内容：

```json
{
  "narrativeVoice": "第三人称全知叙事……",
  "rules": ["日语敬称统一……", "……共 12 条"],
  "register": "",
  "rhythm": "",
  "dialogue": "",
  "diction": ""
}
```

这与截图完全一致：只有“叙述声音”和“规则（每行一条）”有内容，语域、节奏与句法、对白特征、措辞与词汇为空。

### 3. 记忆写入时间早于最近两次分析

| 时间（UTC） | 事件 |
|---|---|
| 2026-10-20T13:54:49Z | 最新 `literary_memory_revisions` 写入，只有 `narrativeVoice` + `rules` |
| 2026-10-20T15:07:21Z | v6 分析运行 `267c0c5e...` 开始，v6 已包含全部文风维度 |
| 2026-10-20T23:29:59Z | 本次 v7 分析运行 `6858b35b...` 开始 |
| 2026-10-20T23:40:19Z | 本次运行完成 |

也就是说：**本次分析完成后，`literaryMemory.styleGuide` 没有任何新的写入。** 面板显示的是约 9 小时前的旧候选。

### 4. v5 的 schema 只有两个文风字段

在 v6 引入完整文风维度之前，Context Graph v5 的 schema 是：

```ts
narrativeStyle: { type: 'string' },
styleRules: { type: 'array', items: { type: 'string' } },
```

`getContextGraphStatus` 的 overview 也只有：

```ts
narrativeStyle: getMeta(...),
rules: uniqueStrings(getMeta(...), 12, 180),
```

这与当前记忆中“`narrativeVoice` + `rules`”两项完全吻合。旧版导入逻辑把 `overview.narrativeStyle` 映射为 `narrativeVoice`，把 `overview.rules` 映射为 `styleGuide.rules`，其余字段当时尚不存在。

## 机制说明

### 面板绑定的是记忆，不是分析结果

`App.vue` 中“全书文风基准”的文本框直接绑定：

```vue
<textarea v-model="literaryMemory.styleGuide.narrativeVoice"></textarea>
<textarea v-model="literaryMemory.styleGuide.register"></textarea>
<textarea v-model="literaryMemory.styleGuide.rhythm"></textarea>
<textarea v-model="literaryMemory.styleGuide.dialogue"></textarea>
<textarea v-model="literaryMemory.styleGuide.diction"></textarea>
```

它不会读取 `contextGraphOverview`，也不会在分析完成时自动刷新。

### 唯一的同步入口是“载入预处理文风建议”

`useLiteraryMemoryEditor.ts` 的 `importContextGraphStyleGuide()` 才会把当前 overview 写入记忆：

```ts
const narrativeVoice = overview.narrativeStyle.trim();
const register = overview.styleRegister.trim();
const rhythm = overview.styleRhythm.trim();
const dialogue = overview.styleDialogue.trim();
const diction = overview.styleDiction.trim();
const rules = overview.styleRules.slice(0, 16);
const avoid = overview.styleAvoid.slice(0, 12);

literaryMemory.value.styleGuide = {
  ...style,
  ...(narrativeVoice ? { narrativeVoice } : {}),
  ...(register ? { register } : {}),
  ...(rhythm ? { rhythm } : {}),
  ...(dialogue ? { dialogue } : {}),
  ...(diction ? { diction } : {}),
  ...(rules.length ? { rules } : {}),
  ...(avoid.length ? { avoid } : {}),
};
```

导入映射本身是完整的，7 个字段都会写入。问题只在于它必须由用户手动触发，且没有“有新结果”的提示。

### 分析完成不会触发记忆更新

`useContextGraph.ts` 的 `loadContextGraph()` 只更新：

```ts
contextGraphOverview.value = {
  narrativeStyle: graph.overview?.narrativeStyle,
  styleRegister: graph.overview?.styleRegister,
  styleRhythm: graph.overview?.styleRhythm,
  styleDialogue: graph.overview?.styleDialogue,
  styleDiction: graph.overview?.styleDiction,
  styleRules: graph.overview?.styleRules,
  styleAvoid: graph.overview?.styleAvoid,
};
```

它不会调用 `importContextGraphStyleGuide()`，也不会修改 `literaryMemory`。因此分析轮询完成时，面板上的旧候选保持不变。

### 旧候选为什么能一直保留

`literaryMemory` 是项目级持久化数据，页面恢复时会从服务端 `/literary-memory` 读取：

```ts
const memoryResponse = await workspaceApi(...);
literaryMemory = sanitizeLiteraryMemory(memoryResponse.current?.memory);
```

服务端 `voiceContext.ts` 的规范化逻辑会保留全部 7 个字段：

```ts
const styleGuide = {
  narrativeVoice: text(style.narrativeVoice, 500),
  register: text(style.register, 500),
  rhythm: text(style.rhythm, 500),
  dialogue: text(style.dialogue, 500),
  diction: text(style.diction, 500),
  rules: list(style.rules, 16, 240),
  avoid: list(style.avoid, 12, 100),
};
```

只要用户不点击“载入预处理文风建议”，旧值就会原样保留。

## 根因归纳

### 直接原因

本次分析结果已经完整生成，但从未导入 `literaryMemory.styleGuide`。面板显示的是 2026-10-20T13:54:49Z 写入的旧候选；该候选的结构与只有 `narrativeStyle` + `styleRules` 的 v5 schema 一致，因此只显示两项。

### 产品/交互原因

1. “全书文风基准”名称容易让用户以为它展示的是最新分析结果，但它实际是“已保存的候选记忆编辑器”。
2. 面板没有显示数据来源、保存时间，也没有提示“本次分析已生成新的 7 个维度，尚未导入”。
3. “载入预处理文风建议”是唯一同步入口，且容易被忽略。
4. 分析完成只更新 `contextGraphOverview`，没有任何自动同步或新结果提示。

### 排除项

- 不是模型只输出了两个字段：DB 中 7 个字段全部存在。
- 不是 style 阶段失败：运行 `completed`，5/5 阶段完成，`styleFieldCoverage` 全为 `true`。
- 不是持久化失败：`context_graph_meta` 和 checkpoint 中数据完整。
- 不是服务端 sanitize 丢弃字段：`voiceContext.ts` 明确保留了 7 个字段。
- 不是导入映射缺字段：`importContextGraphStyleGuide()` 已映射全部字段。

## 影响

- 用户会误判“全书分析只发现了叙述声音和规则”，从而不信任分析结果。
- 若用户直接确认当前候选并开始翻译，实际注入的只有旧版的叙述声音和规则，新分析出的语域、节奏、对白、措辞不会生效。
- 当前候选状态为 `candidate`，按 `translationBrief.ts` 的逻辑不会注入；只有用户确认后才会进入初译和 Reviewer。因此本次尚未造成错误注入，但会阻塞新维度的使用。
- 旧候选可能包含与本次分析不一致的规则，用户确认前需要人工核对。

## 建议

### 立即恢复（无需改代码）

在“全书文风基准”面板点击一次“载入预处理文风建议”。当前 `contextGraphOverview` 已包含全部 7 个字段，导入后语域、节奏与句法、对白特征、措辞与词汇都会被填入；导入结果仍是候选，需要人工检查后再确认。

### 产品修复建议

1. **区分“本次分析结果”和“已保存候选”**
   - 在面板中增加只读的“本次分析结果”区域，或明确标注当前文本框的数据来源和保存时间。
   - 标题改为“全书文风候选（已保存）”，避免与本次分析混淆。

2. **增加新结果提示**
   - 当 `contextGraphOverview` 与 `literaryMemory.styleGuide` 不一致时，显示“本次分析有新结果，点击载入”。
   - 可以只比较字段是否有值/内容是否变化，不必做复杂 diff。

3. **谨慎自动导入**
   - 仅当 `literaryMemory.styleGuide` 为空（首次分析）时自动导入。
   - 如果用户已经编辑或确认过候选，绝不自动覆盖；改为提示用户手动导入。
   - 需要保留“用户编辑优先”的语义，避免分析轮询覆盖人工修改。

4. **记录并展示来源**
   - 在记忆中保存 `styleGuideSourceRunId` / `styleGuideImportedAt`，面板显示“来自运行 6858b35b，导入于 …”。
   - 这样可以直接看出面板内容是否落后于最新运行。

5. **按钮文案**
   - “载入预处理文风建议”可改为“载入本次分析结果（覆盖未确认候选）”，并说明是否会覆盖手工编辑。

### 测试建议

1. 服务端：v7 运行完成后，`GET /context-graph/status` 的 `overview` 必须返回全部 7 个非空字段。
2. 扩展：`importContextGraphStyleGuide()` 必须把 7 个字段全部写入 `literaryMemory.styleGuide`，并保持 `candidate` 状态。
3. 扩展：分析完成但未点击导入时，不得修改已有 `literaryMemory.styleGuide`。
4. 扩展：当记忆为空时，首次分析完成可自动导入；当记忆非空或已确认时，不得自动覆盖。
5. UI：当 overview 与已保存候选不一致时，必须显示“有新结果”提示。

## 复现与核对 SQL

```sql
-- 1. 查看当前来源版本的文风字段
SELECT key, length(value)
FROM context_graph_meta
WHERE source_revision_id = (
  SELECT value FROM project_meta WHERE key = 'current_source_revision_id'
)
AND key IN (
  'bookSummary','narrativeStyle','styleRegister','styleRhythm',
  'styleDialogue','styleDiction','styleAvoid','styleRules','styleEvidence'
)
ORDER BY key;

-- 2. 查看最近运行与文风覆盖率
SELECT run_id, status, started_at, finished_at,
       json_extract(progress_json, '$.analysisVersion'),
       json_extract(progress_json, '$.styleFieldCoverage')
FROM context_graph_runs
ORDER BY started_at DESC
LIMIT 3;

-- 3. 查看最新记忆中的文风字段
SELECT created_at,
       json_extract(memory_json, '$.styleGuideStatus'),
       length(json_extract(memory_json, '$.styleGuide.narrativeVoice')),
       length(json_extract(memory_json, '$.styleGuide.register')),
       length(json_extract(memory_json, '$.styleGuide.rhythm')),
       length(json_extract(memory_json, '$.styleGuide.dialogue')),
       length(json_extract(memory_json, '$.styleGuide.diction')),
       json_array_length(json_extract(memory_json, '$.styleGuide.rules'))
FROM literary_memory_revisions
ORDER BY created_at DESC, rowid DESC
LIMIT 1;
```

## 相关代码位置

- `fanyi-extension/src/entrypoints/document/App.vue:465`：全书文风基准面板，文本框绑定 `literaryMemory.styleGuide`。
- `fanyi-extension/src/entrypoints/document/App.vue:477`：载入按钮，调用 `importContextGraphStyleGuide`。
- `fanyi-extension/src/entrypoints/document/useLiteraryMemoryEditor.ts:528`：`importContextGraphStyleGuide()`，负责 overview → memory 的完整映射。
- `fanyi-extension/src/entrypoints/document/useContextGraph.ts:150`：`contextGraphOverview` 只从 status 接口更新，不触碰 `literaryMemory`。
- `fanyi-extension/src/entrypoints/document/App.vue:1923`：项目恢复时从 `/literary-memory` 读取已保存候选。
- `local-agent-service/src/documents/contextGraph.ts:1649`：`getContextGraphStatus()` 的 overview 返回全部 7 个字段。
- `local-agent-service/src/documents/voiceContext.ts:221`：服务端记忆规范化保留全部 7 个字段。
- `local-agent-service/src/documents/translationBrief.ts:526`：候选状态不注入，只有 `confirmed` 才进入 TranslationBrief。
- v5 旧 schema：`git show f293da7^:local-agent-service/src/documents/contextGraph.ts`，只有 `narrativeStyle` 与 `styleRules`。
