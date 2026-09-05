import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tool-defs.js';

describe('lux_doctor MCP schema', () => {
  it('registers an argument-free read-only tool', () => {
    const doctor = TOOLS.find((tool) => tool.name === 'lux_doctor');
    expect(doctor).toBeDefined();
    expect(doctor?.description).toContain('Read-only');
    expect(doctor?.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
