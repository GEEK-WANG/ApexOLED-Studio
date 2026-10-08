# -*- coding: utf-8 -*-
"""R2 UI 桥回归：参数解析 / 预览闭环 / 导出 / 效果 meta。"""
import base64
import io

import numpy as np
import pytest
from PIL import Image

from apexoled.effects import effect_meta
from apexoled.ui.api import OledApi, _build_options, frame_png_b64


class TestBuildOptions:
    def test_defaults(self):
        o = _build_options({})
        assert o.fps == 10 and o.mode == "cover" and o.colors == "bw"
        assert o.effect is None and o.crop is None and o.logo is False
        assert o.effect_in == 0.8 and o.effect_hold == 1.6

    def test_effect_none_string(self):
        assert _build_options({"effect": "none"}).effect is None

    def test_crop_string_parsed(self):
        o = _build_options({"crop": "128x40+10+20"})
        assert o.crop == {"w": 128, "h": 40, "x": 10, "y": 20}

    def test_crop_invalid_raises(self):
        with pytest.raises(ValueError):
            _build_options({"crop": "abc"})

    def test_type_coercion(self):
        o = _build_options({"fps": "15", "palette": "16", "effect_in": "1.5",
                            "logo": True})
        assert o.fps == 15 and o.palette == 16 and o.effect_in == 1.5
        assert o.logo is True

    def test_duration_blank_is_none(self):
        assert _build_options({"duration": None}).duration is None
        assert _build_options({"duration": ""}).duration is None
        assert _build_options({"duration": 2.5}).duration == 2.5


class TestFrameEncode:
    def test_png_b64_roundtrip(self):
        f = np.full((40, 128, 3), 255, dtype=np.uint8)
        b64 = frame_png_b64(f)
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        assert img.size == (128, 40)
        arr = np.asarray(img.convert("RGB"))
        assert arr.mean() == 255


class TestEffectMeta:
    def test_covers_all_8(self):
        meta = effect_meta()
        assert set(meta) == {"fade", "wipe", "reveal", "zoom", "blinds",
                             "scanline", "pixelate", "breathing"}
        assert len(meta["wipe"]["directions"]) == 8
        assert meta["blinds"]["directions"] == ["h", "v"]
        assert meta["fade"]["directions"] == []


class TestOledApi:
    def test_app_info(self):
        info = OledApi().get_app_info()
        assert info["width"] == 128 and info["height"] == 40
        assert "effects" in info and len(info["effects"]) == 8

    def test_set_source_ok(self, logo_png):
        api = OledApi()
        r = api.set_source(str(logo_png))
        assert r["ok"]
        src = r["src"]
        assert src["w"] == 320 and src["h"] == 100
        assert not src["animated"]
        assert src["thumb"].startswith("data:image/png;base64,")
        assert 0 < src["thumb_scale"] <= 1

    def test_set_source_rejects(self, tmp_path):
        api = OledApi()
        assert not api.set_source(str(tmp_path / "nope.png"))["ok"]
        bad = tmp_path / "bad.txt"
        bad.write_text("x")
        assert not api.set_source(str(bad))["ok"]

    def test_preview_requires_source(self):
        r = OledApi().render_preview({})
        assert not r["ok"] and "素材" in r["error"]

    def test_preview_loop(self, logo_png):
        api = OledApi()
        api.set_source(str(logo_png))
        r = api.render_preview({"effect": "fade", "colors": "bw"})
        assert r["ok"]
        assert len(r["frames"]) == 36      # (0.8+1.6+0.8+0.4)×10
        assert r["fps"] == 10 and r["animated"] is True
        img = Image.open(io.BytesIO(base64.b64decode(r["frames"][0])))
        assert img.size == (128, 40)

    def test_preview_static_single_frame(self, logo_png):
        api = OledApi()
        api.set_source(str(logo_png))
        r = api.render_preview({"colors": "bw"})
        assert r["ok"] and len(r["frames"]) == 1 and r["animated"] is False

    def test_preview_effect_ignored_on_gif(self, anim_gif):
        api = OledApi()
        api.set_source(str(anim_gif))
        r = api.render_preview({"effect": "fade"})
        assert r["ok"]
        assert any("仅对静态图片生效" in w for w in r["warnings"])

    def test_preview_crop(self, logo_png):
        api = OledApi()
        api.set_source(str(logo_png))
        r = api.render_preview({"crop": "160x50+0+0"})
        assert r["ok"] and len(r["frames"]) == 1

    def test_export_file(self, logo_png, tmp_path):
        api = OledApi()
        api.set_source(str(logo_png))
        out = tmp_path / "logo_oled.png"
        r = api.export_file({"colors": "bw"}, "png", 92, str(out))
        assert r["ok"] and out.exists() and r["kb"] > 0
        assert r["frames"] == 1
        assert (tmp_path / "logo_oled_preview.html").exists()

    def test_export_gif_with_effect(self, logo_png, tmp_path):
        api = OledApi()
        api.set_source(str(logo_png))
        out = tmp_path / "logo_oled.gif"
        r = api.export_file({"effect": "fade"}, "gif", 92, str(out))
        assert r["ok"] and out.exists() and r["frames"] == 36

    def test_export_static_rejects_gif(self, logo_png, tmp_path):
        api = OledApi()
        api.set_source(str(logo_png))
        r = api.export_file({}, "gif", 92, str(tmp_path / "x.gif"))
        assert not r["ok"] and "GIF" in r["error"]
