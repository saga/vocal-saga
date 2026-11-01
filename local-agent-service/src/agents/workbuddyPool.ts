import { REQUEST_TIMEOUT_MS, WORKBUDDY_POOL_MAX_USES, WORKBUDDY_POOL_SIZE } from '../config.ts';
import { buildWorkbuddyOptions, type WorkbuddyAgent } from './workbuddy.ts';
import { parseTurnUsage, type TurnUsage } from './usage.ts';
import { logInfo, logWarn, summarizeError } from '../log.ts';

// SDK 会话的最小使用面：正式用 Session，测试用假对象。
export interface PooledSession {
  /** 向会话发送一轮用户消息（prompt）。 */
  send(message: string): Promise<void>;
  /** 流式读取会话输出事件（assistant/result 等）。 */
  stream(): AsyncGenerator<any, void>;
  /** 请求中断当前运行；不保证底层进程立即退出。 */
  interrupt(): Promise<void>;
  /** 关闭会话并释放底层 CLI 进程资源。 */
  close(): void;
  /** 热切换模型（若 SDK 支持）；不支持时调用方会重建会话。 */
  setModel?(model: string): Promise<void>;
  /** 只 boot CLI 进程，不调模型（SDK Session.connect 的预热语义）。 */
  connect?(): Promise<void>;
}

/** 会话工厂：根据选项创建并返回一个 PooledSession（可同步或异步）。 */
export type SessionFactory = (options: Record<string, any>) => PooledSession | Promise<PooledSession>;

interface Slot {
  /** 当前槽位持有的 SDK 会话；null 表示未创建或已丢弃。 */
  session: PooledSession | null;
  /** 当前会话实际使用的模型标识；空字符串表示未设置/运行时默认。 */
  model: string;
  /** Complete scope key; document batches add run, role, prompt revision, lane and batch index to isolate history. */
  scopeKey: string;
  /** 当前会话对应的 schema 序列化键；空字符串表示纯文本模式。 */
  schemaKey: string;
  /** 已复用的轮数；达到 maxUses 后重建会话。 */
  uses: number;
  /** 是否正在被某个请求独占。 */
  busy: boolean;
  /** 最近一次使用/释放的时间戳（毫秒），用于 LRU 驱逐。 */
  lastUsedAt: number;
}

/**
 * 为日志生成 scope 的简短描述。
 *
 * 职责：scopeKey 可能是 JSON 数组（含整份 schema），直接打印会淹没一行；
 * 只取第一个元素（真正的作用域名）并截断到 80 字符。shared-slot 会话返回固定标签。
 *
 * 参数：
 * - `scopeKey`：原始 scope 键。
 *
 * 返回值：string，适合单行日志的简短描述。
 * 边界：空字符串返回 `'<空>'`；非 JSON 数组按原文截断；不修改输入。
 *
 * 日志里描述 scope：scopeKey 可能是 JSON 数组（含整份 schema），直接打印会淹没一行。
 * 只取第一个元素（真正的作用域名）并截断。
 */
function describeScope(scopeKey: string): string {
  if (!scopeKey) return '<空>';
  if (scopeKey.startsWith('shared-slot:')) return '通用槽位';
  if (scopeKey.startsWith('[')) {
    try {
      const parsed = JSON.parse(scopeKey);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0].slice(0, 80);
    } catch { /* 非 JSON 就按原文截断 */ }
  }
  return scopeKey.slice(0, 80);
}

/**
 * 跑完一轮会话并聚合文本、结构化输出与 token 计量。
 *
 * 职责：发送 `combinedPrompt`，遍历 `session.stream()` 聚合 assistant 文本，
 * 在收到 `result` 事件时提取 structured_output 与 usage 并结束；遇到错误子类型或
 * 执行失败时抛错。
 *
 * 参数：
 * - `session`：已就绪的 PooledSession。
 * - `combinedPrompt`：本轮发送的完整 Prompt。
 *
 * 返回值：Promise<{ text, structuredOutput, usage }>。
 * 边界：若 stream() 永不结束，本函数不会返回，需外层 Promise.race 接管；
 *       不负责超时或会话关闭。
 *
 * 单独抽出来是为了让超时能通过 Promise.race 接管：如果 CLI 卡住或事件流已断，
 * stream() 不会自己结束，外层的超时只能靠竞速，不能靠 interrupt() 的副作用。
 */
async function runSessionTurn(
  session: PooledSession,
  combinedPrompt: string,
): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null }> {
  let text = '';
  let structuredOutput: unknown;
  let usage: TurnUsage | null = null;
  await session.send(combinedPrompt);
  for await (const message of session.stream()) {
    const raw: any = message && typeof message === 'object' ? message : {};
    if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
      for (const part of raw.message.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          text += (text ? '\n' : '') + part.text;
        }
      }
    }
    if (raw.type === 'result') {
      if (raw.is_error && Array.isArray(raw.errors) && raw.errors.length > 0) {
        throw new Error('Workbuddy 执行失败：' + String(raw.errors[0]));
      }
      if (raw.subtype && raw.subtype !== 'success') {
        throw new Error('Workbuddy 执行失败：' + String(raw.subtype));
      }
      if (raw.structured_output !== undefined) structuredOutput = raw.structured_output;
      // 每轮计费口径：result.usage 的 token 计数（CodeBuddy 订阅下 total_cost_usd 恒为 0）。
      usage = parseTurnUsage(raw);
      break;
    }
  }
  return { text, structuredOutput, usage };
}

// 有界 Workbuddy Session 池。普通网页文本使用可复用的 shared-slot 会话来摊薄启动开销；
// project Agent 为隔离每批对话历史使用独立 scope，不同批次可能重建 Session 并产生初始化成本。
//
// 为什么不用 daemon（--serve）：daemon 是交互式 Agent 服务，走 Gateway Protocol
// 的 /api/v1/runs（有状态 Agent run），给按 chunk 计量的无头翻译用是重协议+多一层
// HTTP。池复用的是 SDK Session，即文档里 --input-format stream-json 长驻进程的
// SDK 等价物：stdin 常开、不重启进程，send/stream 即多轮。
//
// 约束：
// - 一个会话同时只能跑一轮（串行），池大小对齐扩展侧扇出（默认 4）。
// - 每 send 一次历史就变长（输入 token 与耗时 creep），用满 maxUses 轮即重建。
// - 书籍任务的调用方负责构造稳定 scopeKey；project Agent 把 run/role/prompt revision/lane/batch 编入 key，因此只有同一批重试会复用上下文。
// - 同一个 scopeKey 同时只允许一个请求运行，避免并发请求把轮次交错写入同一对话。
// - 达到 maxUses 后销毁会话；新会话首轮会重新注入稳定 prompt，动态书籍记忆由调用方重传。
export class WorkbuddySessionPool {
  private slots: Slot[];
  private waiters: Array<() => void> = [];
  private closed = false;

  /**
   * 断言池未关闭。
   *
   * 职责：在所有可能影响会话生命周期的操作前检查 `closed` 标志，
   * 防止关闭后继续创建/复用 CLI 进程或唤醒排队请求。
   *
   * 参数：无。
   * 返回值：无；池已关闭时抛出 `Error('Workbuddy session pool is closed')`。
   * 边界：仅检查内存标志，不等待或清理；调用方需自行处理抛出的异常。
   */
  private assertOpen(): void {
    if (this.closed) throw new Error('Workbuddy session pool is closed');
  }

  /**
   * 构造有界会话池。
   *
   * 职责：按 `size` 预分配固定数量的 Slot（不提前启动 CLI 进程），
   * 并记录最大复用轮数 `maxUses` 与会话工厂 `factory`。
   *
   * 参数：
   * - `size`：池容量，即同时在途的最大会话数，对齐扩展侧扇出（默认 6）。
   * - `maxUses`：单个会话最多复用的轮数，达到后销毁并懒重建，避免历史上下文无限增长。
   * - `factory`：创建 SDK Session 的工厂函数，返回 `PooledSession` 或其 Promise。
   *
   * 返回值：无（构造函数）。
   * 边界：不启动任何进程；空闲槽位的 CLI 进程需由 `prewarm` 或首单懒创建。
   *       `size <= 0` 时池为空，所有 `acquire` 将永久排队，调用方应保证合法容量。
   */
  constructor(
    private readonly size: number,
    private readonly maxUses: number,
    private readonly factory: SessionFactory,
  ) {
    // 预分配固定数量的槽位，避免运行时动态扩容导致无界进程增长。
    this.slots = Array.from({ length: size }, () => ({
      session: null, model: '', scopeKey: '', schemaKey: '', uses: 0, busy: false, lastUsedAt: 0,
    }));
  }

  // 取一个空闲槽位并保证会话就绪；全忙时排队等（不另起进程，避免无界膨胀）。
  /**
   * 获取与 provider/model/session scope/schema 匹配的空闲会话。
   *
   * 职责：为普通文本请求走共享槽位；为带 scope/schema 的请求复用或创建独立会话。
   * 池满时通过 waiter 排队而非无限创建进程；同一 scopeKey 正在执行中的会话
   * 不可被第二个请求并发复用，避免轮次交错写入同一对话历史。
   *
   * 参数：
   * - `agent`：Agent 配置（provider/model）。
   * - `scopeKey`：会话作用域键，默认 `'shared-text-translation'`；文档批次应传入包含
   *   run/role/prompt revision/lane/batch 的稳定键。
   * - `schema`：可选 JSON Schema，用于结构化输出；影响 schemaKey 与会话重建。
   *
   * 返回值：Promise<number>，分配到的槽位索引。
   * 边界：池已关闭时抛错；会话创建失败会释放槽位并向上抛出；
   *       达到 `maxUses` 或模型/schema 不匹配时重建会话。
   */
  async acquire(
    agent: WorkbuddyAgent,
    scopeKey = 'shared-text-translation',
    schema?: Record<string, unknown>,
  ): Promise<number> {
    this.assertOpen();
    // Shared text requests reuse a bounded slot; tasks needing explicit thinking/effort use query() instead.
    if (scopeKey === 'shared-text-translation' && !schema) return this.acquireSharedTextSlot(agent);

    const schemaKey = schema ? JSON.stringify(schema) : '';
    const requestedKey = JSON.stringify([scopeKey, agent.model || '<runtime-default>', schemaKey]);
    for (;;) {
      this.assertOpen();
      // A scoped conversation has exactly one slot. Do not create a second copy while its
      // first copy is busy: parallel sends would split history and make turn order nondeterministic.
      const existingIndex = this.slots.findIndex((slot) => slot.scopeKey === requestedKey);
      if (existingIndex >= 0) {
        const slot = this.slots[existingIndex];
        if (slot.busy) {
          await this.waitForSlot();
          continue;
        }
        slot.busy = true;
        try {
          await this.ensureSession(existingIndex, agent, requestedKey, schema);
          this.assertOpen();
        } catch (error) {
          slot.busy = false;
          this.wakeNext();
          throw error;
        }
        slot.lastUsedAt = Date.now();
        return existingIndex;
      }

      let index = this.slots.findIndex((slot) => !slot.busy && !slot.session);
      if (index < 0) {
        // Bound memory/CLI children: evict the least-recently-used idle session only.
        const idle = this.slots
          .map((slot, slotIndex) => ({ slot, slotIndex }))
          .filter(({ slot }) => !slot.busy)
          .sort((a, b) => a.slot.lastUsedAt - b.slot.lastUsedAt)[0];
        if (idle) index = idle.slotIndex;
      }
      if (index < 0) {
        await this.waitForSlot();
        continue;
      }

      const slot = this.slots[index];
      slot.busy = true;
      if (slot.session) this.dropSession(index, '槽位复用');
      slot.scopeKey = requestedKey;
      slot.schemaKey = schemaKey;
      try {
        await this.ensureSession(index, agent, requestedKey, schema);
        this.assertOpen();
      } catch (error) {
        slot.busy = false;
        this.wakeNext();
        throw error;
      }
      slot.lastUsedAt = Date.now();
      return index;
    }
  }

  /**
   * 获取可复用的共享文本槽位（普通网页/短文本翻译路径）。
   *
   * 职责：优先复用空闲且 schema 为空的 `shared-slot:` 会话；
   * 无可用复用会话时在空闲/可驱逐槽位上创建新会话；池满时排队等待。
   * 共享槽位按模型资格复用，模型切换时重建，避免历史上下文串线。
   *
   * 参数：
   * - `agent`：本次请求的 Agent 配置，主要使用 `agent.model`。
   *
   * 返回值：Promise<number>，分配到的槽位索引。
   * 边界：同一槽位同时只允许一个请求运行；池关闭时抛出错误；
   *       会话创建失败会释放槽位并唤醒下一个等待者，异常向上抛出。
   */
  private async acquireSharedTextSlot(agent: WorkbuddyAgent): Promise<number> {
    for (;;) {
      this.assertOpen();
      const reusable = this.slots.findIndex((slot) =>
        !slot.busy && !!slot.session && slot.schemaKey === '' && slot.scopeKey.startsWith('shared-slot:'),
      );
      if (reusable >= 0) {
        const slot = this.slots[reusable];
        slot.busy = true;
        try {
          await this.ensureSession(reusable, agent, slot.scopeKey || ('shared-slot:' + reusable));
          this.assertOpen();
        } catch (error) {
          slot.busy = false;
          this.wakeNext();
          throw error;
        }
        slot.lastUsedAt = Date.now();
        return reusable;
      }

      let index = this.slots.findIndex((slot) => !slot.busy && !slot.session);
      if (index < 0) {
        const idle = this.slots
          .map((slot, slotIndex) => ({ slot, slotIndex }))
          .filter(({ slot }) => !slot.busy)
          .sort((a, b) => a.slot.lastUsedAt - b.slot.lastUsedAt)[0];
        if (idle) index = idle.slotIndex;
      }
      if (index < 0) {
        await this.waitForSlot();
        continue;
      }

      const slot = this.slots[index];
      slot.busy = true;
      if (slot.session) this.dropSession(index, '槽位复用');
      const slotKey = 'shared-slot:' + index + ':' + (agent.model || '<runtime-default>');
      slot.scopeKey = slotKey;
      try {
        await this.ensureSession(index, agent, slotKey);
        this.assertOpen();
      } catch (error) {
        slot.busy = false;
        this.wakeNext();
        throw error;
      }
      slot.lastUsedAt = Date.now();
      return index;
    }
  }

  /**
   * 判断槽位中的会话是否为尚未使用过的新会话。
   *
   * 职责：当 `uses === 0` 时，下一轮需要重新注入稳定系统指令（prompt），
   * 因为会话尚未承载过任何对话轮次。
   *
   * 参数：
   * - `index`：槽位索引。
   *
   * 返回值：boolean；索引越界或槽位不存在时返回 `false`（uses 为 undefined）。
   * 边界：仅读取内存计数，不触发会话创建或状态变更。
   */
  /** True when the next turn must seed a fresh session with stable system instructions. */
  isFresh(index: number): boolean {
    return this.slots[index]?.uses === 0;
  }

  /**
   * 释放槽位的独占权，允许下一个排队请求进入。
   *
   * 职责：将 `busy` 置为 false、更新 `lastUsedAt`，并唤醒一个等待中的 `acquire`。
   * `runPrompt` 不会自动释放独占权，调用方必须在 `runPrompt` 完成
   * （无论成功或失败）后显式调用 `release(index)`，否则槽位将一直被占用。
   *
   * 参数：
   * - `index`：槽位索引；越界时静默返回。
   *
   * 返回值：无。
   * 边界：不关闭会话、不重置 `uses`；会话复用状态保持不变。
   */
  release(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    // 释放独占权，允许下一个排队请求进入该槽位。
    slot.busy = false;
    slot.lastUsedAt = Date.now();
    this.wakeNext();
  }

  // 在指定槽位跑一轮：发 prompt、收文本与 structured_output，超时则中断。
  // 成功用满 maxUses 轮即重建；失败/超时直接丢弃会话（状态不可信），下次懒重建。
  /**
   * 在独占槽位中执行一次 Prompt。
   * 调用方负责在完成后 release(index) 释放独占权；本方法不自动 release。
   *
   * 职责：发送 `combinedPrompt`，聚合文本/结构化输出/token 计量；超时通过
   * `Promise.race` 接管并丢弃会话；空响应或失败时丢弃会话以便下次重建；
   * 成功用满 `maxUses` 轮后销毁会话。
   *
   * 参数：
   * - `index`：已 acquire 的槽位索引。
   * - `combinedPrompt`：本轮发送的完整 Prompt（含稳定系统指令与动态上下文）。
   * - `requestId`：请求/批次 ID，用于日志关联。
   * - `timeoutMs`：超时阈值，默认 `REQUEST_TIMEOUT_MS`。
   *
   * 返回值：Promise<{ text, structuredOutput, usage }>。
   * 边界：调用前槽位必须已 acquire 且持有会话；超时/失败会抛错并丢弃会话；
   *       空响应（text 与 structuredOutput 均缺失）视为失败。
   *       注意：slot 释放由调用方负责（acquire/release 配对），本方法不自动 release。
   */
  async runPrompt(
    index: number,
    combinedPrompt: string,
    requestId: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ text: string; structuredOutput: unknown; usage: TurnUsage | null }> {
    const slot = this.slots[index];
    const session = slot.session;
    if (!session) throw new Error('会话槽位没有可用会话');
    let timedOut = false;
    // interrupt() 只是请求 CLI 停下；CLI 卡住或事件流已断时它不会让 stream() 结束，
    // 只靠它做超时会让调用永久悬着：既不返回也不报错，整个 Run 就停在「运行中」。
    // 这里用 race 让超时成为权威判定，并在超时后丢弃会话，下一轮换新 CLI 进程。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // 卡死现场必须留痕：哪一轮、哪个 scope、超时阈值多少。
        logWarn('pool', '调用超时 · slot=' + index + ' · ' + (timeoutMs / 1000).toFixed(0) + 's · request=' +
          requestId.slice(0, 40) + ' · scope=' + describeScope(slot.scopeKey));
        try { Promise.resolve(session.interrupt()).catch(() => {}); } catch { /* timeout is handled below */ }
        reject(new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）'));
      }, timeoutMs);
      timer.unref?.();
    });
    let turn: { text: string; structuredOutput: unknown; usage: TurnUsage | null };
    try {
      turn = await Promise.race([runSessionTurn(session, combinedPrompt), timeoutPromise]);
    } catch (error) {
      this.dropSession(index, timedOut ? '调用超时' : '调用失败', error);
      if (timedOut) throw new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）');
      throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
    }
    const { text, structuredOutput, usage } = turn;
    if (timedOut) {
      this.dropSession(index, '调用超时');
      throw new Error('Workbuddy 调用超时（' + (timeoutMs / 1000).toFixed(0) + 's 内未返回）');
    }
    // 原生 --json-schema 成功时，SDK 可能只返回 StructuredOutput tool_use，
    // 最终数据放在 result.structured_output，而没有任何 assistant text。
    // 因此只有 text 和 structured_output 都缺失才是空响应；不能误杀健康的 JSON Session。
    // schemaKey 在 acquire 时记录本槽位的模式，用于让日志区分纯文本与结构化调用。
    const structuredMode = slot.schemaKey.length > 0;
    if (!text.trim() && structuredOutput === undefined) {
      this.dropSession(index, '空响应');
      // 空响应是最难复盘的失败：留下模式、请求号与 scope，才能判断是模型没吐内容
      // 还是会话被上游掐断。
      logWarn('pool', '空响应 · slot=' + index + ' · mode=' + (structuredMode ? 'structured' : 'text') +
        ' · request=' + requestId.slice(0, 40) + ' · scope=' + describeScope(slot.scopeKey) +
        ' · 已用 ' + slot.uses + ' 轮');
      throw new Error(
        'Workbuddy 返回了空内容（mode=' + (structuredMode ? 'structured' : 'text') +
        '），会话已丢弃重建；请重试该批次',
      );
    }
    // The document workflow logs role, batch, latency and output counts at the project boundary.
    // Keep internal Session reuse counters out of the default terminal output.
    slot.uses += 1;
    if (slot.uses >= this.maxUses) this.dropSession(index, '用满 ' + this.maxUses + ' 轮');
    return { text: text.trim(), structuredOutput, usage };
  }

  // 关停/测试用：关闭全部 CLI 子进程并清空。
  /**
   * 关闭池内全部活动/空闲 SDK 会话并清空可复用状态。
   *
   * 职责：标记池为 `closed`，丢弃并关闭每个槽位的会话，唤醒所有排队的
   * `acquire`（使其抛出“池已关闭”而非继续循环）。
   *
   * 参数：无。
   * 返回值：无。
   * 边界：幂等——重复调用无额外效果；关闭后池实例不可再用，
   *       旧 Slot 中的 `session` 引用必须丢弃。
   */
  closeAll(): void {
    if (this.closed) return;
    // Closing is terminal for this pool instance. Wake queued acquire() calls so they
    // reject instead of looping back and creating new CLI sessions after shutdown.
    this.closed = true;
    for (let i = 0; i < this.slots.length; i++) this.dropSession(i, '关闭池');
    this.waiters.splice(0).forEach((wake) => { wake(); });
  }

  /**
   * 后台预热空闲槽位的 CLI 进程。
   *
   * 职责：对所有空闲且无会话的槽位调用 `ensureSession` + `connect()`，
   * 提前拉起 CLI 进程以减少首单冷启动延迟；单个槽位失败只丢弃该会话，
   * 不影响池的可用性（首单仍走懒创建）。
   *
   * 参数：
   * - `agent`：预热使用的 Agent 配置（模型等）。
   *
   * 返回值：Promise<void>；所有预热任务完成（或各自失败处理）后 resolve。
   * 边界：默认关闭预热（`LOCAL_AGENT_PREWARM`）；池已关闭时 `ensureSession` 抛错；
   *       预热只 boot 进程，不调用模型、不消耗 token。
   */
  // 服务启动后后台调用一次：把空闲槽位的 CLI 进程提前拉起。
  // connect 只 boot 进程、不发 prompt（不调模型、不花 token）；initialize 留给首单。
  // 单个失败只丢该槽——首单仍走懒创建，不影响可用性。
  async prewarm(agent: WorkbuddyAgent): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.busy || slot.session) continue;
      slot.busy = true;
      jobs.push((async () => {
        try {
          const prewarmKey = 'shared-slot:' + i + ':' + (agent.model || '<runtime-default>');
          await this.ensureSession(i, agent, prewarmKey);
          await slot.session?.connect?.();
        } catch (error) {
          logWarn('pool', '预热失败 · slot=' + i + ' · ' + summarizeError(error));
          this.dropSession(i, '预热失败');
        } finally {
          slot.busy = false;
          this.wakeNext();
        }
      })());
    }
    await Promise.all(jobs);
  }

  /**
   * 保证槽位拥有可用会话，并在需要时创建或重建。
   *
   * 职责：
   * - 槽位无会话时创建新会话；
   * - `scopeKey` 不匹配时丢弃旧会话并重建（scope 切换）；
   * - 模型不一致时优先热切换（`setModel`），SDK 不支持则重建；
   * - 记录模型、schema、uses 等槽位元数据。
   *
   * 参数：
   * - `index`：槽位索引。
   * - `agent`：本次请求的 Agent 配置。
   * - `requestedKey`：完整的 scope 键（含 scope/模型/schema）。
   * - `schema`：可选的 JSON Schema，用于结构化输出模式。
   *
   * 返回值：Promise<void>。
   * 边界：池已关闭时抛出；会话创建失败会记录详细入参并向上抛出；
   *       创建过程中池关闭会关闭刚创建的会话并抛出。
   */
  // 保证槽位有可用会话；模型与槽位不一致时热切换（控制请求，无需重启进程）。
  private async ensureSession(
    index: number,
    agent: WorkbuddyAgent,
    requestedKey: string,
    schema?: Record<string, unknown>,
  ): Promise<void> {
    this.assertOpen();
    const slot = this.slots[index];
    const create = async (reason: string) => {
      const startedAt = Date.now();
      let created: PooledSession;
      try {
        created = await this.factory(buildTextSessionOptions(agent, schema));
      } catch (error) {
        // SDK 抛出的 boot 失败通常只有一句不透明的 "boot failed"，拿不到 CLI 的 stderr。
        // 既然原因不可得，就把这次 boot 的全部入参记下来：至少能判断是哪个模型、
        // 哪种 schema 模式、在什么 cwd 下起的会话失败，从而可复现。
        const options = buildTextSessionOptions(agent, schema);
        logWarn('pool', '新建会话失败 · slot=' + index + ' · ' + reason +
          ' · ' + summarizeError(error) +
          ' · provider=' + agent.provider +
          ' · model=' + (agent.model || '<运行时默认>') +
          ' · mode=' + (schema ? 'structured' : 'text') +
          ' · cwd=' + String(options.cwd || '<默认>') +
          ' · after=' + (Date.now() - startedAt) + 'ms');
        throw error;
      }
      if (this.closed) {
        try { created.close(); } catch { /* shutdown already invalidated this slot */ }
        throw new Error('Workbuddy session pool is closed');
      }
      slot.session = created;
      logInfo('pool', '新建会话 · slot=' + index + ' · ' + reason + ' · scope=' + describeScope(requestedKey) +
        ' · model=' + (agent.model || '<运行时默认>') + ' · ' + (Date.now() - startedAt) + 'ms');
      slot.model = agent.model || '';
      // Shared text slots have a model-qualified key; keep it aligned after a hot switch
      // or a rebuild, otherwise diagnostics and subsequent scope checks retain stale model data.
      slot.scopeKey = requestedKey.startsWith('shared-slot:')
        ? 'shared-slot:' + index + ':' + (agent.model || '<runtime-default>')
        : requestedKey;
      slot.schemaKey = schema ? JSON.stringify(schema) : '';
      slot.uses = 0;
    };
    if (!slot.session) {
      await create('槽位为空');
      return;
    }
    if (slot.scopeKey !== requestedKey) {
      this.dropSession(index, 'scope 切换');
      await create('重建');
      return;
    }
    if ((agent.model || '') !== slot.model) {
      if (!slot.session.setModel) {
        // Do not update the cached model label when this SDK Session cannot actually switch models.
        // Recreate it instead, otherwise telemetry claims one model while the CLI still uses another.
        this.dropSession(index, 'Session API 不支持 setModel，重建以应用模型');
        await create('切换模型（Session 不支持 setModel）');
        return;
      }
      try {
        await slot.session.setModel(agent.model);
      } catch (error) {
        this.dropSession(index, 'setModel 失败');
        throw error;
      }
      this.assertOpen();
      logInfo('pool', '会话换模型 · slot=' + index + ' · ' + (slot.model || '<运行时默认>') + ' → ' + (agent.model || '<运行时默认>'));
      slot.model = agent.model || '';
      if (slot.scopeKey.startsWith('shared-slot:')) {
        slot.scopeKey = 'shared-slot:' + index + ':' + (agent.model || '<runtime-default>');
      }
    }
  }

  /**
   * 丢弃并关闭槽位会话。
   *
   * 职责：关闭底层 SDK 会话，清空槽位的会话/计数/scope/schema/model 等状态，
   * 便于下次懒重建；根据是否传入 `error` 选择 warn/info 日志级别。
   *
   * 参数：
   * - `index`：槽位索引；越界时 `slots[index]` 为 undefined 会抛错（调用方应保证合法）。
   * - `reason`：丢弃原因，用于日志与排查。
   * - `error`：可选的失败原因；传入时按 warn 级别记录。
   *
   * 返回值：无。
   * 边界：关闭失败仅记录日志，不阻断状态清空；槽位可能残留僵尸进程风险已留痕。
   *       传入 error 时会把它写进日志：会话生命周期是排查「调用卡住/空响应」的关键线索，
   *       只说「调用失败」而不说失败原因，等于没记。
   */
  private dropSession(index: number, reason = '关闭', error?: unknown): void {
    const slot = this.slots[index];
    if (slot.session) {
      const detail = error === undefined ? '' : ' · cause=' + summarizeError(error);
      const line = '丢弃会话 · slot=' + index + ' · ' + reason +
        (slot.scopeKey ? ' · scope=' + describeScope(slot.scopeKey) : '') +
        (slot.uses ? ' · 已用 ' + slot.uses + ' 轮' : '') + detail;
      // 失败类丢弃是故障信号，用 warn；正常轮换（用满轮数、关闭池）保持 info。
      if (error !== undefined) logWarn('pool', line);
      else logInfo('pool', line);
      try { slot.session.close(); } catch (closeError) {
        // 关闭失败说明 CLI 子进程可能残留，必须留痕，否则会积累僵尸进程。
        logWarn('pool', '关闭会话失败 · slot=' + index + ' · ' + summarizeError(closeError));
      }
      slot.session = null;
    }
    slot.uses = 0;
    slot.scopeKey = '';
    slot.schemaKey = '';
    slot.model = '';
    slot.lastUsedAt = Date.now();
  }

  /**
   * 唤醒一个等待中的 `acquire` 请求。
   *
   * 职责：从 `waiters` 队列取出最早的等待者并调用其 resolve，
   * 使其重新进入 acquire 循环尝试获取槽位。
   *
   * 参数：无。
   * 返回值：无；队列为空时无操作。
   * 边界：仅唤醒一个等待者，避免惊群；不保证被唤醒者一定能成功获取槽位。
   */
  private wakeNext(): void {
    const wake = this.waiters.shift();
    if (wake) wake();
  }

  /**
   * 等待一个空闲槽位。
   *
   * 职责：将当前请求挂入 `waiters` 队列并 await，直到被 `wakeNext` 唤醒；
   * 等待超过 2s 时记录排队日志。
   *
   * 参数：无。
   * 返回值：Promise<void>。
   * 边界：池关闭时 `closeAll` 会唤醒所有等待者，其后续 `assertOpen` 抛错；
   *       不保证唤醒后一定能获取到槽位，调用方需循环重试。
   *
   * 池满时请求会停在这里，日志里必须能看出「不是模型慢，而是在排队」；
   * 只有真正等久了才输出，避免正常排队刷屏。
   */
  private async waitForSlot(): Promise<void> {
    const startedAt = Date.now();
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    const waited = Date.now() - startedAt;
    if (waited >= 2000) logInfo('pool', '排队等待槽位 · ' + (waited / 1000).toFixed(1) + 's');
  }
}

/**
 * 构建复用会话的 SDK 选项。
 *
 * 职责：基于 `buildWorkbuddyOptions` 生成单次 query 的选项，
 * 但移除 `maxTurns`（按进程生命周期计的预算，不适合复用会话）；
 * 单轮护栏由 `tools: []`（无工具可循环）与超时共同承担。
 *
 * 参数：
 * - `agent`：Agent 配置（provider/model 等）。
 * - `schema`：可选 JSON Schema，用于结构化输出模式。
 *
 * 返回值：Record<string, any>，可直接传给 SessionFactory 的选项对象。
 * 边界：不校验 agent/schema 的合法性；`maxTurns` 被解构丢弃，其余字段原样透传。
 */
// 复用会话的 options：与单次 query 一致，但去掉 maxTurns。
// --max-turns 是按进程（会话生命周期）计的预算，不适合复用会话；
// 单轮护栏由 tools:[]（无工具可循环）+ 超时承担。
export function buildTextSessionOptions(agent: WorkbuddyAgent, schema?: Record<string, unknown>): Record<string, any> {
  const { maxTurns: _unused, ...rest } = buildWorkbuddyOptions(agent, schema);
  return rest;
}

/**
 * 获取文本翻译会话池单例（懒创建）。
 *
 * 职责：首次调用时创建 `WorkbuddySessionPool`，使用默认容量/最大轮数与
 * SDK 会话工厂；后续调用返回同一实例。可传入 `factory` 覆盖（测试用）。
 *
 * 参数：
 * - `factory`：可选的 SessionFactory，仅在首次创建时生效；后续调用忽略。
 *
 * 返回值：WorkbuddySessionPool 单例。
 * 边界：非线程安全的懒初始化，假设单进程/单事件循环；池关闭后需调用
 *       `closeTextPool` 清空单例才能重新创建。
 */
// 文本翻译池单例：懒创建，首单才启动 CLI 进程。
let textPool: WorkbuddySessionPool | null = null;

export function getTextPool(factory?: SessionFactory): WorkbuddySessionPool {
  if (!textPool) {
    // 默认工厂动态导入 SDK，避免在非 Workbuddy 路径下加载重型依赖。
    const create: SessionFactory = factory ?? (async (options) => {
      const sdk = await import('@tencent-ai/agent-sdk');
      return sdk.unstable_v2_createSession(options);
    });
    textPool = new WorkbuddySessionPool(WORKBUDDY_POOL_SIZE, WORKBUDDY_POOL_MAX_USES, create);
  }
  return textPool;
}

/**
 * 关闭文本翻译会话池单例（测试隔离/进程关停用）。
 *
 * 职责：若单例存在则 `closeAll()` 并置空，便于下次 `getTextPool` 重建。
 *
 * 参数：无。
 * 返回值：无。
 * 边界：关闭后旧引用失效；不等待已排队请求完成，它们会因池关闭而抛错。
 */
// 测试隔离与进程关停用。
export function closeTextPool(): void {
  if (textPool) {
    textPool.closeAll();
    textPool = null;
  }
}
