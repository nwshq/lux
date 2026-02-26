import { LuxDatabase } from '../../../dist/db/index.js';
import { SubprocessSessionManager } from '../../../dist/experts/subprocess-manager.js';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * Walk up from `startDir` looking for a directory containing `lux.yaml`.
 * Returns the project root, or null if none found.
 */
function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'lux.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveDbPath(): string {
  const root = process.env.LUX_ROOT ?? findProjectRoot(process.cwd());
  if (!root) {
    throw new Error(
      'Could not find a Lux project. Run `lux init` in your project root, or set LUX_ROOT.',
    );
  }
  const dbDir = join(root, '.lux');
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, 'lux.db');
}

const DB_PATH = resolveDbPath();

let db: LuxDatabase | null = null;
let sessionManager: SubprocessSessionManager | null = null;

export function getLuxDatabase(): LuxDatabase {
  if (!db) {
    db = new LuxDatabase(DB_PATH);
  }
  return db;
}

export function getSessionManager(): SubprocessSessionManager {
  if (!sessionManager) {
    sessionManager = new SubprocessSessionManager(getLuxDatabase());
  }
  return sessionManager;
}

// Graceful shutdown
function cleanup() {
  if (sessionManager) {
    sessionManager.terminateAll();
  }
  if (db) {
    db.close();
  }
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
