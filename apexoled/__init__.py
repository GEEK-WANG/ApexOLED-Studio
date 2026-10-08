# -*- coding: utf-8 -*-
"""ApexOLED Studio —— 赛睿 OLED 动图工坊（v2.0 帧级渲染引擎）。

把任意图片 / GIF / 视频转换为赛睿 Apex Pro TKL 键盘 OLED 屏可用的
动图与图片：128 × 40 像素、10 帧/秒、无限循环。
"""

APP_NAME = "ApexOLED Studio"
VERSION = "2.0.0b1"

# 赛睿 Apex Pro TKL OLED 屏硬性规格
WIDTH = 128
HEIGHT = 40
DEFAULT_FPS = 10

# 支持的输入扩展名（批量模式按此过滤）
SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp",
                  ".gif", ".apng", ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
