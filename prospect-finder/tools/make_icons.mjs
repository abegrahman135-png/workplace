import { writeFileSync, mkdirSync } from 'fs';
// Minimal PNG encoder (no deps) — solid gradient-ish violet gem tile.
import { deflateSync } from 'zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = [];
  const cx = size / 2, cy = size / 2, r = size * 0.46;
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = y / size;
      const inside = d <= r;
      const rr = Math.round(139 + (236 - 139) * t);
      const gg = Math.round(92 + (72 - 92) * t);
      const bb = Math.round(246 + (153 - 246) * t);
      // 4-point sparkle
      const ang = Math.atan2(dy, dx);
      const spark = Math.abs(Math.cos(2 * ang));
      const sr = r * (0.30 + 0.42 * spark);
      const isGem = d <= sr;
      if (!inside) raw.push(0, 0, 0, 0);
      else if (isGem) raw.push(255, 255, 255, 255);
      else raw.push(rr, gg, bb, 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync('public/icons', { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`public/icons/icon-${s}.png`, png(s));
console.log('icons written');
