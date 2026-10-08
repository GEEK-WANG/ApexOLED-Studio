# -*- coding: utf-8 -*-
"""pywebview js_api 桥（R2 实时预览闭环）。

前端每次改参数 → render_preview() → 引擎真实渲染 → 逐帧 PNG base64 回传
→ canvas 播放。预览帧与导出帧同源同参数，预览即成品（R2.2 零偏差）。

webview 相关调用全部延迟导入，保证本模块可在无 GUI 环境下单测。
"""
import base64
import io
import time
from pathlib import Path
from typing import Optional

from PIL import Image

from .. import APP_NAME, DEFAULT_FPS, HEIGHT, SUPPORTED_EXTS, VERSION, WIDTH
from ..decode import parse_crop
from ..effects import effect_meta
from ..engine import RenderOptions, render
from ..exporters import export
from ..exporters.preview import make_preview

# 框选缩略图最大显示宽/高（源像素 → 显示像素的缩放比例随图返回）
_THUMB_MAX_W, _THUMB_MAX_H = 480, 360


def frame_png_b64(frame) -> str:
    """单帧 RGB uint8 数组 → PNG base64（data: 前缀由前端拼接）。"""
    img = Image.fromarray(frame)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _build_options(params: dict) -> RenderOptions:
    """前端参数 dict（JSON 值）→ RenderOptions。crop 支持 'WxH+X+Y' 字符串。"""
    p = params or {}

    def s(key, default=None):
        v = p.get(key)
        return default if v in (None, "") else str(v)

    def n(key, cast, default):
        v = p.get(key)
        return default if v in (None, "") else cast(v)

    crop = None
    if p.get("crop"):
        crop = parse_crop(str(p["crop"]))  # 中文报错向上抛

    effect = s("effect")
    if effect and effect.lower() == "none":
        effect = None

    return RenderOptions(
        fps=n("fps", int, DEFAULT_FPS),
        mode=s("mode", "cover"),
        bg=s("bg", "black"),
        colors=s("colors", "bw"),
        palette=n("palette", int, 256),
        dither=s("dither", "auto"),
        crop=crop,
        logo=bool(p.get("logo")),
        enhance=s("enhance", "none"),
        effect=effect,
        effect_in=n("effect_in", float, 0.8),
        effect_hold=n("effect_hold", float, 1.6),
        effect_out=n("effect_out", float, 0.8),
        effect_gap=n("effect_gap", float, 0.4),
        duration=n("duration", float, None),
        max_frames=n("max_frames", int, None),
    )


def _thumb_info(path: Path) -> dict:
    """源素材首帧缩略图（框选用）+ 基本信息缓存于 set_source 返回值。"""
    from ..decode import decode

    seq = decode(path, fps=DEFAULT_FPS, max_frames=1)
    frame = seq.frames[0]
    h, w = frame.shape[:2]

    scale = min(_THUMB_MAX_W / w, _THUMB_MAX_H / h, 1.0)
    tw, th = max(1, round(w * scale)), max(1, round(h * scale))
    img = Image.fromarray(frame).resize((tw, th))
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    thumb = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

    n_frames = 1
    if path.suffix.lower() in {".gif", ".apng", ".webp", ".png"}:
        try:
            with Image.open(path) as im:
                n_frames = getattr(im, "n_frames", 1)
        except Exception:
            n_frames = 1

    return {
        "name": path.name,
        "path": str(path),
        "kb": round(path.stat().st_size / 1024, 1),
        "w": w, "h": h,
        "n_frames": n_frames,
        "animated": seq.animated or n_frames > 1,
        "is_video": path.suffix.lower() in {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"},
        "thumb": thumb,
        "thumb_scale": scale,
    }


class OledApi:
    """js_api 暴露给前端的方法集合（pywebview window.pywebview.api.*）。"""

    def __init__(self):
        self._src: Optional[Path] = None

    # ---- 基础信息 ----
    def get_app_info(self) -> dict:
        return {"app": APP_NAME, "version": VERSION,
                "width": WIDTH, "height": HEIGHT,
                "fps_default": DEFAULT_FPS,
                "effects": effect_meta(),
                "exts": sorted(SUPPORTED_EXTS)}

    # ---- 素材 ----
    @staticmethod
    def _window():
        """当前 pywebview 主窗口（对话框是 Window 实例方法，非模块函数）。"""
        import webview
        if not webview.windows:
            raise RuntimeError("GUI 窗口尚未就绪。")
        return webview.windows[0]

    def pick_file(self) -> Optional[str]:
        """原生文件选择对话框；取消返回 None。"""
        import webview
        r = self._window().create_file_dialog(
            webview.FileDialog.OPEN,
            allow_multiple=False,
            file_types=("图片 / GIF / 视频 (*.png;*.jpg;*.jpeg;*.bmp;*.webp;"
                        "*.gif;*.apng;*.mp4;*.webm;*.mov;*.mkv;*.avi;*.m4v)",
                        "所有文件 (*.*)"))
        return str(r[0]) if r else None

    def set_source(self, path: str) -> dict:
        """选定素材：校验存在性 + 生成框选缩略图，返回源信息。"""
        p = Path(path)
        if not p.exists():
            return {"ok": False, "error": f"文件不存在：{path}"}
        if p.suffix.lower() not in SUPPORTED_EXTS:
            return {"ok": False,
                    "error": f"不支持的格式 {p.suffix}（可选 {'/'.join(sorted(SUPPORTED_EXTS))}）"}
        try:
            info = _thumb_info(p)
        except Exception as e:
            return {"ok": False, "error": f"无法读取素材：{e}"}
        self._src = p
        return {"ok": True, "src": info}

    # ---- 实时预览（R2.1：预览即成品）----
    def render_preview(self, params: dict) -> dict:
        if not self._src:
            return {"ok": False, "error": "请先选择素材。"}
        t0 = time.perf_counter()
        try:
            opts = _build_options(params)
            result = render(self._src, opts)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        ms = (time.perf_counter() - t0) * 1000
        return {
            "ok": True,
            "frames": [frame_png_b64(f) for f in result.frames],
            "fps": result.fps,
            "animated": result.animated,
            "warnings": result.warnings,
            "elapsed_ms": round(ms, 1),
        }

    # ---- 导出 ----
    def save_dialog(self, default_name: str) -> Optional[str]:
        """保存位置对话框；取消返回 None。"""
        import webview
        r = self._window().create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=str(default_name or "output"),
            file_types=("GIF 动图 (*.gif)", "PNG (*.png)", "JPEG (*.jpg)",
                        "BMP (*.bmp)", "所有文件 (*.*)"))
        return str(r[0]) if r else None

    def export_file(self, params: dict, fmt: str, quality: int = 92,
                    outpath: str = "") -> dict:
        """按预览同款参数渲染并导出到用户指定位置（含预览 HTML）。"""
        if not self._src:
            return {"ok": False, "error": "请先选择素材。"}
        try:
            result = render(self._src, _build_options(params))
            out = Path(outpath) if outpath else \
                self._src.with_name(self._src.stem + "_oled." +
                                    (fmt if fmt != "jpeg" else "jpg"))
            out, notes = export(result, out, fmt, quality=int(quality))
            html = out.with_name(out.stem + "_preview.html")
            make_preview(out, result, html)
            return {"ok": True, "path": str(out), "preview": str(html),
                    "kb": round(out.stat().st_size / 1024, 1),
                    "frames": len(result.frames),
                    "notes": notes, "warnings": result.warnings}
        except Exception as e:
            return {"ok": False, "error": str(e)}
