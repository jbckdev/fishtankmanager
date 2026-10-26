// Génère les icônes PNG de la PWA (même dessin que public/icon.svg), sans dépendance.
// Usage : node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const BG = [7, 19, 24], SKY = [56, 189, 248], LIGHT = [224, 242, 254], DEEP = [3, 105, 161];

// Plein cadre (pas de coins arrondis) : iOS et Android appliquent leur propre masque
function pixel(x, y, s) {
  const d = Math.hypot(x - s / 2, y - s / 2) / s;
  let col = mix(BG, SKY, Math.max(0, 1 - d / 0.42) ** 2 * 0.55); // halo
  const R = 0.265, edge = clamp01((R - d) * s + 0.5); // sphère, bord anti-crénelé
  if (edge > 0) {
    const g = Math.hypot(x - s * 0.38, y - s * 0.36) / (s * R * 1.4);
    const orb = g < 0.45 ? mix(LIGHT, SKY, g / 0.45) : mix(SKY, DEEP, clamp01((g - 0.45) / 0.55));
    col = mix(col, orb, edge);
  }
  return col.map(Math.round);
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, 255], y * stride + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public');
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), png(size));
  console.log('✓', name);
}
