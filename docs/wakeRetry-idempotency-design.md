# Design: idempotency keys for `fetchWithWakeRetry`'s mutation risk

**Status: design only, no code written yet.** This document exists to finally
make progress on the standing candidate first flagged in round 387 and
deferred ever since (387 → 468 → 469) — always correctly, since round 163's
own history is a live warning about what happens when `wakeRetry.ts` is
touched carelessly: a "simple" fix there once made cold-start recovery
unreliable for every request in the app, not just one route. This round
produces a grounded, scoped plan instead of code, so a future round can
implement it carefully with this analysis already done and reviewed.

## The actual risk, precisely

`fetchWithWakeRetry` (`apps/web/src/wakeRetry.ts`) retries a request whenever
the underlying `fetch()` call itself throws — not when the server returns an
HTTP error. Its own doc comment states the safety argument plainly:

> Retrying is safe here because a connection failure means the request was
> never received by the server at all — nothing to duplicate.

That is true for the dominant real-world case this file exists to handle:
Render's free tier spinning a service down, where the next request's `fetch()`
fails because nothing is listening yet — the TCP connection itself never
completes, so the server genuinely never saw a byte of the request. That case
is categorically safe to retry, for any HTTP method, including POST.

It is **not** true for every way `fetch()` can throw. A connection can also
fail *after* the request was fully sent and the server fully processed it,
but *before* the response made it back to the browser (the socket resets
while the response is in flight, a proxy/load-balancer hiccups mid-transfer,
the tab's network stack hits a transient error on an otherwise-healthy
connection). `fetch()` surfaces that the same way it surfaces a cold-start
connection refusal: as a thrown `TypeError`/`NetworkError`, with no way for
the caller to distinguish "never sent" from "sent, processed, lost on the way
back." `fetchWithWakeRetry` retries both identically. For a GET or a
naturally-idempotent write (see below), that is harmless. For a route whose
effect is "create a new row" or "append to a list" every time it runs, that
narrow but real window is where round 387's concern lives: the first attempt
can have already fully succeeded server-side by the time the client decides to
retry it.

This window is narrow (it requires the connection to survive long enough to
deliver the whole request and for the server to finish processing before
dying) and is **not** the common cold-start case `wakeRetry.ts` was built for
— but "narrow" is not "never," and the goal here is closing a real gap, not
a theoretical one.

## Full inventory of mutating routes (verified by reading each one)

### Already safe — no idempotency key needed

- **Every `DELETE` route** (`/roles/:index`, `/assumptions/:index`,
  `/entities/:name`, `/entities/:name/fields/:name`, `/projects/:id`,
  `/checkpoints/:id`, `/collaborators/:userId`, WhatsApp message deletes):
  deleting an already-deleted or nonexistent row is a no-op or a 404, not a
  second deletion of something else. A duplicate retry changes nothing.
- **Every `PATCH` that sets a field to an explicit value** (project
  name/description, entity/field label, checkpoint label): setting the same
  value twice leaves the exact same end state. Pure overwrite, no
  accumulation.
- **`POST /projects/:id/collaborators`** (invite): `addCollaborator`
  (`packages/db/src/collaborators.ts:25-32`) does
  `INSERT OR IGNORE INTO project_collaborators (projectId, userId, addedAt) ...`
  against a `(projectId, userId)` primary key. A duplicate invite of the same
  person is a silent no-op at the DB layer already — no application-level
  guard needed because the schema itself enforces it.
- **`POST /projects/:id/checkpoints/:id/restore`**: copies a stored spec onto
  `project.spec`. Running it twice in a row sets the same end state twice;
  the second run is a no-op in effect (it does insert its own fresh
  checkpoint each time — see the standing "checkpoints have no automatic
  pruning" candidate, round 380 — but that is an unrelated, already-known,
  already-deferred cosmetic-accumulation concern, not a correctness bug this
  design needs to fix).
- **`POST /projects/:id/build`**: double-guarded already.
  `activePipelines.has(project.id)` (`routes/projects.ts:720-721`) rejects a
  retry that lands while the first attempt is still genuinely running, and
  `project.status === "built"` (`routes/projects.ts:717-718`) rejects a
  *delayed* retry that lands after the first attempt already finished. No
  gap.

### Real, unguarded risk — a duplicate retry doubles a real effect

- **`POST /projects`** (create from an idea) — `routes/projects.ts:364-382`.
  No guard of any kind. A duplicate retry calls `generateSpec()` again (a
  second real AI call, doubled cost) and `insertProject(db, { id: randomUUID(), ... })`
  again, inserting a second, genuinely distinct draft project with the same
  description. The user only ever sees whichever response their browser's
  `fetch()` promise actually resolved to; the other draft sits silently in
  "Your projects" as an orphan they never asked for. **This is the highest-
  value route to fix first**: real AI cost wasted, and a confusing duplicate
  a person has to notice and clean up themselves.
- **`POST /projects/from-template`** — `routes/projects.ts:422-443`. Same
  shape as above minus the AI call: `insertProject` with a fresh
  `randomUUID()`, no guard. A duplicate retry creates two identical draft
  projects from the same template.
- **`POST /projects/:id/clone`** — same `insertProject(... randomUUID() ...)`
  pattern (confirmed by the route's own doc comment referencing it as the
  precedent for `/projects/from-template` above); same risk.
- **`POST /projects/:id/roles`** / **`POST /projects/:id/assumptions`** —
  `routes/projects.ts:1204-1241`. Guarded by `activePipelines` against a
  retry landing *during* an in-flight build/refine, but not against one
  landing *after* a normal (non-pipeline) request already completed — the
  realistic failure window here. A duplicate retry appends the identical
  role/assumption text a second time: a visible, if cosmetic and
  user-correctable, duplicate list entry.
- **`POST /projects/:id/entities`** / **`POST /projects/:id/entities/:name/fields`** —
  same shape and same residual gap as roles/assumptions: a duplicate retry
  appends a second entity/field (the entity gets a deconflicted name like
  "Customer 2" via `deriveEntityName`, so it's visibly a duplicate, not a
  silent corruption — but still unintended).

### Residual gap despite an existing guard

- **`POST /projects/:id/refine`** — `routes/projects.ts:735-764`. The
  `activePipelines` guard protects against a retry landing while the
  original refine is still actually running (rejected with 409
  `PIPELINE_IN_PROGRESS`), which covers the common case: the connection drop
  happens, the server keeps running the pipeline to completion in the
  background, and a retry fired moments later still finds the pipeline
  in-flight. The gap is the same "arrives after the first one already fully
  finished" window as the append routes above: a delayed retry that lands
  after `activePipelines.delete()` has already run is treated as a brand-new,
  legitimate refine instruction and genuinely re-applies it — a second real
  AI call, a second checkpoint, a second (possibly slightly different, since
  the AI call isn't deterministic) spec change. Lower likelihood than the
  append routes (the pipeline itself takes real time, so the "it already
  fully finished" window only opens once the whole build/refine duration has
  elapsed) but the most expensive one to hit (a full AI-driven rebuild, not
  a one-line append).
- **`POST /projects/:id/answers`** — `routes/projects.ts:644-699`. Same
  `activePipelines` guard, same residual gap, same AI-call cost, scoped to
  the pre-build spec-review step instead of a built project.

## Recommended mechanism

A client-generated idempotency key, sent once per logical user action and
reused across that action's own retries (never regenerated per retry
attempt), checked server-side against a small, deliberately short-lived
table.

**Client side** (`apps/web/src/api.ts`): the specific call sites identified
above as needing one (not a blanket default) generate a key once —
`crypto.randomUUID()`, the same primitive `handleBuildComplete`'s own history
entries already use — before their single call into `request()`/`fetchApi()`,
and pass it through as a header: `X-Idempotency-Key: <uuid>`. Because
`fetchWithWakeRetry`'s loop re-sends the exact same `init` object (headers
included) on every attempt (`wakeRetry.ts:71-93`), the key is automatically
identical across that action's own retries with no change needed to
`wakeRetry.ts` or `fetchApi()` themselves — this is the central reason this
approach doesn't require touching the retry loop at all, which is exactly
the file round 163 warns against modifying carelessly. A genuinely new user
action (clicking "Create" again after actually going back to the idea box, as
opposed to the browser silently retrying the same click) generates a new key,
because it's a new call to the API function, which generates a fresh UUID.

**Server side** (`apps/api/src`): a new table,
`idempotency_keys (key TEXT PRIMARY KEY, userId TEXT NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL, responseStatus INTEGER, responseBody TEXT, createdAt TEXT NOT NULL)`,
and a small helper (mirroring the shape `activePipelines` already
establishes as this codebase's own precedent for "guard + do the work +
record the outcome"):

```ts
async function withIdempotency(
  db: ForgeDatabase,
  key: string | undefined,
  userId: string,
  route: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  if (!key) return run(); // no key supplied -- caller didn't opt in, behave exactly as today
  const existing = getIdempotencyRecord(db, key);
  if (existing?.status === "in_progress") {
    throw new HttpError(409, "This request is already being processed", "DUPLICATE_REQUEST_IN_PROGRESS");
  }
  if (existing?.status === "done") {
    return { status: existing.responseStatus, body: JSON.parse(existing.responseBody) };
  }
  insertIdempotencyRecord(db, key, userId, route); // status "in_progress"
  const result = await run();
  completeIdempotencyRecord(db, key, result.status, result.body);
  return result;
}
```

The specific at-risk routes above wrap their existing body in this helper;
every other route is completely untouched. A short TTL cleanup (e.g. rows
older than 24h deleted on a schedule, or opportunistically on each insert) is
enough — this only needs to cover a single retry sequence's own window, not
serve as a permanent audit log.

## What this deliberately does NOT do

- **No blanket middleware.** Attaching an idempotency key to every mutating
  route, including the ones proven naturally safe above, is exactly the kind
  of unneeded complexity this codebase's own conventions avoid (validating
  for a scenario that provably can't cause harm). Only the routes in the
  "real, unguarded risk" and "residual gap" sections above would opt in.
- **No change to `wakeRetry.ts` or `fetchApi()`'s retry loop itself.** The
  whole point of threading the key through `init`'s headers is that the
  existing retry mechanism already reuses it correctly without modification
  — the file round 163 made clear is dangerous to touch stays untouched.
- **No implementation in this round.** This is a plan, reviewed against the
  actual route code, not a diff. A future round can pick it up starting with
  `POST /projects` alone (highest real-world value: wasted AI cost plus a
  confusing duplicate draft), ship it, verify it with a real test that
  simulates "server received and fully processed the request, client never
  saw the response, client retries," and only then decide whether to extend
  the same helper to the remaining routes listed above.

## Open questions for whoever implements this

1. ~~**TTL length** for the `idempotency_keys` table — 24h is a reasonable
   starting guess (far longer than any realistic retry sequence) but is a
   product/ops judgment call, not a technical one.~~ **Resolved (round 480)**:
   implemented as the "opportunistically on each insert" option this doc
   itself named above, with the suggested 24h cutoff — see
   `pruneExpiredIdempotencyRecords` in `packages/db/src/idempotency.ts`,
   called from `withIdempotency` before every lookup.
2. **Collaborator/multi-tab edge case**: two different browser tabs
   legitimately submitting the *same* logical action (e.g. two collaborators
   both clicking "Build" around the same moment) would each generate their
   own key, so they wouldn't collide with each other — only a single
   client's own retry of its own request reuses a key. Worth a sentence in
   the eventual PR description so a reviewer doesn't mistake this for a
   cross-user lock.
3. **Whether to return the replayed cached response or a distinct
   "this already happened" signal** on a repeated "done" key — this design
   assumes replaying the original response verbatim (simplest, matches what
   the client expected the first time), but a reviewer closer to the product
   side may prefer a different signal for observability.
