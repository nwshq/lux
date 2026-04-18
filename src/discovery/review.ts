import { createInterface } from 'readline';
import type { ProposedExpert, ReviewResult } from './types.js';

// ── I/O Interface ─────────────────────────────────────────

/**
 * Abstraction over terminal I/O for testability.
 * In production, reads from stdin and writes to stdout.
 * In tests, can be replaced with mock implementations.
 */
export interface ReviewIO {
  write(text: string): void;
  prompt(question: string): Promise<string>;
  close(): void;
}

/**
 * Create a ReviewIO backed by Node.js readline (stdin/stdout).
 */
function createTerminalIO(): ReviewIO {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    write(text: string) {
      process.stdout.write(text);
    },
    prompt(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer.trim());
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

// ── Formatting ────────────────────────────────────────────

/**
 * Format the summary table of all proposals.
 * Exported for testing.
 */
export function formatProposalTable(proposals: ProposedExpert[]): string {
  const lines: string[] = [];
  lines.push(
    `Expert Discovery Results (${proposals.length} proposal${proposals.length !== 1 ? 's' : ''})`
  );
  lines.push('');

  // Calculate column widths
  const slugWidth = Math.max(4, ...proposals.map((p) => p.slug.length));
  const mountWidth = Math.max(10, ...proposals.map((p) => p.mountPath.length));

  // Header
  lines.push(
    `  ${'#'.padEnd(4)}${'Slug'.padEnd(slugWidth + 2)}${'Mount Path'.padEnd(mountWidth + 2)}Confidence`
  );

  // Rows
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const num = String(i + 1).padEnd(4);
    const slug = p.slug.padEnd(slugWidth + 2);
    const mount = p.mountPath.padEnd(mountWidth + 2);
    lines.push(`  ${num}${slug}${mount}${p.confidence.toFixed(2)}`);
  }

  return lines.join('\n');
}

/**
 * Format a single proposal for detailed review.
 * Exported for testing.
 */
export function formatProposalDetail(proposal: ProposedExpert, index: number): string {
  const lines: string[] = [];
  lines.push(`Review proposal ${index + 1}: ${proposal.slug}`);
  lines.push(`  Name: ${proposal.name}`);
  lines.push(`  Mount: ${proposal.mountPath}`);
  if (proposal.additionalPaths && proposal.additionalPaths.length > 0) {
    lines.push(`  Additional paths: ${proposal.additionalPaths.join(', ')}`);
  }
  lines.push(`  Description: ${proposal.description}`);
  lines.push(`  Confidence: ${proposal.confidence.toFixed(2)}`);
  if (proposal.boundaryBasis) {
    lines.push(`  Boundary basis: ${proposal.boundaryBasis}`);
  }
  if (proposal.structuralRationale) {
    lines.push(`  Structural rationale: ${proposal.structuralRationale}`);
  }
  return lines.join('\n');
}

// ── Edit Flow ─────────────────────────────────────────────

/**
 * Interactively edit a proposal's fields.
 * Returns a new ProposedExpert with the edited values.
 * Exported for testing.
 */
export async function editProposal(
  proposal: ProposedExpert,
  io: ReviewIO
): Promise<ProposedExpert> {
  io.write('\n  Edit fields (press Enter to keep current value):\n');

  const slug = await promptWithDefault(io, '  Slug', proposal.slug);
  const name = await promptWithDefault(io, '  Name', proposal.name);
  const mountPath = await promptWithDefault(io, '  Mount path', proposal.mountPath);
  const description = await promptWithDefault(io, '  Description', proposal.description);

  return {
    ...proposal,
    slug,
    name,
    mountPath,
    description,
  };
}

async function promptWithDefault(io: ReviewIO, label: string, current: string): Promise<string> {
  const answer = await io.prompt(`${label} [${current}]: `);
  return answer.length > 0 ? answer : current;
}

// ── Public API ────────────────────────────────────────────

/**
 * Stage 4: Interactive review.
 *
 * Presents proposals one at a time and prompts the operator for an action:
 *   [a] Accept — register as proposed
 *   [e] Edit   — modify slug, name, mount path, or description
 *   [s] Skip   — do not register this expert
 *   [q] Quit   — stop reviewing, register accepted so far
 *
 * When `io` is not provided, uses stdin/stdout via readline.
 */
export async function review(proposals: ProposedExpert[], io?: ReviewIO): Promise<ReviewResult> {
  if (proposals.length === 0) {
    return { accepted: [], skipped: [] };
  }

  const ownIO = !io;
  if (!io) {
    io = createTerminalIO();
  }

  const accepted: ProposedExpert[] = [];
  const skipped: ProposedExpert[] = [];

  try {
    // Show summary table
    io.write('\n' + formatProposalTable(proposals) + '\n');
    io.write('\nActions for each proposal:\n');
    io.write('  [a] Accept — register as proposed\n');
    io.write('  [e] Edit   — modify slug, name, mount path, or description\n');
    io.write('  [s] Skip   — do not register this expert\n');
    io.write('  [q] Quit   — stop reviewing, register accepted so far\n');

    for (let i = 0; i < proposals.length; i++) {
      io.write('\n' + formatProposalDetail(proposals[i], i) + '\n');

      let action: string;
      while (true) {
        const raw = await io.prompt('\n  Action [a/e/s/q]: ');
        action = raw.toLowerCase();

        if (action === 'a' || action === 'e' || action === 's' || action === 'q') {
          break;
        }
        io.write('  Invalid action. Please enter a, e, s, or q.\n');
      }

      if (action === 'q') {
        // Quit — skip remaining proposals
        for (let j = i; j < proposals.length; j++) {
          skipped.push(proposals[j]);
        }
        break;
      }

      if (action === 'a') {
        accepted.push(proposals[i]);
      } else if (action === 'e') {
        const edited = await editProposal(proposals[i], io);
        accepted.push(edited);
      } else {
        // action === 's'
        skipped.push(proposals[i]);
      }
    }
  } finally {
    if (ownIO) {
      io.close();
    }
  }

  return { accepted, skipped };
}
