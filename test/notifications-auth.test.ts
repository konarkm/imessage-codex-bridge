import { describe, expect, it } from 'vitest';
import { authorizeWebhook } from '../src/notifications/auth.js';

describe('authorizeWebhook', () => {
  it('accepts bearer fallback secret', () => {
    const result = authorizeWebhook({
      headers: {
        authorization: 'Bearer bridge-secret',
      },
      fallbackSecret: 'bridge-secret',
    });

    expect(result.authorized).toBe(true);
    expect(result.mode).toBe('fallback');
    expect(result.reasonCode).toBe('fallback_secret_matched');
  });

  it('accepts x-bridge-secret fallback header', () => {
    const result = authorizeWebhook({
      headers: {
        'x-bridge-secret': 'bridge-secret',
      },
      fallbackSecret: 'bridge-secret',
    });

    expect(result.authorized).toBe(true);
    expect(result.mode).toBe('fallback');
    expect(result.reasonCode).toBe('fallback_secret_matched');
  });

  it('rejects missing auth', () => {
    const result = authorizeWebhook({
      headers: {},
      fallbackSecret: 'bridge-secret',
    });

    expect(result.authorized).toBe(false);
    expect(result.mode).toBe('none');
    expect(result.reasonCode).toBe('missing_auth');
  });
});
