// dev/wheel-app-probe.mjs -- "does THIS application act on a POSTED wheel?" (R32)
//
// WHY THIS FILE EXISTS (it closes backlog item 2 of R30)
//   R27 made the auto long screenshot post WM_MOUSEWHEEL at the target instead of moving the real
//   cursor; R29 measured that the message must go to the LEAF control, not the top-level window,
//   and proved it on two toolkits: WinForms (first visible line 0 -> 3) and Chromium (scrollTop
//   180 -> 349.6). What was never measured: Qt and Java -- the two desktop toolkits whose wheel
//   routing is genuinely different (Qt routes by the cursor's widget; Swing's Windows peer may or
//   may not read the coordinates out of the message).
//
//   Guessing there would be expensive: a silent "nothing scrolled" in the product looks exactly
//   like "this app is not scrollable", and the user would only find out after an auto long
//   screenshot produced one frame.
//
// HOW IT MEASURES
//   Two independent facts per arm, never one:
//     * the fixture's OWN scrollbar value (Qt/Swing log every change) -- ground truth, no pixels
//     * a pixel diff of a crop around the scroll point -- what a generic app (which has no log)
//       can offer; it also catches "the app repainted but did not scroll"
//   and a CONTROL arm with a REAL wheel (cursor moved + mouse_event). If the control does not
//   scroll, the fixture is broken and the posted result means nothing (the R29 lesson).
//
// RUN IT FROM THE HOST (a low-integrity sandbox shell cannot post a message any medium-integrity
// app acts on, and cannot even show the fixture):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs', args:['-App','qt']})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs', args:['-App','java']})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-app-probe.mjs', args:['-Title','xxx']})
//
//   -App qt|java    spawn the bundled fixture (Qt needs the lab PyQt5; see -QtPath)
//   -Title <substr> measure an ALREADY RUNNING app instead (click into it once so it has focus)
//   -Seconds <n>    how long the fixture lives (default 60)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPng } from './png.mjs'
import { lab } from './labpath.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = lab('wheel-app')
const CAPTURE = path.join(PLUGIN, 'ps', 'capture.ps1')
const QT_FIXTURE = path.join(HERE, 'qt-scroll-fixture.pyw')
const JAVA_FIXTURE = path.join(HERE, 'SwingScrollFixture.java')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
	const i = argv.indexOf(name)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const APP = String(arg('-App', '')).toLowerCase()
const TITLE_ARG = String(arg('-Title', ''))
const SECONDS = Number(arg('-Seconds', '60')) || 60
const QT_PATH = String(arg('-QtPath', lab('pyqt')))

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(item, ok, detail) {
	results.push({ item, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

fs.mkdirSync(LAB, { recursive: true })

/* ─────────────────── the fixture ─────────────────── */

const TAG = APP === '' ? 'window' : APP
const LOG = path.join(LAB, `${TAG}.log`)
const INFO = path.join(LAB, `${TAG}.json`)
for (const f of [LOG, INFO]) {
	try {
		fs.rmSync(f, { force: true })
	} catch {}
}

let fixture = null
async function spawnFixture() {
	if (APP === 'qt') {
		/**
		 * PyQt5 is installed with `pip --target`, so Qt's own plugin lookup (which is relative to
		 * wherever Qt5Core.dll was loaded from) does not find its `platforms/` directory --
		 * measured: `qt.qpa.plugin: Could not find the Qt platform plugin "windows"`, and the
		 * process dies before any window exists. Pointing QPA at the shipped directory fixes it.
		 */
		const qtPlugins = path.join(QT_PATH, 'PyQt5', 'Qt5', 'plugins')
		const env = {
			...process.env,
			PYTHONPATH: QT_PATH + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
			QT_PLUGIN_PATH: qtPlugins,
			QT_QPA_PLATFORM_PLUGIN_PATH: path.join(qtPlugins, 'platforms'),
		}
		fixture = spawn('python', [QT_FIXTURE, '--x', '60', '--y', '60', '--w', '440', '--h', '340', '--log', LOG, '--info', INFO, '--seconds', String(SECONDS)], {
			env,
			// windowsHide:false on purpose. With CREATE_NO_WINDOW the Qt window never reached the
			// screen (measured: 0% pixel change, while Qt insisted visible=true), so a console
			// flash for a few seconds is the cheaper trade.
			windowsHide: false,
			stdio: 'ignore',
		})
	} else if (APP === 'java') {
		const javaExe = findJava()
		fixture = spawn(javaExe, [JAVA_FIXTURE, '70', '70', '460', '360', LOG, INFO, String(SECONDS)], { windowsHide: false, stdio: 'ignore' })
	} else {
		return false
	}
	fixture.on('error', (e) => console.log(`   fixture error: ${e.message}`))
	fixture.unref()
	return true
}

function findJava() {
	const candidates = [
		process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '',
		'C:\\Program Files\\Microsoft\\jdk-17.0.8.7-hotspot\\bin\\java.exe',
	]
	for (const c of candidates) if (c !== '' && fs.existsSync(c)) return c
	return 'java'
}

/* ─────────────────── helpers ─────────────────── */

/** Last "value=N" line of the fixture's own log (null when the app has no such log). */
function lastValue() {
	try {
		const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/)
		for (let i = lines.length - 1; i >= 0; i--) {
			const m = /^value=(-?\d+)/.exec(lines[i].trim())
			if (m) return Number(m[1])
		}
	} catch {}
	return null
}

let capSeq = 0
async function capture(rect) {
	capSeq += 1
	const out = path.join(LAB, `${TAG}-${String(capSeq).padStart(2, '0')}.png`)
	const res = await shot.run(shot.findPowershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE, '-Mode', 'desktop', '-Rect', `${rect.x},${rect.y},${rect.w},${rect.h}`, '-Out', out, '-Json'], {
		timeoutMs: 25_000,
	})
	if (!fs.existsSync(out)) throw new Error(`capture failed: ${String(res.stderr ?? '').slice(0, 200)}`)
	return readPng(out)
}

/** Fraction of pixels that differ by more than `tol` per channel. */
function diffRatio(a, b, tol = 10) {
	if (a.width !== b.width || a.height !== b.height) return 1
	let diff = 0
	const n = a.width * a.height
	for (let y = 0; y < a.height; y++) {
		for (let x = 0; x < a.width; x++) {
			const p = a.at(x, y)
			const q = b.at(x, y)
			if (Math.abs(p[0] - q[0]) > tol || Math.abs(p[1] - q[1]) > tol || Math.abs(p[2] - q[2]) > tol) diff++
		}
	}
	return diff / n
}

async function findWindow(title) {
	const list = await shot.listWindows({ exclude: '', limit: 120 })
	const wins = (list && list.windows) || []
	const hit = wins.find((w) => String(w.title || '').includes(title))
	if (!hit) return null
	return {
		hwnd: Number(hit.hwnd) || 0,
		x: Number(hit.x ?? hit.left) || 0,
		y: Number(hit.y ?? hit.top) || 0,
		w: Number(hit.w ?? hit.width) || 0,
		h: Number(hit.h ?? hit.height) || 0,
		title: String(hit.title || ''),
	}
}

/* ─────────────────── run ─────────────────── */

console.log(`wheel-app probe · app=${APP || 'existing window'} · lab=${LAB}`)

/**
 * The fixture's rectangles are fixed and known before the spawn, so the pixels at that place can be
 * compared across the spawn. That comparison is the ONLY trustworthy answer to "is the fixture
 * actually on screen" -- enumerating windows is not (a Qt top-level window with WS_EX_TOOLWINDOW is
 * filtered out of ps/windows.ps1, and a window on a non-interactive desktop is "visible" to Win32
 * while nobody can see it).
 */
const FIXTURE_RECT = APP === 'qt' ? { x: 60, y: 60, w: 440, h: 340 } : { x: 70, y: 70, w: 460, h: 360 }
let bgShot = null
if (APP !== '') {
	await sleep(250)
	bgShot = await capture(FIXTURE_RECT)
}

const spawned = await spawnFixture()

let point = null
let win = null
if (spawned) {
	const up = await (async () => {
		for (let i = 0; i < 200; i++) {
			try {
				if (fs.statSync(INFO).size > 10) return true
			} catch {}
			await sleep(100)
		}
		return false
	})()
	if (!up) {
		console.log(`   fixture did not come up; log tail:`)
		try {
			console.log(fs.readFileSync(LOG, 'utf8').slice(-800))
		} catch {}
		process.exit(1)
	}
	const info = JSON.parse(fs.readFileSync(INFO, 'utf8'))
	console.log(`   fixture: ${JSON.stringify(info)}`)
	/**
	 * Two different ways to find the same thing, each chosen for a measured reason:
	 *   Qt   -> the fixture reports its own HWND. Enumeration is NOT usable: a Qt top-level window
	 *           carries WS_EX_TOOLWINDOW and ps/windows.ps1 filters those out.
	 *   Java -> no HWND is reachable without JNA, and reading a Swing component's screen position
	 *           off the EDT returned a nonsense y (4301) in the first run. A JFrame is an ordinary
	 *           titled window, so enumeration works and the point is derived from the frame rect.
	 */
	if (APP === 'qt') {
		win = { hwnd: Number(info.hwnd) || 0, x: 0, y: 0, w: 0, h: 0, title: info.toolkit }
		point = { x: Number(info.cx), y: Number(info.cy) }
	} else {
		win = await findWindow('DSH-JAVA-SCROLL')
		if (win === null) {
			console.log('   java frame not enumerable; is it behind something or was it never mapped?')
			process.exit(1)
		}
		// 55% down the window: safely inside the scrollpane, below the title bar.
		point = { x: win.x + Math.round(win.w / 2), y: win.y + Math.round(win.h * 0.55) }
	}
	// Is it really on screen at the expected place? Compare before/after the spawn.
	const fgShot = await capture(FIXTURE_RECT)
	const appeared = diffRatio(bgShot, fgShot)
	check(
		'fixture is really ON SCREEN (pixels at its rect changed after spawn)',
		appeared > 0.25,
		`${(appeared * 100).toFixed(1)}% of ${FIXTURE_RECT.w}x${FIXTURE_RECT.h} changed`
	)
	if (appeared <= 0.25) {
		console.log('   the fixture window is not visible where it claims to be -- refusing to measure')
		console.log('   (a covered or invisible fixture would make both arms statements about another window)')
		process.exit(1)
	}
} else {
	const title = TITLE_ARG
	if (title === '') {
		console.log('   need -App qt|java or -Title <substring>')
		process.exit(1)
	}
	win = await findWindow(title)
	if (win === null) {
		console.log(`   no visible window whose title contains "${title}"`)
		process.exit(1)
	}
	// Content centre: a third down the window is inside the client area of any normal frame.
	point = { x: win.x + Math.round(win.w / 2), y: win.y + Math.round(win.h / 3) }
}

check('fixture/window found', win !== null && win.hwnd > 0, win === null ? 'not found' : `hwnd=${win.hwnd} "${win.title}" ${win.w}x${win.h}@${win.x},${win.y}`)
if (win === null) {
	// "not found" has three very different causes (window never mapped / filtered out by
	// ps/windows.ps1 / title mismatch). Printing what the enumerator DOES see separates them.
	const list = await shot.listWindows({ exclude: '', limit: 80 })
	console.log(`   enumerator sees ${(list.windows ?? []).length} windows:`)
	for (const w of list.windows ?? []) console.log(`     ${w.hwnd} pid=${w.pid} "${String(w.title).slice(0, 48)}"`)
	process.exit(1)
}
const hit = await shot.hitTest(point.x, point.y)
console.log(`   point ${point.x},${point.y} · leaf=${JSON.stringify(hit).slice(0, 160)}`)

const CROP = { x: Math.max(0, point.x - 90), y: Math.max(0, point.y - 90), w: 180, h: 180 }

/**
 * Baseline scroll position. The fixtures log "value=N" only when the value CHANGES, so a pristine
 * fixture has no such line at all -- reading only the log gives null and makes the very first
 * measurement unusable (measured: the posted wheel really did scroll 0 -> 9, and the probe called
 * it a failure because it had nothing to compare against). The startup value comes from the info
 * file instead.
 */
const v0 = fixtureStartValue()

/* arm 1: POSTED wheel, exactly what auto long screenshot does */
const before = await capture(CROP)
const posted = await shot.postWheel(win.hwnd, point.x, point.y, -120, 3)
await sleep(900)
const v1 = lastValue()
const after = await capture(CROP)
const d1 = diffRatio(before, after)
const scrolled1 = v1 !== null ? v1 !== v0 : d1 > 0.02
console.log(`   POSTED  ×3 → value ${v0} -> ${v1} · pixels changed ${(d1 * 100).toFixed(1)}% · ${JSON.stringify(posted).slice(0, 200)}`)
check('posted wheel reached a control (not refused)', posted.posted === true && Number(posted.postedTo) > 0, `postedTo=${posted.postedTo} reason=${posted.reason}`)
check('POSTED WHEEL SCROLLED IT  ← the headline', scrolled1 === true, `value ${v0} -> ${v1}, ${v1 === null ? 'no app log, pixels only' : 'app log = ground truth'}`)

/* arm 2: CONTROL -- a real wheel. If it cannot even move the cursor, that is a SKIP, not a FAIL:
 * the point of the arm is "the fixture is scrollable", and the logged value already proves the
 * scrollbar responds. Never let an environment limitation read as a verdict about the app. */
const v2 = v1 === null ? v0 : v1
const before2 = await capture(CROP)
const real = await shot.wheelAt(point.x, point.y, -120, 3)
await sleep(900)
const v3 = lastValue()
const after2 = await capture(CROP)
const d2 = diffRatio(before2, after2)
const scrolled2 = v3 !== null ? v3 !== v2 : d2 > 0.02
console.log(`   REAL    ×3 → value ${v2} -> ${v3} · pixels changed ${(d2 * 100).toFixed(1)}% · ${JSON.stringify(real).slice(0, 160)}`)
if (real.ok === false) {
	console.log(`   SKIP  CONTROL arm: ${real.error || 'real wheel unavailable'} —— 这是环境限制（沙箱/低完整性不能移光标），不是被测应用的结论`)
} else {
	check('CONTROL: a real wheel scrolls it', scrolled2 === true, `value ${v2} -> ${v3}, diff ${(d2 * 100).toFixed(1)}%`)
}

/* ─────────────────── verdict ─────────────────── */

const fails = results.filter((r) => !r.ok).length
console.log('')
console.log(`VERDICT ${APP || 'window'}: posted wheel ${scrolled1 ? 'WORKS' : 'DOES NOT WORK'}${scrolled1 && v1 !== null ? ` (value ${v0} -> ${v1})` : ''} · ${results.length - fails} PASS / ${fails} FAIL`)
if (fixture !== null) {
	try {
		fixture.kill()
	} catch {}
}
// Explicit exit: postWheel/wheelAt go through the RESIDENT helper module, which keeps a child
// process handle open. Without this the probe prints its verdict and then hangs until the
// harness kills it (measured: a green run reported as a 240s timeout).
process.exit(fails > 0 ? 1 : 0)

/** Scroll value the fixture started at (info file), falling back to its log. */
function fixtureStartValue() {
	try {
		const info = JSON.parse(fs.readFileSync(INFO, 'utf8'))
		if (Number.isFinite(Number(info.value))) return Number(info.value)
	} catch {}
	const v = lastValue()
	return v === null ? 0 : v
}
