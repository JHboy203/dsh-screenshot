/* dev/longshot-lab.mjs -- the long-capture LAB: geometry, one auto session, and the picture's runs.
 *
 * Why this file exists: R59-R61 needed the same three throwaway scripts over and over (measure the
 * fixture's geometry; run one auto session on a tall page; run one on a page with something
 * animating inside). They lived in gitignored dev/_*.mjs and would have been rewritten by the next
 * session. They are merged here, committed, and documented in README.
 *
 * Run it from the HOST (a low-integrity sandbox shell cannot create an interactive window):
 *
 *   host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs', args:['measure','10','8']})
 *   host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs', args:['run','10','8','0','20']})
 *   host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-lab.mjs', args:['run','40','1','90','14']})
 *
 *   args: ['measure', fontPt, rows]        -> geometry only (no session)
 *         ['run', fontPt, rows, animateMs, maxFrames]  -> one auto session + runs summary
 *
 * Everything lands under .cache/longshot-lab/. The stitched PNG is deleted unless `keep` is the
 * 6th arg; the fixture's own log and Info file are kept when `keep` is given (that is the point of
 * a lab).
 *
 * ASCII only: the host console is GBK, and Chinese output from a child process is unreadable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const LAB = path.join(PLUGIN, '.cache', 'longshot-lab')
const INFO = path.join(LAB, 'info.json')
const FLOG = path.join(LAB, 'fx.log')
const CONTROL = path.join(LAB, 'fx.ctl')
const ERRLOG = path.join(LAB, 'fx.err')
const FX = 560
const FY = 120
const FW = 660
const FH = 520
const SECONDS = 240

fs.mkdirSync(LAB, { recursive: true })
// Keep every frame and the stitched picture out of the user's real screenshot folder.
process.env.DSH_SHOT_CACHE = path.join(LAB, 'cache')

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const scroll = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'scrollsession.mjs')).href)
const pixels = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'pixels.mjs')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cmd = String(process.argv[2] ?? 'measure').toLowerCase()
const fontPt = Number(process.argv[3] ?? 40)
const rows = Number(process.argv[4] ?? 1)
const animate = Number(process.argv[5] ?? 0)
const maxFrames = Number(process.argv[6] ?? 20)
const keep = String(process.argv[7] ?? '') === 'keep'

let child = null
let errFd = -1

function startFixture(opts = {}) {
	for (const p of [INFO, FLOG, CONTROL]) {
		try { fs.rmSync(p, { force: true }) } catch {}
	}
	errFd = fs.openSync(ERRLOG, 'w')
	child = spawn(
		shot.findPowershell(),
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(PLUGIN, 'dev', 'longshot-backdrop.ps1'),
			'-X', String(FX), '-Y', String(FY), '-W', String(FW), '-H', String(FH),
			'-Bands', String(opts.bands ?? 24), '-FontPt', String(opts.fontPt ?? 40),
			'-Rows', String(opts.rows ?? 1), '-Animate', String(opts.animate ?? 0),
			'-Seconds', String(SECONDS),
			'-Log', FLOG, '-Info', INFO, '-Control', CONTROL],
		{ windowsHide: false, stdio: ['ignore', errFd, errFd] }
	)
}

async function waitInfo(ms) {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		try {
			const j = JSON.parse(fs.readFileSync(INFO, 'utf8'))
			if (j && j.ok === true) return j
		} catch {}
		if (child !== null && child.exitCode !== null) return null
		await sleep(150)
	}
	return null
}

function stopFixture() {
	try { child?.kill() } catch {}
	try { if (errFd >= 0) fs.closeSync(errFd) } catch {}
	errFd = -1
}

function geometry(info) {
	const lineH = Number(info.lineH)
	const bandH = Number(info.bands?.[0]?.h ?? lineH)
	const totalH = Number(info.totalH)
	const notchPx = 3 * lineH
	return {
		fontPt: Number(info.fontPt ?? fontPt),
		rows: Number(info.rows ?? rows),
		animate: Number(info.animate ?? 0),
		lineH,
		bandH,
		totalH,
		regionH: FH,
		notchPx,
		framesAtOneNotch: Math.ceil(Math.max(0, totalH - FH) / Math.max(1, notchPx)) + 1,
		maxFrames,
	}
}

/* Fold a stitched picture into runs along the probe's sample column (0.62 W). Every band is a
 * solid colour there, so a correct stitch is `bands` runs of exactly `bandH`. */
function runsOf(img) {
	const col = Math.round(img.width * 0.62)
	const luma = (y) => {
		const i = (y * img.width + col) * 4
		return img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114
	}
	const runs = []
	let start = 0
	for (let y = 1; y < img.height; y++) {
		if (Math.abs(luma(y) - luma(start)) > 4) {
			runs.push(y - start)
			start = y
		}
	}
	runs.push(img.height - start)
	return { n: runs.length, min: Math.min(...runs), max: Math.max(...runs) }
}

try {
	startFixture({ fontPt, rows, animate })
	const info = await waitInfo(20000)
	if (info === null) {
		console.log('FAIL: no Info file from the fixture (see ' + ERRLOG + ')')
		stopFixture()
		process.exit(1)
	}
	const geo = geometry(info)

	// The probe aborts (env 2) when something covers the region; this lab reports it instead of
	// pretending the session result is about the product.
	const hit = await shot.hitTest(Math.round(info.x + info.w / 2), Math.round(info.y + info.h / 2))
	const mine = Number(hit.hwnd) === Number(info.hwnd)
	if (!mine) {
		console.log('WARN: the fixture is NOT the window under the region centre (hit=' + hit.hwnd +
			" '" + (hit.title ?? '') + "') -- a locked screen or an always-on-top window is in the way")
	}
	if (cmd === 'measure') {
		console.log(JSON.stringify(geo))
		stopFixture()
		process.exit(0)
	}

	const t0 = Date.now()
	const begin = await scroll.scrollBegin(`${info.x},${info.y},${info.w},${info.h}`, {
		mode: 'auto',
		maxFrames,
		settleMs: 420,
	})
	if (begin.ok !== true) {
		console.log('FAIL: scrollBegin ' + JSON.stringify(begin))
		stopFixture()
		process.exit(1)
	}
	let st = null
	const traj = []
	for (let i = 0; i < 600; i++) {
		await sleep(400)
		st = await scroll.scrollStatus()
		if (st) traj.push([st.frames, st.notches, st.lastShiftPx, st.maxFrames, st.stopReason ?? ''])
		if (st?.done === true) break
	}
	const out = await scroll.scrollEnd()
	let runs = null
	let imgH = null
	if (out.ok === true && out.path) {
		const img = pixels.readPng(out.path)
		imgH = img.height
		runs = runsOf(img)
		if (!keep) {
			try { fs.rmSync(out.path, { force: true }) } catch {}
		}
	}
	console.log(JSON.stringify({
		...geo,
		frames: out.frames ?? st?.frames,
		stopReason: out.stopReason ?? '',
		notches: out.notches ?? st?.notches,
		lastShiftPx: out.lastShiftPx ?? st?.lastShiftPx,
		ok: out.ok,
		error: out.error ?? '',
		height: out.height ?? 0,
		imgH,
		runs,
		seconds: Math.round((Date.now() - t0) / 100) / 10,
		traj,
		path: out.path ?? '',
	}))
	stopFixture()
	process.exit(0)
} catch (error) {
	console.log('FAIL: lab crashed: ' + String(error?.message ?? error))
	stopFixture()
	try { await scroll.scrollCancel() } catch {}
	process.exit(1)
}
