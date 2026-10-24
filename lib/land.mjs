/**
 * lib/land.mjs — 收尾一步走：**自检 → 提交 → 推送 → 回证据**（R40）。
 *
 * 为什么做成工具：这一会话里每一轮的收尾都是同一串手工动作，而且每一步都踩过坑 ——
 *
 *   · 命令行 `git` 写入被 workspace-write 沙箱拒（`.git/index.lock` Permission denied），
 *     每轮要一次 `danger-full-access` 提权；
 *   · `pnpm`/`gh` 之类的推送辅助只推"HEAD ≠ 远端"的仓，**脏但 HEAD 相等会被静默跳过**；
 *   · 提交消息里的中文在命令行里容易被编码弄坏；
 *   · 收尾前该跑哪几项自检、各自的结论行长什么样，换会话要重新摸。
 *
 * 宿主进程里这些都不成立：没有工具沙箱、stdin 可以按 UTF-8 传中文、自检项就写在这里。
 * 默认 `dryRun:true`（只出计划），避免"一句话就把东西推上去了"。
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runScript } from './preflight.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)
/** 工作区根：插件目录的上一级（DSH-Plugin/<x> → DSH-Plugin → 工作区）。 */
export const WORKSPACE = path.dirname(path.dirname(PLUGIN_ROOT))

/** 提交前默认要跑的确定性自检（都很快；闸门那种 3 分钟的留给 shot_gate）。 */
export const LAND_CHECKS = [
	{ name: '静态契约 smoke', rel: path.join(WORKSPACE, '.tools', 'dsh-shot-smoke.mjs'), timeoutMs: 240_000, verdict: /^passed (\d+) \/ failed (\d+)/m },
	{ name: '探针库自检', rel: path.join(PLUGIN_ROOT, 'dev', 'probe-selftest.mjs'), timeoutMs: 240_000, verdict: /(\d+) PASS \/ (\d+) FAIL/m },
]

/** 跑一条 git 命令（宿主进程里，不受工具沙箱限制）。永不抛。 */
export function gitRun(args, opts = {}) {
	try {
		const stdout = execFileSync('git', args, {
			cwd: opts.cwd ?? PLUGIN_ROOT,
			input: opts.input,
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		return { ok: true, stdout: String(stdout ?? ''), stderr: '' }
	} catch (error) {
		return {
			ok: false,
			stdout: String((error && error.stdout) || ''),
			stderr: String((error && error.stderr) || (error && error.message) || error),
		}
	}
}

/** 当前仓状态：分支 / HEAD / 脏文件 / 是否与远端一致。 */
export function gitState(cwd = PLUGIN_ROOT) {
	const head = gitRun(['rev-parse', '--short', 'HEAD'], { cwd })
	if (head.ok !== true) return { ok: false, error: '不是 git 仓，或 git 不可用：' + head.stderr.split('\n')[0] }
	const branch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
	const porcelain = gitRun(['status', '--porcelain'], { cwd })
	const upstream = gitRun(['rev-parse', '--short', 'origin/' + (branch.stdout || '').trim()], { cwd })
	const files = String(porcelain.stdout || '')
		.split(/\r?\n/)
		.filter((l) => l.trim() !== '')
	return {
		ok: true,
		branch: (branch.stdout || '').trim(),
		head: (head.stdout || '').trim(),
		upstream: (upstream.stdout || '').trim(),
		dirty: files,
		inSync: upstream.ok === true && (upstream.stdout || '').trim() === (head.stdout || '').trim(),
	}
}

/**
 * 收尾一步走。
 * @param {{message?:string, body?:string|string[], runChecks?:boolean, dryRun?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, dryRun:boolean, committed:boolean, pushed:boolean, sha:string,
 *   files:string[], checks:Array, text:string, error:string}>}
 */
export async function land(opts = {}) {
	const dryRun = opts.dryRun !== false
	const runChecks = opts.runChecks !== false
	const message = String(opts.message ?? '').trim()
	const body = (Array.isArray(opts.body) ? opts.body : typeof opts.body === 'string' ? opts.body.split(/\r?\n/) : [])
		.map((l) => String(l).trim())
		.filter((l) => l !== '')
	const fail = (error, extra = {}) => ({ ok: false, dryRun, committed: false, pushed: false, sha: '', files: [], checks: [], error, text: error, ...extra })

	if (message === '') return fail('需要一句提交标题（message）—— 空标题会让历史没法检索。')
	const state = gitState()
	if (state.ok !== true) return fail(String(state.error || '读不到仓状态'))

	// ① 自检（除非显式关掉）：红了**不提交** —— 免得"提交了但其实是坏的"。
	const checks = []
	if (runChecks) {
		for (const c of LAND_CHECKS) {
			const r = await runScript(c.rel, [], c.timeoutMs)
			// R56：取**最后一条**结论行，不是第一条。探针库自检的输出里会引用聚合的样例行
			// （"flaky 6 PASS / 0 FAIL"），用 exec() 抓第一条会把样例当成结论 —— 实测出现过
			// "12 通过 / 0 失败" 这种既不等于真结论、又让整体判红的读数。
			const all = String(r.stdout || '').match(new RegExp(c.verdict.source, 'gm'))
			const m = all === null ? null : c.verdict.exec(all[all.length - 1])
			const ok = r.ok === true && m !== null && Number(m[2]) === 0 && Number(m[1]) > 0
			checks.push({ name: c.name, ok, detail: m === null ? '没有结论行（退出码 ' + r.exitCode + '）' : m[1] + ' 通过 / ' + m[2] + ' 失败', ms: r.ms })
		}
		const red = checks.filter((c) => c.ok !== true)
		if (red.length > 0) {
			const text = ['自检没过，**没有提交**：', ...red.map((c) => 'FAIL ' + c.name + ' — ' + c.detail)].join('\n')
			return { ok: false, dryRun, committed: false, pushed: false, sha: state.head, files: state.dirty, checks, error: '自检失败', text }
		}
	}

	const full = [message, ...(body.length === 0 ? [] : ['', ...body])].join('\n')
	const sha = gitRun(['rev-parse', '--short', 'HEAD']).stdout.trim()
	const plan = [
		'收尾计划（' + (dryRun ? 'dryRun，不动任何东西' : '真执行') + '）：',
		'  仓      ' + PLUGIN_ROOT + ' @ ' + state.branch + ' · HEAD ' + state.head + (state.inSync ? '（与远端一致）' : '（与远端不一致）'),
		'  脏文件  ' + (state.dirty.length === 0 ? '无' : state.dirty.length + ' 个：' + state.dirty.slice(0, 8).join('、') + (state.dirty.length > 8 ? ' …' : '')),
		'  自检    ' + (checks.length === 0 ? '跳过' : checks.map((c) => (c.ok ? 'PASS ' : 'FAIL ') + c.name + '（' + c.detail + '）').join(' · ')),
		'  提交    ' + message,
		...(body.length === 0 ? [] : body.map((l) => '          ' + l)),
	].join('\n')

	if (dryRun) return { ok: true, dryRun: true, committed: false, pushed: false, sha, files: state.dirty, checks, error: '', text: plan + '\n（dryRun：确认无误后传 dryRun:false 才真的提交推送）' }

	// ② 提交（中文走 stdin，避免命令行编码问题）。
	let committed = false
	if (state.dirty.length > 0) {
		const add = gitRun(['add', '-A'])
		if (add.ok !== true) return fail('git add 失败：' + add.stderr.split('\n').slice(0, 2).join(' '), { checks })
		const commit = gitRun(
			['-c', 'user.name=' + (process.env.DSH_GIT_NAME || 'DSH'), '-c', 'user.email=' + (process.env.DSH_GIT_EMAIL || 'dsh@local'), 'commit', '-F', '-'],
			{ input: full }
		)
		if (commit.ok !== true) return fail('git commit 失败：' + commit.stderr.split('\n').slice(0, 3).join(' '), { checks })
		committed = true
	}

	// ③ 推送（HEAD 已经在远端时 git 会说 Everything up-to-date，不算失败）。
	const push = gitRun(['push', 'origin', 'HEAD'])
	const after = gitState()
	const pushed = push.ok === true && after.ok === true && after.inSync === true
	const text = [
		plan,
		'',
		committed ? '✅ 已提交' : '（没有改动，跳过提交）',
		pushed ? '✅ 已推送（远端 = ' + after.head + '）' : '❌ 推送没成功：' + (push.stderr || push.stdout || '').split('\n').filter((l) => l.trim() !== '').slice(-2).join(' '),
		'   sha  ' + (after.ok === true ? after.head : sha),
	].join('\n')
	return {
		ok: committed || pushed,
		dryRun: false,
		committed,
		pushed,
		sha: after.ok === true ? after.head : sha,
		files: state.dirty,
		checks,
		error: pushed ? '' : 'push failed',
		text,
	}
}
