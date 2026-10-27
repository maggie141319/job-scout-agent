# US Cabinet World — Employee Time Clock

Mobile-friendly time clock for US Cabinet World (2341 S Council Rd, Oklahoma City, OK 73128).

- Employees punch **Clock In / Lunch Out / Lunch In / Clock Out** from their phones with a personal 6-digit PIN,
  or on an administrator-authorized shared tablet (kiosk mode).
- Server-generated timestamps, America/Chicago calendar, actual lunch times (no automatic deduction).
- GPS geofence (default 100 m) with a manager-review exception path when GPS fails.
- Weekly settlement for the **Friday–Thursday** pay week (paid Friday), CSV exports for bookkeeping/QuickBooks.
- Admin dashboard with roles, punch corrections and a complete, append-only audit trail.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · PostgreSQL (`pg`) · Vitest · Playwright smoke test.
No vendor-specific services: any PostgreSQL 13+ and any Node 20.9+ host works; Vercel is the documented target.

> See **[HANDOFF.md](HANDOFF.md)** for architecture, design decisions, status, and next steps.

---

## 1. Local development

Prerequisites: Node 22 (see `.nvmrc`), PostgreSQL 13+ (local, Docker, or a Neon dev branch).

```bash
npm ci
cp .env.example .env.local          # then fill in DATABASE_URL and PIN_PEPPER
npm run db:migrate                  # creates tables (safe to re-run)
npm run admin:create                # prompts for the first admin username/password
npm run dev                         # http://localhost:3000  (admin: /admin)
```

Quick local Postgres with Docker:

```bash
docker run -d --name timeclock-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
# DATABASE_URL=postgresql://postgres:dev@localhost:5432/postgres
```

Geolocation needs a secure context: `http://localhost` works; phones on your LAN need HTTPS (use a Vercel preview deployment to test on real phones).

## 2. Environment variables

| Name | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. On Vercel+Neon use the **pooled** URL with `sslmode=require`. |
| `PIN_PEPPER` | yes | ≥32 random chars. Secret key used to HMAC employee PINs. **Changing it invalidates all PINs.** Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `DATABASE_POOL_MAX` | no | Max DB connections per server instance (default 5). |
| `TEST_DATABASE_URL` | tests only | Disposable database for integration tests. **All tables in it are dropped.** |

Secrets live only in `.env.local` (git-ignored) or the hosting provider's environment settings. Never commit them.

## 3. Tests

```bash
npm run typecheck
npm test                 # unit tests + PostgreSQL integration tests (needs TEST_DATABASE_URL, else integration is skipped)
npm run build
```

Covered: clock-in, lunch-out, lunch-in, clock-out, invalid sequences, duplicate-punch window, idempotent retries,
PIN hashing/rate limiting, GPS required / outside / low accuracy / stale rejection, monitor vs enforce mode,
manager exception approve/reject, kiosk mode and revocation, overnight shifts, Friday week boundary, DST,
overtime reporting, rate history, corrections with audit trail, DB-level immutability of raw punches and audit log,
admin login lockout and sessions.

Browser end-to-end smoke test (real Chromium, simulated GPS) against a running production build:

```bash
# Use a DISPOSABLE database: migrate it and create admin "owner" + manager "manager1" first
npm run build && DATABASE_URL=... PIN_PEPPER=... npx next start -p 3100
E2E_ADMIN_PASSWORD=... E2E_MANAGER_PASSWORD=... E2E_BASE_URL=http://localhost:3100 npm run test:e2e -- ./screenshots
```

(Requires `playwright` with Chromium: `npm i -D playwright && npx playwright install chromium`.)

## 4. Deploy to Vercel (test deployment first)

1. Push this project to its own private GitHub repository (`us-cabinet-world-timeclock`).
2. Create a Postgres database. Easiest: Vercel dashboard → Storage → **Neon** (free tier works), or neon.tech directly.
   Create **two** databases/branches: `staging` (for the test deployment) and `production`.
3. In Vercel: **Add New Project** → import the repo. Framework preset: Next.js (auto). Root directory: repo root.
4. Project → Settings → Environment Variables:
   - `DATABASE_URL` — Preview = staging URL, Production = production URL
   - `PIN_PEPPER` — a different random value for Preview and Production
5. Run migrations and create the first admin **from your computer** against each database:
   ```bash
   DATABASE_URL="<staging url>" npm run db:migrate
   DATABASE_URL="<staging url>" npm run admin:create
   ```
6. Deploy. Check `https://<deployment>/api/health` returns `{"ok":true,"database":"up"}`.
7. Run the go-live checklist below on the **preview/staging** deployment before inviting employees.

Re-run `npm run db:migrate` against each database whenever a new file appears in `db/migrations/`
(before or right after deploying the code that needs it).

## 5. Go-live checklist (do not enable real employee use until all pass)

- [ ] Admin sign-in works; a manager account sees only Status/Review/Timecards.
- [ ] Data persists across redeploys (punch, redeploy, punch is still there).
- [ ] **Verify warehouse coordinates on site**: Settings → stand inside the warehouse → "Use this device's current location" → Save → "Mark coordinates verified". The seeded point (35.4420, −97.6730) is an *unverified approximation*.
- [ ] In monitor mode, have 2–3 people punch from inside, the parking lot and off-site; check results on the Review page and adjust the radius / max accuracy.
- [ ] Enable enforcement; confirm an off-site punch is rejected and the exception request reaches the Review page.
- [ ] Register the warehouse tablet as a kiosk (optional) and test a punch.
- [ ] Review a full test week on the Settlement page; export CSVs and confirm the format with your bookkeeper/accountant.
- [ ] Confirm overtime policy and worker classification with your accountant (Settings → Overtime premium).
- [ ] Set up backups (below).

## 6. Backups and recovery

- **Database** (payroll records): Neon keeps point-in-time history (restore window depends on plan). In addition, take
  a weekly off-platform dump after each pay run:
  `DATABASE_URL="<production url>" npm run backup:db` → `backups/timeclock-db-<date>.dump` (git-ignored; store privately).
  Restore into an empty database: `pg_restore --no-owner --no-privileges -d "<new db url>" backups/<file>.dump`.
- **Source code**: GitHub is the source of truth. `npm run backup:zip` creates `backups/us-cabinet-world-timeclock-source-<date>.zip`
  from git-tracked files only (no secrets, no node_modules).
- Keep `PIN_PEPPER` in a password manager; without it, existing PINs cannot be verified (records are unaffected — reset PINs).

## 7. Using the app

- Employees: open the site on a phone → enter PIN → tap the one highlighted action. Location is read once per tap (never tracked).
  If location fails: **Try again** or **send to a manager for review** with a short reason (time is recorded immediately).
- Managers/admins: `/admin`. Fix missing punches on **Timecards** (every change requires a reason and is audited; originals are kept).
- Pay: **Settlement** → choose the week → resolve flags → export CSV → optionally "Save snapshot" after paying.

## Project layout

```
app/                    Next.js routes (employee page, /api/punch*, /admin/*)
components/             Small client components for admin forms
lib/                    Domain logic (time, punch rules, geofence, settlement, security, CSV)
lib/services/           Database services (punches, employees, corrections, reports, auth, kiosks, settings)
db/migrations/          Plain SQL migrations, applied by scripts/migrate.mjs
scripts/                migrate, create-admin, backup-db, make-backup-zip
tests/                  Vitest unit + integration tests, Playwright e2e smoke test
```
