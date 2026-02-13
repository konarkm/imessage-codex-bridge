import { describe, expect, it } from 'vitest';
import { helpText, parseSlashCommand } from '../src/router/commands.js';

describe('parseSlashCommand', () => {
  it('parses known slash commands', () => {
    expect(parseSlashCommand('/status')).toEqual({
      name: 'status',
      args: [],
      raw: '/status',
    });

    expect(parseSlashCommand('/model gpt-5.3-codex')).toEqual({
      name: 'model',
      args: ['gpt-5.3-codex'],
      raw: '/model gpt-5.3-codex',
    });

    expect(parseSlashCommand('/notifications 20 webhook')).toEqual({
      name: 'notifications',
      args: ['20', 'webhook'],
      raw: '/notifications 20 webhook',
    });

    expect(parseSlashCommand('/restart codex')).toEqual({
      name: 'restart',
      args: ['codex'],
      raw: '/restart codex',
    });

    expect(parseSlashCommand('/effort high')).toEqual({
      name: 'effort',
      args: ['high'],
      raw: '/effort high',
    });

    expect(parseSlashCommand('/spark')).toEqual({
      name: 'spark',
      args: [],
      raw: '/spark',
    });
  });

  it('returns null for unknown commands or non-commands', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('/unknown value')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
  });
});

describe('helpText', () => {
  it('contains critical control commands', () => {
    const text = helpText();
    expect(text).toContain('/stop');
    expect(text).toContain('/resume');
    expect(text).toContain('/debug');
    expect(text).toContain('/notifications');
    expect(text).toContain('/restart <codex|bridge|both>');
    expect(text).toContain('/effort [level]');
    expect(text).toContain('/spark');
  });
});
