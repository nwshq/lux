import { join, resolve } from 'path';

export interface RuntimePathOptions {
  corpus?: string;
  db?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function resolveCorpusPath(options: RuntimePathOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const raw = options.corpus ?? env.LUX_CORPUS_PATH ?? cwd;
  return resolve(raw);
}

export function resolveDbPath(options: RuntimePathOptions = {}): string {
  const env = options.env ?? process.env;

  if (options.db) {
    return resolve(options.db);
  }

  if (env.LUX_DB_PATH) {
    return resolve(env.LUX_DB_PATH);
  }

  return join(resolveCorpusPath(options), '.lux', 'lux.db');
}
