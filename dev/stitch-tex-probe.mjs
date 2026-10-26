// dev/stitch-tex-probe.mjs -- R63: does the stitcher land every seam on DENSE REAL page texture?
//
// WHY THIS EXISTS
//   Every stitcher test before R63 used colour bands (dev/longshot-backdrop.ps1 and the synthetic
//   cases in py/stitch.py's header). Bands carry no ink on most rows: the overlap landscape is
//   smooth, a seam off by a few pixels still scores ~0, and the R61 "robust" fallback looks fine.
//   Real pages are dense anti-aliased text, where the residual rises everywhere and the search has
//   to pick the right minimum among many similar ones. R63 took the band fixture's claim and
//   replayed it on genuine texture; this probe keeps that replay runnable.
//
// HOW (dev/texreplay.py builds the fixture, this file drives it)
//   1. one REAL capture of this desktop (dense UI, genuine font AA) -> screen.png;
//   2. texreplay builds a long page out of it and cuts KNOWN frames (exact ground truth);
//   3. py/stitch.py stitches those frames exactly as the product does;
//   4. texreplay compares the result with the page PIXEL BY PIXEL.
//
//   scroll  plain scrolling        -> every offset exact, no fallback needed, output pixel-identical
//   anim    a 220x130 block repaints every frame at a fixed screen position
//                                 -> every offset still exact, the structural fallback carries it,
//                                    and everything OUTSIDE the block's columns is pixel-identical
//   dup     like anim + one frame where nothing scrolled -> that frame is skipped (offset 0)
//   gap     two frames farther apart than one frame height -> refused (exit 3, no output file)
//   tight   scroll, but the overlap is only 25 % of the frame (R65)
//                                 -> still every offset exact; a repeated band on the page must not
//                                    win over the widest exact candidate
//   tightanim  a narrow overlap AND the block repainting inside the overlapping band (R65)
//                                 -> refused (exit 3, no output file): no evidence left, never guess
//
// RUN IT FROM THE HOST (it spawns python + captures the screen):
//   shot_probe({probe:'stitch-tex'})        or
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/stitch-tex-probe.mjs'})
//
// Exit: 0 all pass / 1 fail / 2 env (no capture, no python, or the screen has no dense texture --
// e.g. locked desktop, everything minimized; texreplay reports flat-source for that).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lab } from './labpath.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = lab('stitch-tex-probe')

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const { capture, findPython, hitTest, lastJsonLine, run } = shot

const PY = path.join(PLUGIN, 'py', 'stitch.py')
const REPLAY = path.join(HERE, 'texreplay.py')
const SHIFT = 237
const FRAMES = 10

const results = []
function check(name, ok, extra) {
	results.push({ name, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`)
}
function envBlocked(why, extra = {}) {
	console.log(`   SKIP  ${why}  ${JSON.stringify(extra)}`)
	const pass = results.filter((r) => r.ok).length
	const fail = results.length - pass
	console.log(`stitch-tex: ${pass} PASS / ${fail} FAIL (env-blocked: ${why})`)
	process.exit(2)
}

if (!fs.existsSync(LAB)) fs.mkdirSync(LAB, { recursive: true })

const py = findPython()
if (!py) envBlocked('python not found', {})

/** Run one python script and return { code, json, stderr }. */
async function py3(script, args, timeoutMs = 120_000) {
	const res = await run(py, [script, ...args], { timeoutMs })
	const json = lastJsonLine(res.stdout)
	return { code: res.code, json, stderr: res.stderr.trim(), out: res.stdout }
}

// 1. A real capture is the whole point: the fixture's texture must be genuine, not painted.
//    Two ways this environment can lie to us, both measured:
//      * a LOCKED session: CopyFromScreen fails or returns the logon screen, and every window
//        probe on this machine goes red at the same time (UIPI drops clicks, fixtures never appear).
//        Ask Windows what is at the centre point -- the logon window is named for it.
//      * a screen without distinct content: the slices end up being the same wallpaper, the page
//        becomes near-repeating and the stitcher correctly calls the frames duplicates. That is
//        not a stitcher regression, so texreplay gates it (repetitive-source) and we exit 2.
const probe = await hitTest(1200, 540)
if (probe && /LockScreen|LogonUI|Secure Desktop/i.test(`${probe.class} ${probe.title}`)) {
	envBlocked('the Windows session is locked (logon screen at the centre point)', { class: probe.class, title: probe.title })
}
const cap = await capture({ mode: 'desktop', noRestore: true })
if (!cap || cap.ok !== true || !cap.path || !fs.existsSync(cap.path)) {
	envBlocked('screen capture failed', { error: cap && cap.error })
}
const screen = path.join(LAB, 'screen.png')
fs.copyFileSync(cap.path, screen)
check('a real screen capture is the texture source', fs.statSync(screen).size > 100_000, { bytes: fs.statSync(screen).size, screen: [cap.width, cap.height] })

/** Build one replay mode's fixture and stitch it. Returns { truth, result, outFile, dir }. */
async function arm(mode, opts = {}) {
	const shift = Number(opts.shift ?? SHIFT)
	const frames = Number(opts.frames ?? FRAMES)
	const height = Number(opts.height ?? 520)
	const dir = path.join(LAB, opts.dir ?? mode)
	const extra = []
	if (opts.patchY !== undefined) extra.push('--patch-y', String(opts.patchY))
	const build = await py3(REPLAY, ['build', '--src', screen, '--out', dir, '--mode', mode, '--frames', String(frames), '--shift', String(shift), '--height', String(height), ...extra])
	if (build.code === 4 && build.json && build.json.error === 'flat-source') {
		envBlocked('the screen has no dense texture right now', build.json)
	}
	if (build.code === 4 && build.json && build.json.error === 'repetitive-source') {
		envBlocked('the screen has no DISTINCT texture right now (slices are the same picture)', build.json)
	}
	if (build.code !== 0 || !build.json || build.json.ok !== true) {
		check(`${mode}: fixture built`, false, { code: build.code, error: build.json && build.json.error, stderr: build.stderr.slice(0, 300) })
		return { truth: null, result: null, outFile: null }
	}
	const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'))
	check(`${mode}: fixture built from real texture`, truth.frames.length === (mode === 'gap' ? 2 : frames) && truth.density >= 120, { frames: truth.frames.length, width: truth.width, slices: truth.slices, density: truth.density, shift: truth.shift })
	const outFile = path.join(dir, 'out.png')
	if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
	const res = await py3(PY, ['--out', outFile, '--overlap-min', '40', ...truth.frames])
	return { truth, result: res, outFile, dir }
}

/** Pixel comparison against the ground-truth page. */
async function compare(dir, outFile, maxY, dropCols) {
	const args = ['compare', '--a', outFile, '--b', path.join(dir, 'page.png'), '--max-y', String(maxY)]
	if (dropCols) args.push('--drop-cols', dropCols)
	return py3(REPLAY, args)
}

// 2. scroll -- dense texture must be handled by the PLAIN pass, exactly, with no fallback at all.
{
	const { truth, result, outFile, dir } = await arm('scroll')
	if (truth && result) {
		check('scroll: every frame pair found', result.code === 0 && result.json !== null, { code: result.code, stderr: result.stderr.slice(0, 300) })
		const r = result.json || {}
		check('scroll: every offset is exactly the truth', Array.isArray(r.offsets) && r.offsets.length === FRAMES - 1 && r.offsets.every((s) => s === SHIFT), { offsets: r.offsets, truth: SHIFT })
		check('scroll: height is exactly the page height', r.height === truth.total, { got: r.height, want: truth.total })
		check('scroll: the animated-content fallback was never needed', Array.isArray(r.robust) && r.robust.every((v) => v === false), { robust: r.robust })
		check('scroll: edge margin stays inside 6..40 px', typeof r.margin === 'number' && r.margin >= 6 && r.margin <= 40, { margin: r.margin })
		const cmp = await compare(dir, outFile, truth.total)
		check('scroll: the stitched picture is PIXEL-IDENTICAL to the page', cmp.json && cmp.json.same === true, cmp.json || { code: cmp.code })
	}
}

// 3. anim -- a block repainting in place. The plain pass must fail (that is the point), the
//    structural fallback must carry every pair, and the seams must still be exact.
{
	const { truth, result, outFile, dir } = await arm('anim')
	if (truth && result) {
		check('anim: the capture still succeeds (no refusal)', result.code === 0 && result.json !== null, { code: result.code, stderr: result.stderr.slice(0, 300) })
		const r = result.json || {}
		check('anim: every offset is exactly the truth (a block repainting does not shift the seam)', Array.isArray(r.offsets) && r.offsets.every((s) => s === SHIFT), { offsets: r.offsets, truth: SHIFT })
		check('anim: height is exactly the page height', r.height === truth.total, { got: r.height, want: truth.total })
		check('anim: the structural fallback carried it (it is what this arm exists for)', Array.isArray(r.robust) && r.robust.every((v) => v === true), { robust: r.robust })
		check('anim: the residual is honestly above tolerance (no residual could have accepted it)', Array.isArray(r.scores) && r.scores.every((s) => s > 8), { scores: r.scores })
		const patch = truth.patch
		const cmp = await compare(dir, outFile, truth.total, `${patch.x - 4},${patch.x + patch.w + 4}`)
		check('anim: outside the repainting block the picture is PIXEL-IDENTICAL', cmp.json && cmp.json.same === true, cmp.json || { code: cmp.code })
	}
}

// 4. dup -- the page stopped scrolling and only the block still changed: that frame carries no new
//    rows, so it must be skipped, never stitched at a guessed offset.
{
	const { truth, result, outFile, dir } = await arm('dup')
	if (truth && result) {
		const r = result.json || {}
		check('dup: the capture still succeeds', result.code === 0 && result.json !== null, { code: result.code, stderr: result.stderr.slice(0, 300) })
		check('dup: the motionless frame is recorded as offset 0', Array.isArray(r.offsets) && r.offsets[r.offsets.length - 1] === 0, { offsets: r.offsets })
		check('dup: it is counted as skipped (not stitched)', r.skipped === 1, { skipped: r.skipped })
		check('dup: height equals the page height (nothing was doubled)', r.height === truth.total, { got: r.height, want: truth.total })
		const patch = truth.patch
		const cmp = await compare(dir, outFile, truth.total, `${patch.x - 4},${patch.x + patch.w + 4}`)
		check('dup: outside the block the picture is PIXEL-IDENTICAL', cmp.json && cmp.json.same === true, cmp.json || { code: cmp.code })
	}
}

// 5. gap -- the content jumped farther than one frame height: there is nothing to match, and a
//    guessed seam is worse than an honest refusal (R58 principle: never emit a plausible wrong
//    picture). The fallback must NOT somehow "find" an overlap here.
{
	const { truth, result, outFile } = await arm('gap')
	if (truth && result) {
		check('gap: refused (exit 3), never guessed into a picture', result.code === 3, { code: result.code })
		check('gap: no output file was written', outFile === null || !fs.existsSync(outFile), { out: outFile })
		check('gap: the error is a machine-readable no-overlap', /"error":\s*"no-overlap"/.test(result.stderr), { stderr: result.stderr.split('\n').pop() })
	}
}

// 6. tight -- the overlap is only 25 % of the frame: an application that scrolls a page at a time
//    minus a line. R64 left this as "only ever measured on synthetic replay", and on REAL texture
//    it failed within minutes: pair 7 had two pixel-exact candidates (truth 390 with 130 rows of
//    evidence, and 477 with 43 rows because 43 rows of the PAGE repeat) and the coarse pass
//    preferred the narrow one -- height 4117 instead of 4030, 243 523 wrong pixels, no error
//    anywhere. py/stitch.py#find_exact_shift is the fix; this arm is what keeps it honest.
{
	const TIGHT = { shift: 390, frames: 10, height: 520, dir: 'tight' }
	const share = (TIGHT.height - TIGHT.shift) / TIGHT.height
	check('tight: the fixture really is a NARROW overlap (< 35 % of the frame)', share < 0.35, { share: Math.round(share * 1000) / 1000, overlapRows: TIGHT.height - TIGHT.shift })
	const { truth, result, outFile, dir } = await arm('scroll', TIGHT)
	if (truth && result) {
		const r = result.json || {}
		check('tight: the capture still succeeds', result.code === 0 && result.json !== null, { code: result.code, stderr: result.stderr.slice(0, 300) })
		check(
			'tight: every offset is exactly the truth (a repeated band must not win over the widest exact candidate)',
			Array.isArray(r.offsets) && r.offsets.length === TIGHT.frames - 1 && r.offsets.every((s) => s === TIGHT.shift),
			{ offsets: r.offsets, truth: TIGHT.shift }
		)
		check('tight: height is exactly the page height', r.height === truth.total, { got: r.height, want: truth.total })
		const cmp = await compare(dir, outFile, truth.total)
		check('tight: the stitched picture is PIXEL-IDENTICAL to the page', cmp.json && cmp.json.same === true, cmp.json || { code: cmp.code })
	}
}

// 7. tightanim -- a narrow overlap AND the block repainting INSIDE the overlapping band (the patch
//    sits on the bottom 130 rows, which is exactly the overlap at a 390 px shift). Nothing in that
//    band can be evidence: the true shift scores ~38 there, and the structural search deliberately
//    refuses to look at overlaps under 35 % (11 rows of dense text once satisfied it and picked a
//    wrong 509 px -- see MIN_OVERLAP_SHARE). The only honest answer is a refusal.
//    Measured: 37.98 > 8.00 -> exit 3, no file.
{
	const TIGHTANIM = { shift: 390, frames: 6, height: 520, dir: 'tightanim', patchY: 390 }
	const { truth, result, outFile } = await arm('anim', TIGHTANIM)
	if (truth && result) {
		check('tightanim: the block really sits inside the overlapping band', truth.patch.y < TIGHTANIM.height && truth.patch.y + truth.patch.h >= TIGHTANIM.shift, { patch: truth.patch, overlapFrom: TIGHTANIM.shift })
		check('tightanim: refused (exit 3) instead of inventing a seam from an animating band', result.code === 3, { code: result.code, stderr: result.stderr.split('\n')[0] })
		check('tightanim: no output file was written', outFile === null || !fs.existsSync(outFile), { out: outFile })
		check('tightanim: the error says no-overlap (machine readable)', /"error":\s*"no-overlap"/.test(result.stderr), { stderr: result.stderr.split('\n').pop() })
	}
}

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`stitch-tex: ${pass} PASS / ${fail} FAIL  (lab: ${LAB})`)
process.exit(fail === 0 ? 0 : 1)
