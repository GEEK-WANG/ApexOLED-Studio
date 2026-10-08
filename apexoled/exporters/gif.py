# -*- coding: utf-8 -*-
"""GIF 导出：128×40、10FPS、无限循环（Pillow 逐帧编码，delay=100ms，loop=0）。"""
from pathlib import Path

import numpy as np
from PIL import Image


def _palette_image(colors: np.ndarray) -> Image.Image:
    cols = np.asarray(colors, dtype=np.uint8).reshape(-1, 3)
    lst = cols.reshape(-1).tolist()
    p = Image.new("P", (1, 1))
    p.putpalette(lst + [0] * (768 - len(lst)))
    return p


def save_gif(frames, path, fps, palette=None) -> None:
    if len(frames) < 2:
        raise ValueError("纯静态内容不支持导出 GIF：请选择 PNG/JPG/BMP，或为静态图添加动画效果。")
    if palette is not None:
        pal_colors = np.asarray(palette, dtype=np.uint8).reshape(-1, 3)
    else:
        uniq = np.unique(np.concatenate([f.reshape(-1, 3) for f in frames]), axis=0)
        pal_colors = uniq
    pal_im = _palette_image(pal_colors)

    pframes = [Image.fromarray(f).quantize(palette=pal_im, dither=Image.Dither.NONE)
               for f in frames]
    duration = int(round(1000 / fps))
    pframes[0].save(str(path), save_all=True, append_images=pframes[1:],
                    duration=duration, loop=0, optimize=True)
