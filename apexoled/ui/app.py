# -*- coding: utf-8 -*-
"""pywebview 桌面壳启动器（R2）：Windows 走系统自带 WebView2。"""
from pathlib import Path

from .. import APP_NAME, VERSION

_WEB_DIR = Path(__file__).parent / "web"


def launch(width: int = 1000, height: int = 720):
    """打开主窗口（阻塞直至窗口关闭）。"""
    import webview  # 延迟导入：CLI 批量用户无需 GUI 依赖可用

    from .api import OledApi

    webview.create_window(
        f"{APP_NAME} v{VERSION}",
        str(_WEB_DIR / "index.html"),
        js_api=OledApi(),
        width=width, height=height,
        min_size=(880, 640),
        text_select=False,
    )
    webview.start()
