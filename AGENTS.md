# AGENTS.md

## 翻译质量总原则

翻译以**信、达、雅同时成立**为目标：准确传达原文事实、语气、视角与潜台词；用自然、清楚、符合目标语言习惯的表达；尽可能保留作者的文体、节奏、意象和人物声音。三者不是互相替代的分数，也不设“准确性做完后才考虑文学性”的固定层级。遇到冲突时，不得增删事实来换取文采；应重新寻找同时满足原意与表达效果的译法。不得把“忠实”理解成逐词硬译，也不得把“文学性”理解成擅自扩写或统一润色。

原则1：重要的功能添加修改，必须要有相应的测试用例。

原则2：没有用的功能直接删掉，不要做fallback design。

原则3：添加足够的中文代码注释。

原则4：如果script调用无法联通，使用proxy.sh的proxy设置。

## Project Architecture

OpenAI-compatible LLM proxy + translation API，部署在 **Cloudflare Workers**。基于 **Hono**（edge-first，无 Node-only 依赖）。

```
/
├── lib/                            # 平台无关源码（编译到 lib/dist/）
│   ├── app.ts                      # createApp() 工厂 — Hono app + 路由
│   ├── index.ts                    # 公共入口：createApp + storage adapters
│   ├── urlUtils.ts                 # URL 标准化工具
│   ├── modelResolver.ts            # 模型解析 + 上游配置
│   ├── auth.ts                     # 鉴权中间件
│   ├── storage/                    # StorageAdapter 抽象
│   │   ├── types.ts                #   interface StorageAdapter
│   │   ├── cloudflare.ts           #   Cloudflare KV adapter
│   │   ├── memory.ts               #   MapStorage (tests / local dev)
│   │   └── index.ts                #   setDefaultStorage / getDefaultStorage
│   └── translate/                  # LLM + 翻译业务逻辑
│       ├── pipeline.ts             # 翻译主流程（有界并发）
│       ├── contentHelper.ts        # 文章容器识别（Layer 1/2/3）
│       ├── contentDetector.ts      # 智能评分（Layer 2 兜底）
│       ├── blockExtractor/         # DOM 文本提取
│       ├── chunkBuilder.ts         # 分块（TARGET_TOKENS=1000）
│       ├── cacheManager.ts         # 缓存管理
│       ├── service/                # LLM API 调用
│       │   ├── deepseek.ts         #   DeepSeek
│       │   ├── openrouter.ts       #   OpenRouter
│       │   └── nvidia.ts           #   NVIDIA (kimi-k2.6 / deepseek-v4-flash / qwen3-next-80b-a3b-instruct)
│       └── rules/                  # 站点规则
├── src/
│   └── worker.ts                   # CF Workers 入口
├── tests/                          # Vitest 测试
├── wrangler.toml                   # CF Workers 配置
└── package.json
```

## Key Decisions

- **Hono** — CF Workers 原生运行，无 Node-only 依赖
- **Storage 抽象** — `StorageAdapter` 接口，CloudflareKV 实现
- **linkedom** — 纯 JS DOM，CF / Node 都能跑，替代 jsdom
- **nodeType 判别** — walker / rules 全部用 `nodeType === N` 而非 `instanceof`
- **有界并发翻译** — `runWithConcurrency` 限制同时在途的 chunk 数，防止上游 429
- **超时保护** — DeepSeek 45s / OpenRouter 60s / NVIDIA 60s
- **文档边界** — Worker `/api/translate/document/segments` 只做一次有界结构化片段翻译；解析、批次调度、书籍记忆、审校、导出和恢复由扩展与本机 Agent 负责
- **URL 标准化** — 无 `.` 域名补 `.com`，保留 www

## Routes

| Path | Auth | 说明 |
|------|------|------|
| `GET /api/hello` | ✗ | 健康检查 |
| `GET /api/v1/models` | ✗ | 模型列表 |
| `POST /api/v1/chat/completions` | ✓ | LLM 代理 |
| `GET /api/v1/translate/text` | ✗ | 文本翻译 |
| `POST /fanyi/page` | ✗ | 浏览器扩展：接收预标记 HTML，返回翻译后的双语 HTML |
| `GET /translate/<url>` | ✗ | 翻译页面（浏览器直访） |
| `GET /force/<url>` | ✗ | 强制重新翻译（跳过 D1 缓存） |
| `GET /openrt/<url>` | ✗ | OpenRouter 免费模型翻译 |
| `GET /nvd/<url>` | ✗ | NVIDIA kimi-k2.6 翻译 |
| `GET /nvd/deepseek/<url>` | ✗ | NVIDIA deepseek-v4-flash 翻译 |
| `GET /nvd/qwen/<url>` | ✗ | NVIDIA qwen3-next-80b-a3b-instruct 翻译 |
| `GET /original/<url>` | ✗ | 原始页面（不翻译） |
| `GET /o/<url>` | ✗ | /original 别名 |
| `GET /s/<domain>/<path>` | ✗ | 简写域名翻译 |
| `GET /` | ✗ | 最新翻译结果 |
| `GET /<id>` | ✗ | D1 历史翻译 |

## Translation Pipeline

```
fetchPage (linkedom)
  ↓
contentHelper (Layer 1: 选择器 → Layer 2: 评分 → Layer 3: body)
  ↓
blockExtractor (DFS 提取 TextBlock)
  ↓
chunkBuilder (TARGET_TOKENS=1000)
  ↓
runWithConcurrency (有界并发翻译)
  ↓
applyBlockTranslation (回填 HTML)
```

**性能数据**（生产日志）：
- parseHTML: 5~35ms
- prepareDoc: 11~86ms
- translateChunks: 99% 时间（LLM API 响应）
- CPU total: 26~59ms

## Services

| Service | API | 模型 | 超时 |
|---------|-----|------|------|
| DeepSeek | api.deepseek.com | deepseek-v4-flash | 45s |
| OpenRouter | openrouter.ai | openrouter/free | 60s |
| NVIDIA | integrate.api.nvidia.com | kimi-k2.6 / deepseek-v4-flash / qwen3-next-80b-a3b-instruct | 60s |

## Site Rules

`lib/translate/rules/` 包含站点特定规则：
- `github-rules.ts` — GitHub
- `reddit-rules.ts` — Reddit
- `hackernews-rules.ts` — Hacker News
- `fortune-rules.ts` — Fortune
- `arxiv-rules.ts` — arXiv（跳过 References/Authors）

## Testing

```bash
npm test              # Vitest
npm run build:lib     # 编译 lib/
npm run typecheck     # 类型检查
npm run dev:cf        # 本地开发（wrangler dev）
npm run deploy:cf     # 部署到 CF Workers
```

## Cloudflare Deployment

```bash
# Secrets
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put NVIDIA_API_KEY
wrangler secret put AUTH_KEY

# 部署
npm run deploy:cf
```

## URL 标准化

- 无 `.` 域名补 `.com`：`towardsdatascience` → `towardsdatascience.com`
- 保留 `www.`：`www.example.com` ≠ `example.com`（暂时视为不同）
- 剥离 scheme：`https://example.com` → `example.com`


## Runtime Boundary: Cloud API vs Local Agent Service

This repository contains two distinct execution environments. They are separate products with different runtime budgets and user expectations; do not treat them as interchangeable implementations of one generic translation pipeline.

### Cloud service — Cloudflare Workers

The root service (`lib/`, `src/worker.ts`) is an edge API running on Cloudflare Workers. It has constrained CPU, memory, request duration, and request/response budgets. It is intended for short, direct, request/response operations, especially web-page and selected-text translation.

- Keep request handlers and translation pipelines bounded. Avoid long-running multi-stage Agent workflows, long chains of model API calls, broad multi-candidate generation, and document-wide review loops inside a Worker request.
- Optimize for useful translation quality within a bounded request: concise Prompt, only necessary context, sensible chunk size, strict output validation, bounded concurrency/retries, and cache reuse when the complete cache key is valid.
- Cloud document translation support is intentionally limited. Do not expand the Worker into a full long-document project orchestrator. If a task requires durable project state, long-running translation, chapter memory, multiple review passes, character voice consistency, or extensive selective rewriting, use `local-agent-service`.
- Distinguish Cloud API tasks from Local Agent tasks in API contracts, docs, UI-facing errors, and tests. Do not imply that the Worker supports the full document workflow merely because it accepts text or chunks.
- Do not add Node-only dependencies or assume persistent in-process memory. Use supported Worker APIs and the existing storage abstractions.
- Keep provider calls bounded by configured timeouts and ensure partial/provider failures become explicit, validated outcomes rather than false successful translations.

### Local Agent Service — macOS / Node.js

`local-agent-service/` is a separate local Node.js service, normally on the user's Mac and reachable from the extension over loopback HTTP. It is designed for long-running AI/Agent work and full document translation.

- Prioritize translation quality over response speed for document and literary tasks; use persistent projects, checkpoints, resumable batches, relevant long-context memory, review, candidate comparison, and selective rework where justified.
- Support local AI Runtime/Agent calls and durable workflow state; do not move these workflows into the Worker.
- Keep its own instructions in `local-agent-service/AGENTS.md`. Changes to the local service must respect its Node.js runtime, SQLite persistence, project/run lifecycle, event protocol, and cancellation/recovery behavior.
- The extension remains responsible for UI, browser APIs, DOM/file-container handling, and presenting progress. The local service is responsible for model/Agent execution, document workflow, quality checks, and durable task state.

### Task-specific Pipelines and Prompts

Do not apply one pipeline, Prompt, or tuning policy to every translation task. Route by task intent, content type, quality requirement, context needs, and runtime constraints.

| Task type | Cloud Worker strategy | Local Agent strategy |
|---|---|---|
| Selected text / short paragraph | Single bounded translation request; concise/direct output; lightweight validation | Optional; usually no long workflow unless explicitly requested |
| Ordinary web page | Extract/segment, bounded chunk translation, preserve markup, bounded retry, cache | Optional deeper processing when the user selects local mode |
| Technical article | Terminology and identifier preservation, structure/format validation | Document-aware translation and targeted review for long/complex material |
| EPUB/PDF or long document | Limited support only; do not promise complete document-project workflows | Full project-based translation, stable segments, persisted batches, checkpoints, recovery and export/sync |
| Novel/literary work | Not the target for multi-chapter literary governance in a Worker request | Quality-first pipeline with book/scene memory, character voice, relationship/register constraints, consistency review and selective rework |
| Multi-step translation research/editing | Avoid long-running Agent plans in Worker request path | Bounded Agent/tool workflow with durable events, evidence/candidate tracking and validation |

Prompt and tuning decisions must be task-specific. Short cloud requests should not incur unnecessary multi-pass review; literary document tasks may spend more time and calls on context, review, comparison, and targeted correction. Additional calls must be justified by likely quality gain and constrained by explicit limits.

**Webpage translation quality contract:** the Cloudflare Worker webpage pipeline is always the lightweight technical workflow. It must not invoke literary entity/person analysis, character voice profiles, Context Graph, full-page Reviewer, style review, or iterative rewrite passes, including when a legacy client sends `translationMode=literary`. Fast is the default and must add no model calls. The optional `qualityMode=enhanced` may reuse a small, bounded amount of already-extracted page metadata (title/headings/opening text) in the existing translation prompt; it must not call a separate context or reviewer model. Fast and Enhanced must have distinct cache fingerprints. Keep all book/document literary workflows inside `local-agent-service`.

### Cross-boundary Rules

**Local document translation has one execution pipeline regardless of UI entry point.** The existing document reader (including “continue translating” and “force retranslate current page”), Agent Workspace, CLI and project API must delegate to the same local Document Project / Run executor in `local-agent-service`. Do not implement another browser-side local translation loop or a second memory-merging path. Task-specific prompts remain policies inside this shared orchestrator, not separate implementations. The literary initial-translation response may add an evidence-validated `context_delta`; service-side wave ordering, persistence, review and audit own its lifecycle. See [TRANSLATION_PIPELINE.md](docs/TRANSLATION_PIPELINE.md) and [ADR-0001](docs/adr/0001-unified-local-translation-context-delta.md).


1. The browser extension is the UI/browser layer and performs simple deterministic work. Complex AI computation belongs in the appropriate Vocal Saga backend.
2. Cloud and local service results must carry truthful execution/provider metadata. Never silently switch execution environments or mislabel remote output as a local Agent result.
3. Share API contracts and reusable domain concepts where useful, but keep runtime-specific orchestration, prompts, resource controls, persistence, and tests separate.
4. A change to task routing, Prompt versions, context assembly, caching, output validation, cancellation, or recovery requires regression tests appropriate to the affected runtime.
5. Keep documentation synchronized. Root `AGENTS.md` describes the Cloud/Local boundary; `local-agent-service/AGENTS.md` governs implementation inside the local service; `fanyi-extension/AGENTS.md` governs browser UI and delegation.\n6. The reader page and Agent Workspace must delegate to the same local Document Project/Run executor; UI entry points may choose a scope, but may not fork the translation pipeline or duplicate context-memory merge logic.


## Agent Chat Routing

- Remote browser chat must use the Vocal Saga Cloud API `/api/v1/chat/completions`, not call a model provider directly from the extension.
- Local Workbuddy/OpenCode chat belongs to `local-agent-service` through its standalone `/api/agent/chat` API. It must not be routed through the document translation Pipeline.
- Agent Skills remain server-managed by `local-agent-service`; the extension only selects server-returned Skill IDs.
