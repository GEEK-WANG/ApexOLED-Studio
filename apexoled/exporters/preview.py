# -*- coding: utf-8 -*-
"""HTML 预览页（F8.1）：输出文件以 base64 内嵌，离线可看。"""
import base64
from pathlib import Path

from .. import APP_NAME

_MIME = {"gif": "image/gif", "png": "image/png", "jpg": "image/jpeg",
         "jpeg": "image/jpeg", "bmp": "image/bmp"}


def make_preview(out_path: Path, result, out_html: Path) -> None:
    """生成自包含预览 HTML。out_path 为已导出的输出文件。"""
    fmt = out_path.suffix.lstrip(".").lower() or "png"
    mime = _MIME.get(fmt, "application/octet-stream")
    data = base64.b64encode(Path(out_path).read_bytes()).decode("ascii")

    n_frames = len(result.frames)
    if result.animated:
        dur_s = n_frames / result.fps if result.fps else 0
        meta_frames = f"{n_frames} 帧 · {result.fps} FPS · 约 {dur_s:.1f} 秒 · 无限循环"
    else:
        meta_frames = "静态图片"
    size_kb = out_path.stat().st_size / 1024
    src_size_kb = result.src_size / 1024 if result.src_size else 0

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{APP_NAME} - 预览：{out_path.name}</title>
<style>
  body {{ background:#101014; color:#e8e8ea; font-family:'Microsoft YaHei',sans-serif;
         display:flex; flex-direction:column; align-items:center; padding:24px; }}
  h1 {{ font-size:18px; color:#ffb400; margin:8px 0 4px; }}
  .sub {{ color:#8a8a92; font-size:12px; margin-bottom:20px; }}
  .card {{ background:#1a1a22; border:1px solid #2c2c38; border-radius:10px;
          padding:20px; margin:10px; text-align:center; }}
  .zoom img {{ image-rendering:pixelated; width:512px; height:160px;
              border:1px solid #333; background:#000; }}
  table {{ border-collapse:collapse; margin:6px auto; font-size:13px; }}
  td {{ padding:3px 14px; }}
  td.k {{ color:#9a9aa4; text-align:right; }}
  td.v {{ color:#fff; text-align:left; }}
  .tip {{ max-width:560px; text-align:left; color:#b8b8c0; font-size:12px; line-height:1.7; }}
</style>
</head>
<body>
  <h1>🖥 预览 · {out_path.name}</h1>
  <div class="sub">Apex Pro TKL OLED · 128×40 · 10 FPS</div>
  <div class="card">
    <div class="sub">原始尺寸（1:1）</div>
    <img src="data:{mime};base64,{data}" alt="预览">
  </div>
  <div class="card zoom">
    <div class="sub">放大 4 倍（像素预览，接近人眼看键盘屏幕的效果）</div>
    <img src="data:{mime};base64,{data}" alt="预览放大">
  </div>
  <div class="card">
    <table>
      <tr><td class="k">内容</td><td class="v">{meta_frames}</td></tr>
      <tr><td class="k">输出大小</td><td class="v">{size_kb:.1f} KB（源文件 {src_size_kb:.1f} KB）</td></tr>
    </table>
  </div>
  <div class="tip">
    <b>上传步骤：</b>SteelSeries Engine → 选择键盘 → OLED &amp; Settings →
    Edit OLED Image → Upload From File → 选择本文件 → DONE → SAVE。<br>
    <b>小技巧：</b>OLED 屏幕小，建议画面高对比、主体居中、避免 1px 细线；
    动画越长文件越大，10FPS 下 60 帧 ≈ 6 秒，够用就好。
  </div>
</body>
</html>"""
    out_html.write_text(html, encoding="utf-8")
