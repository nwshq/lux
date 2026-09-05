import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
import { buildIndexStatusPayload } from '../status-payload.js';
import { buildDoctorPayload, buildDoctorReport, inspectDoctorReport } from '../doctor.js';

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
    const report = buildDoctorReport(db, runtime);
    expect(report.status).toEqual(buildIndexStatusPayload(db, runtime));
    expect(report.checks.length).toBeGreaterThan(0);
    db.close();
  });

  it('diagnoses an absent index without creating it', () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-doctor-absent-'));
    roots.push(root);
    const path = join(root, '.lux', 'lux.db');
    const runtime = {
      corpusPath: root,
      corpusSource: 'explicit' as const,
      dbPath: path,
      dbSource: 'explicit' as const,
    };
    const report = inspectDoctorReport(runtime);
    expect(report.result).toBe('fail');
    expect(report.status).toBeNull();
    expect(report.checks.find((check) => check.id === 'index.presence')).toMatchObject({
      status: 'fail',
    });
    expect(() => readFileSync(path)).toThrow();
  });
});
