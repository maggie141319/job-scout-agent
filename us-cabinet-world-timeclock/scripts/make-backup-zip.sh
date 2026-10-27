#!/usr/bin/env bash
# Creates a source-code backup ZIP from files tracked by git (so .env files, node_modules,
# build output and database dumps are never included). Output: backups/<name>-<date>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
name="us-cabinet-world-timeclock"
stamp="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p backups
out="backups/${name}-source-${stamp}.zip"
files="$(git ls-files --cached --others --exclude-standard . | grep -vE '(^|/)\.env($|\.)|\.env\.local$|^backups/' | grep -E '.' || true)"
# Keep .env.example (a template without secrets).
files="$(printf '%s\n%s\n' "$files" "$(git ls-files .env.example 2>/dev/null || true)" | sort -u | grep -v '^$')"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/$name"
echo "$files" | while read -r f; do
  [ -f "$f" ] && mkdir -p "$tmp/$name/$(dirname "$f")" && cp "$f" "$tmp/$name/$f"
done
# Safety net: refuse to package anything that looks like a secret file.
if find "$tmp/$name" -name '.env' -o -name '.env.local' -o -name '*.dump' | grep -q .; then
  echo "Refusing to package secret/dump files" >&2
  exit 1
fi
(cd "$tmp" && zip -qr "$OLDPWD/$out" "$name")
echo "Created $out ($(du -h "$out" | cut -f1)), $(unzip -l "$out" | tail -1 | awk '{print $2}') files"
