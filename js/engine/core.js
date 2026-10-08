// ApexOLED Studio v3 —— 引擎核心：常量、帧结构、数值工具。
// 帧约定：{width, height, data: Uint8ClampedArray}，RGBA 排列，alpha 恒为 255
//（色彩运算只作用于 RGB，与 Python 基准版的 RGB numpy 帧语义一致）。

export const APP_NAME = 'ApexOLED Studio';
export const VERSION = '3.0.0a1';

// 赛睿 Apex Pro TKL OLED 屏硬性规格
export const WIDTH = 128;
export const HEIGHT = 40;
export const DEFAULT_FPS = 10;

export function makeFrame(w, h, data) {
  return { width: w, height: h, data };
}

export function cloneFrame(f) {
  return { width: f.width, height: f.height, data: new Uint8ClampedArray(f.data) };
}

// 全黑帧（alpha 不透明）
export function blackFrame(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return makeFrame(w, h, d);
}

// Python round()：四舍六入五成双（np.round 同义），帧数/尺寸等所有移植点必须用它
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

// np.linspace(start, stop, n)，n===1 时返回 [start]
export function linspace(start, stop, n) {
  if (n <= 0) return [];
  if (n === 1) return [start];
  const out = new Array(n);
  const step = (stop - start) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = start + step * i;
  out[n - 1] = stop; // 终点对齐
  return out;
}

// ITU-R 601-2 亮度（与 Python 基准 _luma 的整数截断一致）
export function luma(r, g, b) {
  return Math.floor((r * 299 + g * 587 + b * 114) / 1000);
}

// np.clip(v,0,255).astype(uint8)：先夹紧再截断
export function u8(v) {
  v = +v;
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return v | 0;
}

// 灰度单通道 → 三通道复制（与 _expand_gray 一致），alpha 置 255
export function expandGray(g, w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = g[i];
    d[j + 3] = 255;
  }
  return makeFrame(w, h, d);
}

export class EngineError extends Error {
  constructor(msg) { super(msg); this.name = 'EngineError'; }
}
