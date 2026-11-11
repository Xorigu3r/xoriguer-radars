// Copia les llibreries que la web fa servir sense empaquetador:
//  - capacitor.js (pont amb Android)
//  - MapLibre GL (mapa que gira amb el rumb): www/vendor/
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
copyFileSync(at('node_modules/@capacitor/core/dist/capacitor.js'), at('www/capacitor.js'));
mkdirSync(at('www/vendor'), { recursive: true });
for (const f of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) {
  copyFileSync(at(`node_modules/maplibre-gl/dist/${f}`), at(`www/vendor/${f}`));
}
copyFileSync(at('node_modules/maplibre-gl/LICENSE.txt'), at('www/vendor/MAPLIBRE-LICENSE.txt'));
// PMTiles (paquets de mapa al mòbil, llicència BSD-3): versió autònoma, defineix window.pmtiles
copyFileSync(at('node_modules/pmtiles/dist/pmtiles.js'), at('www/vendor/pmtiles.js'));
console.log('Llibreries copiades a www/ i www/vendor/');
