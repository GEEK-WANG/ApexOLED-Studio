// 双语支持（中/EN）—— 静态文案走 data-zh/data-en 属性扫描（见 applyStatic），
// 动态文案走下方 STRINGS 字典（app.js 调 t(key)）。语言持久化 localStorage，
// 默认跟随浏览器语言。引擎层错误/警告为「中文 / English」并列单串，无需翻译。
const KEY = 'apexoled-lang';
let lang = 'zh';
const listeners = [];

const STRINGS = {
  // 效果快捷 chips
  effNone:      { zh: '无效果',        en: 'None' },
  effBreathing: { zh: '呼吸',          en: 'Breathing' },
  effFade:      { zh: '淡入淡出',      en: 'Fade' },
  effWipeL2r:   { zh: '擦除 左→右',    en: 'Wipe L→R' },
  effWipeT2b:   { zh: '擦除 上→下',    en: 'Wipe T→B' },
  effRevealT2b: { zh: '揭开 上→下',    en: 'Reveal T→B' },
  effZoom:      { zh: '缩放渐显',      en: 'Zoom' },
  effBlinds:    { zh: '百叶窗',        en: 'Blinds' },
  effScanline:  { zh: '扫描线',        en: 'Scanline' },
  effPixelate:  { zh: '像素化浮现',    en: 'Pixelate' },
  // 效果名（下拉选项，key 即效果标识）
  none:      { zh: '无',        en: 'None' },
  fade:      { zh: '淡入淡出',  en: 'Fade' },
  wipe:      { zh: '擦除',      en: 'Wipe' },
  reveal:    { zh: '揭开',      en: 'Reveal' },
  zoom:      { zh: '缩放渐显',  en: 'Zoom' },
  blinds:    { zh: '百叶窗',    en: 'Blinds' },
  scanline:  { zh: '扫描线',    en: 'Scanline' },
  pixelate:  { zh: '像素化浮现', en: 'Pixelate' },
  breathing: { zh: '呼吸',      en: 'Breathing' },
  // 方向名（key 即方向标识）
  l2r:  { zh: '左→右',    en: 'L→R' },
  r2l:  { zh: '右→左',    en: 'R→L' },
  t2b:  { zh: '上→下',    en: 'T→B' },
  b2t:  { zh: '下→上',    en: 'B→T' },
  tl2br:{ zh: '左上→右下', en: 'TL→BR' },
  tr2bl:{ zh: '右上→左下', en: 'TR→BL' },
  bl2tr:{ zh: '左下→右上', en: 'BL→TR' },
  br2tl:{ zh: '右下→左上', en: 'BR→TL' },
  h:    { zh: '横向',      en: 'Horizontal' },
  v:    { zh: '纵向',      en: 'Vertical' },
  // 播放器
  play:  { zh: '▶ 播放',  en: '▶ Play' },
  pause: { zh: '❚❚ 暂停', en: '❚❚ Pause' },
  // 框选
  cropNone:    { zh: '未框选（使用完整画面）',                 en: 'No selection (full image)' },
  cropRatioOk: { zh: '（≈3.2:1，与 OLED 同比例，无需再裁）',   en: '(≈3.2:1 — same ratio as OLED, no crop needed)' },
  // 其他动态文案
  decoding:      { zh: '解码中…',            en: 'Decoding…' },
  fmtGifStatic:  { zh: 'GIF（需动态内容）',   en: 'GIF (animated only)' },
  fmtGifAnim:    { zh: 'GIF（动态）',         en: 'GIF (animated)' },
  // GameSense 直连
  gsSend:       { zh: '推送当前帧到键盘',                        en: 'Push current frame' },
  gsSendAnim:   { zh: '推送动画到键盘',                          en: 'Push animation to keyboard' },
  gsFramesUnit: { zh: '帧',                                      en: 'frames' },
  gsSending:    { zh: '推送中…',                                en: 'Pushing…' },
  gsIdle:       { zh: '未连接',                                  en: 'Not connected' },
  gsOk:         { zh: '已连接 — GG 应用列表中可见 ApexOLED Studio', en: 'Connected — ApexOLED Studio appears in GG' },
  gsUnverified: { zh: '已发送（浏览器读不到响应），请在键盘上确认',  en: 'Sent (opaque response) — verify on the keyboard' },
  gsSent:       { zh: '静图已上屏（保持页面打开以维持显示）',        en: 'Static image on OLED (keep this page open to maintain)' },
  gsSentAnim:   { zh: '动画已上屏，循环播放中（保持页面打开；隐藏标签页可能被浏览器节流）', en: 'Animation looping on OLED (keep this page visible; hidden tabs may be throttled)' },
  gsStopped:    { zh: '已停止，键盘已交还 GG',                    en: 'Stopped — OLED returned to GG' },
  gsTruncated:  { zh: '帧数超过上限，仅推送了前',                  en: 'Too many frames — pushed only the first' },
  gsPickOk:     { zh: '已从 coreProps.json 读取端口',             en: 'Port read from coreProps.json' },
};

export function t(key) {
  const s = STRINGS[key];
  return s ? s[lang] : key;
}

export function getLang() { return lang; }

// 扫描静态双语节点：data-zh/data-en → textContent；data-zh-title/data-en-title → title
export function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-zh]').forEach(el => {
    const v = el.dataset[lang];
    if (v != null) el.textContent = v;
  });
  document.querySelectorAll('[data-zh-title]').forEach(el => {
    const v = el.dataset[lang + 'Title'];
    if (v != null) el.title = v;
  });
  document.querySelectorAll('[data-zh-ph]').forEach(el => {
    const v = el.dataset[lang + 'Ph'];
    if (v != null) el.placeholder = v;
  });
  const btn = document.getElementById('btn-lang');
  if (btn) btn.textContent = lang === 'zh' ? 'EN' : '中文';
}

export function setLang(l) {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* 隐私模式不可用则忽略 */ }
  applyStatic();
  for (const cb of listeners) cb(l);
}

export function onLangChange(cb) { listeners.push(cb); }

export function initLang() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  lang = saved === 'en' || saved === 'zh'
    ? saved
    : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const btn = document.getElementById('btn-lang');
  if (btn) btn.addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh'));
  applyStatic();
}
