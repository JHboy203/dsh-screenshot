// dev/recframe-probe.mjs -- R32 regression for the "recording frame" (ps/recframe.ps1).
//
// WHAT IT PROVES, and why none of it can be asserted from geometry alone:
//   1. the frame really appears on the screen  (a window that reports Visible=true and paints
//      nothing is exactly the failure this probe was written after -- see the note below)
//   2. the border sits OUTSIDE the captured rect   -> not one frame pixel lands in the video
//   3. the INTERIOR is transparent (desktop content preserved), not blacked out
//   4. the interior is NOT key-coloured (a TransparencyKey leak would look like a magenta slab)
//   5. the stop file closes it, and killing the process also closes it (both paths are used)
//
// HOW TO RUN (must be the HOST context -- a window created from the sandboxed shell never reaches
// the interactive desktop, so the capture sees a bare wall and every pixel assertion fails):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/recframe-probe.mjs'})
//
// WHY PIXELS: the first version of this probe only checked "the process is alive" and "a window
// with that pid is visible". Both were true while the screen showed nothing at all -- the window
// was created on a non-interactive desktop. Visibility is not the property we care about; the
// property is "these pixels are on the user's screen, and they are not inside the video".
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
const THICK = 3
/** Border colour used by ps/recframe.ps1 (Color.FromArgb(255, 235, 64, 52)). */
const BORDER = [235, 64, 52]
/** TransparencyKey used by ps/recframe.ps1. */
const KEY = [255, 0, 255]

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(item, ok, detail) {
	results.push({ item, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

fs.mkdirSync(LAB, { recursive: true })

/* ─────────────────── where to put it ─────────────────── */

/**
 * A desktop spot the frame can own. It is intentionally in the lower-right corner: that area is
 * wallpaper on every layout we have seen, so the "interior did not change" comparison is not
 * fighting a playing video. It does NOT need to be uncovered -- the frame is topmost, and the
 * interior comparison tolerates nothing moving, which is why a static patch is chosen.
 */
const disp = await shot.displays()
const vw = Number(disp.virtual?.w) || 1920
const vh = Number(disp.virtual?.h) || 1080
const REGION = { x: vw - 240, y: vh - 320, w: 160, h: 110 }
const PAD = 8
const CROP = { x: REGION.x - PAD, y: REGION.y - PAD, w: REGION.w + 2 * PAD, h: REGION.h + 2 * PAD }
console.log(`screen ${vw}x${vh} · region ${REGION.w}x${REGION.h}@${REGION.x},${REGION.y} · dpi mixed=${disp.mixedDpi} negativeOrigin=${disp.negativeOrigin}`)

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

/** Bounding box of the pixels matching `test`, or null. Lets a probe say "drawn at 192x96" --
 *  the signature of a DPI-virtualised window -- instead of only "some pixels". */
function bboxOf(img, test) {
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -1
	let y1 = -1
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (!test(img.at(x, y))) continue
			if (x < x0) x0 = x
			if (y < y0) y0 = y
			if (x > x1) x1 = x
			if (y > y1) y1 = y
		}
	}
	if (x1 < 0) return null
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
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
let canaryUp = false
for (let i = 0; i < 60 && !canaryUp; i++) {
	await sleep(100)
	try {
		canaryUp = fs.readFileSync(canaryInfo, 'utf8').trim().startsWith('{')
	} catch {}
}
await sleep(400)
const canaryShot = await capture('canary', CANARY_CROP)
const lime = countIn(canaryShot.img, 0, 0, canaryShot.img.width, canaryShot.img.height, (c) => c[1] > 180 && c[0] < 120 && c[2] < 120)
/** The bbox matters as much as the count: a window drawn at 0.8 scale is DPI-virtualised, and
 *  that silently moves every frame too. */
const limeBox = bboxOf(canaryShot.img, (c) => c[1] > 180 && c[0] < 120 && c[2] < 120)
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

/* the strongest statement: the interior still shows what was there before the frame appeared */
const diff = interiorDiff(before.img, img)
check(
	'interior still shows the desktop (>=95% pixels unchanged)',
	diff.same / diff.total >= 0.95,
	`${((diff.same / diff.total) * 100).toFixed(1)}% unchanged of ${diff.total}`
)

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

const fails = results.filter((r) => !r.ok).length
console.log(`\n${results.length - fails} PASS / ${fails} FAIL  (lab: ${LAB})`)
if (fails > 0) process.exit(1)

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
	return { same, total }
}
