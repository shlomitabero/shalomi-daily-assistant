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
 * Round 1751: targetEmail used to fall back to the raw internal userId
 * string (CollaboratorsPanel.tsx's accessChangesForReport) when the
 * target isn't in either current list -- which is the normal case for a
 * "removed" entry, since removeCollaborator hard-deletes the row the
 * caller's email lookup is built from. A real downloaded/copied report
 * would then leak a bare database id into human-facing text instead of
 * naming the removed person, for the single most common case this log
 * entry exists to describe. Mirrors changedByEmail's own existing
 * null-fallback to "Unknown" one line below it.
 */
test("formatCollaboratorsReport falls back to the unknown-actor translation when a removed entry's targetEmail is null, instead of leaking a raw userId", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "removed",
      targetEmail: null,
      changedByEmail: "owner@example.com",
      previousRole: "editor",
      newRole: null,
      changedAt: "2024-02-02T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Unknown was removed from the project by owner@example.com"));
  assert.ok(!result.includes("undefined"), "must never render the literal string 'undefined'");
});

/**
 * Round 1654: the sibling action to role_changed/removed above --
 * ownership transfer was the one access-change action round 1636's own
 * sweep missed, despite being the single biggest access-change action in
 * the file (round 1255's own doc comment).
 */
test("formatCollaboratorsReport renders an ownership-transferred entry in the access-changes section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "ownership_transferred",
      targetEmail: "dana@example.com",
      changedByEmail: "owner@example.com",
      previousRole: "editor",
      newRole: null,
      changedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Recent access changes:"));
  assert.ok(result.includes("Ownership of the project was transferred to dana@example.com by owner@example.com"));
});

/**
 * Round 1781: the other half of the same ownership-transfer handoff --
 * the previous owner's own standing dropping from unrestricted "owner" to
 * a capped "editor" collaborator -- previously left no trace at all.
 * Without its own branch, this would fall into roleChangedEntry's "from
 * {previousRole} to {newRole}" text with a blank "from", since "owner"
 * isn't a representable CollaboratorRole (previousRole is always null
 * for this action).
 */
test("formatCollaboratorsReport renders a previous-owner-demoted entry distinctly, not with roleChangedEntry's blank-from text", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "previous_owner_demoted",
      targetEmail: "owner@example.com",
      changedByEmail: "owner@example.com",
      previousRole: null,
      newRole: "editor",
      changedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Recent access changes:"));
  assert.ok(result.includes("owner@example.com, the previous owner, was changed to Editor (full access) access on"));
  assert.ok(!result.includes("'s role was changed from"), "must not fall into role_changed's own text with a blank 'from'");
});

/**
 * Round 1665: "invited" is the one sibling action in this exact family
 * (role_changed/removed round 1636, ownership_transferred round 1654) that
 * never got its own report entry -- without its own explicit branch in
 * formatCollaboratorsReport's if/else-if chain, an "invited" entry would
 * silently fall into the final `else` and render with removedEntry's own
 * text ("X was removed from the project"), the exact opposite of what
 * happened.
 */
test("formatCollaboratorsReport renders an invited entry in the access-changes section, not misclassified as a removal", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [
    {
      action: "invited",
      targetEmail: "dana@example.com",
      changedByEmail: "owner@example.com",
      previousRole: null,
      newRole: "editor",
      changedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Recent access changes:"));
  assert.ok(result.includes("dana@example.com was invited to the project with Editor (full access) access by owner@example.com"));
  assert.ok(!result.includes("was removed from the project"), "an invite must never render with the removal entry's text");
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

/**
 * Round 1775: the schema-label-edits section's 3 new role branches --
 * without their own explicit branches, a role_added/role_removed entry
 * would fall into entity_renamed's text (wrong direction: it would claim
 * a rename that never happened) and role_renamed would fall into
 * field_renamed's text (wrong: it would claim a field was involved).
 */
test("formatCollaboratorsReport renders role_added/role_removed/role_renamed entries with their own distinct text, not the entity/field-rename text", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [
    { action: "role_added", entityName: "Roles", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "", newLabel: "Supervisor", changedAt: "2024-02-01T10:00:00.000Z" },
    { action: "role_removed", entityName: "Roles", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Intern", newLabel: "", changedAt: "2024-02-02T10:00:00.000Z" },
    { action: "role_renamed", entityName: "Roles", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Staff", newLabel: "Lead", changedAt: "2024-02-03T10:00:00.000Z" },
  ]);
  assert.ok(result.includes('The role "Supervisor" was added by owner@example.com'));
  assert.ok(result.includes('The role "Intern" was removed by owner@example.com'));
  assert.ok(result.includes('A role\'s name was changed from "Staff" to "Lead" by owner@example.com'));
});

/**
 * Round 1776: the identical extension round 1775 did for roles, now for
 * assumptions and personas -- without their own explicit branches, an
 * assumption/persona entry would fall through to a wrong sibling branch
 * (persona_renamed's own text is the catch-all `else`, so an
 * assumption_added/assumption_removed/assumption_renamed/persona_added/
 * persona_removed entry would wrongly render as if a persona had been
 * renamed) rather than its own distinct text.
 */
test("formatCollaboratorsReport renders assumption_added/assumption_removed/assumption_renamed/persona_added/persona_removed/persona_renamed entries with their own distinct text", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [
    { action: "assumption_added", entityName: "Assumptions", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "", newLabel: "Users have internet access", changedAt: "2024-02-01T10:00:00.000Z" },
    { action: "assumption_removed", entityName: "Assumptions", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Users pay monthly", newLabel: "", changedAt: "2024-02-02T10:00:00.000Z" },
    { action: "assumption_renamed", entityName: "Assumptions", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Fast internet", newLabel: "Stable internet", changedAt: "2024-02-03T10:00:00.000Z" },
    { action: "persona_added", entityName: "Personas", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "", newLabel: "Busy manager", changedAt: "2024-02-04T10:00:00.000Z" },
    { action: "persona_removed", entityName: "Personas", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Intern", newLabel: "", changedAt: "2024-02-05T10:00:00.000Z" },
    { action: "persona_renamed", entityName: "Personas", fieldName: null, changedByEmail: "owner@example.com", previousLabel: "Manager", newLabel: "Director", changedAt: "2024-02-06T10:00:00.000Z" },
  ]);
  assert.ok(result.includes('The assumption "Users have internet access" was added by owner@example.com'));
  assert.ok(result.includes('The assumption "Users pay monthly" was removed by owner@example.com'));
  assert.ok(result.includes('An assumption was changed from "Fast internet" to "Stable internet" by owner@example.com'));
  assert.ok(result.includes('The persona "Busy manager" was added by owner@example.com'));
  assert.ok(result.includes('The persona "Intern" was removed by owner@example.com'));
  assert.ok(result.includes('A persona was changed from "Manager" to "Director" by owner@example.com'));
});

/**
 * Round 1666: the sibling report section to schemaLabelEdits above, for
 * automation-rule deletions -- the one action in the automation-rule
 * audit-trail family (createdByUserId/updatedByUserId, round 1664) that
 * still had no trail at all.
 */
test("formatCollaboratorsReport includes an automation-rule-deletions section listing a deleted rule's entity/trigger/action, but omits the section entirely when there are none", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const withoutDeletions = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [], []);
  assert.ok(!withoutDeletions.includes("Deleted automation rules:"), "the section must not appear at all when there are no automation-rule deletions");

  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [], [
    {
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      deletedByEmail: "owner@example.com",
      deletedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("Deleted automation rules:"));
  assert.ok(result.includes("An automation rule for \"Customer\" (When a new record is created, Send a WhatsApp message) was deleted by owner@example.com"));
});

test("formatCollaboratorsReport in Hebrew renders the automation-rule-deletions section", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("he", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "he", t, [], [], [], [
    {
      entityName: "Customer",
      trigger: "record_created",
      actionType: "webhook",
      deletedByEmail: "owner@example.com",
      deletedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("חוקי אוטומציה שנמחקו:"));
});

test("formatCollaboratorsReport falls back to the unknown-actor translation when an automation-rule-deletion's deletedByEmail is null", () => {
  const t = (key: string, params?: Record<string, string | number>) => translate("en", key, params);
  const result = formatCollaboratorsReport(owner, [], "CRM", "en", t, [], [], [], [
    {
      entityName: "Customer",
      trigger: "record_created",
      actionType: "send_whatsapp",
      deletedByEmail: null,
      deletedAt: "2024-02-03T10:00:00.000Z",
    },
  ]);
  assert.ok(result.includes("by Unknown"));
});
