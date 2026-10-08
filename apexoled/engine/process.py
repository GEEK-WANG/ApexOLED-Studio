# -*- coding: utf-8 -*-
"""帧级预处理：白底 Logo 优化（F4）/ 锐化增强（F5）/ cover-fit 缩放（F2.4）。"""
from typing import List

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

_BG_NAMES = {"black": (0, 0, 0), "white": (255, 255, 255),
             "grey": (128, 128, 128), "gray": (128, 128, 128),
             "red": (255, 0, 0), "green": (0, 128, 0), "blue": (0, 0, 255)}


def parse_bg(c: str):
    """背景色：black/white/#RRGGBB → (r,g,b)。"""
    c = (c or "black").strip()
    if c.lower() in _BG_NAMES:
        return _BG_NAMES[c.lower()]
    s = c.lstrip("#")
    if len(s) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in s):
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    raise ValueError(f"无法识别的背景色：{c}（支持 black/white/#RRGGBB）。")


def apply_logo_white_bg(frames: List[np.ndarray]) -> List[np.ndarray]:
    """F4.1：接近白色（三通道均 ≥235）的背景压成黑色，彩色文字原样保留。"""
    out = []
    for f in frames:
        g = f.copy()
        g[np.all(g >= 235, axis=-1)] = 0
        out.append(g)
    return out


def apply_bw_logo_threshold(frames: List[np.ndarray]) -> List[np.ndarray]:
    """F4.2：黑白模式逐通道阈值 120——任何亮通道拉白，暖色文字→白字黑底。"""
    return [np.where(f >= 120, 255, 0).astype(np.uint8) for f in frames]


def apply_enhance(frames: List[np.ndarray], level: str) -> List[np.ndarray]:
    """F5：锐化 / 对比度增强。light / strong 两档。"""
    out = []
    for f in frames:
        im = Image.fromarray(f)
        if level == "light":
            im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
            im = ImageEnhance.Contrast(im).enhance(1.06)
            im = ImageEnhance.Color(im).enhance(1.05)
        else:  # strong
            im = im.filter(ImageFilter.UnsharpMask(radius=3, percent=110, threshold=2))
            im = ImageEnhance.Contrast(im).enhance(1.12)
            im = ImageEnhance.Color(im).enhance(1.10)
            im = im.point(lambda v: int(255 * (v / 255) ** 0.95 + 0.5))
        out.append(np.asarray(im, dtype=np.uint8).copy())
    return out


def _resize_cover(im: Image.Image, W: int, H: int) -> Image.Image:
    w, h = im.size
    s = max(W / w, H / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    im = im.resize((nw, nh), Image.LANCZOS)
    x0, y0 = (nw - W) // 2, (nh - H) // 2
    return im.crop((x0, y0, x0 + W, y0 + H))


def _resize_fit(im: Image.Image, W: int, H: int, bg) -> Image.Image:
    w, h = im.size
    s = min(W / w, H / h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), bg)
    canvas.paste(im, ((W - nw) // 2, (H - nh) // 2))
    return canvas


def scale_frames(frames: List[np.ndarray], mode: str, bg: str,
                 W: int, H: int) -> List[np.ndarray]:
    """缩放到目标尺寸：cover 裁剪填满 / fit 等比完整显示加背景。"""
    bg_rgb = parse_bg(bg)
    out = []
    for f in frames:
        im = Image.fromarray(f)
        if mode == "cover":
            im = _resize_cover(im, W, H)
        else:
            im = _resize_fit(im, W, H, bg_rgb)
        out.append(np.asarray(im, dtype=np.uint8).copy())
    return out
