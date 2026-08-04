import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { computeInsights } from './insights.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 5181);
const checkEveryMs = Number(process.env.CHECK_INTERVAL_MS || 12 * 60 * 60 * 1000);
const tflKey = process.env.TFL_APP_KEY || ''; // optional; area data still works without it
// A realistic browser UA makes the listing pages (and their photos) far more
// likely to load — some hosts block the default Node fetch UA.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Pull this listing's own photo + floorplan URLs out of the page HTML. The media
// URLs embed the listing's numeric id, so we filter to just this property (drops
// the "similar properties" images) and separate floorplans from photos.
function extractMedia(html, listingUrl) {
  const rmId = (String(listingUrl).match(/properties\/(\d+)/) || [])[1];
  if (!rmId) return { photos: [], floorplans: [], fetchedAt: new Date().toISOString() };
  const all = [...new Set((html.match(/https:\/\/media\.rightmove\.co\.uk\/[^"'\\ )]+\.(?:jpe?g|png)/gi) || []))]
    .filter(u => u.includes('/' + rmId + '/'));
  const floorplans = all.filter(u => /property-floorplan|_FLP_/i.test(u)).slice(0, 3);
  const photos = all.filter(u => !/property-floorplan|_FLP_|_max_/i.test(u)).slice(0, 24);
  return { photos, floorplans, fetchedAt: new Date().toISOString() };
}
async function storeMedia(id, media) {
  await db.execute({
    sql: `INSERT INTO media(property_id,data,fetched_at) VALUES(?,?,?)
          ON CONFLICT(property_id) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at`,
    args: [id, JSON.stringify(media), media.fetchedAt],
  });
}

// --- add-a-listing: extract a property from a pasted portal URL -----------
const PORTALS = /(?:^|\.)(?:rightmove\.co\.uk|zoopla\.co\.uk|onthemarket\.com|primelocation\.com)$/i;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&pound;/g, '£').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function ogMeta(html, k) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']og:${k}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:${k}["']`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}
async function geocode(postcode, outcode) {
  try { if (postcode) { const g = await getJsonQuick(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`); if (g.result) return { lat: g.result.latitude, lng: g.result.longitude, district: g.result.admin_district }; } } catch { }
  try { if (outcode) { const g = await getJsonQuick(`https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`); if (g.result) return { lat: g.result.latitude, lng: g.result.longitude, district: (g.result.admin_district || [])[0] }; } } catch { }
  return null;
}
async function getJsonQuick(u) { const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
function extractListing(html, href) {
  const title = ogMeta(html, 'title') || '';
  const descr = ogMeta(html, 'description') || '';
  const image = ogMeta(html, 'image');
  const text = `${descr} ${title}`;
  const beds = +((text.match(/(\d+)\s*bed/i) || [])[1] || 0) || null;
  const type = (text.match(/bedroom\s+([a-z][a-z-]*)\b/i) || [])[1] || (text.match(/\b(flat|maisonette|apartment|house|studio|bungalow|cottage|duplex)\b/i) || [])[1] || 'home';
  let price = null;
  const pm = html.match(/primaryPrice"[^>]*><span>£([\d,]+)/) || descr.match(/£\s?([\d,]{4,})/) || html.match(/£\s?([\d,]{4,})/);
  if (pm) price = +pm[1].replace(/,/g, '');
  let area = (descr.match(/\bin\s+(.+?)\s+for\s+£/i) || [])[1] || (title.match(/\bin\s+(.+?)(?:\s+for|$)/i) || [])[1] || '';
  area = area.replace(/,?\s*United Kingdom\s*$/i, '').replace(/\s+/g, ' ').trim();
  // Read location ONLY from the listing's own description (the page HTML is full
  // of postcode-shaped junk like CSS hashes). Full postcode if present, else the
  // outward code (e.g. "E1W") — the last postcode-shaped token in the area text.
  const pcD = descr.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/);
  const postcode = pcD ? `${pcD[1]} ${pcD[2]}` : null;
  const outcodes = [...area.matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/g)].map(m => m[1]);
  const outcode = outcodes[outcodes.length - 1] || null;
  const media = extractMedia(html, href);
  if (!media.photos.length && image) media.photos = [image];
  return { title, descr, beds, type, price, area, postcode, outcode, media };
}
async function addListing(listingUrl) {
  const u = new URL(listingUrl);
  if (!PORTALS.test(u.hostname)) return { error: 'Please paste a Rightmove, Zoopla, OnTheMarket or PrimeLocation link.' };
  let resp;
  try { resp = await fetch(u.href, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) }); }
  catch { return { error: 'Could not reach that page.' }; }
  if (!resp.ok) return { error: `That page returned ${resp.status}.` + (/zoopla/i.test(u.hostname) ? ' Zoopla often blocks automated reads — a Rightmove link is most reliable.' : '') };
  const html = await resp.text();
  const ex = extractListing(html, u.href);
  const geo = await geocode(ex.postcode, ex.outcode);
  if (!geo) return { error: 'Could not work out the location from that page. A Rightmove link works best.' };
  if (!ex.price) return { error: 'Could not read the price from that page.' };
  const rmId = (u.href.match(/(\d{5,})/) || [])[1];
  const prefix = /rightmove/i.test(u.hostname) ? 'rm-' : /zoopla/i.test(u.hostname) ? 'zp-' : /onthemarket/i.test(u.hostname) ? 'otm-' : 'pl-';
  const id = prefix + (rmId || slug(ex.area).slice(0, 24) || Math.abs([...u.href].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36));
  const exists = (await db.execute({ sql: 'SELECT id FROM properties WHERE id=?', args: [id] })).rows[0];
  const street = (ex.area.split(',')[0] || ex.area || 'Home').trim();
  const name = `${ex.beds ? ex.beds + ' bed ' : ''}${ex.type}, ${street}`.trim();
  const areaLabel = (ex.area || [geo.district, ex.outcode].filter(Boolean).join(', ') || 'Location').slice(0, 80);
  if (!exists) {
    await db.execute({
      sql: `INSERT INTO properties (id,name,area,price,bedrooms,size,latitude,longitude,listing_url,recommendation,confidence,agent_view,checks,tags,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, name, areaLabel, ex.price, ex.beds || 0, 'Size TBC', geo.lat, geo.lng, u.href, 'View', 'Medium',
        (ex.descr ? ex.descr.replace(/\s+/g, ' ').trim() : 'Added from a listing link.'),
        'Ask for: service charge, lease length, EPC, exact floor plan and a viewing. Confirm the precise location and any planned works.',
        [ex.type, ex.outcode].filter(Boolean).join('|'), new Date().toISOString()],
    });
    if (ex.media.photos.length || ex.media.floorplans.length) await storeMedia(id, ex.media);
    (async () => {
      try {
        const data = await computeInsights({ latitude: geo.lat, longitude: geo.lng, price: ex.price, area: areaLabel }, { tflKey });
        await db.execute({ sql: `INSERT INTO insights(property_id,data,computed_at) VALUES(?,?,?) ON CONFLICT(property_id) DO UPDATE SET data=excluded.data,computed_at=excluded.computed_at`, args: [id, JSON.stringify(data), data.computedAt] });
      } catch { }
    })();
  }
  return { ok: true, id, name, existing: !!exists };
}

// Database selection:
//  - In production, set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) and data lives
//    in Turso's cloud, so it survives redeploys on hosts with no persistent disk.
//  - Locally, with those unset, it falls back to a plain SQLite file on disk.
const localPath = process.env.DB_PATH || join(root, 'data', 'nest.sqlite');
const db = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : (mkdirSync(dirname(localPath), { recursive: true }), createClient({ url: 'file:' + localPath.replace(/\\/g, '/') }));

async function initialise() {
  await db.executeMultiple(`CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL, price INTEGER NOT NULL,
    bedrooms INTEGER NOT NULL, size TEXT, latitude REAL NOT NULL, longitude REAL NOT NULL,
    listing_url TEXT NOT NULL, recommendation TEXT NOT NULL, confidence TEXT NOT NULL,
    agent_view TEXT NOT NULL, checks TEXT NOT NULL, tags TEXT NOT NULL,
    availability TEXT NOT NULL DEFAULT 'available', last_checked TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feedback (
    property_id TEXT NOT NULL, person TEXT NOT NULL, verdict TEXT, note TEXT,
    updated_at TEXT NOT NULL, PRIMARY KEY(property_id, person),
    FOREIGN KEY(property_id) REFERENCES properties(id)
  );
  CREATE TABLE IF NOT EXISTS insights (
    property_id TEXT PRIMARY KEY, data TEXT NOT NULL, computed_at TEXT NOT NULL,
    FOREIGN KEY(property_id) REFERENCES properties(id)
  );
  CREATE TABLE IF NOT EXISTS media (
    property_id TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL,
    FOREIGN KEY(property_id) REFERENCES properties(id)
  );`);
  const count = (await db.execute('SELECT COUNT(*) AS n FROM properties')).rows[0].n;
  if (!count) await seed();
}

async function seed() {
  const created = new Date().toISOString();
  const sql = `INSERT INTO properties
    (id,name,area,price,bedrooms,size,latitude,longitude,listing_url,recommendation,confidence,agent_view,checks,tags,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const data = [
    ['bruce-road','Bruce Road maisonette','Bow, E3',475000,2,'68m² / 736 sq ft',51.526354,-0.015993,'https://www.rightmove.co.uk/properties/89030907','View','High','This is the one I would call about first. It gives you a real private garden, a sensible 68m², a separate kitchen and room in the budget for the inevitable first-home costs. It is not a buy-from-the-photos home: the value depends on the natural light, the condition and how the route feels when you leave the station.','Ask for: service charge, lease length, EPC, exact floor plan, and a viewing late enough to test the walk from Bromley-by-Bow. Make sure the garden is genuinely private and usable.','garden|good value|separate kitchen|Bow'],
    ['ermine-house','Ermine House garden flat','Parnell Road, Bow, E3',450000,2,'Size TBC',51.533283,-0.025893,'https://www.rightmove.co.uk/properties/87593172','View','Medium','This has the ingredients that often make a home feel good in daily life: private outside space, a bright reception opening outside, Victoria Park nearby and Roman Road on hand. It is compelling at the guide price, but I would not let the styling sell it to you: the listing says some images are digitally enhanced.','Ask for: total internal area, service charge, ground rent, lease details and whether there are planned works. At the viewing, test ground-floor privacy, noise and whether the patio receives usable light.','private patio|Victoria Park|chain free|Bow'],
    ['blackhorse-road','Blackhorse Road Warner flat','Walthamstow, E17',500000,2,'64m² / 686 sq ft',51.585655,-0.039371,'https://www.rightmove.co.uk/properties/89982033','Watch','Medium','This is a deliberate test of the better-everyday-location versus private-outdoor-space trade-off. The building character, two double bedrooms and three-minute station walk are attractive; it is outside the original location core, so it only earns a viewing if the floor plan and photos make you excited.','Ask for: service charge, shared-garden arrangement, any loft rights, and the exact evening feel around Blackhorse Road. The reported lease is 114 years with £200 ground rent: verify before becoming attached.','period character|fast transport|shared garden|exploratory area'],
  ];
  await db.batch(data.map(row => ({ sql, args: [...row, created] })), 'write');
}

async function rows(person) {
  const properties = (await db.execute('SELECT * FROM properties ORDER BY created_at DESC')).rows;
  const feedback = (await db.execute('SELECT property_id, person, verdict, note, updated_at FROM feedback')).rows;
  const insights = (await db.execute('SELECT property_id, data FROM insights')).rows;
  const media = (await db.execute('SELECT property_id, data FROM media')).rows;
  return properties.map(p => {
    const ins = insights.find(i => i.property_id === p.id);
    const med = media.find(m => m.property_id === p.id);
    return {
      ...p,
      tags: String(p.tags).split('|'),
      feedback: feedback.filter(f => f.property_id === p.id),
      mine: feedback.find(f => f.property_id === p.id && f.person === person) || null,
      insights: ins ? JSON.parse(ins.data) : null,
      media: med ? JSON.parse(med.data) : null,
    };
  });
}

// Fetch listing pages to fill any missing galleries (used on first boot).
async function bootstrapMedia() {
  const props = (await db.execute("SELECT id, listing_url FROM properties WHERE id NOT IN (SELECT property_id FROM media)")).rows;
  for (const p of props) {
    try {
      const res = await fetch(p.listing_url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      const m = extractMedia(await res.text(), p.listing_url);
      if (m.photos.length || m.floorplans.length) await storeMedia(p.id, m);
      console.log(`media ${p.id}: ${m.photos.length} photos, ${m.floorplans.length} floorplans`);
    } catch (e) { console.log(`media ${p.id}: failed (${e && e.message})`); }
    await new Promise(r => setTimeout(r, 800));
  }
}

// Compute live area intelligence for every property and cache it in the DB.
// Sequential with a gap so we stay gentle on the shared public APIs (esp. Overpass).
async function refreshInsights() {
  const props = (await db.execute('SELECT id, area, price, latitude, longitude FROM properties')).rows;
  const done = [];
  for (const p of props) {
    try {
      const data = await computeInsights(p, { tflKey });
      await db.execute({
        sql: `INSERT INTO insights(property_id,data,computed_at) VALUES(?,?,?)
              ON CONFLICT(property_id) DO UPDATE SET data=excluded.data,computed_at=excluded.computed_at`,
        args: [p.id, JSON.stringify(data), data.computedAt],
      });
      done.push({ id: p.id, sources: data.sources.length });
    } catch (e) { done.push({ id: p.id, error: String(e && e.message || e) }); }
    await new Promise(r => setTimeout(r, 3000));
  }
  return done;
}

function send(res, code, body, type = 'application/json; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function csv(value) { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

async function exportCsv() {
  const headings = ['Property', 'Area', 'Price', 'Bedrooms', 'Size', 'Recommendation', 'Confidence', 'Availability', 'Listing link', 'Latitude', 'Longitude', 'Last checked', 'Ralf verdict', 'Ralf note', 'Hannah verdict', 'Hannah note', 'Agent view', 'Checks'];
  const all = await rows('');
  const lines = all.map(p => {
    const f = person => p.feedback.find(x => x.person.toLowerCase() === person.toLowerCase()) || {};
    return [p.name, p.area, p.price, p.bedrooms, p.size, p.recommendation, p.confidence, p.availability, p.listing_url, p.latitude, p.longitude, p.last_checked, f('Ralf').verdict, f('Ralf').note, f('Hannah').verdict, f('Hannah').note, p.agent_view, p.checks].map(csv).join(',');
  });
  return [headings.join(','), ...lines].join('\r\n');
}

async function refresh() {
  const items = (await db.execute({ sql: 'SELECT id, listing_url FROM properties WHERE availability != ?', args: ['off-market'] })).rows;
  const now = new Date().toISOString();
  const results = [];
  for (const item of items) {
    try {
      const response = await fetch(item.listing_url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' } });
      const html = await response.text();
      const page = html.toLowerCase();
      const unavailable = !response.ok || /sold stc|no longer available|property has been removed|this property is no longer/.test(page);
      await db.execute({ sql: 'UPDATE properties SET availability=?, last_checked=? WHERE id=?', args: [unavailable ? 'off-market' : 'available', now, item.id] });
      // Reuse the page we just downloaded to refresh the photo/floorplan gallery.
      try { const m = extractMedia(html, item.listing_url); if (m.photos.length || m.floorplans.length) await storeMedia(item.id, m); } catch { /* leave last-good media */ }
      results.push({ id: item.id, status: unavailable ? 'off-market' : 'available' });
    } catch {
      await db.execute({ sql: 'UPDATE properties SET availability=?, last_checked=? WHERE id=?', args: ['needs-check', now, item.id] });
      results.push({ id: item.id, status: 'needs-check' });
    }
  }
  refreshInsights().catch(() => {}); // recompute area data in the background so the button returns quickly
  return { availability: results };
}

function staticFile(pathname) {
  const clean = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = normalize(join(root, clean));
  return full.startsWith(root) && existsSync(full) ? full : null;
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

await initialise();

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/properties' && req.method === 'GET') return send(res, 200, JSON.stringify(await rows(url.searchParams.get('person') || '')));
  if (url.pathname === '/api/export.csv' && req.method === 'GET') return send(res, 200, await exportCsv(), 'text/csv; charset=utf-8');
  if (url.pathname === '/api/refresh' && req.method === 'POST') return send(res, 200, JSON.stringify(await refresh()));
  if (url.pathname === '/api/properties' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const { url: listingUrl } = JSON.parse(body || '{}');
      if (!listingUrl) return send(res, 400, JSON.stringify({ error: 'No link provided.' }));
      const result = await addListing(listingUrl);
      return send(res, result.error ? 422 : 200, JSON.stringify(result));
    } catch (e) { return send(res, 400, JSON.stringify({ error: 'Could not add that link.' })); }
  }
  const del = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    const id = del[1];
    for (const t of ['feedback', 'insights', 'media']) await db.execute({ sql: `DELETE FROM ${t} WHERE property_id=?`, args: [id] });
    await db.execute({ sql: 'DELETE FROM properties WHERE id=?', args: [id] });
    return send(res, 200, JSON.stringify({ ok: true }));
  }
  const match = url.pathname.match(/^\/api\/properties\/([^/]+)\/feedback$/);
  if (match && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { person, verdict, note } = JSON.parse(body);
      if (!['Ralf', 'Hannah'].includes(person)) throw new Error('person');
      if (!['Love', 'View', 'Watch', 'Pass', null].includes(verdict)) throw new Error('verdict');
      await db.execute({
        sql: `INSERT INTO feedback(property_id,person,verdict,note,updated_at) VALUES(?,?,?,?,?)
              ON CONFLICT(property_id,person) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,updated_at=excluded.updated_at`,
        args: [match[1], person, verdict, note || '', new Date().toISOString()],
      });
      return send(res, 200, JSON.stringify({ ok: true }));
    } catch { return send(res, 400, JSON.stringify({ error: 'Invalid feedback' })); }
  }
  const file = staticFile(url.pathname);
  if (!file) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  try { return send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream'); }
  catch { return send(res, 500, 'Could not load file', 'text/plain; charset=utf-8'); }
}).listen(port, () => console.log(`Nest is running at http://127.0.0.1:${port}`));

// On first boot (or after adding a home), fill any missing area intelligence in
// the background so it's ready without the user pressing anything.
(async () => {
  try {
    const have = (await db.execute('SELECT COUNT(*) AS n FROM insights')).rows[0].n;
    const total = (await db.execute('SELECT COUNT(*) AS n FROM properties')).rows[0].n;
    if (have < total) { console.log('Computing area intelligence in the background…'); await refreshInsights(); console.log('Area intelligence ready.'); }
  } catch (e) { console.log('Area-intelligence bootstrap skipped:', e && e.message); }
  try { console.log('Fetching listing galleries…'); await bootstrapMedia(); console.log('Galleries ready.'); }
  catch (e) { console.log('Gallery bootstrap skipped:', e && e.message); }
})();

setInterval(() => refresh().catch(() => {}), checkEveryMs).unref();
