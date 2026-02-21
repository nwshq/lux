/**
 * Builds a clean, minimal environment for expert subprocesses.
 *
 * Filters the source env through an explicit allowlist so that expert
 * subprocesses are fully decoupled from the calling context (CLI, MCP,
 * API, or another agent). This prevents vars like CLAUDECODE from
 * triggering nested-session guards in spawned `claude --print` processes.
 */

const EXACT_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'TMPDIR',
]);

const PREFIX_ALLOWLIST = [
  'LANG',     // LANG, LANGUAGE
  'LC_',      // LC_ALL, LC_CTYPE, etc.
  'XDG_',     // XDG_CONFIG_HOME, XDG_DATA_HOME, etc.
  'ANTHROPIC_', // ANTHROPIC_API_KEY, etc.
];

export function buildCleanEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (EXACT_ALLOWLIST.has(key)) {
      clean[key] = value;
      continue;
    }

    for (const prefix of PREFIX_ALLOWLIST) {
      if (key.startsWith(prefix)) {
        clean[key] = value;
        break;
      }
    }
  }

  return clean;
}
