// GameSense 直连客户端 —— SteelSeries Engine（GG）本地 HTTP JSON 协议。
// 协议文档：https://github.com/SteelSeries/gamesense-sdk
//   端口写在 %PROGRAMDATA%/SteelSeries/SteelSeries Engine 3/coreProps.json 的 address 字段
//   （浏览器沙箱读不到该文件 → UI 提供 File System Access API 一次读取 + 手动填写两条路）。
// G1：地址配置 + 注册应用（GG 应用列表出现 ApexOLED Studio）。
// G2：单帧上屏（128×40 RGBA → 640 字节 1bit 位图 → bind + 触发显示）。
// 错误文案沿用引擎层惯例：「中文 / English」并列单串。

import { WIDTH, HEIGHT, luma } from './engine/core.js';

export const GAME = 'APEXOLED_STUDIO';
export const EVENT = 'OLED_FRAME';
const ADDR_KEY = 'apexoled-gs-address';

const COREPROPS_PATH = 'C:\\ProgramData\\SteelSeries\\SteelSeries Engine 3\\coreProps.json';

/* ---------------- 地址配置 ---------------- */

export function getSavedAddress() {
  try { return localStorage.getItem(ADDR_KEY) || ''; } catch { return ''; }
}

export function saveAddress(addr) {
  try { localStorage.setItem(ADDR_KEY, addr || ''); } catch { /* 隐私模式不可用则忽略 */ }
}

// File System Access API（Chrome/Edge，https 或 localhost 下可用）：
// 用户在文件选择器里选中 coreProps.json，自动解析出 {"address":"127.0.0.1:xxxxx"}。
export async function readAddressFromCoreProps() {
  if (typeof window.showOpenFilePicker !== 'function') {
    throw new Error('此浏览器不支持文件选择器，请手动填写地址（Chrome/Edge 支持）。 / File picker unsupported here; enter the address manually (Chrome/Edge OK).');
  }
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: 'coreProps.json', accept: { 'application/json': ['.json'] } }],
    multiple: false,
  });
  const file = await handle.getFile();
  let props;
  try { props = JSON.parse(await file.text()); }
  catch { throw new Error('所选文件不是有效 JSON，请确认选的是 coreProps.json。 / Selected file is not valid JSON; make sure it is coreProps.json.'); }
  const addr = props && typeof props.address === 'string' ? props.address.trim() : '';
  if (!addr) {
    throw new Error(`文件里没有 address 字段，请确认选的是 coreProps.json（位于 ${COREPROPS_PATH}）。 / No address field found; make sure it is coreProps.json (at ${COREPROPS_PATH}).`);
  }
  return addr;
}

/* ---------------- HTTP ---------------- */

function baseUrl(addr) {
  const a = (addr || '').trim().replace(/\/+$/, '');
  if (!a) throw new Error('请先填写 Engine 地址（如 127.0.0.1:54321）。 / Enter the Engine address first (e.g. 127.0.0.1:54321).');
  return a.startsWith('http') ? a : `http://${a}`;
}

// Engine 实测行为（2026-10 本机探针）：
//   OPTIONS 预检 → 200 + Access-Control-Allow-Origin: *（预检可读，证明服务在且放行跨域）
//   POST application/json → 200（服务端正常处理），但 POST 响应不带 CORS 头（浏览器读不到回执）
//   POST text/plain / 无 Content-Type → 400 严格拒收
// 策略：预检探路区分「GG 未运行」与「可达但回执不可读」；只发 application/json。
//   预检失败 → 报无法连接；预检通过但 POST 本地被拒（读不到响应）→ 视为已送达未验证。
async function post(addr, path, body) {
  const url = `${baseUrl(addr)}/${path}`;
  let preflight;
  try {
    preflight = await fetch(`${baseUrl(addr)}/game_event`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
  } catch {
    throw new Error('无法连接 Engine：地址不对或 SteelSeries GG 未运行。 / Cannot reach Engine: wrong address or GG not running.');
  }
  if (!preflight.ok || preflight.headers.get('access-control-allow-origin') == null) {
    throw new Error('端口可达，但不是 GameSense 服务（或未允许跨域）。 / Port reachable but not a GameSense server (or CORS denied).');
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Engine 返回 HTTP ${res.status}。 / Engine replied HTTP ${res.status}.`);
    return { verified: true }; // 若未来 Engine 的 POST 响应也带 CORS 头，可读到真实回执
  } catch (err) {
    if (err && /HTTP \d+/.test(err.message)) throw err; // 可读的 HTTP 错误：如实上报
    return { verified: false }; // 预检已证明服务在 → 请求已送达，仅回执不可读
  }
}

/* ---------------- GameSense 协议 ---------------- */

// 注册应用元数据 —— 成功后 GG 应用列表会出现 ApexOLED Studio（G1 验收点）
export async function registerApp(addr) {
  return post(addr, 'game_metadata', {
    game: GAME,
    game_display_name: 'ApexOLED Studio',
    developer: 'GEEK-WANG',
  });
}

// RGBA 帧 → GameSense image-data：1 bit/像素（1=白），按行打包、MSB 在前、左上原点，
// 共 128×40/8 = 640 字节。bw 模式下像素值本就是 0/255，阈值 128 为恒等映射。
export function frameToGamesenseBytes(frame) {
  if (!frame || frame.width !== WIDTH || frame.height !== HEIGHT) {
    throw new Error(`内部帧不是 ${WIDTH}×${HEIGHT} 规格，无法上屏。 / Internal frame is not ${WIDTH}×${HEIGHT}; cannot push.`);
  }
  const out = new Array((WIDTH * HEIGHT) / 8).fill(0); // 普通 Array：JSON 序列化为字节数组
  const rowBytes = WIDTH / 8;
  const d = frame.data;
  for (let y = 0; y < HEIGHT; y++) {
    const rowOff = y * rowBytes;
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      if (luma(d[i], d[i + 1], d[i + 2]) >= 128) out[rowOff + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

// 单帧上屏：bind（本帧作为该事件的默认画面）→ game_event 触发显示。
// 每次推送重新 bind 即可刷新画面，兼容旧版 Engine（不依赖 3.17.9+ 的事件内动态图）。
// 注意：Engine 15 秒收不到事件会休眠清屏，静态帧也会被清（G3 将用心跳解决，G2 先接受此行为）。
export async function pushFrame(addr, frame) {
  const bytes = frameToGamesenseBytes(frame);
  const r = await post(addr, 'bind_game_event', {
    game: GAME,
    event: EVENT,
    min_value: 0,
    max_value: 100,
    icon_id: 0,
    value_optional: true,
    handlers: [{
      'device-type': `screened-${WIDTH}x${HEIGHT}`,
      zone: 'one',
      mode: 'screen',
      datas: [{ 'has-text': false, 'image-data': bytes }],
    }],
  });
  await post(addr, 'game_event', { game: GAME, event: EVENT, data: { value: 0 } });
  return r; // { verified: boolean }
}
