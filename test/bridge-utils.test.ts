import { describe, expect, it } from 'vitest';
import { composeInboundTextForCodex, formatOutboundForImessage, splitMessage } from '../src/bridge.js';

describe('splitMessage', () => {
  it('splits long text into bounded chunks', () => {
    const text = `A`.repeat(2600);
    const chunks = splitMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('preserves short text', () => {
    expect(splitMessage('hello', 1000)).toEqual(['hello']);
  });

  it('forwards media-only inbound as URL context', () => {
    const result = composeInboundTextForCodex('', 'https://example.com/image.png', 'url_only');
    expect(result).toContain('User attached media URL: https://example.com/image.png');
    expect(result).toContain('Fetch and inspect this attachment URL as needed.');
  });

  it('forwards text and media together', () => {
    const result = composeInboundTextForCodex('please inspect', 'https://example.com/file.pdf', 'url_only');
    expect(result).toContain('User message: please inspect');
    expect(result).toContain('User attached media URL: https://example.com/file.pdf');
  });

  it('returns text unchanged when no media URL is present', () => {
    expect(composeInboundTextForCodex('hello world', '', 'url_only')).toBe('hello world');
  });
});

describe('formatOutboundForImessage', () => {
  it('converts markdown markers into unicode styled text', () => {
    const formatted = formatOutboundForImessage('Use **bold**, *italic*, and `code`.');
    expect(formatted).toContain('𝐛𝐨𝐥𝐝');
    expect(formatted).toContain('𝑖𝑡𝑎𝑙𝑖𝑐');
    expect(formatted).toContain('𝚌𝚘𝚍𝚎');
    expect(formatted).not.toContain('**');
    expect(formatted).not.toContain('`');
  });

  it('does not mutate when disabled', () => {
    const input = 'Use **bold** and *italic*.';
    expect(formatOutboundForImessage(input, false)).toBe(input);
  });

  it('does not italicize underscores inside words', () => {
    const input = 'Keep snake_case literal, but _format this_.';
    const formatted = formatOutboundForImessage(input);
    expect(formatted).toContain('snake_case');
    expect(formatted).toContain('𝑓𝑜𝑟𝑚𝑎𝑡 𝑡ℎ𝑖𝑠');
  });
});
