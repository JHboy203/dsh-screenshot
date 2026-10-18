# dsh-screenshot · DSH 截图插件

QQ 同款截图，按钮挂在**对话输入框「语音」键旁边**（`conversation.input.left` 槽，order `-90`）。

## 能力

| 菜单项 | 说明 |
|---|---|
| ✂ 截图 | 抓屏 → 框选 → 标注 → **贴进输入框 + 复制到剪贴板**（两条都做） |
| ⏺ 录屏 | ffmpeg gdigrab 整屏录制（H.264 + faststart），右上角计时胶囊点「停止」收尾 |
| Aa 提取文字 | 框选后**离线 OCR**（Windows 自带引擎，不出本机），出可复制/可贴进输入框的文本面板 |
| 译 屏幕翻译 | OCR 之后把文字（带翻译指令前缀）贴进输入框，交给 DSH 自己的模型翻 |
| ⇕ 长截图 | 框选区域 → 宿主滚一屏抓一张 → 重叠区对齐拼接 → 长图回到标注界面 |
| 范围 | 整个桌面 / 只截 DSH 窗口 |
| ☐ 截图时隐藏当前窗口 | QQ 同款开关；**只有宿主进程里生效**（见下） |
| 🪟 抓窗方式 | 屏幕区域（快）/ 窗口自绘 PrintWindow（被挡住也拍得到） |

标注工具：矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克，八色 + 粗细滑杆，撤销重做（游标模型），
Enter 完成、Esc 取消、Ctrl+Z/Y、Ctrl+C、Ctrl+S、Ctrl+A 全选、双击全屏。
另有**贴图**（钉在界面上，拖动移动、Ctrl+滚轮缩放）。

热键：`Ctrl+Alt+A` 截图，`Ctrl+Alt+O` 提取文字。

## 为什么抓屏一定在宿主半边

渲染进程**拿不到屏幕**：官方主会话没有 `setDisplayMediaRequestHandler`，权限处理器只放行
麦克风（`/lib/main.js` 逐个文件取证过），`getDisplayMedia()` 拿不到任何源。
所以宿主半边用 PowerShell/.NET：

- `System.Drawing.Graphics.CopyFromScreen` → 整屏（自动覆盖多显示器虚拟屏）
- `PrintWindow(PW_RENDERFULLCONTENT)` → 单窗口，被别的窗口挡住也拍得到
- `Windows.Media.Ocr` → 离线 OCR
- `ffmpeg -f gdigrab` → 录屏
- 合成滚轮 `mouse_event(WHEEL)` + Python/PIL 重叠对齐 → 长截图

## 三个必须记住的坑

1. **DPI**：不先 `SetProcessDPIAware()`，进程拿到的是虚拟化坐标 —— 本机 125% 缩放下同一窗口
   会是 1295×823 而不是 1619×1029（截图发糊）。
2. **低完整性进程做不了窗口操作**：DSH 的工具沙箱是 Low 完整性，`ShowWindow` /
   `SetForegroundWindow` / `PrintWindow` 会被 UIPI **静默拒绝**（不报错、窗口纹丝不动）。
   所以「隐藏窗口」「窗口自绘」只有在**插件宿主进程**里起的 pwsh 才有效，
   在工具 shell 里验证必然失败 —— 这不是 bug。
3. **含中文的 .ps1 必须带 UTF-8 BOM**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 GBK 解码，
   中文注释会被撕碎，甚至**吞掉后面的代码行**（症状是莫名其妙的 `LockBits`/参数类型错误）。

## 自检

```bash
node .tools/dsh-shot-smoke.mjs          # 88 项：文件/清单/两端契约/覆盖层/接线/PowerShell 静态体检/宿主可加载
node .tools/dsh-shot-smoke.mjs --live   # 再加真抓屏 + 真 OCR（沙箱里会 SKIP，见坑 2）
```

浏览器里真点真画地验标注界面：

```bash
node .tools/devserver.mjs 8934 "$DSH_WORKSPACE"
# 打开 http://127.0.0.1:8934/DSH-Plugin/dsh-screenshot/dev/harness.html
```

`dev/harness.html` 会**从 client.js 里把覆盖层那段抠出来 eval** —— 验的就是真正装进 DSH 的代码。
（为什么内联而不是 import：官方客户端模块只服务声明过的 chunk，任意路径取不到。）

## 接线

```bash
node .tools/dsh-plugin-install.cjs install dsh-screenshot "$DSH_WORKSPACE\DSH-Plugin\dsh-screenshot"
# 沙箱下 symlink 会 EPERM，改用 cmd /c mklink /J + node .tools/_add-bundle.cjs
```

宿主半边改完**必须重启 DSH Desktop**（Electron host 不消费 `patchReload: live`）。


## 适用 profile

本插件面向 DSH 的 `desktop` profile。本机已在 `desktop` profile 下加载（`.dsh/profiles/desktop`）。插件包本身不含 profile 配置，profile 名可自行替换。

## 安装（DSH 命令行）

```bash
# <profile> 换成你的 profile 名，本机为 desktop
dsh plugin --profile desktop add <本目录或包名>
```

等价的离线方式：把本仓 `cordis.patch.yml` 里的 `insert` 行追加到本机 profile 的
`cordis.patch.yml`。**改了 `cordis.patch.yml` 必须重启 DSH**（Desktop 不 watch patch 层）。

## 外部依赖与权限

- 运行位置：DSH 宿主进程（Node 侧）或浏览器侧，**需要本机文件读写权限**（部分工具会读写工作区内的文件）。
- 外部命令：`powershell.exe` + .NET（抓屏在宿主半边做）
- 环境变量（可选，用于覆盖默认值；值不写进仓库）：`DSH_SHOT_DIR`、`DSH_SHOT_CACHE`、`DSH_OVERLAY_DIR`、`DSH_SHOT_HELPER`、`DSH_SHOT_HELPER_MS`、`DSH_SHOT_MAX_TOTAL_HEIGHT`、`DSH_SHOT_OVERLAY`
- 监听端口：无

## 已知限制

- **仅在本机 Windows + DSH `desktop` profile 实测**，其他平台/版本未验证。
- 私有备份仓：按 `.gitignore` 排除了 `node_modules`、运行时缓存、调试 dump 与备份文件；要复现运行请自行 `npm install`（如有依赖）。
- 文档中出现的 `$DSH_WORKSPACE`、`$TK_ROOT`、`%USERPROFILE%` 等是**占位符**，使用前需替换成本机实际路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方代码、字体、图标或数据的许可证需单独核对（见仓内说明）。
