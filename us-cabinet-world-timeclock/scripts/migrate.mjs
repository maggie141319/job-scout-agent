#!/usr/bin/env node
// Applies SQL files in db/migrations in filename order, once each, inside transactions.
// Usage: DATABASE_URL=... node scripts/migrate.mjs   (reads .env.local if present)
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvFile } from "./load-env.mjs";

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export async function migrate(connectionString, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`);
    // Serialize concurrent runs.
    await client.query("select pg_advisory_lock(727274)");
    const applied = new Set((await client.query("select version from schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    log("migrations up to date");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
