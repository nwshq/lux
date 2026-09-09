import { describe, expect, it } from 'vitest';
import { resolveInfrastructureFederation } from '../resolver.js';
describe('infrastructure federation', () => {
  it('emits only explicit existing evidence-backed mappings', () => {
    const o = resolveInfrastructureFederation({
      exportsByRepo: new Map(),
      mappings: [
        {
          fromRepo: 'main',
          fromId: 'package:npm:x',
          toRepo: 'infra',
          toId: 'resource:terraform:.#aws_x.y',
          edgeType: 'produces_artifact',
          evidenceFile: 'deploy/map.yml',
        },
      ],
      nodeExists: () => true,
      evidenceExists: () => true,
    });
    expect(o.edges[0]).toMatchObject({
      authorization: 'explicit-mapping',
      confidenceClass: 'artifact-backed',
    });
  });
  it('refuses mutable mutual image tags', () => {
    const e = (repo: string) => ({
      schemaVersion: 1 as const,
      repo,
      repoCommit: 'a',
      indexSchemaVersion: 1,
      configFingerprint: 'f',
      id: 'artifact:container-image:app%3Alatest',
      evidenceFile: 'e',
    });
    const o = resolveInfrastructureFederation({
      exportsByRepo: new Map([
        ['a', [e('a')]],
        ['b', [e('b')]],
      ]),
      mappings: [],
      nodeExists: () => true,
      evidenceExists: () => true,
    });
    expect(o.edges).toEqual([]);
  });
});

describe('federation hostility', () => {
  it('rejects duplicate mappings and cycles', () => {
    const m = {
        fromRepo: 'a',
        fromId: 'package:npm:a',
        toRepo: 'b',
        toId: 'package:npm:b',
        edgeType: 'produces_artifact' as const,
        evidenceFile: 'map.yml',
      },
      base = { exportsByRepo: new Map(), nodeExists: () => true, evidenceExists: () => true };
    expect(resolveInfrastructureFederation({ ...base, mappings: [m, m] }).edges).toEqual([]);
    const reverse = {
      ...m,
      fromRepo: 'b',
      fromId: 'package:npm:b',
      toRepo: 'a',
      toId: 'package:npm:a',
    };
    const o = resolveInfrastructureFederation({ ...base, mappings: [m, reverse] });
    expect(o.edges).toHaveLength(1);
    expect(o.diagnostics).toContain('mapping-cycle');
  });
  it('requires current clean export state and confined evidence', () => {
    const x = {
        schemaVersion: 1 as const,
        repo: 'a',
        repoCommit: 'old',
        indexSchemaVersion: 1,
        configFingerprint: 'f',
        id: 'package:npm:x',
        evidenceFile: 'export.yml',
      },
      y = { ...x, repo: 'b', repoCommit: 'new' },
      o = resolveInfrastructureFederation({
        exportsByRepo: new Map([
          ['a', [x]],
          ['b', [y]],
        ]),
        mappings: [],
        nodeExists: () => true,
        evidenceExists: () => true,
        repositoryState: new Map([
          ['a', { commit: 'new', schemaVersion: 1, configFingerprint: 'f', clean: true }],
          ['b', { commit: 'new', schemaVersion: 1, configFingerprint: 'f', clean: true }],
        ]),
      });
    expect(o.edges).toEqual([]);
  });
});
