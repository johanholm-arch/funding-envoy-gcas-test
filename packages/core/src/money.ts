export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === ".") return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Building a number formatter is expensive; these two cover every amount we show.
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const CENTS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const SYMBOL: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", KRW: "₩" };

export function formatMoney(amount: number | undefined, currency = "USD", opts: { compact?: boolean } = {}): string {
  if (amount === undefined || Number.isNaN(amount)) return "—";
  const sym = SYMBOL[currency] ?? `${currency} `;
  if (opts.compact && Math.abs(amount) >= 1_000_000) return `${sym}${(amount / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${sym}${(amount % 1 === 0 ? WHOLE : CENTS).format(amount)}`;
}

export function formatPct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}
