/**
 * lib/shooter.mjs — 常驻抓屏助手的 Node 半边。
 *
 * 为什么要有它：一次一次性抓屏实测 ~1.9 秒（本机 1920x1080），其中真正的活只有 ~150ms ——
 * 其余全是"每次重来一遍"的固定开销：起进程 ~500ms、`Add-Type -AssemblyName System.Drawing`
 * ~260ms、编译那段 C# 互操作 ~390ms、解析绑定 capture.ps1 ~250ms。
 * 助手把这笔开销付一次，之后每次抓屏只要 ~200-300ms —— 覆盖层"点了几秒才出来"就是这么没的。
 *
 * ⚠️ **通道只有文件系统**，没有管道也没有 stdin：
 *    node spawn 一开管道在这个环境里直接 EPERM（沙箱禁 CreatePipe），
 *    而全 'ignore' 会让 powershell.exe 以 0xC0000142 退出。请求/响应走文件是 ps/hotkey.ps1
 *    已经在用的成熟模式（事件文件 + 轮询），这里只是把它做成一次问答。
 *
 * ⚠️ 这个进程**必须有明确的生命周期**：助手脱离宿主还活着就是一个常驻的 PowerShell + .NET
 *    进程（~80MB），而且会在下一次 DSH 启动时抢答请求。所以：
 *      ① tag 每次启动都不同 ⇒ 上一代的 req/res/ready 文件名跟这一代不同，**结构上不可能串台**；
 *      ② 助手自己每 ~2 秒看一眼 -ParentPid，宿主被强杀时它自己退；
 *      ③ 插件 dispose 时 stopShooter()：先落 stop-flag 让它体面退出，~800ms 没走就 kill。
 *
 * ⚠️ 助手永远只是**加速**：没就绪 / 超时 / 中途死了 ⇒ 返回 null，调用方静默回落到
 *    "每次新起一个 pwsh"的老路径。功能不会因为助手而变差，只是慢回去。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CACHE_DIR, PS_DIR, findPwsh } from './shot.mjs'

/** 助手的工作目录（请求/响应/就绪/停止标志都在这）。 */
export const SHOOTER_DIR = path.join(CACHE_DIR, 'shooter')
/** ps/shooter.ps1 的绝对路径。 */
export const SHOOTER_SCRIPT = path.join(PS_DIR, 'shooter.ps1')

/** 一次助手请求最多等多久（毫秒）。`DSH_SHOT_HELPER_MS` 可覆盖（自检用它逼出回落路径）。 */
function helperTimeoutMs() {
	const raw = Number(process.env.DSH_SHOT_HELPER_MS)
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 6000
}

/** 总开关：`DSH_SHOT_HELPER=0` 时永远走老路径（前后对比实测就是靠它）。 */
export function shooterEnabled() {
	return process.env.DSH_SHOT_HELPER !== '0'
}

/** 轮询响应的间隔。一次响应最坏多等这么久，相对 200ms 的抓屏可以忽略。 */
const POLL_MS = 6
/** 启动失败后多久才允许再试（防止"每次抓屏都尝试起一个新助手"）。 */
const RESPAWN_COOLDOWN_MS = 5000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const state = {
	child: null,
	tag: '',
	spawnAt: 0,
	readyAt: 0,
	readySeen: false,
	lastSpawnTry: 0,
	exited: null,
	stopping: false,
	error: '',
	seq: 0,
	served: 0,
	misses: 0,
	lastMs: 0,
	chain: Promise.resolve(),
	/**
	 * 第几代。**每一次 spawn 就是新一代**，而每一代的 exit 处理器只许动自己那一代的账。
	 *
	 * ⚠️ 这不是洁癖，是实测踩出来的：`stopShooter()` 之后 `process.kill(pid,0)` 报"进程没了"
	 *    并不等于 node 已经派发过 'exit' 事件。旧那一代的处理器晚到一步，就会把**新**那一代
	 *    的 state.child 清成 null —— 于是助手活着、ready 文件也写好了，node 却永远认为它不在
	 *    （hosttest 里表现为"冷启动后等 30 秒也没就绪"，同时那个助手变成没人管的孤儿进程）。
	 */
	gen: 0,
}

/** 某一代的那几个文件（tag 是闭包变量，不是 state.tag —— 否则会误删新那代的文件）。 */
function filesOf(tag) {
	return {
		req: path.join(SHOOTER_DIR, `req-${tag}.json`),
		res: path.join(SHOOTER_DIR, `res-${tag}.json`),
		ready: path.join(SHOOTER_DIR, `ready-${tag}.json`),
		stop: path.join(SHOOTER_DIR, `stop-${tag}.flag`),
	}
}

const reqPath = () => filesOf(state.tag).req
const resPath = () => filesOf(state.tag).res
const readyPath = () => filesOf(state.tag).ready
const stopPath = () => filesOf(state.tag).stop

function alive() {
	return state.child !== null && state.child.exitCode === null
}

/**
 * 就绪是**惰性**判断：没有定时器，没有额外 CPU —— 每次要用助手时看一眼握手文件在不在。
 * 助手写完 ready 文件才进主循环，所以"看得见 ready" ⇔ "它能干活"。
 */
function ready() {
	if (state.readySeen) return true
	if (!alive()) return false
	try {
		if (fs.existsSync(readyPath())) {
			state.readySeen = true
			state.readyAt = Date.now()
			return true
		}
	} catch {}
	return false
}

/** 原子写：先写临时文件再改名，读的人绝不会看见半个 JSON。 */
function writeJson(file, value) {
	const tmp = file + '.tmp'
	fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
	try {
		fs.rmSync(file, { force: true })
	} catch {}
	fs.renameSync(tmp, file)
}

/**
 * 清掉上一代留下的垃圾（会话崩溃时 request/response 会残留）。
 * ⚠️ 只碰 2 小时以前的文件：两个 DSH 实例同时开着时，别去动另一个活着的助手。
 */
function sweepOld(now = Date.now()) {
	let names = []
	try {
		names = fs.readdirSync(SHOOTER_DIR)
	} catch {
		return
	}
	for (const name of names) {
		if (!/^(req|res|ready|stop|warmup)-/.test(name) && !name.endsWith('.tmp')) continue
		const file = path.join(SHOOTER_DIR, name)
		try {
			if (now - fs.statSync(file).mtimeMs > 2 * 3600 * 1000) fs.rmSync(file, { force: true })
		} catch {}
	}
}

/**
 * 起助手。**同步返回、不等就绪** —— 插件初始化时调用它绝不能拖慢 DSH 启动，
 * 而用户第一次点 📷 通常在这之后好几秒。
 * 幂等：已经在跑就返回同一个句柄。
 */
export function startShooter() {
	if (alive()) {
		return { ok: true, already: true, pid: state.child.pid, tag: state.tag, ready: ready(), dir: SHOOTER_DIR }
	}
	if (!fs.existsSync(SHOOTER_SCRIPT)) {
		state.error = 'ps/shooter.ps1 not found'
		return { ok: false, already: false, pid: 0, tag: '', ready: false, error: state.error, dir: SHOOTER_DIR }
	}
	state.lastSpawnTry = Date.now()
	try {
		fs.mkdirSync(SHOOTER_DIR, { recursive: true })
	} catch (error) {
		state.error = String(error?.message ?? error)
		return { ok: false, already: false, pid: 0, tag: '', ready: false, error: state.error, dir: SHOOTER_DIR }
	}
	sweepOld()

	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	state.tag = tag
	const gen = state.gen + 1
	state.gen = gen
	state.readySeen = false
	state.readyAt = 0
	state.exited = null
	state.stopping = false
	state.error = ''

	const errFile = path.join(SHOOTER_DIR, `stderr-${tag}.log`)
	let child
	try {
		// stderr 走**真文件句柄**，理由同 lib/hotkey.mjs：管道在这个环境里建不出来
		// （沙箱禁 CreatePipe），而且这个进程活得比一次调用长，管道缓冲满了会把写日志的
		// 那一侧卡死。文件既没有这两个问题，又留下"它为什么退出"的线索。
		const errFd = fs.openSync(errFile, 'a')
		try {
			child = spawn(
				findPwsh(),
				[
					'-NoProfile',
					'-ExecutionPolicy',
					'Bypass',
					'-File',
					SHOOTER_SCRIPT,
					'-Dir',
					SHOOTER_DIR,
					'-Tag',
					tag,
					// ★ 宿主自己的 pid。DSH 被强杀（任务管理器结束进程 / 崩溃）时 dispose 不会跑，
					//   child.kill() 也就不会发生 —— 助手会自己每 ~2 秒看一眼这个 pid，不在就退。
					//   0 = 不看守（自检可以显式传 0 来测"它自己该活多久就活多久"）。
					'-ParentPid',
					String(process.pid),
					// 4 小时硬上限（不是 12 小时）：父进程判活已经是"pid + 启动时刻"双条件，
					// 这一层只是最后兜底 —— 真被绕过的代价是一个常驻 PowerShell 进程。
					'-MaxMinutes',
					'240',
				],
				{ cwd: path.dirname(PS_DIR), windowsHide: true, stdio: ['ignore', 'ignore', errFd] }
			)
		} finally {
			// 子进程拿到的是 fd 的副本，父进程这一份要关掉，否则文件句柄一直挂着。
			try {
				fs.closeSync(errFd)
			} catch {}
		}
	} catch (error) {
		state.error = String(error?.message ?? error)
		return { ok: false, already: false, pid: 0, tag, ready: false, error: state.error, dir: SHOOTER_DIR }
	}

	state.child = child
	state.spawnAt = Date.now()
	// ⚠️ 必须挂 'error'：子进程起不来（pwsh 被移走 / 被策略拦住）时 node 会发这个事件，
	//    没有监听器就是一个 uncaughtException —— 在宿主进程里那会连累整棵插件树。
	child.on('error', (error) => {
		if (gen !== state.gen) return
		state.child = null
		state.readySeen = false
		state.error = `spawn failed: ${error?.message ?? error}`
	})
	child.on('exit', (code) => {
		// 上一代晚到的退出通知：它已经不配再动任何共享状态（见 state.gen 上面那段）。
		if (gen !== state.gen) return
		state.child = null
		state.readySeen = false
		// 我们自己收掉的不算"意外退出"：不区分的话，"助手突然没了"（真崩了）和
		// "插件刚被卸载"（正常）在诊断里长得一模一样。
		if (state.stopping) {
			state.stopping = false
			state.exited = null
			return
		}
		let tail = ''
		try {
			tail = fs.readFileSync(errFile, 'utf8').slice(-600)
		} catch {}
		state.exited = { code, at: new Date().toISOString(), stderr: tail }
		// 这一代**确实干活干成过**（就绪过）才给它免掉重生冷却：一个证明过自己能用的助手猝死，
		// 下一次抓屏就该立刻拉一个新的。反过来，一个从来没就绪过的助手（脚本坏了 / 环境不对）
		// 必须继续吃冷却，否则每次抓屏都会 spawn 一个注定要死的进程。
		if (state.readyAt > state.spawnAt && state.spawnAt > 0) state.lastSpawnTry = 0
	})
	return { ok: true, already: false, pid: child.pid, tag, ready: false, dir: SHOOTER_DIR }
}

/** 收掉助手：先落 stop 标志让它体面退出（它会自己删掉 ready 文件），到点还没走就 kill。 */
export function stopShooter() {
	const child = state.child
	const tag = state.tag
	const files = filesOf(tag)
	state.child = null
	state.readySeen = false
	if (child === null || child.exitCode !== null) return true
	try {
		fs.writeFileSync(files.stop, 'q', 'utf8')
	} catch {}
	state.stopping = true
	const timer = setTimeout(() => {
		try {
			child.kill()
		} catch {
			state.stopping = false
		}
	}, 800)
	if (timer.unref) timer.unref()
	// ⚠️ 清理只认**捕获到的 tag**，绝不能走 reqPath() 之类读 state.tag 的函数：
	//    这条回调可能在"新一代助手已经起来"之后才跑，那时候 state.tag 已经是新的了，
	//    删下去就把新助手的 ready/req 文件一起删掉（新助手于是永远不被承认）。
	child.once('exit', () => {
		clearTimeout(timer)
		for (const file of [files.req, files.res, files.ready, files.stop]) {
			try {
				fs.rmSync(file, { force: true })
			} catch {}
		}
	})
	return true
}

export function shooterStatus() {
	return {
		enabled: shooterEnabled(),
		alive: alive(),
		ready: ready(),
		pid: alive() ? state.child.pid : 0,
		tag: state.tag,
		dir: SHOOTER_DIR,
		served: state.served,
		misses: state.misses,
		lastMs: state.lastMs,
		error: state.error,
		exited: state.exited === null ? null : state.exited,
		spawnMs: state.spawnAt === 0 ? 0 : Date.now() - state.spawnAt,
		readyMs: state.readyAt === 0 || state.spawnAt === 0 ? 0 : state.readyAt - state.spawnAt,
	}
}

/**
 * 一次助手问答。**只做一次，不重试**（重试属于上层：下一次抓屏自然会再用它）。
 * @returns {Promise<object|null>} 助手**权威答案**（ok 真或假）；null = 这次别用它，去走老路径。
 */
async function requestOnce(req) {
	const seq = state.seq + 1
	state.seq = seq
	const started = Date.now()
	const out = resPath()
	const req0 = reqPath()

	try {
		fs.rmSync(out, { force: true })
	} catch {}
	try {
		// 请求里的 out 是**这一次调用自己的** PNG 路径：助手超时被回落之后，它即便后来写完了
		// 也只会留下一张孤儿图（pruneShots 会收掉），不会覆盖回落路径真正要用的那张。
		writeJson(req0, { seq, op: 'cap', ...req })
	} catch (error) {
		state.error = String(error?.message ?? error)
		return null
	}

	const deadline = started + helperTimeoutMs()
	while (Date.now() < deadline) {
		await sleep(POLL_MS)
		if (!fs.existsSync(out)) continue
		let info = null
		try {
			info = JSON.parse(fs.readFileSync(out, 'utf8'))
		} catch {
			// 半写状态（助手正在 rename）：下一轮再读。
			continue
		}
		try {
			fs.rmSync(out, { force: true })
		} catch {}
		// 上一轮超时后助手才写完的响应会带着旧 seq：丢掉，继续等自己那一份。
		if (Number(info?.seq) !== seq) continue
		state.lastMs = Date.now() - started
		return info
	}

	// 超时：把请求文件收掉，别让它在下一次请求之前被消费掉（那会串一次答案）。
	try {
		fs.rmSync(req0, { force: true })
	} catch {}
	try {
		fs.rmSync(req.out, { force: true })
	} catch {}
	state.error = `helper timed out after ${helperTimeoutMs()}ms`
	return null
}

/**
 * 经助手抓一张屏。
 *
 * @param {{mode?: string, out?: string, hideSelf?: boolean, method?: string, hwnd?: number,
 *   rect?: string, noRestore?: boolean, target?: string}} req
 * @returns {Promise<{ok: boolean, info: object}|null>} null = 助手这次用不上（回落）。
 */
export async function shootViaHelper(req) {
	if (!shooterEnabled()) return null
	if (!alive() || !ready()) {
		// 助手不在/还没热：顺手拉起一个（有冷却，免得每次抓屏都 spawn 一个进程），
		// 但**这次不等它** —— 直接回落走老路径，下一次抓屏自然命中。
		state.misses += 1
		if (!alive() && Date.now() - state.lastSpawnTry > RESPAWN_COOLDOWN_MS) {
			state.error = ''
			startShooter()
		}
		return null
	}
	// 串行化：助手是单线程的，两个请求同时塞进去只会让第二个等第一个。
	const run = state.chain.then(() => (alive() && ready() ? requestOnce(req) : null))
	state.chain = run.catch(() => null)
	const info = await run
	if (info === null) return null
	if (info.ok === true) state.served += 1
	return { ok: info.ok === true, info }
}
