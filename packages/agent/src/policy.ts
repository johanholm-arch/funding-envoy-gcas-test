// Policy guidance: answers come from the tenant's own clauses, quoted, or the question is declined.
// The scope boundary is enforced here, in code, before any model is asked anything.

export interface Clause {
  ref: string; // "Policy 6.4", "SOP 4.1"
  document: string; // "Grants and Donations Policy v6"
  heading?: string;
  text: string;
}

/** Split a markdown policy or SOP into numbered clauses. Recognises "6.4 Heading" or "**6.4** ..." or "### 6.4 Heading" at line start. */
export function parseClauses(markdown: string, prefix: string, document: string): Clause[] {
  const lines = markdown.split(/\r?\n/);
  const clauses: Clause[] = [];
  let cur: Clause | undefined;
  const start = /^(?:#{1,6}\s*)?(?:\*\*)?(\d+(?:\.\d+)+)(?:\*\*)?\.?\s+(.*)$/;
  for (const line of lines) {
    const m = start.exec(line.trim());
    if (m) {
      if (cur) clauses.push(cur);
      const rest = m[2]!.replace(/\*\*/g, "").trim();
      cur = { ref: `${prefix} ${m[1]}`, document, heading: rest.length < 90 ? rest : undefined, text: rest.length < 90 ? "" : rest };
    } else if (cur) {
      if (/^#{1,3}\s/.test(line.trim()) && !start.test(line.trim())) { clauses.push(cur); cur = undefined; continue; }
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  if (cur) clauses.push(cur);
  return clauses.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text || c.heading);
}

const STOP = new Set("a an the of to in on for and or is are be can we our you your it this that with as at by from what which who how do does may i".split(" "));

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9%$€£ ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}
function stem(t: string): string {
  return t.replace(/(ings|ing|ies|ied|es|s|ed)$/, "");
}

// Grants vocabulary: a requestor's word → the words policies use. Expands the query only.
const THESAURUS: Record<string, string[]> = {
  dinner: ["meal", "hospitality"], lunch: ["meal", "hospitality"], breakfast: ["meal"], catering: ["meal", "hospitality"], food: ["meal"], drinks: ["meal", "hospitality", "alcohol"],
  party: ["entertainment"], gala: ["entertainment"], golf: ["entertainment"], tickets: ["entertainment"],
  doctor: ["individual", "healthcare", "professional"], physician: ["individual", "healthcare", "professional"], speaker: ["faculty"], speakers: ["faculty"],
  percent: ["revenue", "cap"], percentage: ["revenue", "cap"], limit: ["cap"], maximum: ["cap"],
  deadline: ["lead", "time", "days"], early: ["lead", "time"], late: ["lead", "time"], when: ["lead", "time", "days"],
  support: ["fund"], sponsor: ["fund"], pay: ["fund", "payment"], money: ["fund"], grant: ["fund"],
  eligible: ["eligibility", "eligible"], qualify: ["eligibility", "eligible"],
  travel: ["travel"], flights: ["travel"], hotel: ["travel", "lodging"],
  sign: ["agreement", "signature"], contract: ["agreement"],
  report: ["reconciliation", "outcomes"], leftover: ["unused", "return"], unspent: ["unused", "return"],
};

/** BM25 retrieval over clauses. */
export function retrieve(question: string, clauses: Clause[], k = 3): { clause: Clause; score: number }[] {
  const raw = tokens(question);
  const q = [...raw, ...raw.flatMap((t) => (THESAURUS[t] ?? []).map(stem))];
  if (!q.length) return [];
  const docs = clauses.map((c) => tokens(`${c.heading ?? ""} ${c.text}`));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const scored = docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return { clause: clauses[i]!, score: s };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export type DeclineReason = "prediction" | "amount-advice" | "advocacy" | "rationale-drafting" | "attestation" | "out-of-corpus";

const DECLINE_PATTERNS: [DeclineReason, RegExp][] = [
  ["prediction", /\b(will|would|chances?|likely|likelihood|odds|probability|guarantee)\b.*\b(approv\w*|fund\w*|accept\w*|succeed|get (it|this|funded))\b|\bapproval (rate|chance)/i],
  ["amount-advice", /\bhow much (should|could|can|do) (we|i)\b|\b(usually|typically|normally|average)\b.*\b(give|grant|award|fund)\b|\bwhat amount\b/i],
  ["advocacy", /\b(improve|increase|boost)\b.*\bchances?\b|\b(get to yes|make it more likely|convince|persuade)\b/i],
  ["rationale-drafting", /\b(write|draft|compose)\b.*\b(rationale|needs assessment|educational need|justification|learning objectives)\b/i],
  ["attestation", /\b(sign|attest|tick|answer)\b.*\b(for me|on my behalf)\b|\bsubmit (it )?for me\b/i],
];

export function scopeCheck(question: string): DeclineReason | undefined {
  for (const [reason, re] of DECLINE_PATTERNS) if (re.test(question)) return reason;
  return undefined;
}

export const DECLINE_TEXT: Record<DeclineReason, string> = {
  prediction: "I can't predict whether a request will be approved; the committee decides each one on its merits. I can make sure it is complete and tell you when its status changes.",
  "amount-advice": "I can't suggest an amount or say what is usually given. The request should reflect your own budget; I can check that the amount and the budget agree.",
  advocacy: "I can't coach a request towards approval. I can make sure it is complete, consistent and meets the policy, which is what reviewers look at first.",
  "rationale-drafting": "The educational rationale has to be yours, so I won't draft it. I can pull it from your needs assessment or prospectus and show you where it came from.",
  attestation: "Statements and attestations are yours to make, and only you can submit. I'll show you exactly what will be sent first.",
  "out-of-corpus": "That isn't covered in the policy documents I can see, so I won't guess. The grants team can answer it.",
};
