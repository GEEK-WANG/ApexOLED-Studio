# ApexOLED Studio — 赛睿 OLED 动图工坊

把**任意图片 / GIF / 视频**一键转换为 **SteelSeries Apex Pro TKL 键盘 OLED 屏**内容：
**128 × 40 像素、10 FPS、无限循环**。

**纯浏览器本地工具** —— 打开网页即可用，无需安装 Python、FFmpeg 或任何软件；
素材全程在你的浏览器内处理，**不会上传到任何服务器**。

## 快速上手（三步）

1. **拖入素材**：图片（PNG/JPG/BMP/WebP…）、GIF 动图、或视频（MP4/WebM/MOV…）
2. **调整效果**：实时预览键盘上的真实效果，「预览即成品」
3. **导出并上传**：下载 GIF（动图）或 PNG（静图），到赛睿驱动里上传

### 上传到键盘

打开 **SteelSeries GG** → 选择键盘 → **OLED & Settings** → **Edit OLED Image** →
**Upload From File** → 选中导出的文件 → **DONE** → **SAVE**。

## 功能

- **所见即所得**：1:1 真实尺寸 + 4x 放大双预览，逐帧播放器，改参数立刻刷新
- **8 类动画效果**：淡入淡出 / 擭除 / 揭开 / 缩放 / 百叶窗 / 扫描线 / 像素化 / 呼吸，
  支持方向、入场+退场自由组合、四段时间轴（进场 / 停留 / 退场 / 黑屏）
- **三种色彩模式**：黑白（OLED 上最清晰，推荐）/ 灰度 / 彩色，可选抖动与调色板颜色数
- **白底 Logo 优化**：白底压黑、彩字提亮，小屏上锐利可读
- **源图框选**：在原图上拖出矩形，只上屏你选中的区域
- **视频抽帧**：按帧率抽取、可限时长与最多帧数
- **多格式导出**：GIF（动态循环）/ PNG / JPG / BMP

## 效果一览

| 效果 | 方向 | 说明 |
|---|---|---|
| fade | — | 淡入淡出 |
| wipe | 8 向（l2r/r2l/t2b/b2t/四对角） | 擭除 |
| reveal | 8 向（默认 t2b） | 揭开 |
| zoom | — | 从中心缩放渐显 |
| blinds | h / v | 百叶窗 |
| scanline | t2b / b2t | 扫描线（带高亮前沿） |
| pixelate | — | 像素化浮现 |
| breathing | — | 全时间轴正弦呼吸（入场+退场同为呼吸时） |

时间轴默认 进场 0.8s / 停留 1.6s / 退场 0.8s / 黑屏 0.4s，上限 60 帧，超长自动按比例压缩。

## 本地运行 / 部署

本站为**零构建纯静态站**（原生 HTML/CSS/JS ES Modules），仓库根即站点根。

```powershell
# 本地预览（任意静态服务器均可）
python -m http.server 8765
# 打开 http://localhost:8765/
```

部署到 GitHub Pages：仓库 **Settings → Pages → Source 选 main 分支 / root** 即可上线。

## 自检页（selftest）

打开 `selftest.html` 可运行 **60 项自动化断言**：

- 26 组逐像素对拍（与 Python 基准版生成的一致性样本，含黑白/灰度/彩色、8 类效果与时间轴）
- 25 项行为断言（参数校验、裁剪、重采样等）
- GIF 结构走查 + 浏览器解码实证（LZW 编码正确性）
- PNG / JPG / BMP 导出回读

引擎曾以 Python（numpy + Pillow）实现并经 127 项 pytest 回归，JS 版逐像素对拍通过后
Python 版已退役（可在 git 历史中查看）。selftest 页用于验证浏览器引擎的正确性。

## 浏览器兼容

- Chrome / Edge / Firefox 133+：全功能（`ImageDecoder` 逐帧解码 GIF）
- Safari：GIF 降级为取首帧，其余功能正常
- 视频抽帧依赖 `<video>` 解码，建议 MP4/WebM

## 架构

```
index.html / app.js / style.css   UI（零依赖原生 JS）
js/engine/
  core.js       常量与数学工具（fround 对齐 float32、银行家舍入）
  decode.js     解码（createImageBitmap / ImageDecoder / <video> 抽帧）
  process.js    预处理（白底 logo / 黑白阈值 / 锐化 / cover-fit 缩放）
  effects.js    8 类效果帧变换 + 四段时间轴
  quantize.js   量化（1bit 黑白 / 灰度 / 中位切色彩色 + Bayer 抖动）
  export.js     GIF89a 编码器（LZW）+ PNG/JPG/BMP + 下载
  pipeline.js   渲染管线（预览与导出共用，保证预览即成品）
selftest.html + selftest-fixtures.json   60 项自检
PRD.md   产品规格（v3.0）
```

## 路线图

- ✅ Web 版引擎（对拍验证通过）
- ⬜ 提交至 SteelSeries gamesense 生态（[gamesense SDK](https://github.com/SteelSeries/gamesense)），
  让工具直接出现在官方驱动的 OLED 应用列表中

## 许可与致谢

仅供学习交流。OLED 上传能力使用 SteelSeries GG 官驱自带功能；
参考 [SteelSeries gamesense-sdk](https://github.com/SteelSeries/gamesense-sdk)。
