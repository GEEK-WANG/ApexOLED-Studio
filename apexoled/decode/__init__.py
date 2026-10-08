# -*- coding: utf-8 -*-
"""解码层：图片 / GIF / APNG 用 Pillow，视频用 FFmpeg 抽帧，统一产出 RGB 帧序列（numpy）。"""
import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import numpy as np
from PIL import Image, UnidentifiedImageError

from .. import SUPPORTED_EXTS

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif", ".apng"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}


@dataclass
class FrameSequence:
    frames: List[np.ndarray]          # RGB uint8，可能仍为源分辨率
    animated: bool
    source: str                       # image / anim / video
    warnings: List[str] = field(default_factory=list)


def parse_crop(s: str) -> dict:
    """解析 'WxH+X+Y' 为 {w,h,x,y}（原图像素坐标）。"""
    m = re.match(r"^(\d+)[xX](\d+)[+](\d+)[+](\d+)$", s.strip())
    if not m:
        raise ValueError("--crop 格式应为 WxH+X+Y，例如 430x140+70+60（宽x高+左+上）。")
    return {"w": int(m.group(1)), "h": int(m.group(2)),
            "x": int(m.group(3)), "y": int(m.group(4))}


def check_crop_bounds(crop: dict, src_w: int, src_h: int) -> None:
    if crop["w"] <= 0 or crop["h"] <= 0:
        raise ValueError("裁剪区域宽高必须大于 0。")
    if crop["x"] + crop["w"] > src_w or crop["y"] + crop["h"] > src_h:
        raise ValueError(
            f"裁剪区域超出图片范围：图片为 {src_w}x{src_h}，"
            f"而框选区域为 x:{crop['x']} y:{crop['y']} w:{crop['w']} h:{crop['h']}，请重新框选。")


def _decode_image(path: Path):
    """Pillow 解码图片 / GIF / APNG。返回 (frames, durations_ms, animated)。"""
    try:
        im = Image.open(path)
        im.load()
    except (UnidentifiedImageError, OSError) as e:
        raise RuntimeError(f"无法读取图片文件 {path}：{e}")

    n = getattr(im, "n_frames", 1)
    if n > 1:
        frames, durs = [], []
        for i in range(n):
            im.seek(i)
            frames.append(np.asarray(im.convert("RGB"), dtype=np.uint8).copy())
            durs.append(im.info.get("duration") or 0)
        return frames, durs, True
    return [np.asarray(im.convert("RGB"), dtype=np.uint8).copy()], None, False


def _resample_frames(frames, durations_ms, fps, max_frames):
    """按目标帧率对动画帧序列重采样（时间轴最近帧取样）。"""
    if not durations_ms or all(d <= 0 for d in durations_ms):
        durations_ms = [100] * len(frames)
    durations_ms = [d if d > 0 else 100 for d in durations_ms]
    total_s = sum(durations_ms) / 1000.0
    ticks = max(1, int(round(total_s * fps)))
    bounds = np.cumsum([0] + list(durations_ms))
    out = []
    for k in range(ticks):
        t_ms = k * 1000.0 / fps
        idx = int(np.searchsorted(bounds, t_ms, side="right")) - 1
        out.append(frames[min(max(idx, 0), len(frames) - 1)])
    if max_frames:
        out = out[:max_frames]
    return out


def _probe_video(path: Path):
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("未找到 FFmpeg/ffprobe，视频输入需要先安装 FFmpeg 并加入 PATH（见 README）。")
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "json", str(path)]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0 or not (p.stdout or "").strip():
        raise RuntimeError(f"ffprobe 无法读取输入文件 {path}：{(p.stderr or '').strip()}")
    try:
        streams = json.loads(p.stdout).get("streams") or []
        w, h = int(streams[0]["width"]), int(streams[0]["height"])
    except (ValueError, KeyError, IndexError):
        raise RuntimeError(f"无法从 {path} 中读取视频尺寸信息。")
    return w, h


def _decode_video(path: Path, fps, duration, max_frames, crop):
    """FFmpeg 管道抽帧：rawvideo RGB24 → numpy 帧。crop 在 FFmpeg 侧先行裁剪。"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 FFmpeg，视频输入需要先安装 FFmpeg 并加入 PATH（见 README）。")

    src_w, src_h = _probe_video(path)
    out_w, out_h = src_w, src_h
    vf = []
    if crop:
        check_crop_bounds(crop, src_w, src_h)
        vf.append(f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}")
        out_w, out_h = crop["w"], crop["h"]
    vf.append(f"fps={max(1, int(fps))}")

    cmd = [ffmpeg, "-v", "error", "-y", "-i", str(path)]
    if duration:
        cmd += ["-t", f"{float(duration):g}"]
    if max_frames:
        cmd += ["-frames:v", str(int(max_frames))]
    cmd += ["-vf", ",".join(vf), "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or not p.stdout:
        tail = (p.stderr or b"").decode("utf-8", errors="replace").strip()[-600:]
        raise RuntimeError(f"FFmpeg 解码视频失败：{tail or '没有输出帧'}")

    fsize = out_w * out_h * 3
    n = len(p.stdout) // fsize
    if n == 0:
        raise RuntimeError(f"未能从视频 {path} 中解码出任何帧。")
    frames = [np.frombuffer(p.stdout, dtype=np.uint8, count=fsize,
                            offset=i * fsize).reshape(out_h, out_w, 3).copy()
              for i in range(n)]
    return frames


def decode(path, fps: int = 10, duration: Optional[float] = None,
           max_frames: Optional[int] = None, crop: Optional[dict] = None) -> FrameSequence:
    """把输入文件解码为 RGB 帧序列。图片/GIF/APNG 无需 FFmpeg。"""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"输入文件不存在：{path}")
    ext = path.suffix.lower()

    if ext in VIDEO_EXTS:
        frames = _decode_video(path, fps, duration, max_frames, crop)
        return FrameSequence(frames, animated=len(frames) > 1, source="video")

    if ext in IMAGE_EXTS:
        frames, durs, animated = _decode_image(path)
        if animated:
            frames = _resample_frames(frames, durs, fps, max_frames)
            if duration:
                frames = frames[:max(1, int(round(duration * fps)))]
            animated = len(frames) > 1
        if crop:
            check_crop_bounds(crop, frames[0].shape[1], frames[0].shape[0])
            frames = [f[crop["y"]:crop["y"] + crop["h"],
                        crop["x"]:crop["x"] + crop["w"]].copy() for f in frames]
        return FrameSequence(frames, animated=animated, source="anim" if animated else "image")

    raise ValueError(f"不支持的文件类型：{path.name}（支持 {', '.join(sorted(SUPPORTED_EXTS))}）")
