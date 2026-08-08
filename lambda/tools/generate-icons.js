import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createIcon(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const orange = [255, 106, 0, 255];
  const white = [255, 255, 255, 255];
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < size; x += 1) rows.set(orange, row + 1 + x * 4);
  }

  const paintLine = (x1, y1, x2, y2, width) => {
    const ax = x1 * size;
    const ay = y1 * size;
    const bx = x2 * size;
    const by = y2 * size;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const radius = width * size / 2;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - radius)); y < Math.min(size, Math.ceil(Math.max(ay, by) + radius)); y += 1) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - radius)); x < Math.min(size, Math.ceil(Math.max(ax, bx) + radius)); x += 1) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
        if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= radius) {
          rows.set(white, y * (size * 4 + 1) + 1 + x * 4);
        }
      }
    }
  };
  paintLine(.25, .19, .33, .19, .08);
  paintLine(.33, .19, .65, .82, .08);
  paintLine(.48, .42, .30, .82, .08);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND'),
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(root, 'public', `icon-${size}.png`), createIcon(size));
}
