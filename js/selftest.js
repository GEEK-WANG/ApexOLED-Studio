// ApexOLED Studio v3 —— 引擎自检页逻辑（公开自检页，可直接访问 /selftest.html）。
// 四组检查：
//   一、与 Python 基准引擎逐像素对拍（selftest-fixtures.json，26 项）
//   二、行为断言（量化值域 / 缩放尺寸 / 时间轴与管线错误路径）
//   三、GIF 编码器：结构走查 + 浏览器 ImageDecoder 解码逐像素回读（LZW 仲裁）
//   四、导出格式：BMP 回读 / PNG 无损往返 / JPG 冒烟 / N1 取首帧规则
import * as core from './engine/core.js';
import {
  fade, wipe, zoom, blinds, scanline, pixelate, breathing,
  parseEffectSpec, buildEffectFrames, effectNames, WIPE_DIRECTIONS,
} from './engine/effects.js';
import { quantizeBW, quantizeGray, quantizeColor } from './engine/quantize.js';
import {
  parseBg, applyLogoWhiteBg, applyBwLogoThreshold, applyEnhance, scaleFrames,
} from './engine/process.js';
import { encodeGIF, encodeBMP, exportResult, defaultFormat } from './engine/export.js';
import { parseCrop, checkCropBounds } from './engine/decode.js';
import { makeRenderOptions, validateOptions, render } from './engine/pipeline.js';

const { makeFrame, roundHalfEven } = core;
const $ = id => document.getElementById(id);

/* ---------------- 通用工具 ---------------- */

// fixture JSON 帧（{w,h,rgb}）→ 引擎 RGBA 帧
function frameFromJson(j) {
  const n = j.w * j.h;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
    data[d] = j.rgb[s]; data[d + 1] = j.rgb[s + 1]; data[d + 2] = j.rgb[s + 2]; data[d + 3] = 255;
  }
  return makeFrame(j.w, j.h, data);
}

// 引擎帧 → fixture JSON 形状
function jsonOf(frame) {
  const n = frame.width * frame.height;
  const rgb = new Array(n * 3);
  for (let i = 0, s = 0, p = 0; i < n; i++, s += 3, p += 4) {
    rgb[s] = frame.data[p]; rgb[s + 1] = frame.data[p + 1]; rgb[s + 2] = frame.data[p + 2];
  }
  return { w: frame.width, h: frame.height, rgb };
}

// 逐像素比对（RGB vs fixture rgb，同时校验 alpha=255）。通过返回 null。
function compareFrame(got, exp, tol = 0) {
  if (got.width !== exp.w || got.height !== exp.h) {
    return `尺寸不符：期望 ${exp.w}×${exp.h}，实际 ${got.width}×${got.height}`;
  }
  const n = exp.w * exp.h, d = got.data;
  let maxDiff = 0, firstBad = null;
  for (let i = 0, s = 0, p = 0; i < n; i++, s += 3, p += 4) {
    if (d[p + 3] !== 255) return `像素 ${i}：alpha=${d[p + 3]}，应为 255`;
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(d[p + c] - exp.rgb[s + c]);
      if (diff > maxDiff) maxDiff = diff;
      if (diff > tol && firstBad === null) {
        firstBad = `像素 ${i}（x=${i % exp.w},y=${Math.floor(i / exp.w)}）RGB[${c}]：期望 ${exp.rgb[s + c]}，实际 ${d[p + c]}`;
      }
    }
  }
  return firstBad ? `${firstBad}（全图最大偏差 ${maxDiff}，容差 ${tol}）` : null;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function expectThrow(fn, sub) {
  try { fn(); } catch (e) {
    if (e && e.message && e.message.includes(sub)) return;
    throw new Error(`异常信息不符：${e && e.message ? e.message : e}`);
  }
  throw new Error('未按预期抛出异常');
}

async function expectReject(promise, sub) {
  try { await promise; } catch (e) {
    if (e && e.message && e.message.includes(sub)) return;
    throw new Error(`异常信息不符：${e && e.message ? e.message : e}`);
  }
  throw new Error('未按预期抛出异常');
}

async function bitmapToFrame(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const frame = makeFrame(c.width, c.height, new Uint8ClampedArray(ctx.getImageData(0, 0, c.width, c.height).data));
  if (bmp.close) bmp.close();
  return frame;
}

function uniqueColorCount(frame) {
  const u = new Set();
  for (let i = 0; i < frame.data.length; i += 4) {
    u.add((frame.data[i] << 16) | (frame.data[i + 1] << 8) | frame.data[i + 2]);
  }
  return u.size;
}

/* ---------------- GIF 结构走查（按规范逐块解析） ---------------- */

function parseGifStructure(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  const header = ascii(0, 6);
  const width = dv.getUint16(6, true), height = dv.getUint16(8, true);
  const packed = bytes[10];
  const gctCount = (packed & 0x80) ? (2 << (packed & 7)) : 0;
  let p = 13 + gctCount * 3;
  let frameCount = 0, delay = null, loop = null, netscape = false, trailer = false;
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3B) { trailer = true; break; }
    if (b === 0x21) { // 扩展块
      const label = bytes[p + 1];
      p += 2;
      const subs = [];
      while (p < bytes.length) {
        const len = bytes[p++];
        if (len === 0) break;
        subs.push(bytes.subarray(p, p + len));
        p += len;
      }
      if (label === 0xF9 && subs.length && subs[0].length === 4) {
        delay = subs[0][1] | (subs[0][2] << 8);
      } else if (label === 0xFF && subs.length >= 2 &&
                 String.fromCharCode(...subs[0]) === 'NETSCAPE2.0') {
        netscape = true;
        if (subs[1][0] === 0x01) loop = subs[1][1] | (subs[1][2] << 8);
      }
    } else if (b === 0x2C) { // 图像描述符（本编码器不写局部调色板）
      p += 10; // 0x2C + x(2) + y(2) + w(2) + h(2) + packed(1)
      p++; // LZW 最小码尺寸
      while (p < bytes.length) { const len = bytes[p++]; if (len === 0) break; p += len; }
      frameCount++;
    } else {
      throw new Error(`GIF 结构走查出未知块 0x${b.toString(16)} @${p}`);
    }
  }
  return { header, width, height, gctCount, frameCount, delay, loop, netscape, trailer };
}

async function decodeGifInBrowser(bytes) {
  if (typeof ImageDecoder === 'undefined') return null;
  const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
  try {
    await dec.tracks.ready;
    await dec.completed.catch(() => {});
    const track = dec.tracks.selectedTrack;
    if (!track || !track.frameCount) return null;
    const frames = [];
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = document.createElement('canvas');
      c.width = image.displayWidth; c.height = image.displayHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      frames.push(makeFrame(c.width, c.height, new Uint8ClampedArray(ctx.getImageData(0, 0, c.width, c.height).data)));
      image.close();
    }
    return { count: track.frameCount, frames };
  } finally {
    if (dec.close) dec.close();
  }
}

/* ---------------- BMP 回读 ---------------- */

function decodeBmp24(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = String.fromCharCode(bytes[0], bytes[1]);
  const size = dv.getUint32(2, true);
  const off = dv.getUint32(10, true);
  const hdrSize = dv.getUint32(14, true);
  const w = dv.getInt32(18, true), h = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // 自底向上
    let o = off + y * rowSize;
    for (let x = 0; x < w; x++) {
      const d = (srcY * w + x) * 4;
      data[d] = bytes[o + 2]; data[d + 1] = bytes[o + 1]; data[d + 2] = bytes[o];
      data[d + 3] = 255;
      o += 3;
    }
  }
  return { sig, size, off, hdrSize, w, h, bpp, frame: makeFrame(w, h, data) };
}

/* ---------------- 用例运行器 ---------------- */

let passed = 0, failed = 0;
const results = [];
const groupsDone = [];

function group(title) {
  const el = document.createElement('div');
  el.className = 'group';
  el.innerHTML = `<h3>${title}</h3>`;
  $('groups').appendChild(el);
  const g = { el, title, passed: 0, total: 0 };
  groupsDone.push(g);
  return g;
}

function updateSummary() {
  const s = $('summary');
  const total = passed + failed;
  s.className = failed ? 'bad' : 'ok';
  s.innerHTML = failed
    ? `通过 <b>${passed}</b> / ${total}，失败 <b>${failed}</b> 项`
    : `全部通过：<b>${passed}</b> / ${total} 项`;
}

async function case_(g, name, fn) {
  g.total++;
  const row = document.createElement('div');
  row.className = 'case';
  row.innerHTML = `<span class="mark">…</span><span class="name">${name}</span><span class="note"></span>`;
  g.el.appendChild(row);
  const mark = row.querySelector('.mark'), note = row.querySelector('.note');
  try {
    const r = await fn();
    g.passed++; passed++;
    row.classList.add('pass');
    mark.textContent = '✓';
    if (typeof r === 'string' && r) note.textContent = r;
  } catch (e) {
    failed++;
    row.classList.add('fail');
    mark.textContent = '✗';
    note.textContent = e && e.message ? e.message : String(e);
  }
  results.push({ name, pass: !row.classList.contains('fail'), note: note.textContent });
  updateSummary();
  return row.classList.contains('fail') ? null : true;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const doc = await (await fetch('selftest-fixtures.json', { cache: 'no-store' })).json();
  const A = frameFromJson(doc.frames.A), B = frameFromJson(doc.frames.B);

  /* ============ 一、Python 基准逐像素对拍 ============ */
  const g1 = group('一、Python 基准逐像素对拍');

  // 单帧变换用例分发表（与 tests/js_fixture_gen.py 一一对应）
  const SINGLE = {
    logo_white_bg: (A, B) => applyLogoWhiteBg([A])[0],
    bw_threshold: (A, B) => applyBwLogoThreshold([A])[0],
    quantize_bw_none: (A, B) => quantizeBW([A], 'none')[0],
    quantize_bw_bayer: (A, B) => quantizeBW([A], 'bayer')[0],
    quantize_gray4_none: (A, B) => quantizeGray([A], 4, 'none')[0],
    quantize_gray4_bayer: (A, B) => quantizeGray([A], 4, 'bayer')[0],
    quantize_gray7_none: (A, B) => quantizeGray([A], 7, 'none')[0],
    fade_p037: (A, B) => fade(B, 0.37),
    wipe_l2r_p05: (A, B) => wipe(B, 0.5, 'l2r'),
    wipe_r2l_p05: (A, B) => wipe(B, 0.5, 'r2l'),
    wipe_tl2br_p042: (A, B) => wipe(B, 0.42, 'tl2br'),
    reveal_t2b_p025: (A, B) => wipe(B, 0.25, 't2b'),
    blinds_h_p05: (A, B) => blinds(B, 0.5, 'h'),
    blinds_v_p03: (A, B) => blinds(B, 0.3, 'v'),
    scanline_t2b_p05: (A, B) => scanline(B, 0.5, 't2b'),
    scanline_b2t_p025: (A, B) => scanline(B, 0.25, 'b2t'),
    pixelate_p05: (A, B) => pixelate(B, 0.5),
    pixelate_b1: (A, B) => pixelate(B, 0.9375),
    breathing_p03: (A, B) => breathing(B, 0.3),
    zoom_p1: (A, B) => zoom(B, 1.0),
    zoom_p0: (A, B) => zoom(B, 0.0),
  };

  await case_(g1, 'fixture_manifest', () => {
    assert(doc.cases.length === 26, `用例数 ${doc.cases.length} ≠ 26`);
    assert(A.width === 16 && A.height === 6, `帧 A 尺寸 ${A.width}×${A.height}`);
    assert(B.width === 32 && B.height === 10, `帧 B 尺寸 ${B.width}×${B.height}`);
    // 抽查合成帧内容完整性（防 JSON 损坏）
    const i = (4 * 16 + 0) * 4; // A[4,0] = (119,120,121)
    assert(A.data[i] === 119 && A.data[i + 1] === 120 && A.data[i + 2] === 121,
      `A[4,0]=${A.data[i]},${A.data[i + 1]},${A.data[i + 2]}`);
    const j = (2 * 32 + 4) * 4; // B[2,4] = 白块 (255,255,255)
    assert(B.data[j] === 255 && B.data[j + 1] === 255 && B.data[j + 2] === 255, 'B 白块缺失');
    return '26 cases · 帧 A/B 完整';
  });

  for (const c of doc.cases) {
    if (SINGLE[c.name]) {
      await case_(g1, c.name, () => {
        const got = SINGLE[c.name](A, B);
        const diff = compareFrame(got, c.expect, c.tol || 0);
        if (diff) throw new Error(diff);
        return tol(c) ? `容差 ${c.tol} 内一致` : '逐像素一致';
      });
    } else if (c.timeline) {
      await case_(g1, c.name, () => {
        const tl = c.timeline;
        const [inSpec, outSpec] = parseEffectSpec(tl.effect);
        const built = buildEffectFrames(A, {
          inEffect: inSpec, outEffect: outSpec,
          inDuration: tl.in, holdDuration: tl.hold,
          outDuration: tl.out, gapDuration: tl.gap, fps: tl.fps,
        });
        assert(built.frames.length === c.expect_frames.length,
          `帧数不符：期望 ${c.expect_frames.length}，实际 ${built.frames.length}`);
        for (let i = 0; i < built.frames.length; i++) {
          const diff = compareFrame(built.frames[i], c.expect_frames[i], c.tol || 0);
          if (diff) throw new Error(`第 ${i} 帧：${diff}`);
        }
        assert(built.warnings.length === c.warnings,
          `警告数不符：期望 ${c.warnings}，实际 ${built.warnings.length}`);
        return `${built.frames.length} 帧 · ${built.warnings.length} 警告 · 全帧一致`;
      });
    } else {
      await case_(g1, `unhandled:${c.name}`, () => {
        throw new Error('分发表中没有该用例的实现');
      });
    }
  }

  /* ============ 二、行为断言 ============ */
  const g2 = group('二、行为断言');

  await case_(g2, 'round_half_even', () => {
    assert(roundHalfEven(0.5) === 0, `0.5 → ${roundHalfEven(0.5)}`);
    assert(roundHalfEven(1.5) === 2, `1.5 → ${roundHalfEven(1.5)}`);
    assert(roundHalfEven(2.5) === 2, `2.5 → ${roundHalfEven(2.5)}`);
    assert(roundHalfEven(3.5) === 4, `3.5 → ${roundHalfEven(3.5)}`);
    assert(roundHalfEven(2.4) === 2, `2.4 → ${roundHalfEven(2.4)}`);
    assert(roundHalfEven(2.6) === 3, `2.6 → ${roundHalfEven(2.6)}`);
  });

  await case_(g2, 'bw_auto_binary', () => {
    const f = quantizeBW([A], 'auto')[0];
    for (let i = 0; i < f.data.length; i += 4) {
      assert(f.data[i] === 0 || f.data[i] === 255, `FS 输出非二值 ${f.data[i]} @${i / 4}`);
    }
    return '输出 ∈ {0,255}';
  });

  await case_(g2, 'gray_auto_levels', () => {
    const f = quantizeGray([A], 4, 'auto')[0];
    const ok = new Set([0, 85, 170, 255]);
    for (let i = 0; i < f.data.length; i += 4) {
      assert(ok.has(f.data[i]), `FS 灰度输出越级 ${f.data[i]} @${i / 4}`);
    }
    return '输出 ⊆ {0,85,170,255}';
  });

  await case_(g2, 'color_none_unique', () => {
    const q = quantizeColor([B], 8, 'none');
    const u = uniqueColorCount(q.frames[0]);
    assert(u <= 8, `唯一色 ${u} > 8`);
    assert(q.palette.length <= 8, `调色板 ${q.palette.length} > 8`);
    return `唯一色 ${u}`;
  });

  await case_(g2, 'scale_cover_size', () => {
    const f = scaleFrames([B], 'cover', 'black', 128, 40)[0];
    assert(f.width === 128 && f.height === 40, `尺寸 ${f.width}×${f.height}`);
    for (let i = 3; i < f.data.length; i += 4) assert(f.data[i] === 255, 'alpha ≠ 255');
    return '128×40 · alpha 255';
  });

  await case_(g2, 'scale_fit_background', () => {
    const f = scaleFrames([A], 'fit', '#3366cc', 128, 40)[0];
    assert(f.width === 128 && f.height === 40, `尺寸 ${f.width}×${f.height}`);
    const px = (x, y) => { const i = (y * 128 + x) * 4; return [f.data[i], f.data[i + 1], f.data[i + 2]]; };
    const bg = [51, 102, 204];
    const c0 = px(0, 0), c1 = px(127, 39), cc = px(64, 20);
    assert(c0[0] === bg[0] && c0[1] === bg[1] && c0[2] === bg[2], `左上角 ${c0} ≠ 背景`);
    assert(c1[0] === bg[0] && c1[1] === bg[1] && c1[2] === bg[2], `右下角 ${c1} ≠ 背景`);
    assert(!(cc[0] === bg[0] && cc[1] === bg[1] && cc[2] === bg[2]), '中心不应是纯背景色');
    return 'fit 两侧露背景 #3366cc';
  });

  await case_(g2, 'enhance_light_bounded', () => {
    const f = applyEnhance([A], 'light')[0];
    assert(f.width === A.width && f.height === A.height, '尺寸改变');
    let changed = 0;
    for (let i = 0; i < f.data.length; i += 4) {
      assert(f.data[i + 3] === 255, 'alpha ≠ 255');
      if (f.data[i] !== A.data[i] || f.data[i + 1] !== A.data[i + 1] || f.data[i + 2] !== A.data[i + 2]) changed++;
    }
    assert(changed > 0, '锐化后画面无任何变化');
    return `${changed}/${A.width * A.height} 像素有变化`;
  });

  await case_(g2, 'enhance_strong_bounded', () => {
    const f = applyEnhance([A], 'strong')[0];
    assert(f.width === A.width && f.height === A.height, '尺寸改变');
    let changed = 0;
    for (let i = 0; i < f.data.length; i += 4) {
      assert(f.data[i] <= 255 && f.data[i] >= 0, '越界');
      if (f.data[i] !== A.data[i] || f.data[i + 1] !== A.data[i + 1] || f.data[i + 2] !== A.data[i + 2]) changed++;
    }
    assert(changed > 0, '强锐化后画面无任何变化');
    return `${changed}/${A.width * A.height} 像素有变化`;
  });

  await case_(g2, 'pipeline_static_bw', () => {
    const r = render({ frames: [A], animated: false, warnings: [] }, makeRenderOptions());
    assert(r.frames.length === 1, `帧数 ${r.frames.length}`);
    const f = r.frames[0];
    assert(f.width === 128 && f.height === 40, `尺寸 ${f.width}×${f.height}`);
    for (let i = 0; i < f.data.length; i += 4) {
      assert(f.data[i] === f.data[i + 1] && f.data[i] === f.data[i + 2], '黑白模式输出非灰');
      assert(f.data[i] === 0 || f.data[i] === 255, `非二值 ${f.data[i]}`);
    }
    assert(!r.animated && !r.effectApplied, 'animated/effectApplied 标记错误');
    assert(r.warnings.length === 0, `默认渲染不应有警告：${r.warnings}`);
    return '128×40 · 二值 · 0 警告';
  });

  await case_(g2, 'pipeline_anim_effect_ignored', () => {
    const r = render({ frames: [B, B], animated: true, warnings: [] }, makeRenderOptions({ effect: 'fade' }));
    assert(r.warnings.some(w => w.includes('仅对静态图片生效')), `缺少忽略警告：${r.warnings}`);
    assert(r.frames.length === 2, `帧数被改动：${r.frames.length}`);
    assert(r.animated && !r.effectApplied, '标记错误');
    return '动图输入效果被忽略 + 警告';
  });

  await case_(g2, 'pipeline_default_format', () => {
    assert(defaultFormat({ animated: true }) === 'gif', '动态默认应为 gif');
    assert(defaultFormat({ animated: false }) === 'png', '静态默认应为 png');
    return 'N1 联动：动态→gif / 静态→png';
  });

  await case_(g2, 'effect_registry', () => {
    const names = effectNames();
    assert(JSON.stringify(names) === JSON.stringify(
      ['blinds', 'breathing', 'fade', 'pixelate', 'reveal', 'scanline', 'wipe', 'zoom']),
      `注册表：${names.join(',')}`);
    assert(WIPE_DIRECTIONS.length === 8, `wipe 方向数 ${WIPE_DIRECTIONS.length}`);
    return `8 效果 · wipe 8 方向`;
  });

  // ---- 错误路径（对齐 Python 基准报错文案） ----
  await case_(g2, 'err_unknown_effect', () => expectThrow(() => parseEffectSpec('wat'), '未知效果'));
  await case_(g2, 'err_bad_direction', () => expectThrow(() => parseEffectSpec('blinds:x'), '不支持方向'));
  await case_(g2, 'err_too_many_effects', () => expectThrow(() => parseEffectSpec('fade+wipe+zoom'), '最多包含'));
  await case_(g2, 'err_bad_bg', () => expectThrow(() => parseBg('purple'), '无法识别的背景色'));
  await case_(g2, 'err_bad_crop_fmt', () => expectThrow(() => parseCrop('430x140'), '格式应为'));
  await case_(g2, 'err_crop_out_of_range', () =>
    expectThrow(() => checkCropBounds({ w: 10, h: 10, x: 20, y: 0 }, 16, 6), '裁剪区域超出'));
  await case_(g2, 'err_timeline_zero', () =>
    expectThrow(() => buildEffectFrames(A, {
      inEffect: { name: 'fade', direction: null }, outEffect: null,
      inDuration: 0, holdDuration: 0, outDuration: 0, gapDuration: 0, fps: 10,
    }), '总时长为 0'));
  await case_(g2, 'err_negative_duration', () =>
    expectThrow(() => buildEffectFrames(A, {
      inEffect: null, outEffect: null,
      inDuration: -1, holdDuration: 0, outDuration: 0, gapDuration: 0, fps: 10,
    }), '不能为负'));
  await case_(g2, 'err_fps_range', () =>
    expectThrow(() => validateOptions(makeRenderOptions({ fps: 0 })), '帧率必须'));
  await case_(g2, 'err_palette_range', () =>
    expectThrow(() => validateOptions(makeRenderOptions({ palette: 1 })), '调色板颜色数'));
  await case_(g2, 'err_gif_needs_multi_frame', () =>
    expectThrow(() => encodeGIF([A], 10), '不支持导出 GIF'));
  await case_(g2, 'err_static_gif_export', () =>
    expectReject(exportResult({ frames: [A], animated: false, fps: 10, palette: null }, 'gif'), '不支持导出 GIF'));
  await case_(g2, 'err_bad_export_format', () =>
    expectReject(exportResult({ frames: [A], animated: false, fps: 10, palette: null }, 'tiff'), '不支持的导出格式'));

  /* ============ 三、GIF 编码器实证 ============ */
  const g3 = group('三、GIF 编码器实证');

  // 彩色多帧（gctSize=256 路径）
  const [inSpec, outSpec] = parseEffectSpec('fade');
  const tlFrames = buildEffectFrames(A, {
    inEffect: inSpec, outEffect: outSpec,
    inDuration: 0.3, holdDuration: 0.2, outDuration: 0.1, gapDuration: 0.1, fps: 10,
  }).frames;
  const richBytes = encodeGIF(tlFrames, 10);

  await case_(g3, 'gif_structure_rich', () => {
    const s = parseGifStructure(richBytes);
    assert(s.header === 'GIF89a', `文件头 ${s.header}`);
    assert(s.width === 16 && s.height === 6, `画布 ${s.width}×${s.height}`);
    assert(s.frameCount === tlFrames.length, `帧数 ${s.frameCount} ≠ ${tlFrames.length}`);
    assert(s.delay === 10, `delay ${s.delay} ≠ 10（1/100s）`);
    assert(s.netscape && s.loop === 0, '缺少 NETSCAPE 无限循环');
    assert(s.trailer, '缺少 0x3B 结尾');
    const uniq = tlFrames.reduce((n, f) => Math.max(n, uniqueColorCount(f)), 0);
    assert(s.gctCount >= uniq, `GCT ${s.gctCount} 项 < 唯一色 ${uniq}`);
    return `${richBytes.length} B · GCT ${s.gctCount} · ${s.frameCount} 帧`;
  });

  await case_(g3, 'gif_browser_decode_rich', async () => {
    const dec = await decodeGifInBrowser(richBytes);
    if (!dec) throw new Error('当前浏览器不支持 ImageDecoder（需 Chrome/Edge/Firefox 133+）');
    assert(dec.count === tlFrames.length, `解码帧数 ${dec.count} ≠ ${tlFrames.length}`);
    for (let i = 0; i < tlFrames.length; i++) {
      const diff = compareFrame(dec.frames[i], jsonOf(tlFrames[i]), 0);
      if (diff) throw new Error(`第 ${i} 帧：${diff}`);
    }
    return `${dec.count} 帧逐像素还原一致（LZW 正确性由浏览器解码仲裁）`;
  });

  // 黑白 2 色（gctSize=2 路径，验证 GCT 大小字段）
  const bwFrames = quantizeBW(tlFrames, 'bayer');
  const bwBytes = encodeGIF(bwFrames, 10);

  await case_(g3, 'gif_structure_bw', () => {
    const s = parseGifStructure(bwBytes);
    assert(s.header === 'GIF89a', `文件头 ${s.header}`);
    assert(s.frameCount === bwFrames.length, `帧数 ${s.frameCount} ≠ ${bwFrames.length}`);
    assert(s.gctCount === 2, `GCT 应为 2 项，实际 ${s.gctCount}（大小字段错误）`);
    assert(s.delay === 10 && s.netscape && s.loop === 0 && s.trailer, 'delay/循环/结尾异常');
    return `${bwBytes.length} B · GCT ${s.gctCount}`;
  });

  await case_(g3, 'gif_browser_decode_bw', async () => {
    const dec = await decodeGifInBrowser(bwBytes);
    if (!dec) throw new Error('当前浏览器不支持 ImageDecoder');
    assert(dec.count === bwFrames.length, `解码帧数 ${dec.count} ≠ ${bwFrames.length}`);
    for (let i = 0; i < bwFrames.length; i++) {
      const diff = compareFrame(dec.frames[i], jsonOf(bwFrames[i]), 0);
      if (diff) throw new Error(`第 ${i} 帧：${diff}`);
    }
    return `${dec.count} 帧逐像素还原一致`;
  });

  /* ============ 四、导出格式 ============ */
  const g4 = group('四、导出格式');

  await case_(g4, 'bmp_roundtrip', () => {
    const bytes = encodeBMP(A);
    const r = decodeBmp24(bytes);
    assert(r.sig === 'BM', `签名 ${r.sig}`);
    assert(r.size === bytes.length, `size 字段 ${r.size} ≠ ${bytes.length}`);
    assert(r.w === 16 && r.h === 6 && r.bpp === 24, `头 ${r.w}×${r.h} ${r.bpp}bpp`);
    const diff = compareFrame(r.frame, jsonOf(A), 0);
    if (diff) throw new Error(diff);
    return `${bytes.length} B 逐像素一致`;
  });

  await case_(g4, 'png_roundtrip_lossless', async () => {
    const res = await exportResult({ frames: [A], animated: false, fps: 10, palette: null }, 'png');
    assert(res.filename === 'apexoled_oled.png', `文件名 ${res.filename}`);
    const f = await bitmapToFrame(await createImageBitmap(res.blob));
    const diff = compareFrame(f, jsonOf(A), 0);
    if (diff) throw new Error(diff);
    assert(res.notes.length === 0, `静态导 PNG 不应有提示：${res.notes}`);
    return `${res.size} B 无损`;
  });

  await case_(g4, 'jpg_smoke', async () => {
    const res = await exportResult({ frames: [A], animated: false, fps: 10, palette: null }, 'jpg', 92);
    assert(res.filename === 'apexoled_oled.jpg', `文件名 ${res.filename}`);
    assert(res.size > 0, '空文件');
    await createImageBitmap(res.blob); // 能解码即通过
    return `${res.size} B 可解码`;
  });

  await case_(g4, 'export_static_takes_first', async () => {
    const res = await exportResult({ frames: [A, B], animated: true, fps: 10, palette: null }, 'png');
    assert(res.notes.some(n => n.includes('取首帧')), `缺少取首帧提示：${res.notes}`);
    const f = await bitmapToFrame(await createImageBitmap(res.blob));
    const diff = compareFrame(f, jsonOf(A), 0);
    if (diff) throw new Error(`导出的不是首帧：${diff}`);
    return 'N1：动态导静态 = 首帧定格';
  });

  /* ============ 收尾 ============ */
  for (const g of groupsDone) {
    g.el.querySelector('h3').textContent = `${g.title} — ${g.passed}/${g.total}`;
  }
  window.__SELFTEST__ = { done: true, passed, failed, total: results.length, results };
  document.title = failed ? `自检：${failed} 项失败` : '自检：全部通过';
}

function tol(c) { return c.tol || 0; }

main().catch(err => {
  const s = $('summary');
  s.className = 'bad';
  s.textContent = `自检无法运行：${err && err.message ? err.message : err}（需通过 HTTP 服务访问，如 python -m http.server）`;
});
