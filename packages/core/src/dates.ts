// Date maths used by rules and SLAs. All dates are treated as calendar dates in UTC.

export function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v !== "string" || !v) return undefined;
  const s = v.length === 10 ? `${v}T00:00:00Z` : v.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b - a), ignoring time of day. */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const ub = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((ub - ua) / 86_400_000);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

export function isWeekend(d: Date): boolean {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

/** Add business days (Mon–Fri), skipping any ISO dates in `holidays`. */
export function addBusinessDays(d: Date, n: number, holidays: string[] = []): Date {
  let r = new Date(d.getTime());
  let left = n;
  const hs = new Set(holidays);
  while (left > 0) {
    r = addDays(r, 1);
    if (!isWeekend(r) && !hs.has(isoDate(r))) left--;
  }
  return r;
}

export function businessDaysBetween(a: Date, b: Date, holidays: string[] = []): number {
  if (b <= a) return 0;
  const hs = new Set(holidays);
  let n = 0;
  let r = new Date(a.getTime());
  while (daysBetween(r, b) > 0) {
    r = addDays(r, 1);
    if (!isWeekend(r) && !hs.has(isoDate(r))) n++;
  }
  return n;
}

export function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function formatDate(v: unknown): string {
  const d = toDate(v);
  if (!d) return String(v ?? "");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
