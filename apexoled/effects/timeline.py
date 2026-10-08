# -*- coding: utf-8 -*-
"""四段时间轴（N2.1）：进场 / 停留 / 退场 / 黑屏，帧数上限 60。"""
import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

from . import EffectSpec, apply_effect

MAX_FRAMES = 60


@dataclass
class EffectConfig:
    in_effect: Optional[EffectSpec] = None
    out_effect: Optional[EffectSpec] = None
    in_duration: float = 0.8
    hold_duration: float = 1.6
    out_duration: float = 0.8
    gap_duration: float = 0.4
    fps: int = 10


def _seg_frames(seconds: float, fps: int) -> int:
    return max(0, int(round(seconds * fps)))


def build_effect_frames(base: np.ndarray,
                        cfg: EffectConfig) -> Tuple[List[np.ndarray], List[str]]:
    """由基准帧生成完整时间轴帧序列。返回 (frames, warnings)。"""
    for k in ("in_duration", "hold_duration", "out_duration", "gap_duration"):
        if getattr(cfg, k) < 0:
            raise ValueError(f"效果时长不能为负：{k}={getattr(cfg, k)}")

    n_in = _seg_frames(cfg.in_duration, cfg.fps)
    n_hold = _seg_frames(cfg.hold_duration, cfg.fps)
    n_out = _seg_frames(cfg.out_duration, cfg.fps)
    n_gap = _seg_frames(cfg.gap_duration, cfg.fps)
    total = n_in + n_hold + n_out + n_gap
    warnings = []
    if total == 0:
        raise ValueError("效果总时长为 0，请调大 进场/停留/退场/黑屏 时长。")
    if total > MAX_FRAMES:
        scale = MAX_FRAMES / total
        n_in = round(n_in * scale)
        n_hold = round(n_hold * scale)
        n_out = round(n_out * scale)
        n_gap = MAX_FRAMES - n_in - n_hold - n_out
        warnings.append(
            f"效果总帧数超过 {MAX_FRAMES}，已按比例压缩为 {MAX_FRAMES} 帧"
            f"（{MAX_FRAMES / cfg.fps:.1f} 秒）。")

    black = np.zeros_like(base)
    frames: List[np.ndarray] = []

    # 呼吸特例：入场与退场同为 breathing 时，整段（非黑屏）做正弦亮度起伏
    if (cfg.in_effect and cfg.out_effect
            and cfg.in_effect.name == "breathing"
            and cfg.out_effect.name == "breathing"):
        n_vis = n_in + n_hold + n_out
        for t in range(n_vis):
            u = t / (n_vis - 1) if n_vis > 1 else 0.5
            m = 0.3 + 0.7 * math.sin(math.pi * u)   # 暗 → 亮 → 暗 完整呼吸
            frames.append(np.clip(base.astype(np.float32) * m, 0, 255).astype(np.uint8))
        frames.extend([black] * n_gap)
        return frames, warnings

    # 进场段
    if cfg.in_effect:
        ps = [1.0] if n_in == 1 else list(np.linspace(0.0, 1.0, n_in)) if n_in > 1 else []
        frames.extend(apply_effect(cfg.in_effect, base, p) for p in ps)
    # 停留段
    frames.extend([base] * n_hold)
    # 退场段（变换倒放：p 从 1 → 0）
    if cfg.out_effect:
        ps = [0.0] if n_out == 1 else list(np.linspace(1.0, 0.0, n_out)) if n_out > 1 else []
        frames.extend(apply_effect(cfg.out_effect, base, p) for p in ps)
    # 黑屏段
    frames.extend([black] * n_gap)
    return frames, warnings
