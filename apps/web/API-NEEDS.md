# API needs from the web front end

What the web app needs from `apps/api`. Nothing is open.

All items from the first pass were delivered and wired. The three found in the second pass are fixed:

1. **Completing an information request.** A requestor's last answer used to fail. The grants team's internal note
   and task are now written in the tenant's context, and a test covers the full round.
2. **Readiness matches submission.** `readiness.canSubmit` and `readiness.blockers` now use the same three conditions
   as `/submit`: no must-fix check, every "your call" decided, every proposed value confirmed. The footer can rely on
   `readiness` alone.
3. **Fleet shows only real tenants.** `GET /api/ops/fleet` lists only tenants with a published catalogue, so test
   fixtures in a shared database no longer appear.
