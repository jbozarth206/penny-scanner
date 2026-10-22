# Penny Scanner (Clermont, FL: Home Depot, Lowe's, Dollar General, Walmart)

Static PWA: scan a barcode (or take a photo, or type a UPC / SKU / Lowe's item # / Walmart item ID) and check it
against crowdsourced penny lists (Home Depot, Lowe's, Dollar General) and Walmart clearance leads.
Every item has a store, a date and its source URL(s). Nothing is invented: codes and prices come from the sources.

Files: index.html, app.js, vendor/zxing.min.js (@zxing/library 0.21.3, vendored), penny-list.json (schema 2, all stores),
manifest.webmanifest, sw.js (offline cache), icons, update_list.py (refresh, Home Depot fetcher + combiner),
store_fetchers.py (Dollar General, Lowe's, Walmart fetchers), deploy.sh, raw/ (cached source pages, not deployed).

Sources
- Home Depot: PennyCentral, Penny Recon (+ weekly receipts report)
- Dollar General: Penny General (pennygeneral.net, this penny week's lists), PennyPinchinMom, GlitchNDealz
- Lowe's: ClearanceFinds monthly Lowe's penny list (item #, observed 1-6 cent prices, dated store rows)
- Walmart: GlitchNDealz dated in-store clearance posts (item ID + clearance and comparison price). No free source
  publishes store-level Walmart hidden clearance for Clermont; RebelSavings (free, but JS + Turnstile) and the
  Walmart app's "Check a price" scanner are the manual options.

Weekly refresh:  ./deploy.sh [--report-week <latest Monday with a Penny Recon report>]
Local test:      python3 -m http.server 8000   (camera works on http://localhost only; iPhone needs HTTPS)
Tests:           /home/box/pwvenv/bin/python /workspace/penny-test/test.py   (URL=... to test the live site)

Bump CACHE in sw.js whenever app files (index.html, app.js, sw.js, manifest) change; penny-list.json is network-first.
