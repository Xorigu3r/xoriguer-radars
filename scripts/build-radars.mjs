// Genera www/radars.json a partir de:
//  - DGT (NAP, DATEX II "Radares fijos"): tot Espanya excepte Catalunya i País Basc. Oficial.
//  - SCT (Servei Català de Trànsit, radars.txt): Catalunya, amb límit de velocitat. Oficial.
//  - França (data.gouv.fr, Ministère de l'Intérieur): radars fixos amb límit. Oficial.
//    A França és il·legal indicar la posició exacta: l'app hi avisa en mode "zona de perill".
//  - OpenStreetMap (Overpass, highway=speed_camera): País Basc, Portugal, Andorra i Itàlia,
//    i els municipals de Catalunya que no són a la llista del SCT. No oficial.
//  - Límits de velocitat que falten (DGT, OSM): de la via d'OpenStreetMap més propera (maxspeed).
// No hi ha radars d'Alemanya ni de Suïssa: allà és il·legal fer servir avisadors conduint.
//
// Sense dependències: node scripts/build-radars.mjs [--dgt f.xml] [--sct f.txt] [--fr f.csv] [--no-limits]
import { writeFile, readFile } from 'node:fs/promises';

const DGT_URL = 'https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml';
const SCT_URL = 'https://transit.gencat.cat/web/.content/documents/seguretat_viaria/radars.txt';
const FR_DATASET = 'https://www.data.gouv.fr/api/1/datasets/liste-des-radars-fixes-en-france/';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Zones d'OpenStreetMap: [país, filtre d'àrea]
const OSM_AREAS = [
  ['ES', '["ISO3166-2"="ES-CT"]'],
  ['ES', '["ISO3166-2"="ES-PV"]'],
  ['PT', '["ISO3166-1"="PT"]["admin_level"="2"]'],
  ['AD', '["ISO3166-1"="AD"]["admin_level"="2"]'],
  ['IT', '["ISO3166-1"="IT"]["admin_level"="2"]'],
];
const OUT = new URL('../www/radars.json', import.meta.url);
const UA = { 'User-Agent': 'xoriguer-radars-build/1.1 (+https://github.com/Xorigu3r/xoriguer-radars)' };

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const tag = (block, name) => {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : null;
};
const round = (x, n = 5) => Math.round(x * 10 ** n) / 10 ** n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- DGT ----------
export function parseDatex(xml) {
  const out = [];
  // Cada radar és un <predefinedLocation id="..."> de primer nivell (el que té id).
  const re = /<(?:\w+:)?predefinedLocation id="([^"]+)">([\s\S]*?)(?=<(?:\w+:)?predefinedLocation id="|<\/(?:\w+:)?predefinedLocationSet>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, id, block] = m;
    const coords = [...block.matchAll(/<(?:\w+:)?latitude>([-\d.]+)<\/(?:\w+:)?latitude>\s*<(?:\w+:)?longitude>([-\d.]+)<\/(?:\w+:)?longitude>/g)]
      .map((c) => [parseFloat(c[1]), parseFloat(c[2])])
      .filter(([la, lo]) => isFinite(la) && isFinite(lo) && la > 27 && la < 44.5 && lo > -19 && lo < 5);
    if (!coords.length) continue;
    const road = tag(block, 'roadNumber') || tag(block, 'value');
    const dist = parseFloat(tag(block, 'referencePointDistance'));
    const pk = isFinite(dist) ? round(dist / 1000, 1) : null;
    const towards = tag(block, 'directionNamed');
    const isTram = /VelocidadMedia|CVM_/i.test(id) || coords.length >= 2;
    const base = id.replace(/^GUID_/, '');
    if (isTram) {
      // Els dos extrems del tram; `g` els agrupa (per calcular la velocitat mitjana).
      coords.slice(0, 2).forEach(([la, lo], k) => out.push({
        id: `dgt-${base}-${k}`, g: `dgt-${base}`, lat: round(la), lon: round(lo), t: 'tram', r: road, pk, to: towards, s: 'dgt', c: 'ES',
      }));
    } else {
      const [la, lo] = coords[0];
      out.push({ id: `dgt-${base}`, lat: round(la), lon: round(lo), t: 'fix', r: road, pk, to: towards, s: 'dgt', c: 'ES' });
    }
  }
  return out;
}

// ---------- SCT (Catalunya) ----------
/** UTM (ETRS89 ≈ WGS84) → lat/lon. */
export function utmToLatLon(x, y, zone = 31) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
  const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = (x - 500000) / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(p1);
  return { lat: (lat * 180) / Math.PI, lon: zone * 6 - 183 + (lon * 180) / Math.PI };
}

export function parseSct(txt) {
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+([\d.,]+(?:\s*-\s*[\d.,]+)?)\s+(\d+)\s+([\d.,]+)\s+([\d.,]+)\s*$/);
    if (!m) continue;
    const [, via, pkRaw, vel, xs, ys] = m;
    const num = (s) => parseFloat(s.replace(',', '.'));
    const { lat, lon } = utmToLatLon(num(xs), num(ys));
    if (!(lat > 40.4 && lat < 42.95 && lon > 0.1 && lon < 3.4)) continue;
    const tram = pkRaw.includes('-');
    const pk = num(pkRaw.split('-')[0]);
    // Trams: la mateixa via i parell de PK (p. ex. 1074-1079 i 1079-1074) són el mateix tram en sentits oposats.
    const g = tram ? `sct-${via}-${pkRaw.split('-').map(num).sort((a, b) => a - b).join('-')}` : undefined;
    out.push({ id: `sct-${via}-${pkRaw.replace(/\s/g, '')}`, ...(g ? { g } : {}), lat: round(lat), lon: round(lon),
      t: tram ? 'tram' : 'fix', r: via, pk: round(pk, 1), v: +vel, s: 'sct', c: 'ES' });
  }
  return out;
}

// ---------- França ----------
// ETF fix, ETD discriminant, ETT torreta, ETU urbà, ETVM velocitat mitjana. Fora: ETFR (semàfor) i ETPN (pas a nivell).
const FR_TYPES = { ETF: 'fix', ETD: 'fix', ETT: 'fix', ETU: 'fix', ETVM: 'tram' };
export function parseFrance(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(';').map((h) => h.trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const iNum = col(/num/), iType = col(/type/), iV = col(/^vma/), iLat = col(/lat/), iLon = col(/lon/);
  const out = [];
  for (const l of lines) {
    const f = l.split(';').map((s) => s.trim());
    const t = FR_TYPES[f[iType]];
    const lat = parseFloat(f[iLat]), lon = parseFloat(f[iLon]);
    if (!t || !isFinite(lat) || !isFinite(lon) || lat < 41 || lat > 51.5 || lon < -5.5 || lon > 10) continue;
    const v = parseInt(f[iV], 10);
    out.push({ id: `fr-${f[iNum]}`, lat: round(lat), lon: round(lon), t, ...(isFinite(v) ? { v } : {}), s: 'fr', c: 'FR' });
  }
  return out;
}

// ---------- OSM ----------
const CARDINAL = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
export function osmDirection(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) % 360;
  if (s in CARDINAL) return CARDINAL[s];
  return null; // forward/backward, "0;180", etc.: no ho podem resoldre sense la via
}

export function parseOverpass(json, country = 'ES') {
  return (json.elements || [])
    .filter((e) => e.type === 'node' && isFinite(e.lat) && isFinite(e.lon))
    .map((e) => {
      const t = e.tags || {};
      const v = parseInt(t.maxspeed, 10);
      const note = `${t.note || ''} ${t.description || ''} ${t.name || ''}`;
      return {
        id: `osm-${e.id}`,
        lat: round(e.lat), lon: round(e.lon),
        t: /tram|velocidad media|average|tutor|section/i.test(note) ? 'tram' : 'fix',
        r: t.ref || null,
        d: osmDirection(t.direction),
        v: isFinite(v) ? v : null,
        s: 'osm', c: country,
      };
    });
}

// ---------- fusió ----------
const toRad = (d) => (d * Math.PI) / 180;
function distance(a, b) {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Els oficials tenen preferència: un punt d'OSM a menys de 80 m d'un oficial es descarta. */
export function merge(official, osm) {
  const grid = new Map();
  const cell = (p) => `${Math.floor(p.lat * 100)}:${Math.floor(p.lon * 100)}`;
  for (const o of official) { const k = cell(o); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(o); }
  const near = (p) => {
    const [a, b] = [Math.floor(p.lat * 100), Math.floor(p.lon * 100)];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const o of grid.get(`${a + i}:${b + j}`) || []) if (distance(o, p) < 80) return true;
    return false;
  };
  return [...official, ...osm.filter((p) => !near(p))];
}

// ---------- descàrrega ----------
async function getText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return opts.latin1 ? new TextDecoder('latin1').decode(await res.arrayBuffer()) : res.text();
}
async function overpass(query, { tries = 2, timeoutMs = 300000 } = {}) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    for (let intent = 0; intent < tries; intent++) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: UA, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) { lastErr = e; console.warn(`Overpass (${url}): ${e.message}`); await sleep(5000); }
    }
  }
  throw lastErr;
}
async function loadDgt() {
  const f = arg('--dgt');
  return parseDatex(f ? await readFile(f, 'utf8') : await getText(DGT_URL));
}
async function loadSct() {
  const f = arg('--sct');
  return parseSct(f ? await readFile(f, 'latin1') : await getText(SCT_URL, { latin1: true }));
}
async function loadFrance() {
  const f = arg('--fr');
  if (f) return parseFrance(new TextDecoder('latin1').decode(await readFile(f)));
  const ds = JSON.parse(await getText(FR_DATASET));
  const csv = ds.resources.filter((r) => r.format === 'csv').sort((a, b) => String(b.last_modified).localeCompare(String(a.last_modified)))[0];
  return parseFrance(await getText(csv.url, { latin1: true }));
}
/** Radars d'OSM zona per zona; si una zona falla (Overpass saturat), es conserven els anteriors d'aquell país. */
async function loadOsm(prev) {
  const all = [], failed = new Set();
  for (const [country, filter] of OSM_AREAS) {
    const q = `[out:json][timeout:300];area${filter}->.a;node["highway"="speed_camera"](area.a);out body;`;
    try {
      const r = parseOverpass(await overpass(q), country);
      console.log(`  OSM ${country} ${filter}: ${r.length}`);
      all.push(...r);
    } catch (e) {
      console.error(`  OSM ${country} ${filter}: ${e.message} → es mantenen els anteriors`);
      failed.add(country);
    }
    await sleep(2000);
  }
  const have = new Set(all.map((r) => r.id));
  for (const r of prev) {
    // Els radars antics sense país eren de Catalunya i el País Basc.
    if (r.s === 'osm' && failed.has(r.c || 'ES') && !have.has(r.id)) all.push({ ...r, c: r.c || 'ES' });
  }
  return all;
}

/** Límit de la via més propera (OSM maxspeed) per als radars que no en tenen. */
async function addLimits(radars) {
  const need = radars.filter((r) => !r.v && r.c !== 'FR');
  const CHUNK = 120;
  // Pressupost de temps: si Overpass va lent, ens quedem amb el que hàgim trobat (el pròxim dia continua,
  // perquè els límits trobats es reaprofiten). Sense això, el novembre de 2026 va bloquejar la web una hora.
  const budgetMs = (+process.env.LIMITS_MINUTES || 20) * 60000;
  const t0 = Date.now();
  let found = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    if (Date.now() - t0 > budgetMs) { console.warn(`\n  límits: s'ha acabat el temps (${need.length - i} radars pendents per a la pròxima vegada)`); break; }
    const part = need.slice(i, i + CHUNK);
    const q = '[out:json][timeout:240];\n' + part.map((r) =>
      `way(around:30,${r.lat},${r.lon})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link)$"][maxspeed];make l rid="${r.id}",ms=set(t["maxspeed"]);out;`).join('\n');
    try {
      const j = await overpass(q, { tries: 1, timeoutMs: 150000 });
      const byId = new Map(part.map((r) => [r.id, r]));
      for (const e of j.elements || []) {
        const r = byId.get(e.tags && e.tags.rid);
        if (!r) continue;
        const vals = String(e.tags.ms || '').split(';').map((s) => parseInt(s, 10)).filter((n) => n >= 10 && n <= 130);
        // Si hi ha vies amb límits diferents (enllaços, vies de servei…), ens quedem el més alt: és el de la via principal.
        if (vals.length) { r.v = Math.max(...vals); found++; }
      }
    } catch (e) { console.warn('Límits:', e.message); }
    process.stdout.write(`  límits ${Math.min(i + CHUNK, need.length)}/${need.length}\r`);
    await sleep(3000);
  }
  console.log(`\n  límits trobats: ${found}/${need.length}`);
}

async function main() {
  let prev = [];
  try { prev = JSON.parse(await readFile(OUT, 'utf8')).radars || []; } catch {}
  const keep = (name, res, src) => {
    if (res.status === 'fulfilled' && res.value.length) { console.log(`${name}: ${res.value.length}`); return res.value; }
    console.error(`${name}: ${res.status === 'rejected' ? res.reason.message : 'buit'} → es manté l'anterior`);
    return prev.filter(src);   // si una font falla, conservem el que teníem
  };
  const [dgtR, sctR, frR] = await Promise.allSettled([loadDgt(), loadSct(), loadFrance()]);
  const dgt = keep('DGT', dgtR, (r) => r.s === 'dgt');
  const sct = keep('SCT', sctR, (r) => r.s === 'sct');
  const fr = keep('França', frR, (r) => r.s === 'fr');
  const osm = await loadOsm(prev);

  const radars = merge([...dgt, ...sct, ...fr], osm);
  if (radars.length < 500) {
    console.error(`Només ${radars.length} radars: no sobreescric radars.json.`);
    process.exit(1);
  }
  if (!process.argv.includes('--no-limits')) {
    // Reaprofitem els límits ja trobats en una execució anterior (estalvia consultes).
    const prevV = new Map(prev.filter((r) => r.v).map((r) => [r.id, r.v]));
    for (const r of radars) if (!r.v && prevV.has(r.id)) r.v = prevV.get(r.id);
    await addLimits(radars);
  }
  for (const r of radars) for (const k of Object.keys(r)) if (r[k] == null) delete r[k];
  const count = (f) => radars.filter(f).length;
  const data = {
    generated: new Date().toISOString(),
    sources: { dgt: count((r) => r.s === 'dgt'), sct: count((r) => r.s === 'sct'), fr: count((r) => r.s === 'fr'), osm: count((r) => r.s === 'osm') },
    countries: [...new Set(radars.map((r) => r.c))].sort(),
    radars,
  };
  await writeFile(OUT, JSON.stringify(data));
  console.log(`radars.json: ${radars.length} punts`, data.sources, `amb límit: ${count((r) => r.v)}`, `trams: ${count((r) => r.t === 'tram')}`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('build-radars.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
