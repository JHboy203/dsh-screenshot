// dev/ovl-skin-shot.mjs -- "render -> crop -> zoom": turn the overlay's whole-form dumps into
// three pictures a human (or a vision model) can actually judge (R66).
//
// WHY THIS EXISTS
//   The overlay skin is drawn by GDI+ inside ps/overlay_host.ps1 (an inner C# compiled by Add-Type).
//   None of it can be judged from code: icon shapes, gaps, font weights, corner radii, whether the
//   card covers the selection. R66 was done entirely by looking at pictures -- and the pictures were
//   produced by hand, six times, with a fresh PIL one-liner each time (and each one re-typed the
//   crop rectangle from memory; two of them were wrong and I looked at the wrong part of the screen).
//
//   So: one command, rectangles COMPUTED from the same constants the paint code uses, three PNGs.
//
// WHAT IT PRODUCES (into <dir>/zoom/)
//   bar.png     the card in the annotate dump           (below a 200,150 320x240 selection)
//   flip.png    the card in the .flip dump              (above a selection near the screen bottom,
//                                                        one button in its hover state)
//   badge.png   the selection size badge (above the selection's top-left)
//   loupe.png   the magnifier in the select dump        (cursor parked at 520,420 by the self test)
//
// RUN IT (needs the dumps first -- they come from the overlay self test):
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/ovl-selftest.mjs',
//                   env:{DSH_OVERLAY_DIR:'<dir>'}})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/ovl-skin-shot.mjs', args:['--dir','<dir>']})
//
// args: --dir <overlay dir> | --scale <n> (default 3) | --out <dir> (default <dir>/zoom)
//
// Exit: 0 written / 2 the dumps are missing (prints the exact command that produces them) or python
//       is unavailable. It never invents a picture: a missing dump is reported, not faked.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lab } from './labpath.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const { findPython, lastJsonLine, run } = shot

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
	const i = argv.indexOf(name)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const DIR = path.resolve(arg('--dir', lab('ovl-skin')))
const SCALE = Math.max(1, Number(arg('--scale', '3')) || 3)
const OUT = path.resolve(arg('--out', path.join(DIR, 'zoom')))

/* ── the numbers come from the paint code, not from memory ────────────────────────────────────
 * BarWidth()/BarHeight() in ps/overlay_host.ps1 are pad*2 + 9 buttons + 8 gaps + 2 sep slots, and
 * pad*2 + button row + hint row + divider gap. Parsing them keeps this file honest when the skin
 * changes: retune the card and the crops follow (measured: re-typing them by hand was wrong twice).
 */
function skinConstants() {
	const src = fs.readFileSync(path.join(PLUGIN, 'ps', 'overlay_host.ps1'), 'utf8')
	const num = (name, dflt) => {
		const m = new RegExp(`private const int ${name} = (\\d+);`).exec(src)
		return m === null ? dflt : Number(m[1])
	}
	const BtnW = num('BtnW', 44)
	const BtnH = num('BtnH', 46)
	const BtnGap = num('BtnGap', 4)
	const BarPad = num('BarPad', 6)
	const SepSlot = num('SepSlot', 9)
	const HintRow = num('HintRow', 20)
	return {
		barW: BarPad * 2 + BtnW * 9 + BtnGap * 8 + SepSlot * 2,
		barH: BarPad * 2 + BtnH + HintRow + 4,
		from: { BtnW, BtnH, BtnGap, BarPad, SepSlot, HintRow },
	}
}

const K = skinConstants()
// The self test's own fixed geometry (dev/ovl-selftest.mjs drives runSelfTest; RunSelfTest in
// ps/overlay_host.ps1 sets these). Kept in one place here and stated in the report below.
const SEL_A = { x: 200, y: 150, w: 320, h: 240 } // annotate + select dumps
const SEL_BOTTOM_H = 120 // .flip dump: selection anchored at the bottom
const CURSOR = { x: 520, y: 420 } // .select dump: where RunSelfTest parks the cursor
const LOUPE = { w: 144, h: 108, gap: 24, readout: 24 }

/** Cards sit 10 px outside the selection; pad the crop so the shadow and edge are included. */
const PAD = 12

function rects(screenH) {
	const a = SEL_A
	const bottomY = screenH - 170
	return {
		// annotate: card below the selection (there is room below in a 200,150 selection)
		bar: { file: 'form.annotate.png', box: { x: a.x - PAD, y: a.y + a.h + 10 - PAD, w: K.barW + PAD * 2, h: K.barH + PAD * 2 } },
		// flip: selection anchored near the bottom -> the card must be ABOVE it
		flip: { file: 'form.flip.png', box: { x: a.x - PAD, y: bottomY - K.barH - 10 - PAD, w: K.barW + PAD * 2, h: K.barH + 20 + PAD * 2 } },
		// size badge: a pill just above the selection's top-left
		badge: { file: 'form.annotate.png', box: { x: a.x - 14, y: a.y - 40, w: 300, h: 50 } },
		// magnifier: 24 px right/below the parked cursor, 144x108 + the readout row
		loupe: {
			file: 'form.select.png',
			box: { x: CURSOR.x + LOUPE.gap - 8, y: CURSOR.y + LOUPE.gap - 8, w: LOUPE.w + 16, h: LOUPE.h + LOUPE.readout + 16 },
		},
	}
}

const py = findPython()
if (!py) {
	console.log('ovl-skin-shot: python not found (needed for nothing but the crop+zoom step)')
	process.exit(2)
}

fs.mkdirSync(OUT, { recursive: true })

// Grab the screen height from a dump instead of asking: the dumps are full-screen renders, so
// their size IS the virtual screen size the overlay saw.
function pngSize(file) {
	const buf = fs.readFileSync(file)
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const needed = new Set(Object.values(rects(1080)).map((r) => r.file))
const missing = [...needed].filter((f) => !fs.existsSync(path.join(DIR, f)))
if (missing.length > 0) {
	console.log(`ovl-skin-shot: 缺渲染图 ${missing.join(', ')}（在 ${DIR}）`)
	console.log('  先跑自检生成它们：')
	console.log(`  host_selfcheck({plugin:'dsh-screenshot', script:'dev/ovl-selftest.mjs', env:{DSH_OVERLAY_DIR:'${DIR}'}}})`)
	process.exit(2)
}

const probeSize = pngSize(path.join(DIR, 'form.annotate.png'))
const R = rects(probeSize.h)

const made = []
for (const [name, r] of Object.entries(R)) {
	const src = path.join(DIR, r.file)
	const dst = path.join(OUT, `${name}.png`)
	const script = [
		'from PIL import Image',
		`im = Image.open(r"${src}").convert("RGB")`,
		`box = (${r.box.x}, ${r.box.y}, ${r.box.x + r.box.w}, ${r.box.y + r.box.h})`,
		'c = im.crop(box)',
		`c = c.resize((c.width * ${SCALE}, c.height * ${SCALE}), Image.NEAREST)`,
		`c.save(r"${dst}")`,
		'print("ok")',
	].join('\n')
	const res = await run(py, ['-c', script], { timeoutMs: 60_000 })
	if (res.code !== 0 || !fs.existsSync(dst)) {
		console.log(`ovl-skin-shot: ${name} 失败：${String(res.stderr || '').trim().slice(0, 200)}`)
		process.exit(1)
	}
	const sz = pngSize(dst)
	made.push({ name, file: dst, box: r.box, px: sz })
}

console.log(JSON.stringify({
	ok: true,
	dir: DIR,
	out: OUT,
	scale: SCALE,
	card: { w: K.barW, h: K.barH, from: K.from, screen: probeSize },
	zoom: made,
}, null, 2))
// One PASS line on purpose: host_selfcheck / shot_probe count PASS/FAIL, and "zero checks" is
// treated as a failure elsewhere in this project -- a tool that works without saying so looks
// exactly like a tool that silently did nothing.
console.log(`   PASS  ${made.length} zoom crops written (${made.map((m) => m.name).join(', ')})  -> ${OUT}`)
console.log('看这几张：' + made.map((m) => m.file).join('  '))
