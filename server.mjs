import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import { computeInsights, recentSales } from './insights.mjs';

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
  const id = (String(listingUrl).match(/(\d{5,})/) || [])[1]; // rightmove /properties/ID, OTM /details/ID
  if (!id) return { photos: [], floorplans: [], fetchedAt: new Date().toISOString() };
  const rx = /https:\/\/media\.(?:rightmove\.co\.uk|onthemarket\.com)\/[^"'\\ )]+\.(?:jpe?g|png|gif|webp)/gi;
  // Scan the raw HTML AND a copy with escaped slashes (\/) unescaped, so floorplan/photo
  // URLs that only appear inside the page's JSON data are caught too.
  const all = [...new Set([...(html.match(rx) || []), ...(html.replace(/\\\//g, '/').match(rx) || [])])];
  const isFloor = u => /property-floorplan|_FLP_|floorplan/i.test(u);
  // The same image often appears at several sizes (a tiny "_max_296x197" thumbnail
  // AND a full-res version). Group by the image's hash and keep the largest — the
  // unsized full-res URL beats any sized thumbnail.
  const dedupe = urls => {
    const groups = new Map();
    for (const u of urls) {
      const hash = (u.match(/([a-f0-9]{20,})/) || [u])[0];
      const sized = u.match(/(?:_max_|[-_])(\d{2,4})x\d{2,4}\.(?:png|jpe?g|gif|webp)/i);
      const rank = sized ? +sized[1] : 100000;   // full-res (no size suffix) wins
      const prev = groups.get(hash);
      if (!prev || rank > prev.rank) groups.set(hash, { u, rank });
    }
    return [...groups.values()].map(x => x.u);
  };
  // Floorplans: a `property-floorplan` URL is always this listing's own, so don't require
  // the id (some don't include it). Photos: keep the id filter to drop "similar properties".
  const floorplans = dedupe(all.filter(isFloor)).slice(0, 4);
  const photos = dedupe(all.filter(u => !isFloor(u) && u.includes('/' + id + '/'))).slice(0, 30);
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
// Tenure (Leasehold / Freehold / Share of freehold) + years left on the lease, if the
// listing states them. Two sources: the visible "TENURE" info-reel and the page data
// (`…"yearsRemainingOnLease":N…},"LEASEHOLD",999,` — tenure then years-remaining).
function extractTenure(html) {
  let tenure = null, leaseYears = null;
  const tm = html.match(/>TENURE<[\s\S]{0,220}?<p[^>]*>([^<]{3,40})<\/p>/i);
  if (tm && /lease|free|commonhold|share/i.test(tm[1])) tenure = tm[1].replace(/\s+/g, ' ').trim();
  // Quotes in this data are backslash-escaped (\"LEASEHOLD\",999) — tolerate the backslashes.
  const lm = html.match(/yearsRemainingOnLease\\?":\d+[\s\S]{0,40}?\},\\?"([A-Za-z ]+?)\\?",(\d+)/);
  if (lm) {
    if (!tenure && /lease|free|share|common/i.test(lm[1])) { const s = lm[1].toLowerCase(); tenure = s.charAt(0).toUpperCase() + s.slice(1); }
    const y = +lm[2]; if (y >= 1 && y <= 1200) leaseYears = y;
  }
  if (tenure && /^free/i.test(tenure)) leaseYears = null; // freehold has no lease term
  return { tenure, leaseYears };
}
// Floor area as "NN sq m" (metric, per preference). Reads the number printed on the
// floor plan / stated in the listing — from the visible size info-reel first, then the
// page data; converts from sq ft only if that's all the listing gives.
function extractSize(html) {
  const sm = html.match(/>\s*([\d,]{1,6})\s*sq\s*m\s*<\/p>/i);
  if (sm) { const m = +sm[1].replace(/,/g, ''); if (m >= 10 && m <= 5000) return `${m} sq m`; }
  const ft = html.match(/>\s*([\d,]{2,7})\s*sq\s*ft\s*<\/p>/i);
  if (ft) { const f = +ft[1].replace(/,/g, ''); if (f >= 100 && f <= 100000) return `${Math.round(f * 0.092903)} sq m`; }
  const rm = html.match(/sqm\\?",\\?"sq\.?\s*m\.?\\?",(\d{2,5})/i);
  if (rm) { const m = +rm[1]; if (m >= 10 && m <= 5000) return `${m} sq m`; }
  const rf = html.match(/sqft\\?",\\?"sq\.?\s*ft\.?\\?",(\d{3,6})/i);
  if (rf) { const f = +rf[1]; if (f >= 100 && f <= 100000) return `${Math.round(f * 0.092903)} sq m`; }
  // Some listings only carry it as e.g. "minimumArea":"992 sq ft / 92 sq m".
  const ma = html.match(/minimumArea\\?"\s*:\s*\\?"([^"\\]{3,40})/i);
  if (ma) { const s = sizeFromText(ma[1], 10); if (s) return s; }
  // Last resort: the agent's own words in the description / key features
  // ("spans approximately 749 sqft", "722 Square Feet (Approximately)").
  return sizeFromText(html.replace(/<[^>]+>/g, ' '), 25);
}
// Largest plausible floor area mentioned in free text, in sq m. Small figures (balconies,
// gardens, single rooms) are ignored by the `floor` minimum.
function sizeFromText(text, floor) {
  const re = /(\d{1,2}(?:,\d{3})|\d{2,5}(?:\.\d+)?)\s*(sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee|oo)t|sq\.?\s*m(?:etres|eters)?\b\.?|sqm|m²|square\s*met(?:re|er)s)/gi;
  let best = null;
  const t = String(text);
  for (const m of t.matchAll(re)) {
    // Skip figures describing part of the home or its outside space ("garden 30 sq m").
    if (/(garden|terrace|balcon|patio|roof|yard|plot|land|bed ?room|room|kitchen|living|reception|lounge|storage|loft|garage|shed|office)\b[^.\d]{0,25}$/i.test(t.slice(Math.max(0, m.index - 40), m.index))) continue;
    const n = +m[1].replace(/,/g, ''), ft = /f/i.test(m[2]);
    const sqm = Math.round(ft ? n * 0.092903 : n);
    if (sqm >= floor && sqm <= 500 && (best == null || sqm > best)) best = sqm;
  }
  return best != null ? `${best} sq m` : null;
}
// Floor-plan text (from OCR): prefer a labelled total ("Gross Internal Area 697 Sq Ft",
// "TOTAL: 70.3m²" — OCR often turns ² into ? or 2), else any plausible total area.
function sizeFromPlanText(text) {
  const re = /(?:total|gross\s+internal\s+area|internal\s+area|floor\s+area|\bG\.?I\.?A\b)[^0-9\n]{0,20}(\d{1,2},\d{3}|\d{2,5}(?:\.\d+)?)\s*(sq\.?\s*f(?:ee)?t|sqft|sq\.?\s*m|sqm|m[²2?]?(?![a-z]))/gi;
  let best = null;
  for (const m of String(text).matchAll(re)) {
    const n = +m[1].replace(/,/g, ''), sqm = Math.round(/f/i.test(m[2]) ? n * 0.092903 : n);
    if (sqm >= 15 && sqm <= 500 && (best == null || sqm > best)) best = sqm;
  }
  return best != null ? `${best} sq m` : sizeFromText(text, 25);
}
// Read the size off the floor plan image for homes whose listing doesn't state one.
// Uses tesseract.js (loaded only when needed). One OCR batch at a time keeps memory low,
// and each floor plan is read once (size_plan_checked remembers which image was tried).
let planQueue = Promise.resolve();
function planSizes(ids) {
  planQueue = planQueue.then(() => planSizesNow(ids)).catch(e => console.log('Floor-plan size read failed:', e && e.message));
  return planQueue;
}
async function planSizesNow(ids) {
  if (!ids || !ids.length) return;
  const rows = (await db.execute({ sql: `SELECT p.id, p.size, p.size_plan_checked, m.data FROM properties p JOIN media m ON m.property_id=p.id WHERE p.id IN (${ids.map(() => '?').join(',')})`, args: ids })).rows;
  const todo = rows.map(r => ({ id: r.id, plans: (JSON.parse(r.data || '{}').floorplans || []), r }))
    .filter(x => x.plans.length && (!x.r.size || /tbc/i.test(x.r.size)) && x.r.size_plan_checked !== x.plans[0]);
  if (!todo.length) return;
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    for (const x of todo) {
      let found = null;
      for (const url of x.plans.slice(0, 3)) {
        try {
          const img = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) })).arrayBuffer());
          const { data } = await worker.recognize(img);
          found = sizeFromPlanText(data.text);
          if (found) break;
        } catch { }
      }
      await db.execute({ sql: 'UPDATE properties SET size=COALESCE(?, size), size_plan_checked=? WHERE id=?', args: [found, x.plans[0], x.id] });
      if (found) console.log(`Floor plan size for ${x.id}: ${found}`);
    }
  } finally { await worker.terminate(); }
}
// Turn a human date ("15 December 2026", "15th Dec 2026", "now") into an ISO date.
function parseHumanDate(s) {
  const t = String(s || '').trim().replace(/(\d+)(?:st|nd|rd|th)/i, '$1');
  if (/^(now|immediately|today)$/i.test(t)) return new Date().toISOString().slice(0, 10);
  const d = new Date(t);
  return (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() < 2100) ? d.toISOString().slice(0, 10) : null;
}
// When a home is available to move into — mostly a rental concept ("Let available date"),
// but sale listings sometimes state one too. Returns an ISO date, or null if not stated.
function extractAvailable(html) {
  // Rightmove's visible reel: <dt>Let available date: </dt><dd>Now</dd> or <dd>01/10/2026</dd>.
  const reel = html.match(/Let available date:\s*<\/dt>\s*<dd>([^<]+)<\/dd>/i);
  if (reel) {
    const v = reel[1].trim();
    if (/^(now|immediately|today|available)$/i.test(v)) return new Date().toISOString().slice(0, 10);
    const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // DD/MM/YYYY (UK order)
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    const d = parseHumanDate(v); if (d) return d;
  }
  const j = html.match(/letAvailableDate\\?"\s*:\s*\\?"(\d{4}-\d{2}-\d{2})/i);
  if (j) return j[1];
  const m = html.match(/Available\s+(?:from\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,}\s+\d{4})/i);
  if (m) { const d = parseHumanDate(m[1]); if (d) return d; }
  if (/\bavailable\s+(?:now|immediately)\b/i.test(html)) return new Date().toISOString().slice(0, 10);
  return null;
}
// Last recorded sale from HM Land Registry Price Paid data (by postcode). If the listing
// address carries a house/flat number we can match the exact unit; otherwise we return
// the most recent sale in that postcode, flagged as not-exact so the UI can say so.
// Returns {price,date,exact} or null when the query succeeds but nothing comparable is
// found. Throws on a network/HTTP failure so callers can tell "no record" from "lookup
// failed" (and not wipe a good stored value on a blip).
async function fetchSold(postcode, address, opts = {}) {
  if (!postcode) return null;
  const data = await getJsonQuick(`https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(postcode)}&_pageSize=60&_sort=-transactionDate`);
  const items = (data.result && data.result.items) || []; // already newest-first
  if (!items.length) return null;
  const val = x => (x && typeof x === 'object' && '_value' in x) ? x._value : x;
  const up = s => String(s == null ? '' : val(s)).toUpperCase();
  const out = it => { const price = +val(it.pricePaid), d = new Date(val(it.transactionDate)); return (price && !isNaN(d.getTime())) ? { price, date: d.toISOString().slice(0, 10) } : null; };
  // 1) Exact unit match when the listing address carries a house/flat number.
  const nums = [...String(address || '').matchAll(/\b(\d{1,4}[a-z]?)\b/gi)].map(m => m[1].toUpperCase());
  if (nums.length) {
    const m = items.find(it => { const a = it.propertyAddress || {}, paon = up(a.paon), saon = up(a.saon); return nums.some(n => paon === n || saon === n || saon === `FLAT ${n}` || paon.split(/\W+/).includes(n) || saon.split(/\W+/).includes(n)); });
    if (m) { const o = out(m); if (o) return { ...o, exact: true }; }
  }
  // 2) Otherwise the most recent COMPARABLE sale in the postcode: same property type
  //    (flat) and within a sane band of the asking price — avoids quoting a nearby
  //    mansion's price for a small flat.
  const lo = opts.price ? opts.price * 0.4 : 0, hi = opts.price ? opts.price * 1.8 : Infinity;
  const comp = items.find(it => {
    const price = +val(it.pricePaid); if (!(price >= lo && price <= hi)) return false;
    if (opts.flat) { const t = up(it.propertyType && it.propertyType._about); if (t && !/FLAT|MAISON/.test(t)) return false; }
    return true;
  });
  if (comp) { const o = out(comp); if (o) return { ...o, exact: false }; }
  return null;
}
function extractListing(html, href) {
  const title = ogMeta(html, 'title') || '';
  const descr = ogMeta(html, 'description') || '';
  const image = ogMeta(html, 'image');
  const text = `${title} ${descr}`;               // title first — it usually has the price
  const beds = +((text.match(/(\d+)\s*bed/i) || [])[1] || 0) || null;
  const type = (text.match(/bedroom\s+([a-z][a-z-]*)\b/i) || [])[1] || (text.match(/\b(flat|maisonette|apartment|house|studio|bungalow|cottage|duplex)\b/i) || [])[1] || 'home';
  // Buy vs rent: the OG title/description says "for rent"/"for sale", the price shows as
  // "£X pcm", and the page's agent links carry transactionType=lettings. Rent prices are
  // monthly (pcm) — stored in `price` and shown as £X pcm.
  const rentSignal = /\b(?:to|for)\s+rent\b|property-to-rent|£[\d,]+\s*(?:pcm|per\s*month|pw|per\s*week)|transactionType=lettings/i;
  const channel = (rentSignal.test(`${title} ${descr} ${href}`) || /transactionType=lettings|\\?"channel\\?"\s*:\s*\\?"RENT/i.test(html)) ? 'rent' : 'buy';
  let price = null;
  if (channel === 'rent') {
    const rpm = text.match(/£\s?([\d,]+)\s*(?:pcm|per\s*month|pm\b)/i) || html.match(/primaryPrice"[^>]*><span>£([\d,]+)/) || text.match(/£\s?([\d,]{3,})/);
    if (rpm) price = +rpm[1].replace(/,/g, '');
    if (!price) { const pw = text.match(/£\s?([\d,]+)\s*(?:pw|per\s*week)/i); if (pw) price = Math.round(+pw[1].replace(/,/g, '') * 52 / 12); }
  } else {
    const pm = text.match(/£\s?([\d,]{4,})/) || html.match(/primaryPrice"[^>]*><span>£([\d,]+)/) || html.match(/£\s?([\d,]{4,})/);
    if (pm) price = +pm[1].replace(/,/g, '');
  }
  // Location comes from the listing's own OG text (title/description) — never a
  // whole-page scrape, which is full of postcode-shaped junk (CSS hashes etc).
  let area = (descr.match(/\bin\s+(.+?)\s+for\s+£/i) || [])[1]                 // "…in Bruce Road, E3 for £…"
    || (title.match(/^(.+?),?\s*\d+\s*bed\b/i) || [])[1]                       // "Mildmay Grove South, London, N1 2 bed…"
    || (descr.match(/\bin\s+([A-Za-z0-9 ,'-]+?)(?:\.|$)/i) || [])[1]           // "…for sale in Mildmay Grove South, London, N1"
    || (title.match(/\bin\s+(.+?)(?:\s+for|$)/i) || [])[1] || '';
  area = area.replace(/,?\s*United Kingdom\s*$/i, '').replace(/\s+/g, ' ').trim();
  const locText = `${area} ${title} ${descr}`;
  const pcD = locText.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/);      // full postcode in the OG text
  let postcode = pcD ? `${pcD[1]} ${pcD[2]}` : null;
  const outcodes = [...area.matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/g)].map(m => m[1]);
  const outcode = outcodes[outcodes.length - 1] || null;
  // If the OG text only exposed an outcode (e.g. "E17"), recover the FULL postcode from
  // the page body so we can geocode to the exact street instead of the outcode centroid.
  // The property's own postcode sits right next to its listing id in the page data
  // (e.g. "E3 3HY","Resale","None",89030907); the estate agent's postcode is elsewhere,
  // so we pick by PROXIMITY to the id — not frequency (the agent's can appear more often).
  const rmId = (href.match(/\/properties\/(\d{5,})/) || href.match(/(\d{6,})/) || [])[1];
  if (!postcode && rmId) {
    const idPos = [];
    for (const m of html.matchAll(new RegExp(rmId, 'g'))) idPos.push(m.index);
    if (idPos.length) {
      let best = null, bestD = Infinity;
      for (const m of html.matchAll(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g)) {
        const oc = m[0].replace(/\s?\d[A-Z]{2}$/i, '').toUpperCase();
        if (outcode && oc !== outcode.toUpperCase()) continue; // keep it in the listing's own area
        const d = Math.min(...idPos.map(p => Math.abs(p - m.index)));
        if (d < bestD) { bestD = d; best = m[0]; }
      }
      if (best && bestD < 200) { const s = best.replace(/\s+/g, '').toUpperCase(); postcode = s.slice(0, -3) + ' ' + s.slice(-3); }
    }
  }
  // Precise coordinates if the page embeds them (OnTheMarket does); else null.
  const cm = html.match(/"lat(?:itude)?"\s*:\s*(-?5\d\.\d{3,})[\s\S]{0,40}?"l(?:ng|on|ongitude)"\s*:\s*(-?\d\.\d{3,})/);
  const coords = cm ? { lat: +cm[1], lng: +cm[2] } : null;
  const media = extractMedia(html, href);
  if (!media.photos.length && image) media.photos = [image];
  const { tenure, leaseYears } = extractTenure(html);
  const size = extractSize(html);
  // "Added on 03/08/2026" / "Reduced on 03/08/2026" → ISO date + which reason.
  let listedDate = null, listedReason = null;
  const dm = html.match(/\b(Added|Reduced) on (\d{2})\/(\d{2})\/(\d{4})\b/i);
  if (dm) { listedReason = dm[1].toLowerCase(); listedDate = `${dm[4]}-${dm[3]}-${dm[2]}`; }
  const availableFrom = extractAvailable(html);
  return { title, descr, beds, type, price, area, postcode, outcode, coords, media, tenure, leaseYears, size, listedDate, listedReason, channel, availableFrom };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function addListing(listingUrl, opts = {}) {
  const u = new URL(listingUrl);
  if (!PORTALS.test(u.hostname)) return { error: 'Please paste a Rightmove, Zoopla, OnTheMarket or PrimeLocation link.' };
  let resp;
  try { resp = await fetch(u.href, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) }); }
  catch { return { error: 'Could not reach that page.' }; }
  if (!resp.ok) return { error: `That page returned ${resp.status}.` + (/zoopla/i.test(u.hostname) ? ' Zoopla often blocks automated reads — a Rightmove link is most reliable.' : '') };
  const html = await resp.text();
  const ex = extractListing(html, u.href);
  // A first fetch occasionally lands on a consent/bot page with no images; retry once so
  // the floor plan/photos (and size) reliably come through when adding a link.
  if (!ex.media.photos.length && !ex.media.floorplans.length) {
    try {
      await sleep(1200);
      const r2 = await fetch(u.href, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (r2.ok) { const h2 = await r2.text(); const m2 = extractMedia(h2, u.href); if (m2.photos.length || m2.floorplans.length) ex.media = m2; if (!ex.size) { const s2 = extractSize(h2); if (s2) ex.size = s2; } if (!ex.availableFrom) { const a2 = extractAvailable(h2); if (a2) ex.availableFrom = a2; } }
    } catch { }
  }
  let lat = ex.coords ? ex.coords.lat : null, lng = ex.coords ? ex.coords.lng : null, district = null;
  if (lat == null) { const geo = await geocode(ex.postcode, ex.outcode); if (geo) { lat = geo.lat; lng = geo.lng; district = geo.district; } }
  if (lat == null) return { error: 'Could not work out the location from that page. A Rightmove link works best.' };
  if (!ex.price) return { error: 'Could not read the price from that page.' };
  if (opts.window && !inWindow(ex.availableFrom, opts.window)) return { ok: false, skipped: 'window', availableFrom: ex.availableFrom };
  if (opts.minSqm && sqmOf(ex.size) != null && sqmOf(ex.size) < opts.minSqm) return { ok: false, skipped: 'size', size: ex.size };
  const wsId = opts.wsId || DEFAULT_WS;
  const rmId = (u.href.match(/(\d{5,})/) || [])[1];
  const prefix = /rightmove/i.test(u.hostname) ? 'rm-' : /zoopla/i.test(u.hostname) ? 'zp-' : /onthemarket/i.test(u.hostname) ? 'otm-' : 'pl-';
  const baseId = prefix + (rmId || slug(ex.area).slice(0, 24) || Math.abs([...u.href].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36));
  // Property ids are globally unique (the PK), so namespace them per workspace — the same
  // listing can live in two different couples' spaces. The default space keeps bare ids.
  const id = wsId === DEFAULT_WS ? baseId : `${baseId}@${wsId.slice(-8)}`;
  // "Already have it" is scoped to THIS workspace (matched by the listing URL, robust to
  // the id scheme) — another space having the same listing doesn't block this one.
  const exists = (await db.execute({ sql: 'SELECT id FROM properties WHERE workspace_id=? AND (id=? OR listing_url=?)', args: [wsId, id, u.href] })).rows[0];
  const street = (ex.area.split(',')[0] || ex.area || 'Home').trim();
  const name = `${ex.beds ? ex.beds + ' bed ' : ''}${ex.type}, ${street}`.trim();
  const areaLabel = (ex.area || [district, ex.outcode].filter(Boolean).join(', ') || 'Location').slice(0, 80);
  const desc = ex.descr ? ex.descr.replace(/\s+/g, ' ').trim() : 'Added from a listing link.';
  const agentView = opts.reason ? `✨ Suggested for you — ${opts.reason}.\n\n${desc}` : desc;
  const tags = [ex.type, ex.outcode, opts.reason ? 'suggested' : null].filter(Boolean).join('|');
  if (!exists) {
    const rent = ex.channel === 'rent';
    const checks = rent
      ? 'Ask for: deposit and holding-deposit terms, minimum tenancy length, whether bills/council tax/parking are included, furnished or not, and pet/decor rules. Confirm the exact available-from date and any renewal terms.'
      : 'Ask for: service charge, lease length, EPC, exact floor plan and a viewing. Confirm the precise location and any planned works.';
    await db.execute({
      sql: `INSERT INTO properties (id,name,area,price,bedrooms,size,latitude,longitude,listing_url,recommendation,confidence,agent_view,checks,tags,created_at,suggest_score,tenure,lease_years,listed_date,listed_reason,listing_type,available_from,workspace_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, name, areaLabel, ex.price, ex.beds || 0, ex.size || 'Size TBC', lat, lng, u.href, 'View', 'Medium', agentView,
        checks, tags, new Date().toISOString(), opts.score != null ? Math.round(opts.score) : null, ex.tenure || null, ex.leaseYears || null, ex.listedDate || null, ex.listedReason || null,
        ex.channel || 'buy', ex.availableFrom || null, wsId],
    });
    if (ex.media.photos.length || ex.media.floorplans.length) await storeMedia(id, ex.media);
    if (!ex.size && ex.media.floorplans.length) planSizes([id]);   // background: size from the floor plan image
    (async () => {
      try {
        const data = await computeInsights({ latitude: lat, longitude: lng, price: ex.price, area: areaLabel, flat: /flat|apartment|maison|studio/i.test(ex.type), rent }, { tflKey });
        await db.execute({ sql: `INSERT INTO insights(property_id,data,computed_at) VALUES(?,?,?) ON CONFLICT(property_id) DO UPDATE SET data=excluded.data,computed_at=excluded.computed_at`, args: [id, JSON.stringify(data), data.computedAt] });
      } catch { }
    })();
    updateCommutes(wsId).catch(() => { });   // background: commute times for the new home
    // Last-sold price is a purchase concept — skip it for rentals.
    if (!rent) (async () => { try { const sold = await fetchSold(ex.postcode, ex.area, { price: ex.price, flat: /flat|apartment|maison|studio/i.test(ex.type) }); if (sold) await db.execute({ sql: 'UPDATE properties SET last_sold_price=?, last_sold_date=?, last_sold_exact=? WHERE id=?', args: [sold.price, sold.date, sold.exact ? 1 : 0, id] }); } catch { } })();
  }
  return { ok: true, id, name, existing: !!exists };
}

// --- learn taste from verdicts, then discover matching Rightmove listings --
const STOP = new Set('the a an and or for in on of to is it with this that you your are be from at as we i has have will can not but if so its their there here more into over near just also'.split(' '));
const outcodesIn = s => (String(s).match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/gi) || []).map(x => x.toUpperCase());
// The search brief per mode (editable in the app, stored in settings). maxPrice is the
// hard ceiling (monthly for rent); minPrice drops teasers/shared-ownership fragments.
const DEFAULT_BRIEF = { buy: { maxPrice: 550000, minPrice: 120000, beds: [1, 2] }, rent: { maxPrice: 2500, minPrice: 800, beds: [1, 2] } };
async function getBriefs(wsId) {
  const saved = await wsGet(wsId, 'briefs', null);
  const out = { buy: { ...DEFAULT_BRIEF.buy }, rent: { ...DEFAULT_BRIEF.rent } };
  if (saved && typeof saved === 'object') for (const m of ['buy', 'rent']) if (saved[m] && typeof saved[m] === 'object') out[m] = { ...out[m], ...saved[m] };
  return out;
}
// Taste Nest acts on = what the live verdicts say + the taste remembered from homes
// cleared by "Start fresh" (ws_settings 'taste_memory', one profile per mode).
async function buildTaste(mode = 'buy', wsId) {
  const live = await liveTaste(mode, wsId);
  const mem = ((await wsGet(wsId, 'taste_memory', {})) || {})[mode];
  if (!mem) return live;
  for (const [o, w] of Object.entries(mem.areas || {})) live.areaScore.set(o, (live.areaScore.get(o) || 0) + w);
  for (const [k, w] of Object.entries(mem.kw || {})) live.kw.set(k, (live.kw.get(k) || 0) + w);
  const pSum = live.priceSum + (mem.priceSum || 0), pN = live.priceN + (mem.priceN || 0);
  live.priceCenter = pN ? pSum / pN : null;
  live.count += mem.count || 0;
  return live;
}
// Fold today's verdicts into the remembered taste before listings are wiped. Older memory
// fades (x0.75 per clear) so recent decisions count most; weak keyword noise is pruned.
async function distilTaste(wsId) {
  const old = (await wsGet(wsId, 'taste_memory', {})) || {};
  const out = {};
  for (const mode of ['buy', 'rent']) {
    const live = await liveTaste(mode, wsId), prev = old[mode] || {}, F = 0.75;
    const areas = {}, kw = {};
    for (const [o, w] of Object.entries(prev.areas || {})) areas[o] = w * F;
    for (const [o, w] of live.areaScore) areas[o] = (areas[o] || 0) + w;
    for (const [k, w] of Object.entries(prev.kw || {})) kw[k] = w * F;
    for (const [k, w] of live.kw) kw[k] = (kw[k] || 0) + w;
    const round = o => Object.fromEntries(Object.entries(o).filter(([, w]) => Math.abs(w) >= 0.5).map(([k, w]) => [k, Math.round(w * 100) / 100]));
    const kwTop = Object.fromEntries(Object.entries(round(kw)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 80));
    const count = Math.round((prev.count || 0) * F) + live.count;
    if (!count) { if (prev.count) out[mode] = prev; continue; }
    out[mode] = { areas: round(areas), kw: kwTop, priceSum: (prev.priceSum || 0) * F + live.priceSum, priceN: (prev.priceN || 0) * F + live.priceN, count, updatedAt: new Date().toISOString() };
  }
  return out;
}
const memorySummary = mem => Object.fromEntries(['buy', 'rent'].filter(m => mem && mem[m]).map(m => [m, {
  count: mem[m].count, areas: Object.entries(mem[m].areas || {}).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o]) => o),
  priceCenter: mem[m].priceN ? Math.round(mem[m].priceSum / mem[m].priceN) : null,
}]));
async function liveTaste(mode = 'buy', wsId) {
  const props = (await db.execute({ sql: "SELECT id, price, area, tags, agent_view FROM properties WHERE COALESCE(listing_type,'buy')=? AND workspace_id=?", args: [mode, wsId] })).rows;
  const fb = (await db.execute('SELECT property_id, verdict, note FROM feedback')).rows;
  const byId = new Map(props.map(p => [p.id, p]));
  const pos = [], neg = [];
  for (const f of fb) {
    const p = byId.get(f.property_id); if (!p) continue;
    const doc = `${p.area} ${p.tags} ${p.agent_view} ${f.note || ''}`.toLowerCase();
    if (f.verdict === 'Love' || f.verdict === 'View') pos.push({ p, doc });
    else if (f.verdict === 'Pass') neg.push({ p, doc });
  }
  const areaScore = new Map();
  pos.forEach(x => outcodesIn(x.p.area).forEach(o => areaScore.set(o, (areaScore.get(o) || 0) + 1)));
  neg.forEach(x => outcodesIn(x.p.area).forEach(o => areaScore.set(o, (areaScore.get(o) || 0) - 1)));
  const prices = pos.map(x => x.p.price).filter(Boolean);
  const priceCenter = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const kw = new Map();
  const tally = (arr, sign) => arr.forEach(x => new Set(x.doc.split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w))).forEach(w => kw.set(w, (kw.get(w) || 0) + sign)));
  tally(pos, 1); tally(neg, -1);
  return { areaScore, priceCenter, kw, count: pos.length + neg.length, priceSum: prices.reduce((a, b) => a + b, 0), priceN: prices.length };
}
function scoreCandidate(ex, taste, brief) {
  let score = 0; const why = [];
  score += (ex.price <= brief.maxPrice) ? 10 : -40;
  if (ex.beds && brief.beds.includes(ex.beds)) score += 8;
  const o = (ex.outcode || '').toUpperCase();
  const a = taste.areaScore.get(o) || 0;
  if (a > 0) { score += 16 * a; why.push(`${o}, an area you’ve liked`); }
  else if (a < 0) { score += 12 * a; }
  if (taste.priceCenter) { const d = Math.abs(ex.price - taste.priceCenter) / taste.priceCenter; score += Math.max(0, 12 - d * 24); if (d < 0.12) why.push('priced like ones you’ve kept'); }
  const doc = `${ex.area} ${ex.descr}`.toLowerCase();
  const hits = [];
  for (const [w, wt] of taste.kw) { if (wt > 0 && doc.includes(w)) { score += wt * 3; hits.push(w); } else if (wt < 0 && doc.includes(w)) { score += wt * 2; } }
  if (hits.length) why.push('mentions ' + hits.sort((x, y) => taste.kw.get(y) - taste.kw.get(x)).slice(0, 3).join(', '));
  return { score, why: why.slice(0, 2) };
}
// Pull the embedded "properties":[…] array out of a Rightmove search page
// (bracket-matched). One fetch per area gives every candidate's price/beds/etc.
function grabArray(src, marker) {
  const i = src.indexOf(marker); if (i < 0) return null;
  let j = src.indexOf('[', i), depth = 0, inStr = false, esc = false;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { if (--depth === 0) { try { return JSON.parse(src.slice(j, k + 1)); } catch { return null; } } }
  }
  return null;
}
function parseSearchResults(html) {
  const arr = grabArray(html, '"properties":[');
  if (!Array.isArray(arr)) return [];
  return arr.map(p => {
    // Rent results price by frequency (weekly/monthly/yearly) — normalise to a monthly
    // figure so it's comparable to the brief. Sale results have no frequency.
    const amt = p.price && p.price.amount, freq = p.price && p.price.frequency;
    let price = amt;
    if (freq === 'weekly') price = Math.round(amt * 52 / 12);
    else if (freq === 'yearly' || freq === 'annually') price = Math.round(amt / 12);
    return {
      id: String(p.id),
      price,
      beds: p.bedrooms,
      type: p.propertySubType || 'home',
      addr: p.displayAddress || '',
      summary: p.summary || '',
      outcode: (String(p.displayAddress || '').match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/g) || []).slice(-1)[0] || null,
      lat: p.location && p.location.latitude, lng: p.location && p.location.longitude,
    };
  }).filter(p => p.id && p.price);
}
// Shared move-in window ({from,to} ISO dates, '' = open) — the same window the app's
// date filter shows, so "Suggest…" and the daily search only add homes free in it.
async function getMoveWindow(wsId) {
  const w = await wsGet(wsId, 'move_window', null) || {};
  return { from: w.from || '', to: w.to || '' };
}
// Same rule as the front-end filter: unknown dates pass; available-now counts as today.
function inWindow(date, w) {
  if (!w || (!w.from && !w.to) || !date) return true;
  const today = new Date().toISOString().slice(0, 10);
  const a = date < today ? today : date;
  if (w.from && a < w.from) return false;
  if (w.to && a > w.to) return false;
  return true;
}
// "Near a line": only suggest homes within N minutes' walk of a station on the chosen
// lines. Walking = 80 m/min (4.8 km/h) along streets ~1.25x longer than a straight line,
// so the straight-line catchment radius is minutes * 80 / 1.25 m (the map draws the same).
const WALK_M_PER_MIN = 80, STREET_FACTOR = 1.25;
const catchmentMetres = minutes => minutes * WALK_M_PER_MIN / STREET_FACTOR;
const suggestionsOn = async wsId => !(await wsGet(wsId, 'suggestions_off', false));
const sqmOf = size => { const m = String(size || '').match(/([\d.]+)\s*(?:sq\s*m|sqm|m²|m2)/i); return m ? +m[1] : null; };
async function getLineTarget(wsId) {
  const t = await wsGet(wsId, 'line_target', null) || {};
  const lines = (Array.isArray(t.lines) ? t.lines : []).filter(l => RAIL_LINES[l]);
  return { lines, minutes: Math.min(30, Math.max(1, Math.round(+t.minutes || 5))) };
}
const haversineM = (a, b) => {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// Nearest station on the target lines, with an estimated walking time.
function nearestOnLines(pt, stations) {
  let best = null;
  for (const s of stations) { const d = haversineM(pt, s); if (!best || d < best.d) best = { d, s }; }
  return best && { station: best.s.name, lines: best.s.lines, metres: Math.round(best.d), minutes: Math.max(1, Math.round(best.d * STREET_FACTOR / WALK_M_PER_MIN)) };
}
// Postcode districts that a line's walking catchments fall in (station + 4 compass points
// at the radius), so the search goes straight to the right places along the line.
let districtShapes = null;
function districtsFor(points) {
  if (!districtShapes) {
    try { districtShapes = JSON.parse(readFileSync(join(root, 'districts.geojson'), 'utf8')).features.map(f => ({ name: f.properties.name, polys: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates })); }
    catch { districtShapes = []; }
  }
  const inRing = (x, y, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const out = new Set();
  for (const p of points) for (const d of districtShapes) if (d.polys.some(poly => inRing(p.lng, p.lat, poly[0]))) { out.add(d.name); break; }
  return [...out];
}
function catchmentDistricts(stations, radiusM) {
  const dLat = radiusM / 111320;
  const pts = stations.flatMap(s => { const dLng = radiusM / (111320 * Math.cos(s.lat * Math.PI / 180)); return [s, { lat: s.lat + dLat, lng: s.lng }, { lat: s.lat - dLat, lng: s.lng }, { lat: s.lat, lng: s.lng + dLng }, { lat: s.lat, lng: s.lng - dLng }]; });
  return districtsFor(pts);
}
async function getSearchDistricts(wsId) {
  const d = await wsGet(wsId, 'search_districts', null);
  return (Array.isArray(d) && d.length) ? d : DEFAULT_DISTRICTS;
}
// Keep at most `cap` UNTOUCHED suggestions (auto-added, no verdict yet). Anything
// the couple has reacted to, added by hand, or seeded is never touched.
async function capSuggestions(cap, mode = 'buy', wsId) {
  const rows = (await db.execute({
    sql: `SELECT id FROM properties
    WHERE tags LIKE '%suggested%' AND COALESCE(listing_type,'buy')=? AND workspace_id=? AND id NOT IN (SELECT property_id FROM feedback)
    ORDER BY COALESCE(suggest_score,0) DESC`, args: [mode, wsId],
  })).rows;
  const doomed = rows.slice(cap).map(r => r.id);
  for (const id of doomed) {
    for (const t of ['feedback', 'insights', 'media', 'commutes', 'guest_notes']) await db.execute({ sql: `DELETE FROM ${t} WHERE property_id=?`, args: [id] });
    await db.execute({ sql: 'DELETE FROM properties WHERE id=?', args: [id] });
  }
  return doomed.length;
}
async function discover(opts = {}) {
  const wsId = opts.wsId || DEFAULT_WS;
  const mode = opts.mode === 'rent' ? 'rent' : 'buy';
  const max = opts.max || 4;            // how many new homes to add this run
  const brief = (await getBriefs(wsId))[mode];
  const minPrice = brief.minPrice || (mode === 'rent' ? 500 : 120000);
  const taste = await buildTaste(mode, wsId);
  // Sample across the FULL selected search area, not just the first few — shuffle the whole
  // list so each run covers a different, wider spread of the selected districts.
  let allAreas = await getSearchDistricts(wsId);
  // Near-a-line target: search the districts along the chosen lines (the ones inside the
  // selected search areas if any overlap, otherwise the whole line), and keep only homes
  // within the walking catchment of one of its stations.
  const target = await getLineTarget(wsId);
  let targetStations = null, radius = 0, lineAreas = [];
  if (target.lines.length) {
    const rail = await railLines();
    targetStations = rail.stations.filter(s => s.lines && s.lines.some(l => target.lines.includes(l)));
    radius = catchmentMetres(target.minutes);
    lineAreas = catchmentDistricts(targetStations, radius);
    const overlap = lineAreas.filter(a => allAreas.includes(a));
    if (lineAreas.length) allAreas = overlap.length ? overlap : lineAreas;
  }
  const shuffled = allAreas.slice().sort(() => Math.random() - 0.5);
  const areas = shuffled.slice(0, opts.maxAreas || 12);
  let outOfReach = 0;
  const searchPath = mode === 'rent' ? 'property-to-rent' : 'property-for-sale';
  const existing = new Set((await db.execute({ sql: 'SELECT listing_url FROM properties WHERE workspace_id=?', args: [wsId] })).rows
    .map(r => (String(r.listing_url).match(/(\d{5,})/) || [])[1]).filter(Boolean));
  const seen = new Set(), candidates = [];
  for (const area of areas) {
    try {
      const html = await (await fetch(`https://www.rightmove.co.uk/${searchPath}/${encodeURIComponent(area)}.html`,
        { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) })).text();
      for (const c of parseSearchResults(html)) {
        if (existing.has(c.id) || seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.price > brief.maxPrice || c.price < minPrice) continue;    // floor drops shared-ownership / per-room teasers
        if (c.beds != null && brief.beds.length && !brief.beds.includes(c.beds)) continue; // != null so a studio (0 beds) is filtered, unknown beds pass
        if (targetStations) {
          if (c.lat == null || c.lng == null) { outOfReach++; continue; }
          const near = nearestOnLines({ lat: c.lat, lng: c.lng }, targetStations);
          if (!near || near.metres > radius) { outOfReach++; continue; }
          c.near = near;
        }
        candidates.push(c);
      }
    } catch { }
    await sleep(900);
  }
  const scored = candidates.map(c => {
    const ex = { price: c.price, beds: c.beds, outcode: c.outcode, area: c.addr, descr: `${c.summary} ${c.type}` };
    const s = scoreCandidate(ex, taste, brief);
    if (c.near) {   // closer to the line ranks a little higher; say so in the "why"
      s.score += Math.max(0, (target.minutes - c.near.minutes) * 1.5);
      const names = c.near.lines.filter(l => target.lines.includes(l)).map(l => lineLabel(l)).join(' / ');
      s.why = [`${c.near.minutes} min walk to ${c.near.station} (${names})`, ...s.why].slice(0, 2);
    }
    return { id: c.id, url: `https://www.rightmove.co.uk/properties/${c.id}`, score: s.score, why: s.why };
  }).sort((a, b) => b.score - a.score);
  // With a move-in window set, a listing's date is only known once its page is read, so
  // try further down the ranking (bounded) to make up for ones that fall outside it.
  const win = await getMoveWindow(wsId);
  const windowOn = !!(win.from || win.to), minSqm = brief.minSqm || 0;
  const added = []; let outOfWindow = 0, tooSmall = 0;
  for (const t of scored.slice(0, (windowOn || minSqm) ? max * 3 : max)) {
    if (added.length >= max) break;
    const r = await addListing(t.url, { reason: (t.why[0] || 'it fits your brief'), score: t.score, wsId, window: windowOn ? win : null, minSqm }).catch(() => null);
    if (r && r.skipped === 'window') outOfWindow++;
    if (r && r.skipped === 'size') tooSmall++;
    if (r && r.ok && !r.existing) added.push({ id: r.id, name: r.name, why: t.why });
    await sleep(600);
  }
  // Give the new homes the full re-check straight away (a second read catches size,
  // tenure, dates or last-sold details the first fetch sometimes misses).
  if (added.length) { await sleep(1500); await refresh(added.map(a => a.id)).catch(() => { }); }
  if (opts.poolCap) await capSuggestions(opts.poolCap, mode, wsId);
  return { added, considered: candidates.length, found: seen.size, learnedFrom: taste.count, areas, mode, outOfWindow, tooSmall, window: windowOn ? win : null,
    lineTarget: targetStations ? { ...target, stations: targetStations.length, outOfReach } : null };
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
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS commutes (property_id TEXT PRIMARY KEY, data TEXT NOT NULL, computed_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guest_notes (property_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS login_tokens (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memberships (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,user_id));
  CREATE TABLE IF NOT EXISTS invites (workspace_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,email));
  CREATE TABLE IF NOT EXISTS ws_settings (workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(workspace_id,key));
  CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL);`);
  // Columns added over time — guarded so re-running is harmless.
  for (const col of ['prev_price INTEGER', 'price_changed_at TEXT', 'suggest_score REAL', 'tenure TEXT', 'lease_years INTEGER',
    'listed_date TEXT', 'listed_reason TEXT', 'last_sold_price INTEGER', 'last_sold_date TEXT', 'last_sold_exact INTEGER',
    "listing_type TEXT NOT NULL DEFAULT 'buy'", 'available_from TEXT', 'workspace_id TEXT',
    'contacted INTEGER DEFAULT 0', 'agent_contact TEXT', 'track_stage TEXT', 'track_notes TEXT', 'size_plan_checked TEXT']) {
    try { await db.execute(`ALTER TABLE properties ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  const count = (await db.execute('SELECT COUNT(*) AS n FROM properties')).rows[0].n;
  if (!count) await seed();
  // Seed the sign-in allow-list once (Ralf can add others from the app). Without an
  // entry here nobody could bootstrap the first login.
  if ((await getSetting('allowed_users', null)) == null) await setSetting('allowed_users', [{ email: 'ralf.g.saade@gmail.com', name: 'Ralf' }]);
  // The host administers the global "who can sign in" list; everyone else only manages
  // their own space. Seeded to Ralf; change via the host_email setting if needed.
  if ((await getSetting('host_email', null)) == null) await setSetting('host_email', 'ralf.g.saade@gmail.com');
  await migrateWorkspaces();
}
const getHostEmail = async () => normEmail(await getSetting('host_email', 'ralf.g.saade@gmail.com'));
async function isHostUser(user) { return !!user && normEmail(user.email) === await getHostEmail(); }
// One-time move to per-household workspaces: put all pre-existing data in one default
// workspace, copy its settings across, and seed its membership from the allow-list.
const DEFAULT_WS = 'ws-home';
async function migrateWorkspaces() {
  if (await getSetting('ws_migrated', false)) return;
  await db.execute({ sql: 'INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)', args: [DEFAULT_WS, 'Ralf & Hannah', nowISO()] });
  await db.execute({ sql: 'UPDATE properties SET workspace_id=? WHERE workspace_id IS NULL', args: [DEFAULT_WS] });
  for (const key of ['search_districts', 'destinations', 'emails', 'briefs']) {
    const v = await getSetting(key, null);
    if (v != null) await wsSet(DEFAULT_WS, key, v);
  }
  const allowed = await getSetting('allowed_users', []);
  for (const [i, u] of (allowed || []).entries())
    await db.execute({ sql: 'INSERT OR IGNORE INTO invites(workspace_id,email,name,role,created_at) VALUES(?,?,?,?,?)', args: [DEFAULT_WS, normEmail(u.email), u.name || null, i === 0 ? 'owner' : 'member', nowISO()] });
  // anyone who already signed in (e.g. Ralf under v3) joins the default space as an owner
  for (const usr of (await db.execute('SELECT id FROM users')).rows)
    await db.execute({ sql: 'INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)', args: [DEFAULT_WS, usr.id, 'owner', nowISO()] });
  await setSetting('ws_migrated', true);
}
// Per-workspace settings (search areas, destinations, subscribers, briefs) live in ws_settings.
async function wsGet(wsId, key, fallback) { try { const r = (await db.execute({ sql: 'SELECT value FROM ws_settings WHERE workspace_id=? AND key=?', args: [wsId, key] })).rows[0]; return r ? JSON.parse(r.value) : fallback; } catch { return fallback; } }
async function wsSet(wsId, key, value) { await db.execute({ sql: 'INSERT INTO ws_settings(workspace_id,key,value) VALUES(?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value', args: [wsId, key, JSON.stringify(value)] }); }
// Resolve which workspace a user is in — their membership, else a pending invite they now
// accept, else a brand-new private workspace of their own.
async function userWorkspace(user) {
  const m = (await db.execute({ sql: 'SELECT workspace_id FROM memberships WHERE user_id=? ORDER BY created_at LIMIT 1', args: [user.id] })).rows[0];
  if (m) return m.workspace_id;
  const inv = (await db.execute({ sql: 'SELECT workspace_id, role FROM invites WHERE email=? LIMIT 1', args: [normEmail(user.email)] })).rows[0];
  if (inv) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)', args: [inv.workspace_id, user.id, inv.role || 'member', nowISO()] });
    await db.execute({ sql: 'DELETE FROM invites WHERE workspace_id=? AND email=?', args: [inv.workspace_id, normEmail(user.email)] });
    return inv.workspace_id;
  }
  const id = 'ws-' + randomBytes(6).toString('hex');
  await db.execute({ sql: 'INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)', args: [id, `${user.name}'s search`, nowISO()] });
  await db.execute({ sql: 'INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)', args: [id, user.id, 'owner', nowISO()] });
  return id;
}
async function workspaceName(wsId) { const w = (await db.execute({ sql: 'SELECT name FROM workspaces WHERE id=?', args: [wsId] })).rows[0]; return w ? w.name : 'Your search'; }
// Members (joined) + pending invites for a space, for the "People in this space" box.
async function workspacePeople(wsId) {
  const mem = (await db.execute({ sql: 'SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at', args: [wsId] })).rows
    .map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, joined: true }));
  const inv = (await db.execute({ sql: 'SELECT email, name, role FROM invites WHERE workspace_id=? ORDER BY created_at', args: [wsId] })).rows
    .map(r => ({ email: r.email, name: r.name || r.email.split('@')[0], role: r.role, joined: false }));
  return [...mem, ...inv];
}
// Make a space's roster match `desired` [{email,name}] — add invites/memberships for new
// people, drop those removed (never the actor). Sharing also allow-lists the email so they
// can sign in. Someone already settled in another space gets a pending invite, not a move.
async function reconcileSpacePeople(wsId, actor, desired) {
  const actorEmail = normEmail(actor.email);
  const byEmail = new Map();
  for (const p of desired) { const e = normEmail(p && p.email); if (validEmail(e)) byEmail.set(e, { email: e, name: String(p.name || '').trim().slice(0, 40) || e.split('@')[0] }); }
  byEmail.set(actorEmail, byEmail.get(actorEmail) || { email: actorEmail, name: actor.name }); // never drop yourself
  const want = new Set(byEmail.keys());
  const members = (await db.execute({ sql: 'SELECT u.id, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?', args: [wsId] })).rows;
  const invites = (await db.execute({ sql: 'SELECT email FROM invites WHERE workspace_id=?', args: [wsId] })).rows;
  for (const m of members) { const e = normEmail(m.email); if (e !== actorEmail && !want.has(e)) await db.execute({ sql: 'DELETE FROM memberships WHERE workspace_id=? AND user_id=?', args: [wsId, m.id] }); }
  for (const inv of invites) { const e = normEmail(inv.email); if (!want.has(e)) await db.execute({ sql: 'DELETE FROM invites WHERE workspace_id=? AND email=?', args: [wsId, e] }); }
  const memberEmails = new Set(members.map(m => normEmail(m.email)));
  const inviteEmails = new Set(invites.map(i => normEmail(i.email)));
  const added = [];   // people newly brought into the space this call (to email an invite)
  for (const p of byEmail.values()) {
    // The invite itself grants sign-in (signInIdentity checks invites) — no need to touch
    // the host's global allow-list.
    if (p.email === actorEmail || memberEmails.has(p.email) || inviteEmails.has(p.email)) continue;
    const existing = (await db.execute({ sql: 'SELECT id FROM users WHERE email=?', args: [p.email] })).rows[0];
    const settled = existing && (await db.execute({ sql: 'SELECT 1 FROM memberships WHERE user_id=? LIMIT 1', args: [existing.id] })).rows[0];
    if (existing && !settled) await db.execute({ sql: 'INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)', args: [wsId, existing.id, 'member', nowISO()] });
    else await db.execute({ sql: 'INSERT OR IGNORE INTO invites(workspace_id,email,name,role,created_at) VALUES(?,?,?,?,?)', args: [wsId, p.email, p.name, 'member', nowISO()] });
    added.push(p);
  }
  return added;
}
async function getSetting(key, fallback) {
  try { const r = (await db.execute({ sql: 'SELECT value FROM settings WHERE key=?', args: [key] })).rows[0]; return r ? JSON.parse(r.value) : fallback; }
  catch { return fallback; }
}
async function setSetting(key, value) {
  await db.execute({ sql: 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', args: [key, JSON.stringify(value)] });
}
const DEFAULT_DISTRICTS = ['N1', 'E2', 'E9', 'E3', 'N16', 'N5', 'E8', 'E5']; // Hoxton, Victoria Park, Bow, Stoke Newington, Highbury…
const DEFAULT_GUARDRAILS = 'Outdoor space preferred. No noisy roads or poor light. No ground floor unless secure/gated. Ex-local authority is considered.';
const getDestinations = wsId => wsGet(wsId, 'destinations', []);

// --- commute times (TfL Journey Planner) ----------------------------------
async function computeCommutes(property, destinations) {
  const out = [];
  const auth = process.env.TFL_APP_KEY ? `app_key=${encodeURIComponent(process.env.TFL_APP_KEY)}` : '';
  const from = `${property.latitude},${property.longitude}`;
  // Fetch the shortest journey for a given TfL mode filter (empty = public transport).
  const fastest = async (postcode, extra) => {
    const qs = [auth, extra].filter(Boolean).join('&');
    const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(postcode)}${qs ? `?${qs}` : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Project-Nest/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const journeys = (await r.json()).journeys || [];
    if (!journeys.length) return null;
    return journeys.reduce((a, b) => (a.duration <= b.duration ? a : b));
  };
  for (const d of destinations) {
    try {
      const transit = await fastest(d.postcode, '');
      let cycle = null;
      try { cycle = await fastest(d.postcode, 'mode=cycle'); } catch { }
      if (!transit && !cycle) { out.push({ name: d.name, postcode: d.postcode, minutes: null, cycleMinutes: null }); continue; }
      const modes = transit ? [...new Set((transit.legs || []).map(l => l.mode && l.mode.name).filter(m => m && m !== 'walking'))] : [];
      out.push({ name: d.name, postcode: d.postcode, minutes: transit ? transit.duration : null, cycleMinutes: cycle ? cycle.duration : null, modes });
    } catch { out.push({ name: d.name, postcode: d.postcode, minutes: null, cycleMinutes: null }); }
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}
async function storeCommutes(id, data) {
  await db.execute({ sql: `INSERT INTO commutes(property_id,data,computed_at) VALUES(?,?,?) ON CONFLICT(property_id) DO UPDATE SET data=excluded.data,computed_at=excluded.computed_at`, args: [id, JSON.stringify(data), new Date().toISOString()] });
}
// Keep every home's commute times in step with the space's places, automatically.
// Per home, results for places already computed are reused; only new places (or ones that
// failed last time) hit TfL, and removed places are simply dropped. One job per workspace;
// a change arriving mid-run triggers another pass. Progress is exposed for the page.
const commuteJobs = new Map();   // wsId -> { running, done, total, again }
const destKey = d => `${d.name}|${d.postcode}`;
async function updateCommutes(wsId) {
  const cur = commuteJobs.get(wsId);
  if (cur && cur.running) { cur.again = true; return; }
  const job = { running: true, done: 0, total: 0, again: false };
  commuteJobs.set(wsId, job);
  try {
    do {
      job.again = false;
      const dests = await getDestinations(wsId), want = dests.map(destKey).join(';');
      const props = (await db.execute({ sql: 'SELECT p.id, p.latitude, p.longitude, c.data FROM properties p LEFT JOIN commutes c ON c.property_id=p.id WHERE p.workspace_id=?', args: [wsId] })).rows;
      const todo = props.map(p => ({ p, have: (() => { try { return JSON.parse(p.data || 'null'); } catch { return null; } })() }))
        .filter(({ have }) => !Array.isArray(have) || have.map(destKey).join(';') !== want || have.some(c => c.minutes == null && c.cycleMinutes == null));
      job.total = todo.length; job.done = 0;
      for (const { p, have } of todo) {
        try {
          const ok = new Map((have || []).filter(c => c.minutes != null || c.cycleMinutes != null).map(c => [destKey(c), c]));
          const missing = dests.filter(d => !ok.has(destKey(d)));
          const fresh = missing.length ? await computeCommutes(p, missing) : [];
          fresh.forEach(c => ok.set(destKey(c), c));
          await storeCommutes(p.id, dests.map(d => ok.get(destKey(d)) || { name: d.name, postcode: d.postcode, minutes: null, cycleMinutes: null }));
        } catch { }
        job.done++;
        if (job.again) break;   // places changed again — start over with the new list
      }
    } while (job.again);
  } finally { job.running = false; }
}
async function refreshCommutes(only) {
  const wss = only ? [{ id: only }] : (await db.execute('SELECT id FROM workspaces')).rows;
  for (const w of wss) await updateCommutes(w.id).catch(() => { });
}
// Re-geocode saved homes to their exact street postcode. Older/discovered listings that
// only had an outcode landed on the district centroid (several stacking on one point);
// this re-reads each page, recovers the full postcode, and moves the pin to the real
// spot, then refreshes area intelligence + commutes for the new location.
async function refineLocations(wsId) {
  const props = (await db.execute({ sql: 'SELECT id, listing_url, latitude, longitude FROM properties WHERE listing_url IS NOT NULL AND workspace_id=?', args: [wsId] })).rows;
  const dests = await getDestinations(wsId);
  let updated = 0; const changes = [];
  for (const p of props) {
    try {
      const resp = await fetch(p.listing_url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) { await sleep(400); continue; }
      const ex = extractListing(await resp.text(), p.listing_url);
      let lat = ex.coords ? ex.coords.lat : null, lng = ex.coords ? ex.coords.lng : null;
      if (lat == null && ex.postcode) { const g = await geocode(ex.postcode, null); if (g) { lat = g.lat; lng = g.lng; } } // precise postcode only — never the outcode fallback
      if (lat == null) { await sleep(400); continue; }
      if (Math.abs(lat - p.latitude) + Math.abs(lng - p.longitude) < 1e-6) { await sleep(400); continue; } // already precise
      await db.execute({ sql: 'UPDATE properties SET latitude=?, longitude=? WHERE id=?', args: [lat, lng, p.id] });
      updated++; changes.push({ id: p.id, postcode: ex.postcode || null });
      try { if (dests.length) await storeCommutes(p.id, await computeCommutes({ latitude: lat, longitude: lng }, dests)); } catch { } // area intelligence (~1mi radius) barely shifts; refresh()/boot recomputes it
    } catch { }
    await sleep(400);
  }
  return { updated, changes };
}

// --- weekly email summary (Resend) ----------------------------------------
const SITE_URL = 'https://project-nest-2mzu.onrender.com';
// Build + send one workspace's weekly digest to its subscribers.
async function sendWeeklyForWorkspace(wsId, emails, key, from) {
  const all = await rows('', wsId);
  const weekAgo = Date.now() - 7 * 864e5;
  const newSug = all.filter(p => p.tags.includes('suggested') && p.created_at && Date.parse(p.created_at) >= weekAgo);
  const drops = all.filter(p => p.price_changed_at && Date.parse(p.price_changed_at) >= weekAgo && p.prev_price && p.price < p.prev_price);
  const keepers = all.filter(p => p.feedback.some(f => ['Love', 'View', 'Watch'].includes(f.verdict)));
  const gbp = n => '£' + Number(n).toLocaleString('en-GB');
  const item = p => `<tr><td style="padding:9px 0;border-top:1px solid #eee"><a href="${p.listing_url}" style="color:#285b43;font-weight:600;text-decoration:none">${p.name}</a><br><span style="color:#667;font-size:13px">${p.area} · ${gbp(p.price)}${(p.prev_price && p.price < p.prev_price) ? ` · ↓ was ${gbp(p.prev_price)}` : ''}</span></td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#17251f;padding:8px">
    <h2 style="font-weight:600;margin:0 0 4px">Nest — your week in the home search</h2>
    <p style="color:#556">${all.length} homes on your list · ${keepers.length} keeper${keepers.length === 1 ? '' : 's'}.</p>
    ${newSug.length ? `<h3 style="margin:22px 0 4px">✨ ${newSug.length} new suggestion${newSug.length > 1 ? 's' : ''} this week</h3><table style="width:100%;border-collapse:collapse">${newSug.slice(0, 8).map(item).join('')}</table>` : ''}
    ${drops.length ? `<h3 style="margin:22px 0 4px">↓ ${drops.length} price drop${drops.length > 1 ? 's' : ''}</h3><table style="width:100%;border-collapse:collapse">${drops.slice(0, 8).map(item).join('')}</table>` : ''}
    ${(!newSug.length && !drops.length) ? `<p style="color:#556">No new suggestions or price drops this week — nothing new beat what you already have.</p>` : ''}
    <p style="margin-top:26px"><a href="${SITE_URL}" style="background:#285b43;color:#fff;padding:11px 20px;text-decoration:none;border-radius:4px;display:inline-block">Open Nest ↗</a></p>
    <p style="color:#99a;font-size:12px;margin-top:24px">You subscribed to this in Nest. To stop, remove your address in the app.</p></div>`;
  const subject = `Nest weekly — ${newSug.length} new, ${drops.length} price drop${drops.length === 1 ? '' : 's'}`;
  let sent = 0; const errors = [];
  for (const to of emails) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: 'Nest' }, subject, content: [{ type: 'text/html', value: html }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok || r.status === 202) sent++; else errors.push(`${to}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    } catch (e) { errors.push(`${to}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 300));
  }
  return { sent, newSug: newSug.length, drops: drops.length, errors };
}
// Weekly digest across every workspace — each gets its own homes to its own subscribers.
async function sendWeekly() {
  const key = process.env.SENDGRID_API_KEY, from = process.env.SENDGRID_FROM;
  const wss = (await db.execute('SELECT id FROM workspaces')).rows;
  let sent = 0; const per = [], preview = [];
  for (const w of wss) {
    const emails = await wsGet(w.id, 'emails', []);
    if (!emails.length) continue;
    if (!key || !from) { preview.push({ ws: w.id, to: emails }); continue; }
    const r = await sendWeeklyForWorkspace(w.id, emails, key, from);
    sent += r.sent; per.push({ ws: w.id, ...r });
  }
  if (!key || !from) return { sent: 0, note: 'SENDGRID_API_KEY / SENDGRID_FROM not set — nothing sent', preview };
  return { sent, workspaces: per };
}

// --- authentication: passwordless magic-link sign-in ----------------------
// A user requests a link → we email a one-time token → clicking it creates a
// server-side session (HttpOnly cookie). Only allow-listed emails can sign in.
// Auth (who you are) is deliberately separate from the data model, so a second
// method (e.g. Google) can be added later without touching sessions/authorization.
const SESSION_DAYS = 30, LOGIN_TOKEN_MINUTES = 20;
const nowISO = () => new Date().toISOString();
const isoIn = ms => new Date(Date.now() + ms).toISOString();
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const INVITE_TOKEN_DAYS = 14;
// Email someone you've added to a space: a one-click sign-in link (valid 14 days) that
// drops them straight into the shared space (they have a pending invite/membership).
async function sendInviteEmail(req, toEmail, inviterName, spaceName) {
  const token = randomBytes(24).toString('hex');
  await db.execute({ sql: 'INSERT INTO login_tokens(token,email,created_at,expires_at) VALUES(?,?,?,?)', args: [token, normEmail(toEmail), nowISO(), isoIn(INVITE_TOKEN_DAYS * 864e5)] });
  const link = `${baseUrl(req)}/api/auth/callback?token=${token}`;
  const key = process.env.SENDGRID_API_KEY, from = process.env.SENDGRID_FROM;
  if (!key || !from) return { sent: false, link };   // dev — no email configured
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#17251f;padding:8px">
    <h2 style="font-weight:600;margin:0 0 6px">You're invited to Nest</h2>
    <p style="color:#556"><b>${escHtml(inviterName)}</b> invited you to <b>${escHtml(spaceName)}</b> — a shared home shortlist on Nest. Click below to open it; the link signs you straight in and works for 14 days.</p>
    <p style="margin:22px 0"><a href="${link}" style="background:#285b43;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px;display:inline-block">Open the shared space ↗</a></p>
    <p style="color:#99a;font-size:12px">If you weren't expecting this, you can ignore it. You can also sign in any time at ${escHtml(baseUrl(req))} with this email.</p></div>`;
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: normEmail(toEmail) }] }], from: { email: from, name: 'Nest' }, subject: `${inviterName} invited you to “${spaceName}” on Nest`, content: [{ type: 'text/html', value: html }] }),
      signal: AbortSignal.timeout(15000),
    });
    return { sent: r.ok || r.status === 202, link };
  } catch { return { sent: false, link }; }
}
async function getAllowed() { return (await getSetting('allowed_users', [])) || []; }
async function allowedEntry(email) { const e = normEmail(email); return (await getAllowed()).find(u => normEmail(u.email) === e) || null; }
// Who may sign in: on the host's global allow-list, OR invited to some space, OR already a
// member of one. This lets a space owner share their space (via an invite) without needing
// the host to also allow-list that person. Returns {email,name} or null.
async function signInIdentity(email) {
  const e = normEmail(email);
  const a = await allowedEntry(e); if (a) return { email: e, name: a.name };
  const inv = (await db.execute({ sql: 'SELECT name FROM invites WHERE email=? LIMIT 1', args: [e] })).rows[0];
  if (inv) return { email: e, name: inv.name || e.split('@')[0] };
  const mem = (await db.execute({ sql: 'SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? LIMIT 1', args: [e] })).rows[0];
  if (mem) return { email: e, name: mem.name || e.split('@')[0] };
  return null;
}
function parseCookies(req) {
  const out = {}, h = req.headers.cookie; if (!h) return out;
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;
const baseUrl = req => `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
function setSessionCookie(res, req, token, maxAgeSec) {
  const bits = [`nest_session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) bits.push('Secure');   // omit on localhost http so the cookie still sets in dev
  res.setHeader('Set-Cookie', bits.join('; '));
}
async function currentUser(req) {
  const tok = parseCookies(req).nest_session; if (!tok) return null;
  const s = (await db.execute({ sql: 'SELECT user_id, expires_at FROM sessions WHERE token=?', args: [tok] })).rows[0];
  if (!s || s.expires_at < nowISO()) return null;
  return (await db.execute({ sql: 'SELECT id, email, name FROM users WHERE id=?', args: [s.user_id] })).rows[0] || null;
}
// Shared sign-in: given a verified email (from a magic link OR Google), check the
// allow-list, upsert the user, create a session cookie and redirect into the app.
// Returns after writing the response. Used by both auth methods so they behave identically.
async function establishSession(req, res, email) {
  const e = normEmail(email);
  const ident = await signInIdentity(e);
  if (!ident) { res.writeHead(302, { Location: '/?auth=denied' }); return res.end(); }
  let u = (await db.execute({ sql: 'SELECT id FROM users WHERE email=?', args: [e] })).rows[0];
  if (!u) { const id = 'u-' + randomBytes(8).toString('hex'); await db.execute({ sql: 'INSERT INTO users(id,email,name,created_at,last_login) VALUES(?,?,?,?,?)', args: [id, e, ident.name || e.split('@')[0], nowISO(), nowISO()] }); u = { id }; }
  else await db.execute({ sql: 'UPDATE users SET last_login=? WHERE id=?', args: [nowISO(), u.id] });
  const stoken = randomBytes(24).toString('hex');
  await db.execute({ sql: 'INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)', args: [stoken, u.id, nowISO(), isoIn(SESSION_DAYS * 864e5)] });
  setSessionCookie(res, req, stoken, SESSION_DAYS * 86400);
  res.writeHead(302, { Location: '/' }); return res.end();
}
const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
async function sendLoginEmail(req, email, token) {
  const link = `${baseUrl(req)}/api/auth/callback?token=${token}`;
  const key = process.env.SENDGRID_API_KEY, from = process.env.SENDGRID_FROM;
  if (!key || !from) return { sent: false, link };   // dev: no email configured — caller surfaces the link
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:460px;margin:auto;color:#17251f;padding:8px">
    <h2 style="font-weight:600;margin:0 0 6px">Sign in to Nest</h2>
    <p style="color:#556">Click below to sign in. The link works once and expires in ${LOGIN_TOKEN_MINUTES} minutes.</p>
    <p style="margin:22px 0"><a href="${link}" style="background:#285b43;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px;display:inline-block">Sign in to Nest ↗</a></p>
    <p style="color:#99a;font-size:12px">If you didn't request this, you can ignore it.</p></div>`;
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email }] }], from: { email: from, name: 'Nest' }, subject: 'Your Nest sign-in link', content: [{ type: 'text/html', value: html }] }),
      signal: AbortSignal.timeout(15000),
    });
    return { sent: r.ok || r.status === 202, link };
  } catch { return { sent: false, link }; }
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

async function rows(person, wsId) {
  const properties = (await db.execute({ sql: 'SELECT * FROM properties WHERE workspace_id=? ORDER BY created_at DESC', args: [wsId] })).rows;
  const feedback = (await db.execute('SELECT property_id, person, verdict, note, updated_at FROM feedback')).rows;
  const insights = (await db.execute('SELECT property_id, data FROM insights')).rows;
  const media = (await db.execute('SELECT property_id, data FROM media')).rows;
  const commutes = (await db.execute('SELECT property_id, data FROM commutes')).rows;
  return properties.map(p => {
    const ins = insights.find(i => i.property_id === p.id);
    const med = media.find(m => m.property_id === p.id);
    const com = commutes.find(c => c.property_id === p.id);
    return {
      ...p,
      tags: String(p.tags).split('|'),
      feedback: feedback.filter(f => f.property_id === p.id),
      mine: feedback.find(f => f.property_id === p.id && f.person === person) || null,
      insights: ins ? JSON.parse(ins.data) : null,
      media: med ? JSON.parse(med.data) : null,
      commutes: com ? JSON.parse(com.data) : [],
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
  const props = (await db.execute('SELECT id, name, area, price, latitude, longitude, listing_type FROM properties')).rows;
  const done = [];
  for (const p of props) {
    try {
      const data = await computeInsights({ ...p, flat: /flat|apartment|maison|studio/i.test(p.name), rent: p.listing_type === 'rent' }, { tflKey });
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

// Coloured rail lines for the map: TfL route sequences (station-to-station lines +
// stations), fetched once and cached. Colours are TfL's published line colours.
const RAIL_LINES = {
  bakerloo: '#B36305', central: '#E32017', circle: '#FFD300', district: '#00782A',
  'hammersmith-city': '#F3A9BB', jubilee: '#A0A5A9', metropolitan: '#9B0056', northern: '#000000',
  piccadilly: '#003688', victoria: '#0098D4', 'waterloo-city': '#95CDBA', elizabeth: '#6950A1',
  dlr: '#00A4A7', liberty: '#676767', lioness: '#F1B41C', mildmay: '#437EC1',
  suffragette: '#39B97A', weaver: '#972861', windrush: '#EF4D5E',
};
// --- "Start fresh": snapshot every listing in a space, remember the taste, then wipe ---
const CHILD_TABLES = ['feedback', 'insights', 'media', 'commutes', 'guest_notes'];
const asObjects = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const MAX_ARCHIVES = 5;
async function masterClear(wsId, user) {
  const props = asObjects(await db.execute({ sql: 'SELECT * FROM properties WHERE workspace_id=?', args: [wsId] }));
  const ids = props.map(p => p.id);
  const children = {};
  for (const t of CHILD_TABLES) {
    children[t] = [];
    for (let i = 0; i < ids.length; i += 200) {   // chunk the IN() list
      const chunk = ids.slice(i, i + 200);
      if (chunk.length) children[t].push(...asObjects(await db.execute({ sql: `SELECT * FROM ${t} WHERE property_id IN (${chunk.map(() => '?').join(',')})`, args: chunk })));
    }
  }
  const priorMemory = (await wsGet(wsId, 'taste_memory', {})) || {};
  const memory = await distilTaste(wsId);           // read verdicts BEFORE they are deleted
  const fb = children.feedback;
  const summary = {
    homes: props.length, buy: props.filter(p => (p.listing_type || 'buy') === 'buy').length, rent: props.filter(p => p.listing_type === 'rent').length,
    verdicts: fb.filter(f => f.verdict).length, keepers: new Set(fb.filter(f => ['Love', 'View', 'Watch'].includes(f.verdict)).map(f => f.property_id)).size,
    notes: fb.filter(f => f.note).length + children.guest_notes.length, by: user?.name || '',
  };
  const id = 'ar-' + randomBytes(6).toString('hex'), at = new Date().toISOString();
  await db.execute({ sql: 'INSERT INTO archives(id,workspace_id,created_at,summary,data) VALUES(?,?,?,?,?)',
    args: [id, wsId, at, JSON.stringify(summary), JSON.stringify({ version: 1, workspace: wsId, createdAt: at, summary, properties: props, children, priorMemory, memory })] });
  // Only once the snapshot is safely written: save the taste, then wipe in one batch.
  await wsSet(wsId, 'taste_memory', memory);
  const stmts = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200), q = chunk.map(() => '?').join(',');
    for (const t of CHILD_TABLES) stmts.push({ sql: `DELETE FROM ${t} WHERE property_id IN (${q})`, args: chunk });
  }
  stmts.push({ sql: 'DELETE FROM properties WHERE workspace_id=?', args: [wsId] });
  await db.batch(stmts, 'write');
  const old = (await db.execute({ sql: 'SELECT id FROM archives WHERE workspace_id=? ORDER BY created_at DESC', args: [wsId] })).rows.slice(MAX_ARCHIVES);
  for (const r of old) await db.execute({ sql: 'DELETE FROM archives WHERE id=?', args: [r.id] });
  return { ok: true, archiveId: id, cleared: props.length, summary, remembered: memorySummary(memory) };
}
async function listArchives(wsId) {
  return (await db.execute({ sql: 'SELECT id, created_at, summary FROM archives WHERE workspace_id=? ORDER BY created_at DESC', args: [wsId] })).rows
    .map(r => ({ id: r.id, createdAt: r.created_at, ...JSON.parse(r.summary) }));
}
// Put a snapshot's homes back (skipping any that were re-added since) and roll the
// remembered taste back to before that clear, so restored verdicts aren't counted twice.
async function restoreArchive(wsId, id) {
  const r = (await db.execute({ sql: 'SELECT data FROM archives WHERE id=? AND workspace_id=?', args: [id, wsId] })).rows[0];
  if (!r) return null;
  const a = JSON.parse(r.data);
  const present = new Set((await db.execute({ sql: 'SELECT id FROM properties', args: [] })).rows.map(x => x.id));
  const insert = (t, row) => { const cols = Object.keys(row); return { sql: `INSERT OR IGNORE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, args: cols.map(c => row[c]) }; };
  const back = a.properties.filter(p => !present.has(p.id)), backIds = new Set(back.map(p => p.id));
  const stmts = back.map(p => insert('properties', { ...p, workspace_id: wsId }));
  for (const t of CHILD_TABLES) for (const row of (a.children[t] || [])) if (backIds.has(row.property_id)) stmts.push(insert(t, row));
  if (stmts.length) await db.batch(stmts, 'write');
  await wsSet(wsId, 'taste_memory', a.priorMemory || {});
  return { ok: true, restored: back.length, skipped: a.properties.length - back.length };
}
const LINE_NAMES = { 'hammersmith-city': 'Hammersmith & City line', 'waterloo-city': 'Waterloo & City line', dlr: 'DLR', elizabeth: 'Elizabeth line' };
const lineLabel = id => LINE_NAMES[id] || id[0].toUpperCase() + id.slice(1) + ' line';
let railCache = null, railFetching = null;
async function railLines() {
  if (railCache && Date.now() - railCache.at < 24 * 3600e3) return railCache.data;
  if (railFetching) return railFetching;
  railFetching = (async () => {
    const r5 = n => Math.round(n * 1e5) / 1e5;
    const lines = [], stations = new Map();
    await Promise.all(Object.entries(RAIL_LINES).map(async ([id, colour]) => {
      try {
        const j = await (await fetch(`https://api.tfl.gov.uk/Line/${id}/Route/Sequence/all${tflKey ? '?app_key=' + tflKey : ''}`, { signal: AbortSignal.timeout(20000) })).json();
        const seen = new Set(), paths = [];
        for (const ls of j.lineStrings || []) for (const path of JSON.parse(ls)) {
          const pts = path.map(([lng, lat]) => [r5(lat), r5(lng)]);
          const key = JSON.stringify(pts), rev = JSON.stringify(pts.slice().reverse());
          if (seen.has(key) || seen.has(rev)) continue;
          seen.add(key); paths.push(pts);
        }
        if (paths.length) lines.push({ id, name: j.lineName || id, colour, paths });
        for (const seq of j.stopPointSequences || []) for (const st of seq.stopPoint || []) {
          const k = st.topMostParentId || st.stationId || st.id;
          if (!stations.has(k)) stations.set(k, { name: String(st.name || '').replace(/ (Underground|DLR|Rail) Station$| Station$/, ''), lat: r5(st.lat), lng: r5(st.lon), lines: [] });
          if (!stations.get(k).lines.includes(id)) stations.get(k).lines.push(id);
        }
      } catch { }
    }));
    const data = { lines, stations: [...stations.values()] };
    if (lines.length) railCache = { at: Date.now(), data };
    return data;
  })();
  try { return await railFetching; } finally { railFetching = null; }
}
function send(res, code, body, type = 'application/json; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function csv(value) { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

async function exportCsv(wsId) {
  const headings = ['Property', 'Buy/Rent', 'Area', 'Price', 'Bedrooms', 'Size', 'Tenure', 'Lease years', 'Available from', 'Listed', 'Last sold £', 'Last sold date', 'Recommendation', 'Confidence', 'Availability', 'Listing link', 'Latitude', 'Longitude', 'Last checked', 'Verdicts', 'Notes', 'Agent view', 'Checks'];
  const all = await rows('', wsId);
  const lines = all.map(p => {
    // Verdicts/notes span whoever reacted (any number of members), not fixed people.
    const verdicts = p.feedback.filter(f => f.verdict).map(f => `${f.person}: ${f.verdict}`).join('; ');
    const notes = p.feedback.filter(f => f.note).map(f => `${f.person}: ${f.note}`).join('; ');
    return [p.name, p.listing_type === 'rent' ? 'Rent' : 'Buy', p.area, p.price, p.bedrooms, p.size, p.tenure, p.lease_years, p.available_from, p.listed_date, p.last_sold_price, p.last_sold_date, p.recommendation, p.confidence, p.availability, p.listing_url, p.latitude, p.longitude, p.last_checked, verdicts, notes, p.agent_view, p.checks].map(csv).join(',');
  });
  return [headings.join(','), ...lines].join('\r\n');
}

// Re-check saved homes. With `ids`, only those homes (used straight after suggestions are
// added, so new homes get the full check at once); without, every live home + area data.
async function refresh(ids) {
  const items = ids
    ? (ids.length ? (await db.execute({ sql: `SELECT id, listing_url, price, size, listing_type FROM properties WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids })).rows : [])
    : (await db.execute({ sql: 'SELECT id, listing_url, price, size, listing_type FROM properties WHERE availability != ?', args: ['off-market'] })).rows;
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
      // …and to backfill tenure / lease length / floor area when the listing states them.
      try { const { tenure, leaseYears } = extractTenure(html); if (tenure) await db.execute({ sql: 'UPDATE properties SET tenure=?, lease_years=? WHERE id=?', args: [tenure, leaseYears, item.id] }); } catch { }
      try {
        const s = extractSize(html);
        if (s) { await db.execute({ sql: 'UPDATE properties SET size=? WHERE id=?', args: [s, item.id] }); }
        else if (item.size && /m²|sq\s*ft/i.test(item.size)) { // normalise a legacy mixed-unit size to sq m
          const m = item.size.match(/([\d,]+)\s*(?:sq\s*m|m²|m2)/i);
          if (m) await db.execute({ sql: 'UPDATE properties SET size=? WHERE id=?', args: [`${m[1].replace(/,/g, '')} sq m`, item.id] });
        }
      } catch { }
      // …and to backfill the listed date, available-from, and last-sold price (Land Registry).
      try {
        const ex = extractListing(html, item.listing_url);
        if (ex.listedDate) await db.execute({ sql: 'UPDATE properties SET listed_date=?, listed_reason=? WHERE id=?', args: [ex.listedDate, ex.listedReason, item.id] });
        if (ex.availableFrom) await db.execute({ sql: 'UPDATE properties SET available_from=? WHERE id=?', args: [ex.availableFrom, item.id] });
        // Last-sold + comparable sales are purchase concepts — skip them for rentals.
        if (item.listing_type !== 'rent') {
          // set-or-clear: a successful lookup with no comparable clears any stale value;
          // a network error throws above and leaves the existing value untouched.
          const flat = /flat|apartment|maison|studio/i.test(ex.type);
          const sold = await fetchSold(ex.postcode, ex.area, { price: item.price, flat });
          await db.execute({ sql: 'UPDATE properties SET last_sold_price=?, last_sold_date=?, last_sold_exact=? WHERE id=?', args: [sold ? sold.price : null, sold ? sold.date : null, sold ? (sold.exact ? 1 : 0) : null, item.id] });
          // Refresh the "recent sales nearby" comps straight into the cached insights, so the
          // re-check button surfaces them immediately (not only after the slow full recompute).
          const row = (await db.execute({ sql: 'SELECT data FROM insights WHERE property_id=?', args: [item.id] })).rows[0];
          if (row) {
            const data = JSON.parse(row.data);
            const comps = await recentSales(data.postcode || ex.postcode, item.price, flat);
            if (comps) { data.comps = comps; await db.execute({ sql: 'UPDATE insights SET data=? WHERE property_id=?', args: [JSON.stringify(data), item.id] }); }
          }
        }
      } catch { }
      // Price-change tracking: record the previous price + when it changed.
      try {
        const ogp = `${ogMeta(html, 'title') || ''} ${ogMeta(html, 'description') || ''}`;
        const pm = ogp.match(/£\s?([\d,]{4,})/) || html.match(/primaryPrice"[^>]*><span>£([\d,]+)/);
        const now2 = pm ? +pm[1].replace(/,/g, '') : null;
        if (now2 && Math.abs(now2 - item.price) >= 1000) {
          await db.execute({ sql: 'UPDATE properties SET prev_price=?, price=?, price_changed_at=? WHERE id=?', args: [item.price, now2, now, item.id] });
        }
      } catch { }
      results.push({ id: item.id, status: unavailable ? 'off-market' : 'available' });
    } catch {
      await db.execute({ sql: 'UPDATE properties SET availability=?, last_checked=? WHERE id=?', args: ['needs-check', now, item.id] });
      results.push({ id: item.id, status: 'needs-check' });
    }
  }
  planSizes(items.map(i => i.id));   // background: floor-plan sizes for homes still marked TBC
  if (!ids) refreshCommutes().catch(() => { });   // and any missing / failed / out-of-date commute times
  if (!ids) refreshInsights().catch(() => {}); // recompute area data in the background (new homes already compute theirs on add)
  return { availability: results };
}

// Automatic re-check (replaces the old button): runs in the background when someone
// opens the app, when the server wakes, and with the daily discovery cron — at most
// once every AUTO_REFRESH_HOURS. Only one run at a time.
const AUTO_REFRESH_HOURS = 12;
let refreshRunning = null;
async function maybeRefresh() {
  if (refreshRunning) return true;
  const last = await getSetting('last_refresh_at', null);
  if (last && Date.now() - new Date(last).getTime() < AUTO_REFRESH_HOURS * 3600e3) return false;
  await setSetting('last_refresh_at', new Date().toISOString());   // claim the slot first
  refreshRunning = refresh().catch(e => console.log('Auto re-check failed:', e && e.message)).finally(() => { refreshRunning = null; });
  return true;
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

  // --- auth routes (never gated) ------------------------------------------
  if (url.pathname === '/api/auth/request' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const email = normEmail(JSON.parse(body || '{}').email);
      if (!validEmail(email)) return send(res, 400, JSON.stringify({ error: 'Enter a valid email address.' }));
      const entry = await signInIdentity(email);
      let devLink = null;
      if (entry) {
        const token = randomBytes(24).toString('hex');
        await db.execute({ sql: 'INSERT INTO login_tokens(token,email,created_at,expires_at) VALUES(?,?,?,?)', args: [token, email, nowISO(), isoIn(LOGIN_TOKEN_MINUTES * 60000)] });
        const r = await sendLoginEmail(req, email, token);
        if (!r.sent) devLink = r.link;   // no email configured (local dev) — surface the link
      }
      // Uniform response whether or not the email is allowed (no account enumeration).
      return send(res, 200, JSON.stringify({ ok: true, ...(devLink ? { devLink } : {}) }));
    } catch { return send(res, 400, JSON.stringify({ error: 'Could not process that.' })); }
  }
  if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const row = (await db.execute({ sql: 'SELECT email, expires_at, used_at FROM login_tokens WHERE token=?', args: [token] })).rows[0];
    if (!row || row.used_at || row.expires_at < nowISO()) { res.writeHead(302, { Location: '/?auth=expired' }); return res.end(); }
    await db.execute({ sql: 'UPDATE login_tokens SET used_at=? WHERE token=?', args: [nowISO(), token] });
    return void await establishSession(req, res, row.email);
  }
  // Which sign-in methods are available (so the login screen can show the Google button).
  if (url.pathname === '/api/auth/config' && req.method === 'GET') return send(res, 200, JSON.stringify({ google: googleEnabled() }));
  // Google OAuth (Authorization Code). Only active when GOOGLE_CLIENT_ID/SECRET are set.
  if (url.pathname === '/api/auth/google' && req.method === 'GET') {
    if (!googleEnabled()) { res.writeHead(302, { Location: '/?auth=nogoogle' }); return res.end(); }
    const state = randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `nest_oauth_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${isHttps(req) ? '; Secure' : ''}`);
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${baseUrl(req)}/api/auth/google/callback`,
      response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account',
    });
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }); return res.end();
  }
  if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
    if (!googleEnabled()) { res.writeHead(302, { Location: '/' }); return res.end(); }
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code || !state || state !== parseCookies(req).nest_oauth_state) { res.writeHead(302, { Location: '/?auth=expired' }); return res.end(); }
    try {
      const tok = await (await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${baseUrl(req)}/api/auth/google/callback`, grant_type: 'authorization_code' }),
        signal: AbortSignal.timeout(15000),
      })).json();
      if (!tok.id_token) { res.writeHead(302, { Location: '/?auth=denied' }); return res.end(); }
      // id_token comes straight from Google's token endpoint over TLS (authenticated with our
      // client secret), so we can trust its claims without a separate JWKS signature check.
      const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (!payload.email || payload.email_verified === false) { res.writeHead(302, { Location: '/?auth=denied' }); return res.end(); }
      return void await establishSession(req, res, payload.email);
    } catch { res.writeHead(302, { Location: '/?auth=expired' }); return res.end(); }
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const tok = parseCookies(req).nest_session; if (tok) await db.execute({ sql: 'DELETE FROM sessions WHERE token=?', args: [tok] });
    setSessionCookie(res, req, '', 0);
    return send(res, 200, JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const u = await currentUser(req);
    if (!u) return send(res, 200, JSON.stringify({ user: null }));
    const wsId = await userWorkspace(u);   // provisions/joins a workspace on first call
    return send(res, 200, JSON.stringify({ user: { id: u.id, email: u.email, name: u.name }, workspace: { id: wsId, name: await workspaceName(wsId) } }));
  }

  // --- gate: every other /api route needs a signed-in user (and resolves their
  //     workspace), except the two cron-triggered jobs which run per-workspace.
  const OPEN_API = new Set(['/api/discover', '/api/send-weekly']);
  if (url.pathname.startsWith('/api/') && !OPEN_API.has(url.pathname)) {
    const u = await currentUser(req);
    if (!u) return send(res, 401, JSON.stringify({ error: 'Sign in required.' }));
    req.user = u;
    req.wsId = await userWorkspace(u);
  }

  if (url.pathname === '/api/master-clear' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { }
    if (b.confirm !== 'CLEAR') return send(res, 400, JSON.stringify({ error: 'Type CLEAR to confirm.' }));
    try { return send(res, 200, JSON.stringify(await masterClear(req.wsId, req.user))); }
    catch (e) { return send(res, 500, JSON.stringify({ error: 'Could not clear — nothing was deleted. ' + String(e && e.message || e) })); }
  }
  const arc = url.pathname.match(/^\/api\/archives\/([\w-]+)\/(download|restore)$/);
  if (arc && arc[2] === 'download' && req.method === 'GET') {
    const r = (await db.execute({ sql: 'SELECT created_at, data FROM archives WHERE id=? AND workspace_id=?', args: [arc[1], req.wsId] })).rows[0];
    if (!r) return send(res, 404, JSON.stringify({ error: 'No such snapshot.' }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="nest-snapshot-${String(r.created_at).slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    return res.end(r.data);
  }
  if (arc && arc[2] === 'restore' && req.method === 'POST') {
    try { const out = await restoreArchive(req.wsId, arc[1]); return send(res, out ? 200 : 404, JSON.stringify(out || { error: 'No such snapshot.' })); }
    catch (e) { return send(res, 500, JSON.stringify({ error: 'Restore failed. ' + String(e && e.message || e) })); }
  }
  if (url.pathname === '/api/rail-lines' && req.method === 'GET') return send(res, 200, JSON.stringify(await railLines()));
  if (url.pathname === '/api/commute-status' && req.method === 'GET') {
    const j = commuteJobs.get(req.wsId) || {};
    return send(res, 200, JSON.stringify({ running: !!j.running, done: j.done || 0, total: j.total || 0 }));
  }
  if (url.pathname === '/api/refresh-status' && req.method === 'GET')
    return send(res, 200, JSON.stringify({ running: !!refreshRunning, lastAt: await getSetting('last_refresh_at', null) }));
  if (url.pathname === '/api/properties' && req.method === 'GET') { maybeRefresh().catch(() => { }); }
  if (url.pathname === '/api/properties' && req.method === 'GET') return send(res, 200, JSON.stringify(await rows(req.user.name, req.wsId)));
  if (url.pathname === '/api/export.csv' && req.method === 'GET') return send(res, 200, await exportCsv(req.wsId), 'text/csv; charset=utf-8');
  if (url.pathname === '/api/refresh' && req.method === 'POST') return send(res, 200, JSON.stringify(await refresh()));
  if (url.pathname === '/api/discover' && req.method === 'POST') {
    const scheduled = url.searchParams.get('scheduled') === '1';
    const mode = url.searchParams.get('mode') === 'rent' ? 'rent' : 'buy';
    if (scheduled) {   // cron: discover for every workspace using each one's own brief/areas
      maybeRefresh().catch(() => { });   // the daily cron also keeps saved homes re-checked
      try { const wss = (await db.execute('SELECT id FROM workspaces')).rows; for (const w of wss) { if (await suggestionsOn(w.id)) await discover({ max: 8, poolCap: 20, maxAreas: 14, mode, wsId: w.id }); } return send(res, 200, JSON.stringify({ scheduled: true, workspaces: wss.length, mode })); }
      catch (e) { return send(res, 200, JSON.stringify({ added: [], error: 'Scheduled discovery did not complete.' })); }
    }
    const u = await currentUser(req);   // manual: needs a session, scoped to the caller's space
    if (!u) return send(res, 401, JSON.stringify({ error: 'Sign in required.' }));
    const uws = await userWorkspace(u);
    if (!(await suggestionsOn(uws))) return send(res, 200, JSON.stringify({ added: [], error: 'Suggestions are turned off for this space.' }));
    try { return send(res, 200, JSON.stringify(await discover({ mode, wsId: uws }))); }
    catch (e) { return send(res, 200, JSON.stringify({ added: [], error: 'Search did not complete (Rightmove may be rate-limiting). Try again shortly.' })); }
  }
  if (url.pathname === '/api/send-weekly' && req.method === 'POST') {
    try { return send(res, 200, JSON.stringify(await sendWeekly())); }
    catch (e) { return send(res, 200, JSON.stringify({ sent: 0, error: String(e && e.message || e) })); }
  }
  if (url.pathname === '/api/regeocode' && req.method === 'POST') {
    try { return send(res, 200, JSON.stringify(await refineLocations(req.wsId))); }
    catch (e) { return send(res, 200, JSON.stringify({ updated: 0, error: String(e && e.message || e) })); }
  }
  const settingsPayload = async () => {
    const host = await isHostUser(req.user);
    return {
      searchDistricts: await getSearchDistricts(req.wsId), destinations: await getDestinations(req.wsId),
      emails: await wsGet(req.wsId, 'emails', []), briefs: await getBriefs(req.wsId),
      guardrails: await wsGet(req.wsId, 'guardrails', DEFAULT_GUARDRAILS),
      moveWindow: await getMoveWindow(req.wsId),
      lineTarget: await getLineTarget(req.wsId),
      suggestionsOn: await suggestionsOn(req.wsId),
      tasteMemory: memorySummary(await wsGet(req.wsId, 'taste_memory', {})),
      archives: await listArchives(req.wsId),
      space: { id: req.wsId, name: await workspaceName(req.wsId), people: await workspacePeople(req.wsId) }, you: normEmail(req.user.email),
      isHost: host,
      ...(host ? { allowedUsers: await getAllowed() } : {}),   // the global sign-in list is host-only
    };
  };
  if (url.pathname === '/api/settings' && req.method === 'GET')
    return send(res, 200, JSON.stringify(await settingsPayload()));
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const b = JSON.parse(body || '{}'), ws = req.wsId;
      if (Array.isArray(b.searchDistricts)) await wsSet(ws, 'search_districts', [...new Set(b.searchDistricts.filter(x => /^[A-Z]{1,2}\d[A-Z\d]?$/i.test(x)).map(x => x.toUpperCase()))].slice(0, 60));
      if (Array.isArray(b.destinations)) {
        const clean = b.destinations
          .filter(d => d && d.name && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(d.postcode).trim()))
          .map(d => ({ name: String(d.name).slice(0, 40).trim(), postcode: String(d.postcode).toUpperCase().replace(/\s+/g, ' ').trim() }))
          .slice(0, 6);
        await wsSet(ws, 'destinations', clean);
        refreshCommutes(ws).catch(() => {}); // recompute this workspace's commutes in the background
      }
      if (Array.isArray(b.emails)) await wsSet(ws, 'emails', b.emails.filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e))).map(e => String(e).toLowerCase()).slice(0, 6));
      if (b.briefs && typeof b.briefs === 'object') {
        const cur = await getBriefs(ws);
        for (const m of ['buy', 'rent']) {
          const src = b.briefs[m]; if (!src || typeof src !== 'object') continue;
          const out = { ...cur[m] };
          if (Number.isFinite(+src.maxPrice)) out.maxPrice = Math.min(m === 'rent' ? 100000 : 100000000, Math.max(0, Math.round(+src.maxPrice)));
          if (Number.isFinite(+src.minPrice)) out.minPrice = Math.max(0, Math.round(+src.minPrice));
          if (src.minSqm !== undefined) out.minSqm = Number.isFinite(+src.minSqm) ? Math.min(500, Math.max(0, Math.round(+src.minSqm))) : 0;
          if (Array.isArray(src.beds)) out.beds = [...new Set(src.beds.map(Number).filter(n => n >= 0 && n <= 6))].sort((a, b) => a - b);
          cur[m] = out;
        }
        await wsSet(ws, 'briefs', cur);
      }
      if (Array.isArray(b.allowedUsers) && await isHostUser(req.user)) {   // global "who can sign in" — host only
        const clean = b.allowedUsers
          .filter(u => u && validEmail(normEmail(u.email)))
          .map(u => ({ email: normEmail(u.email), name: String(u.name || '').trim().slice(0, 40) || normEmail(u.email).split('@')[0] }));
        const byEmail = new Map(clean.map(u => [u.email, u]));
        if (!byEmail.has(normEmail(req.user.email))) byEmail.set(normEmail(req.user.email), { email: normEmail(req.user.email), name: req.user.name });
        await setSetting('allowed_users', [...byEmail.values()].slice(0, 50));
      }
      if (typeof b.guardrails === 'string') await wsSet(ws, 'guardrails', b.guardrails.trim().slice(0, 400));
      if (typeof b.suggestionsOn === 'boolean') await wsSet(ws, 'suggestions_off', !b.suggestionsOn);
      if (b.lineTarget && typeof b.lineTarget === 'object') {
        const lines = (Array.isArray(b.lineTarget.lines) ? b.lineTarget.lines : []).filter(l => RAIL_LINES[l]).slice(0, 6);
        await wsSet(ws, 'line_target', { lines, minutes: Math.min(30, Math.max(1, Math.round(+b.lineTarget.minutes || 5))) });
      }
      if (b.moveWindow && typeof b.moveWindow === 'object') {
        const iso = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';
        await wsSet(ws, 'move_window', { from: iso(b.moveWindow.from), to: iso(b.moveWindow.to) });
      }
      if (typeof b.spaceName === 'string' && b.spaceName.trim()) await db.execute({ sql: 'UPDATE workspaces SET name=? WHERE id=?', args: [b.spaceName.trim().slice(0, 60), ws] });
      let invited = 0;
      if (Array.isArray(b.spacePeople)) {
        const added = await reconcileSpacePeople(ws, req.user, b.spacePeople);
        if (added.length) {
          const spaceName = await workspaceName(ws);
          for (const p of added) { try { const r = await sendInviteEmail(req, p.email, req.user.name, spaceName); if (r.sent) invited++; } catch { } }
        }
      }
      return send(res, 200, JSON.stringify({ ok: true, invited, ...(await settingsPayload()) }));
    } catch { return send(res, 400, JSON.stringify({ error: 'Invalid settings' })); }
  }
  if (url.pathname === '/api/properties' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const { url: listingUrl } = JSON.parse(body || '{}');
      if (!listingUrl) return send(res, 400, JSON.stringify({ error: 'No link provided.' }));
      const result = await addListing(listingUrl, { wsId: req.wsId });
      return send(res, result.error ? 422 : 200, JSON.stringify(result));
    } catch (e) { return send(res, 400, JSON.stringify({ error: 'Could not add that link.' })); }
  }
  const del = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    const id = del[1];
    // Only a home in the caller's own workspace can be removed.
    const owned = (await db.execute({ sql: 'SELECT 1 FROM properties WHERE id=? AND workspace_id=?', args: [id, req.wsId] })).rows[0];
    if (!owned) return send(res, 404, JSON.stringify({ error: 'No such home.' }));
    for (const t of ['feedback', 'insights', 'media', 'commutes', 'guest_notes']) await db.execute({ sql: `DELETE FROM ${t} WHERE property_id=?`, args: [id] });
    await db.execute({ sql: 'DELETE FROM properties WHERE id=?', args: [id] });
    return send(res, 200, JSON.stringify({ ok: true }));
  }
  const match = url.pathname.match(/^\/api\/properties\/([^/]+)\/feedback$/);
  if (match && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { verdict, note } = JSON.parse(body);
      if (!['Love', 'View', 'Watch', 'Pass', null].includes(verdict)) throw new Error('verdict');
      // A verdict can only be left on a home in the caller's own workspace.
      const owned = (await db.execute({ sql: 'SELECT 1 FROM properties WHERE id=? AND workspace_id=?', args: [match[1], req.wsId] })).rows[0];
      if (!owned) return send(res, 404, JSON.stringify({ error: 'No such home.' }));
      const person = req.user.name;   // reactions are attributed to the signed-in user, never the client
      await db.execute({
        sql: `INSERT INTO feedback(property_id,person,verdict,note,updated_at) VALUES(?,?,?,?,?)
              ON CONFLICT(property_id,person) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,updated_at=excluded.updated_at`,
        args: [match[1], person, verdict, note || '', new Date().toISOString()],
      });
      return send(res, 200, JSON.stringify({ ok: true }));
    } catch { return send(res, 400, JSON.stringify({ error: 'Invalid feedback' })); }
  }
  // Curate & track: per-home tracking (contacted the agent, agent contact, stage, notes).
  const tr = url.pathname.match(/^\/api\/properties\/([^/]+)\/tracking$/);
  if (tr && req.method === 'PUT') {
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const owned = (await db.execute({ sql: 'SELECT 1 FROM properties WHERE id=? AND workspace_id=?', args: [tr[1], req.wsId] })).rows[0];
      if (!owned) return send(res, 404, JSON.stringify({ error: 'No such home.' }));
      const b = JSON.parse(body || '{}'), sets = [], args = [];
      if ('contacted' in b) { sets.push('contacted=?'); args.push(b.contacted ? 1 : 0); }
      if ('agent_contact' in b) { sets.push('agent_contact=?'); args.push(String(b.agent_contact || '').slice(0, 200)); }
      if ('track_stage' in b) { sets.push('track_stage=?'); args.push(String(b.track_stage || '').slice(0, 40)); }
      if ('track_notes' in b) { sets.push('track_notes=?'); args.push(String(b.track_notes || '').slice(0, 600)); }
      if (sets.length) { args.push(tr[1]); await db.execute({ sql: `UPDATE properties SET ${sets.join(', ')} WHERE id=?`, args }); }
      return send(res, 200, JSON.stringify({ ok: true }));
    } catch { return send(res, 400, JSON.stringify({ error: 'Could not save tracking.' })); }
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
  try { if (await maybeRefresh()) console.log('Re-checking saved homes in the background…'); } catch { }
  try { console.log('Fetching listing galleries…'); await bootstrapMedia(); console.log('Galleries ready.'); }
  catch (e) { console.log('Gallery bootstrap skipped:', e && e.message); }
  try {
    const have = (await db.execute('SELECT COUNT(*) AS n FROM commutes')).rows[0].n;
    const total = (await db.execute('SELECT COUNT(*) AS n FROM properties')).rows[0].n;
    console.log('Checking commute times…'); await refreshCommutes(); console.log('Commutes up to date.');
  } catch (e) { console.log('Commute bootstrap skipped:', e && e.message); }
})();

setInterval(() => maybeRefresh().catch(() => {}), checkEveryMs).unref();   // same 12 h guard as the other triggers
