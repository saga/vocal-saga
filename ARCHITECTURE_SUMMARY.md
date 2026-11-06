# vocal-saga 项目架构概览

## 一、项目定位

vocal-saga 是一个运行在 Cloudflare Workers 上的翻译代理服务。它结合：
- **URL 翻译**：抓取网页、抽取正文、分块调用 LLM、回填双语 HTML
- **网页翻译 API**：支持浏览器扩展和直接访问
- **LLM 代理**：兼容 OpenAI-style Chat Completions，统一路由到 DeepSeek / NVIDIA / OpenRouter / Cloudflare AI / Gemini / OpenCode / MiMo

目标是：在无 Node-only 依赖的环境下，提供稳定、可扩展、平台无关的网页翻译与 LLM 代理。

## 二、技术栈

- HTTP 框架：`Hono`
- DOM 解析：`linkedom`
- 文章抽取：`@mozilla/readability`
- 存储适配：Cloudflare KV、D1、内存 MapStorage
- 测试：`Vitest`
- TypeScript：`tsc`
- 部署：Cloudflare Workers（`wrangler.toml`）

## 三、目录结构

```
/
├── lib/                            # 平台无关核心逻辑
│   ├── app.ts                      # Hono 应用工厂与路由
│   ├── index.ts                    # 入口导出 + 存储适配
│   ├── modelResolver.ts            # 模型解析与后端路由
│   ├── auth.ts                     # API 鉴权中间件
│   ├── config.ts                   # API key / 运行时配置
│   ├── urlUtils.ts                 # URL 标准化与校验
│   ├── redirectGuard.ts            # 浏览器导航/Fetch 拦截守卫
│   ├── spaGuard.ts                 # SPA/导航脚本清理
│   ├── devirtualize.ts             # 去虚拟定位布局修正
│   ├── storage/                    # 存储适配器抽象
│   └── translate/                  # 翻译核心业务逻辑
│       ├── pipeline.ts             # 翻译主流程
│       ├── contentHelper.ts        # 文章容器识别 + block 提取入口
│       ├── contentDetector.ts      # 智能评分 / 内容检测
│       ├── chunkBuilder.ts         # 分块构建
│       ├── cacheManager.ts         # 翻译缓存管理
│       ├── translateApi.ts         # 翻译结果解析与修复
│       ├── translationDisplay.ts   # 双语回填与显示策略
│       ├── glossaryExtractor.ts    # 术语提取
│       ├── languageDetector.ts     # 页面语言检测（ja → ja-source-natural 升级）
│       ├── blockExtractor/         # DOM 文本块提取
│       ├── extraction/             # 多策略文章抽取与评分
│       └── service/                # LLM 服务调用适配
├── src/
│   └── worker.ts                   # Cloudflare Workers 入口
├── tests/                          # Vitest 测试
├── public/                         # 静态资源
├── wrangler.toml                   # Workers 配置
├── package.json                    # 依赖与脚本
└── ARCHITECTURE_SUMMARY.md         # 本文档
```

## 四、部署架构

### 运行时边界
- 入口：`src/worker.ts`
- `worker.ts` 负责在 Cloudflare Worker isolate 中创建并复用单例 Hono app
- `getApp(env)` 首次调用时：
  - 将 `env.VOCAL_SAGA_KV` 注入 `CloudflareKVStorage`
  - 调用 `createApp(env)` 构造 Hono 应用
  - 后续请求直接复用同一 app 实例，避免重复初始化
- 404 时回退到绑定的静态资源 `env.ASSETS`，保证 `/help.html`、`/translate.html` 等静态页面正常返回
- 长请求依赖边缘网络与上游 LLM，需控制超时和并发，避免 Worker request timeout

### 存储与绑定
- `VOCAL_SAGA_KV`：Cloudflare KV，用于翻译 chunk 级缓存、翻译状态缓存等
- `DB999`：Cloudflare D1，用于翻译结果持久化、历史记录、缓存查询
- `ASSETS`：静态资源绑定，用于部署静态页面与前端资源
- 运行时配置通过环境变量注入，`createApp` 从 `env` 读取并回退到 `process.env`，支持本地测试与 CI

### 安全边界
- 公开翻译页面接口和浏览器扩展 API 不启用鉴权，保持用户访问便利
- 仅对敏感后端管理 API 启用 Bearer `AUTH_KEY`，例如：
  - `POST /api/v1/chat/completions`
- `auth.ts` 负责统一校验 `Authorization` header，与 env 中的 `AUTH_KEY` 对比
- `assertPublicUrl` 与 `normalizeUrl` 保护 URL 输入，避免私网、localhost、非法 scheme 或内网地址注入

### 对外路由分类
- 页面与缓存查询路由：`/`, `/page/:page`, `/article/:id`
- 翻译入口路由：`/translate/*`, `/force/*`, `/openrt/*`, `/nvd/*`, `/mimo/*`, `/gemini/*`, `/oc/*`, `/cf/*`
- 扩展协作路由：`/fanyi/page`, `/fanyi/page/check`
- LLM 代理路由：`/api/v1/chat/completions`
- 模型列表与健康检查：`/api/v1/models`, `/api/hello`

## 五、请求处理流程

### 1. URL 翻译流程

1. 客户端请求 `GET /translate/<url>`，`<url>` 为去 scheme 的规范 URL
2. `lib/urlUtils.ts` 的 `normalizeUrl()`：
   - 补全无 `.` 的简称域名为 `.com`
   - 保留 `www.` 前缀，避免误拆域名
   - 去除 `https://` / `http://`
3. `cacheKeyUrl()` 生成缓存键，并使用 D1 查询是否存在已翻译 HTML
4. 如果缓存命中且 `isHealthyCachedHtml(html)` 返回 `true`：直接返回缓存结果，避免重复翻译
   - 健康检查包括：
     - 是否包含 `<html>` 标签
     - 是否带有有效外链样式或原页面内联样式
     - 是否没有仅保留 OneTrust / fanyi 内联样式
5. 缓存未命中或缓存损坏时进入 `translateUrl()`：
   - `fetchPage()` 使用 `linkedom` 抓取目标页面并解析 DOM
   - `prepareDocument()` 识别文章根节点并提取文本块
   - `translateChunksWithRetry()` 构建 chunk 并并行翻译，处理漏翻块重试
   - `applyBlockTranslation()` 将翻译结果回填到 DOM
6. 页面后处理：
   - `stripDangerousScripts()`：移除可能触发重定向、导航或敏感 JS 的脚本
   - `devirtualizeLayout()`：修正基于绝对定位 / transform 的“虚拟布局”残留
   - `injectRedirectGuard()`：注入客户端 Fetch/Navigation 拦截代码，增强浏览器端安全
7. 最终 HTML 写入 D1 缓存，供后续请求命中
8. 返回带双语内容的 HTML 响应

### 2. 扩展端 HTML 翻译流程

1. 浏览器扩展发送 `POST /fanyi/page`，提交原始 HTML 和 URL
2. 服务端解析 request body，确认 `html`、`url`、`provider` 等参数合法
3. 如果 HTML 包含 `data-fanyi-block-id` 标记：说明扩展已经完成了 block 抽取，服务端直接从标记中提取块数据
4. 否则按标准流程调用 `prepareDocument()` 进行内容抽取和 block 生成
5. 翻译结果回填 HTML，执行同样的后处理 pipeline，并写入缓存
6. 将双语 HTML 返回给扩展端，用于显示或缓存

### 3. 扩展缓存预检查流程

- `GET /fanyi/page/check` 实现扩展端缓存检查
- 返回 `204` 表示服务端无缓存，应继续翻译
- 返回 `200` 表示已有缓存结果，可直接复用，减少重复翻译

### 4. LLM 代理流程

1. 客户端请求 `POST /api/v1/chat/completions`
2. `requireAuth` 中间件验证 Bearer token 是否匹配环境变量中的 `AUTH_KEY`
3. 请求体解析出 `model`, `messages`, `stream` 等参数
4. `lib/modelResolver.ts` 根据 model 名称或 `_backend` 字段决定后端类型
5. 转发到对应的后端实现：`DeepSeek`, `OpenRouter`, `NVIDIA`, `Cloudflare AI`, `Gemini`, `OpenCode`, `MiMo`
6. 统一处理上游响应：
   - 解析可能的 `translated_text`, `text`, `translation` 字段
   - 修复 JSON 语法错误
   - 记录网络状态、延迟与错误信息
7. 将上游结果原样返回，保持与 OpenAI-style 接口的兼容性

### 5. 核心控制点

- Cache-first：优先命中 D1 缓存，减少 LLM 调用成本和延迟
- 健康检查：缓存命中前验明 HTML 结构完整且具有样式
- 多层防御：后端清理 + 前端注入护盾，防止 SPA 重定向和导航劫持
- 扩展协作：支持扩展端提前标记 block，提高服务端效率
- 统一模型路由：URL 翻译、扩展翻译与 LLM 代理共用模型解析逻辑

## 六、核心模块

### 1. Hono 应用与路由

`lib/app.ts` 是平台无关的 Hono 应用工厂。它负责：
- 读取 env 绑定配置并注入 `config`
- 注册所有路由，包括公开翻译路由、扩展接口、LLM 代理、术语管理等
- 渲染翻译历史页面与分页列表页
- 统一处理 HTML 缓存查询、D1 数据库读取与写入
- 提供 `isHealthyCachedHtml()` 检查缓存完整性，避免返回损坏 HTML

### 2. URL 标准化与校验

`lib/urlUtils.ts` 负责将输入转为稳定的缓存键和安全 URL：
- `normalizeUrl(url)`：补全简写域名、剥离 scheme、保留 `www.` 前缀
- `assertPublicUrl(url)`：禁止 `localhost`/私网/特殊 scheme
- `cacheKeyUrl(url)`：生成缓存键，避免同一页面被不同 URL 形式分裂缓存

### 3. 存储适配

`lib/storage/` 提供 `StorageAdapter` 抽象，屏蔽不同后端实现：
- `get(key)` / `getJSON(key)`
- `set(key, value, ttlMs?)` / `setJSON(key, value, ttlMs?)`
- `delete(key)` / `list()`

实现包括：
- `CloudflareKVStorage`：在 Worker 环境中访问 KV
- `MapStorage`：用于测试与本地开发

`setDefaultStorage()` 用于注入默认存储层，使上层模块无需直接依赖 KV API。

### 4. 翻译主流程

`lib/translate/pipeline.ts` 是整个翻译流程的入口，提供三种对外接口：
- `translateText()`：用于纯文本或小段落翻译，直接对文本块进行 chunk 构建与 LLM 调用
- `translateUrl()`：用于页面翻译，负责抓取 URL、缓存检查、全文抽取与最终 HTML 输出
- `translateHtml()`：用于浏览器扩展或外部 HTML 输入，支持预标记 block 和纯 HTML 重新解析

#### 4.1 `translateUrl()` 流程
- 接收标准化后的 URL 和语言参数
- 先查询 D1 缓存：若命中且 `isHealthyCachedHtml()` 返回 `true`，直接返回缓存 HTML
- 缓存 miss 时：
  - 调用 `fetchPage()` 抓取目标页面 HTML，并使用 `linkedom` 解析为 `Document`
  - 调用 `prepareDocument()` 生成 `PrepareDocumentResult`
  - 调用 `translateChunksWithRetry()` 获取翻译 chunk
  - 调用 `applyBlockTranslation()` 把翻译结果写回原页面 DOM
  - 执行 `processTranslationHtml()` 做后处理
  - 将最终 HTML 写入 D1 缓存

#### 4.2 `translateHtml()` 流程
- 接收 raw HTML、URL、source/target 语言、provider 等参数
- 尝试读取 `data-fanyi-block-id` 标记：如果扩展端已预标记 block，则复用该信息，避免重复抽取
- 若没有预标记，则仍调用 `prepareDocument()` 进行文章抽取与 block 提取
- 翻译后执行与 URL 翻译一致的回填与 HTML 后处理

#### 4.3 `prepareDocument()` 角色
- 负责从 `Document` 中找到最佳文章根节点
- 先调用 `contentHelper` / `contentDetector` 或 `extraction.pipeline` 得到 `ArticleCandidate`
- 生成 `TextBlock[]`：遍历文章根节点，按照 `DIRECT_SET`、`SKIP_SET`、`renderHint` 规则提取块
- 计算块级 metadata：
  - `renderHint.inlineCandidate`
  - `context` 摘要信息
  - 术语表、关键词提示
- 结果用于后续 chunk 构建与翻译请求

#### 4.4 `translateChunksWithRetry()` 角色
- 将 `TextBlock[]` 交给 `chunkBuilder` 分成若干 `Chunk`
- 按服务类型设定并发度：
  - DeepSeek：并发 4
  - OpenRouter / OpenCode：并发 1
  - NVIDIA / Cloudflare / Gemini：默认 2
- 并行发起每个 chunk 的 LLM 调用
- 对返回结果做 `translateApi.processTranslationWithCheck()`：
  - 修复 JSON 语法问题
  - 兼容不同服务返回结构
  - 检查和记录 `unchanged` / `missing blocks`
- 发现缺失 ID 时，调用 `diffMissingIds()` 与 `shouldRetryMissing()` 决定是否重试该 chunk
- 重试流程使用 `buildRetryChunk()` 只包含漏翻块，以减少额外 tokens

#### 4.5 `applyBlockTranslation()` 角色
- 将翻译结果按 `TextBlock.id` 匹配回原 DOM
- 主要逻辑在 `translationDisplay.ts`：
  - `.fanyi-original` 用于保留原文节点与结构
  - `.fanyi-translation` 用于容器内插入译文
- 翻译显示策略：
  - 对短句或 inline 候选使用内联模式
  - 对长句使用块模式，避免破坏段落结构
- 保证不直接替换原节点的样式和链接关系，避免断裂页面交互

#### 4.6 `processTranslationHtml()` 角色
- 做最终 HTML 后处理，输出可直接在浏览器显示的页面
- 处理步骤包括：
  - `stripDangerousScripts()`：删除导航、重定向、SPA hydration、client-side fetch hook 相关脚本
  - `devirtualizeLayout()`：修复 `position:absolute`、`transform`、`translateY` 等虚拟定位残留，避免双语页面重叠
  - `injectRedirectGuard()`：注入客户端 Fetch/Navigation 拦截逻辑，保护翻译页面在浏览器端不会被原站点脚本劫持
  - 添加双语显示 CSS 和 `base` 标签，保证相对链接正常工作

#### 4.7 数据流与错误处理
- `translateUrl()` / `translateHtml()` 的输入输出为结构化对象，便于缓存与日志记录
- 失败时会捕获：
  - fetch 网络错误
  - 解析错误
  - LLM 服务错误
  - chunk JSON 格式异常
- 通过 `translateApi` 的结果加工层，统一将异常转成可预测返回，避免上层直接暴露原始上游错误

### 4.8 设计重点
- **分层职责清晰**：抓取、抽取、翻译、回填、后处理各司其职
- **可复用入口**：URL 翻译与 HTML 翻译共享核心 pipeline
- **缓存友好**：先缓存后翻译，后处理输出可直接回写缓存
- **容错重试**：对 LLM 漏翻块重试而不是整块重翻，提高稳定性
- **UX 保护**：后处理阶段防止浏览器端原站点脚本干扰

## 五、文章抽取与候选评分

`lib/translate/extraction/` 的设计目标是：
- 不依赖单一抽取规则
- 兼顾通用页面和站点特化页面
- 提供可解释的置信度排序

### 5.1 架构概览

整个 Extraction 子系统由两层组成：
1. **CandidateProvider**：并行生成多个 `ArticleCandidate`
2. **ArticleQualityScorer**：对候选结果统一打分并排序

这意味着即便某个 provider 失效，系统仍可从其它候选中选出最佳正文。

### 5.2 Provider 列表

- `SiteRuleProvider`：
  - 最高优先级
  - 如果当前 URL 命中 `lib/translate/rules/` 中的站点规则，就直接使用站点定义的 `articleRootSelector`
  - 这种方式对 GitHub、Reddit、Hacker News、arXiv 等结构化页面效果最好
- `SelectorProvider`：
  - 使用通用 CSS 选择器查找常见正文容器
  - 支持 `.article`, `.post__content`, `main`, `#content` 等常见模式
  - 适合没有站点规则但结构清晰的页面
- `DensityProvider`：
  - 通过 `contentDetector` 计算节点的文本密度、链接密度、标签分布等信号
  - 把候选节点的质量用数字指标表示
  - 适合没有明显正文容器的复杂页面
- `ReadabilityProvider`：
  - 使用 `@mozilla/readability` 作为兜底
  - 对于严格文章布局或博客页面，Readability 通常能提供稳定结果

### 5.3 Candidate 生成与过滤

每个 provider 的输出是一个 `ArticleCandidate`，包含：
- `provider`：提供者名称
- `root`：候选正文根节点
- `title`：候选标题
- `textLength`：正文文本长度
- `blockCount`：估算块数量
- `providerScore`：provider 内部评分值
- `confidence`：最终置信度
- `metadata`：如 `noiseSet`、`textCache`、`semanticHints`

候选生成后会进行过滤：
- 丢弃空节点或文本过短的结果
- 丢弃包含大量导航/广告的候选
- 对同一根节点的重复候选去重

### 5.4 统一评分机制

`ArticleQualityScorer` 负责为每个候选计算 `confidence`，评分维度包括：
- `textDensity`：文本长度与节点面积比
- `linkDensity`：链接文本占比，越低越优
- `boilerplateRatio`：噪声 / 样板内容比例
- 结构信号：`h1/h2/p` 数量、段落密度
- 语义完整性：标题是否与正文内容匹配

不同 provider 的内部分数会被映射到统一区间，最后得出 `confidence`。

### 5.5 Fallback 与容错

- 系统会选出置信度最高的候选作为正文根
- 如果最高置信度较低，但节点块数足够多，仍会继续使用该候选
- 如果没有候选满足基本阈值，则回退到全文 `body`
- `prepareDocument()` 会在低置信度情况下记录该情况，便于后续调优

### 5.6 结果传递

选定的正文根会作为 `ArticleContext` 传递给 block extractor：
- 包含 `noiseSet`、`knownNoise` 等噪声过滤器
- 共享 `textCache` 与 `semanticHints`
- 避免从页面顶部到正文之间的重复扫描

### 5.7 关键优势

- **可解释性**：每个候选来源与置信度都可追溯
- **健壮性**：多个 provider 互为备份，降低单点失效风险
- **可扩展性**：新增站点规则或 provider 不影响整体调度
- **调优友好**：低置信度、低块数、回退到 `body` 的场景可以单独分析

### 6. Block 提取

`lib/translate/blockExtractor/` 的任务是把选定的文章根节点拆成可翻译的文本块，并打上可视化和重建所需的元数据。

#### 6.1 核心思路

- 从 `ArticleCandidate.root` 开始深度遍历 DOM
- 使用手写递归 walker，避免依赖浏览器特定的 `TreeWalker`、`NodeIterator` 或 `instanceof`
- 所有节点统一以 `nodeType === N` 区分，兼容 `linkedom` 与真实浏览器 DOM
- 通过 `WalkCache` 缓存节点分类、文本有效性、噪声判断，避免重复计算

#### 6.2 节点分类与过滤

- `DIRECT_SET`：如 `p`, `h1`-`h6`, `li`, `dd`, `blockquote`, `figcaption` 等被视为“直接块”。这些节点通常生成独立 `TextBlock`
- `SKIP_SET`：如 `script`, `style`, `noscript`, `iframe`, `svg` 等直接跳过
- `IGNORE_SET`：广告、导航、版权、评论等噪声节点通过规则过滤
- `TEXT_NODE`：仅保留有效文本，去掉纯空白或标点占比过高的内容

#### 6.3 文本块生成

- walker 遍历过程中会把连续文本节点合并为一个块，避免同一段落被过度拆分
- 对于 `DIRECT_SET` 节点，直接生成 `TextBlock`
- 对于普通容器节点，先递归处理子节点，再根据子块结果决定是否提升当前节点作为块
- 通过 `MIN_TEXT_LENGTH` / `MAX_TEXT_LENGTH` 控制块大小
- 如果单个文本块过长，会在语义边界（如标题、换行、句号后）进行拆分

#### 6.4 噪声与上下文

- 通过 `noiseSet` 和 `knownNoise` 过滤重复噪声片段
- `contentHelper` 或 `ArticleContext` 提供的语义提示可以影响 block 级别的过滤策略
- 遇到广告、版权、评论、推荐内容时优先丢弃

#### 6.5 Block 元数据

每个输出的 `TextBlock` 包括：
- `id`：唯一标识，用于翻译结果回填和重试匹配
- `xpath`：定位原 DOM 节点，便于回写时精确匹配
- `tag`：原节点标签名
- `text`：提取的可翻译文本
- `renderHint`：如 `inlineCandidate`，指示后续显示模式
- `context`：周边文本/标题摘要，用于 prompt 优化或语义判断

#### 6.6 兼容与鲁棒性

- 使用 `nodeType` 判断避免因 `linkedom` 与浏览器 DOM 类型不同而出错
- 支持嵌套 `<html>` / `<body>` 等异常结构，适应 GitHub.blog、某些 SPA 页面
- 生成的 `TextBlock` 保留原始结构信息，便于在双语回填时重建页面格式

### 7. Chunk 构建

`lib/translate/chunkBuilder.ts` 负责将 `TextBlock[]` 组织成可发送给 LLM 的 `Chunk[]`，它是 LLM 成本控制和容错的核心。

#### 7.1 目标与约束

- 避免单个请求过大导致上游超时或返回失败
- 保留语义完整性，尽量不在段落、标题或列表项中间拆分
- 保证结果回填时能按 block ID 精确映射
- 为缺失块重试提供最小可重试单位

#### 7.2 Token 估算

- 不是简单按字符计数，而是使用字符类型权重估算 token
- CJK 字符开销较高，Latin 文字开销较低
- 估算公式会考虑中文、英文、标点和空白
- 该代价用于判断当前 chunk 是否接近 `TARGET_TOKENS`

#### 7.3 切分策略

- 逐块累积 text 直到接近 `TARGET_TOKENS`
- 对 `h1`-`h6`、`p`, `li`, `dd`, `blockquote` 等语义边界做优先拆分
- 当一个 block 过长时，会在子句/句号、换行、段落边界处进一步拆分，避免一个 chunk 包含过多独立逻辑
- 对于嵌套列表、表格、引用等结构，会保留节点完整性，尽量避免将其拆成多个独立语义块

#### 7.4 Chunk 元数据

每个 `Chunk` 除了 `blocks` 列表，还包含：
- `estimatedTokens`：本 chunk 的 token 估算值
- `sourceLang` / `targetLang`
- `provider` 或 `serviceHint`：提示调用哪个后端
- `isRetry`：重试 chunk 的标记
- `blockIds`：用于快速 diff 缺失块

#### 7.5 并发策略与服务适配

- `chunkBuilder` 生成的 chunk 与 `translateChunksWithRetry()` 的并发策略配合使用
- 例如：
  - DeepSeek 适合较多 chunk 并发
  - OpenRouter / OpenCode 因限流严格，往往并发 1
  - NVIDIA / Cloudflare / Gemini 采用中等并发
- 这保证了 chunk 数量与上游后端特性一致，避免超量请求导致 429/504

#### 7.6 容错与重试友好设计

- chunk 的最小粒度对应 block ID，使重试时只重新发送缺失块
- chunk 之外还保留整体 block 列表，便于出现漏翻时快速恢复
- 若修改 chunk 大小仍无法满足上游，后续策略可继续动态调小 `TARGET_TOKENS`

### 8. 翻译服务适配

`lib/translate/service/` 提供统一 `TranslationService` 接口并封装不同后端：
- `DeepSeek`
- `OpenRouter`
- `NVIDIA`
- `Cloudflare AI`
- `Gemini`
- `OpenCode`
- `MiMo`

共用能力：
- 上游请求体构建与 prompt 选择
- LLM 输出 JSON 修复
- `stripThinkingTags` / `stripMarkdownCodeBlock`
- `cleanJsonString` 处理格式异常

### 9. 翻译显示

`lib/translate/translationDisplay.ts` 负责把翻译结果准确、安全地回填到原始 HTML 中，同时保持页面结构与交互。此模块既是用户可见的展示层，也是最终翻译结果与原文对齐的关键。

#### 9.1 设计目标

- 保留原文结构，避免直接覆盖原始 DOM 节点
- 将译文与原文并列显示，方便阅读与核对
- 支持短句 inline 显示和长句块级显示两种模式
- 避免破坏链接、按钮、样式和页面交互
- 支持后续复原与调试

#### 9.2 回填方式

- 对于大多数块级翻译，采用 `.fanyi-original` / `.fanyi-translation` 双列显示
  - 原文内容被包装到 `.fanyi-original` 内，保持原格式
  - 译文插入到 `.fanyi-translation` 内，与原文并列但视觉区分明显
- 对于短文本、短列表项、按钮文本等，可能启用 inline 模式
  - `renderHint.inlineCandidate` 由 block 提取器标记
  - inline 模式下译文会直接插入到原文元素内部，而不产生额外大的块容器

#### 9.3 显示策略

- `inline` 模式条件：
  - 文本长度较短
  - 译文词数不多
  - 当前节点适合在同一行内显示
- 否则使用块级模式，避免长译文挤压页面
- 对于标题、段落、引用、列表项等分别调整插入位置，保证逻辑关系清晰

#### 9.4 DOM 结构保护

- 译文回填时优先保留原节点的 `class`、`id`、`href`、`data-*` 属性
- 不直接替换原节点内容，避免破坏链接、表单、脚本绑定
- 插入译文容器时保留原节点父层次，尽量在同一层级追加，而非提升/降级结构
- 通过 `xpath` 与 `TextBlock.id` 精确定位回写位置，避免错位

#### 9.5 样式与视觉层

- 统一注入一组双语页面样式：
  - `.fanyi-translation`：左侧边框、背景弱化、内边距
  - `.fanyi-inline-translation`：较小字号、低透明度、靠近原文显示
  - `[data-fanyi-low-priority="true"]`：弱化显示，hover 时恢复强度
  - `[data-fanyi-remove="true"]`：用于隐藏 Cookie Banner、Overlay 等不必要元素
- 添加全局 `base` 标签，保证相对链接在翻译页面中仍能正常解析
- 样式注入优先级足够高，避免被页面自身样式轻易覆盖

#### 9.6 可恢复与调试

- 由于译文与原文分离包装，逻辑上支持后续恢复原始页面
- `.fanyi-original` 与 `.fanyi-translation` 的包裹关系使得回退或调试页面更简单
- 该结构也便于浏览器扩展端或后续增强功能读取、切换显示模式

#### 9.7 兼容性考量

- 在结果回填时，避免对特殊元素（如 `code`, `pre`, `table`, `a`, `img`）做破坏性调整
- 对 `li`/`dd` 等列表内容保留原有列表结构，译文在同一列表项内显示
- 对嵌套语义结构（如 `blockquote` 内的段落）保持层级一致，防止译文插入导致 DOM 扁平化

### 10. 站点规则

`lib/translate/rules/` 定义站点特化规则：
- GitHub
- Reddit
- Hacker News
- Fortune
- arXiv

每个规则可指定：
- `articleRootSelector`
- `skipSelectors`
- `skipTextPatterns`
- `promptInstructions`

### 11. 模型解析与后端路由

`lib/modelResolver.ts` 将 model 名与 backend 绑定：
- 以 model 名判断 `deepseek`, `nvidia`, `openrouter`, `cloudflare`
- 支持 `_backend` 字段强制指定后端
- 保证 LLM 代理与翻译 pipeline 使用统一路由逻辑

## 七、缓存与持久化

### 1. D1 缓存（翻译结果）

- 存储翻译页面 HTML、URL、语言、标题
- 使用 `ON CONFLICT(url, source_lang, target_lang)` UPSERT
- `isHealthyCachedHtml()` 判断缓存是否完整

### 2. 翻译 chunk 缓存

- `CacheManager` 抽象在 `lib/translate/cacheManager.ts`
- 支持内存 Map 存储和持久层 KV
- 7 天 TTL
- 仅缓存块级翻译结果，减少重复调用

### 3. 缓存健康策略

缓存健康检查要求：
- HTML 包含 `<html>` 标签
- 存在有效外链样式
- 或者存在非 OneTrust / 非 fanyi 的内联样式

若检测到损坏缓存，系统会触发重新翻译。

## 八、安全与守卫

### 1. API 鉴权

`lib/auth.ts` 提供 Bearer token 中间件：
- 仅对敏感 API 启用
- `AUTH_KEY` 通过环境变量注入

### 2. SPA / 浏览器防御

- `stripDangerousScripts()` 移除危险 navigation / hydration 脚本
- `devirtualizeLayout()` 修正服务端渲染后残留的虚拟定位
- `injectRedirectGuard()` 在 HTML 注入客户端 Fetch/Navigation 拦截器

### 3. 输入校验

- `normalizeUrl()` 和 `assertPublicUrl()` 保护 URL 输入
- 通过 `cacheKeyUrl()` 生成一致缓存键

## 九、测试体系

- `npm test`：Vitest 全量测试
- `npm run build:lib`：编译 `lib/`
- `npm run typecheck`：TypeScript 类型检查

测试覆盖模块包括：
- 路由与 Hono 应用行为
- 内容抽取与 block 提取
- 翻译缓存与 chunk 构建
- 翻译服务适配
- 站点规则与 HTML 后处理

## 十、设计亮点

- **边缘优先**：Cloudflare Workers + Hono，避免 Node-only 依赖
- **多策略抽取**：SiteRule / Selector / Density / Readability 组合
- **服务抽象**：统一 TranslationService 接口，便于新增模型后端
- **双语回填**：原文结构保留，译文逐块插入
- **缓存健康检查**：防止损坏 HTML 缓存导致页面样式丢失

## 十一、建议改进方向

- 统一引入 `logger`，替换散落的 `console.*`
- 统一封装 LLM 上游调用的 timeout/retry/限流策略
- 拆分长任务到后台队列，降低边缘执行超时风险
- 增加 ESLint/Prettier 和 CI lint 步骤
- 强化类型安全，进一步减少 `any` 使用
