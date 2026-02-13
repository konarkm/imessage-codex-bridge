import { describe, expect, it } from 'vitest';
import { parseNotificationDecision } from '../src/notifications/schema.js';

describe('parseNotificationDecision', () => {
  it('parses a valid decision envelope', () => {
    const decision = parseNotificationDecision(
      JSON.stringify({
        delivery: 'send',
        message: 'Heads up: deploy failed',
        reasonCode: 'deploy_failure',
      }),
    );

    expect(decision).toEqual({
      delivery: 'send',
      message: 'Heads up: deploy failed',
      reasonCode: 'deploy_failure',
    });
  });

  it('returns null for invalid envelope', () => {
    expect(parseNotificationDecision('not json')).toBeNull();
    expect(parseNotificationDecision(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});
