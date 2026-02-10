import { describe, expect, it } from 'vitest';
import { composeInboundTextForCodex, splitMessage } from '../src/bridge.js';

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
