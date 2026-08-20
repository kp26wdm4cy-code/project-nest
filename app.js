// Project Nest — shared front-end wired to the persistent backend (server.mjs).
// Data lives in SQLite on the server; this file only reads and writes via /api.

const PEOPLE = ['Ralf', 'Hannah'];
const MODES = ['buy', 'rent'];
const ui = JSON.parse(localStorage.getItem('nest-ui') || '{}');
ui.person = PEOPLE.includes(ui.person) ? ui.person : 'Ralf';
ui.filter ||= 'queue';
ui.mode = MODES.includes(ui.mode) ? ui.mode : 'buy';   // Buy vs Rent — a top-level view switch
ui.moveFrom ||= '';    // move-in window filter (ISO dates, '' = open)
ui.moveTo ||= '';
ui.compareOpen ??= false;   // smart keeper comparison panel open/closed
const saveUi = () => localStorage.setItem('nest-ui', JSON.stringify(ui));

let allProperties = [];   // every home from the server (both buy and rent)
let properties = [];      // current-mode slice — everything downstream reads this
let selectedId = null;
let currentUser = null;   // the signed-in user ({id,email,name}); ui.person = their name
let currentWorkspace = null;  // { id, name } — this user's household space
let spacePeople = [];     // members + pending invites of the current space
let map, markers = {};
let galShots = [], galIndex = 0;  // current gallery images for the full-screen viewer
let districtLayer = null, selectedDistricts = new Set(), areaMode = false, saveDistTimer;
let destinations = [], subscribedEmails = [];
let briefs = { buy: { maxPrice: 550000, minPrice: 120000, beds: [1, 2] }, rent: { maxPrice: 2500, minPrice: 800, beds: [1, 2] } };
let allowedUsers = [];   // emails permitted to sign in ({email,name}) — host only
let isHost = false;      // whether the signed-in user administers the global sign-in list

const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);
// Rentals carry a monthly price; sales an outright price. One label formatter for both.
const isRent = p => (p && p.listing_type) === 'rent';
const priceLabel = p => isRent(p) ? `${money(p.price)} pcm` : money(p.price);
const byId = id => properties.find(p => p.id === id);
// Pass is a shared veto: if ANYONE has passed a home it counts as Passed for everyone
// (out of the queue/keepers, hidden from the map). Otherwise it's this person's own
// verdict. Each person's reaction buttons still reflect their own choice (p.mine).
const statusOf = p => (p.feedback || []).some(f => f.verdict === 'Pass') ? 'Pass' : (p.mine?.verdict || 'queue');
// Other signed-in people's verdicts on this home (everyone except you).
const othersVerdicts = p => (p.feedback || []).filter(f => f.person !== ui.person && f.verdict);
const othersInline = p => { const o = othersVerdicts(p); return o.length ? `${o[0].person}: ${verdictText(o[0].verdict)}${o.length > 1 ? ` +${o.length - 1}` : ''}` : ''; };
const othersDetail = p => othersVerdicts(p).map(f => `${f.person} said ${verdictText(f.verdict)}${f.note ? `: “${f.note}”` : '.'}`).join(' ');
const label = status => ({ queue: 'To review', Love: 'Keeper', View: 'Worth viewing', Watch: 'Watch', Pass: 'Passed' })[status] || status;
const verdictText = v => ({ Love: '♥ Love it', View: '✓ Would view', Watch: '◌ Watch', Pass: '× Forget it' })[v] || v;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysSince = iso => { const d = new Date(iso); return isNaN(d) ? null : Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000)); };
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtMonth = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); };
const compactGbp = n => n >= 1e6 ? '£' + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'm' : '£' + Math.round(n / 1000) + 'k';
// Map pins + list dots are coloured by verdict: love=vivid green, view=light green,
// watch=faint yellow, forget=grey, not-yet-reviewed=neutral.
const markerClass = p => ({ Love: 'v-love', View: 'v-view', Watch: 'v-watch', Pass: 'v-pass' })[statusOf(p)] || 'v-queue';

const AVAIL = {
  available: { text: 'Available', cls: 'ok' },
  'off-market': { text: 'Off-market', cls: 'off' },
  'needs-check': { text: 'Needs check', cls: 'warn' },
};
const availInfo = p => AVAIL[p.availability] || AVAIL.available;
function whenChecked(iso) {
  if (!iso) return 'not yet checked';
  const d = new Date(iso);
  return 'checked ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
// Move-in availability: a listing's available-from date (mostly rentals).
const todayISO = () => new Date().toISOString().slice(0, 10);
function availWhen(p) {
  const a = p.available_from;
  if (!a) return null;
  return a <= todayISO() ? 'Available now' : 'From ' + fmtDate(a);
}
const availChip = p => { const w = availWhen(p); return w ? `<i class="movein">🗓️ ${w}</i>` : ''; };
// Move-in window filter: keep a home if its available-from date falls inside [from, to].
// Homes with no stated date are kept (we can't judge them). Available-now counts as "today".
function inMoveWindow(p) {
  const from = ui.moveFrom, to = ui.moveTo;
  if (!from && !to) return true;
  const a = p.available_from;
  if (!a) return true;
  if (from && a < from) return false;   // free before the window opens — too soon
  if (to && a > to) return false;       // not free until after it closes — too late
  return true;
}
const moveFilterOn = () => !!(ui.moveFrom || ui.moveTo);

// ---- area intelligence ---------------------------------------------------
// Rendered from LIVE data computed server-side (HM Land Registry, OpenStreetMap,
// TfL, Police.uk, Environment Agency), cached per property, arriving as `insights`.
// Scores are derived indicators, not financial advice.
const asOf = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const walkMin = m => Math.max(1, Math.round(m / 80)) + ' min walk';

// A single-series area/line sparkline — one hue, direct end-marker, no legend.
function sparkline(series) {
  const w = 320, h = 92, pad = 8;
  const min = Math.min(...series), max = Math.max(...series);
  const xx = i => pad + i * (w - 2 * pad) / (series.length - 1);
  const yy = v => (h - pad) - ((v - min) / ((max - min) || 1)) * (h - 2 * pad);
  const pts = series.map((v, i) => `${xx(i).toFixed(1)},${yy(v).toFixed(1)}`);
  const area = `M${xx(0).toFixed(1)},${(h - pad).toFixed(1)} L${pts.join(' L')} L${xx(series.length - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const lx = xx(series.length - 1), ly = yy(series[series.length - 1]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Local average price index over the period">
    <defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ea573" stop-opacity=".38"/><stop offset="1" stop-color="#7ea573" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#sparkfill)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#285b43" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="#285b43" stroke="#fff" stroke-width="1.6"/>
  </svg>`;
}

function headlineFor(p, d) {
  const bits = [];
  if (d.price) bits.push(`local flat prices ${d.price.changePct >= 0 ? 'up' : 'down'} ${Math.abs(d.price.changePct)}% since ${d.price.fromYear}`);
  if (d.nearestStation) bits.push(`${d.nearestStation.name} ${d.nearestStation.distM}m away`);
  const lead = d.district || p.area;
  return bits.length ? `${lead}: ${bits.join(', ')}.` : `${lead}: live area read below.`;
}

// Dot plot of comparable sold prices over time (last N years), with this home's asking
// price as the baseline. One glance shows level (dots vs the line), trend (their slope)
// and liquidity/resellability (how many dots there are). Native <title> gives per-dot hover.
function compsChart(comps, asking) {
  const sales = (comps.sales || []).filter(s => s.price && s.date);
  if (!sales.length) return '';
  const win = comps.windowYears || 5;
  const W = 660, H = 240, padL = 50, padR = 14, padT = 14, padB = 24;
  const yearMs = 365.25 * 864e5, now = Date.now();
  const x0 = now - win * yearMs, x1 = now;
  const xs = d => padL + (new Date(d).getTime() - x0) / (x1 - x0) * (W - padL - padR);
  const prices = sales.map(s => s.price).concat(asking ? [asking] : []);
  const step = 25000;
  const yMin = Math.floor(Math.min(...prices) * 0.96 / step) * step;
  let yMax = Math.ceil(Math.max(...prices) * 1.04 / step) * step;
  if (yMax <= yMin) yMax = yMin + step;
  const ys = p => padT + (1 - (p - yMin) / (yMax - yMin)) * (H - padT - padB);
  const yticks = [yMin, (yMin + yMax) / 2, yMax];
  const grid = yticks.map(v => `<line class="cc-grid" x1="${padL}" x2="${W - padR}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"/>`).join('');
  const ylab = yticks.map(v => `<text class="cc-ylab" x="${padL - 8}" y="${(ys(v) + 3).toFixed(1)}" text-anchor="end">${compactGbp(v)}</text>`).join('');
  let xlab = '';
  for (let y = new Date(x0).getFullYear() + 1; y <= new Date(x1).getFullYear(); y++) {
    const t = new Date(Date.UTC(y, 0, 1)).getTime();
    if (t >= x0 && t <= x1) xlab += `<text class="cc-xlab" x="${xs(t).toFixed(1)}" y="${H - 7}" text-anchor="middle">${y}</text>`;
  }
  const askEls = asking
    ? `<line class="cc-ask" x1="${padL}" x2="${W - padR}" y1="${ys(asking).toFixed(1)}" y2="${ys(asking).toFixed(1)}"/><text class="cc-asklab" x="${padL + 3}" y="${Math.max(ys(asking) - 6, padT + 9).toFixed(1)}">This home · ${money(asking)}</text>` : '';
  const dots = sales.map(s => `<circle class="cc-dot" cx="${xs(s.date).toFixed(1)}" cy="${ys(s.price).toFixed(1)}" r="4.5"><title>${money(s.price)} · ${fmtMonth(s.date)}${s.label ? ' · ' + esc(s.label) : ''}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="comps-chart" role="img" aria-label="Comparable sold prices over the last ${win} years versus this home's asking price of ${money(asking)}; ${sales.length} sales plotted.">${grid}${ylab}${xlab}${askEls}${dots}</svg>`;
}
// Compact "market snapshot" stat card shown to the right of the comps chart.
function compsSummary(comps, asking) {
  const prices = (comps.sales || []).map(s => s.price).filter(Boolean);
  const lo = Math.min(...prices), hi = Math.max(...prices), n = comps.count;
  const pct = (asking && comps.median) ? Math.round((asking / comps.median - 1) * 100) : null;
  const pctTxt = pct == null ? '—' : pct === 0 ? 'in line' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
  const pctCls = pct == null ? '' : pct >= 5 ? 'prem' : pct <= -5 ? 'val' : '';
  const liq = n >= 9 ? 'Active market' : n >= 4 ? 'Steady market' : 'Thin market';
  const rows = [
    ['Median (5 yr)', money(comps.median)],
    ['This home', `${money(asking)} <i class="snap-pct ${pctCls}">${pctTxt}</i>`],
    ['Sold range', `${compactGbp(lo)}–${compactGbp(hi)}`],
    ['Activity', `${n} sale${n === 1 ? '' : 's'} · ${liq}`],
  ];
  return `<p class="ic-kicker">MARKET SNAPSHOT</p><div class="snap">${rows.map(([k, v]) => `<div class="snap-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;
}
function compsRead(comps, asking) {
  const n = comps.count, med = comps.median, win = comps.windowYears || 5;
  const liq = n >= 9 ? 'an active local resale market' : n >= 4 ? 'a steady resale market' : 'a thin market — few recent comparable sales, so a resale can take longer';
  let vs = 'about in line with';
  if (asking && med) { const pct = Math.round((asking / med - 1) * 100); if (Math.abs(pct) >= 2) vs = `${Math.abs(pct)}% ${pct > 0 ? 'above' : 'below'}`; }
  return `Asking ${money(asking)} is ${vs} the ${win}-year median (${money(med)}) of ${n} comparable sale${n === 1 ? '' : 's'} — ${liq}.`;
}
function renderInsights() {
  const box = document.getElementById('areaInsights');
  if (!box) return;
  const p = byId(selectedId);
  if (!p) { box.innerHTML = ''; return; }
  const d = p.insights;
  if (!d) {
    box.innerHTML = `<div class="insight-head"><p class="kicker">AREA INTELLIGENCE</p>
      <h3>Live area data isn't compiled for this home yet.</h3></div>
      <p class="insight-foot">Press "Check listings now" to pull it in (Land Registry, OpenStreetMap, TfL, Police.uk, Environment Agency) — it then fills automatically after each listings check.</p>`;
    return;
  }
  const price = d.price;
  const chg = price ? price.changePct : null;
  const chgClass = chg == null ? '' : chg < 0 ? 'neg' : 'pos';
  const chgText = chg == null ? '' : (chg >= 0 ? '+' : '−') + Math.abs(chg) + '%';
  const priceCard = price
    ? `<p class="ic-kicker">LOCAL PRICE TREND <span>· ${d.district || ''}</span></p>
       <div class="ic-figure"><span class="ic-big ${chgClass}">${chgText}</span><span class="ic-sub">since ${price.fromYear} · avg now ${money(price.avgNow)}</span></div>
       ${sparkline(price.index.map(x => x.v))}`
    : `<p class="ic-kicker">LOCAL PRICE TREND</p><p class="ic-empty">No Land Registry price series for this area.</p>`;

  const bars = Object.entries(d.scores || {}).map(([k, v]) =>
    `<div class="scorebar" title="${k}: ${v} / 100 (derived indicator)"><span>${k}</span><div class="track"><i style="width:${v}%"></i></div><b>${v}</b></div>`).join('');
  const scoreCard = bars
    ? `<p class="ic-kicker">AREA SCORECARD <span>/ 100 · derived</span></p><div class="scorebars">${bars}</div>`
    : `<p class="ic-kicker">AREA SCORECARD</p><p class="ic-empty">Scores unavailable right now.</p>`;

  const st = d.nearestStation, facts = [];
  if (st) facts.push(`<div class="fact"><span>🚉</span><b>${st.name}</b> · ${st.distM}m · ${st.modes.join(', ')}</div>`);
  if (d.crime) facts.push(`<div class="fact"><span>🛡️</span>${d.crime.count} street crimes/mo (~1 mi) · ${d.crime.band}</div>`);
  if (d.flood) facts.push(`<div class="fact"><span>🌊</span>${d.flood.count ? d.flood.count + ' flood-alert area' + (d.flood.count > 1 ? 's' : '') + ' within 3km' : 'No flood-alert areas within 3km'}</div>`);
  const drivers = (d.drivers || []).slice(0, 4).map(x => `<li>${x}</li>`).join('');
  const signalCard = `<p class="ic-kicker">SIGNALS &amp; FUTURE PULL</p>
       <div class="facts-list">${facts.join('')}</div>${drivers ? `<ul class="ic-drivers">${drivers}</ul>` : ''}`;

  const nearby = (d.nearby || []).map(n =>
    `<div class="near-card"><div class="near-top"><strong>${n.name}</strong><span class="chip">${walkMin(n.distM)}</span></div><p>${n.why}</p></div>`).join('');
  const nearbyBlock = nearby
    ? `<div class="near-head"><p class="kicker">WORTH A DETOUR NEARBY</p></div><div class="near-row">${nearby}</div>` : '';

  const comps = d.comps;
  const salesBlock = isRent(p)   // sale comps don't apply to a rental — hide the whole block
    ? ''
    : (comps && comps.count)
    ? `<div class="near-head sales-head"><p class="kicker">RECENT SALES NEARBY</p><span class="sale-summary">${comps.count} comparable sale${comps.count > 1 ? 's' : ''} in ${esc(comps.postcode)} · last ${comps.windowYears || 5} yrs · median ${money(comps.median)}</span></div>
       <div class="sales-grid">
         <article class="insight-card comps-chart-card">${compsChart(comps, p.price)}<p class="comps-read">${compsRead(comps, p.price)}</p></article>
         <article class="insight-card comps-summary-card">${compsSummary(comps, p.price)}</article>
       </div>`
    : `<div class="near-head sales-head"><p class="kicker">RECENT SALES NEARBY</p></div>
       <div class="sales-grid"><article class="insight-card comps-none"><p class="ic-empty">No comparable sales recorded${d.postcode ? ' in ' + esc(d.postcode) : ' nearby'} in the last 5 years — common for new-builds and quiet streets. Recent Land Registry sales will appear here once similar homes sell.</p></article></div>`;

  box.innerHTML = `
    <div class="insight-head">
      <p class="kicker">AREA INTELLIGENCE · ${(d.district ? d.district + ' · ' : '')}${p.area.toUpperCase()}</p>
      <h3>${headlineFor(p, d)}</h3>
    </div>
    <div class="insight-row">
      <article class="insight-card">${priceCard}</article>
      <article class="insight-card">${scoreCard}</article>
      <article class="insight-card">${signalCard}</article>
    </div>
    ${salesBlock}
    ${nearbyBlock}
    <p class="insight-foot">Live data — ${(d.sources || []).join(', ') || 'sources unavailable'}. Prices are actual sold prices (Land Registry); scores are derived indicators, not financial advice. As of ${asOf(d.computedAt)}.</p>`;
}

// ---- data ----------------------------------------------------------------
async function loadProperties() {
  const res = await fetch(`/api/properties?person=${encodeURIComponent(ui.person)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load properties');
  allProperties = await res.json();
  applyMode();
}
// Slice the full list to the current Buy/Rent view; everything else reads `properties`.
function applyMode() {
  properties = allProperties.filter(p => (p.listing_type || 'buy') === ui.mode);
  if (!byId(selectedId)) selectedId = properties[0]?.id || null;
}
const modeCount = mode => allProperties.filter(p => (p.listing_type || 'buy') === mode).length;
function renderModeSwitch() {
  document.querySelectorAll('#modeSwitch button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === ui.mode);
    const c = b.querySelector('b'); if (c) c.textContent = modeCount(b.dataset.mode);
  });
}
function switchMode(mode) {
  if (!MODES.includes(mode) || mode === ui.mode) return;
  ui.mode = mode; saveUi();
  selectedId = null;
  applyMode();
  renderModeSwitch();
  renderAll();
  if (map) setTimeout(fitToProperties, 60);
}

async function saveFeedback(p, patch) {
  const current = p.mine || {};
  const verdict = 'verdict' in patch ? patch.verdict : (current.verdict ?? null);
  const note = 'note' in patch ? patch.note : (current.note ?? '');
  const res = await fetch(`/api/properties/${encodeURIComponent(p.id)}/feedback`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person: ui.person, verdict, note }),
  });
  if (!res.ok) throw new Error('Could not save');
  const updatedAt = new Date().toISOString();
  p.mine = { property_id: p.id, person: ui.person, verdict, note, updated_at: updatedAt };
  p.feedback = (p.feedback || []).filter(f => f.person !== ui.person).concat(p.mine);
  return p.mine;
}

// ---- map -----------------------------------------------------------------
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([51.552, -0.040], 12);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  window.setTimeout(() => map.invalidateSize(), 150);
  refreshMarkers();
}
function refreshMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  const visible = properties.filter(p => statusOf(p) !== 'Pass' && inMoveWindow(p)); // hide passed + out-of-window
  // Some homes only geocode to their postcode-district centre, so several can land on
  // the exact same point. Fan those out in a small ring so none hides behind another.
  const groups = {};
  visible.forEach(p => { const k = `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`; (groups[k] = groups[k] || []).push(p); });
  visible.forEach(p => {
    let lat = p.latitude, lng = p.longitude;
    const grp = groups[`${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`];
    if (grp.length > 1) {
      const i = grp.indexOf(p), ang = (2 * Math.PI * i) / grp.length, r = 0.0009; // ~90m
      lat += r * Math.cos(ang);
      lng += r * Math.sin(ang) / Math.cos(lat * Math.PI / 180);
    }
    const face = p.id === selectedId ? '●' : Math.round(p.price / 1000) + 'k';
    const icon = L.divIcon({ className: '', html: `<div class="pin ${markerClass(p)} ${p.availability === 'off-market' ? 'gone' : ''}">${face}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] });
    markers[p.id] = L.marker([lat, lng], { icon, title: p.name }).addTo(map).on('click', () => select(p.id));
  });
}
// Zoom/pan the map to fit every pin currently shown (the non-passed homes).
function fitToProperties() {
  const ms = Object.values(markers);
  if (!ms.length) return;
  map.fitBounds(L.featureGroup(ms).getBounds(), { padding: [45, 45], maxZoom: 15 });
}

// ---- search-area districts (map boundaries) ------------------------------
async function loadSettings() {
  try { const s = await (await fetch('/api/settings', { cache: 'no-store' })).json(); selectedDistricts = new Set(s.searchDistricts || []); destinations = s.destinations || []; subscribedEmails = s.emails || []; if (s.briefs) briefs = s.briefs; allowedUsers = s.allowedUsers || []; isHost = !!s.isHost; if (s.space) { currentWorkspace = { id: s.space.id, name: s.space.name }; spacePeople = s.space.people || []; } } catch { }
  renderModeChrome();
  updateAreaToggle();
  showDistricts();   // always render a faint shade for the selected areas
  renderDestChips();
  renderEmailChips();
  renderAllowChips();
  renderSpaceBox();
  renderUserChip();
}
function renderDestChips() {
  const box = document.getElementById('destChips');
  if (!box) return;
  box.innerHTML = destinations.length
    ? destinations.map((d, i) => `<span class="dest-chip">${d.name} · ${d.postcode}<button data-i="${i}" aria-label="Remove ${d.name}">×</button></span>`).join('')
    : '<span class="dest-empty">No places added yet.</span>';
  box.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => removeDest(+b.dataset.i));
}
async function saveDestinations() {
  try {
    const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinations }) })).json();
    destinations = s.destinations || destinations; renderDestChips();
  } catch { }
  // commute times recompute server-side in the background — reload to show them
  if (destinations.length) setTimeout(async () => { await loadProperties(); renderAll(); }, 6500);
}
function addDest() {
  const nEl = document.getElementById('destName'), pEl = document.getElementById('destPostcode');
  const n = (nEl.value || '').trim(), p = (pEl.value || '').trim();
  if (!n || !/^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/.test(p)) { pEl.focus(); return; }
  if (destinations.length >= 6) return;
  destinations.push({ name: n.slice(0, 40), postcode: p.toUpperCase() });
  nEl.value = ''; pEl.value = '';
  renderDestChips(); saveDestinations();
}
function removeDest(i) { destinations.splice(i, 1); renderDestChips(); saveDestinations(); }

function renderEmailChips() {
  const box = document.getElementById('emailChips');
  if (!box) return;
  box.innerHTML = subscribedEmails.length
    ? subscribedEmails.map((e, i) => `<span class="dest-chip">${e}<button data-i="${i}" aria-label="Unsubscribe ${e}">×</button></span>`).join('')
    : '<span class="dest-empty">No one subscribed yet.</span>';
  box.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => { subscribedEmails.splice(+b.dataset.i, 1); renderEmailChips(); saveEmails('Removed.'); });
}
async function saveEmails(msg) {
  try { const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: subscribedEmails }) })).json(); subscribedEmails = s.emails || subscribedEmails; renderEmailChips(); }
  catch { }
  const st = document.getElementById('emailStatus'); if (st && msg) st.textContent = msg;
}
function addEmail() {
  const el = document.getElementById('emailInput'); const v = (el.value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { el.focus(); return; }
  if (!subscribedEmails.includes(v)) subscribedEmails.push(v);
  el.value = ''; renderEmailChips(); saveEmails('Subscribed — you’ll get a summary each Sunday morning.');
}

// ---- who can sign in (allow-list = lightweight invites) -------------------
function renderAllowChips() {
  const section = document.getElementById('allowSection');
  if (section) section.hidden = !isHost;   // the global sign-in list is host-only
  const box = document.getElementById('allowChips');
  if (!box || !isHost) return;
  box.innerHTML = allowedUsers.length
    ? allowedUsers.map((u, i) => `<span class="dest-chip">${esc(u.name)} · ${esc(u.email)}<button data-i="${i}" aria-label="Remove ${esc(u.email)}">×</button></span>`).join('')
    : '<span class="dest-empty">No one added yet.</span>';
  box.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => removeAllow(+b.dataset.i));
}
async function saveAllowed(msg) {
  try { const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowedUsers }) })).json(); allowedUsers = s.allowedUsers || allowedUsers; renderAllowChips(); }
  catch { }
  const st = document.getElementById('allowStatus'); if (st && msg) st.textContent = msg;
}
function addAllow() {
  const nEl = document.getElementById('allowName'), eEl = document.getElementById('allowEmail');
  const name = (nEl.value || '').trim(), email = (eEl.value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { eEl.focus(); return; }
  if (!allowedUsers.some(u => u.email === email)) allowedUsers.push({ email, name: name || email.split('@')[0] });
  nEl.value = ''; eEl.value = '';
  renderAllowChips(); saveAllowed(`${name || email} can now sign in — send them the site link and they’ll get a magic link by email.`);
}
function removeAllow(i) { allowedUsers.splice(i, 1); renderAllowChips(); saveAllowed('Removed.'); }

// ---- people in this space (share the shortlist) --------------------------
function renderSpaceBox() {
  const label = document.getElementById('spaceNameLabel');
  if (label) label.textContent = currentWorkspace ? currentWorkspace.name : 'your space';
  const nameInput = document.getElementById('spaceNameInput');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = currentWorkspace ? currentWorkspace.name : '';
  const box = document.getElementById('spaceChips');
  if (!box) return;
  const you = (currentUser && currentUser.email || '').toLowerCase();
  box.innerHTML = spacePeople.length
    ? spacePeople.map((p, i) => {
        const isYou = p.email.toLowerCase() === you;
        const tag = isYou ? ' (you)' : p.joined ? '' : ' · pending';
        return `<span class="dest-chip">${esc(p.name)}${tag} · ${esc(p.email)}${isYou ? '' : `<button data-i="${i}" aria-label="Remove ${esc(p.email)}">×</button>`}</span>`;
      }).join('')
    : '<span class="dest-empty">Just you so far.</span>';
  box.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => removeSpacePerson(+b.dataset.i));
}
async function saveSpacePeople(opts = {}) {
  let invited = 0;
  try {
    const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spacePeople: spacePeople.map(p => ({ email: p.email, name: p.name })) }) })).json();
    invited = s.invited || 0;
    if (s.space) { spacePeople = s.space.people || []; currentWorkspace = { id: s.space.id, name: s.space.name }; }
    if (s.allowedUsers) allowedUsers = s.allowedUsers;
    renderSpaceBox(); renderAllowChips(); renderUserChip();
  } catch { }
  const st = document.getElementById('spaceStatus');
  if (st) {
    if (opts.removed) st.textContent = 'Removed from this space.';
    else if (opts.addedName) st.textContent = invited
      ? `Invited ${opts.addedName} — we’ve emailed them a link to join this space.`
      : `Added ${opts.addedName}. They can sign in with this email to join (set up email to auto-send invites).`;
  }
}
function addSpacePerson() {
  const nEl = document.getElementById('spacePersonName'), eEl = document.getElementById('spacePersonEmail');
  const name = (nEl.value || '').trim(), email = (eEl.value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { eEl.focus(); return; }
  if (!spacePeople.some(p => p.email.toLowerCase() === email)) spacePeople.push({ email, name: name || email.split('@')[0], joined: false });
  nEl.value = ''; eEl.value = '';
  renderSpaceBox(); saveSpacePeople({ addedName: name || email });
}
function removeSpacePerson(i) { spacePeople.splice(i, 1); renderSpaceBox(); saveSpacePeople({ removed: true }); }
async function renameSpace() {
  const el = document.getElementById('spaceNameInput'); const v = (el.value || '').trim();
  if (!v || (currentWorkspace && v === currentWorkspace.name)) return;
  try {
    const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceName: v }) })).json();
    if (s.space) currentWorkspace = { id: s.space.id, name: s.space.name };
    renderSpaceBox(); renderUserChip();
  } catch { }
}
function districtStyle(name) {
  const on = selectedDistricts.has(name);
  if (!areaMode) return on ? { fill: true, fillColor: '#285b43', fillOpacity: 0.1, color: '#5d9b75', weight: 1, opacity: 0.5 } : { fill: false, stroke: false };
  return on ? { fill: true, fillColor: '#285b43', fillOpacity: 0.3, color: '#285b43', weight: 1.6, opacity: 1 } : { fill: true, fillColor: '#285b43', fillOpacity: 0.05, color: '#9aa79c', weight: 0.6, opacity: 0.85 };
}
function restyleDistricts() { if (districtLayer) districtLayer.setStyle(f => districtStyle(f.properties.name)); }
async function ensureDistricts() {
  if (districtLayer) return districtLayer;
  const geo = await (await fetch('/districts.geojson', { cache: 'force-cache' })).json();
  districtLayer = L.geoJSON(geo, {
    style: f => districtStyle(f.properties.name),
    onEachFeature: (f, layer) => {
      const name = f.properties.name;
      layer.bindTooltip(name, { sticky: true, direction: 'top', className: 'dist-tip' });
      layer.on('click', () => {
        if (!areaMode) return;
        selectedDistricts.has(name) ? selectedDistricts.delete(name) : selectedDistricts.add(name);
        layer.setStyle(districtStyle(name));
        updateAreaToggle();
        clearTimeout(saveDistTimer);
        saveDistTimer = setTimeout(() => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchDistricts: [...selectedDistricts] }) }).catch(() => {}), 700);
      });
    },
  });
  return districtLayer;
}
async function showDistricts() {
  const layer = await ensureDistricts().catch(() => null);
  if (!layer) return;
  if (!map.hasLayer(layer)) layer.addTo(map);
  restyleDistricts();
}
async function toggleAreas() {
  areaMode = !areaMode;
  await showDistricts();
  document.querySelector('.map-panel')?.classList.toggle('editing', areaMode);
  restyleDistricts();
  updateAreaToggle();
}
function updateAreaToggle() {
  const b = document.getElementById('areaToggle');
  if (!b) return;
  const n = selectedDistricts.size;
  b.classList.toggle('active', areaMode);
  b.innerHTML = areaMode ? `Done${n ? ' · <b>' + n + '</b> selected' : ' · tap districts'}` : `◧ Search areas${n ? ' · ' + n : ''}`;
}
const hasDrop = p => p.prev_price && p.price < p.prev_price;
// Short drop badge for the list; rentals move in £, sales in £k.
const dropText = p => !hasDrop(p) ? '' : (isRent(p) ? `↓ ${money(p.prev_price - p.price)}` : `↓ £${Math.round((p.prev_price - p.price) / 1000)}k`);
const prevLabel = p => isRent(p) ? `${money(p.prev_price)} pcm` : money(p.prev_price);

// ---- lists ---------------------------------------------------------------
function included(p, filter) {
  const s = statusOf(p);
  if (filter === 'passed') return s === 'Pass';        // passed stays findable regardless of dates
  if (!inMoveWindow(p)) return false;                  // move-in window narrows the active tabs
  if (filter === 'queue') return s === 'queue';
  if (filter === 'kept') return s === 'Love' || s === 'View' || s === 'Watch';
  return false;
}
function renderList() {
  let list = properties.filter(p => included(p, ui.filter));
  // The "To review" list is ordered best-fit first (same fit score as the compare panel,
  // computed across the homes on show), so the most promising flats surface at the top.
  let fitMap = null;
  if (ui.filter === 'queue' && list.length > 1) {
    const fit = computeFit(list);
    fitMap = new Map(list.map((p, i) => [p.id, fit[i]]));
    list = list.slice().sort((a, b) => fitMap.get(b.id) - fitMap.get(a.id));
  }
  const box = document.getElementById('propertyList');
  box.innerHTML = list.length ? list.map(p => {
    const others = othersInline(p);
    const av = availInfo(p);
    const fs = fitMap ? ` · <b class="fitscore" title="Fit score — best-fit first">fit ${fitMap.get(p.id)}</b>` : '';
    return `<button class="property-item ${p.id === selectedId ? 'active' : ''} ${p.recommendation === 'View' ? 'top' : ''}" data-id="${p.id}">
      <div class="item-top"><strong>${p.name}</strong><span class="fit">${p.recommendation === 'View' ? 'VIEW FIRST' : 'WATCH'}</span></div>
      <span>${p.area} · ${priceLabel(p)}${hasDrop(p) ? ` <i class="drop">${dropText(p)}</i>` : ''} · ${p.bedrooms} bed <i class="avail ${av.cls}">${av.text}</i>${availChip(p)}${(p.tags || []).includes('suggested') ? '<i class="sug">✨ Suggested</i>' : ''}</span>
      <span><i class="status-dot ${markerClass(p)}"></i>${label(statusOf(p))}${fs}${others ? ` · <b class="partner">${others}</b>` : ''}</span>
    </button>`;
  }).join('') : '<p class="empty">Nothing here yet. Switch tab or add a home — verdicts are saved on the shared server.</p>';
  box.querySelectorAll('.property-item').forEach(b => b.onclick = () => select(b.dataset.id));
  renderCounts();
}
function renderCounts() {
  const c = f => properties.filter(p => included(p, f)).length;
  document.getElementById('queueCount').textContent = c('queue');
  document.getElementById('keepCount').textContent = c('kept');
  document.getElementById('passCount').textContent = c('passed');
}

function select(id) {
  if (!id) return;
  selectedId = id;
  const p = byId(id);
  if (map && p) map.flyTo([p.latitude, p.longitude], 14, { duration: .45 });
  renderList();
  renderDetail();
  renderInsights();
  refreshMarkers();
}

// Time-on-market + last-sold price line for the detail panel.
function marketFacts(p) {
  const bits = [];
  if (p.listed_date) {
    const when = fmtDate(p.listed_date), days = daysSince(p.listed_date);
    if (p.listed_reason === 'reduced') bits.push(`<span>🏷️ Price reduced ${when}${days != null ? ` · ${days} day${days === 1 ? '' : 's'} ago` : ''}</span>`);
    else bits.push(`<span>🕒 Listed ${when}${days != null ? ` · ${days} day${days === 1 ? '' : 's'} on the market` : ''}</span>`);
  }
  const avail = availWhen(p);
  if (avail) bits.push(`<span>🗓️ ${avail}${(moveFilterOn() && !inMoveWindow(p)) ? ' · outside your move-in window' : ''}</span>`);
  if (!isRent(p) && p.last_sold_price) {   // last-sold price is a purchase concept
    const when = fmtMonth(p.last_sold_date);
    bits.push(`<span>💷 ${p.last_sold_exact ? 'Last sold' : 'Nearby sale (same postcode)'} ${money(p.last_sold_price)}${when ? ` · ${when}` : ''}</span>`);
  }
  return bits.length ? `<div class="market-facts">${bits.join('')}</div>` : '';
}
function renderDetail() {
  const p = byId(selectedId);
  const box = document.getElementById('propertyDetail');
  if (!p) { box.innerHTML = ''; return; }
  const mine = p.mine || {};
  const others = othersDetail(p);
  const av = availInfo(p);
  const med = p.media || {};
  const floors = med.floorplans || [], pics = med.photos || [];
  const shots = [...floors, ...pics];              // floor plan first, then photos
  const isFloor = u => floors.includes(u);
  const gallery = shots.length ? `<div class="gallery">
      <img id="galMain" class="gallery-main" src="${shots[0]}" referrerpolicy="no-referrer" alt="${p.name}">
      <div class="gallery-strip">
        ${shots.map((u, i) => `<button class="thumb${isFloor(u) ? ' floor' : ''}${i === 0 ? ' active' : ''}" data-src="${u}"${isFloor(u) ? ' title="Floorplan"' : ''}><img src="${u}" referrerpolicy="no-referrer" alt="${isFloor(u) ? 'Floorplan' : ''}" loading="lazy">${isFloor(u) ? '<span>PLAN</span>' : ''}</button>`).join('')}
      </div>
    </div>` : '';
  box.innerHTML = `${gallery}<div>
    <div class="detail-heading">
      <div>
        <p class="kicker">NEST'S VIEW · ${p.confidence.toUpperCase()} CONFIDENCE</p>
        <h2>${p.name}<br><em>${p.recommendation === 'View' ? 'Worth seeing first.' : 'Worth a closer look.'}</em></h2>
      </div>
      <div class="heading-actions">
        <a class="listing-button" href="${p.listing_url}" target="_blank" rel="noreferrer">Open full listing ↗</a>
        <button type="button" id="removeHome" class="remove-home">Remove home</button>
      </div>
    </div>
    <p class="facts">${p.area} · ${priceLabel(p)}${hasDrop(p) ? ` <span class="drop big">${dropText(p)} from ${prevLabel(p)}</span>` : ''} · ${p.bedrooms} bedrooms · ${p.size || 'Size TBC'}${(!isRent(p) && p.tenure) ? ` · <span class="tenure${p.lease_years && p.lease_years < 90 ? ' short' : ''}">${p.tenure}${p.lease_years ? ` · ${p.lease_years}-yr lease` : ''}</span>` : ''}
      <span class="avail ${av.cls} big">${av.text}</span><span class="checked">${whenChecked(p.last_checked)}</span></p>
    ${marketFacts(p)}
    <p class="agent-view">${p.agent_view}</p>
    <div class="questions"><strong>Before you book it</strong>${p.checks}</div>
    ${(p.commutes && p.commutes.length) ? `<div class="commutes"><strong>Getting to your places</strong>${p.commutes.map(c => `<div class="commute-row"><span class="cm-name">${c.name}</span><span class="cm-leg"><span class="cm-ico">🚉</span><b class="cm-min">${c.minutes != null ? c.minutes + ' min' : '—'}</b><span class="cm-mode">${c.minutes != null ? (c.modes && c.modes.length ? c.modes.join(' · ') : 'walk') : 'no transit route'}</span></span><span class="cm-leg cm-cycle"><span class="cm-ico">🚲</span><b class="cm-min">${c.cycleMinutes != null ? c.cycleMinutes + ' min' : '—'}</b><span class="cm-mode">${c.cycleMinutes != null ? 'cycle' : 'no cycle route'}</span></span></div>`).join('')}</div>` : ''}
  </div>
  <div class="reaction">
    <p class="kicker">SHARED VERDICT · YOU ARE ${ui.person.toUpperCase()}</p>
    <h3>What is your instinct?</h3>
    <p>One tap is enough. Add a reason if you have one — it is saved for everyone.${others ? ` <b class="partner">${others}</b>` : ''}</p>
    <div class="reaction-buttons">${['Love', 'View', 'Watch', 'Pass'].map(v => `<button data-verdict="${v}" class="${mine.verdict === v ? 'selected' : ''}">${verdictText(v)}</button>`).join('')}</div>
    <textarea id="note" placeholder="What works or puts you off? e.g. 'living room feels dark'">${mine.note || ''}</textarea>
    <div class="saved-note" id="savedNote">${mine.verdict || mine.note ? 'Saved on the shared server.' : ''}</div>
    <div class="guest-notes">
      <p class="kicker">SECOND OPINIONS</p>
      <div class="guest-list">${(p.guestNotes || []).map(g => `<div class="guest-item"><div class="guest-head"><strong>${esc(g.name)}</strong><span class="guest-when">${whenChecked(g.created_at)}</span><button type="button" class="guest-del" data-note="${g.id}" title="Remove this note" aria-label="Remove note">×</button></div><p>${esc(g.body)}</p></div>`).join('') || '<p class="guest-empty">No notes yet — friends and family can leave one below.</p>'}</div>
      <div class="guest-add">
        <input id="guestName" type="text" placeholder="Your name" maxlength="40" autocomplete="off" />
        <textarea id="guestBody" placeholder="Leave a note about this home…" maxlength="600"></textarea>
        <button type="button" id="guestAdd" class="lead-btn ghost">Add note</button>
      </div>
      <div class="guest-status" id="guestStatus"></div>
    </div>
  </div>`;
  galShots = shots; galIndex = 0;
  box.querySelectorAll('.thumb').forEach((t, i) => t.onclick = () => {
    galIndex = i;
    document.getElementById('galMain').src = t.dataset.src;
    box.querySelectorAll('.thumb').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
  });
  document.getElementById('galMain')?.addEventListener('click', () => openLightbox(galIndex));
  box.querySelectorAll('[data-verdict]').forEach(b => b.onclick = () => onVerdict(p, b.dataset.verdict));
  document.getElementById('removeHome')?.addEventListener('click', () => removeProperty(p));
  document.getElementById('note').addEventListener('change', async e => {
    try { await saveFeedback(p, { note: e.target.value }); document.getElementById('savedNote').textContent = 'Note saved on the shared server.'; renderLearning(); }
    catch { document.getElementById('savedNote').textContent = 'Could not save — is the server running?'; }
  });
  document.getElementById('guestAdd')?.addEventListener('click', () => submitGuestNote(p));
  box.querySelectorAll('.guest-del').forEach(b => b.onclick = () => removeGuestNote(p, b.dataset.note));
}
// Second opinions: anyone can leave a named note on a home. Stored shared server-side.
async function submitGuestNote(p) {
  const name = (document.getElementById('guestName')?.value || '').trim();
  const body = (document.getElementById('guestBody')?.value || '').trim();
  const status = document.getElementById('guestStatus');
  if (!name || !body) { if (status) status.textContent = 'Add your name and a note.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/properties/${encodeURIComponent(p.id)}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, body }) });
    if (!r.ok) throw new Error();
    await loadProperties(); renderDetail();
  } catch { if (status) status.textContent = 'Could not save — try again.'; }
}
async function removeGuestNote(p, id) {
  try { await fetch(`/api/guest-notes/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadProperties(); renderDetail(); } catch { }
}

async function onVerdict(p, verdict) {
  const next = p.mine?.verdict === verdict ? null : verdict; // tap again to clear
  try {
    await saveFeedback(p, { verdict: next });
    renderDetail(); renderList(); refreshMarkers(); renderLearning(); renderBrief();
  } catch {
    const s = document.getElementById('savedNote'); if (s) s.textContent = 'Could not save — is the server running?';
  }
}

// ---- full-screen image viewer -------------------------------------------
function openLightbox(i) {
  if (!galShots.length) return;
  galIndex = (i % galShots.length + galShots.length) % galShots.length;
  const lb = document.getElementById('lightbox');
  lb.classList.remove('zoomed');
  document.getElementById('lbImg').src = galShots[galIndex];
  document.getElementById('lbCount').textContent = `${galIndex + 1} / ${galShots.length}`;
  lb.hidden = false;
  document.body.classList.add('lb-open');
}
function lbStep(d) { document.getElementById('lightbox').classList.remove('zoomed'); openLightbox(galIndex + d); }
function toggleZoom() {
  const lb = document.getElementById('lightbox');
  const on = lb.classList.toggle('zoomed');
  if (on) requestAnimationFrame(() => { lb.scrollTo((lb.scrollWidth - lb.clientWidth) / 2, (lb.scrollHeight - lb.clientHeight) / 2); });
}
function closeLightbox() { const lb = document.getElementById('lightbox'); lb.hidden = true; lb.classList.remove('zoomed'); document.body.classList.remove('lb-open'); }

function renderLearning() {
  const mine = properties.map(p => p.mine).filter(Boolean);
  const notes = mine.map(x => x.note).filter(Boolean);
  const loves = mine.filter(x => x.verdict === 'Love' || x.verdict === 'View').length;
  const passes = mine.filter(x => x.verdict === 'Pass').length;
  let html;
  if (!mine.length) {
    html = '<h3>Your taste will become the filter.</h3><p>Give each lead a fast verdict as <strong>' + ui.person + '</strong> and, whenever you can, one sentence about why. Everyone signed in keeps their own verdicts on the same leads.</p>';
  } else {
    html = `<h3>${loves ? `${loves} lead${loves > 1 ? 's' : ''} you want to keep in play.` : 'Your first decisions are taking shape.'}</h3>
      <p>${notes.length ? `You have left ${notes.length} note${notes.length > 1 ? 's' : ''} for the next scout.` : 'The next useful signal is why — light, layout, street, building or location.'}${passes ? ` ${passes} pass${passes > 1 ? 'es' : ''} help me avoid similar homes.` : ''}</p>`;
  }
  document.getElementById('learningText').innerHTML = html;
}

// Live brief signals derived from the current contributor's keepers (Love/View/Watch —
// the same set as the Keepers tab). Updates on every verdict.
const ocOf = a => { const m = [...String(a || '').matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/g)]; return m.length ? m[m.length - 1][1].toUpperCase() : null; };
function renderBrief() {
  const homeEl = document.getElementById('briefKeepers'), areaEl = document.getElementById('briefLeaning');
  if (!homeEl && !areaEl) return;
  const keepers = properties.filter(p => ['Love', 'View', 'Watch'].includes(statusOf(p)));
  if (!keepers.length) { if (homeEl) homeEl.textContent = ''; if (areaEl) areaEl.textContent = ''; return; }
  // price range (sales in £k; rentals in £ pcm)
  const prices = keepers.map(p => p.price).filter(n => n > 0).sort((a, b) => a - b);
  let priceStr = '';
  if (prices.length) {
    const lo = prices[0], hi = prices[prices.length - 1];
    if (ui.mode === 'rent') priceStr = (lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`) + ' pcm';
    else { const l = Math.round(lo / 1000), h = Math.round(hi / 1000); priceStr = l === h ? `£${l}k` : `£${l}k–£${h}k`; }
  }
  // bed mix (span + most common)
  const bedCounts = {};
  keepers.forEach(p => { if (p.bedrooms) bedCounts[p.bedrooms] = (bedCounts[p.bedrooms] || 0) + 1; });
  const beds = Object.keys(bedCounts).map(Number).sort((a, b) => a - b);
  let bedStr = '';
  if (beds.length === 1) bedStr = `${beds[0]}-bed`;
  else if (beds.length > 1) { const top = beds.slice().sort((a, b) => bedCounts[b] - bedCounts[a])[0]; bedStr = `${beds[0]}–${beds[beds.length - 1]} bed, mostly ${top}-bed`; }
  if (homeEl) homeEl.textContent = `Your keepers so far (${keepers.length}): ${[priceStr, bedStr].filter(Boolean).join(', ')}.`;
  // areas leaning toward: keeper outcodes, most-kept first
  const oc = {};
  keepers.forEach(p => { const o = ocOf(p.area); if (o) oc[o] = (oc[o] || 0) + 1; });
  const top = Object.keys(oc).sort((a, b) => oc[b] - oc[a]);
  if (areaEl) areaEl.textContent = top.length ? `Leaning toward ${top.slice(0, 5).join(', ')}${top.length > 5 ? ` +${top.length - 5} more` : ''}.` : '';
}

// ---- editable brief ------------------------------------------------------
function bedsLabel(arr) {
  if (!arr || !arr.length) return 'any number of beds';
  const s = [...arr].sort((a, b) => a - b).map(n => n === 0 ? 'studio' : n + '-bed');
  return s.length === 1 ? s[0] : s.slice(0, -1).join(', ') + ' or ' + s[s.length - 1];
}
const briefPriceLabel = (mode, v) => mode === 'rent' ? `${money(v)} pcm` : (v >= 1000 ? '£' + Math.round(v / 1000) + 'k' : money(v));
function briefHomeText(mode) {
  const b = briefs[mode] || {};
  const tail = mode === 'rent' ? 'Sensible layout; minimal empty weeks before move-in.' : 'Efficient layout, charm and potential.';
  return `Up to ${briefPriceLabel(mode, b.maxPrice)}, ${bedsLabel(b.beds)}. ${tail}`;
}
// Swap the mode-specific copy (brief ceiling from the editable brief, add-box placeholder,
// suggest-button label). Auto-suggest now works for both Buy and Rent.
function renderModeChrome() {
  const home = document.getElementById('briefHomeStatic');
  if (home) home.textContent = briefHomeText(ui.mode);
  const add = document.getElementById('addUrl');
  if (add) add.placeholder = ui.mode === 'rent'
    ? 'Paste a Rightmove/OnTheMarket “to rent” link to add a rental…'
    : 'Paste a Rightmove or OnTheMarket link to add a home…';
  const disc = document.getElementById('discoverBtn');
  if (disc) { disc.disabled = false; disc.title = ''; disc.textContent = ui.mode === 'rent' ? '✨ Suggest rentals that fit us' : '✨ Suggest homes that fit us'; }
}
function openBriefEditor() {
  const ed = document.getElementById('briefEditor'); if (!ed) return;
  const b = briefs[ui.mode] || {};
  document.getElementById('briefMaxPrice').value = b.maxPrice || '';
  document.getElementById('briefPriceUnit').textContent = ui.mode === 'rent' ? 'monthly rent (pcm)' : 'price';
  document.querySelectorAll('#briefBeds input').forEach(c => c.checked = (b.beds || []).includes(+c.value));
  document.getElementById('briefEditStatus').textContent = '';
  ed.hidden = false;
  document.getElementById('briefEdit')?.setAttribute('aria-expanded', 'true');
}
function closeBriefEditor() {
  const ed = document.getElementById('briefEditor'); if (ed) ed.hidden = true;
  document.getElementById('briefEdit')?.setAttribute('aria-expanded', 'false');
}
async function saveBrief() {
  const status = document.getElementById('briefEditStatus');
  const maxPrice = Math.max(0, Math.round(+document.getElementById('briefMaxPrice').value || 0));
  const beds = [...document.querySelectorAll('#briefBeds input:checked')].map(c => +c.value);
  if (!maxPrice) { if (status) status.textContent = 'Enter a max ' + (ui.mode === 'rent' ? 'monthly rent.' : 'price.'); return; }
  briefs[ui.mode] = { ...briefs[ui.mode], maxPrice, beds };
  if (status) status.textContent = 'Saving…';
  try {
    const s = await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ briefs }) })).json();
    if (s.briefs) briefs = s.briefs;
    renderModeChrome();
    if (status) status.textContent = `Saved — “Suggest ${ui.mode === 'rent' ? 'rentals' : 'homes'}” will use this.`;
    setTimeout(closeBriefEditor, 1100);
  } catch { if (status) status.textContent = 'Could not save — is the server running?'; }
}
// Reflect the move-in window filter (inputs, active state, how many homes it hides).
function renderMoveFilter() {
  const f = document.getElementById('moveFrom'), t = document.getElementById('moveTo'), clr = document.getElementById('moveClear'), note = document.getElementById('moveNote');
  if (!f || !t) return;
  f.value = ui.moveFrom || ''; t.value = ui.moveTo || '';
  const on = moveFilterOn();
  document.getElementById('moveFilter')?.classList.toggle('active', on);
  if (clr) clr.hidden = !on;
  if (note) {
    if (!on) note.textContent = '';
    else {
      const hidden = properties.filter(p => statusOf(p) !== 'Pass' && !inMoveWindow(p)).length;
      note.textContent = hidden ? `Hiding ${hidden} home${hidden === 1 ? '' : 's'} available outside this window.` : 'Every home falls inside this window.';
    }
  }
}
function setMoveWindow(which, val) {
  ui[which] = val || ''; saveUi();
  renderMoveFilter(); renderList(); refreshMarkers();
}

function renderLeadNote() {
  const live = properties.filter(p => p.availability !== 'off-market').length;
  const last = properties.map(p => p.last_checked).filter(Boolean).sort().pop();
  const el = document.getElementById('leadStatus');
  if (el) el.innerHTML = `<strong>${live} live lead${live === 1 ? '' : 's'}</strong><br><small>${last ? 'Availability ' + whenChecked(last) : 'Availability not checked yet — press “Check listings”.'}</small>`;
}

// ---- sign-in / identity --------------------------------------------------
function renderUserChip() {
  const chip = document.getElementById('userChip'), name = document.getElementById('userName'), space = document.getElementById('spaceNameChip');
  if (name) name.textContent = currentUser ? currentUser.name : '';
  if (space) space.textContent = currentWorkspace ? currentWorkspace.name : '';
  if (chip) chip.hidden = !currentUser;
}
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { }
  location.href = '/';
}
// Shown when there's no session: email → magic link. In local dev (no SendGrid) the
// server returns the link directly so you can click through without email.
function showLogin() {
  const ls = document.getElementById('loginScreen'), main = document.getElementById('top');
  if (main) main.hidden = true;
  if (!ls) return;
  ls.hidden = false;
  const status = document.getElementById('loginStatus');
  const params = new URLSearchParams(location.search);
  if (params.get('auth') === 'expired') status.textContent = 'That sign-in link expired or was already used — enter your email for a fresh one.';
  else if (params.get('auth') === 'denied') status.textContent = 'That email isn’t on the allow-list yet. Ask whoever set up Nest to add you.';
  // Show the Google button only if the server has Google configured.
  fetch('/api/auth/config').then(r => r.json()).then(cfg => {
    if (!cfg.google) return;
    const g = document.getElementById('googleBtn'), or = document.getElementById('loginOr');
    if (or) or.hidden = false;
    if (g) { g.hidden = false; g.onclick = () => { location.href = '/api/auth/google'; }; }
  }).catch(() => { });
  const btn = document.getElementById('loginBtn'), input = document.getElementById('loginEmail');
  const submit = async () => {
    const email = (input.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { input.focus(); return; }
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await (await fetch('/api/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json();
      if (r.devLink) status.innerHTML = `Dev mode (no email configured): <a href="${r.devLink}">click here to sign in</a>.`;
      else status.textContent = 'Check your email for a sign-in link — it works once and expires in 20 minutes.';
    } catch { status.textContent = 'Something went wrong — please try again.'; }
    finally { btn.disabled = false; btn.textContent = orig; }
  };
  btn.onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  input.focus();
}

async function checkListings(btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking listings + area…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadProperties();
    renderAll();
    btn.textContent = 'Updated ✓';
  } catch {
    btn.textContent = 'Check failed — retry';
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 2500);
  }
}

async function submitAddUrl(btn) {
  const input = document.getElementById('addUrl');
  const status = document.getElementById('addStatus');
  const val = (input.value || '').trim();
  if (!val) { input.focus(); return; }
  const orig = btn.textContent;
  btn.disabled = true; input.disabled = true; btn.textContent = 'Reading…';
  status.classList.remove('err'); status.textContent = 'Fetching the listing, its photos and area intelligence…';
  try {
    const res = await fetch('/api/properties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: val }) });
    const data = await res.json();
    if (!res.ok || data.error) { status.classList.add('err'); status.textContent = data.error || 'Could not add that link.'; }
    else {
      input.value = '';
      ui.filter = 'queue'; saveUi();
      await loadProperties();
      // Jump to whichever view (Buy/Rent) the new home lives in, so it's visible.
      const added = allProperties.find(p => p.id === data.id);
      if (added) { ui.mode = (added.listing_type || 'buy'); saveUi(); }
      selectedId = data.id;
      applyMode();
      status.textContent = data.existing ? `“${data.name}” is already on your list.` : `Added “${data.name}” to your ${ui.mode === 'rent' ? 'Rent' : 'Buy'} list. Photos are in; area data is filling in — press it again in a moment if the panel is still loading.`;
      document.querySelector('.tab.active')?.classList.remove('active');
      document.querySelector('.tab[data-filter="queue"]')?.classList.add('active');
      renderAll();
      document.getElementById('propertyDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch { status.classList.add('err'); status.textContent = 'Something went wrong adding that link.'; }
  finally { btn.disabled = false; input.disabled = false; btn.textContent = orig; }
}

async function submitDiscover(btn) {
  const status = document.getElementById('addStatus');
  const noun = ui.mode === 'rent' ? 'rentals' : 'homes to buy';
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Searching Rightmove…';
  status.classList.remove('err');
  status.textContent = `Reading ${noun} across your brief areas and ranking them by what you and Hannah have liked — this can take up to a minute…`;
  try {
    const res = await fetch(`/api/discover?mode=${encodeURIComponent(ui.mode)}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) { status.classList.add('err'); status.textContent = data.error; }
    else if (!data.added || !data.added.length) {
      status.textContent = `Looked at ${data.considered || 0} ${noun} across your areas — nothing new beat what you already have. Try again in a day or two as fresh listings come on, or widen your brief.`;
    } else {
      status.textContent = `Added ${data.added.length} ${ui.mode === 'rent' ? 'rental' : 'home'} suggestion${data.added.length > 1 ? 's' : ''}: ${data.added.map(a => '“' + a.name + '”').join(', ')} — look for the ✨ Suggested tag, and each explains why.`;
      ui.filter = 'queue'; saveUi();
      await loadProperties();
      document.querySelector('.tab.active')?.classList.remove('active');
      document.querySelector('.tab[data-filter="queue"]')?.classList.add('active');
      renderAll();
    }
  } catch { status.classList.add('err'); status.textContent = 'The search could not complete — Rightmove may be rate-limiting. Try again shortly.'; }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// Two-click remove (no blocking browser dialog).
function removeProperty(p) {
  const btn = document.getElementById('removeHome');
  if (!btn) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1'; btn.textContent = 'Click again to remove'; btn.classList.add('armed');
    setTimeout(() => { const b = document.getElementById('removeHome'); if (b) { b.dataset.armed = ''; b.textContent = 'Remove home'; b.classList.remove('armed'); } }, 3000);
    return;
  }
  fetch(`/api/properties/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
    .then(async () => { selectedId = null; await loadProperties(); renderAll(); })
    .catch(() => {});
}

// ---- smart compare of keepers --------------------------------------------
const cmpSqm = p => { const m = String(p.size || '').match(/([\d.]+)\s*(?:sq\s*m|sqm|m²|m2)/i); return m ? +m[1] : null; };
const cmpPpsqm = p => { const s = cmpSqm(p); return s ? Math.round(p.price / s) : null; };
const cmpCommute = p => { const t = (p.commutes || []).map(c => c.minutes).filter(n => n != null); return t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null; };
const cmpScore = (p, k) => (p.insights && p.insights.scores && p.insights.scores[k] != null) ? p.insights.scores[k] : null;
const cmpCompsPct = p => { const c = p.insights && p.insights.comps; return (c && c.median && p.price) ? Math.round((p.price / c.median - 1) * 100) : null; };
const cmpLikes = p => (p.feedback || []).filter(f => ['Love', 'View'].includes(f.verdict));
const cmpShort = p => (p.name || '').split(',')[0].trim();

function computeFit(keepers) {
  const b = briefs[ui.mode] || {};
  const budget = b.maxPrice || Math.max(...keepers.map(p => p.price));
  const metrics = [
    { w: 1.5, val: p => budget ? (budget - p.price) / budget : null },       // more under budget
    { w: 1.5, val: p => { const v = cmpPpsqm(p); return v != null ? -v : null; } }, // lower £/m²
    { w: 1.0, val: p => cmpSqm(p) },                                          // bigger
    { w: 1.0, val: p => cmpScore(p, 'Transport') },
    { w: 0.7, val: p => cmpScore(p, 'Green space') },
    { w: 0.7, val: p => cmpScore(p, 'Amenities') },
    { w: 1.0, val: p => cmpScore(p, 'Value') },
    { w: 1.2, val: p => { const v = cmpCommute(p); return v != null ? -v : null; } }, // shorter commute
    { w: 1.0, val: p => { const v = cmpCompsPct(p); return v != null ? -v : null; } }, // below local median
  ];
  const norm = metrics.map(m => {
    const vals = keepers.map(m.val), present = vals.filter(v => v != null);
    if (!present.length) return keepers.map(() => 0.5);
    const lo = Math.min(...present), hi = Math.max(...present);
    return vals.map(v => v == null ? 0.5 : (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
  });
  const totW = metrics.reduce((a, m) => a + m.w, 0);
  return keepers.map((p, i) => {
    let s = 0; metrics.forEach((m, mi) => s += m.w * norm[mi][i]);
    let score = (s / totW) * 100;
    if (cmpLikes(p).length >= 2) score += 4;   // you both like it
    return Math.round(Math.max(0, Math.min(100, score)));
  });
}
function keepersForCompare() { return properties.filter(p => ['Love', 'View', 'Watch'].includes(statusOf(p))).slice(0, 6); }
function renderCompare() {
  const section = document.getElementById('compareSection'), body = document.getElementById('compareBody'), toggle = document.getElementById('compareToggle');
  if (!section) return;
  const ks = keepersForCompare();
  if (ks.length < 2) { section.hidden = true; if (body) body.innerHTML = ''; return; }
  section.hidden = false;
  if (toggle) toggle.textContent = ui.compareOpen ? 'Hide ▴' : `Compare ${ks.length} keepers ▾`;
  if (!ui.compareOpen) { body.innerHTML = ''; return; }

  const fit = computeFit(ks);
  const topIdx = fit.indexOf(Math.max(...fit));
  const rent = ui.mode === 'rent';
  // rows: {label, cell(p)->html, num(p)->number|null, better:'low'|'high'|null}
  const rows = [
    { label: 'Fit score', cell: (p, i) => `<b>${fit[i]}</b>`, num: (p, i) => fit[i], better: 'high', head: true },
    { label: rent ? 'Rent' : 'Price', cell: p => priceLabel(p), num: p => p.price, better: 'low' },
    { label: '£ / m²', cell: p => { const v = cmpPpsqm(p); return v ? '£' + v.toLocaleString('en-GB') : '—'; }, num: p => cmpPpsqm(p), better: 'low' },
    { label: 'Size', cell: p => { const v = cmpSqm(p); return v ? v + ' m²' : '—'; }, num: p => cmpSqm(p), better: 'high' },
    { label: 'Beds', cell: p => p.bedrooms || '—', num: null, better: null },
    { label: 'Avg commute', cell: p => { const v = cmpCommute(p); return v != null ? v + ' min' : '—'; }, num: p => cmpCommute(p), better: 'low' },
    { label: 'Transport', cell: p => cmpScore(p, 'Transport') ?? '—', num: p => cmpScore(p, 'Transport'), better: 'high' },
    { label: 'Green space', cell: p => cmpScore(p, 'Green space') ?? '—', num: p => cmpScore(p, 'Green space'), better: 'high' },
    { label: 'Amenities', cell: p => cmpScore(p, 'Amenities') ?? '—', num: p => cmpScore(p, 'Amenities'), better: 'high' },
    { label: 'Area value', cell: p => cmpScore(p, 'Value') ?? '—', num: p => cmpScore(p, 'Value'), better: 'high' },
    ...(rent ? [] : [{ label: 'vs local median', cell: p => { const v = cmpCompsPct(p); return v == null ? '—' : (v > 0 ? '+' : '') + v + '%'; }, num: p => cmpCompsPct(p), better: 'low' }]),
    ...(rent ? [] : [{ label: 'Tenure', cell: p => p.tenure ? esc(p.tenure) + (p.lease_years ? ` · ${p.lease_years}y` : '') : '—', num: null, better: null }]),
    { label: 'Available', cell: p => availWhen(p) || '—', num: null, better: null },
    { label: 'Who likes it', cell: p => cmpLikes(p).map(f => esc(f.person)).join(', ') || '—', num: null, better: null },
  ];
  const headCells = ks.map((p, i) => `<th class="${i === topIdx ? 'cmp-top' : ''}"><button class="cmp-h" data-id="${p.id}"><span class="cmp-name">${esc(cmpShort(p))}</span><span class="cmp-price">${priceLabel(p)}</span></button></th>`).join('');
  const rowHtml = rows.map(r => {
    const nums = r.num ? ks.map((p, i) => r.num(p, i)) : null;
    let best = -1, worst = -1;
    if (nums) {
      const present = nums.map((v, i) => [v, i]).filter(x => x[0] != null);
      if (present.length >= 2 && r.better) {
        const sorted = present.slice().sort((a, b) => a[0] - b[0]);
        best = (r.better === 'low' ? sorted[0] : sorted[sorted.length - 1])[1];
        worst = (r.better === 'low' ? sorted[sorted.length - 1] : sorted[0])[1];
      }
    }
    const cells = ks.map((p, i) => `<td class="${i === best ? 'cmp-best' : ''} ${i === worst ? 'cmp-worst' : ''} ${i === topIdx ? 'cmp-topcol' : ''}">${r.cell(p, i)}</td>`).join('');
    return `<tr class="${r.head ? 'cmp-fitrow' : ''}"><th scope="row">${r.label}</th>${cells}</tr>`;
  }).join('');

  // smart read
  const byMin = (fn) => { let bi = -1, bv = Infinity; ks.forEach((p, i) => { const v = fn(p); if (v != null && v < bv) { bv = v; bi = i; } }); return bi; };
  const byMax = (fn) => { let bi = -1, bv = -Infinity; ks.forEach((p, i) => { const v = fn(p); if (v != null && v > bv) { bv = v; bi = i; } }); return bi; };
  const valueIdx = byMin(cmpPpsqm), connIdx = byMin(cmpCommute) >= 0 ? byMin(cmpCommute) : byMax(p => cmpScore(p, 'Transport')), roomIdx = byMax(cmpSqm);
  const bits = [`<b>Best all-rounder:</b> ${esc(cmpShort(ks[topIdx]))} (fit ${fit[topIdx]})`];
  if (valueIdx >= 0) bits.push(`<b>Best value:</b> ${esc(cmpShort(ks[valueIdx]))} (£${cmpPpsqm(ks[valueIdx]).toLocaleString('en-GB')}/m²)`);
  if (connIdx >= 0) bits.push(`<b>Best connected:</b> ${esc(cmpShort(ks[connIdx]))}${cmpCommute(ks[connIdx]) != null ? ` (${cmpCommute(ks[connIdx])} min avg)` : ''}`);
  if (roomIdx >= 0 && cmpSqm(ks[roomIdx])) bits.push(`<b>Roomiest:</b> ${esc(cmpShort(ks[roomIdx]))} (${cmpSqm(ks[roomIdx])} m²)`);
  const tradeoff = (valueIdx >= 0 && valueIdx !== topIdx) ? ` <span class="cmp-trade">Trade-off: ${esc(cmpShort(ks[topIdx]))} scores highest overall, but ${esc(cmpShort(ks[valueIdx]))} is better value per m².</span>` : '';

  body.innerHTML = `<p class="cmp-read">${bits.join(' · ')}.${tradeoff}</p>
    <div class="cmp-scroll"><table class="cmp-table"><thead><tr><th></th>${headCells}</tr></thead><tbody>${rowHtml}</tbody></table></div>
    <p class="cmp-foot">Fit score weighs value-for-money, £/m², size, transport, green space, amenities, area value, commute and price-vs-local-market — plus a nudge when you both like it. Green = best in its row; a home you both like counts for more.</p>`;
  body.querySelectorAll('.cmp-h').forEach(b => b.onclick = () => { select(b.dataset.id); document.getElementById('propertyDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

function renderAll() {
  renderModeSwitch(); renderModeChrome(); renderMoveFilter();
  renderList(); renderDetail(); renderInsights(); refreshMarkers(); renderLearning(); renderBrief(); renderLeadNote(); renderCompare();
}

function bind() {
  document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
    document.querySelector('.tab.active').classList.remove('active');
    tab.classList.add('active');
    ui.filter = tab.dataset.filter; saveUi();
    renderList();
  });
  document.getElementById('briefButton').onclick = () => document.getElementById('brief').scrollIntoView({ behavior: 'smooth' });
  document.getElementById('briefEdit')?.addEventListener('click', () => { const ed = document.getElementById('briefEditor'); (ed && ed.hidden) ? openBriefEditor() : closeBriefEditor(); });
  document.getElementById('briefSave')?.addEventListener('click', saveBrief);
  document.getElementById('briefCancel')?.addEventListener('click', closeBriefEditor);
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  document.getElementById('allowAdd')?.addEventListener('click', addAllow);
  document.getElementById('allowEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addAllow(); } });
  document.getElementById('spaceAdd')?.addEventListener('click', addSpacePerson);
  document.getElementById('spacePersonEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSpacePerson(); } });
  document.getElementById('spaceNameInput')?.addEventListener('change', renameSpace);
  document.querySelectorAll('#modeSwitch button').forEach(b => b.onclick = () => switchMode(b.dataset.mode));
  document.getElementById('moveFrom')?.addEventListener('change', e => setMoveWindow('moveFrom', e.target.value));
  document.getElementById('moveTo')?.addEventListener('change', e => setMoveWindow('moveTo', e.target.value));
  document.getElementById('moveClear')?.addEventListener('click', () => { ui.moveFrom = ''; ui.moveTo = ''; saveUi(); renderMoveFilter(); renderList(); refreshMarkers(); });
  document.getElementById('checkListings').onclick = e => checkListings(e.currentTarget);
  const addBtn = document.getElementById('addBtn');
  if (addBtn) {
    addBtn.onclick = () => submitAddUrl(addBtn);
    document.getElementById('addUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAddUrl(addBtn); } });
  }
  const discoverBtn = document.getElementById('discoverBtn');
  if (discoverBtn) discoverBtn.onclick = () => submitDiscover(discoverBtn);
  document.getElementById('areaToggle')?.addEventListener('click', toggleAreas);
  document.getElementById('zoomExtent')?.addEventListener('click', fitToProperties);
  document.getElementById('compareToggle')?.addEventListener('click', () => { ui.compareOpen = !ui.compareOpen; saveUi(); renderCompare(); });
  document.getElementById('destAdd')?.addEventListener('click', addDest);
  document.getElementById('destPostcode')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDest(); } });
  document.getElementById('emailAdd')?.addEventListener('click', addEmail);
  document.getElementById('emailInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } });
  const lb = document.getElementById('lightbox');
  if (lb) {
    lb.querySelector('.lb-close').onclick = closeLightbox;
    lb.querySelector('.lb-prev').onclick = e => { e.stopPropagation(); lbStep(-1); };
    lb.querySelector('.lb-next').onclick = e => { e.stopPropagation(); lbStep(1); };
    document.getElementById('lbImg').onclick = e => { e.stopPropagation(); toggleZoom(); };
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') lbStep(-1);
      else if (e.key === 'ArrowRight') lbStep(1);
    });
  }
  renderUserChip();
}

// ---- boot ----------------------------------------------------------------
(async function boot() {
  // Gate on a session first — no login, show the sign-in screen and stop.
  const me = await fetch('/api/me', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ user: null }));
  if (!me.user) { showLogin(); return; }
  currentUser = me.user; currentWorkspace = me.workspace || null; ui.person = currentUser.name; saveUi();
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('top').hidden = false;
  renderUserChip();
  // set the active tab class before first render
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  (document.querySelector(`.tab[data-filter="${ui.filter}"]`) || document.querySelector('.tab')).classList.add('active');
  initMap();
  bind();
  loadSettings();
  try {
    await loadProperties();
    renderAll();
  } catch (err) {
    document.getElementById('propertyList').innerHTML =
      '<p class="empty">Could not reach the Nest server. Start it with <code>npm start</code> and open this page at the address it prints.</p>';
  }
})();
