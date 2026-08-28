import { describe, it, expect } from 'vitest';
import { VueLspEnricher } from '../vue.js';
import { EnricherRegistry } from '../index.js';
import { buildRegistry } from '../../general.js';

// ---------------------------------------------------------------------------
// Unit tests for VueLspEnricher (lifecycle, config, node IDs, registration)
// ---------------------------------------------------------------------------
// Tests that require a live vue-language-server are integration tests and are
// excluded from this suite. These cover the enricher contract, configuration
// defaults, helper utilities, and — the point of the whole file — that a `vue`
// entry in lux.yaml actually produces a registered enricher.

describe('VueLspEnricher', () => {
  describe('construction and config defaults', () => {
    it('should set languageId to vue', () => {
      const enricher = new VueLspEnricher();
      expect(enricher.languageId).toBe('vue');
    });

    it('should handle the .vue extension', () => {
      const enricher = new VueLspEnricher();
      expect(enricher.fileExtensions).toEqual(['.vue']);
    });

    it('should default to the vue-language-server command', () => {
      const enricher = new VueLspEnricher();
      expect(enricher.config.serverCommand).toBe('vue-language-server');
      expect(enricher.config.serverArgs).toEqual(['--stdio']);
    });

    it('should accept custom server command and args', () => {
      const enricher = new VueLspEnricher({
        serverCommand: '/opt/homebrew/bin/vue-language-server',
        serverArgs: ['--stdio', '--log-level', '3'],
        maxConcurrency: 2,
        requestTimeoutMs: 5000,
        initTimeoutMs: 30000,
      });
      expect(enricher.config.serverCommand).toBe('/opt/homebrew/bin/vue-language-server');
      expect(enricher.config.serverArgs).toEqual(['--stdio', '--log-level', '3']);
      expect(enricher.config.maxConcurrency).toBe(2);
      expect(enricher.config.requestTimeoutMs).toBe(5000);
      expect(enricher.config.initTimeoutMs).toBe(30000);
    });

    it('should start not ready', () => {
      const enricher = new VueLspEnricher();
      expect(enricher.isReady).toBe(false);
    });

    it('should refuse to enrich before initialize()', async () => {
      const enricher = new VueLspEnricher();
      await expect(enricher.enrich('/tmp/Component.vue')).rejects.toThrow(/not initialized/);
    });
  });

  describe('node ID helpers', () => {
    it('should build a stable file node ID', () => {
      const id = VueLspEnricher.buildFileNodeId('resources/js/admin-ui/UserDetails.vue');
      expect(id).toBe('file:resources/js/admin-ui/UserDetails.vue');
    });

    it('should build a symbol node ID the propagation pass probes for', () => {
      // resolveConsumerSymbolNode() probes `symbol:vue:<path>#<name>`; this
      // scheme is fixed by that lookup, not chosen here.
      const id = VueLspEnricher.buildSymbolNodeId(
        'resources/js/admin-ui/UserDetails.vue',
        'onsiteNumberLabel'
      );
      expect(id).toBe('symbol:vue:resources/js/admin-ui/UserDetails.vue#onsiteNumberLabel');
    });
  });

  describe('registry integration', () => {
    it('should be discoverable by extension once registered', () => {
      const registry = new EnricherRegistry();
      registry.register(new VueLspEnricher());
      expect(registry.getByExtension('.vue')?.languageId).toBe('vue');
      expect(registry.getSupportedExtensions()).toContain('.vue');
    });

    // The regression this whole change exists for. buildRegistry()
    // looks a language id up in a factory table and skips entries it does not
    // recognise, so before a `vue` factory existed this returned an EMPTY
    // registry for a perfectly valid config — no error, no warning, and an
    // index that silently carried zero Vue symbols.
    it('should build a vue enricher from a lux.yaml entry', () => {
      const registry = buildRegistry([
        {
          languageId: 'vue',
          enabled: true,
          serverCommand: '/opt/homebrew/bin/vue-language-server',
          serverArgs: ['--stdio'],
        },
      ]);

      expect(registry.size).toBe(1);
      expect(registry.getByExtension('.vue')?.languageId).toBe('vue');
    });

    it('should respect enabled: false for a vue entry', () => {
      const registry = buildRegistry([{ languageId: 'vue', enabled: false }]);
      expect(registry.size).toBe(0);
    });

    it('should register vue alongside php and typescript', () => {
      const registry = buildRegistry([
        { languageId: 'php', enabled: true },
        { languageId: 'vue', enabled: true },
        { languageId: 'typescript', enabled: true },
      ]);

      expect(registry.size).toBe(3);
      expect(registry.getByExtension('.vue')?.languageId).toBe('vue');
      expect(registry.getByExtension('.php')?.languageId).toBe('php');
      expect(registry.getByExtension('.ts')?.languageId).toBe('typescript');
    });

    it('should skip an unrecognised language id without throwing', () => {
      const registry = buildRegistry([
        { languageId: 'cobol', enabled: true },
        { languageId: 'vue', enabled: true },
      ]);

      // The unknown entry is skipped; the recognised one still registers.
      expect(registry.size).toBe(1);
      expect(registry.getByExtension('.vue')?.languageId).toBe('vue');
    });
  });
});
