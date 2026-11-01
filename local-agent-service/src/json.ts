import { DEFAULT_OPENCODE_MODEL, DEFAULT_PROVIDER, DEFAULT_WORKBUDDY_MODEL } from './config.ts';
import { logInfo } from './log.ts';
import { jsonrepair } from 'jsonrepair';

/**
 * 解析用户/配置传入的模型字符串，拆分出 provider 与 model。
 *
 * 支持 "workbuddy:model"、"opencode:model"、"local-workbuddy:model" 等前缀；
 * 未指定 provider 时根据 hint 或默认 Provider 推断。"auto"/空值回退到 CLI/SDK 默认模型，
 * OpenCode 的非空模型必须包含 "/"（provider/model 格式）。
 */
export function parseAgentModel(modelValue: unknown, providerHint = '') {
  const raw = typeof modelValue === 'string' ? modelValue.trim() : '';
  const hint = typeof providerHint === 'string' ? providerHint.trim().toLowerCase() : '';
  let provider = DEFAULT_PROVIDER;
  let model = '';

  const match = /^(?:local-)?(workbuddy|opencode)(?::(.+))?$/i.exec(raw);
  if (match) {
    provider = match[1].toLowerCase();
    model = (match[2] || '').trim();
  } else if (['workbuddy', 'opencode'].includes(hint)) {
    provider = hint;
    model = raw && raw.toLowerCase() !== 'auto' ? raw : '';
  } else if (raw.includes('/') && DEFAULT_PROVIDER === 'opencode') {
    provider = 'opencode';
    model = raw;
  }

  if (provider !== 'workbuddy' && provider !== 'opencode') throw new Error('LOCAL_AGENT_PROVIDER 只支持 workbuddy 或 opencode');
  if (!model || model.toLowerCase() === 'auto') {
    model = provider === 'workbuddy' ? DEFAULT_WORKBUDDY_MODEL : DEFAULT_OPENCODE_MODEL;
    if (model.toLowerCase() === 'auto') model = '';
  }
  // 未显式配置模型时，交给已登录的 CLI/SDK 使用自身默认模型。
  // 只校验非空覆盖值，避免把“未设置模型”变成服务启动/路由故障。
  if (model && provider === 'opencode' && !model.includes('/')) {
    throw new Error('OpenCode 模型必须使用 provider/model 格式，例如 openai/gpt-5.4');
  }
  return { provider, model };
}

/**
 * 将 OpenAI 风格 messages 数组归一化为 system prompt 与 user prompt。
 * 跳过 role 非法或内容为空的条目；system/developer 合并为系统指令，其余按角色拼接为对话文本。
 * @throws messages 为空或无有效 user/assistant 内容时抛错。
 */
export function normalizeMessages(messages: any) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 必须是非空数组');
  const system: string[] = [];
  const conversation: string[] = [];
  for (const item of messages) {
    if (!item || !['system', 'developer', 'user', 'assistant'].includes(item.role)) continue;
    const content = typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n')
        : '';
    if (!content.trim()) continue;
    if (item.role === 'system' || item.role === 'developer') system.push(content.trim());
    else conversation.push(item.role.toUpperCase() + ':\n' + content.trim());
  }
  if (!conversation.length) throw new Error('messages 中没有有效的 user/assistant 内容');
  return { systemPrompt: system.join('\n\n'), userPrompt: conversation.join('\n\n') };
}

/**
 * 在 normalizeMessages 基础上，为 JSON 模式追加"只输出严格 JSON"的格式约束。
 * 返回 { systemPrompt, prompt } 供 Agent 调用使用。
 */
export function buildAgentPrompt(messages: any, jsonMode = false) {
  const normalized = normalizeMessages(messages);
  const formatRule = jsonMode
    ? '\n\n输出约束：只输出一个严格合法的 JSON 对象或数组；具体结构以 SYSTEM INSTRUCTIONS 和 USER REQUEST 为准。不要 Markdown 代码围栏、前言或后记。保留调用方指定的全部字段与 ID。'
    : '';
  return { systemPrompt: normalized.systemPrompt, prompt: normalized.userPrompt + formatRule };
}

/**
 * 解析模型输出中的 JSON 对象或数组。
 *
 * 翻译提示词的历史协议允许返回 JSON 数组，而文学分析/Reviewer 使用 JSON 对象。
 * 不能因为顶层是数组就把成功的翻译响应误判为 502。
 * 同时接受代码围栏，或 JSON 前后附带少量解释文本的常见模型输出。
 */
export function parseJsonValue(text: unknown, context = ''): Record<string, any> | any[] | null {
  const original = String(text ?? '').trim();
  if (!original) return null;

  const fence = String.fromCharCode(96).repeat(3);
  const fenceStart = original.indexOf(fence);
  const fenceEnd = original.lastIndexOf(fence);
  let value = original;
  if (fenceStart >= 0 && fenceEnd > fenceStart) {
    value = original.slice(fenceStart + fence.length, fenceEnd).trim();
    value = value.replace(/^json\s*/i, '');
  }

  const parseContainer = (candidate: string): Record<string, any> | any[] | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed !== null && typeof parsed === 'object'
        ? parsed as Record<string, any> | any[]
        : null;
    } catch {
      return null;
    }
  };

  const direct = parseContainer(value);
  if (direct !== null) return direct;

  // 找出第一个完整的顶层对象或数组，同时正确处理转义引号与嵌套。
  // 这样像 "Result:\n[{...}]" 这种输出也能解析，而不会在字符串里的花括号处切断。
  // 截断输出只能捡回第一个完整 item（如 {"id":"b33",...}），先记下来，后面跟 repair 比"谁捡得多"。
  let scanned: Record<string, any> | any[] | null = null;
  for (let start = 0; start < value.length && scanned === null; start += 1) {
    const opening = value[start];
    if (opening !== '{' && opening !== '[') continue;
    const stack: string[] = [opening === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (stack.length === 0) {
          scanned = parseContainer(value.slice(start, index + 1));
          break;
        }
      }
    }
  }

  // 模型常在译文里用 ASCII 双引号写中文对话引语（""我没犯法——""），
  // 或输出被截断：上面两种确定性解析只能捡回零散 item。jsonrepair 做最后兜底——
  // 只在本来就要返回残缺/null 的路上尝试，修不好就维持原结果，不污染正常输出。
  // 谁捡回的条目多用谁；修出来的残缺数组由调用方按 id 过滤、缺段重试补齐。
  try {
    const repaired = parseContainer(jsonrepair(value));
    const repairedCount = containerItemCount(repaired);
    if (repaired !== null && repairedCount > containerItemCount(scanned)) {
      // 这是模型输出质量信号：只记 inputChars 无法判断是哪个调用、坏在哪、救回多少。
      logInfo('local-agent', 'json-repair salvaged invalid model output · inputChars=' + value.length +
        ' · scannedItems=' + containerItemCount(scanned) +
        ' · repairedItems=' + repairedCount +
        (context ? ' · ' + context : ''));
      return repaired;
    }
  } catch {
    /* 修不好就维持扫描结果，老行为不变 */
  }
  return scanned;
}

/** 比较"捡回多少有效条目"：只数带 string id 的对象。
 *  必须这么比——jsonrepair 会把解释文字也包进数组（如 ["result:", {...}, "thanks"]），
 *  按容器长度比会让幻觉结果打败精确扫描。 */
function containerItemCount(value: Record<string, any> | any[] | null): number {
  if (value === null) return 0;
  const items = Array.isArray(value)
    ? value
    : Array.isArray((value as Record<string, unknown>).translations)
      ? ((value as Record<string, unknown>).translations as unknown[])
      : [value];
  return items.filter((item) =>
    !!item && typeof item === 'object' && !Array.isArray(item) &&
    typeof (item as Record<string, unknown>).id === 'string').length;
}

/**
 * 仅保留对象形态的解析器：复用 parseJsonValue，若结果是数组则返回 null。
 * 用于文学分析与 Reviewer 等必须返回 JSON 对象的场景。
 */
export function parseJsonObject(text: unknown, context = ''): Record<string, any> | null {
  const parsed = parseJsonValue(text, context);
  return parsed && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
}
