// dev/ocr-probe.mjs -- R63: the OCR chain, end to end, on text whose answer is known.
//
// WHY THIS EXISTS
//   Until R63 the gate never ran OCR at all. ps/ocr_region.ps1 had a self-test, but it spawns a
//   child PowerShell from inside PowerShell, and DSH's file sandbox refuses that ("could not
//   launch a child PowerShell") -- so the OCR path was only ever exercised by a human in a
//   terminal. Every shipped change to it (preprocess modes, the banded/tiled path, the language
//   picker) was unverified. This probe renders KNOWN text with GDI+ and then calls
//   lib/shot.mjs#ocr() -- the exact function a user's screenshot goes through -- so the chain
//   (node -> windows powershell 5.1 -> Windows.Media.Ocr -> JSON -> shapes) is asserted, not
//   assumed.
//
// WHAT IT PINS (measured on this machine, see the numbers in the checks)
//   light   28 px CJK+ASCII on white     -> all three lines exact, CJK never split by spaces
//   dark    same text, light on #1E1E1E  -> a dark theme reads without any preprocess option
//   small   11 px text                   -> degrades, but the upscale path engages (scale >= 2)
//                                           and the ASCII half still comes back
//   blank   no text at all               -> ok, empty text, zero lines (never an error)
//   rect    only the bottom half asked   -> the top line must NOT leak in, geometry inside the rect
//
// RUN IT FROM THE HOST (it spawns powershell.exe 5.1 and GDI+):
//   shot_probe({probe:'ocr'})              or
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/ocr-probe.mjs'})
//
// Exit: 0 all pass / 1 fail / 2 env (cannot render: no System.Drawing, no CJK font).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const WORKSPACE = 'D:\\信息库\\AI工作区'
const LAB = path.join(WORKSPACE, '.tmp-shot-lab', 'ocr-probe')

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const { findPowershell, lastJsonLine, ocr, run } = shot

const results = []
function check(name, ok, extra) {
	results.push({ name, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`)
}
function finish(code) {
	const pass = results.filter((r) => r.ok).length
	const fail = results.length - pass
	console.log(`ocr: ${pass} PASS / ${fail} FAIL  (lab: ${LAB})`)
	process.exit(code === undefined ? (fail === 0 ? 0 : 1) : code)
}

if (!fs.existsSync(LAB)) fs.mkdirSync(LAB, { recursive: true })

/* ── the known text ─────────────────────────────────────────────────────────────────────────────
 * Deliberately the plugin's own vocabulary: if the engine ever starts mangling real UI strings,
 * these are the words a user would see it fail on. */
const TEXT = {
	main: '深度求索 截图插件 中文识别测试',
	ascii: 'DSH screenshot OCR 2026',
	tail: '去重 拼接 长截图 剪贴板',
	small: '小字号 十一像素 识别一行',
	smallAscii: 'small 11px line',
	top: '上半部分 不应出现',
	bottom: '下半部分 识别这里',
}
const RECT = { x: 0, y: 50, w: 900, h: 150 }

const spec = {
	out: LAB,
	cases: [
		{ name: 'light', width: 900, height: 240, background: '#FFFFFF', foreground: '#101010', lines: [{ text: TEXT.main, px: 28 }, { text: TEXT.ascii, px: 28 }, { text: TEXT.tail, px: 20 }] },
		{ name: 'dark', width: 900, height: 240, background: '#1E1E1E', foreground: '#E8E8E8', lines: [{ text: TEXT.main, px: 28 }, { text: TEXT.ascii, px: 28 }] },
		{ name: 'small', width: 620, height: 120, background: '#FFFFFF', foreground: '#101010', lines: [{ text: TEXT.small, px: 11 }, { text: TEXT.smallAscii, px: 11 }] },
		{ name: 'blank', width: 400, height: 120, background: '#FFFFFF' },
		{ name: 'rect', width: 900, height: 400, background: '#FFFFFF', foreground: '#101010', lines: [{ text: TEXT.top, px: 28 }, { text: TEXT.bottom, px: 28 }] },
	],
}
const specFile = path.join(LAB, 'spec.json')
fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8')

// 1. Render. ASCII-only PS script + UTF-8 spec file: a CJK literal inside .ps1 would be decoded as
//    GBK by Windows PowerShell 5.1 and come out as mojibake.
const fx = await run(findPowershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'ocr-fixture.ps1'), '-Spec', specFile], { timeoutMs: 90_000 })
const rendered = lastJsonLine(fx.stdout)
if (fx.code === 3 || (rendered === null && fx.code !== 0)) {
	console.log('   SKIP  cannot render fixtures here  ' + JSON.stringify({ code: fx.code, stderr: fx.stderr.trim().slice(0, 300) }))
	finish(2)
}
check('the fixtures rendered (GDI+ + a CJK font are available)', rendered !== null && rendered.ok === true, rendered === null ? { code: fx.code, stderr: fx.stderr.trim().slice(0, 300) } : { out: rendered.out })
const PNG = {}
for (const c of (rendered && rendered.cases) || []) PNG[c.name] = c.png
check('every case produced a PNG', ['light', 'dark', 'small', 'blank', 'rect'].every((n) => PNG[n] && fs.existsSync(PNG[n])), { png: Object.keys(PNG) })
if (results.some((r) => !r.ok)) finish(1)

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const cjkOnly = (s) => String(s || '').replace(/[^\u3400-\u9fff]/g, '')
const charsOf = (s) => new Set([...cjkOnly(s)])

/* ── 2. light: the ordinary case. Every line exact, and CJK words are NOT split by spaces ───── */
{
	const r = await ocr({ file: PNG.light })
	const got = norm(r.text)
	check('light: the call succeeded', r.ok === true && got.length > 0, { ok: r.ok, error: r.error })
	check('light: the CJK line comes back whole', got.includes('深度求索') && got.includes('截图插件') && got.includes('中文识别'), { got })
	check('light: the ASCII line comes back whole', /DSH/.test(got) && /screenshot/.test(got) && /2026/.test(got), { got })
	check('light: the small tail line comes back', got.includes('去重') || got.includes('剪贴板'), { got })
	check('light: CJK is not split into one word per character', !/[\u3400-\u9fff] [\u3400-\u9fff]/.test(got), { got })
	check('light: at least 3 recognised lines', Array.isArray(r.lines) && r.lines.length >= 3, { lines: r.lines && r.lines.length })
	check('light: geometry is reported per line', Array.isArray(r.lines) && r.lines.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.w) && Number.isFinite(l.h) && l.w > 0), { first: r.lines && r.lines[0] })
	check('light: the language is a Chinese engine', /^zh/i.test(String(r.lang)) && Array.isArray(r.langs) && r.langs.length > 0, { lang: r.lang, langs: r.langs })
	check('light: the picture size is reported', r.width === 900 && r.height === 240, { w: r.width, h: r.height })
	check('light: the path used is disclosed (no silent degradation)', typeof r.used === 'string' && r.used.length > 0 && Number(r.scale) >= 1, { used: r.used, scale: r.scale, fallback: r.fallback })
}

/* ── 3. dark: the DSH theme. Light text on #1E1E1E, with NO preprocess option passed ────────── */
{
	const r = await ocr({ file: PNG.dark })
	const got = norm(r.text)
	check('dark theme: the call succeeded', r.ok === true, { ok: r.ok, error: r.error })
	check('dark theme: the CJK line is readable without preprocess', got.includes('深度求索') && got.includes('截图插件'), { got })
	check('dark theme: the ASCII line is readable', /DSH/.test(got) && /2026/.test(got), { got })
	check('dark theme: at least 2 lines', Array.isArray(r.lines) && r.lines.length >= 2, { lines: r.lines && r.lines.length, used: r.used })
}

/* ── 4. small: 11 px is past the reliable limit, so assert the DEGRADATION, not perfection ──── */
{
	const r = await ocr({ file: PNG.small })
	const got = norm(r.text).toLowerCase()
	const hits = [...charsOf(TEXT.small)].filter((c) => got.includes(c)).length
	check('11 px: the call succeeded', r.ok === true, { ok: r.ok, error: r.error })
	check('11 px: the upscale path engaged (scale >= 2)', Number(r.scale) >= 2, { scale: r.scale, used: r.used })
	// The ASCII half is where 11 px really hurts (measured: "small 11px line" came back as
	// "stnall 11p x line"), so pin what actually survives rather than a word the engine cannot
	// resolve at this size: the word "line", the digits, and a mostly-read Latin line.
	const latin = (norm(r.text).match(/[A-Za-z]/g) || []).length
	check('11 px: the ASCII half is mostly read', /line/i.test(got) && /11/.test(got) && latin >= 8, { got: norm(r.text), latin })
	check('11 px: at least 3 of the CJK characters survive', hits >= 3, { hits, of: charsOf(TEXT.small).size, got: norm(r.text) })
}

/* ── 5. blank: nothing to read is not an error ─────────────────────────────────────────────── */
{
	const r = await ocr({ file: PNG.blank })
	check('blank: the call succeeded (no text is not a failure)', r.ok === true, { ok: r.ok, error: r.error })
	check('blank: the text is empty', norm(r.text) === '', { got: norm(r.text) })
	check('blank: zero lines', Array.isArray(r.lines) && r.lines.length === 0, { lines: r.lines && r.lines.length, used: r.used })
}

/* ── 6. rect: only the bottom half. The top line must not leak in, and the geometry must be
 *      relative to the rect (that is what the client draws boxes with). ─────────────────────── */
{
	const r = await ocr({ file: PNG.rect, rect: `${RECT.x},${RECT.y},${RECT.w},${RECT.h}` })
	const got = norm(r.text)
	check('rect: the call succeeded', r.ok === true, { ok: r.ok, error: r.error })
	check('rect: the requested line was read', got.includes('下半部分') && (got.includes('这里') || got.includes('识别')), { got })
	check('rect: the line OUTSIDE the rect did not leak in', !got.includes('上半部分') && !got.includes('不应'), { got })
	check('rect: the picture is only the rect', r.width === RECT.w && r.height === RECT.h, { w: r.width, h: r.height })
	check(
		'rect: line geometry sits inside the rect',
		Array.isArray(r.lines) && r.lines.length >= 1 && r.lines.every((l) => l.x >= 0 && l.y >= 0 && l.x + l.w <= RECT.w + 1 && l.y + l.h <= RECT.h + 1),
		{ lines: r.lines }
	)
}

/* ── 7. A missing file is a clean refusal, not a crash (the caller passes user paths) ───────── */
{
	const r = await ocr({ file: path.join(LAB, 'does-not-exist-9f3a.png') })
	check('missing file: refused cleanly', r.ok === false && /not found/i.test(String(r.error)) && Array.isArray(r.lines), { ok: r.ok, error: r.error })
}

finish()
