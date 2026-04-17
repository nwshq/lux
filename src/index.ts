// Root public API for Lux.
//
// This file is the package entry point referenced by package.json.
// Re-export the scanner and overlay orchestration surfaces that are intended
// for programmatic use outside the CLI.

export * from './scanner/index.js';
export * from './scanner/rebuild-orchestrator.js';
export * from './scanner/associations/index.js';
