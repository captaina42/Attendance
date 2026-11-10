// Generates the PWA icon set with no image dependencies: a rounded app tile with a
// gradient in the app colours and the AttendSecure "A" mark drawn as thick strokes.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "icons");

// ---------- tiny PNG encoder ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- shapes ----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Antialiased coverage from a signed distance in pixels.
const coverage = (dist, edge = 1.2) => clamp01(0.5 - dist / edge);

function sdRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

const mix = (a, b, t) => a + (b - a) * t;

// Draw at `size` with the artwork inset by `pad` (maskable icons need a safe zone).
function draw(size, pad, supersample = 3) {
  const S = size * supersample;
  const inner = S - pad * S * 2;
  const ox = pad * S;
  const oy = pad * S;
  const radius = inner * 0.235;

  // The "A": apex, two legs and a crossbar, in the inner box.
  const W = inner * 0.105; // stroke width
  const px = (u) => ox + u * inner;
  const py = (v) => oy + v * inner;
  const apex = [px(0.5), py(0.235)];
  const leftFoot = [px(0.285), py(0.79)];
  const rightFoot = [px(0.715), py(0.79)];
  const barA = [px(0.393), py(0.565)];
  const barB = [px(0.607), py(0.565)];

  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const i = (y * S + x) * 4;

      const tile = coverage(sdRoundRect(cx, cy, S / 2, S / 2, S / 2, S / 2, radius));
      if (tile <= 0) continue;

      // Diagonal gradient in the AttendSecure navy → indigo range.
      const t = clamp01((cx + cy) / (2 * S));
      let r = mix(16, 61, t);
      let g = mix(22, 82, t);
      let b = mix(63, 214, t * 1.05 > 1 ? 1 : t * 1.05);

      const d = Math.min(
        sdSegment(cx, cy, apex[0], apex[1], leftFoot[0], leftFoot[1]) - W / 2,
        sdSegment(cx, cy, apex[0], apex[1], rightFoot[0], rightFoot[1]) - W / 2,
        sdSegment(cx, cy, barA[0], barA[1], barB[0], barB[1]) - W / 2,
      );
      const glyph = coverage(d);
      if (glyph > 0) {
        r = mix(r, 255, glyph);
        g = mix(g, 255, glyph);
        b = mix(b, 255, glyph);
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(255 * tile);
    }
  }

  // Box-downsample the supersampled image.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const si = ((y * supersample + sy) * S + (x * supersample + sx)) * 4;
          const alpha = buf[si + 3] / 255;
          r += buf[si] * alpha;
          g += buf[si + 1] * alpha;
          b += buf[si + 2] * alpha;
          a += alpha;
        }
      }
      const n = supersample * supersample;
      const oi = (y * size + x) * 4;
      out[oi] = a ? Math.round(r / a) : 0;
      out[oi + 1] = a ? Math.round(g / a) : 0;
      out[oi + 2] = a ? Math.round(b / a) : 0;
      out[oi + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function write(name, size, pad, supersample) {
  const pixels = draw(size, pad, supersample);
  fs.writeFileSync(path.join(OUT, name), encodePng(size, size, pixels));
  console.log(`icons/${name}  ${size}x${size}`);
}

fs.mkdirSync(OUT, { recursive: true });
write("icon-192.png", 192, 0, 3);
write("icon-512.png", 512, 0, 2);
write("icon-maskable-512.png", 512, 0.12, 2); // art kept inside the Android safe zone
write("apple-touch-icon.png", 180, 0, 3);
write("favicon-32.png", 32, 0, 4);
