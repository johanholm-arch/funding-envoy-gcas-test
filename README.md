# FundingEnvoy

An external funding platform for the pharmaceutical and medical device industry: grants, donations, sponsorships and
patient-organization support. FundingEnvoy is the system of record. Its assistant, also called FundingEnvoy, prepares
and checks; people decide.

Built from the design concept in `docs/concept/fundingenvoy-concept.html` and the regulatory research in
`docs/research/requirements-report.md`. Progress and decisions are in `docs/BUILD-LOG.md`.

This is a sandbox. Every company, person, document and figure in the demo content is fictional. Halden Pharma (US and
EU) and Meridian Biologics (EU and UK) are the demo tenants.

## Run it

You need Node 22, pnpm 10 and a local Postgres 16 with a `postgres` superuser. The scripts expect the socket in
`/tmp`; set `PGHOST` if yours is elsewhere.

```
pnpm install
pnpm db:reset                      # creates the fundingenvoy database and applies migrations
pnpm seed                          # demo tenants, packs, people, organizations, test set
pnpm --filter @fe/api scenario     # optional: requests at review, committee and payment
pnpm --filter @fe/web build
FE_TODAY=2027-04-02 pnpm --filter @fe/api start
```

Open http://127.0.0.1:8787 and choose a persona. `FE_TODAY` pins the demo date so lead times and screening dates in
the demo content stay current. For front-end work, run `pnpm dev:web` (port 5173, proxied to the API on 8787).

**A short tour.**
1. **Requestor.** Sign in as Dr. Elena Marsh, New England Cardiology Society. Describe a $50,000 symposium in Boston,
   then upload the files in `content/halden/documents/necs-hf2027/`.
2. **Coordinator.** Kwame Osei sees the request on the desk with the items for a person's judgement first.
3. **Committee.** Marisol Alvarez records the decision.
4. **Agreement and payment.** Rania Haddad (Legal) and Daniel Kowalski (Finance) take it through agreement and payment.
5. **Audit.** Priya Nair (compliance auditor) verifies the audit chain.
6. **Configuration and analytics.** Jane Whitfield owns the Studio and Ask.
7. **Operations.** Sophie Brandt runs the managed service across both tenants.
8. **Access.** Ana Ferreira manages people and single sign-on.

## The assistant

Without an API key the demo assistant is used. It reads labelled facts and keywords, calls no AI model, and the
interface says so. To use Claude, set `ANTHROPIC_API_KEY`. The model defaults to `claude-opus-5-5` and can be changed
with `FE_CLAUDE_MODEL`. `FE_ASSISTANT=demo` forces the demo assistant even when a key is set.

Either way the assistant only proposes. Checks, gates, the workflow and the audit trail are deterministic code. Five
actions always need a named person: the funding decision, statements, agreement signature, payment release and
disclosure submission.

## What is simulated

- **E-signature (DocuSign) and ERP (SAP).** Simulated connectors. They record what they would send, as connector
  actions in the trail.
- **Screening lists.** Simulated per country.
- **Single sign-on.** Runs against a built-in demo identity provider. Real OIDC providers work through the same code
  path.
- **Regulatory packs.** The packs in `content/packs/` have not been verified against the primary texts. Every value
  is marked unverified until a person checks it. See `content/packs/VERIFICATION.md`.

## Tests

```
pnpm typecheck
pnpm test                          # 87 tests; they reseed the demo database
pnpm testset                       # the 46-case synthetic test set against the published rulebook
```

Load testing at 500,000 requests and 300 concurrent people is described in `docs/PERFORMANCE.md`.

## Layout

| Path | What |
|---|---|
| `packages/core` | Domain contracts, rule engine, workflow engine, gates, autonomy dial, audit chain |
| `packages/db` | Schema and migrations, row-level security, append-only hash-chained events |
| `packages/agent` | Document reading, policy answers, demo and Claude providers |
| `apps/api` | Fastify API: requests, desk, committee, agreements, payments, disclosure, Studio, Ask, operations, identity |
| `apps/web` | React front end |
| `content/` | Demo tenant content, regulatory packs, synthetic documents and test set |
| `docs/` | Architecture, research, concept, performance, build log |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | local `fundingenvoy` as `fe_app` | Application connection (no superuser, row-level security applies) |
| `DATABASE_ADMIN_URL` | local `fundingenvoy` as `postgres` | Used only to apply migrations |
| `PORT`, `HOST` | 8787, 127.0.0.1 | Where the API listens |
| `FE_WORKERS` | 1 | API processes sharing the port |
| `DB_POOL_MAX` | 20 | Connections per process |
| `FE_COOKIE_SECRET` | demo value | Required in production |
| `FE_TODAY` | today | Pins the date (demo) |
| `FE_DEMO` | on | Persona sign-in and the demo identity provider; set `0` to turn off |
| `FE_PUBLIC_URL` | from the request | Public base URL for sign-in callbacks and SCIM resource links |
| `ANTHROPIC_API_KEY`, `FE_CLAUDE_MODEL`, `FE_ASSISTANT` | | See "The assistant" |
| `FE_ANALYTICS_CONCURRENCY` | 4 | Ask questions running at once |
| `FE_UPLOADS` | `.uploads` | Where uploaded files are stored, by content hash |
