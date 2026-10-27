#!/usr/bin/env node
/**
 * Browser end-to-end smoke test of the full workflow against a running server.
 *
 * Prerequisites (use a DISPOSABLE database):
 *   1. npm run build && DATABASE_URL=... PIN_PEPPER=... npx next start -p 3100
 *   2. Fresh migrated DB with an admin "owner" / E2E_ADMIN_PASSWORD and a manager "manager1" / E2E_MANAGER_PASSWORD
 *   3. Playwright with Chromium available (npm i -D playwright && npx playwright install chromium)
 * Run: E2E_BASE_URL=http://localhost:3100 node tests/e2e/smoke.mjs [screenshotDir]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD ?? "e2e-owner-password";
const MANAGER_PW = process.env.E2E_MANAGER_PASSWORD ?? "e2e-manager-password";
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SITE = { latitude: 35.442, longitude: -97.673 };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
let step = 0;
const log = (msg) => console.log(`✔ ${++step}. ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function adminLogin(context, username, password) {
  const page = await context.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/admin`);
  return page;
}

function formWith(page, buttonName) {
  return page.locator("form", { has: page.getByRole("button", { name: buttonName, exact: true }) });
}

async function submitForm(page, buttonName, expectText) {
  const form = formWith(page, buttonName).first();
  await form.getByRole("button", { name: buttonName, exact: true }).click();
  await form.getByRole("status").filter({ hasText: expectText }).waitFor({ timeout: 15_000 });
  return form;
}

async function enterPin(page, pin) {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

const browser = await chromium.launch();
try {
  // ---------- Admin creates employees ----------
  const adminCtx = await browser.newContext();
  const admin = await adminLogin(adminCtx, "owner", ADMIN_PW);
  await shot(admin, "01-admin-status-empty");
  log("admin signs in");

  await admin.goto(`${BASE}/admin/employees`);
  let form = formWith(admin, "Add employee");
  await form.locator('[name="employeeCode"]').fill("E001");
  await form.locator('[name="firstName"]').fill("Maria");
  await form.locator('[name="lastName"]').fill("Lopez");
  await form.locator('[name="rate"]').fill("18.50");
  await form.locator('[name="rateEffectiveDate"]').fill("2026-01-02");
  await form.locator('[name="pin"]').fill("482913");
  await submitForm(admin, "Add employee", "Added Maria Lopez");
  if (!(await admin.getByText("482913").isVisible())) fail("PIN not shown once after creation");

  form = formWith(admin, "Add employee");
  await form.locator('[name="employeeCode"]').fill("E002");
  await form.locator('[name="firstName"]').fill("Jake");
  await form.locator('[name="lastName"]').fill("Smith");
  await form.locator('[name="rate"]').fill("20");
  await form.locator('[name="rateEffectiveDate"]').fill("2026-01-02");
  await form.locator('[name="pin"]').fill("");
  await submitForm(admin, "Add employee", "Added Jake Smith");
  const jakePin = (await form.locator("strong.font-mono").textContent()).trim();
  if (!/^\d{6}$/.test(jakePin)) fail("generated PIN missing");
  await shot(admin, "02-admin-employees");
  log(`admin adds 2 employees (one generated PIN), rates hidden from employees`);

  // ---------- Phone: full day inside geofence (monitor mode) ----------
  const phoneCtx = await browser.newContext({ ...PHONE, geolocation: { ...SITE, accuracy: 15 }, permissions: ["geolocation"] });
  const phone = await phoneCtx.newPage();
  await phone.goto(BASE);
  await shot(phone, "03-phone-pin-pad");
  await enterPin(phone, "000000");
  await phone.getByRole("alert").filter({ hasText: "PIN not recognized" }).waitFor();
  log("wrong PIN rejected");

  await enterPin(phone, "482913");
  await phone.getByText("Hi, Maria").waitFor();
  if (!(await phone.getByRole("button", { name: "Lunch In" }).isDisabled())) fail("Lunch In should be disabled while clocked out");
  if (!(await phone.getByRole("button", { name: "Clock Out" }).isDisabled())) fail("Clock Out should be disabled while clocked out");
  await shot(phone, "04-phone-ready");
  await phone.getByRole("button", { name: "Clock In" }).click();
  await phone.getByText(/Clocked in at/).waitFor();
  await shot(phone, "05-phone-clocked-in");
  log("phone Clock In inside geofence; invalid actions disabled");

  // Immediate second punch is blocked as an accidental duplicate (60 s window).
  await phone.getByRole("button", { name: "Done" }).click();
  await enterPin(phone, "482913");
  await phone.getByRole("button", { name: "Lunch Out" }).click();
  await phone.getByRole("alert").filter({ hasText: "To prevent accidental double punches" }).waitFor();
  await shot(phone, "06-phone-duplicate-blocked");
  log("accidental duplicate punch blocked");

  // Invalid sequence via the API (UI disables it): Lunch In while working.
  const bad = await phone.request.post(`${BASE}/api/punch`, {
    headers: { Origin: BASE },
    data: { pin: "482913", action: "lunch_in", clientRequestId: "e2e-invalid-seq-1", location: { ...SITE, accuracy: 10, ageSeconds: 1 } },
  });
  const badJson = await bad.json();
  if (badJson.code !== "DUPLICATE_PUNCH" && badJson.code !== "INVALID_SEQUENCE") fail(`unexpected ${badJson.code}`);
  const noLoc = await phone.request.post(`${BASE}/api/punch`, {
    headers: { Origin: BASE },
    data: { pin: jakePin, action: "clock_in", clientRequestId: "e2e-no-location-1" },
  });
  if ((await noLoc.json()).code !== "LOCATION_REQUIRED") fail("phone punch without location must be refused");
  const cross = await phone.request.post(`${BASE}/api/punch`, { headers: { Origin: "https://evil.example" }, data: {} });
  if (cross.status() !== 403) fail("cross-origin POST must be blocked");
  log("API rejects punch without location and cross-origin requests");

  // Shorten the duplicate window so the rest of the day can be punched quickly.
  await admin.goto(`${BASE}/admin/settings`);
  await formWith(admin, "Save settings").locator('[name="duplicate_window_s"]').fill("0");
  await submitForm(admin, "Save settings", "Settings saved");
  log("admin updates settings (duplicate window → 0 s for the test)");

  for (const [action, expected] of [
    ["Lunch Out", /Lunch started at/],
    ["Lunch In", /Back from lunch at/],
    ["Clock Out", /Clocked out at/],
  ]) {
    await phone.reload();
    await enterPin(phone, "482913");
    await phone.getByRole("button", { name: action }).click();
    await phone.getByText(expected).waitFor();
  }
  await shot(phone, "07-phone-clocked-out");
  log("phone Lunch Out → Lunch In → Clock Out");

  // ---------- Enforce geofence; GPS rejection; manager exception ----------
  await admin.goto(`${BASE}/admin/settings`);
  await formWith(admin, "Mark coordinates verified").locator('[name="note"]').fill("E2E test: coordinates confirmed on site");
  await submitForm(admin, "Mark coordinates verified", "verified");
  admin.once("dialog", (d) => d.accept());
  await formWith(admin, "Enable enforcement").getByRole("button", { name: "Enable enforcement" }).click();
  await admin.getByText("ENFORCE", { exact: true }).waitFor();
  await shot(admin, "08-admin-settings-enforce");
  log("admin verifies coordinates and enables enforcement");

  const awayCtx = await browser.newContext({ ...PHONE, geolocation: { latitude: 35.5, longitude: -97.6, accuracy: 10 }, permissions: ["geolocation"] });
  const away = await awayCtx.newPage();
  await away.goto(BASE);
  await enterPin(away, jakePin);
  await away.getByRole("button", { name: "Clock In" }).click();
  await away.getByText("Location not verified").waitFor();
  await away.getByText("outside the warehouse area").waitFor();
  await shot(away, "09-phone-gps-rejected");
  await away.getByPlaceholder(/Why can't your location/).fill("Delivering cabinets to a job site this morning");
  await away.getByRole("button", { name: /Submit Clock In for review/ }).click();
  await away.getByText("Sent to a manager for location review.").waitFor();
  await shot(away, "10-phone-exception-submitted");
  log("outside punch rejected; employee submits exception for manager review");

  const mgrCtx = await browser.newContext();
  const mgr = await adminLogin(mgrCtx, "manager1", MANAGER_PW);
  await mgr.goto(`${BASE}/admin/settlement`);
  await mgr.waitForURL(/denied=1/);
  if (await mgr.getByRole("link", { name: "Settlement" }).count()) fail("manager should not see settlement link");
  await mgr.goto(`${BASE}/admin/review`);
  await mgr.getByText("Delivering cabinets to a job site").waitFor();
  await shot(mgr, "11-manager-review");
  await formWith(mgr, "Approve").getByRole("button", { name: "Approve" }).click();
  await mgr.getByText("Nothing to review.").waitFor();
  log("manager blocked from settlement (role check) and approves the exception");

  // ---------- Kiosk mode on a shared tablet ----------
  const tabletCtx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const tabletAdmin = await adminLogin(tabletCtx, "owner", ADMIN_PW);
  await tabletAdmin.goto(`${BASE}/admin/settings`);
  await formWith(tabletAdmin, "Register THIS device as kiosk").locator('[name="name"]').fill("Warehouse Tablet");
  tabletAdmin.once("dialog", (d) => d.accept());
  await formWith(tabletAdmin, "Register THIS device as kiosk").getByRole("button", { name: "Register THIS device as kiosk" }).click();
  await tabletAdmin.getByText("This device is registered as kiosk").waitFor();
  await tabletAdmin.getByRole("button", { name: "Sign out" }).click();
  await tabletAdmin.waitForURL(/\/admin\/login/);
  await tabletAdmin.goto(BASE);
  await tabletAdmin.getByText("Time Clock · Warehouse Tablet").waitFor();
  await enterPin(tabletAdmin, jakePin);
  await tabletAdmin.getByText("Hi, Jake").waitFor();
  await shot(tabletAdmin, "12-kiosk-ready");
  await tabletAdmin.getByRole("button", { name: "Clock Out" }).click();
  await tabletAdmin.getByText(/Clocked out at/).waitFor();
  await shot(tabletAdmin, "13-kiosk-clocked-out");
  log("kiosk registered by admin; employee punches on tablet without phone GPS, history kept");

  // ---------- Corrections + settlement + CSV ----------
  const mariaId = await (async () => {
    await admin.goto(`${BASE}/admin/employees`);
    const href = await admin.getByRole("row", { name: /Lopez/ }).getByRole("link", { name: "Manage" }).getAttribute("href");
    return href.split("/").pop();
  })();
  await admin.goto(`${BASE}/admin/timecards?employee=${mariaId}`);
  const clockInRow = admin.getByRole("row", { name: /Clock In/ }).first();
  await clockInRow.getByText("Edit / void").click();
  const fix = clockInRow.locator("form", { has: admin.getByRole("button", { name: "Save correction" }) });
  const current = await fix.locator('[name="at"]').inputValue();
  const [d, t] = current.split("T");
  const [h, m] = t.split(":").map(Number);
  const later = `${d}T${String(Math.max(h - 1, 0)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  await fix.locator('[name="at"]').fill(later);
  await fix.locator('[name="reason"]').fill("Arrived early to unload truck, confirmed by owner");
  await fix.getByRole("button", { name: "Save correction" }).click();
  await admin.getByText(/Corrected: Arrived early/).waitFor();
  if ((await admin.locator("td.line-through").count()) < 1) fail("original punch should remain visible as voided history");
  await shot(admin, "14-admin-timecard-corrected");
  log("admin corrects a punch; original kept as voided history");

  await admin.goto(`${BASE}/admin/settlement`);
  await admin.getByRole("link", { name: "Lopez, Maria" }).waitFor();
  await admin.getByText("Internal payment estimate only.").first().waitFor();
  await admin.getByText(/Flat rate: total hours × hourly rate/).first().waitFor();
  await shot(admin, "15-admin-settlement");
  const csv = await admin.request.get(`${BASE}/admin/export?kind=summary`);
  const csvText = await csv.text();
  if (!csvText.includes("Lopez") || !csvText.startsWith("Employee Code")) fail("summary CSV missing data");
  if (!csvText.includes("Estimated Amount (internal estimate)") || !csvText.includes("Hours Over 40") || !csvText.includes("Internal payment estimate only")) {
    fail("summary CSV must label the internal estimate and keep hours over 40");
  }
  const qb = await (await admin.request.get(`${BASE}/admin/export?kind=quickbooks`)).text();
  if (!qb.startsWith("Date,Employee,Hours")) fail("QuickBooks CSV header wrong");
  const anon = await phone.request.get(`${BASE}/admin/export?kind=summary`);
  if (anon.status() !== 403) fail("CSV export must require admin");
  const mgrCsv = await mgr.request.get(`${BASE}/admin/export?kind=summary`);
  if (mgrCsv.status() !== 403) fail("CSV export must be admin-only (manager got access)");
  log("settlement shows flat-rate internal estimate label; CSV exports (admin only) keep hours over 40");

  await admin.goto(`${BASE}/admin/audit`);
  for (const action of ["punch.replace", "punch.exception_approve", "kiosk.register", "settings.geofence_mode", "employee.create"]) {
    if (!(await admin.getByRole("cell", { name: action, exact: true }).first().isVisible())) fail(`audit missing ${action}`);
  }
  await shot(admin, "16-admin-audit");
  log("audit log records corrections, reviews and admin changes");

  console.log(`\nAll ${step} end-to-end checks passed.`);
} finally {
  await browser.close();
}
