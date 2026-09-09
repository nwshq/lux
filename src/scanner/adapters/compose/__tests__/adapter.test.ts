import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractComposeFacts } from '../adapter.js';
import { DEFAULT_PARSER_LIMITS } from '../../types.js';
describe('Compose static facts', () =>
  it('parses image, build and dependencies as data', () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-compose-')),
      p = join(r, 'compose.yml');
    writeFileSync(
      p,
      'services:\n  api:\n    image: app:1\n    depends_on: [db]\n  db:\n    image: postgres:16'
    );
    const o = extractComposeFacts({
      corpusRoot: r,
      allowedRoots: [r],
      filePath: p,
      limits: DEFAULT_PARSER_LIMITS,
    });
    expect(o.facts.filter((x) => x.family === 'service')).toHaveLength(2);
    expect(o.facts.some((x) => x.family === 'dependency')).toBe(true);
    rmSync(r, { recursive: true });
  }));
