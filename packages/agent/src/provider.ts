import type { AiTrace, Catalogue, FieldDef, Provenance } from "@fe/core";
import type { Clause } from "./policy.ts";
import type { SetupInput, SetupProposal } from "./setup.ts";

export interface SourceDocument {
  id: string;
  name: string;
  type?: string; // classified type, if known
  pages: string[];
}

export interface FieldProposal {
  key: string;
  value: unknown;
  source: Provenance;
  confidence: number; // 0..1
}

export interface ExtractInput {
  documents: SourceDocument[];
  fields: FieldDef[];
  subtype?: string;
}

export interface ExtractOutput {
  proposals: FieldProposal[];
  conflicts: { key: string; values: { value: unknown; source: Provenance }[] }[];
  trace: AiTrace;
}

export interface DocClassification {
  type: string;
  confidence: number;
  reason: string;
  trace: AiTrace;
}

export interface RequestClassification {
  subtype?: string;
  confidence: number;
  reasons: string[];
  /** A question for the requestor whose answer decides the type, with options. */
  question?: { text: string; options: { id: string; label: string; subtype?: string }[] };
  trace: AiTrace;
}

export interface PolicyAnswer {
  answer: string;
  citations: { ref: string; quote: string }[];
  declined?: string;
  trace: AiTrace;
}

export interface MessageExtraction {
  proposals: FieldProposal[];
  trace: AiTrace;
}

/** Everything the assistant does that needs judgement over text. Orchestration, checks and gates are deterministic and live elsewhere. */
export interface AssistantProvider {
  readonly name: "claude" | "demo";
  readonly model: string;
  extractFields(input: ExtractInput): Promise<ExtractOutput>;
  extractFromMessage(text: string, fields: FieldDef[], messageId: string): Promise<MessageExtraction>;
  classifyDocument(doc: { name: string; mime: string; pages: string[] }, knownTypes: { type: string; label: string }[]): Promise<DocClassification>;
  classifyRequest(input: { text: string; proposals: FieldProposal[]; catalogue: Catalogue; country: string }): Promise<RequestClassification>;
  answerPolicy(question: string, clauses: Clause[]): Promise<PolicyAnswer>;
  /** Optional: map an analytics question onto the metrics library. Returns undefined when the library cannot answer it. */
  /** Read a funder's policy and SOP and propose its words, limits, required documents and stage times, each with its source. */
  proposeSetup(input: SetupInput): Promise<SetupProposal & { trace: AiTrace }>;
  planQuery?(question: string, metrics: { id: string; label: string; definition: string; synonyms: string[] }[], dimensions: { id: string; label: string }[], today: string): Promise<QueryPlanOut | undefined>;
}

export interface QueryPlanOut { metric: string; groupBy: string[]; filters: { dimension: string; value: string }[]; period?: { from: string; to: string; label: string } }

export const PROMPT_VERSION = "fe-2026-10-27.1";
