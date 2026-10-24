// dev/longshot-probe.mjs -- R58: the long capture's OUTPUT, asserted from pixels.
//
// WHY THIS EXISTS: every probe we had stopped short of the product. `wheel-target` proves a
// posted WM_MOUSEWHEEL is accepted by a real app; `recframe`/`record-integrity` prove the
// recording frame and the encoded video. But the long screenshot -- the one feature whose whole
// point is a STITCHED picture -- had no automated assertion about that picture. A stitcher that
// repeats a frame, drops a frame, or seams at the wrong offset yields a plausible, tall, wrong
// image; "frames: 4, height: 1832" reads exactly the same as a correct run.
//
// WHAT IT PROVES (two arms, same fixture):
//   ARM A (auto)   the session drives the target itself: begin -> wheel posted to the leaf ->
//                  frames accumulate -> end -> the stitched PNG contains bands 1..N in order,
//                  each exactly once, seams uniform, height matching the known content height.
//   ARM B (manual) the DEFAULT mode: the session polls, fingerprints, waits for stability and
//                  commits only changed frames while an external actor scrolls the content to
//                  known offsets. Same pixel assertions on the result.
//   ARM C (negative) jumps farther than one frame -> the stitcher must refuse with an error,
//                  never emit a tall, plausible, wrong picture. (The first version of this probe
//                  measured exactly that failure: +479px of duplicated content, silently.)
//   ARM D (edge chrome) same auto session, but the fixture keeps its VERTICAL SCROLLBAR VISIBLE:
//                  the thumb moves between frames, which is the one piece of content-free chrome
//                  that used to break the overlap search (R58 measured 131/283 rows differing at
//                  the true shift). Proves the edge/margin handling added in R59.
//
// HOW IT KNOWS THE RIGHT ANSWER: dev/longshot-backdrop.ps1 paints N numbered bands, each a
// distinct colour, and reports its own per-band Y/height/colour in the Info JSON. So the probe
// can fold the stitched image into colour runs and name them: "row 0..63 = band 1, 64..127 =
// band 2, ...". Reading the bands back is the only check that can fail when the picture is wrong
// but the bookkeeping is right.
//
// MUST RUN FROM THE HOST (a window created in the sandboxed shell never reaches the interactive
// desktop, and posting to a medium-integrity app is refused):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/longshot-probe.mjs'})
//   shot_probe({probe:'longshot'})
//
// EXIT CODES (same convention as the other probes): 0 all green | 1 a real regression |
// 2 environment blocked it (fixture covered, wheel refused by the app) -- never read 2 as green.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = path.join('D:\\信息库\\AI工作区', '.tmp-shot-lab', 'longshot')
const BACKDROP = path.join(HERE, 'longshot-backdrop.ps1')
const INFO = path.join(LAB, 'fixture-info.json')
const FLOG = path.join(LAB, 'fixture.log')
const CONTROL = path.join(LAB, 'fixture-control.txt')
const ERRLOG = path.join(LAB, 'fixture-stderr.log')

/** The fixture's geometry. Big enough that 24 bands need >= 3 screens: more than one seam. */
const FX = 560
const FY = 120
const FW = 660
const FH = 520
const BANDS = 24
const SECONDS = 200

fs.mkdirSync(LAB, { recursive: true })
// Redirect BOTH the frame cache and the shots dir before anything imports them: the stitched
// result must not land in the user's real screenshot folder.
process.env.DSH_SHOT_CACHE = path.join(LAB, 'cache')

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const scroll = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'scrollsession.mjs')).href)
const { readPng } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'pixels.mjs')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let envFails = 0
function check(item, ok, detail, kind) {
	results.push({ item, ok: ok === true, env: kind === 'env' })
	if (kind === 'env' && ok !== true) envFails += 1
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

/* ─────────────────── fixture ─────────────────── */

let child = null
let errFd = -1
/**
 * @param {number} scrollbar 0 = hide the vertical scrollbar, 1 = keep it (edge-chrome arm)
 * @param {{fontPt?: number, rows?: number, animate?: number}} [opts]
 *   R60 `rows`: each band N lines tall -> a TALL page at a SMALL font (one notch only moves
 *   ~60 px there, so a fixed one-notch loop runs out of frames before the page ends).
 *   R61 `animate`: ms interval of a block that repaints in place INSIDE the region (video /
 *   spinner / clock) -- the case that used to be refused as "frames do not overlap".
 */
function startFixture(scrollbar = 0, opts = {}) {
	const fontPt = Number(opts.fontPt ?? 40)
	const rows = Number(opts.rows ?? 1)
	const animate = Number(opts.animate ?? 0)
	try { fs.rmSync(INFO, { force: true }) } catch {}
	try { fs.rmSync(FLOG, { force: true }) } catch {}
	try { fs.rmSync(CONTROL, { force: true }) } catch {}
	errFd = fs.openSync(ERRLOG, 'w')
	child = spawn(
		shot.findPowershell(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', BACKDROP,
			'-X', String(FX), '-Y', String(FY), '-W', String(FW), '-H', String(FH),
			'-Bands', String(BANDS), '-Seconds', String(SECONDS),
			'-Scrollbar', String(scrollbar),
			'-FontPt', String(fontPt), '-Rows', String(rows), '-Animate', String(animate),
			'-Log', FLOG, '-Info', INFO, '-Control', CONTROL,
		],
		{ windowsHide: false, stdio: ['ignore', errFd, errFd] }
	)
}

function fixtureLog() {
	try {
		return fs.readFileSync(FLOG, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => {
			try { return JSON.parse(l) } catch { return { ev: 'unparsed', raw: l } }
		})
	} catch { return [] }
}

function fixtureEventsAfter(n) {
	return fixtureLog().slice(n)
}

function scrollLines(events) {
	return events.filter((e) => e.ev === 'line').map((e) => Number(e.v))
}

/** Last first-visible-line the fixture reported (its own ground truth for scroll position). */
function lastVisibleLine() {
	const lines = scrollLines(fixtureLog())
	return lines.length === 0 ? null : lines[lines.length - 1]
}

function writeControl(text) {
	try { fs.writeFileSync(CONTROL, text, 'utf8') } catch {}
}

async function waitInfo(ms) {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		if (fs.existsSync(INFO)) {
			try {
				const j = JSON.parse(fs.readFileSync(INFO, 'utf8'))
				if (j && j.ok === true) return j
			} catch {}
		}
		if (child !== null && child.exitCode !== null) return null
		await sleep(150)
	}
	return null
}

/* ─────────────────── pixel reading ─────────────────── */

/**
 * Fold the stitched image into colour runs.
 *
 * The sample column is deliberately NOT the centre: the band label ("BAND 07") sits on the
 * left, and text anti-aliasing would make single rows unmatchable. The right-hand part of every
 * band is solid padding spaces, i.e. exactly one palette colour.
 */
function bandRuns(img, bands, column) {
	const pal = bands.map((b) => ({ i: Number(b.i), rgb: b.rgb.map(Number) }))
	const rows = []
	for (let y = 0; y < img.height; y++) {
		const c = img.at(column, y)
		let best = null
		let bestD = Infinity
		for (const p of pal) {
			const d = Math.abs(c[0] - p.rgb[0]) + Math.abs(c[1] - p.rgb[1]) + Math.abs(c[2] - p.rgb[2])
			if (d < bestD) { bestD = d; best = p }
		}
		rows.push(bestD <= 24 ? best.i : null)
	}
	const runs = []
	let cur = null
	for (let k = 0; k < rows.length; k++) {
		const v = rows[k]
		if (cur !== null && cur.band === v) {
			cur.n += 1
			cur.y1 = k
			continue
		}
		cur = { band: v, n: 1, y0: k, y1: k }
		runs.push(cur)
	}
	// A run shorter than 3 rows is a colour boundary artifact, not a band.
	const cleaned = runs.filter((r) => r.band !== null && r.n >= 3)
	const seq = []
	for (const r of cleaned) {
		if (seq.length === 0 || seq[seq.length - 1].band !== r.band) seq.push(r)
	}
	let lastBandRow = -1
	for (let y = rows.length - 1; y >= 0; y--) {
		if (rows[y] !== null) { lastBandRow = y; break }
	}
	let unknownMiddle = 0
	for (let y = 0; y <= lastBandRow; y++) if (rows[y] === null) unknownMiddle += 1
	const trailing = rows.length - (lastBandRow + 1)
	return { seq, cleaned, unknownMiddle, trailing, lastBandRow, rows }
}

/* ─────────────────── one arm's pixel verdict ─────────────────── */

function verify(name, out, info, bandCount, frameH) {
	console.log(`\n   [${name}] stitched: ${out.path}  (${out.width}x${out.height}, frames=${out.frames}, stopReason='${out.stopReason}')`)
	const img = readPng(out.path)
	const column = Math.max(20, Math.min(img.width - 20, Math.round(img.width * 0.62)))
	const { seq, cleaned, unknownMiddle, trailing, lastBandRow } = bandRuns(img, info.bands, column)
	const order = seq.map((r) => r.band)
	const distinct = [...new Set(order)]
	const stepAllPlusOne = order.length > 1 && order.every((b, k) => k === 0 || b === order[k - 1] + 1)
	const heights = cleaned.map((r) => r.y1 - r.y0 + 1)
	const lineH = Number(info.lineH) || 0
	const tol = Math.max(3, Math.round(lineH * 0.06))
	const heightOk = heights.every((h) => Math.abs(h - (Number(info.bands[0].h) || lineH)) <= tol)
	const maxH = heights.length > 0 ? Math.max(...heights) : 0
	const minH = heights.length > 0 ? Math.min(...heights) : 0

	check(`${name}: result exists and is mentioned in the response`, fs.existsSync(out.path) === true && out.id !== '', `id=${out.id}`)
	check(
		`${name}: the picture is the REGION width (nothing rescaled)`,
		Math.abs(img.width - FW) <= 1,
		`img=${img.width} region=${FW}`
	)
	check(
		`${name}: bands read back in order, each exactly once`,
		stepAllPlusOne && distinct.length === bandCount && order[0] === 1 && order[order.length - 1] === bandCount,
		`order=${order.slice(0, 8).join(',')}${order.length > 8 ? ',…' : ''} n=${order.length} distinct=${distinct.length}/${bandCount}`
	)
	check(
		`${name}: no duplicated / backtracked band (the classic seam bug)`,
		new Set(order).size === order.length && order.every((b, k) => k === 0 || b > order[k - 1]),
		`seen=${distinct.length}`
	)
	check(
		`${name}: every band is exactly its own height (seams land on the pixel, +-${tol}px)`,
		heightOk,
		`min=${minH} max=${maxH} band=${info.bands[0].h} runs=${cleaned.length}`
	)
	check(
		`${name}: no unknown rows in the middle of the picture`,
		unknownMiddle === 0,
		`unknown middle rows=${unknownMiddle} of ${img.height}`
	)
	check(
		`${name}: trailing blank is at most one frame (the region can scroll past the end)`,
		trailing <= frameH,
		`trailing=${trailing} frameH=${frameH}`
	)
	const expected = Number(info.totalH) || 0
	const contentEnd = lastBandRow + 1
	check(
		`${name}: the content ends where it really ends (no lost or doubled rows)`,
		expected > 0 && Math.abs(contentEnd - expected) <= 2,
		`contentEnd=${contentEnd} expected=${expected}`
	)
	return { img, order, distinct }
}

/* ─────────────────── run ─────────────────── */

const DONE_TIMEOUT_MS = 90000

async function waitDone(maxMs) {
	const t0 = Date.now()
	let last = null
	while (Date.now() - t0 < maxMs) {
		last = await scroll.scrollStatus()
		if (last.done === true) return last
		await sleep(250)
	}
	return last
}

/**
 * @param {string} name
 * @param {'auto'|'manual'} mode
 * @param {() => Promise<any>} drive
 * @param {{maxFrames?: number}} [opts] The frame cap this arm asks the session for. The 24-band
 *   arms only need ~8 frames, so they run with 14 to keep the probe short; the TALL arm (R60)
 *   must run with the product's own default (40), because the assertion is precisely "does it
 *   finish a 57-frame-at-one-notch page inside the real cap".
 */
async function runArm(name, mode, drive, opts = {}) {
	console.log(`\n--- ARM ${name} ---`)
	const marks = fixtureLog().length
	const maxFrames = Number(opts.maxFrames ?? 14)
	const begin = await scroll.scrollBegin(`${FX},${FY},${FW},${FH}`, { mode, maxFrames, settleMs: 320 })
	check(`${name}: begin accepted and claimed a target`, begin.ok === true && Number(begin.target) > 0, `target=${begin.target} '${begin.targetTitle ?? ''}' error='${begin.error ?? ''}'`)
	if (begin.ok !== true) return null
	if (typeof begin.active !== 'boolean') check(`${name}: begin reports active (client gates on it)`, false, 'missing field')
	const t0 = Date.now()
	const st = await drive()
	const stFinal = st && st.done === true ? st : await waitDone(DONE_TIMEOUT_MS)
	const lines = scrollLines(fixtureEventsAfter(marks))
	const advanced = lines.length > 0 && Math.max(...lines) > Math.min(...lines)
	check(
		`${name}: frames accumulated`, Number(stFinal?.frames) >= 3,
		`frames=${stFinal?.frames} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s wheelMode=${stFinal?.wheelMode} postedTo=${stFinal?.wheelPostedTo}`
	)
	check(
		`${name}: the fixture really scrolled (ground truth from its own control)`,
		advanced,
		`line events=${lines.length} range=${lines.length === 0 ? 'none' : `${Math.min(...lines)}..${Math.max(...lines)}`}`,
		advanced ? undefined : 'env'
	)
	const out = await scroll.scrollEnd()
	check(`${name}: end returned a stitched file`, out.ok === true && fs.existsSync(out.path) === true, `error='${out.error ?? ''}'`)
	if (out.ok !== true) return null
	const frameH = Number(stFinal?.height) || FH
	check(`${name}: the stitch is taller than one frame (it really stitched)`, out.height > frameH * 1.6, `h=${out.height} frameH=${frameH}`)
	return { out, stFinal }
}

function cleanupPng(p) {
	if (process.env.DSH_SHOT_KEEP === '1') return
	try { fs.rmSync(p, { force: true }) } catch {}
}

let info = null
let code = 0
try {
	startFixture()
	info = await waitInfo(20000)
	check('fixture window came up on the interactive desktop', info !== null, info === null ? 'no Info file (see fixture-stderr.log)' : `hwnd=${info.hwnd} rect=${info.x},${info.y},${info.w}x${info.h}`)
	if (info === null) throw new Error('fixture did not start')

	// The region must be fully on screen, otherwise the capture clips and the pixel verdict is
	// about the desktop, not about the stitcher.
	const disp = await shot.displays()
	const vw = Number(disp.virtual?.w) || 1920
	const vh = Number(disp.virtual?.h) || 1080
	check('fixture region is inside the virtual screen', info.x >= 0 && info.y >= 0 && info.x + info.w <= vw && info.y + info.h <= vh, `rect=${info.x},${info.y},${info.w}x${info.h} screen=${vw}x${vh}`, 'env')

	// Ownership: the session claims whatever top-level window owns the region centre. If that is
	// not our fixture, every later comparison is about some other window.
	const cx = Math.round(info.x + info.w / 2)
	const cy = Math.round(info.y + info.h / 2)
	const hit = await shot.hitTest(cx, cy)
	const mine = Number(hit.hwnd) === Number(info.hwnd)
	check('the window under the region centre is the fixture (not DSH, not another app)', mine, `hit=${hit.hwnd} '${hit.title ?? ''}' want=${info.hwnd}`, mine ? undefined : 'env')
	if (!mine) {
		// Measured (R59): with the desktop LOCKED the lock screen owns every point, the wheel is
		// posted to it, the fixture never scrolls -- and the run then burns 7 minutes printing a
		// pile of FAILs that all say the same thing. Say it once, say it loudly, exit env=2.
		console.log(
			`   ABORT  the region is covered by hwnd ${hit.hwnd} '${hit.title ?? ''}'.\n` +
			'          Locked screen / screensaver / another always-on-top window? Unlock and re-run.\n' +
			'          (Every pixel verdict below would be about that window, not the stitcher.)'
		)
		writeControl('q')
		await sleep(300)
		try { if (child !== null) child.kill() } catch {}
		try { if (errFd >= 0) fs.closeSync(errFd) } catch {}
		try { await scroll.scrollCancel() } catch {}
		console.log(`\nlongshot: aborted early (${results.filter((r) => r.ok).length} PASS so far) -- environment, not a product verdict`)
		process.exit(2)
	}

	// ─────────── ARM A: auto ───────────
	const a = await runArm('auto', 'auto', async () => await waitDone(DONE_TIMEOUT_MS))
	if (a !== null) verify('auto', a.out, info, BANDS, FH)

	// ─────────── ARM B: manual (the default mode) ───────────
	console.log('\n--- ARM manual ---')
	writeControl('top')
	await sleep(500)
	const steps = [0, 5, 10, 15, 19, 23]
	const b = await runArm('manual', 'manual', async () => {
		let st = await scroll.scrollStatus()
		for (const at of steps) {
			if (st.done === true) break
			writeControl(`scrollto ${at}`)
			// settleMs is 320: one change + two stable grabs take ~1s. Give it 1.4s.
			await sleep(1400)
			st = await scroll.scrollStatus()
			console.log(`      scrollto ${at} -> frames=${st.frames} h=${st.height} stalled=${st.stalled}`)
		}
		return st
	})
	if (b !== null) verify('manual', b.out, info, BANDS, FH)

	// ─────────── ARM C (negative): too far to overlap must FAIL LOUDLY ───────────
	// The first version of the stitcher searched for "the best overlap" and used it even when
	// there was none: the result was a tall, plausible, WRONG picture (this probe measured
	// +479px of duplicated content). So the honest-failure contract is part of the feature and
	// gets its own arm: jump farther than one frame height and the session must refuse.
	console.log('\n--- ARM C (negative): jump farther than one frame ---')
	writeControl('top')
	await sleep(1200)
	const lineBefore = lastVisibleLine()
	const beginC = await scroll.scrollBegin(`${FX},${FY},${FW},${FH}`, { mode: 'manual', maxFrames: 6, settleMs: 300 })
	if (beginC.ok === true) {
		await sleep(700)
		writeControl(`scrollto ${BANDS - 1}`)
		await sleep(1600)
		const stC = await scroll.scrollStatus()
		const lineAfter = lastVisibleLine()
		const moved = lineBefore !== null && lineAfter !== null && lineAfter !== lineBefore
		check(
			'negative: the two frames really do not overlap (fixture jumped)',
			Number(stC.frames) >= 2 && moved,
			`frames=${stC.frames} line ${lineBefore} -> ${lineAfter}`,
			moved ? undefined : 'env'
		)
		const outC = await scroll.scrollEnd()
		check(
			'negative: says so instead of stitching a wrong picture',
			outC.ok === false && /overlap/i.test(String(outC.error ?? '')),
			`ok=${outC.ok} error='${outC.error ?? ''}'`
		)
		check('negative: produced no file', outC.ok === false && String(outC.path ?? '') === '', `path='${outC.path ?? ''}'`)
		await scroll.scrollCancel()
	}

	if (a !== null) cleanupPng(a.out.path)
	if (b !== null) cleanupPng(b.out.path)

	// ─────────── ARM D: a VISIBLE scrollbar (edge chrome) ───────────
	// The stitcher's overlap search used to include the outer columns, and a scrollbar THUMB
	// moves between frames: measured R58 -> at the true shift 131 of 283 rows still differed,
	// and the coarse match picked 475 px for a pair that moved 237 px. R59 drops the edge from
	// both passes and scores on the closest 90 % of pixels; this arm is what proves it, with
	// the scrollbar VISIBLE instead of hidden.
	console.log('\n--- ARM D: scrolling with a VISIBLE scrollbar (edge chrome) ---')
	try { if (child !== null) child.kill() } catch {}
	await sleep(600)
	startFixture(1)
	const infoD = await waitInfo(20000)
	check(
		'fixture restarted with its scrollbar visible',
		infoD !== null && Number(infoD.scrollbar) === 1,
		infoD === null ? 'no Info file' : `scrollbar=${infoD.scrollbar}`
	)
	if (infoD !== null) {
		const hitD = await shot.hitTest(Math.round(infoD.x + infoD.w / 2), Math.round(infoD.y + infoD.h / 2))
		const mineD = Number(hitD.hwnd) === Number(infoD.hwnd)
		check(
			'the fixture is still the window under the region centre',
			mineD,
			`hit=${hitD.hwnd} '${hitD.title ?? ''}' want=${infoD.hwnd}`,
			mineD ? undefined : 'env'
		)
		if (!mineD) {
			console.log('   SKIP   scrolling-with-scrollbar arm: something else is on top of the region')
		} else {
			const d = await runArm('scrollbar', 'auto', async () => await waitDone(DONE_TIMEOUT_MS))
			if (d !== null) {
				verify('scrollbar', d.out, infoD, BANDS, FH)
				cleanupPng(d.out.path)
			}
		}
	}

	/* ─────────── ARM E (R60): a TALL page at a SMALL font ───────────
	 * FontPt 10 -> line height 20 px -> ONE wheel notch (3 lines) moves 60 px. With `-Rows 8`
	 * every band is 8 lines = 160 px tall, so the page is 24 x 160 = **3840 px**, i.e. 57 frames
	 * at one notch per frame -- more than MAX_FRAMES (40). Measured before the fix: the session
	 * stopped at 40 frames with 2880 px of picture and **stopReason ''**, i.e. a silently
	 * truncated long screenshot. The fix measures the real shift after each frame and raises the
	 * step to ~45 % of the region height (here 3 notches = 180 px), so the same page finishes in
	 * ~18 frames. This arm asserts both halves: it reached the end, and it did so by adapting.
	 */
	console.log('\n--- ARM tall: 3840 px page at a small font (the frame cap used to cut it silently) ---')
	try { if (child !== null) child.kill() } catch {}
	await sleep(600)
	startFixture(0, { fontPt: 10, rows: 8 })
	const infoE = await waitInfo(20000)
	const totalE = Number(infoE?.totalH ?? 0)
	const bandHE = Number(infoE?.bands?.[0]?.h ?? 0)
	check(
		'tall fixture is really 3840 px tall (57 frames at one notch, more than the 40-frame cap)',
		infoE !== null && totalE >= 3700 && bandHE === 160,
		infoE === null ? 'no Info file' : `totalH=${totalE} bandH=${bandHE} lineH=${infoE.lineH}`
	)
	if (infoE !== null) {
		const hitE = await shot.hitTest(Math.round(infoE.x + infoE.w / 2), Math.round(infoE.y + infoE.h / 2))
		const mineE = Number(hitE.hwnd) === Number(infoE.hwnd)
		check(
			'the tall fixture is the window under the region centre',
			mineE,
			`hit=${hitE.hwnd} '${hitE.title ?? ''}' want=${infoE.hwnd}`,
			mineE ? undefined : 'env'
		)
		if (!mineE) {
			console.log('   SKIP   tall-page arm: something else is on top of the region')
		} else {
			const e = await runArm('tall', 'auto', async () => await waitDone(DONE_TIMEOUT_MS), { maxFrames: 40 })
			if (e !== null) {
				// 先判"没被截断"，再判内容本身 —— 否则高度不够时报出来的是七八条色带错位，
				// 看起来像拼接器坏了，真正的原因却是"根本没抓完"。
				check(
					'tall: the session did not hit the frame cap (no silent truncation)',
					String(e.out.stopReason ?? '') !== 'max-frames' && Number(e.out.frames) < 40,
					`frames=${e.out.frames} stopReason='${e.out.stopReason ?? ''}'`
				)
				check(
					'tall: the step adapted beyond one notch',
					Number(e.out.notches) >= 2,
					`notches=${e.out.notches} lastShiftPx=${e.out.lastShiftPx}`
				)
				verify('tall', e.out, infoE, BANDS, FH)
				cleanupPng(e.out.path)
			}
		}
	}

	/* ─────────── ARM F (R61): something INSIDE the region animates ───────────
	 * The last known nuisance: a video / spinner / clock that stays at a fixed SCREEN position
	 * while the content scrolls under it. Measured before the fix: the stitcher refused the whole
	 * capture ("frames 1 and 2 do not overlap, residual 12.60 > 8.00") even though ~92 % of the
	 * picture matched, and the auto loop never saw "the page stopped" because the whole-frame
	 * fingerprint kept changing. Now the score trims the worst rows (an animated band cannot
	 * poison it) and the loop's bottom test is "how much of the picture changed", not "are the
	 * pixels identical". Both halves are asserted here.
	 */
	console.log('\n--- ARM animated: a 220x130 block repainting inside the region ---')
	try { if (child !== null) child.kill() } catch {}
	await sleep(600)
	startFixture(0, { animate: 90 })
	const infoF = await waitInfo(20000)
	check(
		'animated fixture is really animating (its block repaints every 90 ms)',
		infoF !== null && Number(infoF.animate) === 90,
		infoF === null ? 'no Info file' : `animate=${infoF.animate}`
	)
	if (infoF !== null) {
		const hitF = await shot.hitTest(Math.round(infoF.x + infoF.w / 2), Math.round(infoF.y + infoF.h / 2))
		const mineF = Number(hitF.hwnd) === Number(infoF.hwnd)
		check(
			'the animated fixture is the window under the region centre',
			mineF,
			`hit=${hitF.hwnd} '${hitF.title ?? ''}' want=${infoF.hwnd}`,
			mineF ? undefined : 'env'
		)
		if (!mineF) {
			console.log('   SKIP   animated arm: something else is on top of the region')
		} else {
			const f = await runArm('animated', 'auto', async () => await waitDone(DONE_TIMEOUT_MS), { maxFrames: 14 })
			if (f !== null) {
				verify('animated', f.out, infoF, BANDS, FH)
				// R61 的诚实边界：区域里那块东西一直在动时，循环**认不出"到底"**（整帧永远在变），
				// 它会走到帧数上限并如实报 max-frames；拼接器把那几帧重复的尾巴跳掉，成品仍完整。
				// 所以这里断言的是"如实报"，不是"提前收"。
				const capped = Number(f.out.frames) >= 14
				check(
					'animated: a capped session says so (max-frames), it never pretends to have reached the bottom',
					!capped || String(f.out.stopReason ?? '') === 'max-frames',
					`frames=${f.out.frames} stopReason='${f.out.stopReason ?? ''}'`
				)
				check(
					'animated: the duplicate tail was skipped, not stitched in',
					Number(f.out.frames) > 8 && f.out.ok === true,
					`frames=${f.out.frames} ok=${f.out.ok}`
				)
				cleanupPng(f.out.path)
			}
		}
	}
} catch (error) {
	console.log(`   FAIL  probe crashed: ${String(error?.message ?? error)}`)
	results.push({ item: 'probe crashed', ok: false })
} finally {
	writeControl('q')
	await sleep(400)
	try { if (child !== null) child.kill() } catch {}
	try { if (errFd >= 0) fs.closeSync(errFd) } catch {}
	try { await scroll.scrollCancel() } catch {}
}

const pass = results.filter((r) => r.ok).length
const realFail = results.filter((r) => r.ok !== true && r.env !== true).length
const fail = results.length - pass
console.log(`\nlongshot: ${pass} PASS / ${fail} FAIL${envFails > 0 ? ` (${envFails} env-blocked)` : ''}  (lab: ${LAB})`)
process.exit(realFail > 0 ? 1 : envFails > 0 ? 2 : 0)
