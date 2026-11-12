import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSpec } from "@forge/shared";
import { AnthropicSpecProvider, SYSTEM_PROMPT } from "./anthropic.js";
import { selectProvider, generateSpec, mergeRefinedSpec, detectLikelyEntityRenames, detectLikelyFieldRenames } from "./index.js";

function baseSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    summary: "base",
    personas: [],
    roles: ["Admin"],
    entities: [],
    screens: [],
    assumptions: [],
    openQuestions: [],
    ...overrides,
  };
}

test("the Product Manager Agent's system prompt tells the model to be thorough, not to minimize", () => {
  // Direct product feedback: the platform should not default to recommending
  // a stripped-down spec -- it should try to cover everything the user's
  // description implies. Lock this in as a real regression test so a future
  // prompt edit can't silently reintroduce "infer the minimum viable set...
  // do not over-engineer" style language.
  assert.doesNotMatch(SYSTEM_PROMPT, /minimum viable/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /do not over-engineer/i);
  assert.match(SYSTEM_PROMPT, /thorough/i);
});

test("selectProvider falls back to heuristic when no API key is configured", () => {
  const provider = selectProvider({});
  assert.equal(provider.name, "heuristic");
});

test("selectProvider picks Anthropic when an API key is configured", () => {
  const provider = selectProvider({ ANTHROPIC_API_KEY: "test-key" } as NodeJS.ProcessEnv);
  assert.equal(provider.name, "anthropic");
});

test("AnthropicSpecProvider parses a well-formed model response", async () => {
  const fakeSpec = {
    summary: "A tiny CRM",
    personas: ["Admin user"],
    roles: ["Admin"],
    entities: [
      {
        name: "Lead",
        fields: [{ name: "name", type: "text", required: true }],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("a tiny CRM");
  assert.equal(spec.summary, "A tiny CRM");
  assert.equal(spec.entities[0].name, "Lead");
});

test("AnthropicSpecProvider strips markdown fences before parsing", async () => {
  const fakeSpec = {
    summary: "Fenced",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "Thing", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fenced = "```json\n" + JSON.stringify(fakeSpec) + "\n```";
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: fenced }] }), { status: 200 })) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  const spec = await provider.generate("fenced case");
  assert.equal(spec.summary, "Fenced");
});

test("AnthropicSpecProvider rejects a field named 'id' or 'createdAt' (both are built-in columns every generated table already has)", async () => {
  const fakeSpec = {
    summary: "A tiny CRM",
    personas: [],
    roles: ["Admin"],
    entities: [
      {
        name: "Lead",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "createdAt", type: "date", required: false },
        ],
      },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("a tiny CRM"), /collides with a built-in column/);
});

test("AnthropicSpecProvider rejects two entities whose names collide when compared case-insensitively (SQLite table names are case-insensitive, so 'Order' and 'order' would silently share one table)", async () => {
  const fakeSpec = {
    summary: "A tiny logistics app",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "order", fields: [{ name: "status", type: "text", required: false }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(fakeSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("a tiny logistics app"), /collide when compared case-insensitively/);
});

test("a model response with two case-colliding entity names falls back to the heuristic provider end to end, instead of ever reaching the database layer with two entities mapped to one SQLite table", async () => {
  const caseCollidingSpec = {
    summary: "A tiny logistics app",
    personas: [],
    roles: ["Admin"],
    entities: [
      { name: "Order", fields: [{ name: "total", type: "number", required: true }] },
      { name: "ORDER", fields: [{ name: "status", type: "text", required: false }] },
    ],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(caseCollidingSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });

  const { spec, providerName } = await generateSpec("a tiny logistics app", provider);
  assert.equal(providerName, "anthropic-fallback");
  const lowerNames = spec.entities.map((e) => e.name.toLowerCase());
  assert.equal(new Set(lowerNames).size, lowerNames.length);
});

test("a model response with a field named 'id' falls back to the heuristic provider end to end, instead of ever reaching the database layer with a colliding column name", async () => {
  const badFieldSpec = {
    summary: "A tiny CRM",
    personas: [],
    roles: ["Admin"],
    entities: [{ name: "Lead", fields: [{ name: "id", type: "text", required: true }] }],
    screens: [],
    assumptions: [],
    openQuestions: [],
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(badFieldSpec) }] }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });

  const { spec, providerName } = await generateSpec("a tiny CRM", provider);
  assert.equal(providerName, "anthropic-fallback");
  // The real heuristic output, not the rejected spec -- no entity in it ever
  // has a field literally named "id" (that's the whole point).
  for (const entity of spec.entities) {
    assert.ok(!entity.fields.some((f) => f.name.toLowerCase() === "id"));
  }
});

test("AnthropicSpecProvider throws a descriptive error on API failure", async () => {
  const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  const provider = new AnthropicSpecProvider({ apiKey: "test-key", fetchImpl: fakeFetch });
  await assert.rejects(() => provider.generate("x"), /429/);
});

test("generateSpec returns providerName alongside the spec", async () => {
  const { spec, providerName } = await generateSpec("customers and invoices");
  assert.equal(providerName, "heuristic");
  assert.ok(spec.entities.length > 0);
});

/**
 * Round 708: generateSpec's own new third parameter must actually reach
 * the provider's generate() call -- both on the normal path and on the
 * fallback-to-heuristic path, since a /refine or /answers call whose real
 * provider fails must not silently lose the language pin and fall back to
 * re-deriving it from the (potentially mixed-language) description text.
 */
test("generateSpec forwards isHebrewOverride to the provider, including the fallback heuristic call when the primary provider throws", async () => {
  let capturedOverride: boolean | undefined;
  const failingProvider = {
    name: "anthropic",
    generate: async (_description: string, isHebrewOverride?: boolean) => {
      capturedOverride = isHebrewOverride;
      throw new Error("simulated model failure");
    },
  };
  const { spec, providerName } = await generateSpec("a shop with customers and orders", failingProvider, false);
  assert.equal(providerName, "anthropic-fallback");
  assert.equal(capturedOverride, false, "the primary provider must receive the real override before it fails");
  // The fallback's own heuristic call must have received the same override
  // too -- confirmed indirectly: an English-pinned fallback must not carry
  // a Hebrew label even if it somehow would have otherwise.
  assert.equal(spec.entities[0]?.label, undefined, "the fallback heuristic call must have received the same English pin");
});

test("generateSpec falls back to the heuristic provider when a non-heuristic provider throws, instead of surfacing a raw error", async () => {
  const failingProvider = {
    name: "anthropic",
    generate: async () => {
      throw new Error("simulated model failure (e.g. schema mismatch or rate limit)");
    },
  };
  const { spec, providerName } = await generateSpec("a shop with customers and orders", failingProvider);
  assert.equal(providerName, "anthropic-fallback");
  assert.ok(spec.entities.length > 0);
});

test("generateSpec still throws when the heuristic provider itself fails (no further fallback to hide behind)", async () => {
  const failingHeuristic = {
    name: "heuristic",
    generate: async () => {
      throw new Error("should propagate, not loop");
    },
  };
  await assert.rejects(() => generateSpec("x", failingHeuristic), /should propagate/);
});

/**
 * Round 1714: a live-tested repro found that /refine's own candidate spec
 * (generateSpec's return value, with zero awareness of the project's
 * CURRENT spec) can silently drop whole entities the current spec already
 * has -- e.g. the Sales CRM template's Contact entity vanished outright on
 * the very first refine of a Templates-Gallery project. mergeRefinedSpec
 * is the safety net: the CURRENT spec's entities/fields/roles always
 * survive; the candidate only ever ADDS what it introduces that doesn't
 * already exist.
 */
test("mergeRefinedSpec keeps an entity the candidate dropped entirely", () => {
  const current = baseSpec({
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Contact", fields: [{ name: "name", type: "text", required: true }] },
    ],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Customer List", type: "list", entity: "Customer" },
      { name: "Customer Form", type: "form", entity: "Customer" },
      { name: "Contact List", type: "list", entity: "Contact" },
      { name: "Contact Form", type: "form", entity: "Contact" },
    ],
  });
  // The candidate re-derived only Customer -- Contact is gone, exactly the
  // live-repro'd failure. candidate.screens reflects this: it was computed
  // (screensFor/buildScreens) from candidate.entities BEFORE the merge ever
  // restores Contact, so it only has Customer's own screens.
  const candidate = baseSpec({
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Customer List", type: "list", entity: "Customer" },
      { name: "Customer Form", type: "form", entity: "Customer" },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name).sort(),
    ["Contact", "Customer"],
  );
  // Round 1753: the restored Contact entity must also get its screens
  // back, not just the entity record itself -- otherwise the merged spec
  // has an entity with zero screens, baked permanently into the resulting
  // checkpoint.
  assert.deepEqual(
    merged.screens.map((s) => s.name).sort(),
    ["Contact Form", "Contact List", "Customer Form", "Customer List", "Dashboard"],
  );
});

test("mergeRefinedSpec still adds a genuinely new entity the candidate introduces", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name).sort(),
    ["Customer", "Invoice"],
  );
});

test("mergeRefinedSpec adds a new field to an existing entity, but keeps that entity's current fields too", () => {
  const current = baseSpec({
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "notes", type: "longtext", required: false },
        ],
      },
    ],
  });
  // The candidate re-derived Customer without "notes" at all, but introduced a new "phone" field.
  const candidate = baseSpec({
    entities: [
      {
        name: "Customer",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "phone", type: "text", required: false },
        ],
      },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  const customer = merged.entities.find((e) => e.name === "Customer")!;
  assert.deepEqual(
    customer.fields.map((f) => f.name).sort(),
    ["name", "notes", "phone"],
  );
});

test("mergeRefinedSpec matches entity/role names case-insensitively, so a mere casing difference doesn't duplicate", () => {
  const current = baseSpec({ roles: ["Admin"], entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({ roles: ["admin"], entities: [{ name: "customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.equal(merged.roles.length, 1);
  assert.equal(merged.entities.length, 1);
});

test("mergeRefinedSpec unions roles the same way as entities", () => {
  const current = baseSpec({ roles: ["Admin"] });
  const candidate = baseSpec({ roles: ["Admin", "Manager"] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.roles, ["Admin", "Manager"]);
});

/**
 * Round 1755: personas/assumptions get the exact same post-build CRUD
 * treatment roles does (RoleChip/PersonaItem/AssumptionItem, App.tsx's
 * preview-roles/personas/assumptions-section), yet mergeRefinedSpec only
 * ever unioned roles -- personas/assumptions came straight from the
 * candidate, silently wiping out anything the user manually added if an
 * ordinary refine's own regenerated candidate happened to omit it.
 */
test("mergeRefinedSpec unions personas and assumptions the same way as roles, instead of silently dropping the current spec's own entries", () => {
  const current = baseSpec({
    personas: ["Regional Manager", "Returning Customer"],
    assumptions: ["No multi-currency support needed", "Single warehouse only"],
  });
  const candidate = baseSpec({ personas: [], assumptions: [] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.personas, ["Regional Manager", "Returning Customer"]);
  assert.deepEqual(merged.assumptions, ["No multi-currency support needed", "Single warehouse only"]);
});

test("mergeRefinedSpec still adds a genuinely new persona/assumption the candidate introduces, case-insensitively deduped", () => {
  const current = baseSpec({ personas: ["Admin User"], assumptions: ["Single currency"] });
  const candidate = baseSpec({ personas: ["admin user", "Support Agent"], assumptions: ["Single currency", "No offline mode"] });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.personas, ["Admin User", "Support Agent"]);
  assert.deepEqual(merged.assumptions, ["Single currency", "No offline mode"]);
});

test("mergeRefinedSpec takes the candidate's own summary, not the current spec's", () => {
  const current = baseSpec({ summary: "old summary" });
  const candidate = baseSpec({ summary: "new summary reflecting the refine instruction" });
  const merged = mergeRefinedSpec(current, candidate);
  assert.equal(merged.summary, "new summary reflecting the refine instruction");
});

/**
 * Round 1803: mergeRefinedSpec above never removes a current entity, so a
 * refine that renames one (e.g. "rename Customer to Client") doesn't
 * replace it -- it leaves the old-named entity untouched AND adds the new
 * one as if unrelated, producing two live entities instead of a rename.
 * detectLikelyEntityRenames doesn't change that merge behavior (see its own
 * doc comment on why not); it only flags the shape for a caller to warn on.
 */
test("mergeRefinedSpec keeps BOTH entities when a refine renames one -- it is not a replacement, confirming detectLikelyEntityRenames's own premise", () => {
  const current = baseSpec({
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }] }],
  });
  const candidate = baseSpec({
    entities: [{ name: "Client", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }] }],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name).sort(),
    ["Client", "Customer"],
  );
});

/**
 * Round 1911: a live-tested repro found that refining ANY project built
 * from the "Project & Team Tracker" template silently creates a duplicate
 * "Employee" entity alongside the template's own "TeamMember" entity, no
 * matter what the refine instruction actually says -- because the
 * template's own permanently-stored description ("...tasks and team
 * members.") contains the Employee domain-entity rule's own "team member"
 * keyword, and /refine's combinedDescription re-feeds that stored
 * description into generateSpec on every single refine. Since the two
 * entities have different names, the ordinary exact-name merge below
 * treats the regenerated "Employee" as unrelated and adds it as a second,
 * SQL-table-backed person entity -- confirmed live via Playwright. The
 * "Staff" entity in the Appointments & Clients template has the identical
 * exposure (its own stored description contains "staff"). This pins that
 * mergeRefinedSpec now recognizes both as already satisfying the Employee
 * concept and folds the candidate's fields into the EXISTING entity
 * instead of duplicating it -- exactly like it already does for an exact
 * name match.
 */
test("mergeRefinedSpec folds a regenerated Employee entity into an existing TeamMember entity instead of duplicating it", () => {
  const current = baseSpec({
    entities: [
      { name: "TeamMember", label: "Team Member", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }, { name: "phone", type: "text", required: false }, { name: "jobTitle", type: "text", required: false }] },
    ],
  });
  // The candidate is what the heuristic engine regenerates purely from the
  // template's own stored description re-matching the Employee keyword --
  // it has no idea TeamMember already exists under a different name.
  const candidate = baseSpec({
    entities: [
      { name: "Employee", label: "Employee", fields: [{ name: "name", type: "text", required: true }, { name: "role", type: "text", required: false }, { name: "email", type: "text", required: false }, { name: "phone", type: "text", required: false }, { name: "active", type: "boolean", required: false }] },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(
    merged.entities.map((e) => e.name),
    ["TeamMember"],
    "must NOT add a second, duplicate person-tracking entity -- the candidate's Employee concept already exists as TeamMember",
  );
  assert.deepEqual(
    merged.entities[0].fields.map((f) => f.name).sort(),
    ["active", "email", "jobTitle", "name", "phone", "role"],
    "TeamMember's own fields must survive, with the candidate's genuinely new fields (role, active) folded in, same as an exact-name merge already does",
  );
});

test("mergeRefinedSpec folds a regenerated Employee entity into an existing Staff entity instead of duplicating it (Appointments & Clients template's own alias)", () => {
  const current = baseSpec({
    entities: [
      { name: "Staff", label: "Staff", fields: [{ name: "name", type: "text", required: true }, { name: "specialty", type: "text", required: false }, { name: "phone", type: "text", required: false }, { name: "email", type: "text", required: false }] },
    ],
  });
  const candidate = baseSpec({
    entities: [
      { name: "Employee", label: "Employee", fields: [{ name: "name", type: "text", required: true }, { name: "role", type: "text", required: false }, { name: "email", type: "text", required: false }, { name: "phone", type: "text", required: false }, { name: "active", type: "boolean", required: false }] },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.entities.map((e) => e.name), ["Staff"]);
  assert.deepEqual(
    merged.entities[0].fields.map((f) => f.name).sort(),
    ["active", "email", "name", "phone", "role", "specialty"],
  );
});

/**
 * Round 1973: round 1911 added entityMergeKey/ENTITY_ALIAS_GROUPS to the
 * ENTITY half of mergeRefinedSpec (the two tests just above), but never
 * updated the SCREENS half, which still matches by plain
 * `.toLowerCase()`. `candidate.screens` is spliced in verbatim -- it
 * still contains "Employee List"/"Employee Form" (derived from the
 * candidate's own pre-merge entity list, which still names it
 * "Employee"), even though no entity named "Employee" survives in
 * `merged.entities` once it's folded into "TeamMember". This pins that
 * those two now-dangling screens are filtered out of the merged result,
 * not left referencing a non-existent entity -- a screen with no
 * `entity` at all (a dashboard) must still survive untouched.
 */
test("mergeRefinedSpec drops the candidate's dangling List/Form screens for an Employee entity the alias merge just folded away", () => {
  const current = baseSpec({
    entities: [
      { name: "TeamMember", label: "Team Member", fields: [{ name: "name", type: "text", required: true }, { name: "jobTitle", type: "text", required: false }] },
    ],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "TeamMember List", type: "list", entity: "TeamMember" },
      { name: "TeamMember Form", type: "form", entity: "TeamMember" },
    ],
  });
  const candidate = baseSpec({
    entities: [
      { name: "Employee", label: "Employee", fields: [{ name: "name", type: "text", required: true }, { name: "role", type: "text", required: false }] },
    ],
    screens: [
      { name: "Dashboard", type: "dashboard" },
      { name: "Employee List", type: "list", entity: "Employee" },
      { name: "Employee Form", type: "form", entity: "Employee" },
    ],
  });
  const merged = mergeRefinedSpec(current, candidate);
  assert.deepEqual(merged.entities.map((e) => e.name), ["TeamMember"], "sanity check: the alias merge must still fold Employee into TeamMember");
  assert.deepEqual(
    merged.screens.map((s) => s.name).sort(),
    ["Dashboard", "TeamMember Form", "TeamMember List"],
    "the dangling Employee List/Form screens must be dropped, while TeamMember's own screens (restored from current.screens, since the candidate regenerated the entity under the different name \"Employee\") and the entity-less Dashboard screen must survive",
  );
  for (const screen of merged.screens) {
    if (screen.entity) {
      assert.ok(
        merged.entities.some((e) => e.name.toLowerCase() === screen.entity!.toLowerCase()),
        `screen "${screen.name}" references entity "${screen.entity}", which doesn't exist in merged.entities`,
      );
    }
  }
});

test("detectLikelyEntityRenames stays silent for the TeamMember/Employee alias pair, instead of misreporting it as a rename", () => {
  const current = baseSpec({
    entities: [{ name: "TeamMember", fields: [{ name: "name", type: "text", required: true }, { name: "jobTitle", type: "text", required: false }] }],
  });
  const candidate = baseSpec({
    entities: [{ name: "Employee", fields: [{ name: "name", type: "text", required: true }, { name: "role", type: "text", required: false }] }],
  });
  assert.deepEqual(
    detectLikelyEntityRenames(current, candidate),
    [],
    "TeamMember isn't dropped and Employee isn't new -- mergeRefinedSpec now folds them together, so there is nothing here to warn about",
  );
});

test("detectLikelyEntityRenames flags an entity the candidate dropped paired with a brand-new one sharing the exact same field names", () => {
  const current = baseSpec({
    entities: [
      { name: "Customer", label: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "email", type: "text", required: false }] },
    ],
  });
  const candidate = baseSpec({
    entities: [
      { name: "Client", label: "Client", fields: [{ name: "email", type: "text", required: false }, { name: "name", type: "text", required: true }] },
    ],
  });
  assert.deepEqual(detectLikelyEntityRenames(current, candidate), [{ from: "Customer", to: "Client" }]);
});

test("detectLikelyEntityRenames finds nothing when the candidate genuinely just adds a new, unrelated entity (current survives untouched)", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({
    entities: [
      { name: "Customer", fields: [{ name: "name", type: "text", required: true }] },
      { name: "Invoice", fields: [{ name: "amount", type: "number", required: true }] },
    ],
  });
  assert.deepEqual(detectLikelyEntityRenames(current, candidate), []);
});

test("detectLikelyEntityRenames finds nothing for a dropped entity whose field names don't match any added entity's", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({ entities: [{ name: "Vendor", fields: [{ name: "contactPerson", type: "text", required: true }] }] });
  assert.deepEqual(detectLikelyEntityRenames(current, candidate), []);
});

test("detectLikelyEntityRenames never matches two unrelated entities that both happen to have zero fields", () => {
  const current = baseSpec({ entities: [{ name: "Dashboard", fields: [] }] });
  const candidate = baseSpec({ entities: [{ name: "Overview", fields: [] }] });
  assert.deepEqual(detectLikelyEntityRenames(current, candidate), []);
});

test("detectLikelyEntityRenames is a no-op when nothing was dropped or added (a pure field-level refine)", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({
    entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }, { name: "phone", type: "text", required: false }] }],
  });
  assert.deepEqual(detectLikelyEntityRenames(current, candidate), []);
});

/**
 * Round 1825: the field-level analog of detectLikelyEntityRenames above --
 * mergeRefinedSpec's own per-entity field loop has the exact same
 * "candidate only adds, current survives" limitation one level down, inside
 * an entity that itself matched and survives the merge.
 */
test("detectLikelyFieldRenames flags a field the candidate dropped paired with a brand-new same-type field on the same surviving entity", () => {
  const current = baseSpec({
    entities: [
      {
        name: "Ticket",
        label: "Ticket",
        fields: [{ name: "subject", type: "text", required: true }, { name: "priority", label: "Priority", type: "enum", required: false, enumValues: ["Low", "High"] }],
      },
    ],
  });
  const candidate = baseSpec({
    entities: [
      {
        name: "Ticket",
        label: "Ticket",
        fields: [{ name: "subject", type: "text", required: true }, { name: "urgencyLevel", label: "Urgency Level", type: "enum", required: false, enumValues: ["Low", "High"] }],
      },
    ],
  });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), [{ entity: "Ticket", from: "Priority", to: "Urgency Level" }]);
});

test("detectLikelyFieldRenames finds nothing when the candidate genuinely just adds a new, unrelated field (current field survives untouched)", () => {
  const current = baseSpec({ entities: [{ name: "Ticket", fields: [{ name: "subject", type: "text", required: true }] }] });
  const candidate = baseSpec({
    entities: [{ name: "Ticket", fields: [{ name: "subject", type: "text", required: true }, { name: "assignee", type: "text", required: false }] }],
  });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), []);
});

test("detectLikelyFieldRenames finds nothing when the dropped and added fields have different types", () => {
  const current = baseSpec({ entities: [{ name: "Ticket", fields: [{ name: "priority", type: "enum", required: false, enumValues: ["Low", "High"] }] }] });
  const candidate = baseSpec({ entities: [{ name: "Ticket", fields: [{ name: "urgencyLevel", type: "number", required: false }] }] });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), []);
});

test("detectLikelyFieldRenames finds nothing for a relation field repointed to a different entity -- that's computeImpact's own retargetedFields shape, not a rename", () => {
  const current = baseSpec({ entities: [{ name: "Ticket", fields: [{ name: "owner", type: "relation", relationTo: "Agent", required: false }] }] });
  const candidate = baseSpec({ entities: [{ name: "Ticket", fields: [{ name: "handler", type: "relation", relationTo: "Team", required: false }] }] });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), []);
});

test("detectLikelyFieldRenames is a no-op when the candidate entity doesn't exist in current (that's detectLikelyEntityRenames's own job, not this function's)", () => {
  const current = baseSpec({ entities: [{ name: "Customer", fields: [{ name: "name", type: "text", required: true }] }] });
  const candidate = baseSpec({ entities: [{ name: "Client", fields: [{ name: "fullName", type: "text", required: true }] }] });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), []);
});

test("detectLikelyFieldRenames stays silent when more than one field is dropped/added at once -- too ambiguous to pair confidently", () => {
  const current = baseSpec({
    entities: [{ name: "Ticket", fields: [{ name: "priority", type: "enum", required: false, enumValues: ["Low", "High"] }, { name: "status", type: "enum", required: false, enumValues: ["Open", "Closed"] }] }],
  });
  const candidate = baseSpec({
    entities: [{ name: "Ticket", fields: [{ name: "urgencyLevel", type: "enum", required: false, enumValues: ["Low", "High"] }, { name: "state", type: "enum", required: false, enumValues: ["Open", "Closed"] }] }],
  });
  assert.deepEqual(detectLikelyFieldRenames(current, candidate), []);
});
