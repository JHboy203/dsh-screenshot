/**
 * lib/hotkey.mjs — 全局热键守护进程的 Node 半边。
 *
 * 为什么是"另起一个 PowerShell 常驻进程"而不是 Electron 的 globalShortcut：
 *   见 ps/hotkey.ps1 顶部。一句话：RegisterHotKey 是纯 Win32，任何进程、任何完整性级别都能用，
 *   不依赖插件宿主能不能 `import('electron')`；而且它能在"看见按键的那一瞬间"把 DSH 窗口提到前台
 *   —— 那是 Win10+ 前台激活规则唯一放行的时刻。
 *
 * 这个进程**必须有明确的生命周期**：热键守护一旦脱离宿主还活着，就会一直吞用户的按键，
 * 比没有热键更糟。所以 stop() 一定 kill，插件卸载/进程退出都接上。
 *
 * ⚠️ 事件文件是唯一通道，不用 stdout：守护进程的 stdout 是没人抽的管道，缓冲满了会把它自己卡死。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CACHE_DIR, PS_DIR, findPowershell } from './shot.mjs'

/** 事件文件：守护进程 append，这里按字节偏移增量读。 */
export const EVENTS_PATH = path.join(CACHE_DIR, 'hotkeys.jsonl')
/** 守护进程的 stderr 落点（不用管道，见 startHotkeys 里的说明）。 */
export const STDERR_PATH = path.join(CACHE_DIR, 'hotkey-stderr.log')

/**
 * 默认候选键位。**顺序即优先级**，`|` 后面是备选。
 *
 * ⚠️ 这份表不是拍脑袋定的，是 2026-10-16 在本机实测出来的：`RegisterHotKey` 对已经被别的
 *    程序占用的组合返回 win32 **1409**，而这台机器上 QQ（Ctrl+Alt+A）、微信、以及若干常驻工具
 *    已经吃掉了 ctrl+alt+{a,o,f,l,t,r,x,z,q}。截图工具最该抢的那个 Ctrl+Alt+A 恰恰是 QQ 的。
 *    ⇒ 每个动作都要给备选，并且**把最终抢到的键回报给界面**（否则用户按了没反应，看起来就是坏的）。
 * 另外刻意避开一切 Ctrl+Shift+*：中文输入法的中英切换就是 Ctrl+Shift，全局注册会把它废掉。
 */
export const DEFAULT_KEYS = {
	shot: ['ctrl+alt+s', 'ctrl+alt+b', 'alt+shift+s'],
	ocr: ['ctrl+alt+c', 'ctrl+alt+k'],
	translate: ['ctrl+alt+d', 'ctrl+alt+e'],
	scroll: ['ctrl+alt+m', 'ctrl+alt+8'],
	record: ['ctrl+alt+v', 'ctrl+alt+9'],
}

/** 人类可读的键位标签（菜单里显示这个）。 */
export function prettyKey(chord) {
	if (typeof chord !== 'string' || chord.length === 0) return ''
	return chord
		.split('+')
		.map((t) => {
			const s = t.trim().toLowerCase()
			if (s === 'ctrl' || s === 'control') return 'Ctrl'
			if (s === 'alt') return 'Alt'
			if (s === 'shift') return 'Shift'
			if (s === 'win' || s === 'meta') return 'Win'
			if (s.length === 1) return s.toUpperCase()
			return s.charAt(0).toUpperCase() + s.slice(1)
		})
		.join('+')
}

/** DEFAULT_KEYS -> ps 的 `-Keys` 参数：`shot=ctrl+alt+s|ctrl+alt+b|alt+shift+s,ocr=...` */
export function buildKeySpec(keys = DEFAULT_KEYS) {
	const parts = []
	for (const [action, list] of Object.entries(keys)) {
		const chords = (Array.isArray(list) ? list : [list]).filter((c) => typeof c === 'string' && c.length > 0)
		if (chords.length > 0) parts.push(action + '=' + chords.join('|'))
	}
	return parts.join(',')
}

export function readEvents() {
	try {
		if (!fs.existsSync(EVENTS_PATH)) return []
		const text = fs.readFileSync(EVENTS_PATH, 'utf8')
		const out = []
		for (const line of text.split('\n')) {
			const t = line.trim()
			if (t.length === 0) continue
			try {
				out.push(JSON.parse(t))
			} catch {
				/* 半行（正在写）——跳过，下一轮会读到完整的 */
			}
		}
		return out
	} catch {
		return []
	}
}

/**
 * 跑一次 `-ProbeOnly`：注册、报告、立刻退出。
 * 用来回答"这台机器上我到底能抢到哪些键"，也用来做主机侧自检（不需要真的常驻进程）。
 * @param {object} [keys]
 */
export async function probeHotkeys(keys = DEFAULT_KEYS) {
	const file = path.join(CACHE_DIR, 'hotkey-probe.jsonl')
	try {
		fs.rmSync(file, { force: true })
	} catch {}
	const { run } = await import('./shot.mjs')
	const res = await run(
		findPowershell(),
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, 'hotkey.ps1'), '-Out', file, '-Keys', buildKeySpec(keys), '-ProbeOnly'],
		{ timeoutMs: 25_000 }
	)
	let events = []
	try {
		events = fs
			.readFileSync(file, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l)
				} catch {
					return null
				}
			})
			.filter(Boolean)
	} catch {}
	const bindings = {}
	const taken = []
	for (const ev of events) {
		if (ev.stage === 'register' && ev.ok === true) bindings[ev.action] = ev.key
		if (ev.stage === 'register' && ev.ok !== true) taken.push({ key: ev.key, action: ev.action, win32: ev.win32 ?? 0 })
	}
	return { ok: res.code === 0, code: res.code, bindings, taken, events, stderr: String(res.stderr ?? '').slice(0, 400) }
}

/**
 * 启动常驻热键守护。幂等：已经在跑就返回同一个句柄。
 * @param {{onFire: (action: string, ev: object) => void, keys?: object, focusTitle?: string}} opts
 */
export function startHotkeys(opts) {
	if (state.child !== null && state.child.exitCode === null) {
		return { ok: true, already: true, bindings: { ...state.bindings }, pid: state.child.pid }
	}
	const keys = opts?.keys ?? DEFAULT_KEYS
	// 目录必须先存在：openSync(...,'a') 不会替你建目录，缺了就是 ENOENT ——
	// 而宿主完全可能在 .cache 还没被任何一次抓屏建出来时就启动热键。
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true })
	} catch {}
	try {
		fs.rmSync(EVENTS_PATH, { force: true })
	} catch {}

	let child
	try {
		// stderr 走**文件**而不是管道：管道在这个环境里可能建不出来（沙箱禁 CreatePipe，
		// spawn 直接 EPERM），而且守护进程活得比一次调用长，管道缓冲满了会把写日志的
		// 那一侧卡死。落文件既没有这两个问题，又保留了"它为什么退出"的线索。
		const errFd = fs.openSync(STDERR_PATH, 'a')
		try {
			child = spawn(
				findPowershell(),
				[
					'-NoProfile',
					'-ExecutionPolicy',
					'Bypass',
					'-File',
					path.join(PS_DIR, 'hotkey.ps1'),
					'-Out',
					EVENTS_PATH,
					'-Keys',
					buildKeySpec(keys),
					'-FocusTitle',
					opts?.focusTitle ?? 'DeepSeek Harness',
					'-MaxMinutes',
					'720',
					// ★ 把宿主自己的 pid 交给守护进程。DSH 被强杀（任务管理器结束进程 / 崩溃）时
					//   dispose 不会跑，child.kill() 也就不会发生 —— 这个守护进程会继续
					//   **全局吞掉用户的按键**最长 12 小时，比没有热键更糟。
					//   守护进程每 ~2 秒看一眼这个 pid 还在不在，不在就自己退出。
					'-ParentPid',
					// 可供自检覆盖成「一个肯定已经死掉的 pid」来验它会自行退出；0 = 不看守。
					String(opts?.parentPid ?? process.pid),
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
		return { ok: false, error: state.error, bindings: {}, pid: 0 }
	}

	state.child = child
	state.error = ''
	state.bindings = {}
	state.seq = 0
	child.on('exit', (code) => {
		state.child = null
		// 我们自己 kill 掉的不算"意外退出"。不区分的话，"热键突然不灵了"（真崩了）和
		// "用户刚在菜单里关掉它"（正常）在诊断里长得一模一样。
		if (state.stopping) {
			state.stopping = false
			state.exited = null
			return
		}
		// 守护进程不该自己退出。真退了就把原因留下来——否则"热键突然不灵了"没有任何线索。
		let tail = ''
		try {
			tail = fs.readFileSync(STDERR_PATH, 'utf8').slice(-800)
		} catch {}
		state.exited = { code, at: new Date().toISOString(), stderr: tail }
	})

	// 增量读事件文件：`fs.watch` 在 Windows 上对"另一个进程 append"并不可靠，轮询 300ms 足够廉价，
	// 而且天然能容忍半行（readEvents 会跳过解析失败的）。
	state.timer = setInterval(() => {
		const events = readEvents()
		for (let i = state.seq; i < events.length; i += 1) {
			const ev = events[i]
			if (ev.stage === 'register' && ev.ok === true && ev.action) state.bindings[ev.action] = ev.key
			if (ev.stage === 'fire' && typeof opts?.onFire === 'function') {
				try {
					opts.onFire(String(ev.action ?? 'shot'), ev)
				} catch (error) {
					state.error = String(error?.message ?? error)
				}
			}
		}
		state.seq = events.length
	}, 300)
	if (state.timer.unref) state.timer.unref()

	return { ok: true, pid: child.pid, bindings: { ...state.bindings } }
}

const state = {
	child: null,
	timer: null,
	seq: 0,
	bindings: {},
	error: '',
	exited: null,
	/** true = 这次退出是我们自己 kill 的，不是守护进程崩了。 */
	stopping: false,
	probe: null,
}

export function hotkeyStatus() {
	const alive = state.child !== null && state.child.exitCode === null
	const bindings = {}
	for (const [action, key] of Object.entries(state.bindings)) bindings[action] = prettyKey(key)
	// 还没注册完（事件文件里还没有 register 行）时先报候选，界面至少能显示"打算用哪个"。
	if (Object.keys(bindings).length === 0) {
		for (const [action, list] of Object.entries(DEFAULT_KEYS)) bindings[action] = prettyKey(list[0]) + '?'
	}
	return {
		alive,
		pid: alive ? state.child.pid : 0,
		bindings,
		error: state.error,
		exited: state.exited === null ? null : state.exited,
		events: readEvents().length,
	}
}

export function stopHotkeys() {
	if (state.timer !== null) {
		clearInterval(state.timer)
		state.timer = null
	}
	const child = state.child
	state.child = null
	if (child !== null) {
		state.stopping = true
		try {
			child.kill()
		} catch {
			state.stopping = false
		}
	}
	return true
}
