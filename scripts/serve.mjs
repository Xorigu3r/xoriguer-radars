// Servidor estàtic mínim per provar la PWA: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Arrel: www/ per defecte, o la carpeta que es passi com a 2n argument (p. ex. per provar la web de descàrregues).
const root = process.argv[3] ? normalize(process.argv[3] + '/') : fileURLToPath(new URL('../www/', import.meta.url));
const port = +process.env.PORT || +process.argv[2] || 8080;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8','.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root) || /[\\/](scripts|node_modules|\.git)[\\/]/.test(file)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const type = types[extname(file)] || 'application/octet-stream';
    // Peticions per trossos (Range): les fa el lector de PMTiles.
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = +m[1], end = m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' })
        .end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }).end(body);
  } catch { res.writeHead(404).end('No trobat'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
