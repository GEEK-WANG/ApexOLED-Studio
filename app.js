// ApexOLED Studio v3 —— UI 控制器（原生 JS，零依赖）
import { VERSION, WIDTH, HEIGHT, EngineError } from './js/engine/core.js';
import { decodeFile } from './js/engine/decode.js';
import { render, makeRenderOptions, validateOptions } from './js/engine/pipeline.js';
import { effectMeta, parseEffectSpec } from './js/engine/effects.js';
import { defaultFormat, exportResult, downloadBlob, formatBytes, FORMATS } from './js/engine/export.js';
import { t, getLang, onLangChange, initLang } from './js/i18n.js';
import { getSavedAddress, saveAddress, readAddressFromCoreProps, registerApp, pushFrame } from './js/gamesense.js';

const $ = id => document.getElementById(id);

const state = {
  file: null,
  seq: null,          // decodeFile 输出
  opts: makeRenderOptions(),
  result: null,       // render 输出
  crop: null,         // {x,y,w,h} 源图像素
  playing: false,
  playTimer: null,
  frameIdx: 0,
  renderToken: 0,     // 异步竞态保护
  lastStats: null,
  gs: { status: 'gsIdle', msg: null, ok: false, sending: false }, // GameSense 直连状态
};

/* ---------------- 通用 UI ---------------- */

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 2600);
}

function showWarnings(warnings) {
  const card = $('warn-card');
  if (!warnings.length) { card.hidden = true; return; }
  $('warn-area').innerHTML = warnings
    .map(w => `<div class="warn-item">${w.replace(/</g, '&lt;')}</div>`).join('');
  card.hidden = false;
}

function setStats(html) { $('render-stats').innerHTML = html; }

/* ---------------- 效果 UI ---------------- */

const CHIPS = [
  { key: 'effNone', value: null },
  { key: 'effBreathing', value: 'breathing' },
  { key: 'effFade', value: 'fade' },
  { key: 'effWipeL2r', value: 'wipe:l2r' },
  { key: 'effWipeT2b', value: 'wipe:t2b' },
  { key: 'effRevealT2b', value: 'reveal:t2b' },
  { key: 'effZoom', value: 'zoom' },
  { key: 'effBlinds', value: 'blinds' },
  { key: 'effScanline', value: 'scanline' },
  { key: 'effPixelate', value: 'pixelate' },
];

function buildEffectUI() {
  const chips = $('effect-chips');
  chips.innerHTML = ''; // 切换语言时重建，先清空
  for (const c of CHIPS) {
    const b = document.createElement('button');
    b.textContent = t(c.key);
    b.dataset.value = c.value ?? '';
    b.onclick = () => {
      state.opts.effect = c.value;
      syncEffectDropdowns();
      scheduleRender();
    };
    chips.appendChild(b);
  }

  const meta = effectMeta();
  const names = ['none', ...Object.keys(meta).sort()];
  for (const sel of [$('sel-eff-in'), $('sel-eff-out')]) {
    sel.innerHTML = names.map(n =>
      `<option value="${n}">${t(n)}</option>`).join('');
    sel.onchange = () => { syncEffectFromDropdowns(); scheduleRender(); };
  }
  for (const sel of [$('sel-eff-in-dir'), $('sel-eff-out-dir')]) {
    sel.onchange = () => { syncEffectFromDropdowns(); scheduleRender(); };
  }
}

function dirOptions(directions) {
  return directions.map(d => `<option value="${d}">${t(d)}</option>`).join('');
}

function syncEffectDropdowns() {
  // chips → 下拉
  const [inSpec, outSpec] = parseEffectSpec(state.opts.effect || 'none');
  const meta = effectMeta();
  const inSel = $('sel-eff-in'), outSel = $('sel-eff-out');
  inSel.value = inSpec ? inSpec.name : 'none';
  outSel.value = outSpec ? outSpec.name : 'none';
  for (const [sel, spec] of [[inSel, inSpec], [outSel, outSpec]]) {
    const dirSel = sel.id.endsWith('in') ? $('sel-eff-in-dir') : $('sel-eff-out-dir');
    if (spec && meta[spec.name].directions.length) {
      dirSel.innerHTML = dirOptions(meta[spec.name].directions);
      dirSel.value = spec.direction;
      dirSel.disabled = false;
    } else {
      dirSel.innerHTML = '<option value="">—</option>';
      dirSel.disabled = true;
    }
  }
  // chips 高亮
  const chips = [...$('effect-chips').children];
  const effStr = state.opts.effect || '';
  let matched = false;
  for (const b of chips) {
    const v = b.dataset.value || '';
    const on = (v === '' && !effStr) || (v !== '' && v === effStr);
    b.classList.toggle('on', on);
    b.classList.remove('custom');
    if (on) matched = true;
  }
  if (!matched) {
    // 自定义组合：第一枚显示为「自定义」态
    const first = chips[0];
    first.classList.add('custom');
    first.classList.remove('on');
  }
}

function syncEffectFromDropdowns() {
  const inName = $('sel-eff-in').value;
  const outName = $('sel-eff-out').value;
  const meta = effectMeta();
  const mk = name => {
    if (name === 'none') return null;
    const dir = meta[name].directions.length
      ? (document.querySelector(`#${name === inName ? 'sel-eff-in-dir' : 'sel-eff-out-dir'}`)?.value || meta[name].direction)
      : null;
    return dir ? `${name}:${dir}` : name;
  };
  const inPart = mk(inName), outPart = mk(outName);
  if (!inPart && !outPart) state.opts.effect = null;
  else if (inPart && outPart) state.opts.effect = `${inPart}+${outPart}`;
  else state.opts.effect = inPart || outPart;
  syncEffectDropdowns();
}

/* ---------------- 渲染循环 ---------------- */

// needsDecode：crop / fps / 视频时长 / 最多帧数 变更需要重新解码，其余只重渲染
function requestRender(needsDecode = false) {
  clearTimeout(requestRender._t);
  requestRender._t = setTimeout(() => {
    if (!state.file) return;
    if (needsDecode) decodeAndRender();
    else renderOnly();
  }, 120);
}
// 兼容旧名
const scheduleRender = () => requestRender(false);

async function decodeAndRender() {
  const token = ++state.renderToken;
  const file = state.file;
  if (!file) return;

  setStats(t('decoding'));
  try {
    const seq = await decodeFile(file, {
      fps: state.opts.fps,
      duration: readNum('in-duration'),
      maxFrames: readNum('in-maxframes'),
      crop: state.crop,
    });
    if (token !== state.renderToken) return;
    state.seq = seq;
    renderOnly();
  } catch (err) {
    if (token !== state.renderToken) return;
    state.seq = null;
    state.result = null;
    setStats('—');
    toast(err.message || String(err), 'err');
    showWarnings([]);
    updateExportUI();
  }
}

function renderOnly() {
  const seq = state.seq;
  if (!seq) return;
  const token = ++state.renderToken;
  const t0 = performance.now();
  try {
    validateOptions(state.opts);
    const result = render(seq, state.opts);
    if (token !== state.renderToken) return;
    state.result = result;
    state.frameIdx = 0;
    drawFrame(0);
    if (result.frames.length > 1) startPlay(); else stopPlay();
    const dt = Math.round(performance.now() - t0);
    state.lastStats = { frames: result.frames.length, fps: state.opts.fps, dt };
    setStats(statsHtml(state.lastStats));
    showWarnings(result.warnings);
    updateExportUI();
  } catch (err) {
    if (token !== state.renderToken) return;
    setStats('—');
    toast(err.message || String(err), 'err');
  }
}

function readNum(id) {
  const v = $(id).value;
  return v === '' || v == null ? null : Number(v);
}

function statsHtml(s) {
  const dim = `${WIDTH}×${HEIGHT}`;
  return getLang() === 'zh'
    ? `${dim} · <b>${s.frames}</b> 帧 · ${s.fps} FPS · 渲染 <b>${s.dt}</b> ms`
    : `${dim} · <b>${s.frames}</b> frames · ${s.fps} FPS · rendered in <b>${s.dt}</b> ms`;
}

/* ---------------- 预览播放器 ---------------- */

function drawFrame(idx) {
  const r = state.result;
  if (!r) return;
  const f = r.frames[idx];
  const c1 = $('oled-1x');
  const ctx1 = c1.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);
  ctx1.putImageData(img, 0, 0);
  const c4 = $('oled-4x');
  const ctx4 = c4.getContext('2d');
  ctx4.imageSmoothingEnabled = false;
  ctx4.drawImage(c1, 0, 0, c4.width, c4.height);
  $('frame-pos').textContent = `${idx + 1} / ${r.frames.length}`;
  state.frameIdx = idx;
}

function stopPlay() {
  state.playing = false;
  clearInterval(state.playTimer);
  state.playTimer = null;
  $('btn-play').textContent = t('play');
}

function startPlay() {
  const r = state.result;
  if (!r || r.frames.length < 2) return;
  stopPlay(); // 先清旧计时器：素材/参数切换会重建播放，防止多计时器叠跑取模错帧
  state.playing = true;
  $('btn-play').textContent = t('pause');
  state.playTimer = setInterval(() => {
    drawFrame((state.frameIdx + 1) % r.frames.length);
  }, 1000 / r.fps);
}

$('btn-play').onclick = () => state.playing ? stopPlay() : startPlay();
$('btn-prev').onclick = () => { if (state.result) drawFrame((state.frameIdx - 1 + state.result.frames.length) % state.result.frames.length); };
$('btn-next').onclick = () => { if (state.result) drawFrame((state.frameIdx + 1) % state.result.frames.length); };

/* ---------------- 文件载入 ---------------- */

function updateCropVal() {
  const c = state.crop;
  if (!c) { $('crop-val').textContent = t('cropNone'); return; }
  const ratio = (c.w / c.h).toFixed(2);
  const hint = Math.abs(c.w / c.h - 3.2) < 0.15 ? t('cropRatioOk') : '';
  $('crop-val').innerHTML = `x:${c.x} y:${c.y} w:${c.w} h:${c.h} <code>${ratio}:1</code> ${hint}`;
}

async function loadFile(file) {
  if (!file) return;
  stopPlay(); // 切素材即停播，防止解码期间旧计时器空转
  state.file = file;
  state.crop = null;
  updateCropVal();
  state.seq = null;
  state.result = null;
  state.renderToken++;

  const isVideo = /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name) ||
    (file.type && file.type.startsWith('video/'));
  $('video-opts').hidden = !isVideo;

  const kb = formatBytes(file.size);
  $('src-info').hidden = false;
  $('src-info').innerHTML = `<b>${escapeHtml(file.name)}</b> · ${kb}`;
  $('crop-wrap').hidden = isVideo; // 视频框选成本高，隐藏源图框选
  if (!isVideo) await setupCropCanvas(file);

  await decodeAndRender();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bindDropzone() {
  const dz = $('dropzone');
  const fi = $('file-input');
  dz.onclick = () => fi.click();
  fi.onchange = () => { loadFile(fi.files[0]); fi.value = ''; };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => {
    e.preventDefault();
    dz.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  };
  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => e.preventDefault();
}

/* ---------------- 源图框选 ---------------- */

const cropUI = { frame: null, scale: 1, dragging: false, x0: 0, y0: 0 };

async function setupCropCanvas(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    cropUI.frame = { width: bitmap.width, height: bitmap.height };
    const c = $('crop-canvas');
    const maxW = Math.min(760, bitmap.width);
    cropUI.scale = maxW / bitmap.width;
    c.width = maxW;
    c.height = Math.max(1, Math.round(bitmap.height * cropUI.scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    cropUI.bitmap = bitmap;
  } catch {
    cropUI.frame = null;
  }
}

function cropPoint(e) {
  const c = $('crop-canvas');
  const rect = c.getBoundingClientRect();
  const scaleC = c.width / rect.width;
  return {
    x: Math.max(0, Math.min(c.width, (e.clientX - rect.left) * scaleC)),
    y: Math.max(0, Math.min(c.height, (e.clientY - rect.top) * scaleC)),
  };
}

function drawCropOverlay(x0, y0, x1, y1) {
  const c = $('crop-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (cropUI.bitmap) ctx.drawImage(cropUI.bitmap, 0, 0, c.width, c.height);
  if (x0 == null) return;
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  ctx.fillStyle = 'rgba(255,122,26,.18)';
  ctx.strokeStyle = '#ff7a1a';
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
}

function bindCrop() {
  const c = $('crop-canvas');
  const down = e => {
    if (!cropUI.frame) return;
    e.preventDefault();
    const p = cropPoint(e);
    cropUI.dragging = true;
    cropUI.x0 = p.x; cropUI.y0 = p.y;
  };
  const move = e => {
    if (!cropUI.dragging) return;
    e.preventDefault();
    const p = cropPoint(e);
    drawCropOverlay(cropUI.x0, cropUI.y0, p.x, p.y);
  };
  const up = e => {
    if (!cropUI.dragging) return;
    cropUI.dragging = false;
    const p = cropPoint(e);
    const sx = cropUI.x0, sy = cropUI.y0;
    if (Math.abs(p.x - sx) < 4 || Math.abs(p.y - sy) < 4) {
      // 视作单击：清除框选
      drawCropOverlay(null);
      state.crop = null;
      updateCropVal();
      requestRender(true);
      return;
    }
    const fx = (r, key) => Math.round(r / cropUI.scale);
    const x = Math.round(Math.min(sx, p.x) / cropUI.scale);
    const y = Math.round(Math.min(sy, p.y) / cropUI.scale);
    const w = Math.max(1, fx(Math.max(sx, p.x)) - x);
    const h = Math.max(1, fx(Math.max(sy, p.y)) - y);
    state.crop = { x, y, w, h };
    updateCropVal();
    requestRender(true);
  };
  c.addEventListener('pointerdown', down);
  c.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  $('btn-crop-clear').onclick = () => {
    state.crop = null;
    drawCropOverlay(null);
    updateCropVal();
    requestRender(true);
  };
}

/* ---------------- 参数绑定 ---------------- */

function bindSeg(id, key, cb) {
  const seg = $(id);
  seg.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      state.opts[key] = b.dataset.v;
      cb && cb();
      scheduleRender();
    };
  });
}

function bindParams() {
  bindSeg('seg-colors', 'colors', updateExportUI);
  bindSeg('seg-mode', 'mode');

  $('sel-bg').onchange = e => { state.opts.bg = e.target.value; scheduleRender(); };
  $('sel-enhance').onchange = e => { state.opts.enhance = e.target.value; scheduleRender(); };
  $('sel-dither').onchange = e => { state.opts.dither = e.target.value; scheduleRender(); };
  $('chk-logo').onchange = e => { state.opts.logo = e.target.checked; scheduleRender(); };

  const palette = $('rg-palette');
  palette.oninput = () => {
    $('out-palette').textContent = palette.value;
    state.opts.palette = +palette.value;
    scheduleRender();
  };

  const fps = $('rg-fps');
  fps.oninput = () => {
    $('out-fps').textContent = fps.value;
    state.opts.fps = +fps.value;
    requestRender(true); // 帧率影响解码重采样
  };

  for (const [id, key, out] of [
    ['rg-tin', 'effectIn', 'm-in'], ['rg-thold', 'effectHold', 'm-hold'],
    ['rg-tout', 'effectOut', 'm-out'], ['rg-tgap', 'effectGap', 'm-gap'],
  ]) {
    $(id).oninput = e => {
      state.opts[key] = +e.target.value;
      $(out).textContent = (+e.target.value).toFixed(1);
      requestRender(false);
    };
  }

  $('in-duration').onchange = () => requestRender(true);
  $('in-maxframes').onchange = () => requestRender(true);

  const quality = $('rg-quality');
  quality.oninput = () => { $('out-quality').textContent = quality.value; };

  $('sel-format').onchange = updateExportUI;
}

/* ---------------- 导出 ---------------- */

function updateExportUI() {
  const r = state.result;
  const sel = $('sel-format');
  $('btn-export').disabled = !r;
  $('btn-play').disabled = !r || r.frames.length < 2;
  if (!r) { $('upload-hint-mini').textContent = ''; updateGsUI(); return; }

  // 内容类型（动/静）变化时自动联动推荐格式（N1 联动规则）
  if (r.animated !== updateExportUI._lastAnimated) {
    updateExportUI._lastAnimated = r.animated;
    sel.value = defaultFormat(r);
  }
  // 纯静态：GIF 置灰并提示
  const gifOpt = sel.querySelector('option[value="gif"]');
  if (!r.animated) {
    gifOpt.disabled = true;
    gifOpt.textContent = t('fmtGifStatic');
    if (sel.value === 'gif') sel.value = 'png';
  } else {
    gifOpt.disabled = false;
    gifOpt.textContent = t('fmtGifAnim');
  }
  const zh = getLang() === 'zh';
  $('upload-hint-mini').innerHTML = r.animated
    ? (zh
      ? `动图 · <b>${r.frames.length}</b> 帧 @ ${r.fps}FPS，导出 GIF 后到赛睿驱动上传`
      : `Animated · <b>${r.frames.length}</b> frames @ ${r.fps}FPS — export GIF, then upload in SteelSeries GG`)
    : (zh
      ? `静图 · 导出 PNG/JPG/BMP 后到赛睿驱动上传`
      : `Static · export PNG/JPG/BMP, then upload in SteelSeries GG`);
  updateGsUI(); // 发送按钮随渲染结果可用性联动
}

$('btn-export').onclick = async () => {
  const r = state.result;
  if (!r) return;
  const fmt = $('sel-format').value;
  const quality = +$('rg-quality').value;
  const base = (state.file?.name || 'apexoled').replace(/\.[^.]+$/, '') || 'apexoled';
  try {
    const { blob, filename, notes, size } = await exportResult(r, fmt, quality, base);
    downloadBlob(blob, filename);
    toast(getLang() === 'zh'
      ? `已导出 ${filename}（${formatBytes(size)}）`
      : `Exported ${filename} (${formatBytes(size)})`, 'ok');
    if (notes.length) showWarnings([...r.warnings, ...notes]);
  } catch (err) {
    toast(err.message || String(err), 'err');
  }
};

/* ---------------- GameSense 直连（G1 连接层 / G2 单帧上屏） ---------------- */

function updateGsUI() {
  const g = state.gs;
  const el = $('gs-status');
  el.textContent = g.msg || t(g.status);
  el.className = g.ok ? 'ok' : (g.msg ? 'err' : '');
  $('gs-send').textContent = g.sending ? t('gsSending') : t('gsSend');
  $('gs-send').disabled = !state.result || g.sending;
}

function gsSet(fields) { Object.assign(state.gs, fields); updateGsUI(); }

async function gsRegister(manual) {
  const addr = $('gs-address').value.trim();
  try {
    const r = await registerApp(addr);
    gsSet({ status: r.verified ? 'gsOk' : 'gsUnverified', msg: null, ok: true });
    saveAddress(addr);
  } catch (err) {
    gsSet({ status: 'gsIdle', msg: err.message || String(err), ok: false });
    if (manual) toast(err.message || String(err), 'err');
  }
}

function bindGamesense() {
  $('gs-address').value = getSavedAddress();
  $('gs-address').onchange = () => saveAddress($('gs-address').value.trim());

  $('gs-pick').onclick = async () => {
    try {
      const addr = await readAddressFromCoreProps();
      $('gs-address').value = addr;
      saveAddress(addr);
      toast(t('gsPickOk'), 'ok');
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 用户取消文件选择
      toast(err.message || String(err), 'err');
    }
  };

  $('gs-connect').onclick = () => gsRegister(true);

  $('gs-send').onclick = async () => {
    if (!state.result || state.gs.sending) return;
    const frame = state.result.frames[state.frameIdx] || state.result.frames[0];
    const addr = $('gs-address').value.trim();
    gsSet({ sending: true });
    try {
      await registerApp(addr); // 幂等：确保 GG 应用列表里有本应用
      const r = await pushFrame(addr, frame);
      gsSet({ status: r.verified ? 'gsSent' : 'gsUnverified', msg: null, ok: true });
      saveAddress(addr);
      toast(t('gsSent'), 'ok');
    } catch (err) {
      gsSet({ status: 'gsIdle', msg: err.message || String(err), ok: false });
      toast(err.message || String(err), 'err');
    } finally {
      gsSet({ sending: false });
    }
  };
  updateGsUI();
}

/* ---------------- 启动 ---------------- */

// 切换语言后重渲染所有动态文案（静态文案由 i18n.applyStatic 扫描处理）
function applyLangUI() {
  buildEffectUI();        // 重建 chips + 效果下拉
  syncEffectDropdowns();   // 同步下拉当前值
  updateCropVal();
  updateExportUI();
  updateGsUI();
  $('btn-play').textContent = state.playing ? t('pause') : t('play');
  if (state.lastStats) setStats(statsHtml(state.lastStats));
}

function init() {
  $('ver').textContent = `v${VERSION}`;
  initLang();             // 语言初始化 + 绑定切换按钮
  bindDropzone();
  bindCrop();
  bindParams();
  bindGamesense();
  onLangChange(applyLangUI);
  applyLangUI();          // 首次渲染（chips/下拉/播放按钮文案按当前语言）
}

init();
