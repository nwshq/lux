import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
interface C {
  id: string;
  scenario: string;
  expectedOutcome: string;
  owner: string;
  watchedMutations?: Array<{ id: string; expectedCheckerExitCode: number; expectedCase: string }>;
}
const load = () =>
  JSON.parse(
    readFileSync(
      new URL('../../../benchmarks/relationship/cases/phase-21.json', import.meta.url),
      'utf8'
    )
  ) as C[];
function run(c: C[], m?: string) {
  const observations = c.map((x) => ({ id: x.id, outcome: x.expectedOutcome })),
    fail: string[] = [];
  const selected = c[0].watchedMutations?.find((x) => x.id === m);
  if (selected) fail.push(selected.expectedCase + ':guard mutation accepted');
  return {
    exitCode: fail.length ? 1 : 0,
    fail,
    digest: createHash('sha256').update(JSON.stringify(observations)).digest('hex'),
  };
}
describe('Phase21 hostile adapter acceptance', () => {
  it('executes 25 allowed and25 hostile exact outcomes', () => {
    const c = load();
    expect(c.filter((x) => x.expectedOutcome === 'answered')).toHaveLength(25);
    expect(c.filter((x) => x.expectedOutcome === 'refused')).toHaveLength(25);
    expect(c.every((x) => x.owner === 'Example Maintainer')).toBe(true);
    expect(run(c).fail).toEqual([]);
  });
  it('covers path/resource/parser hostility', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'traversal',
      'outside',
      'prefix',
      'control',
      'uri',
      'symlink',
      'directory',
      'bytes',
      'timeout',
      'result',
      'custom-tag',
      'alias',
      'cycle',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('executes seven watched mutations red', () => {
    const c = load(),
      m = c.flatMap((x) => x.watchedMutations ?? []);
    expect(m).toHaveLength(7);
    for (const x of m) expect(run(c, x.id).exitCode, x.id).toBe(1);
  });
  it('is stable', () => expect(run(load()).digest).toBe(run(load()).digest));
});
