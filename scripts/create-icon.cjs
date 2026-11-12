const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.join(__dirname, '..', 'build');
fs.mkdirSync(root, { recursive: true });
function pixel(x, y, size) {
  const px = x / size, py = y / size;
  const ink = px >= .28 && px <= .42 && py >= .23 && py <= .79
    || px >= .28 && px <= .75 && py >= .23 && py <= .36
    || px >= .28 && px <= .66 && py >= .46 && py <= .59;
  return ink ? [23, 23, 20, 255] : [247, 243, 232, 255];
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
const size = 256, raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) Buffer.from(pixel(x, y, size)).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
fs.writeFileSync(path.join(root, 'icon.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
const sizes = [16, 32, 48, 256], directory = Buffer.alloc(6 + sizes.length * 16), images = [];
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((n, index) => {
  const maskSize = Math.ceil(n / 32) * 4 * n, bmp = Buffer.alloc(40 + n * n * 4 + maskSize);
  bmp.writeUInt32LE(40); bmp.writeInt32LE(n, 4); bmp.writeInt32LE(n * 2, 8); bmp.writeUInt16LE(1, 12); bmp.writeUInt16LE(32, 14); bmp.writeUInt32LE(n * n * 4, 20);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const [r, g, b, a] = pixel(x, n - 1 - y, n); Buffer.from([b, g, r, a]).copy(bmp, 40 + (y * n + x) * 4);
  }
  const entry = 6 + index * 16; directory[entry] = n % 256; directory[entry + 1] = n % 256;
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6); directory.writeUInt32LE(bmp.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += bmp.length; images.push(bmp);
});
fs.writeFileSync(path.join(root, 'icon.ico'), Buffer.concat([directory, ...images]));
