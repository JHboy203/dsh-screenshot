// dev/wheel-target-probe.mjs -- R29 regression: a posted wheel must go to the control under the
// point, and must be REFUSED when that control no longer belongs to the target window.
//
// WHY THIS FILE EXISTS (it started as a measurement): R27 posted WM_MOUSEWHEEL at the TOP-LEVEL
// window and only ever measured Chromium. The comment in shotcore.ps1 claiming "WinForms routes
// by the REAL cursor position" was an assertion, never a measurement. R29 measured it against a
// WinForms TextBox that logs its own scroll position (dev/wheel-target.ps1):
//
//   message addressed to            wheel reached        content scrolled
//   top-level form                  form                 NO
//   control under the point         editor               YES
//   + real cursor parked inside     form+editor          YES (still no, when addressed to root)
//   real wheel (mouse_event)        editor               YES  <- control arm
//
// So the product now resolves the leaf with WindowFromPoint and posts there. Chromium accepts
// both, verified live (DSH session list scrollTop 180 -> 349.6, cursor never moved).
//
// Ground truth is the fixture's OWN log: 'wheel' = the message reached a control, 'line' = the
// text really moved (first visible line changed). No pixels involved, so a covering window does
// not matter. The last arm is a CONTROL: a real wheel must scroll the fixture, otherwise every
// "did not scroll" above would be a statement about the fixture.
//
// RUN IT FROM THE HOST (a low-integrity sandbox shell cannot post a message any medium-
// integrity app will act on):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/wheel-target-probe.mjs'})
//
// It starts its OWN resident helper: the one the app started may still be running the previous
// shotcore.ps1 (a helper does not respawn when its script changes), and this test must exercise
// the NEW code, not the app's old process.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = path.join('D:\\信息库\\AI工作区', '.tmp-shot-lab', 'wheel')
const FIXTURE = path.join(HERE, 'wheel-target.ps1')
const WINPOINT = path.join(HERE, 'winpoint.ps1')
const LOG = path.join(LAB, 'target.log')
const INFO = path.join(LAB, 'target-info.json')
const CONTROL = path.join(LAB, 'control.txt')
const CONSOLE = path.join(LAB, 'target-console.log')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
	const i = argv.indexOf(name)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const SHELL = String(arg('-Shell', 'powershell')).toLowerCase() === 'pwsh' ? 'pwsh' : 'powershell'
const SECONDS = Number(arg('-Seconds', '90')) || 90

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const shooter = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shooter.mjs')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pwshExe = () => (SHELL === 'pwsh' ? shot.findPwsh() : shot.findPowershell())

const results = []
function check(item, ok, detail) {
	results.push({ item, ok: ok === true, detail: String(detail) })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

fs.mkdirSync(LAB, { recursive: true })
for (const f of [LOG, INFO, CONTROL]) {
	try {
		fs.rmSync(f, { force: true })
	} catch {}
}

/** Lines of the fixture log (each one is a JSON object). */
function logLines() {
	try {
		return fs
			.readFileSync(LOG, 'utf8')
			.split(/\r?\n/)
			.filter((s) => s.trim().startsWith('{'))
			.map((s) => {
				try {
					return JSON.parse(s)
				} catch {
					return null
				}
			})
			.filter(Boolean)
	} catch {
		return []
	}
}

/** Ground truth: the editor's first visible line. 'shown'/'top' both mean line 0. */
function firstLine() {
	const lines = logLines()
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]
		if (l.ev === 'line') return Number(l.v) || 0
		if (l.ev === 'cmd' && l.cmd === 'top') return 0
		if (l.ev === 'shown') return 0
	}
	return 0
}

async function waitFor(pred, timeoutMs, tick = 100) {
	const until = Date.now() + timeoutMs
	while (Date.now() < until) {
		if (pred()) return true
		await sleep(tick)
	}
	return false
}

async function resetTop() {
	const seen = logLines().filter((l) => l.ev === 'cmd' && l.cmd === 'top').length
	fs.writeFileSync(CONTROL, 'top', 'ascii')
	const ok = await waitFor(
		() => logLines().filter((l) => l.ev === 'cmd' && l.cmd === 'top').length > seen,
		4000
	)
	await sleep(140)
	return ok
}

/** One raw postwheel.ps1 run -- used for the "old root-addressed" evidence arm. */
async function rawPost(hwnd, x, y, delta, extra = []) {
	const res = await shot.run(
		shot.findPowershell(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'postwheel.ps1'),
			'-Hwnd', String(hwnd), '-Delta', String(delta), '-X', String(x), '-Y', String(y), ...extra,
		],
		{ timeoutMs: 20_000 }
	)
	return { info: shot.lastJsonLine(res.stdout), exit: res.code, stderr: String(res.stderr ?? '').slice(0, 200) }
}

/** One measured attempt: reset to top, act, then read the fixture's own account of it. */
async function arm(label, act, settleMs = 550) {
	await resetTop()
	const mark = logLines().length
	const y0 = firstLine()
	const ret = await act()
	await sleep(settleMs)
	const lines = logLines().slice(mark)
	return {
		label,
		ret,
		wheels: lines.filter((l) => l.ev === 'wheel').map((w) => w.on),
		y0,
		y1: firstLine(),
		scrolled: firstLine() !== y0,
	}
}

/* ─────────────────── start the target ─────────────────── */

const errFd = fs.openSync(CONSOLE, 'a')
let child = null
try {
	child = spawn(
		pwshExe(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', FIXTURE,
			'-Seconds', String(SECONDS), '-Log', LOG, '-Info', INFO, '-Control', CONTROL,
		],
		{ windowsHide: false, stdio: ['ignore', errFd, errFd] }
	)
} finally {
	try {
		fs.closeSync(errFd)
	} catch {}
}
child.unref()

const up = await waitFor(() => {
	try {
		return fs.readFileSync(INFO, 'utf8').trim().startsWith('{')
	} catch {
		return false
	}
}, 15_000)
if (!up) {
	console.log(JSON.stringify({ ok: false, error: 'fixture did not come up', shell: SHELL, dir: LAB }))
	try {
		console.log(fs.readFileSync(CONSOLE, 'utf8').slice(-1500))
	} catch {}
	process.exit(1)
}
const info = JSON.parse(fs.readFileSync(INFO, 'utf8'))
await sleep(500)
const focus = logLines().find((l) => l.ev === 'focus') ?? null

/* the leaf under the centre (independent ruler; the product resolves this itself) */
const at = await shot.run(
	shot.findPowershell(),
	['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINPOINT, '-X', String(info.cx), '-Y', String(info.cy)],
	{ timeoutMs: 20_000 }
)
const point = shot.lastJsonLine(at.stdout)

/* a window that is NOT the target, to prove the guard refuses instead of scrolling it */
let foreign = 0
try {
	const list = await shot.listWindows({ exclude: '', limit: 80 })
	const wins = (list && list.windows) || []
	const usable = wins.filter(
		(w) => Number(w.hwnd) !== Number(info.hwnd) && Number(w.w || w.width || 0) > 100 && Number(w.h || w.height || 0) > 100
	)
	// Prefer DSH itself (it is certainly a different root), but do not depend on its title.
	const dsh = usable.find((w) => /DeepSeek/i.test(String(w.title)))
	const pick = dsh ?? usable[0]
	if (pick !== undefined) foreign = Number(pick.hwnd) || 0
} catch {}

console.log(`target: hwnd=${info.hwnd} editor=${info.ehwnd} centre=${info.cx},${info.cy} shell=${SHELL}`)
console.log(`leaf at centre: ${JSON.stringify(point)}`)
console.log(`focus: ${JSON.stringify(focus)}`)

/* ─────────────────── its own helper (new code) ─────────────────── */

let helperReady = false
try {
	shooter.startShooter()
	helperReady = await waitFor(() => shooter.shooterStatus().ready === true, 20_000, 150)
} catch {}
check('own helper is up (runs the current shotcore.ps1)', helperReady, JSON.stringify(shooter.shooterStatus()).slice(0, 180))

/* ─────────────────── the arms ─────────────────── */

// 1. The product path, helper fast path. THIS is the regression that matters.
const viaHelper = await arm('postWheel/via-helper', () => shot.postWheel(info.hwnd, info.cx, info.cy, -120, 1))
check(
	'posted wheel scrolls a WinForms target (helper path)',
	viaHelper.scrolled === true,
	`wheels=${JSON.stringify(viaHelper.wheels)} line ${viaHelper.y0}->${viaHelper.y1} ret=${JSON.stringify(viaHelper.ret)}`
)
check(
	'it was addressed to the control under the point, not the top-level form',
	Number(viaHelper.ret?.postedTo) > 0 && Number(viaHelper.ret?.postedTo) !== Number(info.hwnd),
	`postedTo=${viaHelper.ret?.postedTo} (root=${info.hwnd}, editor=${info.ehwnd})`
)

// 2. Same product path with the helper disabled: the spawn fallback (ps/postwheel.ps1) must have
// the same semantics, because that is what runs while a helper is still on old code.
const keep = process.env.DSH_SHOT_HELPER
process.env.DSH_SHOT_HELPER = '0'
let viaSpawn = { scrolled: false, ret: {}, wheels: [], y0: 0, y1: 0 }
try {
	viaSpawn = await arm('postWheel/via-spawn', () => shot.postWheel(info.hwnd, info.cx, info.cy, -120, 1), 900)
} finally {
	if (keep === undefined) delete process.env.DSH_SHOT_HELPER
	else process.env.DSH_SHOT_HELPER = keep
}
check(
	'spawn fallback has the same semantics (leaf-addressed)',
	viaSpawn.scrolled === true && Number(viaSpawn.ret?.postedTo) > 0,
	`wheels=${JSON.stringify(viaSpawn.wheels)} line ${viaSpawn.y0}->${viaSpawn.y1} ret=${JSON.stringify(viaSpawn.ret)}`
)

// 3. Safety: asked to scroll a window that is NOT under the point -> refuse, scroll nothing.
let guard = { scrolled: false, ret: null }
if (foreign > 0) {
	guard = await arm('postWheel/foreign-window', () => shot.postWheel(foreign, info.cx, info.cy, -120, 1))
	check(
		'refuses a window that is not under the point (posts nothing)',
		guard.ret?.posted === false && guard.ret?.reason === 'point-moved' && guard.scrolled === false,
		`ret=${JSON.stringify(guard.ret)} scrolled=${guard.scrolled}`
	)
} else {
	check('refuses a window that is not under the point (posts nothing)', false, 'no foreign window found to test with')
}

// 4. CONTROL: a real wheel. If this fails, the fixture cannot scroll by wheel at all and the
// checks above would be meaningless.
const real = await arm('real-wheel', () => shot.wheelAt(info.cx, info.cy, -120, 1), 700)
check(
	'CONTROL: a real wheel does scroll the fixture',
	real.scrolled === true,
	`wheels=${JSON.stringify(real.wheels)} line ${real.y0}->${real.y1} ret=${JSON.stringify(real.ret)}`
)

// 5. Evidence (informational, not a verdict): what R27 used to do -- address the top-level form.
const old = await arm('old/root-addressed', async () => (await rawPost(info.hwnd, info.cx, info.cy, -120, ['-Resolve', 'root'])).info)
console.log(
	`   INFO  old root-addressed message: wheels=${JSON.stringify(old.wheels)} ` +
		`line ${old.y0}->${old.y1} scrolled=${old.scrolled} (R29 exists because this is false)`
)

/* ─────────────────── clean up ─────────────────── */

// ⚠️ Deliberately NOT stopping the helper. This script runs inside the HOST process, so
// `startShooter()` above replaced the app's resident helper with one that parsed the current
// shotcore.ps1 -- leaving it running is the point (captures stay fast, and the new code is live
// without a DSH restart). Killing it here would hand the app back a cold, slower state.
try {
	fs.writeFileSync(CONTROL, 'q', 'ascii')
} catch {}
await sleep(400)
try {
	child.kill()
} catch {}
console.log(`helper after the run: ${JSON.stringify({ alive: shooter.shooterStatus().alive, ready: shooter.shooterStatus().ready, pid: shooter.shooterStatus().pid })}`)

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`R29 wheel-target: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
