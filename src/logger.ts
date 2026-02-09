function ts(): string {
  return new Date().toISOString();
}

export function logInfo(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.log(`[${ts()}] INFO ${message}`, meta);
    return;
  }
  console.log(`[${ts()}] INFO ${message}`);
}

export function logWarn(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.warn(`[${ts()}] WARN ${message}`, meta);
    return;
  }
  console.warn(`[${ts()}] WARN ${message}`);
}

export function logError(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.error(`[${ts()}] ERROR ${message}`, meta);
    return;
  }
  console.error(`[${ts()}] ERROR ${message}`);
}
