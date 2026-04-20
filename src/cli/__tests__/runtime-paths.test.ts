import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { resolveCorpusPath, resolveDbPath } from '../../utils/runtime-paths.js';

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
});
