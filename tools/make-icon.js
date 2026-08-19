/**
 * 트레이/앱 아이콘 PNG를 코드로 생성한다. (바이너리 에셋을 저장소에 두지 않기 위함)
 *   node tools/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 보라 라운드 사각형 + 오른쪽에 살짝 빼꼼 나온 노란 메모지 */
function icon(size) {
  const s = size;
  const u = s / 32; // 32px 기준 좌표를 실제 크기로 환산
  return encodePNG(s, (x, y) => {
    const px = x / u, py = y / u;
    // 노란 메모지 (오른쪽으로 빼꼼)
    if (px >= 17 && px <= 30 && py >= 9 && py <= 25) return [251, 243, 176, 255];
    // 보라 본체 (라운드 사각형)
    const inX = px >= 3 && px <= 20, inY = py >= 4 && py <= 28;
    if (inX && inY) {
      const r = 4;
      const cx = Math.min(Math.max(px, 3 + r), 20 - r);
      const cy = Math.min(Math.max(py, 4 + r), 28 - r);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) return [139, 92, 246, 255];
    }
    return [0, 0, 0, 0];
  });
}

/** PNG 여러 장을 묶어 .ico 를 만든다. (Vista 이후는 ICO 안에 PNG 를 그대로 넣을 수 있다) */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;

  pngs.forEach((p, i) => {
    const at = i * 16;
    dir[at] = p.size >= 256 ? 0 : p.size;      // 256 은 0 으로 적는다
    dir[at + 1] = p.size >= 256 ? 0 : p.size;
    dir[at + 2] = 0;                            // 팔레트 색 수
    dir[at + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, at + 4);               // color planes
    dir.writeUInt16LE(32, at + 6);              // bits per pixel
    dir.writeUInt32LE(p.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += p.data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const pngs = [];
for (const size of [16, 32, 64, 256]) {
  const data = icon(size);
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, data);
  pngs.push({ size, data });
  console.log('wrote', file);
}

const ico = path.join(outDir, 'icon.ico');
fs.writeFileSync(ico, buildIco(pngs));
console.log('wrote', ico);
