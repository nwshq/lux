import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig } from './config.js';
import { resolveFirstPartyRoots } from './pack/first-party.js';

export const STRUCTURAL_CONFIG_FINGERPRINT_KEY = 'structural_config_fingerprint';

/**
 * `sha256` over the raw bytes of `lux.yaml` (whole file — over-escalation is the safe direction),
 * the raw bytes of `composer.lock` when present, the applied `schema_version`, and the sorted
 * realpaths of resolved first-party roots (Decision 7). A cosmetic YAML edit costs one full
 * rebuild; a missed input would silently under-escalate (the dangerous direction), so the whole
 * file is hashed.
 */
export function computeStructuralConfigFingerprint(rootPath: string, db: LuxDatabase): string {
  const h = createHash('sha256');

  h.update('lux.yaml\0');
  const luxYaml = join(rootPath, 'lux.yaml');
  h.update(existsSync(luxYaml) ? readFileSync(luxYaml) : Buffer.from('<absent>'));

  h.update('\0composer.lock\0');
  const composerLock = join(rootPath, 'composer.lock');
  h.update(existsSync(composerLock) ? readFileSync(composerLock) : Buffer.from('<absent>'));

  h.update('\0schema_version\0');
  h.update(String(db.getAppliedSchemaVersion()));

  h.update('\0firstPartyRoots\0');
  const config = loadLspConfig(rootPath);
  const roots = (
    config.firstParty ? resolveFirstPartyRoots(rootPath, config.firstParty.packages) : []
  )
    .map((r) => {
      try {
        return realpathSync(r.sourceRoot);
      } catch {
        return r.sourceRoot;
      }
    })
    .sort();
  h.update(roots.join('|'));

  return h.digest('hex');
}

/** Persist the fingerprint — call after EVERY full rebuild (Decision 7). */
export function persistStructuralConfigFingerprint(rootPath: string, db: LuxDatabase): void {
  db.setIndexMetadata(
    STRUCTURAL_CONFIG_FINGERPRINT_KEY,
    computeStructuralConfigFingerprint(rootPath, db)
  );
}

/** True when the current config matches the fingerprint recorded at the last full rebuild. */
export function structuralConfigFingerprintMatches(rootPath: string, db: LuxDatabase): boolean {
  const stored = db.getIndexMetadata(STRUCTURAL_CONFIG_FINGERPRINT_KEY);
  if (!stored) return false; // never recorded ⇒ escalate (safe direction)
  return stored === computeStructuralConfigFingerprint(rootPath, db);
}
