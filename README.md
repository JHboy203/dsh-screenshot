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
- **`recframe` 不再把取景压在活窗口上（R48）**：以前候选写死几个角落（右下角 1677,757）。
  DSH 最大化时整屏都是它，框透明会把它那一小条的光标/滚动同步透出来 → 内部"只 78.1% 未变"，
  看着像框改了画面。现在用 `shot.listWindows()` 枚举窗口矩形，**网格搜索被应用窗口盖得最少的位置**
  （桌面外壳 Progman/WorkerW/任务栏不算），再验 350 ms 静态度；另外加一条判据：取景压在应用窗口上、
  且内部只改了一部分（≥50% 未变）→ 记 **env**；**真把内部涂黑/画死会改掉几乎 100%**，仍然是 FAIL。
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
node .tools/dsh-shot-smoke.mjs          # 496 项：文件/清单/两端契约/覆盖层/接线/PowerShell 静态体检/宿主可加载
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
host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})         # 12 项：录屏框在屏幕上的像素级证据
host_selfcheck({plugin:'dsh-screenshot', script:'dev/record-audio-probe.mjs'})     # 33 项：录屏录音（设备枚举/真带 AAC 音轨/坏设备照录/自动选设备档位/坐标参数类型守卫/auto 与挑选结果一致/并发 start 串行 + service 回执 already），约 35 秒
host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-selftest.mjs'})         # 36 项：像素库/探针库/清单元数据自检（1.5 秒，确定性）
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
4. **录完必须收掉框**：`record('stop')` 会先落停止信号再杀进程，残留一个红框比不画更糟。

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
