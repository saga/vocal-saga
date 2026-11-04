import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgentSkills, loadAgentSkills } from '../src/agentSkills.ts';

test('Agent Skills are discovered from the server-side skills directory', () => {
  const skills = listAgentSkills();
  assert.ok(skills.length > 0, 'expected at least one server-managed Skill');
  assert.ok(skills.every((skill) => skill.id && skill.name));
});

test('selected Agent Skill content is loaded by server-owned ID', () => {
  const skills = listAgentSkills();
  const selected = loadAgentSkills([skills[0].id]);
  assert.equal(selected.length, 1);
  assert.ok(selected[0].content.length > 0);
});

test('Agent Skill loader rejects path traversal and unknown IDs', () => {
  assert.throws(() => loadAgentSkills(['../README.md']), /不存在|无效/);
  assert.throws(() => loadAgentSkills(['not-a-real-skill']), /不存在/);
});
