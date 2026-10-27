# Build log

The finished work is on `main`. `build/phase-0-1` is the branch it was built on and is kept as a record.

## Decisions taken (27 October 2026)

- **System of record.** FundingEnvoy is the system of record. Integration with another grants platform comes later.
- **Ledger interface.** The interface follows the Ledger direction from the mockups.
- **Sandbox only.** The first environment is a sandbox with fictional tenants: Halden Pharma, plus Meridian
  Biologics to make multi-tenancy real. No customer name is needed.
- **Recommendations accepted.** Everything else follows the recommendations in the concept, decisions 1 to 7.

## Status against the twelve requirements

| # | Requirement | Status |
|---|---|---|
| 1 | Rethink the grants experience | Built: start from your own words or documents, provenance on every value, checks in the margin, review in your name |
| 2 | Agentic requestor interface | Built: the assistant reads documents, proposes values with their source, asks one question at a time, answers policy with clauses, declines to predict |
| 3 | Agentic coordinator and approver interface, autonomy dial | Built: desk and brief with judgement items first; dial levels 0 to 4 per stage; five actions always a person's |
| 4 | Front-end configurability and branding, single and multi-tenant | Built: brand (colour, name, logo) and words per funder as signed versions; contrast kept automatically; new funders added from the Operations screen |
| 5 | SOP-driven workflow | Built: workflow drafted from an SOP, with a clause diff, stage impact and questions about vague clauses |
| 6 | Dynamic fields and workflows across request types | Built: catalogue of types, fields, documents, statements and conflict questions; conditional fields; stage variations |
| 7 | Front-end configuration for Salesforce and other grants platforms | Not started; deferred by decision (system of record first) |
| 8 | DocuSign, SAP and similar | Simulated connectors behind the same interfaces a real connector would use; recorded in the trail |
| 9 | Hundreds of concurrent users, 500k rows | Measured: 300 people over 500,000 requests, p95 under 400 ms at a realistic pace, no errors (`docs/PERFORMANCE.md`) |
| 10 | Natural-language analytics | Built: Ask plans questions onto a governed metrics library; the model never writes SQL; every answer shows its query |
| 11 | SSO and user management | Built: OIDC per tenant with home-realm discovery, SCIM 2.0 users and groups, roles from directory groups, access administration |
| 12 | Full audit trail of every user, system and AI action | Built: append-only, hash-chained per tenant, checkpointed verification, AI traces on every assistant action, sign-ins included |

## Milestones

| Commit | What |
|---|---|
| `0122ebd` | Core domain: rule engine, workflow engine, gates, autonomy, audit chain |
| `8a8694d` | Database: schema, forced row-level security, append-only events |
| `a75c898` | Assistant layer: documents, policy, demo and Claude providers |
| `acd9de2` | API, desk, audit routes, test-set runner |
| `c6d9c96` | Screening at intake and submission; documents covering several requirements; end-to-end test |
| `44b4bfd` | Demo tenant content (SOP, policy, rulebook, workflow, 46-case test set) |
| `13a4c6a` | Agreements, payments, transfers of value, reconciliation, disclosure |
| `6ff44c8` | Studio: versioned configuration, test-set gating, signed publication |
| `9c8c7a7` | Ask |
| `51760b6` | Second tenant and the managed-service Operations seat |
| `8ffaacc` | OIDC single sign-on, SCIM 2.0, access administration |
| `4169112` | Demo scenario; reference counter |
| `2bf2483` | Scale: 500,000 requests, 300 concurrent people |
| `e0f2d8f` | Web app and the API changes it asked for |

## Found and fixed along the way

- **Money across currencies.** Ask added dollars, pounds and euros together. Money is now reported per currency.
- **Older open work missing from the desk.** At volume, the desk dropped older open requests. It now counts every
  pile.
- **Duplicate references.** Request references collided once drafts were submitted. They now come from a counter.
- **Full scans under row-level security.** Two common query patterns forced full scans when row-level security
  applied. Both now use indexes.
- **Assistant wording.** The assistant showed internal field keys and lowercased organization names.
- **Agreement stage capped too low.** The agreement stage was wrongly capped at "recommend". The cap now applies only
  to the funding decision and payment release.

## Needs a person

- **Verify the regulatory packs.** Primary regulatory sources could not be fetched from this environment, so every
  pack value is marked unverified. A compliance person should check each parameter against the primary text
  (`content/packs/VERIFICATION.md`). The Operations screen shows which values are still unverified.
- **Choose Claude or the demo assistant.** Set `ANTHROPIC_API_KEY` to run the assistant on Claude. The demo assistant
  is clearly labelled and calls no model.
- **Make the repository private if intended.** The GitHub repository is public.

## Open items

- **Salesforce and other platform integrations (requirement 7).** Deferred by decision.
- **Real DocuSign and SAP connectors.** These replace the simulated ones without changing the workflow.
- **Field-by-field editors in Studio.** The catalogue, rulebook and workflow can be drafted, checked, compared and
  published, but not yet edited field by field.
- **Accessibility audit.** It was checked by construction and keyboard, not yet with an automated audit tool.
- **Production hosting.** This means separate database and API hosts, a read replica for analytics, partitioned
  events, and a nightly full chain verification with external timestamping. See `docs/PERFORMANCE.md`.
