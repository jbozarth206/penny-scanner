#!/usr/bin/env bash
# Weekly refresh: rebuild penny-list.json and push it to GitHub Pages if it changed.
# Usage: ./deploy.sh [update_list.py args, e.g. --report-week 2026-10-26]
set -euo pipefail
cd "$(dirname "$0")"
python3 update_list.py "$@"
git add penny-list.json
[ -f manual_overrides.json ] && git add manual_overrides.json
if git diff --cached --quiet; then
  echo "penny-list.json unchanged; nothing to deploy."
  exit 0
fi
git commit -m "Weekly penny list refresh $(date +%Y-%m-%d)"
git push origin main
echo "Pushed. Live in ~1 min at https://jbozarth206.github.io/penny-scanner/"
