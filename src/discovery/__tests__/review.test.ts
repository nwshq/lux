import { describe, it, expect, vi } from 'vitest';
import { review, formatProposalTable, formatProposalDetail, editProposal } from '../review.js';
import type { ReviewIO } from '../review.js';
import type { ProposedExpert } from '../types.js';

// ── Fixtures ──────────────────────────────────────────────

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

/**
 * Create a mock ReviewIO that responds to prompts with the given answers.
 * Answers are consumed in order; excess prompts return 'a' (accept).
 */
function createMockIO(answers: string[]): ReviewIO & { output: string[] } {
  let answerIndex = 0;
  const output: string[] = [];

  return {
    output,
    write(text: string) {
      output.push(text);
    },
    prompt(_question: string): Promise<string> {
      const answer = answerIndex < answers.length ? answers[answerIndex] : 'a';
      answerIndex++;
      return Promise.resolve(answer);
    },
    close: vi.fn(),
  };
}

// ══════════════════════════════════════════════════════════════
// formatProposalTable
// ══════════════════════════════════════════════════════════════

describe('formatProposalTable', () => {
  it('shows the count of proposals', () => {
    const table = formatProposalTable([makeProposal(), makeProposal({ slug: 'auth' })]);
    expect(table).toContain('2 proposals');
  });

  it('uses singular "proposal" for one item', () => {
    const table = formatProposalTable([makeProposal()]);
    expect(table).toContain('1 proposal)');
  });

  it('includes slug, mount path, and confidence for each entry', () => {
    const table = formatProposalTable([
      makeProposal({ slug: 'invoicing', mountPath: 'modules/Invoicing/', confidence: 0.92 }),
    ]);
    expect(table).toContain('invoicing');
    expect(table).toContain('modules/Invoicing/');
    expect(table).toContain('0.92');
  });

  it('includes a header row', () => {
    const table = formatProposalTable([makeProposal()]);
    expect(table).toContain('Slug');
    expect(table).toContain('Mount Path');
    expect(table).toContain('Confidence');
  });

  it('numbers each row starting from 1', () => {
    const table = formatProposalTable([
      makeProposal({ slug: 'first' }),
      makeProposal({ slug: 'second' }),
    ]);
    expect(table).toContain('1');
    expect(table).toContain('2');
  });
});

// ══════════════════════════════════════════════════════════════
// formatProposalDetail
// ══════════════════════════════════════════════════════════════

describe('formatProposalDetail', () => {
  it('includes the proposal slug and 1-based index', () => {
    const detail = formatProposalDetail(makeProposal(), 0);
    expect(detail).toContain('Review proposal 1: invoicing');
  });

  it('includes name, mount, description, and confidence', () => {
    const detail = formatProposalDetail(makeProposal(), 0);
    expect(detail).toContain('Name: Invoicing System');
    expect(detail).toContain('Mount: modules/Invoicing/');
    expect(detail).toContain('Description: Manages invoice creation');
    expect(detail).toContain('Confidence: 0.92');
  });

  it('includes additional paths when present', () => {
    const detail = formatProposalDetail(
      makeProposal({ additionalPaths: ['lib/billing/', 'lib/payments/'] }),
      0
    );
    expect(detail).toContain('Additional paths: lib/billing/, lib/payments/');
  });

  it('omits additional paths when not present', () => {
    const detail = formatProposalDetail(makeProposal(), 0);
    expect(detail).not.toContain('Additional paths');
  });
});

// ══════════════════════════════════════════════════════════════
// editProposal
// ══════════════════════════════════════════════════════════════

describe('editProposal', () => {
  it('returns edited values when user provides input', async () => {
    const io = createMockIO(['new-slug', 'New Name', 'new/path/', 'New description.']);
    const original = makeProposal();
    const edited = await editProposal(original, io);

    expect(edited.slug).toBe('new-slug');
    expect(edited.name).toBe('New Name');
    expect(edited.mountPath).toBe('new/path/');
    expect(edited.description).toBe('New description.');
  });

  it('keeps original values when user presses Enter (empty input)', async () => {
    const io = createMockIO(['', '', '', '']);
    const original = makeProposal();
    const edited = await editProposal(original, io);

    expect(edited.slug).toBe(original.slug);
    expect(edited.name).toBe(original.name);
    expect(edited.mountPath).toBe(original.mountPath);
    expect(edited.description).toBe(original.description);
  });

  it('preserves non-editable fields (reasoning, confidence, additionalPaths)', async () => {
    const io = createMockIO(['', '', '', '']);
    const original = makeProposal({
      reasoning: 'Keep this.',
      confidence: 0.75,
      additionalPaths: ['extra/'],
    });
    const edited = await editProposal(original, io);

    expect(edited.reasoning).toBe('Keep this.');
    expect(edited.confidence).toBe(0.75);
    expect(edited.additionalPaths).toEqual(['extra/']);
  });

  it('allows partial edits (only some fields changed)', async () => {
    const io = createMockIO(['custom-slug', '', '', 'Custom description.']);
    const original = makeProposal();
    const edited = await editProposal(original, io);

    expect(edited.slug).toBe('custom-slug');
    expect(edited.name).toBe(original.name);
    expect(edited.mountPath).toBe(original.mountPath);
    expect(edited.description).toBe('Custom description.');
  });
});

// ══════════════════════════════════════════════════════════════
// review: accept action
// ══════════════════════════════════════════════════════════════

describe('review: accept action', () => {
  it('accepts a single proposal', async () => {
    const io = createMockIO(['a']);
    const proposals = [makeProposal()];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].slug).toBe('invoicing');
    expect(result.skipped).toHaveLength(0);
  });

  it('accepts all proposals when user always picks "a"', async () => {
    const io = createMockIO(['a', 'a', 'a']);
    const proposals = [
      makeProposal({ slug: 'one' }),
      makeProposal({ slug: 'two' }),
      makeProposal({ slug: 'three' }),
    ];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// review: skip action
// ══════════════════════════════════════════════════════════════

describe('review: skip action', () => {
  it('skips a single proposal', async () => {
    const io = createMockIO(['s']);
    const proposals = [makeProposal()];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].slug).toBe('invoicing');
  });

  it('mixes accept and skip', async () => {
    const io = createMockIO(['a', 's', 'a']);
    const proposals = [
      makeProposal({ slug: 'accepted1' }),
      makeProposal({ slug: 'skipped1' }),
      makeProposal({ slug: 'accepted2' }),
    ];
    const result = await review(proposals, io);

    expect(result.accepted.map((p) => p.slug)).toEqual(['accepted1', 'accepted2']);
    expect(result.skipped.map((p) => p.slug)).toEqual(['skipped1']);
  });
});

// ══════════════════════════════════════════════════════════════
// review: quit action
// ══════════════════════════════════════════════════════════════

describe('review: quit action', () => {
  it('quits immediately and skips all proposals', async () => {
    const io = createMockIO(['q']);
    const proposals = [makeProposal({ slug: 'one' }), makeProposal({ slug: 'two' })];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
  });

  it('accepts first then quits, skipping remaining', async () => {
    const io = createMockIO(['a', 'q']);
    const proposals = [
      makeProposal({ slug: 'accepted' }),
      makeProposal({ slug: 'skipped1' }),
      makeProposal({ slug: 'skipped2' }),
    ];
    const result = await review(proposals, io);

    expect(result.accepted.map((p) => p.slug)).toEqual(['accepted']);
    expect(result.skipped.map((p) => p.slug)).toEqual(['skipped1', 'skipped2']);
  });

  it('registers accepted proposals before quitting', async () => {
    const io = createMockIO(['a', 'a', 'q']);
    const proposals = [
      makeProposal({ slug: 'one' }),
      makeProposal({ slug: 'two' }),
      makeProposal({ slug: 'three' }),
      makeProposal({ slug: 'four' }),
    ];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(2);
    expect(result.skipped).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════
// review: edit action
// ══════════════════════════════════════════════════════════════

describe('review: edit action', () => {
  it('allows editing then accepting a proposal', async () => {
    // 'e' to edit, then four field prompts (new-slug, enter, enter, enter)
    const io = createMockIO(['e', 'new-slug', '', '', '']);
    const proposals = [makeProposal({ slug: 'original' })];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].slug).toBe('new-slug');
  });
});

// ══════════════════════════════════════════════════════════════
// review: edge cases
// ══════════════════════════════════════════════════════════════

describe('review: edge cases', () => {
  it('returns empty result for empty proposals array', async () => {
    const result = await review([]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('handles invalid input by re-prompting', async () => {
    // 'x' is invalid, then 'blah', then 'a' is valid
    const io = createMockIO(['x', 'blah', 'a']);
    const proposals = [makeProposal()];
    const result = await review(proposals, io);

    expect(result.accepted).toHaveLength(1);
    // Should have written error messages
    const output = io.output.join('');
    expect(output).toContain('Invalid action');
  });

  it('shows the summary table in output', async () => {
    const io = createMockIO(['a']);
    const proposals = [makeProposal()];
    await review(proposals, io);

    const output = io.output.join('');
    expect(output).toContain('Expert Discovery Results');
    expect(output).toContain('invoicing');
  });

  it('shows action instructions in output', async () => {
    const io = createMockIO(['a']);
    await review([makeProposal()], io);

    const output = io.output.join('');
    expect(output).toContain('[a] Accept');
    expect(output).toContain('[e] Edit');
    expect(output).toContain('[s] Skip');
    expect(output).toContain('[q] Quit');
  });

  it('does not call close() on externally provided IO', async () => {
    const io = createMockIO(['a']);
    await review([makeProposal()], io);

    expect(io.close).not.toHaveBeenCalled();
  });
});
