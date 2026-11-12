// Els fitxers s'actualitzen sols en segon pla; canvia la versió només si vols forçar-ho tot de cop.
const VERSION = 'v6';
const SHELL = ['./', 'index.html', 'style.css', 'marca/marca.css', 'marca/Montserrat-ExtraBold.ttf', 'app.js', 'map.js', 'capacitor.js', 'manifest.webmanifest', 'icons/logo.svg', 'icons/falco.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([...SHELL, 'radars.json'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('radars.json')) {
    // Xarxa primer (per tenir les dades noves) i, si no n'hi ha, la còpia guardada.
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('radars.json', copy));
        return res;
      }).catch(() => caches.match('radars.json'))
    );
    return;
  }
  // Resta de fitxers: respon de seguida amb la còpia guardada i l'actualitza en segon pla
  // (els canvis es veuen la propera vegada que s'obre l'app).
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
