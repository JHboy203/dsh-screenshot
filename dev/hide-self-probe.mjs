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
const { overlayPick, overlayStatus, stopOverlayHost } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'overlay.mjs')).href)
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
	before === null || after === null ? {} : { before: [before.x, before.y, before.w, before.h], after: [after.x, after.y, after.w, after.h] }
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
