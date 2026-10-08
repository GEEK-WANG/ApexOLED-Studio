# -*- coding: utf-8 -*-
"""F1 输入回归：图片格式 / 动图 / 视频 / 批量 / 健壮性。"""
import numpy as np
import pytest
from PIL import Image

from apexoled.engine import RenderOptions, render


@pytest.mark.parametrize("fmt", ["png", "jpg", "bmp", "webp"])
def test_static_image_formats(tmp_path, photo_png, fmt):
    p = tmp_path / f"photo.{fmt}"
    Image.open(photo_png).convert("RGB").save(p)
    result = render(p, RenderOptions(colors="bw"))
    assert len(result.frames) == 1
    assert not result.animated


def test_animated_gif_resampled_to_10fps(tmp_path, anim_gif):
    # 5 帧 × 100ms = 0.5s @10FPS → 5 帧
    result = render(anim_gif, RenderOptions(colors="bw"))
    assert result.animated
    assert len(result.frames) == 5
    assert result.frames[1].shape == (40, 128, 3)


def test_animated_gif_max_frames(tmp_path, anim_gif):
    result = render(anim_gif, RenderOptions(colors="bw", max_frames=3))
    assert len(result.frames) == 3


def test_video_duration_and_max_frames(tmp_path, sample_mp4):
    r1 = render(sample_mp4, RenderOptions(colors="bw"))
    assert len(r1.frames) == 20          # 2s @10FPS
    r2 = render(sample_mp4, RenderOptions(colors="bw", duration=1))
    assert len(r2.frames) == 10
    r3 = render(sample_mp4, RenderOptions(colors="bw", max_frames=5))
    assert len(r3.frames) == 5


def test_missing_file():
    with pytest.raises(FileNotFoundError, match="不存在"):
        render("no/such/file.png", RenderOptions())


def test_unsupported_ext(tmp_path):
    p = tmp_path / "data.txt"
    p.write_text("hello")
    with pytest.raises(ValueError, match="不支持的文件类型"):
        render(p, RenderOptions())


def test_corrupt_image_friendly_error(tmp_path):
    p = tmp_path / "bad.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\nnot a real png")
    with pytest.raises(RuntimeError, match="无法读取图片文件"):
        render(p, RenderOptions())


def test_crop_valid(tmp_path, photo_png):
    r_full = render(photo_png, RenderOptions(colors="bw"))
    r_crop = render(photo_png, RenderOptions(colors="bw",
                    crop={"w": 120, "h": 60, "x": 0, "y": 0}))
    assert r_full.frames[0].shape == r_crop.frames[0].shape == (40, 128, 3)
    assert not np.array_equal(r_full.frames[0], r_crop.frames[0])


def test_crop_out_of_bounds(tmp_path, photo_png):
    with pytest.raises(ValueError, match="超出图片范围"):
        render(photo_png, RenderOptions(crop={"w": 999, "h": 60, "x": 0, "y": 0}))
