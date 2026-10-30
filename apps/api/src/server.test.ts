import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

/**
 * Round 1298: server.ts (this app's own real top-level bootstrap, run on
 * Render per render.yaml) never handled SIGTERM/SIGINT at all -- Render
 * sends SIGTERM on every redeploy, restart, and scale event, an entirely
 * routine occurrence, so the process used to be killed immediately with
 * no drain for in-flight HTTP requests or the automations loop's own
 * setInterval tick. Spawns the real server.ts via tsx (the same way this
 * repo's own "start:dev" script does), waits for it to report itself
 * listening, sends SIGTERM, and confirms the process exits cleanly
 * (code 0) on its own rather than being force-killed by the 10s safety-
 * net timer -- a real end-to-end exercise of the actual bootstrap file,
 * not a reimplementation of its shutdown logic.
 */
test("server.ts exits cleanly on SIGTERM instead of being killed mid-shutdown", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const apiDir = path.resolve(import.meta.dirname, "..");
  const port = 34000 + Math.floor(Math.random() * 5000);

  const child = spawn(tsxBin, ["--experimental-sqlite", "src/server.ts"], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port), DB_PATH: ":memory:" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 10_000;
    let listening = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.ts exited early (code ${child.exitCode}):\n${stderr}`);
      }
      try {
        const res = await fetch(`http://localhost:${port}/api/health`);
        if (res.status < 500) {
          listening = true;
          break;
        }
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(listening, `server.ts never came up:\n${stderr}`);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");

    const { code } = await exitPromise;
    assert.equal(code, 0, `expected a clean exit (code 0) after SIGTERM, not a force-kill by the safety-net timer:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
