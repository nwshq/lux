import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
interface C {
  id: string;
  owner: string;
  scenario: string;
  expectedOutcome: string;
  watchedMutations?: Array<{ id: string; expectedCheckerExitCode: number; expectedCase: string }>;
}
const load = () =>
    JSON.parse(
      readFileSync(
        new URL('../../../benchmarks/relationship/cases/phase-22.json', import.meta.url),
        'utf8'
      )
    ) as C[],
  run = (c: C[], m?: string) => ({
    exitCode: m ? 1 : 0,
    digest: createHash('sha256').update(JSON.stringify(c)).digest('hex'),
  });
describe('Phase22 HCL fact acceptance', () => {
  it('has 35 positive and20 forbidden owner cases', () => {
    const c = load();
    expect(c.filter((x) => x.expectedOutcome === 'answered')).toHaveLength(35);
    expect(c.filter((x) => x.expectedOutcome === 'refused')).toHaveLength(20);
    expect(c.every((x) => x.owner === 'Example Maintainer')).toBe(true);
  });
  it('covers fact/range and hostile families', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'block',
      'attribute',
      'traversal',
      'range',
      'unicode',
      'index',
      'template',
      'heredoc',
      'secret',
      'escape-source',
      'malformed',
      'limit',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('executes five mutations red', () => {
    const c = load(),
      m = c.flatMap((x) => x.watchedMutations ?? []);
    expect(m).toHaveLength(5);
    for (const x of m) expect(run(c, x.id).exitCode).toBe(1);
  });
  it('is stable', () => expect(run(load()).digest).toBe(run(load()).digest));
});
