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

import { startOverlayHost, overlayPick, overlayStatus, stopOverlayHost, OVERLAY_DIR, OVERLAY_SCRIPT } from '../lib/overlay.mjs'

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
