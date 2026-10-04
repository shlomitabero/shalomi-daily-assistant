# Forge AI — Product Vision

*Working name, treat as temporary; branding is not hard-coded anywhere in the codebase.*

## North Star

A non-technical person describes a business in plain language and gets back a
working, secure, deployable software product — not just generated screens.
The experience should feel like hiring a small software company, not running
a code generator.

Example north-star prompt:

> "I need a CRM for a real-estate company with leads from Facebook and
> WhatsApp, automatic follow-up, three employee permission levels,
> dashboards, invoices and an AI assistant."

Forge AI should independently understand the business, ask only genuinely
necessary questions, propose a specification, generate a real data model and
a real working application, test it, and let the user iterate — all before
a single line of hand-written code.

## The core differentiator

Most AI builders are "prompt → code → preview." Forge AI's category is:

```
IDEA → SPEC → BUILD → VERIFY → DEPLOY → OPERATE → OBSERVE → IMPROVE
```

The platform is meant to own the full software lifecycle, including after
launch (self-healing, cost/scale awareness, business outcomes) — not just
the initial generation step. That full lifecycle is the multi-year vision;
see `roadmap.md` for what is actually implemented today versus aspirational.

## User types the platform is designed for

- **Zero-code founder** — communicates in business language, never sees a
  database or an API.
- **Product manager** — wants control over requirements, priorities, and
  releases.
- **Developer** — wants git, source, terminal, logs, migrations, and full
  override control.
- **Agency** — multiple clients, white-label, reusable templates.
- **Enterprise** — RBAC, SSO, audit logs, private deployment, compliance.

Phase 1 (what's built today) serves the zero-code founder and developer
personas end-to-end for a single workspace; agency/enterprise concerns are
deliberately deferred (see `roadmap.md`).

## The six differentiators worth protecting

Of the full 100+-point vision this project was scoped from, six ideas are
the actual moat — most competitors focus on *building*; these are about
*owning the lifecycle*:

1. **AI Team** — specialized cooperating agents (PM, architect, UX,
   engineers, QA, security, DevOps) rather than one undifferentiated model
   call.
2. **Self-healing applications** — the platform keeps observing a shipped
   app and proposes/applies fixes.
3. **Time Machine** — every significant change is a restorable checkpoint,
   including database-aware rollback.
4. **Business Brain** — the system accumulates an understanding of the
   business itself, not just its code.
5. **Spreadsheet/PDF/screenshot → SaaS** — turn existing artifacts (Excel
   workflows, SOPs, screenshots) into working software.
6. **Cost + Scale Simulator** — tells a business owner what the system will
   cost and where it will break, before they find out in production.

## What Phase 1 actually proves

The Phase 1 slice in this repository proves the first, foundational link in
that chain end-to-end and honestly:

**Idea → generated Product Spec → real generated database schema → working
generic CRUD API → live, usable preview UI.**

It deliberately does *not* yet attempt multi-agent orchestration,
self-healing, git sync, deployment, or billing — seeing 101 sections
attempted badly would be worse than seeing one built well. See
`roadmap.md` for the phased plan and `architecture.md` for what exists in
this codebase today.
