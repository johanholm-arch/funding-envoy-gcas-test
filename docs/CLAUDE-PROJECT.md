# Setting up the FundingEnvoy project in the Claude app

A Claude **Project** keeps shared instructions and files in one place, with a separate chat ("thread") for each
workstream. Every chat in the project reads the same instructions and files.

**How the work flows:** each thread works out its part (requirements, a spec, decisions, questions for others) and
ends with a short written result. You bring that result to the Claude Code session ("GrantsAgent"), which builds it,
tests it and puts it on Azure. Project chats can't change the code or the Azure site themselves.

## 1. Create the project (5 minutes)

1. In the Claude app, open **Projects** and click **New project**.
2. Name: `FundingEnvoy`. Description: `External funding platform for pharma and medtech: build workstreams`.
3. Open **Project instructions** (sometimes called "Set project instructions") and paste the text in section 2.
4. Add the files in section 3 to the project's knowledge.
5. Start one chat per workstream with the starter messages in section 4.

## 2. Project instructions (paste this)

```
This project is FundingEnvoy: an external funding (grants and donations) platform for pharmaceutical and medtech
companies. It runs as a managed service for several funders. It is either the system of record, or it sits in front
of a funder's existing Salesforce grants app and writes requests into it.

Who I am: I own the product. I am not a developer. Explain everything in plain language first, then give the
technical detail separately for the developers and for Claude Code.

How we work:
- Each chat in this project is one workstream. Stay within it; if something belongs to another workstream, say so in
  one line and add it to the list of handovers.
- The code is built in a separate Claude Code session ("GrantsAgent") on the GitHub repository
  johanholm-arch/funding-envoy-gcas-test. This project's chats write requirements, specs and decisions, not code.
- End each piece of work with a short result I can hand over: decisions made, open questions with who answers them,
  and what Claude Code should build, in the order it should be built.
- Keep the platform's rules: the assistant prepares and explains, people decide; five actions are always a person's
  (the funding decision, statements, agreement signature, payment release, disclosure submission); every action is in
  the audit trail; sales and marketing never see grants data.
- Base answers on the project files. Say when something is an assumption, and mark anything from outside the files
  with its source.
- Never ask for or repeat passwords, keys or secrets.
```

## 3. Files to add to the project

From the GitHub repository (download each file, or use **Add content → GitHub** if the app offers it):

| File | What it is |
|---|---|
| `README.md` | What FundingEnvoy is and how the demo works |
| `docs/BUILD-LOG.md` | What is built, against the twelve requirements, and what is open |
| `docs/ARCHITECTURE.md` | How the system is put together (for the technical threads) |
| `docs/SALESFORCE-TEST-CONNECTION.md` | The Salesforce test-connection guide |
| `docs/research/requirements-report.md` | The original research and requirements |
| `content/halden/policy.md` and `content/halden/sop.md` | The demo funder's policy and SOP, as examples |

Also add the **integration plan** ("FundingEnvoy and Salesforce: integration plan"): open it, use its export or
download option (PDF or Markdown), and add that file.

## 4. One chat per workstream (paste the starter as the first message)

**Salesforce connector**

```
Workstream: Salesforce connector. The read-only test connection to our Salesforce test org is built; next is mapping
FundingEnvoy to our real grants app and writing requests into it (steps 3 to 6 of the integration plan). Help me
(1) work through the questions for our Salesforce admin and the grants app vendor, (2) interpret what "Read the org"
shows once I paste it here, and (3) write the handover for Claude Code: which object holds requests, which fields
map to which, statuses, documents, and how requestors sign in.
```

**API for other systems**

```
Workstream: API for other systems. Other platforms (middleware, ERP, CRM, other grants systems) need to connect to
FundingEnvoy. Help me decide what they need: which things they can read or create, which events FundingEnvoy sends
out (for example "request submitted", "approved", "paid"), how they sign in, and limits. End with a plain-language
summary and a handover for Claude Code to build a documented API (OpenAPI) and outgoing webhooks.
```

**Agent requirements**

```
Workstream: agent requirements. Write down what FundingEnvoy's assistant must do and must never do, for requestors
and for the grants team, as numbered, testable requirements (for example "declines to predict whether a request will
be approved, and says why"). For each, add example conversations that pass and fail. End with a handover for Claude
Code to turn them into an evaluation set run against Claude before each release.
```

**Security and production**

```
Workstream: security and production. A pharma company will review FundingEnvoy before using it with real data. Help
me prepare: the security questions they will ask (SIG Lite style), our answers from the project files, the gaps, and
what production hosting on Azure needs beyond today's demo (separate database, backups, monitoring, sign-in). End with
a list of what Claude Code should build first and what needs a person or a supplier.
```

**Decisions and status** (optional, one chat that keeps the overview)

```
Workstream: decisions and status. Keep a running list across all workstreams: decisions made (date, who, why), open
questions (who answers, by when), and what has been handed to Claude Code. When I paste a result from another chat,
add it to the list and tell me if it conflicts with an earlier decision.
```

## 5. Bringing a result back to be built

When a thread ends with a handover, copy it into the Claude Code session ("GrantsAgent") with one line such as
"From the API workstream: please build this." Claude Code builds it, tests it, and tells you what changed and how to
update Azure. Bring the summary of what was built back to the "Decisions and status" chat.
