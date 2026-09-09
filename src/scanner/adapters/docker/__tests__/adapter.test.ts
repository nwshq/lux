import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDockerFacts } from '../adapter.js';
import { DEFAULT_PARSER_LIMITS } from '../../types.js';
describe('Docker static facts', () =>
  it('parses stages and static copies without execution', () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-docker-')),
      p = join(r, 'Dockerfile');
    writeFileSync(p, 'FROM node:20 AS build\nCOPY package.json /app/\nCMD ["node","app.js"]');
    const o = extractDockerFacts({
      corpusRoot: r,
      allowedRoots: [r],
      filePath: p,
      limits: DEFAULT_PARSER_LIMITS,
    });
    expect(o.facts).toHaveLength(3);
    rmSync(r, { recursive: true });
  }));
