import { describe, it, expect } from 'vitest';
import { buildAnalysisPrompt, parseProposalResponse } from '../analyze.js';
import type { DiscoveryContext } from '../types.js';

// ── Fixtures ──────────────────────────────────────────────

function makeContext(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    tree: 'root/\n├── src/\n└── docs/',
    fileCountsByDirectory: {},
    existingExperts: [],
    ...overrides,
  };
}

function makeValidResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    experts: [
      {
        slug: 'invoicing',
        name: 'Invoicing System',
        mountPath: 'modules/Invoicing/',
        description: 'Manages invoice creation and payment tracking.',
        reasoning: 'High file count and clear domain boundary.',
        confidence: 0.92,
      },
    ],
    rationale: 'The codebase has clear domain boundaries.',
    ...overrides,
  });
}

// ══════════════════════════════════════════════════════════════
// buildAnalysisPrompt
// ══════════════════════════════════════════════════════════════

describe('buildAnalysisPrompt', () => {
  it('includes the directory tree', () => {
    const prompt = buildAnalysisPrompt(makeContext({ tree: 'myproject/\n├── src/' }));
    expect(prompt).toContain('myproject/\n├── src/');
  });

  it('includes the Directory Tree header', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).toContain('### Directory Tree');
  });

  it('includes file counts when present', () => {
    const prompt = buildAnalysisPrompt(
      makeContext({
        fileCountsByDirectory: {
          'src/models': 12,
          'src/controllers': 8,
        },
      })
    );
    expect(prompt).toContain('### File Counts by Directory');
    expect(prompt).toContain('src/models: 12');
    expect(prompt).toContain('src/controllers: 8');
  });

  it('omits file counts section when empty', () => {
    const prompt = buildAnalysisPrompt(makeContext({ fileCountsByDirectory: {} }));
    expect(prompt).not.toContain('### File Counts by Directory');
  });

  it('includes symbol summaries when present', () => {
    const prompt = buildAnalysisPrompt(
      makeContext({
        symbolSummaries: {
          'src/models': ['Invoice', 'LineItem', 'Payment'],
        },
      })
    );
    expect(prompt).toContain('### Symbol Summaries');
    expect(prompt).toContain('src/models: Invoice, LineItem, Payment');
  });

  it('omits symbol summaries when not provided', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).not.toContain('### Symbol Summaries');
  });

  it('includes cross-references when present', () => {
    const prompt = buildAnalysisPrompt(
      makeContext({
        crossReferences: [{ sourceDir: 'src/a', targetDir: 'src/b', referenceCount: 5 }],
      })
    );
    expect(prompt).toContain('### Cross-References');
    expect(prompt).toContain('src/a → src/b (5 refs)');
  });

  it('omits cross-references when not provided', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).not.toContain('### Cross-References');
  });

  it('omits cross-references when empty array', () => {
    const prompt = buildAnalysisPrompt(makeContext({ crossReferences: [] }));
    expect(prompt).not.toContain('### Cross-References');
  });

  it('includes existing experts when present', () => {
    const prompt = buildAnalysisPrompt(
      makeContext({
        existingExperts: [{ slug: 'auth', mountPath: 'modules/Auth/' }],
      })
    );
    expect(prompt).toContain('### Already Registered Experts');
    expect(prompt).toContain('auth (modules/Auth/)');
  });

  it('shows "None" when no existing experts', () => {
    const prompt = buildAnalysisPrompt(makeContext({ existingExperts: [] }));
    expect(prompt).toContain('### Already Registered Experts');
    expect(prompt).toContain('None');
  });

  it('includes instructions for proposal criteria', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).toContain('Cover distinct functional domains');
    expect(prompt).toContain('Avoid overlapping mount paths');
    expect(prompt).toContain('Do not duplicate already-registered experts');
  });

  it('includes the JSON schema', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).toContain('"slug"');
    expect(prompt).toContain('"mountPath"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"rationale"');
  });

  it('requests ONLY valid JSON', () => {
    const prompt = buildAnalysisPrompt(makeContext());
    expect(prompt).toContain('Respond with ONLY valid JSON');
  });
});

// ══════════════════════════════════════════════════════════════
// parseProposalResponse
// ══════════════════════════════════════════════════════════════

describe('parseProposalResponse: valid input', () => {
  it('parses a valid response with one expert', () => {
    const result = parseProposalResponse(makeValidResponse());
    expect(result.experts).toHaveLength(1);
    expect(result.experts[0].slug).toBe('invoicing');
    expect(result.rationale).toBe('The codebase has clear domain boundaries.');
  });

  it('parses multiple experts', () => {
    const raw = JSON.stringify({
      experts: [
        {
          slug: 'invoicing',
          name: 'Invoicing',
          mountPath: 'modules/Invoicing/',
          description: 'Invoicing domain.',
          reasoning: 'Clear boundary.',
          confidence: 0.92,
        },
        {
          slug: 'auth',
          name: 'Authentication',
          mountPath: 'modules/Auth/',
          description: 'Auth domain.',
          reasoning: 'Separate concern.',
          confidence: 0.85,
        },
      ],
      rationale: 'Two clear domains.',
    });
    const result = parseProposalResponse(raw);
    expect(result.experts).toHaveLength(2);
    expect(result.experts[0].slug).toBe('invoicing');
    expect(result.experts[1].slug).toBe('auth');
  });

  it('parses empty experts array', () => {
    const raw = JSON.stringify({ experts: [], rationale: 'No clear boundaries found.' });
    const result = parseProposalResponse(raw);
    expect(result.experts).toHaveLength(0);
    expect(result.rationale).toBe('No clear boundaries found.');
  });

  it('preserves additionalPaths when present', () => {
    const raw = JSON.stringify({
      experts: [
        {
          slug: 'billing',
          name: 'Billing',
          mountPath: 'modules/Billing/',
          additionalPaths: ['modules/Payments/', 'modules/Invoicing/'],
          description: 'Billing domain.',
          reasoning: 'Groups related modules.',
          confidence: 0.88,
        },
      ],
      rationale: 'Grouped billing.',
    });
    const result = parseProposalResponse(raw);
    expect(result.experts[0].additionalPaths).toEqual(['modules/Payments/', 'modules/Invoicing/']);
  });

  it('omits additionalPaths when not in response', () => {
    const result = parseProposalResponse(makeValidResponse());
    expect(result.experts[0].additionalPaths).toBeUndefined();
  });

  it('handles confidence at boundary values (0.0 and 1.0)', () => {
    const raw = JSON.stringify({
      experts: [
        {
          slug: 'low',
          name: 'Low',
          mountPath: 'a/',
          description: 'd',
          reasoning: 'r',
          confidence: 0.0,
        },
        {
          slug: 'high',
          name: 'High',
          mountPath: 'b/',
          description: 'd',
          reasoning: 'r',
          confidence: 1.0,
        },
      ],
      rationale: 'Boundary test.',
    });
    const result = parseProposalResponse(raw);
    expect(result.experts[0].confidence).toBe(0.0);
    expect(result.experts[1].confidence).toBe(1.0);
  });
});

describe('parseProposalResponse: markdown fences', () => {
  it('strips ```json fences', () => {
    const json = makeValidResponse();
    const wrapped = '```json\n' + json + '\n```';
    const result = parseProposalResponse(wrapped);
    expect(result.experts).toHaveLength(1);
  });

  it('strips bare ``` fences', () => {
    const json = makeValidResponse();
    const wrapped = '```\n' + json + '\n```';
    const result = parseProposalResponse(wrapped);
    expect(result.experts).toHaveLength(1);
  });

  it('handles fences with trailing whitespace', () => {
    const json = makeValidResponse();
    const wrapped = '```json\n' + json + '\n```  ';
    const result = parseProposalResponse(wrapped);
    expect(result.experts).toHaveLength(1);
  });
});

describe('parseProposalResponse: error handling', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseProposalResponse('not json at all')).toThrow('Failed to parse AI response');
  });

  it('throws on null response', () => {
    expect(() => parseProposalResponse('null')).toThrow('non-object value');
  });

  it('throws on missing experts array', () => {
    expect(() => parseProposalResponse(JSON.stringify({ rationale: 'ok' }))).toThrow(
      'missing "experts" array'
    );
  });

  it('throws on missing rationale', () => {
    expect(() => parseProposalResponse(JSON.stringify({ experts: [] }))).toThrow(
      'missing "rationale" string'
    );
  });

  it('throws when experts is not an array', () => {
    expect(() =>
      parseProposalResponse(JSON.stringify({ experts: 'not array', rationale: 'ok' }))
    ).toThrow('missing "experts" array');
  });

  it('throws on non-object expert entry', () => {
    expect(() =>
      parseProposalResponse(JSON.stringify({ experts: ['not an object'], rationale: 'ok' }))
    ).toThrow('Expert at index 0 is not an object');
  });

  it('throws on missing slug', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              name: 'Test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('Expert at index 0 missing or empty "slug"');
  });

  it('throws on empty slug', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: '',
              name: 'Test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('Expert at index 0 missing or empty "slug"');
  });

  it('throws on missing name', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('missing or empty "name"');
  });

  it('throws on missing mountPath', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('missing or empty "mountPath"');
  });

  it('throws on confidence below 0', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: -0.1,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('invalid "confidence"');
  });

  it('throws on confidence above 1', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 1.1,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('invalid "confidence"');
  });

  it('throws on non-numeric confidence', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 'high',
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('invalid "confidence"');
  });

  it('throws on invalid additionalPaths (not array)', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              mountPath: 'a/',
              additionalPaths: 'not-array',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('invalid "additionalPaths"');
  });

  it('throws on additionalPaths containing non-strings', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'test',
              name: 'Test',
              mountPath: 'a/',
              additionalPaths: [123],
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('invalid "additionalPaths"');
  });

  it('includes index in error messages for multi-expert responses', () => {
    expect(() =>
      parseProposalResponse(
        JSON.stringify({
          experts: [
            {
              slug: 'ok',
              name: 'OK',
              mountPath: 'a/',
              description: 'd',
              reasoning: 'r',
              confidence: 0.5,
            },
            {
              slug: 'bad',
              name: 'Bad',
              mountPath: 'b/',
              description: 'd',
              reasoning: 'r',
              confidence: 2.0,
            },
          ],
          rationale: 'ok',
        })
      )
    ).toThrow('Expert at index 1');
  });
});
