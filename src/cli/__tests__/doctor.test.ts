import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
import { buildIndexStatusPayload } from '../status-payload.js';
import { buildDoctorPayload } from '../doctor.js';

describe('doctor payload parity', () => {
  const roots: string[] = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  );

  it('is exactly the index status payload, including coverage.languages', () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-doctor-'));
    roots.push(root);
    const path = join(root, 'lux.db');
    const db = new LuxDatabase(path);
    const runtime = {
      corpusPath: root,
      corpusSource: 'explicit' as const,
      dbPath: path,
      dbSource: 'explicit' as const,
    };
    expect(buildDoctorPayload(db, runtime)).toEqual(buildIndexStatusPayload(db, runtime));
    expect(buildDoctorPayload(db, runtime).coverage.languages).toBeInstanceOf(Array);
    db.close();
  });
});
