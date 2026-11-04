/**
 * 独立通用 Agent 对话 API。
 * 不创建 Document Project / Translation Run，不调用文档翻译或文学审校 Pipeline。
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROVIDER, DEFAULT_WORKBUDDY_MODEL, DEFAULT_OPENCODE_MODEL, WORK_DIR } from './config.ts';
import { sendApiError, sendJson } from './middleware.ts';
import { runAgent } from './agents/runner.ts';
import { normalizeCodeBuddyTaskProfile } from './agents/taskProfiles.ts';
import { readModelCatalog } from './agents/modelCatalog.ts';
import { loadAgentSkills, listAgentSkills } from './agentSkills.ts';

const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 80_000;
const MAX_TOTAL_CHARS = 180_000;

export function handleAgentChatRequest(req: Request, res: Response, url: URL): boolean {
  if (req.method === 'GET' && url.pathname === '/api/agent/capabilities') {
    const catalog = readModelCatalog({ projectRoot: WORK_DIR });
    sendJson(res, 200, {
      providers: [
        { id: 'workbuddy', label: 'Workbuddy', defaultModel: DEFAULT_WORKBUDDY_MODEL, models: catalog.map((item) => ({ id: item.id, credits: item.credits, maxInputTokens: item.maxInputTokens, contextWindow: item.contextWindow })) },
        { id: 'opencode', label: 'OpenCode', defaultModel: DEFAULT_OPENCODE_MODEL, models: (process.env.LOCAL_OPENCODE_MODELS || '').split(',').map((id) => id.trim()).filter(Boolean).map((id) => ({ id })) },
      ],
      defaultProvider: DEFAULT_PROVIDER === 'opencode' ? 'opencode' : 'workbuddy',
      thinkingModes: ['disabled', 'adaptive', 'enabled'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      skillsEndpoint: '/api/agent/skills',
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/skills') {
    sendJson(res, 200, { skills: listAgentSkills() });
    return true;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/agent/chat') return false;

  void executeAgentChat(req, res).catch((error) => {
    if (!res.headersSent) sendApiError(res, 500, error instanceof Error ? error.message : String(error));
  });
  return true;
}

async function executeAgentChat(req: Request, res: Response): Promise<void> {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const provider = body.provider === 'opencode' ? 'opencode' : body.provider === 'workbuddy' ? 'workbuddy' : '';
  if (!provider) { sendApiError(res, 400, 'provider 必须是 workbuddy 或 opencode'); return; }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    sendApiError(res, 400, 'messages 必须包含 1-80 条对话消息'); return;
  }
  let totalChars = 0;
  const normalized = [];
  for (const item of messages) {
    if (!item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
      sendApiError(res, 400, '每条消息必须包含合法 role 和 content'); return;
    }
    if (item.content.length > MAX_MESSAGE_CHARS) { sendApiError(res, 413, '单条消息超过 80,000 字符'); return; }
    totalChars += item.content.length;
    normalized.push({ role: item.role as 'system' | 'user' | 'assistant', content: item.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) { sendApiError(res, 413, '对话上下文超过 180,000 字符'); return; }

  let skills;
  try { skills = loadAgentSkills(body.skillIds); }
  catch (error) { sendApiError(res, 400, error instanceof Error ? error.message : String(error)); return; }

  const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : '';
  const profile = normalizeCodeBuddyTaskProfile({
    model,
    fallbackModel: '',
    thinkingMode: body.thinkingMode,
    effort: body.effort,
    thinkingBudgetTokens: body.thinkingBudgetTokens,
    systemPromptAppendix: '',
    userPromptTemplate: '',
  }, 'translation');
  const systemMessage = normalized.find((item) => item.role === 'system');
  const conversation = normalized.filter((item) => item.role !== 'system');
  const skillInstructions = skills.map(({ skill, content }) =>
    '## Agent Skill: ' + skill.name + ' (' + skill.id + ')\n' + content,
  ).join('\n\n');
  const systemPrompt = [
    systemMessage?.content || 'You are a helpful assistant.',
    skillInstructions ? 'The following server-managed Agent Skills are active. Follow their instructions when relevant.\n\n' + skillInstructions : '',
    body.jsonMode === true ? 'Return only a valid JSON object. Do not wrap it in Markdown fences or add explanatory text.' : '',
  ].filter(Boolean).join('\n\n');
  const latest = conversation.pop();
  if (!latest || latest.role !== 'user') { sendApiError(res, 400, '最后一条消息必须是 user 消息'); return; }
  const historyText = conversation.map((item) => item.role.toUpperCase() + ':\n' + item.content).join('\n\n');
  const prompt = (historyText ? 'Conversation history:\n' + historyText + '\n\n' : '') + 'USER:\n' + latest.content;
  const requestId = randomUUID();
  const startedAt = Date.now();
  try {
    const result = await runAgent(
      { provider, model },
      prompt,
      systemPrompt,
      'agent-chat:' + requestId,
      'agent-chat:' + requestId,
      profile,
    );
    sendJson(res, 200, {
      id: 'chatcmpl-' + requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || '<runtime-default>',
      provider,
      choices: [{ index: 0, message: { role: 'assistant', content: result.result }, finish_reason: 'stop' }],
      usage: result.usage,
      durationMs: Date.now() - startedAt,
      appliedSkills: skills.map(({ skill }) => skill.id),
    });
  } catch (error) {
    sendApiError(res, 502, error instanceof Error ? error.message : String(error));
  }
}
