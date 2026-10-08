#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ApexOLED Studio  ——  赛睿 OLED 动图工坊
=========================================
把任意图片 / GIF / 视频一键转换为赛睿 Apex Pro TKL 键盘 OLED 屏支持的
GIF 动图：128 x 40 像素、10 FPS、无限循环。

实现方式：Python 3 标准库 + FFmpeg（不依赖任何第三方 pip 包）。

快速上手（在项目目录下打开终端执行）：
    python apex_oled.py photo.png                  # 单张图片 -> output/photo_oled.gif
    python apex_oled.py anim.mp4 --duration 3      # 截取视频前 3 秒转成动图
    python apex_oled.py anim.gif --colors bw       # 转换为 1 位黑白高对比风格
    python apex_oled.py ./images --outdir ./out    # 批量转换整个文件夹
    python apex_oled.py --gui                      # 打开图形界面（双击 run_gui.bat 也可以）

上传到键盘：SteelSeries Engine -> 选择键盘 -> OLED & Settings ->
Edit OLED Image -> Upload From File -> 选择生成的 GIF -> DONE -> SAVE。
"""

import argparse
import base64
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

APP_NAME = "ApexOLED Studio"
VERSION = "1.0.0"

# 赛睿 Apex Pro TKL OLED 屏规格
WIDTH = 128
HEIGHT = 40
DEFAULT_FPS = 10

# 支持的输入扩展名（批量模式按此过滤）
SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp",
                  ".gif", ".apng", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}

DITHER_MAP = {"auto": "sierra2_4a", "none": "none", "bayer": "bayer:bayer_scale=4"}


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def find_tool(name: str):
    """查找可执行程序路径。"""
    return shutil.which(name)


def run(cmd):
    """执行命令并返回 subprocess 结果（不经过 shell，路径带空格也安全）。"""
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def probe(path, count_frames: bool = False):
    """用 ffprobe 读取视频流信息：尺寸、时长、帧数、帧率。

    count_frames=True 时会真实解码计数（较慢），适合对输出的小 GIF 统计帧数。
    """
    ffprobe = find_tool("ffprobe")
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,duration,nb_frames,r_frame_rate"]
    if count_frames:
        cmd.append("-count_frames")
    cmd += ["-of", "json", str(path)]
    p = run(cmd)
    if p.returncode != 0:
        raise RuntimeError(f"ffprobe 无法读取输入文件 {path}：{p.stderr.strip()}")
    data = json.loads(p.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError(f"输入文件 {path} 中没有找到视频/图像流")
    s = streams[0]

    def to_float(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def to_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    nb_frames = to_int(s.get("nb_read_frames"))
    if nb_frames is None:
        nb_frames = to_int(s.get("nb_frames"))

    return {
        "width": to_int(s.get("width")),
        "height": to_int(s.get("height")),
        "duration": to_float(s.get("duration")),
        "nb_frames": nb_frames,
        "fps": s.get("r_frame_rate"),
    }


def is_animated(info) -> bool:
    """判断输入是否为多帧动画/视频。"""
    if info["nb_frames"] is not None and info["nb_frames"] > 1:
        return True
    if info["duration"] is not None and info["duration"] > 0.05:
        return True
    return False


def normalize_color(c: str) -> str:
    """把用户输入的颜色规范化成 FFmpeg 可识别的写法。"""
    c = c.strip()
    if c.lower() in ("black", "white", "grey", "gray", "red", "green", "blue", "yellow", "cyan", "magenta"):
        return c.lower()
    if c.startswith("#"):
        c = c[1:]
    if len(c) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in c):
        return "0x" + c.upper()
    return c  # 交给 FFmpeg 自行判断，出错时会有明确报错


def parse_crop(s: str) -> dict:
    """解析 --crop 'WxH+X+Y' 为 {w,h,x,y}（原图像素坐标）。"""
    m = re.match(r"^(\d+)[xX](\d+)[+](\d+)[+](\d+)$", s.strip())
    if not m:
        raise ValueError("--crop 格式应为 WxH+X+Y，例如 430x140+70+60（宽x高+左+上）。")
    return {"w": int(m.group(1)), "h": int(m.group(2)),
            "x": int(m.group(3)), "y": int(m.group(4))}


# ---------------------------------------------------------------------------
# 核心转换
# ---------------------------------------------------------------------------
def build_vf(opts: dict) -> str:
    """构造 FFmpeg -vf 滤镜链。"""
    fps = max(1, int(opts["fps"]))

    # 1) 统一帧率（仅对多帧动画/视频生效；静态单帧套 fps 会被 FFmpeg 丢弃）
    parts = []
    if opts.get("animated"):
        parts.append(f"fps={fps}")

    # 2) 用户框选的裁剪区域（原图像素坐标）
    crop = opts.get("crop")
    if crop:
        parts.append(f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}")

    # 3) 白底 Logo 优化：把接近白色的背景压成黑色，彩色文字原样保留
    if opts.get("logo"):
        parts.append("lutrgb=r='if(gte(val,235),0,val)':"
                     "g='if(gte(val,235),0,val)':"
                     "b='if(gte(val,235),0,val)'")

    # 3.5) 黑白 + 白底 Logo：逐通道阈值 120——任何“亮通道”都拉白，
    #      让橙/红/黄等彩色文字在 1 位黑白下保持可读（配合上面的白底压黑：
    #      白背景→黑，暖色文字→白；对红字黄圈这类彩圈 logo 则自然形成
    #      白圈黑字的高对比结构）
    if opts.get("logo") and opts.get("colors") == "bw":
        parts.append("lutrgb=r='if(gte(val,120),255,0)':"
                     "g='if(gte(val,120),255,0)':"
                     "b='if(gte(val,120),255,0)'")

    # 4) 锐化 / 对比度增强（在缩放前做，边缘更利落）
    enhance = opts.get("enhance", "none")
    if enhance == "light":
        parts.append("unsharp=5:5:0.5,eq=contrast=1.06:saturation=1.05")
    elif enhance == "strong":
        parts.append("unsharp=7:7:0.9,eq=contrast=1.12:gamma=0.95:saturation=1.1")

    # 5) 缩放：cover 裁剪填满 / fit 等比适配加背景
    if opts["mode"] == "cover":
        scale = (f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,"
                 f"crop={WIDTH}:{HEIGHT}")
    else:  # fit
        bg = normalize_color(opts["bg"])
        scale = (f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,"
                 f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color={bg}")
    parts.append(scale)

    # 6) 静态图动画效果（PPT 式：淡入淡出 / 擦除 / 揭开），仅对静态输入生效
    effect = opts.get("effect")
    if effect and effect != "none":
        D = max(0.2, float(opts.get("effect_duration", 0.8)))
        T = float(opts.get("effect_total", 2 * D + 2.0))
        if effect == "fade":
            parts.append(f"fade=t=in:st=0:d={D},fade=t=out:st={T - D:.3f}:d={D}")
        elif effect == "wipe":  # 擦除：从左向右揭开
            parts.append(
                f"crop=w='max(2,{WIDTH}*min(t/{D},1))':h={HEIGHT}:x=0:y=0,"
                f"pad={WIDTH}:{HEIGHT}:0:0:black,"
                f"fade=t=out:st={T - D:.3f}:d={D}")
        elif effect == "reveal":  # 揭开：从上向下展开
            parts.append(
                f"crop=w={WIDTH}:h='max(2,{HEIGHT}*min(t/{D},1))':x=0:y=0,"
                f"pad={WIDTH}:{HEIGHT}:0:0:black,"
                f"fade=t=out:st={T - D:.3f}:d={D}")

    # 7) 色彩模式：彩色 / 灰度 / 1 位黑白
    pre = ""
    if opts["colors"] == "gray":
        pre = "format=gray,"
    elif opts["colors"] == "bw":
        pre = "format=gray,"
    palette_max = 2 if opts["colors"] == "bw" else max(2, min(256, int(opts["palette"])))
    dither = DITHER_MAP.get(opts["dither"], "sierra2_4a")
    if opts["colors"] == "bw" and opts.get("logo"):
        # 已做过逐通道阈值（值只有 0/255），不再需要抖动，避免产生杂点
        dither = "none"

    # 8) 调色板：split 双路 -> 一路生成调色板，一路用调色板量化
    parts.append(f"{pre}split[s0][s1];"
                 f"[s0]palettegen=max_colors={palette_max}:reserve_transparent=0[p];"
                 f"[s1][p]paletteuse=dither={dither}")
    return ",".join(parts)


def convert_file(src: Path, dst: Path, opts: dict) -> dict:
    """转换单个文件，返回输出信息。"""
    src = Path(src)
    dst = Path(dst)
    if not src.exists():
        raise FileNotFoundError(f"输入文件不存在：{src}")

    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 FFmpeg，请先安装并加入 PATH（见 README）。")

    dst.parent.mkdir(parents=True, exist_ok=True)
    info = probe(src)
    # 校验裁剪区域是否在图片范围内
    crop = opts.get("crop")
    if crop:
        if not (info["width"] and info["height"]):
            raise RuntimeError("无法读取输入尺寸，不能应用裁剪。")
        if crop["w"] <= 0 or crop["h"] <= 0:
            raise RuntimeError("裁剪区域宽高必须大于 0。")
        if crop["x"] + crop["w"] > info["width"] or crop["y"] + crop["h"] > info["height"]:
            raise RuntimeError(
                f"裁剪区域超出图片范围：图片为 {info['width']}x{info['height']}，"
                f"而框选区域为 x:{crop['x']} y:{crop['y']} w:{crop['w']} h:{crop['h']}，请重新框选。")
    animated = is_animated(info)
    opts = dict(opts)
    opts["animated"] = animated

    # 静态图 + 动画效果：把单张图当作短动画输入来生成效果
    use_effect = (not animated) and opts.get("effect") and opts["effect"] != "none"
    if use_effect:
        D = max(0.2, float(opts.get("effect_duration", 0.8)))
        opts["effect_total"] = 2 * D + 2.0
        opts["animated"] = True

    vf = build_vf(opts)

    if use_effect:
        # -t 必须放在 -i 之前作为输入时长限制：-loop 1 的输入是无限的，
        # 若用输出侧 -t，palettegen 等不到 EOF 会死锁
        cmd = [ffmpeg, "-y", "-loop", "1", "-t", f"{opts['effect_total']:.3f}",
               "-i", str(src), "-vf", vf, "-an", "-loop", "0",
               "-f", "gif", str(dst)]
    else:
        cmd = [ffmpeg, "-y", "-i", str(src), "-vf", vf, "-an", "-loop", "0"]
        if opts.get("duration"):
            cmd += ["-t", str(opts["duration"])]
        if opts.get("max_frames"):
            cmd += ["-frames:v", str(opts["max_frames"])]
        cmd += ["-f", "gif", str(dst)]

    p = run(cmd)
    if p.returncode != 0:
        raise RuntimeError(f"FFmpeg 转换失败：\n{p.stderr.strip()[-1200:]}")

    out_info = probe(dst, count_frames=True)
    out_info["animated"] = is_animated(info)
    out_info["src_name"] = src.name
    out_info["src_size"] = src.stat().st_size
    out_info["dst_size"] = dst.stat().st_size
    return out_info


def default_outname(src: Path, outdir: Path) -> Path:
    """生成默认输出文件名，冲突时自动加序号。"""
    base = outdir / f"{src.stem}_oled.gif"
    if not base.exists():
        return base
    i = 1
    while True:
        cand = outdir / f"{src.stem}_oled_{i}.gif"
        if not cand.exists():
            return cand
        i += 1


def collect_inputs(paths, recursive: bool = True):
    """展开输入参数：文件直接加入，文件夹递归收集支持的扩展名。"""
    files = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            files.extend(f for f in p.rglob("*") if f.suffix.lower() in SUPPORTED_EXTS)
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(f"路径不存在：{p}")
    if not files:
        raise RuntimeError("没有找到任何可转换的图片/GIF/视频文件。")
    return files


# ---------------------------------------------------------------------------
# 预览 HTML
# ---------------------------------------------------------------------------
def make_preview(gif_path: Path, out_info: dict, out_html: Path):
    """生成一个自包含的预览 HTML（GIF 以 base64 内嵌，离线可看）。"""
    try:
        gif_b64 = base64.b64encode(gif_path.read_bytes()).decode("ascii")
    except OSError as e:
        raise RuntimeError(f"读取输出 GIF 失败：{e}")

    frames = out_info.get("nb_frames") or "?"
    fps = opts_fps_display(out_info)
    dur = out_info.get("duration")
    dur_s = f"{dur:.2f} 秒" if dur is not None else "?"
    size_kb = out_info["dst_size"] / 1024
    src_size_kb = out_info["src_size"] / 1024

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{APP_NAME} - 预览：{gif_path.name}</title>
<style>
  body {{ background:#101014; color:#e8e8ea; font-family:'Microsoft YaHei',sans-serif;
         display:flex; flex-direction:column; align-items:center; padding:24px; }}
  h1 {{ font-size:18px; color:#ffb400; margin:8px 0 4px; }}
  .sub {{ color:#8a8a92; font-size:12px; margin-bottom:20px; }}
  .card {{ background:#1a1a22; border:1px solid #2c2c38; border-radius:10px;
          padding:20px; margin:10px; text-align:center; }}
  .native img {{ image-rendering:auto; }}
  .zoom img {{ image-rendering:pixelated; width:512px; height:160px; border:1px solid #333; background:#000; }}
  table {{ border-collapse:collapse; margin:6px auto; font-size:13px; }}
  td {{ padding:3px 14px; }}
  td.k {{ color:#9a9aa4; text-align:right; }}
  td.v {{ color:#fff; text-align:left; }}
  .tip {{ max-width:560px; text-align:left; color:#b8b8c0; font-size:12px; line-height:1.7; }}
</style>
</head>
<body>
  <h1>🖥 预览 · {gif_path.name}</h1>
  <div class="sub">Apex Pro TKL OLED · 128×40 · 10 FPS</div>
  <div class="card native">
    <div class="sub">原始尺寸（1:1）</div>
    <img src="data:image/gif;base64,{gif_b64}" alt="预览">
  </div>
  <div class="card zoom">
    <div class="sub">放大 4 倍（像素预览，接近人眼看键盘屏幕的效果）</div>
    <img src="data:image/gif;base64,{gif_b64}" alt="预览放大">
  </div>
  <div class="card">
    <table>
      <tr><td class="k">帧数</td><td class="v">{frames}</td></tr>
      <tr><td class="k">时长</td><td class="v">{dur_s}</td></tr>
      <tr><td class="k">输出大小</td><td class="v">{size_kb:.1f} KB（源文件 {src_size_kb:.1f} KB）</td></tr>
    </table>
  </div>
  <div class="tip">
    <b>上传步骤：</b>SteelSeries Engine → 选择键盘 → OLED &amp; Settings →
    Edit OLED Image → Upload From File → 选择本 GIF → DONE → SAVE。<br>
    <b>小技巧：</b>OLED 屏幕小，建议画面高对比、主体居中、避免 1px 细线；
    动画越长文件越大，10FPS 下 60 帧 ≈ 6 秒，够用就好。
  </div>
</body>
</html>"""
    out_html.write_text(html, encoding="utf-8")


def opts_fps_display(out_info: dict):
    """从输出信息里尽力还原帧率显示。"""
    fps = out_info.get("fps")
    if fps and "/" in fps:
        try:
            n, d = fps.split("/")
            return f"{float(n)/float(d):g} FPS"
        except (ValueError, ZeroDivisionError):
            pass
    return f"{fps or DEFAULT_FPS} FPS"


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------
def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="apex_oled",
        description=f"{APP_NAME} v{VERSION} —— 把图片/GIF/视频转换为赛睿 Apex Pro TKL "
                    f"OLED 屏 GIF（{WIDTH}×{HEIGHT}，{DEFAULT_FPS}FPS）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("示例：\n"
                "  python apex_oled.py photo.png\n"
                "  python apex_oled.py anim.mp4 --duration 3\n"
                "  python apex_oled.py anim.gif --colors bw\n"
                "  python apex_oled.py ./images --outdir ./out\n"
                "  python apex_oled.py --gui\n"))
    parser.add_argument("inputs", nargs="*", help="输入文件或文件夹（支持多文件/批量）")
    parser.add_argument("-o", "--output", help="输出 GIF 路径（仅单个输入时有效）")
    parser.add_argument("--outdir", default=None, help="输出目录（默认项目下 output/）")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS, help=f"动画帧率，默认 {DEFAULT_FPS}")
    parser.add_argument("--mode", choices=["cover", "fit"], default="cover",
                        help="画面适配方式：cover=裁剪填满（默认），fit=完整显示加背景")
    parser.add_argument("--bg", default="black",
                        help="fit 模式背景色：black/white/#RRGGBB，默认 black")
    parser.add_argument("--colors", choices=["color", "gray", "bw"], default="bw",
                        help="色彩模式：bw=1位黑白（默认，OLED 上最清晰），gray=灰度，color=彩色")
    parser.add_argument("--palette", type=int, default=256,
                        help="调色板颜色数 2~256，默认 256；越小文件越小、风格越硬朗")
    parser.add_argument("--dither", choices=["auto", "none", "bayer"], default="auto",
                        help="抖动算法：auto=平滑（默认），none=无抖动，bayer=棋盘纹理")
    parser.add_argument("--effect", choices=["none", "fade", "wipe", "reveal"], default="none",
                        help="静态图动画效果：fade=淡入淡出，wipe=擦除（左→右），reveal=揭开（上→下）；仅静态图片生效")
    parser.add_argument("--effect-duration", type=float, default=0.8,
                        help="效果进出场时长（秒），默认 0.8；总时长≈2×时长+2 秒")
    parser.add_argument("--duration", type=float, default=None,
                        help="视频输入截取时长（秒），如 --duration 3 取前 3 秒")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="最多保留帧数（10FPS 下 60 帧≈6 秒）")
    parser.add_argument("--crop", default=None,
                        help="裁剪区域（原图像素）WxH+X+Y，如 430x140+70+60；图形界面里可直接框选")
    parser.add_argument("--logo", action="store_true",
                        help="白底 Logo 优化：把白色背景压成黑色，彩色文字更突出（适合火影/犬夜叉这类白底 logo）")
    parser.add_argument("--enhance", choices=["none", "light", "strong"], default="none",
                        help="锐化增强：none=无（默认），light=轻度，strong=强力（文字更锐利）")
    parser.add_argument("--no-preview", action="store_true",
                        help="转换后不生成预览 HTML")
    parser.add_argument("--gui", action="store_true", help="打开图形界面")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {VERSION}")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    # GUI 模式
    if args.gui:
        if not _GUI_AVAILABLE:
            print("当前 Python 环境没有 tkinter，无法启动图形界面。请改用命令行模式。")
            sys.exit(1)
        run_gui()
        return

    if not args.inputs:
        print("未指定输入文件。运行 python apex_oled.py --help 查看用法；"
              "或使用 python apex_oled.py --gui 打开图形界面。")
        sys.exit(1)

    # 检查 ffmpeg / ffprobe
    if not find_tool("ffmpeg") or not find_tool("ffprobe"):
        print("错误：未找到 FFmpeg/ffprobe。请安装 FFmpeg 并加入系统 PATH（见 README.md）。")
        sys.exit(1)

    inputs = collect_inputs(args.inputs)
    if len(inputs) > 1 and args.output:
        print("提示：批量转换时忽略 -o/--output，输出到 --outdir（默认 output/）。")
        args.output = None

    outdir = Path(args.outdir) if args.outdir else (Path(__file__).parent / "output")
    outdir.mkdir(parents=True, exist_ok=True)

    try:
        crop_box = parse_crop(args.crop) if args.crop else None
    except ValueError as e:
        print(f"参数错误：{e}")
        sys.exit(1)

    opts = {
        "fps": args.fps,
        "mode": args.mode,
        "bg": args.bg,
        "colors": args.colors,
        "palette": args.palette,
        "dither": args.dither,
        "duration": args.duration,
        "max_frames": args.max_frames,
        "crop": crop_box,
        "logo": args.logo,
        "enhance": args.enhance,
        "effect": args.effect,
        "effect_duration": args.effect_duration,
    }

    failed = []
    for i, src in enumerate(inputs, 1):
        dst = Path(args.output) if (args.output and len(inputs) == 1) else default_outname(src, outdir)
        try:
            print(f"[{i}/{len(inputs)}] 转换：{src.name} ...", flush=True)
            out_info = convert_file(src, dst, opts)
            line = (f"  ✔ 完成 -> {dst}  "
                    f"({out_info.get('width')}x{out_info.get('height')}, "
                    f"{out_info.get('nb_frames') or '?'} 帧, "
                    f"{out_info['dst_size']/1024:.1f} KB)")
            print(line)
            if not args.no_preview:
                html = dst.with_name(dst.stem + "_preview.html")
                make_preview(dst, out_info, html)
                print(f"     预览 -> {html}")
        except Exception as e:
            print(f"  ✘ 失败：{e}")
            failed.append(str(src))

    print("-" * 50)
    if failed:
        print(f"完成，{len(inputs)-len(failed)}/{len(inputs)} 个成功，失败 {len(failed)} 个：")
        for f in failed:
            print(f"  - {f}")
        sys.exit(1)
    print(f"全部完成！输出目录：{outdir}")
    print("上传到键盘：SteelSeries Engine → OLED & Settings → Edit OLED Image → Upload From File")


# ---------------------------------------------------------------------------
# 图形界面（tkinter，标准库自带）
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 图形界面（tkinter，标准库自带）
# ---------------------------------------------------------------------------
try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    _GUI_AVAILABLE = True
except ImportError:  # 无 tkinter 的精简 Python 环境仍可使用命令行模式
    tk = filedialog = messagebox = ttk = None
    _GUI_AVAILABLE = False


class ApexOledGui:
    """转换工具的图形界面。"""

    def __init__(self, root):
        self.root = root
        root.title(f"{APP_NAME} v{VERSION} - 赛睿 OLED 动图工坊")
        root.geometry("620x520")
        root.resizable(False, False)

        pad = {"padx": 10, "pady": 5}
        main = ttk.Frame(root, padding=12)
        main.pack(fill="both", expand=True)

        # 输入文件
        ttk.Label(main, text="输入文件/文件夹（图片、GIF、视频）").grid(row=0, column=0, sticky="w", **pad)
        self.in_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.in_var).grid(row=1, column=0, sticky="we", padx=10)
        ttk.Button(main, text="浏览…", command=self.pick_input).grid(row=1, column=1, padx=5)
        ttk.Button(main, text="框选区域…", command=self.open_crop).grid(row=1, column=2, padx=5)

        # 框选状态
        self.crop_box = None          # {"x","y","w","h"}，原图像素坐标
        self.crop_var = tk.StringVar(value="未框选（转换整张图）")
        ttk.Label(main, textvariable=self.crop_var, foreground="#8a8a92",
                  font=("Microsoft YaHei UI", 8)).grid(row=2, column=0, columnspan=3, sticky="w", padx=12)

        # 输出目录
        ttk.Label(main, text="输出目录").grid(row=3, column=0, sticky="w", **pad)
        self.out_var = tk.StringVar(value=str(Path(__file__).parent / "output"))
        ttk.Entry(main, textvariable=self.out_var).grid(row=4, column=0, sticky="we", padx=10)
        ttk.Button(main, text="浏览…", command=self.pick_output).grid(row=4, column=1, padx=5)

        # 选项
        opt = ttk.LabelFrame(main, text="转换选项", padding=10)
        opt.grid(row=5, column=0, columnspan=3, sticky="we", pady=8, padx=10)

        ttk.Label(opt, text="画面适配").grid(row=0, column=0, sticky="w", padx=5)
        self.mode_var = tk.StringVar(value="cover")
        ttk.Combobox(opt, textvariable=self.mode_var, state="readonly",
                     values=["cover（裁剪填满）", "fit（完整显示）"], width=18).grid(row=0, column=1, padx=5)

        ttk.Label(opt, text="色彩模式").grid(row=0, column=2, sticky="w", padx=5)
        self.color_var = tk.StringVar(value="bw（黑白）")
        ttk.Combobox(opt, textvariable=self.color_var, state="readonly",
                     values=["bw（黑白）", "gray（灰度）", "color（彩色）"], width=18).grid(row=0, column=3, padx=5)

        ttk.Label(opt, text="抖动").grid(row=1, column=0, sticky="w", padx=5)
        self.dither_var = tk.StringVar(value="auto")
        ttk.Combobox(opt, textvariable=self.dither_var, state="readonly",
                     values=["auto（平滑）", "none（无）", "bayer（纹理）"], width=18).grid(row=1, column=1, padx=5)

        ttk.Label(opt, text="增强").grid(row=1, column=2, sticky="w", padx=5)
        self.enhance_var = tk.StringVar(value="light")
        ttk.Combobox(opt, textvariable=self.enhance_var, state="readonly",
                     values=["light（轻度）", "strong（强力）", "none（无）"], width=18).grid(row=1, column=3, padx=5)

        ttk.Label(opt, text="帧率(FPS)").grid(row=2, column=0, sticky="w", padx=5)
        self.fps_var = tk.IntVar(value=DEFAULT_FPS)
        ttk.Spinbox(opt, from_=1, to=60, textvariable=self.fps_var, width=8).grid(row=2, column=1, sticky="w", padx=5)

        ttk.Label(opt, text="截取时长(秒,可选)").grid(row=2, column=2, sticky="w", padx=5)
        self.dur_var = tk.StringVar(value="")
        ttk.Entry(opt, textvariable=self.dur_var, width=10).grid(row=2, column=3, sticky="w", padx=5)

        self.logo_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(opt, text="白底 Logo 优化（白色背景压黑，文字更醒目）",
                        variable=self.logo_var).grid(row=3, column=0, columnspan=2, sticky="w", padx=5, pady=(6, 0))

        ttk.Label(opt, text="效果").grid(row=3, column=2, sticky="w", padx=5)
        self.effect_var = tk.StringVar(value="none（无）")
        ttk.Combobox(opt, textvariable=self.effect_var, state="readonly",
                     values=["none（无）", "fade（淡入淡出）", "wipe（擦除）", "reveal（揭开）"],
                     width=18).grid(row=3, column=3, padx=5, pady=(6, 0))

        # 按钮
        btns = ttk.Frame(main)
        btns.grid(row=6, column=0, columnspan=3, pady=6)
        ttk.Button(btns, text="开始转换", command=self.convert).pack(side="left", padx=8)
        ttk.Button(btns, text="打开输出目录", command=self.open_outdir).pack(side="left", padx=8)

        # 状态
        self.status = tk.StringVar(value="就绪")
        ttk.Label(main, textvariable=self.status, foreground="#2a7a2a").grid(row=7, column=0, columnspan=3, sticky="w", padx=12)

        self.log_box = tk.Text(main, height=8, state="disabled", bg="#14141a", fg="#d8d8de",
                               font=("Consolas", 9), wrap="word")
        self.log_box.grid(row=8, column=0, columnspan=3, sticky="we", padx=10, pady=6)
        root.columnconfigure(0, weight=1)

        # 工作线程 -> 主线程的 UI 更新队列
        self._ui_q = queue.Queue()
        self._poll_ui()

    def _poll_ui(self):
        """主线程轮询 UI 队列，执行工作线程投递的界面更新。

        注意：tkinter 不允许在工作线程里直接调用（Tk 9.0 会抛
        "main thread is not in main loop"），所以统一走队列。
        """
        while True:
            try:
                fn, args = self._ui_q.get_nowait()
            except queue.Empty:
                break
            try:
                fn(*args)
            except Exception:
                pass  # 单个回调失败不应拖垮轮询循环
        try:
            self.root.after(50, self._poll_ui)
        except tk.TclError:
            pass  # 窗口已销毁

    def _ui(self, fn, *args):
        """工作线程调用：把界面更新任务放入队列。"""
        self._ui_q.put((fn, args))

    def log(self, msg):
        self.log_box.config(state="normal")
        self.log_box.insert("end", msg + "\n")
        self.log_box.see("end")
        self.log_box.config(state="disabled")

    def pick_input(self):
        path = filedialog.askopenfilename(
            title="选择图片 / GIF / 视频",
            filetypes=[("媒体文件", "*.png *.jpg *.jpeg *.bmp *.webp *.gif *.apng "
                          "*.mp4 *.webm *.mov *.mkv *.avi"), ("所有文件", "*.*")])
        if path:
            self.in_var.set(path)
            # 换了输入文件后，旧框选区域不再适用
            self.crop_box = None
            self.crop_var.set("未框选（转换整张图）")

    def open_crop(self):
        src_str = self.in_var.get().strip()
        if not src_str:
            messagebox.showwarning("提示", "请先选择输入文件，再框选区域。")
            return
        if not Path(src_str).is_file():
            messagebox.showwarning("提示", "框选功能仅支持单个图片/视频文件。")
            return
        CropDialog(self, src_str)

    def pick_output(self):
        path = filedialog.askdirectory(title="选择输出目录")
        if path:
            self.out_var.set(path)

    def open_outdir(self):
        out = Path(self.out_var.get())
        out.mkdir(parents=True, exist_ok=True)
        os.startfile(str(out))

    def convert(self):
        src_str = self.in_var.get().strip()
        if not src_str:
            messagebox.showwarning("提示", "请先选择输入文件或文件夹。")
            return
        try:
            fps = int(self.fps_var.get())
        except (tk.TclError, ValueError):
            messagebox.showwarning("提示", "帧率必须是数字。")
            return
        dur = self.dur_var.get().strip()
        if dur:
            try:
                dur = float(dur)
            except ValueError:
                messagebox.showwarning("提示", "截取时长必须是数字。")
                return
        else:
            dur = None

        mode = "cover" if "cover" in self.mode_var.get() else "fit"
        colors = self.color_var.get().split("（")[0]
        dither = self.dither_var.get().split("（")[0]
        enhance = self.enhance_var.get().split("（")[0]
        effect = self.effect_var.get().split("（")[0]

        opts = {"fps": fps, "mode": mode, "bg": "black", "colors": colors,
                "palette": 256, "dither": dither, "duration": dur, "max_frames": None,
                "crop": self.crop_box, "logo": bool(self.logo_var.get()),
                "enhance": enhance, "effect": effect, "effect_duration": 0.8}

        t = threading.Thread(target=self._work, args=(src_str, self.out_var.get(), opts), daemon=True)
        t.start()

    def _work(self, src_str, out_str, opts):
        ui = self._ui  # 工作线程不直接碰 tkinter，统一走队列

        ui(self.status.set, "转换中…")
        self.log("=" * 46)
        try:
            inputs = collect_inputs([src_str])
            outdir = Path(out_str)
            outdir.mkdir(parents=True, exist_ok=True)
            for i, src in enumerate(inputs, 1):
                ui(self.log, f"[{i}/{len(inputs)}] {src.name}")
                dst = default_outname(src, outdir)
                out_info = convert_file(src, dst, opts)
                ui(self.log, f"  ✔ {dst.name}  "
                            f"({out_info.get('width')}x{out_info.get('height')}, "
                            f"{out_info.get('nb_frames') or '?'} 帧, "
                            f"{out_info['dst_size']/1024:.1f} KB)")
                try:
                    html = dst.with_name(dst.stem + "_preview.html")
                    make_preview(dst, out_info, html)
                    ui(self.log, f"    预览 {html.name}")
                except Exception as e:
                    ui(self.log, f"    （预览生成失败：{e}）")
            ui(self.status.set, f"完成：{len(inputs)} 个文件 → {outdir}")
            ui(messagebox.showinfo, "完成", f"转换完成！\n输出目录：{outdir}\n"
                                            "SteelSeries Engine → OLED & Settings → Upload From File")
        except Exception as e:
            ui(self.status.set, "失败")
            ui(self.log, f"✘ {e}")
            ui(messagebox.showerror, "转换失败", str(e))


class CropDialog:
    """框选区域对话框：显示图片，拖拽选择要在 OLED 上呈现的主要区域。"""

    PREVIEW_MAX_W = 760
    PREVIEW_MAX_H = 460

    def __init__(self, app, src):
        self.app = app
        self.src = Path(src)
        self.result = None            # {"x","y","w","h"}，原图像素坐标
        self._imgs = []               # 保持 PhotoImage 引用，防止被回收
        self._tmp_files = []
        self._prev_win = None

        info = probe(self.src)
        self.orig_w, self.orig_h = info["width"], info["height"]
        if not (self.orig_w and self.orig_h):
            messagebox.showerror("错误", "无法读取图片尺寸。")
            return

        # 计算显示尺寸（保持原图比例，等比缩放）
        if self.orig_w / self.orig_h > self.PREVIEW_MAX_W / self.PREVIEW_MAX_H:
            self.disp_w = self.PREVIEW_MAX_W
            self.disp_h = max(2, int(self.disp_w * self.orig_h / self.orig_w))
        else:
            self.disp_h = self.PREVIEW_MAX_H
            self.disp_w = max(2, int(self.disp_h * self.orig_w / self.orig_h))
        self.scale = self.disp_w / self.orig_w   # 画布坐标 -> 原图像素

        self.win = tk.Toplevel(app.root)
        self.win.title("框选 OLED 显示区域")
        self.win.geometry(f"{self.disp_w + 30}x{self.disp_h + 130}")
        self.win.transient(app.root)
        self.win.grab_set()

        self.canvas = tk.Canvas(self.win, width=self.disp_w, height=self.disp_h,
                                bg="#000", highlightthickness=1, highlightbackground="#333")
        self.canvas.pack(padx=10, pady=8)

        self.info_var = tk.StringVar(value="在图片上按住鼠标左键拖拽，框出要显示的区域")
        ttk.Label(self.win, textvariable=self.info_var, foreground="#8a8a92").pack()

        btns = ttk.Frame(self.win)
        btns.pack(pady=6)
        ttk.Button(btns, text="试看 OLED 效果", command=self.preview).pack(side="left", padx=6)
        ttk.Button(btns, text="确定", command=self.ok).pack(side="left", padx=6)
        ttk.Button(btns, text="清除", command=self.clear).pack(side="left", padx=6)
        ttk.Button(btns, text="取消", command=self.win.destroy).pack(side="left", padx=6)

        self.rect = None
        self.start = None
        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._drag)
        self.canvas.bind("<ButtonRelease-1>", self._release)

        # 显示图片（用 ffmpeg 取第一帧并缩放到显示尺寸）
        self._load_display_image()

        # 若之前已有框选，恢复显示
        if self.app.crop_box:
            self._draw_rect_from_orig(self.app.crop_box)

    # ---- 图片加载与显示 ----
    def _load_display_image(self):
        tmp = Path(tempfile.mkdtemp(prefix="apex_crop_")) / "preview.png"
        ffmpeg = find_tool("ffmpeg")
        cmd = [ffmpeg, "-y", "-i", str(self.src), "-vf",
               f"scale={self.disp_w}:{self.disp_h}:flags=bilinear",
               "-frames:v", "1", str(tmp)]
        p = run(cmd)
        if p.returncode != 0:
            raise RuntimeError(f"生成预览图失败：{p.stderr.strip()[-400:]}")
        img = tk.PhotoImage(file=str(tmp))
        self._imgs.append(img)
        self._tmp_files.append(tmp)
        self.canvas.create_image(0, 0, anchor="nw", image=img)

    # ---- 拖拽框选 ----
    def _press(self, e):
        self.start = (e.x, e.y)
        if self.rect:
            self.canvas.delete(self.rect)
            self.rect = None

    def _drag(self, e):
        if not self.start:
            return
        x0, y0 = self.start
        x1, y1 = max(0, min(e.x, self.disp_w)), max(0, min(e.y, self.disp_h))
        if self.rect:
            self.canvas.coords(self.rect, x0, y0, x1, y1)
        else:
            self.rect = self.canvas.create_rectangle(x0, y0, x1, y1,
                                                     outline="#ff4d4f", width=2)

    def _release(self, e):
        if not self.start:
            return
        x0, y0 = self.start
        x1, y1 = e.x, e.y
        self.start = None
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        x0 = max(0, min(x0, self.disp_w))
        y0 = max(0, min(y0, self.disp_h))
        x1 = max(0, min(x1, self.disp_w))
        y1 = max(0, min(y1, self.disp_h))
        if x1 - x0 < 2 or y1 - y0 < 2:
            self.info_var.set("选区太小，请重新拖拽")
            return
        self.result = {
            "x": round(x0 / self.scale),
            "y": round(y0 / self.scale),
            "w": round((x1 - x0) / self.scale),
            "h": round((y1 - y0) / self.scale),
        }
        # 取整可能越界，收回到图片范围内
        self.result["x"] = min(self.result["x"], self.orig_w - 1)
        self.result["y"] = min(self.result["y"], self.orig_h - 1)
        self.result["w"] = min(self.result["w"], self.orig_w - self.result["x"])
        self.result["h"] = min(self.result["h"], self.orig_h - self.result["y"])
        self._update_info()

    def _draw_rect_from_orig(self, cb):
        x0 = round(cb["x"] * self.scale)
        y0 = round(cb["y"] * self.scale)
        x1 = round((cb["x"] + cb["w"]) * self.scale)
        y1 = round((cb["y"] + cb["h"]) * self.scale)
        self.rect = self.canvas.create_rectangle(x0, y0, x1, y1, outline="#ff4d4f", width=2)
        self.result = cb
        self._update_info()

    def _update_info(self):
        cb = self.result
        ar = cb["w"] / cb["h"]
        if abs(ar - WIDTH / HEIGHT) < 0.12:
            note = f"接近 OLED 比例 {WIDTH/HEIGHT:.1f}:1，无需再裁切"
        else:
            note = f"比例 {ar:.2f}:1（OLED 为 {WIDTH/HEIGHT:.1f}:1），转换时按 3.2:1 适配"
        self.info_var.set(
            f"已框选：x{cb['x']} y{cb['y']} {cb['w']}×{cb['h']} 像素（原图 {self.orig_w}×{self.orig_h}）｜{note}")

    # ---- 操作 ----
    def ok(self):
        if not self.result:
            messagebox.showwarning("提示", "请先在图片上拖拽框出区域。")
            return
        self.app.crop_box = self.result
        self.app.crop_var.set(
            f"已框选 x{self.result['x']} y{self.result['y']} {self.result['w']}×{self.result['h']}（可再点“框选区域…”调整）")
        self.win.destroy()

    def clear(self):
        self.result = None
        if self.rect:
            self.canvas.delete(self.rect)
            self.rect = None
        self.info_var.set("在图片上按住鼠标左键拖拽，框出要显示的区域")

    def preview(self):
        """按当前增强/白底设置试跑一次转换，4 倍放大显示结果。"""
        if not self.result:
            messagebox.showwarning("提示", "请先框选区域。")
            return
        opts = {"fps": DEFAULT_FPS, "mode": "cover", "bg": "black", "colors": "color",
                "palette": 256, "dither": "auto", "duration": None, "max_frames": None,
                "crop": self.result, "logo": bool(self.app.logo_var.get()),
                "enhance": self.app.enhance_var.get().split("（")[0]}
        try:
            tmp = Path(tempfile.mkdtemp(prefix="apex_crop_")) / "preview.gif"
            convert_file(self.src, tmp, opts)
            zoom = tmp.with_name("zoom.png")
            ffmpeg = find_tool("ffmpeg")
            p = run([ffmpeg, "-y", "-i", str(tmp),
                     "-vf", "scale=512:160:flags=neighbor", "-frames:v", "1", str(zoom)])
            if p.returncode != 0:
                raise RuntimeError(f"生成预览帧失败：{p.stderr.strip()[-300:]}")
            img = tk.PhotoImage(file=str(zoom))
            self._imgs.append(img)
            self._tmp_files.append(tmp)
            self._tmp_files.append(zoom)
        except Exception as e:
            messagebox.showerror("预览失败", str(e))
            return

        if self._prev_win is not None and self._prev_win.winfo_exists():
            self._prev_win.destroy()
        self._prev_win = tk.Toplevel(self.win)
        self._prev_win.title("OLED 效果预览（4 倍放大）")
        tk.Label(self._prev_win, image=img, bg="#000", borderwidth=1, relief="solid").pack(padx=8, pady=8)
        tk.Label(self._prev_win, text="这就是键盘上看到的画面（放大 4 倍）。满意就点「确定」。",
                 fg="#8a8a92", font=("Microsoft YaHei UI", 9)).pack(padx=8, pady=(0, 8))


def run_gui():
    root = tk.Tk()
    ApexOledGui(root)
    root.mainloop()


if __name__ == "__main__":
    main()
