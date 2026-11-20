// RLS: employees see only their own data; managers enter manual scores only;
// admin-only tables are closed to everyone else; anon sees nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asUser, authUserFor, createTestDatabase } from "./harness";
import { pgStore } from "./pg-store";
import { recalcPeriod } from "@shared/recalc.ts";

const BRANCH = "00000000-0000-4000-8000-000000000001";
const E = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ADMIN = E(1), MANAGER = E(2), NOA = E(3), ITAI = E(4), YOSSI = E(8);

let pool: pg.Pool;
const uid: Record<string, string> = {};

beforeAll(async () => {
  pool = await createTestDatabase("zozobra_rls_test");
  for (const [k, phone] of [
    ["admin", "972500000001"], ["manager", "972500000002"], ["noa", "972500000003"],
    ["itai", "972500000004"], ["yossi", "972500000008"], ["stranger", "972599999999"],
  ]) uid[k] = await authUserFor(pool, phone);
  await recalcPeriod(pgStore(pool), BRANCH, "2027-01");
});
afterAll(async () => pool?.end());

describe("login linking", () => {
  it("links an auth user to the employee with the same phone", async () => {
    const r = await pool.query(`select auth_user_id from employees where id=$1`, [NOA]);
    expect(r.rows[0].auth_user_id).toBe(uid.noa);
  });
  it("an unknown phone gets no employee and sees nothing", async () => {
    await asUser(pool, uid.stranger, async (q) => {
      expect((await q(`select * from employees`)).rowCount).toBe(0);
      expect((await q(`select * from metric_results`)).rowCount).toBe(0);
      expect((await q(`select * from bonus_payouts`)).rowCount).toBe(0);
      expect((await q(`select * from metric_targets`)).rowCount).toBe(0);
    });
  });
});

describe("employee isolation", () => {
  it("sees only their own employee row", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`select id from employees`);
      expect(r.rows.map((x) => x.id)).toEqual([NOA]);
    });
  });
  it("cannot read another employee's results", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`select employee_id from metric_results where employee_id is not null`);
      expect(r.rowCount).toBeGreaterThan(0);
      expect(new Set(r.rows.map((x) => x.employee_id))).toEqual(new Set([NOA]));
      expect((await q(`select * from metric_results where employee_id=$1`, [ITAI])).rowCount).toBe(0);
    });
  });
  it("sees branch-level results (revenue, food cost)", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`select metric_id from metric_results where employee_id is null`);
      expect(r.rows.map((x) => x.metric_id)).toContain("revenue");
    });
  });
  it("cannot read another employee's payout", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`select employee_id from bonus_payouts`);
      expect(r.rows.map((x) => x.employee_id)).toEqual([NOA]);
      expect((await q(`select * from bonus_payouts where employee_id=$1`, [ITAI])).rowCount).toBe(0);
    });
  });
  it("leaderboard exposes first names only and marks me", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`select * from leaderboard('2027-01-01')`);
      expect(r.rowCount).toBeGreaterThan(3);
      expect(Object.keys(r.rows[0]).sort()).toEqual(["first_name", "is_me", "job_role", "rank", "realization"]);
      expect(r.rows.filter((x) => x.is_me).map((x) => x.first_name)).toEqual(["נועה"]);
      expect(r.rows.some((x) => x.first_name.includes("כהן"))).toBe(false);
    });
  });
  it("cannot write results, targets or payouts", async () => {
    await asUser(pool, uid.noa, async (q) => {
      await expect(q(`insert into metric_results (branch_id, period, metric_id, employee_id, value, source)
        values ($1,'2027-01-01','survey',$2,5,'manual')`, [BRANCH, NOA])).rejects.toThrow(/row-level security/);
      const u = await q(`update metric_targets set target=1`);
      expect(u.rowCount).toBe(0);
      await expect(q(`update bonus_payouts set amount=999999`)).rejects.toThrow(/permission denied/);
      const s = await q(`update bonus_payouts set status='approved'`);
      expect(s.rowCount).toBe(0);
    });
  });
  it("cannot change their own role", async () => {
    await asUser(pool, uid.noa, async (q) => {
      const r = await q(`update employees set app_role='admin' where id=$1`, [NOA]);
      expect(r.rowCount).toBe(0);
    });
  });
  it("cannot read admin tables", async () => {
    await asUser(pool, uid.noa, async (q) => {
      for (const t of ["integrations", "sync_log", "audit_log", "unmatched_rows", "employee_external_ids", "metric_source_map"]) {
        expect((await q(`select * from ${t}`)).rowCount, t).toBe(0);
      }
    });
  });
  it("cannot read secrets", async () => {
    await asUser(pool, uid.noa, async (q) => {
      await expect(q(`select integration_secret(id) from integrations`)).rejects.toThrow(/permission denied/);
      await expect(q(`select * from vault.decrypted_secrets`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe("shift manager", () => {
  it("can see branch employees and enter a manual service score", async () => {
    await asUser(pool, uid.manager, async (q) => {
      expect((await q(`select * from employees`)).rowCount).toBe(12);
      const r = await q(`insert into metric_results (branch_id, period, metric_id, employee_id, value, source)
        values ($1,'2027-01-01','service',$2,93,'manual')
        on conflict (branch_id, period, metric_id, employee_id) do update set value=excluded.value, source='manual'`,
        [BRANCH, ITAI]);
      expect(r.rowCount).toBe(1);
    });
  });
  it("cannot write a system metric (revenue) or a non-manual source", async () => {
    await asUser(pool, uid.manager, async (q) => {
      await expect(q(`update metric_results set value=1 where metric_id='revenue' returning id`))
        .resolves.toMatchObject({ rowCount: 0 });
      await expect(q(`insert into metric_results (branch_id, period, metric_id, employee_id, value, source)
        values ($1,'2027-02-01','service',$2,93,'tabit')`, [BRANCH, ITAI])).rejects.toThrow(/row-level security/);
    });
  });
  it("cannot see other people's payouts or approve", async () => {
    await asUser(pool, uid.manager, async (q) => {
      const r = await q(`select employee_id from bonus_payouts`);
      expect(r.rows.map((x) => x.employee_id)).toEqual([MANAGER]);
    });
  });
});

describe("admin", () => {
  it("sees all payouts, can approve, and cannot edit amounts directly", async () => {
    await asUser(pool, uid.admin, async (q) => {
      expect((await q(`select * from bonus_payouts`)).rowCount).toBe(11);
      const r = await q(`update bonus_payouts set status='approved' where employee_id=$1 returning approved_by`, [NOA]);
      expect(r.rows[0].approved_by).toBe(uid.admin);
      await expect(q(`update bonus_payouts set amount=1`)).rejects.toThrow(/permission denied/);
    });
  });
  it("can store a secret but never read it back", async () => {
    await asUser(pool, uid.admin, async (q) => {
      const [i] = (await q(`select id from integrations where system='tabit'`)).rows;
      await q(`select set_integration_secret($1, 'super-secret-key-123')`, [i.id]);
      const r = await q(`select config::text, secret_id from integrations where id=$1`, [i.id]);
      expect(r.rows[0].secret_id).toBeTruthy();
      expect(r.rows[0].config).not.toContain("super-secret");
      await expect(q(`select integration_secret($1)`, [i.id])).rejects.toThrow(/permission denied/);
    });
  });
  it("cannot demote themself", async () => {
    await asUser(pool, uid.admin, async (q) => {
      await expect(q(`update employees set app_role='employee' where id=$1`, [ADMIN])).rejects.toThrow(/מעצמך/);
    });
  });
});

describe("anon", () => {
  it("has no access at all", async () => {
    await asUser(pool, null, async (q) => {
      await expect(q(`select * from employees`)).rejects.toThrow(/permission denied/);
      await expect(q(`select * from bonus_payouts`)).rejects.toThrow(/permission denied/);
    }, "anon");
  });
});

describe("approval revert rule", () => {
  it("changing a result after approval reverts affected payouts to draft and audits it", async () => {
    await pool.query(`update bonus_payouts set status='approved' where period='2027-01-01'`);
    // branch metric → every eligible employee is affected (revenue: everyone)
    await pool.query(`update metric_results set value=value+1 where metric_id='labor'`);
    const r = await pool.query(`select e.job_role, p.status from bonus_payouts p join employees e on e.id=p.employee_id`);
    for (const row of r.rows) {
      const affected = ["chef", "shift_manager"].includes(row.job_role);
      expect(row.status, row.job_role).toBe(affected ? "draft" : "approved");
    }
    const a = await pool.query(`select count(*)::int n from audit_log where action='payout_reverted_to_draft'`);
    expect(a.rows[0].n).toBe(2); // Yossi (chef) + Maya (shift manager)
    const reasons = await pool.query(`select distinct reason from audit_log where action='payout_reverted_to_draft'`);
    expect(reasons.rows[0].reason).toContain("labor");
  });
  it("an employee-level change only reverts that employee", async () => {
    await pool.query(`update bonus_payouts set status='approved' where status='draft'`);
    await pool.query(`update metric_results set value=4.2 where metric_id='survey' and employee_id=$1`, [ITAI]);
    const r = await pool.query(`select employee_id from bonus_payouts where status='draft'`);
    expect(r.rows.map((x) => x.employee_id)).toEqual([ITAI]);
  });
  it("paid payouts are locked and the change is logged", async () => {
    await pool.query(`update bonus_payouts set status='approved' where employee_id=$1`, [YOSSI]);
    await pool.query(`update bonus_payouts set status='paid' where employee_id=$1`, [YOSSI]);
    await pool.query(`update metric_results set value=value+1 where metric_id='food'`);
    const r = await pool.query(`select status from bonus_payouts where employee_id=$1`, [YOSSI]);
    expect(r.rows[0].status).toBe("paid");
    await expect(pool.query(`update bonus_payouts set amount=1 where employee_id=$1`, [YOSSI])).rejects.toThrow(/נעול/);
    const a = await pool.query(`select count(*)::int n from audit_log where action='changed_after_paid'`);
    expect(a.rows[0].n).toBe(1);
  });
  it("rejects illegal status jumps", async () => {
    await expect(pool.query(`update bonus_payouts set status='paid' where employee_id=$1`, [ITAI]))
      .rejects.toThrow(/מעבר סטטוס/);
  });
});
