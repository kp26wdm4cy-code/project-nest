// Live area intelligence — computed server-side from free public data sources.
// Every source is wrapped so one failure never breaks the rest; the result lists
// which sources succeeded. Scores are DERIVED indicators, clearly labelled in the UI.

const UA = 'Project-Nest/1.0 (home-search area intelligence)';

function metresBetween(aLat, aLng, bLat, bLng) {
  return Math.round(111320 * Math.hypot(bLat - aLat, (bLng - aLng) * Math.cos(aLat * Math.PI / 180)));
}
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
const slugify = s => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const gbp = n => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n);

async function getJson(url, opts = {}, ms = 15000) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function getText(url, opts = {}, ms = 15000) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// --- 1. postcodes.io: coordinates -> district / postcode -----------------
async function locate(lat, lng) {
  const d = await getJson(`https://api.postcodes.io/postcodes?lat=${lat}&lon=${lng}&limit=1`);
  const p = d.result?.[0];
  if (!p) throw new Error('no postcode');
  return { district: p.admin_district, postcode: p.postcode, constituency: p.parliamentary_constituency };
}

// --- 2. HM Land Registry UK HPI: real price trend by local authority -----
async function priceTrend(district, propertyPrice) {
  const region = `http://landregistry.data.gov.uk/id/region/${slugify(district)}`;
  const query = `PREFIX ukhpi: <http://landregistry.data.gov.uk/def/ukhpi/>
SELECT ?date ?avg ?flat WHERE {
  ?o ukhpi:refRegion <${region}> ; ukhpi:refMonth ?date ; ukhpi:averagePrice ?avg .
  OPTIONAL { ?o ukhpi:averagePriceFlatMaisonette ?flat . }
} ORDER BY ?date`;
  const d = await getJson('https://landregistry.data.gov.uk/landregistry/query?query=' + encodeURIComponent(query),
    { headers: { Accept: 'application/sparql-results+json' } });
  const rows = (d.results?.bindings || []).map(b => ({ ym: b.date.value, avg: +b.avg.value, flat: b.flat ? +b.flat.value : null }));
  if (!rows.length) throw new Error('no price rows');
  // Downsample to one point per year (latest month seen for that year), last 10 years.
  const byYear = new Map();
  for (const r of rows) byYear.set(r.ym.slice(0, 4), r);        // later months overwrite earlier
  const years = [...byYear.keys()].sort().slice(-10);
  const series = years.map(y => ({ y: +y, avg: byYear.get(y).avg }));
  const base = series[0].avg;
  const index = series.map(s => ({ y: s.y, v: Math.round(s.avg / base * 100) }));
  const last = byYear.get(years[years.length - 1]);
  const avgNow = last.avg, flatNow = last.flat || last.avg;
  const changePct = Math.round((series[series.length - 1].avg / base - 1) * 100);
  // Value: guide price vs the area's flat-type average.
  const valueScore = propertyPrice && flatNow ? clamp(50 + (flatNow - propertyPrice) / flatNow * 100) : null;
  return { index, changePct, avgNow, flatNow, valueScore, fromYear: series[0].y };
}

// --- 3. OpenStreetMap Overpass: nearby places + green/amenity signal -----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
async function overpass(q) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ep of OVERPASS) {
      try {
        const text = await getText(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 30000);
        if (text.trim().startsWith('{')) return JSON.parse(text);
        lastErr = new Error('non-json');
      } catch (e) { lastErr = e; }
      await sleep(400);
    }
    await sleep(1500);
  }
  throw lastErr || new Error('overpass failed');
}
async function nearby(lat, lng) {
  const q = `[out:json][timeout:25];(` +
    `node(around:1300,${lat},${lng})[leisure~"^(park|nature_reserve|common|recreation_ground)$"];` +
    `way(around:1300,${lat},${lng})[leisure~"^(park|nature_reserve|common|recreation_ground)$"];` +
    `node(around:1500,${lat},${lng})[amenity=marketplace];` +
    `way(around:1600,${lat},${lng})[tourism~"museum|gallery|attraction|theatre"];` +
    `node(around:1600,${lat},${lng})[tourism~"museum|gallery|attraction|theatre"];` +
    `node(around:900,${lat},${lng})[shop~"supermarket|convenience"];` +
    `node(around:700,${lat},${lng})[amenity~"cafe|restaurant|pub"];` +
    `);out center tags 300;`;
  const els = (await overpass(q)).elements || [];
  const items = els.map(e => {
    const c = e.center || e;
    const t = e.tags || {};
    const kind = t.leisure ? 'green' : t.amenity === 'marketplace' ? 'market' : t.tourism ? 'culture'
      : t.shop ? 'shop' : t.amenity ? 'food' : 'other';
    return { name: t.name || null, kind, distM: metresBetween(lat, lng, c.lat, c.lon) };
  });
  const greens = items.filter(i => i.kind === 'green').sort((a, b) => a.distM - b.distM);
  const namedParks = greens.filter(g => g.name);
  const shops = items.filter(i => i.kind === 'shop').length;
  const food = items.filter(i => i.kind === 'food').length;
  const markets = items.filter(i => i.kind === 'market');
  const culture = items.filter(i => i.kind === 'culture');
  // Calibrated so scores actually spread, not all pinned at 100.
  const nearestPark = greens[0];
  const greenProx = nearestPark ? clamp(60 - nearestPark.distM / 12, 0, 60) : 0;
  const greenScore = clamp(greenProx + clamp(namedParks.length * 5, 0, 40));
  const amenitiesScore = clamp(Math.min(shops, 10) * 5 + Math.min(food, 25) * 1.4 + markets.length * 10 + culture.length * 4);
  // "Worth a detour": named, interesting places — markets & culture first, then notable greens.
  const seen = new Set();
  const pick = arr => arr.filter(i => i.name && !seen.has(i.name) && seen.add(i.name));
  const why = i => i.kind === 'market' ? 'Local market — everyday high-street life on the doorstep.'
    : i.kind === 'culture' ? 'A cultural draw that pulls people (and demand) to the area.'
      : `Green space about ${Math.max(1, Math.round(i.distM / 80))} min walk away.`;
  const detours = [...pick(markets), ...pick(culture), ...pick(namedParks)]
    .slice(0, 3).map(i => ({ name: i.name, distM: i.distM, why: why(i), type: i.kind }));
  return { greenScore, amenitiesScore, greenCount: namedParks.length, topGreen: namedParks[0]?.name || null, detours };
}

// --- 4. TfL: nearest rail/tube stations + transport signal ---------------
async function transport(lat, lng, tflKey) {
  const key = tflKey ? `&app_key=${encodeURIComponent(tflKey)}` : '';
  const d = await getJson(`https://api.tfl.gov.uk/StopPoint?lat=${lat}&lon=${lng}&stopTypes=NaptanMetroStation,NaptanRailStation&radius=1300${key}`);
  const stops = (d.stopPoints || []).map(s => ({ name: s.commonName.replace(/ (Underground|DLR|Rail) Station$/i, ''), distM: Math.round(s.distance), modes: s.modes || [] }))
    .sort((a, b) => a.distM - b.distM);
  if (!stops.length) throw new Error('no stations');
  const modes = [...new Set(stops.flatMap(s => s.modes))];
  const nearest = stops[0];
  const proximity = clamp(72 - nearest.distM / 9, 0, 72);
  const breadth = clamp((stops.length - 1) * 5 + modes.length * 7, 0, 34);
  const score = clamp(proximity + breadth);
  return { score, nearest, count: stops.length, modes };
}

// --- 5. Police.uk: recorded street crime (volume, ~1 mile) ---------------
async function crime(lat, lng) {
  const now = new Date();
  for (let back = 2; back <= 5; back++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    try {
      const arr = await getJson(`https://data.police.uk/api/crimes-street/all-crime?lat=${lat}&lng=${lng}&date=${month}`, {}, 15000);
      if (Array.isArray(arr)) {
        const count = arr.length;
        const band = count < 500 ? 'Quieter for inner London' : count < 1000 ? 'Typical inner-London volume' : 'Busier, central-London volume';
        return { count, month, band };
      }
    } catch { /* try an earlier month */ }
  }
  throw new Error('no crime data');
}

// --- 6. Environment Agency: nearby designated flood-alert areas ----------
async function flood(lat, lng) {
  const d = await getJson(`https://environment.data.gov.uk/flood-monitoring/id/floodAreas?lat=${lat}&long=${lng}&dist=3`);
  const items = d.items || [];
  return { count: items.length, nearest: items[0]?.description || null };
}

// --- 7. HM Land Registry Price Paid: recent comparable sales nearby -------
async function recentSales(postcode, price, flat) {
  if (!postcode) return null;
  const d = await getJson(`https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(postcode)}&_pageSize=100&_sort=-transactionDate`);
  const items = d.result?.items || []; // newest-first
  if (!items.length) return null;
  const val = x => (x && typeof x === 'object' && '_value' in x) ? x._value : x;
  const title = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const rows = items.map(it => {
    const p = +val(it.pricePaid), dt = new Date(val(it.transactionDate)), a = it.propertyAddress || {};
    const uri = String(val(it.propertyType?._about) || '').toLowerCase();
    const type = uri.includes('flat') ? 'Flat' : uri.includes('terrac') ? 'Terraced' : uri.includes('semi') ? 'Semi' : uri.includes('detached') ? 'Detached' : 'Home';
    const label = title([val(a.saon), val(a.paon)].filter(Boolean).join(', ') || val(a.street) || '');
    return { price: p, date: isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10), type, uri, label };
  }).filter(r => r.price && r.date);
  // "Similar": same property type (flat), within a sensible band of the guide price,
  // and — recency matters for pricing — only the last few years.
  const WINDOW_YEARS = 5;
  const cutoff = new Date(Date.now() - WINDOW_YEARS * 365.25 * 864e5).toISOString().slice(0, 10);
  const lo = price ? price * 0.5 : 0, hi = price ? price * 1.7 : Infinity;
  const band = r => r.date >= cutoff && r.price >= lo && r.price <= hi;
  let sim = rows.filter(r => band(r) && (!flat || /flat|maison/.test(r.uri)));
  if (!sim.length) sim = rows.filter(band);
  if (!sim.length) return null;
  const sorted = sim.map(r => r.price).sort((a, b) => a - b);
  return {
    postcode, windowYears: WINDOW_YEARS, count: sim.length,
    since: Math.min(...sim.map(r => +r.date.slice(0, 4))),
    median: sorted[Math.floor(sorted.length / 2)],
    sales: sim.slice(0, 40).map(r => ({ price: r.price, date: r.date, type: r.type, label: r.label })),
  };
}

// --- orchestrate ---------------------------------------------------------
export async function computeInsights(property, opts = {}) {
  const { latitude: lat, longitude: lng, price, area } = property;
  const out = { area, district: null, postcode: null, computedAt: new Date().toISOString(), sources: [], scores: {}, drivers: [], nearby: [] };

  const loc = await locate(lat, lng).catch(() => null);
  if (loc) { out.district = loc.district; out.postcode = loc.postcode; out.sources.push('postcodes.io'); }

  const [pt, nb, tr, cr, fl, cp] = await Promise.all([
    (loc ? priceTrend(loc.district, price) : Promise.reject()).catch(() => null),
    nearby(lat, lng).catch(() => null),
    transport(lat, lng, opts.tflKey).catch(() => null),
    crime(lat, lng).catch(() => null),
    flood(lat, lng).catch(() => null),
    (loc ? recentSales(loc.postcode, price, property.flat) : Promise.reject()).catch(() => null),
  ]);

  if (pt) {
    out.price = { index: pt.index, changePct: pt.changePct, avgNow: pt.avgNow, fromYear: pt.fromYear };
    if (pt.valueScore != null) out.scores['Value'] = pt.valueScore;
    out.sources.push('HM Land Registry');
    out.drivers.push(`Area prices ${pt.changePct >= 0 ? 'up' : 'down'} ${Math.abs(pt.changePct)}% since ${pt.fromYear} (Land Registry)`);
  }
  if (tr) {
    out.scores['Transport'] = tr.score;
    out.nearestStation = tr.nearest;
    out.sources.push('TfL');
    const flavour = tr.modes.includes('elizabeth-line') ? ' — incl. Elizabeth line' : tr.modes.includes('dlr') ? ' — incl. DLR' : '';
    out.drivers.push(`${tr.nearest.name} ~${tr.nearest.distM}m (${tr.nearest.modes.join('/')})${flavour}`);
  }
  if (nb) {
    out.scores['Green space'] = nb.greenScore;
    out.scores['Amenities'] = nb.amenitiesScore;
    out.nearby = nb.detours;
    out.sources.push('OpenStreetMap');
    if (nb.greenCount) out.drivers.push(`${nb.greenCount} named park${nb.greenCount > 1 ? 's' : ''}/greens within ~1.3km${nb.topGreen ? ', incl. ' + nb.topGreen : ''}`);
  }
  if (cp) { out.comps = cp; if (!out.sources.includes('HM Land Registry')) out.sources.push('HM Land Registry'); }
  if (cr) { out.crime = cr; out.sources.push('Police.uk'); }
  if (fl) {
    out.flood = fl;
    out.sources.push('Environment Agency');
    if (fl.count) out.drivers.push(`Near ${fl.count} EA flood-alert area${fl.count > 1 ? 's' : ''} (mostly river) — worth checking the official flood map`);
  }
  if (pt && pt.flatNow && price) {
    out.drivers.push(`Guide price ${price < pt.flatNow ? 'below' : 'above'} the ${out.district || 'local'} flat average (${gbp(pt.flatNow)})`);
  }
  out.drivers = out.drivers.slice(0, 5);
  return out;
}
