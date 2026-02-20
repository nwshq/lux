import type { LintFile, LintResult, LintRule } from '../../types.js';

/**
 * Validates that payloads are in project-scoped locations.
 *
 * Valid:   knowledge/10_clients/nwshq/projects/workstream/payloads/2026-02-15-feature/
 * Invalid: implementation-payloads/2026-02-15-feature/
 *          payloads/2026-02-15-feature/
 */

const PROJECT_PAYLOAD_PATTERN = /^knowledge\/.*\/projects\/[^/]+\/payloads\/[^/]+\/?$/;

function isPayloadDir(relativePath: string): boolean {
  const parts = relativePath.replace(/\/$/, '').split('/');
  return parts.length >= 2 && parts[parts.length - 2] === 'payloads';
}

export const payloadLocation: LintRule = {
  name: 'payload-location',
  description:
    'Payloads must be in project-scoped locations (knowledge/.../projects/<name>/payloads/)',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    if (!file.isDirectory) return [];
    if (!isPayloadDir(file.relativePath)) return [];

    // Check if it matches the valid project-scoped pattern
    if (PROJECT_PAYLOAD_PATTERN.test(file.relativePath)) {
      return [];
    }

    // It's a payload directory but not in the right location
    const dirname = file.relativePath.replace(/\/$/, '').split('/').pop();

    let message: string;
    let suggestion: string;

    if (file.relativePath.startsWith('implementation-payloads/')) {
      message = `Payload "${dirname}" is in deprecated location implementation-payloads/`;
      suggestion = 'Move to knowledge/10_clients/<client>/projects/<project>/payloads/';
    } else if (file.relativePath.match(/^payloads\//)) {
      message = `Payload "${dirname}" is at CORPUS root, not project-scoped`;
      suggestion = 'Move to knowledge/10_clients/<client>/projects/<project>/payloads/';
    } else {
      message = `Payload "${dirname}" is not in a valid project location`;
      suggestion = 'Payloads must be in knowledge/.../projects/<name>/payloads/';
    }

    return [
      {
        path: file.path,
        rule: this.name,
        severity: this.severity,
        message,
        suggestion,
      },
    ];
  },
};
