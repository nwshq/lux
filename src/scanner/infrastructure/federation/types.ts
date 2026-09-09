export interface FederationEndpointV1 {
  repo: string;
  id: string;
}
export interface FederationMappingV1 {
  fromRepo: string;
  fromId: string;
  toRepo: string;
  toId: string;
  edgeType: 'produces_artifact' | 'consumes_artifact' | 'references_resource';
  evidenceFile: string;
}
export interface FederationExportV1 {
  schemaVersion: 1;
  repo: string;
  repoCommit: string;
  indexSchemaVersion: number;
  configFingerprint: string;
  id: string;
  evidenceFile: string;
}
export interface MappedFederationEdgeV1 {
  schemaVersion: 1;
  source: FederationEndpointV1;
  target: FederationEndpointV1;
  edgeType: FederationMappingV1['edgeType'];
  confidenceClass: 'artifact-backed';
  authorization: 'explicit-mapping' | 'mutual-exact-export';
  evidence: Array<{ repo: string; filePath: string }>;
}
