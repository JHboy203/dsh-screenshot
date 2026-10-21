# dsh-screenshot · DSH 截图插件

[English](README.en.md)


QQ 同款截图，按钮挂在**对话输入框「语音」键旁边**（`conversation.input.left` 槽，order `-90`）。

## 能力

| 菜单项 | 说明 |
|---|---|
| ✂ 截图 | **一律在原生覆盖层里框选**（独立进程的全屏真窗口，能盖住别的应用）→ 标注 → **贴进输入框 + 复制到剪贴板** |
| ⏺ 录屏 | ffmpeg gdigrab 录制（H.264 + faststart）。**默认先框一块再录**（见下），屏幕上有一圈红框标出边界，右上角计时胶囊点「停止」收尾 |
| Aa 提取文字 | 框选后**离线 OCR**（Windows 自带引擎，不出本机），出可复制/可贴进输入框的文本面板 |
| 译 屏幕翻译 | OCR 之后把文字（带翻译指令前缀）贴进输入框，交给 DSH 自己的模型翻 |
| ⇕ 长截图 | 框选区域 → 宿主滚一屏抓一张 → 重叠区对齐拼接 → 长图回到标注界面 |
| ☐ 截图时隐藏 DSH 界面 | 原生覆盖层在**冻结桌面之前**把 DSH 窗口藏起来（QQ 同款），框完/取消后还原并回到前台；默认关，在「更多设置」里勾 |

> **R33 起删掉了「范围 / 选一个窗口来截 / 自己框范围 / 抓窗方式」四项**，以及在 DSH 窗口里
> 渲染桌面截图的那套（canvas + DOM 覆盖层）。它只能盖住 DSH 自己的窗口、在 125% 缩放下
> 只能框到屏幕左上角一块 —— 留着它等于"看起来能用，框不到你要的东西"。现在唯一入口是原生
> 覆盖层；不可用时**明说**（"重启 DSH 一次"），不再偷偷换成降级界面。老的
> `range/method/pickHwnd/pickTitle/nativeOverlay` 设置由 `prefsVer` 迁移一次性清掉。

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

## 宿主工具（8 个）

| 工具 | 干什么 |
|---|---|
| `screenshot` / `screenshot_windows` | AI 自己抓图（不弹覆盖层、不抢前台、不动窗口），返回文件路径 |
| `shot_health` | **换会话第一条命令**：按"文件时间 vs 进程/实例时间"回答**要不要重启** |
| `shot_gate` | 一条命令跑完闸门（静态契约 / 覆盖层端到端 / 一拍成本 / 宿主全量） |
| `shot_bridge` | 驱动**正在运行**的客户端（state / eval / click / menu / dome / longshot） |
| `shot_displays` | 显示器 / DPI / 负坐标体检 + 越界裁剪实测 |
| **`shot_pixels`** | **像素事实**（R34）：`rect` 现场抓或 `path` 读图 → 黑图判据（meanLuma/blackPct）、某颜色的像素数与**外接框**、与另一张图的**差异占比**（可限定 `region` 只看内部） |
| **`shot_probe`** | **一条命令跑任意 dev 探针**（R34）：`hosttest` / `recframe` / `wheel-target` / `hide-self` / `wheel-app-qt` / `wheel-app-java`；超时**如实判成失败** |

> 这两个是**换会话时的交接面**：验证这个插件最费劲的不是写代码，是"怎么证明屏幕上真的发生了
> 什么"。前者把像素判据变成一次调用，后者把"必须在宿主里跑、各有各的参数"的门槛固化成一张表。

## 自检

```bash
node .tools/dsh-shot-smoke.mjs          # 446 项：文件/清单/两端契约/覆盖层/接线/PowerShell 静态体检/宿主可加载
node .tools/dsh-shot-smoke.mjs --live   # 再加真抓屏 + 真 OCR（沙箱里会 SKIP，见坑 2）
```

宿主半边 + 真窗口的回归（**必须在宿主进程里跑**，沙箱里注入不了消息）：

```
host_selfcheck({plugin:'dsh-screenshot'})                                        # 全量，77 项 / FAIL 必须 0
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-target-probe.mjs'})    # 6 项：投递滚轮投给谁
host_selfcheck({plugin:'dsh-screenshot', script:'dev/hide-self-probe.mjs'})        # 10 项：真藏一次 + 还原 + 几何不变
```

`hide-self-probe` 会**真的把 DSH 窗口藏起来约 1.5 秒**（覆盖层正盖着屏幕，所以看不见），
用来验"藏"与"还原"两半；它同时证明还原**不会改动窗口的摆放**（用 `SW_RESTORE` 会悄悄把
最大化窗口变回普通大小）。

```
host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})         # 12 项：录屏框在屏幕上的像素级证据
host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-selftest.mjs'})         # 11 项：像素库/探针库自检（1 秒，确定性）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','qt']})                                              # Qt 认不认投递滚轮
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','java']})                                            # Java(Swing) 认不认
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-Title','记事本']})                                        # 任何已开着的应用
```

## 区域录屏（R32）

**默认就让人框一块**，而不是整屏：整屏录到不该录的东西代价更高，而"框一块"以前藏在
右键菜单第十几行里、几乎没人知道它存在。菜单里「录制范围：每次框一块 / 整个桌面」可以切回去，
选择会被记住。

四件容易被忽略、但都会让这个功能"看起来坏了"的事：

1. **奇数宽高会让 ffmpeg 当场死掉**（`width not divisible by 2`，留下 0 字节文件）。
   人手拖框极容易拖出 801×601，所以宿主把宽高**向下取偶**，并且**回执里报实际录的尺寸**——
   客户端显示的是真在录的 800×600，不是用户拖的那个数。
2. **框到的区域小于 2×2 时明确报错**，绝不"那就整屏录"（那会把整个桌面录进去）。
3. **屏幕上会画一圈红框**（`ps/recframe.ps1`）说明正在录哪一块 —— 框选覆盖层一关，
   屏幕上再没有别的东西能说明边界在哪。红框画在**捕获矩形之外**，所以不会被录进视频；
   内部用**窗口 region 挖掉**（用 `TransparencyKey` 的那个版本实测屏幕上一个像素都不显示）。
   框起不来不影响录制。
4. **录完必须收掉框**：`record('stop')` 会先落停止信号再杀进程，残留一个红框比不画更糟。

## 录屏结果面板：为什么"抽一帧"会失败（R33）

用户现场：录了 7.3 秒，面板显示 **0 KB**、"当前帧"空白、报 `moov atom not found`；
换成一段正常的录屏，面板又报 `frame produced no file`。两条根因：

1. **`ffmpeg -ss <t>` 落在末尾之后 = 退出码 0 且不产出文件**（不是报错！）。面板默认就在
   `时长 - 0.05` 处取第一张预览帧，而时长用的是**墙钟**，常常比文件真正的结尾多几十毫秒。
   现在：时长优先用文件自己的（`ffprobe`）；`Invoke-Frame` 在"没产出文件"时依次退到
   `-sseof -0.4`（文件末尾前 0.4 秒）和 `t = 0` —— 末帧附近拿不到就退一步，而不是宣布失败。
2. **0 字节的录屏以前会被当成成功**（文件存在、`recordStop` 返回 ok），于是界面开一个
   "必然抽帧失败"的面板，看起来像截屏/录屏整个坏了。现在 `recordStop` 发现
   `bytes === 0` 或时长 0 就**直接报错**，并把 ffmpeg 的 stderr 尾巴带出来 —— 那句话才是
   下次能定位的线索。

## 投递滚轮的适用范围（R32 实测）

auto 长截图不移动鼠标，而是 `PostMessage(WM_MOUSEWHEEL)` 给**点位下面的叶子控件**。已实测：

| 应用类型 | 消息投给 | 结果 |
|---|---|---|
| WinForms | 叶子 TextBox | ✅ 首个可见行 0 → 3（R29） |
| Chromium（DSH 自己） | 叶子 | ✅ scrollTop 180 → 349.6（R29） |
| **Qt 5.15** | 顶层（Qt 一窗一 HWND） | ✅ 滚动条 0 → 9 |
| **Java Swing（JDK 17）** | 顶层（Swing 一窗一 HWND） | ✅ 滚动条 0 → 189 |

⚠️ 这两行的判据是**被测程序自己记的滚动条值**，不是"画面变了没有"——夹具的每一行内容
长得一样，滚动后像素几乎不变（实测 pixel diff 0.0%），只看画面会得出"没滚动"的错误结论。

改了 `ps/*.ps1` 要**重启 DSH**：抓屏助手在执行的那一刻就把脚本读完了，之后不会重读。
（`host_selfcheck` 跑在另一个 node 进程里，它起的助手跟着自己消失，替代不了应用那个 ——
`dev/refresh-shooter.mjs` 能给出"哪个助手是谁的"的证据。**覆盖层助手例外**：它盯着自己的
`.ps1`，改完会自己退出重生。）

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
- 长截图的 auto 模式**优先投递滚轮**（不动光标），判定靠"下一张画面变没变"。投递要投给
  **点位下面那个控件**：投给顶层窗口时 Chromium 认、**WinForms 等旧式应用不认**
  （实测：顶层窗体只触发自己的 MouseWheel，内容不滚；投给 `WindowFromPoint` 的叶子才滚）。
  不认时自动降级成移光标。Qt / Java / Electron 的自绘滚动容器**尚未逐个实测**。
- **剪贴板是全机独占资源**：别的程序正占着时截图复制会失败（实测报「所请求的剪贴板操作失败」）。
  助手会重试 4 次；仍失败时**客户端会明说"没复制成功"并留下诊断**，不会假装复制过。
- 「截图时隐藏 DSH 界面」靠**标题**找窗口（`DeepSeek Harness` 子串匹配）；窗口标题被改得
  面目全非时只会不藏（截图照常），不会报错。
- 私有备份仓：按 `.gitignore` 排除了 `node_modules`、运行时缓存、调试 dump 与备份文件；要复现运行请自行 `npm install`（如有依赖）。
- 文档中出现的 `$DSH_WORKSPACE`、`$TK_ROOT`、`%USERPROFILE%` 等是**占位符**，使用前需替换成本机实际路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方代码、字体、图标或数据的许可证需单独核对（见仓内说明）。
