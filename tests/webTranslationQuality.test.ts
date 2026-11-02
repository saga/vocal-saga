import { describe, expect, it } from 'vitest';
import {
  buildWebQualityInstructions,
  withWebQualityContext,
} from '../lib/translate/pipeline';

describe('web translation quality mode', () => {
  const blocks = [
    { id: 'h1', tag: 'h1', text: 'Graph databases' },
    { id: 'p1', tag: 'p', text: 'This article explains graph database architecture and query planning.' },
    { id: 'p2', tag: 'p', text: 'It compares indexes, traversal and distributed execution.' },
  ] as any;

  it('keeps fast mode free of additional context and preserves the glossary reference', () => {
    const glossary = { document_terms: ['Graph database'] };
    expect(withWebQualityContext(glossary, 'Article', blocks, 'fast')).toBe(glossary);
    expect(withWebQualityContext(undefined, 'Article', blocks, 'fast')).toBeUndefined();
  });

  it('builds a bounded deterministic context from existing page blocks', () => {
    const instruction = buildWebQualityInstructions('Article title', blocks);
    expect(instruction).toContain('Article title');
    expect(instruction).toContain('Graph databases');
    expect(instruction).toContain('query planning');
    expect(instruction).toContain('只读上下文');
    expect(instruction!.length).toBeLessThan(1200);
  });

  it('adds context only in enhanced mode without replacing site instructions or terms', () => {
    const glossary = {
      document_terms: ['Graph database'],
      site_instructions: ['Preserve code identifiers.'],
    };
    const enhanced = withWebQualityContext(glossary, 'Article', blocks, 'enhanced');
    expect(enhanced?.document_terms).toEqual(['Graph database']);
    expect(enhanced?.site_instructions).toHaveLength(2);
    expect(enhanced?.site_instructions?.[0]).toBe('Preserve code identifiers.');
    expect(enhanced?.site_instructions?.[1]).toContain('Graph databases');
  });
});
