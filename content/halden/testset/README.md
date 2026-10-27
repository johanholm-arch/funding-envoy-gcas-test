# Halden test set

46 synthetic requests, one JSON file each. Every expected value was derived from the rules as published in `content/packs/*.json` and `content/halden/rulebook.json` (version 1). The same expectations were checked against `packages/core/src/rules/engine.ts` as it stood on 27 October 2026: 0 differences.

## File format

```jsonc
{
  "id": "tc-01",
  "title": "…", "purpose": "…",
  "organizationId": "…",            // from content/halden/organizations.json
  "subtype": "ime-accredited",       // family is taken from the catalogue
  "country": "US",
  "today": "2027-04-02",             // the date used as "now" (lead time, screening age)
  "phase": "submit",                 // "submit" or "pre-payment": rules whose appliesAt excludes the phase are "na"
  "fields": { "title": "…", "amount.requested": 50000, … },   // raw values; wrap as confirmed FieldValues
  "budget": [ { "line": 1, "description": "…", "category": "venue", "amount": 12800 } ],
  "documents": ["request-letter", "prospectus", …],           // document types present
  "documentText": { "prospectus": "…" },                       // optional: text of that document as ONE page (pagesText[0])
  "attestations": ["accuracy", …],                             // ids typed by the requestor
  "coi": { "coi-1": "no", … },                                 // unanswered questions are absent
  "screening": "clear",                                        // "clear" | "possible-match" | "match"
  "openRequestsAmount": 0,                                     // other requested+pending+approved this calendar year
  "agreement": { "templateId": "…", "signatures": [ { "party": "…", "name": "…", "at": "…" } ], "certifiedAt": "…", "clauseIds": [ … ] },  // pre-payment cases only
  "expected": {
    "checks": { "R-04": "pass", "R-07": "fail", "T-5": "na", … },  // EVERY rule id in the six packs and the rulebook
    "submittable": false,             // no block rule in fail or pending
    "reviewingGroup": "US medical education",   // group of the single triage rule (T-1…T-8) that passes; map in rulebook.parameters.triage
    "routesToCompliance": false,      // coi any yes OR screening not clear OR org.governmentControlled OR country FR
    "approvalPath": "committee",      // "single-approver" when charitable, USD and amount <= 5,000 (SOP 6.5)
    "notes": "…"
  }
}
```

## How the runner must build the evaluation context

- **Organization:** the record from `organizations.json`, with `screening` replaced by one entry per list (`LEIE, SAM, OFAC-SDN, IRS-TEOS, UK-OFSI, EU-CFSP, PEP`), each with `result` = the test's `screening` value, `checkedAt` = `today`, and no adjudication. The organization's own screening entries are for the demo UI, not for tests.
- **Request:** `typeConfirmed: true`, `status: "draft"`, `stage: "intake"`; every field `{ value, status: "confirmed", source: { kind: "form" } }`; attestation and COI records timestamped on `today`.
- **Documents:** one `EvalDocument` per type in `documents`; `pagesText` = `[documentText[type]]` when given, otherwise undefined.
- **Parameters:** pack parameters (`key → value`, all six packs) merged with `rulebook.parameters`; the rulebook wins on a clash. Several pack rules use `param.<pack key>`, for example `param.fr.antiCadeaux.authorisationThreshold.associationDonation`.
- **Other context:** `teachingHospitalIds: ["070099"]` (Mercy Ridge's fictional CCN); `productNames` = `tenant.json` `products` (`Cardiovex`, `Halvexa`, `Renotide`); `agreement` from the test when present.
- **Evaluation:** `evaluateRules(allRules, ctx, { phase, includeOutOfScope: true })`. Rules filtered out by phase are omitted by the engine; the expectations list them as `na`.

## Coverage

Every rule passes in at least one case and fails (or returns judge) in at least one, except where that is impossible by construction:

- Always-pass inform rules: CORE-G2, EFPIA-01, UK-ABPI-05, FR-AC-01, FR-TS-01, US-TAX-02 (they document a duty; their check is `predicate: always`).
- Triage rules T-1…T-8 are `pass` when in scope and `na` otherwise; each is hit at least once.
- US-FCPA-01's scope requires a government-controlled recipient, so it can only fail (judge) when in scope.
- CORE-G5 applies only to `pap-donation`, which is not in the catalogue: always `na`.

Boundary cases: lead time 59 / 60 / 61 days (tc-04…06), revenue cap exactly 25% and 25.005% (tc-08, tc-09), budget difference 50 and 51 against a tolerance of 50 (tc-12, tc-13).

## Cases

| Case | Title | Type | Phase | Submittable | Reviewing group | Not passing |
|---|---|---|---|---|---|---|
| tc-01 | Flagship: NECS Heart Failure 2027, as first prepared | ime-accredited · US | submit | no | US medical education | R-07 fail, R-11b fail, R-18 fail, R-24 judge, R-28 fail, R-29 pending |
| tc-02 | Flagship: NECS Heart Failure 2027, fixed | ime-accredited · US | submit | yes | US medical education | R-07 fail, R-24 judge |
| tc-03 | Flagship: NECS at the Checks screen | ime-accredited · US | submit | no | US medical education | R-07 fail, R-11b fail, R-24 judge, R-28 fail, R-29 pending |
| tc-04 | Lead time 59 days | ime-accredited · US | submit | yes | US medical education | R-07 fail, R-24 judge |
| tc-05 | Lead time exactly 60 days | ime-accredited · US | submit | yes | US medical education | R-24 judge |
| tc-06 | Lead time 61 days | ime-accredited · US | submit | yes | US medical education | R-24 judge |
| tc-07 | UK masterclass already held | ime-accredited · GB | submit | no | UK medical education | UK-ABPI-02 fail, R-07 fail, R-08 fail |
| tc-08 | Revenue cap exactly 25% | ime-accredited · US | submit | yes | US medical education | — |
| tc-09 | Revenue cap just over | ime-accredited · US | submit | no | US medical education | R-04 fail |
| tc-10 | Revenue cap breached by open requests | ime-accredited · US | submit | no | US medical education | R-04 fail, R-24 judge |
| tc-11 | Organization with no revenue on its profile | ime-accredited · US | submit | no | US medical education | R-04 pending |
| tc-12 | Budget differs by $50 (within tolerance) | ime-accredited · US | submit | yes | US medical education | R-24 judge |
| tc-13 | Budget differs by $51 (outside tolerance) | ime-accredited · US | submit | yes | US medical education | R-18 fail, R-24 judge |
| tc-14 | Entertainment and gifts in the budget | ime-accredited · US | submit | no | US medical education | R-24 fail |
| tc-15 | Learner travel in the budget | ime-accredited · US | submit | no | US medical education | R-24 fail |
| tc-16 | Early draft | ime-accredited · US | submit | no | US medical education | CORE-G3 fail, US-OP-02 fail, ACE-02 fail, R-06 fail, R-06e fail, R-11a fail, R-11b fail, R-12 fail, R-13 fail, R-14 fail, R-15 pending, R-16 fail, R-18 pending, R-21 fail, R-22 fail, R-23 fail, R-24 pending, R-26 fail, R-28 fail, R-29 pending |
| tc-17 | US accredited grant at payment; hospitality found by keyword | ime-accredited · US | pre-payment | yes | US medical education | R-24 judge |
| tc-18 | Individual physician asks for congress support | ime-non-accredited · US | submit | no | US medical education | CORE-G1 fail, R-02 fail, R-04 pending, R-15n judge, R-24 fail |
| tc-19 | Sanctions screening: possible match | charitable-contribution · US | submit | yes | US charitable contributions | US-SCR-01 judge, R-31 fail |
| tc-20 | Sanctions screening: confirmed match | charitable-contribution · US | submit | no | US charitable contributions | US-SCR-01 fail, R-31 fail |
| tc-21 | Government-controlled foreign hospital | ime-non-accredited · FR | submit | yes | France medical affairs | US-FCPA-01 fail, FR-AC-02 fail, R-29 fail, R-30 judge |
| tc-22 | Conflict of interest 'yes' | ime-accredited · US | submit | yes | US medical education | R-24 judge, R-29 fail |
| tc-23 | Three statements missing | ime-accredited · US | submit | no | US medical education | R-21 fail, R-22 fail, R-24 judge, R-26 fail |
| tc-24 | Not-conditioned statement missing | ime-accredited · US | submit | no | US medical education | CORE-G3 fail, R-24 judge |
| tc-25 | Non-direction statement missing | ime-accredited · US | submit | no | US medical education | US-OP-02 fail, R-24 judge |
| tc-26 | Independence and separation statements missing | ime-accredited · US | submit | no | US medical education | ACE-02 fail, R-23 fail, R-24 judge |
| tc-27 | W-9 missing | ime-accredited · US | submit | no | US medical education | US-TAX-01 fail, R-24 judge |
| tc-28 | France: payment gate in order | ime-non-accredited · FR | pre-payment | yes | France medical affairs | FR-AC-02 fail |
| tc-29 | Accredited request, provider not accredited | ime-accredited · US | submit | no | US medical education | ACE-01 fail, R-24 judge |
| tc-30 | Prospectus gives the supporter a role | ime-accredited · US | submit | no | US medical education | R-15 fail, R-24 judge |
| tc-31 | Prospectus silent on supporter role | ime-accredited · US | submit | yes | US medical education | R-15 judge, R-24 judge |
| tc-32 | Non-accredited education without independence statement | ime-non-accredited · US | submit | no | US medical education | R-06n fail |
| tc-33 | Non-accredited prospectus gives the sponsor a say | ime-non-accredited · US | submit | yes | US medical education | R-15n fail |
| tc-34 | In-kind support without its nature; accreditation statement missing | ime-accredited · US | submit | no | Global grants committee | ACE-04 fail, R-14 fail |
| tc-35 | Teaching hospital on the CMS list | ime-accredited · US | submit | yes | US medical education | US-OP-01 judge |
| tc-36 | UK society, accredited masterclass, clean | ime-accredited · GB | submit | yes | UK medical education | — |
| tc-37 | UK title names a Halden medicine | ime-non-accredited · GB | submit | no | UK medical education | UK-ABPI-01 fail, R-35 fail |
| tc-38 | UK grant at payment, all in order | ime-accredited · GB | pre-payment | yes | UK medical education | — |
| tc-39 | UK grant at payment, not certified | ime-accredited · GB | pre-payment | no | UK medical education | UK-ABPI-04 fail |
| tc-40 | UK grant at payment, acknowledgement clause missing | ime-accredited · GB | pre-payment | no | UK medical education | CORE-G6 fail, UK-ABPI-03 fail |
| tc-41 | UK hospital charity: community purpose, registration missing | charitable-contribution · GB | submit | no | UK charitable contributions | EFPIA-02 fail, R-11c fail, R-29 fail |
| tc-42 | France: convention above the authorisation threshold, short lead time | ime-non-accredited · FR | submit | yes | France medical affairs | FR-AC-02 fail, FR-AC-04 fail, R-07 fail |
| tc-43 | France: small donation below the threshold | charitable-contribution · FR | submit | yes | France affiliate | — |
| tc-44 | France: payment gate with no convention record and a late signature | ime-accredited · FR | pre-payment | no | France medical affairs | CORE-G4 fail, ACE-03 fail, FR-AC-02 fail, FR-AC-03 fail |
| tc-45 | US charitable under $5,000: single approver | charitable-contribution · US | submit | yes | US charitable contributions | — |
| tc-46 | US charitable over $5,000 without no-business-benefit statement | charitable-contribution · US | submit | no | US charitable contributions | R-06c fail, R-25 fail, R-31 fail |
