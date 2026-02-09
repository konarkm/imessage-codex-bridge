import { describe, expect, it } from 'vitest';
import { splitMessage } from '../src/bridge.js';

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
});
