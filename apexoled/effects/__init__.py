# -*- coding: utf-8 -*-
"""效果注册表：新增效果 = 写一个变换函数 + register() 一行注册。

效果语法（CLI --effect / GUI 下拉）：
    NAME[:direction][+NAME[:direction]]
如 wipe:l2r+fade = 擦除入场 + 淡出退场（N2.4/N2.5/N2.6）。
"""
from dataclasses import dataclass
from typing import Optional, Tuple

from . import transforms as T
from .transforms import WIPE_DIRECTIONS


@dataclass
class EffectSpec:
    name: str
    direction: Optional[str] = None


# name → (fn, 默认方向, 允许方向集合)
_REGISTRY = {}


def register(name, fn, default_direction=None, directions=None):
    _REGISTRY[name] = (fn, default_direction, set(directions or ()))


register("fade", T.fade)
register("wipe", T.wipe, "l2r", WIPE_DIRECTIONS)
register("reveal", T.wipe, "t2b", WIPE_DIRECTIONS)   # v1.x 兼容：揭开=从上向下
register("zoom", T.zoom)
register("blinds", T.blinds, "h", ("h", "v"))
register("scanline", T.scanline, "t2b", ("t2b", "b2t"))
register("pixelate", T.pixelate)
register("breathing", T.breathing)


def effect_names():
    return sorted(_REGISTRY)


def _parse_single(part: str) -> EffectSpec:
    name, _, direction = part.partition(":")
    name = name.strip().lower()
    direction = direction.strip().lower() if direction else None
    if name not in _REGISTRY:
        raise ValueError(
            f"未知效果：{part}（可选 {'/'.join(effect_names())}）")
    fn, default_dir, allowed = _REGISTRY[name]
    if direction is None:
        direction = default_dir
    elif allowed and direction not in allowed:
        raise ValueError(
            f"效果 {name} 不支持方向 {direction}（可选 {'/'.join(sorted(allowed))}）")
    return EffectSpec(name, direction)


def parse_effect_spec(s: str) -> Tuple[Optional[EffectSpec], Optional[EffectSpec]]:
    """'wipe:l2r+fade' → (入场 spec, 退场 spec)；单个效果时入场=退场。"""
    s = (s or "").strip()
    if not s or s.lower() == "none":
        return None, None
    parts = s.split("+")
    if len(parts) > 2:
        raise ValueError("效果表达式最多包含 入场+退场 两个效果，如 wipe:l2r+fade。")
    first = _parse_single(parts[0])
    second = _parse_single(parts[1]) if len(parts) == 2 else _parse_single(parts[0])
    return first, second


def apply_effect(spec: EffectSpec, frame, p: float):
    fn, default_dir, _allowed = _REGISTRY[spec.name]
    return fn(frame, p, spec.direction or default_dir)
