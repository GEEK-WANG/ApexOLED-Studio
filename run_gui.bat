@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ApexOLED Studio - 赛睿 OLED 动图工坊
echo ============================================
echo   ApexOLED Studio - 赛睿 OLED 动图工坊
echo ============================================
echo 正在启动图形界面，请稍候...
echo.

rem 依次尝试：py 启动器 -> PATH 中的 python
set "PYCMD="
where py >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3"
if not defined PYCMD (
    where python >nul 2>nul
    if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
    echo.
    echo [错误] 未找到 Python 3，无法启动。
    echo 请到 https://www.python.org/downloads/ 安装，
    echo 安装时务必勾选 "Add Python to PATH"，装完后再双击本文件。
    pause
    exit /b 1
)

%PYCMD% apex_oled.py --gui
if errorlevel 1 (
    echo.
    echo [错误] 程序启动失败，请查看上方报错信息。
    pause
)
