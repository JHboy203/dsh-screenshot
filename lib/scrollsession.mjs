/**
 * lib/scrollsession.mjs — 长截图会话（**宿主侧**，manual / auto 两种模式）。
 *
 * 用户的原话是「滚动截屏没效果，既不会自己滚，也不能我鼠标滚轮控制着滚」。两个症状
 * 对应两个设计错误，这一版把它们一起改掉：
 *
 * ① **为什么会话必须跑在宿主（node）里，而不是渲染进程**
 *    用户滚的是**别的窗口**（浏览器等）。那一刻 DSH 是失焦的，而 Chromium 对失焦窗口的
 *    定时器节流是 1 次/分钟（background throttling）。上一版把「滚轮监听 + 定时抓帧」
 *    放在客户端，在真机上就等于完全没工作 —— 这就是"没效果"的根因。宿主进程是普通
 *    node，没有节流这回事；抓屏（capture.ps1 -Rect）也不需要前台窗口，
 *    所以会话改成：客户端只负责开始/查状态/结束，**抓帧全部在宿主里自走**。
 *
 * ② **手动模式不再依赖"用户滚动事件"**
 *    宿主听不到别的窗口的滚轮（那是别的进程的窗口消息）。所以手动模式改成**轮询 + 指纹**：
 *    每 ~260ms 抓一次这块区域，用 **PNG 字节的 sha1** 当指纹。BitBlt 是确定性的 ——
 *    画面没变，字节就完全一样，所以"变了没变"不需要任何图像解码依赖。
 *    变化之后还要**等它稳定**（连续两次抓到的指纹相同）才 commit，避免把滚一半的
 *    半截画面当成一帧接进长图。
 *
 * ③ **遮挡守卫**（paused='target-lost'）
 *    会话开始时记下"区域中心点下面那个顶层窗口"当 target。每一拍先问一次中心点下面是
 *    不是它；不是（用户点回 DSH 了，或别的窗口盖上来）就**不 commit**，继续轮询，
 *    切回来自动恢复。这条是"用户滚完回到 DSH 点完成"时结果不被污染的关键 ——
 *    那一刻区域里的像素已经换成 DSH 自己了。
 *
 * 会话是**单例**的：同一时刻只可能有一个长截图在进行（屏幕上只有一套覆盖层）。
 * 任何异常都记进 session.error 并从 status 里读得出来，绝不静默死掉。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { CACHE_DIR, PS_DIR, PY_DIR, capture, findPython, findPwsh, hitTest, lastJsonLine, run, shotPath, thumb, wheelAt } from './shot.mjs'

/** 轮询间隔（**目标**值）。实际节拍 = 这个值 - 上一拍耗时，见 schedule()。 */
const POLL_MS = 260
/** 一次会话最多留多少帧（内存与耗时的兜底，不是功能上限）。 */
const MAX_FRAMES = 40
/** 默认最多帧数：40 帧 × 一屏已经是很长的页面了。 */
const DEFAULT_MAX_FRAMES = 40
/** 默认滚动/稳定等待。太短会抓到滚一半的画面，太长会明显拖慢自动模式。 */
const DEFAULT_SETTLE_MS = 420
/** 预览缩略图宽度（客户端那一小条"在抓了"）。 */
const PREVIEW_WIDTH = 140
/**
 * 长图总高的**默认**上限（像素）。
 *
 * 为什么必须有：`DEFAULT_MAX_FRAMES=40` × 一帧 1080px ≈ **43000px**，而拼接那一刻要在内存里
 * 造一张 1920×43000 的位图 —— 那是几百 MB 的峰值，正好炸在"用户最在意的长截图"这条路上。
 * 累加用**真实帧高**（capture 报的），不估算：stitch.py 的成品高 = 首帧高 + Σ滚动量，而每段
 * 滚动量都不会超过该帧高度，所以"Σ帧高"就是拼接峰值内存的保守上界。
 *
 * `DSH_SHOT_MAX_TOTAL_HEIGHT` 可覆盖（自检用得上：小页面就能触发上限，不必真滚三万像素）。
 */
const MAX_TOTAL_HEIGHT = 30000

/** 本次会话的上限：begin 时读一次，方便自检在同一个进程里换值。 */
function maxTotalHeight() {
	const n = Number(process.env.DSH_SHOT_MAX_TOTAL_HEIGHT)
	return Number.isFinite(n) && n >= 200 ? Math.trunc(n) : MAX_TOTAL_HEIGHT
}

const session = {
	active: false,
	mode: 'manual',
	rect: '',
	x: 0,
	y: 0,
	w: 0,
	h: 0,
	/** 这块区域归哪个顶层窗口所有；0 = 没认出来（此时守卫失效，只能靠指纹）。 */
	target: 0,
	targetTitle: '',
	/** 工作目录（CACHE_DIR/scroll/<sid>）：所有中间帧都在里面，收尾一次删干净。 */
	dir: '',
	/** [{file, fp, at}] 已 commit 的帧，顺序即屏幕顺序。 */
	frames: [],
	/** 最后一帧**已 commit** 的指纹：新抓的和它相同 = 画面没动。 */
	lastFp: '',
	/** 已抓过但还没确认稳定的那一帧（连续两次相同才 commit）。 */
	stagedFile: '',
	stagedFp: '',
	stagedHeight: 0,
	/** 抓帧计数（只用来命名文件）。 */
	grabs: 0,
	/** 稳定确认之间的限流：别把一帧录两次。 */
	committedAt: 0,
	paused: '',
	stalled: 0,
	done: false,
	error: '',
	maxFrames: DEFAULT_MAX_FRAMES,
	settleMs: DEFAULT_SETTLE_MS,
	/** 已 commit 的帧高之和 = 拼接成品的保守上界（见 MAX_TOTAL_HEIGHT 的注释）。 */
	totalHeight: 0,
	maxTotalHeight: MAX_TOTAL_HEIGHT,
	/** 为什么停：'' 正常 / 'max-height' 撞到总高上限（客户端读它给提示）。 */
	stopReason: '',
	started: 0,
	busy: false,
	looping: false,
	timer: null,
	preview: '',
	previewFor: -1,
	previewBusy: false,
	/** auto 模式开跑前记下的光标位置（**只读一次**）；manual 恒为 null —— 用户自己的鼠标一个像素都不碰。 */
	savedCursor: null,
	/** 最近一次"还光标"的结果：'' | 'restored' | 'failed'（'n/a' 只在返回时兜底）。 */
	cursorState: '',
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function clearTimer() {
	if (session.timer !== null) {
		clearInterval(session.timer)
		clearTimeout(session.timer)
		session.timer = null
	}
}

/**
 * 排下一拍。
 * ⚠️ `unref()` 是必须的：这是个常驻轮询定时器，不 unref 的话 DSH 退出时会被它拖住
 *    （进程挂着不退，用户看到的是"关不掉"）。
 */
function schedule(delay) {
	if (!session.active || session.done) return
	clearTimer()
	session.timer = setTimeout(() => {
		session.timer = null
		void tick()
	}, Math.max(0, delay))
	if (typeof session.timer.unref === 'function') session.timer.unref()
}

function drop(file) {
	if (typeof file !== 'string' || file === '') return
	try {
		fs.rmSync(file, { force: true })
	} catch {}
}

function parseRect(rect) {
	const parts = String(rect ?? '')
		.split(',')
		.map(Number)
	if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) return null
	return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
}

/** 读 PNG 尺寸（只解 IHDR，不解码整张图）。失败给全 0，调用方自己兜。 */
function pngSize(file) {
	const out = { width: 0, height: 0 }
	try {
		const fd = fs.openSync(file, 'r')
		try {
			const buf = Buffer.alloc(24)
			fs.readSync(fd, buf, 0, 24, 0)
			// 8 字节签名 + 4 长度 + 4 'IHDR' + 4 宽 + 4 高
			if (buf.toString('ascii', 12, 16) !== 'IHDR') return out
			out.width = buf.readUInt32BE(16)
			out.height = buf.readUInt32BE(20)
		} finally {
			fs.closeSync(fd)
		}
	} catch {}
	return out
}

/** 中心点（物理像素）。 */
function center() {
	return { cx: Math.round(session.x + session.w / 2), cy: Math.round(session.y + session.h / 2) }
}

/** 清空会话；工作目录（含所有中间帧）一次删干净。 */
function reset() {
	clearTimer()
	if (session.dir !== '') {
		try {
			fs.rmSync(session.dir, { recursive: true, force: true })
		} catch {}
	}
	session.active = false
	session.rect = ''
	session.dir = ''
	session.frames = []
	session.lastFp = ''
	session.stagedFile = ''
	session.stagedFp = ''
	session.stagedHeight = 0
	session.totalHeight = 0
	session.stopReason = ''
	session.grabs = 0
	session.committedAt = 0
	session.paused = ''
	session.stalled = 0
	session.done = false
	session.error = ''
	session.started = 0
	session.busy = false
	session.looping = false
	session.target = 0
	session.targetTitle = ''
	session.preview = ''
	session.previewFor = -1
	session.previewBusy = false
	session.savedCursor = null
	session.cursorState = ''
	session.w = 0
	session.h = 0
}

/* ─────────────────────────── 光标（只属于 auto） ─────────────────────────── */

/**
 * auto 模式会**真的发滚轮**（wheel.ps1 的 SetCursorPos + mouse_event），而滚轮事件只会
 * 发给光标底下那个窗口 —— 所以程序必须先把光标挪到区域中心。挪完不还，用户就会看到
 * 「程序接管了我的鼠标」，这正是一整轮投诉的根因。规矩定死：
 *
 *   - 读光标：**只在 auto 开始时读一次**（多读没有意义，中间用户也不该在动它）；
 *   - 还光标：auto 循环一退出就还，scrollEnd / scrollCancel 再兜一次（幂等）；
 *   - **manual 模式一个像素都不许碰** —— 那时候鼠标是用户自己在用。
 */
function wheelArgs(extra) {
	return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'wheel.ps1'), ...extra]
}

/** 读当前光标；问不到就给 null（还不了光标不等于会话不能跑）。 */
async function getCursor() {
	try {
		const res = await run(findPwsh(), wheelArgs(['-GetPos']), { timeoutMs: 10_000 })
		const info = lastJsonLine(res.stdout)
		if (info === null || info.ok !== true) return null
		const x = Number(info.x)
		const y = Number(info.y)
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null
		return { x, y }
	} catch {
		return null
	}
}

/** 把光标放回去。true = 脚本回了 ok。 */
async function setCursor(pos) {
	try {
		const res = await run(findPwsh(), wheelArgs(['-SetPos', `${pos.x},${pos.y}`]), { timeoutMs: 10_000 })
		const info = lastJsonLine(res.stdout)
		return info !== null && info.ok === true
	} catch {
		return false
	}
}

/**
 * 幂等地还光标：
 *   - `cursor:'n/a'`   没有要还的（manual，或从没读过）；
 *   - `cursor:'restored'` 还成功（成功之后 savedCursor 清空，再调一次就是 n/a）；
 *   - `cursor:'failed'` 脚本说没还成 —— **保留 savedCursor**，让 end/cancel 还能再试一次。
 * 这个函数**永不抛**：它还不上光标，也绝不能影响 end/cancel 本身的结果。
 */
async function restoreCursor() {
	if (session.savedCursor === null) return session.cursorState === '' ? 'n/a' : session.cursorState
	const ok = await setCursor(session.savedCursor)
	if (ok) {
		session.savedCursor = null
		session.cursorState = 'restored'
	} else {
		session.cursorState = 'failed'
	}
	return session.cursorState
}

/* ─────────────────────────── 抓帧 ─────────────────────────── */

/**
 * 抓一次当前区域，算指纹，并把文件**搬进会话工作目录**。
 *
 * 为什么要搬：`capture()` 落在 SHOTS_DIR，而那里有个只保留最近 40 张的裁剪器
 * （shot.mjs#pruneShots，每次 capture 都会顺手跑一次）。会话的帧必须活到 scrollEnd，
 * 留在 SHOTS_DIR 就有被当成"最老的截图"删掉的风险 —— 一次 40 帧的会话正好能把
 * 自己的开头几帧裁没。搬走之后 SHOTS_DIR 里只剩一张瞬时文件，裁剪器碰不到我们的帧。
 *
 * @returns {Promise<{ok: boolean, file?: string, fp?: string, bytes?: number,
 *   width?: number, height?: number, error?: string}>}
 */
async function grabFrame() {
	const res = await capture({ mode: 'desktop', rect: session.rect, noRestore: true, timeoutMs: 25_000 })
	if (!res.ok) return { ok: false, error: String(res.error ?? 'capture failed') }
	let buf
	try {
		buf = fs.readFileSync(res.path)
	} catch (error) {
		drop(res.path)
		return { ok: false, error: 'read frame: ' + String(error?.message ?? error) }
	}
	// 指纹 = PNG 字节的 sha1。BitBlt 是确定性的：同一块没变的屏幕，两次抓到的字节一模一样。
	const fp = crypto.createHash('sha1').update(buf).digest('hex')
	session.grabs += 1
	const dest = path.join(session.dir, `f${String(session.grabs).padStart(3, '0')}.png`)
	try {
		fs.writeFileSync(dest, buf)
	} catch (error) {
		drop(res.path)
		return { ok: false, error: 'write frame: ' + String(error?.message ?? error) }
	}
	drop(res.path)
	return {
		ok: true,
		file: dest,
		fp,
		bytes: buf.length,
		width: Number(res.width) || session.w,
		height: Number(res.height) || session.h,
	}
}

/**
 * 把一帧记进会话。
 *
 * **这里是总高闸门**：所有提交（开场帧、manual 的稳定确认、auto、用户按「＋」）都走这一个口，
 * 所以上限只可能在一处失守。超限时**不提交**、把会话标成 done、并留下 stopReason。
 * @returns {boolean} true = 收下了；false = 撞到总高上限（已经 done，调用方要停）
 */
function commit(file, fp, height) {
	const frameHeight = Number(height) || session.h
	const next = session.totalHeight + frameHeight
	if (next > session.maxTotalHeight) {
		drop(file)
		session.stagedFile = ''
		session.stagedFp = ''
		session.stagedHeight = 0
		session.stopReason = 'max-height'
		session.done = true
		return false
	}
	session.frames.push({ file, fp, at: Date.now(), height: frameHeight })
	session.totalHeight = next
	session.lastFp = fp
	session.committedAt = Date.now()
	session.stalled = 0
	// 让下一次 status 重新生成预览（不在这里同步生成：它会多起一个 pwsh，拖慢抓帧）。
	session.previewFor = -1
	return true
}

/**
 * 遮挡守卫：区域中心点下面还是 target 吗？
 * target 没认出来（0）时守卫**失效但不阻塞** —— 宁可少一层保护，也不要整个功能不可用；
 * 这种情况下 status 里的 targetTitle 是空的，界面能看出来。
 */
async function guard() {
	if (session.target === 0) return { ok: true, hwnd: 0, reason: '' }
	const { cx, cy } = center()
	const hit = await hitTest(cx, cy)
	if (!hit.ok) return { ok: true, hwnd: 0, reason: '' } // 问不到就不拦，指纹那一层还在
	if (hit.hwnd !== session.target) return { ok: false, hwnd: hit.hwnd, reason: 'target-lost' }
	return { ok: true, hwnd: hit.hwnd, reason: '' }
}

/* ─────────────────────────── 两拍 ─────────────────────────── */

/**
 * manual 的一拍：抓一次 → 指纹比对 → 稳定了才 commit。
 * 这个函数**永不抛**（抛出去就没有下一拍了，会话会静默停住）。
 */
async function step() {
	// 守卫与抓帧**并行**：这一拍的成本几乎全是两次 pwsh 启动（hitwin ~1s + capture ~1-2s），
	// 串起来一拍 2.5~3.5s，并行能砍掉近一半。手动模式里"用户滚完停一下"往往只有两三秒，
	// 拍子越快越接得住；代价是区域被盖住时白抓一帧（那一帧直接丢掉，不 commit）。
	const [g, grab] = await Promise.all([guard(), grabFrame()])
	if (!g.ok) {
		session.paused = g.reason
		drop(grab.file)
		return
	}
	session.paused = ''
	if (session.frames.length >= session.maxFrames) {
		session.done = true
		drop(grab.file)
		return
	}
	if (!grab.ok) {
		session.error = String(grab.error ?? 'capture failed')
		return
	}
	// 和已 commit 的最后一帧一样 = 画面没动（用户还没滚，或者到底了）。
	if (grab.fp === session.lastFp) {
		drop(session.stagedFile)
		session.stagedFile = ''
		session.stagedFp = ''
		session.stagedHeight = 0
		drop(grab.file)
		return
	}
	// 连续两次抓到同一个新画面 = 滚完了、稳定了。
	if (session.stagedFile !== '' && grab.fp === session.stagedFp) {
		const now = Date.now()
		if (now - session.committedAt >= session.settleMs) {
			const file = session.stagedFile
			const fp = session.stagedFp
			const height = session.stagedHeight
			session.stagedFile = ''
			session.stagedFp = ''
			session.stagedHeight = 0
			// 撞到总高上限时 commit 自己会把 done/stopReason 设好。
			commit(file, fp, height)
			drop(grab.file)
		} else {
			// 限流：这一帧已经确认稳定了，但离上一帧太近。留着 staged，下一拍再收。
			drop(grab.file)
		}
		return
	}
	// 新内容：换掉还没确认的 staged（它多半是滚到一半的画面）。
	drop(session.stagedFile)
	session.stagedFile = grab.file
	session.stagedFp = grab.fp
	session.stagedHeight = Number(grab.height) || session.h
}

/** manual 的节拍器：跑完这一拍再排下一拍，避免抓帧比定时器慢时堆叠。 */
async function tick() {
	if (!session.active || session.busy || session.done) return
	session.busy = true
	const started = Date.now()
	try {
		await step()
	} catch (error) {
		session.error = String(error?.message ?? error)
	} finally {
		session.busy = false
		if (session.active && !session.done) schedule(Math.max(40, POLL_MS - (Date.now() - started)))
	}
}

/**
 * 对 target 窗口发一次滚轮（R25 起先问常驻助手，拿不到才 spawn ps/wheel.ps1）。
 * ⚠️ 低完整性进程调它会被 UIPI **静默丢弃**（不报错、画面不动）—— 这也是这段逻辑
 *    必须待在宿主进程里的原因之一（DSH 工具沙箱是低完整性的）。
 *    助手对这种情况会如实回 `moved:false` **且不发滚轮**，于是上层能看出"这一拍白滚了"，
 *    而不是拿着一张没变的画面反复当成"到底了"。
 */
async function sendWheel() {
	const { cx, cy } = center()
	// 滚一屏的 80%：留 20% 重叠给 stitch.py 找偏移。全屏滚（100%）在"行高不是整除"时
	// 容易出现找不到重叠的情况。
	const stepPx = Math.max(60, Math.min(session.h - 20, Math.round(session.h * 0.8)))
	return wheelAt(cx, cy, -stepPx, 1)
}

/**
 * auto：程序自己滚。capture → commit → 发滚轮 → 等 settleMs → 再来；
 * 连续两帧指纹相同（滚不动了）或到 maxFrames 就 done。
 */
async function autoLoop() {
	if (session.looping) return
	session.looping = true
	try {
		// 顺序很关键：**先滚再抓**。
		// 上一版是"抓 → 比对 → 滚"，于是第一拍抓到的当然还是开场那一帧，
		// 指纹与 lastFp 相同 → 立刻判定"滚不动了"、done + stalled，一帧都没多。
		// 正确的因果是：发滚轮 → 等它稳定 → 抓 → 和上一帧比，相同才是真的到底了。
		while (session.active && !session.done) {
			const g = await guard()
			if (!g.ok) {
				// 区域被别的窗口盖住了：不发滚轮（会滚到别人的窗口上），等它露出来。
				session.paused = g.reason
				await sleep(Math.max(300, session.settleMs))
				continue
			}
			session.paused = ''
			/**
			 * 滚轮发不出去就**不要接着抓**：助手会回 `moved:false`（低完整性调用者被 UIPI 丢了
			 * 光标移动，或者用户正握着鼠标，它一个事件也没发）。这时画面当然没变，上一版会把
			 * "画面没变"读成"到底了"、把会话提前收掉 —— 用户看到的就是"长截图只截了一屏"。
			 *
			 * 但也不能永远等下去：连续失败 5 次就**如实放弃**（stopReason='wheel-refused'），
			 * 让界面上出现一句能读懂的话，而不是一个永远不结束的会话。
			 */
			const wheel = await sendWheel()
			if (wheel !== null && wheel !== undefined && wheel.ok !== true && wheel.moved === false) {
				session.wheelFails = (Number(session.wheelFails) || 0) + 1
				session.paused = 'wheel-refused'
				session.lastError = String(wheel.error || 'wheel refused')
				if (session.wheelFails >= 5) {
					session.stopReason = 'wheel-refused'
					session.done = true
					break
				}
				await sleep(Math.max(300, session.settleMs))
				continue
			}
			session.wheelFails = 0
			await sleep(session.settleMs)
			const grab = await grabFrame()
			if (!grab.ok) {
				session.error = String(grab.error ?? 'capture failed')
				await sleep(Math.max(300, session.settleMs))
				continue
			}
			if (grab.fp === session.lastFp) {
				// 滚了一屏之后画面还是原样 = 已经到底了（或这个窗口根本不滚）。
				drop(grab.file)
				session.stalled = 1
				session.done = true
				break
			}
			// 撞到总高上限时 commit 自己会把 done/stopReason 设好，这里跟着停。
			if (!commit(grab.file, grab.fp, grab.height)) break
			if (session.frames.length >= session.maxFrames) {
				session.done = true
				break
			}
		}
	} catch (error) {
		session.error = String(error?.message ?? error)
	} finally {
		session.looping = false
		// 循环一退出（滚到底 / 到帧数上限 / 报错）就把光标还回去 —— 不能让"自动滚动"
		// 的副作用留在用户的桌面上。还不上也**不改**会话状态：后面 end/cancel 还会再兜一次。
		await restoreCursor()
	}
}

/* ─────────────────────────── 对外 API ─────────────────────────── */

/** 状态里那一串字段（成功/失败响应都要带全，客户端读的是同一个形状）。 */
function statusFields() {
	const frame = session.frames.length === 0 ? null : session.frames[session.frames.length - 1]
	const size = frame === null ? { width: session.w, height: session.h } : pngSize(frame.file)
	return {
		active: session.active,
		mode: session.mode,
		frames: session.frames.length,
		paused: session.paused,
		stalled: session.stalled,
		done: session.done,
		elapsed: session.started === 0 ? 0 : Math.round((Date.now() - session.started) / 100) / 10,
		lastError: session.error,
		preview: session.preview,
		width: size.width,
		height: size.height,
		target: session.target,
		targetTitle: session.targetTitle,
		maxFrames: session.maxFrames,
		file: frame === null ? '' : frame.file,
		/** 已攒的帧高之和 = 成品高度的保守上界（客户端可以拿来显示"已抓 N px"）。 */
		totalHeight: session.totalHeight,
		maxTotalHeight: session.maxTotalHeight,
		/** '' 正常 / 'max-height' 撞到总高上限（客户端读到就该收官，别再让用户滚了）。 */
		stopReason: session.stopReason,
		// 光标归还状态：auto 会话里能看到 restored/failed；manual 恒为 n/a（它不碰鼠标）。
		cursor: session.cursorState === '' ? 'n/a' : session.cursorState,
		// 我们**打算**还到哪 —— 排错与自检要靠它：用户的手一直在动，光比对"前后位置相同"
		// 证明不了什么，而这一串能证明 GetPos 读到的就是它。
		cursorAt: session.savedCursor === null ? '' : `${session.savedCursor.x},${session.savedCursor.y}`,
	}
}

/**
 * 会话状态（宿主侧的唯一真相）。
 *
 * 语义提醒：
 *   - `frames` 是**已经确认稳定**的帧数；
 *   - `preview` 是最新一帧缩到 140px 宽的 jpg data URL（''' = 还没有/生成失败），
 *     给界面显示"在抓了"。生成是**后台**的，不阻塞这次调用；
 *   - `paused` 是 ''（在跑）或 'target-lost'（区域被别的窗口盖住了，此刻不 commit）；
 *   - `stalled` 是 0/1 计数：最近一次抓帧发现画面没动；
 *   - `done` 在自动模式滚到底 / 到 maxFrames 时为 true（手动模式恒 false）。
 */
export async function scrollStatus() {
	// 帧数变了就重新生成预览，但**不等它**：status 是每秒被调好几次的热路径。
	if (session.active && session.frames.length > 0 && session.previewFor !== session.frames.length && !session.previewBusy) {
		session.previewFor = session.frames.length
		session.previewBusy = true
		const src = session.frames[session.frames.length - 1].file
		thumb(src, PREVIEW_WIDTH, 70)
			.then((t) => {
				if (t.ok && t.dataUrl !== '') session.preview = t.dataUrl
			})
			.catch(() => {})
			.finally(() => {
				session.previewBusy = false
			})
	}
	return { ok: true, ...statusFields() }
}

/**
 * 开始一次长截图会话。
 *   - 立刻抓第 0 帧（它同时是 target 认领的依据）；
 *   - manual（默认）：起 ~260ms 的轮询，用户自己滚，我们负责"变了才接、稳定才收"；
 *   - auto：宿主自己发滚轮，滚到底自动 done。
 *
 * @param {string} rectText "x,y,w,h"（**屏幕物理像素**）
 * @param {{mode?: 'manual'|'auto', maxFrames?: number, settleMs?: number}} [opts]
 */
export async function scrollBegin(rectText, opts = {}) {
	// 上一轮要是有没还成的光标，先在这里补还一次（reset 会把记录清掉，之后就没机会了）。
	await restoreCursor()
	reset()
	const r = parseRect(rectText)
	if (r === null) {
		session.error = 'rect must be "x,y,w,h"'
		return { ok: false, error: session.error, ...statusFields() }
	}
	session.mode = opts.mode === 'auto' ? 'auto' : 'manual'
	const maxFrames = Number(opts.maxFrames)
	session.maxFrames = Number.isFinite(maxFrames) ? Math.max(2, Math.min(MAX_FRAMES, Math.trunc(maxFrames))) : DEFAULT_MAX_FRAMES
	const settleMs = Number(opts.settleMs)
	session.settleMs = Number.isFinite(settleMs) ? Math.max(120, Math.min(3000, Math.trunc(settleMs))) : DEFAULT_SETTLE_MS
	session.rect = `${r.x},${r.y},${r.w},${r.h}`
	session.x = r.x
	session.y = r.y
	session.w = r.w
	session.h = r.h
	session.started = Date.now()
	session.error = ''
	// 总高上限每次 begin 读一次（DSH_SHOT_MAX_TOTAL_HEIGHT 可覆盖，缺省 30000）。
	session.maxTotalHeight = maxTotalHeight()

	const sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	session.dir = path.join(CACHE_DIR, 'scroll', sid)
	try {
		fs.mkdirSync(session.dir, { recursive: true })
	} catch (error) {
		session.error = 'cannot create session dir: ' + String(error?.message ?? error)
		return { ok: false, error: session.error, ...statusFields() }
	}

	// 认领 target：这块区域中心点下面那个**顶层**窗口。之后每一拍都会用它做遮挡守卫。
	const { cx, cy } = center()
	const hit = await hitTest(cx, cy)
	if (hit.ok && hit.hwnd > 0) {
		session.target = hit.hwnd
		session.targetTitle = hit.title
	}

	// 第 0 帧：立刻抓，用户马上就能在预览里看到"在抓了"。
	const first = await grabFrame()
	if (!first.ok) {
		session.error = String(first.error ?? 'capture failed')
		reset()
		session.error = String(first.error ?? 'capture failed')
		return { ok: false, error: session.error, ...statusFields() }
	}
	session.active = true
	// 开场帧也走同一个闸门：上限比一帧还小时，它会被拒（frames=0、done=true、
	// stopReason='max-height'），这是如实的结果，不该硬塞进去。
	commit(first.file, first.fp, first.height)
	if (session.mode === 'auto') {
		// 只有 auto 会动光标，所以也只有 auto 需要记下它原来在哪。读一次就够 ——
		// 每拍再读一次既没必要，也会把用户中途自己挪鼠标的动作当成"要还的位置"。
		session.savedCursor = await getCursor()
		void autoLoop()
	} else schedule(0)
	return {
		ok: true,
		error: '',
		path: first.file,
		width: first.width,
		height: first.height,
		...statusFields(),
	}
}

/**
 * 立刻强制接一帧（用户手动按「＋」）。
 * 故意**不做稳定性确认**：用户按下按钮就是"现在这一张，收下"。
 * 但"画面和上一帧完全一样"仍然不接 —— 那拼进去就是一段重复。
 */
export async function scrollAdd() {
	if (!session.active) {
		session.error = 'no active long-capture session'
		return { ok: false, error: session.error, ...statusFields() }
	}
	if (session.frames.length >= session.maxFrames) {
		session.done = true
		session.error = `frame limit reached (${session.maxFrames})`
		return { ok: false, error: session.error, ...statusFields() }
	}
	const grab = await grabFrame()
	if (!grab.ok) {
		session.error = String(grab.error ?? 'capture failed')
		return { ok: false, error: session.error, ...statusFields() }
	}
	if (grab.fp === session.lastFp) {
		drop(grab.file)
		session.stalled = 1
		return { ok: true, error: '', path: '', stalled: 1, ...statusFields() }
	}
	// 用户按「＋」也要过总高闸门：过不去就如实说，别悄悄丢掉这一帧。
	if (!commit(grab.file, grab.fp, grab.height)) {
		return { ok: false, error: 'max-height reached', path: '', stalled: 0, ...statusFields() }
	}
	return { ok: true, error: '', path: grab.file, stalled: 0, ...statusFields() }
}

/**
 * 收官：把所有帧交给既有的 stitch.py 拼接（**沿用 shot.mjs#scrollCapture 那条路**，
 * 不自己重写对齐算法），落成一张正式截图（在 SHOTS_DIR，id 能被 _fileOf 解析）。
 *
 * 帧数 < 2 时如实返回 not enough frames（一张图本来就不需要拼）。
 */
export async function scrollEnd() {
	// 收官前先把"为什么停"记下来：下面 reset() 会把它清掉（和 cursor 同一个道理）。
	const stopReason = session.stopReason
	const totalHeight = session.totalHeight
	if (!session.active) {
		session.error = 'no active long-capture session'
		const cursor = await restoreCursor()
		return { ok: false, error: session.error, frames: 0, id: '', path: '', width: 0, height: 0, cursor, stopReason, totalHeight }
	}
	clearTimer()
	// 收官前再兜一次光标（auto 循环正常退出时已经还过了，这里覆盖"循环被打断"的情况）。
	const cursor = await restoreCursor()
	const files = session.frames.map((f) => f.file)
	if (files.length < 2) {
		session.error = 'not enough frames'
		return { ok: false, error: session.error, frames: files.length, id: '', path: '', width: session.w, height: session.h, cursor, stopReason, totalHeight }
	}
	const out = shotPath().replace(/\.png$/, '.long.png')
	const res = await run(
		findPython(),
		[path.join(PY_DIR, 'stitch.py'), '--out', out, '--overlap-min', '40', ...files],
		{ timeoutMs: 180_000 }
	)
	let info = null
	const lines = String(res.stdout).split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
	if (lines.length > 0) {
		try {
			info = JSON.parse(lines[lines.length - 1])
		} catch {
			info = null
		}
	}
	if (res.code !== 0 || info === null || !fs.existsSync(out)) {
		// 拼接失败**保留会话**：用户可以再按一次「完成」，不用从头滚一遍。
		session.error = (res.stderr || '').trim() || `stitch exit ${res.code}`
		return { ok: false, error: session.error, frames: files.length, id: '', path: '', width: session.w, height: session.h, cursor, stopReason, totalHeight }
	}
	const result = {
		ok: true,
		error: '',
		id: path.basename(out, '.png'),
		path: out,
		frames: files.length,
		width: Number(info.width) || session.w,
		height: Number(info.height) || 0,
		offsets: Array.isArray(info.offsets) ? info.offsets : [],
		cursor,
		// 收官结果里也要带"为什么停"：客户端拿到 done=true 就收官，不必再回读 status。
		stopReason,
		totalHeight,
	}
	// 成功才清会话（工作目录连同中间帧一起删掉；最终长图在 SHOTS_DIR，不受影响）。
	reset()
	return result
}

/**
 * 取消：停掉轮询/自动循环，还光标，删掉所有中间文件。
 * 之所以是 async：还光标要真的等一次 pwsh。**失败不影响返回值本身**。
 */
export async function scrollCancel() {
	const n = session.frames.length
	const cursor = await restoreCursor()
	reset()
	return { ok: true, frames: n, error: '', cursor }
}

/** 有没有会话在跑（热键/工具用来判断"要不要先取消"）。 */
export function isScrollActive() {
	return session.active
}
