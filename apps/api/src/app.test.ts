import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const db = createStore(":memory:");
  const app = createApp(db);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("health check responds ok", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("full acceptance flow: idea -> spec -> build -> CRUD", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description:
          "Build an appointment-management application for a beauty clinic. I need customers, appointments, employees, services, an admin dashboard and automatic appointment status tracking.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { project: { id: string; spec: { entities: { name: string }[] } }; providerName: string };
    assert.equal(created.providerName, "heuristic");
    const projectId = created.project.id;
    const entityNames = created.project.spec.entities.map((e) => e.name).sort();
    assert.deepEqual(entityNames, ["Appointment", "Customer", "Employee", "Service"]);

    // Before build, entity data endpoints must refuse.
    const beforeBuild = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`);
    assert.equal(beforeBuild.status, 409);

    const buildRes = await fetch(`${baseUrl}/api/projects/${projectId}/build`, { method: "POST" });
    assert.equal(buildRes.status, 200);
    const built = (await buildRes.json()) as { project: { status: string } };
    assert.equal(built.project.status, "built");

    // Create a customer record through the generic CRUD API.
    const createRecordRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dana Levi", email: "dana@example.com", status: "New" }),
    });
    assert.equal(createRecordRes.status, 201);
    const { record } = (await createRecordRes.json()) as { record: { id: number; name: string } };
    assert.equal(record.name, "Dana Levi");

    const listRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`);
    const { records } = (await listRes.json()) as { records: { id: number }[] };
    assert.equal(records.length, 1);

    const updateRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Won" }),
    });
    assert.equal(updateRes.status, 200);
    const { record: updated } = (await updateRes.json()) as { record: { status: string } };
    assert.equal(updated.status, "Won");

    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer/${record.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteRes.status, 204);

    const listAfterDelete = await fetch(`${baseUrl}/api/projects/${projectId}/entities/Customer`);
    const { records: recordsAfterDelete } = (await listAfterDelete.json()) as { records: unknown[] };
    assert.equal(recordsAfterDelete.length, 0);
  });
});

test("returns 400 for an empty description", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    assert.equal(res.status, 400);
  });
});

test("returns 404 for an unknown project", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/projects/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test("rejects an insert missing a required field with 400", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "A CRM with customers and deals." }),
    });
    const { project } = (await createRes.json()) as { project: { id: string } };
    await fetch(`${baseUrl}/api/projects/${project.id}/build`, { method: "POST" });

    const badInsert = await fetch(`${baseUrl}/api/projects/${project.id}/entities/Customer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "no-name@example.com" }),
    });
    assert.equal(badInsert.status, 400);
  });
});
