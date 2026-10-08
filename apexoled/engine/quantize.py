# -*- coding: utf-8 -*-
"""量化层（F6 / N2.2）：1 位黑白、灰度、彩色调色板；Floyd-Steinberg / Bayer / 无抖动。"""
from typing import List, Tuple

import numpy as np
from PIL import Image

# 8x8 Bayer 有序递色矩阵（归一化到 0..1）
_BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=np.float64) / 64.0


def _bayer_map(h: int, w: int) -> np.ndarray:
    ny, nx = (h + 7) // 8, (w + 7) // 8
    return np.tile(_BAYER8, (ny, nx))[:h, :w]


def _luma(f: np.ndarray) -> np.ndarray:
    """ITU-R 601-2 亮度（与 v1.x format=gray 一致）。"""
    r = f[..., 0].astype(np.uint32)
    g = f[..., 1].astype(np.uint32)
    b = f[..., 2].astype(np.uint32)
    return ((r * 299 + g * 587 + b * 114) // 1000).astype(np.uint8)


def _palette_image(colors: np.ndarray) -> Image.Image:
    """(K,3) 颜色数组 → P 模式调色板图（Pillow 量化基准）。"""
    cols = np.asarray(colors, dtype=np.uint8).reshape(-1, 3)
    lst = cols.reshape(-1).tolist()
    if len(cols) > 256:
        raise ValueError("调色板颜色数不能超过 256。")
    p = Image.new("P", (1, 1))
    p.putpalette(lst + [0] * (768 - len(lst)))
    return p


def _fs_quantize(frame_rgb: np.ndarray, pal_im: Image.Image) -> np.ndarray:
    """用固定调色板做 Floyd-Steinberg 误差扩散（Pillow C 实现）。"""
    im = Image.fromarray(frame_rgb)
    q = im.quantize(palette=pal_im, dither=Image.Dither.FLOYDSTEINBERG)
    return np.asarray(q.convert("RGB"), dtype=np.uint8).copy()


def quantize_bw(frames: List[np.ndarray], dither: str) -> List[np.ndarray]:
    """1 位黑白：auto=FS 平滑递色 / bayer=棋盘 / none=硬阈值 128。"""
    h, w = frames[0].shape[:2]
    out = []
    if dither == "none":
        for f in frames:
            g = _luma(f)
            out.append(_expand_gray((g >= 128).astype(np.uint8) * 255))
    elif dither == "bayer":
        th = _bayer_map(h, w) * 255.0
        for f in frames:
            g = _luma(f)
            out.append(_expand_gray((g > th).astype(np.uint8) * 255))
    else:  # auto / FS
        pal = _palette_image(np.array([[0, 0, 0], [255, 255, 255]]))
        for f in frames:
            g = _luma(f)
            replica = np.stack([g, g, g], axis=-1)
            out.append(_fs_quantize(replica, pal))
    return out


def quantize_gray(frames: List[np.ndarray], levels: int, dither: str) -> List[np.ndarray]:
    """灰度：均匀灰阶调色板（levels 级）。"""
    levels = int(max(2, min(256, levels)))
    gl = np.round(np.linspace(0, 255, levels)).astype(np.uint8)
    h, w = frames[0].shape[:2]
    out = []
    if dither == "none":
        for f in frames:
            g = _luma(f)
            idx = np.clip(np.round(g / 255.0 * (levels - 1)), 0, levels - 1).astype(int)
            out.append(_expand_gray(gl[idx]))
    elif dither == "bayer":
        th = _bayer_map(h, w)
        for f in frames:
            g = _luma(f).astype(np.float64)
            step = 255.0 / max(1, levels - 1)
            pert = g + (th - 0.5) * step
            idx = np.clip(np.round(pert / 255.0 * (levels - 1)), 0, levels - 1).astype(int)
            out.append(_expand_gray(gl[idx]))
    else:
        pal = _palette_image(np.stack([gl, gl, gl], axis=1))
        for f in frames:
            g = _luma(f)
            replica = np.stack([g, g, g], axis=-1)
            out.append(_fs_quantize(replica, pal))
    return out


def _nearest_palette(perturbed: np.ndarray, palette: np.ndarray) -> np.ndarray:
    """扰动后的帧映射到最近调色板颜色（Bayer 彩色路径）。"""
    pal = palette.astype(np.int32)
    f = perturbed.astype(np.int32)
    d = (f[..., None, :] - pal[None, None, :, :]) ** 2
    idx = np.argmin(d.sum(axis=-1), axis=-1)
    return palette[idx].astype(np.uint8)


def quantize_color(frames: List[np.ndarray], n_colors: int,
                   dither: str) -> Tuple[List[np.ndarray], np.ndarray]:
    """彩色：全帧共享自适应调色板（median cut），返回 (量化后帧, 调色板)。"""
    n = int(max(2, min(256, n_colors)))
    sample = np.concatenate(frames, axis=0) if len(frames) > 1 else frames[0]
    pal_im = Image.fromarray(sample).quantize(colors=n, method=Image.Quantize.MEDIANCUT)
    raw = pal_im.getpalette()[: 3 * n]
    palette = np.array(raw, dtype=np.uint8).reshape(n, 3)

    if dither in ("auto", "none"):
        d = Image.Dither.FLOYDSTEINBERG if dither == "auto" else Image.Dither.NONE
        out = []
        for f in frames:
            q = Image.fromarray(f).quantize(palette=pal_im, dither=d)
            out.append(np.asarray(q.convert("RGB"), dtype=np.uint8).copy())
        return out, palette

    # bayer：加性扰动 + 最近邻
    h, w = frames[0].shape[:2]
    offset = (_bayer_map(h, w)[..., None] - 0.5) * 96.0
    out = []
    for f in frames:
        pert = np.clip(f.astype(np.float64) + offset, 0, 255)
        out.append(_nearest_palette(pert, palette))
    return out, palette


def _expand_gray(g2: np.ndarray) -> np.ndarray:
    """单通道灰度 → 三通道 RGB。"""
    return np.stack([g2, g2, g2], axis=-1)
