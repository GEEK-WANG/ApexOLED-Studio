# ApexOLED Studio（赛睿 OLED 动图工坊）

把任意图片 / GIF / 视频一键转换为**赛睿 Apex Pro TKL 键盘 OLED 屏**支持的动图 GIF：



* **分辨率：128 × 40 像素**（Apex Pro TKL OLED 原生分辨率）

* **帧率：10 FPS**（键盘支持的上限，动画流畅且文件小）

* **无限循环播放**，直接通过 SteelSeries Engine 上传

实现方式：**Python 3（仅标准库）+ FFmpeg**，零第三方依赖。



***

## 目录结构



```
ApexOLED-Studio/
├── apex_oled.py          # 主程序（命令行 + 图形界面二合一）
├── run_gui.bat           # 双击启动图形界面
├── README.md             # 本文档
├── output/               # 转换结果默认输出到这里
│   └── *_preview.html    # 每个 GIF 附带的预览页（双击打开）
└── examples/             # 演示素材与转换示例
```



***

## 环境要求



1. **Python 3.8+** —— 自带 tkinter 即可，无需安装任何 pip 包

2. **FFmpeg** —— 需在系统 PATH 中（`ffmpeg` 和 `ffprobe`）

检查方法，在终端执行：



```
python --version
ffmpeg -version
```

如果提示 `ffmpeg 不是内部或外部命令`，请到 [https://www.gyan.dev/ffmpeg/builds/](https://www.gyan.dev/ffmpeg/builds/) 下载

`ffmpeg-release-full` 版，解压后把 `bin` 目录加入系统 PATH，或把 `bin` 目录下的

`ffmpeg.exe`、`ffprobe.exe` 复制到本目录。



***

## 快速上手

### 方式一：图形界面（推荐新手）

双击 `run_gui.bat`：

1. 选择图片/视频

2. 点「**框选区域…**」——在图上拖拽，框出你真正想显示在 OLED 上的部分
   （比如白底 logo 图只框文字区域），点「试看 OLED 效果」可先看 4 倍放大预览

3. 勾选「**白底 Logo 优化**」（白底 logo 图强烈建议开启：背景压成黑色、文字更醒目）

4. 选「**增强**」：轻度 / 强力（文字更锐利）

5. 选「**效果**」（静态图片）：淡入淡出 / 擦除 / 揭开，让静态图也能动起来

6. 选输出目录 → 点「开始转换」

### 方式二：命令行

在项目目录打开终端（PowerShell / CMD）：



```
# 单张图片转成 OLED GIF（默认黑白像素风，输出到 output/）
python apex_oled.py 照片.png

# 白底 logo：框选文字区域 + 黑白 + 淡入淡出动画（推荐配方）
python apex_oled.py 火影忍者.png --crop 430x140+70+60 --logo --enhance strong --effect fade

# 视频转动图，只取前 3 秒
python apex_oled.py 视频.mp4 --duration 3

# 动图转黑白（平滑递色像素风，不开 logo）
python apex_oled.py 动画.gif --colors bw --dither auto

# 静态图 + 擦除动画（从左向右揭开）
python apex_oled.py 犬夜叉.jpg --crop 500x210+40+40 --logo --effect wipe

# 批量转换整个文件夹
python apex_oled.py D:\图片文件夹 --outdir D:\转换结果

# 自定义输出文件名（仅单文件时有效）
python apex_oled.py 照片.png -o my_oled.gif
```



***

## 参数说明



| 参数             | 默认值       | 说明                                        |
| -------------- | --------- | ----------------------------------------- |
| `inputs`       | 必填        | 输入文件或文件夹，可同时传多个                           |
| `-o, --output` | 自动命名      | 输出 GIF 路径（仅单个输入时有效）                       |
| `--outdir`     | `output/` | 输出目录（批量时使用）                               |
| `--fps`        | `10`      | 动画帧率，键盘推荐 10，最大建议不超过 10                   |
| `--mode`       | `cover`   | `cover`= 裁剪填满屏幕；`fit`= 完整显示、四周加背景         |
| `--bg`         | `black`   | `fit` 模式背景色：`black` / `white` / `#RRGGBB` |
| `--colors`     | `bw`      | 色彩模式：`bw`=1 位黑白（默认，OLED 上最清晰、最省空间）；`gray`=灰度；`color`=彩色 |
| `--palette`    | `256`     | 调色板颜色数 2\~256，默认 256；越小文件越小、风格越硬朗                |
| `--dither`     | `auto`    | `auto`=平滑抖动；`none`=无抖动；`bayer`=棋盘纹理（递色像素风）     |
| `--effect`     | `none`    | 静态图动画效果（仅单张图片）：`fade`=淡入淡出；`wipe`=擦除（左→右揭开）；`reveal`=揭开（上→下展开） |
| `--effect-duration` | `0.8` | 效果进出场时长（秒），总时长≈ 2×时长 + 2 秒，默认约 3.6 秒 |
| `--duration`   | 无         | 视频输入截取时长（秒）                               |
| `--max-frames` | 无         | 最多保留帧数（10FPS 下 60 帧 ≈ 6 秒）                |
| `--crop`       | 无         | 框选区域（原图像素）`WxH+X+Y`，如 `430x140+70+60`；图形界面里可直接拖拽框选 |
| `--logo`       | 关         | 白底 Logo 优化：把白色背景压成黑色，彩色文字更醒目（适合白底 logo 图） |
| `--enhance`    | `none`    | 锐化增强：`none`=无，`light`=轻度，`strong`=强力（文字更锐利） |
| `--no-preview` | 关         | 转换后不生成预览 HTML                             |
| `--gui`        | 关         | 启动图形界面                                    |

> 说明：
>
> - `--colors bw` 即官方社区常说的 “黑白图” 做法（贴吧 / B 站教程同思路），在 OLED 小屏上对比度最高、显示最锐利。
>
> - 黑白 + 白底 Logo（`--colors bw --logo`）会用「逐通道阈值」把彩色文字拉成白/黑两值：白底 logo 变成白字黑底；红字黄圈这类彩圈 logo 自然形成黑字白圈黑底，两种都清晰可读。
>
> - `--effect` 只在输入是单张图片时生效（视频 / GIF 本身有动画，不再叠加）。三种效果循环播放：进场 → 停留约 1.6 秒 → 淡出 → 短暂黑屏。
>
> - `--crop` 的坐标以**原图**为准（左上角为原点）：先框出主要区域，再按 128×40 适配。框选时提示会显示当前选区比例，接近 3.2:1（OLED 比例）最省事。



***

## 上传到键盘



1. 打开 **SteelSeries Engine**（赛睿 GG 软件）

2. 选择你的 **Apex Pro TKL** 键盘

3. 打开 **OLED & Settings** 选项卡

4. 左侧 **Edit OLED Image** → **Upload From File**

5. 选择转换生成的 `.gif` 文件

6. 点 **DONE**，再点 **SAVE**



***

## OLED 动图制作小技巧



* **高对比度**：屏幕只有 128×40，明暗反差越大越清晰，暗色背景 + 亮色主体最佳

* **避免 1px 细线**：缩到 40px 高之后细线条会糊或闪，线条越粗越好

* **主体居中**：`cover` 模式会裁剪四周，重要内容放在画面中央

* **动画别太长**：10FPS 下 60 帧≈6 秒，文件小、上传快、OLED 烧屏风险低

* **文字内容**：先用大字号图片再转换，字号小于 10px 会看不清

* **彩色 vs 黑白**：素材色彩层次多→黑白更耐看；像素风 / 卡通→彩色更出效果



***

## 常见问题

**Q: 提示找不到 FFmpeg？**

安装 FFmpeg 并加入 PATH（见上文「环境要求」）。

**Q: 转换出来是静态的？**

输入是单张图片时输出就是单帧 GIF，属于正常现象；想要动画请用 GIF / 视频作为输入，

或把多张图片做成视频 / 动图后再转换。

**Q: 动画太快 / 太慢？**

用 `--fps` 调整；视频太长用 `--duration` 截取。

**Q: 上传后显示不全 / 内容被裁掉？**

用 `--mode fit` 可完整显示；或调整原始素材让主体居中。

**Q: 彩色 GIF 有杂色 / 噪点？**

试试 `--dither none`（更干净）或 `--colors bw`（最干净）。

**Q: 文件太大上传失败？**

用 `--palette 128` 或更低、缩短动画、用 `--colors bw`。



***

## 参考



* 赛睿官方博客：5 Fun Ways To Use Your OLED Display

  [https://steelseries.com/zh-cn/blog/steelseries-oled-gifs-and-customization-137](https://steelseries.com/zh-cn/blog/steelseries-oled-gifs-and-customization-137)

* B 站二创：赛睿 Apex Pro 小屏幕图片分享（120x40 黑白图思路）

  [https://www.bilibili.com/video/BV1NA411P7hq/](https://www.bilibili.com/video/BV1NA411P7hq/)