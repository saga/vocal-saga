# local-agent-service 代码体量审计（2026-11-01）

只读审计，不改代码。两个列表：超过 1000 行的文件、超过 200 行的函数。

## 测量口径

- 工具：TypeScript 官方 parser（`local-agent-service/node_modules/typescript`）遍历 AST，按声明跨度计数（函数签名首行 → 闭括号末行，含 JSDoc 之外的实现行）。
- 覆盖范围：`local-agent-service/src`（32 个 .ts + 1 个 .mjs，共 33 文件，1,611 个函数）、`tests`（29 个文件，932 个函数）、`scripts`。
- 阈值：文件 `> 1000` 行；函数 `>= 200` 行。
- 脚本：`/tmp/func-size.mjs`（一次性审计脚本，未入库）。
- 边界已独立复核：`executeRun` 起于 1827 行、`runAnalysis` 起于 888 行且下一顶层声明分别在 2938 之后与 1735 行，跨度与 AST 结果一致。

## 列表一：文件超过 1000 行

### src（生产代码，5 个）

| 行数 | 文件 | 备注 |
|---|---|---|
| 2,966 | `src/documents/translationAgent.ts` | 含 4 个 200+ 行函数（见列表二） |
| 2,879 | `src/documents/projectStore.ts` | 无 200+ 行函数，纯体量问题 |
| 2,594 | `src/documents/contextGraph.ts` | 含 `runAnalysis` 841 行 |
| 2,046 | `src/documents/qualityAudit.ts` | 含 `runProjectQualityAudit` 210 行 |
| 1,259 | `src/documents/translationBrief.ts` | 含 3 个 200+ 行函数 |

- `src` 的 32 个 .ts 文件合计 20,362 行；上述 5 个文件合计 11,744 行，占生产代码 **57.7%**。
- 接近阈值未入选（>800 行）：`src/literary.ts` 871、`src/documents/voiceContext.ts` 796。

### tests / scripts（4 个，供参考，非生产代码）

| 行数 | 文件 |
|---|---|
| 1,409 | `tests/translation-brief.test.mjs` |
| 1,376 | `tests/document-project.test.mjs` |
| 1,232 | `scripts/diagnose-character-voice.mjs` |
| 1,057 | `tests/quality-audit.test.mjs` |

## 列表二：单个函数超过 200 行

按行数降序，共 15 个（`src`）。`d0` 为顶层函数，`d1` 为嵌套在其他函数内的闭包。

| 行数 | 函数名 | 位置 | 形态 |
|---|---|---|---|
| **1,112** | `executeRun` | `src/documents/translationAgent.ts:1827` | async，d0 |
| **841** | `runAnalysis` | `src/documents/contextGraph.ts:888` | async，d0 |
| **520** | `handleDocumentProjectRequest` | `src/documents/projectRoutes.ts:66` | async export，d0 |
| **490** | `buildTemporallyVisibleMemory` | `src/documents/translationBrief.ts:175` | d0 |
| **472** | `buildTranslationBrief` | `src/documents/translationBrief.ts:746` | export，d0 |
| 471 | `reviewBatch` | `src/documents/translationAgent.ts:1961` | async arrow，d1（嵌在 `executeRun` 内） |
| 433 | `handleRequest` | `src/routes.ts:79` | async export，d0 |
| 413 | `buildProjectContextGraphBundle` | `src/documents/contextGraph.ts:2182` | export，d0 |
| 407 | `sanitizeProjectLiteraryMemory` | `src/documents/voiceContext.ts:163` | export，d0 |
| 254 | `refreshChineseEditorialProfile` | `src/documents/chineseEditorialProfile.ts:80` | async export，d0 |
| 233 | `translateBatch` | `src/documents/translationAgent.ts:1227` | async，d0 |
| 225 | `validateTranslationContextDelta` | `src/documents/translationContextDelta.ts:113` | export，d0 |
| 221 | `buildProjectVoiceContext` | `src/documents/voiceContext.ts:576` | export，d0 |
| 210 | `runProjectQualityAudit` | `src/documents/qualityAudit.ts:1449` | export，d0 |
| 205 | `processBatch` | `src/documents/translationAgent.ts:2434` | async arrow，d1（嵌在 `executeRun` 内） |

测试目录另有 1 个：`tests/server.test.mjs:459-716`（258 行匿名 async 测试闭包）。

### 体量集中度

- 13 个顶层（d0）函数合计 5,831 行，占 `src` 的 .ts 总行数（20,362）的 **28.6%**；两个 d1 闭包已包含在 `executeRun` 的 1,112 行内，不重复计入。
- `src/documents/translationAgent.ts` 一个文件贡献了 1,112 + 471 + 233 + 205 行（`reviewBatch`、`processBatch` 为 `executeRun` 内部闭包，存在嵌套重复），是单点最集中的位置。
- 其余 1,596 个函数（99.1%）都在 200 行以内，问题集中在少数入口编排函数，不是普遍现象。
