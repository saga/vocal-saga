import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRunLanguageDirection, documentLanguageName } from '../src/documents/languageMatch.ts';
import { normalizePromptStyle } from '../src/documents/projectStore.ts';

/**
 * 项目里存的 systemPrompt 是「上一次生效的快照」：建项目时源语言是英语，
 * 之后改成法语，快照里的「输入语言：英语」不会自己更新。
 * 运行时必须以本次 Run 的语言为准，否则模型会照着过期语言方向翻译。
 */
test('按本次 Run 的语言重写过期的语言行', () => {
  const stored = '你是一名文学译者。\n\n<输出格式>\n\n输入语言：英语\n目标语言：简体中文\n\n</输出格式>';
  const rewritten = applyRunLanguageDirection(stored, { sourceLang: 'fr', targetLang: 'zh' });
  assert.match(rewritten, /输入语言：法语/);
  assert.doesNotMatch(rewritten, /输入语言：英语/);
  assert.match(rewritten, /目标语言：简体中文/);
  // 其余正文不得被改动
  assert.match(rewritten, /你是一名文学译者。/);
  assert.match(rewritten, /<\/输出格式>/);
});

test('auto 不落成具体语言，而是明确的自动检测说明', () => {
  const rewritten = applyRunLanguageDirection('输入语言：英语\n目标语言：简体中文', { sourceLang: 'auto', targetLang: 'ja' });
  assert.match(rewritten, /输入语言：自动检测（按原文实际语言判断，不要假定为英语）/);
  assert.match(rewritten, /目标语言：日语/);
});

test('重写是幂等的，重复调用不会叠加语言段', () => {
  const once = applyRunLanguageDirection('输入语言：英语\n目标语言：简体中文', { sourceLang: 'de', targetLang: 'zh' });
  const twice = applyRunLanguageDirection(once, { sourceLang: 'de', targetLang: 'zh' });
  assert.equal(twice, once);
});

test('没有语言行的自定义 Prompt 补一段权威说明，而不是沿用旧方向', () => {
  const custom = '你是一个严格的译者，只输出 JSON。';
  const rewritten = applyRunLanguageDirection(custom, { sourceLang: 'ko', targetLang: 'zh' });
  assert.equal(rewritten, custom + '\n\n输入语言：韩语\n目标语言：简体中文');
});

test('未收录的语言代码原样透传，不猜成英语', () => {
  assert.equal(documentLanguageName('xx', '自动检测'), 'xx');
  assert.equal(documentLanguageName('', '自动检测'), '自动检测');
  assert.equal(documentLanguageName('zh-CN', '自动检测'), '简体中文');
});

test('文风随项目保存，未知值回落到通用直译', () => {
  assert.equal(normalizePromptStyle('acheng'), 'acheng');
  assert.equal(normalizePromptStyle('ja-source-natural'), 'ja-source-natural');
  assert.equal(normalizePromptStyle('nope'), 'default');
  assert.equal(normalizePromptStyle(undefined), 'default');
});
