import { REQUEST_TIMEOUT_MS, WORKBUDDY_POOL_MAX_USES, WORKBUDDY_POOL_SIZE } from '../config.ts';
import { buildWorkbuddyOptions, type WorkbuddyAgent } from './workbuddy.ts';
import { parseTurnUsage, type TurnUsage } from './usage.ts';
import { logInfo, logWarn, summarizeError } from '../log.ts';

// SDK 会话的最小使用面：正式用 Session，测试用假对象。
export interface PooledSession {
  send(message: string): Promise<void>;
  stream(): AsyncGenerator<any, void>;
  interrupt(): Promise<void>;
  close(): void;
  setModel?(model: string): Promise<void>;
  /** 只 boot CLI 进程，不调模型（SDK Session.connect 的预热语义）。 */
  connect?(): Promise<void>;
}

export type SessionFactory = (options: Record<string, any>) => PooledSession | Promise<PooledSession>;

interface Slot {
  session: PooledSession | null;
  model: string;
  /** Complete scope key; document batches add run, role, prompt revision, lane and batch index to isolate history. */
  scopeKey: string;
  schemaKey: string;
  uses: number;
  busy: boolean;
  lastUsedAt: number;
}

/**
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

  private assertOpen(): void {
    if (this.closed) throw new Error('Workbuddy session pool is closed');
  }

  constructor(
    private readonly size: number,
    private readonly maxUses: number,
    private readonly factory: SessionFactory,
  ) {
    this.slots = Array.from({ length: size }, () => ({
      session: null, model: '', scopeKey: '', schemaKey: '', uses: 0, busy: false, lastUsedAt: 0,
    }));
  }

  // 取一个空闲槽位并保证会话就绪；全忙时排队等（不另起进程，避免无界膨胀）。
  /**
   * 获取与 provider/model/session scope/schema 匹配的空闲会话。
   * 池满时通过 waiter 排队而非无限创建进程；scopeKey 正在执行中的会话不可被第二个请求并发复用。
   * 会话达到 maxUses 或模型/schema 不匹配时应重建，避免历史上下文持续增长或类型约束串线。
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

  /** True when the next turn must seed a fresh session with stable system instructions. */
  isFresh(index: number): boolean {
    return this.slots[index]?.uses === 0;
  }

  release(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    slot.busy = false;
    slot.lastUsedAt = Date.now();
    this.wakeNext();
  }

  // 在指定槽位跑一轮：发 prompt、收文本与 structured_output，超时则中断。
  // 成功用满 maxUses 轮即重建；失败/超时直接丢弃会话（状态不可信），下次懒重建。
  /**
   * 在独占槽位中执行一次 Prompt，并在 finally 路径释放槽位。
   * 同一 scope 的重试可以复用会话，但调用方仍须传入完整、显式的当前批次上下文；
   * 不能把 SDK 对话历史当作权威记忆或跨批次的安全上下文。
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
   * 用于服务关闭、测试隔离和故障恢复；关闭后不得继续使用旧 Slot 中的 session 引用。
   */
  closeAll(): void {
    if (this.closed) return;
    // Closing is terminal for this pool instance. Wake queued acquire() calls so they
    // reject instead of looping back and creating new CLI sessions after shutdown.
    this.closed = true;
    for (let i = 0; i < this.slots.length; i++) this.dropSession(i, '关闭池');
    this.waiters.splice(0).forEach((wake) => { wake(); });
  }

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
   * 传入 error 时会把它写进日志：会话生命周期是排查「调用卡住/空响应」的关键线索，
   * 只说「调用失败」而不说失败原因，等于没记。
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

  private wakeNext(): void {
    const wake = this.waiters.shift();
    if (wake) wake();
  }

  /**
   * 等一个空闲槽位。
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

// 复用会话的 options：与单次 query 一致，但去掉 maxTurns。
// --max-turns 是按进程（会话生命周期）计的预算，不适合复用会话；
// 单轮护栏由 tools:[]（无工具可循环）+ 超时承担。
export function buildTextSessionOptions(agent: WorkbuddyAgent, schema?: Record<string, unknown>): Record<string, any> {
  const { maxTurns: _unused, ...rest } = buildWorkbuddyOptions(agent, schema);
  return rest;
}

// 文本翻译池单例：懒创建，首单才启动 CLI 进程。
let textPool: WorkbuddySessionPool | null = null;

export function getTextPool(factory?: SessionFactory): WorkbuddySessionPool {
  if (!textPool) {
    const create: SessionFactory = factory ?? (async (options) => {
      const sdk = await import('@tencent-ai/agent-sdk');
      return sdk.unstable_v2_createSession(options);
    });
    textPool = new WorkbuddySessionPool(WORKBUDDY_POOL_SIZE, WORKBUDDY_POOL_MAX_USES, create);
  }
  return textPool;
}

// 测试隔离与进程关停用。
export function closeTextPool(): void {
  if (textPool) {
    textPool.closeAll();
    textPool = null;
  }
}
