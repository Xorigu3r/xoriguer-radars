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

function alertText(radar, dist, speedKmh) {
  const what = radar.t === 'tram' ? 'Tram de velocitat mitjana' : 'Radar';
  let s = `${what} a ${speechDist(dist)}`;
  if (radar.v) s += `. Límit ${radar.v}`;
  if (radar.v && speedKmh > radar.v + 3) s += `. Vas massa ràpid`;
  return s + '.';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { distance, bearing, angleDiff, destination, findAhead, alertStage, pickHeading, formatDist, speechDist, alertText };
}

/* =========================================================
   App (navegador)
   ========================================================= */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (() => {
  const $ = (s) => document.querySelector(s);
  const DEFAULTS = { first: 1000, second: 200, voice: true, beep: true, vibrate: true, wake: true };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; } catch {}
  const saveSettings = () => { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {} };

  let radars = [];
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
  } : null;
  let geoWatcherId = null;
  let notifId = 1;
  const appHidden = () => document.visibilityState !== 'visible';
  document.body.classList.toggle('native', isNative);

  async function nativeSetup() {
    try {
      const perm = await P.notif.checkPermissions();
      if (perm.display !== 'granted') await P.notif.requestPermissions();
      await P.notif.createChannel({
        id: 'radar', name: 'Avisos de radar', description: 'Avís quan hi ha un radar al davant',
        importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#FFA82E',
      });
    } catch (e) { console.warn('Notificacions:', e); }
  }
  function nativeNotify(text, stage) {
    P.notif.schedule({ notifications: [{
      id: notifId++, title: stage === 2 ? 'Radar a prop!' : 'Radar al davant', body: text,
      channelId: 'radar', smallIcon: 'ic_stat_radar', iconColor: '#FFA82E', autoCancel: true,
    }] }).catch((e) => console.warn(e));
  }

  // ---------- dades ----------
  async function loadRadars() {
    try {
      const res = await fetch('radars.json', { cache: 'no-cache' });
      const data = await res.json();
      radars = data.radars || [];
      const d = data.generated ? new Date(data.generated) : null;
      $('#dataInfo').textContent = `${radars.length.toLocaleString('ca')} radars` +
        (d ? ` · dades del ${d.toLocaleDateString('ca')}` : '') +
        (data.sources ? ` (DGT ${data.sources.dgt}, OSM ${data.sources.osm})` : '');
    } catch (e) {
      $('#dataInfo').textContent = 'No s\'han pogut carregar els radars.';
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
    if (isNative) {
      // Veu nativa d'Android: funciona també amb la pantalla apagada.
      const opts = { text, lang: 'ca-ES', rate: 1.0, volume: 1.0, category: 'playback', queueStrategy: 0 };
      const go = () => P.tts.speak(opts).catch(() => P.tts.speak({ ...opts, lang: 'es-ES' }).catch(() => {}));
      delay ? setTimeout(go, delay) : go();
      return;
    }
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
    if (document.visibilityState === 'visible') requestWake();
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

  function update(pos, kmh) {
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
      const stage = alertStage(next.dist, settings.first, settings.second);
      const done = alerted.get(next.radar.id)?.stage || 0;
      if (stage > done) {
        alerted.set(next.radar.id, { stage, seen: now });
        fireAlert(next, stage, kmh);
      }
    }
    showNext(next, kmh);
  }

  function fireAlert(a, stage, kmh) {
    const text = alertText(a.radar, a.dist, kmh || 0);
    if (isNative && appHidden()) {
      // App en segon pla o pantalla apagada: notificació (so + vibració del canal) i veu nativa.
      // Sense setTimeout: amb la pantalla apagada el WebView pot endarrerir molt els temporitzadors.
      nativeNotify(text, stage);
      say(text, 0);
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
    if (!a || a.dist > settings.first) {
      box.className = 'alert idle';
      $('#alertTitle').textContent = 'Cap radar al davant';
      $('#alertDist').textContent = '';
      $('#alertInfo').textContent = a ? `Següent a ${formatDist(a.dist)}` : '';
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
    bits.push(r.s === 'dgt' ? 'DGT' : 'OSM');
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
    running = true; heading = null; prevFix = null; alerted.clear();
    document.body.classList.add('running');
    $('#startBtn').textContent = 'Atura';
    requestWake();
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
    releaseWake();
    document.body.classList.remove('running');
    $('#startBtn').textContent = 'Engega';
    setStatus('Aturat');
    showNext(null, null);
    $('#speed').textContent = '–';
    $('#heading').textContent = '';
  }

  // Demo: condueix a 108 km/h cap a un radar de la DGT, començant 2,5 km abans.
  function startDemo() {
    const pool = radars.filter((r) => r.s === 'dgt' && r.t === 'fix');
    if (!pool.length) { setStatus('No hi ha radars carregats.', true); return; }
    const target = pool[Math.floor(Math.random() * pool.length)];
    const brg = Math.random() * 360;
    let pos = destination(target, (brg + 180) % 360, 2500);
    const speed = 30; // m/s = 108 km/h
    setStatus('Demo');
    demoTimer = setInterval(() => {
      pos = destination(pos, brg, speed);
      onPosition({ coords: { latitude: pos.lat, longitude: pos.lon, heading: brg, speed, accuracy: 5 } });
      if (distance(pos, target) > 3000) stop();
    }, 1000);
  }

  // Avisa si el GPS deixa de donar posicions.
  setInterval(() => {
    if (running && (watchId != null || geoWatcherId != null) && lastFixAt && Date.now() - lastFixAt > 15000) setStatus('Sense senyal de GPS', true);
  }, 5000);

  // ---------- ajustos ----------
  function bindSettings() {
    const dist = $('#optDist'), distOut = $('#optDistOut');
    dist.value = settings.first; distOut.textContent = formatDist(settings.first);
    dist.oninput = () => { settings.first = +dist.value; distOut.textContent = formatDist(settings.first); saveSettings(); };
    for (const k of ['voice', 'beep', 'vibrate', 'wake']) {
      const el = $(`#opt-${k}`);
      el.checked = settings[k];
      el.onchange = () => { settings[k] = el.checked; saveSettings(); if (k === 'wake') requestWake(); };
    }
    $('#testBtn').onclick = () => {
      ensureAudio(); beep(2); vibrate([250, 120, 250]);
      say(alertText({ t: 'fix', v: 100 }, 1000, 0));
    };
    $('#demoBtn').onclick = () => { $('#settings').close(); start(true); };
  }

  $('#startBtn').onclick = () => (running ? stop() : start());
  $('#settingsBtn').onclick = () => $('#settings').showModal();
  $('#closeSettings').onclick = () => $('#settings').close();
  bindSettings();
  loadRadars();
  showNext(null, null);

  if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
