// 渲染管线 —— 移植自 Python 基准版 apexoled/engine/__init__.py render()。
// 解码（decode.js）→ 预处理（logo/增强）→ 缩放 128×40 → 效果（仅静态）→ 量化。
// 导出与预览都只消费 render() 的结果，保证「预览即成品」。
import { WIDTH, HEIGHT, EngineError } from './core.js';
import { applyLogoWhiteBg, applyBwLogoThreshold, applyEnhance, scaleFrames } from './process.js';
import { parseEffectSpec, buildEffectFrames } from './effects.js';
import { quantizeBW, quantizeGray, quantizeColor } from './quantize.js';

export function makeRenderOptions(partial = {}) {
  return Object.assign({
    fps: 10,
    mode: 'cover',        // cover / fit
    bg: 'black',          // fit 模式背景色
    colors: 'bw',         // bw / gray / color
    palette: 256,         // 调色板颜色数 2~256
    dither: 'auto',       // auto / none / bayer
    crop: null,           // {w,h,x,y}
    logo: false,          // 白底 Logo 优化
    enhance: 'none',      // none / light / strong
    effect: null,         // 'wipe:l2r+fade'
    effectIn: 0.8,
    effectHold: 1.6,
    effectOut: 0.8,
    effectGap: 0.4,
    duration: null,
    maxFrames: null,
  }, partial);
}

export function validateOptions(opts) {
  if (!(1 <= Math.round(opts.fps) && Math.round(opts.fps) <= 60)) {
    throw new EngineError(`帧率必须在 1~60 之间（当前 ${opts.fps}）。`);
  }
  if (!['cover', 'fit'].includes(opts.mode)) {
    throw new EngineError(`适配模式仅支持 cover/fit（当前 ${opts.mode}）。`);
  }
  if (!['bw', 'gray', 'color'].includes(opts.colors)) {
    throw new EngineError(`色彩模式仅支持 bw/gray/color（当前 ${opts.colors}）。`);
  }
  if (!(2 <= Math.round(opts.palette) && Math.round(opts.palette) <= 256)) {
    throw new EngineError(`调色板颜色数必须在 2~256 之间（当前 ${opts.palette}）。`);
  }
  if (!['auto', 'none', 'bayer'].includes(opts.dither)) {
    throw new EngineError(`抖动仅支持 auto/none/bayer（当前 ${opts.dither}）。`);
  }
  if (!['none', 'light', 'strong'].includes(opts.enhance)) {
    throw new EngineError(`增强仅支持 none/light/strong（当前 ${opts.enhance}）。`);
  }
  if (opts.duration != null && opts.duration <= 0) {
    throw new EngineError('视频截取时长必须大于 0。');
  }
  if (opts.maxFrames != null && opts.maxFrames <= 0) {
    throw new EngineError('最多帧数必须大于 0。');
  }
}

// seq：decodeFile() 的输出 {frames, animated, source, warnings}
export function render(seq, opts) {
  validateOptions(opts);
  let frames = seq.frames;
  const warnings = [...seq.warnings];
  let animated = seq.animated;

  // 预处理（源分辨率）：白底 logo → 黑白 logo 阈值 → 锐化增强
  if (opts.logo) {
    frames = applyLogoWhiteBg(frames);
    if (opts.colors === 'bw') frames = applyBwLogoThreshold(frames);
  }
  if (opts.enhance !== 'none') frames = applyEnhance(frames, opts.enhance);

  // 缩放到 OLED 规格
  frames = scaleFrames(frames, opts.mode, opts.bg, WIDTH, HEIGHT);

  // 效果（F7.6：仅静态输入生效）
  let effectApplied = false;
  if (opts.effect && opts.effect !== 'none') {
    const [inSpec, outSpec] = parseEffectSpec(opts.effect);
    if (animated) {
      warnings.push('动画效果仅对静态图片生效，已忽略。');
    } else if (inSpec || outSpec) {
      const built = buildEffectFrames(frames[0], {
        inEffect: inSpec, outEffect: outSpec,
        inDuration: opts.effectIn, holdDuration: opts.effectHold,
        outDuration: opts.effectOut, gapDuration: opts.effectGap,
        fps: opts.fps,
      });
      frames = built.frames;
      animated = true;
      effectApplied = true;
      warnings.push(...built.warnings);
    }
  }

  // 量化（F4.3：黑白+logo 禁用抖动；效果时间轴 auto→bayer，动画平滑 + 体积可控）
  let palette = null;
  if (opts.colors === 'bw') {
    let d = opts.logo ? 'none' : opts.dither;
    if (effectApplied && d === 'auto') d = 'bayer';
    frames = quantizeBW(frames, d);
  } else if (opts.colors === 'gray') {
    frames = quantizeGray(frames, opts.palette, opts.dither);
  } else {
    const q = quantizeColor(frames, opts.palette, opts.dither);
    frames = q.frames;
    palette = q.palette;
  }

  return {
    frames, fps: opts.fps, animated, palette, warnings,
    effectApplied,
  };
}
