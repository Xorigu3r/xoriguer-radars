// Mapa de conducció: gira amb el rumb (el cotxe sempre mira amunt) i mostra els radars.
// Només es carrega si l'usuari activa el mapa als ajustos (app.js fa `import('./map.js')`).
import * as maplibregl from './vendor/maplibre-gl.mjs';

// OpenFreeMap: tessel·les vectorials gratuïtes, sense clau. Estil fosc, com la resta de l'app.
const STYLE = 'https://tiles.openfreemap.org/styles/dark';

/* ---------------------------------------------------------------------------------------------
   Memòria del mapa al mòbil (Cache API)
   - Tessel·les (protocol xt://z/x/y): primer la còpia desada; si no n'hi ha, internet i es desa.
     La clau és z/x/y, sense la versió del servidor: el que ja has vist o descarregat continua
     servint quan OpenFreeMap publica una versió nova.
   - Es desen comprimides (gzip) perquè ocupin el mateix que es baixa.
   - Estil i TileJSON: internet primer, còpia desada si no hi ha connexió.
   - Símbols i lletres (protocol xc://host/camí, sense «https://», que MapLibre espatlla): còpia desada primer.
   --------------------------------------------------------------------------------------------- */
const CACHE = 'xoriguer-mapa-v1';
const KEY = (k) => `https://mapa.xoriguer.local/${k}`;
let tileTmpl = null;

const gz = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

function stats() {
  try { return JSON.parse(localStorage.getItem('mapaDesat') || '{"tiles":0,"bytes":0}'); } catch { return { tiles: 0, bytes: 0 }; }
}
function bump(bytes) {
  const s = stats(); s.tiles++; s.bytes += bytes;
  try { localStorage.setItem('mapaDesat', JSON.stringify(s)); } catch {}
}
async function cacheGet(key) {
  const r = await (await caches.open(CACHE)).match(KEY(key));
  return r ? gunzip(await r.arrayBuffer()) : null;
}
async function cacheHas(key) {
  return !!(await (await caches.open(CACHE)).match(KEY(key)));
}
async function cachePut(key, buf, count = true) {
  try {
    const z = await gz(buf);
    await (await caches.open(CACHE)).put(KEY(key), new Response(z));
    if (count) bump(z.byteLength);
  } catch { /* sense espai o sense Cache API: només no es desa */ }
}

/** JSON d'internet amb còpia desada de recanvi (per si no hi ha cobertura). */
async function jsonNetFirst(url, key) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const buf = await res.arrayBuffer();
    cachePut(key, buf, false);
    return JSON.parse(new TextDecoder().decode(buf));
  } catch (e) {
    const buf = await cacheGet(key);
    if (!buf) throw e;
    return JSON.parse(new TextDecoder().decode(buf));
  }
}

function asType(buf, type) {
  if (type === 'json') return JSON.parse(new TextDecoder().decode(buf));
  if (type === 'string') return new TextDecoder().decode(buf);
  return buf;
}

/* ---------------------------------------------------------------------------------------------
   Paquets de mapa (.pmtiles) desats al mòbil amb el connector natiu "Mapes".
   Quan una tessel·la cau dins d'un paquet instal·lat, es llegeix d'allà (sense dades ni cobertura).
   --------------------------------------------------------------------------------------------- */
const Cap = window.Capacitor;
const MapesNatiu = Cap && Cap.isNativePlatform && Cap.isNativePlatform() ? Cap.registerPlugin('Mapes') : null;
let pmLib = null;
function loadPmtiles() {
  if (window.pmtiles) return Promise.resolve(window.pmtiles);
  if (!pmLib) pmLib = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'vendor/pmtiles.js'; s.onload = () => ok(window.pmtiles); s.onerror = ko;
    document.head.appendChild(s);
  });
  return pmLib;
}
const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
/** Font de bytes per a PMTiles: el fitxer al mòbil (natiu) o, per a proves al navegador, una URL. */
function sourceFor(pkg) {
  if (MapesNatiu && pkg.fitxer) {
    return { getKey: () => pkg.fitxer,
      getBytes: async (offset, length) => ({ data: b64((await MapesNatiu.llegeix({ fitxer: pkg.fitxer, offset, length })).data) }) };
  }
  return pkg.url;   // el lector de PMTiles fa peticions per trossos (Range)
}
let packages = [];   // [{ id, bounds:[w,s,e,n], pm }]
/** Registra els paquets instal·lats ([{id, fitxer|url, bounds}]). */
export async function setPackages(list) {
  const lib = await loadPmtiles();
  packages = list.map((p) => ({ id: p.id, bounds: p.bounds, pm: new lib.PMTiles(sourceFor(p)) }));
}
const tileCenter = (z, x, y) => {
  const n = 2 ** z, lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return { lat, lon };
};
async function fromPackages(z, x, y) {
  if (!packages.length) return null;
  const c = tileCenter(+z, +x, +y);
  for (const p of packages) {
    const [w, s, e, n] = p.bounds;
    if (c.lon < w || c.lon > e || c.lat < s || c.lat > n) continue;
    try {
      const r = await p.pm.getZxy(+z, +x, +y);
      if (r && r.data) return r.data;
    } catch (err) { console.warn('Paquet', p.id, err); }
  }
  return null;
}

let protocols = false;
function registerProtocols() {
  if (protocols) return;
  protocols = true;
  maplibregl.addProtocol('xt', async (params, abort) => {
    const [z, x, y] = params.url.slice('xt://'.length).split('/');
    const fromPkg = await fromPackages(z, x, y);
    if (fromPkg) return { data: fromPkg };
    const key = `t/${z}/${x}/${y}`;
    const hit = await cacheGet(key);
    if (hit) return { data: hit };
    const res = await fetch(tileTmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: abort.signal });
    if (res.status === 204 || res.status === 404) return { data: new ArrayBuffer(0) }; // mar, buit
    if (!res.ok) throw new Error(`Tessel·la ${res.status}`);
    const buf = await res.arrayBuffer();
    cachePut(key, buf.slice(0));
    return { data: buf };
  });
  maplibregl.addProtocol('xc', async (params, abort) => {
    const url = 'https://' + params.url.slice('xc://'.length);
    const key = `c/${url}`;
    let buf = await cacheGet(key);
    if (!buf) {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`Recurs ${res.status}`);
      buf = await res.arrayBuffer();
      cachePut(key, buf.slice(0), false);
    }
    return { data: asType(buf, params.type) };
  });
}

/** Estil fosc amb les fonts del mapa passades per la memòria del mòbil. */
async function buildStyle() {
  registerProtocols();
  const style = await jsonNetFirst(STYLE, 'style');
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type !== 'vector' || !src.url) continue;
    const tj = await jsonNetFirst(src.url, `tilejson/${id}`);
    tileTmpl = tj.tiles[0];
    style.sources[id] = {
      type: 'vector', tiles: ['xt://{z}/{x}/{y}'],
      minzoom: tj.minzoom || 0, maxzoom: tj.maxzoom || 14, attribution: tj.attribution || src.attribution,
    };
  }
  if (typeof style.sprite === 'string') style.sprite = 'xc://' + style.sprite.replace('https://', '');
  if (style.glyphs) style.glyphs = 'xc://' + style.glyphs.replace('https://', '');
  return style;
}

/* ---------------------------------------------------------------- mapa sense connexió */

const tileOf = (lat, lon, z) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
};

/** Tessel·les (z12–z14) a menys de `km` d'algun punt d'un camí (per al mapa d'una ruta). */
export function tilesAlongPath(path, km = 3) {
  const set = new Set();
  for (let i = 0; i < path.length; i++) {
    // Punts cada ~1 km com a molt (els trams llargs entre dos punts es divideixen).
    const a = path[i], b = path[i + 1] || a;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.lat - a.lat, b.lon - a.lon) / 0.009));
    for (let s = 0; s < steps; s++) {
      const p = { lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps };
      for (const t of tilesInRadius(p, km)) set.add(t.join('/'));
    }
  }
  return [...set].map((k) => k.split('/').map(Number));
}

/** Descarrega una llista de tessel·les a la memòria del mapa (mapa d'una zona o d'una ruta). */
export async function downloadTiles(tiles, onProgress, signal) {
  const style = await buildStyle();
  await saveStyleExtras(style, signal);
  let done = 0, bytes = 0, errors = 0, i = 0;
  const worker = async () => {
    while (i < tiles.length) {
      if (signal && signal.aborted) return;
      const [z, x, y] = tiles[i++];
      const key = `t/${z}/${x}/${y}`;
      try {
        if (!(await fromPackages(z, x, y)) && !(await cacheHas(key))) {
          const r = await fetch(tileTmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal });
          if (r.ok) { const buf = await r.arrayBuffer(); bytes += buf.byteLength; await cachePut(key, buf); }
          else if (r.status !== 204 && r.status !== 404) errors++;
        }
      } catch (e) { if (signal && signal.aborted) return; errors++; }
      done++;
      if (onProgress) onProgress({ done, total: tiles.length, bytes, errors });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, total: tiles.length, errors, aborted: !!(signal && signal.aborted) };
}

/** Tessel·les (z12–z14) dins d'un cercle de `radiKm` al voltant de `center`. */
export function tilesInRadius(center, radiKm) {
  const out = [];
  for (const z of [12, 13, 14]) {
    const n = 2 ** z;
    const tileKm = (40075 * Math.cos((center.lat * Math.PI) / 180)) / n;
    const c = tileOf(center.lat, center.lon, z), rt = radiKm / tileKm + 0.5;
    for (let x = Math.floor(c.x - rt); x <= Math.ceil(c.x + rt); x++)
      for (let y = Math.floor(c.y - rt); y <= Math.ceil(c.y + rt); y++)
        if ((x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 <= rt * rt) out.push([z, ((x % n) + n) % n, y]);
  }
  return out;
}

/** Quant ocupa el mapa desat (aproximat). */
export function savedStats() { return stats(); }

export async function clearSaved() {
  await caches.delete(CACHE);
  try { localStorage.removeItem('mapaDesat'); } catch {}
}

/**
 * Descarrega el mapa d'una zona. onProgress({done, total, bytes}); `signal` per aturar-ho.
 * També desa l'estil, els símbols i les lletres perquè el mapa s'obri sense cobertura.
 */
export function downloadArea(center, radiKm, onProgress, signal) {
  return downloadTiles(tilesInRadius(center, radiKm), onProgress, signal);
}

/** Desa l'estil, els símbols i les lletres més habituals (llatí bàsic i ampliat, i puntuació). */
async function saveStyleExtras(style, signal) {
  const extras = [];
  if (typeof style.sprite === 'string') for (const s of ['@2x.json', '@2x.png', '.json', '.png']) extras.push('https://' + style.sprite.slice(5) + s);
  if (style.glyphs) {
    const stacks = new Set();
    for (const l of style.layers) { const f = l.layout && l.layout['text-font']; if (Array.isArray(f) && typeof f[0] === 'string') stacks.add(f.join(',')); }
    for (const st of stacks) for (const range of ['0-255', '256-511', '8192-8447']) {
      extras.push(('https://' + style.glyphs.slice(5)).replace('{fontstack}', encodeURIComponent(st)).replace('{range}', range));
    }
  }
  for (const url of extras) {
    if (signal && signal.aborted) break;
    if (await cacheHas(`c/${url}`)) continue;
    try { const r = await fetch(url, { signal }); if (r.ok) await cachePut(`c/${url}`, await r.arrayBuffer(), false); } catch {}
  }
}

const C ={ cream: '#F6EFE2', orange: '#FFA82E', orangeDark: '#F2650F', red: '#D9341E', night: '#0A0B0E' };

// Zoom segons la velocitat: a ciutat més a prop, a l'autopista veus més lluny.
export function zoomFor(kmh) {
  if (kmh == null || kmh < 30) return 16.5;
  if (kmh < 60) return 16;
  if (kmh < 90) return 15.3;
  if (kmh < 110) return 14.8;
  return 14.4;
}

// Icona rodona de radar (com les senyals del logo): anella de color, fons crema, càmera fosca.
function radarIcon(ring, size = 64, tram = false) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  g.beginPath(); g.arc(r, r, r - 2, 0, Math.PI * 2); g.fillStyle = C.night; g.fill();
  g.beginPath(); g.arc(r, r, r - 5, 0, Math.PI * 2); g.fillStyle = ring; g.fill();
  g.beginPath(); g.arc(r, r, r - 13, 0, Math.PI * 2); g.fillStyle = C.cream; g.fill();
  g.fillStyle = C.night;
  if (tram) {
    // Tram de velocitat mitjana: dues càmeres petites unides
    g.fillRect(r - 15, r - 5, 11, 9); g.fillRect(r + 4, r - 5, 11, 9);
    g.fillRect(r - 4, r - 1, 8, 2);
  } else {
    g.fillRect(r - 11, r - 6, 22, 14);
    g.fillRect(r - 6, r - 10, 7, 4);
    g.beginPath(); g.arc(r, r + 1, 4.5, 0, Math.PI * 2); g.fillStyle = C.cream; g.fill();
  }
  return g.getImageData(0, 0, size, size);
}

// Triangle d'avís (incidències de trànsit)
function warnIcon(color, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const tri = (inset) => {
    g.beginPath();
    g.moveTo(size / 2, 4 + inset); g.lineTo(size - 4 - inset, size - 6 - inset * 0.6); g.lineTo(4 + inset, size - 6 - inset * 0.6);
    g.closePath();
  };
  g.lineJoin = 'round';
  tri(0); g.fillStyle = C.night; g.fill();
  tri(4); g.fillStyle = color; g.fill();
  tri(12); g.fillStyle = C.cream; g.fill();
  g.fillStyle = C.night; g.fillRect(size / 2 - 3, size * 0.36, 6, size * 0.26); g.fillRect(size / 2 - 3, size * 0.68, 6, 6);
  return g.getImageData(0, 0, size, size);
}

function carMarker() {
  const el = document.createElement('div');
  el.className = 'car-marker';
  el.innerHTML = `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
    <circle cx="24" cy="24" r="22" fill="rgba(255,168,46,.18)"/>
    <path d="M24 6 L37 38 L24 31 L11 38 Z" fill="${C.orange}" stroke="${C.night}" stroke-width="2.5" stroke-linejoin="round"/>
  </svg>`;
  return el;
}

/**
 * Crea el mapa dins `el`. Retorna { setRadars, update, resize, destroy, onError }.
 * update(pos, heading, kmh, nextId): centra el cotxe a la part baixa i gira el mapa segons el rumb.
 */
export async function createMap(el, { onError } = {}) {
  const map = new maplibregl.Map({
    container: el,
    style: await buildStyle(),
    center: [2.17, 41.39],
    zoom: 15,
    pitch: 50,
    bearing: 0,
    interactive: false,            // conduint: el mapa segueix el cotxe tot sol
    attributionControl: { compact: true },
    fadeDuration: 0,
  });
  let ready = false;
  let pending = null;
  let lastData = null;
  let incData = null;
  let nextFilter = '';

  const car = new maplibregl.Marker({ element: carMarker(), rotationAlignment: 'viewport', pitchAlignment: 'viewport' })
    .setLngLat([2.17, 41.39]);

  map.on('error', (e) => { if (onError) onError(e && e.error); });
  // Amb el padding, el centre de la càmera és just on és el cotxe.
  map.on('move', () => { if (ready) car.setLngLat(map.getCenter()); });

  map.on('load', () => {
    // L'estil fosc pinta les carreteres gairebé negres i conduint no es veuen: les aclarim
    // (gris per a carrers i carreteres, taronja apagat per a autopistes i autovies).
    const roads = {
      highway_path: '#2E323A',
      highway_minor: '#454B55',
      highway_major_casing: '#6B717C', highway_major_inner: '#555B66', highway_major_subtle: '#555B66',
      highway_motorway_casing: '#E0892A', highway_motorway_inner: '#8C5A1E', highway_motorway_subtle: '#8C5A1E',
    };
    for (const [id, color] of Object.entries(roads)) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', color);
    }
    map.addImage('radar', radarIcon(C.orange));
    map.addImage('radar-tram', radarIcon(C.orange, 64, true));
    map.addImage('radar-next', radarIcon(C.red, 80));
    map.addImage('radar-next-tram', radarIcon(C.red, 80, true));
    map.addSource('radars', { type: 'geojson', data: lastData || { type: 'FeatureCollection', features: [] } });
    const common = {
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-rotation-alignment': 'viewport',
      'icon-pitch-alignment': 'viewport',
    };
    map.addLayer({
      id: 'radars', type: 'symbol', source: 'radars',
      filter: ['!=', ['get', 'id'], nextFilter],
      layout: { ...common, 'icon-image': ['case', ['==', ['get', 't'], 'tram'], 'radar-tram', 'radar'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.45, 16, 0.7] },
    });
    map.addLayer({
      id: 'radar-next', type: 'symbol', source: 'radars',
      filter: ['==', ['get', 'id'], nextFilter],
      layout: { ...common, 'icon-image': ['case', ['==', ['get', 't'], 'tram'], 'radar-next-tram', 'radar-next'], 'icon-size': 0.85 },
    });
    // Incidències de trànsit: triangle (vermell per a accidents i talls, taronja per a la resta)
    map.addImage('inc', warnIcon(C.orange));
    map.addImage('inc-red', warnIcon(C.red));
    map.addSource('inc', { type: 'geojson', data: incData || { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'inc', type: 'symbol', source: 'inc',
      layout: {
        'icon-image': ['match', ['get', 'k'], ['accident', 'tall'], 'inc-red', 'inc'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 0.6],
        'icon-allow-overlap': true, 'icon-rotation-alignment': 'viewport', 'icon-pitch-alignment': 'viewport',
      },
    }, 'radars');
    car.addTo(map);
    ready = true;
    if (pending) { update(...pending); pending = null; }
  });

  function setRadars(list) {
    lastData = {
      type: 'FeatureCollection',
      features: list.map((r) => ({ type: 'Feature', properties: { id: r.id, t: r.t }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })),
    };
    if (ready) map.getSource('radars').setData(lastData);
  }

  let first = true;
  function update(pos, heading, kmh, nextId) {
    if (!ready) { pending = [pos, heading, kmh, nextId]; return; }
    const id = nextId || '';
    if (id !== nextFilter) {
      nextFilter = id;
      map.setFilter('radars', ['!=', ['get', 'id'], id]);
      map.setFilter('radar-next', ['==', ['get', 'id'], id]);
    }
    // La fletxa no salta a la posició nova: segueix el centre de la càmera mentre aquesta
    // s'hi desplaça (event 'move'), així llisca per la carretera com el cotxe.
    if (first) car.setLngLat([pos.lon, pos.lat]);
    const h = el.clientHeight || 600;
    const opts = {
      center: [pos.lon, pos.lat],
      zoom: zoomFor(kmh),
      // El cotxe a la part baixa de la pantalla: es veu més carretera al davant.
      padding: { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 },
    };
    if (heading != null) opts.bearing = heading;
    if (first) { map.jumpTo(opts); first = false; }
    else map.easeTo({ ...opts, duration: 950, easing: (t) => t });
  }

  function setIncidents(list) {
    incData = {
      type: 'FeatureCollection',
      features: list.map((i) => ({ type: 'Feature', properties: { k: i.kind }, geometry: { type: 'Point', coordinates: [i.lon, i.lat] } })),
    };
    if (ready) map.getSource('inc').setData(incData);
  }

  return {
    setRadars,
    setIncidents,
    update,
    resize: () => map.resize(),
    destroy: () => map.remove(),
  };
}
