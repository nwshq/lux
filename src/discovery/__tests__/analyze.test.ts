import { describe, it, expect } from 'vitest';
import {
  buildAnalysisPrompt,
  buildClaudeArgs,
  parseProposalResponse,
  extractJsonObject,
  attachStructuralSignatures,
} from '../analyze.js';
import type { DiscoveryContext, ProposedExpert } from '../types.js';
import type { OverlayNeighborhood } from '../../experts/structural-analysis.js';

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
// buildClaudeArgs / buildAnalysisPrompt
// ══════════════════════════════════════════════════════════════

describe('buildClaudeArgs', () => {
  it('uses Claude Code print mode with bypassPermissions', () => {
    const args = buildClaudeArgs('prompt text', 'claude-sonnet-4-20250514');
    expect(args).toEqual([
      '--print',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'claude-sonnet-4-20250514',
      'prompt text',
    ]);
  });
});

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

  it('caps prompt growth for very large enrichment contexts', () => {
    const largeContext = makeContext({
      fileCountsByDirectory: Object.fromEntries(
        Array.from({ length: 2500 }, (_, i) => [`dir-${i.toString().padStart(4, '0')}`, 2500 - i])
      ),
      symbolSummaries: Object.fromEntries(
        Array.from({ length: 1200 }, (_, i) => [
          `symbols-${i.toString().padStart(4, '0')}`,
          Array.from({ length: 20 }, (_, j) => `Symbol${i}_${j}`),
        ])
      ),
      crossReferences: Array.from({ length: 900 }, (_, i) => ({
        sourceDir: `src-${i}`,
        targetDir: `dst-${i}`,
        referenceCount: 900 - i,
      })),
      existingExperts: Array.from({ length: 80 }, (_, i) => ({
        slug: `expert-${i}`,
        mountPath: `mount-${i}`,
      })),
    });

    const prompt = buildAnalysisPrompt(largeContext);
    expect(prompt.length).toBeLessThan(120000);
    expect(prompt).toContain('more directories omitted for prompt budget');
    expect(prompt).toContain('more cross-references omitted for prompt budget');
  });

  it('can build a materially smaller fallback prompt', () => {
    const largeContext = makeContext({
      fileCountsByDirectory: Object.fromEntries(
        Array.from({ length: 600 }, (_, i) => [`dir-${i.toString().padStart(4, '0')}`, 600 - i])
      ),
      symbolSummaries: Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `symbols-${i.toString().padStart(4, '0')}`,
          Array.from({ length: 15 }, (_, j) => `Symbol${i}_${j}`),
        ])
      ),
      crossReferences: Array.from({ length: 300 }, (_, i) => ({
        sourceDir: `src-${i}`,
        targetDir: `dst-${i}`,
        referenceCount: 300 - i,
      })),
    });

    const defaultPrompt = buildAnalysisPrompt(largeContext);
    const fallbackPrompt = buildAnalysisPrompt(largeContext, {
      totalChars: 45000,
      maxFileCountDirs: 60,
      maxSymbolSummaryDirs: 40,
      maxSymbolsPerDir: 5,
      maxCrossReferences: 30,
      maxExistingExperts: 20,
      maxOverlayNeighborhoods: 8,
    });

    expect(fallbackPrompt.length).toBeLessThan(defaultPrompt.length);
    expect(fallbackPrompt.length).toBeLessThan(45000);
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

describe('extractJsonObject', () => {
  it('extracts a JSON object from wrapped prose', () => {
    expect(extractJsonObject('Here you go\n{"experts":[],"rationale":"ok"}\nThanks')).toBe(
      '{"experts":[],"rationale":"ok"}'
    );
  });

  it('returns null when no JSON object is present', () => {
    expect(extractJsonObject('no object here')).toBeNull();
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

  it('parses valid JSON wrapped in extra prose', () => {
    const wrapped = `Analysis complete\n${makeValidResponse()}\nDone`;
    const result = parseProposalResponse(wrapped);
    expect(result.experts).toHaveLength(1);
  });
});

describe('parseProposalResponse: error handling', () => {
  it('throws on invalid JSON', () => {
    expect(() => parseProposalResponse('not json at all')).toThrow('Failed to parse AI response');
  });

  it('throws on plain-text Claude failures like prompt length rejection', () => {
    expect(() => parseProposalResponse('Prompt is too long')).toThrow(
      'Failed to parse AI response'
    );
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

// ══════════════════════════════════════════════════════════════
// attachStructuralSignatures
// ══════════════════════════════════════════════════════════════

function makeProposal(mountPath: string): ProposedExpert {
  return {
    slug: 'test',
    name: 'Test',
    mountPath,
    description: '',
    reasoning: '',
    confidence: 0.9,
  };
}

function makeNeighborhood(overrides: Partial<OverlayNeighborhood> = {}): OverlayNeighborhood {
  return {
    id: 'nbhd-1',
    kind: 'surface-family',
    label: 'test neighborhood',
    anchorFiles: [],
    memberFiles: [],
    dominantDirectories: [],
    cohesionScore: 1,
    externalCouplingScore: 0,
    trustState: 'overlay-complete',
    trustWeight: 1.0,
    evidenceSummary: [],
    ...overrides,
  };
}

describe('attachStructuralSignatures', () => {
  it('attaches a signature when a neighborhood dominant directory matches the mount path', () => {
    const proposals = [makeProposal('src/billing')];

    const neighborhoods = [
      makeNeighborhood({
        id: 'billing-nbhd',
        dominantDirectories: ['src/billing'],
        anchorFiles: ['src/billing/BillingService.ts', 'src/billing/routes.ts'],
        surfaceIds: ['svc::BillingService'],
        providerIds: ['src/billing/BillingService.ts'],
      }),
    ];

    attachStructuralSignatures(proposals, neighborhoods);

    expect(proposals[0].structuralSignature).toBeDefined();
    expect(proposals[0].structuralSignature?.version).toBe(1);
    expect(proposals[0].structuralSignature?.anchorFiles).toContain(
      'src/billing/BillingService.ts'
    );
    expect(proposals[0].structuralSignature?.dominantDirectories).toContain('src/billing');
    expect(proposals[0].structuralSignature?.dominantSurfaces).toContain('svc::BillingService');
  });

  it('merges multiple neighborhoods under the same mount path', () => {
    const proposals = [makeProposal('src/billing')];

    const neighborhoods = [
      makeNeighborhood({
        id: 'billing-core',
        dominantDirectories: ['src/billing'],
        anchorFiles: ['src/billing/BillingService.ts'],
      }),
      makeNeighborhood({
        id: 'billing-sub',
        dominantDirectories: ['src/billing/subscription'],
        anchorFiles: ['src/billing/subscription/SubscriptionService.ts'],
      }),
    ];

    attachStructuralSignatures(proposals, neighborhoods);

    const sig = proposals[0].structuralSignature!;
    expect(sig).toBeDefined();
    expect(sig.anchorFiles).toContain('src/billing/BillingService.ts');
    expect(sig.anchorFiles).toContain('src/billing/subscription/SubscriptionService.ts');
    expect(sig.dominantDirectories).toContain('src/billing');
    expect(sig.dominantDirectories).toContain('src/billing/subscription');
  });

  it('does not attach a signature when no neighborhood matches', () => {
    const proposals = [makeProposal('src/billing')];

    const neighborhoods = [
      makeNeighborhood({
        dominantDirectories: ['src/payments'],
        anchorFiles: ['src/payments/PaymentService.ts'],
      }),
    ];

    attachStructuralSignatures(proposals, neighborhoods);

    expect(proposals[0].structuralSignature).toBeUndefined();
  });

  it('does nothing when neighborhoods array is empty', () => {
    const proposals = [makeProposal('src/billing')];

    attachStructuralSignatures(proposals, []);

    expect(proposals[0].structuralSignature).toBeUndefined();
  });

  it('normalizes trailing slash on mount path before matching', () => {
    const proposals = [makeProposal('src/billing/')];

    const neighborhoods = [
      makeNeighborhood({
        dominantDirectories: ['src/billing'],
        anchorFiles: ['src/billing/BillingService.ts'],
      }),
    ];

    attachStructuralSignatures(proposals, neighborhoods);

    expect(proposals[0].structuralSignature).toBeDefined();
  });
});
