# -*- coding: utf-8 -*-
"""F4 白底 Logo / F5 增强 / F6 色彩与抖动 回归。"""
import numpy as np
import pytest
from PIL import Image

from apexoled.engine import RenderOptions, render


def _frame(path, **kw):
    return render(path, RenderOptions(**kw)).frames[0]


class TestLogo:
    def test_white_bg_becomes_black(self, logo_png):
        # logo 320×100 → cover 精确 128×40；左上角原为白底
        f = _frame(logo_png, colors="bw", logo=True)
        assert f[2, 2].tolist() == [0, 0, 0]

    def test_bw_logo_channel_threshold(self, logo_png):
        f = _frame(logo_png, colors="bw", logo=True)
        # 橙色圆 (255,140,0)：R/G 通道 ≥120 → 灰度≈225 → 白
        assert f[20, 20].tolist() == [255, 255, 255]
        # 红色条 (200,30,30)：仅 R 亮 → 灰度≈60 → 黑
        assert f[19, 100].tolist() == [0, 0, 0]
        # 黄色环 (255,200,0) → 白（环左弧位于目标 (20, 50) 附近）
        assert f[20, 50].tolist() == [255, 255, 255]

    def test_color_logo_keeps_colored_text(self, logo_png):
        f = _frame(logo_png, colors="color", logo=True)
        # 白底压黑，橙色保留
        assert f[2, 2].tolist() == [0, 0, 0]
        assert f[20, 20][0] > 180 and 80 < f[20, 20][1] < 200

    def test_logo_bw_disables_dither(self, gray50_png):
        # 中央 100 灰块：logo 模式逐通道阈值 → 均匀黑；无 logo 时 FS 递色 → 黑白混合
        f_logo = _frame(gray50_png, colors="bw", logo=True)
        region = f_logo[10:30, 30:90]
        assert set(np.unique(region).tolist()) == {0}     # F4.3 无杂点
        f_plain = _frame(gray50_png, colors="bw", logo=False)
        region2 = f_plain[10:30, 30:90]
        assert 0 in np.unique(region2) and 255 in np.unique(region2)  # 递色混合


class TestEnhance:
    @pytest.mark.parametrize("level", ["light", "strong"])
    def test_enhance_changes_output(self, photo_png, level):
        f0 = _frame(photo_png, colors="gray", enhance="none")
        f1 = _frame(photo_png, colors="gray", enhance=level)
        assert f0.shape == f1.shape == (40, 128, 3)
        assert not np.array_equal(f0, f1)

    def test_strong_differs_from_light(self, photo_png):
        fl = _frame(photo_png, colors="gray", enhance="light")
        fs = _frame(photo_png, colors="gray", enhance="strong")
        assert not np.array_equal(fl, fs)


class TestColors:
    def test_bw_only_two_values(self, photo_png):
        f = _frame(photo_png, colors="bw")
        assert set(np.unique(f).tolist()) <= {0, 255}

    def test_gray_levels(self, photo_png):
        f = _frame(photo_png, colors="gray", palette=4)
        vals = np.unique(f[..., 0])
        assert len(vals) <= 4

    def test_color_palette_size(self, photo_png):
        f = _frame(photo_png, colors="color", palette=8)
        colors = np.unique(f.reshape(-1, 3), axis=0)
        assert len(colors) <= 8

    @pytest.mark.parametrize("dither", ["auto", "none", "bayer"])
    def test_dither_modes_run(self, photo_png, dither):
        f = _frame(photo_png, colors="bw", dither=dither)
        assert set(np.unique(f).tolist()) <= {0, 255}

    def test_bayer_dithers_midgray(self, gray50_png):
        # 100 灰（<128）：bayer 递色应产生黑白混合
        f = _frame(gray50_png, colors="bw", dither="bayer")
        region = f[10:30, 30:90]
        assert 0 in np.unique(region) and 255 in np.unique(region)

    def test_dither_none_uniform(self, gray50_png):
        f = _frame(gray50_png, colors="bw", dither="none")
        region = f[10:30, 30:90]
        assert set(np.unique(region).tolist()) == {0}   # 100 < 128 全黑


class TestMode:
    def test_fit_mode_padding(self, white_png):
        # 100×100 → fit：内容 40×40 居中，左右留背景（黑）
        f = _frame(white_png, colors="bw", mode="fit", bg="black")
        assert f[20, 10].tolist() == [0, 0, 0]        # 左侧背景
        assert f[20, 64].tolist() == [255, 255, 255]  # 中央内容

    def test_fit_white_bg(self, tmp_path):
        # 黑色内容 + 白色背景：fit 时背景应为白
        p = tmp_path / "black.png"
        Image.new("RGB", (100, 100), (0, 0, 0)).save(p)
        f = _frame(p, colors="bw", mode="fit", bg="white")
        assert f[20, 10].tolist() == [255, 255, 255]  # 背景白
        assert f[20, 64].tolist() == [0, 0, 0]        # 内容黑
