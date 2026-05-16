import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { runDiscoveryPipeline, filterCandidates, resolveModel } from '../pipeline.js';
import type {
  PipelineStages,
  DiscoveryOptions,
  DiscoveryContext,
  DiscoveryProposal,
  ProposedExpert,
  ReviewResult,
  RegisteredExpert,
} from '../types.js';

// ── Test Fixtures ──────────────────────────────────────────

function makeProposal(overrides: Partial<ProposedExpert> = {}): ProposedExpert {
  return {
    slug: 'invoicing',
    name: 'Invoicing System',
    mountPath: 'modules/Invoicing/',
    description: 'Manages invoice creation and payment tracking.',
    reasoning: 'High file count and clear domain boundary.',
    confidence: 0.92,
    ...overrides,
  };
}

function makeContext(tree = 'root/\n├── src/\n└── docs/'): DiscoveryContext {
  return {
    tree,
    fileCountsByDirectory: { 'src/': 10, 'docs/': 5 },
    existingExperts: [],
  };
}

function makeStages(overrides: Partial<PipelineStages> = {}): PipelineStages {
  return {
    collectTree: vi.fn().mockReturnValue('root/\n├── src/\n└── docs/'),
    enrichContext: vi.fn().mockReturnValue(makeContext()),
    deriveCandidateRegions: vi
      .fn<(context: DiscoveryContext) => DiscoveryContext>()
      .mockImplementation((context: DiscoveryContext): DiscoveryContext => context),
    analyze: vi.fn().mockResolvedValue({
      experts: [
        makeProposal(),
        makeProposal({
          slug: 'reporting',
          name: 'Reporting',
          mountPath: 'modules/Reporting/',
          confidence: 0.88,
        }),
        makeProposal({ slug: 'auth', name: 'Auth', mountPath: 'modules/Auth/', confidence: 0.85 }),
      ],
      rationale: 'Three clear domain boundaries.',
    } satisfies DiscoveryProposal),
    review: vi.fn().mockResolvedValue({
      accepted: [makeProposal()],
      skipped: [
        makeProposal({
          slug: 'reporting',
          name: 'Reporting',
          mountPath: 'modules/Reporting/',
          confidence: 0.88,
        }),
        makeProposal({ slug: 'auth', name: 'Auth', mountPath: 'modules/Auth/', confidence: 0.85 }),
      ],
    } satisfies ReviewResult),
    register: vi.fn().mockResolvedValue([
      {
        slug: 'invoicing',
        mountPath: 'modules/Invoicing/',
        claudeMdPath: 'modules/Invoicing/claude.md',
      },
    ] satisfies RegisteredExpert[]),
    ...overrides,
  };
}

// ── Test Setup ─────────────────────────────────────────────

let db: LuxDatabase;
let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `lux-pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(testDir, { recursive: true });
  db = new LuxDatabase(join(testDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

// ── Full Pipeline Flow ─────────────────────────────────────

describe('runDiscoveryPipeline', () => {
  const baseOptions: DiscoveryOptions = { rootPath: '/fake/root' };

  it('runs all six stages in sequence and returns results', async () => {
    const stages = makeStages();
    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    // All stages called
    expect(stages.collectTree).toHaveBeenCalledWith('/fake/root');
    expect(stages.enrichContext).toHaveBeenCalledWith(
      'root/\n├── src/\n└── docs/',
      db,
      baseOptions
    );
    expect(stages.deriveCandidateRegions).toHaveBeenCalledWith(makeContext(), baseOptions);
    expect(stages.analyze).toHaveBeenCalledWith(makeContext(), baseOptions);
    expect(stages.review).toHaveBeenCalledWith(expect.any(Array));
    expect(stages.register).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ slug: 'invoicing' })]),
      db,
      baseOptions
    );

    // Result shape
    expect(result.proposed).toHaveLength(3);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].slug).toBe('invoicing');
    expect(result.skipped).toHaveLength(2);
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0].slug).toBe('invoicing');
    expect(result.rationale).toBe('Three clear domain boundaries.');
  });

  it('calls stages in the correct order', async () => {
    const callOrder: string[] = [];

    const stages = makeStages({
      collectTree: vi.fn(() => {
        callOrder.push('collectTree');
        return 'root/\n├── src/';
      }),
      enrichContext: vi.fn(() => {
        callOrder.push('enrichContext');
        return makeContext();
      }),
      deriveCandidateRegions: vi.fn((context: DiscoveryContext): DiscoveryContext => {
        callOrder.push('deriveCandidateRegions');
        return context;
      }),
      analyze: vi.fn(() => {
        callOrder.push('analyze');
        return Promise.resolve({
          experts: [makeProposal()],
          rationale: 'test',
        });
      }),
      review: vi.fn(() => {
        callOrder.push('review');
        return Promise.resolve({ accepted: [makeProposal()], skipped: [] });
      }),
      register: vi.fn(() => {
        callOrder.push('register');
        return Promise.resolve([{ slug: 'invoicing', mountPath: 'modules/Invoicing/' }]);
      }),
    });

    await runDiscoveryPipeline(db, baseOptions, stages);

    expect(callOrder).toEqual([
      'collectTree',
      'enrichContext',
      'deriveCandidateRegions',
      'analyze',
      'review',
      'register',
    ]);
  });

  // ── Empty Tree ─────────────────────────────────────────

  it('returns empty result when tree is empty', async () => {
    const stages = makeStages({
      collectTree: vi.fn().mockReturnValue(''),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(result.proposed).toHaveLength(0);
    expect(result.rationale).toContain('empty');
    expect(stages.enrichContext).not.toHaveBeenCalled();
    expect(stages.deriveCandidateRegions).not.toHaveBeenCalled();
    expect(stages.analyze).not.toHaveBeenCalled();
  });

  it('returns empty result when tree is whitespace-only', async () => {
    const stages = makeStages({
      collectTree: vi.fn().mockReturnValue('   \n  \n  '),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(result.proposed).toHaveLength(0);
    expect(stages.enrichContext).not.toHaveBeenCalled();
  });

  // ── AI Returns No Proposals ────────────────────────────

  it('returns empty result when AI proposes no experts', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [],
        rationale: 'No clear domain boundaries found.',
      }),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(result.proposed).toHaveLength(0);
    expect(result.rationale).toContain('No clear domain boundaries');
    expect(stages.review).not.toHaveBeenCalled();
    expect(stages.register).not.toHaveBeenCalled();
  });

  // ── Confidence Filtering ───────────────────────────────

  it('filters proposals below the confidence threshold', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [
          makeProposal({ slug: 'high', confidence: 0.9 }),
          makeProposal({ slug: 'medium', confidence: 0.6 }),
          makeProposal({ slug: 'low', confidence: 0.3 }),
        ],
        rationale: 'Mixed confidence.',
      }),
      review: vi.fn().mockResolvedValue({
        accepted: [makeProposal({ slug: 'high', confidence: 0.9 })],
        skipped: [makeProposal({ slug: 'medium', confidence: 0.6 })],
      }),
      register: vi.fn().mockResolvedValue([{ slug: 'high', mountPath: 'modules/High/' }]),
    });

    const result = await runDiscoveryPipeline(db, { ...baseOptions, minConfidence: 0.5 }, stages);

    // Only high and medium pass the 0.5 threshold
    expect(result.proposed).toHaveLength(2);
    expect(result.proposed.map((p) => p.slug)).toEqual(['high', 'medium']);
  });

  it('returns empty when all proposals are below threshold', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [
          makeProposal({ slug: 'low1', confidence: 0.2 }),
          makeProposal({ slug: 'low2', confidence: 0.1 }),
        ],
        rationale: 'Low confidence.',
      }),
    });

    const result = await runDiscoveryPipeline(db, { ...baseOptions, minConfidence: 0.5 }, stages);

    expect(result.proposed).toHaveLength(0);
    expect(result.rationale).toContain('below the confidence threshold');
    expect(stages.review).not.toHaveBeenCalled();
  });

  it('uses default minConfidence of 0.5 when not specified', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [
          makeProposal({ slug: 'above', confidence: 0.5 }),
          makeProposal({ slug: 'below', confidence: 0.49 }),
        ],
        rationale: 'Edge case.',
      }),
      review: vi.fn().mockResolvedValue({
        accepted: [makeProposal({ slug: 'above', confidence: 0.5 })],
        skipped: [],
      }),
      register: vi.fn().mockResolvedValue([{ slug: 'above', mountPath: 'modules/Above/' }]),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0].slug).toBe('above');
  });

  // ── Max Experts Cap ────────────────────────────────────

  it('caps proposals at maxExperts', async () => {
    const manyExperts = Array.from({ length: 30 }, (_, i) =>
      makeProposal({
        slug: `expert-${i}`,
        confidence: 1.0 - i * 0.01,
      })
    );

    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: manyExperts,
        rationale: 'Large codebase.',
      }),
      review: vi.fn().mockResolvedValue({
        accepted: [],
        skipped: manyExperts.slice(0, 5),
      }),
    });

    const result = await runDiscoveryPipeline(db, { ...baseOptions, maxExperts: 5 }, stages);

    expect(result.proposed).toHaveLength(5);
    expect(result.countPolicy).toMatchObject({
      selectionMode: 'top-n-slice',
      maxExperts: 5,
      proposalCountBeforeFilter: 30,
      eligibleCountAfterConfidence: 30,
      acceptedCountAfterCountLimit: 5,
      stoppedBecause: 'top-n-slice',
    });
    expect(stages.review).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'expert-0' }),
        expect.objectContaining({ slug: 'expert-4' }),
      ])
    );
  });

  it('uses default maxExperts of 20 when not specified', async () => {
    const manyExperts = Array.from({ length: 25 }, (_, i) =>
      makeProposal({
        slug: `expert-${i}`,
        confidence: 0.9,
      })
    );

    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: manyExperts,
        rationale: 'Many proposals.',
      }),
      review: vi.fn().mockResolvedValue({
        accepted: [],
        skipped: manyExperts.slice(0, 20),
      }),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(result.proposed).toHaveLength(20);
    expect(result.countPolicy).toMatchObject({
      selectionMode: 'top-n-slice',
      maxExperts: 20,
      stoppedBecause: 'top-n-slice',
    });
  });

  it('uses inventory safety-cap semantics when requested', async () => {
    const manyExperts = Array.from({ length: 25 }, (_, i) =>
      makeProposal({
        slug: `expert-${i}`,
        confidence: 0.9,
      })
    );

    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: manyExperts,
        rationale: 'Many proposals.',
      }),
      review: vi.fn().mockResolvedValue({
        accepted: [],
        skipped: manyExperts.slice(0, 16),
      }),
    });

    const result = await runDiscoveryPipeline(
      db,
      { ...baseOptions, countSelectionMode: 'quality-gated-inventory' },
      stages
    );

    expect(result.proposed).toHaveLength(16);
    expect(result.countPolicy).toMatchObject({
      selectionMode: 'quality-gated-inventory',
      safetyCap: 16,
      proposalCountBeforeFilter: 25,
      eligibleCountAfterConfidence: 25,
      acceptedCountAfterCountLimit: 16,
      stoppedBecause: 'safety-cap',
    });
  });

  // ── Dry-Run Mode ───────────────────────────────────────

  it('skips review and registration in dry-run mode', async () => {
    const stages = makeStages();

    const result = await runDiscoveryPipeline(db, { ...baseOptions, dryRun: true }, stages);

    expect(stages.collectTree).toHaveBeenCalled();
    expect(stages.enrichContext).toHaveBeenCalled();
    expect(stages.analyze).toHaveBeenCalled();
    expect(stages.review).not.toHaveBeenCalled();
    expect(stages.register).not.toHaveBeenCalled();

    expect(result.proposed).toHaveLength(3);
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.registered).toHaveLength(0);
  });

  // ── JSON Mode ──────────────────────────────────────────

  it('skips review and registration in JSON mode', async () => {
    const stages = makeStages();

    const result = await runDiscoveryPipeline(db, { ...baseOptions, json: true }, stages);

    expect(stages.review).not.toHaveBeenCalled();
    expect(stages.register).not.toHaveBeenCalled();

    expect(result.proposed).toHaveLength(3);
    expect(result.accepted).toHaveLength(0);
    expect(result.registered).toHaveLength(0);
    expect(result.rationale).toBe('Three clear domain boundaries.');
  });

  // ── Review Skips All ───────────────────────────────────

  it('skips registration when all proposals are skipped in review', async () => {
    const stages = makeStages({
      review: vi.fn().mockResolvedValue({
        accepted: [],
        skipped: [
          makeProposal(),
          makeProposal({ slug: 'reporting', confidence: 0.88 }),
          makeProposal({ slug: 'auth', confidence: 0.85 }),
        ],
      }),
    });

    const result = await runDiscoveryPipeline(db, baseOptions, stages);

    expect(stages.register).not.toHaveBeenCalled();
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.registered).toHaveLength(0);
  });

  // ── Stage Error Propagation ────────────────────────────

  it('propagates errors from collectTree', async () => {
    const stages = makeStages({
      collectTree: vi.fn(() => {
        throw new Error('Permission denied');
      }),
    });

    await expect(runDiscoveryPipeline(db, baseOptions, stages)).rejects.toThrow(
      'Permission denied'
    );
  });

  it('propagates errors from analyze', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockRejectedValue(new Error('Claude CLI failed')),
    });

    await expect(runDiscoveryPipeline(db, baseOptions, stages)).rejects.toThrow(
      'Claude CLI failed'
    );
  });

  it('propagates errors from review', async () => {
    const stages = makeStages({
      review: vi.fn().mockRejectedValue(new Error('stdin closed')),
    });

    await expect(runDiscoveryPipeline(db, baseOptions, stages)).rejects.toThrow('stdin closed');
  });

  it('propagates errors from register', async () => {
    const stages = makeStages({
      review: vi.fn().mockResolvedValue({
        accepted: [makeProposal()],
        skipped: [],
      }),
      register: vi.fn().mockRejectedValue(new Error('Duplicate expert slug')),
    });

    await expect(runDiscoveryPipeline(db, baseOptions, stages)).rejects.toThrow(
      'Duplicate expert slug'
    );
  });

  // ── Accept-All Mode ─────────────────────────────────────

  it('skips review and accepts all candidates when acceptAll is set', async () => {
    const stages = makeStages();

    const result = await runDiscoveryPipeline(db, { ...baseOptions, acceptAll: true }, stages);

    expect(stages.review).not.toHaveBeenCalled();
    expect(stages.register).toHaveBeenCalled();

    // All 3 proposals above default 0.5 threshold should be accepted
    expect(result.accepted).toHaveLength(3);
    expect(result.accepted.map((p) => p.slug)).toEqual(['invoicing', 'reporting', 'auth']);
    expect(result.skipped).toHaveLength(0);
    expect(result.registered).toHaveLength(1); // mock register returns 1
  });

  it('dry-run takes precedence over acceptAll', async () => {
    const stages = makeStages();

    const result = await runDiscoveryPipeline(
      db,
      { ...baseOptions, dryRun: true, acceptAll: true },
      stages
    );

    expect(stages.review).not.toHaveBeenCalled();
    expect(stages.register).not.toHaveBeenCalled();

    expect(result.proposed).toHaveLength(3);
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.registered).toHaveLength(0);
  });

  it('acceptAll respects confidence threshold', async () => {
    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [
          makeProposal({ slug: 'high', confidence: 0.9 }),
          makeProposal({ slug: 'low', confidence: 0.3 }),
        ],
        rationale: 'Mixed.',
      }),
      register: vi.fn().mockResolvedValue([{ slug: 'high', mountPath: 'modules/High/' }]),
    });

    const result = await runDiscoveryPipeline(
      db,
      { ...baseOptions, acceptAll: true, minConfidence: 0.5 },
      stages
    );

    expect(stages.review).not.toHaveBeenCalled();
    // Only the high-confidence proposal passes the filter
    expect(result.proposed).toHaveLength(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].slug).toBe('high');
  });

  it('acceptAll works with diff mode', async () => {
    // Register an existing expert so diff has something to compare
    db.insertExpert({
      slug: 'existing',
      name: 'Existing',
      mount_path: '/fake/root/existing',
    });

    const stages = makeStages({
      analyze: vi.fn().mockResolvedValue({
        experts: [makeProposal({ slug: 'new-expert', confidence: 0.9, mountPath: 'modules/New/' })],
        rationale: 'New boundary found.',
      }),
      register: vi.fn().mockResolvedValue([{ slug: 'new-expert', mountPath: 'modules/New/' }]),
    });

    const result = await runDiscoveryPipeline(
      db,
      { ...baseOptions, acceptAll: true, diff: true },
      stages
    );

    expect(stages.review).not.toHaveBeenCalled();
    expect(result.diffResult).toBeDefined();
  });

  // ── Options Passthrough ────────────────────────────────

  it('passes options through to enrichContext and analyze', async () => {
    const opts: DiscoveryOptions = {
      rootPath: '/my/corpus',
      model: 'claude-haiku-4-5-20251001',
      maxExperts: 10,
      minConfidence: 0.7,
      dryRun: true,
    };

    const stages = makeStages();
    await runDiscoveryPipeline(db, opts, stages);

    expect(stages.enrichContext).toHaveBeenCalledWith(expect.any(String), db, opts);
    expect(stages.deriveCandidateRegions).toHaveBeenCalledWith(expect.any(Object), opts);
    expect(stages.analyze).toHaveBeenCalledWith(expect.any(Object), opts);
  });
});

// ── filterCandidates ───────────────────────────────────────

describe('filterCandidates', () => {
  const experts = [
    makeProposal({ slug: 'a', confidence: 0.95 }),
    makeProposal({ slug: 'b', confidence: 0.8 }),
    makeProposal({ slug: 'c', confidence: 0.6 }),
    makeProposal({ slug: 'd', confidence: 0.4 }),
    makeProposal({ slug: 'e', confidence: 0.2 }),
  ];

  it('filters by minimum confidence', () => {
    const result = filterCandidates(experts, 0.5, 100);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.slug)).toEqual(['a', 'b', 'c']);
  });

  it('caps at maxExperts', () => {
    const result = filterCandidates(experts, 0.0, 2);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.slug)).toEqual(['a', 'b']);
  });

  it('applies both filters (confidence first, then cap)', () => {
    const result = filterCandidates(experts, 0.5, 2);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.slug)).toEqual(['a', 'b']);
  });

  it('returns empty array when nothing passes threshold', () => {
    const result = filterCandidates(experts, 0.99, 100);
    expect(result).toHaveLength(0);
  });

  it('includes proposals exactly at the threshold', () => {
    const result = filterCandidates(experts, 0.6, 100);
    expect(result).toHaveLength(3);
    expect(result[2].slug).toBe('c');
  });

  it('handles empty input', () => {
    const result = filterCandidates([], 0.5, 20);
    expect(result).toHaveLength(0);
  });
});

// ── resolveModel ───────────────────────────────────────────

describe('resolveModel', () => {
  it('returns specified model', () => {
    expect(resolveModel({ rootPath: '/', model: 'claude-haiku-4-5-20251001' })).toBe(
      'claude-haiku-4-5-20251001'
    );
  });

  it('returns default model when not specified', () => {
    expect(resolveModel({ rootPath: '/' })).toBe('gpt-5.4');
  });
});
