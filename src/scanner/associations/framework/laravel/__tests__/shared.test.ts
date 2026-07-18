import { describe, it, expect } from 'vitest';
import { resolvePhpClassReference, type LaravelPhpEntry } from '../shared.js';

function entry(imports: Record<string, string>, namespace?: string): LaravelPhpEntry {
  return {
    filePath: 'x.php',
    content: '',
    namespace,
    imports: new Map(Object.entries(imports)),
    classes: [],
  };
}

describe('resolvePhpClassReference (operational resolver)', () => {
  it('E3: expands a namespace-alias use import on the first segment', () => {
    // `use App\Jobs\Api;` then `Api\GetClientTokenJob::class`
    expect(
      resolvePhpClassReference('Api\\GetClientTokenJob', entry({ Api: 'App\\Jobs\\Api' }))
    ).toBe('App\\Jobs\\Api\\GetClientTokenJob');
  });

  it('E3: strips ::class / new before expanding the alias', () => {
    expect(resolvePhpClassReference('Api\\FooJob::class', entry({ Api: 'App\\Jobs\\Api' }))).toBe(
      'App\\Jobs\\Api\\FooJob'
    );
    expect(resolvePhpClassReference('new Api\\FooJob', entry({ Api: 'App\\Jobs\\Api' }))).toBe(
      'App\\Jobs\\Api\\FooJob'
    );
  });

  it('leaves a fully-qualified ref whose head is not an imported namespace unchanged', () => {
    expect(resolvePhpClassReference('App\\Jobs\\FooJob', entry({}))).toBe('App\\Jobs\\FooJob');
  });

  it('resolves a bare imported class name (exact import — unchanged behavior)', () => {
    expect(resolvePhpClassReference('FooJob', entry({ FooJob: 'App\\Jobs\\FooJob' }))).toBe(
      'App\\Jobs\\FooJob'
    );
  });

  it('prefixes a bare unimported class with the file namespace (unchanged behavior)', () => {
    expect(resolvePhpClassReference('FooJob', entry({}, 'App\\Domain'))).toBe(
      'App\\Domain\\FooJob'
    );
  });
});
