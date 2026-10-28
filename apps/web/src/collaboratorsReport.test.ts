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
