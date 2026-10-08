# -*- coding: utf-8 -*-
"""F2 规格回归：128×40 / 10FPS / 无限循环。"""
import numpy as np
import pytest
from PIL import Image

from apexoled import HEIGHT, WIDTH
from apexoled.engine import RenderOptions, render
from apexoled.exporters import export


def _save_gif(tmp_path, photo_png, **kw):
    kw.setdefault("effect", "fade")     # 动画由效果产生
    result = render(photo_png, RenderOptions(**kw))
    return export(result, tmp_path / "out.gif", "gif")


def test_gif_size_128x40(tmp_path, photo_png):
    path, _ = _save_gif(tmp_path, photo_png, colors="color")
    with Image.open(path) as im:
        assert im.size == (WIDTH, HEIGHT)


def test_gif_infinite_loop_and_fps(tmp_path, photo_png):
    path, _ = _save_gif(tmp_path, photo_png, colors="bw")
    with Image.open(path) as im:
        assert im.info.get("loop") == 0            # 无限循环
        im.seek(0)
        assert im.info.get("duration") == 100       # 10FPS → 100ms/帧


def test_gif_custom_fps(tmp_path, photo_png):
    # fps=5 → 每帧 200ms
    result = render(photo_png, RenderOptions(colors="bw", effect="fade", fps=5))
    path, _ = export(result, tmp_path / "o5.gif", "gif")
    with Image.open(path) as im:
        im.seek(0)
        assert im.info.get("duration") == 200


def test_all_formats_size(tmp_path, photo_png):
    for fmt in ("gif", "png", "jpg", "bmp"):
        result = render(photo_png, RenderOptions(colors="color", effect="fade"))
        path, _ = export(result, tmp_path / f"o.{fmt}", fmt)
        with Image.open(path) as im:
            assert im.size == (WIDTH, HEIGHT), fmt


def test_effect_frames_respect_fps_and_still_128x40(tmp_path, photo_png):
    result = render(photo_png, RenderOptions(colors="bw", effect="fade", fps=10))
    for f in result.frames:
        assert f.shape == (HEIGHT, WIDTH, 3)
