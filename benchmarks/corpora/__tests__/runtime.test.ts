import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCheckoutOverrides, withBenchmarkCorpora } from '../runtime.js';
import type { CorpusManifestV1 } from '../preflight.js';

const roots: string[] = [];
function temp(prefix = 'lux-runner-barrier-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
}
function repository(parent: string, id: string, remoteOwner = 'nwshq') {
  const root = join(parent, id);
  execFileSync('git', ['init', '-q', root]);
  git(root, 'config', 'user.email', 'runner-test@example.com');
  git(root, 'config', 'user.name', 'Runner Test');
  git(root, 'remote', 'add', 'origin', `https://github.com/${remoteOwner}/${id}.git`);
  writeFileSync(join(root, 'fixture.txt'), `${id}\n`);
  git(root, 'add', 'fixture.txt');
  git(root, 'commit', '-q', '-m', 'fixture');
  return { root, commit: git(root, 'rev-parse', 'HEAD') };
}
function entry(repository: { root: string; commit: string }, id: string) {
  return {
    id,
    remote: `https://github.com/nwshq/${id}.git`,
    checkoutHints: [repository.root],
    commit: repository.commit,
    fixtureSchemaVersion: 1,
    goldSchemaVersion: 1,
    minimumCases: 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('benchmark real-corpus runtime gate', () => {
  it('uses a global barrier: valid first + invalid second produces zero runtime calls or output', async () => {
    const root = temp();
    const first = repository(root, 'first');
    const second = repository(root, 'second', 'other');
    const manifest: CorpusManifestV1 = {
      schemaVersion: 1,
      owner: 'Example Maintainer',
      corpora: [entry(first, 'first'), entry(second, 'second')],
    };
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const output = join(root, 'result-output');
    const calls = { db: 0, spawn: 0, status: 0, scanner: 0, case: 0 };

    await expect(
      withBenchmarkCorpora({ corpusIds: ['first', 'second'], manifestPath }, () => {
        calls.db++;
        calls.spawn++;
        calls.status++;
        calls.scanner++;
        calls.case++;
        writeFileSync(output, 'should not exist');
      })
    ).rejects.toMatchObject({ code: 'corpus.remote-mismatch' });
    expect(calls).toEqual({ db: 0, spawn: 0, status: 0, scanner: 0, case: 0 });
    expect(existsSync(output)).toBe(false);
  });

  it('loads only strict path-string override maps', () => {
    const root = temp();
    const valid = join(root, 'valid.json');
    writeFileSync(valid, JSON.stringify({ lux: '~/Code/lux/vcs' }));
    expect(loadCheckoutOverrides(valid)).toEqual({ lux: '~/Code/lux/vcs' });

    for (const [name, value] of [
      ['array', []],
      ['object-value', { lux: { path: '/tmp/lux' } }],
      ['unsafe-id', { '../lux': '/tmp/lux' }],
      ['empty', { lux: '' }],
    ] as const) {
      const path = join(root, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      expect(() => loadCheckoutOverrides(path)).toThrow(/Checkout override/u);
    }
  });
});
