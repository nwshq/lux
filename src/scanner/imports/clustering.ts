// Re-export from canonical location in db/ layer.
// scanner/ is allowed to import from db/.
export { computeClusters } from '../../db/clustering.js';
export type { ModuleCluster, ClusterOptions } from '../../db/clustering.js';
