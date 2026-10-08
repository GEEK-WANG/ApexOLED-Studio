# -*- coding: utf-8 -*-
"""pytest fixtures：合成素材（不依赖字体/外部资源，确定性可复现）。"""
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image, ImageDraw

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def make_logo(path):
    """白底 logo：橙色圆 + 黄色环 + 红色条（320×100，cover 后无裁剪精确映射）。"""
    im = Image.new("RGB", (320, 100), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.ellipse([10, 10, 90, 90], fill=(255, 140, 0))                 # 橙色主体
    d.ellipse([120, 20, 200, 80], outline=(255, 200, 0), width=8)  # 黄色环
    d.rectangle([230, 35, 310, 60], fill=(200, 30, 30))             # 红色条
    im.save(path)


def make_photo(path):
    """彩色渐变图 240×120。"""
    arr = np.zeros((120, 240, 3), np.uint8)
    x = np.linspace(0, 255, 240)
    y = np.linspace(0, 255, 120)
    arr[..., 0] = x[None, :]
    arr[..., 1] = y[:, None]
    arr[..., 2] = (x[None, :] + y[:, None]) // 2
    Image.fromarray(arr).save(path)


def make_white(path):
    """全白图 100×100（效果/fit 断言用）。"""
    Image.new("RGB", (100, 100), (255, 255, 255)).save(path)


def make_gray50(path):
    """白底 + 中央 50% 灰块 320×100（F4.3 抖动禁用断言用）。"""
    im = Image.new("RGB", (320, 100), (255, 255, 255))
    ImageDraw.Draw(im).rectangle([60, 20, 260, 80], fill=(100, 100, 100))
    im.save(path)


def make_anim_gif(path, n=5, duration=100):
    """5 帧 100ms 动图 64×32（红底白色滑块，0.5s @10FPS → 5 帧）。"""
    frames = []
    for i in range(n):
        a = np.zeros((32, 64, 3), np.uint8)
        a[..., 0] = 255
        a[:, i * 12:i * 12 + 16] = 255
        frames.append(Image.fromarray(a))
    frames[0].save(path, save_all=True, append_images=frames[1:],
                   duration=duration, loop=0)


@pytest.fixture
def logo_png(tmp_path):
    p = tmp_path / "logo.png"
    make_logo(p)
    return p


@pytest.fixture
def photo_png(tmp_path):
    p = tmp_path / "photo.png"
    make_photo(p)
    return p


@pytest.fixture
def white_png(tmp_path):
    p = tmp_path / "white.png"
    make_white(p)
    return p


@pytest.fixture
def gray50_png(tmp_path):
    p = tmp_path / "gray50.png"
    make_gray50(p)
    return p


@pytest.fixture
def anim_gif(tmp_path):
    p = tmp_path / "anim.gif"
    make_anim_gif(p)
    return p


@pytest.fixture
def sample_mp4(tmp_path):
    if not HAS_FFMPEG:
        pytest.skip("本机没有 FFmpeg，跳过视频用例")
    p = tmp_path / "sample.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", "testsrc=duration=2:size=160x120:rate=25",
         "-pix_fmt", "yuv420p", str(p)],
        check=True, capture_output=True)
    return p
