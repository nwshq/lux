import { describe, expect, it } from 'vitest';
import { resolveTerraformGraph } from '../resolver.js';
const r = (filePath: string) => ({
  filePath,
  line: 1,
  column: 0,
  endLine: 1,
  endColumn: 1,
  startByte: 0,
  endByte: 1,
});
describe('Terraform static graph', () =>
  it('materializes module declarations and same-module references', () => {
    const facts: any[] = [
      {
        schemaVersion: 1,
        family: 'hcl-block',
        localId: 'vpc',
        filePath: 'main.tf',
        range: r('main.tf'),
        blockKind: 'resource',
        labels: ['aws_vpc', 'main'],
      },
      {
        schemaVersion: 1,
        family: 'hcl-block',
        localId: 'subnet',
        filePath: 'main.tf',
        range: r('main.tf'),
        blockKind: 'resource',
        labels: ['aws_subnet', 'x'],
      },
      {
        schemaVersion: 1,
        family: 'hcl-traversal',
        localId: 'ref',
        filePath: 'main.tf',
        range: r('main.tf'),
        ownerLocalId: 'subnet',
        root: 'aws_vpc',
        segments: [],
        baseAddress: 'aws_vpc.main',
        fullyStatic: true,
      },
    ];
    const o = resolveTerraformGraph(facts);
    expect(o.nodes).toHaveLength(3);
    expect(o.edges.map((e) => e.edgeType).sort()).toEqual(
      ['declares_resource', 'declares_resource', 'references_resource'].sort()
    );
  }));
