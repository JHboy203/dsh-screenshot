/**
 * lib/overlay.mjs — 常驻「原生覆盖层」助手的 Node 半边（M1）。
 *
 * 为什么要一个独立进程：DSH 渲染进程只能在自己窗口里画（DOM 平面），
 * 而截图的第一步必须**盖住真实桌面上的别的应用**。能盖住桌面的只有真正拥有 HWND 的窗口。
 * 走的是 ps/pickwindow.ps1 早已开出的那条路（那边用于选窗口），本模块把它用于**框选截图**。
 *
 * 为什么要常驻：本机冷启一个 powershell.exe 实测 ~4.2s。每次截图起一个新进程，
 * 会比它替代的 DOM 覆盖层还慢。所以插件 init 时起一个，Add-Type + DPI 只需做一次。
 *
 * 协议（全走文件 —— 这个沙箱禁 CreatePipe，管道一律 EPERM）：
 *   node 写  <DIR>/ovlreq-<callTag>.json   { tag, timeoutSec, dim, png }
 *   助手读走即删 → 出覆盖层 → 用户拖框 → 写
 *            <DIR>/ovlres-<callTag>.json   { ok, cancelled, x, y, w, h, clip, png, ms, ... }
 *   ready 握手：<DIR>/ready-<Tag>.json      （Add-Type + DPI 做完才写）
 *   关停：      <DIR>/stop-<Tag>.flag
 *
 * ⚠️ 一切失败都只降级、不上抛：助手不在 / 半路死了 / 超时，overlayPick 返回 ok:false，
 *    客户端据此**回落到原来的 DOM 覆盖层**（这就是"保留回退开关"的实现方式）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { CACHE_DIR, PS_DIR } from './shot.mjs'

/**
 * ⚠️ DSH_OVERLAY_DIR 只服务于测试：低完整性的 shell 里，子进程写 `.cache/` 会被沙箱拒绝，
 *    而插件宿主自己 spawn 的进程不受此限。生产路径永远走 CACHE_DIR/overlay。
 */
export const OVERLAY_DIR = process.env.DSH_OVERLAY_DIR || path.join(CACHE_DIR, 'overlay')
export const OVERLAY_SCRIPT = path.join(PS_DIR, 'overlay_host.ps1')

/** WinForms 窗体 + Clipboard::SetImage 都要求 STA，缺了会抛 ThreadStateException。 */
const STA = '-STA'

const state = {
	child: null,
	tag: '',
	spawnAt: 0,
	readyAt: 0,
	readySeen: false,
	error: '',
	stopping: false,
	/** 第几代。每一代的 exit 处理只许动自己那一代的账（照抄 shooter.mjs 的教训）。 */
	generation: 0,
	/** 串行化：助手一次只能跑一个覆盖层，并发调用排队。 */
	chain: Promise.resolve(),
	lastSpawnTry: 0,
	calls: 0,
	lastResult: null,
}

function filesOf(tag) {
	return {
		req: (callTag) => path.join(OVERLAY_DIR, `ovlreq-${callTag}.json`),
		res: (callTag) => path.join(OVERLAY_DIR, `ovlres-${callTag}.json`),
		ready: path.join(OVERLAY_DIR, `ready-${tag}.json`),
		stop: path.join(OVERLAY_DIR, `stop-${tag}.flag`),
		stderr: path.join(OVERLAY_DIR, `stderr-${tag}.log`),
	}
}

function ready() {
	if (state.readySeen) return true
	if (state.tag === '') return false
	try {
		if (fs.existsSync(filesOf(state.tag).ready)) {
			state.readySeen = true
			state.readyAt = Date.now()
			return true
		}
	} catch {}
	return false
}

function alive() {
	return state.child !== null && state.child.exitCode === null && state.child.signalCode === null
}

/** 清掉上一轮崩溃留下的请求/响应文件（只碰 ovlreq-/ovlres-，绝不动 ready/stop）。 */
function sweep() {
	let names = []
	try {
		names = fs.readdirSync(OVERLAY_DIR)
	} catch {
		return 0
	}
	let removed = 0
	for (const name of names) {
		if (!/^(ovlreq|ovlres)-/.test(name) && !name.endsWith('.tmp')) continue
		try {
			fs.unlinkSync(path.join(OVERLAY_DIR, name))
			removed += 1
		} catch {}
	}
	return removed
}

/**
 * 起助手。幂等：已经在跑就直接返回。任何异常都收敛成 {ok:false}，绝不上抛。
 * @returns {{ok: boolean, already: boolean, pid: number, tag: string, ready: boolean, dir: string, error?: string}}
 */
export function startOverlayHost() {
	if (process.env.DSH_SHOT_OVERLAY === '0') {
		return { ok: false, already: false, pid: 0, tag: '', ready: false, dir: OVERLAY_DIR, error: 'disabled by DSH_SHOT_OVERLAY=0' }
	}
	if (alive()) {
		return { ok: true, already: true, pid: state.child.pid, tag: state.tag, ready: ready(), dir: OVERLAY_DIR }
	}
	if (Date.now() - state.lastSpawnTry < 5000) {
		return { ok: false, already: false, pid: 0, tag: '', ready: false, dir: OVERLAY_DIR, error: state.error || 'cooldown' }
	}
	state.lastSpawnTry = Date.now()
	if (!fs.existsSync(OVERLAY_SCRIPT)) {
		state.error = 'overlay_host.ps1 not found'
		return { ok: false, already: false, pid: 0, tag: '', ready: false, dir: OVERLAY_DIR, error: state.error }
	}
	try {
		fs.mkdirSync(OVERLAY_DIR, { recursive: true })
	} catch {}
	sweep()

	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	state.tag = tag
	state.readySeen = false
	state.readyAt = 0
	state.error = ''
	state.stopping = false
	state.generation += 1
	const myGeneration = state.generation

	const files = filesOf(tag)
	let errFd = 'ignore'
	try {
		errFd = fs.openSync(files.stderr, 'a')
	} catch {}

	const args = ['-NoProfile', STA, '-ExecutionPolicy', 'Bypass', '-File', OVERLAY_SCRIPT, '-Dir', OVERLAY_DIR, '-Tag', tag]

	let child = null
	try {
		child = spawn('powershell.exe', args, { cwd: path.dirname(PS_DIR), windowsHide: true, stdio: ['ignore', 'ignore', errFd] })
	} catch (error) {
		state.error = `spawn failed: ${error?.message ?? error}`
		try {
			if (typeof errFd === 'number') fs.closeSync(errFd)
		} catch {}
		return { ok: false, already: false, pid: 0, tag, ready: false, dir: OVERLAY_DIR, error: state.error }
	}
	state.child = child
	state.spawnAt = Date.now()

	child.on('error', (error) => {
		if (state.generation !== myGeneration) return
		state.readySeen = false
		state.error = `child error: ${error?.message ?? error}`
	})
	child.on('exit', (code, signal) => {
		if (state.generation !== myGeneration) return
		state.readySeen = false
		if (state.stopping) {
			state.stopping = false
			state.child = null
			return
		}
		state.error = `helper exited code=${code} signal=${signal}`
		state.child = null
	})

	return { ok: true, already: false, pid: child.pid, tag, ready: false, dir: OVERLAY_DIR }
}

/** 等 ready 握手；ready() 是带缓存的，这里只是给一个上限。 */
async function waitReady(ms = 6000) {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (ready()) return true
		if (!alive() && state.readySeen === false) {
			// 进程已经没了，再等也没用
			return false
		}
		await new Promise((r) => setTimeout(r, 60))
	}
	return ready()
}

/** 一个请求：写 req → 轮询 res → 读回。超时/进程死都返回 ok:false。 */
async function requestOnce(payload) {
	const callTag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	const files = filesOf(state.tag)
	const reqFile = files.req(callTag)
	const resFile = files.res(callTag)
	const deadline = Date.now() + (Number(payload.timeoutSec) || 120) * 1000 + 10_000

	try {
		const tmp = reqFile + '.tmp'
		fs.writeFileSync(tmp, JSON.stringify({ ...payload, tag: callTag }), 'utf8')
		fs.renameSync(tmp, reqFile)
	} catch (error) {
		return { ok: false, cancelled: false, error: `write request failed: ${error?.message ?? error}` }
	}

	while (Date.now() < deadline) {
		try {
			if (fs.existsSync(resFile)) {
				const raw = fs.readFileSync(resFile, 'utf8')
				try {
					fs.unlinkSync(resFile)
				} catch {}
				const parsed = JSON.parse(raw)
				return typeof parsed === 'object' && parsed !== null ? parsed : { ok: false, error: 'bad result json' }
			}
		} catch (error) {
			return { ok: false, cancelled: false, error: `read result failed: ${error?.message ?? error}` }
		}
		if (!alive()) {
			// 助手在自己处理这一次的途中死了 —— 别再等了
			return { ok: false, cancelled: false, error: 'helper died during request' }
		}
		await new Promise((r) => setTimeout(r, 25))
	}
	try {
		fs.unlinkSync(reqFile)
	} catch {}
	return { ok: false, cancelled: false, error: 'timed out waiting for overlay' }
}

/**
 * 每次框选都默认落一张盘 —— 只进剪贴板的话，用户根本找不到自己的图。
 * 目录口径与 shot.mjs 的 save() 一致：先 `~/Pictures/DSH截图`（用户找得到），
 * 建不出来就退到 CACHE_DIR（保证可写，具体由助手脚本自己兜）。
 */
function shotStamp() {
	const d = new Date()
	const p = (n) => String(n).padStart(2, '0')
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 首选落盘位置：和 shot.mjs 的 save() 同一处，用户找得到。 */
function defaultPngPath(stamp) {
	return path.join(os.homedir(), 'Pictures', 'DSH截图', `shot-${stamp}.png`)
}

/**
 * 让用户**在真实桌面上框一块**（阻塞调用，和 pickwin 同一形态）。
 * @param {{timeoutSec?: number, dim?: number, png?: string, labels?: string[],
 *   regionOnly?: boolean, selfTest?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, cancelled: boolean, x: number, y: number, w: number, h: number,
 *   clip: boolean, png: string, ms: number, reason: string, regionOnly?: boolean, error?: string}>}
 */
export async function overlayPick(opts = {}) {
	const timeoutSec = Math.min(600, Math.max(3, Number(opts.timeoutSec) || 120))
	/**
	 * regionOnly = 只要矩形，不要图。
	 * 长截图 / 提取文字 / 屏幕翻译的第一步都是「框一块屏幕区域」，框完自己会去抓那块区域，
	 * 所以这里**不该**写剪贴板、**也不该**落盘 —— 落一张用户没要的 PNG 既白花时间，
	 * 又可能盖掉他剪贴板里原本复制着的东西。
	 */
	const regionOnly = opts.regionOnly === true
	let png = typeof opts.png === 'string' ? opts.png : ''
	let pngFallback = typeof opts.pngFallback === 'string' ? opts.pngFallback : ''
	if (png.length === 0 && opts.keepFile !== false && regionOnly !== true) {
		// 首选 ~/Pictures/DSH截图；写不进去（受限令牌 / sandbox）时退到插件自己的缓存目录。
		// 兜底是必须的：只进剪贴板用户根本找不到图，而硬失败会让整次框选白做。
		const stamp = shotStamp()
		png = defaultPngPath(stamp)
		if (pngFallback.length === 0) pngFallback = path.join(CACHE_DIR, 'shots', `shot-${stamp}.png`)
	}
	const payload = { timeoutSec, dim: opts.dim === undefined ? 55 : Number(opts.dim), png, pngFallback }
	// 仅测试用：让助手程序化地画几个标注再确认（没有人能从这个 sandbox 里移动鼠标）。
	if (opts.selfTest === true) payload.selfTest = true
	// 仅测试用：自检时走"贴图"分支而不是"复制"，并让助手稍后自己把贴图窗关掉。
	if (opts.pinTest === true) payload.pinTest = true
	// 仅测试用：把整个覆盖层（放大镜 / 工具条）渲染成 PNG，供人肉眼复核。
	if (typeof opts.formShot === 'string' && opts.formShot.length > 0) payload.formShot = opts.formShot
	// 只取矩形（长截图 / OCR / 翻译）。助手收到它就直接跳过标注阶段。
	if (regionOnly) payload.regionOnly = true
	// 工具条文案由客户端带过来：overlay_host.ps1 必须零非 ASCII 字节，
	// 所以中文字面量不能写在那份脚本里。
	if (Array.isArray(opts.labels) === true) payload.labels = opts.labels
	// 工具条下方那行快捷键提示，同样只能由客户端带进来。
	if (typeof opts.hint === 'string' && opts.hint.length > 0) payload.hint = opts.hint
	state.calls += 1

	const run = state.chain.then(async () => {
		if (!alive()) {
			const started = startOverlayHost()
			if (started.ok !== true) return { ok: false, cancelled: false, x: 0, y: 0, w: 0, h: 0, clip: false, png: '', ms: 0, reason: 'no-helper', error: started.error ?? 'helper unavailable' }
			const ok = await waitReady(8000)
			if (!ok) return { ok: false, cancelled: false, x: 0, y: 0, w: 0, h: 0, clip: false, png: '', ms: 0, reason: 'not-ready', error: state.error || 'helper not ready' }
		}
		const res = await requestOnce(payload)
		state.lastResult = res
		return res
	})
	// 链不断：一次失败不许把后续调用一起带死。
	state.chain = run.catch(() => null).then(() => null)
	return run
}

/** 收掉助手：落 stop 标志 → 等它自己走 → 800ms 没走就 kill。 */
export function stopOverlayHost() {
	const tag = state.tag
	if (tag === '') return { ok: true, stopped: false }
	const files = filesOf(tag)
	state.readySeen = false
	try {
		fs.writeFileSync(files.stop, 'q', 'utf8')
	} catch {}
	state.stopping = true
	const child = state.child
	if (child === null) return { ok: true, stopped: false }
	const pid = child.pid
	setTimeout(() => {
		try {
			if (alive()) child.kill()
		} catch {}
		for (const file of [files.ready, files.stop]) {
			try {
				fs.unlinkSync(file)
			} catch {}
		}
	}, 800)
	try {
		process.kill(pid, 0)
	} catch {}
	return { ok: true, stopped: true, pid }
}

export function overlayStatus() {
	return {
		enabled: process.env.DSH_SHOT_OVERLAY !== '0',
		alive: alive(),
		ready: ready(),
		pid: state.child === null ? 0 : state.child.pid,
		tag: state.tag,
		dir: OVERLAY_DIR,
		script: OVERLAY_SCRIPT,
		spawnMs: state.spawnAt === 0 ? 0 : Date.now() - state.spawnAt,
		readyMs: state.readyAt === 0 || state.spawnAt === 0 ? 0 : state.readyAt - state.spawnAt,
		calls: state.calls,
		lastResult: state.lastResult,
		error: state.error,
	}
}
