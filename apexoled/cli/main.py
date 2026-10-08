# -*- coding: utf-8 -*-
"""CLI 入口：与 v1.x 参数对齐（R1.3），新增 N1/N2 参数，批量转换行为不变。"""
import argparse
import sys
from pathlib import Path

from .. import APP_NAME, DEFAULT_FPS, HEIGHT, SUPPORTED_EXTS, VERSION, WIDTH
from ..decode import parse_crop
from ..engine import RenderOptions, render
from ..exporters import export
from ..exporters.preview import make_preview
from ..effects import parse_effect_spec

_EXT_OF = {"gif": ".gif", "png": ".png", "jpg": ".jpg", "jpeg": ".jpeg", "bmp": ".bmp"}


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


def default_outname(src: Path, outdir: Path, ext: str) -> Path:
    """默认输出名 {stem}_oled.{ext}，冲突时自动加序号。"""
    base = outdir / f"{src.stem}_oled{ext}"
    if not base.exists():
        return base
    i = 1
    while True:
        cand = outdir / f"{src.stem}_oled_{i}{ext}"
        if not cand.exists():
            return cand
        i += 1


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="apexoled",
        description=f"{APP_NAME} v{VERSION} —— 把图片/GIF/视频转换为赛睿 Apex Pro TKL "
                    f"OLED 屏内容（{WIDTH}×{HEIGHT}，{DEFAULT_FPS}FPS）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("示例：\n"
                "  apexoled photo.png                            # 静态图 -> PNG（默认）\n"
                "  apexoled logo.png --logo --colors bw         # 白底 logo 优化\n"
                "  apexoled anim.mp4 --duration 3                # 视频前 3 秒 -> GIF\n"
                "  apexoled pic.png --effect fade               # 静态图 + 淡入淡出 -> GIF\n"
                "  apexoled pic.png --effect wipe:l2r+fade       # 擦除入场 + 淡出退场\n"
                "  apexoled pic.png --effect-in 1 --effect-hold 2 --effect-gap 0\n"
                "  apexoled pic.png --format jpg --quality 92   # 五格式导出\n"
                "  apexoled ./images --outdir ./out             # 批量转换\n"))
    parser.add_argument("inputs", nargs="*", help="输入文件或文件夹（支持多文件/批量）")
    parser.add_argument("-o", "--output", help="输出文件路径（仅单个输入时有效）")
    parser.add_argument("--outdir", default=None, help="输出目录（默认项目下 output/）")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS,
                        help=f"动画帧率，默认 {DEFAULT_FPS}")
    parser.add_argument("--mode", choices=["cover", "fit"], default="cover",
                        help="画面适配：cover=裁剪填满（默认），fit=完整显示加背景")
    parser.add_argument("--bg", default="black",
                        help="fit 模式背景色：black/white/#RRGGBB，默认 black")
    parser.add_argument("--colors", choices=["color", "gray", "bw"], default="bw",
                        help="色彩模式：bw=1位黑白（默认，OLED 上最清晰），gray=灰度，color=彩色")
    parser.add_argument("--palette", type=int, default=256,
                        help="调色板颜色数 2~256，默认 256；越小文件越小、风格越硬朗")
    parser.add_argument("--dither", choices=["auto", "none", "bayer"], default="auto",
                        help="抖动算法：auto=平滑（默认），none=无抖动，bayer=棋盘纹理")
    parser.add_argument("--effect", default="none",
                        help="动画效果（仅静态图生效）：fade/wipe/reveal/zoom/blinds/"
                             "scanline/pixelate/breathing，可带方向如 wipe:l2r，"
                             "可组合入场+退场如 wipe:l2r+fade")
    parser.add_argument("--effect-duration", type=float, default=None,
                        help="（v1.x 兼容）进出场时长（秒），默认 0.8")
    parser.add_argument("--effect-in", type=float, default=None,
                        help="进场时长（秒），默认 0.8")
    parser.add_argument("--effect-hold", type=float, default=None,
                        help="停留时长（秒），默认 1.6")
    parser.add_argument("--effect-out", type=float, default=None,
                        help="退场时长（秒），默认 0.8")
    parser.add_argument("--effect-gap", type=float, default=None,
                        help="黑屏间隔（秒），默认 0.4；设 0 可无缝循环")
    parser.add_argument("--duration", type=float, default=None,
                        help="视频输入截取时长（秒），如 --duration 3 取前 3 秒")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="最多保留帧数（10FPS 下 60 帧≈6 秒）")
    parser.add_argument("--crop", default=None,
                        help="裁剪区域（原图像素）WxH+X+Y，如 430x140+70+60")
    parser.add_argument("--logo", action="store_true",
                        help="白底 Logo 优化：把白色背景压成黑色，彩色文字更突出")
    parser.add_argument("--enhance", choices=["none", "light", "strong"], default="none",
                        help="锐化增强：none=无（默认），light=轻度，strong=强力")
    parser.add_argument("--format", choices=["auto", "gif", "jpg", "jpeg", "png", "bmp"],
                        default="auto",
                        help="导出格式：auto=动态 GIF/静态 PNG（默认）；GIF 仅用于动态内容")
    parser.add_argument("--quality", type=int, default=92,
                        help="JPG 质量 1~100，默认 92")
    parser.add_argument("--no-preview", action="store_true",
                        help="转换后不生成预览 HTML")
    parser.add_argument("--gui", action="store_true",
                        help="打开图形界面（v2.0-beta 提供基于 pywebview 的新界面）")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {VERSION}")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    if args.gui:
        from ..ui.app import launch
        launch()
        return

    if not args.inputs:
        print("未指定输入文件。运行 apexoled --help 查看用法。")
        sys.exit(1)

    # 参数预校验（错误一次性报出，不进入逐文件循环）
    try:
        crop_box = parse_crop(args.crop) if args.crop else None
    except ValueError as e:
        print(f"参数错误：{e}")
        sys.exit(1)

    try:
        parse_effect_spec(args.effect) if args.effect else None
    except ValueError as e:
        print(f"参数错误：{e}")
        sys.exit(1)

    d_in = args.effect_in if args.effect_in is not None else \
        (args.effect_duration if args.effect_duration is not None else 0.8)
    d_out = args.effect_out if args.effect_out is not None else \
        (args.effect_duration if args.effect_duration is not None else 0.8)
    d_hold = args.effect_hold if args.effect_hold is not None else 1.6
    d_gap = args.effect_gap if args.effect_gap is not None else 0.4

    opts = RenderOptions(
        fps=args.fps, mode=args.mode, bg=args.bg, colors=args.colors,
        palette=args.palette, dither=args.dither, crop=crop_box, logo=args.logo,
        enhance=args.enhance, effect=None if args.effect == "none" else args.effect,
        effect_in=d_in, effect_hold=d_hold, effect_out=d_out, effect_gap=d_gap,
        duration=args.duration, max_frames=args.max_frames)

    try:
        inputs = collect_inputs(args.inputs)
    except (FileNotFoundError, RuntimeError) as e:
        print(f"错误：{e}")
        sys.exit(1)

    if len(inputs) > 1 and args.output:
        print("提示：批量转换时忽略 -o/--output，输出到 --outdir（默认 output/）。")
        args.output = None

    outdir = Path(args.outdir) if args.outdir else (Path.cwd() / "output")
    outdir.mkdir(parents=True, exist_ok=True)

    failed = []
    for i, src in enumerate(inputs, 1):
        try:
            print(f"[{i}/{len(inputs)}] 转换：{src.name} ...", flush=True)
            result = render(src, opts)
            fmt = args.format if args.format != "auto" else \
                ("gif" if result.animated else "png")

            if args.output and len(inputs) == 1:
                dst = Path(args.output)
                if dst.suffix.lower() != _EXT_OF[fmt]:
                    fixed = dst.with_suffix(_EXT_OF[fmt])
                    print(f"     提示：输出扩展名与格式不符，已改为 {fixed.name}")
                    dst = fixed
            else:
                dst = default_outname(src, outdir, _EXT_OF[fmt])

            dst, notes = export(result, dst, fmt, quality=args.quality)
            for w in result.warnings + notes:
                print(f"     提示：{w}")
            n_frames = len(result.frames)
            line = (f"  ✔ 完成 -> {dst}  ({WIDTH}x{HEIGHT}, "
                    f"{n_frames} 帧, {dst.stat().st_size / 1024:.1f} KB)")
            print(line)
            if not args.no_preview:
                html = dst.with_name(dst.stem + "_preview.html")
                make_preview(dst, result, html)
                print(f"     预览 -> {html}")
        except Exception as e:
            print(f"  ✘ 失败：{e}")
            failed.append(str(src))

    print("-" * 50)
    if failed:
        print(f"完成，{len(inputs) - len(failed)}/{len(inputs)} 个成功，失败 {len(failed)} 个：")
        for f in failed:
            print(f"  - {f}")
        sys.exit(1)
    print(f"全部完成！输出目录：{outdir}")
    print("上传到键盘：SteelSeries Engine → OLED & Settings → Edit OLED Image → Upload From File")


if __name__ == "__main__":
    main()
