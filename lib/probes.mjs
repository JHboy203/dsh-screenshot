// lib/probes.mjs — 把"跑某个 dev 探针"固定成一个工具（R34）+ 清单自动发现与全跑聚合（R35）
//
// 为什么需要它：这个插件的验证被拆在六七份脚本里（hosttest / recframe / wheel-target /
// hide-self / wheel-app-qt|java / ovl-selftest），而它们的**正确跑法**有门槛：
//   ① 必须从**宿主进程**里跑（低完整性沙箱注入不了消息、起的窗口上不了屏）；
//   ② 每个都要带自己的参数（`-App qt` / `-Seconds 45` …）；
//   ③ 输出是中文 PASS/FAIL 列表，人要自己数。
// 换会话之后，谁都得重新摸一遍。这里把它们收成一张表：`shot_probe({probe:'recframe'})`。
//
// R35 补两条 R34 明确留下的"未做"：
//   * **清单自动发现** —— `dev/*-probe.mjs` 不用再手写进 PROBES（写文件即出现）。
//     ⚠️ 反过来的坑：**一个脚本被多条探针共用时（wheel-app-probe.mjs → qt/java 两条）
//     绝不能**再自动登记一条无参的，否则 `all` 会把它跑两遍、第二遍必然假红。
//   * **全跑聚合** —— `probe:'all'`，重活（hosttest ≈ 10 分钟）默认排除且**排在最后**。
//
// ⚠️ 它**只 spawn**（不 import），所以探针里的顶层 await / 退出码语义都照常。
// ⚠️ 三种状态都必须是"失败"，不许读成绿：**超时**（进程被杀）、**零检查**
//    （退出码 0 但一行 PASS/FAIL 都没打印 = 根本没跑到断言）、**非零退出**。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** 自动发现的扫描目录（可覆盖，自检就是靠这个参数拿临时目录验的）。 */
export const DEV_DIR = path.join(PLUGIN_ROOT, 'dev')

/**
 * 显式探针表：**带元数据的那几条**（跑法、参数、超时、是否重活）。
 * `timeoutSec` 是硬上限：超时会被杀并如实回报（**不要**把超时当通过）。
 * `heavy: true` 的默认不进 `all`（hosttest 会起窗口并真录一段，约 10 分钟）。
 * `needs`（依赖什么才能跑，如 pyqt / JDK）与 `argsHint`（人话描述它认哪些参数）
 * 都只用于 `probe:'list'` 的提示，不影响执行。
 */
export const PROBES = {
	hosttest: {
		script: 'dev/hosttest.mjs',
		timeoutSec: 600,
		heavy: true,
		about: '全量宿主自检（会起测试窗口、会真录一段）',
	},
	recframe: { script: 'dev/recframe-probe.mjs', timeoutSec: 240, about: '录屏框：像素级证据（在屏幕四边之外、内部 0 像素、内部未被改动）' },
	'record-audio': {
		script: 'dev/record-audio-probe.mjs',
		timeoutSec: 180,
		about: '录屏录音：设备枚举解析 / 文件真带 AAC 音轨 / 坏设备也照录（含静音对照臂）',
		argsHint: '无参数。没麦的机器会 SKIP 真实录音臂（不是失败）',
	},
	'wheel-target': { script: 'dev/wheel-target-probe.mjs', timeoutSec: 240, about: '投递滚轮投给谁（WinForms 夹具，含真实滚轮对照臂）' },
	'hide-self': { script: 'dev/hide-self-probe.mjs', timeoutSec: 180, about: '「截图时隐藏 DSH」真藏一次 + 还原 + 几何不变' },
	'wheel-app-qt': {
		script: 'dev/wheel-app-probe.mjs',
		args: ['-App', 'qt'],
		timeoutSec: 240,
		about: 'Qt 认不认投递滚轮（自带夹具）',
		needs: 'pyqt（.tmp-shot-lab/pyqt）',
		argsHint: '-App qt|java、-Title <窗口标题>（默认 qt）',
	},
	'wheel-app-java': {
		script: 'dev/wheel-app-probe.mjs',
		args: ['-App', 'java'],
		timeoutSec: 240,
		about: 'Java Swing 认不认投递滚轮（一窗一 HWND）',
		needs: 'JDK',
		argsHint: '-App qt|java、-Title <窗口标题>（这里固定 java）',
	},
}

/** 自动发现的文件名约定：`dev/<id>-probe.mjs`。 */
const PROBE_FILE = /-probe\.mjs$/

/**
 * 从脚本头部注释取 **说明** 与 **它要什么参数**。
 *
 * 约定（两行都必须写在头部注释里，`// args:` 那行是**机器可读**的）：
 *   // dev/xxx-probe.mjs -- 一句话说明
 *   // args: -Hwnd <句柄> -Delta <-120>
 *
 * 为什么需要 `args:`：R35 实测自动发现的两个探针**都要命令行参数**，而"被发现"不等于
 * "知道怎么跑" —— 清单里只写一句说明，人还得逐个打开脚本看用法。有了这行，
 * `probe:'list'` 与 `all` 的"没跑"原因都能直接说清要什么。
 */
function headerOf(file) {
	let text = ''
	try {
		text = fs.readFileSync(file, 'utf8').slice(0, 2000)
	} catch {
		return { about: '', argsHint: '' }
	}
	let about = ''
	let argsHint = ''
	for (const line of text.split(/\r?\n/)) {
		const raw = line.trim()
		const m = /^\/\/+\s*(.+)$/.exec(raw)
		if (m === null) continue
		const body0 = m[1].trim()
		const am = /^args\s*[:：]\s*(.+)$/i.exec(body0)
		if (am !== null) {
			if (argsHint === '') argsHint = am[1].trim().slice(0, 140)
			continue
		}
		if (about !== '') continue
		// 首行常常是 `dev/xxx-probe.mjs -- 说明` 或 `xxx-probe.mjs -- 说明`，把文件名前缀去掉，只留人话。
		const body = body0.replace(/^(?:dev[/\\])?[\w.-]+\.mjs\s*(?:--|—|·)\s*/, '').trim()
		if (body === '') continue
		about = body.length > 90 ? body.slice(0, 90) + '…' : body
	}
	return { about, argsHint }
}

/**
 * 扫描 `dev/*-probe.mjs`，返回**没被显式表覆盖**的那些。
 * 被显式表覆盖的（同 basename）不登记 —— 否则 `all` 会把同一个脚本跑两遍。
 * @param {{dir?:string}} [opts]
 * @returns {{found: Array<{id:string, script:string, about:string, timeoutSec:number, auto:true}>,
 *   covered: string[], skipped: Array<{file:string, why:string}>}}
 */
export function discoverProbes(opts = {}) {
	const dir = typeof opts.dir === 'string' && opts.dir !== '' ? opts.dir : DEV_DIR
	const covered = Object.values(PROBES).map((d) => path.basename(String(d.script)))
	const coveredSet = new Set(covered)
	const found = []
	const skipped = []
	let names = []
	try {
		names = fs.readdirSync(dir)
	} catch (error) {
		return { found, covered, skipped: [{ file: dir, why: '读不了目录：' + String(error?.message ?? error) }] }
	}
	for (const name of names.slice().sort()) {
		if (!PROBE_FILE.test(name)) continue
		if (coveredSet.has(name)) {
			skipped.push({ file: name, why: '已由显式探针覆盖' })
			continue
		}
		const file = path.join(dir, name)
		try {
			if (!fs.statSync(file).isFile()) continue
		} catch {
			continue
		}
		const header = headerOf(file)
		found.push({
			id: name.replace(PROBE_FILE, ''),
			script: path.relative(PLUGIN_ROOT, file).split(path.sep).join('/'),
			about: header.about || `自动发现的探针（${name}）`,
			argsHint: header.argsHint,
			needsArgs: header.argsHint !== '',
			timeoutSec: 240,
			auto: true,
		})
	}
	return { found, covered, skipped }
}

/**
 * 合并清单：显式表在前（声明顺序），自动发现的名按名排序在后。
 * `needsArgs` / `argsHint` 是给人看的（`probe:'list'` 与 `all` 的"没跑"原因），不影响执行。
 * @param {{dir?:string}} [opts]
 * @returns {Array<{name:string, script:string, args:string[], timeoutSec:number, about:string,
 *   heavy:boolean, auto:boolean, needs:string, argsHint:string, needsArgs:boolean}>}
 */
export function listProbes(opts = {}) {
	const entries = Object.entries(PROBES).map(([name, def]) => {
		const fixedArgs = Array.isArray(def.args) ? def.args.map(String) : []
		const argsHint = String(def.argsHint ?? (fixedArgs.length > 0 ? fixedArgs.join(' ') : ''))
		return {
			name,
			script: String(def.script),
			args: fixedArgs,
			timeoutSec: Number.isFinite(Number(def.timeoutSec)) ? Number(def.timeoutSec) : 240,
			about: String(def.about ?? ''),
			heavy: def.heavy === true,
			auto: false,
			needs: String(def.needs ?? ''),
			argsHint,
			needsArgs: argsHint !== '',
		}
	})
	const taken = new Set(entries.map((e) => e.name))
	for (const item of discoverProbes(opts).found) {
		if (taken.has(item.id)) continue
		entries.push({
			name: item.id,
			script: item.script,
			args: [],
			timeoutSec: item.timeoutSec,
			about: item.about,
			heavy: false,
			auto: true,
			needs: '',
			argsHint: item.argsHint ?? '',
			needsArgs: item.needsArgs === true,
		})
		taken.add(item.id)
	}
	return entries
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
 * 把一次探针结果收敛成一个"为什么不是绿"的短码（给聚合表用）。
 *
 * 约定（R35）：**退出码 2 = 环境挡住**（夹具被盖住 / 窗口上不了屏），
 * 与产品回归（1）分开 —— 两者都是红，但**处置方向相反**：
 * 一个是去改代码，一个是挪开挡着的窗口再跑。混成一个红会让人往错的方向查。
 */
export function reasonOf(res) {
	if (res === null || typeof res !== 'object') return 'error'
	if (res.timedOut === true) return 'timeout'
	if (Number(res.exitCode) === 2) return 'env'
	if (Number(res.failed) > 0) return 'failed'
	if (Number(res.passed) === 0) return 'zero-checks'
	if (Number(res.exitCode) !== 0) return 'exit'
	return res.ok === true ? 'ok' : 'error'
}

/**
 * 跑一个探针。
 * @param {{probe:string, args?:string[], timeoutSec?:number}} opts
 * @returns {Promise<{ok:boolean, probe:string, passed:number, failed:number, exitCode:number|null,
 *   timedOut:boolean, failures:string[], reason:string, seconds:number, text:string}>}
 */
export async function runProbe(opts = {}) {
	const name = String(opts.probe ?? '')
	const def = PROBES[name]
	if (def === undefined) {
		const known = listProbes({ dir: opts.dir })
			.map((e) => e.name)
			.join(' / ')
		return {
			ok: false,
			probe: name,
			passed: 0,
			failed: 0,
			exitCode: null,
			timedOut: false,
			failures: [],
			reason: 'unknown',
			seconds: 0,
			tail: [],
			stderr: [],
			text: `未知探针 "${name}"（单跑只认显式探针表；一次跑多个请用 probe:'all'）。可用：${known}`,
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
		return {
			ok: false,
			probe: name,
			passed: 0,
			failed: 0,
			exitCode: null,
			timedOut: false,
			failures: [],
			reason: 'error',
			seconds: 0,
			tail: [],
			stderr: [],
			text: `起不来：${String(error?.message ?? error)}`,
		}
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
	const provisional = { ok: false, passed: counted.passed, failed: counted.failed, exitCode: done.exitCode, timedOut: done.timedOut === true }
	const reason = reasonOf({ ...provisional, ok: counted.failed === 0 && done.timedOut !== true && done.exitCode === 0 && counted.passed > 0 })
	const ok = reason === 'ok'
	const tail = out.trim().split(/\r?\n/).slice(-12).join('\n')
	const verdict =
		reason === 'timeout'
			? `超时（${timeoutSec}s 被杀）—— **不算通过**`
			: reason === 'env'
				? `**环境挡住（退出码 2）** —— 不算通过，但**不是产品回归**：夹具多半被别的窗口盖住/没上屏。挪开挡着的窗口再跑。`
				: reason === 'zero-checks'
					? `退出码 ${done.exitCode}，但**一行 PASS/FAIL 都没打印** —— 根本没跑到断言，**不算通过**`
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
		reason,
		seconds,
		// 聚合时**只在失败那条**打印尾巴：判"环境还是产品"靠的就是 target:/leaf at centre: 这类行。
		tail: tail.split(/\r?\n/).slice(-10),
		stderr: err.trim() === '' ? [] : err.trim().split(/\r?\n/).slice(-6),
		text,
	}
}

/**
 * **全跑聚合**（R35）。`probe:'all'` 走这里；也可以点名跑一串。
 *
 * 默认集合 = 显式表里非重活的 + 自动发现的（`includeAuto` 可关），
 * **重活永远排在最后**（hosttest 排第一但要是先跑它，前面 10 分钟里什么都看不到）。
 *
 * @param {{probes?:string|string[], includeHeavy?:boolean, includeAuto?:boolean, stopOnFail?:boolean,
 *   timeoutSec?:number, entries?:Array, runner?:Function, dir?:string}} [opts]
 */
export async function runProbes(opts = {}) {
	const entries = Array.isArray(opts.entries) ? opts.entries : listProbes({ dir: opts.dir })
	const includeHeavy = opts.includeHeavy === true
	// ⚠️ R35 实测教训：`dev/` 里被自动发现的两个探针（auto-wheel / postwheel）**都需要命令行参数**，
	// 不带参数跑只会得到无意义的结果。所以自动发现的**默认不进 all**：清单里有、点名能跑，
	// 但要进 all 得显式 includeAuto:true。发现 ≠ 知道怎么跑。
	const includeAuto = opts.includeAuto === true
	const stopOnFail = opts.stopOnFail === true
	const runner = typeof opts.runner === 'function' ? opts.runner : runProbe
	const wanted = opts.probes
	const skipped = []

	let picked
	if (wanted === undefined || wanted === null || wanted === '' || wanted === 'all') {
		picked = []
		for (const e of entries) {
			if (e.heavy === true && !includeHeavy) {
				skipped.push({ name: e.name, why: '重活（约 10 分钟），默认不跑；要跑给 includeHeavy:true' })
				continue
			}
			if (e.auto === true && !includeAuto) {
				const hint = String(e.argsHint ?? '')
				skipped.push({
					name: e.name,
					why: hint === '' ? '自动发现的探针（跑法见脚本头注释）；点名跑或 includeAuto:true' : `**需要参数**：${hint} —— 点名跑并带 args，或 includeAuto:true`,
				})
				continue
			}
			picked.push(e)
		}
	} else {
		const names = (Array.isArray(wanted) ? wanted.map(String) : String(wanted).split(',')).map((s) => s.trim()).filter((s) => s !== '')
		const missing = []
		picked = []
		for (const n of names) {
			const hit = entries.find((e) => e.name === n)
			if (hit === undefined) missing.push(n)
			else picked.push(hit)
		}
		if (missing.length > 0) {
			return {
				ok: false,
				error: `未知探针 ${missing.join(' / ')}`,
				probes: [],
				passed: 0,
				failed: missing.length,
				totalMs: 0,
				skipped,
				text: `未知探针 "${missing.join('" / "')}"。可用：${entries.map((e) => e.name).join(' / ')}（或 probe:'all' / probe:'list'）`,
			}
		}
	}
	// 重活挪到最后：保留组内原有顺序。
	picked = [...picked.filter((e) => e.heavy !== true), ...picked.filter((e) => e.heavy === true)]
	if (picked.length === 0) {
		return { ok: true, probes: [], passed: 0, failed: 0, totalMs: 0, skipped, text: '没有可跑的探针（清单为空，或被 includeHeavy/includeAuto 过滤光了）。' }
	}

	const started = Date.now()
	const results = []
	for (const entry of picked) {
		const res = await runner({
			probe: entry.name,
			args: Array.isArray(entry.args) ? entry.args : [],
			timeoutSec: Number.isFinite(Number(opts.timeoutSec)) && Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) : entry.timeoutSec,
		})
		const reason = typeof res?.reason === 'string' && res.reason !== '' ? res.reason : reasonOf(res)
		results.push({
			probe: entry.name,
			ok: res?.ok === true,
			passed: Number(res?.passed) || 0,
			failed: Number(res?.failed) || 0,
			reason,
			seconds: Number.isFinite(Number(res?.seconds)) ? Number(res.seconds) : 0,
			heavy: entry.heavy === true,
			auto: entry.auto === true,
			failures: Array.isArray(res?.failures) ? res.failures.map(String).slice(0, 5) : [],
			// 失败那条的**诊断尾巴**（target:/leaf at centre: 这类行）—— 判"环境还是产品"全靠它。
			// 通过的那几条不带，否则一张表会被几百行 stdout 撑爆。
			tail: res?.ok === true ? [] : Array.isArray(res?.tail) ? res.tail.map(String).slice(-10) : [],
			stderr: res?.ok === true ? [] : Array.isArray(res?.stderr) ? res.stderr.map(String).slice(-6) : [],
			// 单跑时 text 很有用；聚合里只留失败项与一行结论，避免几百行输出把工具结果撑爆。
			text: typeof res?.text === 'string' ? res.text : '',
		})
		if (res?.ok !== true && stopOnFail) {
			skipped.push(...picked.slice(results.length).map((e) => ({ name: e.name, why: 'stopOnFail：前面已经失败了' })))
			break
		}
	}

	const totalMs = Date.now() - started
	const passedChecks = results.reduce((n, r) => n + r.passed, 0)
	const failedChecks = results.reduce((n, r) => n + r.failed, 0)
	const bad = results.filter((r) => r.ok !== true)
	const ok = bad.length === 0 && results.length === picked.length
	const envCount = results.filter((r) => r.reason === 'env').length
	const lines = [
		`全跑 ${results.length} 个探针 · ${results.length - bad.length}/${results.length} 通过 · ${passedChecks} PASS / ${failedChecks} FAIL · ${Math.round(totalMs / 100) / 10}s`,
		...results.map((r) => {
			const mark = r.ok ? 'PASS' : r.reason === 'env' ? 'ENV ' : 'FAIL'
			const why = r.ok ? '' : r.reason === 'env' ? '  ← 环境挡住（不是产品回归）' : `  ← ${r.reason}`
			const tag = r.heavy ? ' [重活]' : r.auto ? ' [自动]' : ''
			return `  ${mark}  ${r.probe.padEnd(16)} ${String(r.passed).padStart(3)} PASS / ${String(r.failed).padStart(2)} FAIL  ${String(r.seconds).padStart(4)}s${tag}${why}`
		}),
	]
	if (envCount > 0) lines.push(`⚠️ 有 ${envCount} 个探针**因环境没判成**（env）—— 先挪开挡着窗口/换时机再跑，别照着它去改代码。`)
	for (const r of bad) {
		if (r.failures.length > 0) lines.push(`  ${r.probe} 的失败项：\n    ` + r.failures.join('\n    '))
		const tail = [...(r.stderr ?? []), ...(r.tail ?? [])].filter((s) => String(s).trim() !== '')
		if (tail.length > 0) lines.push(`  ${r.probe} 的诊断尾巴：\n    ` + tail.join('\n    '))
	}
	if (skipped.length > 0) lines.push('未跑：' + skipped.map((s) => `${s.name}（${s.why}）`).join('；'))

	return {
		ok,
		probes: results,
		passed: passedChecks,
		failed: failedChecks,
		totalMs,
		skipped,
		error: ok ? '' : `${bad.length} 个探针没过：` + bad.map((r) => `${r.probe}(${r.reason})`).join(', '),
		text: lines.join('\n'),
	}
}
