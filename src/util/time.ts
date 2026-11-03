/**
 * Parse durations like "30m", "6h", "7d", "2w" into milliseconds.
 * Plain numbers are treated as minutes.
 */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i.exec(s.trim());
  if (!m) throw new Error(`Invalid duration: ${s} (expected e.g. 30m, 6h, 7d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[unit]!;
  return n * mult;
}

/** Resolve "--since" values: a duration ("7d") relative to now, or an ISO date. */
export function parseSince(s: string, now = new Date()): Date {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
    return d;
  }
  return new Date(now.getTime() - parseDuration(s));
}
