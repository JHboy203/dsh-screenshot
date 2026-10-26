// dev/record-integrity-probe.mjs -- R56: the RECORDED FILE is the deliverable, so check the file.
// args: (none)
//
// Everything about the recording frame used to be verified on the SCREEN: "the frame is drawn
// outside the captured rect", "the interior is untouched". The promise the user cares about lives
// in the FILE: "the red frame never shows up in the video", "the framed area is recorded as it is".
// 2026-10-24 (R55) proved how thin that inference is -- re-asserting the frame with SWP_SHOWWINDOW
// dimmed the framed area by 17%, a defect that exists only in the file, never on a paused screen.
//
// What it does: paints the known checkerboard backdrop, records a 120x90 patch of it for ~2.5 s,
// extracts a frame from the resulting mp4 (exactly what the result panel does), and judges THAT
// frame's pixels. H.264 is lossy, so the checks are tolerant: no red, brightness within 8 % of the
// subject, and both tones still present.
//
// RUN FROM THE HOST (it starts windows and spawns ffmpeg):
//   shot_probe({probe:'record-integrity'})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/record-integrity-probe.mjs'})
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lab } from './labpath.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = lab('record-integrity')
fs.mkdirSync(LAB, { recursive: true })
// CACHE_DIR is read at import time, so this has to happen before the module is loaded.
process.env.DSH_SHOT_CACHE = path.join(LAB, 'cache')

const { readPng } = await import(pathToFileURL(path.join(HERE, 'png.mjs')).href)
const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DARK = [30, 36, 48]
const LIGHT = [216, 222, 233]
/** Checkerboard painted by dev/recframe-backdrop.ps1 (same fixture the frame probe uses). */
const BD = { x: 16, y: 764, w: 400, h: 300 }
const RW = 120
const RH = 90

const results = []
function check(name, ok, extra) {
	results.push({ name, ok: ok === true })
	console.log(`   ${ok === true ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + extra}`)
}
/** Console is GBK: keep every byte ASCII. */
const ascii = (s) => String(typeof s === 'string' ? s : JSON.stringify(s)).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

const bdInfo = path.join(LAB, 'bd.json')
try {
	fs.rmSync(bdInfo, { force: true })
} catch {}
const bdChild = spawn(
	shot.findPowershell(),
	['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'recframe-backdrop.ps1'), '-X', String(BD.x), '-Y', String(BD.y), '-W', String(BD.w), '-H', String(BD.h), '-Cell', '30', '-Seconds', '120', '-Info', bdInfo],
	{ windowsHide: false, stdio: 'ignore' }
)
process.on('exit', () => {
	try {
		bdChild.kill()
	} catch {}
})
let bd = null
for (let i = 0; i < 200 && bd === null; i++) {
	await sleep(100)
	try {
		bd = JSON.parse(fs.readFileSync(bdInfo, 'utf8'))
	} catch {}
}
check(
	'checkerboard backdrop is up (the recording needs a subject whose pixels we know)',
	bd !== null && bd.ok === true,
	bd === null ? 'no Info file' : ascii({ x: bd.x, y: bd.y, w: bd.w, h: bd.h, cell: bd.cell })
)
if (bd === null || bd.ok !== true) {
	console.log('\nENVIRONMENT: the fixture did not come up -- nothing to record, nothing to judge.')
	console.log(`\n1 PASS / 1 FAIL(env)  (lab: ${LAB})`)
	process.exit(2)
}
await sleep(400)

const bdRect = { x: Number(bd.x), y: Number(bd.y), w: Number(bd.w), h: Number(bd.h) }
const cell = Number(bd.cell) || 30
/** Expected colour at SCREEN position, straight from the fixture's geometry. */
const want = (sx, sy) => {
	const ix = Math.floor((sx - bdRect.x) / cell)
	const iy = Math.floor((sy - bdRect.y) / cell)
	return (ix + iy) % 2 === 1 ? LIGHT : DARK
}
/** Fraction of a capture that still carries the colour the checkerboard says it must have. */
function matchRatio(img, originScreen) {
	let ok = 0
	let total = 0
	for (let y = 2; y < img.height - 2; y++) {
		for (let x = 2; x < img.width - 2; x++) {
			const w = want(originScreen.x + x, originScreen.y + y)
			const c = img.at(x, y)
			total++
			if (Math.abs(c[0] - w[0]) <= 8 && Math.abs(c[1] - w[1]) <= 8 && Math.abs(c[2] - w[2]) <= 8) ok++
		}
	}
	return total === 0 ? 0 : ok / total
}

/* Pick the patch to record. Same lesson as the frame probe: other windows (including click-through
 * overlays) may sit on the fixture, so only record a patch that reads back as our own pattern. */
const cands = [
	{ x: Math.round((bdRect.w - RW) / 2), y: Math.round((bdRect.h - RH) / 2) },
	{ x: 10, y: 10 },
	{ x: bdRect.w - RW - 10, y: 10 },
	{ x: 10, y: bdRect.h - RH - 10 },
	{ x: bdRect.w - RW - 10, y: bdRect.h - RH - 10 },
]
let REG = null
let preRatio = 0
for (const c of cands) {
	const cap = await shot.capture({ rect: `${bdRect.x + c.x},${bdRect.y + c.y},${RW},${RH}` })
	if (cap.ok !== true || !cap.path) continue
	let img = null
	try {
		img = readPng(cap.path)
	} catch {
		continue
	}
	const r = matchRatio(img, { x: bdRect.x + c.x, y: bdRect.y + c.y })
	if (r >= 0.995) {
		REG = { x: bdRect.x + c.x, y: bdRect.y + c.y, w: RW, h: RH }
		preRatio = r
		break
	}
}
check(
	'found a 120x90 patch of the backdrop that is clean BEFORE recording',
	REG !== null,
	REG === null ? 'no clean patch (someone is covering the fixture)' : `${(preRatio * 100).toFixed(2)}% at ${REG.x},${REG.y}`
)
if (REG === null) {
	console.log('\nENVIRONMENT: nothing clean to record -- move whatever covers the fixture and re-run.')
	console.log(`\n1 PASS / 1 FAIL(env)  (lab: ${LAB})`)
	process.exit(2)
}

/* Record it. This draws the real frame window, exactly like a user recording. */
const started = await shot.recordStart({ fps: 10, region: `${REG.x},${REG.y},${REG.w},${REG.h}`, audio: false })
check(
	'recordStart is real (file path + frame drawn)',
	started.ok === true && String(started.path) !== '' && started.frame === true,
	ascii({ ok: started.ok, frame: started.frame, via: started.via, error: started.error })
)
await sleep(2500)
const stopped = await shot.recordStop()
check(
	'recordStop produced a playable file (bytes > 0, duration > 0.5 s)',
	stopped.ok === true && stopped.bytes > 0 && Number(stopped.duration) > 0.5,
	ascii({ ok: stopped.ok, bytes: stopped.bytes, duration: stopped.duration })
)

/* Extract a frame -- the same call the result panel makes, so a broken path shows up here too. */
const outPng = path.join(LAB, 'frame.png')
try {
	fs.rmSync(outPng, { force: true })
} catch {}
const at = Math.min(1.2, Math.max(0.2, Number(stopped.duration) / 2))
const fr = await shot.recAction('frame', { file: stopped.path, time: at, out: outPng }, 60_000)
check(
	'a frame can be extracted from the mp4 (the result panel does exactly this)',
	fr.ok === true && fs.existsSync(outPng) && Number(fr.width) > 0,
	ascii({ ok: fr.ok, w: fr.width, h: fr.height, at, error: fr.error })
)

let img = null
try {
	img = readPng(outPng)
} catch {}
check('the extracted frame has the recorded size', img !== null && img.width === RW && img.height === RH, img === null ? 'no png' : `${img.width}x${img.height} vs ${RW}x${RH}`)

if (img !== null) {
	/* 1. The red frame must NEVER appear in the file. This is the promise the geometry only implies:
	 *    the border is drawn outside the capture rect, so a rounding error or a 1 px overlap would
	 *    ship red pixels into the video and nothing else would notice. */
	let red = 0
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const c = img.at(x, y)
			if (c[0] > 150 && c[1] < 120 && c[2] < 120) red++
		}
	}
	check('NO frame pixels inside the recorded video (red border really stays outside)', red <= 2, `red px=${red}`)

	/* 2. Brightness: the R55 dim was 17 % -- on screen it was invisible unless you compared two
	 *    captures, but in the file it would be the whole recording. Compare against the subject. */
	let sum = 0
	let wantSum = 0
	let darkN = 0
	let lightN = 0
	let n = 0
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const c = img.at(x, y)
			const w = want(REG.x + x, REG.y + y)
			sum += 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
			wantSum += 0.299 * w[0] + 0.587 * w[1] + 0.114 * w[2]
			const dD = Math.abs(c[0] - DARK[0]) + Math.abs(c[1] - DARK[1]) + Math.abs(c[2] - DARK[2])
			const dL = Math.abs(c[0] - LIGHT[0]) + Math.abs(c[1] - LIGHT[1]) + Math.abs(c[2] - LIGHT[2])
			if (dD < dL) darkN++
			else lightN++
			n++
		}
	}
	const luma = sum / n
	const wantLuma = wantSum / n
	check(
		'recorded brightness is the subject, not a dimmed copy (within 8 %)',
		Math.abs(luma - wantLuma) <= wantLuma * 0.08,
		`luma=${luma.toFixed(1)} want=${wantLuma.toFixed(1)} (${((luma / wantLuma - 1) * 100).toFixed(1)}%)`
	)
	check(
		'the file carries the two-tone subject (neither tone swallowed by the encoder)',
		darkN / n > 0.3 && lightN / n > 0.3,
		`dark=${((darkN / n) * 100).toFixed(1)}% light=${((lightN / n) * 100).toFixed(1)}%`
	)
}

try {
	bdChild.kill()
} catch {}
try {
	fs.rmSync(path.join(stopped.path || ''), { force: true })
} catch {}

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`record-integrity: ${pass} PASS / ${fail} FAIL  (lab: ${LAB})`)
process.exit(fail === 0 ? 0 : 1)
