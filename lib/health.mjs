/**
 * lib/health.mjs — **换会话第一条命令**的后端：这套东西现在跑的是不是最新代码。
 *
 * 为什么需要它（R28）：这个插件最容易骗人的地方不是功能，是**"我改的代码到底生效了没有"**。
 * 三条路各有各的失效方式，而且都不报错：
 *   ① 宿主半边（`lib/*.mjs` / `tools.js`）改了**必须重启** —— 不重启就还是旧逻辑，
 *      而工具的表象完全正常（它只是"按旧代码"做事），这一轮就因此把"桥的假阴性"写到线上去过；
 *   ② 抓屏助手（`ps/shooter.ps1` + `shotcore.ps1`）**不会自己重生** ——
 *      脚本改了、进程还是旧的（R25 加 `kind:'wheel'` 时踩过：老助手把请求当抓屏，失败后静默回落）；
 *   ③ 客户端（`client.js`）会热重载，但**不是立刻** —— 回执里的 `build`/`born` 才是答案。
 *
 * 这个文件只做一件事：把"文件时间 vs 进程时间 / 实例 born"摆在一起，给出
 * **要不要重启** 和一个能照做的下一步。它不修改任何东西。
 *
 * 所有判据都是纯函数可注入的（见 `runHealth(deps)`），所以自检不用真重启就能验它。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)
const PS_DIR = path.join(PLUGIN_ROOT, 'ps')
const CLIENT_FILE = path.join(PLUGIN_ROOT, 'client.js')
const TOOLS_FILE = path.join(PLUGIN_ROOT, 'tools.js')

/** 文件比进程新多少才算"需要重启"（同一秒内的写入不算；免得刚启动就报旧）。 */
const TOLERANCE_MS = 2000

/** 一个文件的 mtime（读不到 = 0，绝不抛）。 */
function mtimeOf(file) {
	try {
		return fs.statSync(file).mtimeMs
	} catch {
		return 0
	}
}

/** 某个目录下所有匹配文件（只一层）。 */
function listDir(dir, ext) {
	try {
		return fs
			.readdirSync(dir)
			.filter((n) => n.endsWith(ext))
			.map((n) => path.join(dir, n))
	} catch {
		return []
	}
}

/**
 * 纯函数：给定 [(名字, mtime)] 与"进程开始时刻"，返回比进程新的那些。
 * @param {Array<{name: string, mtime: number}>} entries
 * @param {number} sinceMs 进程开始时刻
 * @param {number} [tol] 容差
 */
export function staleSince(entries, sinceMs, tol = TOLERANCE_MS) {
	if (!(sinceMs > 0)) return []
	return entries
		.filter((e) => Number(e.mtime) > 0 && Number(e.mtime) > sinceMs + tol)
		.map((e) => ({ name: e.name, mtime: Number(e.mtime), ageMs: Math.round(Number(e.mtime) - sinceMs) }))
}

/** 从 client.js 里读出它自己的 build 标记（"我这份文件是哪一版"）。 */
export function readClientBuild(file = CLIENT_FILE) {
	try {
		const text = fs.readFileSync(file, 'utf8')
		const m = /build:\s*'(R\d+)'/.exec(text)
		return m === null ? '' : m[1]
	} catch {
		return ''
	}
}

/** 默认依赖（生产用；自检全部替换成替身）。 */
function realDeps() {
	return {
		now: () => Date.now(),
		uptimeMs: () => process.uptime() * 1000,
		statMtime: (file) => mtimeOf(file),
		libFiles: () => [TOOLS_FILE, ...listDir(HERE, '.mjs')],
		psFiles: () => listDir(PS_DIR, '.ps1'),
		clientBuild: () => readClientBuild(),
		async statuses() {
			const out = { shooter: null, overlay: null, instances: [], error: '' }
			try {
				const shooter = await import('./shooter.mjs')
				out.shooter = shooter.shooterStatus()
			} catch (error) {
				out.error += ' shooter: ' + String(error?.message ?? error)
			}
			try {
				const overlay = await import('./overlay.mjs')
				out.overlay = overlay.overlayStatus()
			} catch (error) {
				out.error += ' overlay: ' + String(error?.message ?? error)
			}
			try {
				const devtools = await import('./devtools.mjs')
				const dumps = devtools.listDumps(200, 'ai-result')
				const seen = new Map()
				for (const item of dumps) {
					if (!item.id) continue
					const prev = seen.get(item.id)
					if (prev === undefined || Number(item.born) > Number(prev.born)) {
						seen.set(item.id, { id: item.id, build: item.build || '', born: Number(item.born) || 0 })
					}
				}
				out.instances = [...seen.values()].sort((a, b) => b.born - a.born)
			} catch (error) {
				out.error += ' client: ' + String(error?.message ?? error)
			}
			return out
		},
		async displays() {
			try {
				const shot = await import('./shot.mjs')
				return await shot.displays()
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error), monitors: [] }
			}
		},
	}
}

const fmtAge = (ms) => {
	const s = Math.max(0, Math.round(Math.abs(ms) / 1000))
	if (s < 90) return s + ' 秒'
	const m = Math.round(s / 60)
	if (m < 90) return m + ' 分钟'
	return Math.round(m / 60) + ' 小时'
}
const hhmmss = (ms) => {
	if (!(ms > 0)) return '?'
	const d = new Date(ms)
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/**
 * 跑一次体检。
 * @param {object} [deps] 自检替换用；生产不传。
 * @returns {Promise<{ok:boolean, needRestart:boolean, hostStale:Array, helperStale:Array,
 *   clientStale:boolean, shooter:object|null, overlay:object|null, instances:Array,
 *   displays:object|null, uptimeMs:number, verdict:string, next:string, text:string, error:string}>}
 */
export async function runHealth(deps = {}) {
	const d = { ...realDeps(), ...deps }
	const now = d.now()
	const uptimeMs = d.uptimeMs()
	const hostStartedAt = now - uptimeMs
	const st = await d.statuses()
	const disp = await d.displays()

	// ① 宿主半边：lib/*.mjs + tools.js（改了必须重启，因为它们被 import 进宿主进程）
	const hostStale = staleSince(
		(await d.libFiles()).map((f) => ({ name: path.basename(f), mtime: d.statMtime(f) })),
		hostStartedAt
	)
	// ② 抓屏助手：只有**它自己真正读的那两个脚本**（助手不会自己重生 —— 最容易被忽略的一条）
	//
	// ⚠️ 这里是**白名单**，不是黑名单（R30 / R32 / R33 三次误判换来的）：
	//   - R30：`overlay_host.ps1` 会盯着自己的 `.ps1` 自己重生，算进来就一边报"要重启"、
	//     一边给错理由；
	//   - R32：`recframe.ps1` 是一次性进程（每次录屏新起一个）；
	//   - R33：`rec.ps1` 也是**每次调用新起**的（录屏的 info/frame/strip/… 全走它）——
	//     黑名单漏了它，体检就报"抓屏助手跑的是旧脚本（rec.ps1）"，而实际上我刚刚
	//     用新代码抽帧成功过一次。**假红比不检查更糟**：它让人去重启一个不需要重启的东西。
	//
	// 真相很简单：常驻助手是 `shooter.ps1`，它 dot-source 了 `shotcore.ps1`。
	// 其余每一个 `ps/*.ps1` 都是**一次性进程**或**自己有重生机制**，改完立刻生效。
	const SHOOTER_SCRIPTS = new Set(['shooter.ps1', 'shotcore.ps1'])
	const OVERLAY_SCRIPTS = new Set(['overlay_host.ps1', 'overlay_poc.ps1'])
	const psAll = (await d.psFiles()).map((f) => ({ name: path.basename(f), mtime: d.statMtime(f) }))
	const psShooter = psAll.filter((f) => SHOOTER_SCRIPTS.has(f.name))
	const psOverlay = psAll.filter((f) => OVERLAY_SCRIPTS.has(f.name))
	const shooterSpawnAt = st.shooter !== null && Number(st.shooter.spawnMs) > 0 ? now - Number(st.shooter.spawnMs) : 0
	const helperStale = st.shooter !== null && st.shooter.alive === true ? staleSince(psShooter, shooterSpawnAt) : []
	// 覆盖层脚本比助手进程新 = 它会自己重生（不用重启）。只作提示，不算 needRestart。
	const overlaySpawnAt = st.overlay !== null && Number(st.overlay.spawnMs) > 0 ? now - Number(st.overlay.spawnMs) : 0
	const overlayScriptsNew = overlaySpawnAt > 0 ? psOverlay.filter((f) => f.mtime > overlaySpawnAt + TOLERANCE_MS) : []
	// ③ 客户端：两条独立判据，缺一不可 ——
	//    a) 它自己报的 build 与磁盘上的 build 不一致（需要人**记得**提版本号，会忘）；
	//    b) client.js 的 mtime 比这个实例**加载时刻**还新（不用任何人记得任何事）。
	//    实测（R28）：b 立刻抓出"改了 client.js 但没提版本号、运行中还是三小时前的实例"
	//    —— 当时 a 判不出来，因为 build 号谁都没改。
	const wantBuild = d.clientBuild()
	const clientMtime = d.statMtime(CLIENT_FILE)
	/**
	 * ⚠️ 只认**本宿主进程启动之后**加载的实例（R30 现场踩到）：
	 * 客户端实例是从 diag dump（`ai-result`）里读的，而那些 dump 是**历史证据**。DSH 刚重启
	 * 两分钟、客户端还没处理过任何命令时，最新的一封可能来自几小时前 —— 于是体检报
	 * "运行中是 R25"，而实际加载的是 R28。渲染进程只能在宿主之后加载，所以
	 * `born < 宿主启动时刻` 的实例**一定不是现在这个**；没得比对时就说"读不到"，
	 * 不要拿历史下结论（假红比不检查更糟）。
	 */
	const allInstances = st.instances || []
	const liveInstances = uptimeMs > 0 ? allInstances.filter((it) => Number(it.born) >= hostStartedAt - 5000) : allInstances
	const newest = liveInstances[0] || null
	const newestBorn = newest !== null ? Number(newest.born) || 0 : 0
	const buildMismatch = wantBuild !== '' && newest !== null && newest.build !== '' && newest.build !== wantBuild
	const fileNewer = clientMtime > 0 && newestBorn > 0 && clientMtime > newestBorn + TOLERANCE_MS
	const clientStale = buildMismatch || fileNewer

	const needRestart = hostStale.length > 0 || helperStale.length > 0
	const ok = (st.shooter === null || st.shooter.ready === true) && (st.overlay === null || st.overlay.ready === true) && !needRestart

	const lines = []
	lines.push('DSH 截图插件体检 · 宿主已跑 ' + fmtAge(uptimeMs) + (hostStartedAt > 0 ? '（' + hhmmss(hostStartedAt) + ' 起）' : ''))
	if (st.shooter !== null) {
		lines.push(
			'  抓屏助手  ' +
				(st.shooter.ready === true ? '✅ ready' : st.shooter.alive === true ? '⏳ alive,未就绪' : '❌ 没在跑') +
				'  pid=' + (st.shooter.pid || 0) +
				'  served=' + (st.shooter.served || 0) +
				'  lastMs=' + (st.shooter.lastMs || 0) +
				(st.shooter.spawnMs > 0 ? '  起了 ' + fmtAge(st.shooter.spawnMs) : '') +
				(st.shooter.error ? '  err=' + String(st.shooter.error).slice(0, 80) : '')
		)
	} else {
		lines.push('  抓屏助手  ⚠️ 拿不到状态' + (st.error ? '（' + st.error.trim().slice(0, 120) + '）' : ''))
	}
	if (st.overlay !== null) {
		lines.push('  覆盖层    ' + (st.overlay.ready === true ? '✅ ready' : st.overlay.alive === true ? '⏳ alive,未就绪' : '❌ 没在跑（下次框选会自己拉起）') + '  pid=' + (st.overlay.pid || 0) + '  calls=' + (st.overlay.calls || 0))
		if (overlayScriptsNew.length > 0) {
			lines.push('            ' + '覆盖层脚本已更新（' + overlayScriptsNew.map((f) => f.name).join('、') + '）—— 它盯着自己的 .ps1，下次框选自动用新代码，不用重启')
		}
	}
	lines.push('  代码      ' + (hostStale.length === 0 ? '✅ 宿主半边是最新的' : '❌ 宿主半边是旧的（这些文件比进程新：' + hostStale.map((f) => f.name + ' +' + fmtAge(f.ageMs)).join('、') + '）'))
	lines.push('            ' + (helperStale.length === 0 ? '✅ 抓屏助手跑的是最新脚本' : '❌ 抓屏助手跑的是旧脚本（' + helperStale.map((f) => f.name + ' +' + fmtAge(f.ageMs)).join('、') + '）—— 它不会自己重生'))
	if (wantBuild !== '') {
		const why = buildMismatch ? '磁盘上 ' + wantBuild + '，运行中是 ' + newest.build : fileNewer ? 'client.js 比这个实例新（' + fmtAge(clientMtime - newestBorn) + '）' : ''
		// 重启之后客户端**必然**还没有回执 —— 那不是异常，是"还没用过桥"。
		// 以前这里用 ⚠️，于是每次换会话的第一条命令都挂着一条看着像问题的警告（R38：改成 ℹ️ 并说清下一步）。
		const staleNote =
			newest === null && allInstances.length > 0
				? 'ℹ️ 本次宿主启动后还没用过桥（最后一次回执 ' + fmtAge(now - (Number(allInstances[0].born) || now)) + '前，属于上一次宿主）—— 正常；用一次 shot_bridge 就会更新'
				: 'ℹ️ 本次启动后还没有任何回执（客户端可能没加载本插件）—— 用一次 shot_bridge 试试；仍没有就查插件有没有加载'
		lines.push(
			'  客户端    ' +
				(clientStale
					? '❌ 还没热重载：' + why
					: newest === null
						? staleNote
						: '✅ 运行中 ' + newest.build + '（' + (newest.id || '?') + '，' + fmtAge(now - newestBorn) + '前加载）')
		)
	}
	if (disp !== null && disp.ok === true) {
		const v = disp.virtual || {}
		lines.push(
			'  显示器    ' + (disp.monitorCount || 0) + ' 台 · 虚拟屏幕 ' + (v.width || 0) + '×' + (v.height || 0) + ' @ ' + (v.left || 0) + ',' + (v.top || 0) +
				(disp.negativeOrigin ? ' · 负坐标原点' : '') + (disp.mixedDpi ? ' · 混合 DPI' : '')
		)
	}

	const verdict = needRestart
		? '需要重启 DSH' + (hostStale.length > 0 ? '（宿主半边有更新的文件）' : '') + (helperStale.length > 0 ? '（抓屏助手在跑旧脚本）' : '')
		: ok
			? '一切是最新的，可以直接干活'
			: '能跑，但助手还没就绪'
	/**
	 * 抓屏助手旧了也只能重启 —— 别想着"从自检进程里 stopShooter() 再 startShooter() 就能换代"。
	 * R29 实测过这条路走不通：`host_selfcheck` 跑在**另一个 node 进程**里（证据是助手自己的
	 * tag `<pid>-<rand>`：应用那个的前缀是插件宿主进程的 pid，不是自检进程的），它起的助手
	 * 跟着自检进程一起消失。见 `dev/refresh-shooter.mjs` 的文件头（那支脚本现在只做归属诊断）。
	 */
	const next = needRestart
		? '重启 DSH → shot_health({}) 复验 → shot_gate({tick:true})'
		: clientStale
			? '等 30–60 秒客户端热重载，再 shot_bridge({ops:[{op:"state"}], build:"' + wantBuild + '"})'
			: 'shot_gate({tick:true}) 跑闸门；要动客户端就 shot_bridge；要看多屏/DPI 就 shot_displays'
	lines.push('结论：' + verdict)
	lines.push('下一步：' + next)

	return {
		ok,
		needRestart,
		hostStale,
		helperStale,
		// 覆盖层脚本比助手进程新：它自己会重生，**不算 needRestart**（R30 的一次误判修正）。
		overlayScriptsNew: overlayScriptsNew.map((f) => f.name),
		clientStale,
		clientStaleWhy: clientStale ? (buildMismatch ? 'build-mismatch' : 'file-newer') : '',
		shooter: st.shooter,
		overlay: st.overlay,
		instances: st.instances || [],
		displays: disp,
		uptimeMs,
		verdict,
		next,
		text: lines.join('\n'),
		error: st.error || '',
	}
}
