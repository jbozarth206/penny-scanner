#!/usr/bin/env bash
# Weekly refresh: rebuild penny-list.json for all stores (Home Depot, Lowe's, Dollar General, Walmart)
# and push it to GitHub Pages if it changed. A store whose source breaks keeps its previous data;
# if every store fails, update_list.py exits non-zero and nothing is pushed.
# Usage: ./deploy.sh [update_list.py args]
#   ./deploy.sh                                   # all stores
#   ./deploy.sh --report-week 2026-10-26          # + Penny Recon receipts report for that Monday (HD)
#   ./deploy.sh --stores dollar_general,walmart   # only refresh some stores
set -euo pipefail
cd "$(dirname "$0")"
python3 update_list.py "$@"
git add penny-list.json
[ -f manual_overrides.json ] && git add manual_overrides.json
if git diff --cached --quiet; then
  echo "penny-list.json unchanged; nothing to deploy."
  exit 0
fi
git commit -m "Weekly penny/clearance list refresh $(date +%Y-%m-%d)"
git push origin main
echo "Pushed. Live in ~1 min at https://jbozarth206.github.io/penny-scanner/"
