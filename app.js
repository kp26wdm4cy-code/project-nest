// Project Nest — shared front-end wired to the persistent backend (server.mjs).
// Data lives in SQLite on the server; this file only reads and writes via /api.

const PEOPLE = ['Ralf', 'Hannah'];
const ui = JSON.parse(localStorage.getItem('nest-ui') || '{}');
ui.person = PEOPLE.includes(ui.person) ? ui.person : 'Ralf';
ui.filter ||= 'queue';
const saveUi = () => localStorage.setItem('nest-ui', JSON.stringify(ui));

let properties = [];      // latest server snapshot, for the current person
let selectedId = null;
let map, markers = {};
let galShots = [], galIndex = 0;  // current gallery images for the full-screen viewer

const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);
const byId = id => properties.find(p => p.id === id);
const partner = () => (ui.person === 'Ralf' ? 'Hannah' : 'Ralf');
const statusOf = p => p.mine?.verdict || 'queue';
const partnerVerdict = p => (p.feedback || []).find(f => f.person === partner() && f.verdict) || null;
const label = status => ({ queue: 'To review', Love: 'Keeper', View: 'Worth viewing', Watch: 'Watch', Pass: 'Passed' })[status] || status;
const verdictText = v => ({ Love: '♥ Love it', View: '✓ Would view', Watch: '◌ Watch', Pass: '× Forget it' })[v] || v;
const markerClass = p => { const s = statusOf(p); return s === 'Pass' ? 'passed' : (s === 'Love' || s === 'View' || s === 'Watch') ? 'kept' : 'unreviewed'; };

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
    ${nearbyBlock}
    <p class="insight-foot">Live data — ${(d.sources || []).join(', ') || 'sources unavailable'}. Scores are derived indicators, not financial advice. As of ${asOf(d.computedAt)}.</p>`;
}

// ---- data ----------------------------------------------------------------
async function loadProperties() {
  const res = await fetch(`/api/properties?person=${encodeURIComponent(ui.person)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load properties');
  properties = await res.json();
  if (!byId(selectedId)) selectedId = properties[0]?.id || null;
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
  properties.forEach(p => {
    const face = p.id === selectedId ? '●' : Math.round(p.price / 1000) + 'k';
    const icon = L.divIcon({ className: '', html: `<div class="pin ${markerClass(p)} ${p.availability === 'off-market' ? 'gone' : ''}">${face}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] });
    markers[p.id] = L.marker([p.latitude, p.longitude], { icon, title: p.name }).addTo(map).on('click', () => select(p.id));
  });
}

// ---- lists ---------------------------------------------------------------
function included(p, filter) {
  const s = statusOf(p);
  if (filter === 'queue') return s === 'queue';
  if (filter === 'kept') return s === 'Love' || s === 'View' || s === 'Watch';
  return s === 'Pass';
}
function renderList() {
  const list = properties.filter(p => included(p, ui.filter));
  const box = document.getElementById('propertyList');
  box.innerHTML = list.length ? list.map(p => {
    const pv = partnerVerdict(p);
    const av = availInfo(p);
    return `<button class="property-item ${p.id === selectedId ? 'active' : ''} ${p.recommendation === 'View' ? 'top' : ''}" data-id="${p.id}">
      <div class="item-top"><strong>${p.name}</strong><span class="fit">${p.recommendation === 'View' ? 'VIEW FIRST' : 'WATCH'}</span></div>
      <span>${p.area} · ${money(p.price)} · ${p.bedrooms} bed <i class="avail ${av.cls}">${av.text}</i>${(p.tags || []).includes('suggested') ? '<i class="sug">✨ Suggested</i>' : ''}</span>
      <span><i class="status-dot ${markerClass(p)}"></i>${label(statusOf(p))}${pv ? ` · <b class="partner">${partner()}: ${verdictText(pv.verdict)}</b>` : ''}</span>
    </button>`;
  }).join('') : '<p class="empty">Nothing here yet. Switch contributor or tab — verdicts are saved on the shared server.</p>';
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

function renderDetail() {
  const p = byId(selectedId);
  const box = document.getElementById('propertyDetail');
  if (!p) { box.innerHTML = ''; return; }
  const mine = p.mine || {};
  const pv = partnerVerdict(p);
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
    <p class="facts">${p.area} · ${money(p.price)} · ${p.bedrooms} bedrooms · ${p.size || 'Size TBC'}
      <span class="avail ${av.cls} big">${av.text}</span><span class="checked">${whenChecked(p.last_checked)}</span></p>
    <p class="agent-view">${p.agent_view}</p>
    <div class="questions"><strong>Before you book it</strong>${p.checks}</div>
  </div>
  <div class="reaction">
    <p class="kicker">SHARED VERDICT · YOU ARE ${ui.person.toUpperCase()}</p>
    <h3>What is your instinct?</h3>
    <p>One tap is enough. Add a reason if you have one — it is saved for both of you.${pv ? ` <b class="partner">${partner()} said ${verdictText(pv.verdict)}${pv.note ? `: “${pv.note}”` : '.'}</b>` : ''}</p>
    <div class="reaction-buttons">${['Love', 'View', 'Watch', 'Pass'].map(v => `<button data-verdict="${v}" class="${mine.verdict === v ? 'selected' : ''}">${verdictText(v)}</button>`).join('')}</div>
    <textarea id="note" placeholder="What works or puts you off? e.g. 'living room feels dark'">${mine.note || ''}</textarea>
    <div class="saved-note" id="savedNote">${mine.verdict || mine.note ? 'Saved on the shared server.' : ''}</div>
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
}

async function onVerdict(p, verdict) {
  const next = p.mine?.verdict === verdict ? null : verdict; // tap again to clear
  try {
    await saveFeedback(p, { verdict: next });
    renderDetail(); renderList(); refreshMarkers(); renderLearning();
  } catch {
    const s = document.getElementById('savedNote'); if (s) s.textContent = 'Could not save — is the server running?';
  }
}

// ---- full-screen image viewer -------------------------------------------
function openLightbox(i) {
  if (!galShots.length) return;
  galIndex = (i % galShots.length + galShots.length) % galShots.length;
  document.getElementById('lbImg').src = galShots[galIndex];
  document.getElementById('lbCount').textContent = `${galIndex + 1} / ${galShots.length}`;
  document.getElementById('lightbox').hidden = false;
  document.body.classList.add('lb-open');
}
function lbStep(d) { openLightbox(galIndex + d); }
function closeLightbox() { document.getElementById('lightbox').hidden = true; document.body.classList.remove('lb-open'); }

function renderLearning() {
  const mine = properties.map(p => p.mine).filter(Boolean);
  const notes = mine.map(x => x.note).filter(Boolean);
  const loves = mine.filter(x => x.verdict === 'Love' || x.verdict === 'View').length;
  const passes = mine.filter(x => x.verdict === 'Pass').length;
  let html;
  if (!mine.length) {
    html = '<h3>Your taste will become the filter.</h3><p>Give each lead a fast verdict as <strong>' + ui.person + '</strong> and, whenever you can, one sentence about why. Hannah and Ralf each keep their own verdicts on the same leads.</p>';
  } else {
    html = `<h3>${loves ? `${loves} lead${loves > 1 ? 's' : ''} you want to keep in play.` : 'Your first decisions are taking shape.'}</h3>
      <p>${notes.length ? `You have left ${notes.length} note${notes.length > 1 ? 's' : ''} for the next scout.` : 'The next useful signal is why — light, layout, street, building or location.'}${passes ? ` ${passes} pass${passes > 1 ? 'es' : ''} help me avoid similar homes.` : ''}</p>`;
  }
  document.getElementById('learningText').innerHTML = html;
}

function renderLeadNote() {
  const live = properties.filter(p => p.availability !== 'off-market').length;
  const last = properties.map(p => p.last_checked).filter(Boolean).sort().pop();
  const el = document.getElementById('leadStatus');
  if (el) el.innerHTML = `<strong>${live} live lead${live === 1 ? '' : 's'}</strong><br><small>${last ? 'Availability ' + whenChecked(last) : 'Availability not checked yet — press “Check listings”.'}</small>`;
}

// ---- top-level actions ---------------------------------------------------
function renderPersonSwitch() {
  document.querySelectorAll('#personSwitch button').forEach(b => b.classList.toggle('active', b.dataset.person === ui.person));
}
async function switchPerson(person) {
  if (!PEOPLE.includes(person) || person === ui.person) return;
  ui.person = person; saveUi(); renderPersonSwitch();
  await loadProperties();
  renderAll();
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
      status.textContent = data.existing ? `“${data.name}” is already on your list.` : `Added “${data.name}”. Photos are in; area data is filling in — press it again in a moment if the panel is still loading.`;
      selectedId = data.id;
      ui.filter = 'queue'; saveUi();
      await loadProperties();
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
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Searching Rightmove…';
  status.classList.remove('err');
  status.textContent = 'Reading listings across your brief areas and ranking them by what you and Hannah have liked — this can take up to a minute…';
  try {
    const res = await fetch('/api/discover', { method: 'POST' });
    const data = await res.json();
    if (data.error) { status.classList.add('err'); status.textContent = data.error; }
    else if (!data.added || !data.added.length) {
      status.textContent = `Looked at ${data.considered || 0} listings across your areas — nothing new beat what you already have. Try again in a day or two as fresh homes come on.`;
    } else {
      status.textContent = `Added ${data.added.length} suggestion${data.added.length > 1 ? 's' : ''}: ${data.added.map(a => '“' + a.name + '”').join(', ')} — look for the ✨ Suggested tag, and each explains why.`;
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

function renderAll() {
  renderList(); renderDetail(); renderInsights(); refreshMarkers(); renderLearning(); renderLeadNote();
}

function bind() {
  document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
    document.querySelector('.tab.active').classList.remove('active');
    tab.classList.add('active');
    ui.filter = tab.dataset.filter; saveUi();
    renderList();
  });
  document.getElementById('briefButton').onclick = () => document.getElementById('brief').scrollIntoView({ behavior: 'smooth' });
  document.querySelectorAll('#personSwitch button').forEach(b => b.onclick = () => switchPerson(b.dataset.person));
  document.getElementById('checkListings').onclick = e => checkListings(e.currentTarget);
  const addBtn = document.getElementById('addBtn');
  if (addBtn) {
    addBtn.onclick = () => submitAddUrl(addBtn);
    document.getElementById('addUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAddUrl(addBtn); } });
  }
  const discoverBtn = document.getElementById('discoverBtn');
  if (discoverBtn) discoverBtn.onclick = () => submitDiscover(discoverBtn);
  const lb = document.getElementById('lightbox');
  if (lb) {
    lb.querySelector('.lb-close').onclick = closeLightbox;
    lb.querySelector('.lb-prev').onclick = e => { e.stopPropagation(); lbStep(-1); };
    lb.querySelector('.lb-next').onclick = e => { e.stopPropagation(); lbStep(1); };
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') lbStep(-1);
      else if (e.key === 'ArrowRight') lbStep(1);
    });
  }
  renderPersonSwitch();
}

// ---- boot ----------------------------------------------------------------
(async function boot() {
  // set the active tab class before first render
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  (document.querySelector(`.tab[data-filter="${ui.filter}"]`) || document.querySelector('.tab')).classList.add('active');
  initMap();
  bind();
  try {
    await loadProperties();
    renderAll();
  } catch (err) {
    document.getElementById('propertyList').innerHTML =
      '<p class="empty">Could not reach the Nest server. Start it with <code>npm start</code> and open this page at the address it prints.</p>';
  }
})();
