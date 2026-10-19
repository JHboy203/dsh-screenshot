/**
 * lib/shot.mjs — dsh-screenshot 宿主引擎：所有真正碰系统的活都在这里。
 *
 * 为什么抓屏在宿主而不是浏览器：官方主会话**没有** setDisplayMediaRequestHandler，
 * 权限处理器只放行麦克风（见交接文件 R14 的 asar 取证），渲染进程的 getDisplayMedia
 * 拿不到任何源。于是屏幕这头只能用 PowerShell/.NET：
 *   System.Drawing.Graphics.CopyFromScreen  → 整屏
 *   PrintWindow(PW_RENDERFULLCONTENT)       → 单窗口（被别的窗口挡住也能拍到）
 *
 * 三个必须记住的坑（都踩过）：
 *   ① **DPI**：不先 SetProcessDPIAware，进程拿到的是虚拟化坐标 —— 同一窗口会是
 *      1295x823 而不是 1619x1029（本机 125% 缩放），截图会糊。
 *   ② **隐蔽失败**：从**低完整性**进程（DSH 工具沙箱就是）调 ShowWindow /
 *      SetForegroundWindow 会被 UIPI **静默拒绝**（不报错、窗口纹丝不动）。
 *      所以「截图时隐藏窗口」只有在宿主进程里起的 pwsh 才有效 —— 这是本插件
 *      必须走宿主半边的原因之一。
 *   ③ **PATH 上的 ffmpeg 可能是假的**：Cherry Studio 的 mise shim 会 exit 127。
 *      这里显式排除 Toolchain\mise\shims。
 *
 * cwd 提醒：宿主进程的 cwd 是 profile 目录，不是工作区（R13.4 的坑），
 * 所以所有路径都从 import.meta.url 推。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_DATAURL_BYTES, MAX_KEEP_SHOTS, MAX_STRIP_BYTES } from './wire.mjs'

export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const PS_DIR = path.join(PLUGIN_ROOT, 'ps')
export const PY_DIR = path.join(PLUGIN_ROOT, 'py')
/**
 * 插件自己的缓存目录（截图、事件文件、boot-report.json）。
 * `DSH_SHOT_CACHE` 可以整体改道 —— 和 SHOTS_DIR 同一个理由：DSH 的文件沙箱**禁止
 * 子进程写插件目录**（node 覆写 = EPERM），所以"在沙箱里把宿主半边真跑一遍"只能靠它。
 * 它也是热键守护进程的事件文件与 stderr 的落点，没有这个开关那两条链路根本没法测。
 */
export const CACHE_DIR = process.env.DSH_SHOT_CACHE
	? path.resolve(process.env.DSH_SHOT_CACHE)
	: path.join(PLUGIN_ROOT, '.cache')
/**
 * 截图落盘目录。默认在插件自己的 .cache 下；`DSH_SHOT_DIR` 可以覆盖 ——
 * 这条不只是灵活性：DSH 的文件沙箱**禁止子进程写插件目录**（node 覆写 = EPERM），
 * 所以「用沙箱里的 node 把宿主引擎整条链路真跑一遍」只能靠它指到别处。
 */
export const SHOTS_DIR = process.env.DSH_SHOT_DIR
	? path.resolve(process.env.DSH_SHOT_DIR)
	: path.join(CACHE_DIR, 'shots')
/**
 * 录屏的落地目录 —— **临时**，不是最终归宿。
 *
 * 为什么录屏不能再直接写 图片\DSH截图：录完之后用户往往只是"看一眼、抽一帧、发出去"，
 * 而一段 1080p 的录屏是几十上百 MB，随手录几次就能把用户的图片目录塞满。所以停录先落到
 * 缓存里，由用户显式选 keep（rec.ps1 负责搬进 图片\DSH截图）或 discard（删掉）。
 * 送进剪贴板的那个 CF_HDROP 也必须是**磁盘上真实存在**的文件，缓存路径同样满足。
 */
export const REC_DIR = path.join(CACHE_DIR, 'rec')
export const REPORT_PATH = path.join(CACHE_DIR, 'boot-report.json')

/** 最近一次失败（给 status() 用：宿主里没有 stdout 可看，只能落盘 + 报给界面）。 */
const last = { error: '', at: '' }
function note(where, error) {
	last.error = `${where}: ${String(error?.message ?? error)}`
	last.at = new Date().toISOString()
	return last.error
}

/* ─────────────────────────── 进程 ─────────────────────────── */

/**
 * 跑一个子进程并收全 stdout/stderr（不抛，失败也返回结果）。
 *
 * ⚠️ stdout / stderr 走**临时文件**，不走管道。这条是实测逼出来的，不是洁癖：
 *      pipe         -> node spawn 直接 EPERM（沙箱禁 CreatePipe）
 *      'ignore'     -> powershell.exe 以 0xC0000142 (STATUS_DLL_INIT_FAILED) 退出
 *      真实文件句柄 -> 正常，退出码与输出都对
 *    换句话说，**只给 stderr 一个真文件句柄**是这个环境里唯一能起 PowerShell 的方式。
 *    落文件的额外好处：`--live` 自检不再被"沙箱禁管道"挡住，宿主半边整条链路
 *    可以在沙箱里真跑一遍；而运行在 DSH 宿主进程里时它同样正常（那里管道本来是通的）。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number, input?: string, cwd?: string, maxBytes?: number}} [opts]
 */
export function run(bin, args, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 20_000
	const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
	return new Promise((resolve) => {
		// 临时文件放在**插件自己的缓存目录**，不放 os.tmpdir()：DSH 的文件沙箱会拒掉
		// %TEMP% 下的写入（实测 UnauthorizedAccessException），而 CACHE_DIR 可以用
		// DSH_SHOT_CACHE 整体改道，正好也是自检需要的。
		try {
			fs.mkdirSync(CACHE_DIR, { recursive: true })
		} catch {}
		const base = path.join(CACHE_DIR, 'run-' + process.pid + '-' + Math.random().toString(36).slice(2, 10))
		const outFile = base + '.out'
		const errFile = base + '.err'
		const inFile = opts.input === undefined ? '' : base + '.in'
		let outFd
		let errFd
		let inFd
		const cleanup = () => {
			for (const f of [outFile, errFile, inFile]) {
				if (f === '') continue
				try {
					fs.rmSync(f, { force: true })
				} catch {}
			}
		}
		let child
		try {
			if (opts.input !== undefined) {
				fs.writeFileSync(inFile, opts.input)
				inFd = fs.openSync(inFile, 'r')
			}
			outFd = fs.openSync(outFile, 'w')
			errFd = fs.openSync(errFile, 'w')
			child = spawn(bin, args, {
				cwd: opts.cwd ?? PLUGIN_ROOT,
				windowsHide: true,
				stdio: [inFd === undefined ? 'ignore' : inFd, outFd, errFd],
			})
		} catch (error) {
			for (const fd of [outFd, errFd, inFd]) {
				try {
					if (fd !== undefined) fs.closeSync(fd)
				} catch {}
			}
			cleanup()
			resolve({ code: -1, stdout: '', stderr: note('spawn ' + bin, error), killed: false })
			return
		}
		// 子进程拿到的是句柄副本；父进程这一份必须马上关，否则文件一直被占着读不到。
		for (const fd of [outFd, errFd, inFd]) {
			try {
				if (fd !== undefined) fs.closeSync(fd)
			} catch {}
		}

		let killed = false
		let settled = false
		const finish = (code, extraError) => {
			if (settled) return
			settled = true
			let out = ''
			let err = ''
			try {
				out = fs.readFileSync(outFile, 'utf8').slice(0, maxBytes)
			} catch {}
			try {
				err = fs.readFileSync(errFile, 'utf8').slice(0, 64 * 1024)
			} catch {}
			cleanup()
			if (extraError) err = note('run ' + bin, extraError)
			resolve({ code, stdout: out, stderr: err, killed })
		}
		const timer = setTimeout(() => {
			killed = true
			try {
				child.kill()
			} catch {}
		}, timeoutMs)
		child.on('error', (error) => {
			clearTimeout(timer)
			finish(-1, error)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			finish(code ?? -1)
		})
	})
}

/** 找一个能用的 Windows PowerShell 5.1（OCR 的 WinRT 互操作在 pwsh 7 里不完整）。 */
export function findPowershell() {
	const candidates = [
		path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		'powershell.exe',
	]
	for (const c of candidates) {
		if (c === 'powershell.exe' || existsSync(c)) return c
	}
	return 'powershell.exe'
}

/** 找一个能用的 pwsh（抓屏用它更快，且不依赖 5.1）。找不到就回落 powershell.exe。 */
export function findPwsh() {
	const candidates = [
		path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
		path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
		'pwsh.exe',
	]
	for (const c of candidates) {
		if (c === 'pwsh.exe' || existsSync(c)) return c
	}
	return findPowershell()
}

/**
 * 找一个**真的能用**的 ffmpeg（排除 mise shim：那个 shim 的 installs 是空的，
 * 一跑就 `error while loading shared libraries` exit 127）。
 */
export function findFfmpeg() {
	const roots = [
		path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
		path.join(process.env.ProgramFiles ?? '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
	]
	for (const c of roots) {
		if (c && existsSync(c) && !/mise/i.test(c)) return c
	}
	return 'ffmpeg.exe'
}

/** 找 python（长截图的拼接用，PIL 在系统 python 里可用）。 */
export function findPython() {
	const roots = [
		path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python38-32', 'python.exe'),
		path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python311', 'python.exe'),
		'C:\\Python38\\python.exe',
	]
	for (const c of roots) {
		if (existsSync(c)) return c
	}
	return 'python.exe'
}

/* ─────────────────────────── 抓屏 ─────────────────────────── */

async function ensureDirs() {
	await mkdir(SHOTS_DIR, { recursive: true })
}

/** 时间戳（到秒）+ 4 位随机：同毫秒内连续几次调用也不会撞名。 */
function stampName() {
	const d = new Date()
	const p = (n, w = 2) => String(n).padStart(w, '0')
	const s = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	return `${s}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 新的截图文件名（`SHOTS_DIR/shot-<时间戳>-<随机>.png`）。
 * 导出是给"录屏抽帧"用的：抽出来的一帧要**当成一张正式截图**落地（同一命名约定），
 * 这样客户端的 id 解析（service.mjs#_fileOf）、OCR、保存对它全都成立。
 */
export function shotPath() {
	return path.join(SHOTS_DIR, `shot-${stampName()}.png`)
}

/** 只留最近 N 张，其余删掉（.cache 不该无限长）。 */
async function pruneShots() {
	try {
		const names = (await readdir(SHOTS_DIR)).filter((n) => n.endsWith('.png') || n.endsWith('.jpg'))
		if (names.length <= MAX_KEEP_SHOTS) return
		const withTime = []
		for (const n of names) {
			const s = await stat(path.join(SHOTS_DIR, n))
			withTime.push([path.join(SHOTS_DIR, n), s.mtimeMs])
		}
		withTime.sort((a, b) => a[1] - b[1])
		for (const [p] of withTime.slice(0, withTime.length - MAX_KEEP_SHOTS)) await rm(p, { force: true })
	} catch {}
}

/**
 * 最近抓过的图（只有元信息；客户端用它做「重新框选 / 贴一张旧的」）。
 * @param {number} [limit]
 */
export async function listShots(limit = 8) {
	await ensureDirs()
	let names = []
	try {
		names = (await readdir(SHOTS_DIR)).filter((n) => n.endsWith('.png') || n.endsWith('.jpg'))
	} catch {
		return []
	}
	const rows = []
	for (const n of names) {
		try {
			const s = await stat(path.join(SHOTS_DIR, n))
			rows.push({ id: n.replace(/\.(png|jpg)$/i, ''), name: n, bytes: s.size, at: new Date(s.mtimeMs).toISOString() })
		} catch {}
	}
	rows.sort((a, b) => (a.at < b.at ? 1 : -1))
	return rows.slice(0, Math.max(1, Math.min(40, limit)))
}

/** 从 PowerShell 的 stdout 里挑出最后一个 JSON 行。 */
/** 取最后一行以 { 开头的 JSON（脚本都会把结果打在末行）。 */
export function lastJsonLine(text) {
	const lines = String(text).split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
	if (lines.length === 0) return null
	try {
		return JSON.parse(lines[lines.length - 1])
	} catch {
		return null
	}
}

/**
 * 惰性拿 shooter 模块。
 * ⚠️ 不能写成顶层 `import`：shooter.mjs 要从本模块拿 CACHE_DIR / PS_DIR / findPwsh，
 *    静态互相 import 会绕成循环依赖。动态 import 只在第一次抓屏时付一次代价。
 */
let shooterModulePromise = null
function shooterModule() {
	if (shooterModulePromise === null) {
		shooterModulePromise = import('./shooter.mjs').catch((error) => {
			shooterModulePromise = null
			throw error
		})
	}
	return shooterModulePromise
}

/**
 * 试着用常驻助手抓一张屏。
 *
 * @returns {Promise<object|null>} null = 这次用不上助手（没起 / 没热 / 超时 / 抓失败），
 *   调用方去走老路径；否则就是 capture() 该返回的那个结果对象（结构与老路径逐字一致）。
 */
async function captureViaHelper(opts, mode, started) {
	if (process.env.DSH_SHOT_HELPER === '0') return null
	let shooter = null
	try {
		shooter = await shooterModule()
	} catch (error) {
		note('shooter', `helper unavailable: ${error?.message ?? error}`)
		return null
	}

	const out = shotPath()
	let answer = null
	try {
		answer = await shooter.shootViaHelper({
			mode,
			out,
			hideSelf: opts.hideSelf === true,
			method: opts.method === 'print' ? 'print' : 'screen',
			hwnd: Number.isFinite(opts.hwnd) && opts.hwnd > 0 ? Math.trunc(opts.hwnd) : 0,
			rect: typeof opts.rect === 'string' ? opts.rect : '',
			noRestore: opts.noRestore === true,
			target: typeof opts.target === 'string' ? opts.target : '',
		})
	} catch (error) {
		note('shooter', `helper request failed: ${error?.message ?? error}`)
		return null
	}
	if (answer === null) return null

	const info = answer.info ?? {}
	// 助手答了但说"没抓到"（窗口不在 / 矩形非法 / …）：**照样回落走老路径**。
	// 理由：老路径是一次全新的进程，助手要是因为长时间存活而状态反常（GDI 句柄失效之类），
	// 回落是唯一能自愈的路；代价只是这一次慢 1.9 秒。真错了的话老路径会给出**同一条**错误消息。
	if (answer.ok !== true) {
		note('shooter', `helper said: ${info.error ?? `exit ${info.exitCode}`}`)
		return null
	}
	if (!existsSync(out)) {
		note('shooter', 'helper reported ok but the png is missing')
		return null
	}
	void pruneShots()
	return {
		ok: true,
		path: out,
		id: path.basename(out, '.png'),
		width: info.width,
		height: info.height,
		left: info.left,
		top: info.top,
		hidden: info.hidden === true,
		method: info.method ?? '',
		hwnd: Number(info.hwnd) || 0,
		mode,
		ms: Date.now() - started,
	}
}

/**
 * 抓一张屏，落盘成 PNG。
 * @param {{mode?: 'desktop'|'window', hideSelf?: boolean, method?: 'screen'|'print',
 *   hwnd?: number, rect?: string, noRestore?: boolean, target?: string, timeoutMs?: number}} opts
 *
 * 两条路，优先走快的：
 *   ① 常驻助手（lib/shooter.mjs：一个长期活着的 pwsh，请求/响应走文件）—— ~200-300ms；
 *   ② 老路径（每次新起一个 pwsh 跑 capture.ps1）—— ~1.9s，但**永远可用**。
 * 助手没就绪 / 超时 / 中途死了 / 抓失败 ⇒ 一律静默落到 ②，返回结构完全一样。
 */
export async function capture(opts = {}) {
	await ensureDirs()
	const mode = opts.mode === 'window' ? 'window' : 'desktop'
	const started = Date.now()

	const fast = await captureViaHelper(opts, mode, started)
	if (fast !== null) return fast

	const out = shotPath()
	const args = [
		'-NoProfile',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		path.join(PS_DIR, 'capture.ps1'),
		'-Mode',
		mode,
		'-Out',
		out,
		'-Json',
	]
	if (opts.hideSelf) args.push('-HideSelf')
	if (opts.method === 'print') args.push('-Method', 'print')
	// 明确的窗口句柄：选择器选中的那个窗口（比按标题猜准得多）
	if (Number.isFinite(opts.hwnd) && opts.hwnd > 0) args.push('-Hwnd', String(Math.trunc(opts.hwnd)))
	// 明确的屏幕矩形（物理像素 x,y,w,h）：覆盖层自己知道用户框的是哪块；
	// AI 无感抓取也走这条 —— 不需要任何前台窗口。
	if (typeof opts.rect === 'string' && opts.rect.length > 0) args.push('-Rect', opts.rect)
	// AI 调用时**永不**还原用户的窗口（那就是"影响我做别的事情"）
	if (opts.noRestore) args.push('-NoRestore')

	const res = await run(findPwsh(), args, { timeoutMs: opts.timeoutMs ?? 25_000 })
	const info = lastJsonLine(res.stdout)
	if (res.code !== 0 || info === null || !existsSync(out)) {
		const error = note('capture', res.stderr.trim() || `exit ${res.code}${res.killed ? ' (timeout)' : ''}`)
		return { ok: false, error, stderr: res.stderr.slice(0, 800), code: res.code }
	}
	void pruneShots()
	return {
		ok: true,
		path: out,
		id: path.basename(out, '.png'),
		width: info.width,
		height: info.height,
		left: info.left,
		top: info.top,
		hidden: info.hidden === true,
		method: info.method ?? '',
		hwnd: Number(info.hwnd) || 0,
		mode,
		ms: Date.now() - started,
	}
}

/**
 * 枚举可截的窗口（选择器的数据源）。
 * @param {{exclude?: string, limit?: number, minWidth?: number, minHeight?: number}} [opts]
 */
export async function listWindows(opts = {}) {
	const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'windows.ps1'), '-Json']
	// exclude === '' 的语义是"连 DSH 自己一起列"。**不能**翻译成 `-ExcludeTitle ''`：
	// 实测 powershell.exe -File 会因为去引号而报 "Missing an argument for parameter"。
	// 走 -KeepSelf 开关，这条路是验过的。
	if (typeof opts.exclude === 'string' && opts.exclude.length === 0) args.push('-KeepSelf')
	else if (typeof opts.exclude === 'string') args.push('-ExcludeTitle', opts.exclude)
	if (Number.isFinite(opts.limit)) args.push('-Limit', String(Math.trunc(opts.limit)))
	if (Number.isFinite(opts.minWidth)) args.push('-MinWidth', String(Math.trunc(opts.minWidth)))
	if (Number.isFinite(opts.minHeight)) args.push('-MinHeight', String(Math.trunc(opts.minHeight)))
	const res = await run(findPwsh(), args, { timeoutMs: 20_000 })
	const info = lastJsonLine(res.stdout)
	if (info === null) {
		return { ok: false, windows: [], error: note('windows', res.stderr.trim() || `exit ${res.code}`) }
	}
	const list = Array.isArray(info.windows) ? info.windows : []
	// 契约：每个字段都显式给值。选择器少一个 key 就是一行空白。
	return {
		ok: info.ok !== false,
		windows: list.map((w) => ({
			hwnd: Number(w.hwnd) || 0,
			title: String(w.title ?? ''),
			class: String(w.class ?? ''),
			pid: Number(w.pid) || 0,
			x: Number(w.x) || 0,
			y: Number(w.y) || 0,
			w: Number(w.w) || 0,
			h: Number(w.h) || 0,
			min: w.min === true,
			z: Number(w.z) || 0,
		})),
		error: '',
	}
}

/* ─────────────────── 命中测试（点下面是谁） ─────────────────── */

/**
 * 屏幕物理坐标 (x,y) 下面那个**顶层窗口**是谁（ps/hitwin.ps1）。
 *
 * 长截图会话靠它守两件事：
 *   ① 开始时认领 target —— 这块区域归哪个窗口所有；
 *   ② 每一拍前确认 target 还在 —— 用户滚完回到 DSH 点「完成」时，中心点下面已经换成
 *      DSH 了，那一帧要是被 commit，长图中间就会插进一张别的窗口的画面。这条守卫是
 *      "结果不被污染"的全部依仗，所以它**每拍都要真的问一次**，不能拿缓存的答案糊弄。
 *
 * 解析出来的 hwnd 是 **root**（GetAncestor(GA_ROOT)）：WindowFromPoint 只会给叶子
 * （Electron 的渲染子窗口、某个按钮），叶子的句柄随鼠标移动就变，当不了会话标识。
 * @param {number} x 物理像素
 * @param {number} y 物理像素
 */
/**
 * hitTest 的助手变体。**拿不到就返回 null**（调用方随即回落 spawn hitwin.ps1），
 * 绝不用"猜"顶上：遮挡守卫是长图不被别的窗口污染的**唯一**依仗，答案必须是真问到的那一个。
 * @returns {Promise<null | {ok:boolean, hwnd:number, title:string, class:string, pid:number,
 *   x:number, y:number, w:number, h:number, error:string}>}
 */
async function hitTestViaHelper(x, y) {
	if (process.env.DSH_SHOT_HELPER === '0') return null
	let shooter = null
	try {
		shooter = await shooterModule()
	} catch {
		return null
	}
	let answer = null
	try {
		answer = await shooter.shootViaHelper({ kind: 'hittest', x, y })
	} catch {
		return null
	}
	if (answer === null) return null
	const info = answer.info ?? {}
	if (answer.ok !== true || info.ok !== true) return null
	const hwnd = Number(info.hwnd) || 0
	if (hwnd === 0) return null
	return {
		ok: true,
		hwnd,
		title: String(info.title ?? ''),
		class: String(info.class ?? ''),
		pid: Number(info.pid) || 0,
		x: Number(info.x) || 0,
		y: Number(info.y) || 0,
		w: Number(info.w) || 0,
		h: Number(info.h) || 0,
		error: '',
	}
}

export async function hitTest(x, y) {
	const hx = Math.round(Number(x) || 0)
	const hy = Math.round(Number(y) || 0)
	/**
	 * 先问**常驻助手**。长截图 manual 模式**每一拍**都要问一次"区域中心还是那个窗口吗"，
	 * 而 spawn 一个 pwsh 跑 hitwin.ps1 实测 **~1.2s**（冷启动）；`step()` 是
	 * `Promise.all([guard(), grabFrame()])`，这 1.2s 于是成了整拍的天花板。
	 * 搬进常驻助手之后同一件事是**几十毫秒**。hitwin.ps1 保留为回落
	 * （助手没热 / 老宿主 / DSH_SHOT_HELPER=0）。
	 */
	const fast = await hitTestViaHelper(hx, hy)
	if (fast !== null) return fast
	const args = [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'hitwin.ps1'),
		'-X', String(hx), '-Y', String(hy), '-Json',
	]
	const res = await run(findPwsh(), args, { timeoutMs: 15_000 })
	const info = lastJsonLine(res.stdout)
	if (info === null) {
		const error = note('hitwin', res.stderr.trim() || `exit ${res.code}${res.killed ? ' (timeout)' : ''}`)
		return { ok: false, hwnd: 0, title: '', class: '', pid: 0, x: 0, y: 0, w: 0, h: 0, error }
	}
	return {
		ok: info.ok !== false,
		hwnd: Number(info.hwnd) || 0,
		title: String(info.title ?? ''),
		class: String(info.class ?? ''),
		pid: Number(info.pid) || 0,
		x: Number(info.x) || 0,
		y: Number(info.y) || 0,
		w: Number(info.w) || 0,
		h: Number(info.h) || 0,
		error: info.ok === false ? String(info.error ?? 'hitwin failed') : '',
	}
}

/* ─────────────────── 合成滚轮（auto 长截图的每一帧） ─────────────────── */

/**
 * 滚轮走常驻助手。
 *
 * 为什么：auto 长截图**每一帧**都要发一次滚轮，而原来那个是 `spawn pwsh wheel.ps1` ——
 * 实测 600–900ms 的进程启动，真正有用的只有 ~1ms 的 mouse_event。于是 auto 模式的节拍
 * 被固定开销钉死。这和 R22 把 hitTest 搬进助手是同一笔账（1228ms → 35ms）。
 *
 * 语义必须逐字相同：同一点位、同样顺序（SetCursorPos → 等光标真到位 → mouse_event），
 * 返回值也照旧报 x/y/delta/times。拿不到答案一律**回落** wheel.ps1，绝不猜。
 *
 * @returns {Promise<null | {ok:boolean, moved:boolean, via:string, error:string}>}
 */
async function wheelViaHelper(x, y, delta, times) {
	if (process.env.DSH_SHOT_HELPER === '0') return null
	let shooter = null
	try {
		shooter = await shooterModule()
	} catch {
		return null
	}
	let answer = null
	try {
		answer = await shooter.shootViaHelper({ kind: 'wheel', x, y, delta, times })
	} catch {
		return null
	}
	if (answer === null) return null
	const info = answer.info ?? {}
	if (answer.ok !== true || info.ok !== true) return null
	// moved=false：光标没到点位上，助手**故意没发滚轮**（低完整性调用者被 UIPI 丢了光标移动）
	// —— 这时说 "ok" 就是在骗人，页面根本没动。
	return {
		ok: info.moved === true,
		moved: info.moved === true,
		via: 'helper',
		// 与 spawn 路径**逐字相同**的坐标回传：两条路的结果要能互相比较。
		x: Number(info.x) || 0,
		y: Number(info.y) || 0,
		delta: Number(info.delta) || 0,
		times: Number(info.times) || 0,
		error: info.moved === true ? '' : 'cursor did not reach the point (UIPI dropped it)',
	}
}

/**
 * 把光标挪到 (x,y) 并往下滚 delta（负数 = 向下）。
 * @returns {Promise<{ok:boolean, moved:(boolean|null), via:string, ms:number, error:string}>}
 *   `moved === null` = 走的是 spawn 回落，老脚本报不出"光标到没到"，不假装知道。
 */
export async function wheelAt(x, y, delta, times = 1) {
	const hx = Math.round(Number(x) || 0)
	const hy = Math.round(Number(y) || 0)
	const d = Math.trunc(Number(delta) || 0)
	const n = Math.max(1, Math.min(20, Math.trunc(Number(times) || 1)))
	const started = Date.now()
	const fast = await wheelViaHelper(hx, hy, d, n)
	if (fast !== null) return { ...fast, ms: Date.now() - started }
	const res = await run(
		findPwsh(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'wheel.ps1'),
			'-X', String(hx), '-Y', String(hy), '-Delta', String(d), '-Times', String(n),
		],
		{ timeoutMs: 15_000 }
	)
	const info = lastJsonLine(res.stdout)
	// `moved` 是脚本**自己观察到**的（光标到没到），不是我们回头再读一次光标 ——
	// 事后读会被用户真实鼠标干扰，那样的判据在有人在用的机器上必然是抖的。
	const moved = info === null ? null : info.moved === true ? true : info.moved === false ? false : null
	return {
		ok: res.code === 0 && info !== null && info.ok !== false,
		moved,
		via: 'spawn',
		// 与助手路径**逐字相同**的坐标回传（两条路的结果要能互相比较）。
		x: info === null ? hx : Number(info.x) || hx,
		y: info === null ? hy : Number(info.y) || hy,
		delta: info === null ? d : Number(info.delta) || d,
		times: info === null ? n : Number(info.times) || n,
		ms: Date.now() - started,
		error: info === null ? res.stderr.trim() || `exit ${res.code}${res.killed ? ' (timeout)' : ''}` : String(info.error || ''),
	}
}

/* ─────────────────── 窗口挑选（真实桌面点选） ─────────────────── */

/**
 * 让用户**在真实桌面上点一个窗口**（ps/pickwindow.ps1，一个全屏 overlay GUI）。
 *
 * 这是本插件里唯一一个**会阻塞几十秒**的调用：脚本自己开一块全屏窗口，用户在屏幕上把
 * 鼠标移到目标窗口上点一下（或按 Esc 取消）。node 侧只是等它退出再把 JSON 读回来。
 *
 * 超时是两层：脚本自己的 `-TimeoutSec`（到点它自己退，给出 `{ok:false,cancelled:true}`），
 * 以及 node 侧的 `TimeoutSec + 20s`（只给"脚本自己也没能退出"兜底，到点直接 kill）。
 * 上层调用者（Remote 方法）必须按阻塞调用对待 —— 用户就是要花几秒挑窗口。
 *
 * @param {number} [timeoutSec] 用户最多有多少秒可以挑，默认 120
 */
export async function pickWindow(timeoutSec = 120) {
	try {
		await mkdir(CACHE_DIR, { recursive: true })
	} catch {}
	const secs = Math.max(5, Math.min(600, Math.trunc(Number(timeoutSec) || 120)))
	const outJson = path.join(CACHE_DIR, `pickwin-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`)
	const started = Date.now()
	// 参数顺序不是随便排的：`-File` 之后的**所有**东西都是脚本参数，所以 -STA 必须在它前面。
	// stdio 沿用 run() 的"真文件句柄"方案 —— 管道在这个沙箱里会让 powershell.exe 以
	// 0xC0000142 退出，而这个脚本是个 GUI，更不能喂 'ignore'。
	const res = await run(
		findPowershell(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA',
			'-File', path.join(PS_DIR, 'pickwindow.ps1'),
			'-OutJson', outJson,
			'-TimeoutSec', String(secs),
		],
		{ timeoutMs: (secs + 20) * 1000 }
	)
	// 先读 -OutJson 文件：stdout 里除了那行 JSON 还可能有脚本的进度输出，文件是干净的。
	let info = null
	try {
		info = JSON.parse(fs.readFileSync(outJson, 'utf8'))
	} catch {}
	if (info === null || typeof info !== 'object') info = lastJsonLine(res.stdout)
	try {
		fs.rmSync(outJson, { force: true })
	} catch {}

	if (info === null) {
		const error = res.killed ? 'timeout' : note('pickwin', res.stderr.trim() || `exit ${res.code}`)
		return { ok: false, cancelled: false, hwnd: 0, title: '', class: '', pid: 0, x: 0, y: 0, w: 0, h: 0, child: 0, ms: Date.now() - started, reason: '', error }
	}
	const ok = info.ok === true
	return {
		ok,
		cancelled: info.cancelled === true,
		hwnd: Number(info.hwnd) || 0,
		title: String(info.title ?? ''),
		class: String(info.class ?? ''),
		pid: Number(info.pid) || 0,
		x: Number(info.x) || 0,
		y: Number(info.y) || 0,
		w: Number(info.w) || 0,
		h: Number(info.h) || 0,
		child: Number(info.child) || 0,
		ms: Number(info.ms) || Date.now() - started,
		reason: String(info.reason ?? ''),
		// ok=true 时 error 恒为 ''：契约里 error 是"为什么没挑到"，挑到了就没有为什么。
		error: ok ? '' : String(info.error ?? (info.cancelled === true ? 'cancelled' : 'no window selected')),
	}
}



const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

/**
 * 读图并转成 data URL。超过 maxBytes 就先降采样（用 PowerShell/.NET 缩放），
 * 免得一次 Remote 调用把网关噎住。
 * @param {string} file
 * @param {number} [maxBytes]
 */
export async function toDataUrl(file, maxBytes = MAX_DATAURL_BYTES) {
	let target = file
	let scaled = false
	let buf = await readFile(file)
	if (buf.length > maxBytes) {
		const small = file.replace(/\.png$/i, '.small.jpg')
		const res = await run(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'imgtool.ps1'),
				'-Op', 'scale', '-In', file, '-Out', small, '-MaxWidth', '2560', '-Quality', '92',
			],
			{ timeoutMs: 30_000 }
		)
		if (res.code === 0 && existsSync(small)) {
			const sbuf = await readFile(small)
			if (sbuf.length < buf.length) {
				buf = sbuf
				target = small
				scaled = true
			}
		}
	}
	const ext = path.extname(target).toLowerCase()
	return {
		dataUrl: `data:${MIME[ext] ?? 'image/png'};base64,${buf.toString('base64')}`,
		mime: MIME[ext] ?? 'image/png',
		bytes: buf.length,
		scaled,
		file: target,
	}
}

/**
 * 缩略图：把一张图缩到 maxWidth 宽，输出 jpg 的 data URL。
 *
 * 存在的理由：长截图会话每抓一帧都要让界面看见"在抓了"，但一整帧的 PNG dataUrl 有
 * 几百 KB 到几 MB，每秒一次会把 Remote 网关噎死；140px 宽的 jpg 只有几 KB。
 * 走 imgtool.ps1 -Op scale（System.Drawing，无需任何 node 侧图像库）。
 *
 * ⚠️ **绝不抛异常**：它服务于 status()，缩略图失败最多是没有预览图，不能让整个
 *    状态查询跟着炸掉（那是"静默死掉"的另一种写法）。失败一律 {ok:false, dataUrl:''}。
 * @param {string} file
 * @param {number} [maxWidth]
 * @param {number} [quality]
 */
export async function thumb(file, maxWidth = 140, quality = 70) {
	const empty = { ok: false, path: '', dataUrl: '', mime: 'image/jpeg', bytes: 0, width: 0, height: 0, error: '' }
	try {
		if (typeof file !== 'string' || file === '' || !existsSync(file)) {
			return { ...empty, error: 'thumb: file not found: ' + String(file ?? '') }
		}
		await mkdir(CACHE_DIR, { recursive: true })
		const w = Math.max(16, Math.min(4096, Math.trunc(Number(maxWidth) || 140)))
		const q = Math.max(20, Math.min(100, Math.trunc(Number(quality) || 70)))
		const out = path.join(CACHE_DIR, `thumb-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jpg`)
		const res = await run(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'imgtool.ps1'),
				'-Op', 'scale', '-In', file, '-Out', out, '-MaxWidth', String(w), '-Quality', String(q),
			],
			{ timeoutMs: 20_000 }
		)
		if (!existsSync(out)) {
			return { ...empty, error: note('thumb', res.stderr.trim() || `imgtool exit ${res.code}`) }
		}
		const buf = await readFile(out)
		try {
			await rm(out, { force: true })
		} catch {}
		// imgtool scale 打的是人话（"scaled 1920x1080 -> 140x79 <out>"），顺手把尺寸抠出来，
		// 省一次 -Op info 的子进程。
		const m = /scaled \d+x\d+ -> (\d+)x(\d+)/.exec(res.stdout)
		return {
			ok: true,
			path: out,
			dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'),
			mime: 'image/jpeg',
			bytes: buf.length,
			width: m === null ? 0 : Number(m[1]) || 0,
			height: m === null ? 0 : Number(m[2]) || 0,
			error: '',
		}
	} catch (error) {
		return { ...empty, error: note('thumb', error) }
	}
}

/* ─────────────────────────── OCR ─────────────────────────── */
/**
 * 对某张图的一块区域做离线 OCR（Windows.Media.Ocr，不出本机）。
 * @param {{file: string, rect?: string, upscale?: number}} opts rect = "x,y,w,h"
 */
export async function ocr(opts) {
	if (!opts?.file || !existsSync(opts.file)) return { ok: false, error: 'shot file not found', text: '', lines: [] }
	const args = [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'ocr_region.ps1'),
		'-Image', opts.file, '-Json',
	]
	if (opts.rect) args.push('-Rect', String(opts.rect))
	if (Number.isFinite(opts.upscale)) args.push('-Upscale', String(opts.upscale))
	// 识别语言。默认不传 => 脚本自己的 'auto'（优先 zh-Hans-CN），实测在这台机器上就是
	// 中文引擎。用户可以在文本面板里换成 ja/en 再识别一次 —— 实测 ja 与 auto 在同一张
	// DSH 截图上给出**实质不同**的中文（auto 202 个 CJK 字 vs ja 173 个），所以这不是摆设。
	if (typeof opts.lang === 'string' && opts.lang.length > 0 && opts.lang !== 'auto') args.push('-Language', opts.lang)
	if (typeof opts.preprocess === 'string' && ['gray', 'contrast'].includes(opts.preprocess)) args.push('-Preprocess', opts.preprocess)
	const res = await run(findPowershell(), args, { timeoutMs: 45_000 })
	const info = lastJsonLine(res.stdout)
	if (res.code !== 0 || info === null) {
		const error = note('ocr', res.stderr.trim() || `exit ${res.code}${res.killed ? ' (timeout)' : ''}`)
		return { ok: false, error, stderr: res.stderr.slice(0, 800), text: '', lines: [], langs: [] }
	}
	return {
		ok: true,
		text: String(info.text ?? ''),
		lines: Array.isArray(info.lines) ? info.lines : [],
		lang: info.lang ?? '',
		// 这台机器上装了哪些识别语言 —— 界面的语言下拉框就是它。别在客户端硬编码。
		langs: Array.isArray(info.langs) ? info.langs : [],
		width: info.width ?? 0,
		height: info.height ?? 0,
		// 识别过程本身也要能看见，别让"降级"静默发生（R19）：used 说走了哪条路
		// （single/fixed/probe/banded/fallback-upscale），fallback 说有没有被夹住
		// （probe-empty / clamped-maxdim / clamped-pixels）。空值 = 脚本没报 = 老脚本。
		used: info.used ?? '',
		fallback: info.fallback ?? '',
		scale: info.scale ?? 0,
		tiles: info.tiles ?? 0,
	}
}

/* ─────────────────────────── 录屏 ─────────────────────────── */

let recording = null

/** 等子进程退出（到点就 kill），给"发完 q 之后"用。 */
function waitClose(child, ms) {
	return new Promise((resolve) => {
		if (child.exitCode !== null) {
			resolve()
			return
		}
		const t = setTimeout(() => {
			try {
				child.kill()
			} catch {}
			resolve()
		}, ms)
		child.on('close', () => {
			clearTimeout(t)
			resolve()
		})
	})
}

/**
 * 直接由 node 起 ffmpeg：**stdin 管道**（唯一能发 'q' 的通道）+ stderr 管道。
 *
 * 为什么必须是 'q'：硬杀（TerminateProcess）留下的 mp4 没有 moov atom，实测
 * `moov atom not found`，录了 262KB 全废。'q' 让 muxer 把索引写完再退出。
 */
function startFfmpegDirect(ffmpeg, args) {
	const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
	let stderr = ''
	child.stderr?.on('data', (d) => {
		if (stderr.length < 4096) stderr += d.toString('utf8')
	})
	return {
		child,
		via: 'node',
		stderr: () => stderr,
		async quit() {
			try {
				child.stdin?.write('q')
			} catch {}
			await waitClose(child, 4000)
		},
	}
}

/**
 * 受限环境下的退路：node 的 `spawn` 一旦带管道就 EPERM（DSH 文件沙箱禁 CreatePipe），
 * ffmpeg 根本起不来。`ps/recspawn.ps1` 用 **.NET 的管道**代起（实测 .NET 不受该限制），
 * 我们只给它一个"退出信号文件"，它自己把 'q' 写进 ffmpeg 的 stdin。
 *
 * stderr/stdout 在这条路上**继承**给文件句柄：ffmpeg 的日志直接落进 errFile，
 * 既不占管道（满了会把 ffmpeg 冻住），node 这边也照样读得到。
 */
async function startFfmpegWrapped(ffmpeg, args) {
	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	const quitFile = path.join(CACHE_DIR, `rec-quit-${tag}.flag`)
	const argsFile = path.join(CACHE_DIR, `rec-args-${tag}.json`)
	const errFile = path.join(CACHE_DIR, `rec-err-${tag}.log`)
	await writeFile(argsFile, JSON.stringify(args), 'utf8')
	try {
		await rm(quitFile, { force: true })
	} catch {}
	const errFd = fs.openSync(errFile, 'w')
	let child
	try {
		child = spawn(
			findPwsh(),
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'recspawn.ps1'), '-Exe', ffmpeg, '-ArgsFile', argsFile, '-Quit', quitFile],
			{ windowsHide: true, stdio: ['ignore', errFd, errFd] }
		)
	} finally {
		try {
			fs.closeSync(errFd)
		} catch {}
	}
	return {
		child,
		via: 'recspawn',
		stderr: () => {
			try {
				return fs.readFileSync(errFile, 'utf8').slice(-4096)
			} catch {
				return ''
			}
		},
		async quit() {
			// 先落信号文件（脚本每 120ms 轮询一次），再等它带着 ffmpeg 一起退。
			try {
				await writeFile(quitFile, 'q', 'utf8')
			} catch {}
			await waitClose(child, 12_000)
			try {
				await rm(quitFile, { force: true })
			} catch {}
		},
	}
}

/**
 * 开始录屏（ffmpeg gdigrab，H.264 + 可选麦克风）。
 * @param {{fps?: number, region?: string, audio?: boolean}} opts region = "x,y,w,h"（空=整屏）
 */
export async function recordStart(opts = {}) {
	if (recording !== null) return { ok: true, recording: true, path: recording.file, already: true }
	await ensureDirs()
	// 落 CACHE_DIR/rec（临时），不落用户图片目录 —— 理由见 REC_DIR 的注释。
	await mkdir(REC_DIR, { recursive: true })
	const file = path.join(REC_DIR, `rec-${stampName()}.mp4`)
	const fps = Number.isFinite(opts.fps) ? Math.max(5, Math.min(30, opts.fps)) : 15
	const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps)]
	if (opts.region) {
		const [x, y, w, h] = String(opts.region).split(',').map(Number)
		if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
			args.push('-offset_x', String(x), '-offset_y', String(y), '-video_size', `${w}x${h}`)
		}
	}
	args.push('-i', 'desktop')
	if (opts.audio) args.push('-f', 'dshow', '-i', 'audio=virtual-audio-capturer')
	args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file)

	const ffmpeg = findFfmpeg()
	let started
	try {
		started = startFfmpegDirect(ffmpeg, args)
	} catch (error) {
		// EPERM = 管道被禁（受限沙箱）。别的错误照实抛给上层，不要拿退路去掩盖。
		if (error?.code !== 'EPERM') {
			const err = note('record', error?.message ?? error)
			return { ok: false, recording: false, path: '', error: err }
		}
		try {
			started = await startFfmpegWrapped(ffmpeg, args)
		} catch (error2) {
			const err = note('record', error2?.message ?? error2)
			return { ok: false, recording: false, path: '', error: err }
		}
	}
	recording = { child: started.child, file, started: Date.now(), stderr: started.stderr, quit: started.quit, via: started.via }
	// ffmpeg 立刻死掉的话（比如根本没装）在这里就能看出来
	await new Promise((r) => setTimeout(r, 600))
	if (started.child.exitCode !== null && started.child.exitCode !== 0) {
		const stderr = started.stderr()
		recording = null
		const error = note('record', stderr.trim() || `ffmpeg exit ${started.child.exitCode}`)
		return { ok: false, recording: false, path: '', error }
	}
	return { ok: true, recording: true, path: file, fps, via: started.via }
}

/**
 * 结束录屏（给 ffmpeg 发 q 让它把 moov 写完，再等它退出）。
 *
 * 返回值刻意带上 width/height：录完的下一步几乎总是"抽一帧当截图"或"贴进输入框"，
 * 而 ffmpeg 的 gdigrab 是按区域录的，尺寸只有文件自己知道。从 rec.ps1 info 拿
 * （它内部先用 ffprobe 解析，拿不到再退回 System.Drawing 读首帧），拿不到就给 0 —— 
 * 契约要求字段齐全，绝不返回 undefined。
 */
export async function recordStop() {
	if (recording === null) {
		return { ok: true, recording: false, path: '', seconds: 0, bytes: 0, width: 0, height: 0, duration: 0, temp: true, error: '' }
	}
	const { file, started } = recording
	const wallSeconds = Math.round((Date.now() - started) / 100) / 10
	// 停法只有一种：让 ffmpeg 自己收到 q 走正常退出（硬杀 = moov 丢失 = 整段报废）。
	// 谁去写那个 q 由 startFfmpeg* 决定 —— 正常路径是 node 直接写 stdin 管道，
	// 受限环境由 recspawn.ps1 代写。两条路都在这里收敛成一句 quit()。
	await recording.quit()
	recording = null
	if (!existsSync(file)) {
		const error = note('record', 'ffmpeg produced no file')
		return { ok: false, recording: false, path: file, seconds: wallSeconds, bytes: 0, width: 0, height: 0, duration: 0, temp: true, error }
	}
	const s = await stat(file)
	const info = await recAction('info', { file }, 40_000)
	const duration = Number(info.duration) || 0
	return {
		ok: true,
		recording: false,
		path: file,
		// seconds = **真实时长**（ffprobe 报的），不是 node 侧的墙钟：退路（recspawn.ps1）
		// 要先把 pwsh 起起来，ffmpeg 实际开录比 recordStart 返回晚 1~1.5s，用墙钟会把
		// "录了 3.6 秒"报到一段 1.6 秒的视频头上（实测踩过）。ffprobe 问不到才退回墙钟。
		seconds: duration > 0 ? duration : wallSeconds,
		wallSeconds,
		bytes: s.size,
		width: Number(info.width) || 0,
		height: Number(info.height) || 0,
		duration,
		// temp:true 是给界面的信号：这段录屏现在在缓存里，用户还没决定 keep 还是 discard。
		temp: true,
		error: '',
	}
}

export function isRecording() {
	return recording !== null
}

/* ─────────────────────── 录屏后处理（rec.ps1） ─────────────────────── */

/**
 * 跑 ps/rec.ps1 的一个 action，把它的 JSON 结果解析出来。
 *
 * 每个 action 都往 stdout 最后一行和 `-OutJson` 里各写一份同样的 JSON；这里**优先读文件**
 * —— stdout 里可能还混着 ffmpeg 的进度行，文件是干净的。两边都拿不到才算失败。
 *
 * @param {'info'|'frame'|'strip'|'trim'|'clip'|'open'|'keep'|'discard'} action
 * @param {{file?: string, time?: number, out?: string, width?: number, outDir?: string,
 *   start?: number, end?: number, count?: number, name?: string}} [params]
 * @param {number} [timeoutMs]
 */
export async function recAction(action, params = {}, timeoutMs = 60_000) {
	const act = String(action ?? '').trim()
	if (act === '') return { ok: false, action: '', error: 'rec: no action given' }
	try {
		await mkdir(CACHE_DIR, { recursive: true })
	} catch {}
	const outJson = path.join(CACHE_DIR, `rec-${act}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`)
	const args = [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'rec.ps1'),
		'-Action', act,
		// 显式把**验过的** ffmpeg 递进去：PATH 上那个可能是 Cherry Studio 的 mise 死壳
		// （exit 127），rec.ps1 自己找路径时也会踩同一个坑。
		'-Ffmpeg', findFfmpeg(),
		'-CacheDir', CACHE_DIR,
	]
	const file = typeof params.file === 'string' ? params.file : ''
	if (file !== '') args.push('-In', file)
	// -Time < 0 是 rec.ps1 的"没给"哨兵（它会自己选一个中间时刻），所以只在真的给了才传。
	if (Number.isFinite(params.time) && params.time >= 0) args.push('-Time', String(params.time))
	const out = typeof params.out === 'string' ? params.out : ''
	if (out !== '') args.push('-Out', out)
	if (Number.isFinite(params.width) && params.width > 0) args.push('-Width', String(Math.trunc(params.width)))
	const outDir = typeof params.outDir === 'string' ? params.outDir : ''
	if (outDir !== '') args.push('-OutDir', outDir)
	if (Number.isFinite(params.start) && params.start >= 0) args.push('-Start', String(params.start))
	if (Number.isFinite(params.end) && params.end >= 0) args.push('-End', String(params.end))
	if (Number.isFinite(params.count) && params.count > 0) args.push('-Count', String(Math.trunc(params.count)))
	if (typeof params.name === 'string' && params.name !== '') args.push('-Name', params.name)
	args.push('-OutJson', outJson)

	const res = await run(findPowershell(), args, { timeoutMs })
	let info = null
	try {
		const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'))
		if (parsed !== null && typeof parsed === 'object') info = parsed
	} catch {}
	if (info === null) info = lastJsonLine(res.stdout)
	try {
		fs.rmSync(outJson, { force: true })
	} catch {}

	if (info === null) {
		const error = res.killed
			? `timeout after ${timeoutMs}ms`
			: note('rec:' + act, res.stderr.trim() || `exit ${res.code}`)
		return { ok: false, action: act, error, stderr: res.stderr.slice(0, 800), code: res.code }
	}
	// 失败分支也一律带 action 字段，调用方不需要猜是哪个动作炸的。
	return { action: act, ...info, ok: info.ok === true }
}

/**
 * 抽一串小图（胶片条）并把每张转成 data URL，**每张控在 maxBytes 以内**。
 *
 * 为什么要有这个上限：胶片条是给界面点选用的，一次 12 张全尺寸 PNG 的 dataUrl 能到几 MB，
 * 一次 Remote 调用就能把网关噎住。rec.ps1 的 -Width 是"缩放到这个宽度"（ffmpeg scale=W:-2），
 * 所以超了就**把宽度压一半重抽一次** —— 这是唯一真正能压小 PNG 的旋钮。
 *
 * @param {{file: string, count?: number, width?: number}} params
 * @param {number} [maxBytes]
 */
export async function recStrip(params, maxBytes = MAX_STRIP_BYTES) {
	const file = typeof params?.file === 'string' ? params.file : ''
	if (file === '') return { ok: false, frames: [], count: 0, width: 0, error: 'strip: -In required' }
	let width = Math.max(80, Math.min(1280, Math.trunc(Number(params.width) || 240)))
	const count = Math.max(1, Math.min(60, Math.trunc(Number(params.count) || 12)))
	const outDir = path.join(REC_DIR, 'strip', stampName())
	let lastError = ''
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const res = await recAction('strip', { file, count, width, outDir }, 180_000)
		const rows = Array.isArray(res.frames) ? res.frames : []
		if (rows.length === 0) {
			lastError = String(res.error ?? 'strip produced no frames')
			return { ok: false, frames: [], count: 0, width, error: lastError }
		}
		const frames = []
		let biggest = 0
		for (const row of rows) {
			const path0 = String(row?.path ?? '')
			if (path0 === '' || !existsSync(path0)) continue
			const data = await toDataUrl(path0, maxBytes)
			biggest = Math.max(biggest, data.bytes)
			frames.push({ t: Number(row?.t) || 0, path: path0, bytes: data.bytes, dataUrl: data.dataUrl })
		}
		if (frames.length === 0) return { ok: false, frames: [], count: 0, width, error: 'strip frames unreadable' }
		if (biggest <= maxBytes || attempt === 1) {
			return { ok: true, frames, count: frames.length, width, dir: outDir, error: '' }
		}
		// 太大：宽度减半重来（缩略图看得见就行，不是给人当成品用的）。
		width = Math.max(80, Math.round(width / 2))
	}
	return { ok: false, frames: [], count: 0, width, error: lastError || 'strip failed' }
}

/* ─────────────────────────── 存盘 ─────────────────────────── */

/**
 * 把 data URL 存成文件。默认存到 图片\DSH截图\。
 * @param {string} dataUrl
 * @param {string} [name]
 */
export async function save(dataUrl, name) {
	const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl ?? ''))
	if (m === null) return { ok: false, error: 'not a base64 data URL', path: '', bytes: 0 }
	const mime = m[1]
	const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'
	/**
	 * 落盘目录**按顺序试**，第一个建得出来的就用：
	 *   ① `~/Pictures/DSH截图` —— 用户找得到（截图/贴图/dump 都记这里最自然）
	 *   ② `SHOTS_DIR`（插件自己的 .cache/shots，或 DSH_SHOT_DIR 覆盖）—— **保证可写**
	 *
	 * 为什么要有②：实测 ① 的 `mkdir` 会 EPERM（沙箱/受限令牌下用户图片目录不可写），
	 * 而以前这里是**硬失败** —— 表现是「诊断快照点了一点反应都没有」，
	 * 因为 mkdir 抛异常被上一层 catch 吞掉了。现在失败会带着真实原因报回去。
	 */
	const candidates = [path.join(os.homedir(), 'Pictures', 'DSH截图'), SHOTS_DIR]
	let dir = ''
	let mkErr = null
	for (const candidate of candidates) {
		try {
			await mkdir(candidate, { recursive: true })
			dir = candidate
			break
		} catch (error) {
			mkErr = error
		}
	}
	if (dir === '') {
		return { ok: false, error: 'cannot create shots dir: ' + String(mkErr?.message ?? mkErr), path: '', bytes: 0 }
	}
	const safe = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
	const base = safe.length > 0 ? safe.replace(/\.(png|jpg|jpeg|webp)$/i, '') : 'shot'
	const d = new Date()
	const p = (n) => String(n).padStart(2, '0')
	const file = path.join(dir, `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ext}`)
	await writeFile(file, Buffer.from(m[2], 'base64'))
	const s = await stat(file)
	return { ok: true, path: file, bytes: s.size, dir }
}

/* ─────────────────────────── 长截图 ─────────────────────────── */

/**
 * 长截图：对一块区域「滚一屏 → 抓一张」，最后用重叠区对齐拼起来。
 * 滚动用合成滚轮（SetCursorPos + mouse_event），和 QQ 长截图一个路子：
 * 会短暂接管真实鼠标，所以只在用户显式点击时跑。
 * @param {{rect: string, maxFrames?: number, delta?: number, settleMs?: number, hideSelf?: boolean}} opts
 */
export async function scrollCapture(opts) {
	const rect = String(opts?.rect ?? '')
	const parts = rect.split(',').map(Number)
	if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) {
		return { ok: false, error: 'rect must be "x,y,w,h"' }
	}
	const [x, y, w, h] = parts
	const maxFrames = Math.max(2, Math.min(20, Number(opts.maxFrames) || 8))
	const delta = Math.max(60, Math.min(h - 20, Number(opts.delta) || Math.round(h * 0.8)))
	const settleMs = Math.max(120, Math.min(1500, Number(opts.settleMs) || 320))
	await ensureDirs()

	const frames = []
	for (let i = 0; i < maxFrames; i += 1) {
		const frame = path.join(SHOTS_DIR, `scroll-${Date.now()}-${i}.png`)
		const res = await run(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'capture.ps1'),
				'-Mode', 'desktop', '-Out', frame, '-Json', ...(opts.hideSelf ? ['-HideSelf'] : []),
			],
			{ timeoutMs: 25_000 }
		)
		if (res.code !== 0 || !existsSync(frame)) break
		// 每帧只留这块区域
		const cropped = frame.replace(/\.png$/, '.crop.png')
		await run(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'imgtool.ps1'),
				'-Op', 'crop', '-In', frame, '-Out', cropped, '-Rect', rect,
			],
			{ timeoutMs: 20_000 }
		)
		await rm(frame, { force: true })
		frames.push(existsSync(cropped) ? cropped : frame)
		if (i === maxFrames - 1) break
		// 把鼠标放到区域中心再滚，滚轮事件才会发给这个窗口
		await run(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'wheel.ps1'),
				'-X', String(Math.round(x + w / 2)), '-Y', String(Math.round(y + h / 2)),
				'-Delta', String(-delta), '-Times', '1',
			],
			{ timeoutMs: 10_000 }
		)
		await new Promise((r) => setTimeout(r, settleMs))
	}

	if (frames.length === 0) return { ok: false, error: 'no frames captured' }
	if (frames.length === 1) {
		const only = await toDataUrl(frames[0])
		return { ok: true, id: path.basename(frames[0], '.png'), dataUrl: only.dataUrl, frames: 1, width: w, height: h, path: frames[0] }
	}
	const out = shotPath().replace(/\.png$/, '.long.png')
	const res = await run(
		findPython(),
		[path.join(PY_DIR, 'stitch.py'), '--out', out, '--overlap-min', '40', ...frames],
		{ timeoutMs: 120_000 }
	)
	const info = lastJsonLine(res.stdout)
	if (res.code !== 0 || info === null || !existsSync(out)) {
		const error = note('scroll', res.stderr.trim() || `stitch exit ${res.code}`)
		return { ok: false, error, frames: frames.length }
	}
	const data = await toDataUrl(out)
	return {
		ok: true,
		id: path.basename(out, '.png'),
		dataUrl: data.dataUrl,
		frames: frames.length,
		width: info.width ?? w,
		height: info.height ?? h,
		path: out,
		scaled: data.scaled,
	}
}

/* ─────────────────────────── 自检 ─────────────────────────── */

/** 进程完整性（低完整性 = 工具沙箱，隐藏窗口/模拟输入会被 UIPI 静默拒绝）。 */
async function integrity() {
	const res = await run('whoami.exe', ['/groups'], { timeoutMs: 8000 })
	const m = /Mandatory Label\\([^\r\n]+)/i.exec(res.stdout)
	return m === null ? '' : m[1].trim()
}

/** 一屏看全这台机器上截图链路的状态。 */
export async function status() {
	await ensureDirs()
	let shots = []
	try {
		const names = (await readdir(SHOTS_DIR)).filter((n) => n.endsWith('.png') || n.endsWith('.jpg'))
		shots = names.slice(-8).reverse()
	} catch {}
	const pwsh = findPwsh()
	const ps51 = findPowershell()
	const ffmpeg = findFfmpeg()
	const python = findPython()
	const integrityLevel = await integrity().catch(() => '')
	// 助手状态（同样走惰性动态 import，理由见 captureViaHelper 上面那段注释）。
	let shooter = null
	try {
		shooter = (await shooterModule()).shooterStatus()
	} catch (error) {
		shooter = { enabled: process.env.DSH_SHOT_HELPER !== '0', alive: false, ready: false, error: String(error?.message ?? error) }
	}
	return {
		ok: true,
		pluginRoot: PLUGIN_ROOT,
		psDir: PS_DIR,
		shotsDir: SHOTS_DIR,
		pwsh,
		powershell51: ps51,
		ffmpeg,
		python,
		hasFfmpeg: existsSync(ffmpeg) || ffmpeg === 'ffmpeg.exe',
		integrity: integrityLevel,
		recording: isRecording(),
		shooter,
		shots,
		lastError: last.error,
		lastErrorAt: last.at,
		node: process.versions.node,
		electron: process.versions.electron ?? null,
	}
}

/** 把开机自检写到 .cache/boot-report.json（宿主没有 stdout 可看，只能落盘）。 */
export async function writeReport(report) {
	try {
		await mkdir(CACHE_DIR, { recursive: true })
		await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
		return REPORT_PATH
	} catch {
		return null
	}
}
