import type { FieldDef, FieldValue, Provenance, Role } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v !== "string" || !v) return undefined;
  // Date-only strings are calendar dates, not instants: read them in UTC so they never shift a day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 14 May 2027 */
export function fmtDate(v: unknown, opts: { long?: boolean } = {}): string {
  const s = typeof v === "string" ? v : "";
  const dateOnly = /^\d{4}-\d{2}-\d{2}(T00:00(:00)?(\.000)?Z?)?$/.test(s);
  const d = toDate(v);
  if (!d) return typeof v === "string" ? v : "";
  const day = dateOnly ? d.getUTCDate() : d.getDate();
  const m = dateOnly ? d.getUTCMonth() : d.getMonth();
  const y = dateOnly ? d.getUTCFullYear() : d.getFullYear();
  return `${day} ${(opts.long ? MONTHS_LONG : MONTHS)[m]} ${y}`;
}

/** 14:03 */
export function fmtTime(v: unknown): string {
  const d = toDate(v);
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 21 Oct 14:32 — or just 14:32 when it is today */
export function fmtWhen(v: unknown, opts: { seconds?: boolean; alwaysDate?: boolean } = {}): string {
  const d = toDate(v);
  if (!d) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = fmtTime(d) + (opts.seconds ? `:${String(d.getSeconds()).padStart(2, "0")}` : "");
  if (sameDay && !opts.alwaysDate) return t;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${t}`;
}

export function fmtMoney(amount: unknown, currency = "USD"): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "");
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString("en-US")}`;
  }
}

const SPECIAL: Record<string, string> = {
  "mainly-us": "Mainly US", "mainly-uk": "Mainly UK", "mainly-fr": "Mainly France", international: "International",
  "in-person": "In person", "in-kind": "In kind", "donations-grants-hco": "Donations and grants to HCOs",
  "contribution-to-event-costs": "Contribution to event costs", "not-disclosable": "Not disclosable",
  "charitable-contribution": "Charitable contribution",
};

/** Enum ids as words: "moore-5" → "Moore level 5", "in-person" → "In person". */
export function humanize(v: string): string {
  if (SPECIAL[v]) return SPECIAL[v]!;
  const moore = /^moore-(\w+)$/.exec(v);
  if (moore) return `Moore level ${moore[1]}`;
  const s = v.replace(/[-_]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fieldValueText(f: Pick<FieldDef, "kind" | "key">, value: unknown, currency?: string): string {
  if (value === undefined || value === null || value === "") return "";
  switch (f.kind) {
    case "money": return fmtMoney(value, currency ?? "USD");
    case "number": return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
    case "date":
    case "datetime": {
      const s = String(value);
      const time = /T(\d{2}:\d{2})/.exec(s)?.[1];
      return `${fmtDate(s.slice(0, 10))}${time && time !== "00:00" ? `, ${time}` : ""}`;
    }
    case "boolean": return value === true || value === "true" ? "Yes" : "No";
    case "enum": return humanize(String(value));
    case "multienum":
    case "list": return Array.isArray(value) ? value.map((x) => humanize(String(x))).join(", ") : String(value);
    default: return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** "Prospectus p.2", "Budget D10", "Your message", "Profile". */
export function sourceLabel(src: Provenance | undefined, docTypeOf?: (id: string) => string | undefined): string {
  if (!src) return "";
  switch (src.kind) {
    case "document": {
      const type = src.documentId && docTypeOf?.(src.documentId);
      const name = type ? docShortName(type) : shortFile(src.documentName);
      if (src.cell) return `${name} ${src.cell}`;
      if (src.page) return `${name} p.${src.page}`;
      return name;
    }
    case "derived":
      if (src.documentName) return `${docShortName(docTypeOf?.(src.documentId ?? "") ?? "") || shortFile(src.documentName)}${src.page ? ` p.${src.page}` : ""}`;
      return "Worked out";
    case "message": return "Your message";
    case "passport": return "Profile";
    case "form": return "Typed by you";
    case "system": return "System";
  }
}

const DOC_SHORT: Record<string, string> = {
  prospectus: "Prospectus", budget: "Budget", "request-letter": "Request letter", w9: "W-9", "nonprofit-proof": "Non-profit letter",
  "financial-statement": "Financial statement", "accreditation-statement": "Accreditation", "coi-policy": "COI policy",
  "charity-registration": "Registration",
};
export function docShortName(type: string): string {
  return DOC_SHORT[type] ?? "";
}
function shortFile(name?: string): string {
  if (!name) return "Document";
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ");
}

export function fieldStatusText(fv: FieldValue): string {
  if (fv.status === "proposed") return "Proposed";
  if (fv.status === "changed") return `Changed${fv.confirmedBy ? ` by ${firstPerson(fv.confirmedBy.name)}` : ""}${fv.confirmedAt ? ` · ${fmtWhen(fv.confirmedAt)}` : ""}`;
  return `Confirmed${fv.confirmedAt ? ` · ${fmtWhen(fv.confirmedAt)}` : ""}`;
}

function firstPerson(n: string): string {
  return n;
}

const ROLE_WORDS: Record<Role, string> = {
  requestor: "Requestor", "org-admin": "Organization admin", coordinator: "Coordinator", "medical-reviewer": "Medical reviewer",
  "compliance-reviewer": "Compliance reviewer", legal: "Legal", "committee-member": "Committee member", "committee-chair": "Committee chair",
  finance: "Finance", tax: "Tax", "compliance-auditor": "Audit", "process-owner": "Process owner", operator: "Operator", "access-admin": "Access administrator", sales: "Sales",
};
export function roleWords(r: Role | string): string {
  return ROLE_WORDS[r as Role] ?? humanize(r);
}

/** "Dr. Marsh" for titled names, otherwise the first name. */
export function greetName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (/^(dr|pr|prof|mr|mrs|ms|mx)\.?$/i.test(parts[0] ?? "") && parts.length > 1) return `${parts[0]} ${parts[parts.length - 1]}`;
  return parts[0] ?? name;
}

export function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** First sentence of a message, for a margin note title. */
export function firstSentence(s: string): [string, string] {
  const m = /^(.+?[.?!])(\s+|$)([\s\S]*)$/.exec(s.trim());
  if (!m) return [s, ""];
  return [m[1]!.replace(/\.$/, ""), m[3] ?? ""];
}

export function shortHash(h?: string): string {
  return h ? `…${h.slice(-6)}` : "";
}
