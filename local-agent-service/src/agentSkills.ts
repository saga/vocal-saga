/**
 * 通用 Agent Skills 目录。Skill 只由 vocal-saga 服务端持有和读取；
 * 扩展只能提交 skill ID，不能上传/覆盖 Skill 正文。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');
const MAX_SKILL_CHARS = 60_000;
const MAX_TOTAL_SKILL_CHARS = 100_000;

export interface AgentSkillSummary {
  id: string;
  name: string;
  description: string;
}

function parseFrontmatter(source: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(source);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (item) values[item[1]!] = item[2]!.replace(/^["']|["']$/g, '');
  }
  return values;
}

function skillFile(id: string): string {
  const normalized = id.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('无效的 Agent Skill ID');
  }
  const file = path.resolve(SKILLS_ROOT, normalized, 'SKILL.md');
  if (!file.startsWith(SKILLS_ROOT + path.sep)) throw new Error('无效的 Agent Skill 路径');
  return file;
}

export function listAgentSkills(): AgentSkillSummary[] {
  const result: AgentSkillSummary[] = [];
  const visit = (directory: string, prefix = ''): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const id = prefix ? prefix + '/' + entry.name : entry.name;
      const file = path.join(directory, entry.name, 'SKILL.md');
      try {
        if (statSync(file).isFile()) {
          const source = readFileSync(file, 'utf8');
          const meta = parseFrontmatter(source);
          result.push({
            id,
            name: meta.name || entry.name,
            description: meta.description || '',
          });
        }
      } catch {
        visit(path.join(directory, entry.name), id);
      }
    }
  };
  visit(SKILLS_ROOT);
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgentSkills(ids: unknown): Array<{ skill: AgentSkillSummary; content: string }> {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== 'string')) {
    throw new Error('skills 必须是最多 8 个 Skill ID 的数组');
  }
  const available = new Map(listAgentSkills().map((skill) => [skill.id, skill]));
  let totalChars = 0;
  return [...new Set(ids as string[])].map((id) => {
    const skill = available.get(id);
    if (!skill) throw new Error('服务端不存在 Agent Skill：' + id);
    const source = readFileSync(skillFile(id), 'utf8');
    if (source.length > MAX_SKILL_CHARS) throw new Error('Agent Skill 内容超过 60,000 字符：' + id);
    totalChars += source.length;
    if (totalChars > MAX_TOTAL_SKILL_CHARS) throw new Error('所选 Agent Skills 总内容超过 100,000 字符，请减少 Skill 数量');
    return { skill, content: source };
  });
}
