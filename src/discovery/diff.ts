// Diff logic for rediscovery mode.
//
// Compares discovery proposals against registered experts to surface
// only meaningful changes: new proposals, stale experts, and boundary
// changes. Used by `lux expert discover --diff`.

import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { Expert } from '../db/types.js';
import type { ProposedExpert } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of a proposed expert relative to registered experts. */
export type ProposalStatus = 'new' | 'updated' | 'duplicate';

/** A proposal annotated with its diff classification. */
export interface ClassifiedProposal {
  /** The proposed expert from AI analysis. */
  proposal: ProposedExpert;
  /** How this proposal relates to registered experts. */
  status: ProposalStatus;
  /** The existing expert this proposal matches, if any. */
  matchedExpert?: Expert;
  /** Why this classification was assigned. */
  reason: string;
}

/** An existing expert whose mount path appears stale. */
export interface StaleExpert {
  /** The registered expert. */
  expert: Expert;
  /** Why this expert is considered stale. */
  reason: string;
}

/** Result of diffing proposals against registered experts. */
export interface DiffResult {
  /** Proposals that cover new territory not handled by existing experts. */
  newProposals: ClassifiedProposal[];
  /** Proposals that suggest changes to existing expert boundaries. */
  updatedProposals: ClassifiedProposal[];
  /** Proposals that duplicate existing experts (filtered out). */
  duplicates: ClassifiedProposal[];
  /** Existing experts whose mount paths no longer contain files. */
  staleExperts: StaleExpert[];
  /** Summary of the diff for display. */
  summary: string;
}

/** Options for the diff operation. */
export interface DiffOptions {
  /** Absolute path to the content root directory. */
  contentRoot: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare discovery proposals against registered experts.
 *
 * Produces a structured diff that categorizes each proposal as new, updated,
 * or duplicate, and identifies stale experts whose mount paths no longer
 * contain files.
 *
 * @param proposals - Expert proposals from the discovery pipeline.
 * @param experts - Currently registered experts from the database.
 * @param options - Diff configuration (content root for stale detection).
 * @returns Categorized diff result.
 */
export function diffProposals(
  proposals: ProposedExpert[],
  experts: Expert[],
  options: DiffOptions
): DiffResult {
  const classified = classifyProposals(proposals, experts, options.contentRoot);
  const staleExperts = detectStaleExperts(experts, options.contentRoot);

  const newProposals = classified.filter((c) => c.status === 'new');
  const updatedProposals = classified.filter((c) => c.status === 'updated');
  const duplicates = classified.filter((c) => c.status === 'duplicate');

  const summary = buildSummary(newProposals, updatedProposals, duplicates, staleExperts);

  return { newProposals, updatedProposals, duplicates, staleExperts, summary };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify each proposal by matching against registered experts.
 *
 * Matching logic:
 * - **Exact match**: Proposal mount path equals an expert's mount path → duplicate
 * - **Contains match**: Proposal mount path is a subdirectory of an expert's
 *   mount path, or vice versa → updated (boundary change)
 * - **No match**: Proposal covers new territory → new
 */
function classifyProposals(
  proposals: ProposedExpert[],
  experts: Expert[],
  contentRoot: string
): ClassifiedProposal[] {
  return proposals.map((proposal) => {
    const normalizedProposalPath = normalizeMountPath(proposal.mountPath, contentRoot);

    // Check for exact mount path match
    const exactMatch = experts.find(
      (e) => normalizeMountPath(e.mount_path, contentRoot) === normalizedProposalPath
    );

    if (exactMatch) {
      return {
        proposal,
        status: 'duplicate' as const,
        matchedExpert: exactMatch,
        reason: `Matches existing expert '${exactMatch.slug}' at ${exactMatch.mount_path}`,
      };
    }

    // Check for overlapping mount paths (one contains the other)
    const overlapMatch = experts.find((e) => {
      const normalizedExpertPath = normalizeMountPath(e.mount_path, contentRoot);
      return (
        pathContains(normalizedExpertPath, normalizedProposalPath) ||
        pathContains(normalizedProposalPath, normalizedExpertPath)
      );
    });

    if (overlapMatch) {
      const normalizedExpertPath = normalizeMountPath(overlapMatch.mount_path, contentRoot);
      const isNarrower = pathContains(normalizedExpertPath, normalizedProposalPath);
      return {
        proposal,
        status: 'updated' as const,
        matchedExpert: overlapMatch,
        reason: isNarrower
          ? `Narrows scope of '${overlapMatch.slug}' (${overlapMatch.mount_path} → ${proposal.mountPath})`
          : `Widens scope of '${overlapMatch.slug}' (${overlapMatch.mount_path} → ${proposal.mountPath})`,
      };
    }

    // Slug match with different path — boundary has moved
    const slugMatch = experts.find((e) => e.slug === proposal.slug);

    if (slugMatch) {
      return {
        proposal,
        status: 'updated' as const,
        matchedExpert: slugMatch,
        reason: `Same slug '${slugMatch.slug}' but different mount path (${slugMatch.mount_path} → ${proposal.mountPath})`,
      };
    }

    return {
      proposal,
      status: 'new' as const,
      reason: 'No matching registered expert',
    };
  });
}

// ---------------------------------------------------------------------------
// Stale expert detection
// ---------------------------------------------------------------------------

/**
 * Detect experts whose mount paths no longer contain any files.
 *
 * An expert is considered stale if:
 * - Its mount path directory does not exist, OR
 * - Its mount path directory exists but contains no files anywhere
 *   in its subtree (recursively checked, ignoring hidden files)
 */
export function detectStaleExperts(experts: Expert[], contentRoot: string): StaleExpert[] {
  const stale: StaleExpert[] = [];

  for (const expert of experts) {
    const staleness = checkExpertStaleness(expert, contentRoot);
    if (staleness) {
      stale.push(staleness);
    }
  }

  return stale;
}

/**
 * Check whether a single expert is stale.
 *
 * Returns a StaleExpert if the expert is stale, or null if it is healthy.
 * Useful for checking individual experts outside of a full diff operation.
 */
export function checkExpertStaleness(expert: Expert, contentRoot: string): StaleExpert | null {
  const mountPath = resolve(contentRoot, expert.mount_path);

  if (!existsSync(mountPath)) {
    return {
      expert,
      reason: `Mount path does not exist: ${expert.mount_path}`,
    };
  }

  if (!containsFiles(mountPath)) {
    return {
      expert,
      reason: `Mount path contains no files: ${expert.mount_path}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a mount path to a relative, trailing-slash-free form.
 *
 * Handles both absolute paths and relative paths. Absolute paths are
 * made relative to the content root.
 */
function normalizeMountPath(mountPath: string, contentRoot: string): string {
  let normalized: string;

  if (mountPath.startsWith('/')) {
    normalized = relative(contentRoot, mountPath);
  } else {
    normalized = mountPath;
  }

  // Remove trailing slashes for consistent comparison
  return normalized.replace(/\/+$/, '');
}

/**
 * Check if parentPath contains childPath (childPath is a subdirectory).
 *
 * Both paths should be normalized relative paths without trailing slashes.
 */
function pathContains(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) return false;

  // Root path contains everything
  if (parentPath === '.' || parentPath === '') return true;

  return childPath.startsWith(parentPath + '/');
}

/**
 * Recursively check if a directory contains any non-hidden files.
 *
 * Returns true if at least one non-hidden file exists anywhere in the
 * directory tree. Hidden entries (dotfiles/dotdirs) are ignored at all
 * levels. Returns false for empty directories, directories containing
 * only hidden files, or directories containing only empty subdirectories.
 */
function containsFiles(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;

      const fullPath = join(dirPath, entry);

      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) return true;
        if (stat.isDirectory() && containsFiles(fullPath)) return true;
      } catch {
        // Entry is unreadable — skip it
        continue;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Build a human-readable summary of the diff result.
 */
function buildSummary(
  newProposals: ClassifiedProposal[],
  updatedProposals: ClassifiedProposal[],
  duplicates: ClassifiedProposal[],
  staleExperts: StaleExpert[]
): string {
  const parts: string[] = [];

  if (newProposals.length > 0) {
    parts.push(`${newProposals.length} new expert(s) proposed`);
  }
  if (updatedProposals.length > 0) {
    parts.push(`${updatedProposals.length} boundary change(s) suggested`);
  }
  if (duplicates.length > 0) {
    parts.push(`${duplicates.length} duplicate(s) filtered`);
  }
  if (staleExperts.length > 0) {
    parts.push(`${staleExperts.length} stale expert(s) detected`);
  }

  if (parts.length === 0) {
    return 'No changes detected — expert panel is up to date.';
  }

  return parts.join(', ') + '.';
}
