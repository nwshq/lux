import type { SourceDiagnosticV1, SourceFactsV1 } from '../contracts/program.js';
import { astLanguageId, langForFile } from '../ast/extract.js';
import { DEFAULT_PARSER_LIMITS, type AdapterInputV1, type SourceAdapterV1 } from './types.js';
import { runBoundedParserWorker } from './worker-host.js';

export const TREE_SITTER_PRODUCERS = {
  php: 'php-tree-sitter',
  typescript: 'typescript-tree-sitter',
  javascript: 'javascript-tree-sitter',
} as const;

function emptyFacts(input: AdapterInputV1, diagnostic: SourceDiagnosticV1): SourceFactsV1 {
  const lang = langForFile(input.filePath);
  return {
    schemaVersion: 1,
    languageId: lang ? astLanguageId(lang) : 'unknown',
    filePath: input.filePath,
    declarations: [],
    references: [],
    diagnostics: [diagnostic],
  };
}

function adapter(id: string, languages: readonly string[]): SourceAdapterV1 {
  return {
    id,
    languages,
    async extract(input) {
      const boundedInput: AdapterInputV1 = {
        ...input,
        limits: { ...DEFAULT_PARSER_LIMITS, ...input.limits },
      };
      const response = await runBoundedParserWorker({
        schemaVersion: 1,
        adapterId: id,
        input: boundedInput,
      });
      if (response.ok) return response.output;
      const diagnostic: SourceDiagnosticV1 = response.diagnostic;
      return {
        facts: emptyFacts(boundedInput, diagnostic),
        dependencies: [boundedInput.filePath],
        diagnostics: [diagnostic],
      };
    },
  };
}

const phpTreeSitterAdapter = adapter(TREE_SITTER_PRODUCERS.php, ['php']);
const typescriptTreeSitterAdapter = adapter(TREE_SITTER_PRODUCERS.typescript, [
  'typescript',
  'tsx',
]);
const javascriptTreeSitterAdapter = adapter(TREE_SITTER_PRODUCERS.javascript, [
  'javascript',
  'jsx',
]);

const DEFAULT_SOURCE_ADAPTERS: readonly SourceAdapterV1[] = [
  phpTreeSitterAdapter,
  typescriptTreeSitterAdapter,
  javascriptTreeSitterAdapter,
];

export function sourceAdapterForLanguage(language: string): SourceAdapterV1 | undefined {
  return DEFAULT_SOURCE_ADAPTERS.find((candidate) => candidate.languages.includes(language));
}
