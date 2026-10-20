// lib/probes.mjs — 把"跑某个 dev 探针"固定成一个工具（R34）
//
// 为什么需要它：这个插件的验证被拆在六七份脚本里（hosttest / recframe / wheel-target /
// hide-self / wheel-app-qt|java / ovl-selftest），而它们的**正确跑法**有门槛：
//   ① 必须从**宿主进程**里跑（低完整性沙箱注入不了消息、起的窗口上不了屏）；
//   ② 每个都要带自己的参数（`-App qt` / `-Seconds 45` …）；
//   ③ 输出是中文 PASS/FAIL 列表，人要自己数。
// 换会话之后，谁都得重新摸一遍。这里把它们收成一张表：`shot_probe({probe:'recframe'})`。
//
// ⚠️ 它**只 spawn**（不 import），所以探针里的顶层 await / 退出码语义都照常。

import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 探针清单。`timeoutSec` 是硬上限：超时会被杀并如实回报（**不要**把超时当通过）。
 */
export const PROBES = {
	hosttest: { script: 'dev/hosttest.mjs', timeoutSec: 600, about: '全量宿主自检（会起测试窗口、会真录一段）' },
	recframe: { script: 'dev/recframe-probe.mjs', timeoutSec: 240, about: '录屏框：像素级证据（在屏幕四边之外、内部 0 像素、内部未被改动）' },
	'wheel-target': { script: 'dev/wheel-target-probe.mjs', timeoutSec: 240, about: '投递滚轮投给谁（WinForms 夹具，含真实滚轮对照臂）' },
	'hide-self': { script: 'dev/hide-self-probe.mjs', timeoutSec: 180, about: '「截图时隐藏 DSH」真藏一次 + 还原 + 几何不变' },
	'wheel-app-qt': { script: 'dev/wheel-app-probe.mjs', args: ['-App', 'qt'], timeoutSec: 240, about: 'Qt 认不认投递滚轮（自带夹具，需要 .tmp-shot-lab/pyqt）' },
	'wheel-app-java': { script: 'dev/wheel-app-probe.mjs', args: ['-App', 'java'], timeoutSec: 240, about: 'Java Swing 认不认投递滚轮（需要 JDK）' },
}

/** 从探针输出里数 PASS/FAIL 行（中英混排，只认行首）。 */
export function countChecks(stdout) {
	let passed = 0
	let failed = 0
	const failures = []
	for (const line of String(stdout ?? '').split(/\r?\n/)) {
		const m = /^\s*(PASS|FAIL)\b\s*(.*)$/.exec(line)
		if (m === null) continue
		if (m[1] === 'PASS') passed++
		else {
			failed++
			if (failures.length < 8) failures.push(m[2].trim())
		}
	}
	return { passed, failed, failures }
}

/**
 * 跑一个探针。
 * @param {{probe:string, args?:string[], timeoutSec?:number}} opts
 * @returns {Promise<{ok:boolean, probe:string, passed:number, failed:number, exitCode:number|null,
 *   timedOut:boolean, failures:string[], text:string}>}
 */
export async function runProbe(opts = {}) {
	const name = String(opts.probe ?? '')
	const def = PROBES[name]
	if (def === undefined) {
		return {
			ok: false,
			probe: name,
			passed: 0,
			failed: 0,
			exitCode: null,
			timedOut: false,
			failures: [],
			text: `未知探针 "${name}"。可用：${Object.keys(PROBES).join(' / ')}`,
		}
	}
	const timeoutSec = Number.isFinite(Number(opts.timeoutSec)) && Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) : def.timeoutSec
	const extra = Array.isArray(opts.args) ? opts.args.map(String) : []
	const script = path.join(PLUGIN_ROOT, def.script)
	const started = Date.now()

	let child
	try {
		child = spawn(process.execPath, [script, ...(def.args ?? []), ...extra], {
			cwd: PLUGIN_ROOT,
			// ⚠️ 必须继承环境：探针靠 DSH_* 变量找缓存目录；被 pin 到沙箱临时目录会各写各的。
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (error) {
		return { ok: false, probe: name, passed: 0, failed: 0, exitCode: null, timedOut: false, failures: [], text: `起不来：${String(error?.message ?? error)}` }
	}

	let out = ''
	let err = ''
	child.stdout?.on('data', (d) => {
		if (out.length < 400_000) out += d.toString('utf8')
	})
	child.stderr?.on('data', (d) => {
		if (err.length < 100_000) err += d.toString('utf8')
	})

	const done = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			try {
				child.kill()
			} catch {}
			resolve({ exitCode: null, timedOut: true })
		}, timeoutSec * 1000)
		child.on('exit', (code) => {
			clearTimeout(timer)
			resolve({ exitCode: code, timedOut: false })
		})
		child.on('error', () => {
			clearTimeout(timer)
			resolve({ exitCode: null, timedOut: false })
		})
	})

	const counted = countChecks(out)
	const seconds = Math.round((Date.now() - started) / 1000)
	const ok = done.timedOut !== true && counted.failed === 0 && done.exitCode === 0 && counted.passed > 0
	const tail = out.trim().split(/\r?\n/).slice(-12).join('\n')
	const verdict = done.timedOut
		? `超时（${timeoutSec}s 被杀）—— **不算通过**`
		: `退出码 ${done.exitCode} · ${counted.passed} PASS / ${counted.failed} FAIL · ${seconds}s`
	const text = [
		`探针 ${name}（${def.about}）`,
		verdict,
		counted.failures.length > 0 ? '失败项：\n  ' + counted.failures.join('\n  ') : '',
		err.trim() !== '' ? 'stderr（尾部）：\n' + err.trim().split(/\r?\n/).slice(-6).join('\n') : '',
		tail !== '' ? 'stdout（尾部）：\n' + tail : '',
	]
		.filter((s) => s !== '')
		.join('\n')

	return {
		ok,
		probe: name,
		passed: counted.passed,
		failed: counted.failed,
		exitCode: done.exitCode,
		timedOut: done.timedOut === true,
		failures: counted.failures,
		text,
	}
}
