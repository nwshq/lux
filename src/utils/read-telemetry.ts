export interface ReadTelemetryV1 {
  recorded: false;
  reason: 'read-only-index';
}

export const READ_TELEMETRY: ReadTelemetryV1 = {
  recorded: false,
  reason: 'read-only-index',
};

/** Add the explicit telemetry omission marker to an object-shaped read response. */
export function withReadTelemetry<T extends object>(
  payload: T
): T & { telemetry: ReadTelemetryV1 } {
  return { ...payload, telemetry: READ_TELEMETRY };
}
