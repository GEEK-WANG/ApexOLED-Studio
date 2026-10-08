# -*- coding: utf-8 -*-
"""8 类效果帧变换函数（R1.1：每个效果 = 一个变换函数，注册即用）。

约定：frame 为 RGB uint8（H,W,3），p 为该段进度 0~1（进场 0→1，退场倒放）。
所有函数返回新数组，不修改入参。
"""
import math

import numpy as np
from PIL import Image

WIPE_DIRECTIONS = ("l2r", "r2l", "t2b", "b2t", "tl2br", "tr2bl", "bl2tr", "br2tl")


def _clip(f):
    return np.clip(f, 0, 255).astype(np.uint8)


def fade(frame, p, direction=None):
    """淡入淡出：整体亮度随 p 线性变化。"""
    return _clip(frame.astype(np.float32) * p)


def wipe(frame, p, direction="l2r"):
    """擦除/揭开：画面从 direction 方向逐块显现（硬边缘，v1.x 风格）。"""
    h, w = frame.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    if direction == "l2r":
        m = xx < p * w
    elif direction == "r2l":
        m = xx >= (1 - p) * w
    elif direction == "t2b":
        m = yy < p * h
    elif direction == "b2t":
        m = yy >= (1 - p) * h
    elif direction == "tl2br":
        m = (xx + yy) < p * (w + h)
    elif direction == "tr2bl":
        m = ((w - 1 - xx) + yy) < p * (w + h)
    elif direction == "bl2tr":
        m = (xx + (h - 1 - yy)) < p * (w + h)
    elif direction == "br2tl":
        m = ((w - 1 - xx) + (h - 1 - yy)) < p * (w + h)
    else:
        raise ValueError(f"未知的擦除方向：{direction}（可选 {'/'.join(WIPE_DIRECTIONS)}）")
    return _clip(frame.astype(np.float32) * m[..., None])


def zoom(frame, p, direction=None):
    """缩放渐显（N2.8）：从 80% 放大到 100%，居中。"""
    h, w = frame.shape[:2]
    s = 0.8 + 0.2 * p
    nw, nh = max(2, round(w * s)), max(2, round(h * s))
    im = Image.fromarray(frame).resize((nw, nh), Image.BILINEAR)
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    x0, y0 = (w - nw) // 2, (h - nh) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = np.asarray(im)
    return canvas


def blinds(frame, p, direction="h"):
    """百叶窗（N2.9）：横向 h / 纵向 v 条纹展开。"""
    h, w = frame.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    if direction == "h":
        band = max(2, h // 5)
        m = (yy % band) < p * band
    elif direction == "v":
        band = max(2, w // 8)
        m = (xx % band) < p * band
    else:
        raise ValueError(f"未知的百叶窗方向：{direction}（可选 h/v）")
    return _clip(frame.astype(np.float32) * m[..., None])


def scanline(frame, p, direction="t2b"):
    """扫描线（N2.10）：逐行点亮，前端带一条高亮扫描线。"""
    h, w = frame.shape[:2]
    out = np.zeros_like(frame)
    n = int(p * h)
    if direction == "t2b":
        out[:n] = frame[:n]
        if n < h:
            out[n] = 255
    elif direction == "b2t":
        out[h - n:] = frame[h - n:]
        if n < h:
            out[h - n - 1] = 255
    else:
        raise ValueError(f"未知的扫描线方向：{direction}（可选 t2b/b2t）")
    return out


def pixelate(frame, p, direction=None):
    """像素化浮现（N2.11）：从马赛克逐步变清晰（起始块约 16px）。"""
    h, w = frame.shape[:2]
    b = max(1, int(round(16 * (1 - p))))
    if b == 1:
        return frame.copy()
    nw, nh = max(1, (w + b - 1) // b), max(1, (h + b - 1) // b)
    im = Image.fromarray(frame).resize((nw, nh), Image.NEAREST)
    im = im.resize((w, h), Image.NEAREST)
    return np.asarray(im, dtype=np.uint8).copy()


def breathing(frame, p, direction=None):
    """呼吸（N2.12）：亮度平滑起伏（下限 30%）。双向使用时构成完整呼吸循环。"""
    m = 0.3 + 0.7 * (0.5 - 0.5 * math.cos(math.pi * p))
    return _clip(frame.astype(np.float32) * m)
