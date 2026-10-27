# Performance at 500,000 requests and 300 concurrent people

Requirement 9 asks for a database that serves hundreds of concurrent users over 500,000 rows. This page records how
that was tested, what broke, what was changed, and the results. Raw results are in `docs/perf/`.

## Result

With 300 people working at a realistic pace (about five seconds between actions), every step answered with a median
under 160 ms and a 95th percentile under 400 ms, with no errors. With 300 people acting every second, five times
harder than real use, the system served 154 requests a second with no errors; responses slowed to around 0.6 s
median because the single test machine was at 100% CPU.

Before the changes below, the same 300 people at one-second pace got medians of 12 to 60 seconds and some errors.

## Setup

One virtual machine with 4 cores and 16 GB of memory ran everything: Postgres 16, the API (three worker processes),
and the load generator. In production these would be separate machines, so these numbers are a floor.

The performance database (`scripts/perf-setup.sh`) is the demo tenant plus `apps/api/src/perf/generate.ts`:

| What | Rows |
|---|---:|
| Requests, 2016 to April 2027 | 500,000 |
| of which open, at the stage their age implies | 29,234 |
| Payments | 430,569 |
| Audit events, sealed into the tenant's hash chain | 2.9 million |
| Organizations shared with the tenant | 20,000 |
| Requestor accounts | 25,000 |
| Database size | 4.1 GB |

Open requests carry a full state cloned from real requests made by the scenario. Closed history carries what the
analytics read (decision, flags, information rounds, routing, stored checks, agreement signatures) rather than every
field's provenance, which keeps the database at 4 GB rather than about 9 GB. Query plans are the same either way,
because list and analytics queries no longer read the state.

The load generator (`apps/api/src/perf/load.ts`) signs each simulated person in and loops through what their seat
does: requestors (70%) list and open their requests and now and then start a new one; coordinators (12%) open the
desk, a brief and a trail; reviewers, the committee chair and finance (13%) open the desk and a brief; analysts (5%)
ask questions in Ask.

## Results

**Realistic pace: 300 people, about 5 s between actions.** 50 requests a second, 0 errors.

| Step | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|
| Requestor: my requests | 8 | 29 | 93 |
| Requestor: open a request | 11 | 27 | 190 |
| Requestor: start a request (write) | 35 | 68 | 88 |
| Coordinator: desk | 155 | 208 | 237 |
| Coordinator: brief | 18 | 107 | 408 |
| Coordinator: request trail | 5 | 12 | 17 |
| Reviewer: desk | 106 | 392 | 842 |
| Reviewer: brief | 17 | 34 | 56 |
| Analyst: Ask | 66 | 187 | 658 |

**Stress: 300 people, about 1 s between actions.** 154 requests a second, 0 errors, machine at 100% CPU.

| Step | p50 ms | p95 ms |
|---|---:|---:|
| Requestor: my requests | 569 | 1,175 |
| Requestor: open a request | 579 | 1,187 |
| Requestor: start a request (write) | 3,106 | 6,193 |
| Coordinator: desk | 912 | 1,517 |
| Coordinator: brief | 661 | 1,306 |
| Analyst: Ask | 1,240 | 3,343 |

**Before the changes, stress pace.** 7 requests a second, 13 errors. Medians: my requests 12.6 s, desk 22 s,
brief 51 s, Ask 60 s.

**Audit chain.** Full verification of 2.93 million events takes 32 s with flat memory, and the chain verified
intact. Verification from the last checkpoint takes about 15 ms.

## What was changed

Each change is in a migration or a named function, with the reason next to it.

- **Indexes Postgres can use under row-level security.** Under row-level security Postgres only uses an index for
  conditions built from leakproof operators. Two common conditions weren't: the JSON field operator, and comparing a
  timestamp with a date. Each forced a full scan. Events now carry a stored `request_id` column, and analytics bound
  periods with timestamps. A request's trail went from 1.6 s to 6 ms. (`009_events_request.sql`, `ask.ts`)
- **Row-level security context evaluated once per query.** Policies called the tenant-context functions for every
  row examined. They are now wrapped so each is evaluated once per query. The policies mean exactly the same as
  before. (`013_rls_initplan.sql`)
- **The desk reads indexed columns, not request state.** The desk used to take the 500 most recently updated
  requests, closed ones included, and sort them in code from each one's full state. At this volume, older open work
  silently fell off the desk. It now sorts all open work into piles in one query over stored columns and a covering
  index, counts every pile, and loads detail only for the items shown. (`008_scale.sql`, `012_desk_cover.sql`,
  `desk.ts`)
- **Audit events sealed at commit.** Events recorded during a transaction are queued and sealed together just
  before commit. The tenant's chain head is locked only for that moment, not for the whole transaction.
  (`events.ts`, `client.ts`)
- **Reference numbers outside the main transaction.** Request references come from a counter taken in a
  one-statement transaction on its own small pool. This replaced numbering by counting rows, which collided once
  drafts were submitted and would have raced under concurrent users. A failed transaction can leave a gap in the
  numbering. (`007_ref_counters.sql`, `nextCounter`)
- **Analytics on stored columns, with a default period and a concurrency limit.**
  - Reviewing group, decision outcome, flag count, information rounds and blocking rules are stored columns.
  - Questions without a period cover the last 12 months, and the answer says so.
  - At most four analytics questions run at once, each limited to 15 s, so analysts cannot starve everyday work.
  - (`010_analytics_columns.sql`, `011_blocking_rules.sql`, `ask.ts`)
- **Chain verification in pages, with checkpoints.** Verification used to load every event of a tenant into memory.
  It now walks the chain in pages. A full verification that passes records a checkpoint, and routine verification
  starts from the latest checkpoint after confirming it still matches the stored event. (`verifyTenantChain`)
- **Smaller responses.** The desk and requestor lists fetch only the fields they show. Number formatters are built
  once instead of on every amount. (`desk.ts`, `money.ts`)
- **Several worker processes.** `FE_WORKERS=n` runs n API processes on one port. Sessions, the chain and
  configuration live in the database, so any worker serves any request. (`main.ts`)

## Correctness fixes found by the test

- **Money added across currencies.** Ask added dollars, pounds and euros together and showed the sum in dollars.
  Money is now reported per currency and never converted.
- **Analytics used the real clock.** Ask took "this year" from the server clock rather than the demo date. It also
  missed "pay" as a word for payments and ignored "in 2026".
- **No graceful shutdown.** The server had no shutdown handler. It now finishes in-flight requests and closes its
  connections on SIGINT and SIGTERM.

## What production would add

- **Separate machines.** Postgres runs on its own host. The API runs as two or more instances behind a load
  balancer, with PgBouncer in transaction mode in front of Postgres.
- **A read replica for analytics,** so Ask never competes with requestors and reviewers for the primary.
- **Partitioned events.** Partition events by tenant and month once a tenant passes about 50 million events. Run full
  chain verification as a nightly job that records a checkpoint and an external timestamp, so on-demand
  verification is always the 15 ms kind.

## Run it

```
scripts/perf-setup.sh                      # builds fundingenvoy_perf: migrate, seed, scenario, 500,000 requests
cd apps/api
DATABASE_URL="postgres://fe_app:fe_app_dev@localhost:5432/fundingenvoy_perf?host=/tmp" \
  FE_WORKERS=3 DB_POOL_MAX=20 FE_LOG=0 PORT=8790 FE_TODAY=2027-04-02 FE_ASSISTANT=demo npx tsx src/main.ts &
VUS=300 DURATION=90 THINK_MS=5000 npx tsx src/perf/load.ts   # realistic pace
VUS=300 DURATION=60 THINK_MS=1000 npx tsx src/perf/load.ts   # stress
```
