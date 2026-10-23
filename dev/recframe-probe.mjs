// dev/recframe-probe.mjs -- R32 regression for the "recording frame" (ps/recframe.ps1).
//
// WHAT IT PROVES, and why none of it can be asserted from geometry alone:
//   1. the frame really appears on the screen  (a window that reports Visible=true and paints
//      nothing is exactly the failure this probe was written after -- see the note below)
//   2. the border sits OUTSIDE the captured rect   -> not one frame pixel lands in the video
//   3. the INTERIOR is transparent (the content underneath is preserved), not blacked out
//   4. the interior is NOT key-coloured (a TransparencyKey leak would look like a magenta slab)
//   5. the stop file closes it, and killing the process also closes it (both paths are used)
//
// HOW TO RUN (must be the HOST context -- a window created from the sandboxed shell never reaches
// the interactive desktop, so the capture sees a bare wall and every pixel assertion fails):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})
//   shot_probe({probe:'recframe'})
//
// WHY PIXELS: the first version of this probe only checked "the process is alive" and "a window
// with that pid is visible". Both were true while the screen showed nothing at all -- the window
// was created on a non-interactive desktop. Visibility is not the property we care about; the
// property is "these pixels are on the user's screen, and they are not inside the video".
//
// WHY A FIXTURE UNDERNEATH (R53): the interior check used to compare two captures of the DESKTOP,
// which meant it measured the desktop as much as the frame. Three rounds of patching that
// (R35: a hard-coded corner was covered by QQ; R48: the candidate sat on the streaming DSH window;
// R49: grid-search for "least covered + static") ended at the same place: on 2026-10-24 this
// desktop (DSH 1619x1029@150,0 + Settings 1920x1020 + Explorer 1268x759) had exactly ONE static
// slot left, 120x90 at (8,968), and the SAME code scored 12/12 on one run and 11/12 in the
// aggregate. So the frame now sits on top of dev/recframe-backdrop.ps1 -- a window that paints a
// checkerboard whose colours and cell size are known -- and the assertion becomes "at this screen
// position the expected colour is still there". No timing, no desktop state, no other window.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPng } from './png.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = path.join('D:\\信息库\\AI工作区', '.tmp-shot-lab', 'recframe')
const FRAME = path.join(PLUGIN, 'ps', 'recframe.ps1')
const CAPTURE = path.join(PLUGIN, 'ps', 'capture.ps1')
const BACKDROP = path.join(HERE, 'recframe-backdrop.ps1')
const THICK = 3
/** Border colour used by ps/recframe.ps1 (Color.FromArgb(255, 235, 64, 52)). */
const BORDER = [235, 64, 52]
/** TransparencyKey used by ps/recframe.ps1. */
const KEY = [255, 0, 255]
/** Checkerboard colours painted by dev/recframe-backdrop.ps1. */
const DARK = [30, 36, 48]
const LIGHT = [216, 222, 233]
/** Cell size asked of the backdrop (the fixture echoes the effective one back in its Info file). */
const CELL = 30
/** The window being recorded. Small on purpose: the crop is REGION + 2*PAD. */
const RW = 120
const RH = 90

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
/** env（环境挡住）的失败项：既不算通过，也不该被当成本产品回归（退出码 2，见文件末尾）。 */
let envFails = 0
function check(item, ok, detail, kind) {
	results.push({ item, ok: ok === true, env: kind === 'env' })
	if (kind === 'env' && ok !== true) envFails += 1
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

fs.mkdirSync(LAB, { recursive: true })

/* ─────────────────── where to put it ─────────────────── */

const disp = await shot.displays()
const vw = Number(disp.virtual?.w) || 1920
const vh = Number(disp.virtual?.h) || 1080
const PAD = 8
/** @type {{x:number,y:number,w:number,h:number}} */
let REGION = null
/** @type {{x:number,y:number,w:number,h:number}} */
let CROP = null

/* ─────────────────── helpers ─────────────────── */

let capSeq = 0
async function capture(label, rect = CROP) {
	capSeq += 1
	const out = path.join(LAB, `${String(capSeq).padStart(2, '0')}-${label}.png`)
	const res = await shot.run(
		shot.findPowershell(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE,
			'-Mode', 'desktop', '-Rect', `${rect.x},${rect.y},${rect.w},${rect.h}`, '-Out', out, '-Json',
		],
		{ timeoutMs: 25_000 }
	)
	if (!fs.existsSync(out)) throw new Error(`capture failed: ${String(res.stderr ?? '').slice(0, 300)}`)
	return { label, file: out, img: readPng(out) }
}

const near = (c, t, tol) => Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol

function countIn(img, x0, y0, x1, y1, test) {
	let n = 0
	for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
		for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
			if (test(img.at(x, y))) n++
		}
	}
	return n
}

/** The canary window is a SOLID lime block, so only pixels sitting in a horizontal run of at least
 *  `minRun` lime pixels are evidence. This is not fussiness: the crop around (40,40) reaches x=286,
 *  and the DSH window starts at x=150 -- so the strip below/right of the canary is whatever DSH is
 *  painting at that moment. On 2026-10-24 the aggregate run found 42 isolated lime-ish pixels there
 *  and the bbox grew from 240x120 to 240x126, which the DPI assertion read as "the window is drawn
 *  at 0.8 scale" (a 6px height error). The single run passed. A verdict that depends on the
 *  colours behind the fixture is a verdict about the desktop, not about the window.
 *  A genuinely DPI-virtualised window is still caught: its rows are 192 px runs, far above minRun,
 *  so the box comes back 192x96. */
function solidLime(img, minRun) {
	const isLime = (c) => c[1] > 180 && c[0] < 120 && c[2] < 120
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -1
	let y1 = -1
	let count = 0
	for (let y = 0; y < img.height; y++) {
		let run = 0
		let start = 0
		for (let x = 0; x <= img.width; x++) {
			const on = x < img.width && isLime(img.at(x, y))
			if (on) {
				if (run === 0) start = x
				run++
				continue
			}
			if (run >= minRun) {
				count += run
				if (start < x0) x0 = start
				if (x - 1 > x1) x1 = x - 1
				if (y < y0) y0 = y
				if (y > y1) y1 = y
			}
			run = 0
		}
	}
	if (x1 < 0) return { count: 0, box: null }
	return { count, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } }
}

/** Four bands just OUTSIDE the region (in crop coordinates). */
function bands() {
	const rx = PAD
	const ry = PAD
	const rw = REGION.w
	const rh = REGION.h
	const t = THICK
	return {
		top: [rx, ry - t, rx + rw, ry],
		bottom: [rx, ry + rh, rx + rw, ry + rh + t],
		left: [rx - t, ry, rx, ry + rh],
		right: [rx + rw, ry, rx + rw + t, ry + rh],
	}
}

let frameChild = null
async function startFrame(tag) {
	const stop = path.join(LAB, `stop-${tag}.txt`)
	const info = path.join(LAB, `frame-${tag}.json`)
	for (const f of [stop, info]) {
		try {
			fs.rmSync(f, { force: true })
		} catch {}
	}
	const log = fs.openSync(path.join(LAB, `frame-${tag}.log`), 'a')
	const child = spawn(
		shot.findPowershell(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FRAME,
			'-X', String(REGION.x), '-Y', String(REGION.y), '-W', String(REGION.w), '-H', String(REGION.h),
			'-Thickness', String(THICK), '-StopFile', stop, '-Info', info,
		],
		{ windowsHide: false, stdio: ['ignore', log, log] }
	)
	try {
		fs.closeSync(log)
	} catch {}
	child.unref()
	return { child, stop, info }
}

async function waitExit(child, ms) {
	const until = Date.now() + ms
	while (Date.now() < until) {
		if (child.exitCode !== null || child.signalCode !== null) return true
		await sleep(80)
	}
	return false
}

/** Poll until `file` exists and is non-empty. */
async function waitForFile(file, ms) {
	const until = Date.now() + ms
	while (Date.now() < until) {
		try {
			if (fs.statSync(file).size > 2) return true
		} catch {}
		await sleep(100)
	}
	return false
}

/* ─────────────────── arm 0: CANARY ───────────────────
 * "A window started this way can be seen at all." Without this arm, an invisible frame is
 * indistinguishable from an environment that never showed the window (both produce zero border
 * pixels and an unchanged interior, and that ambiguity wasted a round in R32).
 */
const CANARY = { x: 40, y: 40, w: 240, h: 120 }
const CANARY_CROP = { x: CANARY.x - 6, y: CANARY.y - 6, w: CANARY.w + 12, h: CANARY.h + 12 }
const canaryInfo = path.join(LAB, 'canary.json')
try {
	fs.rmSync(canaryInfo, { force: true })
} catch {}
const canaryLog = fs.openSync(path.join(LAB, 'canary.log'), 'a')
const canary = spawn(
	shot.findPowershell(),
	['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'recframe-control.ps1'), '-X', String(CANARY.x), '-Y', String(CANARY.y), '-W', String(CANARY.w), '-H', String(CANARY.h), '-Seconds', '30', '-Info', canaryInfo],
	{ windowsHide: false, stdio: ['ignore', canaryLog, canaryLog] }
)
try {
	fs.closeSync(canaryLog)
} catch {}
canary.unref()
/* WAIT FOR THE WINDOW, DO NOT SLEEP —— 和 arm 1 同一条纪律。冷启动的 powershell.exe + Add-Type
 * 编译要 1.5–2.5s，机器忙时更久。R35 实测：把取景框改成"多点两次抓屏"（pickRegion）之后，
 * 原来固定的 6s 轮询不够了 —— canary.json 在轮询结束后才写出，抓到的是一张**只画了一半**的窗口
 * （118/240 px、up=false），于是 CANARY 报"窗口没上屏"，而其实只是"还没画完"。
 * 判据必须来自窗口自己的 Info 文件，而不是一个猜出来的 sleep。 */
const canaryUp = await waitForFile(canaryInfo, 20_000)
await sleep(400)
const canaryShot = await capture('canary', CANARY_CROP)
const limeSeen = solidLime(canaryShot.img, CANARY.w * 0.25)
const lime = limeSeen.count
/** The bbox matters as much as the count: a window drawn at 0.8 scale is DPI-virtualised, and
 *  that silently moves every frame too. */
const limeBox = limeSeen.box
console.log(`canary: lime=${lime} bbox=${JSON.stringify(limeBox)} (crop origin ${CANARY_CROP.x},${CANARY_CROP.y}; window ${CANARY.w}x${CANARY.h}@${CANARY.x},${CANARY.y})`)
check('CANARY: a plain window started by this probe is visible on screen', lime >= CANARY.w * CANARY.h * 0.5, `lime px=${lime} of ${CANARY.w * CANARY.h}`)
check(
	'CANARY: it is drawn at PHYSICAL coordinates (not DPI-virtualised)',
	limeBox !== null && Math.abs(limeBox.w - CANARY.w) <= 4 && Math.abs(limeBox.h - CANARY.h) <= 4,
	limeBox === null ? 'no lime' : `${limeBox.w}x${limeBox.h} vs ${CANARY.w}x${CANARY.h}`
)
try {
	canary.kill()
} catch {}
if (lime < CANARY.w * CANARY.h * 0.5) {
	console.log(`\nENVIRONMENT: windows started from this process never reach the screen (canary x=${CANARY.x},${CANARY.y} up=${canaryUp}).`)
	console.log('Every pixel assertion below would be meaningless, so the frame arms are SKIPPED.')
	console.log(`\n1 PASS / 1 FAIL  (lab: ${LAB})`)
	process.exit(2)
}

/* ─────────────────── the KNOWN-CONTENT backdrop (R53) ───────────────────
 * The frame is placed on top of a window WE paint, so "is the interior still the old content?"
 * becomes "is the expected checkerboard colour still at this screen position?".
 * Topmost + foreground (AttachThreadInput first: the foreground lock refuses a plain
 * SetForegroundWindow) because sitting under a maximized DSH is the normal case here; the frame
 * is created afterwards, which puts it above this window.
 */
const BD_W = Math.min(400, Math.max(260, vw - 80))
const BD_H = Math.min(300, Math.max(220, vh - 80))
const BD = { x: 16, y: Math.max(8, vh - BD_H - 16), w: BD_W, h: BD_H }

let backdropChild = null
process.on('exit', () => {
	try {
		backdropChild?.kill()
	} catch {}
	try {
		frameChild?.kill()
	} catch {}
})

const bdInfo = path.join(LAB, 'backdrop.json')
try {
	fs.rmSync(bdInfo, { force: true })
} catch {}
const bdLog = fs.openSync(path.join(LAB, 'backdrop.log'), 'a')
backdropChild = spawn(
	shot.findPowershell(),
	[
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BACKDROP,
		'-X', String(BD.x), '-Y', String(BD.y), '-W', String(BD.w), '-H', String(BD.h),
		'-Cell', String(CELL), '-Seconds', '180', '-Info', bdInfo,
	],
	{ windowsHide: false, stdio: ['ignore', bdLog, bdLog] }
)
try {
	fs.closeSync(bdLog)
} catch {}
backdropChild.unref()

const bdUp = await waitForFile(bdInfo, 20_000)
let bd = null
try {
	bd = JSON.parse(fs.readFileSync(bdInfo, 'utf8'))
} catch {}
if (bdUp !== true || bd === null || bd.ok !== true) {
	console.log('')
	console.log('ENVIRONMENT: 棋盘夹具没起来（没等到 backdrop.json / ok=false）。')
	console.log('  => 下面的取景与像素判定都没有地面真值，全部作废 —— 这不是框的问题。')
	console.log(`\n1 PASS / 1 FAIL(env)  (lab: ${LAB})`)
	process.exit(2)
}
await sleep(400)

const bdRect = { x: Number(bd.x), y: Number(bd.y), w: Number(bd.w), h: Number(bd.h) }
const cell = Number(bd.cell) || CELL
REGION = { x: bdRect.x + Math.round((bdRect.w - RW) / 2), y: bdRect.y + Math.round((bdRect.h - RH) / 2), w: RW, h: RH }
CROP = { x: REGION.x - PAD, y: REGION.y - PAD, w: REGION.w + 2 * PAD, h: REGION.h + 2 * PAD }
console.log(
	`screen ${vw}x${vh} · backdrop ${bdRect.w}x${bdRect.h}@${bdRect.x},${bdRect.y} 格子 ${cell}px（dpi ${bd.dpi ?? '?'}）· region ${REGION.w}x${REGION.h}@${REGION.x},${REGION.y} · dpi mixed=${disp.mixedDpi} negativeOrigin=${disp.negativeOrigin}`
)

check(
	'backdrop fixture places itself exactly where it was asked (physical pixels)',
	bdRect.x === BD.x && bdRect.y === BD.y && bdRect.w === BD.w && bdRect.h === BD.h,
	`got ${bdRect.w}x${bdRect.h}@${bdRect.x},${bdRect.y} want ${BD.w}x${BD.h}@${BD.x},${BD.y}`
)

/** Expected colour at SCREEN position (sx,sy): the checkerboard is anchored at the backdrop's
 *  client origin, so the index is pure arithmetic -- no capture involved. */
function checkerAt(sx, sy) {
	const ix = Math.floor((sx - bdRect.x) / cell)
	const iy = Math.floor((sy - bdRect.y) / cell)
	return (ix + iy) % 2 === 1 ? LIGHT : DARK
}

/** Walk the interior (crop coordinates -> screen coordinates) and count how many pixels still
 *  carry the colour the checkerboard says they must have. */
function patternStats(image) {
	let ok = 0
	let total = 0
	for (let y = PAD + 2; y < PAD + REGION.h - 2; y++) {
		for (let x = PAD + 2; x < PAD + REGION.w - 2; x++) {
			const want = checkerAt(CROP.x + x, CROP.y + y)
			const got = image.at(x, y)
			total++
			if (Math.abs(got[0] - want[0]) <= 8 && Math.abs(got[1] - want[1]) <= 8 && Math.abs(got[2] - want[2]) <= 8) ok++
		}
	}
	return { ok, total, ratio: total === 0 ? 0 : ok / total }
}

/* The fixture itself has to be on screen before it can be a witness. Two different failures must
 * not collapse into one verdict: "the window never reached the screen" is the ENVIRONMENT (exit 2,
 * same class as the canary), while "the window is there but not the colours we computed" is our
 * own arithmetic being wrong -- that is a red to fix, not an environment to blame. */
const bdShot = await capture('backdrop')
const bdPat = patternStats(bdShot.img)
const checkerPx = countIn(bdShot.img, PAD, PAD, PAD + REGION.w, PAD + REGION.h, (c) => near(c, DARK, 10) || near(c, LIGHT, 10))
const bdVisible = checkerPx >= REGION.w * REGION.h * 0.9
check(
	'backdrop fixture shows its known checkerboard where the frame will go',
	bdVisible && bdPat.ratio >= 0.995,
	`${(bdPat.ratio * 100).toFixed(2)}% of ${bdPat.total} px match；棋盘色像素 ${checkerPx}/${REGION.w * REGION.h}`,
	bdVisible ? 'product' : 'env'
)
if (!bdVisible) {
	console.log('')
	console.log('ENVIRONMENT: 棋盘窗没上屏（它那块屏幕上不是棋盘色）—— 和 CANARY 同一类，先看窗口为什么被盖住。')
	console.log(`\n1 PASS / 1 FAIL(env)  (lab: ${LAB})`)
	process.exit(2)
}

/* ─────────────────── arm 1: the frame on screen ─────────────────── */

await sleep(300)
const before = await capture('before')
console.log(`before: ${before.img.width}x${before.img.height} · luma=${meanLuma(before.img).toFixed(1)}`)

const run1 = await startFrame('a')
frameChild = run1.child
/* WAIT FOR THE WINDOW, DO NOT SLEEP. A cold powershell.exe + Add-Type compile takes ~1.5-2.5s
 * here, so a fixed 1.6s sleep regularly captured the screen BEFORE the first paint -- the probe
 * then reported "border missing" about a frame that was drawn a moment later (measured: the
 * Info file and the red border both appeared ~2.2s after spawn). The form writes Info in Shown,
 * which is the earliest moment its geometry is real. */
const shown = await waitForFile(run1.info, 20_000)
check('frame process is up', frameChild.exitCode === null, `pid=${frameChild.pid} exit=${frameChild.exitCode}`)
await sleep(500)

/* The window's own account of where it is. "Not drawn" and "drawn 40px to the left" look the
 * same from the outside; this is the measurement that tells them apart. */
let frameInfo = null
try {
	frameInfo = JSON.parse(fs.readFileSync(run1.info, 'utf8'))
} catch {}
const wantRect = { x: REGION.x - THICK, y: REGION.y - THICK, w: REGION.w + 2 * THICK, h: REGION.h + 2 * THICK }
check(
	'frame reports its own geometry',
	frameInfo !== null &&
		Number(frameInfo.x) === wantRect.x &&
		Number(frameInfo.y) === wantRect.y &&
		Number(frameInfo.w) === wantRect.w &&
		Number(frameInfo.h) === wantRect.h,
	`got ${JSON.stringify(frameInfo)} want ${JSON.stringify(wantRect)}`
)

const on = await capture('on')
const img = on.img
check('capture size matches the requested crop', img.width === CROP.w && img.height === CROP.h, `${img.width}x${img.height} vs ${CROP.w}x${CROP.h}`)

/* A wider shot is saved on every run: when a pixel assertion fails, this is the picture that
 * says whether the frame is absent, displaced, or one bar short. */
await capture('wide', { x: CROP.x - 40, y: CROP.y - 40, w: CROP.w + 80, h: CROP.h + 80 })

const b = bands()
const isBorder = (c) => near(c, BORDER, 40)
const counts = {}
for (const [name, r] of Object.entries(b)) counts[name] = countIn(img, r[0], r[1], r[2], r[3], isBorder)
check(
	'border is drawn OUTSIDE the captured rect on all four sides',
	Object.values(counts).every((n) => n >= REGION.w * 0.6 || n >= REGION.h * 0.6),
	JSON.stringify(counts) + ` (need >=60% of each side)`
)
check(
	'no border pixel INSIDE the captured rect',
	countIn(img, PAD, PAD, PAD + REGION.w, PAD + REGION.h, isBorder) === 0,
	`inside=${countIn(img, PAD, PAD, PAD + REGION.w, PAD + REGION.h, isBorder)}`
)
const interiorLuma = meanLuma(img, PAD, PAD, PAD + REGION.w, PAD + REGION.h)
const keyPx = countIn(img, PAD, PAD, PAD + REGION.w, PAD + REGION.h, (c) => near(c, KEY, 24))
check('interior is NOT blacked out', interiorLuma > 15, `luma=${interiorLuma.toFixed(1)} (>15)`)
check('interior is NOT key-coloured (no TransparencyKey leak)', keyPx <= 2, `magenta px=${keyPx} (<=2)`)

/* the strongest statement, and since R53 it is deterministic: the interior still carries the
 * checkerboard the backdrop paints. Nothing about the desktop can influence this number. */
const pat = patternStats(img)

/* ─────────────────── arm 2: the stop file ─────────────────── */

fs.writeFileSync(run1.stop, 'stop', 'ascii')
const stopped = await waitExit(frameChild, 5000)
check('stop file closes the frame', stopped === true, `exit=${frameChild.exitCode} sig=${frameChild.signalCode}`)
if (!stopped) {
	try {
		frameChild.kill()
	} catch {}
	await sleep(500)
}

/* ─────────────────── POST：关框后再拍一张 ───────────────────
 * 判据换成"读回自己画的棋盘"——背景是我们自己的窗口，它不会因为别人在动画而变化，
 * 所以"内部变了"只可能是框画上去的。不再需要 env 三态：
 *   棋盘没上屏 → 上面已经 exit 2（环境）；棋盘上屏了却对不上 → 产品/夹具的真红。
 */
await sleep(700)
let afterImg = null
try {
	afterImg = (await capture('after')).img
} catch {}
const interiorRatio = interiorDiff(before.img, img).ratio
const patBefore = patternStats(before.img)
const patAfter = afterImg === null ? null : patternStats(afterImg)
check(
	'interior still shows the BACKDROP checkerboard (>=99.5% of pixels at the expected colour)',
	pat.ratio >= 0.995,
	`${(pat.ratio * 100).toFixed(2)}% of ${pat.total} px match` + (pat.ratio >= 0.995 ? '' : `；框没画上来时（before）是 ${(patBefore.ratio * 100).toFixed(2)}%`)
)
check(
	'interior is unchanged while the frame is up (>=95% pixels)',
	interiorRatio >= 0.95,
	`${(interiorRatio * 100).toFixed(2)}% unchanged of ${interiorDiff(before.img, img).total}`
)
check(
	'the backdrop is intact again after the frame closes',
	patAfter !== null && patAfter.ratio >= 0.995,
	patAfter === null ? 'no after-capture' : `${(patAfter.ratio * 100).toFixed(2)}% of ${patAfter.total} px match`
)

/* ─────────────────── arm 3: kill (the path recordStop uses) ─────────────────── */

const run2 = await startFrame('b')
frameChild = run2.child
await waitForFile(run2.info, 20_000)
const up2 = frameChild.exitCode === null
let killed = false
if (up2) {
	try {
		frameChild.kill()
	} catch {}
	killed = await waitExit(frameChild, 4000)
}
check('killing the process closes the frame', up2 && killed, `up=${up2} exit=${frameChild.exitCode}`)

/* ─────────────────── report ─────────────────── */

try {
	backdropChild.kill()
} catch {}
const fails = results.filter((r) => !r.ok).length
const productFails = results.filter((r) => !r.ok && r.env !== true).length
console.log(`\n${results.length - fails} PASS / ${fails} FAIL  (lab: ${LAB})`)
if (productFails > 0) process.exit(1)
if (envFails > 0) {
	console.log(`其中 ${envFails} 项是 env（环境挡住，见上面的 ENVIRONMENT 段）—— 不算产品回归，也不算通过。`)
	process.exit(2)
}

function meanLuma(image, x0 = 0, y0 = 0, x1 = image.width, y1 = image.height) {
	let sum = 0
	let n = 0
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const c = image.at(x, y)
			sum += 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
			n++
		}
	}
	return n === 0 ? 0 : sum / n
}

function interiorDiff(a, bb) {
	let same = 0
	let total = 0
	for (let y = PAD + 2; y < PAD + REGION.h - 2; y++) {
		for (let x = PAD + 2; x < PAD + REGION.w - 2; x++) {
			const p = a.at(x, y)
			const q = bb.at(x, y)
			total++
			if (Math.abs(p[0] - q[0]) <= 6 && Math.abs(p[1] - q[1]) <= 6 && Math.abs(p[2] - q[2]) <= 6) same++
		}
	}
	return { same, total, ratio: total === 0 ? 0 : same / total }
}
