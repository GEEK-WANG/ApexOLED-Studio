# -*- coding: utf-8 -*-
"""渲染管线（R1.1）：解码 → 预处理 → 效果 → 量化 → RenderResult。

导出与 UI 层都只消费 render() 的结果，保证「预览即成品」（R2.2）。
"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import numpy as np

from .. import DEFAULT_FPS, HEIGHT, WIDTH
from ..decode import decode
from ..effects import parse_effect_spec
from ..effects.timeline import EffectConfig, build_effect_frames
from . import process, quantize


@dataclass
class RenderOptions:
    fps: int = DEFAULT_FPS
    mode: str = "cover"            # cover / fit
    bg: str = "black"              # fit 模式背景色
    colors: str = "bw"             # bw / gray / color
    palette: int = 256             # 调色板颜色数 2~256
    dither: str = "auto"           # auto / none / bayer
    crop: Optional[dict] = None    # {"w","h","x","y"}
    logo: bool = False             # 白底 Logo 优化
    enhance: str = "none"          # none / light / strong
    effect: Optional[str] = None   # "wipe:l2r+fade"
    effect_in: float = 0.8
    effect_hold: float = 1.6
    effect_out: float = 0.8
    effect_gap: float = 0.4
    duration: Optional[float] = None
    max_frames: Optional[int] = None

    def validate(self):
        if not (1 <= int(self.fps) <= 60):
            raise ValueError(f"帧率必须在 1~60 之间（当前 {self.fps}）。")
        if self.mode not in ("cover", "fit"):
            raise ValueError(f"适配模式仅支持 cover/fit（当前 {self.mode}）。")
        if self.colors not in ("bw", "gray", "color"):
            raise ValueError(f"色彩模式仅支持 bw/gray/color（当前 {self.colors}）。")
        if not (2 <= int(self.palette) <= 256):
            raise ValueError(f"调色板颜色数必须在 2~256 之间（当前 {self.palette}）。")
        if self.dither not in ("auto", "none", "bayer"):
            raise ValueError(f"抖动仅支持 auto/none/bayer（当前 {self.dither}）。")
        if self.enhance not in ("none", "light", "strong"):
            raise ValueError(f"增强仅支持 none/light/strong（当前 {self.enhance}）。")
        if self.duration is not None and self.duration <= 0:
            raise ValueError("视频截取时长必须大于 0。")
        if self.max_frames is not None and self.max_frames <= 0:
            raise ValueError("最多帧数必须大于 0。")


@dataclass
class RenderResult:
    frames: List[np.ndarray]       # 最终 RGB uint8 128×40（已按色彩模式量化）
    fps: int
    animated: bool                 # 是否为动态内容（决定可否导出 GIF）
    palette: Optional[np.ndarray] = None   # 色彩模式共享调色板 (K,3)
    warnings: List[str] = field(default_factory=list)
    src_name: str = ""
    src_size: int = 0


def render(path, opts: RenderOptions) -> RenderResult:
    """完整渲染管线。任何输入最终产出一组 128×40 RGB 帧。"""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"输入文件不存在：{path}")
    opts.validate()

    seq = decode(path, fps=opts.fps, duration=opts.duration,
                 max_frames=opts.max_frames, crop=opts.crop)
    frames = seq.frames
    warnings = list(seq.warnings)

    # 预处理（源分辨率）：白底 logo → 黑白 logo 阈值 → 锐化增强
    if opts.logo:
        frames = process.apply_logo_white_bg(frames)
        if opts.colors == "bw":
            frames = process.apply_bw_logo_threshold(frames)
    if opts.enhance != "none":
        frames = process.apply_enhance(frames, opts.enhance)

    # 缩放到 OLED 规格
    frames = process.scale_frames(frames, opts.mode, opts.bg, WIDTH, HEIGHT)

    # 效果（F7.6：仅静态输入生效）
    animated = seq.animated
    effect_applied = False
    if opts.effect and opts.effect != "none":
        in_spec, out_spec = parse_effect_spec(opts.effect)
        if animated:
            warnings.append("动画效果仅对静态图片生效，已忽略。")
        elif in_spec or out_spec:
            cfg = EffectConfig(in_spec, out_spec, opts.effect_in, opts.effect_hold,
                               opts.effect_out, opts.effect_gap, opts.fps)
            eframes, ewarn = build_effect_frames(frames[0], cfg)
            frames, animated = eframes, True
            effect_applied = True
            warnings.extend(ewarn)

    # 量化（F4.3：黑白+logo 禁用抖动，避免杂点；其余按用户选择）
    palette = None
    if opts.colors == "bw":
        d = "none" if opts.logo else opts.dither
        if effect_applied and d == "auto":
            # 效果时间轴：FS 噪声逐帧不相关，10FPS 下闪烁明显且 GIF 体积爆炸；
            # 有序抖动阈值固定，亮度变化时白点单调嵌套——动画更平滑，体积可控。
            d = "bayer"
        frames = quantize.quantize_bw(frames, d)
    elif opts.colors == "gray":
        frames = quantize.quantize_gray(frames, opts.palette, opts.dither)
    else:
        frames, palette = quantize.quantize_color(frames, opts.palette, opts.dither)

    return RenderResult(frames=frames, fps=opts.fps, animated=animated,
                        palette=palette, warnings=warnings,
                        src_name=path.name, src_size=path.stat().st_size)
