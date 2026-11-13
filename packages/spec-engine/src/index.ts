import type { Entity, ProductSpec } from "@forge/shared";
import { AnthropicSpecProvider } from "./anthropic.js";
import { HeuristicSpecProvider } from "./heuristic.js";
import type { SpecProvider } from "./provider.js";

export type { SpecProvider } from "./provider.js";
export { HeuristicSpecProvider } from "./heuristic.js";
export { AnthropicSpecProvider } from "./anthropic.js";
export { isHebrewText } from "./domainEntities.js";
export { TEMPLATES, type AppTemplate } from "./templates.js";
export { requestSpecFix, type RequestSpecFixOptions } from "./debug.js";
export {
  enhancePrompt,
  selectEnhancer,
  HeuristicPromptEnhancer,
  AnthropicPromptEnhancer,
  type PromptEnhancer,
} from "./promptEnhancer.js";
// Round 925: the new Lovable.dev/Base44-style "AI Code Mode" foundation
// (system prompt + XML action parser + patch engine) -- see eliteAgent.ts's
// own doc comment. Exported here like every other provider above, but
// deliberately NOT wired into selectProvider: that function drives the
// EXISTING, already-live spec-driven generation flow, which must keep
// working unchanged while this new path is built out and proven.
export {
  ELITE_SYSTEM_PROMPT,
  parseAgentResponse,
  parsePatchHunks,
  applyPatch,
  generateEliteCodeResponse,
  type AgentAction,
  type PatchHunk,
  type ApplyPatchResult,
  type EliteAgentOptions,
  type EliteAgentResult,
} from "./eliteAgent.js";

/**
 * Picks the best available provider: a real Claude model call when
 * ANTHROPIC_API_KEY is set, otherwise the deterministic offline heuristic.
 * This is the seam the Model Router (Forge AI vision, section 31) will grow
 * from — today it's a two-way choice, not a full router.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): SpecProvider {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new AnthropicSpecProvider({ apiKey, model: env.ANTHROPIC_MODEL });
  }
  return new HeuristicSpecProvider();
}

/**
 * If a real model call fails at runtime -- network error, rate limit, or the
 * model's output not matching ProductSpecSchema -- this falls back to the
 * deterministic heuristic provider instead of surfacing a raw 500 to the
 * user, who has no way to act on "Internal server error". The real failure
 * is still logged server-side for diagnosis. `providerName` comes back
 * tagged "<name>-fallback" so this is never silently mistaken for a normal
 * heuristic (no-API-key) response.
 */
export async function generateSpec(
  description: string,
  provider: SpecProvider = selectProvider(),
  isHebrewOverride?: boolean,
): Promise<{ spec: ProductSpec; providerName: string }> {
  try {
    const spec = await provider.generate(description, isHebrewOverride);
    return { spec, providerName: provider.name };
  } catch (err) {
    if (provider.name === "heuristic") throw err;
    // eslint-disable-next-line no-console
    console.error(`spec provider "${provider.name}" failed, falling back to heuristic:`, err);
    const spec = await new HeuristicSpecProvider().generate(description, isHebrewOverride);
    return { spec, providerName: `${provider.name}-fallback` };
  }
}

/**
 * Round 1911: a handful of curated templates (templates.ts) give their own
 * built-in "person who works for/with the business" entity a different name
 * than the heuristic engine's own generic "Employee" domain-entity rule
 * (domainEntities.ts) would produce for the identical concept -- "TeamMember"
 * (Project & Team Tracker template) and "Staff" (Appointments & Clients
 * template). Both templates' own short stored descriptions ("...tasks and
 * team members.", "Clients, staff, services...") contain one of Employee's
 * own keywords ("team member", /\bstaff\b/) -- entirely reasonably, since a
 * freeform description that mentions "team members" genuinely should produce
 * an Employee entity on a FIRST build. But /refine's own combinedDescription
 * (routes/projects.ts) re-appends the project's permanently-stored
 * description on every single future refine, so this same keyword match
 * re-fires every time, regardless of what the new instruction actually asked
 * for. Because mergeRefinedSpec (and detectLikelyEntityRenames below) match
 * entities by exact name, "Employee" never matches the existing "TeamMember"/
 * "Staff" entity, so a brand-new, redundant person-tracking entity (with its
 * own SQL table and screens) got silently added on every refine of either
 * template -- confirmed live: refining a fresh "Project & Team Tracker"
 * project with an unrelated instruction ("Add a Notes field to Milestone")
 * added a whole new "Employee" entity alongside the pre-existing "Team
 * Member" one, with no warning anywhere.
 *
 * This maps each known alias back to a shared canonical key so both
 * functions below treat them as the SAME entity for matching purposes --
 * mergeRefinedSpec folds the candidate's fields into the existing aliased
 * entity (exactly like it already does for an exact name match) instead of
 * adding a duplicate, and detectLikelyEntityRenames correctly stays silent
 * rather than misreporting a non-existent "rename". Deliberately a short,
 * explicit list of verified aliases rather than a general name-similarity
 * heuristic (e.g. field-overlap scoring): two genuinely unrelated entities
 * can easily share common field names (name/email/phone), which is exactly
 * why detectLikelyEntityRenames's own doc comment requires an exact
 * field-signature match rather than a looser one.
 */
const ENTITY_ALIAS_GROUPS: string[][] = [["employee", "teammember", "staff"]];
const ENTITY_ALIAS_KEY = new Map<string, string>();
for (const group of ENTITY_ALIAS_GROUPS) {
  for (const name of group) ENTITY_ALIAS_KEY.set(name, group[0]);
}
function entityMergeKey(name: string): string {
  const lower = name.toLowerCase();
  return ENTITY_ALIAS_KEY.get(lower) ?? lower;
}

/**
 * Round 1714: /projects/:id/refine (apps/api/src/routes/projects.ts) calls
 * generateSpec with the project's own description plus the new instruction
 * appended -- but SpecProvider.generate (both HeuristicSpecProvider and
 * AnthropicSpecProvider) takes plain text only, with zero awareness of the
 * CURRENT spec it is refining. A live-tested repro confirmed the heuristic
 * provider's own keyword matching alone, re-run on the same description it
 * originally produced a spec from, already yields a materially different
 * entity set -- so the first "Improve the app" on a Templates-Gallery
 * project (whose stored description is the template's own short marketing
 * blurb, not the richer text that produced its curated entities) silently
 * replaced the whole candidate spec, dropping entire entities (e.g. the
 * Sales CRM template's Contact entity vanished outright) and relations the
 * user never asked to remove.
 *
 * This merges the freshly generated candidate spec INTO the current one
 * instead of replacing it outright: every entity and role the current spec
 * already has survives, candidate entities/fields/roles that don't already
 * exist are added. This can't apply a request to CHANGE an existing field
 * (e.g. "make X required") -- generateSpec's own re-derivation already
 * couldn't reliably do that before this fix either -- but it stops refine
 * from silently deleting unrelated, already-built parts of the app, which
 * is the far more damaging failure mode. A full fix (passing the live spec
 * as structured context into generation itself) is a bigger redesign left
 * for a future round.
 */
export function mergeRefinedSpec(current: ProductSpec, candidate: ProductSpec): ProductSpec {
  const mergedEntities: Entity[] = current.entities.map((entity) => ({ ...entity, fields: [...entity.fields] }));
  const entityByLowerName = new Map(mergedEntities.map((entity) => [entityMergeKey(entity.name), entity]));
  // Round 2009: every entity named here (current's own, plus every entity
  // candidate.entities carries) is guaranteed to exist in mergedEntities by
  // the time this function returns -- either it already did, or the
  // "!existingEntity" branch just below adds it verbatim. A relation field
  // bolted onto an ALREADY-EXISTING entity by the loop below is only ever
  // safe when its own relationTo resolves to one of those same names;
  // otherwise it permanently points at an entity that never existed and
  // never will (see this function's own round-1973 screens-filtering
  // comment below for the identical "don't reference an entity name that
  // didn't survive" concern, just on the other side of the merge).
  const resolvableEntityKeys = new Set<string>([
    ...current.entities.map((entity) => entityMergeKey(entity.name)),
    ...candidate.entities.map((entity) => entityMergeKey(entity.name)),
  ]);
  for (const candidateEntity of candidate.entities) {
    const existingEntity = entityByLowerName.get(entityMergeKey(candidateEntity.name));
    if (!existingEntity) {
      const addedEntity = { ...candidateEntity, fields: [...candidateEntity.fields] };
      mergedEntities.push(addedEntity);
      entityByLowerName.set(entityMergeKey(addedEntity.name), addedEntity);
      continue;
    }
    const fieldNameSet = new Set(existingEntity.fields.map((field) => field.name.toLowerCase()));
    for (const candidateField of candidateEntity.fields) {
      if (fieldNameSet.has(candidateField.name.toLowerCase())) continue;
      // Round 2009: domainEntities.ts's own Order rule carries an optional
      // `courierId` relation to a "Courier" entity that, by that rule's own
      // explicit design ("when a description only mentions order without a
      // courier/driver, the Courier entity... won't exist in the spec at
      // all"), frequently never exists alongside it -- a from-scratch build
      // tolerates that (the whole spec is generated together, so there's
      // nothing else for the field to have silently displaced). But when
      // this exact Order candidate instead arrives here, into an EXISTING
      // entity that an unrelated refine instruction merely re-triggered
      // (confirmed live: refining the curated Restaurant Management
      // template, whose own stored description mentions "orders", with an
      // unrelated instruction about a different entity entirely), bolting
      // on a relation to an entity that was never requested and will never
      // exist in this project is a strictly worse outcome than simply
      // leaving the field out -- a permanently dead, always-empty relation
      // picker on every single Order record, forever. Skipping only a
      // candidate field that is itself new to this entity AND a relation to
      // an entity absent from both sides of this merge leaves every other
      // candidate field (including a relation that genuinely does resolve,
      // e.g. because the SAME refine also introduced/already has that
      // target entity) merged exactly as before.
      if (candidateField.type === "relation" && candidateField.relationTo && !resolvableEntityKeys.has(entityMergeKey(candidateField.relationTo))) {
        continue;
      }
      existingEntity.fields.push(candidateField);
      fieldNameSet.add(candidateField.name.toLowerCase());
    }
  }
  const roleSet = new Set(current.roles.map((role) => role.toLowerCase()));
  const mergedRoles = [...current.roles];
  for (const candidateRole of candidate.roles) {
    if (!roleSet.has(candidateRole.toLowerCase())) {
      mergedRoles.push(candidateRole);
      roleSet.add(candidateRole.toLowerCase());
    }
  }
  // Round 1755: personas/assumptions are plain string lists with the exact
  // same user-facing CRUD treatment as roles (RoleChip/PersonaItem/
  // AssumptionItem + their Add*Form siblings, App.tsx's preview-roles/
  // personas/assumptions-section -- round 906's own comment explains these
  // all work post-build too), not inert narrative text like summary -- yet
  // this function only ever merged roles the "current survives, candidate
  // only adds" way, leaving personas/assumptions on "candidate only", the
  // same silent-deletion failure mode round 1714 exists specifically to
  // stop and round 1753 already extended to screens. A user who manually
  // adds a persona/assumption on the post-build preview screen loses it
  // the next time anyone runs an ordinary refine instruction whose own
  // regenerated candidate happens to omit it.
  const personaSet = new Set(current.personas.map((persona) => persona.toLowerCase()));
  const mergedPersonas = [...current.personas];
  for (const candidatePersona of candidate.personas) {
    if (!personaSet.has(candidatePersona.toLowerCase())) {
      mergedPersonas.push(candidatePersona);
      personaSet.add(candidatePersona.toLowerCase());
    }
  }
  const assumptionSet = new Set(current.assumptions.map((assumption) => assumption.toLowerCase()));
  const mergedAssumptions = [...current.assumptions];
  for (const candidateAssumption of candidate.assumptions) {
    if (!assumptionSet.has(candidateAssumption.toLowerCase())) {
      mergedAssumptions.push(candidateAssumption);
      assumptionSet.add(candidateAssumption.toLowerCase());
    }
  }
  // candidate.screens was derived (screensFor/buildScreens) from
  // candidate.entities BEFORE this merge restored any dropped entity, so
  // it never has List/Form screens for an entity mergedEntities just
  // brought back -- restore those screens from current.screens the same
  // "current survives, candidate only adds" way entities/roles are
  // merged above. Without this, the restored entity has no screens at
  // all, permanently baking the entities/screens mismatch into this and
  // every later checkpoint (nothing ever regenerates screens afterward),
  // and under-reporting Time Machine's own "N screens" count
  // (HistoryPanel.tsx/checkpointDiff.ts, which read screens.length, not
  // entities.length, for exactly this reason).
  const candidateEntityNames = new Set(candidate.entities.map((entity) => entity.name.toLowerCase()));
  const restoredScreens = current.screens.filter((screen) => screen.entity && !candidateEntityNames.has(screen.entity.toLowerCase()));
  // Round 1973: this block still matched by plain `.toLowerCase()`, not
  // `entityMergeKey` -- round 1911 added a SECOND merge mode (alias
  // folding: a regenerated "Employee" entity folds into an existing
  // "TeamMember"/"Staff" one instead of becoming a separate entity) to
  // the entity half of this function above, but never updated this
  // screens half to match. `candidate.screens` is spliced in verbatim,
  // with no filtering for an entity the alias merge just folded away --
  // so `candidate.screens` still contains "Employee List"/"Employee
  // Form" (derived from the candidate's own pre-merge entity list, which
  // still names it "Employee"), even though no entity named "Employee"
  // survives in `mergedEntities` once it's folded into "TeamMember".
  // These two screens become permanently dangling: nothing downstream
  // ever regenerates/re-validates `screens` against `entities` (round
  // 1905's own established finding on this exact function), and every
  // later refine keeps re-splicing `candidate.screens` verbatim again,
  // baking the mismatch in for good. HistoryPanel.tsx/checkpointDiff.ts
  // both read `screens.length`, not `entities.length`, for Time
  // Machine's own "N screens" count (see this function's own round-1753
  // comment above) -- permanently inflating it by 2 for every checkpoint
  // on any project that ever hits the alias-merge path. Filtering against
  // `mergedEntities` itself (ground truth for what actually survived)
  // rather than re-deriving the alias logic a second time here closes
  // this without needing to thread entityMergeKey through this block too.
  const survivingEntityNames = new Set(mergedEntities.map((entity) => entity.name.toLowerCase()));
  const mergedScreens = [...candidate.screens, ...restoredScreens].filter(
    (screen) => !screen.entity || survivingEntityNames.has(screen.entity.toLowerCase()),
  );
  return {
    ...candidate,
    entities: mergedEntities,
    roles: mergedRoles,
    personas: mergedPersonas,
    assumptions: mergedAssumptions,
    screens: mergedScreens,
  };
}

/**
 * Round 1803: mergeRefinedSpec above matches entities by exact name only --
 * by design, it never REMOVES a current entity (see its own doc comment,
 * "every entity ... survives"), so when a refine instruction renames an
 * entity (a realistic, common request, e.g. "rename Customer to Client"),
 * the candidate's new-named entity doesn't match the old one by name and
 * gets added as if unrelated, while the old-named entity is never touched.
 * The merged spec ends up with BOTH entities live at once -- not the
 * rename the user asked for -- and for a post-build /refine this creates
 * two real, independent SQLite tables (confirmed via mergeRefinedSpec's own
 * callers in routes/projects.ts, which feed its result straight into the
 * real migration pipeline).
 *
 * This detects that specific shape so a caller can warn the user, without
 * touching the merge itself: an exact field-name-set match between a
 * current entity the candidate completely omits and a brand-new candidate
 * entity is a strong signal, but not a certain one (two genuinely
 * different entities could coincidentally share every field name) --
 * acting on it by auto-merging would risk the exact silent-data-loss
 * failure mode mergeRefinedSpec itself exists to prevent, so this only
 * ever informs, never merges.
 *
 * Round 1911: uses the same entityMergeKey as mergeRefinedSpec above for
 * its own "does the candidate/current already have this entity" checks --
 * without this, a known alias pair (e.g. "TeamMember" vs "Employee", now
 * silently merged rather than duplicated) would still land in both
 * droppedEntities and addedEntities here, producing a misleading "X looks
 * like it was meant to become Y" warning for an entity that was never
 * actually dropped.
 */
export function detectLikelyEntityRenames(current: ProductSpec, candidate: ProductSpec): { from: string; to: string }[] {
  const candidateNames = new Set(candidate.entities.map((entity) => entityMergeKey(entity.name)));
  const currentNames = new Set(current.entities.map((entity) => entityMergeKey(entity.name)));
  const droppedEntities = current.entities.filter((entity) => !candidateNames.has(entityMergeKey(entity.name)));
  const addedEntities = candidate.entities.filter((entity) => !currentNames.has(entityMergeKey(entity.name)));
  const fieldSignature = (entity: Entity) =>
    [...new Set(entity.fields.map((field) => field.name.toLowerCase()))].sort().join(",");
  const renames: { from: string; to: string }[] = [];
  for (const dropped of droppedEntities) {
    // An empty signature (an entity with no fields at all) would otherwise
    // match ANY other empty-field entity -- never a meaningful signal of a
    // genuine rename, just two unrelated bare entities.
    if (dropped.fields.length === 0) continue;
    const droppedSignature = fieldSignature(dropped);
    const match = addedEntities.find((added) => added.fields.length > 0 && fieldSignature(added) === droppedSignature);
    if (match) renames.push({ from: dropped.label || dropped.name, to: match.label || match.name });
  }
  return renames;
}

/**
 * Round 1825: the field-level analog of detectLikelyEntityRenames above --
 * that function only ever matches a current entity the candidate drops
 * entirely against a brand-new candidate entity, but mergeRefinedSpec's
 * own per-entity field loop (lines 115-121 above) has the exact same
 * "candidate only adds, current survives" limitation one level down,
 * inside an entity that itself matched and survives the merge (e.g.
 * "rename the priority field to urgencyLevel" on Ticket): the old field
 * is never removed, the new one gets added, and the entity ends up with
 * both -- the same silent-duplication shape, one level down, with the
 * same real consequence (diffAndMigrate genuinely ADD COLUMNs the new
 * field while leaving the old column intact).
 *
 * Deliberately scoped narrowly to avoid a false positive: only when a
 * surviving entity drops EXACTLY ONE field and gains EXACTLY ONE new
 * field (no ambiguity about which pair goes together, unlike the
 * entity-level check above which can lean on a whole field-name-set
 * match), and the two share the same type (plus, for a relation field,
 * the same relationTo -- a same-named field keeping its name but
 * changing type/relationTo is already covered by computeImpact's own
 * retypedFields/retargetedFields, a different, already-handled shape).
 *
 * Round 1974: this used to match entities by plain `.toLowerCase()`,
 * same as `mergeRefinedSpec`/`detectLikelyEntityRenames` did before round
 * 1911 -- but that round's own `entityMergeKey` fix (ENTITY_ALIAS_GROUPS
 * above) was only ever applied to those two functions, never to this
 * one. `mergeRefinedSpec` itself IS alias-aware, so a regenerated
 * "Employee" entity correctly folds its fields into an existing
 * "TeamMember"/"Staff" entity rather than becoming a separate one -- but
 * that merge is additive-only (current survives, candidate only adds),
 * so a field rename INSIDE that same alias-matched entity (e.g. the
 * regenerated "Employee" drops `name` and gains `fullName`) still leaves
 * both the stale `name` and the new `fullName` on the merged entity,
 * exactly the silent duplication this function exists to warn about.
 * Without this fix, `pipeline.ts`'s `describeImpactHazards` -- called
 * with the same raw, pre-merge current/candidate pair `mergeRefinedSpec`
 * itself receives -- never even looked up the alias-matched entity here
 * (the map was keyed by the OTHER alias member's plain lowercase name),
 * so `currentEntity` came back `undefined` and the whole comparison was
 * silently skipped, for the exact entity this function is most likely to
 * ever see a genuine rename on (it's a known hotspot for a regenerated-
 * under-a-different-name entity in the first place).
 */
export function detectLikelyFieldRenames(current: ProductSpec, candidate: ProductSpec): { entity: string; from: string; to: string }[] {
  const currentByLowerName = new Map(current.entities.map((entity) => [entityMergeKey(entity.name), entity]));
  const renames: { entity: string; from: string; to: string }[] = [];
  for (const candidateEntity of candidate.entities) {
    const currentEntity = currentByLowerName.get(entityMergeKey(candidateEntity.name));
    if (!currentEntity) continue;
    const candidateFieldNames = new Set(candidateEntity.fields.map((field) => field.name.toLowerCase()));
    const currentFieldNames = new Set(currentEntity.fields.map((field) => field.name.toLowerCase()));
    const droppedFields = currentEntity.fields.filter((field) => !candidateFieldNames.has(field.name.toLowerCase()));
    const addedFields = candidateEntity.fields.filter((field) => !currentFieldNames.has(field.name.toLowerCase()));
    if (droppedFields.length !== 1 || addedFields.length !== 1) continue;
    const [dropped] = droppedFields;
    const [added] = addedFields;
    if (dropped.type !== added.type) continue;
    if (dropped.type === "relation" && (dropped.relationTo ?? "").toLowerCase() !== (added.relationTo ?? "").toLowerCase()) continue;
    renames.push({
      entity: candidateEntity.label || candidateEntity.name,
      from: dropped.label || dropped.name,
      to: added.label || added.name,
    });
  }
  return renames;
}
