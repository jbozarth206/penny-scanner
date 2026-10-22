/* Penny Scanner – checks a scanned/typed code against penny-list.json */
'use strict';
const $ = s => document.querySelector(s);
const state = { data: null, items: [], bySku: new Map(), byUpc: new Map(), byInet: new Map(), reader: null, scanning: false };
window.pennyState = state; // for debugging/tests

const digits = s => String(s || '').replace(/\D/g, '');
const gtinKey = c => { const d = digits(c); return d.length >= 8 && d.length <= 14 ? d.padStart(14, '0') : d; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v => v == null ? '—' : '$' + Number(v).toFixed(2);
const fmtDate = iso => { if (!iso) return '—'; const [y,m,d] = iso.split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}); };
const daysAgo = iso => { if (!iso) return null; const [y,m,d] = iso.split('-').map(Number); return Math.round((Date.now() - new Date(y, m-1, d)) / 864e5); };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2500); }

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

async function loadData() {
  try {
    const r = await fetch('penny-list.json', {cache: 'no-cache'});
    state.data = await r.json();
  } catch (e) { $('#updated').textContent = 'list failed to load'; console.warn('list load failed', e); return; }
  state.items = state.data.items || [];
  for (const it of state.items) {
    state.bySku.set(digits(it.sku), it);
    if (it.upc) state.byUpc.set(gtinKey(it.upc), it);
    for (const u of it.upc_alt || []) state.byUpc.set(gtinKey(u), it);
    if (it.internet_number) state.byInet.set(digits(it.internet_number), it);
  }
  $('#updated').textContent = 'List updated ' + fmtDate(state.data.updated);
  renderList(); renderHistory();
}

/* Returns {status:'match'|'maybe'|'none', item, how, code} */
function lookup(raw, format) {
  const code = String(raw || '').trim(); const d = digits(code);
  if (!d) return {status: 'none', code, how: 'no digits in code'};
  const tries = [d];
  if ((format === 'UPC_E' || d.length === 8) && upcEtoA(d)) tries.push(upcEtoA(d));
  for (const t of tries) {
    if (t.length >= 8 && state.byUpc.has(gtinKey(t))) return {status: 'match', item: state.byUpc.get(gtinKey(t)), how: 'UPC', code};
  }
  if (state.bySku.has(d)) return {status: 'match', item: state.bySku.get(d), how: 'SKU', code};
  // 10-digit SKUs typed with a leading zero or 6-digit SKUs padded
  const noLead = d.replace(/^0+/, '');
  if (noLead !== d && state.bySku.has(noLead)) return {status: 'match', item: state.bySku.get(noLead), how: 'SKU', code};
  if (d.length === 9 && state.byInet.has(d)) return {status: 'match', item: state.byInet.get(d), how: 'Home Depot Internet #', code};
  // Long Code 128 labels (e.g. clearance stickers) may embed the 10-digit SKU among other digits.
  if (d.length > 10) {
    for (const [sku, it] of state.bySku) if (sku.length === 10 && d.includes(sku)) return {status: 'maybe', item: it, how: 'SKU found inside a longer barcode', code};
  }
  return {status: 'none', code, how: ''};
}

function itemCard(it) {
  const states = Object.entries(it.states || {}).sort((a,b) => b[1]-a[1]).map(([s,n]) => `${s} ${n}`).join(', ');
  const ago = daysAgo(it.last_seen);
  const src = (it.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' · ');
  const upcLine = it.upc ? `<code>${esc(it.upc)}</code> <span class="small mut">${it.upc_verified ? '✓ matches on 2 sources' : '(1 source: ' + esc((it.upc_sources||[]).join(', ')) + ')'}</span>` : '<span class="mut">unknown, check by SKU</span>';
  return `<div class="item">
   ${it.image ? `<img src="${esc(it.image)}" alt="" style="float:right;width:84px;height:84px;object-fit:contain;background:#fff;border-radius:10px;margin-left:10px" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
   <div class="small mut">${esc(it.brand || '')}</div><h3>${esc(it.name)}</h3>
   <div>${it.florida_reports ? `<span class="tag fl">FL × ${it.florida_reports}</span>` : ''}${daysAgo(it.last_seen) > 14 ? `<span class="tag old">older lead: last seen ${daysAgo(it.last_seen)}d ago</span>` : ''}${it.receipt_verified ? `<span class="tag rc">Receipt-checked</span>` : ''}${it.upc_verified ? '<span class="tag ok">UPC verified</span>' : ''}</div>
   <div class="kv" style="margin-top:8px;clear:both">
    <b>SKU</b><span><code>${esc(it.sku_display || it.sku)}</code></span>
    <b>UPC</b><span>${upcLine}</span>
    <b>Retail</b><span>${money(it.retail)} → <b style="color:var(--ok)">$0.01</b> reported</span>
    <b>Reports</b><span>${it.reports ?? '—'} in ${it.state_count ?? Object.keys(it.states||{}).length} states</span>
    <b>States</b><span class="small">${esc(states) || '—'}</span>
    <b>Last seen</b><span>${fmtDate(it.last_seen)}${ago != null ? ` (${ago === 0 ? 'today' : ago + 'd ago'})` : ''}</span>
    <b>First seen</b><span>${fmtDate(it.first_reported)}</span>
    <b>Source</b><span class="small">${src}</span>
   </div>
   ${it.internet_number ? `<p class="small" style="margin:10px 0 0"><a href="https://www.homedepot.com/p/${esc(it.internet_number)}" target="_blank" rel="noopener">Open on homedepot.com</a></p>` : ''}
   ${it.notes ? `<p class="small">${esc(it.notes)}</p>` : ''}
  </div>`;
}

const NOTE = `<div class="note"><b>Heads up:</b> this checks the crowdsourced penny list, not Home Depot's register. The real price only shows when the item is scanned at checkout, and stores don't have to sell penny items.</div>`;

function showResult(res, viaScan) {
  let html;
  if (res.status === 'match') {
    html = `<div class="banner ok">✅ PENNY LIST MATCH<span class="sub">Matched by ${esc(res.how)} · scanned ${esc(res.code)}</span></div><div class="card">${itemCard(res.item)}</div>`;
  } else if (res.status === 'maybe') {
    html = `<div class="banner maybe">⚠️ POSSIBLE MATCH<span class="sub">${esc(res.how)}: ${esc(res.code)}. Confirm the SKU on the label.</span></div><div class="card">${itemCard(res.item)}</div>`;
  } else {
    const noUpc = state.items.filter(i => !i.upc).length;
    html = `<div class="banner no">❌ NOT ON LIST<span class="sub">${esc(res.code) || 'empty code'}</span></div>
     <div class="card small">Not found among ${state.items.length} reported penny items (as of ${fmtDate(state.data?.updated)}).
     ${noUpc ? `${noUpc} items on the list have no known UPC, so if you scanned a package UPC, also type the <b>SKU</b> from the shelf tag or sticker.` : ''}</div>`;
  }
  $('#result').innerHTML = html + NOTE;
  $('#result').scrollIntoView({behavior: 'smooth', block: 'start'});
  addHistory(res);
  if (viaScan && navigator.vibrate) navigator.vibrate(res.status === 'match' ? [80, 60, 80] : 150);
}

/* ---------- history ---------- */
function addHistory(res) {
  const h = JSON.parse(localStorage.getItem('pennyHistory') || '[]');
  h.unshift({code: res.code, status: res.status, name: res.item?.name || '', t: Date.now()});
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
  const q = $('#search').value.trim().toLowerCase(), qd = digits(q), sort = $('#sort').value, f = $('#filter').value;
  let arr = state.items.filter(it => {
    if (f === 'fl' && !it.florida_reports) return false;
    if (f === 'upc' && !it.upc) return false;
    if (f === 'rc' && !it.receipt_verified) return false;
    if (!q) return true;
    const hay = `${it.name} ${it.brand} ${it.sku_display} ${it.model || ''}`.toLowerCase();
    return hay.includes(q) || (qd.length >= 3 && (digits(it.sku).includes(qd) || digits(it.upc).includes(qd)));
  });
  const cmp = {
    reports: (a,b) => (b.reports||0) - (a.reports||0),
    recent: (a,b) => String(b.last_seen||'').localeCompare(String(a.last_seen||'')),
    fl: (a,b) => (b.florida_reports||0) - (a.florida_reports||0) || (b.reports||0) - (a.reports||0),
    price: (a,b) => (b.retail||0) - (a.retail||0),
    name: (a,b) => a.name.localeCompare(b.name),
  }[sort];
  arr.sort(cmp);
  $('#count').textContent = `${arr.length} of ${state.items.length} items · reported in last ${state.data?.window_days || 30} days`;
  $('#list').innerHTML = arr.map(it => `<div class="li" data-sku="${esc(it.sku)}">
    ${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='icon-192.png'">` : '<img alt="" src="icon-192.png">'}
    <div style="min-width:0"><div class="t">${esc(it.name)}</div>
    <div class="m"><code>${esc(it.sku_display)}</code> · ${money(it.retail)} · ${it.reports || 0} reports / ${it.state_count || 0} states · ${fmtDate(it.last_seen)}</div>
    <div>${it.florida_reports ? `<span class="tag fl">FL × ${it.florida_reports}</span>` : ''}${it.receipt_verified ? '<span class="tag rc">Receipt</span>' : ''}${it.upc ? '<span class="tag">UPC</span>' : ''}${daysAgo(it.last_seen) > 14 ? `<span class="tag old">not seen in ${daysAgo(it.last_seen)}d</span>` : ''}</div></div></div>`).join('');
}
$('#list').addEventListener('click', e => { const r = e.target.closest('[data-sku]'); if (!r) return; setTab('scan'); showResult({status: 'match', item: state.bySku.get(r.dataset.sku), how: 'list', code: r.dataset.sku}); });
['input', 'change'].forEach(ev => { $('#search').addEventListener(ev, renderList); $('#sort').addEventListener(ev, renderList); $('#filter').addEventListener(ev, renderList); });

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
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
window.pennyLookup = lookup;
loadData();
