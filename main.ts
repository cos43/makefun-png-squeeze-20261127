// png-squeeze entry: a small lossless PNG re-encoder written for this bounty.
// Strategy, per image:
//   1. decode the stored RGBA PNG the contest hands us;
//   2. shrink the sample stream before filtering: <=256 distinct RGBA colours
//      become a palette image (colour type 3 + tRNS when any alpha < 255);
//      an all-grey image becomes grey (type 0) or grey+alpha (type 4);
//      an opaque colour image becomes RGB (type 2); the rest stays RGBA;
//   3. pick each row's filter (None/Sub/Up/Average/Paeth) by the smallest sum
//      of absolute signed residual bytes — the filter that leaves the least
//      entropy for the deflater;
//   4. one zlib level-9 stream, one IDAT, no ancillary chunks.
// Everything is deterministic: no clock, no randomness, no environment reads
// beyond the input/output directories the contest mounts.
import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- PNG chunk plumbing (CRC-32, chunk assembly) ---------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function assemble(parts: Uint8Array[]): Uint8Array {
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  let total = sig.length;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let at = sig.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function ihdr(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---- Decoding: stored RGBA PNG -> raw RGBA pixels --------------------------

function paethPredict(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (data[12] !== 0) throw new Error('interlaced');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (channels === undefined) throw new Error(`colour type ${colourType} unsupported`);
  const stride = width * channels;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT length mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? samples[o + i - channels] : 0;
      const up = y > 0 ? samples[p + i] : 0;
      const upLeft = y > 0 && i >= channels ? samples[p + i - channels] : 0;
      let v = raw[src + i];
      if (ft === 1) v += left;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (left + up) >> 1;
      else if (ft === 4) v += paethPredict(left, up, upLeft);
      samples[o + i] = v & 0xff;
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns ? (trns[1] << 16) | (trns[3] << 8) | trns[5] : -1;
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns ? trns[1] : -1;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      const pl = palette as Uint8Array;
      rgba[d] = pl[e * 3];
      rgba[d + 1] = pl[e * 3 + 1];
      rgba[d + 2] = pl[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---- Analysis: pick the smallest faithful sample format -------------------

interface Reduced {
  colourType: number;
  bpp: number; // samples per pixel
  samples: Uint8Array;
  palette?: Uint8Array; // RGB triples, colour type 3
  trns?: Uint8Array; // alpha per palette entry, colour type 3
}

function reduce(rgba: Uint8Array, width: number, height: number): Reduced {
  const n = width * height;
  // Pass 1: distinct colours (cap the count at 257), grey-ness, opacity.
  const seen = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (seen.size <= 256) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!seen.has(key)) seen.set(key, seen.size);
    }
  }
  if (allGrey) {
    // Grey first: the sample IS the grey value, so the row filters predict
    // on real brightness instead of on arbitrary palette indices.
    if (allOpaque) {
      const samples = new Uint8Array(n);
      for (let i = 0, d = 0; i < n; i++, d += 4) samples[i] = rgba[d];
      return { colourType: 0, bpp: 1, samples };
    }
    const samples = new Uint8Array(n * 2);
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 2) {
      samples[s] = rgba[d];
      samples[s + 1] = rgba[d + 3];
    }
    return { colourType: 4, bpp: 2, samples };
  }
  if (seen.size <= 256) {
    // Palette image: 1 byte per pixel, exact RGBA via PLTE + tRNS.
    // Sort the palette by colour so neighbouring similar colours get close
    // indices — the row filters then leave small residuals.
    const keys = [...seen.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const remap = new Map<number, number>();
    const palette = new Uint8Array(keys.length * 3);
    const alphas = new Uint8Array(keys.length);
    let anyAlpha = false;
    keys.forEach((key, idx) => {
      remap.set(key, idx);
      palette[idx * 3] = (key >>> 24) & 0xff;
      palette[idx * 3 + 1] = (key >>> 16) & 0xff;
      palette[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
      if ((key & 0xff) !== 255) anyAlpha = true;
    });
    const samples = new Uint8Array(n);
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      samples[i] = remap.get(key) as number;
    }
    // tRNS may stop at the last non-opaque entry.
    let trns: Uint8Array | undefined;
    if (anyAlpha) {
      let last = keys.length - 1;
      while (last > 0 && alphas[last] === 255) last--;
      trns = alphas.subarray(0, last + 1);
    }
    return { colourType: 3, bpp: 1, samples, palette, trns };
  }
  if (allOpaque) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 3) {
      samples[s] = rgba[d];
      samples[s + 1] = rgba[d + 1];
      samples[s + 2] = rgba[d + 2];
    }
    return { colourType: 2, bpp: 3, samples };
  }
  return { colourType: 6, bpp: 4, samples: rgba };
}

// ---- Filtering: per-row minimum-absolute-residual choice -------------------

function filterRowInto(
  type: number,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): number {
  // Returns the sum of |signed| residual bytes; also writes the filtered row.
  const n = cur.length;
  let sum = 0;
  if (type === 0) {
    for (let i = 0; i < n; i++) {
      const v = cur[i];
      out[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
  } else if (type === 1) {
    for (let i = 0; i < n; i++) {
      const v = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      out[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
  } else if (type === 2) {
    for (let i = 0; i < n; i++) {
      const v = (cur[i] - (prev === null ? 0 : prev[i])) & 0xff;
      out[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const v = (cur[i] - ((a + b) >> 1)) & 0xff;
      out[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      const v = (cur[i] - paethPredict(a, b, c)) & 0xff;
      out[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
  }
  return sum;
}

function filterBest(samples: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      const s = filterRowInto(t, cur, prev, bpp, trials[t]);
      if (s < bestSum) {
        bestSum = s;
        bestType = t;
      }
    }
    const at = y * (stride + 1);
    raw[at] = bestType;
    raw.set(trials[bestType], at + 1);
  }
  return raw;
}

// ---- Encoding ----------------------------------------------------------------

function encode(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const r = reduce(rgba, width, height);
  const raw = filterBest(r.samples, width, height, r.bpp);
  const compressed = deflateSync(raw, { level: 9 });
  const parts: Uint8Array[] = [chunk('IHDR', ihdr(width, height, r.colourType))];
  if (r.palette) parts.push(chunk('PLTE', r.palette));
  if (r.trns) parts.push(chunk('tRNS', r.trns));
  parts.push(chunk('IDAT', new Uint8Array(compressed)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return assemble(parts);
}

// ---- Driver ------------------------------------------------------------------

for (const id of readdirSync(INPUT).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), encode(image.rgba, image.width, image.height));
}
