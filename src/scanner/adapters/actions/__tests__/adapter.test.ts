import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractActionFacts } from '../adapter.js';
import { DEFAULT_PARSER_LIMITS } from '../../types.js';
describe('Actions adapter', () =>
  it('extracts static uses/run/artifacts and refuses expressions', async () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-actions-')),
      p = join(r, '.github/workflows/ci.yml');
    mkdirSync(join(r, '.github/workflows'), { recursive: true });
    writeFileSync(
      p,
      `name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./scripts/test.sh\n      - uses: \${{ matrix.action }}\n`
    );
    const o = extractActionFacts({
      corpusRoot: r,
      allowedRoots: [r],
      filePath: p,
      limits: DEFAULT_PARSER_LIMITS,
    });
    expect(o.facts.filter((x) => x.family === 'uses')).toHaveLength(1);
    expect(o.facts.some((x) => x.family === 'run')).toBe(true);
    expect(o.diagnostics[0].code).toBe('actions-computed-target');
    rmSync(r, { recursive: true });
  }));
