#!/usr/bin/env node
// Creates (or resets the password of) an administrator account.
// Usage: npm run admin:create            (interactive prompts; password is not echoed)
//        npm run admin:create -- --role manager
// Non-interactive (CI/test only): ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_DISPLAY_NAME env vars.
import { randomBytes, scrypt } from "node:crypto";
import readline from "node:readline";
import pg from "pg";
import { loadEnvFile } from "./load-env.mjs";

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}
const roleArg = process.argv.indexOf("--role");
const role = roleArg > -1 ? process.argv[roleArg + 1] : "admin";
if (!["admin", "manager"].includes(role)) {
  console.error("--role must be admin or manager");
  process.exit(1);
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// Must match lib/security.ts hashPassword().
function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`),
    ),
  );
}

const username = (process.env.ADMIN_USERNAME ?? (await ask("Username: "))).toLowerCase();
const displayName = process.env.ADMIN_DISPLAY_NAME ?? ((await ask("Display name: ")) || username);
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await ask("Password (min 12 chars): ", { hidden: true });
  const confirm = await ask("Confirm password: ", { hidden: true });
  if (password !== confirm) {
    console.error("Passwords do not match.");
    process.exit(1);
  }
}
if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
  console.error("Username must be 3-64 characters: letters, digits, . _ -");
  process.exit(1);
}
if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const hash = await hashPassword(password);
  const res = await client.query(
    `insert into admin_users (username, display_name, password_hash, role)
     values ($1, $2, $3, $4)
     on conflict (username) do update set password_hash = excluded.password_hash, role = excluded.role,
       display_name = excluded.display_name, active = true, failed_logins = 0, locked_until = null, updated_at = now()
     returning id, (xmax = 0) as inserted`,
    [username, displayName, hash, role],
  );
  const { id, inserted } = res.rows[0];
  await client.query(
    `insert into audit_log (actor_type, actor_label, action, entity_type, entity_id, after)
     values ('system', 'create-admin script', $1, 'admin_user', $2, $3)`,
    [inserted ? "admin_user.create" : "admin_user.reset_password", id, JSON.stringify({ username, role })],
  );
  console.log(`${inserted ? "Created" : "Updated"} ${role} account "${username}".`);
} finally {
  await client.end();
}
