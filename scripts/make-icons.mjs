// Genera totes les icones a partir de www/icons/logo.svg:
//  - www/icons/icon-192.png, icon-512.png, maskable-512.png (PWA)
//  - assets/*.png (font per a `npx capacitor-assets generate --android`)
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
// El logo enllaça falco.png (el falcó de la casa); per a sharp l'incrustem com a data URI.
const falco = `data:image/png;base64,${readFileSync(at('www/icons/falco.png')).toString('base64')}`;
const svg = readFileSync(at('www/icons/logo.svg'), 'utf8').replaceAll('"falco.png"', `"${falco}"`);
const BG = '#0A0B0E';

// Separa el fons (primer <rect>) del dibuix per poder-lo escalar dins la "zona segura".
// Els <defs> (degradat de les anelles) es conserven a part.
const defs = (svg.match(/<defs>[\s\S]*?<\/defs>/) || [''])[0];
const inner = svg.replace(/^[\s\S]*?<rect[^>]*\/>/, '').replace(/<\/svg>\s*$/, '');
const variant = ({ scale = 1, bg = BG }) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512">${defs}` +
  (bg ? `<rect width="512" height="512" fill="${bg}"/>` : '') +
  `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${inner}</g></svg>`);

const png = (buf, size, out) => sharp(buf, { density: Math.ceil((72 * size) / 512) + 10 })
  .resize(size, size).png().toFile(at(out));

mkdirSync(at('assets'), { recursive: true });
await Promise.all([
  png(Buffer.from(svg), 192, 'www/icons/icon-192.png'),
  png(Buffer.from(svg), 512, 'www/icons/icon-512.png'),
  png(variant({ scale: 0.8 }), 512, 'www/icons/maskable-512.png'),
  // Android: icona clàssica, i icona adaptativa (primer pla dins el 66% central + fons llis)
  png(variant({ scale: 0.92 }), 1024, 'assets/icon-only.png'),
  png(variant({ scale: 0.58, bg: null }), 1024, 'assets/icon-foreground.png'),
  sharp({ create: { width: 1024, height: 1024, channels: 3, background: BG } }).png().toFile(at('assets/icon-background.png')),
]);
// Pantalla d'inici: logo al centre sobre fons de nit
const logo = await sharp(Buffer.from(svg), { density: 200 }).resize(900, 900).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 3, background: BG } })
    .composite([{ input: logo, gravity: 'center' }]).png().toFile(at(`assets/${name}`));
}
console.log('Icones generades.');
