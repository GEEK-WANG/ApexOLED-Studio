// 解码层 —— 浏览器原生能力替代 Pillow/FFmpeg：
//   图片（png/jpg/bmp/webp/avif…）→ createImageBitmap
//   动图 GIF → ImageDecoder 逐帧 + _resample_frames 按帧率重采样（不支持时降级首帧）
//   视频 → <video> 按 10FPS 时间戳 seek + drawImage 抽帧（无需 FFmpeg）
// 产出统一 RGBA 帧序列（alpha 恒 255），语义对齐 Python 基准版 apexoled/decode/。
import { makeFrame, roundHalfEven, EngineError } from './core.js';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp', 'gif', 'apng', 'avif'];
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];

export function parseCrop(s) {
  const mm = (s || '').trim().match(/^(\d+)[xX](\d+)[+](\d+)[+](\d+)$/);
  if (!mm) throw new EngineError('--crop 格式应为 WxH+X+Y，例如 430x140+70+60（宽x高+左+上）。 / --crop format: WxH+X+Y, e.g. 430x140+70+60');
  return { w: +mm[1], h: +mm[2], x: +mm[3], y: +mm[4] };
}

export function checkCropBounds(crop, srcW, srcH) {
  if (crop.w <= 0 || crop.h <= 0) throw new EngineError('裁剪区域宽高必须大于 0。 / Crop width and height must be > 0.');
  if (crop.x + crop.w > srcW || crop.y + crop.h > srcH) {
    throw new EngineError(
      `裁剪区域超出图片范围：图片为 ${srcW}x${srcH}，而框选区域为 x:${crop.x} y:${crop.y} w:${crop.w} h:${crop.h}，请重新框选。 / Crop out of bounds: image is ${srcW}x${srcH}, selection x:${crop.x} y:${crop.y} w:${crop.w} h:${crop.h}.`);
  }
}

/* ---------------- 内部工具 ---------------- */

function canvasFrame(source, w, h, sx = 0, sy = 0, sw = w, sh = h) {
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; // 透明区域按黑色处理（对齐 OLED 黑底语义）
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return makeFrame(sw, sh, new Uint8ClampedArray(ctx.getImageData(0, 0, sw, sh).data));
}

function cropFrame(frame, crop) {
  const c = document.createElement('canvas');
  c.width = frame.width; c.height = frame.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  const out = document.createElement('canvas');
  out.width = crop.w; out.height = crop.h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(c, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return makeFrame(crop.w, crop.h, new Uint8ClampedArray(octx.getImageData(0, 0, crop.w, crop.h).data));
}

function forceOpaque(frame) {
  for (let i = 3; i < frame.data.length; i += 4) frame.data[i] = 255;
  return frame;
}

// 时间轴最近帧重采样（Python _resample_frames 逐行为移植）
function resampleFrames(frames, durationsMs, fps, maxFrames) {
  if (!durationsMs.length || durationsMs.every(d => d <= 0)) {
    durationsMs = durationsMs.map(() => 100);
  }
  durationsMs = durationsMs.map(d => d > 0 ? d : 100);
  const totalS = durationsMs.reduce((a, b) => a + b, 0) / 1000;
  const ticks = Math.max(1, roundHalfEven(totalS * fps));
  const bounds = [0];
  for (const d of durationsMs) bounds.push(bounds[bounds.length - 1] + d);
  const out = [];
  for (let k = 0; k < ticks; k++) {
    const tMs = k * 1000 / fps;
    // searchsorted(bounds, t, side='right') - 1
    let lo = 0, hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid] <= tMs) lo = mid; else hi = mid - 1;
    }
    const idx = Math.min(Math.max(lo, 0), frames.length - 1);
    out.push(frames[idx]);
  }
  return maxFrames ? out.slice(0, maxFrames) : out;
}

async function decodeAnimatedGif(file, fps) {
  // ImageDecoder：Chrome/Edge/Firefox 133+；Safari 走降级路径
  if (typeof ImageDecoder === 'undefined') return null;
  let dec;
  try {
    dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
    await dec.tracks.ready;
    await dec.completed.catch(() => {});
  } catch { return null; }
  const track = dec.tracks.selectedTrack;
  if (!track || !track.frameCount || track.frameCount < 2) return null;

  const frames = [], durations = [];
  let first = null;
  for (let i = 0; i < track.frameCount; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    if (!first) {
      first = { w: image.displayWidth, h: image.displayHeight };
    }
    durations.push(Math.max(0, (image.duration || 0) / 1000)); // µs → ms
    frames.push(canvasFrame(image, first.w, first.h));
    image.close();
  }
  return { frames, durations };
}

async function decodeVideo(file, fps, duration, maxFrames, crop) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new EngineError(`无法解码视频文件 ${file.name}（浏览器不支持的编码格式）。 / Cannot decode video ${file.name} (unsupported codec in this browser).`));
      setTimeout(() => reject(new EngineError('视频加载超时，请重试或换用 mp4/webm 格式。 / Video loading timed out; retry or use mp4/webm.')), 20000);
    });

    const end = duration ? Math.min(video.duration || duration, duration) : video.duration;
    if (!end || !isFinite(end)) throw new EngineError('无法读取视频时长信息。 / Cannot read video duration.');
    let ticks = Math.max(1, roundHalfEven(end * fps));
    if (maxFrames) ticks = Math.min(ticks, Math.max(1, Math.round(maxFrames)));

    let drawW = video.videoWidth, drawH = video.videoHeight;
    let sx = 0, sy = 0;
    if (crop) {
      checkCropBounds(crop, video.videoWidth, video.videoHeight);
      sx = crop.x; sy = crop.y; drawW = crop.w; drawH = crop.h;
    }

    const frames = [];
    const seek = t => new Promise((resolve, reject) => {
      let done = false;
      video.onseeked = () => { if (!done) { done = true; resolve(); } };
      video.currentTime = Math.min(Math.max(t, 0), Math.max(0, (video.duration || 0) - 0.011));
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 300); // 容错：seek 卡住也继续
    });
    for (let k = 0; k < ticks; k++) {
      await seek(k / fps);
      frames.push(forceOpaque(canvasFrame(video, drawW, drawH, sx, sy, drawW, drawH)));
    }
    if (!frames.length) throw new EngineError(`未能从视频 ${file.name} 中解码出任何帧。 / No frames decoded from ${file.name}.`);
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
  }
}

/* ---------------- 主入口 ---------------- */

// 返回 { frames, animated, source: 'image'|'anim'|'video', warnings }
export async function decodeFile(file, opts = {}) {
  const fps = opts.fps || 10;
  const duration = opts.duration || null;
  const maxFrames = opts.maxFrames || null;
  const crop = opts.crop || null;
  const warnings = [];

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isVideo = VIDEO_EXTS.includes(ext) ||
    (file.type && file.type.startsWith('video/'));
  const isGif = ext === 'gif' || file.type === 'image/gif';

  if (isVideo) {
    const frames = await decodeVideo(file, fps, duration, maxFrames, crop);
    return { frames, animated: frames.length > 1, source: 'video', warnings };
  }

  if (isGif) {
    const anim = await decodeAnimatedGif(file, fps);
    if (anim) {
      let frames = resampleFrames(anim.frames, anim.durations, fps, maxFrames);
      if (duration) frames = frames.slice(0, Math.max(1, roundHalfEven(duration * fps)));
      if (crop) {
        checkCropBounds(crop, frames[0].width, frames[0].height);
        frames = frames.map(f => cropFrame(f, crop));
      }
      frames = frames.map(forceOpaque);
      return { frames, animated: frames.length > 1, source: 'anim', warnings };
    }
    warnings.push('当前浏览器不支持 GIF 逐帧解码，已按静态图片处理（Chrome/Edge/Firefox 支持完整动图）。 / This browser cannot decode animated GIF frames; using the first frame only (Chrome/Edge/Firefox support full animation).');
  }

  // 静态图片（含 GIF 降级 / APNG 首帧）
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new EngineError(`无法读取图片文件 ${file.name}：文件损坏或格式不受支持。 / Cannot read image ${file.name}: corrupted or unsupported format.`);
    }
  }
  let frame = canvasFrame(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  if (crop) {
    checkCropBounds(crop, frame.width, frame.height);
    frame = cropFrame(frame, crop);
  }
  frame = forceOpaque(frame);
  return { frames: [frame], animated: false, source: 'image', warnings };
}
