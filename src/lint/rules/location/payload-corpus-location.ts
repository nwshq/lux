import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Detects payload directories at the CORPUS root level and flags them as errors.
 *
 * Payloads must be project-scoped, living under:
 *   knowledge/10_clients/{client}/{project}/payloads/{payload}/
 *
 * Finding them at the CORPUS root (payloads/{payload}/) is an error.
 */

function isPayloadDir(relativePath: string): boolean {
  const parts = relativePath.replace(/\/$/, '').split('/');
  return parts.length >= 2 && parts[parts.length - 2] === 'payloads';
}

function isCorpusLevel(relativePath: string): boolean {
  const normalised = relativePath.replace(/\/$/, '');
  return normalised.startsWith('payloads/') && normalised.split('/').length === 2;
}

export const payloadCorpusLocation: LintRule = {
  name: 'payload-corpus-location',
  description: 'Payload directories must be project-scoped, not at the CORPUS root',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    if (!file.isDirectory) return [];
    if (!isPayloadDir(file.relativePath)) return [];
    if (!isCorpusLevel(file.relativePath)) return [];

    const dirname = file.relativePath.replace(/\/$/, '').split('/').pop()!;

    return [
      {
        path: file.path,
        rule: this.name,
        severity: this.severity,
        message: `Payload "${dirname}" is at the CORPUS root — payloads must be project-scoped`,
        suggestion: `Move to knowledge/10_clients/{client}/{project}/payloads/${dirname}/`,
      },
    ];
  },
};
