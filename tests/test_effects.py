# -*- coding: utf-8 -*-
"""F7 / N2 效果系统回归：8 类效果、方向、组合、时间轴、平滑递色。"""
import numpy as np
import pytest

from apexoled.effects import parse_effect_spec
from apexoled.effects.timeline import EffectConfig, MAX_FRAMES, build_effect_frames

ALL_EFFECTS = ["fade", "wipe", "reveal", "zoom", "blinds",
              "scanline", "pixelate", "breathing"]


def _render_effect(path, effect, **kw):
    from apexoled.engine import RenderOptions, render
    opts = dict(effect=effect, colors="bw")
    opts.update(kw)
    return render(path, RenderOptions(**opts))


def _mean(f):
    return float(f.mean())


class TestRegistry:
    def test_parse_basic(self):
        i, o = parse_effect_spec("fade")
        assert i.name == o.name == "fade"

    def test_parse_direction_and_combo(self):
        i, o = parse_effect_spec("wipe:l2r+fade")
        assert (i.name, i.direction) == ("wipe", "l2r")
        assert o.name == "fade"

    def test_parse_none(self):
        assert parse_effect_spec("none") == (None, None)
        assert parse_effect_spec("") == (None, None)

    def test_unknown_effect(self):
        with pytest.raises(ValueError, match="未知效果"):
            parse_effect_spec("magic")

    def test_bad_direction(self):
        with pytest.raises(ValueError, match="不支持方向"):
            parse_effect_spec("wipe:diagonal")


class TestTimeline:
    def test_default_frame_count(self, white_png):
        r = _render_effect(white_png, "fade")
        # 默认 0.8+1.6+0.8+0.4 = 3.6s @10FPS = 36 帧
        assert len(r.frames) == 36

    def test_custom_segments(self, white_png):
        r = _render_effect(white_png, "fade", effect_in=1, effect_hold=1,
                           effect_out=1, effect_gap=1)
        assert len(r.frames) == 40

    def test_gap_zero_seamless(self, white_png):
        r = _render_effect(white_png, "fade", effect_gap=0)
        assert len(r.frames) == 32          # 36 - 4 帧黑屏
        # 末帧为退场自然结束帧（fade p=0 全黑），而非额外黑屏帧
        assert _mean(r.frames[-1]) == 0

    def test_frame_cap_60(self, white_png):
        r = _render_effect(white_png, "fade", effect_in=10, effect_hold=10,
                           effect_out=10, effect_gap=10)
        assert len(r.frames) == MAX_FRAMES
        assert any("压缩" in w for w in r.warnings)

    def test_zero_total_raises(self, white_png):
        from apexoled.effects import EffectSpec
        with pytest.raises(ValueError, match="总时长为 0"):
            build_effect_frames(np.zeros((40, 128, 3), np.uint8),
                                EffectConfig(EffectSpec("fade"), EffectSpec("fade"),
                                             0, 0, 0, 0))


class TestEffects:
    @pytest.mark.parametrize("effect", ALL_EFFECTS)
    def test_all_effects_run_and_specs(self, white_png, effect):
        r = _render_effect(white_png, effect)
        assert r.animated
        assert len(r.frames) == 36
        for f in r.frames:
            assert f.shape == (40, 128, 3)
            assert set(np.unique(f).tolist()) <= {0, 255}

    def test_hold_frame_is_full_image(self, white_png):
        r = _render_effect(white_png, "wipe")
        hold = r.frames[10]     # 8 帧进场后为停留段
        assert _mean(hold) == 255

    def test_gap_frames_black(self, white_png):
        r = _render_effect(white_png, "fade")
        assert _mean(r.frames[-1]) == 0
        assert _mean(r.frames[-4]) == 0

    def test_bw_fade_smooth_no_hard_cut(self, white_png):
        """N2.2：黑白 fade 逐帧灰度递变（FS 递色），无整体硬切。"""
        r = _render_effect(white_png, "fade", effect_in=1.0)  # 进场 10 帧
        means = [_mean(f) for f in r.frames[:10]]
        for a, b in zip(means, means[1:]):
            assert b >= a - 2            # 单调不减（容差）
            assert b - a < 40            # 无硬切跳变
        # 过渡帧应有黑白混合（递色），而非全黑/全白两态切换
        for f in r.frames[2:8]:
            vals = np.unique(f)
            assert 0 in vals and 255 in vals

    def test_wipe_l2r_geometry(self, white_png):
        r = _render_effect(white_png, "wipe:l2r", effect_in=1.0)  # 10 帧进场
        f = r.frames[2]          # p=0.2 → 左侧约 26 列可见
        assert f[:, 8].mean() == 255      # 左侧内容
        assert f[:, 100].mean() == 0      # 右侧未显现

    def test_wipe_directions_differ(self, white_png):
        base = dict(effect_in=1.0)
        r_l = _render_effect(white_png, "wipe:l2r", **base)
        r_r = _render_effect(white_png, "wipe:r2l", **base)
        assert not np.array_equal(r_l.frames[2], r_r.frames[2])

    @pytest.mark.parametrize("direction", ["t2b", "b2t", "tl2br", "tr2bl", "bl2tr", "br2tl"])
    def test_wipe_all_directions(self, white_png, direction):
        r = _render_effect(white_png, f"wipe:{direction}", effect_in=1.0)
        # 10(进场) + 16(停留) + 8(退场) + 4(黑屏)
        assert len(r.frames) == 38

    def test_reveal_equals_wipe_t2b(self, white_png):
        r1 = _render_effect(white_png, "reveal", effect_in=1.0)
        r2 = _render_effect(white_png, "wipe:t2b", effect_in=1.0)
        assert np.array_equal(r1.frames[2], r2.frames[2])

    def test_combo_in_wipe_out_fade(self, white_png):
        r = _render_effect(white_png, "wipe:l2r+fade", effect_in=1.0, effect_out=1.0)
        assert len(r.frames) == 40      # 10 + 16 + 10 + 4
        # 进场第 3 帧呈擦除形态（左侧可见右侧黑）
        assert r.frames[2][:, 100].mean() == 0
        # 退场段（末 10 帧前 4 帧起）亮度递减
        out_means = [_mean(f) for f in r.frames[-14:-4]]
        assert out_means[0] > out_means[-1]

    def test_zoom_grows_from_center(self, white_png):
        r = _render_effect(white_png, "zoom", effect_in=1.0)
        first = r.frames[0]
        # 80% 缩放：上下留黑边
        assert first[0, 64].mean() == 0
        assert first[20, 64].mean() == 255

    def test_pixelate_final_clear(self, photo_png):
        # 显式关抖动：本用例比较几何恢复（p=1.0 时马赛克回到原图），
        # 效果时间轴 auto→bayer 与无效果 FS 的抖动图案差异不在断言范围内
        r = _render_effect(photo_png, "pixelate", effect_in=1.0, dither="none")
        r_none = _render_effect(photo_png, "none", dither="none")
        # 末进场帧 = 清晰原图（与无效果量化一致）
        assert np.array_equal(r.frames[9], r_none.frames[0])
        # 早期帧为马赛克（与清晰帧不同）
        assert not np.array_equal(r.frames[0], r_none.frames[0])

    def test_scanline_row_by_row(self, white_png):
        r = _render_effect(white_png, "scanline:t2b", effect_in=1.0)
        f = r.frames[4]          # p=4/9 → 前 17 行点亮，扫描线在第 17 行
        assert f[5, 64].mean() == 255
        assert f[30, 64].mean() == 0
        assert f[17, 64].mean() == 255      # 高亮扫描线行

    def test_blinds_bands(self, white_png):
        r = _render_effect(white_png, "blinds:h", effect_in=1.0)
        f = r.frames[4]          # p=0.5，带高 8 → 每带前 4 行白
        assert f[1, 64].mean() == 255
        assert f[6, 64].mean() == 0

    def test_breathing_full_cycle(self, white_png):
        r = _render_effect(white_png, "breathing")
        means = [_mean(f) for f in r.frames]
        vis = means[:32]         # 非黑屏段
        assert vis[0] < vis[16] and vis[16] > vis[31]   # 暗→亮→暗
        assert means[-1] == 0    # 黑屏段

    def test_effect_ignored_on_animated(self, anim_gif):
        r_plain = _render_effect(anim_gif, "none")
        r_eff = _render_effect(anim_gif, "fade")
        assert len(r_eff.frames) == len(r_plain.frames) == 5
        assert any("仅对静态图片生效" in w for w in r_eff.warnings)


class TestEffectCombos:
    def test_effect_x_logo_x_colors(self, logo_png):
        """效果 × 白底 logo × 色彩模式 组合全过（N2 约束）。"""
        for effect in ("fade", "wipe:l2r", "pixelate"):
            for colors in ("bw", "gray", "color"):
                for enhance in ("none", "light"):
                    r = _render_effect(logo_png, effect, colors=colors,
                                       logo=True, enhance=enhance)
                    assert len(r.frames) == 36
                    assert r.frames[0].shape == (40, 128, 3)

    def test_effect_x_dither(self, photo_png):
        for effect in ("fade", "zoom", "breathing"):
            for dither in ("auto", "none", "bayer"):
                r = _render_effect(photo_png, effect, dither=dither)
                assert len(r.frames) == 36
