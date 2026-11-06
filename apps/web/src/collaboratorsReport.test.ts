import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectCollaborator } from "@forge/shared";
import type { ProjectOwnerInfo } from "./api.js";
import { formatCollaboratorsReport } from "./collaboratorsReport.js";
import { translate } from "./i18n/language.js";

const owner: ProjectOwnerInfo = { userId: "owner1", email: "owner@example.com" };

function makeCollaborator(overrides: Partial<ProjectCollaborator> = {}): ProjectCollaborator {
  return {
    userId: "collab1",
    email: "collab@example.com",
    addedAt: "2024-01-15T08:30:00.000Z",
    role: "editor",
    ...overrides,
  };
}

/**
 * Round 1190: before this round, the "no collaborators" line only printed
 * when `!owner && collaborators.length === 0` -- but CollaboratorsPanel.tsx
 * only ever renders the Copy/Download buttons that call this function once
 * `owner` is truthy (its own gating condition), and `owner` is truthy for
 * every normal project (getOwnerInfo's own doc comment: null only in the
 * should-never-happen case of a dangling owner reference). So this line
 * could never actually appear for the single most common real state --
 * an owner with zero invited collaborators -- even though the on-screen
 * panel's own identical-purpose empty check is gated only on
 * `collaborators.length === 0`, independent of owner.
 */
test("formatCollaboratorsReport includes the 'no collaborators' line for a project with an owner and zero invited collaborators, matching the on-screen panel's own empty-state condition", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t);
  assert.ok(
    result.includes("No collaborators yet."),
    "the report must show the same empty-state message the on-screen panel always shows for this state",
  );
  assert.ok(result.includes("owner@example.com"), "the owner line must still be present");
});

test("formatCollaboratorsReport in Hebrew includes the Hebrew 'no collaborators' line for a project with an owner and zero invited collaborators", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "he", t);
  assert.ok(result.includes("עדיין אין שותפים לפרויקט הזה."));
});

test("formatCollaboratorsReport does not show the 'no collaborators' line once a real collaborator exists, and lists their email and role", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [makeCollaborator({ email: "dana@example.com", role: "viewer" })], "CRM", "en", t);
  assert.ok(!result.includes("No collaborators yet."), "the empty-state line must not appear once a real collaborator exists");
  assert.ok(result.includes("dana@example.com"));
});

/**
 * Round 1636: the sibling report section to recordDeletions above, for
 * collaborator role changes/removal -- docs/security.md's own "Section
 * 40" note named this as the one gap left in this audit-trail family.
 */
test("formatCollaboratorsReport includes an access-changes section listing a role change and a removal, each with the actor and date, but omits the section entirely when there are none", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const withoutChanges = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], []);
  assert.ok(!withoutChanges.includes("Recent access changes:"), "the section must not appear at all when there are no access changes");

  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "role_changed",
      targetEmail: "dana@example.com",
      changedByEmail: "owner@example.com",
      previousRole: "editor",
      newRole: "viewer",
      changedAt: "2024-02-01T10:00:00.000Z",
    },
    {
      action: "removed",
      targetEmail: "yossi@example.com",
      changedByEmail: "owner@example.com",
      previousRole: "editor",
      newRole: null,
      changedAt: "2024-02-02T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Recent access changes:"));
  assert.ok(result.includes("dana@example.com's role was changed from Editor (full access) to Viewer (read-only) by owner@example.com"));
  assert.ok(result.includes("yossi@example.com was removed from the project by owner@example.com"));
});

test("formatCollaboratorsReport in Hebrew renders the access-changes section with translated role labels", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "he", t, [], [
    {
      action: "role_changed",
      targetEmail: "dana@example.com",
      changedByEmail: "owner@example.com",
      previousRole: "editor",
      newRole: "viewer",
      changedAt: "2024-02-01T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("שינויי הרשאות אחרונים:"));
  assert.ok(result.includes("עורך/ת (גישה מלאה)"));
  assert.ok(result.includes("צפייה בלבד"));
});

test("formatCollaboratorsReport falls back to the unknown-actor translation when changedByEmail is null", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "removed",
      targetEmail: "yossi@example.com",
      changedByEmail: null,
      previousRole: "editor",
      newRole: null,
      changedAt: "2024-02-02T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("yossi@example.com was removed from the project by Unknown"));
});

/**
 * Round 1639: the sibling report section to accessChanges above, for
 * entity/field label renames -- docs/security.md's own "Section 40" note
 * still named this as the one sub-gap this audit-trail family left open.
 */
test("formatCollaboratorsReport includes a schema-label-edits section listing an entity rename and a field rename, each with the actor and date, but omits the section entirely when there are none", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const withoutEdits = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], []);
  assert.ok(!withoutEdits.includes("Recent display-name changes:"), "the section must not appear at all when there are no schema label edits");

  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [
    {
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      changedByEmail: "owner@example.com",
      previousLabel: "Customers",
      newLabel: "Clients",
      changedAt: "2024-02-01T10:00:00.000Z",
    },
    {
      action: "field_renamed",
      entityName: "Customer",
      fieldName: "phone",
      changedByEmail: "dana@example.com",
      previousLabel: "Phone",
      newLabel: "Mobile",
      changedAt: "2024-02-02T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Recent display-name changes:"));
  assert.ok(result.includes("\"Customer\"'s display name was changed from \"Customers\" to \"Clients\" by owner@example.com"));
  assert.ok(result.includes("\"phone\" field's display name on \"Customer\" was changed from \"Phone\" to \"Mobile\" by dana@example.com"));
});

test("formatCollaboratorsReport in Hebrew renders the schema-label-edits section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "he", t, [], [], [
    {
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      changedByEmail: "owner@example.com",
      previousLabel: "Customers",
      newLabel: "Clients",
      changedAt: "2024-02-01T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("שינויי שמות תצוגה אחרונים:"));
});

test("formatCollaboratorsReport falls back to the unknown-actor translation when a schema label edit's changedByEmail is null", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [
    {
      action: "entity_renamed",
      entityName: "Customer",
      fieldName: null,
      changedByEmail: null,
      previousLabel: "Customers",
      newLabel: "Clients",
      changedAt: "2024-02-01T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("by Unknown"));
});
