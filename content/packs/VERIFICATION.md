# Pack verification record

**Authoring session:** 27 October 2026. **Result: no pack value was verified against a primary source in this session.** Every parameter and rule basis carries `verified: false`, and each pack's `verification.status` is `unverified` (core: `partial`, because its gates are platform design rather than external values).

## What was tried

| Source wanted | Host | Result |
|---|---|---|
| CMS Open Payments Data Collection page (2026 thresholds) | www.cms.gov | WebFetch: DNS failure (ENOTFOUND). curl via egress proxy: 403 on CONNECT |
| 42 CFR 403.904 | www.ecfr.gov, www.law.cornell.edu, www.govinfo.gov | DNS failure / 403 |
| Federal Register (CMS rules, OIG notices) | www.federalregister.gov | 403 |
| IRS 1099 threshold (OBBBA § 70433) | www.irs.gov | 403 |
| ACCME Standard 4 and 5 | accme.org | DNS failure / 403 |
| ABPI Code clauses 8, 23, 28 | pmcpa.org.uk, www.pmcpa.org.uk | DNS failure / 403 |
| Arrêté du 7 août 2020; Décret 2020-730 | www.legifrance.gouv.fr; official-text mirrors (infomie.net JO copy, affairesjuridiques.aphp.fr) | 403 |
| EU texts | eur-lex.europa.eu | 403 |
| Open Payments data | openpaymentsdata.cms.gov | 403 |

The proxy status endpoint recorded each refusal as `connect_rejected` (policy denial). Web search worked, but search results are summaries of pages, not the primary text, so they were not counted as verification:

- **Open Payments 2026:** the search confirmed that the CMS Data Collection page has a "Current Reporting Thresholds – Program Year 2026" section. The figures $13.82 and $138.13 appeared only in a third-party guide (MedDeviceGuide).
- **1099 threshold:** secondary sources (CPA Practice Advisor, TaxBandits, Paylocity, Carnegie Mellon finance pages) agree on $2,000 for payments made in 2026, indexed from 2027. No irs.gov page was returned.
- **ACCME Standard 4:** a search summary of accme.org/node/452391 says that the agreement must be executed before the accredited education starts, and that the Standard's items are numbered 1–4 on that page. Rule refs therefore say "ACCME Standard 4" without sub-numbers.
- **ABPI:** search returned the Moderna case report title and summary (breaches of 8.3, 23.2, 5.1) and the CSL Vifor case (certification before the activity). It did not return the clause text or the words "apparent from the start".
- **France:** search confirmed (via DS Avocats and CMS France, both secondary) that the arrêté of 7 August 2020 sets per-category thresholds above which authorisation is required, and that filings are made by téléprocédure. It did not return the threshold figures or the Décret lead times.

## Values a person must still check before go-live

| Priority | Item | Where | Effect if wrong |
|---|---|---|---|
| 1 | French authorisation thresholds by category (candidates €1,000 association donation; €5,000 research donation; €10,000 association reconnue d'utilité publique; €8,000 category unknown), and whether the threshold is "at or above" or "above" | Légifrance JORFTEXT000042234024 | FR-AC-02 routes the wrong way. It is severity judge, so a person decides every French case until this is fixed |
| 1 | Décret 2020-730 lead times (expected: declaration 8 days before; authorisation request 2 months before, silence = approval) | Légifrance, CSP R.1453-x | FR-AC-04 (judge) uses 60 days |
| 1 | ABPI 2024 clause 23.2 supplementary information: exact agreement contents and acknowledgement wording | pmcpa.org.uk clause 23; AUTH/3676/7/22; AUTH/3851/11/23 | UK template clauses `uk-*` |
| 1 | ABPI clause 8.3: who certifies (final medical signatory or other qualified signatory) and when | pmcpa.org.uk clause 8 | UK-ABPI-04 and Annex A of the SOP |
| 2 | Open Payments PY2026 thresholds $13.82 / $138.13 | cms.gov Data Collection | Parameters only; no submission rule depends on them in v1 |
| 2 | 1099-NEC/MISC threshold $2,000 for 2026 payments | IRS instructions for 2026 forms | US-TAX-02 message (inform) |
| 2 | 42 CFR 403.904(i)(1) paragraph reference for the CE indirect-payment exclusion | eCFR | US-OP-02 basis text |
| 2 | ACCME Standard 4 and 5 verbatim, including the 30-minute separation | accme.org | ACE-02, ACE-03, ACE-04, clause texts |
| 3 | EFPIA 2026 section numbering (12.01) and HCO categories | EFPIA Code 2026 PDF | EFPIA-02 ref; disclosure category list |
| 3 | Transparence Santé semester dates (1 March / 1 September) | entreprises-transparence.sante.gouv.fr | Calendar only |
| 3 | US state dates (VT 1 April; NV 1 May–1 June; MA 1 July; CT 1 July) | State statutes and agency pages | Calendar only |
| 3 | Open Payments submission window (expected to 31 March) | 42 CFR 403.908; CMS | Calendar only |

## Every value, by pack

| Pack | Item | Value or ref | Status | Source as recorded |
|---|---|---|---|---|
| core | rule CORE-G1 (block) | Gate G1 | n/a (platform gate) | Global gate G1: organizations only. EFPIA Code 12.02; ABPI Code 2024 clause 23; PhRMA Code (CME support to the provider, never to individual clinicians); AdvaMed Code Section IV. |
| core | rule CORE-G2 (inform) | Gate G2 | n/a (platform gate) | Global gate G2. OIG Compliance Program Guidance for Pharmaceutical Manufacturers (68 FR 23731, 5 May 2003); AdvaMed Code Section IV. Enforced by the permission model in packages/core/src/gates.ts, not by this rule. |
| core | rule CORE-G3 (block) | Gate G3 | n/a (platform gate) | Global gate G3. OIG CPG 2003 (grants conditioned on purchases implicate the Anti-Kickback Statute); PhRMA Code; ABPI 2024 clause 23 (must not be an inducement). |
| core | rule CORE-G4 (block) | Gate G4 | n/a (platform gate) | Global gate G4. ACCME Standards for Integrity and Independence, Standard 4 (written agreement executed before the education starts); ABPI 2024 clause 23; Halden SOP 7.1. |
| core | rule CORE-G5 (block) | Gate G5 | n/a (platform gate) | Global gate G5. OIG Supplemental Special Advisory Bulletin on Independent Charity Patient Assistance Programs, 79 FR 31120 (30 May 2014). Out of pilot scope: applies only to subtype pap-donation, which is not in the Halden catalogue v1. |
| core | rule CORE-G6 (block) | Gate G6 | n/a (platform gate) | Global gate G6. 42 CFR Part 403 Subpart I (Open Payments); EFPIA Code disclosure; ABPI 2024 clause 28; Code de la santé publique L.1453-1 (Transparence Santé); Halden SOP 9.2. |
| us | parameter `openPayments.minimumTransfer.2026` | 13.82 | UNVERIFIED | CMS Open Payments Data Collection page (https://www.cms.gov/openpayments/program-participants/reporting-entities/data-collection). Not readable this session; a web search confirmed the page has a 'Current Reporting Thresholds – Program Year 2026' section but did not show the figure. $13.82 seen only in secondary sources. |
| us | parameter `openPayments.aggregate.2026` | 138.13 | UNVERIFIED | As above. One vendor (Qordata) states $13.07 / $130.66; CMS governs. |
| us | parameter `tax.form1099.threshold.2026` | 2000 | UNVERIFIED | OBBBA § 70433 per secondary sources (CPA Practice Advisor 30 Jul 2025; NATP). irs.gov not reachable. |
| us | parameter `ma.perOccurrence` | 50 | UNVERIFIED | 105 CMR 970.009 per research report; not re-read. |
| us | parameter `oig.ao2402.expires` | "2027-01-01" | UNVERIFIED | Morgan Lewis, Feb 2025 (secondary). Relevant to PAP donations only (out of pilot scope). |
| us | parameter `screening.lists` | ["LEIE", "SAM", "OFAC-SDN", "IRS-TEOS"] | UNVERIFIED | Halden SOP 5.1; list owners HHS-OIG, GSA, Treasury OFAC, IRS. |
| us | rule US-OP-01 (judge) | 42 CFR 403.904 | UNVERIFIED | 42 CFR Part 403 Subpart I; CMS annual Teaching Hospital List for the programme year. |
| us | rule US-OP-02 (block) | Open Payments indirect payments | UNVERIFIED | 42 CFR 403.904(i)(1) and CMS CY2015 PFS final rule reasoning: funding an accredited or certified CE provider is not an indirect payment where the manufacturer does not require, instruct, direct or otherwise cause the provider to pay a specific covered recipient. |
| us | rule US-TAX-01 (block) | IRS Form W-9 | UNVERIFIED | Payee taxpayer identification for information reporting; Halden Finance procedure. |
| us | rule US-TAX-02 (inform) | OBBBA § 70433 | UNVERIFIED | One Big Beautiful Bill Act (Pub. L. 119-21) § 70433: Form 1099-NEC/MISC threshold raised from $600 to $2,000 for payments made after 31 December 2025, indexed from 2027. |
| us | rule US-SCR-01 (block) | Screening | UNVERIFIED | HHS-OIG LEIE (42 U.S.C. 1320a-7); SAM.gov exclusions; OFAC SDN list (31 CFR Chapter V); IRS Tax Exempt Organization Search for 501(c)(3) status and auto-revocation. |
| us | rule US-FCPA-01 (judge) | FCPA | UNVERIFIED | 15 U.S.C. 78dd-1 et seq.; DOJ/SEC FCPA Resource Guide (2nd ed., 2020): donations and grants to foreign public institutions are 'anything of value'. |
| us | calendar us-op-submission | `annual:03-31` | UNVERIFIED | Open Payments submission and attestation window closes (expected 31 March; verify each year) |
| us | calendar us-op-publication | `annual:06-30` | UNVERIFIED | CMS publishes prior-year Open Payments data |
| us | calendar us-vt | `annual:04-01` | UNVERIFIED | Vermont manufacturer disclosure of allowable expenditures and gifts (18 V.S.A. § 4632) |
| us | calendar us-nv-open | `annual:05-01` | UNVERIFIED | Nevada Board of Pharmacy marketing code filing window opens (NAC 639.616) |
| us | calendar us-nv-close | `annual:06-01` | UNVERIFIED | Nevada marketing code filing must be received by today |
| us | calendar us-ma | `annual:07-01` | UNVERIFIED | Massachusetts disclosure of payments ≥ $50 per occurrence (105 CMR 970.009) |
| us | calendar us-ct | `annual:07-01` | UNVERIFIED | Connecticut annual compliance certification to the Department of Consumer Protection (Conn. Gen. Stat. § 21a-70e) |
| us | calendar us-ao-2402 | `once:2027-01-01` | UNVERIFIED | OIG Advisory Opinion 24-02 ceases to be in effect (patient-assistance donations, out of pilot scope) |
| accredited-ce | parameter `accme.standard5.separationMinutes` | 30 | UNVERIFIED | ACCME Standard 5 per research report (UCF CPD policy restating it). Not read in primary text. |
| accredited-ce | rule ACE-01 (block) | ACCME eligibility | UNVERIFIED | Accredited continuing education is offered by a provider accredited by ACCME, a state medical society recognised by ACCME, Joint Accreditation, or the equivalent body for the profession or country. |
| accredited-ce | rule ACE-02 (block) | ACCME Standard 5 | UNVERIFIED | Standards for Integrity and Independence, Standard 5: marketing, exhibits and non-accredited education are not in the educational space within 30 minutes before or after an accredited activity. |
| accredited-ce | rule ACE-03 (block) | ACCME Standard 4 | UNVERIFIED | Standard 4: the terms, conditions and purposes of commercial support are documented in a written agreement between the ineligible company and the accredited provider, executed before the education starts. |
| accredited-ce | rule ACE-04 (block) | ACCME Standard 4 | UNVERIFIED | Standard 4: learners are told the source and the nature of any in-kind support before the activity. |
| efpia | parameter `efpia.disclosure.deadline` | 6 | UNVERIFIED | EFPIA Disclosure Code per research report |
| efpia | parameter `efpia.disclosure.publicYears` | 3 | UNVERIFIED | EFPIA Disclosure Code per research report |
| efpia | parameter `efpia.records.years` | 5 | UNVERIFIED | EFPIA Disclosure Code per research report |
| efpia | rule EFPIA-01 (inform) | EFPIA Disclosure | UNVERIFIED | EFPIA Code of Practice: transfers of value to HCOs disclosed within six months of the end of the calendar year, public for at least three years; records kept for at least five years. |
| efpia | rule EFPIA-02 (block) | EFPIA 12.01 | UNVERIFIED | EFPIA Code (2019/2023 numbering) Section 12.01: donations and grants to HCOs only to support healthcare, research or education. ABPI 2024 clause 23 is to the same effect. |
| efpia | calendar efpia-hco-publication | `annual:06-30` | UNVERIFIED | EFPIA HCO disclosure of prior-year transfers of value |
| uk | parameter `uk.abpi.edition` | "2024" | UNVERIFIED | ABPI news Sept 2024 per research report; fully in force 1 Jan 2025. |
| uk | parameter `uk.disclosure.deadline` | "06-30" | UNVERIFIED | ABPI clauses 28/29 per research report |
| uk | rule UK-ABPI-01 (block) | ABPI 23.1 | UNVERIFIED | ABPI Code of Practice 2024, clause 23: donations and grants must not bear the name of any medicine. |
| uk | rule UK-ABPI-02 (block) | ABPI 23 | UNVERIFIED | ABPI Code 2024, clause 23: donations and grants must be prospective. |
| uk | rule UK-ABPI-03 (block) | ABPI 23.2 | UNVERIFIED | ABPI Code 2024, clause 23.2 and supplementary information: the written agreement describes the donation or grant, its objective, how it supports healthcare, research or education, the parties, and that the support will be acknowledged and that acknowledgement will be apparent from the start. PMCPA AUTH/3676/7/22 and AUTH/3851/11/23 (Roche). |
| uk | rule UK-ABPI-04 (block) | ABPI 8.3 | UNVERIFIED | ABPI Code 2024, clause 8.3 and clause 23: the written agreement for donations and grants is certified. PMCPA CASE/0646/06/25 (Moderna): uncertified grants breached clauses 8.3 and 23.2. |
| uk | rule UK-ABPI-05 (inform) | ABPI 28 | UNVERIFIED | ABPI Code 2024, clause 28 (HCOs) and clause 29 (patient organisations): annual disclosure by 30 June for the prior calendar year. |
| uk | calendar uk-disclosure | `annual:06-30` | UNVERIFIED | Disclosure UK publication of prior-year transfers of value |
| fr | parameter `fr.antiCadeaux.authorisationThreshold.associationDonation` | 1000 | UNVERIFIED | UNVERIFIED. Candidates in sources: €1,000 for association donations (Vigier Avocats; ONPP), €5,000 for research donations per convention (Légifrance summary; Tours note), €10,000 where the beneficiary is an association reconnue d'utilité publique, and an €8,000 figure with truncated category (Tours note). €1,000 is used as the most cautious value: it sends more requests to a person. |
| fr | parameter `fr.antiCadeaux.authorisationThreshold.researchDonation` | 5000 | UNVERIFIED | UNVERIFIED. Légifrance JORFTEXT000042234024 as summarised by the research report; not used by a rule in v1. |
| fr | parameter `fr.antiCadeaux.authorisationThreshold.rupDonation` | 10000 | UNVERIFIED | UNVERIFIED. Vigier Avocats per research report; not used by a rule in v1. |
| fr | parameter `fr.antiCadeaux.declarationLeadDays` | 8 | UNVERIFIED | UNVERIFIED expected value (Décret 2020-730). Not used by a rule in v1. |
| fr | parameter `fr.antiCadeaux.authorisationLeadDays` | 60 | UNVERIFIED | UNVERIFIED expected value: '2 months' (Décret 2020-730), encoded as 60 days. |
| fr | parameter `fr.transparence.thresholdEUR` | 10 | UNVERIFIED | Transparence Santé official FAQ per research report; not re-read. |
| fr | rule FR-AC-01 (inform) | CSP L.1453-7 to L.1453-9 | UNVERIFIED | Code de la santé publique L.1453-3 ff. as reformed by Ordonnance 2017-49; Décret 2020-730 of 15 June 2020; in force 1 October 2020. |
| fr | rule FR-AC-02 (judge) | Arrêté 7 août 2020 | UNVERIFIED | Arrêté du 7 août 2020 fixant les montants à partir desquels une convention prévue à l'article L. 1453-8 est soumise à autorisation (JORFTEXT000042234024). |
| fr | rule FR-AC-03 (block) | CSP L.1453-8 | UNVERIFIED | Décret 2020-730; declarations via IDAHE 2 (CNOM) or EPS (other Ordres and ARS). Paper filings are not processed. |
| fr | rule FR-AC-04 (judge) | Décret 2020-730 | UNVERIFIED | Décret 2020-730: lead times before the benefit (expected: declaration at least 8 days before; authorisation request at least 2 months before, silence for 2 months = authorisation). |
| fr | rule FR-TS-01 (inform) | CSP L.1453-1 | UNVERIFIED | Transparence Santé: every convention regardless of amount and every benefit ≥ €10 TTC, rounded to the euro; semester filings. |
| fr | calendar fr-ts-mar | `semester:03-01,09-01` | UNVERIFIED | Transparence Santé filing for July–December of the prior year (expected 1 March) |

## How to mark a value verified

1. Read the value in the primary text (statute, regulation, code, official agency page).
2. In the pack, set `verified: true` on the parameter or on the rule's `basis`, replace `verificationNote` with the URL, the date read and the exact words relied on, and set `verification.checkedBy` and `checkedAt`.
3. Where a verified value lets a rule become stricter (for example FR-AC-02 from `judge` to `block`), make that a separate change, publish a new pack version and re-run the test set.
