# Architecture

This document is the contract between the parts of the codebase. If code and this document disagree, fix one of them in the same change.

## Shape

```
apps/web        React + Vite. The Ledger UI for every seat.
apps/api        Fastify. HTTP API, sessions, tenant context, orchestration.
packages/core   Pure TypeScript, no I/O. Domain types, rulebook engine, workflow
                engine, gatekeeper (six gates, locked outcomes), autonomy policy,
                audit hash chain, conditions, money and business-day maths.
packages/db     PostgreSQL migrations (SQL), row-level security, repositories.
packages/agent  The FundingEnvoy assistant. A provider interface with two
                implementations: Claude (when ANTHROPIC_API_KEY is set) and a
                deterministic demo provider (labelled as such in the UI).
content/packs   Country and code packs as data (US, UK, FR, core).
content/halden  The demo tenant: SOP, policy, catalogue, rulebook, workflow,
                brand, words, synthetic documents and the synthetic test set.
```

## Principles that shape the code

1. **The request is a ledger.** Every change is an event appended to `events` with a per-tenant hash chain. Projections (`requests.state`, `payments`, `transfers_of_value`) are written in the same transaction. The audit trail is the primary record, not a side table.
2. **Agents propose, people decide.** Anything the assistant produces is a proposal with provenance. Five actions are locked to a named person by `packages/core/src/gates.ts`: decide funding, attest, sign an agreement, release a payment, submit a disclosure. No configuration can lower that.
3. **Rules are data; gates are code.** Tenant rulebooks and country packs are versioned JSON evaluated by a deterministic engine. The six global gates are code and cannot be removed by a tenant.
4. **Configuration is versioned and signed.** Rulebook, workflow, catalogue, autonomy policy, brand and words are rows in `config_versions`. A published version is immutable (database trigger). Every request pins the versions it started on.
5. **Tenant isolation is enforced twice.** Application code scopes every query by tenant, and Postgres row-level security enforces it again using `app.tenant_id`, set per transaction from the authenticated session. The application role has no `BYPASSRLS`.

## Domain vocabulary

| Term | Meaning |
|---|---|
| Tenant | A funder (pharma or medtech company). Owns its configuration, requests and people. |
| Organization | A requesting entity (society, hospital, university, charity, patient group). Owns its passport. |
| Passport | The organization's reusable profile: identity, identifiers, tax status, revenue, screening results, documents, signers. Shared per tenant by consent. |
| Request | A funding request. Family, subtype, country, fields with provenance, documents, attestations, conflict-of-interest answers, checks, stage. |
| Family / subtype | The catalogue. Pilot families: education (accredited, non-accredited) and charitable contributions. |
| Rule | A deterministic check with scope, basis, severity and messages. |
| Pack | A versioned bundle of rules, clause requirements, disclosure mappings and calendar entries for a country or code. |
| Stage | A workflow step with an owner role, time allowed, the assistant's autonomy level and outcomes. |
| Autonomy level | 0 Off, 1 Observe, 2 Recommend, 3 Act with confirmation, 4 Autonomous within the rulebook. |
| Locked action | One of the five actions only a named person may take. Where every way forward from a stage is a locked action (committee decision, payment release), the assistant is capped at level 2; elsewhere it may work at its level but never take the locked outcome itself. |

## Severity

| Severity | Meaning for submission | Shown as |
|---|---|---|
| `block` | Cannot submit until resolved. | Must fix |
| `warn` | Requestor decides (submit with flag, or change). Reviewer sees the flag. | Your call |
| `judge` | Passes to a reviewer as an item for judgement. | For you (reviewer) |
| `inform` | Information only. | Note |

## Provenance

Every field value is `{ value, status, source }` where `status` is `proposed | confirmed | changed` and `source` names a document page or cell, a message, the passport, the form, or a derivation. Nothing is written as confirmed until the requestor confirms it.

## Audit event

```
{ tenantId, seq, id, at, actor {type: person|agent|system|connector, id, name, roles},
  entity {type, id}, action, data,
  ai? { provider, model, promptVersion, inputHashes[], outputHash, scores, gate {stage, level, outcome}, humanDecision? },
  prevHash, hash }
hash = sha256(prevHash + canonicalJson(event without hash))
```

Chain heads are anchored nightly to `chain_anchors`; verification walks the chain and recomputes every hash.

## Environments

The demo runs on a local PostgreSQL 16 and the deterministic demo provider. Setting `ANTHROPIC_API_KEY` switches the assistant to Claude. E-signature and ERP connectors run in simulated mode unless their credentials are configured.
