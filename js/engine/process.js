// 帧级预处理 —— 移植自 Python 基准版 apexoled/engine/process.py
// 白底 Logo 优化（F4）/ 锐化增强（F5）/ cover-fit 缩放（F2.4）。
import { luma, makeFrame, roundHalfEven, u8, EngineError } from './core.js';

const BG_NAMES = {
  black: [0, 0, 0], white: [255, 255, 255], grey: [128, 128, 128], gray: [128, 128, 128],
  red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
};

export function parseBg(c) {
  c = (c || 'black').trim();
  const lower = c.toLowerCase();
  if (BG_NAMES[lower]) return BG_NAMES[lower];
  const s = c.startsWith('#') ? c.slice(1) : c;
  if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  throw new EngineError(`无法识别的背景色：${c}（支持 black/white/#RRGGBB）。`);
}

/* ---------------- F4 白底 Logo ---------------- */

// 接近白色（三通道均 ≥235）的背景压成黑色，彩色文字原样保留
export function applyLogoWhiteBg(frames) {
  return frames.map(f => {
    const src = f.data;
    const out = new Uint8ClampedArray(src);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i] >= 235 && out[i + 1] >= 235 && out[i + 2] >= 235) {
        out[i] = out[i + 1] = out[i + 2] = 0;
      }
    }
    return makeFrame(f.width, f.height, out);
  });
}

// 黑白模式逐通道阈值 120——任何亮通道拉白，暖色文字→白字黑底
export function applyBwLogoThreshold(frames) {
  return frames.map(f => {
    const src = f.data;
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      out[i] = src[i] >= 120 ? 255 : 0;
      out[i + 1] = src[i + 1] >= 120 ? 255 : 0;
      out[i + 2] = src[i + 2] >= 120 ? 255 : 0;
      out[i + 3] = 255;
    }
    return makeFrame(f.width, f.height, out);
  });
}

/* ---------------- F5 锐化增强 ---------------- */

// 三次盒式模糊逼近高斯（Kovesi boxes-for-gauss），等效 PIL GaussianBlur(radius=σ)
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes.map(s => Math.max(1, (s - 1) >> 1));
}

function boxBlurH(src, w, h, r) {
  const out = new Float64Array(src.length);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + Math.max(0, Math.min(w - 1, x + k))];
      out[row + x] = acc * norm;
    }
  }
  return out;
}

function boxBlurV(src, w, h, r) {
  const out = new Float64Array(src.length);
  const norm = 1 / (r * 2 + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[Math.max(0, Math.min(h - 1, y + k)) * w + x];
      out[y * w + x] = acc * norm;
    }
  }
  return out;
}

function gaussianBlurChannel(ch, w, h, sigma) {
  const radii = boxesForGauss(sigma, 3);
  let cur = Float64Array.from(ch);
  for (const r of radii) {
    cur = boxBlurV(boxBlurH(cur, w, h, r), w, h, r);
  }
  return cur;
}

function unsharpChannel(ch, w, h, sigma, percent, threshold) {
  const blurred = gaussianBlurChannel(ch, w, h, sigma);
  const out = new Float64Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const diff = ch[i] - blurred[i];
    out[i] = Math.abs(diff) < threshold ? ch[i] : u8(ch[i] + diff * percent / 100);
  }
  return out;
}

export function applyEnhance(frames, level) {
  return frames.map(f => {
    const { width: w, height: h, data: src } = f;
    const n = w * h;
    const R = new Float64Array(n), G = new Float64Array(n), B = new Float64Array(n);
    const L = new Float64Array(n);
    let lumaSum = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      R[i] = src[j]; G[i] = src[j + 1]; B[i] = src[j + 2];
      L[i] = luma(src[j], src[j + 1], src[j + 2]);
      lumaSum += L[i];
    }
    let r, g, b, contrastF, colorF;
    if (level === 'light') {
      r = unsharpChannel(R, w, h, 2, 60, 2);
      g = unsharpChannel(G, w, h, 2, 60, 2);
      b = unsharpChannel(B, w, h, 2, 60, 2);
      contrastF = 1.06; colorF = 1.05;
    } else { // strong
      r = unsharpChannel(R, w, h, 3, 110, 2);
      g = unsharpChannel(G, w, h, 3, 110, 2);
      b = unsharpChannel(B, w, h, 3, 110, 2);
      contrastF = 1.12; colorF = 1.10;
    }
    // ImageEnhance.Contrast：向整图 L 亮度的均值靠拢
    const mean = lumaSum / n;
    // ImageEnhance.Color：向逐像素灰度靠拢
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let vr = u8(r[i] * contrastF + mean * (1 - contrastF));
      let vg = u8(g[i] * contrastF + mean * (1 - contrastF));
      let vb = u8(b[i] * contrastF + mean * (1 - contrastF));
      vr = u8(L[i] + (vr - L[i]) * colorF);
      vg = u8(L[i] + (vg - L[i]) * colorF);
      vb = u8(L[i] + (vb - L[i]) * colorF);
      if (level === 'strong') {
        // point 曲线：int(255 * (v/255)^0.95 + 0.5)
        vr = Math.floor(255 * Math.pow(vr / 255, 0.95) + 0.5);
        vg = Math.floor(255 * Math.pow(vg / 255, 0.95) + 0.5);
        vb = Math.floor(255 * Math.pow(vb / 255, 0.95) + 0.5);
      }
      out[j] = u8(vr); out[j + 1] = u8(vg); out[j + 2] = u8(vb); out[j + 3] = 255;
    }
    return makeFrame(w, h, out);
  });
}

/* ---------------- F2.4 cover / fit 缩放 ---------------- */

// 大比例缩小时逐级减半再精缩（保证下采样质量），模拟 PIL LANCZOS 的观感
function canvasToFrame(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return makeFrame(canvas.width, canvas.height, new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
}

function frameToCanvas(frame) {
  const c = document.createElement('canvas');
  c.width = frame.width; c.height = frame.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return c;
}

function resizeCanvas(srcCanvas, nw, nh) {
  let cur = srcCanvas;
  // 逐级减半（目标 < 当前/2 时），提高下采样质量
  while (cur.width > nw * 2 && cur.height > nh * 2) {
    const half = document.createElement('canvas');
    half.width = Math.max(nw, Math.floor(cur.width / 2));
    half.height = Math.max(nh, Math.floor(cur.height / 2));
    const hctx = half.getContext('2d');
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = document.createElement('canvas');
  out.width = nw; out.height = nh;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, nw, nh);
  return out;
}

export function scaleFrames(frames, mode, bg, W, H) {
  const bgRgb = parseBg(bg);
  return frames.map(f => {
    const src = frameToCanvas(f);
    const w = f.width, h = f.height;
    if (mode === 'cover') {
      const s = Math.max(W / w, H / h);
      const nw = Math.max(1, roundHalfEven(w * s));
      const nh = Math.max(1, roundHalfEven(h * s));
      const resized = resizeCanvas(src, nw, nh);
      const x0 = Math.floor((nw - W) / 2), y0 = Math.floor((nh - H) / 2);
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const ctx = out.getContext('2d');
      ctx.drawImage(resized, x0, y0, W, H, 0, 0, W, H);
      return canvasToFrame(out);
    }
    // fit：等比完整显示 + 背景色
    const s = Math.min(W / w, H / h);
    const nw = Math.max(1, roundHalfEven(w * s));
    const nh = Math.max(1, roundHalfEven(h * s));
    const resized = resizeCanvas(src, nw, nh);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = `rgb(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]})`;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(resized, Math.floor((W - nw) / 2), Math.floor((H - nh) / 2));
    return canvasToFrame(out);
  });
}
