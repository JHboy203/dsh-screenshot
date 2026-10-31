/**
 * dev/ovl-selftest.mjs — 原生覆盖层（M1 框选 + M2 标注 + 贴图）的端到端自检。
 *
 * 为什么需要它：本机沙箱 shell 是 Low Mandatory Level，注入不了鼠标，
 * 所以「拖框 → 标注 → 渲染 → 剪贴板 / 落盘 / 贴图」这条链**没法靠人手驱动来验证**。
 * 助手的请求支持三个测试开关，全部由本脚本驱动：
 *
 *   selfTest   程序化设选区 + 画 7 个标注（矩形/箭头/画笔/马赛克/序号/文字/椭圆）+ 确认
 *   pinTest    走贴图分支，助手 1.5 秒后自己关窗 —— 验证贴图而不在屏幕上留东西
 *   formShot   用 Control.DrawToBitmap 把**整个覆盖层**渲染成 PNG（工具条 / 放大镜）
 *   regionOnly 只要矩形（长截图 / 提取文字 / 屏幕翻译的第一步）：不标注、不写剪贴板、不落盘
 *
 * formShot 的 `.select.png` / `.annotate.png` 是唯一能"看到"native 窗体的方式
 * （DOM 那边能截图，WinForms 窗体截不到），改 UI 之后务必肉眼读一次。
 *
 * 跑法（必须让它能写目标目录）：
 *   set DSH_OVERLAY_DIR=<some empty dir>
 *   node DSH-Plugin/dsh-screenshot/dev/ovl-selftest.mjs
 *
 * 不设 DSH_OVERLAY_DIR 时落在插件自己的 `.cache/overlay` —— 那要求由插件宿主来跑，
 * 低完整性 shell 写不进去（会看到 bitmap save 的 GDI+ 通用错误）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { startOverlayHost, overlayPick, overlayStatus, stopOverlayHost, pinFromFile, takePinHandoff, OVERLAY_DIR, OVERLAY_SCRIPT, PIN_HANDOFF_FILE, PIN_MAIL_DIR } from '../lib/overlay.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
let skipped = 0
function check(name, cond, extra) {
	const ok = cond === true
	if (!ok) failures += 1
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`)
	return ok
}
/**
 * 剪贴板是**全机独占**资源：别的程序占着时 `Clipboard::SetImage` 必然失败（R30 实测过
 * 一次持续几十秒的占用），那与本插件的正确性无关。这种情况下记 SKIP 而不是 FAIL ——
 * 假红比不检查更糟。但**前提是助手带回了原因**（clipError）：没原因才是产品 bug。
 */
function skip(name, why) {
	skipped += 1
	console.log(`SKIP  ${name}  ${why}`)
}
const clipboardBusy = (res) => res !== null && res !== undefined && res.clip !== true && String(res.clipError ?? '').length > 0

async function main() {
	console.log('OVERLAY_DIR = ' + OVERLAY_DIR)
	console.log('OVERLAY_SCRIPT = ' + OVERLAY_SCRIPT)

	// ── 闸门 0：.ps1 必须零非 ASCII 字节 ───────────────────────────────
	// PS 5.1 把无 BOM 的 UTF-8 当 GBK 解码，一句中文注释就会吞掉后面的代码行，
	// 报出来却是 "The Try statement is missing its Catch or Finally block"。
	// 这一条在本工程已经抓过三次，别删。
	try {
		const bytes = fs.readFileSync(OVERLAY_SCRIPT)
		let firstBad = -1
		for (let i = 0; i < bytes.length; i += 1) {
			if (bytes[i] > 0x7f) {
				firstBad = i
				break
			}
		}
		check('overlay_host.ps1 is ASCII only', firstBad < 0, firstBad < 0 ? undefined : { offset: firstBad })
	} catch (error) {
		check('overlay_host.ps1 readable', false, { error: String(error?.message ?? error) })
	}

	// ── 闸门 1：起进程 → ready 握手 ──────────────────────────────────
	const started = startOverlayHost()
	check('startOverlayHost ok', started.ok === true, started)
	let readyMs = -1
	const t0 = Date.now()
	for (let i = 0; i < 250; i += 1) {
		const st = overlayStatus()
		if (st.ready === true) {
			readyMs = Date.now() - t0
			break
		}
		if (!st.alive && i > 30) break
		await sleep(60)
	}
	check('helper ready', readyMs >= 0, { readyMs })

	// ── 闸门 2：真实路径的框选 + 标注 + 渲染 + 剪贴板 + 落盘 ─────────
	const png = path.join(OVERLAY_DIR, 'selftest.png')
	try { fs.unlinkSync(png) } catch {}
	const res = await overlayPick({
		timeoutSec: 20,
		dim: 55,
		png,
		selfTest: true,
		formShot: path.join(OVERLAY_DIR, 'form'),
		labels: ['矩形', '箭头', '画笔', '马赛克', '序号', '文字', '椭圆', '颜色', '撤销'],
		hint: 'Enter 复制    P 贴图    Esc 后退    Ctrl+Z 撤销    X 线宽    C 颜色',
	})
	console.log('pick -> ' + JSON.stringify(res))

	check('ok', res.ok === true, { ok: res.ok, reason: res.reason, error: res.error })
	check('size 320x240', Number(res.w) === 320 && Number(res.h) === 240, { w: res.w, h: res.h })
	check('origin 200,150', Number(res.x) === 200 && Number(res.y) === 150, { x: res.x, y: res.y })
	check('seven shapes rendered', Number(res.shapes) === 7, { shapes: res.shapes })
	if (clipboardBusy(res)) skip('clipboard took it', 'another program holds the clipboard: ' + res.clipError)
	else check('clipboard took it', res.clip === true, { clip: res.clip, clipError: res.clipError })
	check('labels reached the form', Number(res.labelsCount) === 9, { labelsCount: res.labelsCount })

	// R66：卡片"翻到选区上方"这条**规则**现在有数字断言（.flip 那张图是给人看的，判绿要有数）。
	// 判据来自窗体自己报的 ToolbarRect：卡片底边不越过选区顶边，且整张卡片还在屏幕内。
	{
		const fb = res.flipBar || {}
		const bar = res.barSize || {}
		const screenH = Number(res.screenH) || 1080
		check('flip: the card sits entirely ABOVE a bottom selection', res.flipAbove === true, { flipAbove: res.flipAbove, flipBar: fb })
		check('flip: the card stayed on screen', Number(fb.y) >= 0 && Number(fb.y) + Number(fb.h) <= screenH, { y: fb.y, h: fb.h, screenH })
		check('R66 card is the skinned size (3 rows tall, not the old 26 px strip)', Number(bar.w) > 300 && Number(bar.h) >= 60 && Number(bar.h) <= 120, { bar })
	}

	if (fs.existsSync(png)) {
		// 确定性校验，别用"文件够不够大"这种启发式：底色单一的区域压出来只有 4-5KB 是正常的。
		const buf = fs.readFileSync(png)
		const sigOk = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
		check('selftest png is a valid 320x240 PNG', sigOk && buf.readUInt32BE(16) === 320 && buf.readUInt32BE(20) === 240, { bytes: buf.length })
	} else {
		check('selftest png written', false)
	}

	// 整屏渲染：唯一能"看到" native 窗体的证据
	for (const suffix of ['.select.png', '.annotate.png']) {
		const p = path.join(OVERLAY_DIR, 'form' + suffix)
		check('form shot ' + suffix, fs.existsSync(p) && fs.statSync(p).size > 50000, { exists: fs.existsSync(p) })
	}
	// R66：工具条从 624x26 变成 458x82，另外两种摆位也必须**画出来**才可信 ——
	//   .flip  选区贴着屏幕底部时，卡片必须翻到选区**上方**（否则盖住要截的内容）
	//   （同一次 dump 里还带一个 hover 态按钮：CSS 免费给的东西这里得自己画）
	{
		const pf = path.join(OVERLAY_DIR, 'form.flip.png')
		const exists = fs.existsSync(pf)
		check('form shot .flip.png (card above a bottom selection, one button hovered)', exists && fs.statSync(pf).size > 50000, { exists })
	}

	// ── 闸门 2b：regionOnly —— 只要矩形，不标注 / 不复制 / 不落盘 ─────
	// 长截图 / 提取文字 / 屏幕翻译的第一步都是这个：框一块屏幕区域，然后自己抓那一块。
	// 三条判据缺一不可：
	//   ① 矩形对（否则长截图抓错地方、OCR 认错字）；
	//   ② **剪贴板没被写**（用户可能正复制着别的东西，框一下就被顶掉是不可接受的）；
	//   ③ **没有 PNG 落盘** —— 这里故意给一个 png 路径，验的是"助手在 region-only 下
	//      根本不理它"，比"没给路径所以没写"强得多。
	const regionPng = path.join(OVERLAY_DIR, 'region-should-not-exist.png')
	try { fs.unlinkSync(regionPng) } catch {}
	const region = await overlayPick({
		timeoutSec: 20,
		dim: 55,
		selfTest: true,
		regionOnly: true,
		png: regionPng,
		formShot: path.join(OVERLAY_DIR, 'form-region'),
	})
	console.log('region -> ' + JSON.stringify({ ok: region.ok, reason: region.reason, x: region.x, y: region.y, w: region.w, h: region.h, clip: region.clip, png: region.png, shapes: region.shapes, regionOnly: region.regionOnly }))
	check('regionOnly ok + reason region', region.ok === true && region.reason === 'region', { reason: region.reason })
	check('regionOnly flagged', region.regionOnly === true, { regionOnly: region.regionOnly })
	check('regionOnly rect 320x240 @ 200,150', Number(region.w) === 320 && Number(region.h) === 240 && Number(region.x) === 200 && Number(region.y) === 150, { x: region.x, y: region.y, w: region.w, h: region.h })
	check('regionOnly wrote no clipboard', region.clip === false, { clip: region.clip })
	check('regionOnly wrote no png', (region.png === '' || region.png === undefined) && !fs.existsSync(regionPng), { png: region.png })
	check('regionOnly drew no shapes', Number(region.shapes) === 0, { shapes: region.shapes })
	// 选区阶段的整屏渲染：region-only 下这是唯一能"看到"这个模式的方式（没有工具条）。
	check('region form shot', fs.existsSync(path.join(OVERLAY_DIR, 'form-region.select.png')), {})

	// ── 闸门 2c：**从服务类进** ────────────────────────────────────────
	// 客户端真正调到的是 service.overlay，不是 overlayPick。少了这一层，
	// "助手单独跑得动"和"服务类把 regionOnly 传下去了"就是两件事 ——
	// 而这轮改动最容易漏的恰恰是中间那一层的透传（漏了表现为助手照常进标注阶段、
	// 用户白等 20 秒，且没有任何报错）。
	const { createShotService } = await import('../lib/service.mjs')
	class FakeRemote {
		constructor(ctx, name) {
			this.ctx = ctx
			this.name = name
		}
	}
	const svc = new (createShotService(FakeRemote))(null, {})
	const svcRegion = await svc.overlay(20, JSON.stringify({ regionOnly: true, selfTest: true, png: regionPng }))
	check('service.overlay 透传 regionOnly', svcRegion.ok === true && svcRegion.regionOnly === true, { ok: svcRegion.ok, regionOnly: svcRegion.regionOnly, reason: svcRegion.reason })
	check('service.overlay 的 regionOnly 也不落盘', (svcRegion.png === '' || svcRegion.png === undefined) && !fs.existsSync(regionPng), { png: svcRegion.png })
	const svcPick = await svc.overlay(20, JSON.stringify({ selfTest: true, png: path.join(OVERLAY_DIR, 'svc-pick.png') }))
	check('service.overlay 不带 regionOnly 时仍是标注模式', svcPick.ok === true && svcPick.regionOnly === false, { ok: svcPick.ok, regionOnly: svcPick.regionOnly })
	if (clipboardBusy(svcPick)) skip('service.overlay 也复制到剪贴板', 'clipboard busy: ' + svcPick.clipError)
	else check('service.overlay 也复制到剪贴板', svcPick.clip === true, { clip: svcPick.clip })

	// ── 闸门 2d：hideSelf 的透传（R30）────────────────────────────────
	// 「截图时隐藏 DSH 界面」这个开关要跨三层：client → service.overlay → overlayPick →
	// 助手的请求文件。少透任何一层，表现都是"勾了没反应"，而且**零报错**。
	// 这里用**不存在的标题**验两件事：① 字段真的走到了助手；② 标题匹配不到不算失败 ——
	// 截图必须照常成功（hidden:false），隐藏只是便利。
	// 真把 DSH 藏起来的验收在 dev/hide-self-probe.mjs（宿主进程里跑，会短暂藏一下窗口）。
	const svcHide = await svc.overlay(
		20,
		JSON.stringify({ selfTest: true, png: path.join(OVERLAY_DIR, 'svc-hide.png'), hideSelf: true, hideTitle: 'DSH-NO-SUCH-WINDOW-9f3a' })
	)
	check('service.overlay 透传 hideSelf（标题不存在也不失败）', svcHide.ok === true && svcHide.hidden === false, { ok: svcHide.ok, hidden: svcHide.hidden, reason: svcHide.reason })
	// 没给标题 = 什么都不藏（协议里的默认语义；客户端总是带标题，但助手不能因此崩）。
	const noTitle = await overlayPick({ timeoutSec: 20, selfTest: true, hideSelf: true })
	check('hideSelf 没给标题时什么都不藏', noTitle.ok === true && noTitle.hidden === false, { ok: noTitle.ok, hidden: noTitle.hidden })

	// ── 闸门 3：落盘兜底（首选目录写不进去时必须接住）────────────────
	const fallback = path.join(OVERLAY_DIR, 'fallback-test.png')
	try { fs.unlinkSync(fallback) } catch {}
	const auto = await overlayPick({ timeoutSec: 20, dim: 55, selfTest: true, png: 'Z:\\definitely-not-writable\\x.png', pngFallback: fallback })
	console.log('fallback -> ' + JSON.stringify({ ok: auto.ok, png: auto.png }))
	check('fallback path took over', typeof auto.png === 'string' && auto.png.indexOf('fallback-test.png') >= 0 && fs.existsSync(auto.png), { png: auto.png })

	// ── 闸门 4：贴图分支（不复制、不落盘，助手自己关窗）──────────────
	const pin = await overlayPick({ timeoutSec: 20, dim: 55, selfTest: true, pinTest: true })
	console.log('pin -> ' + JSON.stringify({ ok: pin.ok, pinned: pin.pinned, reason: pin.reason }))
	check('pin branch works', pin.ok === true && pin.reason === 'pinned' && Number(pin.w) === 320, { reason: pin.reason, w: pin.w })
	check('pin wrote no file', pin.png === '' || pin.png === undefined, { png: pin.png })
	await sleep(2500)

	// ── 闸门 4b：贴图窗能缩放 / 菜单是中文 / 「送进输入框」的交接真的写出来了（R67）
	//
	// 用户原话：「贴图做不到缩放，也不能落到对话框内」。沙箱里没人能点最上层的窗，
	// 所以这三件事必须由窗体自己报数字：
	//   ① 缩放：DebugZoom(1.5) 之后宽高都变大、**宽高比不变**、百分比报 150；
	//   ② 菜单：七项中文能不能穿过「.ps1 零非 ASCII」这道门（中文只能走请求 JSON）；
	//   ③ 交接：PNG + pinout.json 真的落进了信箱，而且宿主能取走（取一次即删）。
	// 这三条任意一条坏了，用户在界面上看到的就是"点了没反应"。
	const pinMenu = ['送进输入框', '复制图像', '保存为文件', '放大', '缩小', '原始大小', '关闭']
	const pinToast = ['已送出，正在贴进输入框', '送出失败', '已保存', '保存失败', '已复制到剪贴板', '复制失败', '界面没来取（重启 DSH 后可用）']
	const pinShot = path.join(OVERLAY_DIR, 'pin.png')
	try { fs.rmSync(PIN_MAIL_DIR, { recursive: true, force: true }) } catch {}
	try { fs.unlinkSync(PIN_HANDOFF_FILE) } catch {}
	const probe = await overlayPick({
		timeoutSec: 20,
		dim: 55,
		// 保存目标故意放在这轮目录里（产品的默认值是 ~/Pictures/DSH截图，这里不碰用户目录）
		png: path.join(OVERLAY_DIR, 'pin-save.png'),
		selfTest: true,
		pinTest: true,
		pinProbe: true,
		pinShot,
		pinMenu,
		pinToast,
	})
	const pz = probe.pinZoom || {}
	console.log('pin probe -> ' + JSON.stringify({ pinned: probe.pinned, zoom: pz, menu: probe.pinMenu, handoff: probe.pinHandoff && { file: probe.pinHandoff.file, bytes: probe.pinHandoff.bytes } }))
	check('pin probe ran (pinned)', probe.ok === true && probe.pinned === true, { ok: probe.ok, pinned: probe.pinned, reason: probe.reason })
	check('pin scales up 1.5x', Number(pz.w1) > Number(pz.w0) && Number(pz.h1) > Number(pz.h0), { w0: pz.w0, w1: pz.w1, h0: pz.h0, h1: pz.h1 })
	check('pin reports 150%', Number(pz.pct) === 150, { pct: pz.pct, w0: pz.w0, w1: pz.w1 })
	{
		// 宽高比必须守住：100%/150% 两档的比例差应当 < 1%（整数取整允许差 1px）
		const a0 = Number(pz.w0) / Number(pz.h0)
		const a1 = Number(pz.w1) / Number(pz.h1)
		const drift = Math.abs(a1 - a0) / a0
		check('pin keeps the aspect ratio', Number.isFinite(a1) && drift < 0.01, { aspect0: a0, aspect1: a1, drift })
		check('pin scaled from the captured pixels', Number(pz.w0) === 320 && Number(pz.h0) === 240 && Number(pz.srcW) === 320 && Number(pz.srcH) === 240, pz)
	}
	check('pin menu captions survived the ASCII-only .ps1', probe.pinMenu === pinMenu.join('|'), { got: probe.pinMenu })
	// R67b：右键菜单必须**能开两次**。第一版每次右键新建一个 ContextMenuStrip、在自己
	// 的 Closed 里 Dispose —— 第二次 Show 就 "Cannot access a disposed object"，而在真机上
	// 那是 .NET 的**模态**错误框，会把助手的消息泵堵死（之后每次截图都超时）。
	check('pin menu opens twice (no disposed-strip crash)', probe.pinMenuCycle === '', { got: probe.pinMenuCycle })
	// 「没人来取」这条诚实分支：宿主没在轮询时必须说清楚，而不是永远显示"已送出"。
	// 这里信箱里的标记确实没人取走（探针进程不轮询），所以它必须报第 7 条文案。
	check('pin says nobody took it when the host is not polling', probe.pinSendWarn === pinToast[6], { got: probe.pinSendWarn, want: pinToast[6] })
	{
		// R67c：Ctrl+拖动（把贴图拖进对话框/别的应用）。拖拽本身要鼠标，但"能拖"这件事的
		// 一半是可验的：图真的落盘了、而且 DataObject 里确实是一个 FileDrop。
		const df = probe.pinDragFile || {}
		const dfPath = String(df.png || '')
		let ok = false
		let dims = { w: 0, h: 0 }
		if (dfPath.length > 0 && fs.existsSync(dfPath)) {
			const buf = fs.readFileSync(dfPath)
			ok = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
			dims = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
		}
		check('pin drag prep writes a real png for FileDrop', dfPath.length > 0 && ok && Number(df.bytes) > 500, { png: dfPath, bytes: df.bytes })
		check('pin drag file keeps the pinned size', Number(dims.w) === 320 && Number(dims.h) === 240, dims)
	}
	{
		const hp = (probe.pinHandoff && probe.pinHandoff.png) || ''
		const bytes = Number(probe.pinHandoff && probe.pinHandoff.bytes) || 0
		check('pin handoff png written', hp.length > 0 && fs.existsSync(hp) && bytes > 500, { png: hp, bytes })
		check('pin handoff json written', fs.existsSync(PIN_HANDOFF_FILE), { file: PIN_HANDOFF_FILE })
		check('pin shot rendered (visual evidence)', fs.existsSync(pinShot) && fs.statSync(pinShot).size > 5000, { file: pinShot, size: fs.existsSync(pinShot) ? fs.statSync(pinShot).size : 0 })
	}
	{
		// 宿主那一半的取件：一次取走、变成 dataUrl、文件被消费掉
		const got = takePinHandoff()
		check('takePinHandoff took the picture', got !== null && got.ok === true && String(got.dataUrl).startsWith('data:image/png;base64,') && got.w === 320 && got.h === 240, got === null ? { got } : { ok: got.ok, w: got.w, h: got.h, bytes: got.bytes, error: got.error })
		check('takePinHandoff consumed the marker', !fs.existsSync(PIN_HANDOFF_FILE), { file: PIN_HANDOFF_FILE })
		check('takePinHandoff is one-shot', takePinHandoff() === null)
	}
	{
		// 拒绝外面指进来的路径：这一条防的是"信箱里出现一份能读任意文件的 JSON"
		fs.mkdirSync(PIN_MAIL_DIR, { recursive: true })
		fs.writeFileSync(PIN_HANDOFF_FILE, JSON.stringify({ ok: true, png: path.join(OVERLAY_DIR, 'selftest.png'), name: 'evil.png', w: 1, h: 1 }), 'utf8')
		const bad = takePinHandoff()
		check('takePinHandoff refuses paths outside the mail dir', bad !== null && bad.ok === false, bad === null ? { bad } : { ok: bad.ok, error: bad.error })
	}
	await sleep(1600)

	// ── 闸门 4c：服务类把贴图菜单与探针参数透下去了（R67）──────────
	// 这一层最容易漏（少透一个字段 = 助手用英文兜底、用户看到英文菜单，且零报错）。
	{
		const { createShotService } = await import('../lib/service.mjs')
		class FakeRemote2 {
			constructor(ctx, name) {
				this.ctx = ctx
				this.name = name
			}
		}
		const svc2 = new (createShotService(FakeRemote2))(null, {})
		const svcPin = await svc2.overlay(20, JSON.stringify({
			selfTest: true,
			pinTest: true,
			pinProbe: true,
			png: path.join(OVERLAY_DIR, 'pin-svc.png'),
			pinMenu,
			pinToast,
		}))
		check('service.overlay 透传 pinMenu/pinToast 且缩放到 150%', svcPin.ok === true && svcPin.pinPercent === 150 && svcPin.pinMenu === pinMenu.join('|'), { ok: svcPin.ok, pct: svcPin.pinPercent, menu: svcPin.pinMenu })
		check('service.overlay 透传后交接文件仍有字节', svcPin.pinHandoffBytes > 500, { bytes: svcPin.pinHandoffBytes })
		// 取走这一份，别把信箱留给下一次心跳
		takePinHandoff()
	}
	await sleep(1600)

	// ── 闸门 4d：贴一张**已有的文件**（R67c：长截图 / 录屏抽帧现在也走同一个贴图窗）──
	//
	// 以前那两条路用的是页面里的 DOM 贴图（另一套缩放、另一套动作条），同一个"贴图"两种手感。
	// 现在客户端只交一个 PNG：`pinFromFile` → 助手开同一个 DshPinForm。这里验三件：
	//   ① 文件能钉上（reason='pin-file'，尺寸来自图片本身）；
	//   ② 不存在的文件**明确失败**，不是静默什么都不发生；
	//   ③ 服务类的 `pin(dataUrl)` 走完整条链（dataUrl → 落盘 → 贴图）。
	{
		const src = path.join(OVERLAY_DIR, 'selftest.png')
		const filePin = await pinFromFile(src, { pinTest: true, pinMenu, pinToast })
		console.log('pin file -> ' + JSON.stringify({ ok: filePin.ok, reason: filePin.reason, w: filePin.w, h: filePin.h, pinW: filePin.pinW, pct: filePin.pinPercent }))
		check('pinFromFile pins an existing png', filePin.ok === true && filePin.pinned === true && filePin.reason === 'pin-file', { ok: filePin.ok, reason: filePin.reason, error: filePin.error })
		check('pinFromFile keeps the picture size (320x240 at 100%)', Number(filePin.w) === 320 && Number(filePin.h) === 240 && Number(filePin.pinW) === 320 && Number(filePin.pinPercent) === 100, { w: filePin.w, h: filePin.h, pinW: filePin.pinW, pct: filePin.pinPercent })
		const missing = await pinFromFile(path.join(OVERLAY_DIR, 'no-such-picture-9f3a.png'), { pinTest: true })
		check('pinFromFile says WHY a missing file failed', missing.ok !== true && missing.reason === 'pin-file-failed' && String(missing.error).length > 0, { reason: missing.reason, error: missing.error })
		await sleep(1800)
	}
	{
		const { createShotService } = await import('../lib/service.mjs')
		class FakeRemote3 {
			constructor(ctx, name) {
				this.ctx = ctx
				this.name = name
			}
		}
		const svc3 = new (createShotService(FakeRemote3))(null, {})
		const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
		const svcPin = await svc3.pin(png1x1, JSON.stringify({ pinMenu, pinToast }))
		check('service.pin takes a dataUrl end to end', svcPin.ok === true && svcPin.pinned === true && svcPin.reason === 'pin-file', { ok: svcPin.ok, reason: svcPin.reason, error: svcPin.error })
		const bad = await svc3.pin('not-a-data-url', '{}')
		check('service.pin rejects a non-png payload', bad.ok === false && bad.reason === 'bad-image', { reason: bad.reason, error: bad.error })
		await sleep(1800)
	}

	// ── 闸门 5：一次失败不许把助手带死 ──────────────────────────────
	check('helper alive after all picks', overlayStatus().alive === true, { alive: overlayStatus().alive })

	stopOverlayHost()
	await sleep(1200)
	check('helper stopped cleanly', overlayStatus().alive === false)

	console.log('----')
	console.log(failures === 0 ? 'ALL PASS' + (skipped > 0 ? ` (${skipped} skipped: clipboard busy)` : '') : `${failures} FAILURE(S)`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('CRASH ' + (error?.stack ?? error))
	process.exit(2)
})
