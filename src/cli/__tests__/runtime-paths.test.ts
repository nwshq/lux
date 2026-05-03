import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  resolveCorpusPath,
  resolveDbPath,
  resolveRuntimePaths,
} from '../../utils/runtime-paths.js';

describe('runtime path resolution', () => {
  it('defaults corpus to current working directory', () => {
    const cwd = '/tmp/lux-repo';
    expect(resolveCorpusPath({ cwd, env: {} })).toBe(cwd);
  });

  it('defaults db to <corpus>/.lux/lux.db', () => {
    const corpus = '/tmp/lux-repo';
    expect(resolveDbPath({ corpus, env: {} })).toBe(join(corpus, '.lux', 'lux.db'));
  });

  it('prefers explicit db override', () => {
    expect(resolveDbPath({ corpus: '/tmp/lux-repo', db: '/tmp/custom.db', env: {} })).toBe(
      '/tmp/custom.db'
    );
  });

  it('prefers env db override when explicit db is absent', () => {
    expect(
      resolveDbPath({
        corpus: '/tmp/lux-repo',
        env: { LUX_DB_PATH: '/tmp/from-env.db' },
      })
    ).toBe('/tmp/from-env.db');
  });

  it('reports explicit/env/cwd corpus and explicit/env/repo-local db sources', () => {
    expect(resolveRuntimePaths({ corpus: '/tmp/lux-repo', db: '/tmp/custom.db', env: {} })).toEqual(
      {
        corpusPath: '/tmp/lux-repo',
        corpusSource: 'explicit',
        dbPath: '/tmp/custom.db',
        dbSource: 'explicit',
      }
    );

    expect(
      resolveRuntimePaths({
        cwd: '/tmp/cwd-repo',
        env: { LUX_CORPUS_PATH: '/tmp/env-repo', LUX_DB_PATH: '/tmp/env.db' },
      })
    ).toEqual({
      corpusPath: '/tmp/env-repo',
      corpusSource: 'env',
      dbPath: '/tmp/env.db',
      dbSource: 'env',
    });

    expect(resolveRuntimePaths({ cwd: '/tmp/cwd-repo', env: {} })).toEqual({
      corpusPath: '/tmp/cwd-repo',
      corpusSource: 'cwd',
      dbPath: join('/tmp/cwd-repo', '.lux', 'lux.db'),
      dbSource: 'repo-local',
    });
  });
});
