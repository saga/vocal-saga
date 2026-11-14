import { describe, it, expect } from 'vitest';
import {
  countSentences,
  validateBlockMapping,
} from '../lib/translate/mappingValidator';

describe('countSentences', () => {

  it('counts multiple English sentences', () => {
    expect(countSentences('First sentence. Second sentence. Third one.')).toBe(3);
  });


  it('ignores pure-symbol/no-letter fragments', () => {
    expect(countSentences('123. !@#。')).toBe(0);
  });

  // 回归：claude.com 文章列表项 "…(e.g. memory lookup) move into the tools."
  // 曾被数成 3 句（"…(e" / "g" / " memory lookup)…"），导致中文 1 句译文被误判错配。
  it('does not split on abbreviation dots (e.g. / i.e. / U.S.)', () => {
    expect(
      countSentences(
        'Hard limits (validation, approval gates) and anything else that comes up mid-conversation (e.g. memory lookup) move into the tools.'
      )
    ).toBe(1);
    expect(countSentences('Use i.e. this one. Then stop.')).toBe(2);
    expect(countSentences('The U.S. market grew. It kept growing.')).toBe(2);
  });

  it('does not split on in-word dots (decimals / filenames)', () => {
    expect(countSentences('Latency dropped to 3.5 ms overall.')).toBe(1);
    expect(countSentences('Edit node.js config then restart.')).toBe(1);
  });

  it('does not split when the dot is followed by a lowercase continuation', () => {
    expect(countSentences('Wait... and then it worked.')).toBe(1);
  });

  it('does not treat semicolons as sentence boundaries', () => {
    expect(countSentences('Load the plan; revise it as results arrive; stop at budget.')).toBe(1);
  });

  it('still counts Chinese sentence terminators', () => {
    expect(countSentences('第一句。第二句！第三句？')).toBe(3);
  });

});

describe('validateBlockMapping', () => {
  it('flags short original paired with very long translation (title got body)', () => {
    const verdict = validateBlockMapping(
      'AI financial advice is surprisingly good especially if you ask the right questions',
      '人们越来越多地转向人工智能寻求财务建议。最近的一项研究发现，当被正确引导时，人工智能给出的建议质量出奇地高。研究还表明，提问的方式会显著影响回答的质量。'
    );
    expect(verdict.suspect).toBe(true);
    expect(verdict.reasons.join('; ')).toMatch(/译文过长|句子数激增/);
  });

  it('flags long original paired with very short translation (body got title)', () => {
    const verdict = validateBlockMapping(
      'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality. Researchers tested several prompting strategies across multiple models.',
      '人工智能理财建议。'
    );
    expect(verdict.suspect).toBe(true);
  });

  it('does NOT flag a normal short title → short translation', () => {
    const verdict = validateBlockMapping(
      'AI financial advice is surprisingly good',
      '人工智能理财建议出奇地好'
    );
    expect(verdict.suspect).toBe(false);
  });

  it('does NOT flag a normal body paragraph → body translation', () => {
    const verdict = validateBlockMapping(
      'People are increasingly turning to AI for financial advice. A study found that the way questions are asked significantly affects answer quality.',
      '人们越来越多地转向人工智能寻求财务建议。研究发现提问方式会显著影响回答质量。'
    );
    expect(verdict.suspect).toBe(false);
  });

  it('flags empty original with non-empty translation', () => {
    const verdict = validateBlockMapping('', '人工智能理财建议');
    expect(verdict.suspect).toBe(true);
    expect(verdict.reasons.join('; ')).toMatch(/原文为空/);
  });


  it('respects custom options (stricter bounds)', () => {
    const verdict = validateBlockMapping(
      'short text here',
      '这是一段明显过长的译文用来测试自定义阈值的触发情况是否符合预期设定',
      { maxCharRatio: 2, minAbsoluteChars: 10 }
    );
    expect(verdict.suspect).toBe(true);
  });

  // 回归：真实误报样本（claude.com / building-agents-when-to-fold-subagents）
  it('does NOT flag a list item whose only dot is inside "e.g."', () => {
    const verdict = validateBlockMapping(
      'Hard limits (validation, approval gates) and anything else that comes up mid-conversation (e.g. memory lookup) move into the tools.',
      '硬性限制（验证、审批门控）以及对话中途出现的任何其他事项（如记忆查找）都转移到工具中。'
    );
    expect(verdict.origSentences).toBe(1);
    expect(verdict.transSentences).toBe(1);
    expect(verdict.suspect).toBe(false);
  });

  // 「骤减」二次门控：译文只有 1 句且绝对差 ≥ 4 才算骤减。3→1 不告警。
  it('does NOT flag 3-sentence original collapsed into 1 Chinese sentence', () => {
    const verdict = validateBlockMapping(
      'The harness runs tool calls in parallel. Results come back to the same model. The model decides the next step.',
      '调度层并行执行工具调用，结果回传给同一个模型，由模型决定下一步。'
    );
    expect(verdict.origSentences).toBe(3);
    expect(verdict.transSentences).toBe(1);
    expect(verdict.suspect).toBe(false);
  });

  // 回归：couchbase.com 文章页 12 EN → 4 CN（比 0.33），多对多合并，不告警。
  it('does NOT flag many-to-many merge with transSentences >= 2', () => {
    const verdict = validateBlockMapping(
      'Agents plan. They act. They adapt. They persist state. They resume after failures. They own processes. They interact with people. They interact with systems. They take days. They take weeks. They are durable. They are not short-lived.',
      '智能体规划、行动并适应。它们持久化状态、故障后恢复。它们与人和系统交互。它们持续数天或数周。'
    );
    expect(verdict.origSentences).toBe(12);
    expect(verdict.transSentences).toBe(4);
    expect(verdict.suspect).toBe(false);
  });

  // 回归：couchbase.com b54 — 5 EN → 1 CN（比 0.20），译文正常但句数骤减确实可疑，仍告警。
  it('still flags 5 EN → 1 CN collapse (transSentences === 1, abs diff >= 4)', () => {
    const verdict = validateBlockMapping(
      'Durable execution is a programming model. The runtime records every step. If the process crashes it replays them. State is durable. Recovery is automatic.',
      '持久化执行是一种编程模型，其中运行时会记录下每一个与外部世界交互的步骤结果；一旦发生故障，程序会重新执行这些步骤。'
    );
    expect(verdict.origSentences).toBe(5);
    expect(verdict.transSentences).toBe(1);
    expect(verdict.reasons.join('; ')).toMatch(/句子数骤减/);
  });

  it('still flags a many-sentence original collapsed into 1 sentence', () => {
    const verdict = validateBlockMapping(
      'Alpha one is here. Beta two is here. Gamma three is here. Delta four is here. Epsilon five is here.',
      '甲乙丙丁戊都在这里。'
    );
    expect(verdict.origSentences).toBe(5);
    expect(verdict.reasons.join('; ')).toMatch(/句子数骤减/);
  });
});
