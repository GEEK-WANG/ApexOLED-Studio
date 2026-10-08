// 8 类效果帧变换 + 注册表 + 四段时间轴 —— 逐行为移植自 Python 基准版
// apexoled/effects/transforms.py / __init__.py / timeline.py。
// 约定：frame 为 RGBA（效果仅改 RGB，alpha 恒 255），p 为该段进度 0~1。
import { blackFrame, cloneFrame, makeFrame, roundHalfEven, linspace, u8, EngineError } from './core.js';

export const WIPE_DIRECTIONS = ['l2r', 'r2l', 't2b', 'b2t', 'tl2br', 'tr2bl', 'bl2tr', 'br2tl'];
export const MAX_FRAMES = 60;

/* ---------------- 帧变换 ---------------- */

// 与 Python _clip(frame.astype(np.float32) * p) 对齐：float32 乘法 + 截断
//（np 的「弱标量」会把 p 压到 f32，逐元素积也按 f32 舍入，否则截断到 uint8 时会差 1）
function fadeF32(frame, p) {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  const m = Math.fround(p);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = u8(Math.fround(src[i] * m));
    out[i + 1] = u8(Math.fround(src[i + 1] * m));
    out[i + 2] = u8(Math.fround(src[i + 2] * m));
    out[i + 3] = 255;
  }
  return makeFrame(w, h, out);
}

export function fade(frame, p) {
  return fadeF32(frame, p);
}

// 时间轴段内 fade：Python 侧 p 来自 np.linspace（np.float64，NEP50 强标量，
// 把 f32 数组提升到 f64 运算后截断）——与直接调用 fade（Python float 弱标量 → f32）语义不同。
function fadeF64(frame, p) {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = u8(src[i] * p);
    out[i + 1] = u8(src[i + 1] * p);
    out[i + 2] = u8(src[i + 2] * p);
    out[i + 3] = 255;
  }
  return makeFrame(w, h, out);
}

export function wipe(frame, p, direction = 'l2r') {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  const wp = p * w, hp = p * h, dp = p * (w + h);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let m;
      switch (direction) {
        case 'l2r': m = x < wp; break;
        case 'r2l': m = x >= (1 - p) * w; break;
        case 't2b': m = y < hp; break;
        case 'b2t': m = y >= (1 - p) * h; break;
        case 'tl2br': m = (x + y) < dp; break;
        case 'tr2bl': m = ((w - 1 - x) + y) < dp; break;
        case 'bl2tr': m = (x + (h - 1 - y)) < dp; break;
        case 'br2tl': m = ((w - 1 - x) + (h - 1 - y)) < dp; break;
        default: throw new EngineError(`未知的擦除方向：${direction}（可选 ${WIPE_DIRECTIONS.join('/')}） / Unknown wipe direction: ${direction} (allowed ${WIPE_DIRECTIONS.join('/')})`);
      }
      out[i] = u8(src[i] * m);
      out[i + 1] = u8(src[i + 1] * m);
      out[i + 2] = u8(src[i + 2] * m);
      out[i + 3] = 255;
    }
  }
  return makeFrame(w, h, out);
}

// 缩放渐显：80% → 100% 居中，双线性采样（Python 用 PIL BILINEAR）
export function zoom(frame, p) {
  const { width: w, height: h, data: src } = frame;
  const s = 0.8 + 0.2 * p;
  const nw = Math.max(2, roundHalfEven(w * s));
  const nh = Math.max(2, roundHalfEven(h * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const x0 = Math.floor((w - nw) / 2), y0 = Math.floor((h - nh) / 2);
  for (let Y = 0; Y < nh; Y++) {
    const sy = (Y + 0.5) * h / nh - 0.5;
    const y1 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const fy = Math.max(0, Math.min(1, sy - y1));
    for (let X = 0; X < nw; X++) {
      const sx = (X + 0.5) * w / nw - 0.5;
      const x1 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const fx = Math.max(0, Math.min(1, sx - x1));
      const x2 = Math.min(w - 1, x1 + 1), y2 = Math.min(h - 1, y1 + 1);
      const i00 = (y1 * w + x1) * 4, i10 = (y1 * w + x2) * 4;
      const i01 = (y2 * w + x1) * 4, i11 = (y2 * w + x2) * 4;
      const o = ((y0 + Y) * w + (x0 + X)) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = u8(top + (bot - top) * fy);
      }
    }
  }
  return makeFrame(w, h, out);
}

export function blinds(frame, p, direction = 'h') {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  let band;
  if (direction === 'h') band = Math.max(2, Math.floor(h / 5));
  else if (direction === 'v') band = Math.max(2, Math.floor(w / 8));
  else throw new EngineError(`未知的百叶窗方向：${direction}（可选 h/v） / Unknown blinds direction: ${direction} (allowed h/v)`);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const m = ((direction === 'h' ? y : x) % band) < p * band ? 1 : 0;
      out[i] = u8(src[i] * m);
      out[i + 1] = u8(src[i + 1] * m);
      out[i + 2] = u8(src[i + 2] * m);
      out[i + 3] = 255;
    }
  }
  return makeFrame(w, h, out);
}

export function scanline(frame, p, direction = 't2b') {
  const { width: w, height: h, data: src } = frame;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const n = Math.trunc(p * h); // Python int() 截断
  if (direction === 't2b') {
    if (n > 0) out.set(src.subarray(0, n * w * 4), 0);
    if (n < h) { // 前端扫描线：整行高亮（Python out[n] = 255 是行广播）
      let o = n * w * 4;
      for (let x = 0; x < w; x++, o += 4) out[o] = out[o + 1] = out[o + 2] = 255;
    }
  } else if (direction === 'b2t') {
    if (n > 0) out.set(src.subarray((h - n) * w * 4), (h - n) * w * 4);
    if (n < h) {
      let o = (h - n - 1) * w * 4;
      for (let x = 0; x < w; x++, o += 4) out[o] = out[o + 1] = out[o + 2] = 255;
    }
  } else {
    throw new EngineError(`未知的扫描线方向：${direction}（可选 t2b/b2t） / Unknown scanline direction: ${direction} (allowed t2b/b2t)`);
  }
  return makeFrame(w, h, out);
}

// 像素化浮现：块中心取样（PIL NEAREST 语义）两步最近邻
export function pixelate(frame, p) {
  const { width: w, height: h, data: src } = frame;
  const b = Math.max(1, roundHalfEven(16 * (1 - p)));
  if (b === 1) return cloneFrame(frame);
  const nw = Math.max(1, Math.ceil(w / b)), nh = Math.max(1, Math.ceil(h / b));
  const small = new Uint8ClampedArray(nw * nh * 4);
  for (let Y = 0; Y < nh; Y++) {
    const sy = Math.min(h - 1, Math.floor((Y + 0.5) * h / nh));
    for (let X = 0; X < nw; X++) {
      const sx = Math.min(w - 1, Math.floor((X + 0.5) * w / nw));
      const s = (sy * w + sx) * 4, d = (Y * nw + X) * 4;
      small[d] = src[s]; small[d + 1] = src[s + 1]; small[d + 2] = src[s + 2]; small[d + 3] = 255;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(nh - 1, Math.floor((y + 0.5) * nh / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(nw - 1, Math.floor((x + 0.5) * nw / w));
      const s = (sy * nw + sx) * 4, d = (y * w + x) * 4;
      out[d] = small[s]; out[d + 1] = small[s + 1]; out[d + 2] = small[s + 2]; out[d + 3] = 255;
    }
  }
  return makeFrame(w, h, out);
}

export function breathing(frame, p) {
  const m = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(Math.PI * p));
  return fade(frame, m);
}

/* ---------------- 注册表 ---------------- */
// name → { fn, 默认方向, 允许方向集合 }
const REGISTRY = new Map();

function register(name, fn, defaultDirection = null, directions = []) {
  REGISTRY.set(name, { fn, defaultDirection, allowed: new Set(directions) });
}

register('fade', fade);
register('wipe', wipe, 'l2r', WIPE_DIRECTIONS);
register('reveal', wipe, 't2b', WIPE_DIRECTIONS); // v1.x 兼容：揭开 = 从上向下
register('zoom', zoom);
register('blinds', blinds, 'h', ['h', 'v']);
register('scanline', scanline, 't2b', ['t2b', 'b2t']);
register('pixelate', pixelate);
register('breathing', breathing);

export function effectNames() {
  return [...REGISTRY.keys()].sort();
}

// UI 下拉数据源
export function effectMeta() {
  const meta = {};
  for (const [name, { defaultDirection, allowed }] of REGISTRY) {
    meta[name] = { direction: defaultDirection, directions: [...allowed].sort() };
  }
  return meta;
}

function parseSingle(part) {
  const [nameRaw, dirRaw] = part.split(':');
  const name = nameRaw.trim().toLowerCase();
  const direction = dirRaw ? dirRaw.trim().toLowerCase() : null;
  if (!REGISTRY.has(name)) {
    throw new EngineError(`未知效果：${part}（可选 ${effectNames().join('/')}） / Unknown effect: ${part} (allowed ${effectNames().join('/')})`);
  }
  const entry = REGISTRY.get(name);
  let dir = direction;
  if (dir === null || dir === '') dir = entry.defaultDirection;
  else if (entry.allowed.size && !entry.allowed.has(dir)) {
    throw new EngineError(`效果 ${name} 不支持方向 ${dir}（可选 ${[...entry.allowed].sort().join('/')}） / Effect ${name} does not support direction ${dir} (allowed ${[...entry.allowed].sort().join('/')})`);
  }
  return { name, direction: dir };
}

// 'wipe:l2r+fade' → [入场, 退场]；单个效果时入场=退场
export function parseEffectSpec(s) {
  s = (s || '').trim();
  if (!s || s.toLowerCase() === 'none') return [null, null];
  const parts = s.split('+');
  if (parts.length > 2) {
    throw new EngineError('效果表达式最多包含 入场+退场 两个效果，如 wipe:l2r+fade。 / Effect expression may contain at most in+out effects, e.g. wipe:l2r+fade.');
  }
  const first = parseSingle(parts[0]);
  const second = parts.length === 2 ? parseSingle(parts[1]) : parseSingle(parts[0]);
  return [first, second];
}

export function applyEffect(spec, frame, p) {
  const entry = REGISTRY.get(spec.name);
  return entry.fn(frame, p, spec.direction ?? entry.defaultDirection);
}

/* ---------------- 四段时间轴 ---------------- */

function segFrames(seconds, fps) {
  return Math.max(0, roundHalfEven(seconds * fps));
}

export function buildEffectFrames(base, cfg) {
  // cfg: {inEffect, outEffect, inDuration, holdDuration, outDuration, gapDuration, fps}
  for (const k of ['inDuration', 'holdDuration', 'outDuration', 'gapDuration']) {
    if (cfg[k] < 0) throw new EngineError(`效果时长不能为负：${k}=${cfg[k]} / Effect durations must be non-negative: ${k}=${cfg[k]}`);
  }
  const fps = cfg.fps;
  let nIn = segFrames(cfg.inDuration, fps);
  let nHold = segFrames(cfg.holdDuration, fps);
  let nOut = segFrames(cfg.outDuration, fps);
  let nGap = segFrames(cfg.gapDuration, fps);
  const total = nIn + nHold + nOut + nGap;
  const warnings = [];
  if (total === 0) throw new EngineError('效果总时长为 0，请调大 进场/停留/退场/黑屏 时长。 / Total effect duration is 0; increase in/hold/out/gap.');
  if (total > MAX_FRAMES) {
    const scale = MAX_FRAMES / total;
    nIn = roundHalfEven(nIn * scale);
    nHold = roundHalfEven(nHold * scale);
    nOut = roundHalfEven(nOut * scale);
    nGap = MAX_FRAMES - nIn - nHold - nOut;
    warnings.push(`效果总帧数超过 ${MAX_FRAMES}，已按比例压缩为 ${MAX_FRAMES} 帧（${(MAX_FRAMES / fps).toFixed(1)} 秒）。 / Effect exceeds ${MAX_FRAMES} frames; compressed proportionally to ${MAX_FRAMES} (${(MAX_FRAMES / fps).toFixed(1)}s).`);
  }

  const frames = [];
  // 呼吸特例：入场与退场同为 breathing 时，整段（非黑屏）做正弦亮度起伏
  if (cfg.inEffect && cfg.outEffect &&
      cfg.inEffect.name === 'breathing' && cfg.outEffect.name === 'breathing') {
    const nVis = nIn + nHold + nOut;
    for (let t = 0; t < nVis; t++) {
      const u = nVis > 1 ? t / (nVis - 1) : 0.5;
      const m = 0.3 + 0.7 * Math.sin(Math.PI * u); // 暗 → 亮 → 暗 完整呼吸
      frames.push(fadeF32(base, m));
    }
    for (let t = 0; t < nGap; t++) frames.push(blackFrame(base.width, base.height));
    return { frames, warnings };
  }

  // 段内效果调度：fade 走 f64 语义（np.linspace 标量），其余效果 p 只参与掩码/取整，
  // f64 与 Python 一致，无需特判
  const applySeg = (spec, base, p) =>
    spec.name === 'fade' ? fadeF64(base, p) : applyEffect(spec, base, p);

  // 进场段
  if (cfg.inEffect) {
    const ps = nIn === 1 ? [1.0] : (nIn > 1 ? linspace(0.0, 1.0, nIn) : []);
    for (const p of ps) frames.push(applySeg(cfg.inEffect, base, p));
  }
  // 停留段
  for (let t = 0; t < nHold; t++) frames.push(base);
  // 退场段（p 从 1 → 0）
  if (cfg.outEffect) {
    const ps = nOut === 1 ? [0.0] : (nOut > 1 ? linspace(1.0, 0.0, nOut) : []);
    for (const p of ps) frames.push(applySeg(cfg.outEffect, base, p));
  }
  // 黑屏段
  for (let t = 0; t < nGap; t++) frames.push(blackFrame(base.width, base.height));
  return { frames, warnings };
}
