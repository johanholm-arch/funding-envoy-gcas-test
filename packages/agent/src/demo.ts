// Deterministic demo provider. It reads "Label: value" lines and keywords; it does not call any model.
// The UI labels its output "demo assistant" so nobody mistakes it for model output.
import { proposeSetupFromText, type SetupInput, type SetupProposal } from "./setup.ts";
import type { AiTrace, Catalogue, FieldDef, Provenance } from "@fe/core";
import { sha256, toNumber } from "@fe/core";
import type { AssistantProvider, DocClassification, ExtractInput, ExtractOutput, FieldProposal, MessageExtraction, PolicyAnswer, RequestClassification } from "./provider.ts";
import { PROMPT_VERSION } from "./provider.ts";
import type { Clause } from "./policy.ts";

const SYNONYMS: Record<string, string[]> = {
  title: ["title", "programme title", "program title", "activity title", "activity", "programme"],
  purpose: ["purpose", "purpose of request", "request purpose"],
  "amount.requested": ["amount requested", "requested amount", "funding requested", "request amount", "grant requested"],
  "amount.currency": ["currency"],
  "provider.name": ["accredited provider", "provider", "cme provider", "accrediting provider"],
  "provider.accreditor": ["accreditor", "accredited by", "accreditation body"],
  credits: ["credits", "credit", "credit hours", "cme credits"],
  "activity.startDate": ["start", "start date", "activity start", "begins"],
  "activity.endDate": ["end", "end date", "activity end", "ends"],
  "activity.location": ["location", "venue", "city"],
  "activity.format": ["format", "delivery format"],
  "audience.expected": ["expected learners", "expected attendance", "expected participants", "expected attendees", "learners expected"],
  "audience.breakdown": ["audience breakdown", "audience mix", "audience composition"],
  "audience.geography": ["audience geography", "audience location", "audience"],
  learningObjectives: ["learning objectives", "objectives"],
  needsAssessment: ["needs assessment", "educational need", "gap analysis"],
  "outcomes.methods": ["outcomes", "outcomes measurement", "evaluation", "outcomes plan"],
  otherFunders: ["other funders", "other supporters", "other commercial supporters", "co-funders"],
  "independence.contentControl": ["supporter role", "independence", "content control"],
  "independence.facultySelection": ["faculty selection"],
  beneficiaries: ["beneficiaries", "who benefits", "beneficiary"],
  programmeDescription: ["programme description", "program description", "project description"],
  "therapeuticArea": ["therapeutic area", "disease area"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function trace(name: string, inputs: unknown[], output: unknown, started: number): AiTrace {
  return {
    provider: "demo", model: "fe-demo-rules-1", promptVersion: PROMPT_VERSION,
    inputHashes: inputs.map((i) => sha256(typeof i === "string" ? i : JSON.stringify(i)).slice(0, 16)),
    outputHash: sha256(JSON.stringify(output) ?? "").slice(0, 16),
    latencyMs: Date.now() - started,
    scores: {},
    ...(name ? {} : {}),
  };
}

function coerce(field: FieldDef, raw: string): unknown {
  const v = raw.trim().replace(/\s+$/, "");
  switch (field.kind) {
    case "number": case "money": {
      const n = toNumber(v.replace(/\b(usd|gbp|eur)\b/i, ""));
      return n ?? v;
    }
    case "boolean": return /^(yes|true|y|accredited)$/i.test(v);
    case "date": { const m = /(\d{4}-\d{2}-\d{2})/.exec(v); return m ? m[1] : v; }
    case "datetime": { const m = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(v); return m ? (m[2] ? `${m[1]}T${m[2]}` : m[1]) : v; }
    case "enum": {
      const opt = field.options?.find((o) => norm(o) === norm(v) || norm(v).includes(norm(o)));
      return opt ?? v;
    }
    default: return v;
  }
}

function labelsFor(f: FieldDef): string[] {
  return [...new Set([norm(f.label), ...(SYNONYMS[f.key] ?? []).map(norm)])];
}

const LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z][A-Za-z0-9 /&()'’-]{1,60}?)(?:\*\*)?\s*:\s*(.+?)\s*$/;

export function extractLabelled(docs: ExtractInput["documents"], fields: FieldDef[]): { proposals: FieldProposal[]; conflicts: ExtractOutput["conflicts"] } {
  const byLabel = new Map<string, FieldDef>();
  for (const f of fields) for (const l of labelsFor(f)) if (!byLabel.has(l)) byLabel.set(l, f);
  const found = new Map<string, FieldProposal[]>();
  for (const d of docs) {
    d.pages.forEach((text, pi) => {
      text.split(/\r?\n/).forEach((line, li) => {
        const m = LINE.exec(line);
        if (!m) return;
        const f = byLabel.get(norm(m[1]!));
        if (!f) return;
        const value = coerce(f, m[2]!);
        const source: Provenance = { kind: "document", documentId: d.id, documentName: d.name, page: pi + 1, paragraph: li + 1, quote: line.trim().replace(/\*\*/g, "") };
        const list = found.get(f.key) ?? [];
        list.push({ key: f.key, value, source, confidence: 0.9 });
        found.set(f.key, list);
      });
    });
  }
  // derived values
  const credits = found.get("credits")?.[0];
  const provider = found.get("provider.name")?.[0];
  if ((credits || provider) && fields.some((f) => f.key === "provider.accredited") && !found.has("provider.accredited")) {
    const src = (credits ?? provider)!.source;
    found.set("provider.accredited", [{ key: "provider.accredited", value: true, source: { ...src, kind: "derived", note: "Credit offered by a named accredited provider" }, confidence: 0.8 }]);
  }
  const outcomes = found.get("outcomes.methods")?.[0];
  if (outcomes && fields.some((f) => f.key === "outcomes.level") && !found.has("outcomes.level")) {
    const m = /moore(?:'s)?\s*(?:level\s*)?(\d[ab]?)/i.exec(String(outcomes.value));
    if (m) found.set("outcomes.level", [{ key: "outcomes.level", value: `moore-${m[1]!.toLowerCase()}`, source: { ...outcomes.source, kind: "derived" }, confidence: 0.85 }]);
  }
  const loc = found.get("activity.location")?.[0];
  const geoField = fields.find((f) => f.key === "audience.geography");
  if (loc && geoField && !found.has("audience.geography")) {
    const s = String(loc.value);
    const geo = /\b(US|USA|United States)\b/.test(s) ? "mainly-us" : /\b(UK|GB|United Kingdom|England|Scotland|Wales)\b/.test(s) ? "mainly-uk" : /\b(France|FR)\b/.test(s) ? "mainly-fr" : undefined;
    if (geo && (!geoField.options || geoField.options.includes(geo))) found.set("audience.geography", [{ key: "audience.geography", value: geo, source: { ...loc.source, kind: "derived", note: "From the activity location" }, confidence: 0.7 }]);
  }
  // The currency stated with the amount ("Amount requested: EUR 25,000") is the request's currency, same quote.
  const amt = found.get("amount.requested")?.[0];
  if (amt && fields.some((f) => f.key === "amount.currency") && !found.has("amount.currency")) {
    const q = amt.source.quote ?? "";
    const cur = /\b(USD|GBP|EUR)\b/i.exec(q)?.[1]?.toUpperCase() ?? (/£/.test(q) ? "GBP" : /€/.test(q) ? "EUR" : /\$/.test(q) ? "USD" : undefined);
    if (cur) found.set("amount.currency", [{ key: "amount.currency", value: cur, source: { ...amt.source, kind: "derived", note: "Currency stated with the amount" }, confidence: 0.85 }]);
  }
  // split "14–15 May 2027" style is not needed: demo documents use ISO dates.
  const proposals: FieldProposal[] = [];
  const conflicts: ExtractOutput["conflicts"] = [];
  for (const [key, list] of found) {
    const distinct = [...new Map(list.map((p) => [JSON.stringify(p.value), p])).values()];
    proposals.push(distinct[0]!);
    if (distinct.length > 1 && !["title"].includes(key)) conflicts.push({ key, values: distinct.map((p) => ({ value: p.value, source: p.source })) });
  }
  return { proposals, conflicts };
}

const DOC_RULES: [string, RegExp, RegExp][] = [
  ["budget", /budget/i, /\b(line|description).*(amount)\b/i],
  ["request-letter", /(request.?letter|letter.?of.?request|cover.?letter|\bletter\b|lettre.?de.?demande)/i, /\b(dear|we are writing|request(ing)? (support|funding)|madame, monsieur|sollicite)/i],
  ["prospectus", /(prospectus|agenda|programme|program|brochure)/i, /\b(agenda|faculty|learning objectives|accredited provider)\b/i],
  ["w9", /\bw-?9\b/i, /request for taxpayer identification/i],
  ["nonprofit-proof", /(determination|501c3|501\(c\)|nonprofit|non-profit|exempt)/i, /\b(determination letter|501\(c\)\(3\)|exempt from federal income tax)\b/i],
  ["financial-statement", /(financial|annual.?report|accounts|statement|comptes)/i, /\b(statement of activities|total revenue|gross revenue|balance sheet)\b/i],
  ["accreditation-statement", /accredit/i, /\b(accreditation statement|is accredited by|accredited by the [A-Z]{3,})/i],
  ["coi-policy", /(conflict|coi)/i, /\bconflict of interest policy\b/i],
  ["charity-registration", /(charity|registration|association|prefecture|journal.?officiel)/i, /\b(registered charity|charity commission|association loi 1901|journal officiel)\b/i],
  ["bylaws", /(bylaw|by-law|constitution|statuts)/i, /\b(by-?laws|constitution)\b/i],
];

/** Other requirement types a document's text also satisfies, with the page where the evidence is. */
export function alsoCovers(pages: string[], mainType: string, allowed: string[]): { type: string; page: number }[] {
  const out: { type: string; page: number }[] = [];
  for (const [type, , bodyRe] of DOC_RULES) {
    if (type === mainType || !allowed.includes(type) || ["budget", "request-letter", "prospectus"].includes(type)) continue;
    const page = pages.findIndex((p) => bodyRe.test(p));
    if (page >= 0) out.push({ type, page: page + 1 });
  }
  return out;
}

export class DemoProvider implements AssistantProvider {
  readonly name = "demo" as const;
  readonly model = "fe-demo-rules-1";

  async proposeSetup(input: SetupInput): Promise<SetupProposal & { trace: AiTrace }> {
    const t0 = Date.now();
    const out = proposeSetupFromText(input);
    return { ...out, trace: trace("setup", [input.policy?.markdown ?? "", input.sop?.markdown ?? ""], out, t0) };
  }

  async extractFields(input: ExtractInput): Promise<ExtractOutput> {
    const t0 = Date.now();
    const out = extractLabelled(input.documents, input.fields);
    return { ...out, trace: trace("extract", input.documents.map((d) => d.pages.join("\n")), out, t0) };
  }

  async extractFromMessage(text: string, fields: FieldDef[], messageId: string): Promise<MessageExtraction> {
    const t0 = Date.now();
    const proposals: FieldProposal[] = [];
    const src = (quote: string): Provenance => ({ kind: "message", messageId, quote });
    const has = (k: string) => fields.some((f) => f.key === k);
    const money = /(?:\$|usd\s?|£|gbp\s?|€|eur\s?)\s?([\d,]+(?:\.\d+)?)\s*(k|thousand)?/i.exec(text);
    if (money && has("amount.requested")) {
      const n = toNumber(money[1]!)! * (money[2] ? 1000 : 1);
      proposals.push({ key: "amount.requested", value: n, source: src(money[0]), confidence: 0.85 });
      const cur = /£|gbp/i.test(money[0]) ? "GBP" : /€|eur/i.test(money[0]) ? "EUR" : "USD";
      if (has("amount.currency")) proposals.push({ key: "amount.currency", value: cur, source: src(money[0]), confidence: 0.85 });
    }
    const iso = [...text.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]!);
    const MONTHS = "january february march april may june july august september october november december".split(" ");
    const span = /(\d{1,2})\s*(?:[–-]|to)\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text) ?? /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
    if (span) {
      const parts = span.length === 5 ? { d1: span[1]!, d2: span[2]!, mon: span[3]!, y: span[4]! } : { d1: span[1]!, d2: span[1]!, mon: span[2]!, y: span[3]! };
      const mi = MONTHS.indexOf(parts.mon.toLowerCase());
      if (mi >= 0) {
        const mm = String(mi + 1).padStart(2, "0");
        iso.push(`${parts.y}-${mm}-${parts.d1.padStart(2, "0")}`, `${parts.y}-${mm}-${parts.d2.padStart(2, "0")}`);
      }
    }
    if (iso[0] && has("activity.startDate")) proposals.push({ key: "activity.startDate", value: iso[0], source: src(span?.[0] ?? iso[0]), confidence: 0.8 });
    if (iso[1] && has("activity.endDate")) proposals.push({ key: "activity.endDate", value: iso[1], source: src(span?.[0] ?? iso[1]), confidence: 0.8 });
    const city = /\bin ([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?:,\s*([A-Z]{2}))?/.exec(text);
    if (city && has("activity.location") && !/^(May|June|July|April|March)$/.test(city[1]!)) proposals.push({ key: "activity.location", value: city[2] ? `${city[1]}, ${city[2]}` : city[1], source: src(city[0]), confidence: 0.6 });
    return { proposals, trace: trace("message", [text], proposals, t0) };
  }

  async classifyDocument(doc: { name: string; mime: string; pages: string[] }, knownTypes: { type: string; label: string }[]): Promise<DocClassification> {
    const t0 = Date.now();
    const allowed = new Set(knownTypes.map((k) => k.type));
    const body = doc.pages.slice(0, 2).join("\n");
    const fileName = doc.name.replace(/[_.-]+/g, " ");
    let best: DocClassification | undefined;
    for (const [type, nameRe, bodyRe] of DOC_RULES) {
      if (allowed.size && !allowed.has(type)) continue;
      const byName = nameRe.test(fileName) || nameRe.test(doc.name), byBody = bodyRe.test(body);
      if (byName || byBody) {
        const confidence = byName && byBody ? 0.95 : byName ? 0.85 : 0.7;
        if (!best || confidence > best.confidence) best = { type, confidence, reason: byName && byBody ? "File name and contents" : byName ? "File name" : "Contents", trace: trace("", [doc.name, body], type, t0) };
      }
    }
    if (/\.(csv|xlsx)$/i.test(doc.name) && (!best || best.confidence < 0.9) && allowed.has("budget")) {
      best = { type: "budget", confidence: 0.8, reason: "Spreadsheet", trace: trace("", [doc.name], "budget", t0) };
    }
    return best ?? { type: "other", confidence: 0.3, reason: "Not recognised", trace: trace("", [doc.name], "other", t0) };
  }

  async classifyRequest(input: { text: string; proposals: FieldProposal[]; catalogue: Catalogue; country: string }): Promise<RequestClassification> {
    const t0 = Date.now();
    const text = input.text.toLowerCase();
    const p = (k: string) => input.proposals.find((x) => x.key === k)?.value;
    const ids = new Set(input.catalogue.subtypes.map((s) => s.id));
    const reasons: string[] = [];
    let subtype: string | undefined, confidence = 0.4;
    const credit = p("credits") || /\b(cme|cpd|ce credit|credits?|accredited)\b/.test(text);
    const edu = credit || /\b(education|symposium|course|conference|grand rounds|webinar|training)\b/.test(text);
    const charity = /\b(donation|charit|relief|community|foundation|fundrais|patient support|humanitarian)\b/.test(text);
    if (credit && ids.has("ime-accredited")) { subtype = "ime-accredited"; confidence = p("provider.name") ? 0.91 : 0.75; reasons.push(p("provider.name") ? `Credit offered with ${String(p("provider.name"))} named as provider` : "Credit mentioned"); }
    else if (edu && ids.has("ime-non-accredited")) { subtype = "ime-non-accredited"; confidence = 0.7; reasons.push("Educational activity without credit"); }
    else if (charity && ids.has("charitable-contribution")) { subtype = "charitable-contribution"; confidence = 0.8; reasons.push("Charitable purpose described"); }
    let question: RequestClassification["question"];
    if (subtype === "ime-accredited") {
      const prov = p("provider.name") ? String(p("provider.name")) : "the provider";
      question = {
        text: `Is ${prov} the accredited provider that controls the content and faculty?`,
        options: [
          { id: "yes", label: `Yes, ${prov} is the accredited provider`, subtype: "ime-accredited" },
          { id: "no-credit", label: "No credit is offered", subtype: "ime-non-accredited" },
          { id: "unsure", label: "Not sure" },
        ],
      };
    } else if (!subtype) {
      question = {
        text: "Which best describes what you're asking for?",
        options: input.catalogue.subtypes.map((s) => ({ id: s.id, label: s.name, subtype: s.id })),
      };
    }
    const out = { subtype, confidence, reasons, question };
    return { ...out, trace: { ...trace("", [input.text], out, t0), scores: { confidence } } };
  }

  async answerPolicy(question: string, clauses: Clause[]): Promise<PolicyAnswer> {
    const t0 = Date.now();
    if (!clauses.length) return { answer: "", citations: [], declined: "out-of-corpus", trace: trace("", [question], null, t0) };
    const top = clauses[0]!;
    const qt = new Set(question.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    let quote = top.text.trim();
    if (quote.length > 400) {
      const sentences = top.text.split(/(?<=[.;])\s+/).filter((x) => x.length > 30);
      quote = ([...sentences].sort((a, b) => score(b, qt) - score(a, qt)).slice(0, 2).join(" ") || top.text.slice(0, 400)).trim();
    }
    const second = clauses[1] && score(clauses[1].text, qt) > 0 ? clauses[1] : undefined;
    const answer = `${top.ref}${top.heading ? ` (${top.heading})` : ""} covers this: "${quote}"${second ? ` See also ${second.ref}.` : ""}`;
    const out = { answer, citations: [{ ref: top.ref, quote }, ...(second ? [{ ref: second.ref, quote: second.text.split(/(?<=\.)\s/)[0]!.trim() }] : [])] };
    return { ...out, trace: trace("", [question, ...clauses.map((c) => c.ref)], out, t0) };
  }
}

function score(s: string, q: Set<string>): number {
  return s.toLowerCase().split(/\W+/).filter((w) => q.has(w)).length;
}
