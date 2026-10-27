# Authoring notes: phase-0 demo content

Written 27 October 2026 for branch `build/phase-0-1`. Everything here is fictional: Halden Pharma, its people, products (Cardiovex, Halvexa, Renotide) and every requesting organization.

## What is here

| Path | What it is |
|---|---|
| `halden/sop.md` | Management of Grants and Donations SOP v4 (about 3,800 words). Clause numbers match the concept review and mockups: 3.1, 4.1, 5.2, 6.1–6.5 (6.5 states US$5,000), 7.1, 7.4, 8.1, 8.3, 9.2; Annex A (UK), Annex B (France), Annexes C–D (checklists). Retention 10 years (9.3). |
| `halden/policy.md` | Grants and Donations Policy v6 (about 2,070 words): 3.1 eligibility, 4.2 not conditioned, 5.2 revenue cap 25%, 6.1, 6.4 meals and hospitality, 7.3 the nine conflict questions, 8.1 anti-discrimination, 9.2 no business benefit, 10.1 acknowledgement. |
| `halden/catalogue.json` | Catalogue v1: 2 families, 3 subtypes (fields: ime-accredited 33, ime-non-accredited 33, charitable-contribution 21, including 7 internal fields), 8 attestations, 9 COI questions. |
| `halden/rulebook.json` | Rulebook v1, published: 6 packs, 37 tenant rules (29 checks and 8 triage rules T-1…T-8), parameters `revenueCap 0.25`, `leadTimeDays 60`, `singleApproverMaxUSD 5000`, `budgetTolerance 50`, triage map, compliance flags. |
| `halden/workflow.json` | Workflow v1, published, signed by J. Whitfield (process owner): 11 stages, the France compliance variation (company choice) and the SOP 6.5 single-approver variation. |
| `halden/autonomy.json`, `halden/autonomy-cautious.json` | Standard (floor 0.7) and cautious (floor 0.85) autonomy policies. |
| `halden/tenant.json` | Tenant, brand, words, products, 16 people covering every role. |
| `halden/organizations.json` | 16 organizations (US 9, GB 3, FR 4). |
| `halden/requestors.json` | 17 requestor-side people. |
| `halden/documents/` | 16 synthetic source documents for 4 requests (flagship NECS HF2027 complete: letter 2 pp, prospectus 6 pp, budget CSV 11 lines = $48,500, W-9, 2021 non-profit letter, 2025 financial statement) and `INDEX.json`. |
| `halden/testset/` | 46 test cases and a README describing the format and how a runner builds the context. |
| `packs/*.json` | core (6 rules), us (6), accredited-ce (4), efpia (2), uk (5), fr (5): 28 pack rules, 18 parameters, 19 agreement clauses, 4 disclosure regimes, 11 calendar entries. CORE-G5 references `pap.productEarmarked` and `pap.dataReturnedToDonor`, which are deliberately not in the catalogue (the pap-donation subtype is out of scope). |
| `packs/VERIFICATION.md` | What was tried, what remains, and every value with its status. |

**Total rules: 65** (28 in packs, 37 in the rulebook).

## How I checked consistency

- Every JSON file parses (61 files).
- Test expectations were computed by a reference evaluator written to the engine semantics the coordinator gave, then checked by running the real `packages/core/src/rules/engine.ts` (as of this session) over all 46 cases through `tsx`: **0 differences** in check status or `submittable`. The runner logic is described in `halden/testset/README.md`. If the engine changes, re-run that comparison.
- Each rule passes and fails (or judges) in at least one case, except the exceptions listed in the testset README (inform rules with `predicate: always`, triage rules, US-FCPA-01 by scope, CORE-G5 out of scope).

## Interpretation choices

1. **Flagship dates.** The concept review says the request was submitted on 21 October 2026 and that the 14 May 2027 activity is 42 days away; those cannot both be true. The test cases keep 14–15 May 2027 and 42 days, so tc-01…03 use `today = 2027-04-02`. The request letter is dated 29 March 2027 to match. The 2026 dates in the concept's history (21 Oct, 3 Nov) are not reproduced.
2. **Flagship states.** tc-01 is the request as first prepared ($50,000, financial statement missing, COI 6 of 9): R-04 shows 4.2%, R-18 fails. tc-03 is the concept's Checks screen ($48,500 already chosen): 2 must fix (R-11b, R-28), 2 decisions (R-07, R-24). tc-02 is the fixed request: submittable with R-07 (warn) and R-24 (judge).
3. **R-11 split.** R-11a non-profit proof (US associations, patient organizations and charities), R-11b financial statement (all; this is the concept's "R-11 block"), R-11c UK/French charity or association registration.
4. **More statements and documents than the concept shows.** The concept's review screen lists 3 attestations; a US accredited request here needs 7 (accuracy, anti-discrimination, not-conditioned, independence, non-direction, acknowledgement, separation). The flagship's documents include Beacon CME's accreditation statement and COI policy (reused from Beacon's profile), which the concept does not list. Both are needed for tc-02 to be submittable under R-14 and R-16.
5. **R-15 is one rule with severity block.** With the engine's `documentQuote` semantics, `fail` (contradicting wording) blocks and `judge` (silence) goes to the medical reviewer, which is what "judge if not found, block when contradicted" asks for. R-15n (non-accredited) is the same check at severity judge.
6. **R-24 is one rule with severity block.** `budgetLines` returns `fail` for entertainment, gifts or learner travel (blocks) and `judge` for meals or the hospitality keywords dinner, reception, gala, drinks and cocktail (reviewer).
7. **Lead time.** R-07 (60 days, warn) and FR-AC-04 (60 days, judge) apply only at draft, submit and review. R-08 (activity not started, block) and UK-ABPI-02 (prospective) apply at every phase.
8. **Screening.** US-SCR-01 covers US requests (LEIE, SAM, OFAC-SDN, IRS-TEOS); tenant rule R-30 covers non-US requests (OFAC-SDN, UK-OFSI, EU-CFSP, PEP). Each request is screened by exactly one rule.
9. **FCPA tier** (US-FCPA-01) sits in the US pack because it is US law applied to a US company paying abroad. Scope: request country ≠ US and the organization is government controlled. Severity judge.
10. **French thresholds.** FR-AC-02 uses `fr.antiCadeaux.authorisationThreshold.associationDonation = 1000`, the lowest candidate. That sends more cases to a person, and the rule is judge, so a wrong value cannot block or wave through a request on its own. The other candidates are stored as separate unverified parameters.
11. **UK certification and clauses** are held as internal request fields (`uk.certificationRef`, `agreement.clauses`), so UK-ABPI-03/04 run on the current engine (see engine question 2).
12. **France compliance review** is mandatory by workflow variation (`companyChoice: true`); Italy and Korea are noted but outside the pilot countries.
13. **SOP 6.5** applies to USD in the rule (R-31, inform) and the workflow variation. For other currencies the SOP says Finance confirms the equivalent; that is not automated, so tc-43 (€800) takes the committee path.
14. **Agreement and close stages** have assistant level 3 as specified, with `maxLevel` 3. `docs/ARCHITECTURE.md` says the maximum is 2 at stages that contain a locked action. The locked outcomes (sign-agreement, submit-disclosure) still need a person, but one of the two documents needs to change.
15. **Charitable requests skip medical review** (`skipWhen family = charitable`). The concept's 11 stages do not say so explicitly, but SOP 6.1 now does.
16. **Organization types.** NHS hospital charities are `charity` and not government controlled (a separate legal person); the CHU is `teaching-hospital` and government controlled. Beacon CME is a for-profit accredited provider, so R-11a does not apply to it.

## Semantic questions for the engine author

1. **Pack parameters.** Pack rules reference `param.<pack key>`, for example FR-AC-02 → `param.fr.antiCadeaux.authorisationThreshold.associationDonation`, and US-TAX-02's message uses `{{param.tax.form1099.threshold.2026}}`. The engine reads only `ctx.parameters`. Proposal: the caller merges every adopted pack's `parameters[]` (key → value) and then `rulebook.parameters` (the tenant wins). Without this, FR-AC-02 is `pending`.
2. **Agreement facts.** `buildFacts` exposes nothing from `ctx.agreement`. Proposal: add `agreement.certifiedAt`, `agreement.clauseIds` and `agreement.templateId`. UK-ABPI-03/04 could then read the agreement itself instead of internal fields.
3. **Judge and pending messages.** `messages` has only `pass` and `fail`; the engine renders `fail` for `judge`. I wrote the fail text for R-24, R-15, R-15n, US-SCR-01 and R-30 to read correctly in both cases. A `messages.judge` would allow sharper wording, for example "Line 9 'Faculty dinner, $2,400' may be treated as hospitality" exactly as the concept shows. The judge-specific vars (`line`, `description`, `lineAmount`) are already computed.
4. **Phase-filtered rules** are omitted, not returned as `na`; the test expectations list them as `na`. Confirm the runner treats a missing result as `na`.
5. **`coiAllNo` with unanswered questions** returns `pending` (the engine), not `pass`. R-29 is judge, so this does not block. The tests follow the engine.
6. **`budgetLines` with no lines** returns `pending`. R-24 is block, so a request with no budget lines cannot be submitted. That is intended, because R-12 also requires the budget, but say so in the UI.
7. **`equalsWithin.tolerance`** is treated as an absolute amount in request currency (50). It accepts only a number; `rulebook.parameters.budgetTolerance` is stored but not referenced. Allow `"param.<key>"` here too?
8. **`amountMax.currency`** is informational only; no FX conversion. R-31 is scoped to `currency = USD` for that reason.
9. **Triage output.** Rules have no "route to" output. The reviewing group comes from the single passing T-rule, mapped in `rulebook.parameters.triage`. Consider a first-class `routing` field on Rule, or a separate routing table type.
10. **Conditions cannot reference parameters.** The workflow's single-approver variation hard-codes `amount lte 5000`, which duplicates `singleApproverMaxUSD`. Consider `value: "param.x"` in conditions.
11. **`teachingHospitalMatch`** returns judge for `org.type = teaching-hospital` in any country; US-OP-01 is scoped to US.
12. **`screeningClear`** returns `pending` when a named list has no result. Every organization must therefore have results for every list its rule names. Non-US organizations carry the four lists of R-30.
13. **Facts used by the workflow** (`coi.anyYes`, `screening.anyMatch`, `org.governmentControlled`, `amount`, `currency`) all exist in `buildFacts`. `screening.anyMatch` is true for a possible match until it is adjudicated as a false positive.
14. **`documentsPresent.maxAgeMonths`** is not used in rules because test documents carry no dates. The catalogue sets 24 months for the financial statement, and `documents/INDEX.json` carries a `dated` value for each document if the engine wants to use it.
15. **`priorApproval.leadDays`** reads `<recordField>Date`. FR-AC-03 does not set `leadDays` because the French lead times are unverified. The field `fr.conventionRecordDate` exists for when they are verified.
16. **`datesConsistent`** compares field values only. It is not used, because the useful check (agenda versus letter versus form) needs per-document extracted dates. A good candidate once extraction provenance is available.
17. **Attestations without `ids`.** All rules name their ids explicitly. The catalogue's `requiredWhen` on attestations is there for the UI and for any future `attestationsComplete` without ids.

## Verification summary

No value was verified against a primary source. WebFetch failed DNS resolution for every primary host, and curl through the egress proxy received 403 on CONNECT for cms.gov, ecfr.gov, law.cornell.edu, govinfo.gov, federalregister.gov, irs.gov, accme.org, pmcpa.org.uk, legifrance.gouv.fr, eur-lex.europa.eu and openpaymentsdata.cms.gov. Web search worked, but only returned summaries:

- **Corroborated, secondary only:** Open Payments 2026 $13.82 / $138.13; 1099 threshold $2,000 for 2026 payments; ACCME Standard 4 agreement executed before the education starts; Moderna PMCPA case breaches of 8.3 and 23.2.
- **Not found at all:** the French arrêté thresholds and the Décret 2020-730 lead times. These rules are judge.

Every pack value is `verified: false`, with a note on what was tried. `packs/VERIFICATION.md` lists what a person must read before go-live, in priority order.
