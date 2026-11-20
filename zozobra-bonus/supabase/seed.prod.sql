-- PRODUCTION seed: branch, metrics, role eligibility, January 2027 targets
-- (prototype numbers), integrations and source map. No demo people.
-- The owner row is added by scripts/setup-production.sql with the real phone.
insert into public.branches (id, name, city) values
  ('00000000-0000-4000-8000-000000000001', 'ZOZOBRA חוצות המפרץ', 'חיפה');

insert into public.metrics (id, name, description, scope, direction, default_source, unit, manager_editable, sort_order) values
  ('survey',  'סקרי שביעות רצון', 'ממוצע דירוג לקוחות (1–5)',        'employee', 'higher', 'survey', 'ציון', true,  1),
  ('service', 'שירות', 'ציון מנהל / לקוח סמוי (0–100)',                   'employee', 'higher', 'manual', 'ציון', true,  2),
  ('food',    'עמידה ביעד פוד קוסט', 'עלות מזון מתוך מחזור',      'branch',   'lower',  'cost',   '%',    false, 3),
  ('labor',   'עמידה ביעד ליבור קוסט', 'עלות שכר מתוך מחזור',    'branch',   'lower',  'payroll','%',    false, 4),
  ('upsell',  'הגדלת מכירות על מוצר', 'מוצר החודש: Dragon Roll · יחידות',     'employee', 'higher', 'tabit',  'יח׳',  false, 5),
  ('promo',   'הגדלת יעדי מבצעים', 'מימושי מבצע Happy Hour בסניף',        'branch',   'higher', 'tabit',  'יח׳',  false, 6),
  ('revenue', 'הגעה ליעד מחזור', 'מחזור חודשי לפני מע״מ',          'branch',   'higher', 'tabit',  '₪',    false, 7),
  ('answer',  'מרכז שירות – אחוז מענה', 'שיחות שנענו מתוך נכנסות',   'branch',   'higher', 'pbx',    '%',    false, 8),
  ('phone',   'שירות בטלפון', 'ציון בקרת איכות שיחות (0–100)',             'employee', 'higher', 'pbx',    'ציון', true,  9);

insert into public.role_metrics (job_role, metric_id) values
  ('waiter','survey'),('waiter','service'),('waiter','upsell'),('waiter','promo'),('waiter','revenue'),
  ('bartender','survey'),('bartender','service'),('bartender','upsell'),('bartender','promo'),('bartender','revenue'),
  ('cook','food'),('cook','revenue'),
  ('chef','food'),('chef','labor'),('chef','revenue'),
  ('shift_manager','survey'),('shift_manager','service'),('shift_manager','food'),
  ('shift_manager','labor'),('shift_manager','promo'),('shift_manager','revenue'),
  ('call_center','answer'),('call_center','phone'),('call_center','revenue');

-- January 2027 targets — numbers from the approved prototype. Amounts in agorot (40000 = ₪400).
with t (metric_id, target, threshold_pct, max_amount) as (values
  ('survey', 4.6, 92, 40000), ('service', 90, 90, 30000), ('food', 28, 90, 50000), ('labor', 30, 90, 50000),
  ('upsell', 60, 75, 25000), ('promo', 900, 80, 25000), ('revenue', 1200000, 90, 60000),
  ('answer', 95, 90, 35000), ('phone', 90, 90, 30000))
insert into public.metric_targets (branch_id, metric_id, period, target, threshold_pct, max_amount)
select '00000000-0000-4000-8000-000000000001', metric_id, '2027-01-01', target, threshold_pct, max_amount from t;

insert into public.integrations (branch_id, system, display_name, status, frequency, config) values
  ('00000000-0000-4000-8000-000000000001','tabit',   'Tabit — קופה',               'awaiting_credentials','hourly',
     '{"mode":"csv_report","base_url":"TODO: from Tabit partner docs","site_id":"TODO"}'),
  ('00000000-0000-4000-8000-000000000001','csv',     'ייבוא CSV',                  'active','manual','{}'),
  ('00000000-0000-4000-8000-000000000001','webhook', 'Webhook כללי',               'not_configured','manual','{}'),
  ('00000000-0000-4000-8000-000000000001','beecomm', 'Beecomm',                    'not_configured','manual','{}'),
  ('00000000-0000-4000-8000-000000000001','cost',    'מערכת עלויות (Restigo/MarketMan)','not_configured','daily_0500','{}'),
  ('00000000-0000-4000-8000-000000000001','payroll', 'שכר ונוכחות (מיכפל/חילן)',   'not_configured','daily_0500','{}'),
  ('00000000-0000-4000-8000-000000000001','pbx',     'מרכזיה (Voicenter/3CX)',     'not_configured','hourly','{}'),
  ('00000000-0000-4000-8000-000000000001','survey',  'מערכת סקרים',                'not_configured','daily_0500','{}');

insert into public.metric_source_map (branch_id, metric_id, system, external_key) values
  ('00000000-0000-4000-8000-000000000001','survey', 'survey', 'csat_avg'),
  ('00000000-0000-4000-8000-000000000001','service','manual', 'service'),
  ('00000000-0000-4000-8000-000000000001','food',   'cost',   'food_cost_pct'),
  ('00000000-0000-4000-8000-000000000001','labor',  'payroll','labor_cost_pct'),
  ('00000000-0000-4000-8000-000000000001','upsell', 'tabit',  'upsell_qty'),
  ('00000000-0000-4000-8000-000000000001','promo',  'tabit',  'promo_qty'),
  ('00000000-0000-4000-8000-000000000001','revenue','tabit',  'net_sales'),
  ('00000000-0000-4000-8000-000000000001','answer', 'pbx',    'answer_rate'),
  ('00000000-0000-4000-8000-000000000001','phone',  'pbx',    'qa_score');
