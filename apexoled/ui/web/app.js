/* ApexOLED Studio v2 —— Web UI 逻辑
 * 实时预览闭环（R2）：参数变更 → debounce → 引擎渲染真实帧 → canvas 播放。
 * 浏览器直接打开时走 MOCK（pywebview 未注入），便于 UI 冒烟。 */
"use strict";

/* ============ API 层（pywebview / mock） ============ */
const hasNativeApi = () => typeof window.pywebview !== "undefined" &&
                          window.pywebview && window.pywebview.api;

/* MOCK：无 pywebview 环境（浏览器冒烟）返回占位数据 */
const MOCK = {
  _genFrame(n, total) {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 40;
    const g = c.getContext("2d");
    const u = total > 1 ? n / (total - 1) : 1;
    g.fillStyle = "#000"; g.fillRect(0, 0, 128, 40);
    g.fillStyle = "#fff";
    g.fillRect(8 + u * 60, 14, 52, 12);
    g.font = "8px monospace";
    g.fillText("MOCK " + n, 10, 34);
    return c.toDataURL("image/png").split(",")[1];
  },
  async get_app_info() {
    return {
      app: "ApexOLED Studio", version: "2.0.0a2-mock",
      width: 128, height: 40, fps_default: 10,
      exts: [".png", ".jpg", ".gif", ".mp4"],
      effects: {
        fade:        { direction: null, directions: [] },
        wipe:        { direction: "l2r", directions: ["l2r", "r2l", "t2b", "b2t", "tl2br", "tr2bl", "bl2tr", "br2tl"] },
        reveal:      { direction: "t2b", directions: ["l2r", "r2l", "t2b", "b2t", "tl2br", "tr2bl", "bl2tr", "br2tl"] },
        zoom:        { direction: null, directions: [] },
        blinds:      { direction: "h",   directions: ["h", "v"] },
        scanline:    { direction: "t2b", directions: ["t2b", "b2t"] },
        pixelate:    { direction: null, directions: [] },
        breathing:   { direction: null, directions: [] },
      },
    };
  },
  async pick_file() { return "mock://demo_source.png"; },
  async set_source(path) {
    return { ok: true, src: {
      name: path.split(/[\\/]/).pop() || "demo.png", path,
      kb: 123.4, w: 640, h: 320, n_frames: 1, animated: false, is_video: false,
      thumb: (function () {
        const c = document.createElement("canvas");
        c.width = 480; c.height = 240;
        const g = c.getContext("2d");
        g.fillStyle = "#233"; g.fillRect(0, 0, 480, 240);
        g.fillStyle = "#ff7a1a"; g.font = "bold 40px sans-serif";
        g.fillText("MOCK 源图", 130, 130);
        return c.toDataURL("image/png");
      })(),
      thumb_scale: 0.75,
    }};
  },
  async render_preview(params) {
    const total = params.effect && params.effect !== "none" ? 36 : 1;
    const frames = [];
    for (let i = 0; i < total; i++) frames.push(this._genFrame(i, total));
    return { ok: true, frames, fps: params.fps || 10, animated: total > 1,
             warnings: ["MOCK 模式：真实效果请通过 apexoled --gui 启动"], elapsed_ms: 8.8 };
  },
  async save_dialog(name) { return "mock://out/" + name; },
  async export_file(params, fmt, quality, outpath) {
    return { ok: true, path: outpath, preview: outpath + ".html", kb: 5.2,
             frames: 36, notes: [], warnings: [] };
  },
};

const api = new Proxy({}, {
  get(_, name) {
    return async (...args) => {
      if (hasNativeApi()) return await window.pywebview.api[name](...args);
      if (MOCK[name]) return await MOCK[name](...args);
      throw new Error("API 不可用：" + name);
    };
  },
});

const onPywebviewReady = () => new Promise((resolve) => {
  if (hasNativeApi()) return resolve();
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (hasNativeApi() || Date.now() - t0 > 2500) { clearInterval(timer); resolve(); }
  }, 100);
});

/* ============ DOM 工具 ============ */
const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { el.hidden = !on; };
let toastTimer = null;
function toast(msg, type = "err") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3200);
}

/* ============ 全局状态 ============ */
const S = {
  src: null,          // set_source 返回的源信息
  frames: [],         // 预解码 Image[]
  fps: 10,
  animated: false,
  playing: false,
  idx: 0,
  raf: 0,
  lastT: 0,
  cropRect: null,     // {x,y,w,h} 源像素坐标
  meta: {},           // 效果注册表 meta
};

/* ============ 参数收集 ============ */
function readParams() {
  const effIn = $("sel-eff-in").value;
  const effOut = $("sel-eff-out").value;
  const inDir = effIn && S.meta[effIn] && S.meta[effIn].directions.length
    ? $("sel-eff-in-dir").value : null;
  let effect = null;
  if (effIn) {
    effect = inDir ? `${effIn}:${inDir}` : effIn;
    if (effOut !== "same") {
      const outDir = S.meta[effOut] && S.meta[effOut].directions.length
        ? $("sel-eff-out-dir").value : null;
      effect += "+" + (outDir ? `${effOut}:${outDir}` : effOut);
    }
  }
  const dur = parseFloat($("in-duration").value);
  return {
    fps: parseInt($("rg-fps").value, 10),
    mode: $("seg-mode").querySelector(".on").dataset.v,
    bg: $("sel-bg").value,
    colors: $("seg-colors").querySelector(".on").dataset.v,
    palette: parseInt($("rg-palette").value, 10),
    dither: $("sel-dither").value,
    logo: $("chk-logo").checked,
    enhance: $("sel-enhance").value,
    effect,
    effect_in: parseFloat($("rg-tin").value),
    effect_hold: parseFloat($("rg-thold").value),
    effect_out: parseFloat($("rg-tout").value),
    effect_gap: parseFloat($("rg-tgap").value),
    duration: isNaN(dur) ? null : dur,
    crop: S.cropRect ? `${S.cropRect.w}x${S.cropRect.h}+${S.cropRect.x}+${S.cropRect.y}` : null,
  };
}

/* ============ 效果下拉联动 ============ */
const EFF_LABELS = {
  fade: "淡入淡出", wipe: "擦除", reveal: "揭开", zoom: "缩放",
  blinds: "百叶窗", scanline: "扫描线", pixelate: "像素化", breathing: "呼吸",
};
const DIR_LABELS = {
  l2r: "左 → 右", r2l: "右 → 左", t2b: "上 → 下", b2t: "下 → 上",
  tl2br: "左上 ↘", tr2bl: "右上 ↙", bl2tr: "左下 ↗", br2tl: "右下 ↖",
  h: "横向", v: "纵向",
};

function fillEffectSelects() {
  const names = Object.keys(S.meta).sort();
  const mkOpts = (sel, withSame) => {
    let html = `<option value="">无</option>`;
    for (const n of names) html += `<option value="${n}">${EFF_LABELS[n] || n}</option>`;
    if (withSame) html = `<option value="same">（同入场）</option>` + html.replace(`<option value="">无</option>`, "");
    sel.innerHTML = html;
  };
  mkOpts($("sel-eff-in"), false);
  mkOpts($("sel-eff-out"), true);
  $("sel-eff-in").value = "";
  $("sel-eff-out").value = "same";
  refreshDirSelects();
}

function refreshDirSelects() {
  const upd = (effSel, dirSel) => {
    const name = effSel.value;
    const box = dirSel.parentElement;
    if (effSel.id === "sel-eff-out" && name === "same") { show(box, false); return; }
    const m = S.meta[name];
    const dirs = m ? m.directions : [];
    show(box, dirs.length > 0);
    dirSel.innerHTML = dirs.map((d) =>
      `<option value="${d}">${DIR_LABELS[d] || d}</option>`).join("");
    if (m && m.direction) dirSel.value = m.direction;
  };
  upd($("sel-eff-in"), $("sel-eff-in-dir"));
  upd($("sel-eff-out"), $("sel-eff-out-dir"));
}

/* ============ 帧数预估 ============ */
function updateFrameCount() {
  const fps = parseInt($("rg-fps").value, 10);
  const t = (v) => parseFloat($(v).value);
  const secs = t("rg-tin") + t("rg-thold") + t("rg-tout") + t("rg-tgap");
  const n = Math.ceil(fps * secs);
  const el = $("frame-count");
  el.textContent = `${n} 帧（${secs.toFixed(1)}s）`;
  el.style.color = n > 60 ? "var(--danger)" : "var(--accent)";
  for (const [id, out] of [["rg-tin", "m-in"], ["rg-thold", "m-hold"],
                            ["rg-tout", "m-out"], ["rg-tgap", "m-gap"]]) {
    $(out).textContent = t(id).toFixed(1);
  }
}

/* ============ 预览调度 ============ */
let previewTimer = null, renderSeq = 0;
function schedulePreview() {
  updateFrameCount();
  if (!S.src) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 180);
}

async function runPreview() {
  if (!S.src) return;
  const seq = ++renderSeq;
  $("render-stats").textContent = "渲染中…";
  const r = await api.render_preview(readParams());
  if (seq !== renderSeq) return;           // 过期响应丢弃
  if (!r.ok) {
    toast(r.error || "渲染失败", "err");
    $("render-stats").textContent = "渲染失败";
    return;
  }
  /* 预解码帧 */
  const imgs = [];
  for (const b64 of r.frames) {
    const im = new Image();
    im.src = "data:image/png;base64," + b64;
    await im.decode();
    imgs.push(im);
  }
  S.frames = imgs; S.fps = r.fps; S.animated = r.animated;
  S.idx = 0; S.playing = false; cancelAnimationFrame(S.raf);
  paint();
  if (r.animated && imgs.length > 1) startPlay();

  const warnCard = $("warn-card");
  const warns = r.warnings || [];
  show(warnCard, warns.length > 0);
  $("warn-area").innerHTML = warns.map((w) => `<div class="warn-item">${w}</div>`).join("");

  $("render-stats").innerHTML =
    `<b>${imgs.length}</b> 帧 · <b>${r.elapsed_ms}</b> ms` +
    (warns.length ? ` · <span class="warn-count">${warns.length} 条提示</span>` : "");
}

/* ============ 播放器 ============ */
function paint() {
  if (!S.frames.length) return;
  const im = S.frames[Math.min(S.idx, S.frames.length - 1)];
  for (const id of ["oled-1x", "oled-4x"]) {
    const ctx = $(id).getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, $(id).width, $(id).height);
    ctx.drawImage(im, 0, 0, $(id).width, $(id).height);
  }
  $("frame-pos").textContent = `${S.idx + 1} / ${S.frames.length}`;
  $("btn-play").textContent = S.playing ? "⏸ 暂停" : "▶ 播放";
}

function startPlay() {
  if (S.frames.length < 2) return;
  S.playing = true;
  S.lastT = performance.now();
  const step = (now) => {
    if (!S.playing) return;
    if (now - S.lastT >= 1000 / S.fps) {
      S.lastT = now;
      S.idx = (S.idx + 1) % S.frames.length;
      paint();
    }
    S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
}

function stopPlay() { S.playing = false; cancelAnimationFrame(S.raf); paint(); }

/* ============ 框选（源图裁剪） ============ */
let dragStart = null, dragRect = null, thumbImg = null, thumbScale = 1;

async function setupCropView() {
  const wrap = $("crop-wrap");
  if (!S.src) { show(wrap, false); return; }
  thumbImg = await (async () => {
    const im = new Image();
    im.src = S.src.thumb;
    await im.decode();
    return im;
  })();
  thumbScale = S.src.thumb_scale || 1;
  const cv = $("crop-canvas");
  cv.width = thumbImg.width; cv.height = thumbImg.height;
  cv.getContext("2d").drawImage(thumbImg, 0, 0);
  dragRect = null;
  show(wrap, true);
  $("crop-hint").textContent =
    `源图 ${S.src.w}×${S.src.h}（显示缩放 ×${(1 / thumbScale).toFixed(2)}）：拖拽画出矩形 → 自动应用`;
}

function drawCropOverlay() {
  if (!thumbImg) return;   // 缩略图未就绪（首次载入/换源瞬间）
  const cv = $("crop-canvas");
  const g = cv.getContext("2d");
  g.clearRect(0, 0, cv.width, cv.height);
  g.drawImage(thumbImg, 0, 0);
  if (dragRect) {
    const { x, y, w, h } = dragRect;
    g.fillStyle = "rgba(0,0,0,.55)";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(thumbImg, x, y, w, h, x, y, w, h);
    g.strokeStyle = "#ff7a1a";
    g.lineWidth = 2;
    g.strokeRect(x + .5, y + .5, w - 1, h - 1);
  }
}

function canvasPos(ev) {
  const cv = $("crop-canvas");
  const r = cv.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(cv.width, (ev.clientX - r.left) * (cv.width / r.width))),
    y: Math.max(0, Math.min(cv.height, (ev.clientY - r.top) * (cv.height / r.height))),
  };
}

function applyCropFromRect() {
  if (!dragRect || dragRect.w < 3 || dragRect.h < 3) { clearCrop(); return; }
  const toSrc = (v) => Math.max(1, Math.round(v * thumbScale));
  S.cropRect = {
    x: toSrc(dragRect.x), y: toSrc(dragRect.y),
    w: toSrc(dragRect.w), h: toSrc(dragRect.h),
  };
  $("crop-val").textContent =
    `${S.cropRect.w}x${S.cropRect.h}+${S.cropRect.x}+${S.cropRect.y}`;
  schedulePreview();
}

function clearCrop() {
  S.cropRect = null; dragRect = null;
  drawCropOverlay();
  $("crop-val").textContent = "未框选";
  schedulePreview();
}

/* ============ 素材载入 ============ */
async function loadSource(path) {
  if (!path) return;
  const r = await api.set_source(path);
  if (!r || !r.ok) { toast((r && r.error) || "无法读取素材", "err"); return; }
  S.src = r.src;
  const si = $("src-info");
  show(si, true);
  si.innerHTML =
    `<b>${S.src.name}</b> · ${S.src.w}×${S.src.h}` +
    (S.src.animated ? ` · 动态 ${S.src.n_frames} 帧` : " · 静态") +
    ` · ${S.src.kb} KB`;
  show($("video-opts"), !!S.src.is_video);
  show($("crop-field"), true);
  clearCrop();
  await setupCropView();
  runPreview();
}

/* ============ 导出 ============ */
async function doExport() {
  if (!S.src) { toast("请先选择素材", "err"); return; }
  const fmt = $("sel-format").value;
  const quality = parseInt($("rg-quality").value, 10);
  const stem = S.src.name.replace(/\.[^.]+$/, "");
  const out = await api.save_dialog(`${stem}_oled.${fmt}`);
  if (!out) { toast("已取消导出", "err"); return; }
  const r = await api.export_file(readParams(), fmt, quality, out);
  if (!r.ok) { toast(r.error, "err"); return; }
  const notes = [...(r.warnings || []), ...(r.notes || [])];
  toast(`已导出：${r.path}（${r.kb} KB，${r.frames} 帧）` +
        (notes.length ? `；${notes.join("；")}` : ""), "ok");
}

/* ============ 事件绑定 ============ */
function bindUI() {
  /* 分段控件 */
  for (const segId of ["seg-mode", "seg-colors"]) {
    $(segId).addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      $(segId).querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      const isBw = $("seg-colors").querySelector(".on").dataset.v === "bw";
      $("rg-palette").disabled = isBw;
      schedulePreview();
    });
  }

  /* 普通控件 → debounce 预览 */
  for (const id of ["sel-bg", "sel-enhance", "sel-dither", "rg-palette",
                    "rg-fps", "rg-tin", "rg-thold", "rg-tout", "rg-tgap",
                    "chk-logo", "in-duration"]) {
    $(id).addEventListener("input", schedulePreview);
    $(id).addEventListener("change", schedulePreview);
  }
  $("out-palette").textContent = "256";
  $("rg-palette").addEventListener("input", () =>
    $("out-palette").textContent = $("rg-palette").value);

  /* 效果下拉联动 */
  $("sel-eff-in").addEventListener("change", () => { refreshDirSelects(); schedulePreview(); });
  $("sel-eff-out").addEventListener("change", () => { refreshDirSelects(); schedulePreview(); });
  $("sel-eff-in-dir").addEventListener("change", schedulePreview);
  $("sel-eff-out-dir").addEventListener("change", schedulePreview);

  /* 播放控制 */
  $("btn-play").addEventListener("click", () =>
    S.playing ? stopPlay() : startPlay());
  $("btn-prev").addEventListener("click", () => {
    stopPlay();
    S.idx = (S.idx - 1 + S.frames.length) % S.frames.length;
    paint();
  });
  $("btn-next").addEventListener("click", () => {
    stopPlay();
    S.idx = (S.idx + 1) % S.frames.length;
    paint();
  });

  /* 素材选择 */
  $("dropzone").addEventListener("click", async () => {
    const p = await api.pick_file();
    if (p) loadSource(p);
  });
  for (const evName of ["dragover", "dragenter"]) {
    $("dropzone").addEventListener(evName, (ev) => {
      ev.preventDefault();
      $("dropzone").classList.add("over");
    });
  }
  $("dropzone").addEventListener("dragleave", () =>
    $("dropzone").classList.remove("over"));
  $("dropzone").addEventListener("drop", async (ev) => {
    ev.preventDefault();
    $("dropzone").classList.remove("over");
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    const path = f && (f.path || f.fullPath);
    if (path) loadSource(path);
    else toast("此环境拖拽拿不到文件路径，请点击选择文件", "err");
  });

  /* 框选画布 */
  const cv = $("crop-canvas");
  cv.addEventListener("mousedown", (ev) => {
    dragStart = canvasPos(ev);
    ev.preventDefault();
  });
  cv.addEventListener("mousemove", (ev) => {
    if (!dragStart) return;
    const p = canvasPos(ev);
    dragRect = {
      x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
    };
    drawCropOverlay();
  });
  window.addEventListener("mouseup", () => {
    if (!dragStart) return;
    dragStart = null;
    applyCropFromRect();
  });
  $("btn-crop-clear").addEventListener("click", clearCrop);

  /* 导出 */
  $("sel-format").addEventListener("change", () =>
    show($("quality-field"), $("sel-format").value === "jpg"));
  $("rg-quality").addEventListener("input", () =>
    $("out-quality").textContent = $("rg-quality").value);
  $("btn-export").addEventListener("click", doExport);
}

/* ============ 启动 ============ */
(async function main() {
  await onPywebviewReady();
  const info = await api.get_app_info();
  S.meta = info.effects || {};
  $("ver").textContent = `v${info.version} · ${info.width}×${info.height} OLED`;
  fillEffectSelects();
  bindUI();
  updateFrameCount();
  $("render-stats").textContent = "等待素材…";
  if (!hasNativeApi()) toast("浏览器冒烟模式（MOCK），真实渲染请用 apexoled --gui 启动", "ok");
})();
