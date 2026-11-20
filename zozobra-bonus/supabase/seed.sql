-- Seed data: one branch, the 9 metrics, role eligibility, a demo team and
-- January 2027 targets + sample results. Safe to re-run on an empty DB.
-- Demo phones 972500000001..12 — configure them as test numbers with OTP
-- 123456 (supabase/config.toml locally, Auth → Phone → test numbers in prod).

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

insert into public.employees
  (id, branch_id, first_name, last_name, phone, job_role, app_role, payroll_id, tip_based, bonus_eligible, start_date) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','שלומי','טבר','972500000001','shift_manager','admin','1001',false,false,'2026-09-01'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','מאיה','לוי','972500000002','shift_manager','shift_manager','1002',false,true,'2026-11-01'),
  ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','נועה','כהן','972500000003','waiter','employee','1003',true,true,'2026-12-15'),
  ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','איתי','מזרחי','972500000004','waiter','employee','1004',true,true,'2026-12-15'),
  ('10000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','ליה','פרץ','972500000005','waiter','employee','1005',true,true,'2027-01-17'),
  ('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','דניאל','אברהם','972500000006','bartender','employee','1006',true,true,'2026-12-15'),
  ('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','עומר','חדד','972500000007','bartender','employee','1007',true,true,'2026-12-15'),
  ('10000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','יוסי','ביטון','972500000008','chef','employee','1008',false,true,'2026-11-01'),
  ('10000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','אחמד','חורי','972500000009','cook','employee','1009',false,true,'2026-12-01'),
  ('10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','טל','שמעוני','972500000010','cook','employee','1010',false,true,'2026-12-01'),
  ('10000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','רוני','אוחיון','972500000011','call_center','employee','1011',false,true,'2026-12-15'),
  ('10000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','שירה','גולן','972500000012','call_center','employee','1012',false,true,'2026-12-15');

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

insert into public.employee_external_ids (employee_id, system, external_id, external_name) values
  ('10000000-0000-4000-8000-000000000003','tabit','W-101','Noa C'),
  ('10000000-0000-4000-8000-000000000004','tabit','W-102','Itai M'),
  ('10000000-0000-4000-8000-000000000006','tabit','B-201','Daniel A'),
  ('10000000-0000-4000-8000-000000000007','tabit','B-202','Omer H'),
  ('10000000-0000-4000-8000-000000000011','pbx','ext-301','Roni'),
  ('10000000-0000-4000-8000-000000000012','pbx','ext-302','Shira');

-- Sample January results (demo — replaced by real syncs)
insert into public.metric_results (branch_id, period, metric_id, employee_id, value, source) values
  ('00000000-0000-4000-8000-000000000001','2027-01-01','food',   null, 28.9, 'cost'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','labor',  null, 29.2, 'payroll'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','promo',  null, 812,  'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','revenue',null, 1236000, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','answer', null, 91.5, 'pbx'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000002', 4.7, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','service','10000000-0000-4000-8000-000000000002', 92,  'manual'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000003', 4.8, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','service','10000000-0000-4000-8000-000000000003', 95,  'manual'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','upsell', '10000000-0000-4000-8000-000000000003', 72, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000004', 4.3, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','service','10000000-0000-4000-8000-000000000004', 84,  'manual'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','upsell', '10000000-0000-4000-8000-000000000004', 48, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000005', 4.5, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','upsell', '10000000-0000-4000-8000-000000000005', 39, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000006', 4.6, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','service','10000000-0000-4000-8000-000000000006', 90,  'manual'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','upsell', '10000000-0000-4000-8000-000000000006', 81, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','survey', '10000000-0000-4000-8000-000000000007', 4.1, 'survey'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','service','10000000-0000-4000-8000-000000000007', 88,  'manual'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','upsell', '10000000-0000-4000-8000-000000000007', 55, 'tabit'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','phone',  '10000000-0000-4000-8000-000000000011', 93,  'pbx'),
  ('00000000-0000-4000-8000-000000000001','2027-01-01','phone',  '10000000-0000-4000-8000-000000000012', 86,  'pbx');
