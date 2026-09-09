import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const path = join(process.cwd(), 'src/scanner/adapters/hcl/tree-sitter-hcl.wasm'),
  expected = '86bb80cd151bd3ab1e44ed431a9c1874978db31519c62055efb50f028a1d0118',
  actual = createHash('sha256').update(readFileSync(path)).digest('hex');
if (actual !== expected) {
  console.error(`HCL parser asset digest mismatch: ${actual}`);
  process.exit(1);
}
console.log(`HCL parser asset verified: ${actual}`);
