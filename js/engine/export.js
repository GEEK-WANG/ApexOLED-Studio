// 导出层 —— GIF89a 自研编码器（LZW + 全局调色板 + 无限循环）+ BMP + PNG/JPG + 下载。
// 行为对齐 Python 基准版 apexoled/exporters/*：delay=1000/fps ms、loop=0、
// 动态→GIF、静态→PNG/JPG/BMP、多帧导静态取首帧。
import { makeFrame, roundHalfEven, EngineError } from './core.js';

export const FORMATS = ['gif', 'png', 'jpg', 'jpeg', 'bmp'];

export function defaultFormat(result) {
  return result.animated ? 'gif' : 'png';
}

/* ---------------- GIF89a 编码器 ---------------- */

function lzwEncode(minCodeSize, pixels) {
  // 经典 compress 派生实现（与 GIFCOMPR.C 同源）：写码后检查 next 槽位决定加宽
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let next = EOI + 1;

  const bytes = [];      // 输出字节流
  let acc = 0, bits = 0; // LSB-first 位缓冲
  const block = [];      // 当前子块（≤255 字节）

  const flushByte = () => {
    block.push(acc & 0xFF);
    acc >>>= 8; bits -= 8;
    if (block.length === 255) { bytes.push(255, ...block); block.length = 0; }
  };
  const write = (code, size) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) flushByte();
  };
  const endBlocks = () => {
    write(EOI, codeSize);
    if (bits > 0) { block.push(acc & 0xFF); acc = 0; bits = 0; }
    if (block.length) { bytes.push(block.length, ...block); block.length = 0; }
    bytes.push(0); // 子块终止符
  };

  const table = new Map();
  write(CLEAR, codeSize);
  let prefix = pixels[0];

  const resetTable = () => {
    table.clear();
    next = EOI + 1;
    codeSize = minCodeSize + 1;
  };

  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    write(prefix, codeSize);
    // 写完检查：已分配码数触顶当前位宽则加宽（12 位封顶）
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    if (next < 4096) {
      table.set(key, next++);
    } else {
      write(CLEAR, codeSize);
      resetTable();
    }
    prefix = k;
  }
  write(prefix, codeSize);
  endBlocks();
  return bytes;
}

function u16le(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }

function collectPalette(frames) {
  // 全帧唯一色（管线输出已 ≤256 色）；超限时用简单均匀量化兜底
  const uniq = new Map();
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      uniq.set((d[i] << 16) | (d[i + 1] << 8) | d[i + 2], [d[i], d[i + 1], d[i + 2]]);
    }
  }
  let colors = [...uniq.values()];
  if (colors.length > 256) {
    // 兜底：把每通道折半到 32 级（≈3 万色桶），再取前 256 个
    const folded = new Map();
    for (const c of colors) {
      const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
      if (!folded.has(key)) folded.set(key, c);
      if (folded.size === 256) break;
    }
    colors = [...folded.values()];
  }
  return colors;
}

function frameIndices(frame, palette) {
  const map = new Map();
  palette.forEach((c, i) => map.set((c[0] << 16) | (c[1] << 8) | c[2], i));
  const { width: w, data: d } = frame;
  const idx = new Uint8Array(w * frame.height);
  for (let i = 0, j = 0, p = 0; i < idx.length; i++, j += 4) {
    const key = (d[j] << 16) | (d[j + 1] << 8) | d[j + 2];
    let v = map.get(key);
    if (v === undefined) {
      // 精确色未入板（理论上不会发生）：最近邻
      let best = 0, bestD = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const dr = d[j] - palette[c][0], dg = d[j + 1] - palette[c][1], db = d[j + 2] - palette[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestD) { bestD = dist; best = c; }
      }
      v = best;
    }
    idx[p++] = v;
  }
  return idx;
}

export function encodeGIF(frames, fps, palette = null) {
  if (frames.length < 2) {
    throw new EngineError('纯静态内容不支持导出 GIF：请选择 PNG/JPG/BMP，或为静态图添加动画效果。');
  }
  const colors = palette && palette.length
    ? palette.map(c => Array.from(c))
    : collectPalette(frames);
  const gctSize = Math.max(2, 1 << Math.ceil(Math.log2(Math.max(2, colors.length))));
  const bpp = Math.log2(gctSize);
  const mcs = Math.max(2, bpp);

  const delay = Math.max(1, roundHalfEven(1000 / fps / 10)); // 1/100 秒
  const out = [];
  const push = (...a) => out.push(...a);

  // Header + Logical Screen Descriptor
  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  push(...u16le(frames[0].width), ...u16le(frames[0].height));
  push(0x80 | ((bpp - 1) << 4) | (bpp - 1), 0, 0); // GCT 标志 | 色深 | 表大小字段 N（表项数=2^(N+1)，故 N=bpp-1）
  // Global Color Table
  for (let i = 0; i < gctSize; i++) {
    const c = colors[i] || [0, 0, 0];
    push(c[0], c[1], c[2]);
  }
  // NETSCAPE 无限循环扩展（loop=0）
  push(0x21, 0xFF, 0x0B, ...Array.from('NETSCAPE2.0', ch => ch.charCodeAt(0)));
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const f of frames) {
    // Graphic Control Extension
    push(0x21, 0xF9, 0x04, 0x00, ...u16le(delay), 0x00, 0x00);
    // Image Descriptor
    push(0x2C, ...u16le(0), ...u16le(0), ...u16le(f.width), ...u16le(f.height), 0x00);
    push(mcs, ...lzwEncode(mcs, frameIndices(f, colors)));
  }
  push(0x3B); // Trailer
  return new Uint8Array(out);
}

/* ---------------- BMP（24 位） ---------------- */

export function encodeBMP(frame) {
  const { width: w, height: h, data } = frame;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowSize * h;
  const size = 54 + pixelBytes;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4D; // "BM"
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);   // 像素数据偏移
  dv.setUint32(14, 40, true);   // BITMAPINFOHEADER 大小
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);     // 正高 = 自底向上
  dv.setUint16(26, 1, true);    // planes
  dv.setUint16(28, 24, true);   // bpp
  dv.setUint32(30, 0, true);    // BI_RGB
  dv.setUint32(34, pixelBytes, true);
  dv.setInt32(38, 2835, true);  // 72 DPI
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // 自底向上
    let o = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      out[o++] = data[s + 2]; // B
      out[o++] = data[s + 1]; // G
      out[o++] = data[s];     // R
    }
  }
  return out;
}

/* ---------------- PNG / JPG（canvas 原生） ---------------- */

function frameToBlob(frame, type, quality) {
  const c = document.createElement('canvas');
  c.width = frame.width; c.height = frame.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return new Promise(resolve => c.toBlob(resolve, type, quality));
}

/* ---------------- 导出调度（N1 联动规则） ---------------- */

export async function exportResult(result, fmt, quality = 92, baseName = 'apexoled') {
  if (!fmt) fmt = defaultFormat(result);
  fmt = fmt.toLowerCase();
  if (!FORMATS.includes(fmt)) {
    throw new EngineError(`不支持的导出格式：${fmt}（可选 ${FORMATS.join('/')}）`);
  }
  const notes = [];
  let blob, ext = fmt === 'jpeg' ? 'jpg' : fmt;

  if (fmt === 'gif') {
    if (!result.animated) {
      throw new EngineError('纯静态内容不支持导出 GIF：请选择 PNG/JPG/BMP，或为静态图添加动画效果。');
    }
    const bytes = encodeGIF(result.frames, result.fps, result.palette);
    blob = new Blob([bytes], { type: 'image/gif' });
  } else {
    if (result.animated) notes.push('动态内容导出静态格式：已取首帧定格（建议改用 GIF）。');
    const first = result.frames[0];
    if (fmt === 'bmp') {
      blob = new Blob([encodeBMP(first)], { type: 'image/bmp' });
    } else if (fmt === 'png') {
      blob = await frameToBlob(first, 'image/png');
    } else { // jpg / jpeg
      blob = await frameToBlob(first, 'image/jpeg', Math.max(1, Math.min(100, Math.round(quality))) / 100);
    }
  }
  return { blob, filename: `${baseName}_oled.${ext}`, notes, size: blob.size };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
