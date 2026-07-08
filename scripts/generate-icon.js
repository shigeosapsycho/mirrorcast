'use strict';

/**
 * generate-icon.js - renders assets/icon.png with zero dependencies.
 *
 * Draws a dark rounded-square app tile with a portrait phone outline and an
 * upward "cast" mark, using signed-distance fields evaluated with 4x
 * supersampling for clean anti-aliased edges, then encodes a PNG by hand
 * (zlib + CRC32). No canvas/sharp/native modules required.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;   // output size
const SS = 4;    // supersample factor per axis

// ---- palette --------------------------------------------------------------
const TILE_TOP = [0x18, 0x1a, 0x1e];
const TILE_BOT = [0x0a, 0x0b, 0x0d];
const ACCENT = [0x4d, 0xa3, 0xff];

// ---- geometry (normalized 0..1) ------------------------------------------
const tile = { cx: 0.5, cy: 0.5, hw: 0.455, hh: 0.455, r: 0.2 };
const phone = { cx: 0.5, cy: 0.46, hh: 0.27, hw: 0.27 * (9 / 19.5), r: 0.055, sw: 0.024 };
const cast = { cx: 0.5, cy: 0.6, dot: 0.014, arcs: [
  { r: 0.052, t: 0.02 },
  { r: 0.09, t: 0.02 },
] };
const ARC_LO = (38 * Math.PI) / 180;
const ARC_HI = (142 * Math.PI) / 180;

// signed distance to a rounded box; < 0 inside
function sdfRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - hw + r;
  const dy = Math.abs(py - cy) - hh + r;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  const outside = Math.hypot(ax, ay);
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// colour of a single supersample; returns [r,g,b,a] 0..255
function sample(u, v) {
  let out = [0, 0, 0, 0];

  // 1) tile
  if (sdfRoundRect(u, v, tile.cx, tile.cy, tile.hw, tile.hh, tile.r) < 0) {
    const t = Math.min(1, Math.max(0, (v - (tile.cy - tile.hh)) / (2 * tile.hh)));
    out = [
      Math.round(lerp(TILE_TOP[0], TILE_BOT[0], t)),
      Math.round(lerp(TILE_TOP[1], TILE_BOT[1], t)),
      Math.round(lerp(TILE_TOP[2], TILE_BOT[2], t)),
      255,
    ];
  }

  // 2) phone outline (stroke = |sdf| < sw/2)
  const sp = sdfRoundRect(u, v, phone.cx, phone.cy, phone.hw, phone.hh, phone.r);
  if (Math.abs(sp) < phone.sw / 2) out = [...ACCENT, 255];

  // 3) cast mark - dot + upward arcs
  const dx = u - cast.cx;
  const dy = v - cast.cy;
  const dist = Math.hypot(dx, dy);
  if (dist < cast.dot) out = [...ACCENT, 255];
  const ang = Math.atan2(-(v - cast.cy), u - cast.cx); // up = positive
  if (ang > ARC_LO && ang < ARC_HI) {
    for (const a of cast.arcs) {
      if (Math.abs(dist - a.r) < a.t / 2) { out = [...ACCENT, 255]; break; }
    }
  }

  return out;
}

// ---- render with supersampling -------------------------------------------
function render() {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / S;
          const v = (y + (sy + 0.5) / SS) / S;
          const [r, g, b, a] = sample(u, v);
          sr += r * a; sg += g * a; sb += b * a; sa += a;
        }
      }
      const i = (y * S + x) * 4;
      const outA = sa / (SS * SS);
      if (sa > 0) {
        px[i] = Math.round(sr / sa);
        px[i + 1] = Math.round(sg / sa);
        px[i + 2] = Math.round(sb / sa);
      }
      px[i + 3] = Math.round(outA);
    }
  }
  return px;
}

// ---- PNG encoding ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // filter byte 0 per scanline
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- main -----------------------------------------------------------------
function main() {
  const outDir = path.join(__dirname, '..', 'assets');
  const outPath = path.join(outDir, 'icon.png');
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePng(render(), S, S);
  fs.writeFileSync(outPath, png);
  console.log(`icon written: ${outPath} (${png.length} bytes, ${S}x${S})`);
}

main();
