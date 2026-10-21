/**
 * lib/preflight.mjs — 「改完宿主半边、还没重启 DSH」时的一步验证（R40）。
 *
 * 为什么需要它：工具表是**宿主启动期**读的。改完 `tools.js` / `lib/*.mjs` 之后、重启之前，
 * 运行中的宿主跑的还是旧实现 —— 想在重启前验"磁盘上的新代码对不对"，以前要记住
 * **两个脚本名**（`dev/gate-full-hostrun.mjs` / `dev/all-probes-hostrun.mjs`）外加
 * `host_selfcheck` 的参数写法，换会话必重新摸（R35/R37 各踩过一次）。
 *
 * 这里把它变成一次工具调用：`shot_preflight`（默认 = 自检 + full 闸门）。
 *
 * ⚠️ 这些脚本是**子进程**跑的（`process.execPath`），不会被工具沙箱限制；它们自己会
 *    `process.exit()`，所以**绝不能**在本进程里 import —— 那会把宿主带走。
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)

/** 可跑的预检项。`severity`: heavy 的不进默认集合（≈5–10 分钟，会起测试窗口）。 */
export const PREFLIGHTS = {
	'probe-selftest': {
		script: 'dev/probe-selftest.mjs',
		timeoutMs: 240_000,
		about: '像素库/探针库/清单元数据自检（≈1.5 s，确定性）',
	},
	'gate-full': {
		script: 'dev/gate-full-hostrun.mjs',
		timeoutMs: 900_000,
		about: '交付闸门 full：静态契约 + 覆盖层 + 一拍成本 + 探针聚合（≈2.5–5 分钟）',
	},
	'all-probes': {
		script: 'dev/all-probes-hostrun.mjs',
		timeoutMs: 900_000,
		about: '只跑探针聚合（5 个轻探针，≈2–5 分钟）',
	},
	hosttest: {
		script: 'dev/hosttest.mjs',
		timeoutMs: 1_200_000,
		heavy: true,
		about: '宿主全量（77 项，≈5–10 分钟，会起测试窗口）',
	},
}

export const PREFLIGHT_NAMES = Object.keys(PREFLIGHTS)
/** 默认集合：快 + 覆盖交付面；重活（hosttest）必须点名。 */
export const DEFAULT_WHAT = ['probe-selftest', 'gate-full']

/** 把一个预检项的输出翻成结论。判据写在这里，工具与调用方都不会各自解释一份。 */
export function verdictOf(name, stdout, exitCode) {
	const out = String(stdout ?? '')
	const lines = out.split(/\r?\n/)
	const tail = (re) => {
		for (let i = lines.length - 1; i >= 0; i--) {
			const m = re.exec(lines[i])
			if (m !== null) return m
		}
		return null
	}
	if (name === 'probe-selftest') {
		const m = tail(/(\d+) PASS \/ (\d+) FAIL/)
		if (m === null) return { ok: false, detail: '没有结论行（脚本可能中途失败）' }
		return { ok: Number(m[2]) === 0 && Number(m[1]) > 0, detail: m[1] + ' PASS / ' + m[2] + ' FAIL' }
	}
	if (name === 'gate-full') {
		const m = tail(/闸门：(\d+)\/(\d+) 通过/)
		if (m === null) return { ok: false, detail: '没有闸门结论行' }
		const failedLines = lines.filter((l) => /^FAIL\s/.test(l)).map((l) => l.trim()).slice(0, 4)
		return {
			ok: Number(m[1]) === Number(m[2]) && Number(m[2]) > 0,
			detail: m[1] + '/' + m[2] + ' 通过' + (failedLines.length === 0 ? '' : ' ← ' + failedLines.join(' | ')),
		}
	}
	if (name === 'all-probes') {
		const m = tail(/ok=(true|false) probes=(\d+) passed=(\d+) failed=(\d+)/)
		if (m === null) return { ok: false, detail: '没有聚合结论行（0 PASS/0 FAIL 也算失败）' }
		return {
			ok: m[1] === 'true' && Number(m[2]) > 0,
			detail: m[2] + ' 个探针 · ' + m[3] + ' PASS / ' + m[4] + ' FAIL',
		}
	}
	if (name === 'hosttest') {
		const m = tail(/全部 (\d+) 项通过/)
		if (m !== null) return { ok: true, detail: '全部 ' + m[1] + ' 项通过' }
		const bad = tail(/(\d+) 项失败/)
		return { ok: false, detail: bad === null ? '退出码 ' + exitCode + '，没有"全部 N 项通过"' : bad[1] + ' 项失败' }
	}
	return { ok: exitCode === 0, detail: '退出码 ' + exitCode }
}

/** 跑一个子进程 node 脚本，永不抛。`lib/land.mjs` 也用它跑自检。 */
export function runScript(scriptPath, extraArgs, timeoutMs) {
	return new Promise((resolve) => {
		const started = Date.now()
		let stdout = ''
		let stderr = ''
		let child = null
		try {
			child = spawn(process.execPath, [scriptPath, ...extraArgs], {
				cwd: PLUGIN_ROOT,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		} catch (error) {
			resolve({ ok: false, exitCode: -1, ms: 0, stdout: '', stderr: String(error && error.message), timedOut: false })
			return
		}
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL')
			} catch {}
		}, timeoutMs)
		child.stdout.on('data', (b) => {
			stdout += String(b)
		})
		child.stderr.on('data', (b) => {
			stderr += String(b)
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			resolve({ ok: false, exitCode: -1, ms: Date.now() - started, stdout, stderr: String(error && error.message), timedOut: false })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve({ ok: code === 0, exitCode: code, ms: Date.now() - started, stdout, stderr, timedOut: Date.now() - started >= timeoutMs })
		})
	})
}

/**
 * 跑一组预检。
 * @param {{what?: string|string[]}} [opts] 'all' 或名字数组（省略 = DEFAULT_WHAT）
 * @returns {Promise<{ok:boolean, items:Array, text:string, plan:string[]}>}
 */
export async function preflightRun(opts = {}) {
	let names = []
	if (Array.isArray(opts.what)) names = opts.what.map(String)
	else if (typeof opts.what === 'string' && opts.what !== '' && opts.what !== 'all') names = [opts.what]
	else if (opts.what === 'all') names = PREFLIGHT_NAMES.filter((n) => PREFLIGHTS[n].heavy !== true).concat()
	else names = DEFAULT_WHAT.slice()
	names = names.filter((n, i) => names.indexOf(n) === i)
	const unknown = names.filter((n) => PREFLIGHTS[n] === undefined)
	if (unknown.length > 0) {
		return {
			ok: false,
			items: [],
			plan: [],
			text: '未知预检项：' + unknown.join('、') + '。可选：' + PREFLIGHT_NAMES.join(' / ') + ' / all',
		}
	}
	const items = []
	for (const name of names) {
		const def = PREFLIGHTS[name]
		const r = await runScript(path.join(PLUGIN_ROOT, def.script), [], def.timeoutMs)
		const v = verdictOf(name, r.stdout, r.exitCode)
		items.push({
			name,
			ok: v.ok === true && r.timedOut !== true,
			detail: (r.timedOut === true ? '超时被中止 · ' : '') + v.detail,
			ms: r.ms,
			exitCode: r.exitCode,
			tail: String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-3).join(' | '),
		})
	}
	const failed = items.filter((i) => i.ok !== true).length
	const text = [
		'预检（磁盘上的代码，未重启也能验）：' + (items.length - failed) + '/' + items.length + ' 通过',
		...items.map((i) => (i.ok ? 'PASS  ' : 'FAIL  ') + i.name.padEnd(16) + ' ' + Math.round(i.ms / 1000) + 's  ' + i.detail),
	]
		.concat(failed === 0 ? [] : ['（失败项先看 detail；需要原始输出时点名单跑一个）'])
		.join('\n')
	return { ok: failed === 0 && items.length > 0, items, plan: names, text }
}
