import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Entity, Field, Project } from "@forge/shared";
import {
  getCheckpoint,
  getProject,
  insertProject,
  listCheckpoints,
  renameCheckpoint,
  deleteCheckpoint,
  listProjectsForUser,
  listOwnedProjectIds,
  listCollaboratedProjectIds,
  diffAndMigrate,
  describeMigrationHazards,
  updateProjectSpec,
  updateProjectName,
  updateProjectDescription,
  deleteProject,
  insertRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  insertWhatsAppMessage,
  listWhatsAppMessages,
  clearWhatsAppMessages,
  deleteWhatsAppMessage,
  addCollaborator,
  removeCollaborator,
  isCollaborator,
  listCollaborators,
  findUserByEmail,
  findUserById,
  countRecords,
  type ForgeDatabase,
} from "@forge/db";
import type { SpecProvider } from "@forge/spec-engine";
import { enhancePrompt, generateSpec, isHebrewText, TEMPLATES } from "@forge/spec-engine";
import { formatValidationError, HttpError } from "../httpError.js";
import { requireAuth } from "../auth/middleware.js";
import { runBuildPipeline } from "../pipeline.js";
import { withIdempotency } from "../idempotency.js";
import { generateExportFiles } from "../codegen.js";
import { generateBackupZipEntries } from "../backup.js";
import { buildZip } from "../zip.js";
import { computeBusinessTwin } from "../twin.js";
import type { WhatsAppWebManager } from "../whatsappWeb.js";
import { findMatchingRecord } from "../whatsapp.js";

const CreateProjectSchema = z.object({
  description: z.string().min(1, "description is required"),
  name: z.string().optional(),
});

const FromTemplateSchema = z.object({
  templateId: z.string().min(1, "templateId is required"),
  lang: z.enum(["he", "en"]).optional(),
});

const EnhanceIdeaSchema = z.object({
  idea: z.string().min(1, "idea is required"),
});

const RefineSchema = z.object({
  instruction: z.string().min(1, "instruction is required"),
});

const AnswerQuestionsSchema = z.object({
  answers: z.record(z.string(), z.string()).optional().default({}),
  additionalRequest: z.string().optional(),
});

const WhatsAppSendSchema = z.object({
  to: z.string().min(1, "to is required"),
  message: z.string().min(1, "message is required"),
});

const AddCollaboratorSchema = z.object({
  // Every stored account email is lowercased at signup (see auth.ts's
  // CredentialsSchema) so this lookup has to normalize the same way, or a
  // real, existing account becomes invisible to it the moment the typed
  // email's capitalization differs at all (mobile auto-capitalize, pasting
  // from a signature, "John.Doe@Company.com") -- findUserByEmail's `WHERE
  // email = ?` is a plain case-sensitive SQLite comparison.
  email: z.string().email("a valid email is required").transform((email) => email.toLowerCase()),
});

const RenameProjectSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
});

const UpdateProjectDescriptionSchema = z.object({
  description: z.string().trim().min(1, "description is required"),
});

const RenameEntityLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const RenameCheckpointSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const RenameFieldLabelSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const AddRoleSchema = z.object({
  role: z.string().trim().min(1, "role is required"),
});

const AddAssumptionSchema = z.object({
  assumption: z.string().trim().min(1, "assumption is required"),
});

const AddEntitySchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

const AddFieldSchema = z.object({
  label: z.string().trim().min(1, "label is required"),
});

/** Exported for direct unit testing of the word-truncation and empty-input fallback below. */
export function deriveName(description: string): string {
  const words = description.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 0 ? words : "Untitled Project";
}

/**
 * A newly-added entity's `label` is free text a user typed (possibly
 * Hebrew, possibly punctuation-laden), but its `name` becomes a SQL table
 * name in both the live preview (packages/db/src/migrate.ts, per-project
 * prefixed) and the exported codegen app (apps/api/src/codegen.ts, used
 * directly), so it has to be a non-empty run of ASCII identifier
 * characters, matching every existing domain entity's own PascalCase
 * convention (see domainEntities.ts -- "Customer", "WorkOrder", etc.).
 * Splits on any non-alphanumeric run (so both "Loyalty Program" and
 * "loyalty-program" become "LoyaltyProgram"), title-cases each surviving
 * word, and joins them with nothing in between. A label with no ASCII
 * letters/digits at all (pure Hebrew, say) leaves nothing to join, so it
 * falls back to "Entity" rather than producing the empty string
 * EntitySchema's `name: z.string().min(1)` would reject.
 *
 * De-duplicates case-insensitively against the project's existing entity
 * names (SQLite's own case-insensitive identifier comparison -- see
 * ProductSpecSchema's own case-collision `.refine()` in @forge/shared) by
 * appending the first free numeric suffix, so two entities that would
 * otherwise both derive to "Payments" never collide into one shared table
 * instead of silently corrupting either entity's data.
 */
export function deriveEntityName(label: string, existingNames: string[]): string {
  const words = label
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const base = words.join("") || "Entity";
  const existingLower = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!existingLower.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (existingLower.has(`${base}${suffix}`.toLowerCase())) suffix += 1;
  return `${base}${suffix}`;
}

/**
 * A newly-added field's `label` is free text (possibly Hebrew), but its
 * `name` becomes a real SQL column name in both the live preview
 * (packages/db/src/migrate.ts) and the exported codegen app
 * (apps/api/src/codegen.ts) -- the same ASCII-identifier requirement
 * deriveEntityName's own comment above explains, just camelCase (matching
 * every existing domain-library field's own convention -- see
 * domainEntities.ts's "customerName"/"courierId") instead of PascalCase.
 * Falls back to "field" for a label with no ASCII letters/digits at all,
 * the same as deriveEntityName falls back to "Entity". De-duplicates
 * case-insensitively against both the entity's existing field names and
 * the two column names every table already carries as a built-in (id,
 * createdAt -- see FieldSchema's own RESERVED_FIELD_NAMES check in
 * @forge/shared), appending the first free numeric suffix, so this can
 * never hand FieldSchema's own refine() a name it would reject.
 */
export function deriveFieldName(label: string, existingNames: string[]): string {
  const words = label
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  const base = words.join("") || "field";
  const taken = new Set(["id", "createdat", ...existingNames.map((n) => n.toLowerCase())]);
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base}${suffix}`.toLowerCase())) suffix += 1;
  return `${base}${suffix}`;
}

function findEntity(project: Project, entityName: string): Entity {
  const entity = project.spec.entities.find((e) => e.name === entityName);
  if (!entity) {
    throw new HttpError(404, `Entity "${entityName}" is not part of this project's spec`, "ENTITY_NOT_FOUND");
  }
  return entity;
}

function findField(entity: Entity, fieldName: string) {
  const field = entity.fields.find((f) => f.name === fieldName);
  if (!field) {
    throw new HttpError(404, `Field "${fieldName}" is not part of entity "${entity.name}"`, "FIELD_NOT_FOUND");
  }
  return field;
}

/**
 * `Number("abc")` is NaN, which SQLite's driver happily binds as a
 * parameter without throwing (verified empirically) -- so without this
 * check, a malformed :recordId in the URL silently falls through to
 * "Record NaN not found in X", a confusing 404 that leaks the raw
 * coercion result instead of clearly rejecting the bad input.
 */
function parseRecordId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `Invalid record id "${raw}"`, "VALIDATION_ERROR");
  }
  return Number(raw);
}

/** Same NaN-leak concern as parseRecordId above, for the roles/assumptions removal routes' :index param. */
function parseListIndex(raw: string, list: string[], notFoundCode: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) >= list.length) {
    throw new HttpError(404, `No item at index ${raw}`, notFoundCode);
  }
  return Number(raw);
}

/**
 * Unlike entities/fields (addressed by their own stable `name`, see the
 * routes below), roles and assumptions are plain strings with no identity
 * beyond their array position -- a role/assumption chip's :index is
 * whatever the client last rendered. Two of these requests can overlap (a
 * user clicking two different chips' remove/rename in quick succession,
 * each firing before the first one's response re-renders the list with
 * shifted indices), and since each handler below re-reads the current spec
 * fresh and applies its own :index synchronously with no await in between,
 * the second request's index can silently land on a different entry than
 * the one actually clicked once the first request's mutation has already
 * shifted the array -- removing/renaming the wrong role or assumption with
 * no error shown anywhere. `expect` carries the exact string value the
 * client had in hand when it captured that index, so a request whose
 * target already moved can be rejected instead of silently corrupting a
 * different entry. Optional only so that direct API callers (including
 * this repo's own existing tests) that don't send it keep working
 * unchanged -- this app's own web client (SpecListItemRemover.tsx) always
 * sends it.
 */
function assertIndexStillMatches(list: string[], index: number, expect: unknown, notFoundCode: string): void {
  if (typeof expect === "string" && list[index] !== expect) {
    throw new HttpError(409, "This item was already changed by another update -- refresh and try again", notFoundCode);
  }
}

/**
 * 404s (rather than 403s) on a project this user has no access to -- either
 * it doesn't exist, or it belongs to someone else and this user isn't a
 * collaborator on it -- to avoid leaking existence either way. A
 * collaborator gets identical access to the owner through every route that
 * calls this (see collaborators.ts's own module comment); only managing the
 * collaborator list itself is owner-only, via requireProjectOwner below.
 */
function requireProjectAccess(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || (project.ownerId !== userId && !isCollaborator(db, id, userId))) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
}

/** Stricter than requireProjectAccess: for actions only the owner may take (inviting/removing a collaborator). */
function requireProjectOwner(db: ForgeDatabase, id: string, userId: string): Project {
  const project = getProject(db, id);
  if (!project || project.ownerId !== userId) {
    throw new HttpError(404, `Project "${id}" not found`, "PROJECT_NOT_FOUND");
  }
  return project;
}

/**
 * listCollaborators (collaborators.ts) only ever returns rows from the
 * project_collaborators join table -- the owner isn't in that table at
 * all (their access comes from project.ownerId directly), so a
 * collaborator opening the sharing panel could see every OTHER
 * collaborator but never the person who actually owns the project. This
 * is the missing other half: fetches the owner's own email so the two
 * collaborators routes below can return it alongside the collaborator
 * list. Falls back to null instead of throwing on the (should-never-
 * happen) case of an owner account that's since been deleted, so a
 * dangling reference doesn't 500 the whole panel.
 */
function getOwnerInfo(db: ForgeDatabase, project: Project): { userId: string; email: string } | null {
  const owner = findUserById(db, project.ownerId);
  return owner ? { userId: owner.id, email: owner.email } : null;
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

async function streamPipeline(
  res: Response,
  db: ForgeDatabase,
  project: Project,
  opts: Parameters<typeof runBuildPipeline>[2],
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for await (const event of runBuildPipeline(db, project, opts)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

export function createProjectsRouter(db: ForgeDatabase, provider: SpecProvider | undefined, whatsapp: WhatsAppWebManager): Router {
  const router = Router();
  router.use(requireAuth(db));

  /**
   * /build, /refine, and /answers each read `project.spec` once at the
   * start of the request, then spend real time (an AI/heuristic
   * spec-generation call, and for /build and /refine also a migration)
   * before writing it back via updateProjectSpec. Two such requests for
   * the *same* project running concurrently (e.g. a double-click, or two
   * open tabs) would each still be working from the spec that was current
   * when they started -- the one that finishes last overwrites
   * project.spec with its own result, silently discarding whatever
   * entities/fields the other one added (for /build and /refine, that
   * other request's migration already ran and the DB table exists,
   * additive-only, but nothing in the overwritten spec points at it any
   * more, so the API can no longer see or write to it; for /answers,
   * which never migrates, it's a plain lost update -- the answers just
   * vanish). Tracked in-memory rather than in the DB: this process is the
   * only writer of project.spec (a single Node process backs this whole
   * app -- see app.ts's own comment on `staticDir`), so there's nothing
   * this needs to survive a restart for.
   */
  const activePipelines = new Set<string>();

  /**
   * The Prompt Architect Agent: takes a short, rough idea and rewrites it
   * into a fuller, more detailed prompt (same AI-or-heuristic provider seam
   * as generateSpec), without creating a project yet -- the client decides
   * whether to use the enhanced text.
   */
  router.post(
    "/ideas/enhance",
    asyncRoute(async (req, res) => {
      const parsed = EnhanceIdeaSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { enhanced, providerName } = await enhancePrompt(parsed.data.idea);
      res.json({ enhanced, providerName });
    }),
  );

  /**
   * `X-Idempotency-Key` (apps/web/src/api.ts's createProject) is this
   * route's first consumer of the mechanism docs/wakeRetry-idempotency-
   * design.md (round 470) designed: a client-generated key reused across
   * fetchWithWakeRetry's own retries of the same createProject() call, so
   * a retry that lands after the first attempt already fully created a
   * project (a real AI call plus a new row) replays that same response
   * instead of creating a second, duplicate draft. A request with no key
   * (an older client, or the key being optional by design) behaves exactly
   * as before -- see withIdempotency's own doc comment.
   */
  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const parsed = CreateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { description, name } = parsed.data;
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects", async () => {
        const { spec, providerName } = await generateSpec(description, provider);
        const project = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: name ?? deriveName(description),
          description,
          spec,
        });
        return { status: 201, body: { project, providerName } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * The Templates Gallery (Forge AI vision doc's "reusable templates" /
   * docs/roadmap.md's "Template/agent marketplace" backlog item): a fixed,
   * hand-authored catalog a client can browse before ever typing an idea.
   * Deliberately returns only display metadata, never each template's full
   * `spec` -- the client doesn't need it (picking a template goes straight
   * to POST /projects/from-template below, which resolves it server-side),
   * and there's no reason to hand a bigger payload than the gallery cards
   * actually render.
   */
  router.get(
    "/templates",
    asyncRoute(async (_req, res) => {
      res.json({
        templates: TEMPLATES.map(({ id, icon, name, nameHe, description, descriptionHe }) => ({
          id,
          icon,
          name,
          nameHe,
          description,
          descriptionHe,
        })),
      });
    }),
  );

  /**
   * One-click project creation from a Templates Gallery card -- the same
   * "insert a project from an already-fully-formed spec, no AI call"
   * precedent /projects/:id/clone already established, just sourcing the
   * spec from the static TEMPLATES catalog instead of an existing project.
   * `lang` picks which of the template's two display-text pairs becomes the
   * new project's name/description, AND which of its two specs (`spec` vs
   * `specEn`) becomes the project's entities -- both are real, human-authored
   * text/labels in their respective language, not a machine translation of
   * one, so an English-UI user gets a fully English generated app instead
   * of English chrome around Hebrew entity/field labels. This app is
   * Hebrew-first, so anything other than an explicit "en" falls back to the
   * Hebrew copy, matching /projects/:id/clone's own Hebrew-first suffix
   * choice just above.
   */
  router.post(
    "/projects/from-template",
    asyncRoute(async (req, res) => {
      const parsed = FromTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const template = TEMPLATES.find((t) => t.id === parsed.data.templateId);
      if (!template) {
        throw new HttpError(404, `No template "${parsed.data.templateId}"`, "TEMPLATE_NOT_FOUND");
      }
      const useEnglish = parsed.data.lang === "en";
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/from-template", async () => {
        const project = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: useEnglish ? template.name : template.nameHe,
          description: useEnglish ? template.description : template.descriptionHe,
          spec: useEnglish ? template.specEn : template.spec,
        });
        return { status: 201, body: { project } };
      });
      res.status(status).json(body);
    }),
  );

  router.get(
    "/projects",
    asyncRoute(async (req, res) => {
      res.json({ projects: listProjectsForUser(db, req.userId!) });
    }),
  );

  /**
   * The robust complement to GET /projects above: that listing goes through
   * listProjectsForUser, which silently drops any project whose stored spec
   * no longer parses against today's ProductSpecSchema (a real, expected
   * case for an older project -- see tryRowToProject's own comment). A
   * caller that needs the actual, complete set of project ids this user can
   * reach -- not a user-facing listing of project details -- needs this
   * instead, the same reason DELETE /auth/account uses listOwnedProjectIds
   * rather than listProjectsForUser for its own deletion sweep. Registered
   * before /projects/:id so this literal path is never captured as an :id.
   */
  router.get(
    "/projects/mine-ids",
    asyncRoute(async (req, res) => {
      res.json({
        ownedProjectIds: listOwnedProjectIds(db, req.userId!),
        sharedProjectIds: listCollaboratedProjectIds(db, req.userId!),
      });
    }),
  );

  router.get(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      res.json({ project: requireProjectAccess(db, req.params.id, req.userId!) });
    }),
  );

  /**
   * A project's name is otherwise only ever set once at creation
   * (deriveName's auto-derived first few words of the description), with
   * no way to fix it -- including the generic "(copy)" suffix a clone
   * starts with. requireProjectAccess (not requireProjectOwner): a
   * collaborator has the exact same full read/write access as the owner
   * everywhere else, and a project's display name is no different.
   */
  router.patch(
    "/projects/:id/name",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const parsed = RenameProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const updated = updateProjectName(db, project.id, parsed.data.name);
      res.json({ project: updated });
    }),
  );

  /**
   * A project's description -- the free text typed on the home screen --
   * was otherwise set exactly once, at creation, with no way to ever fix
   * it, unlike the name route right above. That's a real gap: the
   * description isn't just cosmetic display text, it's silently re-sent as
   * context on every future /refine and /answers call (see this file's own
   * `combinedDescription` construction in both of those routes), so a typo
   * or wrong requirement in the original description keeps compounding
   * into every future AI call, with no way to correct it short of starting
   * over. requireProjectAccess (not requireProjectOwner), matching every
   * other spec-review-screen edit a collaborator can already make. No
   * activePipelines guard needed: unlike the 12 routes round 380 added one
   * to, this never reads-then-writes project.spec -- the description
   * column is never touched anywhere else in the app after insertProject,
   * so there is no read-modify-write race for it to lose.
   */
  router.patch(
    "/projects/:id/description",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const parsed = UpdateProjectDescriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const updated = updateProjectDescription(db, project.id, parsed.data.description);
      res.json({ project: updated });
    }),
  );

  /**
   * Clones a project's spec (and description) into a brand-new project
   * owned by whoever asked -- the owner, or a collaborator making their
   * own personal starting point from a shared one. Deliberately does NOT
   * copy the source project's actual data (real customer records, etc.):
   * the clone always starts as a fresh "draft", exactly like a newly
   * described idea, so the requester chooses when (and whether) to build
   * it and get its own freshly generated seed data -- never someone
   * else's real business data landing in a new project without them
   * asking for that specifically. requireProjectAccess (not
   * requireProjectOwner) since reading a project you have access to and
   * making your own personal copy of its blueprint doesn't touch the
   * original at all.
   */
  router.post(
    "/projects/:id/clone",
    asyncRoute(async (req, res) => {
      const source = requireProjectAccess(db, req.params.id, req.userId!);
      const suffix = isHebrewText(source.description) ? " (עותק)" : " (copy)";
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/:id/clone", async () => {
        const cloned = insertProject(db, {
          id: randomUUID(),
          ownerId: req.userId!,
          name: `${source.name}${suffix}`,
          description: source.description,
          spec: source.spec,
        });
        return { status: 201, body: { project: cloned } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * Permanently deletes a project -- requireProjectOwner, not
   * requireProjectAccess: unlike renaming or cloning, this affects every
   * collaborator's access too (nobody can even see this project's data
   * again), so it's deliberately not something a collaborator can do to
   * someone else's project on their own initiative. Tears down any *live*
   * WhatsApp Web socket first (that in-memory state lives in this process,
   * outside packages/db's reach -- see WhatsAppWebManager's own comment),
   * then deleteProject (packages/db) does the rest: drops the project's
   * real generated data tables, checkpoints, collaborator grants, and
   * WhatsApp connection/message history. Irreversible -- the client is
   * expected to confirm with the user before calling this.
   *
   * The activePipelines check below is the same guard /build, /refine,
   * /answers, and restore already have, for a reason specific to THIS
   * route: a running pipeline (runBuildPipeline, pipeline.ts) keeps
   * creating entity tables (diffAndMigrate) and inserting seed rows
   * entirely independently of this request, by project id, with no way
   * to cancel it mid-flight. Deleting the project out from under it
   * doesn't stop it -- deleteProject drops the project row and every
   * table it currently knows about, but the in-flight pipeline's own
   * later diffAndMigrate/insertRecord/updateProjectSpec calls just keep
   * running against that same (now-gone) project id: at best they throw
   * once updateProjectSpec can't find the row anymore (after the response
   * headers for that pipeline's own SSE stream were already sent, so the
   * client just sees the stream die with no error), and at worst any
   * entity table diffAndMigrate re-creates *after* this delete runs is a
   * permanently orphaned SQLite table with no project row ever pointing
   * at it again -- a real disk-space leak nothing else in this app ever
   * cleans up.
   */
  router.delete(
    "/projects/:id",
    asyncRoute(async (req, res) => {
      const project = requireProjectOwner(db, req.params.id, req.userId!);
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      await whatsapp.disconnect(project.id).catch(() => {});
      deleteProject(db, project.id);
      res.status(204).end();
    }),
  );

  /**
   * Project sharing (see collaborators.ts's own module comment): the owner
   * or any current collaborator can see who has access; only the owner can
   * change who does. Listed by requireProjectAccess first so a collaborator
   * gets the same 404-not-403 existence-hiding treatment as every other
   * route if they've lost access since their last page load.
   */
  router.get(
    "/projects/:id/collaborators",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  router.post(
    "/projects/:id/collaborators",
    asyncRoute(async (req, res) => {
      const project = requireProjectOwner(db, req.params.id, req.userId!);
      const parsed = AddCollaboratorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const invited = findUserByEmail(db, parsed.data.email);
      if (!invited) {
        throw new HttpError(404, `No account found for "${parsed.data.email}"`, "COLLABORATOR_USER_NOT_FOUND");
      }
      if (invited.id === project.ownerId) {
        throw new HttpError(400, "The project owner already has full access", "CANNOT_ADD_OWNER_AS_COLLABORATOR");
      }
      addCollaborator(db, project.id, invited.id);
      res.status(201).json({ collaborators: listCollaborators(db, project.id), owner: getOwnerInfo(db, project) });
    }),
  );

  /**
   * Removing a collaborator was previously owner-only, full stop -- which
   * meant a collaborator invited to someone else's project had no way to
   * actually leave it; only asking the owner to remove them worked. This
   * now also allows the one case that's always safe regardless of who owns
   * the project: removing YOURSELF (real, permanent "leave project" self-
   * service, the collaborator-scoped sibling of round 210's own "delete my
   * account"). requireProjectAccess (not requireProjectOwner) so a
   * collaborator's own request to leave doesn't 404 before it even gets a
   * chance to check who's being removed; the owner-or-self check below is
   * what actually gates it. A collaborator can never remove a *different*
   * collaborator -- that stays owner-only.
   */
  router.delete(
    "/projects/:id/collaborators/:userId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const isSelf = req.params.userId === req.userId;
      if (project.ownerId !== req.userId! && !isSelf) {
        throw new HttpError(403, "Only the project owner can remove a different collaborator", "COLLABORATOR_CANNOT_REMOVE_OTHERS");
      }
      removeCollaborator(db, project.id, req.params.userId);
      res.status(204).end();
    }),
  );

  router.post(
    "/projects/:id/answers",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const parsed = AnswerQuestionsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const entries = Object.entries(parsed.data.answers)
        .map(([question, answer]) => [question.trim(), answer.trim()] as const)
        .filter(([question, answer]) => question.length > 0 && answer.length > 0);
      const additionalRequest = parsed.data.additionalRequest?.trim() ?? "";

      // Free-text answers (not just the suggested quick-pick options) and a
      // free-standing request (not tied to any specific question at all)
      // both feed straight back into spec generation -- so this actually
      // changes the spec that will get built, instead of only highlighting
      // a chip in the UI.
      const sections: string[] = [];
      if (entries.length > 0) {
        const answersText = entries.map(([question, answer]) => `- ${question}: ${answer}`).join("\n");
        sections.push(`Answers to clarifying questions:\n${answersText}`);
      }
      if (additionalRequest.length > 0) {
        sections.push(`Additional request: ${additionalRequest}`);
      }
      if (sections.length === 0) {
        res.json({ project });
        return;
      }
      // Unlike /refine, this route only calls updateProjectSpec directly --
      // it never runs the build pipeline, so it never migrates the SQL
      // schema to match whatever new entities/fields the regenerated spec
      // adds. That's fine before the first build (there's no schema yet to
      // fall out of sync with), but doing this on an already-built project
      // would silently desync project.spec from the real database: the spec
      // would claim an entity exists that has no table, and the very next
      // read/write against it throws an uncaught "no such table" SQL error
      // -- confirmed empirically, not just reasoned about. Checked only
      // here, after the no-op early-return above, so a harmless call with
      // no actual answers/request still succeeds post-build; /refine is the
      // route that correctly re-runs the pipeline for a built project.
      if (project.status === "built") {
        throw new HttpError(409, "This project is already built; use refine to make further changes", "ALREADY_BUILT");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      // Round 474: unlike /build and /refine (which stream SSE and are out
      // of scope for this mechanism), this route returns a plain JSON
      // response, so it fits withIdempotency()'s {status, body} contract
      // exactly like the five routes converted in rounds 471-473. A retry
      // landing after the activePipelines guard above already cleared
      // (the pipeline fully finished) would otherwise call generateSpec()
      // again -- a second real AI call -- and overwrite project.spec a
      // second time.
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/:id/answers", async () => {
        activePipelines.add(project.id);
        try {
          const combinedDescription = `${project.description}\n\n${sections.join("\n\n")}`;
          const { spec, providerName } = await generateSpec(combinedDescription, provider);
          const updated = updateProjectSpec(db, project.id, spec);
          return { status: 200, body: { project: updated, providerName } };
        } finally {
          activePipelines.delete(project.id);
        }
      });
      res.status(status).json(body);
    }),
  );

  router.post(
    "/projects/:id/build",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Mirrors /refine's own status guard below: without this, calling
      // /build a second time on an already-built project silently
      // "succeeds" (diffAndMigrate with no previousSpec treats every
      // entity as new, but the seed step's own empty-table check keeps it
      // from re-seeding real data) but still inserts a fresh checkpoint
      // mislabeled "Initial build" every time -- the Time Machine history
      // ends up with multiple identically-labeled checkpoints with no way
      // to tell them apart. /refine is the correct route once a project
      // is already built.
      if (project.status === "built") {
        throw new HttpError(409, "This project is already built; use refine to make further changes", "ALREADY_BUILT");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      activePipelines.add(project.id);
      try {
        await streamPipeline(res, db, project, {
          nextSpec: project.spec,
          changeLabel: isHebrewText(project.description) ? "בנייה ראשונית" : "Initial build",
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.post(
    "/projects/:id/refine",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before refining it", "BUILD_REQUIRED");
      }
      const parsed = RefineSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      activePipelines.add(project.id);
      try {
        const { instruction } = parsed.data;
        const combinedDescription = `${project.description}\n\nAdditional requirement: ${instruction}`;
        const { spec: nextSpec, providerName } = await generateSpec(combinedDescription, provider);
        await streamPipeline(res, db, project, {
          previousSpec: project.spec,
          nextSpec,
          changeLabel: isHebrewText(instruction) ? `שיפור: ${instruction}` : `Refine: ${instruction}`,
          providerName,
        });
      } finally {
        activePipelines.delete(project.id);
      }
    }),
  );

  router.get(
    "/projects/:id/checkpoints",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json({ checkpoints: listCheckpoints(db, project.id) });
    }),
  );

  router.post(
    "/projects/:id/checkpoints/:checkpointId/restore",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const checkpoint = getCheckpoint(db, req.params.checkpointId);
      if (!checkpoint || checkpoint.projectId !== project.id) {
        throw new HttpError(404, `Checkpoint "${req.params.checkpointId}" not found`, "CHECKPOINT_NOT_FOUND");
      }
      // Restore itself is the lost-update hazard activePipelines (see its
      // own comment above) exists to prevent -- it reads project.spec, does
      // work, then writes project.spec back, just like /build, /refine, and
      // /answers do. Unlike those three, restore's own work below never
      // awaits anything, so it can't itself be interrupted mid-flight; but
      // without this check, restoring while a slow /build or /refine is
      // already in flight would still get silently overwritten the moment
      // that other request finishes and writes its own result back.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      // Restoring never drops columns/tables (migrations are additive-only),
      // so it's always safe from *losing* data: this just ensures the
      // restored spec's schema exists (a no-op unless restoring "forward"
      // to a spec never built) and moves the spec pointer. "Safe from
      // losing" isn't "safe from misreading" though -- diffAndMigrate can
      // still report a reused column whose physical SQL type or FK target
      // no longer matches what the restored spec claims (e.g. a field that
      // was boolean when this checkpoint was taken, but has since been
      // retyped to text and wasn't just created fresh here), and /build and
      // /refine always surface that exact same diagnostic to the user
      // (pipeline.ts's "Database" agent message) -- silently discarding it
      // here, right where it's needed just as much, left a restored project
      // render stale/mismatched values (e.g. a boolean cell reading
      // Boolean("some real note text") as true) with no warning at all.
      const changes = diffAndMigrate(db, project.id, project.spec, checkpoint.spec);
      const updated = updateProjectSpec(db, project.id, checkpoint.spec);
      const migrationWarning = describeMigrationHazards(changes).trim();
      res.json({ project: updated, migrationWarning: migrationWarning.length > 0 ? migrationWarning : null });
    }),
  );

  /**
   * A checkpoint's label was previously only ever the automatic one build/
   * refine gave it ("Initial build", "Refine: <instruction>") -- no way to
   * give an important one a name that's actually memorable months later
   * (e.g. "before the pricing overhaul"). Checks project ownership through
   * requireProjectAccess just like the restore route above, and
   * renameCheckpoint itself re-scopes by projectId in its own WHERE clause
   * (see checkpoints.ts), so a checkpoint id belonging to a different
   * project can never be renamed even if guessed.
   */
  router.patch(
    "/projects/:id/checkpoints/:checkpointId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const parsed = RenameCheckpointSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const checkpoint = renameCheckpoint(db, project.id, req.params.checkpointId, parsed.data.label);
      res.json({ checkpoint });
    }),
  );

  /**
   * Time Machine's history otherwise only ever grows -- every build and
   * every refine adds a checkpoint, with no way to prune a single unwanted
   * one (an experimental refine that went nowhere, say), the same real gap
   * round 208 closed for the WhatsApp message log. deleteCheckpoint itself
   * re-scopes by projectId in its own WHERE clause (see checkpoints.ts), so
   * a checkpoint id belonging to a different project can never be deleted
   * even if guessed. Never touches the project's own current spec (that
   * lives on the project row, independent of this table), so deleting even
   * the checkpoint that happens to match the current state is harmless.
   */
  router.delete(
    "/projects/:id/checkpoints/:checkpointId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      deleteCheckpoint(db, project.id, req.params.checkpointId);
      res.status(204).end();
    }),
  );

  router.get(
    "/projects/:id/export",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before exporting its code", "BUILD_REQUIRED");
      }
      /**
       * codegen.ts's assertSafe rejects any entity/field name that isn't a
       * plain ASCII identifier -- unlike the live preview's own table-name
       * sanitization (packages/db/src/identifiers.ts's tableNameFor), which
       * never throws. A spec with a single, non-colliding non-ASCII name
       * (e.g. Hebrew) is therefore a real, reachable case that builds and
       * runs fine in the live preview but has always thrown here as a bare
       * Error -- which app.ts's generic error handler turned into an
       * unexplained 500, with zero indication of what went wrong or how to
       * fix it. Caught here and translated into an actionable 422 instead;
       * the underlying schema-level fix (round 283) intentionally didn't
       * reject this case outright, since a lone non-colliding non-ASCII
       * name doesn't corrupt any data -- it just can't be exported.
       */
      let files: ReturnType<typeof generateExportFiles>;
      try {
        files = generateExportFiles(project);
      } catch (err) {
        const match = err instanceof Error && /^Refusing to export: unsafe (entity|field) identifier "(.+)"$/.exec(err.message);
        if (match) {
          throw new HttpError(
            422,
            `Refusing to export: unsafe ${match[1]} identifier "${match[2]}" -- rename it to use only English letters, digits, and underscores, then try exporting again`,
            "EXPORT_UNSAFE_IDENTIFIER",
          );
        }
        throw err;
      }
      const zip = buildZip(files);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}.zip"`);
      res.send(zip);
    }),
  );

  router.get(
    "/projects/:id/backup",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before backing up its data", "BUILD_REQUIRED");
      }
      const entries = generateBackupZipEntries(db, project);
      const zip = buildZip(entries);
      const safeName = project.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "forge-app";
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${safeName}-backup.zip"`);
      res.send(zip);
    }),
  );

  router.get(
    "/projects/:id/integrations/whatsapp/status",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json(whatsapp.getStatus(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/connect",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      res.json(await whatsapp.connect(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/disconnect",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      await whatsapp.disconnect(project.id);
      res.json(whatsapp.getStatus(project.id));
    }),
  );

  router.post(
    "/projects/:id/integrations/whatsapp/send",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      const parsed = WhatsAppSendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const { to, message } = parsed.data;
      const status = whatsapp.getStatus(project.id);
      if (status.status !== "connected") {
        throw new HttpError(409, "Connect WhatsApp before sending a message", "WHATSAPP_NOT_CONNECTED");
      }
      const result = await whatsapp.sendMessage(project.id, to, message);
      // Mirrors the matching an incoming message gets (see
      // WhatsAppWebManager.handleIncomingMessages): without this, the panel's
      // own log rendering (which falls back to the matched label only when
      // one is present, for either direction) always shows the raw phone
      // number for a sent test message, even when `to` is a known customer's
      // number. Only attempted once the project is actually built -- before
      // that there is no real table behind any entity yet, and
      // findMatchingRecord's listRecords call would throw "no such table".
      const match = project.status === "built" ? findMatchingRecord(db, project, to) : null;
      insertWhatsAppMessage(db, {
        projectId: project.id,
        direction: "out",
        fromNumber: status.phoneNumber ?? "",
        toNumber: to,
        body: message,
        matchedEntityName: match?.entityName ?? null,
        matchedRecordId: match?.recordId ?? null,
        matchedLabel: match?.label ?? null,
        status: result.ok ? "sent" : "failed",
      });
      if (!result.ok) {
        res.status(502).json({ ok: false, error: result.error });
        return;
      }
      res.json({ ok: true });
    }),
  );

  router.get(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // A conversation only ever grows, and listWhatsAppMessages always
      // capped at 50 with no way to ask for anything older -- offset lets
      // the panel's own "load older messages" button actually reach them.
      // Anything that isn't a genuine non-negative integer (missing, "abc",
      // "-5") falls back to 0 rather than passing NaN/a negative value
      // straight into the SQL LIMIT/OFFSET clause.
      const parsedOffset = Number(req.query.offset);
      const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
      res.json(listWhatsAppMessages(db, project.id, 50, offset));
    }),
  );

  router.delete(
    "/projects/:id/integrations/whatsapp/messages",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      clearWhatsAppMessages(db, project.id);
      res.status(204).end();
    }),
  );

  router.delete(
    "/projects/:id/integrations/whatsapp/messages/:messageId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      deleteWhatsAppMessage(db, project.id, req.params.messageId);
      res.status(204).end();
    }),
  );

  router.get(
    "/projects/:id/twin",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing its Business Twin", "BUILD_REQUIRED");
      }
      res.json({ twin: computeBusinessTwin(db, project) });
    }),
  );

  /**
   * One cheap COUNT(*) per entity, so the entity-tabs strip can show how
   * much data lives in each tab without the user clicking into every one --
   * the only other place this information already existed (Business Twin)
   * sits an extra click away behind its own panel, not at a glance where
   * attention already is.
   */
  router.get(
    "/projects/:id/entity-counts",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Build the project before viewing entity counts", "BUILD_REQUIRED");
      }
      const counts: Record<string, number> = {};
      for (const entity of project.spec.entities) {
        counts[entity.name] = countRecords(db, project.id, entity);
      }
      res.json({ counts });
    }),
  );

  router.get(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      res.json({ records: listRecords(db, project.id, entity) });
    }),
  );

  router.post(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      /**
       * Same `PRAGMA foreign_keys = ON` constraint the DELETE route below
       * already translates (round 292), but on the write side: a relation
       * field's picker in EntityPanel.tsx is built from `relatedRecords`
       * fetched earlier, so submitting a create/edit referencing a record
       * another collaborator (or this same browser's own deferred-delete
       * undo window) deleted in the meantime hits this exact constraint.
       * Without this, app.ts's generic error handler turned it into an
       * unexplained 500 instead of a message naming the actual problem.
       */
      let record: ReturnType<typeof insertRecord>;
      try {
        record = insertRecord(db, project.id, entity, req.body ?? {});
      } catch (err) {
        if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
          throw new HttpError(
            400,
            "This record references another record that no longer exists",
            "INVALID_RELATION_TARGET",
          );
        }
        throw err;
      }
      res.status(201).json({ record });
    }),
  );

  /**
   * An entity's display label (e.g. "Customer" shown as "לקוחות") was
   * otherwise only ever set once, by spec generation -- fixing an awkward
   * auto-generated label meant a full natural-language Refine round-trip
   * (a real AI/heuristic call plus a migration, even though nothing about
   * the actual schema needs to change). `label` is pure display metadata
   * (see EntitySchema's own comment) -- entity.name, the real table name,
   * is never touched -- so this is a direct updateProjectSpec write, no
   * migration involved. requireProjectAccess (not requireProjectOwner),
   * consistent with every other spec-editing action a collaborator can
   * already do. Registered before the .../:recordId PATCH route below so
   * a request to .../entities/Customer/label is never mistaken for an
   * update to a record literally named "label".
   */
  router.patch(
    "/projects/:id/entities/:entityName/label",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same read-project.spec-then-write-it-back shape /build, /refine,
      // /answers, and checkpoint-restore are already guarded against (see
      // their own comments) -- a slow /refine already in flight computes
      // its nextSpec from the pre-rename spec and silently reverts this
      // rename the moment it finishes writing, with no error to either side.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      const parsed = RenameEntityLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const nextSpec = {
        ...project.spec,
        entities: project.spec.entities.map((e) => (e.name === entity.name ? { ...e, label: parsed.data.label } : e)),
      };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  /**
   * A field's display label (e.g. a "phone" field shown as "טלפון נייד")
   * has the exact same story as an entity's own label above: set once by
   * spec generation, pure display metadata that never touches the real
   * column name, so this is another direct updateProjectSpec write with
   * no migration. Path shape (.../fields/:fieldName/label) can never
   * collide with .../:entityName/:recordId below since it's a distinct,
   * longer route -- unlike the entity-label route, there's no registration-
   * order concern here.
   */
  router.patch(
    "/projects/:id/entities/:entityName/fields/:fieldName/label",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as the entity-label route above, for the
      // same reason -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      const field = findField(entity, req.params.fieldName);
      const parsed = RenameFieldLabelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const nextSpec = {
        ...project.spec,
        entities: project.spec.entities.map((e) =>
          e.name === entity.name
            ? { ...e, fields: e.fields.map((f) => (f.name === field.name ? { ...f, label: parsed.data.label } : f)) }
            : e,
        ),
      };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  /**
   * The spec review screen's "roles" chips and "assumptions" list (both
   * plain string[] on the spec, set once by spec generation) were
   * otherwise entirely static -- no way to correct a role or assumption
   * the AI/heuristic engine got wrong before committing to a build. Same
   * direct updateProjectSpec write as the label routes above, just
   * filtering an index out of a string[] instead of editing an object
   * field. Deliberately DELETE-by-index rather than a full-array PUT: the
   * UI only ever removes one chip/item at a time, and index-based removal
   * means a stale client array can't accidentally resurrect an item
   * someone else just removed. No project.status check (unlike the record
   * routes below) since this edits the spec itself, the same as the label
   * routes -- available before a project is even built, when it's most
   * useful for catching a wrong assumption early. Unlike assumptions,
   * `roles` carries `.min(1)` on ProductSpecSchema (see that schema's own
   * comment -- every stored spec is re-validated against it on every read),
   * so removing the very last role would otherwise pass this route's own
   * checks and then blow up inside updateProjectSpec's schema validation as
   * an uncaught 500 -- guarded explicitly below instead, with a clear 400.
   *
   * Removal alone was one-directional: once the heuristic engine missed a
   * role entirely (e.g. a two-sided marketplace where it only spotted
   * "Buyer"), or missed an assumption worth recording, there was no way to
   * add one back short of restarting the whole spec. These two POST
   * routes are the other half of the same correction workflow -- append
   * one trimmed string to the array and persist through the same
   * updateProjectSpec path, no schema/status checks needed since any
   * non-empty string is a valid role or assumption.
   */
  /**
   * Round 473 extends the same withIdempotency() mechanism (round 471's
   * POST /projects, round 472's from-template/clone) to this append route
   * -- the design doc's own "append-only gap": a retry landing after the
   * first append already finished would otherwise append the identical
   * role a second time.
   */
  router.post(
    "/projects/:id/roles",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as the entity/field-label routes above --
      // this is another direct read-project.spec-then-write-it-back edit,
      // the exact shape /build/refine/answers/restore are already guarded
      // against.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/:id/roles", async () => {
        const nextSpec = { ...project.spec, roles: [...project.spec.roles, parsed.data.role] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /** See POST /projects/:id/roles's own doc comment just above -- same extension, same reasoning. */
  router.post(
    "/projects/:id/assumptions",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddAssumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/:id/assumptions", async () => {
        const nextSpec = { ...project.spec, assumptions: [...project.spec.assumptions, parsed.data.assumption] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  router.delete(
    "/projects/:id/roles/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const index = parseListIndex(req.params.index, project.spec.roles, "ROLE_NOT_FOUND");
      assertIndexStillMatches(project.spec.roles, index, (req.body as { expect?: unknown })?.expect, "ROLE_STALE_INDEX");
      if (project.spec.roles.length <= 1) {
        throw new HttpError(400, "Cannot remove the last remaining role -- at least one role is required", "VALIDATION_ERROR");
      }
      const nextSpec = { ...project.spec, roles: project.spec.roles.filter((_, i) => i !== index) };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  router.delete(
    "/projects/:id/assumptions/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const index = parseListIndex(req.params.index, project.spec.assumptions, "ASSUMPTION_NOT_FOUND");
      assertIndexStillMatches(
        project.spec.assumptions,
        index,
        (req.body as { expect?: unknown })?.expect,
        "ASSUMPTION_STALE_INDEX",
      );
      const nextSpec = { ...project.spec, assumptions: project.spec.assumptions.filter((_, i) => i !== index) };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  /**
   * Remove-then-re-add was the only way to fix a typo or wording in an
   * existing role/assumption -- correct in the end, but it also silently
   * moved the item to the end of its own list (a new POST always appends)
   * and briefly violated roles' own .min(1) floor if it was the last one.
   * Reuses AddRoleSchema/AddAssumptionSchema verbatim (same {role: string}/
   * {assumption: string} shape a rename body needs) rather than declaring
   * a near-duplicate schema. In-place index replacement via .map, mirroring
   * renameFieldLabel's own PATCH-by-identity approach above.
   */
  router.patch(
    "/projects/:id/roles/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const index = parseListIndex(req.params.index, project.spec.roles, "ROLE_NOT_FOUND");
      assertIndexStillMatches(project.spec.roles, index, (req.body as { expect?: unknown })?.expect, "ROLE_STALE_INDEX");
      const parsed = AddRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const nextSpec = { ...project.spec, roles: project.spec.roles.map((r, i) => (i === index ? parsed.data.role : r)) };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  router.patch(
    "/projects/:id/assumptions/:index",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      // Same activePipelines guard as /roles POST above -- see its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const index = parseListIndex(req.params.index, project.spec.assumptions, "ASSUMPTION_NOT_FOUND");
      assertIndexStillMatches(
        project.spec.assumptions,
        index,
        (req.body as { expect?: unknown })?.expect,
        "ASSUMPTION_STALE_INDEX",
      );
      const parsed = AddAssumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const nextSpec = {
        ...project.spec,
        assumptions: project.spec.assumptions.map((a, i) => (i === index ? parsed.data.assumption : a)),
      };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  /**
   * The spec review screen's "entities" section (the list of screens the
   * AI Team is about to build) was the one part of the spec review page
   * with no correction path at all -- roles and assumptions each got a
   * real remove button, but an entity the heuristic/AI invented that
   * doesn't belong (an unwanted "Courier" screen on a business with no
   * delivery, say) could only be talked out of existence via the free-text
   * "additional request" box and hoping the next build actually drops it --
   * never a guaranteed, immediate removal. Removes by entityName (not
   * index, unlike roles/assumptions above) since EntitySchema names are
   * already the real unique identifier every other route in this file
   * addresses an entity by. Same `entities: z.array(EntitySchema).min(1)`
   * floor on ProductSpecSchema as roles' own `.min(1)` -- guarded the same
   * way, with a clear 400 instead of an uncaught schema-validation 500.
   * Gated to a project that hasn't been built yet: once built, this
   * spec-review screen is never shown again and the real database table,
   * generated code, and routes for that entity already exist -- removing
   * it from the spec alone would silently desync the spec from the actual
   * running app instead of actually undoing anything.
   */
  router.delete(
    "/projects/:id/entities/:entityName",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot remove a screen after the project has already been built", "ENTITY_REMOVAL_AFTER_BUILD");
      }
      // Same activePipelines guard /build itself already has (see its own
      // comment) -- an in-flight /build on this still-unbuilt project reads
      // project.spec at its own start and only writes its result back once
      // the whole pipeline finishes, so this removal would otherwise be
      // silently reverted (or, worse, removing an entity the pipeline is
      // mid-migration on) the moment that build completes.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      if (!project.spec.entities.some((e) => e.name === req.params.entityName)) {
        throw new HttpError(404, "No such screen in this project's spec", "ENTITY_NOT_FOUND");
      }
      if (project.spec.entities.length <= 1) {
        throw new HttpError(400, "Cannot remove the last remaining screen -- at least one is required", "VALIDATION_ERROR");
      }
      const dependent = project.spec.entities.find(
        (e) => e.name !== req.params.entityName && e.fields.some((f) => f.type === "relation" && f.relationTo === req.params.entityName),
      );
      if (dependent) {
        throw new HttpError(
          400,
          `Cannot remove this screen -- "${dependent.label ?? dependent.name}" still links to it`,
          "ENTITY_HAS_DEPENDENT_RELATIONS",
        );
      }
      const nextSpec = {
        ...project.spec,
        entities: project.spec.entities.filter((e) => e.name !== req.params.entityName),
      };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  /**
   * The other direction of the same gap the comment above describes --
   * removal alone was one-directional. If the heuristic/AI engine missed a
   * whole screen entirely (a two-sided marketplace where it only spotted
   * "Order", say, and never "Payment"), there was no way to add it back
   * short of a full Refine round-trip after committing to a build, or
   * talking it into existence via the free-text "additional request" box
   * and hoping the regenerated spec actually includes it. Mirrors
   * AddRoleForm/AddAssumptionForm's own shape (a single free-text field,
   * appended), but an entity needs more than a bare string to satisfy
   * EntitySchema -- `deriveEntityName` turns the typed label into a valid
   * ASCII table-name `name`, and the new entity gets the same single
   * required "name" text field every domain-library entity starts with
   * (see domainEntities.ts), rather than being born with zero fields and
   * failing `fields.min(1)`. Same pre-build-only gate as the DELETE route
   * above, for the same reason: once built, the real database table and
   * generated code already exist and don't track further spec edits.
   */
  /** Same withIdempotency() extension as POST /projects/:id/roles above -- see its own doc comment. */
  router.post(
    "/projects/:id/entities",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot add a screen after the project has already been built", "ENTITY_ADD_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const parsed = AddEntitySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(db, idempotencyKey, req.userId!, "POST /projects/:id/entities", async () => {
        const name = deriveEntityName(parsed.data.label, project.spec.entities.map((e) => e.name));
        const newEntity: Entity = {
          name,
          label: parsed.data.label,
          fields: [{ name: "name", type: "text", required: true }],
        };
        const nextSpec = { ...project.spec, entities: [...project.spec.entities, newEntity] };
        const updated = updateProjectSpec(db, project.id, nextSpec);
        return { status: 200, body: { project: updated } };
      });
      res.status(status).json(body);
    }),
  );

  /**
   * The other half of the same one-directional gap entities themselves had
   * before the add route above -- roles, assumptions, and whole entities
   * all got a real add/remove/rename correction path on the spec review
   * screen, but a single *field* within an entity had none at all: the
   * only field-level mutation anywhere in the app was renameFieldLabel
   * (cosmetic label-only). An AI/heuristic-mis-scoped entity missing an
   * obvious field (no "email" on a Customer, say) could only be fixed via
   * a full natural-language Refine round-trip after committing to a build.
   * Mirrors AddEntityForm's own shape (a single free-text label, appended)
   * -- the new field is born as a plain optional text field (type: "text",
   * required: false), the least assumption-laden starting point, using
   * deriveFieldName the same way the entity-add route above uses
   * deriveEntityName. Same pre-build-only gate as entity/field-label
   * routes: once built, the real database column and generated code
   * already exist and don't track further spec edits.
   */
  /** Same withIdempotency() extension as POST /projects/:id/roles above -- see its own doc comment. */
  router.post(
    "/projects/:id/entities/:entityName/fields",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot add a field after the project has already been built", "FIELD_ADD_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      const parsed = AddFieldSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, formatValidationError(parsed.error), "VALIDATION_ERROR");
      }
      const idempotencyKey = req.header("X-Idempotency-Key") || undefined;
      const { status, body } = await withIdempotency(
        db,
        idempotencyKey,
        req.userId!,
        "POST /projects/:id/entities/:entityName/fields",
        async () => {
          const name = deriveFieldName(parsed.data.label, entity.fields.map((f) => f.name));
          const newField: Field = { name, label: parsed.data.label, type: "text", required: false };
          const nextSpec = {
            ...project.spec,
            entities: project.spec.entities.map((e) => (e.name === entity.name ? { ...e, fields: [...e.fields, newField] } : e)),
          };
          const updated = updateProjectSpec(db, project.id, nextSpec);
          return { status: 200, body: { project: updated } };
        },
      );
      res.status(status).json(body);
    }),
  );

  /**
   * Removal side of the same gap. `entity.fields` carries EntitySchema's
   * own `fields.min(1)` floor (an entity with zero fields can't render a
   * record form at all), the same reasoning as roles'/entities' own
   * `.min(1)` guards above -- checked explicitly here for a clear 400
   * rather than an uncaught schema-validation error inside
   * updateProjectSpec. Same pre-build-only gate as every other
   * spec-shape-changing route in this file.
   */
  router.delete(
    "/projects/:id/entities/:entityName/fields/:fieldName",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status === "built") {
        throw new HttpError(409, "Cannot remove a field after the project has already been built", "FIELD_REMOVE_AFTER_BUILD");
      }
      // Same activePipelines guard as the entity-removal route above -- see
      // its own comment.
      if (activePipelines.has(project.id)) {
        throw new HttpError(409, "A build or refine is already running for this project", "PIPELINE_IN_PROGRESS");
      }
      const entity = findEntity(project, req.params.entityName);
      findField(entity, req.params.fieldName);
      if (entity.fields.length <= 1) {
        throw new HttpError(400, "Cannot remove the last remaining field -- at least one is required", "VALIDATION_ERROR");
      }
      const nextSpec = {
        ...project.spec,
        entities: project.spec.entities.map((e) =>
          e.name === entity.name ? { ...e, fields: e.fields.filter((f) => f.name !== req.params.fieldName) } : e,
        ),
      };
      const updated = updateProjectSpec(db, project.id, nextSpec);
      res.json({ project: updated });
    }),
  );

  router.patch(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      // Same FOREIGN KEY constraint translation as the POST route above --
      // see its own comment for why this is reachable through the real UI.
      let record: ReturnType<typeof updateRecord>;
      try {
        record = updateRecord(db, project.id, entity, recordId, req.body ?? {});
      } catch (err) {
        if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
          throw new HttpError(
            400,
            "This record references another record that no longer exists",
            "INVALID_RELATION_TARGET",
          );
        }
        throw err;
      }
      res.json({ record });
    }),
  );

  router.delete(
    "/projects/:id/entities/:entityName/:recordId",
    asyncRoute(async (req, res) => {
      const project = requireProjectAccess(db, req.params.id, req.userId!);
      if (project.status !== "built") {
        throw new HttpError(409, "Project has not been built yet — call POST /build first", "BUILD_REQUIRED");
      }
      const entity = findEntity(project, req.params.entityName);
      const recordId = parseRecordId(req.params.recordId);
      /**
       * `PRAGMA foreign_keys = ON` (connection.ts) makes deleting a record
       * another record still points to via a `relation` field throw a real
       * "FOREIGN KEY constraint failed" error from node:sqlite -- app.ts's
       * generic error handler turned that into an unexplained 500 before
       * this, with EntityPanel.tsx's own deferred-delete undo window
       * (round 108-ish) silently swallowing the failure entirely (its
       * `.catch(() => {})`, fixed the same round as this), so the user saw
       * the row vanish and then quietly reappear on next refresh with no
       * error ever shown. Translated into an actionable 409 here instead,
       * the same route-level pattern as EXPORT_UNSAFE_IDENTIFIER (round 284).
       */
      try {
        deleteRecord(db, project.id, entity, recordId);
      } catch (err) {
        if (err instanceof Error && err.message === "FOREIGN KEY constraint failed") {
          throw new HttpError(
            409,
            "Cannot delete this record -- another record still references it through a relation field",
            "RECORD_HAS_DEPENDENT_RECORDS",
          );
        }
        throw err;
      }
      res.status(204).end();
    }),
  );

  return router;
}
