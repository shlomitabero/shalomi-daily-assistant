# Integrations

Every source implements one interface (`supabase/functions/_shared/integrations/types.ts`):

```ts
fetchMetrics(ctx, period) → { rows: NormalizedRow[] }   // pull
parseReport(csvText, period, config) → NormalizedRow[]  // uploaded export
```

`NormalizedRow = { period, metricId? | externalKey?, employeeExternalId?, employeeName?, value }`.
Everything after that is shared (`ingest.ts`): metric resolution through
`metric_source_map`, the authoritative-source check, employee matching
(external id → payroll id → phone → exact full name → names mapped earlier),
parking unmatched rows for the mapping screen, writing results, the sync log
and recalculation.

| System | Pull | Report upload | Status |
|---|---|---|---|
| Tabit | config-driven REST (endpoints are `TODO` placeholders) | ✅ per-waiter report | waiting for partner credentials |
| CSV | — | ✅ import wizard | works now |
| Webhook | push, HMAC-signed | — | works now |
| Beecomm, cost (Restigo/MarketMan), payroll (Michpal/Hilan), PBX (Voicenter/3CX), surveys | config-driven REST | ✅ | stubs: work once a vendor endpoint + key are entered |

## Authoritative source per metric

`metric_source_map` holds one source per metric (e.g. `revenue → tabit / net_sales`).
Automatic sources (cron, webhook) may only write metrics mapped to them, so the
PBX can never overwrite revenue. CSV import and manual entry are admin
actions and may write any metric.

## Config-driven REST client (`rest.ts`)

Set on the integration screen as JSON — no code change for a new vendor:

```json
{
  "base_url": "https://api.vendor.example",
  "auth": { "type": "header", "name": "X-Api-Key" },
  "requests": [{
    "path": "/reports/kpi",
    "query": { "from": "{{period_start}}", "to": "{{period_end}}" },
    "rows_path": "data.items",
    "fields": { "employee_id": "agent.id", "employee_name": "agent.name", "metric_key": "kpi", "value": "value" }
  }]
}
```

`auth.type`: `bearer` (default) | `header` | `query` | `none`. The key itself
goes in the **API key** field and is stored in Supabase Vault — config JSON
that looks like it contains a key is rejected. Placeholders:
`{{period}} {{period_start}} {{period_end}} {{year}} {{month}}`. HTTPS only.

## Tabit

Tabit has no public API; access comes through their partner program. Nothing
about their API is assumed: every endpoint in `TABIT_DEFAULT_CONFIG`
(`tabit.ts`) is a `TODO(tabit-partner-docs)` placeholder, and the adapter
reports "not ready" until real values are entered. When the docs arrive:

1. Integration screen → Tabit → mode **API שותפים**.
2. Fill `base_url`, `auth`, `requests` from the partner docs.
3. Save the key in the **API key** field.
4. Set status **פעיל** and the frequency.

Until then, upload Tabit's monthly per-waiter report on the same screen. The
column names are in `config.report`; columns listed in `branch_totals` are
summed into branch-level results (promotions, revenue).

## Webhook

```
POST {SUPABASE_URL}/functions/v1/zozobra/webhook?integration=<id>
X-Zozobra-Timestamp: <unix seconds>
X-Zozobra-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
Content-Type: application/json

{ "period": "2027-01",
  "rows": [ { "metric": "upsell", "employee_id": "W-101", "value": 12 },
            { "metric": "answer_rate", "value": 93.4 } ] }
```

- `metric` is our metric id or the source's key from `metric_source_map`.
- Rejected: missing or bad signature (401), timestamp older than 5 minutes
  (401), the same signature twice (409), body over 1 MB (413), more than
  5000 rows (400).
- The integration's `act_as` setting says which system the data counts as
  (e.g. a PBX vendor pushing through the webhook uses `act_as: "pbx"`).
- Response: `{ received, written, unmatched, rejected, issues[] }`.

Node example:

```js
const ts = Math.floor(Date.now() / 1000);
const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
```

## Schedules

pg_cron calls `zozobra/dispatch` every 15 minutes. It runs each active (or
errored) integration whose frequency is due: every 15 minutes, hourly, or
daily at 05:00 Israel time. During the first 3 days of a month it also pulls
the previous month, to catch late data. Each run is in `sync_log` and on the
"יומן סנכרון" screen.
