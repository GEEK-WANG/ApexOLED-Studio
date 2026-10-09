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

// 上屏帧数上限：单帧 640 字节，动画 JSON 体积随帧数线性增长，超限则截断并提示（G3）。
export const MAX_PUSH_FRAMES = 60;
// 把 Engine 默认 15 秒的 deinit 清屏计时延到上限 60 秒，配合心跳保活（G3）。
const DEINIT_MS = 60000;

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
// 浏览器（Chrome/Edge）对 C:\ProgramData 等系统目录有读取限制，showOpenFilePicker / getFile
// 可能抛出浏览器级 SecurityError / NotReadableError（非本模块自定义文案）。统一转成手动降级指引。
const MANUAL_HINT = `请改用记事本打开 ${COREPROPS_PATH}，把 "address" 的值复制粘贴到输入框（形如 127.0.0.1:3612）。 / Open it in Notepad and paste the "address" value into the input (e.g. 127.0.0.1:3612).`;

export async function readAddressFromCoreProps() {
  if (typeof window.showOpenFilePicker !== 'function') {
    throw new Error('此浏览器不支持文件选择器，请手动填写地址（Chrome/Edge 支持）。 / File picker unsupported here; enter the address manually (Chrome/Edge OK).');
  }
  let handle, file;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{ description: 'coreProps.json', accept: { 'application/json': ['.json'] } }],
      multiple: false,
    });
    file = await handle.getFile();
  } catch (err) {
    if (err && err.name === 'AbortError') throw err; // 用户主动取消：交调用方静默处理
    throw new Error(`浏览器不允许读取该位置（系统目录受限）。 / The browser blocks reading that location. ${MANUAL_HINT}`);
  }
  let text;
  try { text = await file.text(); }
  catch { throw new Error(`无法读取该文件。 / Cannot read that file. ${MANUAL_HINT}`); }
  let props;
  try { props = JSON.parse(text); }
  catch { throw new Error('所选文件不是有效 JSON，请确认选的是 coreProps.json。 / Selected file is not valid JSON; make sure it is coreProps.json.'); }
  const addr = props && typeof props.address === 'string' ? props.address.trim() : '';
  if (!addr) {
    throw new Error(`文件里没有 address 字段，请确认选的是 coreProps.json（位于 ${COREPROPS_PATH}）。 / No address field found; make sure it is coreProps.json (at ${COREPROPS_PATH}).`);
  }
  return addr;
}

/* ---------------- HTTP ---------------- */

// 地址归一化：全角冒号/句点/空格 → 半角（用户常见误输入），去尾部斜杠，补协议，校验 host:port。
function baseUrl(addr) {
  let a = String(addr || '').trim()
    .replace(/：/g, ':')
    .replace(/[。．]/g, '.')
    .replace(/[\u3000\s]/g, '');
  a = a.replace(/\/+$/, '');
  if (!a) throw new Error('请先填写 Engine 地址（如 127.0.0.1:54321）。 / Enter the Engine address first (e.g. 127.0.0.1:54321).');
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  if (!/^https?:\/\/[^\s/:]+:\d{1,5}$/i.test(a)) {
    throw new Error('地址格式不对，应为「主机:端口」（如 127.0.0.1:3612）。 / Bad address format; expected host:port (e.g. 127.0.0.1:3612).');
  }
  return a;
}

// Engine 实测行为（2026-10 本机转储，随 coreProps 端口）：
//   OPTIONS /game_event → 200 + Access-Control-Allow-Origin: * + Allow-Methods: POST,OPTIONS
//   POST application/json → 200，响应同样带 ACAO:*（服务端确实放行跨域，浏览器可读回执）
//   POST text/plain / 无 Content-Type → 400 严格拒收（故绝不能降级成 text/plain 盲发）
// 坑：Access-Control-Allow-Origin 是非 CORS 安全列表响应头，服务端未发 Access-Control-Expose-Headers
//     时页面 JS 读不到（headers.get(...) 恒为 null）。曾据此误报「端口可达但不是 GameSense 服务」。
async function post(addr, path, body) {
  const url = `${baseUrl(addr)}/${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Engine 返回 HTTP ${res.status}。 / Engine replied HTTP ${res.status}.`);
    return { verified: true };
  } catch (err) {
    if (/Engine 返回 HTTP/.test((err && err.message) || '')) throw err; // 可读的 HTTP 错误：如实上报
    // 请求被拦截（连接失败，或响应跨域不可读）：no-cors 探路区分「GG 未运行」与「已送达未验证」
    if (await reachable(addr)) return { verified: false };
    throw new Error('无法连接 Engine：地址不对或 SteelSeries GG 未运行。 / Cannot reach Engine: wrong address or GG not running.');
  }
}

// no-cors GET 探路：端口没人监听会 reject，服务在则 resolve（opaque，读不到内容但能证明可达）
async function reachable(addr) {
  try {
    await fetch(`${baseUrl(addr)}/`, { method: 'GET', mode: 'no-cors' });
    return true;
  } catch { return false; }
}

/* ---------------- GameSense 协议 ---------------- */

// 注册应用元数据 —— 成功后 GG 应用列表会出现 ApexOLED Studio（G1 验收点）
export async function registerApp(addr) {
  return post(addr, 'game_metadata', {
    game: GAME,
    game_display_name: 'ApexOLED Studio',
    developer: 'GEEK-WANG',
    deinitialize_timer_length_ms: DEINIT_MS, // 延长休眠清屏计时（15s → 60s）
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

// 帧序列 → screen handler 的 datas（G3 动画）：
//   单帧：不带 length/repeats —— 画面常驻，直到下次写屏。
//   多帧：每帧 length-millis 控制显示时长；末帧 repeats:true = 无限循环，直到有新事件写屏。
// 帧数超过 MAX_PUSH_FRAMES 时截断（动画 JSON 体积随帧数线性增长），并回报 truncated。
export function framesToGamesenseDatas(frames, fps) {
  const kept = frames.slice(0, MAX_PUSH_FRAMES);
  const truncated = frames.length > kept.length;
  if (kept.length === 1) {
    return { datas: [{ 'has-text': false, 'image-data': frameToGamesenseBytes(kept[0]) }], truncated: false };
  }
  const frameMs = Math.max(20, Math.round(1000 / (fps > 0 ? fps : 10)));
  const datas = kept.map((f, i) => {
    const d = { 'has-text': false, 'image-data': frameToGamesenseBytes(f), 'length-millis': frameMs };
    if (i === kept.length - 1) d.repeats = true;
    return d;
  });
  return { datas, truncated };
}

// 上屏：bind（把整批帧绑为该事件的画面）→ game_event 触发。
// 每次推送都重新 bind，画面随之刷新；循环动画会一直播到 stop_game 或下次推送。
export async function pushAnimation(addr, frames, fps) {
  const { datas, truncated } = framesToGamesenseDatas(frames, fps);
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
      datas,
    }],
  });
  await post(addr, 'game_event', { game: GAME, event: EVENT, data: { value: 0 } });
  return { ...r, frames: datas.length, truncated };
}

// 心跳：重置 deinit 计时，让静态画面与循环动画不被休眠规则清掉（G3 保活）。
export async function heartbeat(addr) {
  return post(addr, 'game_heartbeat', { game: GAME });
}

// 停止上屏：交还 GG 默认显示（循环动画也只能靠它停下）。
export async function stopGame(addr) {
  return post(addr, 'stop_game', { game: GAME });
}
