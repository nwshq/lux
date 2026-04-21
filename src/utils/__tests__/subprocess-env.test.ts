import { describe, it, expect } from 'vitest';
import { buildCleanEnv } from '../subprocess-env.js';

describe('buildCleanEnv', () => {
  const fullSource: Record<string, string> = {
    // Exact allowlist
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/home/user',
    SHELL: '/bin/zsh',
    USER: 'testuser',
    LOGNAME: 'testuser',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    // Prefix allowlist
    LANG: 'en_US.UTF-8',
    LANGUAGE: 'en_US',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    XDG_CONFIG_HOME: '/home/user/.config',
    XDG_DATA_HOME: '/home/user/.local/share',
    ANTHROPIC_API_KEY: 'sk-ant-test-key',
    // Should be excluded
    CLAUDECODE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    npm_config_registry: 'https://registry.npmjs.org',
    npm_lifecycle_event: 'test',
    DEBUG: '*',
    SOME_RANDOM_VAR: 'should-not-appear',
    AWS_SECRET_ACCESS_KEY: 'secret',
  };

  it('should include all exact allowlist vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.USER).toBe('testuser');
    expect(env.LOGNAME).toBe('testuser');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.TMPDIR).toBe('/tmp');
  });

  it('should include LANG and LANGUAGE prefix-matched vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LANGUAGE).toBe('en_US');
  });

  it('should include LC_ prefix-matched vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.LC_CTYPE).toBe('UTF-8');
  });

  it('should include XDG_ prefix-matched vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.XDG_CONFIG_HOME).toBe('/home/user/.config');
    expect(env.XDG_DATA_HOME).toBe('/home/user/.local/share');
  });

  it('should include ANTHROPIC_ prefix-matched vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  it('should exclude CLAUDECODE', () => {
    const env = buildCleanEnv(fullSource);

    expect(env).not.toHaveProperty('CLAUDECODE');
  });

  it('should exclude NODE_OPTIONS', () => {
    const env = buildCleanEnv(fullSource);

    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('should exclude npm_ prefixed vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env).not.toHaveProperty('npm_config_registry');
    expect(env).not.toHaveProperty('npm_lifecycle_event');
  });

  it('should exclude DEBUG', () => {
    const env = buildCleanEnv(fullSource);

    expect(env).not.toHaveProperty('DEBUG');
  });

  it('should exclude arbitrary unknown vars', () => {
    const env = buildCleanEnv(fullSource);

    expect(env).not.toHaveProperty('SOME_RANDOM_VAR');
  });

  it('should include AWS_ prefix-matched vars for Bedrock-style auth', () => {
    const env = buildCleanEnv(fullSource);

    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret');
  });

  it('should return an empty object for an empty source', () => {
    const env = buildCleanEnv({});

    expect(env).toEqual({});
  });

  it('should skip undefined values', () => {
    const env = buildCleanEnv({
      PATH: '/usr/bin',
      HOME: undefined,
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env).not.toHaveProperty('HOME');
  });

  it('should return a new object each call', () => {
    const source = { PATH: '/usr/bin' };
    const a = buildCleanEnv(source);
    const b = buildCleanEnv(source);

    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
