import { describe, expect, it } from "vitest";
import { isDue, periodsToSync } from "./sync.ts";
import { parseReport } from "./integrations/report.ts";
import { TABIT_DEFAULT_CONFIG, tabitAdapter } from "./integrations/tabit.ts";
import { restFetch, restReadiness, template } from "./integrations/rest.ts";
import { parseWebhookPayload, signPayload, verifySignature } from "./integrations/webhook.ts";
import { AdapterNotReadyError } from "./integrations/types.ts";

describe("isDue", () => {
  const now = new Date("2027-01-15T10:00:00Z"); // 12:00 Israel
  it("manual never runs", () => expect(isDue("manual", null, now)).toBe(false));
  it("15 min", () => {
    expect(isDue("every_15_min", "2027-01-15T09:50:00Z", now)).toBe(false);
    expect(isDue("every_15_min", "2027-01-15T09:45:00Z", now)).toBe(true);
    expect(isDue("every_15_min", null, now)).toBe(true);
  });
  it("hourly", () => {
    expect(isDue("hourly", "2027-01-15T09:30:00Z", now)).toBe(false);
    expect(isDue("hourly", "2027-01-15T09:00:00Z", now)).toBe(true);
  });
  it("daily at 05:00 Israel time", () => {
    // 02:00 UTC = 04:00 Israel (winter) → not yet
    expect(isDue("daily_0500", "2027-01-14T03:00:00Z", new Date("2027-01-15T02:00:00Z"))).toBe(false);
    // 03:05 UTC = 05:05 Israel → due, last ran yesterday
    expect(isDue("daily_0500", "2027-01-14T03:00:00Z", new Date("2027-01-15T03:05:00Z"))).toBe(true);
    // already ran today after 05:00
    expect(isDue("daily_0500", "2027-01-15T03:05:00Z", new Date("2027-01-15T10:00:00Z"))).toBe(false);
    // summer time: 02:05 UTC = 05:05 Israel (UTC+3)
    expect(isDue("daily_0500", "2027-07-14T02:10:00Z", new Date("2027-07-15T02:05:00Z"))).toBe(true);
  });
});

describe("periodsToSync", () => {
  it("includes last month in the first 3 days", () => {
    expect(periodsToSync(new Date("2027-02-02T10:00:00Z"))).toEqual(["2027-01", "2027-02"]);
    expect(periodsToSync(new Date("2027-02-10T10:00:00Z"))).toEqual(["2027-02"]);
  });
});

describe("Tabit adapter", () => {
  it("does not pretend to have an API: default config is not ready", () => {
    const problems = tabitAdapter.readiness({ ...TABIT_DEFAULT_CONFIG, mode: "api" }, false);
    expect(problems.length).toBeGreaterThan(0);
  });
  it("refuses to pull in report mode", async () => {
    await expect(
      tabitAdapter.fetchMetrics({ integrationId: "i", branchId: "b", config: TABIT_DEFAULT_CONFIG, secret: null, fetch }, "2027-01"),
    ).rejects.toBeInstanceOf(AdapterNotReadyError);
  });
  it("parses the per-waiter report with branch totals and skips summary rows", () => {
    const csv = [
      "מספר מלצר,שם מלצר,פריטי אפסייל,פריטי מבצע,מכירות נטו",
      "W-101,נועה כהן,141,60,\"410,000\"",
      "W-102,איתי מזרחי,110,51,390000",
      'סה"כ,,251,111,800000',
    ].join("\n");
    const rows = tabitAdapter.parseReport!(csv, "2027-01", TABIT_DEFAULT_CONFIG);
    expect(rows).toContainEqual({ period: "2027-01", externalKey: "upsell_qty", employeeExternalId: "W-101", employeeName: "נועה כהן", value: 141 });
    expect(rows).toContainEqual({ period: "2027-01", externalKey: "net_sales", value: 800000 });
    expect(rows).toContainEqual({ period: "2027-01", externalKey: "promo_qty", value: 111 });
    expect(rows.filter((r) => r.externalKey === "upsell_qty")).toHaveLength(2);
  });
  it("reports missing report columns clearly", () => {
    expect(() => parseReport("a,b\n1,2", "2027-01", TABIT_DEFAULT_CONFIG.report)).toThrow(/עמודות חסרות/);
  });
});

describe("REST client", () => {
  const cfg = {
    base_url: "https://api.example.test",
    auth: { type: "header" as const, name: "X-Key" },
    requests: [{
      path: "/kpi",
      query: { from: "{{period_start}}", to: "{{period_end}}" },
      rows_path: "data.items",
      fields: { employee_id: "agent.id", value: "v", metric_key: "k" },
    }],
  };
  it("templates periods", () => expect(template("{{period_start}}..{{period_end}}", "2027-02")).toBe("2027-02-01..2027-02-28"));
  it("requires https and a key", () => {
    expect(restReadiness({ ...cfg, base_url: "http://x" }, true)).toContain("כתובת ה־API חייבת להתחיל ב־https://");
    expect(restReadiness(cfg, false)).toContain("חסר מפתח גישה");
  });
  it("calls the endpoint with auth and maps rows", async () => {
    let seen: { url: string; key: string | null } | null = null;
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), key: new Headers(init.headers).get("X-Key") };
      return new Response(JSON.stringify({ data: { items: [{ agent: { id: "ext-301" }, k: "qa_score", v: "93" }, { agent: {}, k: "answer_rate", v: 91 }] } }));
    }) as unknown as typeof fetch;
    const rows = await restFetch({ integrationId: "i", branchId: "b", config: {}, secret: "s3cret", fetch: fakeFetch }, cfg, "2027-01");
    expect(seen!.url).toBe("https://api.example.test/kpi?from=2027-01-01&to=2027-01-31");
    expect(seen!.key).toBe("s3cret");
    expect(rows).toEqual([
      { period: "2027-01", externalKey: "qa_score", employeeExternalId: "ext-301", employeeName: null, value: 93 },
      { period: "2027-01", externalKey: "answer_rate", employeeExternalId: null, employeeName: null, value: 91 },
    ]);
  });
});

describe("webhook signature", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ period: "2027-01", rows: [{ metric: "answer_rate", value: 93 }] });
  it("accepts a valid signature", async () => {
    const ts = 1_800_000_000;
    const signature = await signPayload(secret, ts, body);
    expect(await verifySignature({ secret, timestamp: String(ts), signature, body, now: ts + 10 })).toEqual({ ok: true });
  });
  it("rejects tampered body, wrong secret, stale or missing headers", async () => {
    const ts = 1_800_000_000;
    const signature = await signPayload(secret, ts, body);
    expect((await verifySignature({ secret, timestamp: String(ts), signature, body: body + " ", now: ts })).ok).toBe(false);
    expect((await verifySignature({ secret: "b".repeat(64), timestamp: String(ts), signature, body, now: ts })).ok).toBe(false);
    expect((await verifySignature({ secret, timestamp: String(ts), signature, body, now: ts + 301 })).ok).toBe(false);
    expect((await verifySignature({ secret, timestamp: null, signature, body })).ok).toBe(false);
  });
  it("validates payload shape", () => {
    expect(parseWebhookPayload({ rows: [{ metric: "x", value: 1 }] })).toHaveProperty("error");
    expect(parseWebhookPayload({ period: "2027-01", rows: [{ metric: "x", value: "nope" }] })).toHaveProperty("error");
    const ok = parseWebhookPayload(JSON.parse(body));
    expect(ok).toEqual({ rows: [{ period: "2027-01", metricId: "answer_rate", externalKey: "answer_rate", employeeExternalId: null, employeeName: null, value: 93 }] });
  });
});
