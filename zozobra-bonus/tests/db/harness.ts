// Builds a throwaway database from the real migrations + seed on a local
// Postgres, and lets tests run queries as a given Supabase user so RLS is
// exercised exactly as in production.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

pg.types.setTypeParser(1082, (v: string) => v); // DATE as YYYY-MM-DD string

const ROOT = path.resolve(__dirname, "../..");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

export async function createTestDatabase(name: string): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const files = [
    path.join(ROOT, "tests/db/supabase-shim.sql"),
    ...readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => path.join(ROOT, "supabase/migrations", f)),
    path.join(ROOT, "supabase/seed.sql"),
  ];
  for (const f of files) {
    try {
      await pool.query(readFileSync(f, "utf8"));
    } catch (e) {
      throw new Error(`${path.basename(f)}: ${(e as Error).message}`);
    }
  }
  return pool;
}

/** Ensure an auth user exists for this phone (login trigger links the employee). */
export async function authUserFor(pool: pg.Pool, phone: string): Promise<string> {
  const r = await pool.query(
    `insert into auth.users (phone) values ($1)
     on conflict (phone) do update set phone = excluded.phone returning id`,
    [phone],
  );
  return r.rows[0].id;
}

/** Run a function inside a transaction as the given Supabase role/user. Always rolls back. */
export async function asUser<T>(
  pool: pg.Pool,
  userId: string | null,
  fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
  role: "authenticated" | "anon" | "service_role" = "authenticated",
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ]);
    await c.query(`set local role ${role}`);
    // each statement in its own savepoint so an expected error doesn't
    // abort the rest of the test transaction
    let n = 0;
    return await fn(async (sql, params) => {
      const sp = `sp${n++}`;
      await c.query(`savepoint ${sp}`);
      try {
        const r = await c.query(sql, params as unknown[]);
        await c.query(`release savepoint ${sp}`);
        return r;
      } catch (e) {
        await c.query(`rollback to savepoint ${sp}`);
        throw e;
      }
    });
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}
