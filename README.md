# dsh-screenshot · DSH 截图插件

[English](README.en.md)


QQ 同款截图，按钮挂在**对话输入框「语音」键旁边**（`conversation.input.left` 槽，order `-90`）。

## 能力

| 菜单项 | 说明 |
|---|---|
| ✂ 截图 | **一律在原生覆盖层里框选**（独立进程的全屏真窗口，能盖住别的应用）→ 标注 → **贴进输入框 + 复制到剪贴板** |
| ⏺ 录屏 | ffmpeg gdigrab 录制（H.264 + faststart）。**默认先框一块再录**（见下），屏幕上有一圈红框标出边界，右上角计时胶囊点「停止」收尾。菜单里可开**录音**（R41，默认关） |
| Aa 提取文字 | 框选后**离线 OCR**（Windows 自带引擎，不出本机），出可复制/可贴进输入框的文本面板 |
| 译 屏幕翻译 | OCR 之后把文字（带翻译指令前缀）贴进输入框，交给 DSH 自己的模型翻 |
| ⇕ 长截图 | 框选区域 → 宿主逐格滚轮、滚一格抓一张 → 重叠区对齐拼接（不重叠就报错，不猜） → 长图回到标注界面 |
| ☐ 截图时隐藏 DSH 界面 | 原生覆盖层在**冻结桌面之前**把 DSH 窗口藏起来（QQ 同款），框完/取消后还原并回到前台；默认关，在「更多设置」里勾 |

> **R33 起删掉了「范围 / 选一个窗口来截 / 自己框范围 / 抓窗方式」四项**，以及在 DSH 窗口里
> 渲染桌面截图的那套（canvas + DOM 覆盖层）。它只能盖住 DSH 自己的窗口、在 125% 缩放下
> 只能框到屏幕左上角一块 —— 留着它等于"看起来能用，框不到你要的东西"。现在唯一入口是原生
> 覆盖层；不可用时**明说**（"重启 DSH 一次"），不再偷偷换成降级界面。老的
> `range/method/pickHwnd/pickTitle/nativeOverlay` 设置由 `prefsVer` 迁移一次性清掉。

标注工具：矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克，八色 + 粗细滑杆，撤销重做（游标模型），
Enter 完成、Esc 取消、Ctrl+Z/Y、Ctrl+C、Ctrl+S、Ctrl+A 全选、双击全屏。
另有**贴图**（钉在界面上，拖动移动、Ctrl+滚轮缩放）。

工具条（R66 换的皮肤）：一张圆角卡片，九个**矢量图标 + 中文小标题**（矩/箭/笔/马赛克/序号/文字/椭圆/色/撤销），
激活项是实心底色药丸，鼠标悬停有浅色底；**快捷键提示行搬进卡片**里（以前是工具条下面一行浮空白字）；
分组用细分隔线分成「工具 | 颜色 | 撤销」。选区贴到屏幕底部时卡片自动翻到选区**上方**，不会盖住要截的内容。
尺寸角标和放大镜用的是同一套卡片语言（圆角 + 投影 + 描边 + 读数在卡内）。
工具条是**画出来的**（GDI+，无位图资产），所以任意 DPI 下都清晰、插件仍是一个纯文本 `.ps1`。

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

## 宿主工具（12 个）

| 工具 | 干什么 |
|---|---|
| `screenshot` / `screenshot_windows` | AI 自己抓图（不弹覆盖层、不抢前台、不动窗口），返回文件路径 |
| `shot_health` | **换会话第一条命令**：按"文件时间 vs 进程/实例时间"回答**要不要重启** |
| **`shot_reap`** | **录制残留体检（只读）+ 可选清理**（R52）：内存里在不在录、`rec/current.json` 记的是谁、pid 还活着吗、`rec/` 堆了几个 mp4；`apply:true` 才按三步判据清掉（活着 → 仍是 `ffmpeg.exe` → `taskkill`） |
| **`shot_owner`** | **"这一点归谁"**（R57）：对一串坐标（或一个矩形：中心+四角内缩 2px）做 `WindowFromPoint`，报 hwnd / 标题 / 类名 / 进程。与 `shot_pixels` 配对：**颜色说这里是我的、它说这里是别人 → 中间有屏幕抓得到但命中测试看不到的浮层**（click-through / layered） |
| `shot_gate` | 一条命令跑完闸门：默认「静态契约 + 覆盖层端到端」；**`full:true` = 交付前那一套**（再加一拍成本 + 探针聚合，约 2.5–5 分钟）；`host:true` 再加宿主全量（≈10 分钟，**不在 full 里**） |
| `shot_bridge` | 驱动**正在运行**的客户端（state / eval / click / menu / dome / longshot） |
| `shot_displays` | 显示器 / DPI / 负坐标体检 + 越界裁剪实测 |
| **`shot_pixels`** | **像素事实**（R34）：`rect` 现场抓或 `path` 读图 → 黑图判据（meanLuma/blackPct）、某颜色的像素数与**外接框**、与另一张图的**差异占比**（可限定 `region` 只看内部） |
| **`shot_probe`** | **一条命令跑任意 dev 探针**：`probe:"<名字>"` 单跑；`probe:"all"` **全跑聚合**（重活 `hosttest` 默认不跑、给了 `includeHeavy` 才跑且排最后）；`probe:"list"` 只列清单（不 spawn）。判据：超时 / **零检查**（退出码 0 但一行 PASS/FAIL 都没打印）/ 非零退出都**如实算失败**；**退出码 2 = env**（环境挡住，见下） |
| **`shot_preflight`** | **改完宿主半边、重启前**用磁盘上的代码验一遍（R40）：默认「探针库自检 + full 闸门」；可点名 `probe-selftest` / `gate-full` / `all-probes` / `hosttest`。判据按**结论行**翻，**没有结论行 = 失败**；每项独立子进程（脚本会 `process.exit`，不能 import） |
| **`shot_land`** | **收尾一步走**（R40）：自检 → `git add -A` → 提交（中文走 stdin）→ `push` → 回读 sha 确认。**默认 dryRun 只看计划**、自检红**不提交**、空标题拒绝。绕开"命令行 git 被沙箱拒 / 推送辅助漏推 / 中文编码"三个坑 |

> 这两个是**换会话时的交接面**：验证这个插件最费劲的不是写代码，是"怎么证明屏幕上真的发生了
> 什么"。前者把像素判据变成一次调用，后者把"必须在宿主里跑、各有各的参数"的门槛固化成一张表。

### 探针清单自动发现 + 全跑聚合（R35）、清单说清参数 + 并行实测（R36）

- **自动发现**：`dev/*-probe.mjs` 会被自动收进清单（不用改 `lib/probes.mjs`）。
  但它**默认不进 `all`** —— 实测 `dev/auto-wheel-probe.mjs` / `dev/postwheel-probe.mjs` 都**需要
  命令行参数**，无参跑只会得到无意义结果。发现 ≠ 知道怎么跑，所以：`probe:"list"` 里有、点名能跑、
  `includeAuto:true` 才进 `all`。已被显式表覆盖的脚本不会再登记（否则同一脚本会被跑两遍）。
- **`all` 的默认集合** = 显式表里非重活的 5 个（`recframe` / `wheel-target` / `hide-self` /
  `wheel-app-qt` / `wheel-app-java`），一轮 **约 3–5 分钟**（机器冷/忙时更久：夹具的 PowerShell
  和覆盖层助手冷启动都可能 >20 s）。
- **env 是第三态**：夹具被别的窗口盖住、窗口上不了屏 → 探针**退 2**，`shot_probe` 报
  `reason:"env"`，聚合里单独标 `ENV` 并给出处置话术。它既不算通过，也不算产品回归 ——
  混成一个红会把人往错的方向查（本轮实测：QQ / DSH 盖住夹具时 `wheel-target` 4 项全红，
  全是假红）。
- **env 在 `all` 里自动重试一次（R45）**：两轮 `shot_probe({probe:'all'})` 分别挂在**不同**探针上
  （一次 `wheel-target`、一次 `recframe`），单跑都 6/6 —— 探针自己用退出码 2 说"环境挡住"，
  那不是回归。所以全跑聚合里遇到 env 会等 2.5 s 重试一次，结果行标注
  `(env 重试后通过)` / `(env 重试后仍 env)`，`probes[].attempts` 如实记 2。
  **真红（exit 1 / 有 FAIL 行）永不重试**，**单跑（点名）也不重试** —— 重试真红会把回归藏起来，
  单跑是操作者要看这一次的真实结果。
- **`recframe` 的取景不再依赖桌面（R48 → R53）**：R35 写死右下角被 QQ 盖住、R48 改成"网格搜索
  被窗口盖得最少的位置 + 350 ms 静态度"、R49 再加"压在活窗口上且只改一部分就记 env" —— 三代都是
  **缓解**。2026-10-24 实测：DSH `1619×1029@150,0` + 设置 `1920×1020` + 资源管理器 `1268×759`
  之后，唯一的静态候选只剩 `(8,968)` 的 120×90；**同一份代码两次跑出 12/12 与 11/12**，
  full 闸门长期 3/4（红的是桌面，不是框）。现在把框压在**自己画的棋盘窗**
  （`dev/recframe-backdrop.ps1`：400×300、30 px 格、颜色与格子大小都已知）上，内部判据变成
  "那个屏幕坐标上还是不是预期颜色" —— 与时间、桌面状态、别人的动画**都无关**；
  env 三态那套随之删掉（背景不再会动，对不上就是真红）。探针 **12 → 16 项**。
  ⚠️ 同一条探针里还有一枚**同类的假红**：canary 的"画的是物理像素"断言原先把整张裁剪里的柠檬绿
  像素都算进外接框，而裁剪右半边压在 DSH 窗口上（DSH 从 x=150 起，canary 240 宽），
  DSH 界面偶发的绿点把 bbox 从 240×120 撑成 **240×126** → 读成"窗口被缩放 0.8"。
  现在只认**成片**的绿（连续 ≥60 px 的行），孤立的绿点不算证据；真的被缩放的窗口
  行宽是 192 px，照样抓得住。
- **参数写进头部（R36）**：探针认命令行参数就在头部加一行
  `// args: -Hwnd <句柄>（必填）` → `probe:"list"` 把「参数」与「依赖」（pyqt / JDK）分开列出，
  `all` 的"未跑"原因也带具体参数。没有这一行，清单只能告诉你它存在，不告诉你它怎么跑。
- **`all` 保持串行 —— 这是量过的结论，不是没做优化（R36）**：`dev/probe-concurrency.mjs`
  在同一批次里串行/并行各跑一遍：并行快 36%（101s → 65s），但 `wheel-app-qt` 从 **5 PASS 掉到
  2 PASS**。原因是两个夹具在**抢同一套真实光标与前台**，彼此成了对方的"环境"。
  要真正提速，得先让探针不再共享这些资源（每夹具自己的注入通道 / 独立虚拟桌面），那是另一个量级。

## 自检

**交付前就一条命令（R37）**：

```
shot_gate({full:true})        # 静态契约 + 覆盖层端到端 + 一拍成本 + 探针聚合（≈2.5–5 分钟）
shot_gate({full:true, host:true})   # 再加宿主全量（≈10 分钟）
```

改完宿主半边、**还没重启 DSH** 时（工具表是启动期读的），用同一个入口的宿主版：
`shot_preflight({})`（R40）—— 默认「探针库自检 + full 闸门」，也可以点名
`{what:'probe-selftest'}`（≈1.5 秒）/ `{what:'hosttest'}`（≈5–10 分钟）。

**收尾一步走**：`shot_land({message:'Rxx: …'})` 先看计划（默认 `dryRun`），
确认后 `{dryRun:false}` 才真的提交推送；自检红了它**不会**提交。

```bash
node .tools/dsh-shot-smoke.mjs          # 604 项：文件/清单/两端契约/覆盖层/接线/PowerShell 静态体检/宿主可加载
node .tools/dsh-shot-smoke.mjs --live   # 再加真抓屏 + 真 OCR（沙箱里会 SKIP，见坑 2）
```

宿主半边 + 真窗口的回归（**必须在宿主进程里跑**，沙箱里注入不了消息）：

```
host_selfcheck({plugin:'dsh-screenshot'})                                        # 全量，77 项 / FAIL 必须 0
host_selfcheck({plugin:'dsh-screenshot', script:'dev/all-probes-hostrun.mjs'})    # 真 runner 跑一遍聚合（改完 lib/probes.mjs、重启前用）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-target-probe.mjs'})    # 6 项：投递滚轮投给谁
host_selfcheck({plugin:'dsh-screenshot', script:'dev/hide-self-probe.mjs'})        # 11 项：真藏一次 + 还原 + 几何不变
```

> ⚠️ **"猜出来的等待"是本项目探针最大的假红来源**（R35 一次收口三条）：
> 覆盖层助手冷启动要 **~10 s**（实测 `readyMs:10205`）、录屏框的 canary 要等窗口自己写 Info、
> 滚轮夹具要抢到前台才不被 DSH 盖住。三处都改成**等测得的就绪信号**（`overlayStatus().ready` /
> `waitForFile(info)` / `AttachThreadInput` 后再 `SetForegroundWindow`），固定 sleep 一律不可靠。


`hide-self-probe` 会**真的把 DSH 窗口藏起来约 1.5 秒**（覆盖层正盖着屏幕，所以看不见），
用来验"藏"与"还原"两半；它同时证明还原**不会改动窗口的摆放**（用 `SW_RESTORE` 会悄悄把
最大化窗口变回普通大小）。

```
host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})         # 22 项：录屏框在屏幕上的像素级证据（R53 起压在已知棋盘窗上；R55 起自己找干净子区 + 直接问"边框那一点归谁"；**R65 起分得清"被别的窗口盖住"（env）和"我根本没画"（回归）**，并有一条**故意遮挡**的臂在验这个区分）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/record-audio-probe.mjs'})     # 45 项：录屏录音（设备枚举/真带 AAC 音轨/坏设备照录/自动选设备档位/坐标参数类型守卫/auto 与挑选结果一致/并发 start 串行 + service 回执 already/孤儿录制清理/recspawn 退路与它的孤儿保护），约 55 秒
host_selfcheck({plugin:'dsh-screenshot', script:'dev/record-integrity-probe.mjs'})  # 9 项：**录进文件的那块画面**（真录 2.5s → 抽帧 → 视频里 0 个红框像素、亮度差 ≤8%、两色都在），约 13 秒
host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-probe.mjs'})         # 81 项：**长截图成品**（编号亮度色带夹具 → auto / manual / **滚动条可见** / **3840px 长页面** / **区域里有动画** 五条真实臂 → 色带顺序 / 每条恰好一次 / 每条高度 / 内容结束位置；外加"两帧不重叠必须报错"的反向臂），166 秒
host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs',
                args:['measure','10','8']})                                        # 实验台：只量夹具几何（行高 / 带高 / 总高 / 一格位移 / 一帧一格要几帧），7 秒
host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs',
                args:['run','10','8','0','20']})                                   # 实验台：3840px 长页面跑一次 auto，回帧数/停因/成品高/色带 run/逐拍轨迹
host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs',
                args:['run','40','1','90','14']})                                  # 实验台：区域里有东西每 90ms 重画时跑一次 auto（R61 那个场景）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/_diag-longshot.mjs'})         # 排障用（不是探针、`dev/_*` 不入库）：跑一次会话并留下所有帧，逐对打印"真实位移 vs 拼接器报的偏移"
host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-selftest.mjs'})         # 43 项：像素库/探针库/清单元数据自检（1.5 秒，确定性）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/stitch-tex-probe.mjs'})       # 36 项：**拼接器在真实页面纹理上**（真截屏 → 造长页面 → 切已知帧 → 与真值逐像素比）：滚动 / 区域里有动画 / 同位置重复帧 / 跳太远 / **窄重叠（25%）** / **窄重叠且动画压在重叠带里**，约 35 秒（R63 起；R65 加后两条）。锁屏或屏幕上没有**互不相同**的纹理时**退 2**（env），不是回归
host_selfcheck({plugin:'dsh-screenshot', script:'dev/ocr-probe.mjs'})              # 29 项：**OCR 端到端**（node 渲染已知文字 → lib/shot.mjs#ocr()）：白底三行 / 深色主题 / 11px 降级 / 空白不报错 / 只认矩形内，约 17 秒（R63）
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','qt']})                                              # Qt 认不认投递滚轮
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-App','java']})                                            # Java(Swing) 认不认
host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs',
                args:['-Title','记事本']})                                        # 任何已开着的应用
```

## 客户端热重载留下的孤儿 DOM（R38）

客户端半边被热重载时，**旧模块已经不在了** —— 它 `appendChild` 到 `body` 的节点
（覆盖层根、调色板、录屏胶囊、面板、菜单、贴图）没人回收，攒几次就会"点不动 / 盖住"。
以前唯一的解法是刷新页面。

现在：每次加载生成一个**代次**，所有长期节点都经 `mountBody` 打上 `data-dshot-gen`，
**加载即清扫别的代次**（只认这个属性，官方 DOM 一个都不碰）。
`__dshotDebug` 里多了 `gen` / `swept` / `sweep()`，可以现场验：

```
shot_bridge({action:'send', ops:[{op:'eval', js:"(()=>{const o=document.createElement('div');o.id='dshot-stale-test';o.setAttribute('data-dshot-gen','g-old');document.body.appendChild(o);const n=window.__dshotDebug.sweep();return {swept:n,gone:document.getElementById('dshot-stale-test')===null,gen:window.__dshotDebug.gen}})()"}]})
```

判据：`swept >= 1` 且 `gone: true`。smoke 里还有一条**假 DOM 真跑**的行为测试
（上一代被清 / 本代保留 / 无标记不碰），所以这条逻辑不靠"字符串在不在"来保证。

**版本号只有一个真源（R39）**：`const CLIENT_BUILD = 'Rxx'`，桥注册与 `__dshotDebug` 都引用它，
`lib/health.mjs` 也优先读它。以前这个号在文件里有两处、`readClientBuild` 只读第一处 ——
只改一处时磁盘与运行中**一起自洽地错**（实测：代码已是 R38，回执还报 R33）。

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
   ⚠️ **"后创建"不等于"在最上面"（R54/R55 实测）**：框是 `WS_EX_NOACTIVATE`（绝不抢焦点），
   所以它永远不会成为前台窗口 —— 而一个**既是 TopMost、又是前台**的窗口会压住它，
   不论谁先创建。2026-10-24 实测：窗口存在、几何正确、也确实画了，屏幕上却一个红像素都没有。
   修法是 `SetWindowPos(HWND_TOPMOST, …)` 抬到 topmost 组的最上层，**并且每 250 ms 重抬一次**
   （一次不够：同一份代码能 16/16 也能 0/0/0/0，差别只有之后有没有人把自己抬上去）。
   ⚠️ 重抬**绝不能带 `SWP_SHOWWINDOW`**：对一个已经可见的窗口反复"显示"，Windows 每次都会重跑
   DWM transition —— 实测把被框住的那块画面整体压暗 **17%**（`216,222,233` → `179,184,193`），
   而那块正是**要录进视频**的区域。探针现在会同时判"边框在"与"内部 100% 还是原来的颜色"，
   这两个一起绿才算过。
4. **录完必须收掉框**：`record('stop')` 会先落停止信号再杀进程，残留一个红框比不画更糟。

**交付物是文件，所以要判文件（R56）**：上面 3 的证据全在**屏幕**上 —— 边框在矩形外、内部没变，
只能推出"应该没进视频"。`dev/record-integrity-probe.mjs` 把它落到文件：压一块已知棋盘 →
真录 2.5 s → 用结果面板那条 `recAction('frame')` 抽一帧 → 判那一帧的像素：

- 视频里**红框像素 = 0**（几何上"在矩形外"到底有没有 1 px 渗进来，只有这样才知道）；
- 亮度与被录内容相差 **≤8%**（R55 那个 17% 压暗在屏幕上看不出来，在文件里就是整段）；
- 两色都还在（H.264 有损，所以判"两色各占 30–70%"，不判逐像素相等）。

## 录屏录音（R41）

**菜单 → 更多设置 → 「录屏录音」**。默认关：录屏带麦是有隐私含义的开关，默认开等于在用户
不知情时录周围的声音。点开时先问宿主一次设备表 —— **没有麦就拒绝打开并说明**，
有麦就说出用的是哪一块（药丸上显示 `🎙 有声` / `静音`，结果面板显示 `有声` / `⚠ 无声（没录上）`）。

R41 之前这条功能是**两半各写一半的死代码**，而且两边都不报错：

| 半边 | 原来的写法 | 后果 |
|---|---|---|
| `client.js` | `record('start', {audio: false, …})` 写死 | 永远不请求声音 |
| `lib/shot.mjs` | `-i audio=virtual-audio-capturer` 写死 | 本机没装那块虚拟声卡，带声必失败 |

现在的链路：`listCaptureDevices()`（`ffmpeg -list_devices -f dshow`）→ `resolveAudioDevice()`
（按名字/ASCII 别名精确匹配；**空 want = 自动档位**：先麦克风（旁白），其次系统音
`立体声混音 / Stereo Mix / loopback`，都没有才拿第一块 audio 设备 —— 分档是为了**与系统列出的
先后无关**，旧写法"第一块命中大正则的"换台机器结论就变）→ `-i audio=<真实设备名>`
+ 显式 `-map 0:v:0 -map 1:a:0` + `-c:a aac`。

三条**不变量**（都由 `dev/record-audio-probe.mjs` 现场证明，33 项断言）：

1. **有麦就必须真有音轨**：`record('stop')` 的 `hasAudio` 来自 `rec.ps1 info` 的 ffprobe，
   不是"用户选了有声"；
2. **没麦/名字错了不许失败**：静音继续录，回执带 `audio:false` + `audioWarning` 原话，
   客户端必须念出来（静默降级最坏的结果是用户录完一整套才发现全程无声）；
3. **设备打不开（被独占/驱动抽风）退一次静音重试** —— 只有 `dshow|audio|device` 这类错才降级，
   区域越界之类的视频侧错误不许拿静音去掩盖。

> 设备枚举的判据**不是退出码**：`-list_devices` 没有正常输入，找不到东西时它也 exit 1，
> 唯一能信的是"解析出了设备"。另外 `(none)` 不是"没有设备"——本机 ffmpeg 用它标**视频**设备。

### `region` 只收字符串，传错了**必须报错**（R43）

`record('start', {region})` 的 `region` 只能是 `"x,y,w,h"`。以前 `lib/service.mjs` 写的是
`typeof parsed.region === 'string' ? parsed.region : ''` —— 传一个 `{x,y,w,h}` **对象**进来会被
**静默替成空**，于是"想录 64×64 的一小块"变成"录整屏 1920×1080"，而回执是 `ok:true` / `region:""`。
实测就是踩在这上面（一段端到端录音意外录了整屏）。

现在两道门都拒：`lib/service.mjs` 的 `record('start')` 与 `lib/shot.mjs` 的 `recordStart`
都返回 `ok:false` + `region 只接受 "x,y,w,h" 字符串（收到 object：{…}）`，且**不会**开始录制
（探针里有一条断言专门证明"没开录"）。理由与 `recordStart` 里"框了却算不出有效区域必须报错"
同一条：**把框选静默换成整屏，会录进用户根本没打算公开的桌面**。

同一个坑在**截图与 OCR** 里也有：`cap()` / `ocr()` 的 `rect` 以前也是 `typeof rect === 'string' ? rect : ''`。
它们现在共用同一条判据（`lib/service.mjs` 的 `coordTypeError`）—— 拒掉，并在错误里说清是哪个参数、
收到了什么类型。三处一起管，是因为"静默替空"在这三条路上意味着同一件事：**把整屏当成你要的那块**。

### 报出来的设备名由宿主算，界面不许猜（R44）

拨开「录屏录音」时那句 `录屏会录音，使用：…` 以前取自 `devices[0]` —— 那是**列表顺序**，
不是宿主的选择（R42 的自动档是"麦克风 > 系统音 > 第一块"）。两块设备时界面可能报 A、实际录 B。
现在 `record('devices')` 回执除 `devices[]` 还带 `auto` / `autoReason` / `autoWarning`
（宿主用 `resolveAudioDevice(list, '')` 算出来的），客户端优先念 `auto`；
**旧宿主**没有这个字段时才退回 `devices[0]`（降级也要能说话，不能因为字段缺就静默）。

### 并发 `start` 必须**串行**，不然会漏一个 ffmpeg（R47）

`recordStart` 的"已在录"判据在开头，而真正赋值 `recording` 要等 `ensureDirs()` → 设备枚举
（另起一个 ffmpeg）→ `sleep(600)` 探活。两次 `start` 落进这个窗口时，**两边都能通过判据**，
各起一个 ffmpeg；`recording` 被后赋值者覆盖，**先起的那个再也没人持有句柄** —— `stop` 停不到它，
它会一直 gdigrab 下去。修复前实测：两个 mp4（一个 2823 B 被 stop，一个 48 B 还在长），
磁盘与 CPU 就这么漏；两次回执还各报一个 path，调用方分不清哪段是"那段"。

现在的处理**不是把两次合并成一次**（那会把第二个调用方的 fps/region/audio 静默吞掉），而是让
第二个调用**等第一次收尾**，再走既有 `already:true` 分支 —— 回执带着实际在录的
region/width/height/audio/mic，调用方看得见"你要的"和"在录的"是不是一回事。互斥是一个
模块级 `starting` 承诺（`let starting = null` + 排队 while + `run.finally`），只包住
`startOnce`：**一次 `start`、一个 ffmpeg、一个文件**。探针里两臂现场证明（同一 path /
`already:true` / 只多一个 mp4）。

R48 补了一处**回执白名单**：`service.mjs` 以前不转发 `already`，活宿主上两次并发 `record('start')`
的回执都是 `already: undefined` —— 调用方只看到"两个 ok + 同一个 path"，分不清是"两次都成功"
还是"第二次被并进来了"。现在 `recFields` 有默认 `already:false`，start 分支带
`already: res.already === true`；探针再加一臂（service 级第二次 start → `already:true` + 同一 path）。

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

### 没在录时按"停止"不弹面板（R50）

`record('stop')` 是**幂等**的：没有在录时回 `ok:true` + `path:''`。客户端以前只看 `ok`，于是
连点两下停止（或上一段刚结束）会：拿空 path 去调 `clip` → 弹一句"录屏已结束，但没能放进剪贴板：
path required"；再打开一个 **path 为空的结果面板**，里面每条抽帧/剪辑都注定失败。
现在 stop 先判 `path === ''`：只说一句「当前没有在录屏（可能已经结束了）」，**不碰剪贴板、不开面板**。
（真机验过：面板数 0、toast 原文如上。）

### 宿主崩溃留下的孤儿录制，下次起录前清掉（R51）

`recording` 只在内存里。宿主被结束/重启时 `recordStop` 不会跑，而 **ffmpeg 不会跟着退出** ——
它会一直 gdigrab 写那个 mp4，没有句柄、没有界面入口，唯一痕迹是 `.cache/rec` 里一颗一直长胖的文件。

现在起录成功时把 `{pid, file, started, via}` 写到 `rec/current.json`，正常 stop 时删掉；
**下一次起录前**（以及"没有在录时点了停止"）先跑 `reapOrphanRecorder()`：

1. `tasklist` 查这个 pid 还活着吗（拿不到就退 `process.kill(pid,0)`）；
2. 那个 pid **现在还是 `ffmpeg.exe`** 吗 —— pid 会被系统复用，杀别人的进程比留着孤儿更糟；
3. 才 `taskkill /PID … /T /F`，并删掉状态文件。

回执里 `reapedPrev:true` 表示"上一段没收尾、已经被终止"。

**两条起进程的路都被保护（R54）**：`via:'node'` 直接起 ffmpeg，pid 就是 `child.pid`；沙箱里由
`ps/recspawn.ps1` 代起时 `child.pid` 是 PowerShell —— 所以脚本**自己**把真 ffmpeg 的 pid 写进一个
pid 文件（`-PidFile`，`{"pid":N}`），宿主读出来照常落 `current.json`，孤儿判据对两条路完全一致。
⚠️ 这条退路只在 node 的 `spawn` 撞上 `EPERM` 时才会走，而宿主进程从不被沙箱限制 —— 换句话说它
**在生产里执行不到**。为了不留下"看起来活着、其实从没跑过"的分支，加了测试缝
`DSH_SHOT_FORCE_RECSPAWN=1`（只有探针会设），`record-audio` 探针因此多出 4 条判据：真的走了
`recspawn`、状态里记的是**真 ffmpeg**、那个 pid 还活着且确实叫 `ffmpeg.exe`、停止后 mp4 可播且状态清掉。

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
- 长截图**一次滚一格滚轮，不是滚"一屏的 80%"**（R58 改的）。滚轮的 `delta` 单位是 1/120 格，
  应用再按自己的行高翻（WinForms 默认 3 行/格）：以前按像素发（520px 区域 → `-416`），
  被读成 3.5 格 ≈ 10 行，**一次滚掉 811px，比一屏还高** —— 两帧之间没有重叠，拼接器只能猜。
  现在按格发；一格的位移由目标应用决定。
- 但**一格能滚多远是应用决定的**：40pt 大字一帧 ≈ 237px，而 10pt 小字一帧只有 **60px**。于是
  "一帧固定一格"能覆盖的总高 = 帧数上限 × 一格 —— 后者在密集小字页面上只够 ~2900px，一张
  3840px 的页面会被**静默截掉一截**（R60 实测：40 帧停在 2880px，`stopReason` 还是空的，用户
  看到的就是一张"正常"的长图）。现在**每帧滚几格按实测位移自适应**（R60）：滚过一帧就知道一格
  值多少像素，把步长调到区域高度的 ~45%（上限 3 格，重叠仍剩一大半）；同一张 3840px 页面
  **18 帧**到底、每条色带 160px 一条不差。撞到帧数上限时 `stopReason='max-frames'`，
  客户端会明说"后面可能没截完"，不再说"已经到底了"。
- 拼接器**不接受"没有重叠的两帧"**：残差超过阈值就报错并保留会话（"滚得太多了，分两次滚"），
  **不会**再静默拼出一张又高又像真的错图（R58 用探针量到过 +479px 的静默重复内容）。
  只差几个像素的重复帧（光标闪烁、时钟跳秒）会被识别成"同一张画面"直接跳过，不再塞进一段重复内容。
- 拼接偏移在缩小图上粗搜之后，再做一次**全分辨率精修**：粗搜的量化误差是 ~4px/像素，
  以前每条接缝会因此偏 2px（重复/丢掉 2px 内容），现在缝落在像素上（探针断言每条色带 79px）。
- 长截图的区域**外缘**如果有会自己动的东西（滚动条拇指、缩放手柄、贴边浮层），那些列在帧间
  就不一致。拼接器现在**两遍（粗搜 + 精修）都先裁掉外缘**（宽度的 6%，至少 6px、至多 40px）再找
  重叠（R59），所以滚动条可见也能拼。实测：R58 的真实帧在未裁边时精修残差 **0.20–0.22**（左缘在闪
  的光标），裁边后 **0.00**，偏移不变；合成的"右侧 14px 滚动条 + 拇指每帧移动"四帧，偏移
  237/237/237 与真值一致（不裁边时同一组会挑错偏移）。
- 区域**内部**有东西自己动（视频、转圈、每帧重画的图表）时，**整块区域在帧间永远不一致**。拼接器
  先按普通残差找接缝；判成"没有重叠"时才走第二条路 —— 它看的不是"残差降下来了没有"，而是
  **分歧长在哪儿**：动画是一块紧凑区域，错的偏移是满屏字都对不齐（R63）。实测：一块 220×130 每帧
  重画时，真值处的普通残差是 **29.29**（远高于 8.00，任何残差都不可能接受它），而"分歧外接框"只占
  重叠的 **0.48**、框内 **49%** 像素超阈值；错偏移是 **1.00** / 27%。这条判据在**真实屏幕纹理**上
  也是对的（`dev/stitch-tex-probe.mjs`：四条臂的偏移逐帧精确，动画块之外的成品与真值**逐像素相同**）。
  ⚠️ R61 用的是"去掉最差 30% 的行"的评分，它在色带夹具上成立，但在真实纹理上会**偏向最窄的重叠**
  （真值 237 px，裁剪评分选 386 / 397 / 509，还静默多贴过 +160 px）—— 这是 R63 换掉它的原因。
- **窄到几行的重叠不算证据**（R63）：27 行真实文字能巧合地给出 **2.37** 的平均差，于是错了 256 px
  还"看起来像真的"。重叠不足区域高度 35% 时，只有**逐像素精确**（残差 ≤ 1.0）才作数 —— 色带夹具
  真的会一格滚掉 75%，它每次都精确到 0.00，所以这条不会误伤真截图。
- **窄重叠"精确"也可能落在错的偏移上**（R65，真实纹理上抓到的真 bug）：一页应用（一次滚一屏减一行，
  25% 重叠）某一对帧有两个**逐像素精确**的候选 —— 真值 390（130 行证据）与 477（43 行，因为页面上
  43 行内容自己重复了 87 px）。粗搜在 2.6:1 的缩小签名上偏好 477（43 行缩成 16 行签名全等，而 390
  落不到签名行上），旧规则又把它当"精确"接受 → 成品 4117 而不是 4030（**静默 +87 px**、243 523 个
  像素错）。现在窄重叠会**重判一次**：在这些候选里取**最深的最小值**，一样深时取**重叠最多**的
  （`py/stitch.py#find_exact_shift`）。实测同一条夹具 4117 → **4030 且逐像素相同**。
  另一半也是实测的：同一条臂上另一种错法（386，"只比真值差 4 px"）也被这条规则挡住 —— 它落在容差里
  但不是最深的最小值。
- **窄重叠 + 重叠带里有东西在动 = 诚实的拒绝**（R65）：重叠只剩 25%、而那块每帧重画的区域正好压在
  重叠带里时，这一带**没有任何可用证据**（真值处残差 37.98 > 8.00），结构判据又**故意**不看 35% 以下
  的重叠（R63：11 行文字满足过它，并挑了个错的 509 px）。所以它会报 `no-overlap`、退出 3、**不出文件**，
  而不是拼一张看起来对的图。自动滚的步长是区域高 45%，正常不会走到这里；真遇到就"分两次滚"。
- 同位置重复帧**仍然先判后拼**（"内容没前进、只有那一小块在变"）。顺序反了会把重复帧按猜出来的
  偏移贴进去 —— R63 实测：色带夹具 + 动画那条臂因此多出 **158 px** 重复内容。
- **已知边界**：在动的那块会在成品上留一道"重影"（每帧各贴了一次），这是拼接的必然结果；这种情况
  自动滚也认不出"到底"（整帧永远在变），会话会走到帧数上限并如实报 `max-frames`（"后面可能没截完"），
  但成品本身是完整的。
- 上面这几条现在有**真实纹理**上的独立探针（R63，R65 扩到六条臂）：`dev/texreplay.py` 拿一张真截屏
  造长页面、切出已知帧，六条臂分别断言"偏移逐帧精确 / 成品与真值逐像素相同（动画块那几列除外）/
  同位置帧跳过 / 跳太远必须报错 / 窄重叠也精确 / 窄重叠+动画必须拒绝"。它第一次跑就抓到两个真 bug
  （上面两条 ⚠️），R65 加窄重叠臂时**又抓到第三个**（上面那条 +87 px）。
- 改拼接器时先看 `texreplay.py landscape`（R64）：它把**每个评分的前几名**和**真值处的四个数**
  摆在一起（`python dev/texreplay.py landscape --dir <build 出来的目录> --pair <第几对>`）。R63 那四个
  bug 没有一个能从产品 JSON 里看出来 —— 每个评分都只报"一个数字"。实测（真实纹理、真值 237）：
  普通滚动时真值是唯一 0.00、结构判据在 486 个位移里**只认它一个**；动画页里真值处普通残差
  **29.33**（任何残差都不能接受），而按行裁剪与普通评分都会选到 **511**（最窄重叠），结构判据仍只认真值。
- 夹具（`dev/longshot-backdrop.ps1`）默认藏滚动条；`-Scrollbar 1` 保留它，探针的第四条臂就是
  用这个跑一遍 auto，证明上面那条不是纸面结论。
- **剪贴板是全机独占资源**：别的程序正占着时截图复制会失败（实测报「所请求的剪贴板操作失败」）。
  助手会重试 4 次；仍失败时**客户端会明说"没复制成功"并留下诊断**，不会假装复制过。
- 「截图时隐藏 DSH 界面」靠**标题**找窗口（`DeepSeek Harness` 子串匹配）；窗口标题被改得
  面目全非时只会不藏（截图照常），不会报错。
- 私有备份仓：按 `.gitignore` 排除了 `node_modules`、运行时缓存、调试 dump 与备份文件；要复现运行请自行 `npm install`（如有依赖）。
- 文档中出现的 `$DSH_WORKSPACE`、`$TK_ROOT`、`%USERPROFILE%` 等是**占位符**，使用前需替换成本机实际路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方代码、字体、图标或数据的许可证需单独核对（见仓内说明）。
