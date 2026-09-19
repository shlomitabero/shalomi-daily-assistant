# ADR 0001: Initial architecture for the Phase 1 vertical slice

## Status

Accepted.

## Context

The founding brief for Forge AI describes a ~100-section, multi-year vision
(AI software company in a box: multi-agent builds, self-healing production
apps, cost/scale simulation, bidirectional Git, marketplace, etc.). The
brief itself explicitly warns against attempting all of it in one pass and
asks for the smallest complete vertical slice of Phase 1 instead: natural
language in, a genuinely working application out.

This repository previously contained an unrelated project ("FROM ZERO", a
business-simulation game) with no relation to Forge AI. Per explicit user
decision, this branch was reset to build Forge AI fresh; FROM ZERO remains
intact on `main` and `claude/from-zero-game-design-2b0jli`.

## Decisions

1. **Scope: one real vertical slice, not broad scaffolding.**
   Idea → generated ProductSpec → real SQL schema → working generic CRUD
   API → live preview UI. Everything else in the vision (auth, git sync,
   deployment, multi-agent orchestration, self-healing, marketplace) is
   explicitly deferred and documented in `roadmap.md` rather than stubbed
   out with fake UI that doesn't work — per the vision's own "No Fake
   Implementations" principle (section 71), a half-built Phase 2 feature is
   worse than an honestly-absent one.

2. **`node:sqlite` instead of `better-sqlite3` or Postgres.**
   Node 22 ships a synchronous SQLite driver in core. It requires no native
   compilation step, which matters for a sandboxed dev/CI environment, and
   keeps "clone and run" true with zero external services — consistent with
   the "own your data, no forced infrastructure" principle. It is flagged
   experimental upstream; if that becomes a blocker, the repository layer in
   `packages/db` is the only place that would need to change (it never
   leaks `node:sqlite` types past its own module boundary in the exported
   API surface used by `apps/api`).

3. **A generic, metadata-driven CRUD engine instead of generating a
   real per-project codebase.**
   Generating and compiling a bespoke Next.js/React app per project needs a
   sandboxed build pipeline, per-project hosting, and a Git-backed workspace
   — all Phase 2+ infrastructure. Building that badly in one pass would
   violate the "no fake implementations" principle worse than not building
   it. Instead, Phase 1 generates a real SQL schema from the spec and
   serves it through one well-tested, generic CRUD engine + UI. This is
   real (validated persistence, real APIs, no mocked data) but is *not* yet
   the "your app, your code, exportable codebase" promise (section 11) —
   `roadmap.md` and `architecture.md` say so explicitly so this isn't
   mistaken for more than it is.

4. **Provider seam over full model router.**
   `packages/spec-engine` picks between a real Anthropic-backed generator and
   a deterministic offline heuristic based on whether `ANTHROPIC_API_KEY` is
   set. This keeps the whole test suite (and the "clone and run with zero
   config" promise) independent of network access or credentials, while
   leaving the seam the full Model Router (section 31) will eventually
   extend.

5. **No authentication in Phase 1.**
   Adding real auth touches nearly every table (row ownership) and the
   entire repository layer (row-level checks). Bolting it on partially
   would be worse than a clearly-documented single-workspace demo mode —
   see `security.md` for exactly what this means and what must change
   before any real deployment.

## Consequences

- The MVP acceptance scenario in `roadmap.md` is genuinely, automatically
  tested (`apps/api/src/app.test.ts`) and was manually verified against the
  real UI with Playwright — not just described.
- Anyone picking this up next has a small, honest surface to extend rather
  than a large surface of partially-working features to first figure out.
- The most visible gap versus the marketing promise ("your app, your code")
  is the shared CRUD engine instead of generated codebases — flagged
  clearly in three places (`architecture.md`, `roadmap.md`, here) so it
  isn't mistaken for done.
