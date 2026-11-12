'use strict';

/* =========================================================
   Lògica pura (sense DOM): es pot provar amb Node (test.mjs)
   ========================================================= */
const R_EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distance(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Punt a `dist` metres de `p` en direcció `brg` (per al mode demo).
function destination(p, brg, dist) {
  const δ = dist / R_EARTH, θ = toRad(brg), φ1 = toRad(p.lat), λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Radars al davant: dins de `maxDist`, dins del con de ±`cone` graus respecte al rumb
 * i, si el radar té sentit conegut (OSM), que aquest coincideixi amb el nostre (±60°).
 * Retorna [{radar, dist, brg}] ordenat per distància.
 */
function findAhead(pos, heading, radars, maxDist, cone = 30) {
  if (heading == null) return [];
  const dLat = maxDist / 111000;
  const dLon = maxDist / (111000 * Math.cos(toRad(pos.lat)) || 1);
  const out = [];
  for (const r of radars) {
    if (Math.abs(r.lat - pos.lat) > dLat || Math.abs(r.lon - pos.lon) > dLon) continue;
    const dist = distance(pos, r);
    if (dist > maxDist) continue;
    const brg = bearing(pos, r);
    // Molt a prop, l'angle és inestable: n'hi ha prou que no quedi clarament al darrere.
    const allowed = dist < 60 ? 75 : cone;
    if (angleDiff(brg, heading) > allowed) continue;
    if (r.d != null && angleDiff(r.d, heading) > 60) continue;
    out.push({ radar: r, dist, brg });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** Etapa d'avís segons la distància: 0 = cap, 1 = primer avís, 2 = avís proper. */
function alertStage(dist, first, second) {
  if (dist <= second) return 2;
  if (dist <= first) return 1;
  return 0;
}

/** Rumb: el del GPS si anem prou ràpid; si no, el calculat entre posicions. */
function pickHeading(coords, prevFix, lastHeading) {
  if (coords.heading != null && !Number.isNaN(coords.heading) && (coords.speed || 0) > 2) return coords.heading;
  if (prevFix && distance(prevFix, coords) >= 15) return bearing(prevFix, coords);
  return lastHeading;
}

function formatDist(m) {
  if (m >= 950) return `${(m / 1000).toFixed(1).replace('.', ',').replace(',0', '')} km`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

function speechDist(m) {
  if (m >= 950) {
    const km = Math.round(m / 100) / 10;
    return km === 1 ? '1 quilòmetre' : `${String(km).replace('.', ',')} quilòmetres`;
  }
  return `${Math.max(50, Math.round(m / 50) * 50)} metres`;
}

function alertText(radar, dist, speedKmh, overspeed = true) {
  const what = radar.t === 'tram' ? 'Tram de velocitat mitjana' : 'Radar';
  let s = `${what} a ${speechDist(dist)}`;
  if (radar.v) s += `. Límit ${radar.v}`;
  if (overspeed && radar.v && speedKmh > radar.v + 3) s += `. Vas massa ràpid`;
  return s + '.';
}

/* ---------- mode legal per país ----------
   França: és il·legal indicar la posició exacta dels radars (llei del 2023). Només s'avisa de
   "zona de control", un sol cop, a una distància que varia d'un radar a l'altre (entre 0,6 i 2 km),
   sense dir la distància ni mostrar-lo al mapa. Alemanya i Suïssa: no hi ha radars a les dades. */
const ZONE_COUNTRIES = new Set(['FR']);
const isZone = (r) => ZONE_COUNTRIES.has(r.c);
/** Distància de l'avís de zona: fixa per a cada radar (hash de l'id), entre 600 i 2000 m. */
function zoneDistance(r) {
  let h = 0;
  for (const ch of String(r.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 600 + (h % 1401);
}

/* ---------- velocitat mitjana als trams ---------- */
/** Trams amb els dos extrems coneguts (camp `g`): Map g → [a, b]. */
function tramGroups(list) {
  const m = new Map();
  for (const r of list) if (r.g && r.t === 'tram') { if (!m.has(r.g)) m.set(r.g, []); m.get(r.g).push(r); }
  for (const [g, pts] of m) if (pts.length !== 2) m.delete(g);
  return m;
}
const avgKmh = (metres, ms) => (ms > 0 ? (metres / (ms / 1000)) * 3.6 : 0);

/* ---------- versions ---------- */
/** 'v1.10' > 'v1.9' → 1; iguals → 0. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(Number), pb = String(b).replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ---------- incidències de trànsit (DATEX II de la DGT i del SCT) ---------- */
const INC_LABEL = { accident: 'Accident', retencio: 'Retenció', tall: 'Carretera o carril tallat', obres: 'Obres', obstacle: 'Obstacle a la via', meteo: 'Mal temps', altre: 'Incidència' };
function incidentKind(type, rec) {
  if (/accident/i.test(rec)) return 'accident';
  if (type === 'AbnormalTraffic' || /queuingTraffic|stationaryTraffic|congest|slowTraffic/i.test(rec)) return 'retencio';
  if (/roadClosed|carriagewayClosures|laneClosures|closedPermanentlyForTheWinter|roadBlocked/i.test(rec)) return /roadworks|roadMaintenance|maintenanceWorks/i.test(rec) ? 'obres' : 'tall';
  if (/roadworks|roadMaintenance|maintenanceWorks/i.test(rec)) return 'obres';
  if (type === 'PoorEnvironmentConditions' || /snow|ice|fog|flooding|wind/i.test(rec)) return 'meteo';
  if (type === 'GeneralObstruction' || type === 'VehicleObstruction' || /obstruction|animal|vehicleOnWrongCarriageway/i.test(rec)) return 'obstacle';
  return 'altre';
}
/** Llegeix un DATEX II (v1–v3) i retorna [{id, kind, lat, lon, road, end}] de les incidències vigents. */
function parseIncidents(xml, now = Date.now()) {
  const out = [];
  const re = /<(?:\w+:)?situationRecord\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?situationRecord>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1], rec = m[2];
    const type = ((attrs.match(/xsi:type="(?:\w+:)?(\w+)"/) || [])[1]) || '';
    if (/validityStatus>\s*suspended/i.test(rec)) continue;
    const endS = (rec.match(/<(?:\w+:)?overallEndTime>([^<]+)</) || [])[1];
    const end = endS ? Date.parse(endS) : null;
    if (end && end < now) continue;
    const c = rec.match(/<(?:\w+:)?latitude>([-\d.]+)<\/(?:\w+:)?latitude>\s*<(?:\w+:)?longitude>([-\d.]+)</);
    if (!c) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || `${c[1]},${c[2]}`;
    const road = (rec.match(/<(?:\w+:)?roadName>(?:\s*<[^>]+>)*\s*([^<\s][^<]*)</) || rec.match(/<(?:\w+:)?roadNumber>([^<]+)</) || [])[1] || '';
    out.push({ id: `inc-${id}`, kind: incidentKind(type, rec), lat: +c[1], lon: +c[2], road: road.trim(), end });
  }
  return out;
}
function incidentText(inc, dist) {
  return `${INC_LABEL[inc.kind] || 'Incidència'} a ${speechDist(dist)}${inc.road ? `, ${inc.road.replace(/-/g, ' ')}` : ''}.`;
}

/** Radars actius segons els ajustos: trams sí/no, radars d'OSM (Catalunya i País Basc) sí/no. */
function filterRadars(list, { trams = true, osm = true } = {}) {
  return list.filter((r) => (trams || r.t !== 'tram') && (osm || r.s !== 'osm'));
}

/** Distàncies acumulades d'un camí [{lat, lon}, …]. */
function pathLengths(path) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + distance(path[i - 1], path[i]));
  return acc;
}

/** Punt i rumb a `d` metres de l'inici del camí (per a la demo). */
function alongPath(path, acc, d) {
  const total = acc[acc.length - 1];
  d = Math.max(0, Math.min(total, d));
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const a = path[i - 1], b = path[i], seg = acc[i] - acc[i - 1] || 1;
  const t = (d - acc[i - 1]) / seg;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, brg: bearing(a, b), end: d >= total };
}

/** Retalla el camí perquè comenci `before` m abans del punt més proper a `target` i acabi `after` m després. */
function trimAround(path, target, before, after) {
  const acc = pathLengths(path);
  let best = 0, bd = Infinity;
  path.forEach((p, i) => { const d = distance(p, target); if (d < bd) { bd = d; best = i; } });
  const from = acc[best] - before, to = acc[best] + after;
  const out = path.filter((p, i) => acc[i] >= from && acc[i] <= to);
  return { path: out.length >= 2 ? out : path, gap: bd };
}

/** De dues còpies de radars.json, la més nova (camp `generated`). */
function newestData(...datas) {
  return datas.filter((d) => d && Array.isArray(d.radars) && d.radars.length)
    .sort((a, b) => String(b.generated || '').localeCompare(String(a.generated || '')))[0] || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { distance, bearing, angleDiff, destination, findAhead, alertStage, pickHeading, formatDist, speechDist, alertText, filterRadars, newestData, pathLengths, alongPath, trimAround,
    isZone, zoneDistance, tramGroups, avgKmh, compareVersions, parseIncidents, incidentKind, incidentText };
}

/* =========================================================
   App (navegador)
   ========================================================= */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (() => {
  const $ = (s) => document.querySelector(s);
  // sortida (només app Android): 'auto' | 'trucada' (Bluetooth com una trucada) | 'altaveu' | 'multimedia'
  const DEFAULTS = {
    first: 1000, second: 200, voice: true, beep: true, vibrate: true, wake: true, sortida: 'auto',
    trams: true, osm: true, overspeed: true,   // què avisa
    map: false, showSpeed: true,               // pantalla (el mapa gasta dades: desactivat per defecte)
    update: true,                              // baixar radars.json nou d'internet un cop al dia
    tramAvg: true,                             // velocitat mitjana als trams
    incidents: true, roadworks: false,         // incidències de trànsit (APK); obres: n'hi ha moltes, desactivades
  };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; } catch {}
  const saveSettings = () => { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {} };

  let allRadars = [];        // tots els de radars.json
  let radars = [];           // els actius segons els ajustos
  let mapView = null;        // mapa (només si està activat)
  let mapLoading = null;
  let running = false;
  let watchId = null;
  let demoTimer = null;
  let prevFix = null;        // última posició usada per calcular el rumb
  let heading = null;
  let lastFixAt = 0;
  const alerted = new Map(); // id → etapa ja avisada
  let wakeLock = null;
  let audioCtx = null;

  // ---------- app Android (Capacitor) ----------
  // Sense empaquetador, els connectors es creen amb registerPlugin (Capacitor.Plugins no s'omple).
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const P = isNative ? {
    geo: Cap.registerPlugin('BackgroundGeolocation'),
    tts: Cap.registerPlugin('TextToSpeech'),
    notif: Cap.registerPlugin('LocalNotifications'),
    awake: Cap.registerPlugin('KeepAwake'),
    veu: Cap.registerPlugin('VeuRadar'),   // connector propi (android/.../VeuRadarPlugin.java)
  } : null;
  const SORTIDES = { trucada: 'Bluetooth (com una trucada)', altaveu: 'altaveu del mòbil', multimedia: 'multimèdia' };
  let geoWatcherId = null;
  let notifId = 1;
  const appHidden = () => document.visibilityState !== 'visible';
  document.body.classList.toggle('native', isNative);

  async function nativeSetup() {
    try {
      const perm = await P.notif.checkPermissions();
      if (perm.display !== 'granted') await P.notif.requestPermissions();
      // Canal silenciós: el so i la vibració els fa VeuRadar (amb la sortida triada);
      // un so de notificació competiria amb la veu pel Bluetooth.
      await P.notif.createChannel({
        id: 'radar-avis', name: 'Avisos de radar', description: 'Text de l\'avís (el so el fa la veu)',
        importance: 2, visibility: 1, vibration: false,
      });
    } catch (e) { console.warn('Notificacions:', e); }
  }
  function nativeNotify(text, stage) {
    P.notif.schedule({ notifications: [{
      id: notifId++, title: stage === 2 ? 'Radar a prop!' : 'Radar al davant', body: text,
      channelId: 'radar-avis', smallIcon: 'ic_stat_radar', iconColor: '#FFA82E', autoCancel: true,
    }] }).catch((e) => console.warn(e));
  }
  /** Avís sonor a l'app Android: xiulets + veu pel camí triat (Bluetooth com a trucada, altaveu…). */
  async function nativeAlert(text, xiulets, vibra) {
    try {
      return await P.veu.avisa({
        text: settings.voice ? text : '', sortida: settings.sortida,
        xiulets: settings.beep ? xiulets : 0, vibra: vibra && settings.vibrate,
      });
    } catch (e) {
      // Si el connector propi falla (veu no preparada…), fem servir l'antic per no quedar mut.
      console.warn('VeuRadar:', e);
      if (settings.voice && text) P.tts.speak({ text, lang: 'ca-ES', rate: 1.0, volume: 1.0, queueStrategy: 0 }).catch(() => {});
      return null;
    }
  }

  // ---------- dades ----------
  // Còpia publicada a GitHub Pages: el workflow la regenera cada dia.
  const REMOTE_RADARS = 'https://xorigu3r.github.io/xoriguer-radars/radars.json';
  const DAY = 24 * 3600 * 1000;
  let currentData = null;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function useData(data, origen) {
    currentData = data;
    allRadars = data.radars || [];
    applyFilters();
    const d = data.generated ? new Date(data.generated) : null;
    $('#dataInfo').textContent = `${allRadars.length.toLocaleString('ca')} radars` +
      (d ? ` · dades del ${d.toLocaleDateString('ca')}` : '') +
      (data.sources ? ` (DGT ${data.sources.dgt}, OSM ${data.sources.osm})` : '');
    $('#updInfo').textContent = d ? `Radars del ${d.toLocaleDateString('ca')}${origen ? ` (${origen})` : ''}.` : '';
  }
  function applyFilters() {
    radars = filterRadars(allRadars, settings);
    groups = tramGroups(radars);
    alerted.clear();
    // Al mapa no es mostren els radars de França (la llei no ho permet).
    if (mapView) mapView.setRadars(radars.filter((r) => !isZone(r)));
  }

  async function loadRadars() {
    let bundled = null, cached = null;
    try { bundled = await (await fetch('radars.json', { cache: 'no-cache' })).json(); } catch {}
    try { cached = JSON.parse(lsGet('radarsCache') || 'null'); } catch {}
    const best = newestData(bundled, cached);
    if (best) useData(best, best === cached ? 'baixats d\'internet' : 'inclosos a l\'app');
    else $('#dataInfo').textContent = 'No s\'han pogut carregar els radars.';
    const last = +(lsGet('radarsChecked') || 0);
    if (settings.update && Date.now() - last > DAY) updateRadars(false);
  }

  /** Baixa radars.json d'internet; si és més nou, el desa i el fa servir. */
  async function updateRadars(manual) {
    // A la web publicada, radars.json ja és el d'internet.
    if (!isNative && location.origin === new URL(REMOTE_RADARS).origin) { if (manual) $('#updInfo').textContent = 'La web ja fa servir els radars més nous.'; return; }
    if (manual) $('#updInfo').textContent = 'Comprovant…';
    try {
      const res = await fetch(REMOTE_RADARS, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      lsSet('radarsChecked', String(Date.now()));
      const isNewer = !currentData || String(data.generated || '') > String(currentData.generated || '');
      if (isNewer && data.radars && data.radars.length > 100) {
        lsSet('radarsCache', JSON.stringify(data));
        useData(data, 'baixats d\'internet');
        if (manual) $('#updInfo').textContent += ' Actualitzats!';
      } else if (manual) {
        $('#updInfo').textContent = 'Ja tens els radars més nous.';
      }
    } catch (e) {
      if (manual) $('#updInfo').textContent = 'No s\'ha pogut connectar. Es fan servir els radars que ja tens.';
    }
  }

  // ---------- so, veu, vibració ----------
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep(times = 2) {
    if (!settings.beep || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 1320;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + i * 0.22 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.16);
    }
  }
  let caVoice = null;
  function pickVoice() {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    caVoice = vs.find((v) => /^ca/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function say(text, delay = settings.beep ? 450 : 0) {
    if (!settings.voice) return;
    if (isNative) { nativeAlert(text, 0, false); return; }
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ca-ES';
    if (caVoice) u.voice = caVoice;
    u.rate = 1.05;
    // Es diu una mica després del xiulet perquè no se solapin.
    setTimeout(() => speechSynthesis.speak(u), delay);
  }
  function vibrate(pattern) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(pattern); }

  // ---------- pantalla encesa ----------
  async function requestWake() {
    if (!running) return;
    if (isNative) {
      // A l'app no cal la pantalla encesa per rebre avisos; és només una preferència.
      (settings.wake ? P.awake.keepAwake() : P.awake.allowSleep()).catch(() => {});
      return;
    }
    if (!settings.wake || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWake() {
    if (isNative) { P.awake.allowSleep().catch(() => {}); return; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWake();
      // En tornar a l'app, el mapa salta a la posició actual (no s'ha mogut amb la pantalla apagada).
      if (mapView && lastPos) mapView.update(lastPos, heading, lastKmh, null);
    }
  });

  // ---------- GPS ----------
  function onPosition(p) {
    onFix({ lat: p.coords.latitude, lon: p.coords.longitude, heading: p.coords.heading, speed: p.coords.speed, accuracy: p.coords.accuracy });
  }
  function onFix(c) {
    lastFixAt = Date.now();
    if (c.accuracy != null && c.accuracy > 100) { setStatus(`GPS imprecís (±${Math.round(c.accuracy)} m)`); return; }
    const h = pickHeading(c, prevFix, heading);
    if (h !== heading || !prevFix || distance(prevFix, c) >= 15) prevFix = c;
    heading = h;
    const kmh = c.speed != null && c.speed >= 0 ? c.speed * 3.6 : null;
    update(c, kmh);
  }
  function onError(e) {
    const msg = { 1: 'Cal donar permís d\'ubicació al navegador.', 2: 'No es troba la posició.', 3: 'El GPS no respon.' }[e.code] || e.message;
    setStatus(msg, true);
  }

  // ---------- mapa (opcional) ----------
  async function setMap(on) {
    document.body.classList.toggle('map-on', on);
    $('#map').hidden = !on;
    if (!on) {
      if (mapView) { mapView.destroy(); mapView = null; }
      $('#mapMsg').hidden = true;
      return;
    }
    if (mapView || mapLoading) return;
    // La llibreria només es carrega si el mapa està activat.
    if (!document.querySelector('link[href="vendor/maplibre-gl.css"]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'vendor/maplibre-gl.css'; document.head.appendChild(l);
    }
    mapLoading = loadMapModule().then(async (m) => {
      if (!settings.map) return;
      let shown = false;
      mapView = await m.createMap($('#map'), {
        onError: () => {
          // Sense cobertura: les tessel·les no arriben, però els avisos continuen.
          if (shown) return; shown = true;
          const msg = $('#mapMsg');
          msg.textContent = 'Sense connexió: es veu el mapa desat al mòbil; les zones no descarregades surten buides. Els avisos funcionen igual.';
          msg.hidden = false; setTimeout(() => { msg.hidden = true; shown = false; }, 8000);
        },
      });
      mapView.setRadars(radars.filter((r) => !isZone(r)));
      mapView.setIncidents(incidents.filter((i) => settings.roadworks || i.kind !== 'obres'));
      if (lastPos) mapView.update(lastPos, heading, lastKmh, null);
    }).catch((e) => {
      console.warn('Mapa:', e);
      setStatus('No s\'ha pogut obrir el mapa.', true);
    }).finally(() => { mapLoading = null; });
  }
  let lastPos = null, lastKmh = null;
  window.addEventListener('resize', () => { if (mapView) mapView.resize(); });

  let mapModule = null;
  function loadMapModule() {
    if (!mapModule) {
      mapModule = import('./map.js').then(async (m) => {
        // Paquets de mapa instal·lats: es registren abans de dibuixar res.
        if (isNative) { try { await m.setPackages(installed()); } catch (e) { console.warn('Paquets:', e); } }
        return m;
      }).catch((e) => { mapModule = null; throw e; });
    }
    return mapModule;
  }

  // ---------- versió nova ----------
  // L'app no és a Google Play: un cop al dia mira a GitHub si hi ha una Release més nova (etiqueta vX.Y).
  const APP_VERSION = '1.3';
  const RELEASES = 'https://api.github.com/repos/Xorigu3r/xoriguer-radars/releases?per_page=15';
  async function checkNewVersion(manual = false) {
    if (!isNative && !manual) return;   // la web s'actualitza sola
    const last = +(lsGet('versionChecked') || 0);
    if (!manual && Date.now() - last < DAY) { showNewVersion(JSON.parse(lsGet('versionNew') || 'null')); return; }
    try {
      const rels = await (await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } })).json();
      lsSet('versionChecked', String(Date.now()));
      const rel = rels.filter((r) => /^v\d+(\.\d+)*$/.test(r.tag_name) && !r.draft && !r.prerelease)
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
      const apk = rel && rel.assets.find((a) => /\.apk$/i.test(a.name));
      const info = rel && apk && compareVersions(rel.tag_name, APP_VERSION) > 0 ? { tag: rel.tag_name, url: apk.browser_download_url } : null;
      lsSet('versionNew', JSON.stringify(info));
      showNewVersion(info);
      if (manual) $('#verInfo').textContent = info ? `Hi ha la versió ${info.tag}.` : `Tens la versió més nova (v${APP_VERSION}).`;
    } catch { if (manual) $('#verInfo').textContent = 'No s\'ha pogut comprovar (sense connexió?).'; }
  }
  function showNewVersion(info) {
    const b = $('#newVersion');
    if (!info) { b.hidden = true; return; }
    b.hidden = false;
    $('#newVersionText').textContent = `Hi ha una versió nova (${info.tag}).`;
    $('#newVersionLink').href = info.url;
  }

  // ---------- mapa sense connexió ----------
  let dlAbort = null;
  const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.', ',')} MB`;
  async function showSaved() {
    try {
      const m = await loadMapModule();
      const s = m.savedStats();
      $('#offInfo').textContent = s.tiles ? `Mapa desat al mòbil: ${mb(s.bytes)} (${s.tiles.toLocaleString('ca')} trossos).` : 'Encara no hi ha mapa desat.';
    } catch { $('#offInfo').textContent = ''; }
  }
  function currentPosition() {
    if (lastPos) return Promise.resolve(lastPos);
    return new Promise((ok, ko) => {
      if (!navigator.geolocation) { ko(new Error('sense GPS')); return; }
      navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), ko,
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
  }
  async function downloadMap() {
    const btn = $('#offBtn');
    if (dlAbort) { dlAbort.abort(); return; }   // segon toc: atura
    const radi = +$('#offRadius').value;
    const conn = navigator.connection && navigator.connection.type;
    if (conn === 'cellular' && !confirm('Sembla que estàs amb dades mòbils. Descarregar el mapa pot gastar desenes de MB. Vols continuar igualment?')) return;
    $('#offInfo').textContent = 'Buscant on ets…';
    let center;
    try { center = await currentPosition(); } catch { $('#offInfo').textContent = 'No es troba la posició. Activa la ubicació i torna-ho a provar.'; return; }
    const m = await loadMapModule();
    dlAbort = new AbortController();
    btn.textContent = 'Atura la descàrrega';
    try {
      const r = await m.downloadArea(center, radi, (p) => {
        $('#offInfo').textContent = `Descarregant ${Math.round((p.done / p.total) * 100)}% · ${mb(p.bytes)}…`;
      }, dlAbort.signal);
      const s = m.savedStats();
      $('#offInfo').textContent = r.aborted ? `Aturat. Mapa desat: ${mb(s.bytes)}.`
        : `Fet: ${radi} km al voltant d'on ets. Mapa desat: ${mb(s.bytes)}.` + (r.errors ? ` (${r.errors} trossos han fallat; torna-ho a provar)` : '');
    } catch (e) {
      $('#offInfo').textContent = 'No s\'ha pogut descarregar (sense connexió?).';
    } finally {
      dlAbort = null;
      btn.textContent = 'Descarrega el mapa de la zona';
    }
  }
  // ---------- paquets de mapa per regions (només app) ----------
  const MAPES_URL = 'https://xorigu3r.github.io/xoriguer-radars/mapes.json';
  const Mapes = isNative ? Cap.registerPlugin('Mapes') : null;
  let manifest = { paquets: [] };
  let pkgBusy = null;   // fitxer que s'està baixant
  const installed = () => { try { return JSON.parse(lsGet('mapesInstal') || '[]'); } catch { return []; } };
  const saveInstalled = (l) => lsSet('mapesInstal', JSON.stringify(l));
  async function applyPackages() {
    if (!mapModule) return;
    try { (await loadMapModule()).setPackages(installed()); } catch (e) { console.warn('Paquets:', e); }
  }
  async function loadManifest() {
    for (const url of [MAPES_URL, 'mapes.json']) {
      try { const m = await (await fetch(url, { cache: 'no-cache' })).json(); if (m.paquets && m.paquets.length) { manifest = m; break; } } catch {}
    }
    renderPackages();
  }
  function renderPackages() {
    const box = $('#pkgList');
    if (!box) return;
    const inst = new Map(installed().map((p) => [p.id, p]));
    if (!manifest.paquets.length) { box.innerHTML = ''; $('#pkgInfo').textContent = 'Els paquets encara no estan publicats. Torna-ho a mirar més endavant.'; return; }
    const byCountry = new Map();
    for (const p of manifest.paquets) { if (!byCountry.has(p.pais)) byCountry.set(p.pais, []); byCountry.get(p.pais).push(p); }
    // Botons de país sencer: un sol fitxer si n'hi ha (Espanya), o totes les regions (França, Itàlia…)
    const cbox = $('#pkgCountries');
    cbox.innerHTML = '';
    for (const [pais, list] of byCountry) {
      const whole = list.find((p) => p.sencer);
      const todo = countryTodo(pais);
      const bytes = todo.reduce((s, p) => s + p.bytes, 0);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = todo.length ? `${tot(pais).replace(/^t/, "T")} (${mb(bytes)})` : `${pais}: ja ${tot(pais).startsWith("tota") ? "la" : "el"} tens`;
      b.disabled = !todo.length || !!pkgBusy;
      b.title = whole ? 'Un sol fitxer' : `${todo.length} paquets un darrere l'altre`;
      b.onclick = () => downloadCountry(pais);
      cbox.appendChild(b);
    }
    box.innerHTML = '';
    for (const [pais, list] of byCountry) {
      const d = document.createElement('details');
      if (pais === 'Espanya') d.open = true;
      const total = list.reduce((s, p) => s + p.bytes, 0);
      d.innerHTML = `<summary>${pais} <small>(${list.length} paquets, ${mb(total)})</small></summary>`;
      const wholeInst = list.find((p) => p.sencer && inst.has(p.id));
      for (const p of list) {
        const i = inst.get(p.id);
        const nou = i && p.data > i.data;
        const covered = !i && wholeInst && !p.sencer && coveredBy(p, wholeInst);
        const row = document.createElement('div');
        row.className = 'pkg';
        row.innerHTML = `<span class="n">${p.nom}<small>${mb(p.bytes)}${i ? ` · descarregat (${i.data})${nou ? ' · hi ha versió nova' : ''}` : ''}${covered ? ' · inclòs al paquet sencer' : ''}</small></span>`;
        const btn = document.createElement('button');
        if (covered) { row.appendChild(btn); btn.textContent = 'Inclòs'; btn.disabled = true; d.appendChild(row); continue; }
        if (pkgBusy === `${p.id}.pmtiles`) { btn.textContent = 'Atura'; btn.onclick = () => Mapes.atura({ fitxer: pkgBusy }); }
        else if (!i || nou) { btn.textContent = nou ? 'Actualitza' : 'Descarrega'; btn.className = 'get'; btn.onclick = () => downloadPackage(p); }
        else { btn.textContent = 'Esborra'; btn.onclick = () => removePackage(p); }
        row.appendChild(btn);
        d.appendChild(row);
      }
      box.appendChild(d);
    }
  }
  if (Mapes) Mapes.addListener('progres', (e) => {
    $('#pkgInfo').textContent = `Descarregant ${e.fitxer.replace('.pmtiles', '')}: ${mb(e.bytes)}${e.total > 0 ? ` de ${mb(e.total)} (${Math.round((e.bytes / e.total) * 100)}%)` : ''}…`;
  });
  async function downloadPackage(p, quiet = false) {
    if (!Mapes || pkgBusy) return false;
    const conn = navigator.connection && navigator.connection.type;
    if (!quiet && conn === 'cellular' && !confirm(`Sembla que estàs amb dades mòbils i el paquet ocupa ${mb(p.bytes)}. Vols continuar igualment?`)) return false;
    try {
      const { lliure } = await Mapes.espai();
      if (lliure < p.bytes * 1.2) { alert(`No hi ha prou espai al mòbil (cal ${mb(p.bytes)}, n'hi ha ${mb(lliure)} de lliure).`); return false; }
    } catch {}
    pkgBusy = `${p.id}.pmtiles`;
    renderPackages();
    try {
      await Mapes.descarrega({ url: p.url, fitxer: pkgBusy, versio: p.data });
      saveInstalled([...installed().filter((x) => x.id !== p.id), { id: p.id, fitxer: pkgBusy, bounds: p.bounds, bytes: p.bytes, data: p.data }]);
      $('#pkgInfo').textContent = `${p.nom}: descarregat.`;
      applyPackages();
      return true;
    } catch (e) {
      $('#pkgInfo').textContent = /aturat/.test(e.message || e) ? 'Descàrrega aturada.' : `No s'ha pogut descarregar ${p.nom} (sense connexió?).`;
      return false;
    } finally {
      pkgBusy = null;
      renderPackages();
    }
  }
  async function removePackage(p) {
    if (!confirm(`Vols esborrar el mapa de ${p.nom}?`)) return;
    try { await Mapes.esborra({ fitxer: `${p.id}.pmtiles` }); } catch {}
    saveInstalled(installed().filter((x) => x.id !== p.id));
    applyPackages();
    renderPackages();
  }
  // «Tota Espanya» però «Tot Portugal»
  const tot = (pais) => (/^(Espanya|França|Itàlia|Andorra)$/.test(pais) ? 'tota' : 'tot') + ' ' + pais;
  /** Una regió és dins del paquet sencer si el seu centre hi cau (les Canàries, per exemple, no). */
  function coveredBy(p, whole) {
    const [w, s, e, n] = whole.bounds, cx = (p.bounds[0] + p.bounds[2]) / 2, cy = (p.bounds[1] + p.bounds[3]) / 2;
    return cx >= w && cx <= e && cy >= s && cy <= n;
  }
  /** Què cal baixar per tenir un país sencer: el paquet sencer (si n'hi ha) + el que no hi càpiga; si no, totes les regions. */
  function countryTodo(pais) {
    const inst = new Map(installed().map((p) => [p.id, p]));
    const list = manifest.paquets.filter((p) => p.pais === pais);
    const whole = list.find((p) => p.sencer);
    const want = whole ? [whole, ...list.filter((p) => !p.sencer && !coveredBy(p, whole))] : list;
    return want.filter((p) => !inst.has(p.id) || p.data > inst.get(p.id).data);
  }
  async function downloadCountry(pais) {
    const todo = countryTodo(pais);
    if (!todo.length) { $("#pkgInfo").textContent = `Ja tens ${tot(pais)}.`; return; }
    const total = todo.reduce((s, p) => s + p.bytes, 0);
    const desc = todo.length === 1 ? `un fitxer de ${mb(total)}` : `${todo.length} paquets (${mb(total)} en total)`;
    if (!confirm(`Descarregar el mapa de ${tot(pais)}: ${desc}?\n\nFes-ho amb WiFi i el mòbil carregant: pot trigar una bona estona. Si es talla, en tornar-ho a provar continua des d'on era.`)) return;
    for (const p of todo) { if (!(await downloadPackage(p, true))) break; }
  }

  // ---------- mapa d'una ruta ----------
  async function downloadRoute() {
    const to = $('#routeTo').value.trim();
    if (!to) { $('#routeInfo').textContent = 'Escriu on vas.'; return; }
    if (dlAbort) { dlAbort.abort(); return; }
    $('#routeInfo').textContent = 'Buscant on ets…';
    let from;
    try { from = await currentPosition(); } catch { $('#routeInfo').textContent = 'No es troba la posició. Activa la ubicació.'; return; }
    try {
      $('#routeInfo').textContent = `Buscant «${to}»…`;
      const g = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ca&countrycodes=es,ad,fr,pt,it&q=${encodeURIComponent(to)}`)).json();
      if (!g.length) { $('#routeInfo').textContent = `No trobo «${to}».`; return; }
      const dest = { lat: +g[0].lat, lon: +g[0].lon };
      $('#routeInfo').textContent = 'Calculant la ruta…';
      const j = await (await fetch(`${OSRM}${from.lon.toFixed(5)},${from.lat.toFixed(5)};${dest.lon.toFixed(5)},${dest.lat.toFixed(5)}?overview=full&geometries=geojson`)).json();
      if (j.code !== 'Ok') throw new Error('sense ruta');
      const path = j.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
      const km = Math.round(j.routes[0].distance / 1000);
      const m = await loadMapModule();
      const tiles = m.tilesAlongPath(path, 3);
      const nom = g[0].display_name.split(',')[0];
      // Mida per tros mesurada: ~15 kB al camp, ~120 kB al centre d'una ciutat.
      const lo = Math.max(1, Math.round((tiles.length * 15) / 1024)), hi = Math.max(2, Math.round((tiles.length * 120) / 1024));
      if (!confirm(`Ruta fins a ${nom}: ${km} km. Es descarregaran ${tiles.length.toLocaleString('ca')} trossos de mapa: entre ${lo} i ${hi} MB (més si passa per ciutats grans). Continuar?`)) { $('#routeInfo').textContent = ''; return; }
      dlAbort = new AbortController();
      $('#routeBtn').textContent = 'Atura la descàrrega';
      const r = await m.downloadTiles(tiles, (p) => {
        $('#routeInfo').textContent = `Ruta fins a ${nom}: ${Math.round((p.done / p.total) * 100)}% · ${mb(p.bytes)}…`;
      }, dlAbort.signal);
      $('#routeInfo').textContent = r.aborted ? 'Aturat.' : `Fet: mapa de la ruta fins a ${nom} (${km} km) desat.` + (r.errors ? ` ${r.errors} trossos han fallat.` : '');
      showSaved();
    } catch (e) {
      $('#routeInfo').textContent = 'No s\'ha pogut calcular o descarregar la ruta (sense connexió?).';
    } finally {
      dlAbort = null;
      $('#routeBtn').textContent = 'Descarrega el mapa de la ruta';
    }
  }

  async function clearMap() {
    if (!confirm('Vols esborrar el mapa desat al mòbil? Es tornarà a baixar d\'internet quan el facis servir.')) return;
    const m = await loadMapModule();
    await m.clearSaved();
    showSaved();
  }

  function update(pos, kmh) {
    lastPos = pos; lastKmh = kmh;
    $('#speed').textContent = kmh == null ? '–' : Math.round(kmh);
    $('#heading').textContent = heading == null ? 'esperant rumb…' : `rumb ${Math.round(heading)}°`;
    setStatus(heading == null ? 'Comença a moure\'t per saber cap on vas' : 'Vigilant');

    const look = Math.max(settings.first, 2500);
    const ahead = findAhead(pos, heading, radars, look);
    const next = ahead[0];

    // Oblida els radars que fa 20 s que no tenim al davant (els hem passat o hem canviat de via).
    // El marge evita repetir l'avís si el rumb del GPS balla un moment.
    const now = Date.now();
    for (const a of ahead) { const e = alerted.get(a.radar.id); if (e) e.seen = now; }
    for (const [id, e] of alerted) if (now - e.seen > 20000) alerted.delete(id);

    if (next) {
      // França (mode zona): un sol avís, a una distància pròpia de cada radar, sense dir-la.
      const zone = isZone(next.radar);
      const stage = zone ? (next.dist <= zoneDistance(next.radar) ? 1 : 0) : alertStage(next.dist, settings.first, settings.second);
      const done = alerted.get(next.radar.id)?.stage || 0;
      if (stage > done) {
        alerted.set(next.radar.id, { stage, seen: now });
        fireAlert(next, stage, kmh);
      }
    }
    showNext(next, kmh);
    trackTram(pos, kmh, now);
    checkIncidents(pos, now);
    // El mapa només es mou si es veu (amb la pantalla apagada no cal gastar bateria).
    if (mapView && !appHidden()) mapView.update(pos, heading, kmh, next && !isZone(next.radar) && next.dist <= settings.first ? next.radar.id : null);
  }

  // ---------- velocitat mitjana als trams ----------
  // En passar per un extrem d'un tram (amb l'altre extrem al davant), es mesura la distància
  // recorreguda i el temps; si la mitjana passa del límit, s'avisa.
  let groups = new Map();      // g → [a, b]
  let tram = null;             // { g, end, v, t0, dist, last, warnedAt, minEndDist }
  function trackTram(pos, kmh, now) {
    if (!settings.tramAvg) { tram = null; return; }
    if (!tram && heading != null) {
      for (const [g, [a, b]] of groups) {
        if (Math.abs(a.lat - pos.lat) > 0.01 && Math.abs(b.lat - pos.lat) > 0.01) continue;
        for (const [start, end] of [[a, b], [b, a]]) {
          if (distance(pos, start) < 80 && angleDiff(bearing(pos, end), heading) < 60) {
            const v = start.v || end.v || null;
            tram = { g, end, v, t0: now, dist: 0, last: pos, warnedAt: 0, minEndDist: distance(pos, end), road: start.r };
            if (settings.voice) say(v ? `Inici del tram. Mitjana màxima ${v}.` : 'Inici del tram de velocitat mitjana.');
            break;
          }
        }
        if (tram) break;
      }
      return;
    }
    if (!tram) return;
    tram.dist += distance(tram.last, pos);
    tram.last = pos;
    const avg = avgKmh(tram.dist, now - tram.t0);
    const toEnd = distance(pos, tram.end);
    tram.minEndDist = Math.min(tram.minEndDist, toEnd);
    $('#tramBox').hidden = false;
    $('#tramAvg').textContent = Math.round(avg);
    $('#tramLimit').textContent = tram.v ? ` / ${tram.v}` : '';
    $('#tramBox').classList.toggle('over', !!(tram.v && avg > tram.v));
    // Avís si la mitjana és alta (després de 400 m perquè no surti per un cop d'accelerador a l'inici).
    if (tram.v && tram.dist > 400 && avg > tram.v + 1 && now - tram.warnedAt > 60000) {
      tram.warnedAt = now;
      const t = `Mitjana ${Math.round(avg)}. Abaixa la velocitat.`;
      if (isNative) nativeAlert(t, 1, true); else { beep(1); say(t); }
    }
    // Final: hem arribat a l'altre extrem i ens n'allunyem, o ja hem fet massa camí.
    const passed = tram.minEndDist < 120 && toEnd > tram.minEndDist + 60;
    if (passed || tram.dist > 40000 || now - tram.t0 > 3600000) {
      if (settings.voice && passed) say(`Fi del tram. Mitjana ${Math.round(avg)}.`);
      tram = null;
      $('#tramBox').hidden = true;
    }
  }

  // ---------- incidències de trànsit ----------
  let incidents = [];
  const incAlerted = new Map();
  function checkIncidents(pos, now) {
    if (!settings.incidents || !incidents.length || heading == null) { $('#incBox').hidden = true; return; }
    const list = incidents.filter((i) => settings.roadworks || i.kind !== 'obres');
    const ahead = findAhead(pos, heading, list, Math.max(settings.first, 2000), 25);
    for (const [id, t] of incAlerted) if (now - t > 30 * 60000) incAlerted.delete(id);
    const n = ahead[0];
    if (!n) { $('#incBox').hidden = true; return; }
    $('#incBox').hidden = false;
    $('#incText').textContent = `${INC_LABEL[n.radar.kind]} a ${formatDist(n.dist)}${n.radar.road ? ` · ${n.radar.road}` : ''}`;
    $('#incBox').dataset.kind = n.radar.kind;
    if (n.dist <= Math.max(settings.first, 1000) && !incAlerted.has(n.radar.id)) {
      incAlerted.set(n.radar.id, now);
      const t = incidentText(n.radar, n.dist);
      if (isNative) { if (appHidden()) nativeNotify(t, 1); nativeAlert(t, 1, true); } else { beep(1); say(t); }
    }
  }
  const INC_URLS = [
    'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml',
    'https://infocar.dgt.es/datex2/sct/SituationPublication/all/content.xml',   // Catalunya (SCT)
  ];
  let incTimer = null, incLoadedAt = 0;
  async function loadIncidents() {
    // La DGT no deixa llegir-les des d'una web (CORS): només a l'app, amb la petició nativa de Capacitor.
    if (!isNative || !settings.incidents) return;
    const http = Cap.registerPlugin('CapacitorHttp');
    const all = [];
    for (const url of INC_URLS) {
      try {
        const r = await http.get({ url, responseType: 'text', connectTimeout: 15000, readTimeout: 30000 });
        if (r.status === 200 && typeof r.data === 'string') all.push(...parseIncidents(r.data));
      } catch (e) { console.warn('Incidències', url, e); }
    }
    if (all.length) { incidents = all; incLoadedAt = Date.now(); }
    $('#incInfo').textContent = incLoadedAt ? `${incidents.length.toLocaleString('ca')} incidències carregades a les ${new Date(incLoadedAt).toLocaleTimeString('ca', { hour: '2-digit', minute: '2-digit' })}.` : 'No s\'han pogut carregar les incidències.';
    if (mapView) mapView.setIncidents(incidents.filter((i) => settings.roadworks || i.kind !== 'obres'));
  }
  function startIncidents() {
    clearInterval(incTimer);
    if (!isNative || !settings.incidents) return;
    loadIncidents();
    incTimer = setInterval(loadIncidents, 5 * 60000);   // cada 5 minuts mentre l'avisador va
  }

  function fireAlert(a, stage, kmh) {
    const text = isZone(a.radar) ? 'Zona de control de velocitat. Respecta els límits.'
      : alertText(a.radar, a.dist, kmh || 0, settings.overspeed);
    if (isNative) {
      // App Android: tot el so (xiulets + veu) el fa VeuRadar, visible o amb la pantalla apagada.
      // Sense setTimeout: amb la pantalla apagada el WebView pot endarrerir molt els temporitzadors.
      if (appHidden()) nativeNotify(text, stage);
      nativeAlert(text, stage === 2 ? 3 : 2, true);
      if (!appHidden()) { const el = $('#alert'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
      return;
    }
    beep(stage === 2 ? 3 : 2);
    vibrate(stage === 2 ? [300, 120, 300, 120, 300] : [250, 120, 250]);
    say(text);
    const el = $('#alert');
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function showNext(a, kmh) {
    const box = $('#alert');
    const zone = a && isZone(a.radar);
    // França: zona de control, sense distància ni posició (la llei no ho permet).
    if (zone && a.dist <= zoneDistance(a.radar) + 300) {
      box.className = 'alert warn';
      $('#alertTitle').textContent = 'Zona de control de velocitat';
      $('#alertDist').textContent = '';
      $('#alertInfo').textContent = 'França: la llei no permet indicar on és el radar';
      $('#limit').hidden = true;
      return;
    }
    if (!a || zone || a.dist > settings.first) {
      box.className = 'alert idle';
      $('#alertTitle').textContent = 'Cap radar al davant';
      $('#alertDist').textContent = '';
      $('#alertInfo').textContent = a && !zone ? `Següent a ${formatDist(a.dist)}` : '';
      $('#limit').hidden = true;
      return;
    }
    const r = a.radar;
    box.className = 'alert ' + (a.dist <= settings.second ? 'near' : 'warn');
    $('#alertTitle').textContent = r.t === 'tram' ? 'Tram de velocitat mitjana' : 'Radar fix';
    $('#alertDist').textContent = formatDist(a.dist);
    const bits = [];
    if (r.r) bits.push(r.r);
    if (r.pk != null) bits.push(`PK ${String(r.pk).replace('.', ',')}`);
    if (r.to) bits.push(`sentit ${r.to.charAt(0) + r.to.slice(1).toLowerCase()}`);
    bits.push({ dgt: 'DGT', sct: 'SCT', fr: 'França', osm: 'OSM' }[r.s] || r.s);
    $('#alertInfo').textContent = bits.join(' · ');
    const lim = $('#limit');
    lim.hidden = !r.v;
    if (r.v) { lim.textContent = r.v; lim.classList.toggle('over', kmh != null && kmh > r.v + 3); }
  }

  function setStatus(t, err = false) {
    const s = $('#status');
    s.textContent = t;
    s.classList.toggle('err', err);
  }

  // ---------- engegar / aturar ----------
  async function startNative() {
    await nativeSetup();
    setStatus('Buscant GPS…');
    try {
      geoWatcherId = await P.geo.addWatcher({
        backgroundTitle: 'Xoriguer Radars està vigilant',
        backgroundMessage: 'Avisa dels radars que tens al davant, també amb la pantalla apagada.',
        requestPermissions: true, stale: false, distanceFilter: 5,
      }, (loc, err) => {
        if (err) {
          if (err.code === 'NOT_AUTHORIZED') {
            stop();
            setStatus('Cal permís d\'ubicació («Permet sempre»).', true);
            if (confirm('Xoriguer Radars necessita la ubicació. Vols obrir els permisos de l\'app?')) P.geo.openSettings();
          } else setStatus(err.message || 'Error de GPS', true);
          return;
        }
        if (loc) onFix({ lat: loc.latitude, lon: loc.longitude, heading: loc.bearing, speed: loc.speed, accuracy: loc.accuracy });
      });
    } catch (e) { setStatus('No s\'ha pogut engegar el GPS: ' + (e.message || e), true); }
  }

  function start(demo = false) {
    if (running) stop();
    ensureAudio();
    if (isNative && settings.voice && !demo) say('Avisador engegat', 0);
    if (isNative && settings.voice && demo) say('Mode demostració', 0);
    // Desbloqueja la veu del navegador: cal una primera locució dins d'un gest de l'usuari.
    if (!isNative && window.speechSynthesis && settings.voice) {
      const u = new SpeechSynthesisUtterance(demo ? 'Mode demostració' : 'Avisador engegat');
      u.lang = 'ca-ES'; if (caVoice) u.voice = caVoice;
      speechSynthesis.speak(u);
    }
    running = true; heading = null; prevFix = null; alerted.clear(); tram = null;
    document.body.classList.add('running');
    $('#startBtn').textContent = 'Atura';
    requestWake();
    startIncidents();
    if (demo) return startDemo();
    if (isNative) { startNative(); return; }
    if (!('geolocation' in navigator)) { setStatus('Aquest navegador no té GPS.', true); return; }
    setStatus('Buscant GPS…');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function stop() {
    running = false;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (geoWatcherId != null) { P.geo.removeWatcher({ id: geoWatcherId }).catch(() => {}); geoWatcherId = null; }
    clearInterval(demoTimer); demoTimer = null;
    clearInterval(incTimer); incTimer = null;
    tram = null; $('#tramBox').hidden = true; $('#incBox').hidden = true;
    releaseWake();
    document.body.classList.remove('running');
    $('#startBtn').textContent = 'Engega';
    setStatus('Aturat');
    showNext(null, null);
    $('#speed').textContent = '–';
    $('#heading').textContent = '';
  }

  // Demo: condueix a 108 km/h per una carretera de veritat que passa per un radar.
  // La ruta la calcula OSRM (servei públic sobre OpenStreetMap). Sense connexió, línia recta.
  const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  async function demoRoute(target, brg) {
    const a = destination(target, (brg + 180) % 360, 4000), b = destination(target, brg, 3000);
    const pts = [a, target, b].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const res = await fetch(`${OSRM}${pts}?overview=full&geometries=geojson&continue_straight=true`, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.code || 'sense ruta');
    const path = j.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
    const t = trimAround(path, target, 2500, 800);
    if (t.gap > 80) throw new Error('el radar no és a la ruta');
    return t.path;
  }
  async function startDemo() {
    const pool = radars.filter((r) => r.t === 'fix' && (r.s === 'dgt' || r.d != null));
    if (!pool.length) { setStatus('No hi ha radars carregats.', true); return; }
    setStatus('Demo: calculant una ruta per carretera…');
    let path = null;
    for (let i = 0; i < 4 && !path && running; i++) {
      const target = pool[Math.floor(Math.random() * pool.length)];
      // Si el radar té sentit conegut (OSM), hi anem en aquest sentit.
      const brg = target.d != null ? target.d : Math.random() * 360;
      try { path = await demoRoute(target, brg); } catch (e) { console.warn('Demo:', e.message); }
      if (!path && i === 3) {
        // Sense connexió: com abans, en línia recta.
        path = [destination(target, (brg + 180) % 360, 2500), destination(target, brg, 800)];
        setStatus('Demo sense connexió: en línia recta (no segueix la carretera).');
      }
    }
    if (!running || !path) return;
    if (!/recta/.test($('#status').textContent)) setStatus('Demo');
    const acc = pathLengths(path);
    const speed = 30; // m/s = 108 km/h
    let d = 0;
    demoTimer = setInterval(() => {
      d += speed;
      const p = alongPath(path, acc, d);
      // El rumb es calcula una mica endavant perquè no tremoli a les corbes.
      const ahead = alongPath(path, acc, d + 25);
      const brg = distance(p, ahead) > 3 ? bearing(p, ahead) : p.brg;
      onPosition({ coords: { latitude: p.lat, longitude: p.lon, heading: brg, speed, accuracy: 5 } });
      if (p.end) stop();
    }, 1000);
  }

  // Avisa si el GPS deixa de donar posicions.
  setInterval(() => {
    if (running && (watchId != null || geoWatcherId != null) && lastFixAt && Date.now() - lastFixAt > 15000) setStatus('Sense senyal de GPS', true);
  }, 5000);

  // ---------- ajustos ----------
  function bindSettings() {
    const slider = (id, key) => {
      const el = $(`#${id}`), out = $(`#${id}Out`);
      el.value = settings[key]; out.textContent = formatDist(settings[key]);
      el.oninput = () => { settings[key] = +el.value; out.textContent = formatDist(settings[key]); saveSettings(); };
    };
    slider('optDist', 'first');
    slider('optDist2', 'second');
    // Interruptors: id de l'element → clau de l'ajust
    const checks = { voice: 'voice', beep: 'beep', vibrate: 'vibrate', wake: 'wake', trams: 'trams', osm: 'osm',
      overspeed: 'overspeed', map: 'map', speed: 'showSpeed', update: 'update',
      tramavg: 'tramAvg', incidents: 'incidents', roadworks: 'roadworks' };
    for (const [id, k] of Object.entries(checks)) {
      const el = $(`#opt-${id}`);
      el.checked = settings[k];
      el.onchange = () => {
        if (k === 'map' && el.checked && !confirm(
          'El mapa fa servir dades mòbils:\n• per autopista, uns 5–6 MB per hora\n• dins d\'una ciutat gran, fins a 1,5 MB per quilòmetre el primer cop\n\nEls trajectes repetits gasten molt menys. També gasta més bateria, perquè vol la pantalla encesa.\n\nEls avisos funcionen igual sense mapa. Vols activar-lo?')) {
          el.checked = false; return;
        }
        settings[k] = el.checked; saveSettings();
        if (k === 'wake') requestWake();
        if (k === 'trams' || k === 'osm') applyFilters();
        if (k === 'incidents') { if (running) startIncidents(); else if (!settings.incidents) { incidents = []; if (mapView) mapView.setIncidents([]); } }
        if (k === 'roadworks' && mapView) mapView.setIncidents(incidents.filter((i) => settings.roadworks || i.kind !== 'obres'));
        if (k === 'map') setMap(settings.map);
        if (k === 'showSpeed') document.body.classList.toggle('no-speed', !settings.showSpeed);
        if (k === 'update' && settings.update) updateRadars(true);
      };
    }
    $('#updBtn').onclick = () => updateRadars(true);
    $('#verBtn').onclick = () => checkNewVersion(true);
    $('#verInfo').textContent = `Versió instal·lada: v${APP_VERSION}.`;
    $('#offBtn').onclick = downloadMap;
    $('#routeBtn').onclick = downloadRoute;
    $('#settingsBtn').addEventListener('click', () => { if (isNative) loadManifest(); });
    $('#offClear').onclick = clearMap;
    $('#settingsBtn').addEventListener('click', showSaved);
    const out = $('#optOut');
    out.value = settings.sortida;
    out.onchange = () => { settings.sortida = out.value; saveSettings(); };
    $('#testBtn').onclick = async () => {
      const text = alertText({ t: 'fix', v: 100 }, 1000, 0);
      if (isNative) {
        const r = await nativeAlert(text, 2, true);
        $('#outInfo').textContent = r ? `Ha sonat per: ${SORTIDES[r.sortida] || r.sortida}` +
          (r.idioma && r.idioma !== 'ca' ? ' · el mòbil no té veu catalana (instal·la-la als ajustos de Text a veu)' : '')
          : 'No s\'ha pogut fer servir la veu nova; ha sonat per la de sempre.';
        return;
      }
      ensureAudio(); beep(2); vibrate([250, 120, 250]);
      say(text);
    };
    // En obrir els ajustos, diu si hi ha Bluetooth connectat (només app Android).
    $('#settingsBtn').addEventListener('click', async () => {
      if (!isNative) return;
      try {
        const e = await P.veu.estat();
        $('#outInfo').textContent = e.bluetooth ? 'Bluetooth de veu connectat (cotxe o auriculars).' : 'Cap Bluetooth de veu connectat.';
      } catch { $('#outInfo').textContent = ''; }
    });
    $('#demoBtn').onclick = () => { $('#settings').close(); start(true); };
  }

  $('#startBtn').onclick = () => (running ? stop() : start());
  $('#settingsBtn').onclick = () => $('#settings').showModal();
  $('#closeSettings').onclick = () => $('#settings').close();
  bindSettings();
  document.body.classList.toggle('no-speed', !settings.showSpeed);
  loadRadars().then(() => { if (settings.map) setMap(true); });
  checkNewVersion();
  showNext(null, null);

  if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
