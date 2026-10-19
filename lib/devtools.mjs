/**
 * lib/devtools.mjs — **开发期**工具的两个后端（R23）。
 *
 * 为什么要把这两件事做成工具：这一轮（R20–R22）为了验证同一套东西，我手敲了
 * 五轮 `host_selfcheck`、三次 `testbed_refwin` + `dsh-longshot-check`、还有几十次
 * "写 cmd.json → 等回执 → 去 dump 目录里翻"的 AI 直连桥操作。每一次都踩同样的坑：
 *
 *   · 闸门分散在四个命令里，跑完要自己对着四份输出判绿（还各自 2–4 分钟）；
 *   · 覆盖层自检必须 `DSH_OVERLAY_DIR` 改道，否则会被**应用常驻的那个助手**抢走请求；
 *   · 桥的静态口（8934）不在插件里，忘了起就"静默失败"，看起来像客户端没热重载；
 *   · 回执落在 dsh-diag 的 200 个 dump 里，要按时间戳+seq 挑，控制台还是 GBK。
 *
 * 所以这里只做两件事：**一次跑完闸门并给结论表**、**把桥当成一个可控对象**。
 * 两者都只读/只做它们自己声明的动作，不碰用户窗口、不抢前台。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)
/** 工作区根：插件目录的上一级（DSH-Plugin/<x> → DSH-Plugin → 工作区）。 */
export const WORKSPACE = path.dirname(path.dirname(PLUGIN_ROOT))

export const LAB = path.join(WORKSPACE, '.tmp-shot-lab')
/** 闸门自检专用的覆盖层请求目录：**必须**与应用常驻的那个助手分开（见文件头）。 */
export const GATE_OVERLAY_DIR = path.join(LAB, 'gate-overlay')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跑一个 node 脚本并收集输出。永不抛：失败也回结构化结果。
 *
 * 两条路：先试 `execFile`（能同时拿到 stdout 与退出码）；如果它被沙箱按
 * **EPERM** 拒掉（低完整性 shell 下子进程不能开管道 —— 这条在 R14 就记过），
 * 就退回"重定向到文件再读回来"。宿主进程里走第一条，工具 shell 里走第二条，行为一致。
 */
function runNode(script, args, opts = {}) {
	const viaPipes = () =>
		new Promise((resolve) => {
			const started = Date.now()
			try {
				execFile(
					process.execPath,
					[script, ...(args || [])],
					{
						cwd: opts.cwd || WORKSPACE,
						env: Object.assign({}, process.env, opts.env || {}),
						timeout: Math.max(5_000, Number(opts.timeoutMs) || 240_000),
						maxBuffer: 8 * 1024 * 1024,
						windowsHide: true,
					},
					(error, stdout, stderr) => {
						if (error !== null && (error.code === 'EPERM' || /EPERM/.test(String(error.message)))) {
							resolve({ pipeDenied: true, ok: false, code: -2, ms: Date.now() - started, stdout: '', stderr: 'EPERM' })
							return
						}
						resolve({
							ok: error === null,
							code: error === null ? 0 : Number(error.code) || 1,
							ms: Date.now() - started,
							stdout: String(stdout || ''),
							stderr: String(stderr || ''),
						})
					}
				)
			} catch (error) {
				// execFile 在 spawn 失败时是**同步 throw**（不是走回调），低完整性 shell 就是这条。
				const msg = String(error?.message ?? error)
				if (/EPERM/.test(msg)) {
					resolve({ pipeDenied: true, ok: false, code: -2, ms: Date.now() - started, stdout: '', stderr: msg })
					return
				}
				resolve({ ok: false, code: -1, ms: Date.now() - started, stdout: '', stderr: msg })
			}
		})

	return viaPipes().then(async (res) => {
		if (res.pipeDenied !== true) return res
		// 回落：stdio 指向文件（文件不是管道，不受限），跑完把文件读回来当 stdout。
		const started = Date.now()
		const ioDir = path.join(LAB, 'gate-io')
		try {
			fs.mkdirSync(ioDir, { recursive: true })
		} catch {}
		const outFile = path.join(ioDir, `run-${process.pid}-${Math.random().toString(36).slice(2, 7)}.log`)
		let fd = null
		try {
			fd = fs.openSync(outFile, 'a')
		} catch {}
		if (fd === null) return { ok: false, code: -1, ms: Date.now() - started, stdout: '', stderr: 'cannot open log file' }
		const finished = await new Promise((resolve) => {
			let child = null
			try {
				child = spawn(process.execPath, [script, ...(args || [])], {
					cwd: opts.cwd || WORKSPACE,
					env: Object.assign({}, process.env, opts.env || {}),
					stdio: ['ignore', fd, fd],
					windowsHide: true,
				})
			} catch (error) {
				resolve({ ok: false, code: -1, error: String(error?.message ?? error) })
				return
			}
			const timer = setTimeout(() => {
				try {
					child.kill()
				} catch {}
				resolve({ ok: false, code: -3, error: 'timeout' })
			}, Math.max(5_000, Number(opts.timeoutMs) || 240_000))
			child.on('exit', (code) => {
				clearTimeout(timer)
				resolve({ ok: code === 0, code: code === null ? -1 : code, error: '' })
			})
			child.on('error', (error) => {
				clearTimeout(timer)
				resolve({ ok: false, code: -1, error: String(error?.message ?? error) })
			})
		})
		let text = ''
		try {
			text = fs.readFileSync(outFile, 'utf8')
		} catch {}
		try {
			fs.rmSync(outFile, { force: true })
		} catch {}
		return {
			ok: finished.ok === true && finished.error === '',
			code: Number(finished.code) || 0,
			ms: Date.now() - started,
			stdout: text,
			stderr: finished.error || '',
		}
	})
}

/** 从一段输出里抠出最后一行匹配 `re` 的文本。 */
function lastMatch(text, re) {
	let hit = null
	for (const line of String(text).split(/\r?\n/)) {
		if (re.test(line)) hit = line
	}
	return hit
}

/* ─────────────────────────── 闸门 ─────────────────────────── */

/**
 * 一次跑完 dsh-screenshot 的闸门，给一张结论表。
 *
 * `smoke` 与 `tick` 是秒级；`overlay` 约 25s（起一次常驻助手）；`host` 约 3 分钟
 * （起测试窗口 + 长截图会话）。**默认只跑前三个**，`host:true` 才跑完整宿主自检。
 *
 * @param {{smoke?: boolean, overlay?: boolean, tick?: boolean, host?: boolean,
 *   content?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean, ms: number, detail: string}>,
 *   passed: number, failed: number, text: string}>}
 */
export async function gateRun(opts = {}) {
	const want = {
		smoke: opts.smoke !== false,
		overlay: opts.overlay !== false,
		tick: opts.tick === true,
		host: opts.host === true,
	}
	const checks = []
	const toolPath = (rel) => path.join(WORKSPACE, '.tools', rel)
	const pluginPath = (rel) => path.join(PLUGIN_ROOT, rel)

	async function step(name, fn) {
		const res = await fn()
		checks.push({ name, ok: res.ok === true, ms: res.ms, detail: res.detail })
		return res
	}

	if (want.smoke) {
		await step('静态契约 dsh-shot-smoke', async () => {
			const r = await runNode(toolPath('dsh-shot-smoke.mjs'), [], { timeoutMs: 180_000 })
			const line = lastMatch(r.stdout, /^passed \d+ \/ failed \d+/)
			return { ok: r.ok && line !== null && !/failed [1-9]/.test(line), ms: r.ms, detail: line || (r.stderr.split('\n')[0] || 'no output') }
		})
	}

	if (want.overlay) {
		await step('助手+服务层 ovl-selftest', async () => {
			try {
				fs.mkdirSync(GATE_OVERLAY_DIR, { recursive: true })
			} catch {}
			const r = await runNode(pluginPath('dev/ovl-selftest.mjs'), [], {
				// 改道：应用常驻的覆盖层助手盯着 .cache/overlay，不改道会抢走我们的请求
				env: { DSH_OVERLAY_DIR: GATE_OVERLAY_DIR },
				timeoutMs: 300_000,
			})
			const line = lastMatch(r.stdout, /^(ALL PASS|\d+ FAILURE)/)
			const passCount = (r.stdout.match(/^PASS /gm) || []).length
			return { ok: r.ok && line === 'ALL PASS', ms: r.ms, detail: (line || 'no verdict') + ' (' + passCount + ' PASS)' }
		})
	}

	if (want.tick) {
		await step('一拍成本 dsh-shot-tick-bench', async () => {
			const r = await runNode(toolPath('dsh-shot-tick-bench.mjs'), [], { timeoutMs: 180_000 })
			let median = 0
			try {
				median = Number(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).medianMs) || 0
			} catch {}
			return { ok: r.ok && median > 0 && median < 1000, ms: r.ms, detail: 'median tick=' + median + 'ms（<1000ms 视为常驻助手在生效）' }
		})
	}

	if (typeof opts.content === 'string' && /^-?\d+,-?\d+,\d+,\d+$/.test(opts.content)) {
		await step('长截图内容级 dsh-longshot-check', async () => {
			const r = await runNode(toolPath('dsh-longshot-check.mjs'), ['--rect', opts.content, '--want', '3', '--seconds', '24'], {
				timeoutMs: 180_000,
			})
			const line = lastMatch(r.stdout, /^LONGSHOT/)
			let info = null
			try {
				info = JSON.parse(String(line).slice('LONGSHOT '.length))
			} catch {}
			return {
				ok: r.ok && info !== null && info.ok === true && info.frames >= 2,
				ms: r.ms,
				detail: info === null ? line || 'no LONGSHOT line' : `${info.frames} 帧 → ${info.width}×${info.height} ${info.path}`,
				path: info === null ? '' : info.path,
			}
		})
	}

	if (want.host) {
		await step('宿主全量 dev/hosttest.mjs', async () => {
			const r = await runNode(pluginPath('dev/hosttest.mjs'), [], { timeoutMs: 900_000 })
			const tail = String(r.stdout).split(/\r?\n/).filter((l) => /项通过|项失败/.test(l)).pop()
			return { ok: r.ok && /全部 \d+ 项通过/.test(tail || ''), ms: r.ms, detail: tail || (r.stderr.split('\n')[0] || 'no summary') }
		})
	}

	const failed = checks.filter((c) => !c.ok).length
	const lines = checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${Math.round(c.ms / 1000)}s  ${c.detail}`)
	const text = [
		`闸门：${checks.length - failed}/${checks.length} 通过${failed === 0 ? '' : '  ← 有红项，先看 detail'}`,
		...lines,
	].join('\n')
	return { ok: failed === 0, checks, passed: checks.length - failed, failed, text }
}

/* ─────────────────────────── AI 直连桥 ─────────────────────────── */

const BRIDGE_STATIC_PORT = 8934
const BRIDGE_DUMP_PORT = 8935
const CMD_REL = path.join('.tmp-vision', '_ai', 'cmd.json')
const CMD_URL = 'http://127.0.0.1:' + BRIDGE_STATIC_PORT + '/.tmp-vision/_ai/cmd.json'
const DUMP_BASE = 'http://127.0.0.1:' + BRIDGE_DUMP_PORT
/** dsh-diag 收集口的落盘目录（8935 自己在 GET / 里也会报，这是兜底）。 */
const DUMP_DIR = path.join(WORKSPACE, 'DSH-Plugin', 'dsh-diag', '.dsh-diag')

async function httpJson(url, timeoutMs = 1500) {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
		const body = await res.text()
		return { ok: true, status: res.status, body }
	} catch (error) {
		return { ok: false, status: 0, body: String(error?.message ?? error) }
	} finally {
		clearTimeout(timer)
	}
}

/** 收集口在哪、写了多少个文件、最近几封是什么。 */
async function dumpInfo() {
	const probe = await httpJson(DUMP_BASE + '/')
	if (probe.ok === true) {
		try {
			const parsed = JSON.parse(probe.body)
			if (parsed !== null && typeof parsed === 'object' && typeof parsed.dir === 'string') {
				return { dir: parsed.dir, via: 'http', count: Number(parsed.count) || 0 }
			}
		} catch {}
	}
	let count = 0
	try {
		count = fs.readdirSync(DUMP_DIR).filter((n) => n.startsWith('dump-')).length
	} catch {}
	return { dir: DUMP_DIR, via: 'fs', count }
}

/** 桥 + 应用侧现状。 */
export async function bridgeStatus() {
	const staticProbe = await httpJson(CMD_URL + '?t=' + Date.now())
	const dumps = await dumpInfo()
	const recent = listDumps(8, 'ai-result')
	const instances = new Map()
	for (const item of recent) {
		// 注意：listDumps 已经把 instance 摊平成 id/build 了（dump 里的形状是 {instance:{id,build}}）。
		if (item.id) instances.set(item.id, item.build || '')
	}
	const staticOk = staticProbe.ok === true && staticProbe.status === 200
	const dumpOk = dumps.via === 'http'
	const lines = [
		`静态口 :${BRIDGE_STATIC_PORT} ${staticOk ? 'OK' : '不通 ← 桥要它才能收命令：node .tools/devserver.mjs ' + BRIDGE_STATIC_PORT + ' ' + WORKSPACE}`,
		`收集口 :${BRIDGE_DUMP_PORT} ${dumpOk ? 'OK' : '不通（dsh-diag 宿主半边没起来？）'}  dir=${dumps.dir}  files=${dumps.count}`,
		`最近 ai-result 里出现过 ${instances.size} 个客户端实例：` + (instances.size === 0 ? '(无回执)' : [...instances.entries()].map(([id, b]) => id + '@' + b).join(', ')),
		...(recent.length === 0 ? [] : ['最近回执：' + recent.map((r) => r.seq + '@' + (r.build || '?')).join(' ')]),
	]
	return {
		ok: staticOk && dumpOk,
		staticOk,
		dumpOk,
		instances: [...instances.entries()].map(([id, build]) => ({ id, build })),
		recent: recent.map((r) => ({ seq: r.seq, build: r.build, at: r.at })),
		text: lines.join('\n'),
		dir: dumps.dir,
	}
}

/** 读最近的 dump（可按 tag 过滤），只取需要的字段。 */
export function listDumps(limit = 10, tag = '') {
	let names = []
	try {
		names = fs.readdirSync(DUMP_DIR).filter((n) => n.startsWith('dump-') && n.endsWith('.json'))
	} catch {
		return []
	}
	const withTime = []
	for (const name of names) {
		const file = path.join(DUMP_DIR, name)
		try {
			withTime.push({ file, name, mtime: fs.statSync(file).mtimeMs })
		} catch {}
	}
	withTime.sort((a, b) => b.mtime - a.mtime)
	const out = []
	for (const item of withTime) {
		if (out.length >= limit) break
		let parsed = null
		try {
			parsed = JSON.parse(fs.readFileSync(item.file, 'utf8'))
		} catch {
			continue
		}
		if (parsed === null || typeof parsed !== 'object') continue
		if (tag !== '' && String(parsed.tag || '') !== tag) continue
		out.push({
			file: item.file,
			name: item.name,
			at: String(parsed.at || ''),
			tag: String(parsed.tag || ''),
			seq: Number(parsed.seq) || 0,
			build: parsed.instance && parsed.instance.build ? String(parsed.instance.build) : '',
			id: parsed.instance && parsed.instance.id ? String(parsed.instance.id) : '',
			results: Array.isArray(parsed.results) ? parsed.results : [],
			extra: parsed.extra === undefined ? null : parsed.extra,
			mtime: item.mtime,
		})
	}
	return out
}

/** 起静态口（幂等）。返回是否就绪。 */
async function ensureStaticServer() {
	const probe = await httpJson(CMD_URL + '?t=' + Date.now())
	if (probe.ok === true && probe.status === 200) return true
	try {
		fs.mkdirSync(path.dirname(path.join(WORKSPACE, CMD_REL)), { recursive: true })
	} catch {}
	try {
		const child = spawn(process.execPath, [path.join(WORKSPACE, '.tools', 'devserver.mjs'), String(BRIDGE_STATIC_PORT), WORKSPACE], {
			cwd: WORKSPACE,
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		})
		child.unref()
	} catch {
		return false
	}
	for (let i = 0; i < 30; i += 1) {
		await sleep(200)
		const again = await httpJson(CMD_URL + '?t=' + Date.now())
		if (again.ok === true && again.status === 200) return true
	}
	return false
}

/**
 * 往运行中的应用下一条命令，并等它的回执。
 *
 * @param {{ops: Array<object>, target?: string, waitMs?: number, ensureServer?: boolean}} opts
 * @returns {Promise<{ok: boolean, sent: boolean, seq: number, results: Array<object>,
 *   instances: Array<{id: string, build: string}>, ms: number, error: string, text: string}>}
 */
export async function bridgeSend(opts = {}) {
	const ops = Array.isArray(opts.ops) ? opts.ops : []
	if (ops.length === 0) {
		return { ok: false, sent: false, seq: 0, results: [], instances: [], ms: 0, error: 'ops is empty', text: '没有要执行的 ops。' }
	}
	const target = typeof opts.target === 'string' && opts.target !== '' ? opts.target : 'all'
	const waitMs = Math.max(1_000, Math.min(180_000, Number(opts.waitMs) || 25_000))
	const t0 = Date.now()

	if (opts.ensureServer !== false) {
		const up = await ensureStaticServer()
		if (!up) {
			return { ok: false, sent: false, seq: 0, results: [], instances: [], ms: Date.now() - t0, error: 'static server :' + BRIDGE_STATIC_PORT + ' not reachable', text: '静态口起不来。手动起：node .tools/devserver.mjs ' + BRIDGE_STATIC_PORT + ' ' + WORKSPACE }
		}
	}

	// seq 必须**大于**客户端记着的那个，否则它认领不了；用毫秒时间戳天然满足。
	const seq = Date.now()
	const cmdFile = path.join(WORKSPACE, CMD_REL)
	try {
		fs.mkdirSync(path.dirname(cmdFile), { recursive: true })
		const tmp = cmdFile + '.tmp'
		fs.writeFileSync(tmp, JSON.stringify({ seq, target, ops }), 'utf8')
		fs.renameSync(tmp, cmdFile)
	} catch (error) {
		return { ok: false, sent: false, seq, results: [], instances: [], ms: Date.now() - t0, error: String(error?.message ?? error), text: '写命令文件失败。' }
	}

	// 等回执：客户端每 1.2s 拉一次，ops 里可能有 wait，所以给够时间。
	const deadline = Date.now() + waitMs
	const seen = new Map()
	while (Date.now() < deadline) {
		for (const item of listDumps(12, 'ai-result')) {
			if (item.seq !== seq) continue
			// 同一个 seq 会被**多个并存的模块实例**各回一封（热重载后常见），按实例收齐。
			if (!seen.has(item.id) || seen.get(item.id).mtime < item.mtime) seen.set(item.id, item)
		}
		if (seen.size > 0) {
			// 给其它实例一点时间一起到齐，免得只看到第一封。
			await sleep(600)
			for (const item of listDumps(12, 'ai-result')) {
				if (item.seq !== seq) continue
				if (!seen.has(item.id) || seen.get(item.id).mtime < item.mtime) seen.set(item.id, item)
			}
			break
		}
		await sleep(300)
	}

	const instances = [...seen.values()].map((v) => ({ id: v.id, build: v.build }))
	const results = [...seen.values()].flatMap((v) => v.results || [])
	if (seen.size === 0) {
		return {
			ok: false,
			sent: true,
			seq,
			results: [],
			instances: [],
			ms: Date.now() - t0,
			error: 'no receipt within ' + waitMs + 'ms',
			text: '命令已写进 ' + CMD_REL + '，但 ' + waitMs + 'ms 内没有回执。通常是：应用没在跑 / 插件客户端太旧（没有 aiBridge）/ 静态口刚起来还没轮询。',
		}
	}
	const lines = [
		'回执 seq=' + seq + ' · ' + instances.length + ' 个实例（' + instances.map((i) => i.id + '@' + i.build).join(', ') + '）· ' + ((Date.now() - t0) / 1000).toFixed(1) + 's',
		...results.map((r) => {
			const v = r.value === undefined ? r.error : r.value
			let s = ''
			try {
				s = typeof v === 'string' ? v : JSON.stringify(v)
			} catch {
				s = String(v)
			}
			return '  ' + String(r.op || '?') + ': ' + String(s).slice(0, 400)
		}),
	]
	return { ok: true, sent: true, seq, results, instances, ms: Date.now() - t0, error: '', text: lines.join('\n') }
}

/** 最近的 dump（给"刚才那次到底发生了什么"用）。 */
export function bridgeResults(opts = {}) {
	const limit = Math.max(1, Math.min(50, Number(opts.limit) || 10))
	const tag = typeof opts.tag === 'string' ? opts.tag : ''
	const items = listDumps(limit, tag)
	return {
		ok: true,
		count: items.length,
		dir: DUMP_DIR,
		items: items.map((i) => ({ name: i.name, tag: i.tag, seq: i.seq, build: i.build, at: i.at, extra: i.extra })),
		text: items.length === 0 ? '没有 dump。' : [DUMP_DIR + ' 最近 ' + items.length + ' 封：', ...items.map((i) => `  ${i.at} ${i.tag} seq=${i.seq} ${i.build}${i.extra === null ? '' : ' ' + JSON.stringify(i.extra).slice(0, 160)}`)].join('\n'),
	}
}
