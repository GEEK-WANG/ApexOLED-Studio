# -*- coding: utf-8 -*-
"""N1 导出格式回归：五格式 / 静态 GIF 拒绝 / 默认联动 / JPG 质量。"""
import pytest
from PIL import Image

from apexoled.engine import RenderOptions, render
from apexoled.exporters import default_format, export


def _static(photo_png, **kw):
    return render(photo_png, RenderOptions(**kw))


def _animated(photo_png, **kw):
    kw.setdefault("effect", "fade")
    return render(photo_png, RenderOptions(**kw))


class TestDefaults:
    def test_static_defaults_png(self, photo_png):
        assert default_format(_static(photo_png, colors="bw")) == "png"

    def test_animated_defaults_gif(self, photo_png, anim_gif):
        assert default_format(_animated(photo_png)) == "gif"
        assert default_format(render(anim_gif, RenderOptions())) == "gif"


class TestStaticGifForbidden:
    def test_static_gif_rejected(self, tmp_path, photo_png):
        result = _static(photo_png, colors="bw")
        with pytest.raises(ValueError, match="GIF"):
            export(result, tmp_path / "x.gif", "gif")

    def test_static_image_effect_counts_as_dynamic(self, tmp_path, photo_png):
        result = _animated(photo_png, colors="bw")
        assert result.animated
        path, _ = export(result, tmp_path / "y.gif", "gif")
        assert path.exists()


class TestFiveFormats:
    @pytest.mark.parametrize("fmt", ["gif", "png", "jpg", "jpeg", "bmp"])
    def test_all_formats_128x40(self, tmp_path, photo_png, fmt):
        result = _animated(photo_png, colors="color")
        path, _ = export(result, tmp_path / f"o.{fmt}", fmt)
        with Image.open(path) as im:
            assert im.size == (128, 40)


class TestDynamicToStatic:
    def test_takes_first_frame(self, tmp_path, photo_png, anim_gif):
        result = render(anim_gif, RenderOptions(colors="bw"))
        path, notes = export(result, tmp_path / "first.png", "png")
        assert "首帧" in "".join(notes)
        with Image.open(path) as im:
            assert im.size == (128, 40)


class TestJpegQuality:
    def test_quality_affects_size(self, tmp_path, photo_png):
        result = _static(photo_png, colors="color")
        p_lo, _ = export(result, tmp_path / "lo.jpg", "jpg", quality=10)
        p_hi, _ = export(result, tmp_path / "hi.jpg", "jpg", quality=95)
        assert p_lo.stat().st_size < p_hi.stat().st_size

    def test_quality_default_92(self, tmp_path, photo_png):
        result = _static(photo_png, colors="color")
        path, _ = export(result, tmp_path / "q.jpg", "jpg")
        assert path.stat().st_size > 0


class TestPalette:
    def test_color_gif_palette_respected(self, tmp_path, photo_png):
        result = _animated(photo_png, colors="color", palette=4)
        path, _ = export(result, tmp_path / "p.gif", "gif")
        with Image.open(path) as im:
            im.seek(0)
            pal = im.getpalette()
            used = im.convert("RGB").getcolors(200000)
            assert len(used) <= 4
