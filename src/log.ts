// One JSON line per lifecycle event. Never pass secrets or full env objects.
type Level = 'info' | 'warn' | 'error';

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Collapse an unknown thrown value to a short message for logs / responses. */
export function errorMessage(err: unknown, max = 500): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}
