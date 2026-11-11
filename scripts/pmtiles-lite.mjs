// Lectura i escriptura mínimes de fitxers PMTiles v3 (sense dependències).
//  - readHeader(buf): capçalera (127 bytes) → límits, zooms, etc. Ho fa servir mapes-manifest.mjs.
//  - writePmtiles(tiles): genera un .pmtiles petit (per a proves) a partir de [{z,x,y,data}].
// Especificació: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
import { gzipSync } from 'node:zlib';

export function readHeader(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 7));
  if (magic !== 'PMTiles' || buf[7] !== 3) throw new Error('No és un PMTiles v3');
  const u64 = (o) => Number(v.getBigUint64(o, true));
  const e7 = (o) => v.getInt32(o, true) / 1e7;
  return {
    rootOffset: u64(8), rootLength: u64(16), tileDataLength: u64(64), addressedTiles: u64(72),
    tileCompression: buf[98], tileType: buf[99], minZoom: buf[100], maxZoom: buf[101],
    bounds: [e7(102), e7(106), e7(110), e7(114)],   // [oest, sud, est, nord]
    center: [e7(119), e7(123), buf[118]],
  };
}

// --- escriptura (proves) ---
function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z;
  let d = 0, tx = x, ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0, ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // rotació de la corba de Hilbert
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      [tx, ty] = [ty, tx];
    }
  }
  return acc + d;
}
const varint = (out, n) => { while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); };

export function writePmtiles(tiles, { minZoom, maxZoom, bounds, center, metadata = {} }) {
  const entries = tiles.map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: gzipSync(t.data) }))
    .sort((a, b) => a.id - b.id);
  let off = 0;
  for (const e of entries) { e.offset = off; e.length = e.data.length; off += e.length; }
  const dir = [];
  varint(dir, entries.length);
  let last = 0;
  for (const e of entries) { varint(dir, e.id - last); last = e.id; }
  for (const e of entries) varint(dir, 1);                    // run_length
  for (const e of entries) varint(dir, e.length);
  entries.forEach((e, i) => varint(dir, i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1));
  const root = gzipSync(Buffer.from(dir));
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)));
  const tileData = Buffer.concat(entries.map((e) => e.data));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0); h[7] = 3;
  const put = (o, n) => h.writeBigUInt64LE(BigInt(n), o);
  put(8, 127); put(16, root.length);
  put(24, 127 + root.length); put(32, meta.length);
  put(40, 127 + root.length + meta.length); put(48, 0);
  put(56, 127 + root.length + meta.length); put(64, tileData.length);
  put(72, entries.length); put(80, entries.length); put(88, entries.length);
  h[96] = 1; h[97] = 2; h[98] = 2; h[99] = 1;               // agrupat, gzip intern, tessel·les gzip, MVT
  h[100] = minZoom; h[101] = maxZoom;
  const e7 = (o, x) => h.writeInt32LE(Math.round(x * 1e7), o);
  e7(102, bounds[0]); e7(106, bounds[1]); e7(110, bounds[2]); e7(114, bounds[3]);
  h[118] = center[2]; e7(119, center[0]); e7(123, center[1]);
  return Buffer.concat([h, root, meta, tileData]);
}
