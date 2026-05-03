import { join, resolve } from 'path';

export interface RuntimePathOptions {
  corpus?: string;
  db?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface RuntimePathResolution {
  corpusPath: string;
  corpusSource: 'explicit' | 'env' | 'cwd';
  dbPath: string;
  dbSource: 'explicit' | 'env' | 'repo-local';
}

export function resolveCorpusPath(options: RuntimePathOptions = {}): string {
  return resolveRuntimePaths(options).corpusPath;
}

export function resolveDbPath(options: RuntimePathOptions = {}): string {
  return resolveRuntimePaths(options).dbPath;
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePathResolution {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const corpusSource = options.corpus ? 'explicit' : env.LUX_CORPUS_PATH ? 'env' : 'cwd';
  const corpusPath = resolve(options.corpus ?? env.LUX_CORPUS_PATH ?? cwd);

  if (options.db) {
    return {
      corpusPath,
      corpusSource,
      dbPath: resolve(options.db),
      dbSource: 'explicit',
    };
  }

  if (env.LUX_DB_PATH) {
    return {
      corpusPath,
      corpusSource,
      dbPath: resolve(env.LUX_DB_PATH),
      dbSource: 'env',
    };
  }

  return {
    corpusPath,
    corpusSource,
    dbPath: join(corpusPath, '.lux', 'lux.db'),
    dbSource: 'repo-local',
  };
}
