# Penny Scanner (Home Depot Clermont #6375)

Static PWA: scan a barcode (or take a photo, or type a SKU/UPC) and check it against the crowdsourced Home Depot penny list.

Files: index.html, app.js, vendor/zxing.min.js (@zxing/library 0.21.3, vendored), penny-list.json, manifest.webmanifest,
sw.js (offline cache), icon-192/512.png, apple-touch-icon.png, update_list.py (weekly refresh), raw/ (cached source pages, don't deploy).

Weekly refresh:  python3 update_list.py --report-week <latest Monday with a Penny Recon report>
Local test:      python3 -m http.server 8000   (camera works on http://localhost only; iPhone needs HTTPS)
Tests:           /home/box/pwvenv/bin/python /workspace/penny-test/test.py

Deploy only: index.html app.js sw.js manifest.webmanifest penny-list.json *.png vendor/
After refreshing the list, bump CACHE in sw.js only if app files change (penny-list.json is network-first).
