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
  const entityByLowerName = new Map(mergedEntities.map((entity) => [entity.name.toLowerCase(), entity]));
  for (const candidateEntity of candidate.entities) {
    const existingEntity = entityByLowerName.get(candidateEntity.name.toLowerCase());
    if (!existingEntity) {
      const addedEntity = { ...candidateEntity, fields: [...candidateEntity.fields] };
      mergedEntities.push(addedEntity);
      entityByLowerName.set(addedEntity.name.toLowerCase(), addedEntity);
      continue;
    }
    const fieldNameSet = new Set(existingEntity.fields.map((field) => field.name.toLowerCase()));
    for (const candidateField of candidateEntity.fields) {
      if (!fieldNameSet.has(candidateField.name.toLowerCase())) {
        existingEntity.fields.push(candidateField);
        fieldNameSet.add(candidateField.name.toLowerCase());
      }
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
  const mergedScreens = [...candidate.screens, ...restoredScreens];
  return {
    ...candidate,
    entities: mergedEntities,
    roles: mergedRoles,
    personas: mergedPersonas,
    assumptions: mergedAssumptions,
    screens: mergedScreens,
  };
}
