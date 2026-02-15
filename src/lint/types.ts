export type Severity = 'error' | 'warning' | 'info';

export interface LintResult {
  path: string;
  rule: string;
  severity: Severity;
  message: string;
  suggestion?: string;
}

export interface LintFile {
  path: string;
  relativePath: string;
  isDirectory: boolean;
}

export interface LintRule {
  name: string;
  description: string;
  severity: Severity;
  check(file: LintFile, corpusPath: string): LintResult[];
}
