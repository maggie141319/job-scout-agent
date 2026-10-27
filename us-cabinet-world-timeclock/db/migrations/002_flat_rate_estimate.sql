-- Internal payment estimate: flat rate (total hours × hourly rate) by default.
-- Hours over 40 are still tracked and reported; the overtime multiplier stays configurable
-- for future use. Existing punches, audit history and settlement snapshots are not modified.

alter table site_settings rename column overtime_policy to pay_estimate_method;
alter table site_settings drop constraint if exists site_settings_overtime_policy_check;

insert into audit_log (actor_type, actor_label, action, entity_type, entity_id, reason, before, after)
select 'system', 'migration 002_flat_rate_estimate', 'settings.pay_estimate_method', 'site_settings', '1',
       'Owner instruction: internal estimate uses the regular hourly rate for all recorded hours, including hours over 40.',
       jsonb_build_object('overtime_policy', pay_estimate_method),
       jsonb_build_object('pay_estimate_method', 'flat_rate', 'overtime_multiplier', 1.5)
from site_settings where id = 1;

update site_settings set pay_estimate_method = 'flat_rate', updated_at = now() where id = 1;

alter table site_settings
  alter column pay_estimate_method set default 'flat_rate',
  add constraint site_settings_pay_estimate_method_check
    check (pay_estimate_method in ('flat_rate', 'overtime_premium')),
  add column overtime_multiplier numeric(4, 2) not null default 1.5
    check (overtime_multiplier >= 1 and overtime_multiplier <= 3);
