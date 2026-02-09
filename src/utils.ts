import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function normalizePhone(value: string): string {
  const digits = value.trim().replace(/\D+/g, '');
  if (digits.length === 0) {
    return '';
  }
  return `+${digits}`;
}

export function ensureDirForFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs(): number {
  return Date.now();
}
