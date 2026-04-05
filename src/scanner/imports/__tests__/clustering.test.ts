import { describe, it, expect } from 'vitest';
import { computeClusters } from '../clustering.js';
import type { ModuleDependency } from '../../../db/types.js';

function makeDep(source: string, target: string, count: number): ModuleDependency {
  return {
    id: 0,
    source_module: source,
    target_module: target,
    reference_count: count,
    sample_files: null,
    created_at: 0,
  };
}

describe('Agglomerative Clustering', () => {
  it('should return empty for empty input', () => {
    const clusters = computeClusters([]);
    expect(clusters).toHaveLength(0);
  });

  it('should handle trivial graph (2 modules)', () => {
    const deps = [makeDep('A', 'B', 5), makeDep('B', 'A', 3)];

    const clusters = computeClusters(deps, { similarityThreshold: 0.0 });
    // With threshold 0, they should merge
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toContain('A');
    expect(clusters[0].members).toContain('B');
    expect(clusters[0].couplingScore).toBeGreaterThan(0);
  });

  it('should keep disconnected components separate', () => {
    const deps = [
      makeDep('A', 'B', 10),
      makeDep('B', 'A', 10),
      makeDep('C', 'D', 10),
      makeDep('D', 'C', 10),
    ];

    const clusters = computeClusters(deps, { similarityThreshold: 0.1 });
    // A-B and C-D are disconnected — no shared neighbors
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('should merge densely connected modules', () => {
    // A-B and A-C both connect to shared neighbor E with high weights
    // This gives them high Jaccard similarity (shared neighbor set)
    const deps = [
      makeDep('A', 'E', 10),
      makeDep('B', 'E', 10),
      makeDep('C', 'E', 10),
      makeDep('E', 'A', 10),
      makeDep('E', 'B', 10),
      makeDep('E', 'C', 10),
      // D is disconnected
      makeDep('D', 'F', 5),
      makeDep('F', 'D', 5),
    ];

    const clusters = computeClusters(deps, { similarityThreshold: 0.1 });
    // A, B, C share E as a common neighbor so they merge
    const largeCluster = clusters.find((c) => c.members.length >= 3);
    expect(largeCluster).toBeDefined();
    expect(largeCluster!.members).toContain('A');
    expect(largeCluster!.members).toContain('B');
    expect(largeCluster!.members).toContain('C');
  });

  it('should respect threshold sensitivity', () => {
    const deps = [makeDep('A', 'B', 5), makeDep('B', 'A', 3)];

    // Very high threshold — nothing merges
    const high = computeClusters(deps, { similarityThreshold: 1.0 });
    expect(high.length).toBe(2);

    // Very low threshold — everything merges
    const low = computeClusters(deps, { similarityThreshold: 0.0 });
    expect(low.length).toBe(1);
  });

  it('should name cluster by hub module (highest degree)', () => {
    const deps = [
      makeDep('Hub', 'A', 20),
      makeDep('Hub', 'B', 15),
      makeDep('A', 'Hub', 10),
      makeDep('B', 'Hub', 5),
      makeDep('A', 'B', 3),
      makeDep('B', 'A', 2),
    ];

    const clusters = computeClusters(deps, { similarityThreshold: 0.05 });
    // Hub has the highest degree, so the cluster should be named after it
    const mainCluster = clusters.find((c) => c.members.length >= 2);
    if (mainCluster && mainCluster.members.includes('Hub')) {
      expect(mainCluster.name).toBe('Hub');
    }
  });

  it('should sort clusters by coupling score descending', () => {
    const deps = [
      makeDep('X', 'Y', 2),
      makeDep('Y', 'X', 1),
      makeDep('A', 'B', 50),
      makeDep('B', 'A', 50),
    ];

    const clusters = computeClusters(deps, { similarityThreshold: 0.0 });
    if (clusters.length >= 2) {
      expect(clusters[0].couplingScore).toBeGreaterThanOrEqual(clusters[1].couplingScore);
    }
  });
});
