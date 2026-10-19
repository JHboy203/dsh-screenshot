/**
 * dev/hosttest.mjs — 宿主半边的**真机自检**：不依赖 Electron，直接用 node 跑。
 *
 *   node dev/hosttest.mjs            只跑不碰鼠标的部分（1/2/3/5/6）
 *   node dev/hosttest.mjs --auto     额外跑 auto 长截图（会**移动真实鼠标**发滚轮）
 *   node dev/hosttest.mjs --pick     额外跑 pickwin（会**全屏覆盖 5 秒**，到点自己退）
 *   node dev/hosttest.mjs --all      上面两个都跑
 *
 * 为什么要有它：宿主半边跑在 DSH 进程里，出了错只有一行日志。而这里的每一条链路
 * （PowerShell 子进程、BitBlt、滚轮、ffmpeg、python 拼接）都只能"真跑一次"才算数。
 *
 * 产物全部落在 .tmp-shot-lab/host/ 下（用 DSH_SHOT_CACHE / DSH_SHOT_DIR 改道，
 * 因为沙箱禁止子进程写插件目录 —— 这两个开关就是为这件事存在的）。
 *
 * 测试用的"会滚的窗口"是 **dev/scroller.ps1**（就在本脚本旁边）：一块真 WinForms 窗口，
 * 里面是一张 12000px 高的位图，node 通过一个控制文件让它上下滚 —— 于是长截图拿到的是
 * **真的、有重叠的**滚动，而不是"随便找块屏幕碰运气"。
 *
 * 这个夹具**故意**放在 dev/ 而不是 .tmp-shot-lab/：后者是产物目录，会被清理。
 * 它曾经待在那里、被一次"清理测试产物"顺手删掉，结果是 host_selfcheck 报
 * "测试窗口没起来"、3/4/7 三组静默地什么也没跑。夹具必须跟着拥有它的测试走。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = 'D:\\信息库\\AI工作区\\.tmp-shot-lab\\host'
/** 夹具在 dev/ 里（见文件头那条说明）：产物目录会被清理，夹具不能待在那儿。 */
const SCROLLER_PS1 = path.join(HERE, 'scroller.ps1')
const SCRATCH = path.join(LAB, 'scratch')
const LOG = path.join(SCRATCH, 'scroller.log')

const argv = process.argv.slice(2)
const WITH_AUTO = argv.includes('--auto') || argv.includes('--all')
const WITH_PICK = argv.includes('--pick') || argv.includes('--all')

// 必须在 import 之前改道：CACHE_DIR / SHOTS_DIR / REC_DIR 都是模块加载时读的常量。
process.env.DSH_SHOT_CACHE = path.join(LAB, 'cache')
process.env.DSH_SHOT_DIR = path.join(LAB, 'shots')
/**
 * 覆盖层的请求目录也必须改道，而且这条**不是洁癖**：
 * DSH 应用自己常驻着一个覆盖层助手（插件 init 起的那一个），它也盯着
 * `.cache/overlay` 里的 `ovlreq-*.json`。两个助手抢同一个目录时，**先读到的那一个**
 * 会去开窗、写结果 —— 于是本脚本问的是自己的助手，窗口却是别人开的，
 * 表现是莫名其妙的 `reason=esc` / 超时，而且随应用是否在跑而变（曾整组假红）。
 */
process.env.DSH_OVERLAY_DIR = path.join(LAB, 'overlay')

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const shooter = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shooter.mjs')).href)
const scroll = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'scrollsession.mjs')).href)
const wire = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'wire.mjs')).href)
const { createShotService } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'service.mjs')).href)

/** 千篇一律的极简基类：服务类只要求 super(ctx, name)。 */
class FakeRemote {
	constructor(ctx, name) {
		this.ctx = ctx
		this.name = name
	}
}
const svc = new (createShotService(FakeRemote))(null, {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function log(...a) {
	console.log(...a)
}
function check(item, ok, detail) {
	results.push({ item, ok: ok === true, detail: String(detail) })
	log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}
function kb(bytes) {
	return `${Math.round(Number(bytes) / 1024)}KB`
}

/** 直接问 wheel.ps1 光标在哪（会话之外读，用来做"还原"的对照）。 */
async function readCursor() {
	const res = await shot.run(shot.findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'wheel.ps1'), '-GetPos'], { timeoutMs: 10_000 })
	const info = shot.lastJsonLine(res.stdout)
	return info !== null && info.ok === true ? { x: Number(info.x), y: Number(info.y) } : null
}

/**
 * 直接问 wheel.ps1：这个坐标你放得上去吗？
 * 这条是"宿主不撒谎"的独立标尺 —— 它给 false 的时候，会话就绝不允许报 cursor='restored'。
 */
async function setPosProbe(pos) {
	const res = await shot.run(shot.findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'wheel.ps1'), '-SetPos', `${pos.x},${pos.y}`], { timeoutMs: 10_000 })
	const info = shot.lastJsonLine(res.stdout)
	return info === null ? null : info.ok === true
}

fs.mkdirSync(SCRATCH, { recursive: true })
fs.mkdirSync(shot.CACHE_DIR, { recursive: true })
fs.mkdirSync(shot.SHOTS_DIR, { recursive: true })

/* ─────────────────── 0. 起一块会滚的真窗口 ─────────────────── */

const CONTROL = path.join(SCRATCH, 'control.txt')
const INFO = path.join(SCRATCH, 'scroller.json')
try {
	fs.rmSync(CONTROL, { force: true })
	fs.rmSync(INFO, { force: true })
} catch {}

// ⚠️ 位置不是随便挑的：本沙箱是**低完整性**，`SetWindowPos(HWND_TOPMOST)` 会返回 true
// 但被静默丢弃（实测 ex-style 不变、点还是打在别人窗口上），低完整性进程也抢不到前台 ——
// 所以测试窗口必须放在**屏幕上没有任何窗口覆盖**的地方，否则它被 Chrome/DSH 盖住，
// 抓到的和 hitwin 问到的都是别人（这条踩了两轮）。
// 实测这张屏的覆盖图（hitwin 网格扫描，1920x1080）：
//   x<=1610 Chrome / x 1650..1799 DSH 自己 / **x>=1800 桌面**，y 全高都一样。
// 于是窗口只能站右边这条 ~120px 的窄带 —— 窄不影响结论：长截图要的是"纵向真的滚动"。
const WIN = { x: 1798, y: 130, w: 120, h: 880 }
let scroller = null
function scrollerStdio() {
	/**
	 * 夹具的输出**必须能看见**。原来是 `stdio:'ignore'`（管道在本沙箱里会 EPERM），
	 * 代价是脚本一启动就报错时，自检只会说一句"测试窗口没起来"，看不到真正的原因
	 * （本轮就栽过：pwsh 7 下 C# 编译不过，报的却是这条）。
	 * 改成重定向到 SCRATCH 下的两个文件 —— 不是管道，所以不会 EPERM。
	 */
	try {
		fs.mkdirSync(SCRATCH, { recursive: true })
		const fd = fs.openSync(path.join(SCRATCH, 'scroller-console.log'), 'a')
		return ['ignore', fd, fd]
	} catch {
		return 'ignore'
	}
}
function startScroller() {
	scroller = spawn(
		shot.findPwsh(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCROLLER_PS1,
			'-X', String(WIN.x), '-Y', String(WIN.y), '-W', String(WIN.w), '-H', String(WIN.h),
			'-Control', CONTROL, '-Info', INFO, '-Log', LOG,
		],
		// 注意：**不能** detached —— 实测 detached 起的 pwsh 会立刻 exit 0（窗口根本没建）。
		{ windowsHide: false, stdio: scrollerStdio() }
	)
	scroller.unref()
}
startScroller()

async function scrollerInfo(timeoutMs = 20_000) {
	const until = Date.now() + timeoutMs
	while (Date.now() < until) {
		try {
			const raw = fs.readFileSync(INFO, 'utf8').trim()
			if (raw.startsWith('{')) return JSON.parse(raw)
		} catch {}
		await sleep(200)
	}
	return null
}

/** 窗口坏了就换一块新的（这台机器上 hide/show 之后它的消息循环有时会卡住，move 不再生效）。 */
async function restartScroller() {
	try {
		tell('q')
		await sleep(300)
		scroller.kill()
	} catch {}
	await sleep(900)
	try {
		fs.rmSync(INFO, { force: true })
	} catch {}
	startScroller()
	return (await scrollerInfo(15_000)) !== null
}
function tell(body) {
	fs.writeFileSync(CONTROL, String(body), 'ascii')
}
function setOffset(off) {
	tell(off)
}
function readInfo() {
	try {
		return JSON.parse(fs.readFileSync(INFO, 'utf8'))
	} catch {
		return null
	}
}

let info = null
try {
	info = await scrollerInfo()
} catch {}
if (info === null) {
	log('!! 测试窗口没起来，后面的用例没有意义，直接退出')
	process.exit(2)
}

/**
 * 找一个"没有任何别的窗口盖住它"的位置。
 *
 * 为什么必须找：这台机器是**活的**（用户真的在用它），而且本进程是低完整性 ——
 * `SetWindowPos(HWND_TOPMOST)` 返回 true 却被打回，低完整性也抢不到前台。所以我的测试窗口
 * 只能"见缝插针"：先把它挪到候选位置，再用 hitwin 问一句"这个点的最顶层窗口是谁"，
 * 答案是我自己才算数。找不到就**如实跳过** 3/4 两组（而不是拿着一堆相同帧去凑结论）。
 */
const CANDIDATES = [
	{ x: 1798, y: 130, w: 120, h: 880 },
	{ x: 1700, y: 130, w: 220, h: 880 },
	{ x: 1490, y: 120, w: 420, h: 760 },
	{ x: 240, y: 140, w: 820, h: 620 },
	{ x: 60, y: 700, w: 900, h: 340 },
]
let visible = false
// 用户可能正全屏看视频 —— 那就等一会儿再看（这张屏是活的，等一两分钟常常就有空位了）。
// 六轮之后还找不到就如实跳过 3/4/7（不会拿一堆相同的帧硬凑结论）。
for (let round = 1; round <= 12 && !visible; round += 1) {
	for (const c of CANDIDATES) {
		tell(`move ${c.x},${c.y},${c.w},${c.h}`)
		await sleep(900)
		const cur = readInfo()
		if (cur === null) continue
		const hit = await shot.hitTest(Math.round(cur.x + cur.w / 2), Math.round(cur.y + cur.h / 2))
		log(`      第${round}轮 试位 (${c.x},${c.y},${c.w},${c.h}) -> client=${cur.x},${cur.y},${cur.w},${cur.h} 中心点是 hwnd=${hit.hwnd} "${String(hit.title).slice(0, 28)}"`)
		if (hit.hwnd === cur.hwnd) {
			info = cur
			visible = true
			break
		}
	}
	if (!visible && round < 12) {
		log(`      第${round}轮没找到空位，等 20s 再试（用户可能正全屏看视频/文档）`)
		await sleep(20_000)
	}
}
if (!visible) {
	log('      !! 屏幕上找不到任何"我的窗口在最上面"的位置 —— 3/4/7 三组必须跳过')
	log('         （这台机器上 Chrome/DSH 会随时最大化，低完整性进程又抢不到前台/TopMost）')
}
const RECT = visible ? `${info.x},${info.y},${info.w},${info.h}` : ''
/** 不依赖 lab 窗口的那块矩形（1 号用例验过它一定落在屏幕内）：老路径用例用它。 */
const FIXED_RECT = '300,300,800,600'

/**
 * 把测试窗口摆回原位并**确认它真的在最上面**。
 *
 * 为什么需要：3.1 的遮挡守卫用例会 `Visible=$false` 再 `$true`，而 hide/show 之后这台机器上
 * 观察到的状态并不稳定（run9 就出现过"auto 的 target 变成桌面、随后又一直 target-lost"）。
 * 与其假定它回来了，不如每次要用之前重新摆一次、再用 hitwin 自问自答一次 ——
 * 不成立就跳过那组，绝不拿"窗口其实没在最上面"的一堆相同帧去凑结论。
 */
async function ensureTop() {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		tell(`move ${WIN.x},${WIN.y},${WIN.w},${WIN.h}`)
		await sleep(1000)
		const cur = readInfo()
		if (cur !== null) {
			const hit = await shot.hitTest(Math.round(cur.x + cur.w / 2), Math.round(cur.y + cur.h / 2))
			if (hit.hwnd === cur.hwnd) {
				info = cur
				return true
			}
		}
		if (attempt === 0) {
			log('      窗口状态不对（move 没生效 = 消息循环卡住了），换一块新的再来')
			if (!(await restartScroller())) return false
		}
	}
	return false
}
log(`# lab 窗口 hwnd=${info.hwnd} client=${RECT} （${info.w}x${info.h} 物理像素）`)
log(`# cache=${shot.CACHE_DIR}`)
log(`# shots=${shot.SHOTS_DIR}`)
log(`# 诚实等级=${await shot.status().then((s) => s.integrity).catch(() => '?')}`)
log('')

/* ─────────────────── 1. capture({rect}) ─────────────────── */

log('[1] capture({rect}) 800x600')
{
	// 这块矩形必须**整块落在屏幕内**：capture.ps1 走 CopyFromScreen，超出屏幕的部分会被
	// 默默裁掉（实测 x+w>1920 时拿回来的是 421x600 而不是 800x600 —— 静默的尺寸错误）。
	const R = { x: 300, y: 300, w: 800, h: 600 }
	const res = await shot.capture({ mode: 'desktop', rect: `${R.x},${R.y},${R.w},${R.h}` })
	check('1 capture 800x600', res.ok === true && res.width === 800 && res.height === 600, `rect=${R.x},${R.y},${R.w},${R.h} path=${res.path} ${res.width}x${res.height} ms=${res.ms} err=${res.error ?? ''}`)
	if (res.ok) fs.copyFileSync(res.path, path.join(SCRATCH, 'shot-800x600.png'))
}

/* ─────────────────── 2. hitwin.ps1 ─────────────────── */

log('[2] hitwin.ps1（区域中心点下面是谁）')
{
	const cx = 300 + 400
	const cy = 300 + 300
	const hit = await shot.hitTest(cx, cy)
	check('2 hitwin 认出 (700,600) 那个窗口', hit.ok === true && hit.hwnd > 0 && hit.title !== '', `(${cx},${cy}) -> hwnd=${hit.hwnd} title="${hit.title}" class="${hit.class}" pid=${hit.pid} rect=${hit.x},${hit.y},${hit.w},${hit.h}`)
}

/* ─────────────────── 3. manual 会话真跑 ─────────────────── */

let manualFrames = 0
let manualHeight = 0
let manualSingle = 0
let guardTripped = false
if (!visible) {
	log('[3] 跳过 manual —— 屏幕上没有"我的窗口在最上面"的位置（这台机器上窗口是用户的，随时会挡住）')
} else if (!(await ensureTop())) {
	// 扫描通过 ≠ 现在还在最上面：扫描到 scrollBegin 之间隔着一两秒，用户（或 DSH 自己）
	// 随时可能把窗口盖上来。会话"认领中心点下面那个顶层窗口"是它的契约，这时候它认对了
	// 反而是我们这条断言的前提没了 —— 和 4/7 一样先摆回原位再自问自答，不成立就如实跳过，
	// 不拿"窗口其实没在最上面"去判产品失败。
	log('[3] 跳过 manual —— 摆不回"我的窗口在最上面"（被用户/Chrome/DSH 盖住了），不拿一堆相同帧硬凑')
} else {
	log('[3] manual 长截图（用户自己滚 = 控制文件驱动窗口滚动）')
	const begin = await scroll.scrollBegin(RECT, { mode: 'manual', settleMs: 300 })
	check('3.0 scrollBegin(manual)', begin.ok === true && begin.active === true && begin.frames === 1, `frames=${begin.frames} mode=${begin.mode} target=${begin.target} "${begin.targetTitle}" ${begin.width}x${begin.height} err=${begin.error}`)
	// 会话的 target 必须真的是 lab 窗口本身 —— 否则后面"内容变了"这件事根本不成立。
	check('3.0b target 就是 lab 窗口', begin.target === info.hwnd, `target=${begin.target} lab=${info.hwnd} title="${begin.targetTitle}"`)
	// manual 一个像素都不许碰光标：契约值就是 n/a。
	check('3.0c manual 的 cursor 必须是 n/a', begin.cursor === 'n/a', `cursor=${begin.cursor} cursorAt="${begin.cursorAt}"`)

	// 用户滚三轮：每轮改一次窗口滚动位置，等它稳定。
	// 每一轮必须留够**两拍**（第一拍抓到新画面，第二拍确认稳定才 commit），而一拍 =
	// hitwin + capture 两次 pwsh 启动（并行后 ~1.5-2.5s），所以这里给 5.5s。
	// 这一条踩过：给 3.2s 时每拍都还没稳定就被下一次改动顶掉，frames 永远是 1 —— 是测试
	// 的节奏错了，不是产品错了（真实用户滚完会停住看几秒）。
	const offsets = [0, 500, 1000]
	for (const off of offsets) {
		setOffset(off)
		for (let i = 0; i < 11; i += 1) {
			await sleep(500)
			const s = await scroll.scrollStatus()
			if (i % 2 === 1) log(`      off=${off} t=${((i + 1) * 0.5).toFixed(1)}s frames=${s.frames} paused="${s.paused}" stalled=${s.stalled} preview=${s.preview === '' ? '-' : kb(s.preview.length)}`)
		}
	}
	const mid = await scroll.scrollStatus()
	manualFrames = mid.frames
	manualSingle = Number(mid.height) || 0

	// 3.4 「＋」立刻接一帧（用户手动按按钮那条路）：滚一下再按。
	//
	// ⚠️ 这条断言**不能**写成"必须 +1"：manual 循环的 tick 从 1.5s 降到 **0.15s**（R22 把
	//    hitTest 搬进常驻助手）之后，`sleep(1200)` 这 1.2 秒**已经够后台循环把新画面收进去了**，
	//    于是 add 抓到的是同一张图 —— 这不是产品缺陷，恰恰是"同一画面不重复拼"的契约在生效。
	//    所以判据改成两条**不依赖竞态**的不变量：
	//      ① add 不许凭空造帧，也不许在内容真的变了时静默不动（frames ∈ {N, N+1}，且与 stalled 自洽）；
	//      ② 紧接着再 add 一次（画面没再变）必须是 stalled —— 重复帧绝不能进长图。
	setOffset(1600)
	await sleep(1200)
	const beforeAdd = (await scroll.scrollStatus()).frames
	const added = await svc.scroll(RECT, JSON.stringify({ session: 'add' }))
	const addFrames = Number(added.frames) || 0
	const addSelfConsistent = added.stalled === 1 ? addFrames === beforeAdd : addFrames === beforeAdd + 1
	check(
		'3.4 {session:add} 立刻接一帧（不重复、不静默）',
		added.ok === true && addFrames >= beforeAdd && addFrames <= beforeAdd + 1 && addSelfConsistent,
		`frames ${beforeAdd} -> ${addFrames} stalled=${added.stalled}（stalled=1 表示后台循环已先收走同一张，正常）`
	)
	const dup = await svc.scroll(RECT, JSON.stringify({ session: 'add' }))
	check(
		'3.4b 画面没再变时 add 必须 stalled（重复帧不许进长图）',
		dup.ok === true && dup.stalled === 1 && Number(dup.frames) === addFrames,
		`frames ${addFrames} -> ${dup.frames} stalled=${dup.stalled}`
	)

	// 会话期间区域一直被别的窗口盖着（用户全屏）时，"接帧 + 拼接"根本没有发生的机会 ——
	// 那是环境问题，不该报成产品失败；如实跳过，并把 paused 打出来。
	const starved = manualFrames < 2
	if (starved) {
		const s0 = await scroll.scrollStatus()
		log(`      3.3 本轮跳过 —— 会话期间区域被别的窗口盖住（paused="${s0.paused}" frames=${s0.frames}），接帧没有发生的机会`)
	}
	const end = starved ? { ok: false, frames: 0, id: '', dataUrl: '', width: 0, height: 0, cursor: 'n/a', stopReason: '', error: 'skipped' } : await svc.scroll(RECT, JSON.stringify({ session: 'end' }))
	manualHeight = Number(end.height) || 0
	const hasId = typeof end.id === 'string' && end.id !== ''
	const file = hasId ? await svc._fileOf(end.id) : ''
	if (!starved) {
		check(
			'3.3 scrollEnd 拼接成一张正式截图',
			end.ok === true && end.frames >= 3 && manualHeight > manualSingle && file !== '' && String(end.dataUrl).startsWith('data:image/'),
			`frames=${end.frames} ${end.width}x${end.height}（单帧高 ${manualSingle}）id=${end.id} path=${end.path} dataUrl=${kb(String(end.dataUrl).length)} _fileOf=${file !== ''} cursor=${end.cursor} stopReason="${end.stopReason}" err=${end.error}`
		)
		if (end.ok) {
			try {
				fs.copyFileSync(end.path, path.join(SCRATCH, 'manual-long.png'))
			} catch {}
		}
	}

	// 3.5 cancel：会话要真的被清掉（status 里 active=false），不能只是"停止接帧"。
	const again = await scroll.scrollBegin(RECT, { mode: 'manual' })
	const cancelled = await svc.scroll(RECT, JSON.stringify({ session: 'cancel' }))
	const after = await scroll.scrollStatus()
	check(
		'3.5 {session:cancel} 停干净',
		again.ok === true && cancelled.ok === true && after.active === false && after.frames === 0,
		`begin frames=${again.frames} -> cancel frames=${cancelled.frames} cursor=${cancelled.cursor} -> status active=${after.active} frames=${after.frames}`
	)

	// ⚠️ 遮挡守卫（3.1/3.1b/3.2）**故意放在这一组最前面验完的最后**：它要 hide/show 测试窗口，
	// 而这台机器上 hide/show 之后窗口的消息循环有时会卡住（move 不再生效 —— run10 第 2 轮整轮
	// 都是这么废的）。放在最后，它就算把窗口弄坏也只影响它自己，不会连累上面已经验过的接帧/拼接。
	// 遮挡守卫：把区域藏起来 → 必须 paused='target-lost' 且不 commit；再放出来 → 必须自己
	// 恢复、接着接帧。
	// ⚠️ 这里有个**测试台**（不是产品）的坑：hide/show 之后这台机器上窗口有时回不到最上面，
	// 而低完整性进程没有任何办法把它拽回来。所以给它两次机会：第一次失败就换一块新窗口、
	// 把会话重开一遍再验"恢复"。两次都不行就如实跳过 3.2 —— 不拿"窗口根本没露出来"硬判产品。
	let guardResumed = false
	let resumeDetail = ''
	for (let attempt = 1; attempt <= 2 && !guardResumed; attempt += 1) {
		if (attempt > 1) {
			if (!(await ensureTop())) {
				log('      3.2 跳过 —— 换了窗口仍然上不去（测试台问题），没有合法前提')
				break
			}
		}
		const guardRect = `${info.x},${info.y},${info.w},${info.h}`
		setOffset(0)
		await sleep(600)
		const gb = await scroll.scrollBegin(guardRect, { mode: 'manual', settleMs: 300 })
		const guardBase = Number(gb.frames) || 0
		tell('h')
		await sleep(600)
		setOffset(680)
		await sleep(3000)
		const hidden = await scroll.scrollStatus()
		if (attempt === 1) {
			guardTripped = hidden.paused === 'target-lost' && hidden.frames === guardBase
			check('3.1 遮挡守卫 paused=target-lost 且不 commit', guardTripped, `paused="${hidden.paused}" frames=${hidden.frames}（隐藏前 ${guardBase}）lastError="${hidden.lastError}"`)
		}
		tell('s')
		const shown = await ensureTop()
		if (attempt === 1) {
			// 只报告不判死：这是"我的测试窗口能不能回来"，不是产品行为。
			log(`      3.1b 藏起来再切回来：ensureTop=${shown}（测试台状态，不作为产品断言）`)
		}
		if (!shown) {
			log(`      第 ${attempt} 次：窗口没能回到最上面，换一块再来`)
			await scroll.scrollCancel()
			continue
		}
		setOffset(1400)
		await sleep(6000)
		const back = await scroll.scrollStatus()
		if (back.paused === '' && back.frames > guardBase) {
			guardResumed = true
			resumeDetail = `第 ${attempt} 次：paused="" frames=${back.frames}（隐藏前 ${guardBase}）`
			check('3.2 切回来自动恢复并继续接帧', true, resumeDetail)
		} else {
			log(`      第 ${attempt} 次：窗口回来了但没接着接帧（paused="${back.paused}" frames=${back.frames}）`)
			await scroll.scrollCancel()
		}
	}
	if (!guardResumed) log('      3.2 本轮跳过 —— 两次都没能让"切回来→继续接帧"成立，没有合法前提，不硬判')
	await scroll.scrollCancel()
}

/* ─────────────────── 4. auto 会话（程序自己滚） ─────────────────── */

let autoFrames = 0
if (WITH_AUTO && visible && (await ensureTop())) {
	log('[4] auto 长截图（宿主发滚轮；本沙箱滚轮送不到，用替身）')
	setOffset(0)
	await sleep(600)
	// 光标账本：auto 开始前读一次，跑完再读一次 —— 这就是"程序别接管我的鼠标"的证据。
	const cursorBefore = await readCursor()
	const begin = await scroll.scrollBegin(RECT, { mode: 'auto', maxFrames: 5, settleMs: 400 })
	check('4.0 scrollBegin(auto)', begin.ok === true && begin.mode === 'auto', `mode=${begin.mode} target=${begin.target} frames=${begin.frames} cursor=${begin.cursor}`)
	// ⚠️ 这个沙箱里 `SetCursorPos` 被拒（实测返回 false、光标纹丝不动），所以 wheel.ps1
	// 的滚轮**物理上送不到 lab 窗口**（它只会发给真实光标底下那个窗口，也就是 Chrome，
	// 而且低完整性 → UIPI 还会把它丢掉）。于是这里用控制文件当"替身滚轮"制造同样的
	// "内容滚了一屏"，验的是 auto 循环本身：滚 → 等 settleMs → 抓 → commit → 到底/到顶即 done。
	// 滚轮投递本身**没有被验证**，报告里如实写了。
	let feederOff = 0
	const feeder = setInterval(() => {
		feederOff += 400
		setOffset(feederOff)
	}, 1200)
	const until = Date.now() + 60_000
	let s = await scroll.scrollStatus()
	// 会话进行中就把 cursorAt 记下来：归还**成功**之后 savedCursor 会被清空（cursorAt 变空），
	// 所以只有"跑着的时候"读到的才是这条链的证据。
	const cursorAtDuring = s.cursorAt
	while (Date.now() < until && !s.done) {
		await sleep(800)
		s = await scroll.scrollStatus()
		log(`      frames=${s.frames} done=${s.done} paused="${s.paused}" stalled=${s.stalled} elapsed=${s.elapsed}s cursor=${s.cursor} err="${s.lastError}"`)
	}
	clearInterval(feeder)
	autoFrames = s.frames
	check('4.1 auto 自己滚到 done', s.done === true && s.frames >= 2, `frames=${s.frames} done=${s.done} stalled=${s.stalled} elapsed=${s.elapsed}s lastError="${s.lastError}"`)
	const cursorAfter = await readCursor()
	// 断言只写**与环境无关、且能证明不撒谎**的性质（用户的手一直在动，"物理光标回来了"
	// 或者"我读到的坐标与它读到的相同"在这台机器上都不可证 —— 两次读之间人就把鼠标挪走了）：
	//   ① cursor 只能是 restored / failed / n/a 三个值之一；
	//   ② 独立标尺（直接问 wheel.ps1 -SetPos）回 ok=false 时，会话**绝不能**报 restored；
	//   ③ manual 会话必须是 n/a（3.0c 单独断言）；
	//   ④ auto 会话必须真的去读过光标：cursorAt 是合法的 "x,y"。
	const validCursor = ['restored', 'failed', 'n/a'].includes(String(s.cursor))
	const probeOk = cursorBefore === null ? null : await setPosProbe(cursorBefore)
	const honestCursor = probeOk === false ? s.cursor !== 'restored' : true
	const readHappened = /^\d+,\d+$/.test(String(cursorAtDuring))
	check(
		'4.2 auto 的光标签约（读过、且不撒谎）',
		validCursor && honestCursor && readHappened,
		`会话中 cursorAt="${cursorAtDuring}"（我这边同时读到 ${JSON.stringify(cursorBefore)}，差值是用户自己挪的）→ 退出后 cursor=${s.cursor}；独立标尺 -SetPos 同坐标 = ${probeOk}；跑完读到 ${JSON.stringify(cursorAfter)}`
	)
	const end = await svc.scroll(RECT, JSON.stringify({ session: 'end' }))
	check('4.3 auto 收官', end.ok === true, `frames=${end.frames} ${end.width}x${end.height} id=${end.id} cursor=${end.cursor} err=${end.error}`)
} else {
	log(`[4] 跳过 auto（${WITH_AUTO ? '没有可用的无遮挡窗口位' : '没有 --auto'}；它会把真实鼠标移到窗口中心发滚轮）`)
}

/* ─────────────────── 5. 录屏 + 后处理 ─────────────────── */

log('[5] record 全链路')
let recPath = ''
{
	const start = await svc.record('start', JSON.stringify({ fps: 15 }))
	check('5.0 record(start)', start.ok === true && start.recording === true, `path=${start.path} via=${start.via ?? '-'} err=${start.error}`)
	await sleep(4500)
	const stop = await svc.record('stop', '')
	recPath = String(stop.path ?? '')
	const inRec = recPath.startsWith(shot.REC_DIR)
	check(
		'5.1 record(stop) 落 CACHE_DIR/rec 且尺寸齐全',
		stop.ok === true && inRec && Number(stop.bytes) > 0 && Number(stop.width) > 0 && Number(stop.height) > 0 && Number(stop.duration) > 2.5,
		`path=${recPath} seconds=${stop.seconds} wallSeconds=${stop.wallSeconds} duration=${stop.duration} bytes=${kb(stop.bytes)} ${stop.width}x${stop.height} temp=${stop.temp} err=${stop.error}`
	)

	if (recPath !== '') {
		const inf = await svc.record('info', JSON.stringify({ path: recPath }))
		check('5.2 record(info)', inf.ok === true && Number(inf.duration) >= 2.5, `duration=${inf.duration} ${inf.width}x${inf.height} bytes=${kb(inf.bytes)} err=${inf.error}`)

		const fr = await svc.record('frame', JSON.stringify({ path: recPath, time: 1.5, width: 1280 }))
		const frFile = fr.id ? await svc._fileOf(fr.id) : ''
		check(
			'5.3 record(frame) 抽帧落成正式截图',
			fr.ok === true && String(fr.dataUrl).startsWith('data:image/') && frFile !== '' && frFile.startsWith(shot.SHOTS_DIR),
			`id=${fr.id} ${fr.width}x${fr.height} bytes=${kb(fr.bytes)} path=${fr.path} _fileOf=${frFile !== ''} dataUrl=${kb(String(fr.dataUrl).length)} err=${fr.error}`
		)

		const st = await svc.record('strip', JSON.stringify({ path: recPath, count: 6, width: 240 }))
		const sizes = (st.frames ?? []).map((f) => f.dataUrl.length)
		const biggest = sizes.length === 0 ? 0 : Math.max(...sizes)
		check(
			'5.4 record(strip) 6 张且每张 ≤150KB',
			st.ok === true && st.count === 6 && biggest <= wire.MAX_STRIP_BYTES,
			`count=${st.count} 最大=${kb(biggest)} 上限=${kb(wire.MAX_STRIP_BYTES)} 首帧t=${st.frames?.[0]?.t} err=${st.error}`
		)

		const at = await svc.record('attach', JSON.stringify({ path: recPath }))
		check(
			'5.5 record(attach) 读成 data URL',
			at.ok === true && String(at.dataUrl).startsWith('data:video/mp4;base64,') && at.mime === 'video/mp4' && at.name !== '',
			`name=${at.name} mime=${at.mime} bytes=${kb(at.bytes)} dataUrl=${kb(String(at.dataUrl).length)} err=${at.error}`
		)

		const bigFile = path.join(LAB, 'fake-big.bin')
		fs.writeFileSync(bigFile, Buffer.alloc(wire.MAX_ATTACH_BYTES + 1024, 7))
		const big = await svc.record('attach', JSON.stringify({ path: bigFile }))
		check('5.6 record(attach) 超 8MB 拒绝', big.ok === false && big.error === 'too-large' && Number(big.bytes) > wire.MAX_ATTACH_BYTES, `bytes=${kb(big.bytes)} error="${big.error}"`)
		const missing = await svc.record('attach', JSON.stringify({ path: path.join(LAB, 'nope.mp4') }))
		check('5.6b record(attach) 文件不存在明确报错', missing.ok === false && String(missing.error).startsWith('file not found'), `error="${missing.error}"`)

		const clip = await svc.record('clip', JSON.stringify({ path: recPath }))
		check('5.7 record(clip) 放进剪贴板（会覆盖你当前剪贴板）', clip.ok === true, `ok=${clip.ok} err=${clip.error}`)

		const unknown = await svc.record('nonsense', JSON.stringify({ path: recPath }))
		check('5.9 未知 action 明确报错', unknown.ok === false && unknown.error === 'unknown action: nonsense', `error="${unknown.error}"`)

		// open 放最后：它会在桌面上真的开一个播放器窗口，开完立刻关掉（别给用户留垃圾）。
		const open = await svc.record('open', JSON.stringify({ path: recPath }))
		check('5.8 record(open) 交给系统播放器', open.ok === true, `ok=${open.ok} err=${open.error}`)
		await sleep(2500)
		const closer = await shot.run(
			shot.findPwsh(),
			['-NoProfile', '-Command', `Get-Process | Where-Object { $_.MainWindowTitle -like '*${path.basename(recPath, '.mp4')}*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null; 'closed:' + $_.ProcessName }`],
			{ timeoutMs: 20_000 }
		)
		log(`      清理播放器窗口: ${closer.stdout.trim() || '(没找到窗口，可能播放器没起或标题不含文件名)'}`)
	}
}

/* ─────────────────── 6. 老路径不回归 ─────────────────── */

log('[6] 老自动路径 scroll(rect,"")')
{
	// 用固定矩形：这条验的是"老调用点没被弄断"，跟我的 lab 窗口在不在最上面无关 ——
	// 之前用 RECT，屏幕被用户全屏占满时它会变成空串，于是这条会假失败。
	const res = await svc.scroll(FIXED_RECT, JSON.stringify({ maxFrames: 4, settleMs: 300 }))
	check(
		'6 scroll 老路径（无 session 字段）',
		res.ok === true && Number(res.frames) >= 2 && Number(res.height) > 0,
		`frames=${res.frames} ${res.width}x${res.height} id=${res.id} path=${res.path} dataUrl=${kb(String(res.dataUrl).length)} err=${res.error}`
	)
}

/* ─────────────────── 7. 总高上限（DSH_SHOT_MAX_TOTAL_HEIGHT） ─────────────────── */

log('[7] 总高上限：把上限压小，看它会不会自己刹车、而且不把已抓到的图弄丢')

// 7.A **确定性**那一半：不需要窗口、不需要内容变化、不需要屏幕上有空位 ——
// 把上限压到比一帧还小（帧高 833），开场帧就会被闸门拒掉：frames=0、done=true、
// stopReason='max-height'。这一半在任何桌面状态下都能跑，也是"闸门真的存在"的硬证据。
{
	process.env.DSH_SHOT_MAX_TOTAL_HEIGHT = '400'
	const begin = await scroll.scrollBegin(FIXED_RECT, { mode: 'manual', settleMs: 300 })
	check(
		'7A.1 上限比一帧还小时，开场帧就被拒（不硬塞、不静默）',
		begin.ok === true && Number(begin.frames) === 0 && begin.done === true && begin.stopReason === 'max-height' && Number(begin.totalHeight) === 0,
		`maxTotalHeight=${begin.maxTotalHeight} frames=${begin.frames} done=${begin.done} stopReason="${begin.stopReason}" totalHeight=${begin.totalHeight}`
	)
	const endA = await svc.scroll(FIXED_RECT, JSON.stringify({ session: 'end' }))
	check(
		'7A.2 这种情况下收官如实说"帧不够"（不假装成功）',
		endA.ok === false && String(endA.error) === 'not enough frames' && endA.stopReason === 'max-height',
		`ok=${endA.ok} error="${endA.error}" stopReason="${endA.stopReason}" frames=${endA.frames}`
	)
	await scroll.scrollCancel()
	delete process.env.DSH_SHOT_MAX_TOTAL_HEIGHT
	log(`      7A 用的矩形 ${FIXED_RECT}（与 lab 窗口无关），所以这一半与桌面状态无关`)
}

// 7.B 另一半（要真的接到多帧才成立）：上限 1800 + 内容真的在变 → 第 2 帧进、第 3 帧被拒，
// 然后**已收到的两帧仍然拼得出来**。
// 优先用 lab 窗口（我完全控制它滚多少）；它到不了最上面时退而用固定矩形 —— 那时只要
// 屏幕上的东西自己在变（用户在看的监控页/视频），同样的闸门语义一样验得到；
// 内容整段时间都不变的话如实跳过，不硬判。
let capStitched = false
{
	const useLab = visible && (await ensureTop())
	const rectB = useLab ? RECT : FIXED_RECT
	log(`[7B] 用 ${useLab ? 'lab 窗口' : `固定矩形 ${FIXED_RECT}（lab 窗口上不去，退而求其次：只要画面自己在变就能验闸门）`}`)
	// 上限 = 2×帧高 + 1：**刚好只放得下两帧**，第三帧必被拒。这样无论用哪块矩形、
	// 帧高是多少（lab 窗口 833 / 固定矩形 600），都用最少的"画面变化次数"触到闸门。
	const frameH = useLab ? Number(info.h) || 800 : 600
	const limit = frameH * 2 + 1
	process.env.DSH_SHOT_MAX_TOTAL_HEIGHT = String(limit)
	setOffset(0)
	await sleep(600)
	const begin = await scroll.scrollBegin(rectB, { mode: 'manual', settleMs: 300 })
	check('7B.0 begin 读到新上限', begin.ok === true && Number(begin.maxTotalHeight) === limit, `maxTotalHeight=${begin.maxTotalHeight}（帧高 ${frameH} → 上限 ${limit}）frames=${begin.frames} totalHeight=${begin.totalHeight} target=${begin.target} "${String(begin.targetTitle).slice(0, 24)}"`)
	for (let i = 0; i < 12; i += 1) {
		if (useLab) setOffset(500 * (i + 1))
		await sleep(4500)
		const s = await scroll.scrollStatus()
		log(`      第${i + 1}拍 frames=${s.frames} totalHeight=${s.totalHeight} done=${s.done} paused="${s.paused}" stopReason="${s.stopReason}"`)
		if (s.done) break
	}
	const capped = await scroll.scrollStatus()
	if (capped.frames < 2) {
		log(`      [7B] 画面在这段时间里没有变化（frames=${capped.frames}）—— 这一段没有合法前提，如实跳过，不硬判`)
		await scroll.scrollCancel()
	} else {
		check(
			'7B.1 撞上限即刹车（done + stopReason + 不超上限）',
			capped.done === true && capped.stopReason === 'max-height' && capped.totalHeight <= 1800,
			`done=${capped.done} stopReason="${capped.stopReason}" frames=${capped.frames} totalHeight=${capped.totalHeight}（上限 ${capped.maxTotalHeight}）`
		)
		const end = await svc.scroll(rectB, JSON.stringify({ session: 'end' }))
		capStitched = end.ok === true && Number(end.height) > 0 && Number(end.height) <= 1800
		check(
			'7B.2 已收到的帧仍然拼得出来，且成品不超上限',
			capStitched && Number(end.frames) === Number(capped.frames) && end.stopReason === 'max-height',
			`frames=${end.frames} ${end.width}x${end.height} id=${end.id} stopReason="${end.stopReason}" totalHeight=${end.totalHeight} err=${end.error}`
		)
	}
	delete process.env.DSH_SHOT_MAX_TOTAL_HEIGHT
}

/* ─────────────────── 8. pickwin（可选，全屏 5 秒） ─────────────────── */

if (WITH_PICK) {
	log('[8] pickwin(5) —— 全屏覆盖 5 秒，到点自动取消')
	const t0 = Date.now()
	const res = await svc.pickwin(5)
	check(
		'8 pickwin 超时路径',
		res.ok === false && res.cancelled === true,
		`ok=${res.ok} cancelled=${res.cancelled} reason="${res.reason}" error="${res.error}" hwnd=${res.hwnd} ms=${res.ms} 墙钟=${Date.now() - t0}ms`
	)
} else {
	log('[8] 跳过 pickwin（没有 --pick；它会全屏覆盖 5 秒）')
}

/* ─────────────────── 9. 常驻抓屏助手 ─────────────────── */

// 助手是"第一次点 📷 要等三秒"的解药：一个活得比一次调用长的 pwsh，请求/响应走文件。
// 这一节要证明的四件事，缺一件它就不配上生产：
//   ① 冷启动后第一次抓屏就是快的（启动开销 + JIT 预热都在用户点之前付掉）；
//   ② 连续第二次更快/同样快，而且**是两张不同的图**（不是把上一张端回来）；
//   ③ 助手被杀掉之后，抓屏照样成功，并且能自己重新拉起一个；
//   ④ 返回结构与失败文案与老路径**逐字一致** —— 客户端分辨不出走的是哪条路。
// 外加静态检查：shotcore.ps1 是被点源进常驻进程的，里面一个 `exit` 都不能有。
log('[9] 常驻抓屏助手（shooter）')
{
	const SHOT_PS = path.join(PLUGIN, 'ps', 'shooter.ps1')
	const CORE_PS = path.join(PLUGIN, 'ps', 'shotcore.ps1')

	/** OS 层真活着吗（EPERM = 在，只是没权限动它）。 */
	const pidAlive = (pid) => {
		if (!pid) return false
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			return error?.code === 'EPERM'
		}
	}
	const waitGone = async (pid, ms = 3000) => {
		const t0 = Date.now()
		while (Date.now() - t0 < ms) {
			if (!pidAlive(pid)) return Date.now() - t0
			await sleep(40)
		}
		return -1
	}
	const waitReady = async (ms = 30_000) => {
		const t0 = Date.now()
		while (Date.now() - t0 < ms) {
			if (shooter.shooterStatus().ready) return Date.now() - t0
			await sleep(40)
		}
		return -1
	}

	// ── 9.0 静态：被点源进常驻进程的那个文件里绝不能有 exit ──
	{
		const core = fs.readFileSync(CORE_PS, 'utf8')
		const coreExit = core.split(/\r?\n/).filter((l) => /^\s*exit\b/.test(l))
		check('9.0a shotcore.ps1 里没有可执行的 exit（有就等于杀掉常驻助手）', coreExit.length === 0, `exit lines=${coreExit.length}`)
		const shell = fs.readFileSync(path.join(PLUGIN, 'ps', 'capture.ps1'), 'utf8')
		check('9.0b capture.ps1 仍然点源 shotcore.ps1（只有一份抓屏实现）', shell.indexOf("shotcore.ps1") !== -1 && shell.indexOf('Invoke-DshCapture') !== -1)
		const nonAscii = (file) => {
			const buf = fs.readFileSync(file)
			let n = 0
			for (const b of buf) if (b > 127) n += 1
			return n
		}
		// ⚠️ 这两个文件必须**零非 ASCII 字节**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 GBK
		//    解码，一旦掺进中文就得连带 UTF-8 BOM，而 BOM 在点源/拼接链路上又是另一个坑。
		check('9.0c shotcore.ps1 + shooter.ps1 仍是纯 ASCII', nonAscii(CORE_PS) === 0 && nonAscii(SHOT_PS) === 0, `core=${nonAscii(CORE_PS)} shooter=${nonAscii(SHOT_PS)}`)
		const sh = fs.readFileSync(SHOT_PS, 'utf8')
		check('9.0d shooter.ps1 有待机轮询（不是忙等）', sh.indexOf('[System.Threading.Thread]::Sleep') !== -1 && sh.indexOf('IdleMs') !== -1)
		check('9.0e shooter.ps1 有 stop 标志与父进程看门狗', sh.indexOf('stop-') !== -1 && sh.indexOf('Test-TargetAlive') !== -1 && sh.indexOf('parent-gone') !== -1)
		check('9.0f shooter.ps1 写响应是 tmp+rename（读者看不到半个 JSON）', sh.indexOf('Write-JsonFile') !== -1 && sh.indexOf("$Path + '.tmp'") !== -1)
	}

	// ── 9.1 幂等：连调两次只应该有一个助手 ──
	// 注意 [1] 抓第一张图时 shootViaHelper 已经顺手把它拉起来了（这就是插件运行期的行为）。
	const firstPid = shooter.shooterStatus().pid
	const again = shooter.startShooter()
	check('9.1 startShooter 幂等（第二次不新起进程）', again.ok === true && again.already === true && again.pid === firstPid, `pid=${firstPid} again=${again.pid} already=${again.already}`)

	// ── 9.2 冷启动：从零起一个助手，等它就绪，再测第一次抓屏 ──
	// 先把已经热着的那个收掉，否则测不到"冷" —— 并且顺便验收尾。
	const warmPid = shooter.shooterStatus().pid
	shooter.stopShooter()
	const goneMs = await waitGone(warmPid)
	check('9.2a stopShooter 真的收掉了 OS 进程', goneMs >= 0, `pid=${warmPid} gone in ${goneMs}ms`)

	const t0 = Date.now()
	const started = shooter.startShooter()
	const readyMs = await waitReady()
	check('9.2b 冷启动到就绪（含 Add-Type + C# 编译 + 预热抓屏）', started.ok === true && readyMs > 0 && readyMs < 20_000, `ready in ${readyMs}ms (startShooter 本身 ${Date.now() - t0 - readyMs}ms) pid=${started.pid}`)

	// 老路径的对照：同一台机器、同一块屏幕、同一个进程里，紧接着测一次。
	process.env.DSH_SHOT_HELPER = '0'
	const tLegacy = Date.now()
	const legacy = await shot.capture({ mode: 'desktop' })
	const legacyMs = Date.now() - tLegacy
	delete process.env.DSH_SHOT_HELPER

	const t1 = Date.now()
	const cold = await shot.capture({ mode: 'desktop' })
	const coldMs = Date.now() - t1
	const t2 = Date.now()
	const hot = await shot.capture({ mode: 'desktop' })
	const hotMs = Date.now() - t2

	check('9.2c 冷启动后第一次抓屏就是快的', cold.ok === true && coldMs < 1500 && coldMs * 2 < legacyMs, `helper=${coldMs}ms legacy=${legacyMs}ms ${cold.width}x${cold.height}`)
	check('9.2d 热态第二次抓屏同样快', hot.ok === true && hotMs < 1500, `helper=${hotMs}ms ${hot.width}x${hot.height}`)
	check('9.2e 两次是两张不同的图（不是把上一张端回来）', cold.path !== hot.path && fs.existsSync(cold.path) && fs.existsSync(hot.path), `${path.basename(cold.path)} / ${path.basename(hot.path)} size=${kb(fs.statSync(hot.path).size)}`)
	// 客户端依赖的就是这个结构 —— 助手路径与老路径的字段必须**完全一样**。
	{
		const lk = Object.keys(legacy).sort().join(',')
		const ck = Object.keys(cold).sort().join(',')
		check('9.2f 助手路径的返回结构与老路径逐字一致', lk === ck, `legacy=[${lk}] helper=[${ck}]`)
	}
	// 尺寸/坐标/方法这些"内容"字段也要对得上（同一个屏幕，同一块虚拟屏）。
	check('9.2g 助手上报的几何信息与老路径一致', cold.width === legacy.width && cold.height === legacy.height && cold.left === legacy.left && cold.top === legacy.top && cold.method === legacy.method && cold.hwnd === legacy.hwnd, `helper=${cold.width}x${cold.height}@${cold.left},${cold.top}/${cold.method}/hwnd=${cold.hwnd} legacy=${legacy.width}x${legacy.height}@${legacy.left},${legacy.top}/${legacy.method}/hwnd=${legacy.hwnd}`)

	// ── 9.3 助手被外力杀掉：下一次抓屏必须照样成功 ──
	const victim = shooter.shooterStatus().pid
	try {
		process.kill(victim)
	} catch {}
	const gone2 = await waitGone(victim)
	await sleep(200)
	const t3 = Date.now()
	const afterKill = await shot.capture({ mode: 'desktop' })
	const afterKillMs = Date.now() - t3
	check('9.3a 助手被杀后抓屏仍然成功（自动回落）', victim > 0 && gone2 >= 0 && afterKill.ok === true, `killed pid=${victim} (gone in ${gone2}ms) -> ok=${afterKill.ok} ${afterKill.width}x${afterKill.height} ${afterKillMs}ms`)
	// 而且下一次抓屏不该永远慢下去：冷却之后要能自己拉一个新的起来。
	let respawned = shooter.shooterStatus()
	if (!respawned.alive) {
		const t4 = Date.now()
		const retry = await shot.capture({ mode: 'desktop' })
		const retryMs = Date.now() - t4
		respawned = shooter.shooterStatus()
		check('9.3b 回落之后能自动拉起新助手', respawned.alive === true, `after retry ok=${retry.ok} ${retryMs}ms -> alive=${respawned.alive} pid=${respawned.pid}`)
	} else {
		check('9.3b 回落之后能自动拉起新助手', true, `alive again immediately pid=${respawned.pid}`)
	}
	// 新助手可能还在 Add-Type（"没就绪就回落"是正常路径），等到就绪再验它真的能干活。
	const ready2 = await waitReady()
	const t5 = Date.now()
	const served = await shot.capture({ mode: 'desktop' })
	check('9.3c 重新拉起的助手确实在干活', ready2 >= 0 && served.ok === true && Date.now() - t5 < 1500, `ready in ${ready2}ms -> ${Date.now() - t5}ms served=${shooter.shooterStatus().served}`)

	// ── 9.4 超时回落：把助手预算压到 1ms，抓屏不能被它拖死 ──
	process.env.DSH_SHOT_HELPER_MS = '1'
	const t6 = Date.now()
	const fell = await shot.capture({ mode: 'desktop' })
	const fellMs = Date.now() - t6
	delete process.env.DSH_SHOT_HELPER_MS
	check('9.4 助手超时 -> 静默回落老路径，结果照旧', fell.ok === true && fell.width === legacy.width, `fallback ${fellMs}ms ok=${fell.ok} ${fell.width}x${fell.height} err=${fell.error ?? ''}`)

	// ── 9.5 失败文案契约：助手与老路径对同一次失败必须说同一句话 ──
	// 走同一个必然失败的调用（不存在的句柄 + 不存在的标题），一边直接调助手、一边跑老 CLI。
	{
		const failReq = { mode: 'window', hwnd: 999999, target: 'ZZZNOPE-9f3a', hideSelf: false, method: 'screen', rect: '', noRestore: true }
		const direct = await shooter.shootViaHelper({ ...failReq, out: shot.shotPath() })
		const res = await shot.run(shot.findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'capture.ps1'), '-Mode', 'window', '-Out', shot.shotPath(), '-Json', '-Hwnd', '999999', '-Target', 'ZZZNOPE-9f3a', '-NoRestore'], { timeoutMs: 30_000 })
		const helperError = String(direct?.info?.error ?? '')
		check(
			'9.5 助手与老路径对同一个失败给出逐字相同的消息',
			direct !== null && direct.ok === false && helperError.length > 0 && res.stderr.includes(helperError) && res.code === 1,
			`helper="${helperError}" cliExit=${res.code} cliStderrHasIt=${res.stderr.includes(helperError)}`
		)
	}

	// ── 9.6 收尾：幂等，且 OS 层真的走干净 ──
	{
		const last = shooter.shooterStatus().pid
		shooter.stopShooter()
		let idempotent = true
		try {
			shooter.stopShooter()
		} catch {
			idempotent = false
		}
		const gone3 = await waitGone(last)
		check('9.6 stopShooter 幂等且 OS 进程真的没了', idempotent && gone3 >= 0, `pid=${last} gone in ${gone3}ms`)
	}
}

/* ─────────────────── 10 原生覆盖层：regionOnly（只取矩形） ───────────────────
 *
 * 长截图 / 提取文字 / 屏幕翻译的第一步都是「框一块屏幕区域」。它们以前用 DOM 覆盖层，
 * 而 DOM 覆盖层的 canvas 是整屏原始像素、被 DSH 窗口裁剪 ⇒ **只能框到屏幕左上角一块**。
 * 现在统一走原生助手，请求里带 regionOnly：只要矩形，不标注 / 不写剪贴板 / 不落盘。
 *
 * 这一组刻意**从服务类进**（svc.overlay），而不是直接调 overlayPick：
 * 客户端真正调到的是这一层，少透传一个字段整条改动就是白改（R19 的教训）。
 * 同时验**反向**：不带 regionOnly 时必须还是老行为（有剪贴板、有 PNG），
 * 否则"顺手把截图也改成不落盘了"这种回归没人发现。
 */
{
	const overlay = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'overlay.mjs')).href)
	overlay.stopOverlayHost()
	await sleep(300)
	const boot = overlay.startOverlayHost()
	let readyMs = -1
	const tReady = Date.now()
	for (let i = 0; i < 200; i += 1) {
		if (overlay.overlayStatus().ready === true) {
			readyMs = Date.now() - tReady
			break
		}
		await sleep(80)
	}
	check('10.0 覆盖层助手起得来并完成 ready 握手', boot.ok === true && readyMs >= 0, `pid=${boot.pid} ready in ${readyMs}ms dir=${overlay.OVERLAY_DIR}`)

	const regionPng = path.join(LAB, 'overlay-region-should-not-exist.png')
	try { fs.unlinkSync(regionPng) } catch {}
	const region = await svc.overlay(20, JSON.stringify({ regionOnly: true, selfTest: true, png: regionPng }))
	check('10.1 服务类把 regionOnly 透传给助手', region.ok === true && region.regionOnly === true, `ok=${region.ok} regionOnly=${region.regionOnly} reason=${region.reason}`)
	check('10.2 regionOnly 回的矩形可用（320x240）', Number(region.w) === 320 && Number(region.h) === 240, `${region.w}x${region.h} @ ${region.x},${region.y}`)
	check('10.3 regionOnly 不写剪贴板（别顶掉用户复制的东西）', region.clip === false, `clip=${region.clip}`)
	check('10.4 regionOnly 不落盘（给了路径也不写）', region.png === '' && fs.existsSync(regionPng) === false, `png='${region.png}' exists=${fs.existsSync(regionPng)}`)

	const pickPng = path.join(LAB, 'overlay-pick.png')
	try { fs.unlinkSync(pickPng) } catch {}
	const picked = await svc.overlay(20, JSON.stringify({ selfTest: true, png: pickPng }))
	check('10.5 不带 regionOnly 仍是标注模式（有剪贴板 + 有 PNG）',
		picked.ok === true && picked.regionOnly === false && picked.clip === true && fs.existsSync(pickPng),
		`ok=${picked.ok} regionOnly=${picked.regionOnly} clip=${picked.clip} png=${fs.existsSync(pickPng)}`)

	check('10.6 两次框选之后助手仍然活着（一次失败不带死整条链）', overlay.overlayStatus().alive === true, `alive=${overlay.overlayStatus().alive} calls=${overlay.overlayStatus().calls}`)
	overlay.stopOverlayHost()
	await sleep(1200)
	check('10.7 收尾干净（OS 进程真的没了）', overlay.overlayStatus().alive === false, `alive=${overlay.overlayStatus().alive}`)
}

/* ─────────────────── 收尾 ─────────────────── */

try {
	tell('q')
	await sleep(400)
	scroller.kill()
} catch {}
log('')
log('── 汇总 ──')
for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`)
const bad = results.filter((r) => !r.ok).length
log(`manual frames=${manualFrames} 高=${manualHeight}（单帧 ${manualSingle}） auto frames=${autoFrames}`)
log(bad === 0 ? `全部 ${results.length} 项通过` : `${bad}/${results.length} 项失败`)
process.exit(bad === 0 ? 0 : 1)
