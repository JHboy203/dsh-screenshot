// dev/hide-self-probe.mjs -- R30: does "hide DSH while capturing" really hide it, and put it back?
//
// The native overlay freezes the screen BEFORE its own window exists, so "hide self" cannot be a
// checkbox inside the overlay -- the helper has to hide the caller's window before CopyFromScreen.
// This probe drives that path end to end through the real service class:
//
//   1. DSH is visible and has a rect;
//   2. svc.overlay({hideSelf, hideTitle:'DeepSeek Harness'}) returns hidden:true;
//   3. DSH is visible again afterwards, is not minimized, and its geometry did not change
//      (a restore implemented with SW_SHOW instead of the current placement would silently
//      un-maximize it -- that is exactly the kind of damage this check exists to catch);
//   4. a title that matches nothing is NOT an error: the capture still succeeds, hidden:false;
//   5. the helper survives all of it.
//
// RUN IT FROM THE HOST (a low-integrity shell is silently refused by UIPI for ShowWindow):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/hide-self-probe.mjs'})
//
// ⚠️ It really does hide the DSH window for ~1.5s (the overlay covers the screen meanwhile).
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = path.join('D:\\信息库\\AI工作区', '.tmp-shot-lab', 'hide-self')

// Must be set BEFORE importing lib/overlay.mjs: OVERLAY_DIR is read at module load. A separate
// request dir also keeps this probe's helper from fighting the app's resident one for requests
// (the two-helper trap: whoever reads ovlreq-*.json first opens the window).
process.env.DSH_OVERLAY_DIR = path.join(LAB, 'overlay')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const { overlayPick, overlayStatus, startOverlayHost, stopOverlayHost } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'overlay.mjs')).href)
const { createShotService } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'service.mjs')).href)

class FakeRemote {
	constructor(ctx, name) {
		this.ctx = ctx
		this.name = name
	}
}
const svc = new (createShotService(FakeRemote))(null, {})

const results = []
function check(name, ok, extra) {
	results.push({ name, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`)
}

/** The DSH window as Windows sees it (visible windows only -- a hidden one disappears from here). */
async function dshWindow() {
	const list = await shot.listWindows({ exclude: '', limit: 80 })
	const wins = (list && list.windows) || []
	return wins.find((w) => /DeepSeek Harness/i.test(String(w.title))) ?? null
}

const before = await dshWindow()
check('DSH window is visible before the test', before !== null, before === null ? {} : { hwnd: before.hwnd, rect: [before.x, before.y, before.w, before.h] })

const PNG = path.join(LAB, 'freeze.png')
const FSHOT = path.join(LAB, 'form')

/* 预热助手（R35）。原来的第一枪直接吃 20s 超时，而冷启动的 powershell.exe + Add-Type 编译
 * 一旦慢到 20s 外，就会得到 `{"ok":false,"reason":"not-ready"}` —— 后面两枪反而都过，
 * 于是三条断言一起变红，看着像"hideSelf 坏了"，其实只是**助手还没起来**。
 * 判据必须是"助手 ready"，不能是一段猜出来的等待：先显式启一次并等 ready。 */
startOverlayHost()
let ready = false
for (let i = 0; i < 200 && !ready; i++) {
	await sleep(150)
	ready = overlayStatus().ready === true
}
check('overlay helper is ready before the first arm', ready, { status: overlayStatus() })

// 1. The real thing: hide DSH, freeze, put it back. selfTest drives the whole annotate path, so
// no mouse is needed and the overlay closes on its own.
const hidden = await svc.overlay(
	20,
	JSON.stringify({
		selfTest: true,
		png: PNG,
		formShot: FSHOT,
		hideSelf: true,
		hideTitle: 'DeepSeek Harness',
		labels: ['矩形', '箭头', '画笔', '马赛克', '序号', '文字', '椭圆', '颜色', '撤销'],
		hint: 'hide-self probe',
	})
)
check('overlay succeeded while hiding DSH', hidden.ok === true, { ok: hidden.ok, reason: hidden.reason, error: hidden.error })
check('the helper reports it really hid a window', hidden.hidden === true, { hidden: hidden.hidden })
check('capture still produced a crop', Number(hidden.w) === 320 && Number(hidden.h) === 240, { w: hidden.w, h: hidden.h })

// 2. It must be back -- visible, not minimized, and where it was.
await sleep(400)
const after = await dshWindow()
check('DSH window is visible again', after !== null, after === null ? 'still hidden' : { hwnd: after.hwnd })
check('DSH window was not minimized', after !== null && after.min !== true, { min: after && after.min })
check(
	'the restore kept its geometry (no un-maximize / move)',
	before !== null && after !== null && before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h,
	/* R65: 也报 hwnd。2026-10-26 的 full 聚合里这一条红过一次（before x=119 → after x=32，尺寸一模一样），
	 * 单跑两次都是绿的、窗口位置也已经是 32 —— 只有 hwnd 能区分"同一个窗口被挪了"和"这一读读到了另一个
	 * 同尺寸窗口"（本机桌面上确实同时存在多个 Chrome_WidgetWin_1）。加它不是诊断洁癖：
	 * 下次红的时候要能直接判，而不是重跑一遍看它变绿。 */
	before === null || after === null ? {} : { before: [before.x, before.y, before.w, before.h], after: [after.x, after.y, after.w, after.h], hwnd: [before.hwnd, after.hwnd] }
)

// 3. A title that matches nothing must not break the capture (hiding is a convenience).
const noMatch = await svc.overlay(20, JSON.stringify({ selfTest: true, hideSelf: true, hideTitle: 'DSH-NO-SUCH-WINDOW-9f3a' }))
check('unknown title: capture still works, hidden:false', noMatch.ok === true && noMatch.hidden === false, { ok: noMatch.ok, hidden: noMatch.hidden })

// 4. hideSelf without a title is a no-op too (the client always sends one, but the contract is
//    "no title -> do not hide").
const noTitle = await overlayPick({ timeoutSec: 20, selfTest: true, hideSelf: true })
check('no title: hidden:false (and no crash)', noTitle.ok === true && noTitle.hidden === false, { ok: noTitle.ok, hidden: noTitle.hidden })

// 5. The helper survives every arm.
check('helper alive after all arms', overlayStatus().alive === true, { alive: overlayStatus().alive })

try {
	stopOverlayHost()
} catch {}
await sleep(800)

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`hide-self: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
