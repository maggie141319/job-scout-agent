#!/usr/bin/env bash
# Production data backup: pg_dump custom-format archive of the database in DATABASE_URL.
# Output goes to backups/ (git-ignored). Store copies somewhere safe and private; they
# contain payroll and personal data. Never commit them.
#   DATABASE_URL=... bash scripts/backup-db.sh
# Restore into an EMPTY database:
#   pg_restore --no-owner --no-privileges -d "$TARGET_DATABASE_URL" backups/<file>.dump
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
mkdir -p backups
out="backups/timeclock-db-$(date -u +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
echo "Wrote $out ($(du -h "$out" | cut -f1)). Verify with: pg_restore --list $out | head"
