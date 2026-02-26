import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { diffProposals, detectStaleExperts, checkExpertStaleness } from '../diff.js';
import type { ProposedExpert } from '../types.js';
import type { Expert } from '../../db/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<ProposedExpert> = {}): ProposedExpert {
  return {
    slug: 'test-expert',
    name: 'Test Expert',
    mountPath: 'modules/Test',
    description: 'Test description',
    reasoning: 'Test reasoning',
    confidence: 0.8,
    ...overrides,
  };
}

function makeExpert(overrides: Partial<Expert> = {}): Expert {
  return {
    id: 1,
    slug: 'existing-expert',
    name: 'Existing Expert',
    mount_path: 'modules/Existing',
    model: 'claude-sonnet-4-20250514',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureDir = join(__dirname, 'fixtures', 'diff-test');

beforeEach(() => {
  if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// diffProposals — classification
// ---------------------------------------------------------------------------

describe('diffProposals', () => {
  it('should classify proposals with no matching experts as new', () => {
    const proposals = [makeProposal({ slug: 'auth', mountPath: 'modules/Auth' })];
    const experts = [makeExpert({ slug: 'billing', mount_path: 'modules/Billing' })];

    // Create the directory so stale detection doesn't flag it
    mkdirSync(join(fixtureDir, 'modules', 'Billing'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Billing', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0].proposal.slug).toBe('auth');
    expect(result.newProposals[0].status).toBe('new');
    expect(result.newProposals[0].reason).toContain('No matching');
    expect(result.updatedProposals).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  it('should classify proposals with exact mount path match as duplicate', () => {
    const proposals = [makeProposal({ slug: 'new-auth', mountPath: 'modules/Auth' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].proposal.slug).toBe('new-auth');
    expect(result.duplicates[0].matchedExpert?.slug).toBe('auth');
    expect(result.duplicates[0].reason).toContain('Matches existing');
    expect(result.newProposals).toHaveLength(0);
  });

  it('should handle trailing slashes in mount paths', () => {
    const proposals = [makeProposal({ mountPath: 'modules/Auth/' })];
    const experts = [makeExpert({ mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
  });

  it('should classify proposals narrowing an existing expert as updated', () => {
    // Proposal is a subdirectory of the existing expert
    const proposals = [makeProposal({ slug: 'auth-models', mountPath: 'modules/Auth/Models' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth', 'Models'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'Models', 'User.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.updatedProposals).toHaveLength(1);
    expect(result.updatedProposals[0].status).toBe('updated');
    expect(result.updatedProposals[0].matchedExpert?.slug).toBe('auth');
    expect(result.updatedProposals[0].reason).toContain('Narrows scope');
  });

  it('should classify proposals widening an existing expert as updated', () => {
    // Proposal is a parent directory of the existing expert
    const proposals = [makeProposal({ slug: 'modules', mountPath: 'modules' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.updatedProposals).toHaveLength(1);
    expect(result.updatedProposals[0].reason).toContain('Widens scope');
  });

  it('should classify proposals with same slug but different path as updated', () => {
    const proposals = [makeProposal({ slug: 'auth', mountPath: 'src/Auth' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.updatedProposals).toHaveLength(1);
    expect(result.updatedProposals[0].reason).toContain('Same slug');
    expect(result.updatedProposals[0].reason).toContain('different mount path');
  });

  it('should classify multiple proposals correctly', () => {
    const proposals = [
      makeProposal({ slug: 'auth', mountPath: 'modules/Auth', confidence: 0.9 }),
      makeProposal({ slug: 'billing', mountPath: 'modules/Billing', confidence: 0.85 }),
      makeProposal({ slug: 'notifications', mountPath: 'modules/Notifications', confidence: 0.7 }),
    ];
    const experts = [
      makeExpert({ id: 1, slug: 'auth', mount_path: 'modules/Auth' }),
      makeExpert({ id: 2, slug: 'reporting', mount_path: 'modules/Reporting' }),
    ];

    // Create directories
    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'Reporting'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');
    writeFileSync(join(fixtureDir, 'modules', 'Reporting', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].proposal.slug).toBe('auth');
    expect(result.newProposals).toHaveLength(2);
    expect(result.newProposals.map((p) => p.proposal.slug)).toContain('billing');
    expect(result.newProposals.map((p) => p.proposal.slug)).toContain('notifications');
  });

  it('should handle empty proposals array', () => {
    const experts = [makeExpert()];

    mkdirSync(join(fixtureDir, 'modules', 'Existing'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Existing', 'file.ts'), '');

    const result = diffProposals([], experts, { contentRoot: fixtureDir });

    expect(result.newProposals).toHaveLength(0);
    expect(result.updatedProposals).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  it('should handle empty experts array', () => {
    const proposals = [makeProposal()];

    const result = diffProposals(proposals, [], { contentRoot: fixtureDir });

    expect(result.newProposals).toHaveLength(1);
    expect(result.staleExperts).toHaveLength(0);
  });

  it('should handle both empty', () => {
    const result = diffProposals([], [], { contentRoot: fixtureDir });

    expect(result.newProposals).toHaveLength(0);
    expect(result.updatedProposals).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.staleExperts).toHaveLength(0);
    expect(result.summary).toContain('No changes detected');
  });

  it('should handle absolute expert mount paths', () => {
    const proposals = [makeProposal({ mountPath: 'modules/Auth' })];
    const experts = [makeExpert({ mount_path: join(fixtureDir, 'modules', 'Auth') })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
  });

  it('should not match paths that share a prefix but are not parent-child', () => {
    // modules/Auth should NOT match modules/AuthService — they are siblings
    const proposals = [makeProposal({ slug: 'auth-service', mountPath: 'modules/AuthService' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    // Should be classified as new, not as an overlap of Auth
    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0].proposal.slug).toBe('auth-service');
    expect(result.updatedProposals).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });

  it('should prefer exact path match over slug match', () => {
    // Same slug + same mount path = duplicate (not updated)
    const proposals = [makeProposal({ slug: 'auth', mountPath: 'modules/Auth' })];
    const experts = [makeExpert({ slug: 'auth', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
    expect(result.updatedProposals).toHaveLength(0);
  });

  it('should preserve additionalPaths in classified proposals', () => {
    const proposals = [
      makeProposal({
        slug: 'invoicing',
        mountPath: 'modules/Invoicing',
        additionalPaths: ['resources/js/Pages/Invoicing', 'routes/invoicing.php'],
      }),
    ];

    const result = diffProposals(proposals, [], { contentRoot: fixtureDir });

    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0].proposal.additionalPaths).toEqual([
      'resources/js/Pages/Invoicing',
      'routes/invoicing.php',
    ]);
  });

  it('should handle mount paths with trailing double slashes', () => {
    const proposals = [makeProposal({ mountPath: 'modules/Auth//' })];
    const experts = [makeExpert({ mount_path: 'modules/Auth/' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.duplicates).toHaveLength(1);
  });

  it('should handle multiple experts where first overlap match wins', () => {
    // Proposal is a child of both experts, but first match (by array order) wins
    const proposals = [makeProposal({ slug: 'deep', mountPath: 'modules/Auth/Sub/Deep' })];
    const experts = [
      makeExpert({ id: 1, slug: 'auth', mount_path: 'modules/Auth' }),
      makeExpert({ id: 2, slug: 'auth-sub', mount_path: 'modules/Auth/Sub' }),
    ];

    mkdirSync(join(fixtureDir, 'modules', 'Auth', 'Sub', 'Deep'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'Sub', 'Deep', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.updatedProposals).toHaveLength(1);
    // Should match the first overlapping expert found
    expect(result.updatedProposals[0].matchedExpert?.slug).toBe('auth');
  });

  it('should preserve confidence and all proposal fields through classification', () => {
    const proposals = [
      makeProposal({
        slug: 'test',
        name: 'Test Expert',
        mountPath: 'modules/Test',
        description: 'A test expert',
        reasoning: 'Because testing',
        confidence: 0.73,
      }),
    ];

    const result = diffProposals(proposals, [], { contentRoot: fixtureDir });

    const classified = result.newProposals[0];
    expect(classified.proposal.slug).toBe('test');
    expect(classified.proposal.name).toBe('Test Expert');
    expect(classified.proposal.mountPath).toBe('modules/Test');
    expect(classified.proposal.description).toBe('A test expert');
    expect(classified.proposal.reasoning).toBe('Because testing');
    expect(classified.proposal.confidence).toBe(0.73);
  });
});

// ---------------------------------------------------------------------------
// detectStaleExperts
// ---------------------------------------------------------------------------

describe('detectStaleExperts', () => {
  it('should detect experts with non-existent mount paths', () => {
    const experts = [makeExpert({ mount_path: 'modules/Deleted' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
    expect(stale[0].expert.slug).toBe('existing-expert');
    expect(stale[0].reason).toContain('does not exist');
  });

  it('should detect experts with empty mount paths', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Empty'), { recursive: true });

    const experts = [makeExpert({ mount_path: 'modules/Empty' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toContain('no files');
  });

  it('should not flag experts with files in mount path', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Active'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Active', 'Service.ts'), 'export class Service {}');

    const experts = [makeExpert({ mount_path: 'modules/Active' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(0);
  });

  it('should flag directories with only empty subdirectories as stale', () => {
    // A directory tree with no actual files should be considered stale
    mkdirSync(join(fixtureDir, 'modules', 'Parent', 'Child'), { recursive: true });

    const experts = [makeExpert({ mount_path: 'modules/Parent' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toContain('no files');
  });

  it('should not flag directories with files in nested subdirectories', () => {
    // A file exists deep in the tree — expert is not stale
    mkdirSync(join(fixtureDir, 'modules', 'Parent', 'Child', 'GrandChild'), { recursive: true });
    writeFileSync(
      join(fixtureDir, 'modules', 'Parent', 'Child', 'GrandChild', 'deep.ts'),
      'export const x = 1;'
    );

    const experts = [makeExpert({ mount_path: 'modules/Parent' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(0);
  });

  it('should ignore hidden files when checking for files recursively', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Hidden'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Hidden', '.gitkeep'), '');

    const experts = [makeExpert({ mount_path: 'modules/Hidden' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toContain('no files');
  });

  it('should ignore hidden files in nested subdirectories', () => {
    mkdirSync(join(fixtureDir, 'modules', 'HiddenDeep', 'sub'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'HiddenDeep', 'sub', '.gitkeep'), '');

    const experts = [makeExpert({ mount_path: 'modules/HiddenDeep' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
  });

  it('should not flag when hidden files coexist with visible files', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Mixed'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Mixed', '.gitkeep'), '');
    writeFileSync(join(fixtureDir, 'modules', 'Mixed', 'real.ts'), 'export const x = 1;');

    const experts = [makeExpert({ mount_path: 'modules/Mixed' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(0);
  });

  it('should handle multiple experts with mixed staleness', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Active'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'Empty'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Active', 'file.ts'), '');

    const experts = [
      makeExpert({ id: 1, slug: 'active', mount_path: 'modules/Active' }),
      makeExpert({ id: 2, slug: 'empty', mount_path: 'modules/Empty' }),
      makeExpert({ id: 3, slug: 'deleted', mount_path: 'modules/Deleted' }),
    ];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(2);
    expect(stale.map((s) => s.expert.slug)).toContain('empty');
    expect(stale.map((s) => s.expert.slug)).toContain('deleted');
  });

  it('should return empty array when no experts are stale', () => {
    mkdirSync(join(fixtureDir, 'modules', 'A'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'B'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'A', 'file.ts'), '');
    writeFileSync(join(fixtureDir, 'modules', 'B', 'file.ts'), '');

    const experts = [
      makeExpert({ id: 1, slug: 'a', mount_path: 'modules/A' }),
      makeExpert({ id: 2, slug: 'b', mount_path: 'modules/B' }),
    ];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(0);
  });

  it('should handle empty experts array', () => {
    const stale = detectStaleExperts([], fixtureDir);
    expect(stale).toHaveLength(0);
  });

  it('should handle expert with absolute mount path that does not exist', () => {
    const experts = [makeExpert({ mount_path: '/nonexistent/absolute/path' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toContain('does not exist');
  });

  it('should detect stale when only hidden subdirectories exist', () => {
    mkdirSync(join(fixtureDir, 'modules', 'OnlyDotDirs', '.git', 'objects'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'OnlyDotDirs', '.git', 'objects', 'pack'), '');

    const experts = [makeExpert({ mount_path: 'modules/OnlyDotDirs' })];

    const stale = detectStaleExperts(experts, fixtureDir);

    expect(stale).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// checkExpertStaleness
// ---------------------------------------------------------------------------

describe('checkExpertStaleness', () => {
  it('should return null for a healthy expert', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Healthy'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Healthy', 'file.ts'), '');

    const expert = makeExpert({ mount_path: 'modules/Healthy' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).toBeNull();
  });

  it('should return StaleExpert for non-existent mount path', () => {
    const expert = makeExpert({ mount_path: 'modules/Gone' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).not.toBeNull();
    expect(result!.expert.slug).toBe('existing-expert');
    expect(result!.reason).toContain('does not exist');
  });

  it('should return StaleExpert for empty mount path', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Empty'), { recursive: true });

    const expert = makeExpert({ mount_path: 'modules/Empty' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).not.toBeNull();
    expect(result!.reason).toContain('no files');
  });

  it('should return StaleExpert for directory with only empty subdirectories', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Hollow', 'a', 'b'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'Hollow', 'c'), { recursive: true });

    const expert = makeExpert({ mount_path: 'modules/Hollow' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).not.toBeNull();
    expect(result!.reason).toContain('no files');
  });

  it('should return null when files exist deep in subdirectories', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Deep', 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Deep', 'a', 'b', 'c', 'file.ts'), '');

    const expert = makeExpert({ mount_path: 'modules/Deep' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).toBeNull();
  });

  it('should return StaleExpert when only hidden files exist', () => {
    mkdirSync(join(fixtureDir, 'modules', 'OnlyHidden', 'sub'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'OnlyHidden', '.env'), '');
    writeFileSync(join(fixtureDir, 'modules', 'OnlyHidden', 'sub', '.gitignore'), '');

    const expert = makeExpert({ mount_path: 'modules/OnlyHidden' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).not.toBeNull();
    expect(result!.reason).toContain('no files');
  });

  it('should ignore hidden directories during recursive check', () => {
    mkdirSync(join(fixtureDir, 'modules', 'HiddenDir', '.hidden'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'HiddenDir', '.hidden', 'file.ts'), '');

    const expert = makeExpert({ mount_path: 'modules/HiddenDir' });
    const result = checkExpertStaleness(expert, fixtureDir);

    // The file exists but only inside a hidden directory — considered stale
    expect(result).not.toBeNull();
  });

  it('should return null when file exists at top level', () => {
    mkdirSync(join(fixtureDir, 'modules', 'TopLevel'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'TopLevel', 'index.ts'), '');

    const expert = makeExpert({ mount_path: 'modules/TopLevel' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).toBeNull();
  });

  it('should include expert slug in the stale result', () => {
    const expert = makeExpert({ slug: 'my-expert', mount_path: 'modules/Missing' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).not.toBeNull();
    expect(result!.expert.slug).toBe('my-expert');
    expect(result!.expert.mount_path).toBe('modules/Missing');
  });

  it('should handle expert with mount path at content root level', () => {
    // Mount path is "." — the content root itself
    writeFileSync(join(fixtureDir, 'root-file.ts'), '');

    const expert = makeExpert({ mount_path: '.' });
    const result = checkExpertStaleness(expert, fixtureDir);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DiffResult summary
// ---------------------------------------------------------------------------

describe('DiffResult summary', () => {
  it('should describe new proposals', () => {
    const proposals = [makeProposal({ slug: 'auth', mountPath: 'modules/Auth' })];

    const result = diffProposals(proposals, [], { contentRoot: fixtureDir });

    expect(result.summary).toContain('1 new expert(s) proposed');
  });

  it('should describe boundary changes', () => {
    const proposals = [makeProposal({ slug: 'auth', mountPath: 'modules/Auth/Models' })];
    const experts = [makeExpert({ slug: 'auth-parent', mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth', 'Models'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'Models', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.summary).toContain('boundary change(s)');
  });

  it('should describe stale experts', () => {
    const experts = [makeExpert({ mount_path: 'modules/Gone' })];

    const result = diffProposals([], experts, { contentRoot: fixtureDir });

    expect(result.summary).toContain('stale expert(s) detected');
  });

  it('should report no changes when panel is up to date', () => {
    const proposals = [makeProposal({ mountPath: 'modules/Auth' })];
    const experts = [makeExpert({ mount_path: 'modules/Auth' })];

    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    // All proposals are duplicates, no stale experts
    expect(result.summary).toContain('duplicate(s) filtered');
  });

  it('should combine multiple status descriptions', () => {
    const proposals = [
      makeProposal({ slug: 'new-expert', mountPath: 'modules/New' }),
      makeProposal({ slug: 'existing', mountPath: 'modules/Existing' }),
    ];
    const experts = [
      makeExpert({ id: 1, slug: 'existing', mount_path: 'modules/Existing' }),
      makeExpert({ id: 2, slug: 'gone', mount_path: 'modules/Gone' }),
    ];

    mkdirSync(join(fixtureDir, 'modules', 'Existing'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Existing', 'file.ts'), '');

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    expect(result.summary).toContain('new expert(s)');
    expect(result.summary).toContain('duplicate(s)');
    expect(result.summary).toContain('stale expert(s)');
  });

  it('should end summary with a period', () => {
    const proposals = [makeProposal()];

    const result = diffProposals(proposals, [], { contentRoot: fixtureDir });

    expect(result.summary).toMatch(/\.$/);
  });

  it('should report no changes with em dash', () => {
    const result = diffProposals([], [], { contentRoot: fixtureDir });

    expect(result.summary).toContain('—');
    expect(result.summary).toContain('up to date');
  });
});

// ---------------------------------------------------------------------------
// End-to-end diff scenarios
// ---------------------------------------------------------------------------

describe('diff: end-to-end scenarios', () => {
  it('should handle a realistic rediscovery scenario', () => {
    // Setup: existing expert panel with some healthy, some stale
    mkdirSync(join(fixtureDir, 'modules', 'Auth'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'Billing'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'NewFeature'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'LoginController.php'), '');
    writeFileSync(join(fixtureDir, 'modules', 'Billing', 'Invoice.php'), '');
    writeFileSync(join(fixtureDir, 'modules', 'NewFeature', 'Feature.php'), '');
    // modules/OldFeature does NOT exist — expert is stale

    const experts = [
      makeExpert({ id: 1, slug: 'auth', mount_path: 'modules/Auth' }),
      makeExpert({ id: 2, slug: 'billing', mount_path: 'modules/Billing' }),
      makeExpert({ id: 3, slug: 'old-feature', mount_path: 'modules/OldFeature' }),
    ];

    // Rediscovery proposes: auth (unchanged), billing (unchanged), new-feature (new)
    const proposals = [
      makeProposal({ slug: 'auth', mountPath: 'modules/Auth', confidence: 0.92 }),
      makeProposal({ slug: 'billing', mountPath: 'modules/Billing', confidence: 0.88 }),
      makeProposal({ slug: 'new-feature', mountPath: 'modules/NewFeature', confidence: 0.85 }),
    ];

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    // Auth and Billing are duplicates (already registered)
    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates.map((d) => d.proposal.slug).sort()).toEqual(['auth', 'billing']);

    // NewFeature is new
    expect(result.newProposals).toHaveLength(1);
    expect(result.newProposals[0].proposal.slug).toBe('new-feature');

    // OldFeature is stale (directory doesn't exist)
    expect(result.staleExperts).toHaveLength(1);
    expect(result.staleExperts[0].expert.slug).toBe('old-feature');

    // No boundary changes
    expect(result.updatedProposals).toHaveLength(0);
  });

  it('should handle refactoring scenario where boundaries shift', () => {
    // Expert was at modules/Auth, rediscovery proposes splitting into sub-domains
    mkdirSync(join(fixtureDir, 'modules', 'Auth', 'OAuth'), { recursive: true });
    mkdirSync(join(fixtureDir, 'modules', 'Auth', 'Session'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'OAuth', 'Provider.ts'), '');
    writeFileSync(join(fixtureDir, 'modules', 'Auth', 'Session', 'Manager.ts'), '');

    const experts = [makeExpert({ id: 1, slug: 'auth', mount_path: 'modules/Auth' })];

    const proposals = [
      makeProposal({ slug: 'auth-oauth', mountPath: 'modules/Auth/OAuth', confidence: 0.88 }),
      makeProposal({ slug: 'auth-session', mountPath: 'modules/Auth/Session', confidence: 0.85 }),
    ];

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    // Both proposals narrow the scope of the existing auth expert
    expect(result.updatedProposals).toHaveLength(2);
    for (const update of result.updatedProposals) {
      expect(update.matchedExpert?.slug).toBe('auth');
      expect(update.reason).toContain('Narrows scope');
    }
  });

  it('should handle DiffResult JSON serialization correctly', () => {
    mkdirSync(join(fixtureDir, 'modules', 'Active'), { recursive: true });
    writeFileSync(join(fixtureDir, 'modules', 'Active', 'file.ts'), '');

    const experts = [
      makeExpert({ id: 1, slug: 'active', mount_path: 'modules/Active' }),
      makeExpert({ id: 2, slug: 'stale', mount_path: 'modules/Gone' }),
    ];

    const proposals = [
      makeProposal({ slug: 'new', mountPath: 'modules/New', confidence: 0.9 }),
      makeProposal({ slug: 'active-dup', mountPath: 'modules/Active', confidence: 0.85 }),
    ];

    const result = diffProposals(proposals, experts, { contentRoot: fixtureDir });

    // Serialize and deserialize (simulates --json output)
    const json = JSON.parse(JSON.stringify(result));

    expect(json.newProposals).toHaveLength(1);
    expect(json.duplicates).toHaveLength(1);
    expect(json.staleExperts).toHaveLength(1);
    expect(json.summary).toBeTruthy();
    expect(json.newProposals[0].proposal.slug).toBe('new');
    expect(json.newProposals[0].status).toBe('new');
    expect(json.duplicates[0].matchedExpert.slug).toBe('active');
    expect(json.staleExperts[0].expert.slug).toBe('stale');
  });
});
