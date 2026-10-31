# vocal-saga Local Agent Service

> 架构与关键函数导航：[docs/LOCAL_AGENT_SERVICE_ARCHITECTURE.md](../docs/LOCAL_AGENT_SERVICE_ARCHITECTURE.md)（模块职责、翻译时序图、预处理流程、Run 状态与持久化边界）。
> 扩展/服务质量审计与定点返工接口契约：[LOCAL_AGENT_EXTENSION_QUALITY_CONTRACT.md](../docs/LOCAL_AGENT_EXTENSION_QUALITY_CONTRACT.md)（统一 API 路径、报告字段、状态/错误语义及跨仓库回归要求）。
> 文学翻译全书预处理门禁：[ADR-0005](../docs/adr/0005-literary-preprocessing-before-translation.md)（扩展正常路径前置检查 + executeRun 服务端最终门禁；queued Run 不代表翻译已开始）。


这是 vocal-saga 中独立的本机 Express + TypeScript Provider，供 fanyi-extension 使用。 默认优先 Workbuddy/CodeBuddy SDK；OpenCode 保留为可选运行时。它把 OpenAI-compatible Chat Completions 请求转交给本机 Workbuddy（@tencent-ai/agent-sdk）或 OpenCode CLI，并使用 Node 内置 SQLite 记录本机请求历史。扩展启用本机 Provider 后，网页翻译、文档翻译、侧栏对话以及 EPUB/PDF 的文学分析和 Reviewer 都走这个本机进程。


## WorkBuddy / CodeBuddy context-window 档位

上下文窗口配置是**可选覆盖**，不更改现有默认行为。没有在 task profile 中指定 `contextWindow` 时，继续使用模型本身的 `defaultLength`，或 CLI 既有默认值。

`GET /api/codebuddy/models` 仍只用于列出模型，不返回 `supportedLengths`。模型目录按 CodeBuddy 优先级叠加产品默认目录、`~/.codebuddy/models.json` 和当前工作目录的 `.codebuddy/models.json`，项目级同 ID 配置优先。客户端应在模型选择/切换后请求新的配置项：

```http
GET /api/codebuddy/config-options?model=deepseek-v4.1-flash
```

仅当模型元数据同时包含合法的 `maxInputTokens` 和至少两个不同的 `contextWindow.supportedLengths`，且每个档位不超过 `maxInputTokens` 时，响应才包含 `context_window` 选择项。档位值是 token 数本身，例如 `"300000"` / `"1000000"`，标签分别是 `300K` / `1M`。单档、缺少元数据或超出物理上限的配置会返回空的 `configOptions`，UI 不显示选择器。没有 `defaultLength` 或默认值不属于有效档位时，初始值取最小档。

选定档位后，调用方可将数值放在相应任务的 `metadata.taskProfiles.<task>.contextWindow` 中，例如 `metadata.taskProfiles.translation.contextWindow = 1000000`。这是按请求/任务显式应用的设置，不会写回用户的全局默认配置。服务端会重新检查当前模型的支持档位和 `maxInputTokens`；若选项已过期或不支持，会拒绝该覆盖并提示刷新配置，而不会悄悄忽略设置。

当前集成的 TypeScript `query()` API 不暴露 `contextWindow` 直接参数，因此显式选择时，服务端用隔离的临时工作目录提供 CodeBuddy 的 `.codebuddy/settings.json` `contextWindow` 种子，并在调用结束后清理。若原工作目录有项目级 `models.json`，只复制该文件到权限受限的临时目录，以便 SDK 看到与选项查询一致的模型定义；不会复制项目 settings、Skills 或 MCP 配置，也不会修改源文件。未设置 `contextWindow` 时不会创建临时目录，仍沿用原来的 `settingSources: []` 与原会话路径。

注意：`autoCompactWindow`、`/autocompact` 等控制压缩触发点，不提供窗口档位，也不替代上下文窗口选择。

## 中文文学编辑的双语复核规则

中文单语文学编辑只产生 provisional edit，不直接写入 Run 候选。后续双语准确性/术语复核必须明确覆盖对应片段并返回完整、非空的最终译文；覆盖成功时保留双语复核最终文本（包括复核修订），并随 Run 自动采纳。未覆盖、缺少结果、空/无效结果、补审失败或复核调用失败时，该片段自动恢复第一道翻译阶段的初译。部分覆盖按片段分别处理。若双语复核将编辑改回初译，对应 finding 自动 dismiss 并记录机器回退来源，不遗留待处理项。未经双语复核的中文编辑不得进入候选、context delta 或项目记忆；不要求用户点击确认。

## 环境要求

- macOS 与 Node.js >= 22.13（使用 Node 内置 `node:sqlite`，不需要另外安装 sqlite3）。
- Workbuddy/CodeBuddy SDK 已在本机登录可用，或 OpenCode CLI 已安装并完成所需 provider 登录。
- 翻译任务不需要打开任何 git 仓库；服务禁用工具，避免模型操作本机文件和 Shell。

## 启动

    cd local-agent-service
    # .env 是可选的；仅当需要覆盖默认设置时才复制配置模板
    # cp .env.example .env
    # LOCAL_AGENT_TOKEN 和模型覆盖都可留空
    npm install
    npm start

服务入口为 TypeScript，HTTP 路由和 JSON body 处理使用 Express。`npm run typecheck` 做类型检查，`npm test` 运行单元和本机 HTTP 集成测试。

默认服务地址是 http://127.0.0.1:8789，启动后可检查 GET /health。本服务强制绑定 loopback，不允许监听 0.0.0.0 或局域网地址。

## 诊断日志与错误定位

每次模型请求都会在本机终端打印带 request ID 的开始、模型运行完成、成功/失败记录；记录 provider、model、endpoint、输入/输出字符数、耗时、HTTP 状态和失败堆栈，不会在普通成功日志里输出整段原文。模型返回无法解析的 JSON 时，会额外输出最多 600 字符的返回内容预览，方便判断是多余解释、代码围栏、截断还是错误响应。要隐藏该预览，在 `.env` 设置 `LOCAL_AGENT_LOG_RESPONSE_PREVIEW=false`。终端日志中的 request ID 可以与扩展错误里的 `local request` 对应，也可以查 `GET /api/history?limit=30` 的 SQLite 请求历史。

### 一键收集最近两个文档的诊断包

遇到翻译质量异常、分析结果缺失、批次失败、Reviewer 异常或任务未正常结束时，在 `local-agent-service` 目录运行：

```bash
# 导出最近更新的两个未归档文档项目及其分析/翻译记录
npm run diagnose:bundle

# 在导出后调用本机 CodeBuddy SDK，对这两个文档的执行轨迹做初步分析
npm run diagnose:bundle -- --analyze

# 自定义诊断包输出目录
npm run diagnose:bundle -- --out /tmp/vocal-saga-diagnostics

# 完全不收集本机服务日志
npm run diagnose:bundle -- --no-logs
```

脚本按 `catalog.sqlite` 中 `document_projects.updated_at DESC` 选择最近更新的两个未归档项目。v2 只导出诊断所需的紧凑信息：来源版本与片段数量/长度、Prompt 和 LiteraryMemory 版本指纹、Run scope/status、run-segment 状态计数、译文记录数量/长度、Reviewer 分类、TranslationBrief 大小、Context Graph 统计与阶段耗时、质量审计指标和有界事件时间线。不会导出原文/译文正文、完整 Prompt、Context Graph Source Feature 行、原始 TranslationBrief、上下文增量、质量 finding 正文或完整事件 payload。

默认还会从 `LOCAL_AGENT_LOG_FILE`（未设置时为 `~/.vocal-saga-local-agent/logs/local-agent.log`）读取**末尾最多 512 KiB**，筛选至多 180 行服务生命周期、重启、异常和 Provider 超时相关日志；上传包前仍应检查这些错误信息。可使用 `--no-logs` 完全排除日志。脚本设置 `COPYFILE_DISABLE=1`，避免 macOS tar 将 `._*` AppleDouble 元数据附加到归档。`--analyze` 只把紧凑摘要和日志计数发送给本机 CodeBuddy，不会把书稿正文发送给分析模型。

诊断包默认写入 `~/.vocal-saga-local-agent/diagnostic-bundles/`。压缩包仍会包含项目标题、片段 ID、时间戳、Provider/Model 名称和错误消息；分享前请检查 `README.txt`、`summary.json` 与 `service-log-excerpt.txt`。


### 小说人物/声音档案缺失诊断

如果《King Rat》等小说中的称谓没有进入“人物角色与声音档案”，可在服务目录执行只读诊断：

针对 James Clavell 的《King Rat》，King Rat 只用于按书名定位项目，不作为人物名；人物检索会使用 the King、King 和 Corporal King。当前人物候选是 King 下士，但不应在没有原文依据时臆造首名。

请优先使用**项目 UUID**，不要只用书名。诊断报告显示同名 EPUB 可能存在多个独立项目，传入标题会同时扫描所有同名项目：

```bash
npm run diagnose:character-voice -- \
  --project "<project-id>" \
  --term "the King" \
  --out ./king-character-diagnosis.json
```

如果要检查其他项目，将 --project 替换为实际 UUID。脚本会重算 BookScan 和当前确定性采样计划，并读取当前来源版本、Context Graph 的节点和证据、人物声音档案、已保存的 TranslationBrief、项目事件、模型请求历史以及配置的工作区/日志目录。

报告新增以下信息：原文中 the King、Corporal King、King Rat 书名和 the King's English 的分项计数；当前采样计划与持久化预处理样本的重合率；模型结构化输出中的人物/实体候选、证据拒绝原因、候选是否最终持久化；请求历史中的端点/模型统计和可解析的结构化响应摘要；以及每个日志扫描根目录是否存在、实际发现和检查了多少文件。

**重要：旧 run 没有逐候选模型输出审计。** 更新版本后，需要在 UI 针对当前 project UUID 重新执行一次“重新分析全书”，才能为新 run 持久化 context-graph.output-audit；诊断脚本会明确标记历史 run 缺失审计信息，避免把“没有历史记录”误判成“模型没有返回人物”。

脚本本身仍是只读的：不调用模型、不发送网络请求、不修改 SQLite 或工作区；报告中的原文/请求摘录有长度限制，并对常见 Token/Secret 字段脱敏，但分享前仍建议人工检查报告文件。

### 当前译名一致性与英文残留诊断

如果人物档案已经建立，但实际译文仍出现多个译名，或中文译文中遗留了 `again` 等英文词，可以对现有项目运行做定点诊断：

```bash
npm run diagnose:translation -- \\
  --project-id "<project-uuid>" \\
  --run-id "<run-uuid>" \\
  --name "Yabu" \\
  --word "again" \\
  --out ./translation-diagnosis.json
```

该脚本只读当前来源版本的已采纳译文、Run 固定的 LiteraryMemory、保存的 TranslationBrief、实际发送给模型的片段和规范名遮罩事件。它会同时检查 `entities` 与“人物角色/声音”中**已确认且启用翻译**的规范名，显示批次实际注入的名称映射、规范名冲突、原文/译文中的目标人物命中，以及译文是否残留指定英文词。它不自动修改译文，也不调用模型。没有给出 `--run-id` 时最多检查最近 6 次运行；输出报告含有限长度的原文/译文摘录，分享前请检查敏感信息。

本机模式是强制 Provider 路由，不是“本机优先、失败切远程”：翻译、侧栏对话、文学分析或审校的本机模型调用失败时会返回明确错误；扩展不会因此向 DeepSeek 或远程 Vocal Saga 重试。文档批次规划遇到服务不可用时使用的只是扩展端确定性 CPU 算法，不会发送模型/API 请求；阅读状态持久化失败也只影响恢复副本，不会改变翻译 Provider。

## 配置 fanyi-extension

在扩展 Popup 勾选“本机 Workbuddy/OpenCode Provider”，选择 Workbuddy 或 OpenCode；服务地址填 http://127.0.0.1:8789。默认无 Token 时扩展的 Token 字段留空；只有在服务端主动配置了 LOCAL_AGENT_TOKEN 时才需要同步填入。模型覆盖可以留空（使用 Workbuddy SDK / OpenCode 自身默认模型），或者填写 Workbuddy 的本机模型 ID / OpenCode 的 provider/model（例如 openai/gpt-5.4 或 ollama/qwen3-coder）。

启用本机 Provider 后，扩展会优先走本机服务，不会发送到 s.sunxiunan.com。EPUB/PDF 文学模式的实体分析与 Reviewer 也使用相同的本机服务。取消勾选后，原来的 DeepSeek 和远程 vocal-saga 配置继续可用。

## 通过 Cloudflare Tunnel 暴露到公网

本机服务依赖 Node、SQLite 和本机 CLI Agent，无法部署到 Cloudflare Workers，因此公网访问走 Tunnel（`cloudflared` 从本机主动连出，不需要公网 IP、不需要路由器端口映射）。

```bash
# 1. 一次性：浏览器授权，选择域名所属 zone
cloudflared tunnel login

# 2. 创建命名隧道 + 绑定域名 + 生成 ~/.cloudflared/config.yml
TUNNEL_HOSTNAME=local.sunxiunan.com ./scripts/setup-tunnel.sh

# 3. 前台试跑，确认可用后再常驻
cloudflared tunnel run vocal-saga-local
sudo cloudflared service install
```

服务端要同时配两项，缺一不可：

```dotenv
LOCAL_AGENT_TOKEN=<openssl rand -hex 32 生成>
LOCAL_AGENT_ALLOWED_HOSTS=local.sunxiunan.com
```

`LOCAL_AGENT_ALLOWED_HOSTS` 控制 Host 头白名单。默认只接受 `localhost` / `127.0.0.1`（防 DNS rebinding），隧道域名不在其中会一律 403；`*.example.com` 可匹配子域。**该变量非空即代表服务可被非本机访问，此时 `LOCAL_AGENT_TOKEN` 为空会让服务直接拒绝启动**，不存在"忘了设 token 但照常开放"的降级路径。扩展侧把服务地址改成 `https://local.sunxiunan.com`，并把同一个 token 填进「本机服务 Token」字段。

两个必须知道的限制：

- **请求时长**：Cloudflare 代理对单个 HTTP 请求有 100 秒上限，超出返回 524。短文本翻译和单批文档片段没问题，文学审校、整章翻译这类长任务会被切断（服务自身 `LOCAL_AGENT_TIMEOUT_MS` 默认 180 秒，比这更宽）。要跑长任务需要给响应加 SSE 心跳或改成 job + 轮询，属于架构改动。
- **请求体大小**：免费/Pro 套餐的 Cloudflare 请求体上限是 100 MB，与 `MAX_DOCUMENT_BODY_BYTES`（100 MiB）基本持平，超大文档会先被边缘拒绝。

安全边界：这个服务能读写本机 SQLite、调起本机 CLI Agent、读取本机文档，公网暴露等于把本机执行入口挂上去。token 泄露的后果是别人能在你的机器上跑模型、读你的书稿。除了 token，建议再加 Cloudflare Access（Service Token 方式，扩展侧需补 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 两个请求头）；如果只是自己几台设备用，Tailscale/WireGuard 比公网暴露更合适，也没有 100 秒超时问题。

## WorkBuddy/CodeBuddy 调用方式与性能说明

网页翻译与旧式单次文档请求属于单轮、无工具的结构化文本任务，不需要 Agent 检索仓库、调用 Shell 或运行 MCP。Workbuddy 对这类通用请求使用官方 `@tencent-ai/agent-sdk` 的 `query()`，并显式禁用工具和配置加载；同时设置 `persistSession: false`，避免把每个请求写成持久化会话记录（需要 CodeBuddy CLI >= 2.125.1）。Project-based EPUB/PDF Agent 是另一条路径：它使用按 run/role/batch 隔离的 structured Session，并由服务端 workflow 管理重试、审校和持久化。高频纯文本翻译走长驻会话池（`src/agents/workbuddyPool.ts`，`LOCAL_AGENT_POOL_SIZE` 默认 6，`LOCAL_AGENT_POOL_MAX_USES` 默认 10）：CLI 进程可跨多次纯文本请求复用，以减少重复启动与初始化；实际收益取决于模型、输入、机器和排队情况。 查询超时从动态 SDK 加载前开始，超时会请求 `interrupt()` 并停止本地事件消费；这只确认发出了中断请求，不代表底层 CLI 一定已退出。在至少 60 段、同环境重复 3 次的基准完成前，不把单次观察外推为固定节省或提速比例。默认 Provider 为 Workbuddy 且 `LOCAL_AGENT_PREWARM` 未设为 false 时，服务启动后预热池中空闲槽位（只 boot、不调模型）；默认 Provider 为 OpenCode 时不会启动 Workbuddy CLI。不用 daemon（`--serve`）：它是交互式 Agent 服务，走 Gateway Protocol 的 `/api/v1/runs`，给按 chunk 计量的无头翻译用是重协议+多一层 HTTP；池用的是 SDK Session，即文档里 `--input-format stream-json` 长驻进程的 SDK 等价物。文学分析仍沿用单次 `query()`；EPUB/PDF 文档翻译 Agent 则使用独立的批次 Session，并将文学审校从翻译 worker 中解耦，详见下方 Document projects 说明。Project Agent 为避免批次间共享历史会创建独立 scope，因此新批次可能重新初始化 Session，不能假设每批都享受预热收益。需要严格 JSON 对象时走 `runAgentJson`：Workbuddy 侧通过 `--json-schema` 进程参数启用 CLI 原生 structured output（`StructuredOutput` 工具收口，`result.structured_output` 优先），同时保留 `outputFormat` 字段等官方 SDK 修复透传后生效。`POST /v1/chat/completions` 接受 `response_format: { type: 'json_schema', json_schema }`：文档分批缺失后的升级轮用它把翻译数组形状写死做约束解码（普通 `json_object` 只保证"是 JSON"，确定性单条失败必须升级形状约束才走得出来；schema 必须包一层 object，CLI StructuredOutput 工具拒收顶层 array）。纯文本翻译带 `thinking: { type: 'disabled' }`（CLI `alwaysThinkingEnabled=false`）并经 `extraArgs` 直传 `--effort minimal`（transport 只在思考未关闭时才拼它；CLI 若在思考关闭时忽略 effort 也无害）；分析/审校需判断，保持默认。当前机器的 Workbuddy/CodeBuddy 模型由本机 `~/.codebuddy/settings.json` 等运行时配置决定；仓库不保证统一的默认模型，也不能在未对目标模型做实时基准前断言模型不是瓶颈。本机服务自己的 SQLite 请求历史、译文缓存和文档断点仍独立保留，不依赖 SDK 的 Agent transcript。

已核对官方 `http-api.md`、`headless.md`、`sdk.md` 和 `sdk-typescript.md`：

- `query()` / TypeScript SDK 支持已有登录凭据、`CODEBUDDY_API_KEY` 或企业 OAuth token，但它仍是 Agent SDK，不是裸模型 Chat Completions 客户端。
- `codebuddy --serve` 的 REST API 中，`POST /api/v1/runs` 创建的是 Agent run；ACP 也是有状态 Agent 会话协议。官方 HTTP API 文档没有提供通用的纯模型 `/v1/chat/completions` 端点。
- 若要彻底移除 Agent/CLI 层，需要另行配置模型服务商的兼容 API endpoint 和对应 API key。不能假定 CodeBuddy 登录态或 `CODEBUDDY_API_KEY` 可直接用于任意模型供应商的兼容接口。

因此当前优化选择是继续使用官方 Workbuddy SDK、将其限制为无工具的单轮调用，并关闭会话持久化；未来若有独立的模型 API 凭据，可增加显式 direct-model Provider，而不是把 Agent REST API 伪装成 Chat Completions。

## 本机业务能力与 SQLite

本机服务不只是模型转发代理。启用扩展本机 Provider 后，新增以下本机业务 API：

- `POST /api/cache/translation/get` / `POST /api/cache/translation/set`：SQLite 持久化翻译缓存。网页分块翻译可复用之前的译文，文档翻译通过相同 background 分块入口时也共享缓存。默认 7 天 TTL，最多保留 20,000 条；缓存不可用时按 cache miss 处理，不阻断翻译。
- `POST /api/cache/translation/delete`：删除指定缓存 key，用于清除检测到的缺失片段/无效译文缓存，防止一直重复命中不完整结果。
- `DELETE /api/cache/translation`：清空本机翻译缓存；扩展的“清空缓存”会同时清理本机缓存。
- `POST /api/documents/batches`：把结构化文档片段交给本机服务计算批次边界。支持字符数、片段数、章节/PDF 页边界约束，返回片段 ID 而不是重复传回全文；服务不可用时扩展才使用同一套确定性本地计算作为降级，不会调用远程服务。
- `POST /api/documents/session/save` / `POST /api/documents/session/get`：服务端 reader-session。Local Agent 扩展的新写入只保存 `projectBacked: true`、`projectId`、来源文件名、阅读位置、语言/视图和轻量进度状态；不保存正文、译文、LiteraryMemory 或 Context Graph。恢复时通过 projectId 读取项目数据库，再分页加载来源片段、已采纳译文和 LiteraryMemory。旧版包含全文/译文/记忆的 session payload 仅为历史迁移兼容保留，不再作为新写入格式。
- `POST /api/documents/session/summary`：只返回恢复卡片所需的标题、格式与更新时间，不传回项目正文。Local Agent 模式下该 reader-session 是服务端保存的轻量项目引用，不是扩展 IndexedDB 的备份副本。
- Local Agent 阅读器由扩展负责文件选择和 UI；EPUB/PDF 原始文件通过 `POST /api/documents/projects/import-file` 上传，由服务端解析、分段和持久化。扩展只读取分页内容，不保存第二份全书解析结果。非 Local Agent 兼容路径仍可使用浏览器解析器。

这些端点只供 loopback 本机扩展使用，沿用同一可选 Token 校验。缓存值、reader-session 与请求历史是独立数据表；`LOCAL_AGENT_STORE_CONTENT=false` 只控制请求历史是否记录完整 prompt/响应，不会关闭项目数据库或 reader-session。旧版 reader-session payload 曾受序列化 JSON 5 MiB 限制；新格式只保存项目引用和轻量 UI 状态，不包含整本书内容。当前原始 source-file 二进制上传上限为 20 MiB，`/api/documents/*` 的 JSON 请求体上限为 100 MiB，其他 Local Agent JSON API 为 24 MiB。清空翻译缓存不会删除文档项目或 reader-session。清除项目内容应使用项目管理 API/界面；停止服务后删除整个 SQLite 数据库文件会删除所有本机持久化数据。

## PDF/EPUB 的 CodeBuddy Session 策略

本机 Workbuddy Provider 存在两种 Session scope，不能混为一谈：legacy `/v1/chat/completions` 适配器按扩展传入的文档元数据构造会话键；project-based EPUB/PDF Agent 则在 `translationAgent.ts` 里按 `projectId + runId + role + promptRevisionId + lane + batchIndex` 构造 scope。后者让每个批次及 Reviewer 使用独立会话；同一批次的缺失 ID 重试复用该批 scope：

- `translation`、`analysis`、`review` 三种角色互不共享历史；不同运行、不同批次不会复用同一段对话。每批都携带显式的原文前文、Prompt、glossary 与 `voiceContext`，不依赖隐式历史维持人物译名或声音。只有同一批次的定向缺失 ID 重试才复用当前 batch scope。
- 每个 Session 同一时间只处理一轮。默认会话池最多 6 个槽位、每个 Session 最多复用 10 轮；槽位不足时只淘汰空闲会话中最近最少使用的一条。达到轮数上限或遇到失败后会丢弃会话，下次请求重新创建并注入稳定提示词。 `closeAll()` 是终态：排队中的请求被唤醒后会失败退出；如果 Session factory 在关闭后才返回，新建的 Session 会立即关闭，不能重新发布到池中。若 SDK Session 没有成功执行 `setModel()` 的能力，切换模型会重建 Session，不能只改池里的模型标记。
- 文档 Agent 将翻译、准确性/术语审校和独立文风审校分配到有界 worker。默认 6 槽位下，文学模式使用最多 4 个翻译 worker + 2 个 Reviewer worker；关闭审校时翻译可用最多 6 个槽位。`LOCAL_AGENT_DOCUMENT_TRANSLATION_CONCURRENCY` 是翻译并发上限（默认 6），`LOCAL_AGENT_DOCUMENT_REVIEW_CONCURRENCY` 是审校并发上限（默认 2），实际分配按 `LOCAL_AGENT_POOL_SIZE` 收敛。文风审校作为单独阶段执行，有原文/译文证据支持的文风修订会自动保存为本次 Run 候选；中文单语编辑先经过双语复核，再自动写回候选。Run 完成时服务端自动采纳有效候选，且保护较新的人工修订。 Reviewer 使用独立的 `LOCAL_AGENT_REVIEW_TIMEOUT_MS`（默认 300000 ms / 5 分钟），不受普通 `LOCAL_AGENT_TIMEOUT_MS`（默认 180000 ms）限制；可以按本机 Provider 与模型表现调整。超时仍是有界失败，不会无限等待：Workbuddy 会请求 SDK interrupt 并丢弃当前不可信 Session；OpenCode 会终止对应 CLI 子进程（先 SIGTERM，必要时 SIGKILL）。Run 的 `plan.ready` 和 Reviewer `stage.started` 事件会记录实际超时值。
- 章节名、当前原文、相关实体映射和近期译文样例作为每轮数据发送；项目 SQLite 中的 LiteraryMemory revision 是唯一可恢复的正式状态。扩展只在页面内存中持有 UI 投影。服务重启后不会依赖旧的对话 transcript，而是从项目数据库读取当前记忆并重新建立 Session。
- 初译一批后先持久化候选并立即调度下一批；审校独立读取原文、初译、`voiceContext` 与原文 `precedingSegments`，仅在发现 must-fix 问题时生成替换候选。run 结束前会等待所有已调度审校落定；取消后仍在飞的翻译/审校响应会被丢弃，不得迟到覆盖运行状态。
- SDK Session 当前不启用会话 transcript 持久化（`persistSession: false`），避免隐式保留完整原文、译文和历史提示词。普通网页翻译仍使用原有共享文本池，不加入文档专属会话。
- project-based Agent 的每批独立 scope 优先保证历史隔离和可复现的显式输入，不承诺跨批次复用同一个 SDK Session 或隐式上下文。Workbuddy 会话池限制同时活动的 Session 槽位；跨批次重新建 scope 可能增加初始化成本。它也不等于模型供应方的 Prompt Cache，不保证缓存命中或费用下降；应结合 `ttftMs`、整批耗时及模型服务可提供的缓存统计评估。
- OpenCode 当前仍使用一次性 CLI 调用，没有接入 CodeBuddy SDK Session 池；其请求仍会携带显式书籍记忆与任务提示词。因此，上述长驻 Session 优化目前适用于 Workbuddy/CodeBuddy SDK。

## SQLite 与隐私

数据库默认位置为 ~/.vocal-saga-local-agent/local-agent.sqlite，使用 WAL。保留运行状态、provider/model、时延、字符数、成功/失败和历史记录。默认 LOCAL_AGENT_STORE_CONTENT=true，会将完整请求 prompt、原文和译文保存在本机 SQLite；如果不希望持久化正文，在 .env 设置 LOCAL_AGENT_STORE_CONTENT=false 并重启，此时仅记录元数据与长度。GET /api/history?limit=30 可查询最近记录；DELETE /api/history 可清空历史。

LOCAL_AGENT_TOKEN 是可选项。留空或保留示例占位值时，服务仍会启动；因为服务只监听 loopback，且会拒绝普通网页的 Origin，仅允许浏览器扩展来源与无 Origin 的本机命令行调用。若配置了 Token，则请求必须携带正确值；扩展的 Token 设置可留空或与服务配置一致。服务始终只监听 127.0.0.1，不应通过反向代理、隧道或局域网地址暴露。
## Document projects and the EPUB/PDF Translation Agent

The ordinary /v1/chat/completions endpoint remains the single-call provider interface. Long documents now have a separate project lifecycle rather than putting an entire book into one JSON checkpoint:

- ~/.vocal-saga-local-agent/documents/catalog.sqlite is a rebuildable project catalog. Each project owns documents/<documentId>/project.sqlite.
- Project databases store source revisions and stable segments, original files, Prompt revisions, LiteraryMemory revisions, Context Graph data/evidence, translation runs, per-segment status, candidate translations, accepted/manual translations, review findings and durable events. The `document_sessions` API remains only as a lightweight reader-session pointer for current clients; legacy full snapshots are compatibility data and are not the current source of truth.
- With the local Agent enabled, the extension's normal EPUB/PDF reading action and the Agent workspace tab call the same project API and Translation Agent. They share a project ID, current-source hash, Prompt/config fingerprint, accepted translation map and run history; the UI is not allowed to maintain a second local-only translation pipeline. A workspace has at most one queued/running/awaiting-acceptance run at a time; a new Run cannot start until the previous Run has completed finalization. The executor validates and automatically accepts eligible candidates when any Run finishes, regardless of whether it was started from the reader, Workspace, API or CLI. Finalization preserves newer manual edits and source hashes; the accept endpoint remains available for explicit recovery of candidates left pending after an interrupted finalization. On service restart, Runs left in `awaiting_acceptance` are recovered automatically: source-ordered context deltas are merged into the latest LiteraryMemory under a SQLite transaction, then eligible candidates are accepted. Candidate acceptance rejects superseded source revisions and preserves any newer accepted result for the same source hash.
- Each run plans its scope deterministically: all, stale, failed, selected IDs or chapter. Source fingerprints, Prompt/config fingerprints and pipeline version are used to detect stale output.
- The Agent executes a bounded workflow: plan, translate in batches, validate IDs and structure, run configured literary review, and automatically finalize eligible candidates. The model cannot directly mutate project state; the Store validates every candidate and protects newer manual edits. Missing IDs get one targeted retry instead of resending the whole document.
- New runs do not overwrite newer accepted/manual translations. Eligible candidates are automatically promoted by the shared finalization transaction; `/runs/:runId/accept` remains an idempotent recovery/compatibility operation. Manual corrections create accepted results marked with `origin=manual`.
- On service startup, interrupted queued/running jobs become paused and in-flight segment rows return to pending. Resuming continues from remaining segments without deleting existing successful candidates.

### Service-side original-file import and Context Graph

The local service parses original documents directly; Local Agent document import does not persist a browser-side copy of the parsed document.

For PDFs, the importer uses Poppler's `pdftotext` command in text-only mode. Install it on macOS with `brew install poppler`. There is no OCR path. A PDF without a usable text layer returns an explicit error.

Every imported source revision gets stable segment IDs and stores the original file outside SQLite. Preprocessing selects beginning/middle/end, representative chapters, dialogue-dense and entity-dense samples, then asks the configured local model for candidate characters, aliases, entities, relationships, narrative style and chapter summaries. Each graph candidate must include a quote validated against a sampled source segment. Narrative facts, relationships and character-voice observations remain candidates rather than becoming facts automatically. A canonical proper-name mapping with a non-empty target and validated source evidence is automatically activated for translation; users do not need to confirm each name individually. Nodes, edges and source evidence are stored against the source revision; rejected mappings remain excluded.

Before each literary translation batch, retrieval matches names and aliases in the current batch plus preceding segments, then injects only a bounded set of matched characters/entities, related edges and summaries from the current and previous chapters. It does not inject the full graph or later chapter summaries. The Context Graph is part of the literary run fingerprint, so graph changes make previously accepted non-manual translations stale. Re-analysis and graph status changes are blocked while a translation run remains active.

Canonical proper-name mappings are handled separately from plot context. Preprocessing takes the source and target language from the project's Prompt configuration; `suggestedTranslation` is generated in that target language, not assumed from the source text. Before literary translation, a mapping with validated evidence is supplied as an active glossary entry regardless of whether its graph row is still a candidate for non-name review. The local Agent masks source-name mentions with protected tokens in both translation and Reviewer prompts, restores them to the glossary target, and rejects a batch result that drops a required token. Conflicting targets are excluded rather than arbitrarily selecting one. The literary pipeline fingerprint is versioned so previous non-manual results become stale and can be regenerated with the canonical-name policy; accepted manual edits remain preserved. The current analysis version is `context-graph-v10-default-adoption`. The Local Agent worker detects source-revision, analysis-version and language-direction mismatches for literary Runs and prepares the matching graph before translation; the extension reads a small status projection rather than owning the readiness gate. A translation batch may reuse an evidence-backed canonical name and target translation as soon as that canonical source name is present in the current or preceding source, even if the supporting quote was analyzed later in the book. This does not expose later aliases that have not appeared, role descriptions, relationships, or chapter summaries. The same mapping is passed to the translator and both Reviewers so a recurring name cannot silently drift between variants.

There are two supported entry paths. Direct original-file import (`npm run doc -- import-file` or `POST /api/documents/projects/import-file`) starts analysis during import. In the Local Agent `fanyi-extension` reader flow, EPUB/PDF source files are uploaded through `POST /api/documents/projects/import-file`; the service parses and persists the source revision and stable segments. The extension reads project pages and `GET /api/documents/projects/:id/context-graph/status` for display. It does not persist a second document/translation/LiteraryMemory copy or create a second readiness gate/wait loop. When a literary translation Run is submitted, `executeRun` checks the immutable source revision, analysis version and language direction, starts or waits for matching preprocessing, and only then enters translation. Existing accepted translations and explicitly confirmed glossary mappings are preserved; a graph-derived target repairs an older unconfirmed AI suggestion but never silently replaces a user-confirmed translation.

### Literary quality baseline (M0), adaptive book scan and source feature index (M1/M2)

M0 now has two checked-in regression corpora:

- `tests/fixtures/fiction-quality-baseline.json`: a small synthetic failure-control corpus for isolating missing outputs, term drift, repeated lines and chronology leaks.
- `tests/fixtures/alice-adventures-real-novel.json`: 22 curated English sentence/dialogue spans from Lewis Carroll’s public-domain novel *Alice’s Adventures in Wonderland*, sourced from [Project Gutenberg eBook #11](https://www.gutenberg.org/ebooks/11). The spans sample Chapters I, II, V, VI and VII and annotate name/label consistency, repeated dialogue, future-character leakage, written-out quantities, and character-voice contrasts.

The real-novel corpus includes both a deliberately defective reference set and a hand-authored improved example. They are **failure-control examples, not output from a measured LLM run, not a published Chinese translation, and not evidence that a provider has improved**. They prove that the evaluator catches known regressions on real source material. The automated score does not judge literary voice; that remains a blinded human-review dimension.

Run both fixture suites and save the machine-readable report:

```bash
cd local-agent-service
npm test
npm run quality:fiction-baseline
node scripts/evaluate-fiction-quality-baseline.mjs --fixture tests/fixtures/alice-adventures-real-novel.json
```

The evaluator accepts the service CLI export shape (`segments[].translation`), a `translations` array (each item has `id` and `translated_text`), or an ID-to-text object. To compare actual model outputs, export both finished runs and use the *same fixture* for both files:

```bash
node scripts/evaluate-fiction-quality-baseline.mjs \
  --fixture tests/fixtures/alice-adventures-real-novel.json \
  ./before.json ./after.json
```

The result reports per-dimension scores, exact findings and before/after deltas for coverage, terminology, repeated-expression consistency, chronology safety and annotated quantity fidelity. Quantity checks explicitly cover English number words such as “ten inches” and “twenty-four hours”, rather than relying only on Arabic digits. The reference translations are included to exercise the checks; use actual exports for model evaluation.

For an end-to-end test using the actual local provider, import the annotated source fixture and use the same source revision, language direction, and segment scope for the before and after runs:

```bash
npm run doc -- import tests/fixtures/alice-adventures-real-novel.json
# Use the returned project ID to run context analysis and translation.
npm run doc -- context-analyze <documentId>
npm run doc -- run <documentId> --scope=all
# Runs automatically finalize eligible candidates; export the completed runs before comparing exports.
```

A before/after score is a deterministic signal, not a literary-quality verdict. Character voices (Alice’s hedging, the Caterpillar’s clipped repetition, the Cheshire Cat’s paradoxical replies, and the tea-party characters’ distinct registers) must be reviewed against the source with run identity hidden. For the service’s persisted, randomized blind packet and guarded A/B disclosure, use the M4 quality-evaluation API documented below.

### Source feature index (M2, 2026-10-17)

The literary preprocessor now emits a deterministic source feature index for each immutable source revision. `bookScan.ts` indexes entity/title candidates and their exact UTF-16 source offsets, sentence and quotation spans, dialogue signals, and lexical number/unit mentions. It keeps the source surface form and stable segment ID; these records are sampling and validation hints, not named-entity recognition facts.

`contextGraph.ts` persists the index in SQLite `context_graph_source_features` under schema version `book-scan-index-v2`. The metadata row records scan limits and whether entity/text/quantity features were truncated. Reads require a matching version and a complete segment row set; an absent or incomplete index returns `null` so callers can use the deterministic scan fallback instead of mixing source revisions.

The sample planner continues to cap model analysis at 72 samples and 850 source characters per sample. It now uses source-positioned multiword/title candidates, sampled occurrence offsets (only where the matched text is actually present in the model input), sentence/quotation repetition, dialogue-density and quantity hints. This improves explainability and sampling coverage without increasing the model's total sample budget.

Quality audit prefers the persisted index when grouping repeated source sentences and quotations. It compares whole translations only when the whole source segment is the repeated sentence; for embedded quotations, it compares the corresponding target quotation where uniquely identifiable. Unalignable embedded phrases produce an informational manual-review finding rather than treating paragraph-level differences as proven phrase drift. Validated `context_delta.entity_mentions` also contributes explicit cross-batch target-surface consistency findings when source/alias identity is grounded. Neither finding triggers global replacement or automatic acceptance.

`book-scan.test.mjs`, `document-context-graph.test.mjs` and `quality-audit.test.mjs` cover compound/title candidates, exact offsets, index persistence, repeated quote alignment, explicit entity mention drift, and the memory-write boundary. These tests validate deterministic behavior only; actual translation-quality benefit still requires a matched before/after run and blind review.
### Unified TranslationBrief, quality audit and paired evaluation (M2–M4)

Literary runs now assemble one bounded `TranslationBrief` for each chapter-scoped batch. The initial translator, accuracy/terminology Reviewer and independent style/character-voice Reviewer receive the same time-filtered glossary, preceding-source context, read-only Context Graph and voice-memory selection. The brief is pinned to the run's source, Prompt and literary-memory revisions, has an 18,000-character serialized-context cap, and is persisted by `(runId, batchIndex)`. Run events record context hash/size, evidence boundary, selected item counts and reviewer input sizes; the run API can return the saved snapshot for diagnosis.

Graph facts are eligible only when **all stored evidence for that node/edge occurs before the first source segment in the batch**. This fail-closed policy may defer a fact if a later chapter provides additional evidence, but avoids injecting later evidence into earlier translation. Complete summaries are only used for previous chapters. The current chapter gets an extractive prefix summary built exclusively from source segments before the batch; its full chapter summary is never injected into an earlier batch. Literary batches are split at chapter boundaries.

Book-wide audit detects missing translations; conflicting confirmed targets between LiteraryMemory entities and Character/Voice profiles; heuristic canonical-name drift; likely English residue in Chinese output; numeric-token mismatches (including common written-out English and Chinese quantities); exact repeated source passages with varying translations; duplicate/unknown/malformed output rows for a specified Run; and stored Reviewer findings for accuracy, terminology, character voice and style. Name-conflict findings are non-repairable until the project memory is manually reconciled. English-residue, numeric and terminology findings are review heuristics, not proof of an error; a retained foreign phrase or proper name can be a false positive. The report records analysis limits and source revision. Model-output anomalies are persisted as run events, and invalid rows never become accepted translations. Findings identify review locations; they do not auto-correct translations. A repair request creates a new selected-ID Run, links it to its parent run where applicable and leaves all accepted/manual translations untouched. Eligible repair candidates are automatically finalized by the same server-side acceptance transaction; newer accepted/manual translations remain protected.

The document Agent UI exposes this through **更多选项 → 全书质量审计**. It loads the latest saved report, displays the metrics and evidence per finding, rejects reports whose source revision is stale, and lets the reader select only findings marked repairable. A partial Run is a finished-but-incomplete result and can be audited to locate missing accepted translations; queued/running/paused work blocks auditing within that same project. Each report also records two aggregate hashes: the accepted-translation snapshot and the effective text actually audited (candidate-overlaid when requested). Before creating a repair Run, the service rechecks these hashes so a manual correction made after the audit cannot be overwritten by an outdated repair request; if a report is stale, rerun the audit. The report stores fixed-size hashes rather than a per-segment translation copy or a hash entry for every segment.

The paired evaluation compares two finished runs on the exact same source revision, language direction and segment ID set. It reports coverage, terminology/repetition warning counts, voice/style findings, pipeline-level translation/reviewer request counts, known system+user prompt characters and measured wall duration. A single pipeline request may trigger internal provider fallback, so these request counts are not guaranteed to equal underlying provider calls. Token usage and billable currency costs are marked unavailable when a provider does not expose them; character counts/duration are operational proxies, not a substitute for actual billing telemetry. Before revealing the metric deltas or A/B mapping, the API returns a randomly assigned blind-review packet. A human records an overall preference for every sample (and optionally accuracy, terminology, voice or style preferences); only then does the result reveal whether A or B was the before/after run.

Useful endpoints below `/api/documents/projects/:id`:

| Method + path | Purpose |
|---|---|
| `GET /runs/:runId/translation-briefs` | Inspect each batch's persisted TranslationBrief including revision IDs, hash, size and selected context. This endpoint explicitly includes the compact saved brief. |
| `POST /quality-audit` with optional `{"runId":"..."}` | Run a whole-book audit against accepted text, overlaid with that run's candidates when supplied. |
| `GET /quality-audit?auditId=...` | Read the latest or a specific saved audit report. |
| `POST /quality-audit/repair` with `{"auditId":"...","findingIds":["..."]}` or `segmentIds` | Create a narrow candidate Run for selected report findings. Eligible repair candidates are automatically accepted when the repair Run finalizes; the repair request itself does not interrupt the user with a confirmation step. |
| `POST /quality-evaluations` with `{"beforeRunId":"...","afterRunId":"..." }` | Create a paired-run evaluation and blind A/B packet. The two runs must be finished and comparable. |
| `POST /quality-evaluations/:evaluationId/reviews` with `{"reviews":[{"segmentId":"...","dimension":"overall","preference":"A"}]}` | Submit human blind ratings; preferences are `A`, `B`, `tie` or `cannot_judge`. Every packet item needs an overall rating before comparison results are disclosed. |
| `GET /quality-evaluations/:evaluationId` | Get the blind-evaluation status; returns run metric deltas only after overall ratings are complete. |

Typical sequence: run baseline translation on the chosen source; repeat on the identical source and segment scope after a Prompt/context change; create the paired evaluation; have a reviewer compare the blinded packet against the source; finally inspect deterministic deltas and added model-call/prompt/duration cost. Use multiple representative passages and repeat the test before claiming an improvement. M0 now includes both the isolated synthetic failure-control corpus and a curated real-source corpus from Project Gutenberg's public-domain *Alice's Adventures in Wonderland*. The CI artifact saves both deterministic reports. Those curated reference translations are not measured model outputs: empirical M4 acceptance still requires matched runs from an authenticated local provider and completed blind human ratings.


### Initial-translation context delta and shared local pipeline

The reader page and Agent Workspace share the same project/run executor, as do CLI and project API callers. The reader actions for continuing with the next untranslated page and forcing a retranslation of the current page must select a Run scope; they must not start a browser-side translation loop or use a separate entity-memory updater. The central contract is defined in [TRANSLATION_PIPELINE.md](../docs/TRANSLATION_PIPELINE.md) and [ADR-0001](../docs/adr/0001-unified-local-translation-context-delta.md).

For literary runs, each initial translation response contains `translations` plus a bounded `context_delta` proposal. The Local Agent validates every source quote against the current batch and requires entity mentions to point to text that actually occurs in the corresponding translation. Invalid context metadata is rejected independently; it does not discard a valid translation. Accepted deltas are stored in the project SQLite `translation_context_deltas` table and exposed to later batches through source-ordered, frozen waves. Batches in one wave share a context snapshot, preventing race-dependent terminology and future-context leakage.

After a successful run, grounded candidates are merged into a new literary memory revision only if the project still has the same source revision. 通过来源证据和结构校验的模型实体/关系以 `model-default` 默认采纳；`user-modified`、`user-confirmed` 和 `user-rejected` 优先，重新分析不得覆盖用户决定、已采纳译文或旧 Run 记录。 Cross-batch target-name disagreements are kept as open questions and surfaced by the whole-book quality audit as `context-delta-conflict` findings. No global replacement or automatic translation repair is performed.

### API

All project endpoints live below /api/documents/projects and use the existing Local Agent Token, loopback Host checks and extension-origin CORS rules:

- GET/POST /api/documents/projects: list/create projects; creation accepts normalized segments.
- GET /api/documents/projects/:id: project summary, verification and recent runs.
- POST /api/documents/projects/:id/source: import a new normalized source revision without deleting run history. Segment identity metadata includes EPUB part path / page / time markers where supplied, so the project retains enough mapping information for future reader/export adapters.
- POST /api/documents/projects/:id/source-file: upload the original file as a binary request with X-Source-File-Name. Files up to 20 MiB are stored outside SQLite at documents/<documentId>/sources/<sourceRevisionId>.<format>; SHA-256 and byte size are recorded in the project database. Re-importing creates a new source revision and never overwrites an earlier revision's source file.
- POST /api/documents/projects/import-file: directly import an original file through the local service. Send raw bytes (not JSON) and set X-Source-File-Name to the URL-encoded file name. The service parses the document, creates stable source segments, stores the original bytes, and starts asynchronous Context Graph preprocessing. This endpoint is independent of the extension's existing reader pipeline; the extension has not been changed.
- GET /api/documents/projects/:id/context-graph/status: fetch a small status DTO (source revision, phase, counters, progress and style notes); use this for routine UI polling so full evidence and chapter summaries are not copied to the extension.
- GET /api/documents/projects/:id/context-graph: explicitly inspect book-level style notes, chapters, graph nodes/edges, source evidence and analysis runs for the current source revision.
- POST /api/documents/projects/:id/context-graph/analyze: explicitly re-run preprocessing for an existing project; poll the status endpoint to observe completion. Translation Runs start preprocessing automatically when readiness does not match.
- POST /api/documents/projects/:id/context-graph/review: review one graph item with JSON { "type": "node" | "edge", "id": "...", "status": "candidate" | "confirmed" | "rejected" }, or review multiple items atomically with { "items": [{ "type": "node" | "edge", "id": "...", "status": "rejected" }], "memory": { ...updated LiteraryMemory... } }. When memory is supplied, graph decisions, the new LiteraryMemory revision and their project events share one SQLite transaction; a memory validation/write failure rolls back every graph decision. This is the deletion path used by the extension to keep Context Graph and LiteraryMemory projections consistent. A node/edge cannot be confirmed without stored source evidence. Graph edits and re-analysis are rejected while a translation run is active, keeping the retrieved context stable during that run.
- GET /api/documents/projects/:id/segments?limit=250&offset=0&runId=...: page through source, accepted translations and one run's candidates.
- GET/POST /api/documents/projects/:id/prompts: list/save Prompt revisions.
- GET/POST /api/documents/projects/:id/runs: list/create Runs. Create returns HTTP 202 while model work continues in the background. For literary Runs, the server persists the Run as queued and applies the Context Graph readiness gate inside executeRun before translation; do not require completed preprocessing in createRun or in the extension UI.
- GET /api/documents/projects/:id/runs/:runId: run status, segment outcomes and review findings.
- POST /api/documents/projects/:id/runs/:runId/resume, cancel or accept: recover, stop or promote candidates.
- PUT /api/documents/projects/:id/segments/:segmentId/translation: save one manual correction.
- GET /api/documents/projects/:id/events?runId=...: read persisted execution events. Browser polling is not the only run history.
- GET /api/documents/projects/:id/verify: detect missing translations and source changes.

### CLI and scripting

UI, CLI and JavaScript scripts call the same TypeScript Project Store and Translation Agent; CLI does not maintain a second translation implementation.

~~~bash
cd local-agent-service
npm run doc -- projects
npm run doc -- import ./parsed-book.json
# Parse the original file locally and wait for the whole-book preprocessing pass.
npm run doc -- import-file ./my-novel.epub
npm run doc -- import-file ./my-document.docx
# Text-layer PDF requires Poppler's pdftotext; no OCR is performed.
npm run doc -- import-file ./my-book.pdf
npm run doc -- context <documentId>
npm run doc -- context-analyze <documentId>
npm run doc -- context-review <documentId> node <nodeId> confirmed
npm run doc -- status <documentId>
npm run doc -- run <documentId> --scope=stale
npm run doc -- run <documentId> --scope=all --prompt-file=./prompt.json
npm run doc -- diff <documentId> <runId>
npm run doc -- accept <documentId> <runId>
npm run doc -- verify <documentId>
npm run doc -- export <documentId> ./accepted-translations.json
~~~

The normalized JSON import accepts title, format, an optional sourceFileName, a segments array and an optional prompt. In addition, `import-file` and `POST /api/documents/projects/import-file` parse original files inside the local service without involving the browser extension. Supported formats are EPUB, DOCX, text-layer PDF, TXT, Markdown and HTML. EPUB extraction follows OPF spine order and preserves content paths; DOCX reads Word paragraphs; PDF uses Poppler `pdftotext` and does not run OCR. On macOS, install the PDF text utility with `brew install poppler`. This direct-import path is used by the Local Agent extension reader workflow; the browser extension does not persist a second full-document snapshot. Prompt changes create a new fingerprinted revision. Manual edits remain the current accepted version across Prompt changes until the user explicitly runs and accepts a replacement; source text changes still mark them stale.

### Literary translation and character voice memory v2

文学模式在同一文档 workspace 内运行；不为每个人物创建独立 Agent。人物声音是可审核、可版本化的数据资产，和静态 Prompt 分开保存。

- 文学记忆保留 v1 的实体、剧情关系、全书文风、章节摘要、近期例句，并迁移为 v2：`characterVoices`、有方向的 `relationshipVoiceRules`、`voiceAnchors`。
- 新分析生成的人物画像/规则/锚点通过来源版本和结构校验后默认参与后续翻译，并以 `model-default` 标记；稳定 ID、证据引用和置信度用于追溯，不要求逐项人工确认。证据不完整时降低使用强度，不伪造证据。
- 用户修改/确认的角色声音核心与用户批准的声音锚点不会被后续章节静默覆盖；机器默认结果不能覆盖用户决定。冲突保留为 open question；说话人不明确时将人物画像作为弱提示，不把推断写成硬事实。
- 批次翻译和 Reviewer 使用独立的只读 `voiceContext` 字段。它按本批原文检索当前可用的 model-default、user-modified 或 user-confirmed 人物/关系/锚点，并遵守来源序号边界；`contextPath` 继续只表示章节/文档结构。
- 上下文按完整条目裁剪，避免序列化 JSON 被字符切片。扩展端缓存指纹包含 voiceContext hash；普通网页没有该字段时，仍使用原来的 cache identity。
- 文学记忆位于每个项目的 `literary_memory_revisions` 表。每次 Run 固定保存 `literary_memory_revision_id`，可从运行记录还原该次使用的角色档案；记忆修改不创建新的静态 Prompt revision。
- Reviewer 可在现有 `style` finding 上标记 `dimension=character_voice|register|narrative_style|pacing`，并引用角色 ID 与证据片段。准确性/术语问题按证据进行 must-fix 修订；有原文/译文证据的文风修订自动保存为 Run 候选，中文单语编辑经双语复核后自动更新候选，Run 完成时统一自动采纳。用户可事后修改。

- The Project Store is the final trust boundary: it checks source revision, segment identity, temporal visibility and whether a voice anchor still points to an available source/translation. Evidence coverage and confidence remain metadata for retrieval strength, not human-approval gates or fixed numeric activation thresholds. `model-default`, `user-modified`, `user-confirmed` and `user-rejected` remain distinct; user decisions take precedence.
- Each literary batch now loads up to four preceding source segments from the same source revision (same chapter first) as a read-only context for pronouns/dialogue turns. They do not enter `run_segments` and must never appear as translation output IDs.

API：
- `GET /api/documents/projects/:id/literary-memory` 读取当前记忆和 revision 历史。
- `POST /api/documents/projects/:id/literary-memory` 保存新的独立记忆 revision。
- `POST /api/documents/projects/:id/prompts` 仍保存静态 Prompt revision；兼容性上若传入 `literaryMemory`，服务端会另存到记忆 revision，而不是放进 Prompt fingerprint。

项目 Skill 见 `local-agent-service/skills/fiction-translation/SKILL.md`。它规定了证据门槛、批次上下文、声音审校和锚点批准顺序。

### Agent boundary

Following the Runtime / Workflow / Skill / Tool / Human separation used in agentic-data-architect, this is a bounded document workflow, not a general-purpose agent with unrestricted tools. The model translates and proposes review changes; the project database owns durable state; deterministic code owns retries, identity validation, cancellation/recovery and state transitions; the service automatically finalizes eligible candidate text; the user can edit or reject the result afterward. Important steps are persisted as project events.

The project Agent uses bounded parallel batch workers for recoverability and throughput. Each translation batch and each literary review batch gets an independent Workbuddy Session scope; every request still carries explicit source context, glossary/Prompt and voiceContext, so correctness does not depend on previous turns in a shared transcript. Initial translation candidates are persisted immediately, reviews run in a separate bounded worker budget and may overlap later translations, and a run does not enter its terminal state until scheduled reviews settle. Cancellation discards in-flight model results. OpenCode retains its one-shot CLI semantics while workflow concurrency remains bounded. OCR for scanned PDF and layout reconstruction from original EPUB/PDF remain in the extension and are outside the project Agent's current input contract.



## Chinese literary editing benchmark

For a blinded A/B comparison of Chinese monolingual editors on 100–200 public-domain, user-owned or licensed segments, see [the benchmark protocol](benchmarks/chinese-literary-editing/README.md). Run it with `npm run benchmark:chinese-literary`. The runner creates a blinded human-review packet, a separate model mapping, bilingual fidelity screening results and a CSV review template. It does not upload local benchmark data.
