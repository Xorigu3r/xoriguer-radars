// Proves de la lògica: node test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const L = require('./www/app.js');
const { parseDatex, parseOverpass, osmDirection } = await import('./scripts/build-radars.mjs');

let ok = 0;
const t = (name, fn) => { fn(); ok++; console.log('✓', name); };

const bcn = { lat: 41.3874, lon: 2.1686 };

t('distància Barcelona–Girona ≈ 86 km', () => {
  const d = L.distance(bcn, { lat: 41.9794, lon: 2.8214 });
  assert.ok(d > 84000 && d < 88000, d);
});
t('rumb cap al nord = 0°, cap a l\'est ≈ 90°', () => {
  assert.ok(L.angleDiff(L.bearing(bcn, { lat: 41.5, lon: 2.1686 }), 0) < 0.5);
  assert.ok(L.angleDiff(L.bearing(bcn, { lat: 41.3874, lon: 2.3 }), 90) < 0.5);
});
t('destination + distance són coherents', () => {
  const p = L.destination(bcn, 45, 1000);
  assert.ok(Math.abs(L.distance(bcn, p) - 1000) < 1);
});

const north900 = { id: 'a', ...L.destination(bcn, 0, 900), t: 'fix' };
const south500 = { id: 'b', ...L.destination(bcn, 180, 500), t: 'fix' };
const ne1500 = { id: 'c', ...L.destination(bcn, 40, 1500), t: 'fix' };
const wrongWay = { id: 'd', ...L.destination(bcn, 0, 600), t: 'fix', d: 180 };
const rightWay = { id: 'e', ...L.destination(bcn, 0, 700), t: 'fix', d: 10 };
const list = [north900, south500, ne1500, wrongWay, rightWay];

t('findAhead: només els del davant, ordenats', () => {
  const ids = L.findAhead(bcn, 0, list, 2000).map((a) => a.radar.id);
  assert.deepEqual(ids, ['e', 'a']); // b darrere, c fora del con, d sentit contrari
});
t('findAhead: respecta la distància màxima', () => {
  assert.deepEqual(L.findAhead(bcn, 0, list, 800).map((a) => a.radar.id), ['e']);
});
t('findAhead: sense rumb no avisa', () => {
  assert.equal(L.findAhead(bcn, null, list, 2000).length, 0);
});
t('findAhead: a prop (<60 m) accepta un angle més gran', () => {
  const close = { id: 'f', ...L.destination(bcn, 60, 40), t: 'fix' };
  assert.equal(L.findAhead(bcn, 0, [close], 2000).length, 1);
});
t('alertStage', () => {
  assert.equal(L.alertStage(1500, 1000, 200), 0);
  assert.equal(L.alertStage(990, 1000, 200), 1);
  assert.equal(L.alertStage(150, 1000, 200), 2);
});
t('pickHeading: GPS si va ràpid, si no calculat', () => {
  assert.equal(L.pickHeading({ ...bcn, heading: 90, speed: 20 }, null, null), 90);
  const p2 = L.destination(bcn, 270, 30);
  assert.ok(L.angleDiff(L.pickHeading({ ...p2, heading: null, speed: 0.5 }, bcn, 12), 270) < 1);
  assert.equal(L.pickHeading({ ...L.destination(bcn, 270, 5), heading: null }, bcn, 12), 12);
});
t('textos', () => {
  assert.equal(L.formatDist(1000), '1 km');
  assert.equal(L.formatDist(1500), '1,5 km');
  assert.equal(L.formatDist(234), '230 m');
  assert.equal(L.alertText({ t: 'fix', v: 100 }, 1000, 90), 'Radar a 1 quilòmetre. Límit 100.');
  assert.equal(L.alertText({ t: 'tram' }, 200, 0), 'Tram de velocitat mitjana a 200 metres.');
  assert.equal(L.alertText({ t: 'fix', v: 80 }, 200, 100), 'Radar a 200 metres. Límit 80. Vas massa ràpid.');
});
t('osmDirection', () => {
  assert.equal(osmDirection('355'), 355);
  assert.equal(osmDirection('NE'), 45);
  assert.equal(osmDirection('forward'), null);
});
t('parseDatex amb un fragment real', () => {
  const xml = `<_0:predefinedLocationSet id="GUID_Inventario_CabinasCinemometro"><_0:predefinedLocation id="GUID_CABINACINEMOMETRO_120001"><_0:predefinedLocation xsi:type="_0:Point"><_0:pointCoordinates><_0:latitude>41.30326</_0:latitude><_0:longitude>-1.94488</_0:longitude></_0:pointCoordinates><_0:roadNumber>A-2</_0:roadNumber><_0:referencePointDistance>202330.0</_0:referencePointDistance><_0:directionNamed>ZARAGOZA</_0:directionNamed></_0:predefinedLocation></_0:predefinedLocation></_0:predefinedLocationSet>`;
  const r = parseDatex(xml);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].r, r[0].pk, r[0].t, r[0].to], ['A-2', 202.3, 'fix', 'ZARAGOZA']);
});
t('parseOverpass', () => {
  const r = parseOverpass({ elements: [{ type: 'node', id: 1, lat: 41, lon: 2, tags: { maxspeed: '80', direction: '90' } }] });
  assert.deepEqual([r[0].v, r[0].d, r[0].s], [80, 90, 'osm']);
});

// Simulació: conduir a 108 km/h cap a un radar i comprovar on avisa.
t('simulació: avisa un cop a ~1 km i un altre a ~200 m', () => {
  const radar = { id: 'x', ...L.destination(bcn, 30, 3000), t: 'fix' };
  const alerts = [];
  const done = new Map();
  let pos = bcn;
  for (let s = 0; s < 110; s++) {
    pos = L.destination(pos, 30, 30);
    const a = L.findAhead(pos, 30, [radar], 2500)[0];
    if (!a) continue;
    const st = L.alertStage(a.dist, 1000, 200);
    if (st > (done.get('x') || 0)) { done.set('x', st); alerts.push(Math.round(a.dist)); }
  }
  assert.equal(alerts.length, 2, alerts);
  assert.ok(alerts[0] <= 1000 && alerts[0] > 960, alerts);
  assert.ok(alerts[1] <= 200 && alerts[1] > 160, alerts);
  console.log('   avisos a', alerts.join(' m i '), 'm');
});

console.log(`\n${ok} proves correctes`);
