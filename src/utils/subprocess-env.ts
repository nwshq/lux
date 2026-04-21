/**
 * Builds a clean, minimal environment for expert subprocesses.
 *
 * Filters the source env through an explicit allowlist so that expert
 * subprocesses are fully decoupled from the calling context (CLI, MCP,
 * API, or another agent). This prevents vars like CLAUDECODE from
 * triggering nested-session guards in spawned `claude --print` processes.
 */

const EXACT_ALLOWLIST = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'TMPDIR']);

const PREFIX_ALLOWLIST = [
  'LANG', // LANG, LANGUAGE
  'LC_', // LC_ALL, LC_CTYPE, etc.
  'XDG_', // XDG_CONFIG_HOME, XDG_DATA_HOME, etc.
  'ANTHROPIC_', // ANTHROPIC_API_KEY, etc.
  'OPENAI_', // OPENAI_API_KEY, etc.
  'AZURE_OPENAI_', // Azure OpenAI auth/base-url config
  'GEMINI_', // GEMINI_API_KEY, etc.
  'GOOGLE_', // GOOGLE_API_KEY and related provider config
  'OPENROUTER_', // OPENROUTER_API_KEY
  'AI_GATEWAY_', // Vercel AI Gateway auth
  'XAI_', // xAI Grok auth
  'MISTRAL_', // Mistral auth
  'CEREBRAS_', // Cerebras auth
  'GROQ_', // Groq auth
  'KIMI_', // Kimi auth
  'OPENCODE_', // OpenCode provider auth
  'ZAI_', // ZAI auth
  'MINIMAX_', // MiniMax auth
  'AWS_', // Bedrock auth/region
  'PI_', // Pi session/config variables
];

export function buildCleanEnv(
  source: Record<string, string | undefined> = process.env
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
