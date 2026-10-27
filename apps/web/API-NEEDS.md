# API needs from the web front end

Things the web app needs from `apps/api` that are missing or awkward today. Each entry says what the UI does until it exists.

## 1. Stable message order
- **Endpoint:** `GET /api/requests/:id` (`messages`)
- **Problem:** messages written in one transaction share `created_at` (Postgres `now()` is the transaction start), and the query orders by `created_at` only. A requestor's message and the assistant's reply can come back in either order.
- **Ask:** a monotonic `seq` column (or `clock_timestamp()` for `created_at`) and `order by created_at, seq`.
- **Until then:** the UI renders in the order received.

## 2. The next question after an edit in the document
- **Endpoints:** `POST /api/requests/:id/fields`, `/confirm-all`, `/attestations`, `/budget`
- **Problem:** these change the request but do not append the assistant's next question, so the conversation can keep showing a question that the document has already answered.
- **Ask:** either append `askNext` after these writes (as `/coi` and `/flags` do), or return `nextAsk: Ask` on `GET /api/requests/:id`.
- **Until then:** the rail hides a field question once that field has a value, and hides the type question once the type is confirmed; the footer's "Up next" sentence is computed from `progress`.

## 3. Reuse a passport document
- **Hint id:** `reuse:nonprofit-proof` (and any `reuse:*`) from check actions.
- **Ask:** `POST /api/requests/:id/documents/reuse { type }` → `{ ok, documentId }`, linking the organization's passport document to the request and recording it in the trail.
- **Until then:** the action is not shown; the requestor can upload the letter again.

## 4. Add a budget line
- **Hint id:** `add:budget-line` (R-18).
- **Ask:** `POST /api/requests/:id/budget { addLine: { description, category, amount, note? } }`.
- **Until then:** not shown; "Request the budget total" and "Upload a revised budget" are offered.

## 5. Committee membership
- **Ask:** `GET /api/committee/members` → `[{ id, name, title, roles }]` for the tenant, and a stated meaning for `votes[].memberId` / `recusals[].memberId` (the flow test sends slugs such as `lindqvist`; the UI sends user ids).
- **Until then:** the decision form lists committee members from `/api/demo/personas` (demo only), plus the signed-in member.

## 6. Draft reference collisions
- **Endpoint:** `POST /api/requests`
- **Problem:** `nextDraftRef` counts rows, so two requests created concurrently (or after a deletion) get the same `D-04xx` and the insert fails with a 500 (`requests_tenant_id_ref_key`). Seen while other agents' tests were running.
- **Ask:** a sequence per tenant.
- **Until then:** the New request screen shows the API's sentence, and the person can try again.

## 7. Greeting
- `startRequest` greets with `u.name.split(" ")[0]`, which gives "Hello Dr.." for titled names. The UI uses "Dr. Marsh" on the start page; the assistant's first message still says "Hello Dr.".

## 8. Demo personas include test fixtures
- `GET /api/demo/personas` returns the test tenants ("Tenant A/B") and their users (R1, R2, Org A1…). The sign-in screen filters to tenants whose staff have a title, and to requestors with a title. A `fixture: true` flag, or excluding test tenants server-side, would be cleaner. The same applies to `GET /api/ops/fleet`; the Operations screen hides tenants with no packs and says how many it hid.

## 9. Brief: who submitted
- **Endpoint:** `GET /api/requests/:id/brief`
- **Ask:** `requestor: { id, name, title }` and `submittedBy`.
- **Until then:** the brief takes the name from the first attestation or confirmed field.

## 10. Agreement signatures: which side, and can I sign
- **Endpoint:** `GET /api/requests/:id/agreement`
- **Ask:** `signatures[].side: "organization" | "company"` and `canSign: boolean` for the current user.
- **Until then:** the UI treats a signature by the organization's named signer as the organization's, and shows the sign form to an `org-admin` requestor or to `legal`.

## 11. Preview has a side effect
- `GET /api/requests/:id/preview` re-screens the organization (writes events) when screening is stale. The working request calls it after every change to decide whether "Review and submit" is enabled. A side-effect-free `canSubmit` + `blockers` on `GET /api/requests/:id` would be lighter.

## 12. Information-request answers with documents
- `POST /api/requests/:id/info/:infoId` takes text answers only. `InfoRequest.questions[].documentIds` exists in the type but no endpoint sets it.
- **Ask:** accept `documentIds` per answer.
- **Until then:** "Attach documents" uploads to the request; the "what changed" note lists them.
