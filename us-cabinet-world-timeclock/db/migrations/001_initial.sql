-- US Cabinet World Time Clock: initial schema.
-- All timestamps are timestamptz (UTC instants). Calendar logic uses America/Chicago in the app.

create table admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username = lower(username) and length(username) between 3 and 64),
  display_name text not null,
  password_hash text not null,
  role text not null check (role in ('admin', 'manager')),
  active boolean not null default true,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index admin_sessions_user_idx on admin_sessions (admin_user_id);

create table employees (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null unique,
  first_name text not null,
  last_name text not null,
  -- HMAC-SHA256(PIN_PEPPER, pin). Never the plaintext PIN.
  pin_lookup text not null unique,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz
);

-- Rate history: settlement uses the rate in effect on each worked day, so rate changes
-- never silently rewrite past weeks.
create table employee_rates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  hourly_rate_cents integer not null check (hourly_rate_cents >= 0 and hourly_rate_cents <= 100000),
  effective_date date not null,
  created_by uuid references admin_users(id),
  created_at timestamptz not null default now(),
  unique (employee_id, effective_date)
);

create table kiosk_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  created_by uuid references admin_users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references admin_users(id)
);

create table site_settings (
  id integer primary key default 1 check (id = 1),
  site_name text not null,
  address text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 100 check (radius_m between 25 and 2000),
  geofence_mode text not null default 'monitor' check (geofence_mode in ('monitor', 'enforce')),
  coordinates_verified_at timestamptz,
  coordinates_verified_by uuid references admin_users(id),
  max_accuracy_m integer not null default 100 check (max_accuracy_m between 10 and 1000),
  max_location_age_s integer not null default 120 check (max_location_age_s between 10 and 900),
  duplicate_window_s integer not null default 60 check (duplicate_window_s between 0 and 600),
  max_shift_hours integer not null default 16 check (max_shift_hours between 8 and 24),
  overtime_policy text not null default 'apply' check (overtime_policy in ('apply', 'report_only')),
  updated_at timestamptz not null default now(),
  updated_by uuid references admin_users(id),
  constraint enforce_requires_verified_coordinates
    check (geofence_mode = 'monitor' or coordinates_verified_at is not null)
);

-- Approximate coordinates for 2341 S Council Rd, Oklahoma City, OK 73128.
-- NOT VERIFIED. An administrator must confirm them on site before enforcement can be enabled.
insert into site_settings (site_name, address, latitude, longitude)
values ('US Cabinet World', '2341 S Council Rd, Oklahoma City, OK 73128', 35.4420, -97.6730);

-- Raw punch records. Core fields are immutable (see trigger); corrections void a punch and
-- insert a replacement, and every change is written to audit_log.
create table punches (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  punch_type text not null check (punch_type in ('clock_in', 'lunch_out', 'lunch_in', 'clock_out')),
  punched_at timestamptz not null,
  source text not null check (source in ('phone', 'kiosk', 'admin')),
  kiosk_device_id uuid references kiosk_devices(id),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  location_age_s double precision,
  distance_m double precision,
  geofence_result text check (geofence_result in ('inside', 'outside', 'low_accuracy', 'stale', 'unavailable', 'not_required')),
  geofence_mode text check (geofence_mode in ('monitor', 'enforce')),
  review_status text not null default 'none' check (review_status in ('none', 'pending', 'approved', 'rejected')),
  exception_reason text,
  gps_error text,
  reviewed_by uuid references admin_users(id),
  reviewed_at timestamptz,
  review_note text,
  voided_at timestamptz,
  voided_by uuid references admin_users(id),
  void_reason text,
  replaces_punch_id uuid references punches(id),
  created_by_admin uuid references admin_users(id),
  correction_reason text,
  client_request_id text unique,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index punches_employee_time_idx on punches (employee_id, punched_at) where voided_at is null;
create index punches_time_idx on punches (punched_at);
create index punches_pending_idx on punches (review_status) where review_status = 'pending';

create function punches_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'punches are append-only; void the punch instead of deleting it';
  end if;
  if new.employee_id is distinct from old.employee_id
     or new.punch_type is distinct from old.punch_type
     or new.punched_at is distinct from old.punched_at
     or new.source is distinct from old.source
     or new.latitude is distinct from old.latitude
     or new.longitude is distinct from old.longitude
     or new.accuracy_m is distinct from old.accuracy_m
     or new.geofence_result is distinct from old.geofence_result
     or new.client_request_id is distinct from old.client_request_id
     or new.created_at is distinct from old.created_at then
    raise exception 'raw punch fields are immutable; void and replace the punch instead';
  end if;
  if old.voided_at is not null and new.voided_at is null then
    raise exception 'a voided punch cannot be restored';
  end if;
  return new;
end $$;

create trigger punches_guard_update before update on punches for each row execute function punches_guard();
create trigger punches_guard_delete before delete on punches for each row execute function punches_guard();

create table audit_log (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('admin', 'employee', 'kiosk', 'system')),
  actor_id uuid,
  actor_label text,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  before jsonb,
  after jsonb,
  ip text
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);
create index audit_log_time_idx on audit_log (occurred_at desc);

create function audit_log_guard() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log for each row execute function audit_log_guard();

-- Optional finalized snapshots of a weekly settlement (the live report is always recomputed
-- from raw punches; snapshots record what was reviewed/paid).
create table settlement_snapshots (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  finalized_at timestamptz not null default now(),
  finalized_by uuid references admin_users(id),
  note text,
  data jsonb not null
);
create index settlement_snapshots_week_idx on settlement_snapshots (week_start, finalized_at desc);

create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);
