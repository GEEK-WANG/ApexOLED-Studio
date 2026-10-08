# -*- coding: utf-8 -*-
"""静态图导出：PNG / JPG(JPEG) / BMP（N1：多帧内容取首帧定格）。"""
from pathlib import Path

from PIL import Image


def save_image(frame, path, fmt: str, quality: int = 92) -> None:
    im = Image.fromarray(frame)
    path = Path(path)
    if fmt in ("jpg", "jpeg"):
        im.save(str(path), format="JPEG", quality=int(quality), optimize=True)
    elif fmt == "png":
        im.save(str(path), format="PNG", optimize=True)
    elif fmt == "bmp":
        im.save(str(path), format="BMP")
    else:
        raise ValueError(f"不支持的静态格式：{fmt}")
