import type { Condition, CompareOp } from "./types.ts";

/** A flat map of fact name → value, e.g. "field.activity.startDate" → "2027-05-14". */
export type Facts = Record<string, unknown>;

export function evaluate(cond: Condition | undefined, facts: Facts): boolean {
  if (!cond) return true;
  if ("always" in cond) return true;
  if ("all" in cond) return cond.all.every((c) => evaluate(c, facts));
  if ("any" in cond) return cond.any.some((c) => evaluate(c, facts));
  if ("not" in cond) return !evaluate(cond.not, facts);
  return compare(facts[cond.fact], cond.op, cond.value);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export function compare(actual: unknown, op: CompareOp, expected: unknown): boolean {
  switch (op) {
    case "exists": return !isEmpty(actual);
    case "missing": return isEmpty(actual);
    case "truthy": return Boolean(actual) && !isEmpty(actual);
    case "falsy": return !actual || isEmpty(actual);
    case "eq": return looseEq(actual, expected);
    case "ne": return !looseEq(actual, expected);
    case "in": return Array.isArray(expected) && expected.some((e) => looseEq(actual, e));
    case "nin": return !(Array.isArray(expected) && expected.some((e) => looseEq(actual, e)));
    case "contains":
      if (Array.isArray(actual)) return actual.some((a) => looseEq(a, expected));
      if (typeof actual === "string" && typeof expected === "string") return actual.toLowerCase().includes(expected.toLowerCase());
      return false;
    case "gt": case "gte": case "lt": case "lte": {
      const a = num(actual), b = num(expected);
      if (a !== undefined && b !== undefined) {
        return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
      }
      // ISO dates compare lexically
      if (typeof actual === "string" && typeof expected === "string") {
        return op === "gt" ? actual > expected : op === "gte" ? actual >= expected : op === "lt" ? actual < expected : actual <= expected;
      }
      return false;
    }
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = num(a), nb = num(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  return false;
}

/** Facts referenced by a condition, used for explanations and dependency tracking. */
export function factsReferenced(cond: Condition | undefined, out = new Set<string>()): Set<string> {
  if (!cond || "always" in cond) return out;
  if ("all" in cond) cond.all.forEach((c) => factsReferenced(c, out));
  else if ("any" in cond) cond.any.forEach((c) => factsReferenced(c, out));
  else if ("not" in cond) factsReferenced(cond.not, out);
  else out.add(cond.fact);
  return out;
}
