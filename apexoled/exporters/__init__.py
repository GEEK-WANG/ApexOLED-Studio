# -*- coding: utf-8 -*-
"""导出调度（N1）：动态→GIF，静态→PNG/JPG/BMP；多帧导静态取首帧。"""
from pathlib import Path
from typing import List, Optional, Tuple

from ..engine import RenderResult
from .gif import save_gif
from .static import save_image

FORMATS = ("gif", "png", "jpg", "jpeg", "bmp")
_MIME = {"gif": "image/gif", "png": "image/png", "jpg": "image/jpeg",
         "jpeg": "image/jpeg", "bmp": "image/bmp"}


def default_format(result: RenderResult) -> str:
    """动态内容默认 GIF，纯静态默认 PNG（N1 联动规则）。"""
    return "gif" if result.animated else "png"


def export(result: RenderResult, path, fmt: Optional[str] = None,
           quality: int = 92) -> Tuple[Path, List[str]]:
    """导出渲染结果。返回 (实际输出路径, 提示信息列表)。"""
    if not fmt:
        fmt = default_format(result)
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise ValueError(f"不支持的导出格式：{fmt}（可选 {'/'.join(FORMATS)}）")
    path = Path(path)

    notes = []
    if fmt == "gif":
        if not result.animated:
            raise ValueError(
                "纯静态内容不支持导出 GIF：请选择 PNG/JPG/BMP，或为静态图添加动画效果。")
        save_gif(result.frames, path, result.fps, result.palette)
    else:
        if result.animated:
            notes.append("动态内容导出静态格式：已取首帧定格（建议改用 GIF）。")
        save_image(result.frames[0], path, fmt, quality)
    return path, notes
