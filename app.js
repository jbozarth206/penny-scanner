/* Penny Scanner – checks a scanned/typed code against penny-list.json (Home Depot, Lowe's, Dollar General, Walmart) */
'use strict';
const $ = s => document.querySelector(s);
const state = { data: null, items: [], byId: new Map(), bySku: new Map(), byUpc: new Map(), byInet: new Map(), store: 'all', reader: null, scanning: false };
window.pennyState = state; // for debugging/tests

const STORES = {
  home_depot: {name: 'Home Depot', tip: 'Scan the package barcode at self-checkout; the Home Depot app will not show the penny price.'},
  lowes: {name: "Lowe's", tip: "Lowe's “penny” items usually ring up at 2¢ (sometimes 1¢–6¢). Many stores won't sell them; ClearanceFinds suggests a staffed checkout. Match the exact Lowe's item #."},
  dollar_general: {name: 'Dollar General', tip: 'New DG pennies usually go live Tuesday morning. Scan the UPC in the Dollar General app with your store selected before checkout.'},
  walmart: {name: 'Walmart', tip: 'Walmart clearance is store-specific. Scan it in the Walmart app (Check a price) with your Clermont store selected; that is the price the register uses.'},
};
// Lowe's store cities within roughly 45 miles of Clermont, FL (for the "Near Clermont" filter)
const NEAR = ['Clermont', 'Minneola', 'Winter Garden', 'Ocoee', 'Orlando', 'Apopka', 'Kissimmee', 'Davenport', 'Leesburg', 'Mt. Dora', 'Mount Dora', 'Eustis', 'Sanford', 'Wildwood', 'The Villages', 'Lady Lake', 'Winter Haven', 'Altamonte Springs', 'Oviedo', 'Lake Mary', 'Haines City', 'St. Cloud'];
const nearClermont = it => (it.florida_stores || []).filter(s => NEAR.some(c => s.toLowerCase().startsWith(c.toLowerCase() + ',')));
const storeName = k => STORES[k]?.name || k;

const digits = s => String(s || '').replace(/\D/g, '');
const gtinKey = c => { const d = digits(c); return d.length >= 8 && d.length <= 14 ? d.padStart(14, '0') : d; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v => v == null ? '—' : '$' + Number(v).toFixed(2);
const cents = v => v == null ? '—' : (v < 0.1 ? Math.round(v * 100) + '¢' : money(v));
const fmtDate = iso => { if (!iso) return '—'; const [y,m,d] = iso.split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}); };
const daysAgo = iso => { if (!iso) return null; const [y,m,d] = iso.split('-').map(Number); return Math.round((Date.now() - new Date(y, m-1, d)) / 864e5); };
const seen = it => it.last_seen || it.listed || null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2500); }
const storeTag = k => `<span class="tag st ${esc(k)}">${esc(storeName(k))}</span>`;
const isClearance = it => it.store === 'walmart';
const priceShort = it => isClearance(it) ? `${money(it.price)} clearance` : `${cents(it.price ?? 0.01)}`;

// UPC-E (8 digits incl. number system + check) -> UPC-A (12 digits)
function upcEtoA(e) {
  e = digits(e); if (e.length !== 8) return null;
  const ns = e[0], d = e.slice(1, 7), ck = e[7]; let body;
  switch (d[5]) {
    case '0': case '1': case '2': body = d.slice(0,2) + d[5] + '0000' + d.slice(2,5); break;
    case '3': body = d.slice(0,3) + '00000' + d.slice(3,5); break;
    case '4': body = d.slice(0,4) + '00000' + d[4]; break;
    default:  body = d.slice(0,5) + '0000' + d[5];
  }
  return ns + body + ck;
}

const addIdx = (map, key, it) => { if (!key) return; const a = map.get(key) || []; if (!a.includes(it)) a.push(it); map.set(key, a); };
async function loadData() {
  try {
    const r = await fetch('penny-list.json', {cache: 'no-cache'});
    state.data = await r.json();
  } catch (e) { $('#updated').textContent = 'list failed to load'; console.warn('list load failed', e); return; }
  state.items = state.data.items || [];
  for (const it of state.items) {
    it.store = it.store || 'home_depot';
    it.id = it.id || `${it.store}:${it.sku || it.upc || it.name}`;
    state.byId.set(it.id, it);
    addIdx(state.bySku, digits(it.sku), it);
    if (it.upc) addIdx(state.byUpc, gtinKey(it.upc), it);
    for (const u of it.upc_alt || []) addIdx(state.byUpc, gtinKey(u), it);
    if (it.internet_number) addIdx(state.byInet, digits(it.internet_number), it);
  }
  $('#updated').textContent = 'Updated ' + fmtDate(state.data.updated);
  renderList(); renderHistory();
}

/* Returns {status:'match'|'maybe'|'none', matches:[{item, how}], item, how, code} — matches across all stores */
function lookup(raw, format) {
  const code = String(raw || '').trim(); const d = digits(code);
  if (!d) return {status: 'none', code, how: 'no digits in code', matches: []};
  const out = []; const push = (arr, how) => { for (const it of arr || []) if (!out.some(m => m.item === it)) out.push({item: it, how}); };
  const tries = [d];
  if ((format === 'UPC_E' || d.length === 8) && upcEtoA(d)) tries.push(upcEtoA(d));
  for (const t of tries) if (t.length >= 8) push(state.byUpc.get(gtinKey(t)), 'UPC');
  const skuHow = it => ({home_depot: 'Home Depot SKU', lowes: "Lowe's item #", dollar_general: 'listed code', walmart: 'Walmart item ID'})[it.store] || 'SKU';
  for (const k of [d, d.replace(/^0+/, '')]) for (const it of state.bySku.get(k) || []) push([it], skuHow(it));
  if (d.length === 9) push(state.byInet.get(d), 'Home Depot Internet #');
  const base = {code, matches: out};
  if (out.length) return {...base, status: 'match', item: out[0].item, how: out[0].how};
  // Long Code 128 labels (e.g. HD clearance stickers) may embed the 10-digit SKU among other digits.
  if (d.length > 10) {
    for (const [sku, arr] of state.bySku) for (const it of arr)
      if (it.store === 'home_depot' && sku.length === 10 && d.includes(sku)) return {...base, matches: [{item: it, how: 'SKU found inside a longer barcode'}], status: 'maybe', item: it, how: 'SKU found inside a longer barcode'};
  }
  return {...base, status: 'none', how: ''};
}

function priceLine(it) {
  if (it.store === 'walmart') {
    const off = it.pct_off != null ? ` <span class="small mut">(${it.pct_off}% off)</span>` : '';
    return `<b>Clearance</b><span><b style="color:var(--ok)">${money(it.price)}</b> reported${it.retail != null ? ` · ${money(it.retail)} ${esc(it.retail_label || 'regular')}` : ' · no regular price given'}${off}</span>`;
  }
  const p = it.price ?? 0.01;
  return `<b>Price</b><span>${it.retail != null ? money(it.retail) + ' → ' : ''}<b style="color:var(--ok)">${cents(p)}</b> ${it.store === 'lowes' ? 'observed' : 'reported'}</span>`;
}

function itemCard(it, how) {
  const states = Object.entries(it.states || {}).sort((a,b) => b[1]-a[1]).map(([s,n]) => `${s} ${n}`).join(', ');
  const ago = daysAgo(it.last_seen);
  const src = (it.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' · ');
  const upcLine = it.upc
    ? `<code>${esc(it.upc)}</code> <span class="small mut">${it.store === 'home_depot' ? (it.upc_verified ? '✓ matches on 2 sources' : '(1 source: ' + esc((it.upc_sources||[]).join(', ')) + ')') : (it.source_count > 1 ? `listed by ${it.source_count} sources` : '')}</span>`
    : `<span class="mut">${it.store === 'home_depot' ? 'unknown, check by SKU' : 'not published by the source'}</span>`;
  const codeLabel = {home_depot: 'SKU', lowes: "Lowe's item #", dollar_general: 'Code listed', walmart: 'Item ID'}[it.store] || 'SKU';
  const near = nearClermont(it);
  return `<div class="item">
   ${it.image ? `<img src="${esc(it.image)}" alt="" style="float:right;width:84px;height:84px;object-fit:contain;background:#fff;border-radius:10px;margin-left:10px" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
   <div>${storeTag(it.store)}<span class="small mut">${esc(it.brand || it.category || '')}</span></div><h3>${esc(it.name)}</h3>
   <div>${near.length ? `<span class="tag near">Near Clermont: ${esc(near.join('; '))}</span>` : ''}${it.florida_reports ? `<span class="tag fl">FL × ${it.florida_reports}</span>` : ''}${ago > 14 ? `<span class="tag old">older lead: last seen ${ago}d ago</span>` : ''}${it.receipt_verified ? `<span class="tag rc">Receipt-checked</span>` : ''}${it.upc_verified ? '<span class="tag ok">UPC verified</span>' : ''}</div>
   <div class="kv" style="margin-top:8px;clear:both">
    ${it.sku ? `<b>${codeLabel}</b><span><code>${esc(it.sku_display || it.sku)}</code></span>` : ''}
    ${it.model ? `<b>Model</b><span><code>${esc(it.model)}</code></span>` : ''}
    <b>UPC</b><span>${upcLine}</span>
    ${priceLine(it)}
    ${it.reports != null ? `<b>Reports</b><span>${it.reports ?? '—'}${it.state_count != null ? ` in ${it.state_count} states` : ''}</span>` : ''}
    ${states ? `<b>States</b><span class="small">${esc(states)}</span>` : ''}
    ${(it.florida_stores || []).length ? `<b>FL stores</b><span class="small">${esc(it.florida_stores.join('; '))}</span>` : ''}
    <b>${it.store === 'dollar_general' ? 'Listed' : 'Last seen'}</b><span>${fmtDate(seen(it))}${it.last_seen && ago != null ? ` (${ago === 0 ? 'today' : ago + 'd ago'})` : (it.listed && !it.last_seen ? ' (list date; report date not given)' : '')}</span>
    ${it.first_reported && it.first_reported !== it.last_seen ? `<b>First seen</b><span>${fmtDate(it.first_reported)}</span>` : ''}
    ${(it.aka || []).length ? `<b>Also listed as</b><span class="small">${esc(it.aka.join(' · '))}</span>` : ''}
    <b>Source</b><span class="small">${src}</span>
   </div>
   ${it.internet_number ? `<p class="small" style="margin:10px 0 0"><a href="https://www.homedepot.com/p/${esc(it.internet_number)}" target="_blank" rel="noopener">Open on homedepot.com</a></p>` : ''}
   ${it.store === 'walmart' && it.item_id ? `<p class="small" style="margin:10px 0 0"><a href="https://www.walmart.com/ip/${esc(it.item_id)}" target="_blank" rel="noopener">Open on walmart.com</a></p>` : ''}
   ${it.notes ? `<p class="small mut">${esc(it.notes)}</p>` : ''}
   <p class="small" style="margin:8px 0 0">💡 ${esc(STORES[it.store]?.tip || '')}</p>
  </div>`;
}

const NOTE = `<div class="note"><b>Heads up:</b> this checks crowdsourced penny and clearance lists, not the store's register. The real price only shows when the item is scanned at checkout, and stores don't have to sell penny or clearance items.</div>`;

function showResult(res, viaScan) {
  let html;
  const ms = res.matches || (res.item ? [{item: res.item, how: res.how}] : []);
  if (res.status === 'match') {
    const names = [...new Set(ms.map(m => storeName(m.item.store)))].join(' + ');
    const wm = ms.length === 1 && isClearance(ms[0].item);
    const head = wm ? `✅ CLEARANCE LEAD · ${money(ms[0].item.price)}` : '✅ PENNY LIST MATCH';
    html = `<div class="banner ok">${head}<span class="sub">${esc(names)} · matched by ${esc([...new Set(ms.map(m => m.how))].join(', '))} · scanned ${esc(res.code)}</span></div>`
      + (ms.length > 1 ? `<div class="card small">This code is on ${ms.length} lists. Check the one for the store you're in.</div>` : '')
      + ms.map(m => `<div class="card">${itemCard(m.item, m.how)}</div>`).join('');
  } else if (res.status === 'maybe') {
    html = `<div class="banner maybe">⚠️ POSSIBLE MATCH<span class="sub">${esc(storeName(res.item.store))} · ${esc(res.how)}: ${esc(res.code)}. Confirm the SKU on the label.</span></div><div class="card">${itemCard(res.item)}</div>`;
  } else {
    const counts = Object.keys(STORES).map(k => `${state.items.filter(i => i.store === k).length} ${storeName(k)}`).join(', ');
    const noCode = state.items.filter(i => !i.upc).length;
    html = `<div class="banner no">❌ NOT ON LIST<span class="sub">${esc(res.code) || 'empty code'}</span></div>
     <div class="card small">Not found among ${state.items.length} reported items (${esc(counts)}), list updated ${fmtDate(state.data?.updated)}.
     ${noCode ? `${noCode} items have no published UPC (all Lowe's and Walmart items, some Home Depot), so if you scanned a package UPC also type the <b>SKU / Lowe's item # / Walmart item ID</b> from the shelf tag.` : ''}</div>`;
  }
  $('#result').innerHTML = html + NOTE;
  $('#result').scrollIntoView({behavior: 'smooth', block: 'start'});
  addHistory(res);
  if (viaScan && navigator.vibrate) navigator.vibrate(res.status === 'match' ? [80, 60, 80] : 150);
}

/* ---------- history ---------- */
function addHistory(res) {
  const h = JSON.parse(localStorage.getItem('pennyHistory') || '[]');
  const ms = res.matches || [];
  h.unshift({code: res.code, status: res.status, name: res.item ? `${storeName(res.item.store)}: ${res.item.name}${ms.length > 1 ? ` (+${ms.length - 1} more)` : ''}` : '', t: Date.now()});
  localStorage.setItem('pennyHistory', JSON.stringify(h.slice(0, 15))); renderHistory();
}
function renderHistory() {
  const h = JSON.parse(localStorage.getItem('pennyHistory') || '[]');
  $('#history').classList.toggle('hidden', !h.length);
  $('#histList').innerHTML = h.map(x => `<div class="li" style="padding:8px 0" data-code="${esc(x.code)}"><div>${x.status === 'match' ? '✅' : x.status === 'maybe' ? '⚠️' : '❌'}</div><div><div class="t"><code>${esc(x.code)}</code></div><div class="m">${esc(x.name || 'not on list')} · ${new Date(x.t).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}</div></div></div>`).join('');
}
$('#histList').addEventListener('click', e => { const r = e.target.closest('[data-code]'); if (r) showResult(lookup(r.dataset.code)); });

/* ---------- scanner (ZXing, works in iOS Safari without BarcodeDetector) ---------- */
function makeReader() {
  const Z = window.ZXing; const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  return new Z.BrowserMultiFormatReader(hints, 300);
}
async function startScan() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('Live camera needs HTTPS. Use "Scan from photo" or type the code.'); return;
  }
  try {
    state.reader = state.reader || makeReader();
    $('#videoWrap').classList.remove('hidden'); $('#stopBtn').classList.remove('hidden'); $('#startBtn').classList.add('hidden');
    state.scanning = true;
    await state.reader.decodeFromConstraints({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}}, $('#video'), (result, err) => {
      if (result && state.scanning) {
        state.scanning = false; stopScan();
        const fmt = window.ZXing.BarcodeFormat[result.getBarcodeFormat()];
        showResult(lookup(result.getText(), fmt), true);
      }
    });
  } catch (e) {
    console.warn('camera error', e); stopScan();
    toast(e && e.name === 'NotAllowedError' ? 'Camera permission denied. Allow it in Settings › Safari › Camera.' : 'Could not start camera: ' + (e.message || e));
  }
}
function stopScan() {
  state.scanning = false;
  try { state.reader && state.reader.reset(); } catch (_) {}
  $('#videoWrap').classList.add('hidden'); $('#stopBtn').classList.add('hidden'); $('#startBtn').classList.remove('hidden');
}
async function scanPhoto(file) {
  if (!file) return;
  toast('Reading barcode…');
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const reader = makeReader();
  for (const max of [1600, 1000, 2400]) {
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    try {
      const r = await reader.decodeFromImageUrl(c.toDataURL('image/jpeg', 0.92));
      showResult(lookup(r.getText(), window.ZXing.BarcodeFormat[r.getBarcodeFormat()]), true); return;
    } catch (_) {}
  }
  toast('No barcode found in photo. Try closer, flat and sharp, or type the code.');
}

/* ---------- list ---------- */
function renderList() {
  const q = $('#search').value.trim().toLowerCase(), qd = digits(q), sort = $('#sort').value, f = $('#filter').value, st = state.store;
  const inStore = state.items.filter(it => st === 'all' || it.store === st);
  let arr = inStore.filter(it => {
    if (f === 'fl' && !it.florida_reports) return false;
    if (f === 'upc' && !it.upc) return false;
    if (f === 'rc' && !it.receipt_verified) return false;
    if (f === 'near' && !nearClermont(it).length) return false;
    if (!q) return true;
    const hay = `${it.name} ${it.brand || ''} ${it.sku_display || ''} ${it.model || ''} ${it.category || ''} ${(it.aka || []).join(' ')} ${storeName(it.store)}`.toLowerCase();
    return hay.includes(q) || (qd.length >= 3 && (digits(it.sku).includes(qd) || digits(it.upc).includes(qd)));
  });
  const rank = Object.keys(STORES);
  const cmp = {
    reports: (a,b) => (b.reports||0) - (a.reports||0),
    recent: (a,b) => String(seen(b)||'').localeCompare(String(seen(a)||'')),
    fl: (a,b) => nearClermont(b).length - nearClermont(a).length || (b.florida_reports||0) - (a.florida_reports||0) || (b.reports||0) - (a.reports||0),
    price: (a,b) => (b.retail||0) - (a.retail||0),
    name: (a,b) => a.name.localeCompare(b.name),
    store: (a,b) => rank.indexOf(a.store) - rank.indexOf(b.store) || a.name.localeCompare(b.name),
  }[sort];
  arr.sort(cmp);
  const meta = st !== 'all' ? (state.data?.stores || {})[st] : null;
  $('#storeNote').innerHTML = st === 'all'
    ? Object.keys(STORES).map(k => { const m = (state.data?.stores || {})[k]; return m ? `${storeTag(k)} ${m.count} · as of ${fmtDate(m.as_of)}${m.stale ? ' ⚠️ old data' : ''}` : `${storeTag(k)} no current source`; }).join('<br>')
    : meta ? `${esc(meta.note || '')} As of ${fmtDate(meta.as_of)}.${meta.stale ? ' ⚠️ Last refresh failed; showing the previous list.' : ''} ${esc(STORES[st].tip)}` : 'No current source for this store.';
  $('#count').textContent = `${arr.length} of ${inStore.length} ${st === 'all' ? 'items' : storeName(st) + ' items'}`;
  $('#list').innerHTML = arr.map(it => `<div class="li" data-id="${esc(it.id)}">
    ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='icon-192.png'">` : '<img alt="" src="icon-192.png">'}
    <div style="min-width:0"><div class="t">${esc(it.name)}</div>
    <div class="m">${it.sku_display || it.sku ? `<code>${esc(it.sku_display || it.sku)}</code> · ` : ''}${it.upc ? `UPC <code>${esc(it.upc)}</code> · ` : ''}${isClearance(it) ? `<b style="color:var(--ok)">${money(it.price)}</b>${it.retail != null ? ` (was ${money(it.retail)})` : ''}` : `${it.retail != null ? money(it.retail) + ' → ' : ''}${cents(it.price ?? 0.01)}`}${it.reports ? ` · ${it.reports} reports${it.state_count ? ' / ' + it.state_count + ' states' : ''}` : ''} · ${fmtDate(seen(it))}</div>
    <div>${storeTag(it.store)}${nearClermont(it).length ? '<span class="tag near">Near Clermont</span>' : ''}${it.florida_reports ? `<span class="tag fl">FL × ${it.florida_reports}</span>` : ''}${it.receipt_verified ? '<span class="tag rc">Receipt</span>' : ''}${it.upc ? '<span class="tag">UPC</span>' : ''}${daysAgo(it.last_seen) > 14 ? `<span class="tag old">not seen in ${daysAgo(it.last_seen)}d</span>` : ''}</div></div></div>`).join('');
}
$('#list').addEventListener('click', e => { const r = e.target.closest('[data-id]'); if (!r) return; const it = state.byId.get(r.dataset.id); setTab('scan'); showResult({status: 'match', item: it, matches: [{item: it, how: 'list'}], how: 'list', code: it.upc || it.sku || ''}); });
['input', 'change'].forEach(ev => { $('#search').addEventListener(ev, renderList); $('#sort').addEventListener(ev, renderList); $('#filter').addEventListener(ev, renderList); });
function setStore(k) {
  state.store = STORES[k] || k === 'all' ? k : 'all';
  document.querySelectorAll('#storeSeg button').forEach(b => b.classList.toggle('on', b.dataset.store === state.store));
  try { localStorage.setItem('pennyStore', state.store); } catch (_) {}
  renderList();
}
$('#storeSeg').addEventListener('click', e => { const b = e.target.closest('[data-store]'); if (b) setStore(b.dataset.store); });
window.setStore = setStore;
try { const s = localStorage.getItem('pennyStore'); if (s) { state.store = s; document.querySelectorAll('#storeSeg button').forEach(b => b.classList.toggle('on', b.dataset.store === s)); } } catch (_) {}

/* ---------- wiring ---------- */
function setTab(t) {
  $('#tabScan').classList.toggle('on', t === 'scan'); $('#tabList').classList.toggle('on', t === 'list');
  $('#scanView').classList.toggle('hidden', t !== 'scan'); $('#listView').classList.toggle('hidden', t !== 'list');
  if (t !== 'scan') stopScan();
}
$('#tabScan').onclick = () => setTab('scan');
$('#tabList').onclick = () => setTab('list');
$('#startBtn').onclick = startScan;
$('#stopBtn').onclick = stopScan;
$('#photoInput').onchange = e => { scanPhoto(e.target.files[0]); e.target.value = ''; };
$('#manualForm').onsubmit = e => { e.preventDefault(); const v = $('#manual').value; if (v.trim()) showResult(lookup(v)); $('#manual').blur(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });
if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
  // When a new version of the app installs, reload once so the phone shows it right away.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(e => console.warn('sw', e));
}
window.pennyLookup = lookup;
loadData();
