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
/** env（环境挡住）的失败项：既不算通过，也不该被当成本产品回归（退出码 2，见文件末尾）。 */
let envFails = 0
function check(item, ok, detail, kind) {
	results.push({ item, ok: ok === true, env: kind === 'env' })
	if (kind === 'env' && ok !== true) envFails += 1
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

fs.mkdirSync(LAB, { recursive: true })

/* ─────────────────── where to put it ─────────────────── */

/**
 * 取景框必须落在**一块自己不会变的桌面**上。R32 时写死了右下角（"那个位置在任何布局下都是壁纸"）——
 * R35 实测这个假设会失效：QQ 的窗口 1239×930@559,71 把右下角盖住了，它一动画，
 * "内部仍显示桌面"就从 100.0% 掉到 **71.9%**，看起来像框在改画面，其实是背景在动。
 * 所以改成**实测挑点**（见 pickRegion）：候选位置各拍两帧，选第一块"两帧完全一致"的。
 * 一块都找不到 → 退 2（环境：屏幕上没有静态区域），一条像素判定都不打。
 */
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

/* ─────────────────── 挑一块真正静态的取景位置 ─────────────────── */
/** 两张同尺寸图里"逐像素一致"的比例（容差 6，和 interiorDiff 同口径）。 */
function sameFraction(a, b) {
	let same = 0
	let total = 0
	const w = Math.min(a.width, b.width)
	const h = Math.min(a.height, b.height)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const p = a.at(x, y)
			const q = b.at(x, y)
			total++
			if (Math.abs(p[0] - q[0]) <= 6 && Math.abs(p[1] - q[1]) <= 6 && Math.abs(p[2] - q[2]) <= 6) same++
		}
	}
	return total === 0 ? 0 : same / total
}

/**
 * 取景框必须落在**一块自己不会变的桌面**上，而且**不能压在别的窗口上**。
 *
 * 两次真实翻车：
 *   - R35：写死右下角，被 QQ（1239×930@559,71）盖住，它一动画，"内部仍显示桌面"
 *     从 100% 掉到 71.9% —— 看起来像框在改画面，其实是背景在动；
 *   - R48：候选取 `(vw-240, vh-320)`＝1677,757，**压在 DSH 自己的窗口右缘**（窗口
 *     150,0·1619×1029 → 右边界 1769）。探针跑的时候 DSH 正在流式输出，那一小条的
 *     光标/滚动同步在变，于是 350ms 的"静态度"检查过了、整段跑完时内部却变了 22%，
 *     判成产品失败（`interior still shows the desktop 78.1%`）。
 *
 * 因此候选不再写死几个角落：**先枚举窗口矩形，网格搜索离所有应用窗口最远的位置**，
 * 再对前几名做"两帧一致"的静态检查。桌面外壳（Progman / WorkerW / 任务栏 / 桌面列表）
 * 不算应用窗口 —— 壁纸本身就是它们画的。
 */
const SHELL_CLASSES = new Set([
	'Progman',
	'WorkerW',
	'SHELLDLL_DefView',
	'SysListView32',
	'Shell_TrayWnd',
	'Shell_SecondaryTrayWnd',
	'Windows.UI.Core.CoreWindow',
	'TaskListThumbnailWnd',
	'MultitaskingViewFrame',
])

/** 矩形相交面积（用来挑"被窗口盖得最少"的位置）。 */
function rectOverlapArea(r, w) {
	const x0 = Math.max(r.x, w.x)
	const y0 = Math.max(r.y, w.y)
	const x1 = Math.min(r.x + r.w, w.x + w.w)
	const y1 = Math.min(r.y + r.h, w.y + w.h)
	if (x1 <= x0 || y1 <= y0) return 0
	return (x1 - x0) * (y1 - y0)
}

async function pickRegion() {
	const RW = 120
	const RH = 90
	const winsRes = await shot.listWindows({ exclude: '' }).catch(() => ({ windows: [] }))
	const apps = winsRes.windows.filter((w) => w.w > 0 && w.h > 0 && w.min !== true && !SHELL_CLASSES.has(w.class))
	console.log(`app windows on screen: ${apps.length}${apps.length === 0 ? '' : ' (' + apps.map((w) => `${w.class}@${w.x},${w.y} ${w.w}x${w.h}`).slice(0, 4).join(' | ') + ')'}`)
	/** @type {Array<{region:{x:number,y:number,w:number,h:number}, overlap:number, why:string}>} */
	const cands = []
	const step = 40
	for (let y = 8; y <= vh - RH - 8; y += step) {
		for (let x = 8; x <= vw - RW - 8; x += step) {
			const region = { x, y, w: RW, h: RH }
			let overlap = 0
			for (const w of apps) overlap += rectOverlapArea(region, w)
			cands.push({ region, overlap, why: `grid x=${x} y=${y}` })
		}
	}
	// 被窗口盖得越少越好；同分取靠右下（本机那块常年是壁纸，和 R32 的直觉一致）
	cands.sort((a, b) => a.overlap - b.overlap || b.region.y - a.region.y || b.region.x - a.region.x)
	const top = cands.slice(0, 8)
	for (const c of top) {
		const region = c.region
		const crop = { x: region.x - PAD, y: region.y - PAD, w: RW + 2 * PAD, h: RH + 2 * PAD }
		let a
		let b
		try {
			a = await capture('pick-a', crop)
			await sleep(350)
			b = await capture('pick-b', crop)
		} catch {
			continue
		}
		const ratio = sameFraction(a.img, b.img)
		console.log(`candidate x=${region.x} y=${region.y}（${c.why}，被窗口盖住 ${c.overlap} px²）静态度 ${(ratio * 100).toFixed(1)}%`)
		if (ratio >= 0.995) return { region, crop, why: `${c.why}（被窗口盖住 ${c.overlap} px²）`, ratio, overlap: c.overlap }
	}
	return null
}

const picked = await pickRegion()
if (picked === null) {
	console.log('')
	console.log('ENVIRONMENT: 屏幕上找不到一块 350ms 内不变化的区域（5 个候选全在动）。')
	console.log('  => "内部仍显示桌面"这条判据无法成立；像素判定全部作废 —— 这不是框的问题。')
	console.log('1 PASS / 1 FAIL(env)')
	process.exit(2)
}
REGION = picked.region
CROP = { ...picked.crop }
console.log(
	`screen ${vw}x${vh} · region ${REGION.w}x${REGION.h}@${REGION.x},${REGION.y}（${picked.why}，静态度 ${(picked.ratio * 100).toFixed(1)}%）· dpi mixed=${disp.mixedDpi} negativeOrigin=${disp.negativeOrigin}`
)

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

/* the strongest statement: the interior still shows what was there before the frame appeared.
 * ⚠️ R35：这条**判决必须放到关框之后** —— 判"环境还是产品"要多一条对照臂：
 * 桌面自己在同一段时间里变了没有（见 arm 2 之后的 POST 段）。 */
let diff = interiorDiff(before.img, img)
let retried = false
if (diff.same / diff.total < 0.95) {
	await sleep(600)
	try {
		const again = await capture('interior-retry')
		const d2 = interiorDiff(before.img, again.img)
		if (d2.same / d2.total > diff.same / diff.total) {
			diff = d2
			retried = true
		}
	} catch {}
}
const interiorRatio = diff.same / diff.total

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

/* ─────────────────── POST：关框后再拍一张（对照臂） ───────────────────
 * R35 实测：取景位置在右下角，而 QQ 的窗口 1239×930@559,71 正好盖住它；QQ 一动，
 * "内部仍显示桌面"就从 100.0% 掉到 71.9% —— 看起来像框画进了画面，其实是背景在动。
 * 判别方法：**桌面自己**在这段时间里变了没有。
 *   内部变了 + 桌面也变了 → env（环境，不是产品回归）
 *   内部变了 + 桌面没变   → failed（真回归：框在改画面）
 */
await sleep(700)
let afterImg = null
try {
	afterImg = (await capture('after')).img
} catch {}
const deskRatio = afterImg === null ? 1 : sameFraction(before.img, afterImg)
const interiorOk = interiorRatio >= 0.95
const deskMoved = deskRatio < 0.95
/**
 * R48 的第三条判据：取景位置**压在应用窗口上**时，"内部 vs 桌面"只能判"大改"。
 *
 * DSH 最大化时整屏都是它，找不到无窗口的候选；窗框透明时，它那一小条的光标/滚动同步会
 * 从框里透出来 —— 实测内部只 78.1% 未变，而 before/after 两帧桌面对着 100%（刚好都在静止相位），
 * 于是老的 env 对照臂没救到。但**真的把内部画黑/涂色**会改掉几乎 100% 像素，不会只改 22%。
 * 所以：压在窗口上、且只改了一部分（>=50% 未变）→ env；改掉一半以上 → 仍然是产品失败。
 */
const overApp = picked.overlap > 0
const partialRepaint = interiorOk || interiorRatio >= 0.5
const envVerdict = !interiorOk && (deskMoved || (overApp && partialRepaint))
check(
	'interior still shows the desktop (>=95% pixels unchanged)',
	interiorOk,
	`${(interiorRatio * 100).toFixed(1)}% unchanged of ${diff.total}${retried ? '（重采一次后）' : ''}` +
		(interiorOk
			? ''
			: `；对照臂：桌面自身静态度 ${(deskRatio * 100).toFixed(1)}%；取景被应用窗口盖住 ${picked.overlap} px²`),
	interiorOk || !envVerdict ? 'product' : 'env'
)
if (!interiorOk && envVerdict) {
	console.log('')
	if (deskMoved) {
		console.log(
			`ENVIRONMENT: 内部只 ${(interiorRatio * 100).toFixed(1)}% 未变，但**桌面自己在同一段时间也只 ${(deskRatio * 100).toFixed(1)}% 未变**。`
		)
		console.log('  => 是取景框下面的窗口在动（R35 实测：QQ 的 1239x930@559,71 盖住右下角那块），不是框画进了画面。')
	} else {
		console.log(
			`ENVIRONMENT: 内部 ${(interiorRatio * 100).toFixed(1)}% 未变，取景位置被应用窗口盖住 ${picked.overlap} px²，而桌面自身是静止的（${(deskRatio * 100).toFixed(1)}%）。`
		)
		console.log('  => 这是 R48 实测那种情形：DSH 最大化时全屏都是它，框透明时它那一小条的光标/滚动同步会透出来；')
		console.log('     真的把内部画黑/涂色会改掉几乎 100%，不会只改 22%。这条记 env。')
	}
	console.log('  => 不算产品回归，也不算通过；其余像素判定照旧有效。')
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
	return { same, total }
}
