import { spawn } from 'node:child_process';
import { REQUEST_TIMEOUT_MS, WORK_DIR } from '../config.ts';

export function buildOpenCodeConfig() {
  let existing: Record<string, any> = {};
  if (process.env.OPENCODE_CONFIG_CONTENT?.trim()) {
    try { existing = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT 不是合法 JSON'); }
  }
  const agents = existing.agent && typeof existing.agent === 'object' && !Array.isArray(existing.agent) ? existing.agent : {};
  const prior = agents['fanyi-local-translation'] && typeof agents['fanyi-local-translation'] === 'object'
    ? agents['fanyi-local-translation'] : {};
  return JSON.stringify({
    ...existing,
    agent: {
      ...agents,
      'fanyi-local-translation': {
        ...prior,
        mode: 'primary',
        tools: { ...(prior.tools || {}), '*': false },
        permission: { ...(prior.permission || {}), '*': 'deny' },
      },
    },
  });
}

export function runOpenCode(agent: { provider: string; model: string }, prompt: string, systemPrompt: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullPrompt = [
      systemPrompt ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt : '',
      'USER REQUEST:\n' + prompt,
    ].filter(Boolean).join('\n\n');
    const args = ['run', '--format', 'json'];
    if (agent.model) args.push('--model', agent.model);
    args.push('--dir', WORK_DIR, '--agent', 'fanyi-local-translation', '--auto', fullPrompt);
    const child = spawn('opencode', args, {
      cwd: WORK_DIR,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: buildOpenCodeConfig() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let answer = '';
    let stdoutFallback = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 3000).unref();
    }, timeoutMs);
    timer.unref();

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;
      let event: any;
      try { event = JSON.parse(line); }
      catch { stdoutFallback += (stdoutFallback ? '\n' : '') + line; return; }
      if (event.type === 'text' && typeof event.part?.text === 'string') answer += event.part.text;
      if (event.type === 'error') stderr += '\n' + String(event.error?.message || event.message || 'OpenCode 调用失败');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('无法启动 OpenCode CLI。请确认 opencode 命令和登录状态：' + error.message));
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      const output = answer.trim() || stdoutFallback.trim();
      if (timedOut) {
        reject(new Error('OpenCode 调用超时（' + timeoutMs + ' ms）'));
        return;
      }
      if (signal || code !== 0) {
        reject(new Error('OpenCode 执行失败（exit=' + code + (signal ? ', signal=' + signal : '') + '）：' + (stderr.trim() || output.slice(-1000) || '无详细错误')));
        return;
      }
      if (!output) {
        reject(new Error('OpenCode 已退出，但没有输出译文。' + (stderr.trim() ? ' ' + stderr.trim().slice(-1000) : '')));
        return;
      }
      resolve(output);
    });
  });
}
