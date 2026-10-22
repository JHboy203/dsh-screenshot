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

/* ─────────────────────── 录音设备（R41） ─────────────────────── */

/**
 * 解析 `ffmpeg -list_devices true -f dshow -i dummy` 的 stderr，得到本机的采集设备。
 *
 * **纯函数**：给一段固定文本就能单测，不需要"这台机器真的插着麦克风"。这一点是刻意的 ——
 * 设备枚举是本轮唯一"换台机器行为就不同"的东西，把解析从 IO 里拆出来才测得动。
 *
 * 实测格式（ffmpeg 9.0.1 / 本机 Windows）：
 *   [in#0 @ 000002...] "ov9734_techfront_camera" (none)
 *   [in#0 @ 000002...]   Alternative name "@device_pnp_\\?\usb#vid_0408..."
 *   [in#0 @ 000002...] "麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)" (audio)
 *   [in#0 @ 000002...]   Alternative name "@device_cm_{33D9A762-...}\\wave_{...}"
 *
 * 两个"看起来显然、其实会错"的地方：
 *  ① 设备名是**数据**：可能带空格、括号、®、中文 —— 只能整段取走，绝不能按空白切；
 *  ② `(none)` 不是"没有设备"：本机 ffmpeg 用它标**视频**设备（它认的类型只有 audio/video）。
 *     按"只收 audio/video"写会把摄像头丢掉、把 none 当未知 —— 所以 none 归为 video。
 */
export function parseDshowDevices(text) {
	const out = []
	for (const line of String(text ?? '').split(/\r?\n/)) {
		const hit = /^\s*\[[^\]]*\]\s+"(.+?)"\s+\((audio|video|none)\)\s*$/.exec(line)
		if (hit !== null) {
			out.push({ name: hit[1], alt: '', kind: hit[2] === 'audio' ? 'audio' : 'video' })
			continue
		}
		const alt = /^\s*\[[^\]]*\]\s+Alternative name "(.+?)"\s*$/.exec(line)
		if (alt !== null && out.length > 0) out[out.length - 1].alt = alt[1]
	}
	return out
}

/** 设备枚举缓存：插拔设备很少见，而"每次点录屏都多起一次 ffmpeg"是能被感知的等待。 */
let DEV_CACHE = { at: 0, devices: [], error: '' }
const DEV_TTL_MS = 30_000

/**
 * 枚举本机采集设备（video 也一起回来，选麦只取 audio）。
 * @param {{refresh?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, devices: Array<{name: string, alt: string, kind: string}>, error: string, cached: boolean}>}
 */
export async function listCaptureDevices(opts = {}) {
	if (opts.refresh !== true && DEV_CACHE.devices.length > 0 && Date.now() - DEV_CACHE.at < DEV_TTL_MS) {
		return { ok: true, devices: DEV_CACHE.devices, error: '', cached: true }
	}
	// ⚠️ 判据**不是退出码**：`-list_devices` 没有正常输入，找不到东西时它照样 exit 1。
	// 唯一能相信的是"解析出了设备"（这和本项目别处"别拿退出码当结论"是同一条教训）。
	const res = await run(findFfmpeg(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeoutMs: 10_000 })
	const devices = parseDshowDevices(res.stderr)
	if (devices.length === 0) {
		const error = note('list-devices', (res.stderr ?? '').trim().slice(-300) || `exit ${res.code}`)
		return { ok: false, devices: [], error, cached: false }
	}
	DEV_CACHE = { at: Date.now(), devices, error: '' }
	return { ok: true, devices, error: '', cached: false }
}

/**
 * 自动挑设备时用的两档名字判据（R42）。分档而不是一个大正则，是因为**顺序必须确定**：
 * 一块机器上同时有「麦克风阵列」与「立体声混音 (Realtek)」时，旧写法按系统列出的先后决定，
 * 换台机器结论就变。现在：麦克风（旁白）优先，其次系统音（立体声混音 / loopback / Stereo Mix）。
 * 英文 Stereo Mix 与中文「立体声混音」都要认 —— 同一块声卡在两种系统语言下名字不同。
 */
export const MIC_RE = /麦克风|microphone|\bmic\b/i
export const SYSTEM_AUDIO_RE = /stereo\s*mix|立体声|loopback|what\s*u\s*hear|混音|wave\s*out/i

/**
 * 从设备表里挑一个录音设备（纯函数；`want` 为空 = 自动挑）。
 * 三种结果都必须能被调用方**如实说出来**：
 *   `{device}`           找到了；
 *   `{device:null, warning}` 没找到 —— 但**不该让录屏失败**。
 *
 * 为什么"找不到就静音继续"而不是直接报错：用户点的是「录屏」，不是「录一段有声的」。
 * 没有麦就录不出声，为这件事让整段录屏起不来，等于把设备的错算到用户头上。但**绝不能静默**：
 * 回执必须带 `audio:false` + warning 原文，客户端要把它念出来（见 service.mjs 的白名单注释）。
 */
export function resolveAudioDevice(devices, want) {
	const list = Array.isArray(devices)
		? devices.filter((d) => d !== null && typeof d === 'object' && d.kind === 'audio')
		: []
	const asked = typeof want === 'string' ? want.trim() : ''
	const names = list.map((d) => `「${d.name}」`).join('、')
	if (list.length === 0) {
		return {
			device: null,
			reason: 'none',
			warning: asked === '' ? '这台机器上没有录音设备，这次静音录制' : `这台机器上没有录音设备（想用的「${asked}」无处可开），这次静音录制`,
		}
	}
	if (asked !== '') {
		const lower = asked.toLowerCase()
		// 优先按**名字**匹配（用户看到的就是名字），再认 ASCII 别名（中文名在某些管道里会被转码，
		// 别名是 `@device_...` 纯 ASCII，实测同样能开）。
		const hit =
			list.find((d) => d.name === asked) ??
			list.find((d) => d.alt !== '' && d.alt === asked) ??
			list.find((d) => d.name.toLowerCase() === lower)
		if (hit === undefined) return { device: null, reason: 'missing', warning: `找不到录音设备「${asked}」（现有：${names}），这次静音录制` }
		return { device: hit, reason: 'explicit', warning: '' }
	}
	// 自动挑的**顺序必须是确定的**（R42）：原来只写"第一块命中 /麦克风|stereo mix|立体声/ 的设备"，
	// 于是同一台机器上"麦克风"与"立体声混音"谁先被系统列出来就选谁 —— 换个顺序结论就变。
	// 现在显式分档：先麦克风（说话/旁白），再系统音（立体声混音/loopback），
	// 都没有才拿第一块 audio 设备。档内仍然按系统给的顺序（同档里没有更该优先的判据）。
	// 菜单那行也据此从「自动选麦」改成「自动选设备」—— 文案不能比实现更具体。
	const auto =
		list.find((d) => MIC_RE.test(d.name)) ??
		list.find((d) => SYSTEM_AUDIO_RE.test(d.name)) ??
		list[0]
	return { device: auto, reason: 'auto', warning: '' }
}

/**
 * 起 ffmpeg 录屏进程：优先 node 直起（stdin 管道能直接发 'q'），管道被禁（EPERM）时退到
 * recspawn.ps1。两条路都可能抛错 —— 由调用方把错误变成回执。
 * （R41 抽出来：带麦那条路径失败后要**退一次静音重试**，两处起进程的代码不能各抄一份。）
 */
async function spawnRecorder(ffmpeg, args) {
	try {
		return startFfmpegDirect(ffmpeg, args)
	} catch (error) {
		if (error?.code !== 'EPERM') throw error
		return startFfmpegWrapped(ffmpeg, args)
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/* ─────────────────── 显示器 / DPI 体检（R26） ─────────────────── */

/**
 * 显示器、DPI、虚拟屏幕的**只读**体检（ps/displays.ps1）。
 *
 * 为什么需要：整条抓屏链路都是按"虚拟屏幕 + 物理像素"写的，而这台机器只有**一块 125% 屏** ——
 * 在单屏上写错也看不出来。真正会翻车的三种情况是：第二块屏在**负坐标**方向、
 * **混合 DPI**（一块 100% 一块 150%）、窗口横跨两块屏。这个探针把这些事实一次报出来，
 * 于是"接上第二块屏之后跑一条命令"就有结论，不用重新推一遍代码。
 *
 * @returns {Promise<{ok:boolean, virtual:object|null, monitors:Array<object>, monitorCount:number,
 *   negativeOrigin:boolean, mixedDpi:boolean, cursor:object|null, foreground:object|null, error:string}>}
 */
export async function displays() {
	const empty = {
		ok: false,
		virtual: null,
		monitors: [],
		monitorCount: 0,
		negativeOrigin: false,
		mixedDpi: false,
		cursor: null,
		foreground: null,
		error: '',
	}
	const res = await run(findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'displays.ps1')], { timeoutMs: 20_000 })
	const info = lastJsonLine(res.stdout)
	if (info === null) return { ...empty, error: note('displays', res.stderr.trim() || `exit ${res.code}`) }
	// ⚠️ 单显示器时 PowerShell 的 ConvertTo-Json 会把 1 元素数组**拍成对象**，
	//    所以这里必须归一化：调用方永远拿到数组（否则"遍历显示器"的代码会在单屏机器上炸）。
	const monitors = Array.isArray(info.monitors) ? info.monitors : info.monitors === undefined || info.monitors === null ? [] : [info.monitors]
	return {
		ok: info.ok !== false,
		virtual: info.virtual === undefined ? null : info.virtual,
		monitors: monitors.map((m) => ({
			l: Number(m.l) || 0,
			t: Number(m.t) || 0,
			r: Number(m.r) || 0,
			b: Number(m.b) || 0,
			w: Number(m.w) || 0,
			h: Number(m.h) || 0,
			dpiX: Number(m.dpiX) || 0,
			dpiY: Number(m.dpiY) || 0,
			dpiHr: Number(m.dpiHr) || 0,
		})),
		monitorCount: Number(info.monitorCount) || monitors.length,
		negativeOrigin: info.negativeOrigin === true,
		mixedDpi: info.mixedDpi === true,
		cursor: info.cursor === undefined ? null : info.cursor,
		foreground: info.foreground === undefined ? null : info.foreground,
		error: '',
	}
}

/**
 * 一张图的**像素统计**（均值亮度 + 近黑像素比例）。
 *
 * 为什么不用"文件大小"看是不是黑图：一张全黑的 1920×1080 PNG 只有几 KB，而一张纯色图也
 * 这么大 —— 两者分不开。`blackPct` 是"这次抓屏到底有没有内容"的唯一客观判据。
 *
 * @returns {Promise<{ok:boolean, width:number, height:number, meanLuma:number, blackPct:number, error:string}>}
 */
export async function imageStats(file) {
	const res = await run(
		findPwsh(),
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'imgtool.ps1'), '-Op', 'stats', '-In', file],
		{ timeoutMs: 30_000 }
	)
	const info = lastJsonLine(res.stdout)
	if (info === null) return { ok: false, width: 0, height: 0, meanLuma: 0, blackPct: 100, error: note('stats', res.stderr.trim() || `exit ${res.code}`) }
	return {
		ok: true,
		width: Number(info.width) || 0,
		height: Number(info.height) || 0,
		meanLuma: Number(info.meanLuma) || 0,
		blackPct: Number(info.blackPct) || 0,
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

/**
 * 把滚轮**投给目标区域里那个窗口**（WM_MOUSEWHEEL）—— 不动光标、不抢焦点。
 *
 * 为什么需要：`wheelAt` 靠"把光标挪进区域 + mouse_event"，有两个固有代价：
 *   ① 长截图期间用户的鼠标被抢走；
 *   ② 用户正在用鼠标时，光标会在等待窗口里被拉走 → `moved:false` → auto 暂停。
 * 直接投消息就没有这两个问题。但**窗口认不认是应用相关的**，所以：
 *   - 这个函数只回 `posted`（user32 收下了），**绝不等于"页面滚了"**；
 *   - 上层（scrollsession）必须靠比较抓到的画面来判断，不认就退回光标法。
 *
 * ⚠️ **投给谁**（R29 实测，别再凭印象改）：
 *   R27 把消息投给顶层窗口（`hwnd`）。用一个会自己记账的 WinForms 文本框量了一遍
 *   （`dev/wheel-target-probe.mjs`）：**投给顶层窗体只会触发窗体自己的 MouseWheel，
 *   一个字都不滚；投给点位下面那个控件才滚**。Chromium 两种都认，所以现在由助手/脚本
 *   用 `WindowFromPoint` 解析出叶子窗口再投 —— 那正是真实滚轮会落到的那个窗口。
 *
 *   安全：叶子窗口不属于 `hwnd` 时**拒绝投递**（`reason:'point-moved'`），绝不"顺手"滚
 *   另一个窗口 —— 那会让 auto 会话悄悄截到别人的画面。`rejected` 才是 user32 不收。
 *
 * @returns {Promise<{ok:boolean, posted:boolean, postedTo:number, reason:string, via:string, hwnd:number, error:string}>}
 */
export async function postWheel(hwnd, x, y, delta, times = 1) {
	const h = Math.trunc(Number(hwnd) || 0)
	const px = Math.round(Number(x) || 0)
	const py = Math.round(Number(y) || 0)
	const d = Math.trunc(Number(delta) || 0)
	const n = Math.max(1, Math.min(20, Math.trunc(Number(times) || 1)))
	const empty = { ok: false, posted: false, postedTo: 0, reason: '', via: 'none', hwnd: h, error: 'no hwnd' }
	if (h <= 0) return { ...empty, error: 'postWheel needs a window handle' }

	if (process.env.DSH_SHOT_HELPER !== '0') {
		let shooter = null
		try {
			shooter = await shooterModule()
		} catch {
			shooter = null
		}
		if (shooter !== null) {
			let answer = null
			try {
				answer = await shooter.shootViaHelper({ kind: 'postwheel', hwnd: h, x: px, y: py, delta: d, times: n })
			} catch {
				answer = null
			}
			if (answer !== null) {
				const info = answer.info ?? {}
				return {
					ok: answer.ok === true && info.ok === true,
					posted: info.posted === true,
					// 真正被投递的窗口（叶子）。0 = 被拒绝，什么都没发出去。
					postedTo: Math.trunc(Number(info.target) || 0),
					reason: String(info.reason ?? ''),
					via: 'helper',
					hwnd: h,
					error: info.ok === true ? '' : String(info.error || 'helper refused'),
				}
			}
		}
	}

	// 回落：一次性的 postwheel.ps1（同样不动光标）。
	const res = await run(
		findPwsh(),
		[
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'postwheel.ps1'),
			'-Hwnd', String(h), '-Delta', String(d), '-Times', String(n), '-X', String(px), '-Y', String(py),
		],
		{ timeoutMs: 15_000 }
	)
	const info = lastJsonLine(res.stdout)
	if (info === null) return { ...empty, via: 'spawn', error: note('postwheel', res.stderr.trim() || `exit ${res.code}`) }
	return {
		ok: info.ok === true,
		posted: Number(info.sent) > 0 || info.ok === true,
		postedTo: Math.trunc(Number(info.target) || 0),
		reason: String(info.reason ?? ''),
		via: 'spawn',
		hwnd: h,
		error: info.ok === true ? '' : String(info.error || 'post rejected'),
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

/**
 * 正在启动的那一次录制（R47）。**并发 start 必须串行**，理由：
 *
 * `recordStart` 里"已在录"的判据在**函数最前面**，而真正赋值 `recording` 却要等
 * `ensureDirs()` → 设备枚举（另起一个 ffmpeg，约 0.3–1 s）→ `attempt()` 里 `sleep(600)`。
 * 两次 start 落在这个窗口里时，**两边都能通过判据**，于是各起一个 ffmpeg：
 *   - `recording` 被后赋值者覆盖，先起的那个**再也没人持有它的句柄** —— stop 停不到它，
 *     它会一直 gdigrab 录到进程被杀为止（实测：两个 mp4，一个 2823 B 被 stop，一个 48 B
 *     继续长；磁盘与 CPU 就这么漏下去）；
 *   - 两次回执各报一个 path，调用方也分不清哪段是"那段"。
 *
 * 处理方式**不是把两次合并成一次**（那会把第二个调用方的 fps/region/audio 静默吞掉），
 * 而是让第二个调用**等第一次收尾**，然后走既有的 `already` 分支 —— 回执里带着
 * 实际在录的 region/audio/mic，调用方看得见"你要的和我给你的是不是一回事"。
 */
let starting = null

/**
 * 正在录制时的**落盘状态**（R51）。
 *
 * 为什么需要：`recording` 只在内存里。宿主被结束/重启时 `recordStop` 没有机会跑，
 * ffmpeg 却不会跟着宿主退出 —— 它会一直 gdigrab 写那个 mp4，直到有人杀掉这个进程。
 * 这种孤儿没有句柄、没有界面入口，唯一的痕迹就是 `.cache/rec` 里一颗一直长胖的文件。
 *
 * 于是：起录成功时把 `{pid, file, started, via}` 写到 `REC_DIR/current.json`；
 * 正常 stop 时删掉。**下一次起录前**先跑 `reapOrphanRecorder()`，把上次留下的清掉。
 *
 * 只对 `via:'node'` 落盘：`via:'recspawn'`（沙箱里由 ps/recspawn.ps1 代起）时
 * `child.pid` 是 PowerShell 不是 ffmpeg —— 记了也不能按名字确认，宁可不动。
 */
const REC_STATE = path.join(REC_DIR, 'current.json')

/** 记下"这一段正在录"（失败不影响录制本身）。 */
function writeRecState(info) {
	try {
		fs.mkdirSync(REC_DIR, { recursive: true })
		fs.writeFileSync(REC_STATE, JSON.stringify(info), 'utf8')
	} catch {}
}

/** 删掉落盘状态（录制结束/被清理时）。 */
function clearRecState() {
	try {
		fs.rmSync(REC_STATE, { force: true })
	} catch {}
}

/**
 * 清掉上一次宿主退出时留下的孤儿 ffmpeg（R51）。
 *
 * 判据分三步，任何一步不确定都**不杀**：
 *   ① `current.json` 里的 pid 还活着吗（`tasklist`；拿不到就退 `process.kill(pid,0)`）；
 *   ② 那个 pid 现在**还是 ffmpeg.exe** 吗 —— pid 会被系统复用，杀了别人的进程比留着孤儿更糟；
 *   ③ 才 `taskkill /PID <pid> /T /F`。
 *
 * @returns {Promise<{ok:boolean, reaped:boolean, reason:string, pid:number, file:string, wasAlive:boolean, error:string}>}
 *   reason: none（没有状态）/ bad-state / gone（进程已不在）/ pid-reused / killed / kill-failed
 */
export async function reapOrphanRecorder() {
	const empty = { ok: true, reaped: false, reason: 'none', pid: 0, file: '', wasAlive: false, error: '' }
	let state = null
	try {
		state = JSON.parse(fs.readFileSync(REC_STATE, 'utf8'))
	} catch {
		return empty
	}
	const pid = Number(state?.pid) || 0
	const file = typeof state?.file === 'string' ? state.file : ''
	if (pid <= 0) {
		clearRecState()
		return { ...empty, reason: 'bad-state', file }
	}
	let alive = false
	let name = ''
	const tl = await run('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 })
	if (tl.code === 0) {
		const line = (tl.stdout.trim().split(/\r?\n/).find((l) => l.indexOf(String(pid)) !== -1) ?? '').trim()
		if (line !== '') {
			alive = true
			name = (line.split(',')[0] ?? '').replace(/^"+|"+$/g, '')
		}
	} else {
		try {
			process.kill(pid, 0)
			alive = true
		} catch {}
	}
	if (!alive) {
		clearRecState()
		return { ...empty, pid, file, reason: 'gone' }
	}
	if (name !== '' && !/^ffmpeg\.exe$/i.test(name)) {
		clearRecState()
		return { ...empty, pid, file, reason: 'pid-reused', wasAlive: true }
	}
	const kill = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 })
	clearRecState()
	return {
		ok: kill.code === 0,
		reaped: kill.code === 0,
		reason: kill.code === 0 ? 'killed' : 'kill-failed',
		pid,
		file,
		wasAlive: true,
		error: kill.code === 0 ? '' : kill.stderr.trim() || `taskkill exit ${kill.code}`,
	}
}

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

/* ─────────────────── 录屏框（R32）─────────────────── */

/**
 * 区域录屏时，在屏幕上画一圈红框标出"正在录的就是这块"。
 *
 * 为什么要它：框选那一层覆盖层一关，屏幕上**没有任何东西**说明边界在哪。用户切到
 * 被录的那个窗口之后，唯一的提示在 DSH 窗口里 —— 而那正好在他背后。所有录屏软件
 * 都画这圈框，原因就是这个。
 *
 * 三条设计约束（都由实测决定，见 ps/recframe.ps1 与 dev/recframe-probe.mjs）：
 *  1. 框必须画在**捕获矩形之外**（窗口放在 x-t,y-t，尺寸 w+2t,h+2t），否则它会被录进视频。
 *  2. 内部必须**根本不存在**（用窗口 region 裁成四根条，不是靠透明色键）——
 *     第一版用 TransparencyKey，窗口 Visible=true、关闭也正常，屏幕上却什么都没有。
 *  3. **失败不影响录屏**：起不来就只是没有框，绝不因此让录制失败。
 */
let recFrame = null

/**
 * @param {{x:number,y:number,w:number,h:number}} area 归一化后的捕获区域
 * @returns {boolean} 真的起了框没有（失败只用于回报，不影响录制）
 */
function startRecFrame(area) {
	stopRecFrame()
	try {
		const stopFile = path.join(CACHE_DIR, `rec-frame-${process.pid}-${Date.now()}.flag`)
		const child = spawn(
			findPwsh(),
			[
				'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'recframe.ps1'),
				'-X', String(area.x), '-Y', String(area.y), '-W', String(area.w), '-H', String(area.h),
				'-Thickness', '3', '-StopFile', stopFile, '-MaxMinutes', '240',
			],
			// windowsHide 只关掉**控制台**窗口，WinForms 的框照常显示（overlay_host 同一个用法）。
			{ windowsHide: true, stdio: 'ignore' }
		)
		// 'error' 没有监听器会让整个宿主进程崩掉 —— 一个装饰性窗口没有这个资格。
		child.on('error', () => {})
		child.unref()
		recFrame = { child, stopFile }
		return true
	} catch {
		recFrame = null
		return false
	}
}

/** 收掉录屏框：先落停止信号文件，再杀进程（两条路都留着，任一条生效即可）。 */
function stopRecFrame() {
	if (recFrame === null) return
	const { child, stopFile } = recFrame
	recFrame = null
	try {
		fs.writeFileSync(stopFile, 'stop')
	} catch {}
	try {
		child.kill()
	} catch {}
	try {
		fs.rmSync(stopFile, { force: true })
	} catch {}
}

/**
 * 把用户框出来的矩形**归一化**成 gdigrab 能接受的区域。
 *
 * 为什么必须有这一步（2026-10-20 R32 实测）：录屏编码是 `libx264 + yuv420p`，
 * 宽或高是**奇数**时 ffmpeg 在 0.6 秒内就死，**留下 0 字节文件**，报的是
 * `width not divisible by 2 (801x601)`。而人手拖框**极容易**拖出奇数尺寸 ——
 * 于是「区域录屏」看起来像"一按就失败"，其实只差一次向下取偶。
 *
 * 取偶取**向下**（不是四舍五入）：宁可少录一行像素，也不要在右边/下边补一条
 * 用户没框到的内容。
 *
 * @param {string} region "x,y,w,h"
 * @returns {{x:number,y:number,w:number,h:number,text:string,adjusted:boolean}|null} 无效/太小 → null
 */
export function normalizeRecordRegion(region) {
	const parts = String(region ?? '').split(',').map((n) => Number(n.trim()))
	if (parts.length !== 4 || !parts.every(Number.isFinite)) return null
	const x = Math.round(parts[0])
	const y = Math.round(parts[1])
	const w0 = Math.round(parts[2])
	const h0 = Math.round(parts[3])
	const w = w0 - (((w0 % 2) + 2) % 2)
	const h = h0 - (((h0 % 2) + 2) % 2)
	if (w < 2 || h < 2) return null
	return { x, y, w, h, text: `${x},${y},${w},${h}`, adjusted: w !== w0 || h !== h0 }
}

/**
 * 开始录屏（ffmpeg gdigrab，H.264 + 可选麦克风）。
 *
 * 并发调用会**排队**（见 `starting`）：第二个调用等第一次落定后，拿到的是
 * `already:true` + 实际在录的参数，绝不会再起第二个 ffmpeg。
 *
 * @param {{fps?: number, region?: string, audio?: boolean, mic?: string}} opts region = "x,y,w,h"（空=整屏）
 */
export async function recordStart(opts = {}) {
	while (starting !== null) {
		// 前一次 start 失败也要放行，失败本身由它自己的调用方去处理
		await starting.catch(() => {})
	}
	const run = startOnce(opts)
	starting = run.finally(() => {
		starting = null
	})
	return await run
}

/**
 * 真正起录（**已串行化**，只由 `recordStart` 调用）。
 * @param {{fps?: number, region?: string, audio?: boolean, mic?: string}} opts
 */
async function startOnce(opts = {}) {
	if (recording !== null) {
		return {
			ok: true,
			recording: true,
			path: recording.file,
			already: true,
			region: recording.region ?? '',
			width: recording.width ?? 0,
			height: recording.height ?? 0,
			audio: recording.audio === true,
			mic: recording.mic ?? '',
			audioWarning: '',
		}
	}
	await ensureDirs()
	// R51：起新的一段之前，先把上一次宿主退出时留下的孤儿 ffmpeg 清掉（否则两路同时写盘）。
	const reaped = await reapOrphanRecorder()
	const reapedPrev = reaped.reaped === true
	// 落 CACHE_DIR/rec（临时），不落用户图片目录 —— 理由见 REC_DIR 的注释。
	await mkdir(REC_DIR, { recursive: true })
	const file = path.join(REC_DIR, `rec-${stampName()}.mp4`)
	const fps = Number.isFinite(opts.fps) ? Math.max(5, Math.min(30, opts.fps)) : 15
	const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps)]
	// 区域录屏：宽高必须取偶（理由见 normalizeRecordRegion）。
	// 归一化后的矩形**回给调用方** —— 客户端要显示的是"真在录的那一块"，
	// 不是用户拖出来那个（801 → 800 这一像素的差，只有回执能说清）。
	const area = opts.region ? normalizeRecordRegion(opts.region) : null
	// 第二道门（R43）：非字符串的 region 在上游 service 已被拒，这里再拦一次 ——
	// 否则 `String({x,y,w,h})` 会变成 "[object Object]"，报出一句误导的"区域太小"。
	if (opts.region !== undefined && opts.region !== null && typeof opts.region !== 'string') {
		return { ok: false, recording: false, path: '', error: 'region 只接受 "x,y,w,h" 字符串（收到 ' + (Array.isArray(opts.region) ? '数组' : typeof opts.region) + '）', region: '', width: 0, height: 0 }
	}
	// 框了却算不出有效区域（比如拖得只剩 1 像素）：**必须报错，不能悄悄录整屏** ——
	// 那会把用户根本没打算公开的桌面录进去。客户端也会把这条错误原文念给用户。
	if (area === null && String(opts.region ?? '').trim().length > 0) {
		return { ok: false, recording: false, path: '', error: `框选的区域太小，没法录（${String(opts.region)}）`, region: '', width: 0, height: 0 }
	}
	if (area !== null) {
		args.push('-offset_x', String(area.x), '-offset_y', String(area.y), '-video_size', `${area.w}x${area.h}`)
	}
	args.push('-i', 'desktop')

	const ffmpeg = findFfmpeg()
	const meta = { region: area === null ? '' : area.text, width: area === null ? 0 : area.w, height: area === null ? 0 : area.h }
	/**
	 * 录屏要不要声音 —— R41。
	 *
	 * 以前这里写死 `audio=virtual-audio-capturer`，那是一块**本机根本没装**的虚拟声卡：
	 * 带 audio 的请求必然起不来，而客户端又从来没传过 `audio: true`。两头一起看着"实现了"，
	 * 实际是一段永远不会被执行的死代码。现在改成**枚举真实 dshow 设备**，并且：
	 *   ① 显式传了 `mic` 就按名字/别名精确匹配；
	 *   ② 没找到（没麦、名字变了）**不算失败**，退静音并带 warning 回给界面；
	 *   ③ 起了麦却打不开（被别的程序独占/驱动抽风）再**退一次静音重试**并说明。
	 * 三条同一个目的：录音是可选项，它坏了不能让"录屏"本身坏掉 —— 但每一次降级都要说话。
	 */
	let mic = null
	let audioWarning = ''
	if (opts.audio === true) {
		const devs = await listCaptureDevices()
		const picked = resolveAudioDevice(devs.devices, opts.mic)
		mic = picked.device
		audioWarning = picked.warning
	}
	/** 按"这一路收不收麦"拼完整参数；带麦时**显式 -map**，不靠 ffmpeg 的默认流选择。 */
	const buildArgs = (micDev) => {
		const out = args.slice()
		if (micDev !== null) {
			// thread_queue_size：默认队列很小，机器一忙 dshow 就报 buffer overrun 并丢包。
			out.push('-thread_queue_size', '512', '-f', 'dshow', '-i', `audio=${micDev.name}`)
			out.push('-map', '0:v:0', '-map', '1:a:0')
		}
		out.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')
		if (micDev !== null) out.push('-c:a', 'aac', '-b:a', '128k')
		out.push('-movflags', '+faststart', '-y', file)
		return out
	}
	/** 起一次录制，600ms 后看它有没有立刻死；返回 `{error}` 或 `{started}`。 */
	const attempt = async (micDev) => {
		let started
		try {
			started = await spawnRecorder(ffmpeg, buildArgs(micDev))
		} catch (error) {
			return { error: note('record', error?.message ?? error), started: null }
		}
		// ffmpeg 立刻死掉的话（比如根本没装）在这里就能看出来
		await sleep(600)
		if (started.child.exitCode !== null && started.child.exitCode !== 0) {
			return { error: started.stderr().trim() || `ffmpeg exit ${started.child.exitCode}`, started }
		}
		return { error: '', started }
	}
	let att = await attempt(mic)
	// 只有"起了麦却打不开"才降级重试。视频侧的错（区域越界、gdigrab 起不来）不该拿静音去掩盖。
	if (att.error !== '' && mic !== null && /dshow|audio|device|already in use|error opening/i.test(att.error)) {
		const line = (att.error.trim().split(/\r?\n/).pop() ?? '').slice(0, 140)
		audioWarning = `录音设备「${mic.name}」打不开（${line}），这次静音录制`
		mic = null
		att = await attempt(null)
	}
	if (att.error !== '') {
		try {
			att.started?.child.kill()
		} catch {}
		recording = null
		stopRecFrame()
		// 区域越界的报错原文是 "Capture area outside of screen size" —— 用户看不懂，
		// 而且他刚框完，唯一的解释就是"框到屏幕外面去了"。
		const raw = att.error.trim()
		const error = /outside of screen/i.test(raw) ? `框选的区域超出了屏幕范围（${meta.region}）` : note('record', raw)
		return { ok: false, recording: false, path: '', error, ...meta }
	}
	const started = att.started
	const audio = mic !== null
	recording = {
		child: started.child,
		file,
		started: Date.now(),
		stderr: started.stderr,
		quit: started.quit,
		via: started.via,
		...meta,
		audio,
		mic: audio ? mic.name : '',
	}
	// 真的开始录了才画框：录屏当场失败时不闪一下红框。
	const frame = area !== null ? startRecFrame(area) : false
	// R51：把"这一段在录"落盘（只对 node 直起有效；recspawn 的 pid 是 PowerShell，记了也没法按名字确认）。
	if (started.via === 'node' && Number(started.child?.pid) > 0) {
		writeRecState({ pid: Number(started.child.pid), file, started: recording.started, via: started.via })
	}
	return { ok: true, recording: true, path: file, fps, via: started.via, frame, audio, mic: audio ? mic.name : '', audioWarning, reapedPrev, ...meta }
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
		// R51：宿主重启后用户点"停止"时内存里没有这一段，但磁盘上可能还留着上一条孤儿 ffmpeg ——
		// 顺手清掉（判据与起录前同一套：pid 活着、且还是 ffmpeg 才杀）。
		await reapOrphanRecorder()
		return { ok: true, recording: false, path: '', seconds: 0, bytes: 0, width: 0, height: 0, duration: 0, temp: true, audio: false, mic: '', hasAudio: false, audioDropped: false, error: '' }
	}
	const { file, started } = recording
	const rec = recording
	const wallSeconds = Math.round((Date.now() - started) / 100) / 10
	// 停法只有一种：让 ffmpeg 自己收到 q 走正常退出（硬杀 = moov 丢失 = 整段报废）。
	// 谁去写那个 q 由 startFfmpeg* 决定 —— 正常路径是 node 直接写 stdin 管道，
	// 受限环境由 recspawn.ps1 代写。两条路都在这里收敛成一句 quit()。
	await recording.quit()
	recording = null
	// R51：这一段已经收尾，落盘状态不再需要（异常/残留会由下一次 start 的 reap 兜住）。
	clearRecState()
	// 录屏框必须跟着消失：它盖在用户桌面上，留一个孤零零的红框比不画还糟。
	stopRecFrame()
	/** ffmpeg 自己的 stderr 尾巴 —— 出问题时不带上它，用户只能看到"0 KB"（R33 现场）。 */
	const ffTail = () => {
		try {
			return String(rec.stderr?.() ?? '').trim().slice(-300)
		} catch {
			return ''
		}
	}
	if (!existsSync(file)) {
		const error = note('record', 'ffmpeg produced no file' + (ffTail() ? '：' + ffTail() : ''))
		return { ok: false, recording: false, path: file, seconds: wallSeconds, bytes: 0, width: 0, height: 0, duration: 0, temp: true, audio: rec.audio === true, mic: rec.mic ?? '', hasAudio: false, audioDropped: false, error }
	}
	const s = await stat(file)
	const info = await recAction('info', { file }, 40_000)
	const duration = Number(info.duration) || 0
	/**
	 * R33（用户现场）：录了 7 秒、文件 **0 字节**、`ffprobe` 报 `moov atom not found` ——
	 * 界面却照常打开了结果面板，第一件事就是抽帧、失败，用户看到的是"录屏坏了、画面渲染不出来"。
	 * 文件里一个字节都没有的时候，**不该假装录成功**：直接带着 ffmpeg 的 stderr 尾巴报错，
	 * 那句 stderr 才是下次能定位的线索。
	 */
	if (s.size === 0 || duration === 0) {
		const tail = ffTail()
		const error = note('record', '录屏里没有任何画面数据（' + s.size + ' 字节、时长 0）' + (tail ? '：' + tail : ''))
		return { ok: false, recording: false, path: file, seconds: wallSeconds, bytes: s.size, width: 0, height: 0, duration: 0, temp: true, audio: rec.audio === true, mic: rec.mic ?? '', hasAudio: false, audioDropped: false, error }
	}
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
		/**
		 * 音轨三件套（R41）—— 为什么不是"只要 audio:true 就够了"：
		 *   audio        这次**要**声音吗（用户的选择）
		 *   hasAudio     文件里**真**有音轨吗（ffprobe 说了算：mediainfo 的 audio 字段）
		 *   audioDropped audio 为真、hasAudio 为假 = 说好要录音却没录上，界面必须提示
		 * 只回 audio 的话，"想录声、设备中途掉了"会被当成成功，用户要到事后听不见人声才发现。
		 */
		audio: rec.audio === true,
		mic: rec.mic ?? '',
		hasAudio: info.audio === true,
		audioDropped: rec.audio === true && info.audio !== true,
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

/*
 * 老的一次性长截图（`scrollCapture`）已**删除**（R26，backlog ③）。
 *
 * 它做过什么：抓全屏 → 裁区域 → spawn wheel.ps1 滚一屏 → 再抓 → … → stitch.py 拼接。
 * 三个致命问题，每一条现在都已经被活路径解决：
 *   ① 每帧 spawn 三个进程（capture + imgtool + wheel），一拍 ~2s，而且滚轮会把鼠标抢走
 *      —— auto 模式改成常驻助手之后一次滚轮是 ~110ms（R25）；
 *   ② 没有任何遮挡守卫：用户点回 DSH 的那一刻，把 DSH 的画面拼进长图；
 *   ③ 全程**没有一个测试**碰过它 —— 而 `service.scroll()` 在没有 `session` 参数时
 *      仍然会走到它，于是它「看起来能用」。
 *
 * 活路径是 `lib/scrollsession.mjs`（manual/auto，会话式，有守卫、有总高上限、有测试），
 * 对外只有一个入口：`service.scroll(rect, '{"session":"begin"}')`。没有 `session` 的
 * 调用现在会拿到一句明确的错误（见 lib/service.mjs），而不是默默跑那条两年前的实现。
 */

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
