# -*- coding: utf-8 -*-
"""F8.2 / N2 体积目标：静态 ≤2KB 级；效果动画 ≤16KB。"""
from apexoled.engine import RenderOptions, render
from apexoled.exporters import export


def test_bw_static_png_small(tmp_path, white_png):
    result = render(white_png, RenderOptions(colors="bw"))
    path, _ = export(result, tmp_path / "s.png", "png")
    assert path.stat().st_size <= 2 * 1024


def test_bw_effect_gif_within_16kb(tmp_path, white_png):
    result = render(white_png, RenderOptions(colors="bw", effect="fade"))
    path, _ = export(result, tmp_path / "a.gif", "gif")
    assert path.stat().st_size <= 16 * 1024


def test_bw_wipe_gif_within_16kb(tmp_path, white_png):
    result = render(white_png, RenderOptions(colors="bw", effect="wipe:l2r+fade"))
    path, _ = export(result, tmp_path / "w.gif", "gif")
    assert path.stat().st_size <= 16 * 1024


def test_all_effects_gif_within_16kb(tmp_path, white_png):
    """8 类效果默认时间轴下 GIF 全部 ≤16KB（体积目标回归）。"""
    for effect in ("fade", "wipe", "reveal", "zoom", "blinds",
                   "scanline", "pixelate", "breathing"):
        result = render(white_png, RenderOptions(colors="bw", effect=effect))
        path, _ = export(result, tmp_path / f"{effect}.gif", "gif")
        assert path.stat().st_size <= 16 * 1024, effect
