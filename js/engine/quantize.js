// 量化层 —— 逐行为移植自 Python 基准版 apexoled/engine/quantize.py
// 1 位黑白 / 灰度 / 彩色调色板；Floyd-Steinberg / 8x8 Bayer / 无抖动。
import { expandGray, linspace, luma, makeFrame, roundHalfEven, u8 } from './core.js';

// 8x8 Bayer 有序递色矩阵（归一化到 0..1）
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
].map(row => row.map(v => v / 64));

function bayerAt(y, x) { return BAYER8[y & 7][x & 7]; }

function frameLuma(frame) {
  const { width: w, height: h, data } = frame;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = luma(data[j], data[j + 1], data[j + 2]);
  }
  return g;
}

/* ---------------- Floyd-Steinberg（标量灰度通道） ---------------- */
function fsScalar(g, w, h, nearest) {
  const buf = new Float64Array(g.length);
  for (let i = 0; i < g.length; i++) buf[i] = g[i];
  const out = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const q = nearest(old);
      out[i] = q;
      const err = old - q;
      if (x + 1 < w) buf[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1] += err * 3 / 16;
        buf[i + w] += err * 5 / 16;
        if (x + 1 < w) buf[i + w + 1] += err * 1 / 16;
      }
    }
  }
  return out;
}

/* ---------------- 1 位黑白 ---------------- */

export function quantizeBW(frames, dither) {
  const { width: w, height: h } = frames[0];
  const out = [];
  if (dither === 'none') {
    for (const f of frames) {
      const g = frameLuma(f);
      const b = new Uint8Array(g.length);
      for (let i = 0; i < g.length; i++) b[i] = g[i] >= 128 ? 255 : 0;
      out.push(expandGray(b, w, h));
    }
  } else if (dither === 'bayer') {
    for (const f of frames) {
      const g = frameLuma(f);
      const b = new Uint8Array(g.length);
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) b[i] = g[i] > bayerAt(y, x) * 255 ? 255 : 0;
      }
      out.push(expandGray(b, w, h));
    }
  } else { // auto = FS 平滑递色（调色板 {0, 255}）
    for (const f of frames) {
      const g = frameLuma(f);
      const b = fsScalar(g, w, h, v => v >= 127.5 ? 255 : 0);
      out.push(expandGray(b, w, h));
    }
  }
  return out;
}

/* ---------------- 灰度 ---------------- */

export function quantizeGray(frames, levelsIn, dither) {
  const levels = Math.max(2, Math.min(256, Math.round(levelsIn)));
  const gl = linspace(0, 255, levels).map(roundHalfEven); // 均匀灰阶
  const { width: w, height: h } = frames[0];
  const step = 255 / Math.max(1, levels - 1);
  const nearestIdx = v => Math.max(0, Math.min(levels - 1, Math.round(v / step)));
  const out = [];
  if (dither === 'none') {
    for (const f of frames) {
      const g = frameLuma(f);
      const b = new Uint8Array(g.length);
      for (let i = 0; i < g.length; i++) {
        const idx = Math.max(0, Math.min(levels - 1, roundHalfEven(g[i] / 255 * (levels - 1))));
        b[i] = gl[idx];
      }
      out.push(expandGray(b, w, h));
    }
  } else if (dither === 'bayer') {
    for (const f of frames) {
      const g = frameLuma(f);
      const b = new Uint8Array(g.length);
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          const pert = g[i] + (bayerAt(y, x) - 0.5) * step;
          const idx = Math.max(0, Math.min(levels - 1, roundHalfEven(pert / 255 * (levels - 1))));
          b[i] = gl[idx];
        }
      }
      out.push(expandGray(b, w, h));
    }
  } else { // auto = FS
    for (const f of frames) {
      const g = frameLuma(f);
      const idx = fsScalar(g, w, h, v => gl[nearestIdx(v)]);
      out.push(expandGray(idx, w, h));
    }
  }
  return out;
}

/* ---------------- 彩色 ---------------- */

function nearestPalette(pert, palette) {
  // pert: [r,g,b] → 最近调色板颜色（平方距离 argmin，与 _nearest_palette 一致）
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = pert[0] - palette[i][0];
    const dg = pert[1] - palette[i][1];
    const db = pert[2] - palette[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function fsColor(frame, palette) {
  const { width: w, height: h, data: src } = frame;
  const buf = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) buf[i] = src[i];
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const old = [buf[i], buf[i + 1], buf[i + 2]];
      const ci = nearestPalette(old, palette);
      const q = palette[ci];
      out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2]; out[i + 3] = 255;
      for (let c = 0; c < 3; c++) {
        const err = old[c] - q[c];
        if (x + 1 < w) buf[i + 4 + c] += err * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) buf[i + (w - 1) * 4 + c] += err * 3 / 16;
          buf[i + w * 4 + c] += err * 5 / 16;
          if (x + 1 < w) buf[i + (w + 1) * 4 + c] += err * 1 / 16;
        }
      }
    }
  }
  return makeFrame(w, h, out);
}

function mapNearest(frame, palette) {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const ci = nearestPalette([src[i], src[i + 1], src[i + 2]], palette);
    out[i] = palette[ci][0]; out[i + 1] = palette[ci][1]; out[i + 2] = palette[ci][2]; out[i + 3] = 255;
  }
  return makeFrame(w, h, out);
}

// median cut：全部帧的全部像素建共享调色板（与 Python 侧 Pillow MEDIANCUT 行为对齐）
function medianCut(pixels, n) {
  // pixels: Uint32Array 视图或普通数组 of [r,g,b]；用打包 int 提速
  let boxes = [pixels];
  while (boxes.length < n) {
    // 取体量最大且色域最宽的盒子分裂
    let bi = -1, bScore = -1, bAxis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const range = [0, 0, 0];
      let mn = [255, 255, 255], mx = [0, 0, 0];
      for (const px of box) {
        for (let c = 0; c < 3; c++) {
          if (px[c] < mn[c]) mn[c] = px[c];
          if (px[c] > mx[c]) mx[c] = px[c];
        }
      }
      for (let c = 0; c < 3; c++) range[c] = mx[c] - mn[c];
      const axis = range[0] >= range[1] && range[0] >= range[2] ? 0 : (range[1] >= range[2] ? 1 : 2);
      const score = box.length * range[axis];
      if (range[axis] === 0) continue;
      if (score > bScore) { bScore = score; bi = i; bAxis = axis; }
    }
    if (bi === -1) break; // 全部盒子已无色域可分
    const box = boxes[bi];
    const axis = bAxis;
    const sorted = [...box].sort((a, b) => a[axis] - b[axis]);
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
  }
  return boxes.filter(b => b.length > 0).map(box => {
    const sum = [0, 0, 0];
    for (const px of box) { sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; }
    return sum.map(s => Math.round(s / box.length));
  });
}

export function quantizeColor(frames, nColorsIn, dither) {
  const n = Math.max(2, Math.min(256, Math.round(nColorsIn)));
  const all = [];
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) all.push([d[i], d[i + 1], d[i + 2]]);
  }
  const palette = medianCut(all, n);

  if (dither === 'auto') {
    return { frames: frames.map(f => fsColor(f, palette)), palette };
  }
  if (dither === 'none') {
    return { frames: frames.map(f => mapNearest(f, palette)), palette };
  }
  // bayer：加性扰动 ±48 + 最近邻
  const { width: w, height: h } = frames[0];
  const out = [];
  for (const f of frames) {
    const src = f.data;
    const o = new Uint8ClampedArray(src.length);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const off = (bayerAt(y, x) - 0.5) * 96;
        const ci = nearestPalette([
          Math.max(0, Math.min(255, src[i] + off)),
          Math.max(0, Math.min(255, src[i + 1] + off)),
          Math.max(0, Math.min(255, src[i + 2] + off)),
        ], palette);
        o[i] = palette[ci][0]; o[i + 1] = palette[ci][1]; o[i + 2] = palette[ci][2]; o[i + 3] = 255;
      }
    }
    out.push(makeFrame(w, h, o));
  }
  return { frames: out, palette };
}
