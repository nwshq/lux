/**
 * Compatibility facade for the historical flat import path.
 *
 * The Phase-4 implementation lives in `./doctor/`; central CLI and MCP wiring keep importing
 * `./doctor.js` so existing library consumers do not need to change paths.
 */
export * from './doctor/index.js';
