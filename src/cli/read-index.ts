import type { LuxDatabase } from '../db/index.js';
import { openIndex, type IndexOpenRefusal, type IndexOpenResult } from '../db/open-policy.js';

export { READ_TELEMETRY, withReadTelemetry } from '../utils/read-telemetry.js';
import { READ_TELEMETRY, type ReadTelemetryV1 } from '../utils/read-telemetry.js';

export interface IndexReadRefusalPayload {
  error: 'index-open-refused';
  refusal: IndexOpenRefusal;
  message: string;
  telemetry: ReadTelemetryV1;
}

function indexReadRefusalPayload(
  result: Extract<IndexOpenResult, { ok: false }>
): IndexReadRefusalPayload {
  return {
    error: 'index-open-refused',
    refusal: result.refusal,
    message: result.message,
    telemetry: READ_TELEMETRY,
  };
}

/** Open an existing current-schema index without creating, migrating, or writing it. */
export function openCliReadIndex(dbPath: string, json: boolean): LuxDatabase | null {
  const opened = openIndex(dbPath, 'read-existing');
  if (opened.ok) return opened.db;

  if (json) console.log(JSON.stringify(indexReadRefusalPayload(opened), null, 2));
  else console.error(`Error: ${opened.message}`);
  process.exitCode = 1;
  return null;
}
