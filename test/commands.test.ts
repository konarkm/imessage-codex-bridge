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
  });
});
