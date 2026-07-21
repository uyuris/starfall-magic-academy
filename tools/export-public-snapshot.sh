#!/usr/bin/env bash
# Export a public snapshot of the committed main tree to the public GitHub repo.
#
# The public repository carries an independent snapshot history: each run adds one
# "Public snapshot" commit whose tree is the current main tree minus internal
# development-harness files. It never publishes the working history of this
# repository.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
EXPORT_DIR="${ROOT}/../starfall-public-export"
REMOTE_URL="git@github.com-uyuris-mag-adv:uyuris/starfall-magic-academy.git"

# Internal development-harness paths excluded from the public snapshot.
EXCLUDES=(
  ".agents"
  ".claude"
  ".codex"
  ".envrc"
  "AGENTS.md"
  "CLAUDE.md"
  "Makefile"
  "mk"
  "work"
)

SRC_SHA=$(git -C "$ROOT" rev-parse main)
SNAPSHOT_DATE=$(date -u +%Y-%m-%d)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git -C "$ROOT" archive main | tar -x -C "$TMP"
for entry in "${EXCLUDES[@]}"; do
  rm -rf "${TMP:?}/${entry}"
done

if [ ! -d "$EXPORT_DIR/.git" ]; then
  git init -b main "$EXPORT_DIR"
fi

rsync -a --delete --exclude .git "$TMP/" "$EXPORT_DIR/"

cd "$EXPORT_DIR"
git add -A
if git diff --cached --quiet && git rev-parse -q --verify HEAD >/dev/null; then
  echo "public snapshot: no changes against previous snapshot (source ${SRC_SHA})"
  exit 0
fi
git commit -m "Public snapshot ${SNAPSHOT_DATE} (source ${SRC_SHA:0:12})"

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$REMOTE_URL"
fi

REMOTE_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
if [ -z "$REMOTE_SHA" ]; then
  git push -u origin main
else
  git push --force-with-lease="refs/heads/main:${REMOTE_SHA}" origin main
fi

echo "public snapshot pushed: $(git rev-parse HEAD) (source ${SRC_SHA})"
