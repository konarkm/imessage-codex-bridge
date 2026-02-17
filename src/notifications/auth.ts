import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface WebhookAuthInput {
  headers: IncomingHttpHeaders;
  fallbackSecret: string;
}

export interface WebhookAuthResult {
  authorized: boolean;
  mode: 'fallback' | 'none';
  reasonCode: 'fallback_secret_matched' | 'missing_auth';
}

export function authorizeWebhook(input: WebhookAuthInput): WebhookAuthResult {
  if (matchesFallbackSecret(input.headers, input.fallbackSecret)) {
    return {
      authorized: true,
      mode: 'fallback',
      reasonCode: 'fallback_secret_matched',
    };
  }

  return {
    authorized: false,
    mode: 'none',
    reasonCode: 'missing_auth',
  };
}

function matchesFallbackSecret(headers: IncomingHttpHeaders, fallbackSecret: string): boolean {
  const secret = fallbackSecret.trim();
  if (secret.length === 0) {
    return false;
  }

  const authHeader = headerValue(headers, 'authorization');
  if (authHeader) {
    const token = authHeader.replace(/^bearer\s+/i, '').trim();
    if (secureEqual(token, secret)) {
      return true;
    }
  }

  const bridgeHeader = headerValue(headers, 'x-bridge-secret');
  if (bridgeHeader && secureEqual(bridgeHeader, secret)) {
    return true;
  }

  return false;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && value.length > 0 && value[0] && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return null;
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
