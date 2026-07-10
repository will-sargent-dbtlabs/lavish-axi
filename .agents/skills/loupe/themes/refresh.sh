#!/usr/bin/env bash
# refresh.sh — re-sync shared non-aurora theme shells from lavish-themes.
#
# The fork (will-sargent-dbtlabs/lavish-themes) is the source of truth for
# shared themes only. The Loupe aurora pair is owned by this skill/repo and is
# deliberately excluded so refreshes never overwrite it.
#
# Idempotent. Clones the fork if it isn't checked out yet.
set -euo pipefail

THEMES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${LAVISH_THEMES_DIR:-$HOME/code/will-sargent-dbtlabs/lavish-themes}"
REPO_URL="${LAVISH_THEMES_REPO_URL:-https://github.com/will-sargent-dbtlabs/lavish-themes.git}"

if [[ -d "$REPO_DIR/.git" ]]; then
  echo "Updating $REPO_DIR..."
  git -C "$REPO_DIR" pull --ff-only --quiet
else
  echo "Cloning $REPO_URL -> $REPO_DIR..."
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi

shared_tier1=(latex terminal water)
shared_tier2=(dbt-brief dbt-brief-dashboard handwritten lavish-light swiss zine)

for theme in "${shared_tier1[@]}"; do
  cp "$REPO_DIR/tier1/$theme.html" "$THEMES_DIR/"
done

for theme in "${shared_tier2[@]}"; do
  cp "$REPO_DIR/tier2/$theme.html" "$THEMES_DIR/"
done

cp "$REPO_DIR/THIRD-PARTY-NOTICES.md" "$THEMES_DIR/"

echo "Synced themes into $THEMES_DIR:"
printf '  %s\n' "${shared_tier1[@]/%/.html}" "${shared_tier2[@]/%/.html}"
echo "Preserved Loupe-owned themes:"
printf '  %s\n' loupe-aurora.html loupe-aurora-light.html
