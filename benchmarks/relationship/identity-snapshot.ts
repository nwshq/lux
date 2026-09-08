import { createHash } from 'node:crypto';
export interface IdentityRowV1 {
  id: string;
  source?: string;
  type?: string;
  target?: string;
  confidenceClass?: string;
  evidence?: readonly string[];
}
export function identitySnapshot(rows: readonly IdentityRowV1[]) {
  const canonical = [...rows]
    .map((r) => ({ ...r, evidence: r.evidence ? [...r.evidence].sort() : undefined }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    rows: canonical,
    digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}
