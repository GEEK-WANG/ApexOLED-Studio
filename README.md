# ApexOLED Studio（赛睿 OLED 动图工坊）

把**任意图片 / GIF / 视频**一键转换为 **SteelSeries Apex Pro TKL 键盘 OLED 屏**内容：
**128 × 40 像素、10 FPS、无限循环**。

## 功能

- **GUI 所见即所得**：改参数立刻看到键盘上的真实效果，预览即成品（pywebview + Web UI）
- **8 类动画效果**：淡入淡出 / 擦除 / 揭开 / 缩放 / 百叶窗 / 扫描线 / 像素化 / 呼吸，
  支持方向、入场+退场组合、四段时间轴（进场 / 停留 / 退场 / 间隔）
- **白底 Logo 优化**：白底压黑、彩色文字提亮，小屏上锐利可读
- **三种色彩模式**：1 位黑白（OLED 上最清晰）/ 灰度 / 彩色，可选抖动
- **五种导出格式**：GIF（动态）/ PNG / JPG / BMP
- **批量转换**：文件夹一次全转
- **源图框选**：只上屏你选中的区域

## 安装

需要 **Python 3.10+**；视频输入需要 **FFmpeg**（图片 / GIF 无需）。

```powershell
pipx install .          # 或: pip install .
apexoled --gui          # 打开图形界面
```

FFmpeg 安装：`winget install ffmpeg` 后重开终端（或将 ffmpeg.exe 所在目录加入 PATH）。

## 使用

### GUI（推荐）

```powershell
apexoled --gui
```

选择素材 → 拖拽框选上屏区域 → 调参数实时预览 → 导出。

### 命令行

```powershell
apexoled photo.png                            # 静态图 -> PNG
apexoled logo.png --logo                      # 白底 Logo 优化
apexoled pic.png --effect fade                # 静态图 + 淡入淡出 -> GIF
apexoled pic.png --effect wipe:l2r+fade       # 擦除入场 + 淡出退场
apexoled anim.mp4 --duration 3                 # 视频前 3 秒 -> GIF
apexoled pic.png --format jpg --quality 92   # JPG 导出
apexoled ./images --outdir ./out              # 批量转换
apexoled --help                               # 全部参数
```

### 上传到键盘

SteelSeries Engine（GG）→ 选择键盘 → **OLED & Settings** → **Edit OLED Image** →
**Upload From File** → 选择生成的文件 → **DONE** → **SAVE**。

## 效果语法

`NAME[:direction][+NAME[:direction]]`，如 `wipe:l2r+fade` = 擦除入场 + 淡出退场。

| 效果 | 方向 | 说明 |
|---|---|---|
| fade | — | 淡入淡出 |
| wipe | 8 向（l2r/r2l/t2b/b2t/四对角） | 擦除 |
| reveal | 8 向（默认 t2b） | 揭开（v1.x 兼容） |
| zoom | — | 从中心放大 |
| blinds | h / v | 百叶窗 |
| scanline | t2b / b2t | 扫描线 |
| pixelate | — | 像素化浮现 |
| breathing | — | 全时间轴呼吸起伏 |

时间轴：`--effect-in 0.8 --effect-hold 1.6 --effect-out 0.8 --effect-gap 0.4`（秒），
上限 60 帧，`--effect-gap 0` 可无缝循环。

## 开发

```powershell
pip install -e .[dev]     # 安装为可编辑包
pip install pillow numpy pywebview pytest
python -m pytest tests/ -q # 127 项回归
python -m apexoled --gui  # 本地运行 GUI
```

架构：`apexoled/decode`（Pillow + FFmpeg 管道）→ `engine`（logo/增强/缩放/量化）→
`effects`（8 类帧变换 + 时间轴）→ `exporters`（GIF/静态/预览 HTML）；`ui` 为
pywebview 桌面壳（Web UI），`cli` 为命令行。规格详见 `PRD.md`。
