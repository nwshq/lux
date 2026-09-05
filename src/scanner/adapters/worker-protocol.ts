import type { AdapterInputV1, AdapterOutputV1 } from './types.js';

export interface AdapterWorkerRequestV1 {
  schemaVersion: 1;
  adapterId: string;
  input: AdapterInputV1;
}

export type AdapterWorkerResponseV1 =
  | { schemaVersion: 1; ok: true; output: AdapterOutputV1 }
  | {
      schemaVersion: 1;
      ok: false;
      diagnostic: {
        code: 'timeout' | 'limit' | 'parse-error' | 'path-escape' | 'worker-error';
        message: string;
      };
    };
