/** Truncate to `max` chars, appending a marker with the number of dropped chars. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

/** Render an arbitrary tool input compactly on one line. */
export function renderInput(input: unknown, max: number): string {
  let s: string;
  if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input) ?? "";
    } catch {
      s = String(input);
    }
  }
  return truncate(s.replace(/\s+/g, " ").trim(), max);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function toDate(v: unknown): Date | undefined {
  if (typeof v === "number" || typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}
