// Genera radars.json a partir de:
//  - DGT (NAP, DATEX II "Radares fijos"): tot Espanya excepte Catalunya i País Basc.
//  - OpenStreetMap via Overpass (highway=speed_camera): Catalunya i País Basc (no oficial).
// Sense dependències: node scripts/build-radars.mjs [--dgt fitxer.xml] [--osm fitxer.json]
import { writeFile, readFile } from 'node:fs/promises';

const DGT_URL = 'https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_QUERY = `[out:json][timeout:120];
(area["ISO3166-2"="ES-CT"];area["ISO3166-2"="ES-PV"];)->.a;
node["highway"="speed_camera"](area.a);
out body;`;
const OUT = new URL('../www/radars.json', import.meta.url);

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

const tag = (block, name) => {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : null;
};
const round = (x, n = 5) => Math.round(x * 10 ** n) / 10 ** n;

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
      coords.slice(0, 2).forEach(([la, lo], k) => out.push({
        id: `dgt-${base}-${k}`, lat: round(la), lon: round(lo), t: 'tram', r: road, pk, to: towards, s: 'dgt',
      }));
    } else {
      const [la, lo] = coords[0];
      out.push({ id: `dgt-${base}`, lat: round(la), lon: round(lo), t: 'fix', r: road, pk, to: towards, s: 'dgt' });
    }
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

export function parseOverpass(json) {
  return (json.elements || [])
    .filter((e) => e.type === 'node' && isFinite(e.lat) && isFinite(e.lon))
    .map((e) => {
      const t = e.tags || {};
      const v = parseInt(t.maxspeed, 10);
      const note = `${t.note || ''} ${t.description || ''} ${t.name || ''}`;
      return {
        id: `osm-${e.id}`,
        lat: round(e.lat), lon: round(e.lon),
        t: /tram|velocidad media|average/i.test(note) ? 'tram' : 'fix',
        r: t.ref || null,
        d: osmDirection(t.direction),
        v: isFinite(v) ? v : null,
        s: 'osm',
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
export function merge(dgt, osm) {
  // Si un punt d'OSM és a menys de 60 m d'un de la DGT, ens quedem el de la DGT (oficial).
  const kept = osm.filter((o) => !dgt.some((d) => Math.abs(d.lat - o.lat) < 0.001 && distance(d, o) < 60));
  return [...dgt, ...kept];
}

// ---------- descàrrega ----------
async function getText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'radars-pwa-build/1.0', ...(opts.headers || {}) }, signal: AbortSignal.timeout(150000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}
async function loadDgt() {
  const f = arg('--dgt');
  return parseDatex(f ? await readFile(f, 'utf8') : await getText(DGT_URL));
}
async function loadOsm() {
  const f = arg('--osm');
  if (f) return parseOverpass(JSON.parse(await readFile(f, 'utf8')));
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      const body = new URLSearchParams({ data: OVERPASS_QUERY });
      return parseOverpass(JSON.parse(await getText(url, { method: 'POST', body })));
    } catch (e) { lastErr = e; console.warn(`Overpass ha fallat (${url}): ${e.message}`); }
  }
  throw lastErr;
}

async function main() {
  const [dgtR, osmR] = await Promise.allSettled([loadDgt(), loadOsm()]);
  const dgt = dgtR.status === 'fulfilled' ? dgtR.value : [];
  const osm = osmR.status === 'fulfilled' ? osmR.value : [];
  if (dgtR.status === 'rejected') console.error('DGT:', dgtR.reason.message);
  if (osmR.status === 'rejected') console.error('OSM:', osmR.reason.message);

  // Si una font falla, conservem els seus radars de l'últim radars.json en lloc de perdre'ls.
  let prev = [];
  try { prev = JSON.parse(await readFile(OUT, 'utf8')).radars || []; } catch {}
  const dgtF = dgt.length ? dgt : prev.filter((r) => r.s === 'dgt');
  const osmF = osm.length ? osm : prev.filter((r) => r.s === 'osm');

  const radars = merge(dgtF, osmF);
  if (radars.length < 100) {
    console.error(`Només ${radars.length} radars: no sobreescric radars.json.`);
    process.exit(1);
  }
  const data = {
    generated: new Date().toISOString(),
    sources: { dgt: dgtF.length, osm: radars.length - dgtF.length },
    radars,
  };
  await writeFile(OUT, JSON.stringify(data));
  const trams = radars.filter((r) => r.t === 'tram').length;
  console.log(`radars.json: ${radars.length} punts (DGT ${data.sources.dgt}, OSM ${data.sources.osm}; ${trams} de tram)`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-radars.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
