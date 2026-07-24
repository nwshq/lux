// src/mcp/anchor-tool-args.ts
//
// Pure argument coercion for the `lux_anchors` MCP tool, factored OUT of server.ts (which constructs a
// DB + stdio transport at module load, so it can't be imported in a unit test). Mirrors the codebase's
// existing side-effect-free split (tool-defs.ts, coerceSearchLimit): the wire handler stays thin and the
// coercion is tested directly. Every field is coerced defensively — `lux_anchors` is exposed to a
// prompt-injectable agent, so an out-of-enum / wrong-type value must resolve to the safe default rather
// than throw on the warm resident server. (The CLI, a human surface, errors on a bad value instead —
// that CLI-vs-MCP divergence is intentional and documented.)

export interface AnchorToolArgs {
  query: string;
  limit: number;
  granularity: 'node' | 'file';
  includeTests: boolean;
}

export function coerceAnchorToolArgs(args: unknown): AnchorToolArgs {
  const a = (args ?? {}) as Record<string, unknown>;
  const query = typeof a.query === 'string' ? a.query : '';
  // Positive-integer limit; a non-number / non-finite / < 1 value (a string "5", 0, -3, 2.9→trunc) falls
  // back to the default 10 rather than reaching `LIMIT ?`.
  const rawLimit = a.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.trunc(rawLimit)
      : 10;
  // Enum coercion: only the exact string 'file' selects file granularity; everything else (incl. the
  // capitalized 'File', a typo, a non-string) is the default 'node'.
  const granularity: 'node' | 'file' = a.granularity === 'file' ? 'file' : 'node';
  // Strict boolean: only the boolean `true` includes tests; a truthy STRING "true" coerces to false, so
  // a mis-typed flag fails safe to the test-excluding default rather than silently including tests.
  const includeTests = a.include_tests === true;
  return { query, limit, granularity, includeTests };
}
