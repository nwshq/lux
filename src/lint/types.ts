export type Severity = 'error' | 'warning' | 'info';

export interface LintResult {
  path: string;
  rule: string;
  severity: Severity;
  message: string;
  suggestion?: string;
  autoFixable?: boolean;
}

export interface LintFile {
  path: string;
  relativePath: string;
  isDirectory: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface LintRule {
  name: string;
  description: string;
  severity: Severity;
  check(file: LintFile, corpusPath: string): LintResult[];
}
