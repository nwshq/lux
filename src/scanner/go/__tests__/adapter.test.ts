import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoDeterministicAdapter } from '../adapter.js';
describe('Go deterministic adapter', () =>
  it('discovers module and extracts package/symbol/calls without Go execution', async () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-go-'));
    writeFileSync(join(r, 'go.mod'), 'module example.com/app\n\ngo 1.24');
    mkdirSync(join(r, 'cmd'));
    writeFileSync(join(r, 'cmd/main.go'), 'package main\nfunc helper(){}\nfunc main(){ helper() }');
    const a = new GoDeterministicAdapter(),
      p = await a.discover(r, [r]);
    expect(p?.modulePath).toBe('example.com/app');
    const f = await a.extract(p!);
    const o = await a.resolve(p!, f);
    expect(o.nodes.some((n) => n.symbolName === 'main')).toBe(true);
    expect(o.edges.some((e) => e.edgeType === 'calls')).toBe(true);
    rmSync(r, { recursive: true });
  }));
