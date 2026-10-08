# -*- coding: utf-8 -*-
"""F9 CLI 回归：参数解析 / 批量 / 框选 crop / 友好报错 / 预览 HTML。"""
import pytest
from PIL import Image

from apexoled.cli.main import main
from apexoled.decode import parse_crop


def _run(argv):
    main(argv)


class TestBasic:
    def test_static_defaults_to_png(self, tmp_path, photo_png, capsys):
        _run([str(photo_png), "--outdir", str(tmp_path)])
        out = tmp_path / "photo_oled.png"
        assert out.exists()
        assert "完成" in capsys.readouterr().out

    def test_version(self, capsys):
        with pytest.raises(SystemExit) as e:
            _run(["--version"])
        assert e.value.code == 0
        assert "ApexOLED Studio" in capsys.readouterr().out

    def test_no_inputs_exits(self, capsys):
        with pytest.raises(SystemExit) as e:
            _run([])
        assert e.value.code == 1

    def test_preview_html_generated(self, tmp_path, photo_png):
        _run([str(photo_png), "--outdir", str(tmp_path)])
        assert (tmp_path / "photo_oled_preview.html").exists()

    def test_no_preview_flag(self, tmp_path, photo_png):
        _run([str(photo_png), "--outdir", str(tmp_path), "--no-preview"])
        assert not (tmp_path / "photo_oled_preview.html").exists()


class TestBatch:
    def test_folder_batch(self, tmp_path, photo_png, white_png, capsys):
        src = tmp_path / "in"
        src.mkdir()
        Image.open(photo_png).save(src / "a.png")
        Image.open(white_png).save(src / "b.png")
        outdir = tmp_path / "out"
        _run([str(src), "--outdir", str(outdir)])
        assert (outdir / "a_oled.png").exists()
        assert (outdir / "b_oled.png").exists()

    def test_batch_ignores_output_flag(self, tmp_path, photo_png, white_png, capsys):
        src = tmp_path / "in"
        src.mkdir()
        Image.open(photo_png).save(src / "a.png")
        Image.open(white_png).save(src / "b.png")
        _run([str(src), "-o", str(tmp_path / "single.png"),
              "--outdir", str(tmp_path / "out")])
        assert "忽略" in capsys.readouterr().out
        assert not (tmp_path / "single.png").exists()


class TestErrors:
    def test_static_gif_rejected_friendly(self, tmp_path, photo_png, capsys):
        with pytest.raises(SystemExit) as e:
            _run([str(photo_png), "--outdir", str(tmp_path),
                  "--format", "gif", "--no-preview"])
        assert e.value.code == 1
        assert "GIF" in capsys.readouterr().out

    def test_bad_crop_format(self, tmp_path, photo_png, capsys):
        with pytest.raises(SystemExit) as e:
            _run([str(photo_png), "--crop", "abc", "--outdir", str(tmp_path)])
        assert e.value.code == 1
        assert "参数错误" in capsys.readouterr().out

    def test_crop_out_of_bounds(self, tmp_path, photo_png, capsys):
        with pytest.raises(SystemExit) as e:
            _run([str(photo_png), "--crop", "999x999+0+0",
                  "--outdir", str(tmp_path), "--no-preview"])
        assert e.value.code == 1
        assert "超出图片范围" in capsys.readouterr().out

    def test_bad_effect_name(self, tmp_path, photo_png, capsys):
        with pytest.raises(SystemExit) as e:
            _run([str(photo_png), "--effect", "magic", "--outdir", str(tmp_path)])
        assert e.value.code == 1
        assert "未知效果" in capsys.readouterr().out


class TestCropUnit:
    def test_parse_crop(self):
        assert parse_crop("430x140+70+60") == {"w": 430, "h": 140, "x": 70, "y": 60}

    def test_parse_crop_invalid(self):
        with pytest.raises(ValueError):
            parse_crop("430")


def _gif_total_duration(path):
    """GIF 总时长（ms）。Pillow 会合并相同帧并累加时长，帧数以引擎为准。"""
    with Image.open(path) as im:
        total = 0
        for i in range(im.n_frames):
            im.seek(i)
            total += im.info.get("duration", 0)
    return total


class TestNewParams:
    def test_effect_timeline_params(self, tmp_path, photo_png):
        _run([str(photo_png), "--effect", "wipe:l2r+fade",
              "--effect-in", "0.5", "--effect-hold", "1", "--effect-out", "0.5",
              "--effect-gap", "0", "--outdir", str(tmp_path), "--no-preview"])
        gif = tmp_path / "photo_oled.gif"
        # 总时长 = (0.5+1+0.5+0)*10 帧 × 100ms
        assert _gif_total_duration(gif) == 20 * 100
        with Image.open(gif) as im:
            assert im.info.get("loop") == 0

    def test_effect_duration_legacy(self, tmp_path, photo_png):
        _run([str(photo_png), "--effect", "fade", "--effect-duration", "0.5",
              "--outdir", str(tmp_path), "--no-preview"])
        # (0.5+1.6+0.5+0.4)*10 = 30 帧 × 100ms
        assert _gif_total_duration(tmp_path / "photo_oled.gif") == 30 * 100

    def test_format_and_quality(self, tmp_path, photo_png):
        _run([str(photo_png), "--format", "jpg", "--quality", "80",
              "--outdir", str(tmp_path), "--no-preview"])
        assert (tmp_path / "photo_oled.jpg").exists()

    def test_output_ext_autofix(self, tmp_path, photo_png, capsys):
        _run([str(photo_png), "--format", "jpg", "-o", str(tmp_path / "out.png"),
              "--no-preview"])
        assert (tmp_path / "out.jpg").exists()
        assert "扩展名" in capsys.readouterr().out

    def test_chinese_path(self, tmp_path, photo_png):
        cn_dir = tmp_path / "中文目录"
        cn_dir.mkdir()
        import shutil
        shutil.copy(photo_png, cn_dir / "图片 一.png")
        _run([str(cn_dir / "图片 一.png"), "--outdir", str(cn_dir),
              "--no-preview"])
        assert (cn_dir / "图片 一_oled.png").exists()
