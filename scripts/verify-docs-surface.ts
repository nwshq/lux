#!/usr/bin/env npx tsx
/**
 * Docs-surface drift guard — asserts the human-facing MCP tool lists never drift from the tool set
 * the MCP server actually registers.
 *
 * v2.11.0's review found the repo's three MCP surface lists had silently drifted from the
 * registered tool set (CLAUDE.md was four tools behind). This check makes that drift structurally
 * impossible: the authoritative names come from the SAME `TOOLS` array the ListTools handler
 * exposes (src/mcp/tool-defs.ts — imported, never re-parsed), and each doc list is asserted against
 * it in BOTH directions.
 *
 * Checked docs (each must list EXACTLY the registered set — no more, no less):
 *   - docs/MCP-TOOLS.md                       — whole doc (per-tool `## ` headings + the bullet list)
 *   - README.md   "Current MCP surface"       — that section only
 *   - CLAUDE.md   "Current MCP surface"        — that section only
 *
 * The canonical Agent Skill is also checked in both useful directions: every tool identifier it
 * references must be registered, and every investigation route required below must be present.
 *
 * What counts as a "claim": only markdown HEADINGS and LIST ITEMS (outside fenced code blocks).
 * Body prose is explicitly NOT a claim — this is the principled, structural reason MCP-TOOLS.md may
 * say in a prose paragraph that `lux_usage_event` is an internal event type and not a tool, without
 * the guard mistaking it for a claimed tool. No hardcoded exception list.
 *
 * Usage:
 *   npx tsx scripts/verify-docs-surface.ts [--json]
 *
 * Exit codes:
 *   0 — every doc list matches the registry exactly
 *   1 — a registered tool is missing from a doc, a doc lists a non-registered tool, or a required
 *       section is absent
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { TOOLS } from '../src/mcp/tool-defs.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? '.', '..');

/** A `lux_*` tool-like identifier. Underscore-suffixed so `lux.yaml` / `lux delta` never match. */
const TOOL_TOKEN = /lux_[a-z_]+/g;

interface DocTarget {
  /** Path relative to the repo root. */
  path: string;
  /**
   * Heading text to scope claim extraction to (matched case-sensitively against the heading's text,
   * to the next heading of equal-or-higher level), or `null` to scan the whole file. README/CLAUDE
   * carry unrelated `lux_*` mentions in other sections' prose, so they MUST be section-scoped;
   * MCP-TOOLS.md is wholly about the tool surface, so it is scanned whole.
   */
  section: string | null;
  /** How the doc is named in violation messages. */
  label: string;
}

const DOCS: DocTarget[] = [
  {
    path: 'docs/MCP-TOOLS.md',
    section: null,
    label: 'docs/MCP-TOOLS.md',
  },
  {
    path: 'README.md',
    section: 'Current MCP surface',
    label: 'README.md "Current MCP surface"',
  },
  {
    path: 'CLAUDE.md',
    section: 'Current MCP surface',
    label: 'CLAUDE.md "Current MCP surface"',
  },
];

const SKILL_PATH = 'skills/lux-code-intel/SKILL.md';
const REQUIRED_SKILL_TOOL_NAMES = [
  'lux_search',
  'lux_spec_derivation_evidence',
  'lux_trace',
  'lux_anchors',
  'lux_delta',
  'lux_deps_impact',
  'lux_overlay_status',
  'lux_index_status',
];
const REQUIRED_SKILL_FRONTMATTER = {
  name: 'lux-code-intel',
  description: /\S/,
};

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  /** True when the line falls inside a fenced code block (``` or ~~~) — never a claim. */
  inFence: boolean;
}

/** Annotate each line with whether it sits inside a fenced code block. The fence line itself is
 *  marked in-fence so its own text (e.g. an info string) is never mistaken for a claim. */
function parseLines(content: string): Line[] {
  const lines: Line[] = [];
  let inFence = false;
  for (const text of content.split('\n')) {
    const isFenceMarker = /^\s*(```|~~~)/.test(text);
    if (isFenceMarker) {
      lines.push({ text, inFence: true });
      inFence = !inFence;
      continue;
    }
    lines.push({ text, inFence });
  }
  return lines;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*([-*+]|\d+\.)\s+/;

/**
 * Slice the lines belonging to the section whose heading text === `section`: from the heading line
 * through the line before the next heading of equal-or-higher level. Fence-aware, so a `#` comment
 * inside a code block can never be mistaken for a section boundary. Returns null if not found.
 */
function sliceSection(lines: Line[], section: string): Line[] | null {
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].inFence) continue;
    const m = HEADING_RE.exec(lines[i].text);
    if (m && m[2].trim() === section) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].inFence) continue;
    const m = HEADING_RE.exec(lines[i].text);
    if (m && m[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx);
}

/**
 * Extract the set of `lux_*` claim tokens from a run of lines: tokens appearing in a markdown
 * HEADING or LIST ITEM, outside fenced code blocks. Prose paragraphs, blockquotes and code fences
 * contribute nothing — the structural rule that lets doc prose discuss non-tool `lux_*` identifiers
 * (e.g. the `lux_usage_event` event type) without the guard treating them as claimed tools.
 */
function extractClaims(lines: Line[]): Set<string> {
  const claims = new Set<string>();
  for (const line of lines) {
    if (line.inFence) continue;
    const isClaimLine = HEADING_RE.test(line.text) || LIST_ITEM_RE.test(line.text);
    if (!isClaimLine) continue;
    const tokens = line.text.match(TOOL_TOKEN);
    if (tokens) for (const t of tokens) claims.add(t);
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

interface Violation {
  doc: string;
  message: string;
}

function checkDoc(registered: Set<string>, target: DocTarget): Violation[] {
  const violations: Violation[] = [];
  const absPath = resolve(ROOT, target.path);

  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return [{ doc: target.label, message: `cannot read ${target.path}` }];
  }

  const allLines = parseLines(content);
  let scopeLines: Line[];
  if (target.section === null) {
    scopeLines = allLines;
  } else {
    const sliced = sliceSection(allLines, target.section);
    if (sliced === null) {
      return [
        {
          doc: target.label,
          message: `could not find a "## ${target.section}" section in ${target.path}`,
        },
      ];
    }
    scopeLines = sliced;
  }

  const claimed = extractClaims(scopeLines);

  // Forward: every registered tool must be claimed by the doc.
  for (const name of registered) {
    if (!claimed.has(name)) {
      violations.push({
        doc: target.label,
        message: `registered tool "${name}" is not listed`,
      });
    }
  }

  // Reverse: every tool-like name claimed by the doc must be registered.
  for (const name of claimed) {
    if (!registered.has(name)) {
      violations.push({
        doc: target.label,
        message: `lists "${name}", which is not a registered MCP tool`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function checkSkill(registered: Set<string>): Violation[] {
  let content: string;
  try {
    content = readFileSync(resolve(ROOT, SKILL_PATH), 'utf8');
  } catch {
    return [{ doc: SKILL_PATH, message: `cannot read ${SKILL_PATH}` }];
  }

  const claimed = new Set(content.match(TOOL_TOKEN) ?? []);
  const violations: Violation[] = [];
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)?.[1] ?? '';
  const skillName = /^name:\s*(.+)$/m.exec(frontmatter)?.[1].trim();
  const skillDescription = /^description:\s*(.+)$/m.exec(frontmatter)?.[1].trim() ?? '';
  if (skillName !== REQUIRED_SKILL_FRONTMATTER.name) {
    violations.push({
      doc: SKILL_PATH,
      message: `frontmatter name must be "${REQUIRED_SKILL_FRONTMATTER.name}"`,
    });
  }
  if (!REQUIRED_SKILL_FRONTMATTER.description.test(skillDescription)) {
    violations.push({ doc: SKILL_PATH, message: 'frontmatter description must be non-empty' });
  }

  for (const name of REQUIRED_SKILL_TOOL_NAMES) {
    if (!registered.has(name)) {
      violations.push({
        doc: SKILL_PATH,
        message: `requires "${name}", which is not a registered MCP tool`,
      });
    }
    if (!claimed.has(name)) {
      violations.push({ doc: SKILL_PATH, message: `does not route to required tool "${name}"` });
    }
  }
  for (const name of claimed) {
    if (!registered.has(name)) {
      violations.push({
        doc: SKILL_PATH,
        message: `references "${name}", which is not a registered MCP tool`,
      });
    }
  }
  return violations;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const registered = new Set(TOOLS.map((t) => t.name));

  const violations = [
    ...DOCS.flatMap((doc) => checkDoc(registered, doc)),
    ...checkSkill(registered),
  ];

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          registeredTools: [...registered],
          violations,
          summary: {
            docsChecked: DOCS.length + 1,
            registeredCount: registered.size,
            violationCount: violations.length,
            clean: violations.length === 0,
          },
        },
        null,
        2
      )
    );
    process.exit(violations.length > 0 ? 1 : 0);
  }

  if (violations.length === 0) {
    console.log(
      `Docs-surface check passed. ${registered.size} registered MCP tools match all ` +
        `${DOCS.length} doc lists (${DOCS.map((d) => d.path).join(', ')}); ` +
        `${SKILL_PATH} references only registered tools and covers its required investigation routes.`
    );
    process.exit(0);
  }

  console.error('\nDocs-surface drift found:\n');
  for (const v of violations) {
    console.error(`  ${v.doc}`);
    console.error(`    ${v.message}`);
    console.error('');
  }
  console.error(
    `${violations.length} violation(s). The MCP tool lists must match the registry in ` +
      `src/mcp/tool-defs.ts exactly — update the drifted doc list(s) above.`
  );
  process.exit(1);
}

main();
