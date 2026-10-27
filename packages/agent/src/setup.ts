// Reading a funder's policy and SOP to propose its setup: the words it uses, its limits, the documents it requires
// and the time allowed at each stage. Every proposal carries the clause and the sentence it came from, so a person can
// check it against the document before accepting it. This is the deterministic reader used by the demo assistant;
// Claude proposes into the same shape and its quotes are verified against the text in code.
import { parseClauses, type Clause } from "./policy.ts";

export interface Sourced<T> { value: T; ref: string; quote: string }
export type WordKey = "request" | "committee" | "reviewingTeam" | "reconciliation";
export type ParameterKey = "leadTimeDays" | "revenueCap" | "singleApproverMaxUSD";

export interface SetupProposal {
  words: Partial<Record<WordKey, Sourced<string>>>;
  parameters: Partial<Record<ParameterKey, Sourced<number>>>;
  documents: { type: string; ref: string; quote: string }[];
  stageTimes: { stage: string; days: number; unit: "business" | "calendar"; ref: string; quote: string }[];
}

export interface SetupInput {
  policy?: { title: string; markdown: string };
  sop?: { title: string; markdown: string };
  documentTypes: { type: string; label: string }[];
  stages: { id: string; name: string; sopRefs: string[] }[];
}

/** Keywords that show a document type is required, matched in clauses about what requests include. */
const DOCUMENT_WORDS: Record<string, RegExp> = {
  "request-letter": /\b(request letter|letter of request|covering letter|cover letter)\b/i,
  budget: /\b(itemi[sz]ed budget|detailed budget|budget)\b/i,
  "financial-statement": /\b(financial statements?|annual accounts|audited accounts|annual report)\b/i,
  prospectus: /\b(prospectus|agenda|programme outline|program outline)\b/i,
  "coi-policy": /\bconflict[- ]of[- ]interest policy\b/i,
  "accreditation-statement": /\baccreditation (statement|letter|certificate)\b/i,
  w9: /\bW-?9\b/,
  "nonprofit-proof": /\b(non-?profit status|determination letter|501\(c\)\(3\))\b/i,
  "charity-registration": /\b(proof of registration|registered charity|charity (number|registration)|registration (number|certificate))\b/i,
  bylaws: /\b(by-?laws|statutes|articles of association)\b/i,
};
const STAGE_STOPWORDS = new Set(["review", "stage", "with", "from", "and", "decision", "report", "check", "close"]);
const ORGANIZATION_DEADLINE = /\b(the organi[sz]ation (provides|reports|returns|submits|sends)|organi[sz]ations? must|unused funds|are returned|requestors? (must|should))\b/i;
const ASKS_FOR = /\b(include|includes|including|submit|submitted|provide|provided|attach|required|requires|must contain|accompanied)\b/i;

function sentences(text: string): string[] {
  return text.replace(/\*\*/g, "").split(/\n+/).flatMap((line) => line.replace(/^\s*[-*]\s+/, "").split(/(?<=[.;])\s+(?=[A-Z(])/)).map((s) => s.trim()).filter(Boolean);
}

function find<T>(clauses: Clause[], pattern: RegExp, value: (m: RegExpExecArray) => T | undefined, where?: RegExp): Sourced<T> | undefined {
  for (const c of clauses) {
    if (where && !where.test(c.text)) continue;
    for (const s of sentences(c.text)) {
      const m = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(s);
      if (!m) continue;
      const v = value(m);
      if (v !== undefined) return { value: v, ref: c.ref, quote: s };
    }
  }
  return undefined;
}

function mostFrequent(clauses: Clause[], pattern: RegExp, normalize: (s: string) => string, skip?: RegExp): Sourced<string> | undefined {
  const counts = new Map<string, { n: number; ref: string; quote: string }>();
  for (const c of clauses) {
    for (const s of sentences(c.text)) {
      for (const m of s.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))) {
        const v = normalize(m[1] ?? m[0]);
        if (!v || (skip && skip.test(v))) continue;
        const e = counts.get(v) ?? { n: 0, ref: c.ref, quote: s };
        e.n++;
        counts.set(v, e);
      }
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  return best ? { value: best[0], ref: best[1].ref, quote: best[1].quote } : undefined;
}

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const money = (s: string) => Number(s.replace(/[,\s]/g, ""));

export function proposeSetupFromText(input: SetupInput): SetupProposal {
  const policy = input.policy ? parseClauses(input.policy.markdown, "Policy", input.policy.title) : [];
  const sop = input.sop ? parseClauses(input.sop.markdown, "SOP", input.sop.title) : [];
  const all = [...policy, ...sop];
  const words: SetupProposal["words"] = {};
  const parameters: SetupProposal["parameters"] = {};

  // Words. The committee that decides is the committee named most often; a request is an "application" only when
  // the documents say so more often than "request".
  const committee = mostFrequent(all, /\b((?:[A-Z][A-Za-z]+\s+(?:(?:and|of|for|&)\s+)?){1,5}(?:Committee|Board|Panel))\b/g, (s) => s.trim().replace(/^The\s+/, ""), /^(Ethics|Audit|Risk|Compliance|Executive|Remuneration)\b/);
  if (committee) words.committee = committee;
  const text = all.map((c) => c.text).join("\n");
  const applications = (text.match(/\bapplications?\b/gi) ?? []).length;
  const requests = (text.match(/\brequests?\b/gi) ?? []).length;
  const term = applications > requests ? find(all, /\b(grant applications?|funding applications?|applications?)\b/i, (m) => sentenceCase(m[1]!.replace(/s$/, "")))
    : find(all, /\b(grant requests?|funding requests?|requests?)\b/i, (m) => sentenceCase(m[1]!.replace(/s$/, "")));
  if (term) words.request = { ...term, value: term.value.split(" ").length > 1 && /^(Grant|Funding) /.test(term.value) ? term.value : term.value };
  const team = mostFrequent(all, /\b(reviewing group|triage group|review team|review panel|grants? review group|medical review group)s?\b/gi, (s) => sentenceCase(s.toLowerCase()));
  if (team) words.reviewingTeam = team;
  const recon = mostFrequent(all, /\b(financial reconciliation|reconciliation report|close-?out report|final report)\b/gi, (s) => sentenceCase(s))
    ?? find(all, /\b(reconciliation)\b/i, (m) => sentenceCase(m[1]!));
  if (recon) words.reconciliation = recon;

  // Limits.
  const lead = find(all, /at least\s+(\d{1,3})\s+(?:calendar\s+|business\s+|working\s+)?days\s+before/i, (m) => Number(m[1]));
  if (lead) parameters.leadTimeDays = lead;
  const cap = find(all, /(\d{1,2}(?:\.\d+)?)\s?(?:%|per\s?cent)\s+of\s+(?:that\s+|the\s+|its\s+|an?\s+)?(?:organi[sz]ation'?s?\s+|recipient'?s?\s+)?(?:annual\s+|total\s+|gross\s+|yearly\s+)*(?:revenue|income|budget|turnover)/i, (m) => Number(m[1]) / 100);
  if (cap) parameters.revenueCap = cap;
  const single = find(all, /(?:US\$|\$|USD\s?)\s?([\d,]{3,})/i, (m) => money(m[1]!), /single approver|single-approver|one approver/i);
  if (single) parameters.singleApproverMaxUSD = single;

  // Required documents: only clauses that talk about what a request includes.
  const documents: SetupProposal["documents"] = [];
  for (const d of input.documentTypes) {
    const re = DOCUMENT_WORDS[d.type];
    if (!re) continue;
    const hit = find(all, re, () => true, ASKS_FOR);
    if (hit) documents.push({ type: d.type, ref: hit.ref, quote: hit.quote });
  }

  // Time allowed at each stage, from the SOP clauses the stage is built on.
  const stageTimes: SetupProposal["stageTimes"] = [];
  const byRef = new Map(sop.map((c) => [c.ref.replace(/^SOP\s*/, ""), c]));
  for (const st of input.stages) {
    const clauses = st.sopRefs.map((r) => byRef.get(r.replace(/^SOP\s*/, ""))).filter((c): c is Clause => Boolean(c));
    // The sentence must be about this stage (it names it) and about the funder's own team, not a deadline the
    // organization has to meet, such as returning unused funds or sending an outcomes report.
    const keys = st.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !STAGE_STOPWORDS.has(w)).map((w) => w.slice(0, 6));
    const about = (sentence: string) => keys.some((k) => new RegExp(`\\b${k}`, "i").test(sentence)) && !ORGANIZATION_DEADLINE.test(sentence);
    const t = find(clauses, /within\s+(\d{1,3})\s+(business|working|calendar)?\s*days/i, (m) => (about(m.input) ? `${m[1]}|${m[2] ?? ""}` : undefined));
    if (t) {
      const [days, kind] = t.value.split("|");
      stageTimes.push({ stage: st.id, days: Number(days), unit: /business|working/i.test(kind!) ? "business" : "calendar", ref: t.ref, quote: t.quote });
    }
  }

  return { words, parameters, documents, stageTimes };
}

/** Keeps only proposals whose quote really appears in the documents (used for Claude's proposals). */
export function verifyProposal(p: SetupProposal, input: SetupInput): SetupProposal {
  const hay = [input.policy?.markdown ?? "", input.sop?.markdown ?? ""].join("\n").replace(/\*\*/g, "").replace(/\s+/g, " ").toLowerCase();
  const ok = (q: string) => q.length > 8 && hay.includes(q.replace(/\*\*/g, "").replace(/\s+/g, " ").toLowerCase().slice(0, 120));
  return {
    words: Object.fromEntries(Object.entries(p.words).filter(([, v]) => v && ok(v.quote))) as SetupProposal["words"],
    parameters: Object.fromEntries(Object.entries(p.parameters).filter(([, v]) => v && ok(v.quote))) as SetupProposal["parameters"],
    documents: p.documents.filter((d) => ok(d.quote)),
    stageTimes: p.stageTimes.filter((s) => ok(s.quote)),
  };
}
