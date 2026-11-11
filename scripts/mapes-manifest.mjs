// Llista de paquets de mapa que mostra l'app (www/mapes.json).
//   node scripts/mapes-manifest.mjs --peca out/es-catalunya.pmtiles   → JSON d'un paquet (mida, límits)
//   node scripts/mapes-manifest.mjs --uneix carpeta-de-peces          → reescriu www/mapes.json
// Els paquets són a la Release "mapes" del repo (un .pmtiles per regió).
import { readFile, writeFile, readdir, stat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readHeader } from './pmtiles-lite.mjs';

const REGIONS = JSON.parse(await readFile(new URL('./mapes-regions.json', import.meta.url), 'utf8'));
const OUT = new URL('../www/mapes.json', import.meta.url);
const BASE = 'https://github.com/Xorigu3r/xoriguer-radars/releases/download/mapes/';

const mode = process.argv[2], target = process.argv[3];

if (mode === '--peca') {
  const fh = await open(target, 'r');
  const buf = Buffer.alloc(127);
  await fh.read(buf, 0, 127, 0);
  await fh.close();
  const h = readHeader(buf);
  const id = basename(target, '.pmtiles');
  const r = REGIONS.find((x) => x.id === id) || { id, nom: id, pais: '' };
  const bytes = (await stat(target)).size;
  const b = h.bounds.map((n) => Math.round(n * 1e4) / 1e4);
  console.log(JSON.stringify({ id, pais: r.pais, nom: r.nom, bytes, bounds: b, maxzoom: h.maxZoom, data: new Date().toISOString().slice(0, 10), url: `${BASE}${id}.pmtiles` }));
} else if (mode === '--uneix') {
  let prev = { paquets: [] };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const byId = new Map(prev.paquets.map((p) => [p.id, p]));
  for (const f of await readdir(target)) {
    if (!f.endsWith('.json')) continue;
    const p = JSON.parse(await readFile(join(target, f), 'utf8'));
    byId.set(p.id, p);   // els paquets que han fallat aquest cop es mantenen amb les dades anteriors
  }
  const ordre = REGIONS.map((r) => r.id);
  const paquets = [...byId.values()].sort((a, b) => ordre.indexOf(a.id) - ordre.indexOf(b.id));
  await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), paquets }, null, 1));
  console.log(`mapes.json: ${paquets.length} paquets, ${(paquets.reduce((s, p) => s + p.bytes, 0) / 1e9).toFixed(1)} GB en total`);
} else {
  console.error('Ús: --peca fitxer.pmtiles | --uneix carpeta');
  process.exit(1);
}
