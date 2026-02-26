import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { LuxDatabase } from '../db/index.js';
import type { ProposedExpert, DiscoveryOptions, RegisteredExpert } from './types.js';

// ── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// ── Claude MD Stub ────────────────────────────────────────

/**
 * Generate a claude.md stub for a newly registered expert.
 * Exported for testing.
 */
export function generateClaudeMdStub(name: string, description: string): string {
  return `---
role: expert
domain: ${name}
---

# ${name}

${description}

## Responsibilities

- [To be refined based on usage]

## Key Concepts

- [To be populated as the expert answers queries]
`;
}

/**
 * Detect an existing claude.md at a mount path.
 * Checks both claude.md and CLAUDE.md.
 * Exported for testing.
 */
export function detectClaudeMd(mountPath: string): string | undefined {
  const lowercase = join(mountPath, 'claude.md');
  if (existsSync(lowercase)) return lowercase;
  const uppercase = join(mountPath, 'CLAUDE.md');
  if (existsSync(uppercase)) return uppercase;
  return undefined;
}

// ── Public API ────────────────────────────────────────────

/**
 * Stage 5: Registration.
 *
 * For each accepted proposal:
 * 1. Resolves the mount path relative to the content root
 * 2. Generates a claude.md stub if none exists at the mount path
 * 3. Inserts an expert record into the database
 * 4. Returns the list of successfully registered experts
 */
export function register(
  accepted: ProposedExpert[],
  db: LuxDatabase,
  options: DiscoveryOptions
): RegisteredExpert[] {
  const registered: RegisteredExpert[] = [];

  for (const proposal of accepted) {
    const mountPath = resolve(options.rootPath, proposal.mountPath);

    // Ensure the mount directory exists
    if (!existsSync(mountPath)) {
      mkdirSync(mountPath, { recursive: true });
    }

    // Generate claude.md stub if none exists
    let claudeMdPath = detectClaudeMd(mountPath);
    if (!claudeMdPath) {
      claudeMdPath = join(mountPath, 'claude.md');
      const stub = generateClaudeMdStub(proposal.name, proposal.description);
      writeFileSync(claudeMdPath, stub, 'utf-8');
    }

    // Detect memory.md
    const memoryMdPath = join(mountPath, 'memory.md');
    const detectedMemory = existsSync(memoryMdPath) ? memoryMdPath : undefined;

    // Insert expert record
    db.insertExpert({
      slug: proposal.slug,
      name: proposal.name,
      mount_path: mountPath,
      model: options.model ?? DEFAULT_MODEL,
      claude_md_path: claudeMdPath,
      memory_path: detectedMemory,
    });

    registered.push({
      slug: proposal.slug,
      mountPath,
      claudeMdPath,
    });
  }

  return registered;
}
