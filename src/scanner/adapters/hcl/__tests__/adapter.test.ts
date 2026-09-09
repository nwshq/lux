import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HclArtifactAdapter } from '../adapter.js';
import { DEFAULT_PARSER_LIMITS } from '../../types.js';
describe('HCL artifact facts', () => {
  it('extracts exact blocks, safe source and traversals while suppressing defaults', async () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-hcl-')),
      p = join(r, 'main.tf');
    writeFileSync(
      p,
      'variable "token" { default = "secret" }\nmodule "db" { source = "./modules/db" value = var.region }'
    );
    const o = await new HclArtifactAdapter().extract({
      corpusRoot: r,
      allowedRoots: [r],
      filePath: p,
      limits: DEFAULT_PARSER_LIMITS,
    });
    expect(o.artifactFacts.filter((x) => x.family === 'hcl-block')).toHaveLength(2);
    expect(o.dependencies).toEqual(['modules/db']);
    expect(JSON.stringify(o)).not.toContain('secret');
    expect(o.facts.references.some((x) => x.rawTarget === 'var.region')).toBe(true);
    rmSync(r, { recursive: true });
  });
  it('reports malformed syntax', async () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-hcl-')),
      p = join(r, 'bad.tf');
    writeFileSync(p, 'resource "x" {');
    const o = await new HclArtifactAdapter().extract({
      corpusRoot: r,
      allowedRoots: [r],
      filePath: p,
      limits: DEFAULT_PARSER_LIMITS,
    });
    expect(o.diagnostics.some((x) => x.code === 'parse-error')).toBe(true);
    rmSync(r, { recursive: true });
  });
});
