# HANDOFF — US Cabinet World Time Clock

_Last updated: 2026-10-27. Keep this file current at every milestone._

This document lets any developer (human or AI: Claude Code Desktop, ChatGPT, etc.) continue the project using only
this repository. Nothing here depends on a Claude session or any proprietary storage.

---

## 1. Project purpose and confirmed business requirements

Employee time clock web app for **US Cabinet World**, 2341 S Council Rd, Oklahoma City, OK 73128.

Confirmed requirements (from the owner's brief):

- **Punching**: employees use their phones; each has a unique PIN; four actions — Clock In, Lunch Out, Lunch In,
  Clock Out. Server-generated timestamps, America/Chicago. Lunch computed from actual punches (never a fixed
  deduction). Invalid sequences and accidental duplicates prevented.
- **Location**: GPS geofence for phone punches, reference = warehouse address, configurable radius starting at
  100 m. Coordinates must be verified before enforcement. Fresh reading required, accuracy recorded. No continuous
  tracking. If GPS fails → exception request for manager review (time is never silently lost). GPS is not
  presented as fraud-proof.
- **Tablet**: same app supports a shared warehouse tablet via administrator-authorized kiosk mode; employee
  records/history are independent of device.
- **Settlement**: pay period Friday → Thursday inclusive, paid Friday, weekends included, individual hourly rates,
  daily + weekly hours and amounts from actual work, raw records kept separate from calculations. Do **not** assume
  1099 removes overtime; keep reporting flexible for the accountant.
- **Admin**: secure auth; add/edit/deactivate employees; set rates; live status; review missing/irregular punches;
  corrections with full audit trail; weekly settlement; CSV for bookkeeping/QuickBooks. Employees never see other
  employees' rates or records.
- **Tech**: Next.js + TypeScript + Tailwind, persistent DB, env-var secrets, secured endpoints, hashed PINs, RBAC,
  responsive UI, Vercel-ready, dedicated private GitHub repo `us-cabinet-world-timeclock`.
- **Delivery**: tested workflow, setup docs, test deployment before production; no real employee use until auth,
  persistence, location verification and admin controls are tested.
- **Portability**: must not depend on Claude Cloud Sessions (credits expire 2026-11-05). Regular commits, backup
  ZIP, this handoff file.

Interpretations made (confirm with owner if different):
- "Payment day: Friday" = the Friday immediately after the Thursday that ends the week (shown as Pay date).
- PINs are exactly **6 digits** (4-digit PINs are too easy to guess and collide).
- **Payment estimate (owner instruction, 2026-10-27 update):** the internal estimate uses each worker's regular hourly
  rate for **all** recorded hours, including hours over 40 (`pay_estimate_method = 'flat_rate'`, default). Hours over 40
  in the Fri–Thu week are **always tracked and shown separately**. The overtime multiplier (`overtime_multiplier`,
  default 1.5) stays configurable: its premium is always shown as a reference column and is added to the estimate only
  if the method is switched to `overtime_premium`. Every screen/CSV labels the amount as an **internal payment estimate,
  not a determination of legal payroll obligations**. The app does not assume 1099 classification removes overtime or
  other legal requirements — confirm with the accountant.
- Kiosk punches do not require GPS (the device itself is authorized and stays in the warehouse).

## 2. Technology stack and architecture

- **Next.js 16.4.3** (App Router, Turbopack build), **React 19**, **TypeScript 5.9**, **Tailwind CSS 4**.
  Note: Next 16 differs from older versions (async `cookies()`/`headers()`/`params`; `middleware` renamed `proxy`).
  Bundled docs: `node_modules/next/dist/docs/`. `AGENTS.md` may be auto-added by `next dev`; that's expected.
- **PostgreSQL** via `pg` (no ORM). Plain SQL migrations in `db/migrations`, applied by `scripts/migrate.mjs`
  (tracks `schema_migrations`, advisory lock, each file in a transaction).
- **Vitest** for unit + integration tests; **Playwright** (optional) for the browser smoke test.

Layers:

```
app/page.tsx + app/time-clock.tsx      Employee PIN pad / action UI (client component)
app/api/punch/identify/route.ts       POST: PIN → own status (no rates)
app/api/punch/route.ts                POST: record punch (server timestamp, GPS check, idempotent)
app/api/health/route.ts               GET: DB connectivity
app/admin/login                       Admin sign-in
app/admin/(dash)/*                    Status, Review, Timecards, Settlement, Employees, Settings, Audit
app/admin/actions.ts                  All admin mutations (server actions; each re-checks auth + role)
app/admin/export/route.ts             CSV exports (admin role only)
lib/time.ts                           Chicago calendar, Fri–Thu weeks, DST-safe conversions
lib/punch-rules.ts                    Pure state machine (off → working ⇄ lunch → off) + duplicate window
lib/geo.ts                            Haversine distance + geofence evaluation
lib/settlement.ts                     Pure weekly calculation (shifts, day split, OT, flags)
lib/security.ts                       PIN HMAC, scrypt passwords, session tokens
lib/services/*.ts                     DB services (punches, employees, corrections, reports, settings, devices, admin-auth, audit, rate-limit)
lib/auth.ts                           Cookie/session helpers for Next (requireAdmin, currentKiosk)
```

Key design decisions:
- **Raw punches are immutable** (DB trigger): corrections void the original (kept, with reason) and insert a
  replacement (`source='admin'`, `replaces_punch_id`). Punches cannot be deleted. `audit_log` is append-only (trigger).
- **Settlement is computed on demand** from raw punches; nothing derived is stored except optional
  `settlement_snapshots` (JSON copies saved when a week is finalized/paid).
- **Time attribution**: worked time is split at Chicago midnight (daily hours) and at Friday 00:00 (pay week), so
  overnight shifts land in the day/week they were actually worked. Durations use real instants (DST-correct).
- **Rate history** (`employee_rates.effective_date`): each day uses the rate in effect that day; changing a rate never
  rewrites past weeks. Estimated amount (flat rate) = Σ day hours × that day's rate. Reference OT premium =
  (multiplier − 1) × (straight pay ÷ total hours) × hours over 40 (weighted regular rate); included only for `overtime_premium`.
- Pay-estimate logic lives only in `lib/settlement.ts` (`calculateEmployeeWeek`, `PAY_ESTIMATE_DISCLAIMER`,
  `payEstimateLabel`); pages and CSV exports read its output.
- **Per-employee row lock** (`select … for update`) serializes punches; `client_request_id` (unique) makes retries idempotent.

## 3. Completed features

- Employee punch flow (phone + kiosk), PIN pad, only valid actions enabled, today's punches shown, auto-reset of idle screen.
- State machine with clear errors; 60 s duplicate window (configurable); forgotten clock-out (older than max shift,
  default 16 h) allows a new Clock In and flags the old shift.
- GPS: one fresh high-accuracy reading per tap (`maximumAge: 0`), accuracy/age/distance stored; monitor vs enforce
  modes; enforcement blocked (app + DB constraint) until coordinates are verified; changing coordinates clears verification.
- Exception requests (GPS failed/outside) → pending punch that still counts (flagged) → manager approve/reject (reject voids).
- Kiosk mode: admin registers device (hashed token in httpOnly cookie, ~400 days), revocable; kiosk name shown on screen.
- Admin auth: scrypt passwords, DB sessions (12 h, hashed tokens, httpOnly/SameSite=Lax/`__Host-` cookie in prod),
  per-account lockout (5 failures → 15 min), per-IP throttling, logout revokes session.
- Roles: `admin` (everything) and `manager` (status, review, timecards/corrections; no rates, settlement, settings, audit, exports).
- Employees: add/edit/deactivate/reactivate, generated or chosen PIN (shown once), PIN reset, rate history.
- Status board, review queue (exceptions + irregular punches per week), timecards with raw history & corrections.
- Weekly settlement: per-day hours, total, ≤40/>40 split, rate, hours × rate, reference OT premium at the configured
  multiplier, **estimated amount (internal estimate, flat rate by default)**, flags; totals; disclaimer banner;
  snapshots; CSV exports: weekly summary, daily detail, QuickBooks-style time activities, raw punches.
- Audit log page; per-employee change history.
- Security headers (frame-deny, nosniff, HSTS, Permissions-Policy geolocation=self), same-origin check on punch APIs,
  Next server-action origin check, CSV formula-injection protection, generic error messages (no internals leaked).
- Tests: 29 unit + 18 PostgreSQL integration tests (incl. flat-rate estimate, configurable multiplier, and an upgrade test
  proving migration 002 leaves punches and audit history untouched); 15-step Playwright browser smoke test (all passing 2026-10-27).
- CI workflow (`.github/workflows/ci.yml`): typecheck, tests with Postgres service, build (runs once in its own repo).

## 4. Incomplete features / not yet done

- **Dedicated GitHub repo** `us-cabinet-world-timeclock` not yet created: the session's GitHub integration lacked
  permission to create repos (HTTP 403). Code currently lives in `us-cabinet-world-timeclock/` on branch
  `claude/kind-allen-cq9ahe` of `maggie141319/job-scout-agent`. See §12 step 1 to move it (history preserved).
- **No deployment yet** (needs the owner's Vercel + database accounts). See README §4.
- **Warehouse coordinates unverified** (seeded approximation 35.4420, −97.6730; geocoding was unavailable). Must be
  verified on site before enforcement.
- QuickBooks CSV column mapping not confirmed with the bookkeeper's actual import tool (QBO vs Desktop vs payroll service).
- No notifications (e.g. email to manager on exception), no employee self-service history beyond "today" — intentionally out of scope for v1.

## 5. Known bugs and limitations

- GPS can be spoofed or be inaccurate indoors; it is a deterrent + audit signal, not fraud-proof. Use Review page data.
- PIN lookup uses HMAC-SHA256 with `PIN_PEPPER`. If both the DB **and** the pepper leak, 6-digit PINs are brute-forceable
  (1M space). Rotate by resetting PINs. Rate limit: 15 failed PINs / 15 min per IP (phone) or per kiosk device —
  phones sharing warehouse Wi-Fi share an IP, so a burst of wrong PINs can briefly block others (a manager can wait it out).
- Corrections are not sequence-validated (historic edits may be temporarily inconsistent); the settlement/review pages flag
  irregular sequences instead.
- Wall-clock times entered during the DST fall-back hour (1:00–2:00 AM, first Sunday of November) are ambiguous; the
  correction form picks one of the two instants.
- Open shifts only count completed segments until a clock-out is added (flagged as missing clock-out) — intentional.
- After a new deployment, an admin page left open may show "Failed to find Server Action"; refresh the page.
- `next dev` may hit file-watcher limits (EMFILE) on some machines; `next build && next start` works.

## 6. Database structure and migrations

Tables (see `db/migrations/001_initial.sql`):
- `admin_users` (username, scrypt hash, role admin|manager, active, lockout fields), `admin_sessions` (sha256 token hash, expiry, revoked).
- `employees` (employee_code, names, `pin_lookup` = HMAC, active), `employee_rates` (cents, effective_date).
- `punches` — raw records: type, `punched_at` (server time), source phone|kiosk|admin, lat/lng/accuracy/age/distance,
  geofence_result + mode, review_status none|pending|approved|rejected, exception reason, void fields, `replaces_punch_id`,
  correction reason, `client_request_id` (unique), ip/user agent. Triggers block deletes and edits of raw fields.
- `audit_log` — append-only (trigger). `settlement_snapshots` — JSON reports. `kiosk_devices` (hashed token).
- `site_settings` — single row: coordinates, radius, mode, verification, accuracy/age limits, duplicate window, max shift,
  `pay_estimate_method` (`flat_rate` | `overtime_premium`), `overtime_multiplier` (1.00–3.00).
  Constraint: `geofence_mode='enforce'` requires `coordinates_verified_at`.
- `rate_limits` — failure counters.

Migration history:
- `001_initial.sql` — initial schema.
- `002_flat_rate_estimate.sql` — renames `overtime_policy` → `pay_estimate_method`, sets it to `flat_rate`, adds
  `overtime_multiplier` (1.5). Writes a `system` audit entry recording the old and new setting. Does not modify punches,
  audit history or settlement snapshots (old snapshots keep their original `amountDueCents` field; the UI reads either).
  **Run it on every existing database** (`npm run db:migrate`).

Migrations: add a new file `db/migrations/NNN_description.sql` (never edit an applied one), then
`DATABASE_URL=... npm run db:migrate` for each environment (staging first).

## 7. Authentication and security design

- Employees: PIN per request (no employee session). Server returns only the employee's own first/last name, state and
  today's punches — never rates or other employees. PINs never stored or logged in plaintext; shown once to the admin on creation/reset.
- Admins/managers: username + password (≥12 chars, scrypt N=16384). Session token = 32 random bytes in an httpOnly cookie;
  only its SHA-256 is stored. Every admin page **and** every server action calls `requireAdmin([...roles])` (layouts are not
  treated as a security boundary). CSV export route checks the admin role itself.
- Kiosk: random token cookie, hash in DB, revocable; punches from kiosks are tagged with the device id.
- CSRF: punch APIs require `Origin` host == request host; server actions use Next's built-in origin check; cookies SameSite=Lax.
- Secrets only in env vars; `.env*` git-ignored; backup ZIP built from git-tracked files only and refuses `.env`/dumps.
- First admin is created from the command line (`npm run admin:create`), never via a public web form.

## 8. Local development

See README §1. Summary: `npm ci` → `.env.local` from `.env.example` → `npm run db:migrate` → `npm run admin:create` → `npm run dev`.

## 9. Vercel deployment and environment variables

See README §2 and §4. Env vars: `DATABASE_URL` (pooled Neon URL recommended), `PIN_PEPPER` (≥32 chars; different per
environment), optional `DATABASE_POOL_MAX`. Use a separate staging database for Preview deployments. Run migrations
from a trusted machine. Health check: `/api/health`.

## 10. Testing

- `npm run typecheck`, `npm test` (needs `TEST_DATABASE_URL` pointing at a disposable DB for integration tests; otherwise they
  are skipped), `npm run build`.
- Browser smoke: README §3 (`npm run test:e2e`). It covers admin login, employee creation, phone punches with simulated GPS,
  wrong PIN, duplicate block, API refusal without location, cross-origin block, verification + enforcement, outside-geofence
  rejection → exception → manager approval, manager role restrictions, kiosk registration & punching, correction with history,
  settlement + CSV (admin-only), audit entries.
- Manual: go-live checklist in README §5 on a real phone over HTTPS.

## 11. Production data backup and recovery

- Neon point-in-time restore (plan-dependent window) + weekly `npm run backup:db` (pg_dump custom format) stored privately
  off-platform after each pay run. Restore with `pg_restore --no-owner --no-privileges -d <empty db> <file>`; then point
  `DATABASE_URL` at it and redeploy. Test a restore into a scratch database at least once before go-live.
- Settlement snapshots in the DB record what was paid each week.
- Code: GitHub + `npm run backup:zip`. Keep `PIN_PEPPER` and DB credentials in a password manager.

## 12. Exact next development steps

1. **Create the dedicated private repo and move the code** (owner): on github.com create empty private repo
   `us-cabinet-world-timeclock` (no README). Then, from a clone of `maggie141319/job-scout-agent`:
   ```bash
   git fetch origin claude/kind-allen-cq9ahe && git checkout claude/kind-allen-cq9ahe
   git subtree split --prefix=us-cabinet-world-timeclock -b timeclock-main
   git push git@github.com:<owner>/us-cabinet-world-timeclock.git timeclock-main:main
   ```
   (Or unzip the backup ZIP into a new folder, `git init`, commit, push.) Confirm CI passes there. Afterwards the
   `us-cabinet-world-timeclock/` folder can be removed from job-scout-agent.
2. Create Neon (or other Postgres) **staging** + **production** databases; set Vercel env vars; migrate; create admin.
3. Deploy a **test (preview) deployment**; run README §5 checklist with 2–3 employees in **monitor** mode for a few days.
4. Verify warehouse coordinates on site; tune radius/accuracy from real readings; enable enforcement.
5. Confirm with the accountant: whether the flat-rate estimate is appropriate (worker classification, overtime
   obligations), CSV/QuickBooks format, pay-date rule. If overtime pay is required, set Settings → Payment estimate
   method to "Add overtime premium" and the multiplier (no code change needed).
6. Run one full Friday–Thursday test week in parallel with the current method; compare totals; then go live.
7. Set up the weekly DB backup routine; test a restore.
8. Optional later: email/SMS alert on new exceptions; employee weekly hours view (own data only); lock finalized weeks.

## Current status (2026-10-27)

- Application code complete for v1; typecheck, 47 automated tests, production build and 15-step browser smoke test pass.
- Update 2026-10-27: internal payment estimate switched to flat rate (all hours × hourly rate) per owner; hours over 40
  still reported; overtime multiplier configurable (migration 002).
- Not deployed; dedicated repo pending (see §4/§12). Not approved for real employee use yet.

## Continuing in Claude Code Desktop or ChatGPT

- Clone the repo, `npm ci`, create `.env.local`, start a local Postgres, run `npm run db:migrate && npm test`.
- Point the assistant at this file and README.md first. Ask it to read `node_modules/next/dist/docs/` before changing
  Next-specific code (Next 16 APIs differ from older training data).
- Keep the invariants: never mutate raw punch fields; every admin mutation calls `requireAdmin` and writes `audit_log`;
  employees never receive rate data; secrets only in env vars.
