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
t('alertText: «Vas massa ràpid» es pot desactivar', () => {
  assert.equal(L.alertText({ t: 'fix', v: 80 }, 200, 100, false), 'Radar a 200 metres. Límit 80.');
});
t('filterRadars: trams i OSM opcionals', () => {
  const l = [{ t: 'fix', s: 'dgt' }, { t: 'tram', s: 'dgt' }, { t: 'fix', s: 'osm' }];
  assert.equal(L.filterRadars(l, { trams: true, osm: true }).length, 3);
  assert.equal(L.filterRadars(l, { trams: false, osm: true }).length, 2);
  assert.equal(L.filterRadars(l, { trams: true, osm: false }).length, 2);
  assert.equal(L.filterRadars(l, { trams: false, osm: false }).length, 1);
});
t('newestData: es queda la còpia més nova i ignora les buides', () => {
  const a = { generated: '2026-11-10T04:00:00Z', radars: [1] }, b = { generated: '2026-11-11T04:00:00Z', radars: [1] };
  assert.equal(L.newestData(a, b), b);
  assert.equal(L.newestData(b, a), b);
  assert.equal(L.newestData(a, { generated: '2099', radars: [] }, null), a);
  assert.equal(L.newestData(null, undefined), null);
});

t('alongPath i trimAround (demo per carretera)', () => {
  // Camí en forma de L: 1 km cap al nord i 1 km cap a l'est
  const a = bcn, b = L.destination(a, 0, 1000), c = L.destination(b, 90, 1000);
  const path = [a, b, c], acc = L.pathLengths(path);
  assert.ok(Math.abs(acc[2] - 2000) < 2);
  const p = L.alongPath(path, acc, 500);
  assert.ok(Math.abs(L.distance(a, p) - 500) < 2 && L.angleDiff(p.brg, 0) < 1);
  const q = L.alongPath(path, acc, 1500);
  assert.ok(L.angleDiff(q.brg, 90) < 1 && !q.end);
  assert.ok(L.alongPath(path, acc, 9999).end);
  // Retallar al voltant de b: 600 m abans i 300 m després
  const dense = [];
  for (let i = 0; i <= 20; i++) dense.push(L.alongPath(path, acc, i * 100));
  const t2 = L.trimAround(dense, b, 600, 300);
  const tl = L.pathLengths(t2.path);
  assert.ok(t2.gap < 2 && tl[tl.length - 1] >= 800 && tl[tl.length - 1] <= 900, tl[tl.length - 1]);
});

const B = await import('./scripts/build-radars.mjs');
t('SCT: UTM → GPS i línies del radars.txt', () => {
  // A-2 PK 445,35 (Alcarràs/Lleida): ha de caure a prop de Lleida
  const p = B.utmToLatLon(288075.4643, 4601625.063);
  assert.ok(p.lat > 41.5 && p.lat < 41.6 && p.lon > 0.4 && p.lon < 0.5, JSON.stringify(p));
  const r = B.parseSct('Via  PK  Velocitat X Y\nA-2         445,35      120         288075,4643 4601625,063 \nN-340       1074-1079   90          296368,2751 4502502,5464\nN-340       1079-1074   90          295760,707  4506827,5578\n');
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].t, r[0].v, r[0].s, r[0].c], ['fix', 120, 'sct', 'ES']);
  assert.equal(r[1].t, 'tram');
  assert.equal(r[1].g, r[2].g);   // els dos sentits del mateix tram s'agrupen
});
t('França: CSV oficial (tipus i límit)', () => {
  const r = B.parseFrance('Numéro de radar;Type de radar;Date de mise en service;VMA ;Latitude; Longitude\n12001;ETD;31/10/2011 00:00;70;+45.361;+4.2526\n9;ETFR;01/01/2012;50;+45.1;+4.1\n10;ETVM;01/01/2012;110;+45.2;+4.3\n');
  assert.equal(r.length, 2);          // el de semàfor (ETFR) queda fora
  assert.deepEqual([r[0].t, r[0].v, r[0].c], ['fix', 70, 'FR']);
  assert.equal(r[1].t, 'tram');
});
t('mode zona (França): sempre entre 600 i 2000 m, i fix per a cada radar', () => {
  for (let i = 0; i < 200; i++) { const d = L.zoneDistance({ id: `fr-${i}` }); assert.ok(d >= 600 && d <= 2000); }
  assert.equal(L.zoneDistance({ id: 'fr-7' }), L.zoneDistance({ id: 'fr-7' }));
  assert.ok(L.isZone({ c: 'FR' }) && !L.isZone({ c: 'ES' }));
});
t('trams: grups de dos extrems i velocitat mitjana', () => {
  const g = L.tramGroups([{ t: 'tram', g: 'a' }, { t: 'tram', g: 'a' }, { t: 'tram', g: 'b' }, { t: 'fix', g: 'c' }]);
  assert.deepEqual([...g.keys()], ['a']);
  assert.equal(Math.round(L.avgKmh(5000, 150000)), 120);   // 5 km en 2 min 30 s = 120 km/h
});
t('versions', () => {
  assert.equal(L.compareVersions('v1.10', '1.9'), 1);
  assert.equal(L.compareVersions('v1.1', '1.1'), 0);
  assert.equal(L.compareVersions('v1.0', '1.1'), -1);
});
t('incidències: DATEX II', () => {
  const x = `<sit:situationRecord xsi:type="sit:GeneralObstruction" id="1"><com:overallEndTime>2099-01-01T00:00:00Z</com:overallEndTime><sit:causeType>accident</sit:causeType><loc:roadName>AP-7</loc:roadName><loc:latitude>41.5</loc:latitude><loc:longitude>2.1</loc:longitude></sit:situationRecord>
  <sit:situationRecord xsi:type="sit:AbnormalTraffic" id="2"><loc:latitude>41.6</loc:latitude><loc:longitude>2.2</loc:longitude></sit:situationRecord>
  <sit:situationRecord xsi:type="sit:GeneralObstruction" id="3"><com:overallEndTime>2001-01-01T00:00:00Z</com:overallEndTime><loc:latitude>41</loc:latitude><loc:longitude>2</loc:longitude></sit:situationRecord>`;
  const r = L.parseIncidents(x);
  assert.equal(r.length, 2);   // la caducada no hi és
  assert.deepEqual([r[0].kind, r[0].road, r[1].kind], ['accident', 'AP-7', 'retencio']);
  assert.equal(L.incidentText(r[0], 1000), 'Accident a 1 quilòmetre, AP 7.');
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
