// Claude provider. Used when ANTHROPIC_API_KEY (or another SDK credential source) is configured.
// Every output is checked in code before use: extracted values must quote text that exists on the cited
// page, classifications must name a known type, and policy answers may cite only the clauses supplied.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { AiTrace, Catalogue, FieldDef } from "@fe/core";
import { sha256 } from "@fe/core";
import type { QueryPlanOut } from "./provider.ts";
import type { AssistantProvider, DocClassification, ExtractInput, ExtractOutput, FieldProposal, MessageExtraction, PolicyAnswer, RequestClassification } from "./provider.ts";
import { PROMPT_VERSION } from "./provider.ts";
import type { Clause } from "./policy.ts";

const MODEL = process.env.FE_CLAUDE_MODEL ?? "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const SYSTEM = `You work inside FundingEnvoy, a platform that helps organizations prepare funding requests to pharmaceutical and medical device companies, and helps those companies review them.
Your role is to read and organize, never to decide. You do not predict funding decisions, suggest amounts, advocate for a request, or write statements that belong to the requestor.
Only report what the provided material says. When you cite text, copy it exactly as it appears. If the material does not say something, leave it out.`;

const ExtractSchema = z.object({
  proposals: z.array(z.object({
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    documentId: z.string(),
    page: z.number().int(),
    quote: z.string(),
    confidence: z.number(),
  })),
});

const DocSchema = z.object({ type: z.string(), confidence: z.number(), reason: z.string() });

const RequestSchema = z.object({
  subtype: z.string().nullable(),
  confidence: z.number(),
  reasons: z.array(z.string()),
  question: z.string().nullable(),
});

const PolicySchema = z.object({
  supported: z.boolean(),
  answer: z.string(),
  citations: z.array(z.object({ ref: z.string(), quote: z.string() })),
});

export class ClaudeProvider implements AssistantProvider {
  readonly name = "claude" as const;
  readonly model = MODEL;
  private client = new Anthropic();

  private async call<T>(schema: z.ZodType<T>, user: string, effort: Effort, maxTokens = 16000): Promise<{ data: T; trace: AiTrace }> {
    const t0 = Date.now();
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort, format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const data = schema.parse(JSON.parse(text));
    return {
      data,
      trace: {
        provider: "claude", model: response.model, promptVersion: PROMPT_VERSION,
        inputHashes: [sha256(user).slice(0, 16)], outputHash: sha256(text).slice(0, 16), latencyMs: Date.now() - t0,
      },
    };
  }

  async extractFields(input: ExtractInput): Promise<ExtractOutput> {
    const fieldList = input.fields.filter((f) => f.extractable !== false).map((f) => `- ${f.key} (${f.kind}${f.options ? `: one of ${f.options.join(", ")}` : ""}): ${f.label}`).join("\n");
    const docs = input.documents.map((d) => `<document id="${d.id}" name="${d.name}"${d.type ? ` type="${d.type}"` : ""}>\n${d.pages.map((p, i) => `<page n="${i + 1}">\n${p}\n</page>`).join("\n")}\n</document>`).join("\n");
    const prompt = `Read these documents and propose values for the fields listed. For each value give the document id, the page number and a short exact quote from that page that shows the value. Dates as YYYY-MM-DD or YYYY-MM-DDTHH:MM. Numbers without currency symbols. If two documents disagree, propose each value separately so the requestor can see the conflict. Skip fields the documents do not state.\n\nFields:\n${fieldList}\n\n${docs}`;
    const { data, trace } = await this.call(ExtractSchema, prompt, "medium");
    const byId = new Map(input.documents.map((d) => [d.id, d]));
    const keys = new Set(input.fields.map((f) => f.key));
    const verified: FieldProposal[] = [];
    for (const p of data.proposals) {
      const doc = byId.get(p.documentId);
      const page = doc?.pages[p.page - 1];
      if (!doc || !page || !keys.has(p.key)) continue;
      if (!normalize(page).includes(normalize(p.quote))) continue; // provenance must be real
      verified.push({ key: p.key, value: p.value, confidence: Math.max(0, Math.min(1, p.confidence)), source: { kind: "document", documentId: doc.id, documentName: doc.name, page: p.page, quote: p.quote } });
    }
    const groups = new Map<string, FieldProposal[]>();
    for (const p of verified) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
    const proposals: FieldProposal[] = [];
    const conflicts: ExtractOutput["conflicts"] = [];
    for (const [key, list] of groups) {
      const distinct = [...new Map(list.map((p) => [JSON.stringify(p.value), p])).values()].sort((a, b) => b.confidence - a.confidence);
      proposals.push(distinct[0]!);
      if (distinct.length > 1) conflicts.push({ key, values: distinct.map((p) => ({ value: p.value, source: p.source })) });
    }
    return { proposals, conflicts, trace: { ...trace, scores: { proposed: data.proposals.length, verified: verified.length } } };
  }

  async extractFromMessage(text: string, fields: FieldDef[], messageId: string): Promise<MessageExtraction> {
    const fieldList = fields.map((f) => `- ${f.key} (${f.kind}): ${f.label}`).join("\n");
    const prompt = `A requestor wrote this message. Propose values only for facts it states directly. Use documentId "message" and page 1, and quote the exact words.\n\nFields:\n${fieldList}\n\n<message>\n${text}\n</message>`;
    const { data, trace } = await this.call(ExtractSchema, prompt, "low", 4000);
    const keys = new Set(fields.map((f) => f.key));
    const proposals = data.proposals
      .filter((p) => keys.has(p.key) && normalize(text).includes(normalize(p.quote)))
      .map((p) => ({ key: p.key, value: p.value, confidence: p.confidence, source: { kind: "message" as const, messageId, quote: p.quote } }));
    return { proposals, trace };
  }

  async classifyDocument(doc: { name: string; mime: string; pages: string[] }, knownTypes: { type: string; label: string }[]): Promise<DocClassification> {
    const prompt = `Classify this document into exactly one of these types, or "other":\n${knownTypes.map((k) => `- ${k.type}: ${k.label}`).join("\n")}\n\nFile name: ${doc.name}\n<content>\n${doc.pages.slice(0, 2).join("\n\n").slice(0, 12000)}\n</content>`;
    const { data, trace } = await this.call(DocSchema, prompt, "low", 2000);
    const ok = knownTypes.some((k) => k.type === data.type);
    return { type: ok ? data.type : "other", confidence: ok ? data.confidence : 0.3, reason: data.reason, trace };
  }

  async classifyRequest(input: { text: string; proposals: FieldProposal[]; catalogue: Catalogue; country: string }): Promise<RequestClassification> {
    const options = input.catalogue.subtypes.map((s) => `- ${s.id}: ${s.name}. ${s.description} Tells it apart: ${s.distinguishers.join("; ")}`).join("\n");
    const facts = input.proposals.map((p) => `${p.key} = ${JSON.stringify(p.value)}`).join("\n");
    const prompt = `Which request type fits best? If the deciding fact is not stated, say which question to ask the requestor (one question). Country: ${input.country}.\n\nTypes:\n${options}\n\nWhat the requestor said:\n${input.text}\n\nFacts read from their documents:\n${facts}`;
    const { data, trace } = await this.call(RequestSchema, prompt, "medium", 4000);
    const valid = data.subtype && input.catalogue.subtypes.some((s) => s.id === data.subtype) ? data.subtype : undefined;
    return {
      subtype: valid, confidence: valid ? data.confidence : 0, reasons: data.reasons,
      question: data.question ? { text: data.question, options: input.catalogue.subtypes.map((s) => ({ id: s.id, label: s.name, subtype: s.id })) } : undefined,
      trace: { ...trace, scores: { confidence: data.confidence } },
    };
  }

  async planQuery(question: string, metrics: { id: string; label: string; definition: string; synonyms: string[] }[], dimensions: { id: string; label: string }[], today: string): Promise<QueryPlanOut | undefined> {
    const schema = z.object({
      answerable: z.boolean(),
      metric: z.enum(metrics.map((m) => m.id) as [string, ...string[]]),
      groupBy: z.array(z.enum(dimensions.map((d) => d.id) as [string, ...string[]])).max(2),
      filters: z.array(z.object({ dimension: z.enum(["country", "type", "stage", "group"]), value: z.string() })),
      period: z.object({ from: z.string(), to: z.string(), label: z.string() }).nullable(),
    });
    const prompt = `Map this analytics question onto the metrics library. Choose one metric and up to two dimensions to group by. Country filter values are ISO codes (US, GB, FR); type values are request type ids (ime-accredited, ime-non-accredited, charitable-contribution). Period dates are YYYY-MM-DD, "to" exclusive; today is ${today}. If no metric fits, set answerable to false.\n\nMetrics:\n${metrics.map((m) => `- ${m.id}: ${m.label}. ${m.definition}`).join("\n")}\n\nDimensions: ${dimensions.map((d) => `${d.id} (${d.label})`).join(", ")}\n\nQuestion: ${question}`;
    const { data } = await this.call(schema, prompt, "low", 2000);
    if (!data.answerable) return undefined;
    return { metric: data.metric, groupBy: data.groupBy, filters: data.filters, period: data.period ?? undefined };
  }

  async answerPolicy(question: string, clauses: Clause[]): Promise<PolicyAnswer> {
    const corpus = clauses.map((c) => `<clause ref="${c.ref}">${c.heading ? `${c.heading}\n` : ""}${c.text}</clause>`).join("\n");
    const prompt = `Answer the question using only these clauses from the company's policy and procedure. Write two to four plain sentences for someone outside the company. Cite each clause you rely on with its ref and an exact quote. If the clauses do not answer the question, set supported to false.\n\n${corpus}\n\nQuestion: ${question}`;
    const { data, trace } = await this.call(PolicySchema, prompt, "medium", 4000);
    const byRef = new Map(clauses.map((c) => [c.ref, c]));
    const citations = data.citations.filter((c) => byRef.has(c.ref) && normalize(byRef.get(c.ref)!.text + " " + (byRef.get(c.ref)!.heading ?? "")).includes(normalize(c.quote)));
    if (!data.supported || !citations.length) return { answer: "", citations: [], declined: "out-of-corpus", trace };
    return { answer: data.answer, citations, trace };
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}