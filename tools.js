/**
 * tools.js — 给 AI 用的**无感抓屏**工具（宿主侧）。
 *
 * 用户原话：「AI要能够自己调用但是不影响我做别的事情」。这一句拆成三条硬约束：
 *
 *  1. **绝不抢前台、绝不移动用户的窗口。** 所以每条路径都带 `noRestore`，
 *     也从不调用 SetForegroundWindow。抓的是屏幕/窗口的像素，不是焦点。
 *  2. **绝不弹覆盖层。** 覆盖层只由人触发（点按钮 / 按热键）。AI 拿一张图不该把用户的
 *     屏幕糊上一层遮罩 —— 那是"影响我做别的事情"最直接的形式。
 *     图要落到输入框时走 `deliver` 队列，客户端在后台贴，不抢焦点。
 *  3. **结果要能被 AI 真的用上。** 返回文件路径而不是几 MB base64：AI 那边可以直接
 *     读这个文件，比把一个 dataUrl 塞进工具结果里省得多，也留着可复用。
 *
 * 坐标口径（踩过）：`-Rect` 要的是**屏幕物理像素**，而且 capture.ps1 自己会
 * SetProcessDPIAware，所以给它的矩形必须是物理像素。窗口几何一律走 `hwnd`，
 * 让 capture.ps1 在自己的进程里解析 —— Node 这边不是 DPI-aware，自己算会差 1.25 倍。
 */

import path from 'node:path'

import { capture, displays, imageStats, listWindows, PLUGIN_ROOT, recorderInventory, reapOrphanRecorder, toDataUrl } from './lib/shot.mjs'
import { queueDeliver } from './lib/bus.mjs'
import { gateRun, bridgeStatus, bridgeSend, bridgeResults, WORKSPACE } from './lib/devtools.mjs'
import { preflightRun } from './lib/preflight.mjs'
import { land } from './lib/land.mjs'
import { runHealth } from './lib/health.mjs'
import { colorFacts, diffRatio, meanLuma, parseColor, readPng } from './lib/pixels.mjs'
import { listProbes, PROBES, runProbe, runProbes } from './lib/probes.mjs'

/** 把任意值收敛成 lossless JSON（宿主对工具输出会做往返校验，undefined 会让整次调用失败）。 */
function lossless(value) {
	try {
		return JSON.parse(JSON.stringify(value))
	} catch {
		return null
	}
}

/** 工具统一输出声明：对象 schema + 文本渲染。 */
const TOOL_OUTPUT = {
	schema: { type: 'object' },
	render: (_args, value) => {
		if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
			return [{ type: 'text', text: value.text }]
		}
		let fallback
		try {
			fallback = JSON.stringify(value, null, 2)
		} catch {
			fallback = String(value)
		}
		return [{ type: 'text', text: fallback === undefined ? '(无输出)' : fallback }]
	},
}

const RESULT_PROPERTIES = {
	ok: { type: 'boolean' },
	path: { type: 'string' },
	width: { type: 'number' },
	height: { type: 'number' },
	range: { type: 'string' },
	hwnd: { type: 'number' },
	method: { type: 'string' },
	fallback: { type: 'string' },
	attached: { type: 'boolean' },
	ms: { type: 'number' },
	error: { type: 'string' },
	text: { type: 'string' },
	// R35：探针聚合（`shot_probe` 的 all / list 两种模式）
	mode: { type: 'string' },
	passed: { type: 'number' },
	failed: { type: 'number' },
	checks: { type: 'array' },
	reason: { type: 'string' },
	probes: { type: 'array' },
	probeCount: { type: 'number' },
	totalMs: { type: 'number' },
}

function num(v) {
	const n = Number(v)
	return Number.isFinite(n) ? Math.trunc(n) : 0
}

/**
 * 把 (x,y,w,h) 收成一个 "x,y,w,h"。全为 0/缺省时返回空串（= 不用矩形）。
 * @returns {{rect: string, error: string}}
 */
function rectOf(args) {
	const x = num(args.x)
	const y = num(args.y)
	const w = num(args.w)
	const h = num(args.h)
	const anyGiven = [args.x, args.y, args.w, args.h].some((v) => v !== undefined && v !== null && v !== '')
	if (!anyGiven) return { rect: '', error: '' }
	if (w <= 0 || h <= 0) return { rect: '', error: 'x/y/w/h 必须四个一起给，且 w、h 要大于 0' }
	return { rect: `${x},${y},${w},${h}`, error: '' }
}

/**
 * 造出这个插件的工具定义。
 * @param {{listWindows?: Function}} [deps] 便于自检注入替身
 */
export function buildShotTools(deps = {}) {
	const listFn = typeof deps.listWindows === 'function' ? deps.listWindows : listWindows
	const capFn = typeof deps.capture === 'function' ? deps.capture : capture
	const dispFn = typeof deps.displays === 'function' ? deps.displays : displays
	const statsFn = typeof deps.imageStats === 'function' ? deps.imageStats : imageStats
	const healthFn = typeof deps.health === 'function' ? deps.health : runHealth
	// R52：shot_reap 的两半都能注入 —— 自检靠它验"预览/apply/名字判据"而不真的 taskkill。
	const inventoryFn = typeof deps.recorderInventory === 'function' ? deps.recorderInventory : recorderInventory
	const reapFn = typeof deps.reapRecorder === 'function' ? deps.reapRecorder : reapOrphanRecorder
	// R35：探针清单与单跑实现都能注入 —— 自检靠它验"聚合/发现"的逻辑而不真的 spawn。
	const probeEntriesFn = typeof deps.probeEntries === 'function' ? deps.probeEntries : () => listProbes()
	const probeRunner = typeof deps.probeRunner === 'function' ? deps.probeRunner : undefined

	return [
		/**
		 * **换会话第一条命令**（R28）。
		 *
		 * 这个插件最容易骗人的地方不是功能，是"我改的代码到底生效了没有"：宿主半边改了要重启、
		 * 抓屏助手不会自己重生、客户端热重载有延迟 —— 三条都不报错，只是**静默按旧代码办事**
		 * （R25 就因此在线上留过一个"桥的假阴性"）。这个工具把"文件时间 vs 进程/实例时间"
		 * 摆在一起，直接回答**要不要重启**。
		 */
		{
			name: 'shot_health',
			description:
				'截图插件体检（换会话第一条命令）：两个常驻助手是否就绪、**宿主半边/抓屏助手/客户端分别是不是最新代码**、' +
				'显示器与 DPI，最后给一句"要不要重启 DSH"和一个能照做的下一步。' +
				'它靠"文件时间 vs 进程/实例时间"判断陈旧，所以能答出"我改了代码但没生效"这类只有重启才会消失的问题。只读。',
			parameters: { type: 'object', properties: {} },
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						needRestart: { type: 'boolean' },
						verdict: { type: 'string' },
						next: { type: 'string' },
						hostStale: { type: 'array' },
						helperStale: { type: 'array' },
						clientStale: { type: 'boolean' },
						shooter: { type: 'object' },
						overlay: { type: 'object' },
						instances: { type: 'array' },
						displays: { type: 'object' },
						uptimeMs: { type: 'number' },
						error: { type: 'string' },
						text: { type: 'string' },
					},
				},
				render: TOOL_OUTPUT.render,
			},
			async execute() {
				const res = await healthFn()
				return {
					ok: res.ok === true,
					needRestart: res.needRestart === true,
					verdict: String(res.verdict || ''),
					next: String(res.next || ''),
					hostStale: lossless(res.hostStale || []),
					helperStale: lossless(res.helperStale || []),
					clientStale: res.clientStale === true,
					shooter: lossless(res.shooter || {}),
					overlay: lossless(res.overlay || {}),
					instances: lossless(res.instances || []),
					displays: lossless(res.displays === null || res.displays === undefined ? {} : res.displays),
					uptimeMs: Number(res.uptimeMs) || 0,
					error: String(res.error || ''),
					text: String(res.text || ''),
				}
			},
		},
		/**
		 * **R52：录制残留体检 + 清理**（把 R51 的"孤儿 ffmpeg"从"下次起录才顺手清"变成能主动查）。
		 *
		 * 宿主崩溃/重启时 `recordStop` 不会跑，而 ffmpeg 不会跟着退出 —— 它会一直往
		 * `.cache/rec` 写，没有句柄、没有界面入口。换会话/接手时先跑这一条：
		 * 默认只读，`apply:true` 才真的按三步判据清理（活得着 → 仍叫 ffmpeg.exe → taskkill）。
		 */
		{
			name: 'shot_reap',
			description:
				'录制残留体检（只读）+ 可选清理：回答"有没有一段没人管的录制还在写盘"。' +
				'给出内存里在不在录、rec/current.json 记的是谁（pid/文件/多久前）、那个 pid 还活着吗、' +
				'.cache/rec 里堆了几个 mp4 / 总共多大 / 最新那个。' +
				'`apply:true` 才真的清理 —— 判据与起录前那道相同：pid 活着、且现在仍是 ffmpeg.exe（防 pid 复用）才 taskkill。' +
				'宿主崩溃/重启后 ffmpeg 不跟着退出，这条就是兜底；换会话接手先跑一次。',
			parameters: {
				type: 'object',
				properties: {
					apply: {
						type: 'boolean',
						description: '默认 false 只体检；true 才真的清理残留录制（只杀 ffmpeg.exe，不杀别的进程）。',
					},
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						apply: { type: 'boolean' },
						recording: { type: 'boolean' },
						state: { type: 'object' },
						alive: { type: 'boolean' },
						name: { type: 'string' },
						pid: { type: 'number' },
						file: { type: 'string' },
						staleMs: { type: 'number' },
						rec: { type: 'object' },
						reap: { type: 'object' },
						verdict: { type: 'string' },
						next: { type: 'string' },
						text: { type: 'string' },
						error: { type: 'string' },
					},
				},
				render: TOOL_OUTPUT.render,
			},
			async execute(args) {
				const apply = args.apply === true
				const before = await inventoryFn()
				const canReap = before.state !== null && Number(before.state.pid) > 0
				const reap = apply && canReap ? await reapFn() : null
				const after = apply ? await inventoryFn() : null
				const shown = after === null ? before : after
				const mb = (n) => (Number(n) >= 1048576 ? (Number(n) / 1048576).toFixed(1) + ' MB' : Math.round(Number(n) / 1024) + ' KB')
				const age = (ms) => {
					const s = Math.max(0, Math.round(Number(ms) / 1000))
					return s < 90 ? s + ' 秒' : Math.round(s / 60) + ' 分钟'
				}
				const st = shown.state
				let verdict = ''
				if (shown.recording) verdict = '正在录（内存里有这一段，状态文件也应当在）'
				else if (st !== null && shown.alive) verdict = '⚠ 有一段没人管的录制还在写盘：current.json 的 pid 活着'
				else if (st !== null) verdict = '有一份过期的 current.json（pid 已不在），下次起录/停止会顺手清掉'
				else verdict = '没有残留录制'
				let next = '不用做别的'
				if (st !== null && shown.alive && !apply) next = '确认要清就 shot_reap({apply:true}) —— 只会杀 ffmpeg.exe'
				else if (st !== null && !shown.alive && !apply) next = 'shot_reap({apply:true}) 会把过期状态文件删掉'
				else if (apply) next = reap !== null && reap.reaped ? '已清掉，可以重新开始录' : '没有需要清的东西'
				const lines = [
					'录制残留检查',
					'  内存：' + (shown.recording ? '在录' : '没在录'),
					'  current.json：' +
						(st === null
							? '无'
							: `pid=${Number(st.pid) || 0} · ${shown.alive ? '活着（' + (shown.name || '名字未知') + '）' : '已不在'} · ${age(shown.staleMs)}前起 · ${String(st.file || '').split(/[\\/]/).pop()}`),
					`  缓存 rec/：${Number(shown.rec.files) || 0} 个 mp4 · 共 ${mb(shown.rec.bytes)}` +
						(shown.rec.newestName === '' ? '' : ` · 最新 ${shown.rec.newestName}（${mb(shown.rec.newestBytes)}）`),
					'  结论：' + verdict,
					'  下一步：' + next,
				]
				if (reap !== null) lines.push(`  清理：${reap.reaped ? '已终止 pid=' + reap.pid : '未杀（reason=' + reap.reason + '）'}`)
				return {
					ok: shown.ok === true && (reap === null || reap.ok !== false),
					apply,
					recording: shown.recording === true,
					state: shown.state === null ? {} : lossless(shown.state),
					alive: shown.alive === true,
					name: String(shown.name || ''),
					pid: shown.state === null ? 0 : Number(shown.state.pid) || 0,
					file: shown.state === null ? '' : String(shown.state.file || ''),
					staleMs: Number(shown.staleMs) || 0,
					rec: lossless(shown.rec || {}),
					reap: reap === null ? {} : lossless(reap),
					verdict,
					next,
					text: lines.join('\n'),
					error: String(shown.error || ''),
				}
			},
		},
		{
			name: 'screenshot',
			description:
				'无感抓屏：截取整个桌面、指定窗口、或一块屏幕矩形，落成 PNG 并返回文件路径。' +
				'全程不抢前台、不移动用户窗口、不弹任何界面，因此可以在用户做别的事情时安全调用。' +
				'想看内容就用 read_image 读返回的 path。',
			parameters: {
				type: 'object',
				properties: {
					range: {
						type: 'string',
						enum: ['desktop', 'window', 'rect'],
						description:
							'desktop=整个虚拟桌面（默认）；window=指定窗口，用 hwnd 或 title 选；rect=屏幕矩形，配合 x/y/w/h。',
					},
					hwnd: { type: 'number', description: 'range=window 时的窗口句柄（先用 screenshot_windows 拿）。' },
					title: { type: 'string', description: 'range=window 且没给 hwnd 时，按标题子串找窗口。' },
					x: { type: 'number', description: 'range=rect 时的屏幕物理像素 X。' },
					y: { type: 'number', description: 'range=rect 时的屏幕物理像素 Y。' },
					w: { type: 'number', description: 'range=rect 时的宽度（物理像素）。' },
					h: { type: 'number', description: 'range=rect 时的高度（物理像素）。' },
					hideSelf: {
						type: 'boolean',
						description: '抓之前把 DSH 窗口藏一下（只对 window 模式有意义）。默认 false —— 隐藏会动用户的窗口。',
					},
					deliver: {
						type: 'boolean',
						description: 'true 时同时把这张图**安静地**贴进 DSH 输入框并复制到剪贴板（不抢焦点）。默认 false。',
					},
					note: { type: 'string', description: 'deliver 时给这张图起的说明，会记进诊断。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const range = ['desktop', 'window', 'rect'].includes(raw.range) ? raw.range : 'desktop'
				const { rect, error: rectError } = rectOf(raw)
				if (rectError !== '') return { ok: false, error: rectError, text: '矩形参数不对：' + rectError }

				let mode = 'desktop'
				let hwnd = num(raw.hwnd)
				let resolvedTitle = ''

				if (range === 'window') {
					mode = 'window'
					if (hwnd <= 0) {
						const want = typeof raw.title === 'string' ? raw.title.trim() : ''
						if (want === '') return { ok: false, error: 'range=window 需要 hwnd 或 title', text: '请给 hwnd 或 title。' }
						const list = await listFn({ exclude: '', limit: 120 })
						const hit = (list.windows || []).find((w) => String(w.title).toLowerCase().includes(want.toLowerCase()))
						if (hit === undefined) {
							return { ok: false, error: 'no window matching: ' + want, text: '没有标题包含「' + want + '」的窗口。' }
						}
						hwnd = hit.hwnd
						resolvedTitle = hit.title
					}
				} else if (range === 'rect') {
					if (rect === '') return { ok: false, error: 'range=rect 需要 x/y/w/h', text: '请给 x/y/w/h。' }
					mode = 'desktop'
				}

				const res = await capFn({
					mode,
					// noRestore 永远为 true：这是"不影响我做别的事情"的底线。
					noRestore: true,
					hideSelf: raw.hideSelf === true && mode === 'window',
					hwnd,
					rect: range === 'rect' ? rect : '',
					// 窗口自绘优先：被挡住也能拍。实测这台机器上 PrintWindow 现在全返回
					// False，会自动回落成屏幕区域并在 fallback 里说明 —— 那种情况下
					// 拍到的可能是挡在前面的窗口，所以如实报出来，别让 AI 当成功。
					method: mode === 'window' ? 'print' : 'screen',
					timeoutMs: 30_000,
				})
				if (!res.ok) {
					return { ok: false, error: res.error || 'capture failed', text: '抓屏失败：' + (res.error || '未知错误') }
				}

				let attached = false
				if (raw.deliver === true) {
					try {
						const data = await toDataUrl(res.path, 6_000_000)
						queueDeliver({
							id: res.id,
							name: 'ai-' + String(res.id || 'shot') + '.png',
							dataUrl: data.dataUrl,
							note: typeof raw.note === 'string' ? raw.note : '',
						})
						attached = true
					} catch (error) {
						attached = false
					}
				}

				const lines = [
					'已抓屏：' + res.width + '×' + res.height + '（' + (range === 'window' ? '窗口' : range === 'rect' ? '矩形' : '整个桌面') + '）',
					'文件：' + res.path,
					res.hwnd > 0 ? '窗口句柄：' + res.hwnd + (resolvedTitle ? '（' + resolvedTitle + '）' : '') : '',
					res.method === 'print' ? '抓法：窗口自绘（被挡住也拍得到）' : '抓法：屏幕区域',
					res.method !== 'print' && mode === 'window'
						? '注意：窗口自绘失败，这张图是屏幕区域 —— 目标被挡住时会拍到挡在前面的窗口。'
						: '',
					attached ? '已排进队列：会安静地贴进输入框并复制（不抢焦点）。' : '',
					'用 read_image 读这个路径就能看到内容。',
				]
				return {
					ok: true,
					path: res.path,
					width: res.width,
					height: res.height,
					range,
					hwnd: res.hwnd || 0,
					method: res.method || '',
					fallback: res.method === 'print' ? '' : mode === 'window' ? 'print-failed' : '',
					attached,
					ms: res.ms || 0,
					error: '',
					text: lines.filter((l) => l !== '').join('\n'),
				}
			},
		},
		{
			name: 'screenshot_windows',
			description: '列出当前可以截的窗口（句柄、标题、位置尺寸、是否最小化）。配合 screenshot 的 range=window 用。只读。',
			parameters: {
				type: 'object',
				properties: {
					exclude: { type: 'string', description: '标题里含它就跳过。默认不过滤（连 DSH 自己一起列）。' },
					limit: { type: 'number', description: '最多返回几个，默认 60。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const res = await listFn({
					exclude: typeof raw.exclude === 'string' ? raw.exclude : '',
					limit: num(raw.limit) > 0 ? num(raw.limit) : 60,
				})
				if (!res.ok) return { ok: false, error: res.error || 'enumerate failed', windows: [], text: '枚举窗口失败：' + (res.error || '') }
				const wins = res.windows || []
				const lines = wins.map((w) => `${w.hwnd}\t${w.w}×${w.h}${w.min ? ' (最小化)' : ''}\t${w.title}`)
				return {
					ok: true,
					count: wins.length,
					windows: wins,
					error: '',
					text: ['共 ' + wins.length + ' 个窗口：', ...lines].join('\n'),
				}
			},
		},
		/**
		 * 开发期：**一条命令跑完全部闸门**。
		 *
		 * 为什么需要它：R20–R22 这三轮，同一套验证被拆成四个命令、分散在四份输出里，
		 * 每跑一轮要 2–4 分钟，还要人肉对四份输出判绿。而它们之间还有**顺序与隔离**要求
		 * （覆盖层自检必须把 `DSH_OVERLAY_DIR` 改道，否则会被应用常驻的那个助手抢走请求）。
		 * 这个工具把这些约束固化下来，返回一张结论表。
		 */
		{
			name: 'shot_gate',
			description:
				'dsh-screenshot 的验证闸门：一次跑完（静态契约 / 覆盖层端到端 / 一拍成本 / 长截图内容级 / **探针聚合** / 宿主全量）并给结论表。' +
				'默认跑前两项（秒级）；**`full:true` = 交付前的那一套**（这两项 + 一拍 + 探针聚合，约 5 分钟，一条命令代替"gate + probe all"两步）；' +
				'`host:true` 再加完整宿主自检（约 10 分钟，会起测试窗口，**不在 full 里**）。' +
				'覆盖层那一项自动把 DSH_OVERLAY_DIR 改道到 .tmp-shot-lab/gate-overlay，不会和正在运行的 DSH 抢请求目录。',
			parameters: {
				type: 'object',
				properties: {
					full: { type: 'boolean', description: '交付前的完整一套：静态契约 + 覆盖层 + 一拍成本 + 探针聚合（不含 hosttest）。默认 false。' },
					smoke: { type: 'boolean', description: '跑静态契约（.tools/dsh-shot-smoke.mjs）。默认 true。' },
					overlay: { type: 'boolean', description: '跑覆盖层+服务层端到端（dev/ovl-selftest.mjs，约 30s）。默认 true。' },
					tick: { type: 'boolean', description: '量一拍成本（.tools/dsh-shot-tick-bench.mjs）。默认 false（full 时自动开）。' },
					probes: { type: 'boolean', description: '跑探针聚合（等同 shot_probe all，5 个轻探针约 3–5 分钟）。默认 false（full 时自动开）。' },
					host: { type: 'boolean', description: '跑完整宿主自检（dev/hosttest.mjs，约 10 分钟，会起测试窗口）。默认 false。' },
					content: { type: 'string', description: '长截图内容级验收的矩形 "x,y,w,h"（需要桌面上一块可滚动的参照窗，如 testbed_refwin）。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const res = await gateRun({
					full: raw.full === true,
					smoke: raw.smoke !== false,
					overlay: raw.overlay !== false,
					tick: raw.tick === true,
					probes: raw.probes === true,
					host: raw.host === true,
					content: typeof raw.content === 'string' ? raw.content : '',
				})
				return {
					ok: res.ok === true,
					passed: res.passed,
					failed: res.failed,
					checks: lossless(res.checks),
					workspace: WORKSPACE,
					error: res.ok ? '' : 'see checks',
					text: res.text,
				}
			},
		},
		/**
		 * **改完宿主半边、还没重启时的一步验证**（R40）。
		 *
		 * 工具表是宿主启动期读的：`tools.js` / `lib/*.mjs` 改完、重启之前，运行中的宿主跑的还是
		 * 旧实现。想在重启前验"磁盘上的新代码对不对"，以前要记住两个脚本名
		 * （`dev/gate-full-hostrun.mjs` / `dev/all-probes-hostrun.mjs`）和 `host_selfcheck` 的参数 ——
		 * 换会话必重新摸（R35 / R37 各踩过一次）。这里把"跑哪个脚本 / 结论行长什么样"写死。
		 */
		{
			name: 'shot_preflight',
			description:
				'**重启 DSH 之前**用磁盘上的代码验一遍（宿主半边的改动，重启前唯一能验的办法）：' +
				'默认跑「探针库自检 + 交付闸门 full」；可点名 `probe-selftest` / `gate-full` / `all-probes` / `hosttest`（重活，点名才跑）。' +
				'每个预检项都在**独立子进程**里跑（脚本自己会 process.exit，绝不会带走宿主）。只读。',
			parameters: {
				type: 'object',
				properties: {
					what: {
						type: 'string',
						description: '预检项：all（默认=自检+full 闸门）/ probe-selftest / gate-full / all-probes / hosttest',
					},
					args: { type: 'array', items: { type: 'string' }, description: '透传给脚本的额外参数（一般不用）。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(raw) {
				const a = raw !== null && typeof raw === 'object' ? raw : {}
				const what = typeof a.what === 'string' ? a.what.trim() : 'all'
				const res = await preflightRun({ what })
				return {
					ok: res.ok === true,
					mode: 'preflight',
					text: res.text,
					checks: lossless(
						(res.items || []).map((i) => ({ name: i.name, ok: i.ok, ms: i.ms, detail: i.detail }))
					),
					plan: Array.isArray(res.plan) ? res.plan : [],
					workspace: WORKSPACE,
					error: res.ok === true ? '' : 'see checks',
				}
			},
		},
		/**
		 * **收尾一步走**（R40）：自检 → 提交 → 推送 → 回证据。
		 *
		 * 这一会话里每轮收尾都是同一串手工动作，且都踩过坑：命令行 git 写入被工具沙箱拒
		 * （每轮要一次提权）、推送辅助只推"HEAD ≠ 远端"、中文提交消息被命令行编码弄坏。
		 * 宿主进程里这些都不成立。默认 `dryRun:true` —— 先出计划，确认后才真提交。
		 */
		{
			name: 'shot_land',
			description:
				'收尾：跑确定性自检（静态契约 smoke + 探针库自检）→ `git add -A` → 提交（中文走 stdin）→ `git push` → 回 sha 与证据。' +
				'**默认 dryRun:true 只出计划**；自检红了**不提交**。传 `message`（标题）+ 可选 `body`（要点，字符串或数组）。' +
				'提交用 `-c user.name/user.email`（可用环境变量 DSH_GIT_NAME / DSH_GIT_EMAIL 覆盖），不依赖全局 git 身份。',
			parameters: {
				type: 'object',
				properties: {
					message: { type: 'string', description: '提交标题（必填）。' },
					body: { type: 'string', description: '提交要点：多行字符串（每行一条）或 JSON 数组。' },
					runChecks: { type: 'boolean', description: '提交前跑自检（默认 true；红了不提交）。' },
					dryRun: { type: 'boolean', description: 'true（默认）= 只出计划；false 才真的提交推送。' },
				},
				required: ['message'],
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(raw) {
				const a = raw !== null && typeof raw === 'object' ? raw : {}
				const res = await land({
					message: typeof a.message === 'string' ? a.message : '',
					body: a.body,
					runChecks: a.runChecks !== false,
					dryRun: a.dryRun !== false,
				})
				return {
					ok: res.ok === true,
					mode: res.dryRun ? 'land-dryrun' : 'land',
					sha: res.sha,
					committed: res.committed === true,
					pushed: res.pushed === true,
					files: lossless(Array.isArray(res.files) ? res.files : []),
					checks: lossless(Array.isArray(res.checks) ? res.checks : []),
					workspace: WORKSPACE,
					error: res.error,
					text: res.text,
				}
			},
		},
		/**
		 * 开发期：**驱动正在运行的 DSH**（AI 直连桥）。
		 *
		 * 客户端半边是这套插件里最难验证的一半（改了要热重载、沙箱注入不了鼠标、渲染进程
		 * 控制台 AI 读不到）。插件自己开了一条独立通道：客户端每 1.2s 拉
		 * `:8934/.tmp-vision/_ai/cmd.json`，执行 `ops`，把结果 POST 到 `:8935/_dump`。
		 * 这个工具把"起静态口 → 写命令 → 等回执 → 解析 dump"这一串固定下来，
		 * 于是"客户端改成什么样了"可以一条调用问清。
		 *
		 * ⚠️ 它会真的在用户的 DSH 里执行代码（默认 target=all 会让**每个并存的模块实例**都执行
		 * 一次）。只用它做只读/无害的探测；会开窗的调用请带 `selfTest`。
		 */
		{
			name: 'shot_bridge',
			description:
				'驱动正在运行中的 DSH 客户端（dsh-screenshot 的 AI 直连桥）：status 看通道与实例；' +
				'send 执行 ops（state / eval / click / menu / dom / longshot / reset）并等回执；results 读最近的回执。' +
				'longshot op 是长截图的程序入口：{op:"longshot",action:"begin",rect:"x,y,w,h",mode:"manual"}，' +
				'之后 add / status / finish / cancel —— 走的是用户点「长截图」时那条路（状态条、框线都会真的建）。' +
				'静态口不通时会自动起一个（node .tools/devserver.mjs 8934）。改完 client.js 用它验证客户端是否真的热重载了。',
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['status', 'send', 'results'], description: '默认 status。' },
					js: { type: 'string', description: 'send 的便捷写法：等价于 ops=[{op:"eval", js}]。脚本里可用 d = window.__dshotDebug。' },
					ops: {
						type: 'array',
						items: { type: 'object' },
						description: 'send 的完整写法：[{op:"state"},{op:"eval",js:"..."},{op:"click",text:"长截图"}]',
					},
					target: { type: 'string', description: "'all'（默认，所有并存实例）/ 'focused'（只有有焦点的那个）/ 具体实例 id。" },
					build: {
						type: 'string',
						description:
							'只发给这个 build 的实例（如 "R25"）。热重载后同一页会同时活着好几个版本的模块，' +
							'target=all 会让每个实例都执行一次（开窗的 op 于是开 8 个会话）—— 按 build 点名才只让新代码动。',
					},
					waitMs: { type: 'number', description: '等回执的上限，默认 25000。' },
					limit: { type: 'number', description: 'results 时最多返回几条，默认 10。' },
					tag: { type: 'string', description: "results 时按 tag 过滤（如 'ai-result' / 'region-result'）。" },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const action = ['send', 'results'].includes(raw.action) ? raw.action : 'status'
				if (action === 'status') {
					const st = await bridgeStatus()
					return {
						ok: st.ok === true,
						staticOk: st.staticOk === true,
						dumpOk: st.dumpOk === true,
						instances: lossless(st.instances),
						recent: lossless(st.recent),
						error: st.ok ? '' : 'bridge not fully reachable',
						text: st.text,
					}
				}
				if (action === 'results') {
					const res = bridgeResults({ limit: raw.limit, tag: raw.tag })
					return { ok: true, count: res.count, items: lossless(res.items), error: '', text: res.text }
				}
				let ops = Array.isArray(raw.ops) ? raw.ops : []
				if (ops.length === 0 && typeof raw.js === 'string' && raw.js.trim() !== '') ops = [{ op: 'eval', js: raw.js }]
				const res = await bridgeSend({
					ops,
					target: typeof raw.target === 'string' && raw.target !== '' ? raw.target : 'all',
					build: typeof raw.build === 'string' ? raw.build : '',
					waitMs: num(raw.waitMs) > 0 ? num(raw.waitMs) : 25_000,
				})
				return {
					ok: res.ok === true,
					seq: res.seq,
					instances: lossless(res.instances),
					results: lossless(res.results),
					ms: res.ms,
					error: res.error,
					text: res.text,
				}
			},
		},
		/**
		 * 显示器 / DPI / 负坐标体检（R26）。
		 *
		 * 为什么做成工具：整条抓屏链路按"虚拟屏幕 + 物理像素"写，而**这台机器只有一块
		 * 125% 屏** —— 单屏上写错也看不出来。真正会翻车的是：第二块屏在负坐标方向、
		 * 混合 DPI、窗口横跨两块屏。这个工具把这些事实与**越界矩形的实测**一起给你，
		 * 于是"插上第二块屏之后跑一条命令"就有结论。
		 */
		{
			name: 'shot_displays',
			description:
				'显示器/DPI/虚拟屏幕体检（只读）+ 越界矩形抓屏实测：给出虚拟屏幕矩形、每块屏的坐标与 DPI、' +
				'是否有负坐标原点/混合 DPI、当前前台窗口与光标；再用两块**故意越界**的矩形各抓一张，' +
				'报出实际落到的尺寸与像素统计（blackPct 区分"被正确裁剪"和"静默黑图"）。' +
				'接第二块显示器或改缩放比例之后跑它，就是多屏路径的验收。',
			parameters: {
				type: 'object',
				properties: {
					probe: { type: 'boolean', description: '是否跑越界抓屏实测（默认 true）。false = 只报显示器事实。' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						monitorCount: { type: 'number' },
						virtual: { type: 'object' },
						monitors: { type: 'array' },
						negativeOrigin: { type: 'boolean' },
						mixedDpi: { type: 'boolean' },
						foreground: { type: 'object' },
						probes: { type: 'array' },
						error: { type: 'string' },
						text: { type: 'string' },
					},
				},
				render: TOOL_OUTPUT.render,
			},
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const info = await dispFn()
				if (info.ok !== true) {
					return { ok: false, monitorCount: 0, virtual: {}, monitors: [], negativeOrigin: false, mixedDpi: false, foreground: {}, probes: [], error: info.error || 'displays failed', text: '显示器体检失败：' + (info.error || '未知错误') }
				}
				const v = info.virtual || { left: 0, top: 0, width: 0, height: 0 }
				const lines = [
					'显示器 ' + info.monitorCount + ' 台 · 虚拟屏幕 ' + v.width + '×' + v.height + ' @ ' + v.left + ',' + v.top +
						(info.negativeOrigin ? ' · **负坐标原点**（多屏 / 左上屏）' : '') +
						(info.mixedDpi ? ' · **混合 DPI**' : ''),
					...info.monitors.map((m, i) => `  #${i + 1} ${m.w}×${m.h} @ ${m.l},${m.t} · DPI ${m.dpiX}${m.dpiX > 0 ? '（' + Math.round((m.dpiX / 96) * 100) + '%）' : ''}`),
					info.foreground && info.foreground.ok
						? `  前台窗口：${String(info.foreground.title).slice(0, 40)} ${info.foreground.w}×${info.foreground.h} @ ${info.foreground.x},${info.foreground.y}`
						: '',
				].filter((l) => l !== '')

				const probes = []
				if (raw.probe !== false) {
					const y = Number(v.top) + 100
					const h = Math.max(60, Math.min(300, Number(v.height) - 200))
					// ① 左边越界：起点在虚拟屏幕左外 200px、宽 400 ⇒ 期望被裁到 200
					// ② 右边越界：起点离右边缘 200px、宽 400 ⇒ 同样期望 200
					// 这两种正是"多屏负坐标"/"跨屏取区域"会走到的裁剪分支。
					const cases = [
						{ name: 'left-out', x: Number(v.left) - 200, y, w: 400, h },
						{ name: 'right-out', x: Number(v.left) + Number(v.width) - 200, y, w: 400, h },
					]
					for (const c of cases) {
						const rect = `${c.x},${c.y},${c.w},${c.h}`
						const cap = await capFn({ mode: 'desktop', rect, noRestore: true, timeoutMs: 30_000 })
						let stats = { ok: false, width: 0, height: 0, meanLuma: 0, blackPct: 100, error: '' }
						if (cap.ok !== false && cap.path) {
							try {
								stats = await statsFn(cap.path)
							} catch (error) {
								stats = { ok: false, width: 0, height: 0, meanLuma: 0, blackPct: 100, error: String(error?.message ?? error) }
							}
						}
						const wantW = Math.max(0, Number(c.w) - 200)
						const one = {
							name: c.name,
							requested: rect,
							ok: cap.ok !== false,
							width: num(cap.width),
							height: num(cap.height),
							left: num(cap.left),
							top: num(cap.top),
							expectWidth: wantW,
							blackPct: Number(stats.blackPct) || 0,
							path: String(cap.path || ''),
							error: String(cap.error || stats.error || ''),
						}
						probes.push(one)
						lines.push(
							`  越界实测 ${c.name}：请求 ${rect} → 实得 ${one.width}×${one.height} @ ${one.left},${one.top}` +
								`（期望宽 ${wantW}）· blackPct=${one.blackPct}` +
								(one.width === wantW ? ' · 裁剪正确' : ' · **尺寸与期望不符**') +
								(one.blackPct >= 95 ? ' · **疑似黑图**' : '')
						)
					}
				}
				if (info.monitorCount < 2) {
					lines.push(
						'⚠️ 只有 1 台显示器：负坐标原点 / 混合 DPI **在这里无法验证**（本次只证明越界裁剪与"不静默黑图"）。' +
							'接第二块屏（或把某块改成 150%）后重跑：negativeOrigin / mixedDpi 会变 true，两张越界图仍应"裁剪正确且非黑"。'
					)
				}
				return {
					ok: true,
					monitorCount: info.monitorCount,
					virtual: lossless(v),
					monitors: lossless(info.monitors),
					negativeOrigin: info.negativeOrigin === true,
					mixedDpi: info.mixedDpi === true,
					foreground: lossless(info.foreground || {}),
					probes: lossless(probes),
					error: '',
					text: lines.join('\n'),
				}
			},
		},
		/**
		 * 开发期：**像素事实**（"那块红框到底画在不在"这一类问题）。
		 *
		 * 为什么需要它：R32/R33 两次被同一类问题绊住 —— **几何断言看不见的那一半**：
		 * 窗口 `Visible=true`、`-Info` 几何逐字段正确，屏幕上却一个像素都没有；或者"内部被盖住了"
		 * 只有逐像素比对能回答。以前每次现写一段 PNG 解码（dev/png.mjs 就是这么来的）。
		 *
		 * 三种问法（可以组合）：
		 *   rect + color  → 现场抓这块再找颜色，回答"画了没有、画在哪、有几个像素"
		 *   path + color  → 对着已有 PNG 做同样的事
		 *   against       → 两张图的差异占比（配 region 只看内部），回答"这块被改动了没有"
		 * 另外永远附带 meanLuma / blackPct：**"拍出来是黑图"是这个插件最经典的静默失败**。
		 */
		{
			name: 'shot_pixels',
			description:
				'像素探针（开发/验收用）：对**屏幕上一块矩形**或**一张已有 PNG** 给出可判定的像素事实 —— ' +
				'meanLuma/blackPct（判"黑图"）、某个颜色的像素数与外接框（判"边框画了没有/画在哪"）、' +
				'与另一张图的差异占比（可限定内部区域，判"这块有没有被盖住/改动"）。' +
				'给 rect 时会现场抓一张（不抢前台、不动用户窗口）。',
			parameters: {
				type: 'object',
				properties: {
					rect: { type: 'string', description: '现场抓屏的矩形 "x,y,w,h"（屏幕物理像素）。与 path 二选一。' },
					path: { type: 'string', description: '已有 PNG 的路径（绝对路径，或相对插件目录）。' },
					color: { type: 'string', description: '要找的颜色："#eb4034" / "235,64,52"。给了才做颜色统计。' },
					tol: { type: 'number', description: '颜色容差（默认 24，每通道）。' },
					region: { type: 'string', description: '只看这块子区域 "x,y,w,h"（图内坐标）。差异比对与颜色统计都听它。' },
					against: { type: 'string', description: '另一张 PNG 的路径：算出两张图在 region 内**不一致像素的占比**。' },
					diffTol: { type: 'number', description: '差异比对的每通道容差（默认 10）。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const parseRectText = (text) => {
					const [x, y, w, h] = String(text ?? '').split(',').map(Number)
					if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
					return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
				}
				const region = parseRectText(raw.region)
				let file = typeof raw.path === 'string' ? raw.path.trim() : ''
				let captured = null
				if (file === '' && typeof raw.rect === 'string' && raw.rect.trim() !== '') {
					captured = await capFn({ mode: 'desktop', rect: raw.rect.trim(), noRestore: true, timeoutMs: 30_000 })
					if (captured.ok === false) {
						return { ok: false, error: String(captured.error || 'capture failed'), text: '抓屏失败：' + String(captured.error || '未知错误') }
					}
					file = String(captured.path || '')
				}
				if (file === '') {
					return { ok: false, error: 'need rect or path', text: '要么给 rect（现场抓），要么给 path（已有图）。' }
				}
				const abs = file.startsWith('\\\\') || /^[a-zA-Z]:/.test(file) ? file : path.join(PLUGIN_ROOT, file)
				let img
				try {
					img = readPng(abs)
				} catch (error) {
					return { ok: false, error: String(error?.message ?? error), text: '读不了这张图：' + String(error?.message ?? error) }
				}
				const lines = [`图 ${path.basename(abs)} · ${img.width}×${img.height}（${region === null ? '整图' : `${region.w}×${region.h}@${region.x},${region.y}`}）`]
				const luma = meanLuma(img, region)
				const stats = await statsFn(abs).catch(() => null)
				const blackPct = stats === null ? 0 : Number(stats.blackPct) || 0
				lines.push(`  亮度 meanLuma=${luma.toFixed(1)} · blackPct=${blackPct.toFixed(1)}` + (luma < 8 ? ' · **疑似黑图**' : ''))

				const rgb = parseColor(raw.color)
				const color = rgb === null ? null : colorFacts(img, rgb, { tol: Number(raw.tol), region })
				if (color !== null) {
					lines.push(
						`  颜色 ${rgb.join(',')}：${color.count} 个像素` +
							(color.bbox === null ? '（**没找到**）' : ` · 外接框 ${color.bbox.w}×${color.bbox.h} @ ${color.bbox.x},${color.bbox.y}`)
					)
				} else if (typeof raw.color === 'string' && raw.color.trim() !== '') {
					lines.push(`  ⚠️ 颜色 "${raw.color}" 解析不了（用 #rrggbb 或 r,g,b）`)
				}

				let diff = null
				if (typeof raw.against === 'string' && raw.against.trim() !== '') {
					const other = raw.against.trim()
					const absOther = other.startsWith('\\\\') || /^[a-zA-Z]:/.test(other) ? other : path.join(PLUGIN_ROOT, other)
					try {
						diff = diffRatio(img, readPng(absOther), { tol: Number(raw.diffTol), region: region === null ? undefined : region })
						lines.push(`  与 ${path.basename(absOther)} 的差异：${(diff * 100).toFixed(1)}%${region === null ? '' : '（仅在 region 内）'}`)
					} catch (error) {
						lines.push('  ⚠️ 对照图读不了：' + String(error?.message ?? error))
					}
				}

				return {
					ok: true,
					path: abs,
					width: img.width,
					height: img.height,
					meanLuma: Math.round(luma * 10) / 10,
					blackPct,
					colorCount: color === null ? 0 : color.count,
					colorBbox: color === null || color.bbox === null ? {} : lossless(color.bbox),
					diff: diff === null ? -1 : Math.round(diff * 1000) / 1000,
					range: captured === null ? '' : String(raw.rect || ''),
					text: lines.join('\n'),
				}
			},
		},
		/**
		 * 开发期：**一条命令跑任意 dev 探针**（含"必须在宿主里跑"这条门槛）。
		 *
		 * 换会话最贵的一步是重新摸清"验证怎么跑"：每个探针都有正确跑法（宿主上下文、
		 * 自己的参数、超时要当失败）。这里固化成一张表。
		 *
		 * R35 补了两种模式：`probe:'list'`（清单 + 跑法 + 依赖，不 spawn）与
		 * `probe:'all'`（全跑聚合，重活默认排除且排最后）。
		 */
		{
			name: 'shot_probe',
			description:
				'跑 dsh-screenshot 的 dev 探针并给出 PASS/FAIL 汇总（"必须在宿主进程里跑"这条门槛天然满足）。三种问法：' +
				'① `probe:"<名字>"` 单跑；② `probe:"all"` **全跑并聚合**（重活 hosttest 默认不跑、给 includeHeavy 才跑且排最后）；' +
				'③ `probe:"list"` 只列清单与跑法（不 spawn）。显式探针：' +
				Object.keys(PROBES)
					.map((k) => `${k}（${PROBES[k].about}）`)
					.join('；') +
				'；另外 `dev/*-probe.mjs` 会被**自动发现**（不用再改 lib/probes.mjs）。' +
				'判据：超时、零检查（退出码 0 但一行 PASS/FAIL 都没打印）、非零退出都**如实算失败**。args 透传给探针脚本。',
			parameters: {
				type: 'object',
				properties: {
					probe: {
						type: 'string',
						description: '探针名 / "all"（全跑聚合）/ "list"（只列清单）：' + Object.keys(PROBES).join(' / ') + ' / all / list',
					},
					args: { type: 'array', items: { type: 'string' }, description: '额外的命令行参数（如 ["-App","qt"]），一般不用。' },
					timeoutSec: { type: 'number', description: '硬超时（秒）。默认取该探针自己的上限；聚合时对每个探针生效（会覆盖各自的上限）。' },
					includeHeavy: { type: 'boolean', description: 'probe:"all" 时是否包含重活（hosttest ≈10 分钟）。默认 false。' },
					includeAuto: { type: 'boolean', description: 'probe:"all" 时是否也跑自动发现的 dev/*-probe.mjs。**默认 false** —— 它们多半需要命令行参数（跑法见脚本头注释），无参跑只会有无意义结果。点名跑则不受此限。' },
					stopOnFail: { type: 'boolean', description: 'probe:"all" 时第一个失败就停（省时间、但看不到后面）。默认 false = 全跑完。' },
				},
				required: ['probe'],
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const mode = String(raw.probe ?? '').trim()
				const entries = probeEntriesFn()

				// ① 只列清单：不 spawn，也不依赖任何窗口/屏幕。
				if (mode === '' || mode === 'list') {
					const lines = [`探针清单（${entries.length} 个；"自动" = dev/*-probe.mjs 里发现的，没写进显式表）`]
					for (const e of entries) {
						const tag = e.heavy === true ? ' [重活]' : e.auto === true ? ' [自动]' : ''
						// 依赖（pyqt / JDK）与参数（认哪些开关）分开写：两者都不决定"能不能跑"，但都决定"怎么跑"。
						const extra = [e.needs ? `依赖 ${e.needs}` : '', e.argsHint ? `参数 ${e.argsHint}` : ''].filter((s) => s !== '').join(' · ')
						lines.push(`  ${e.name.padEnd(16)} ${String(e.timeoutSec).padStart(4)}s${tag}  ${e.about}${extra === '' ? '' : `（${extra}）`}`)
					}
					lines.push('跑一个：probe:"<名字>"（要参数的用 args 透传）；全跑：probe:"all"（重活加 includeHeavy:true）。')
					return {
						ok: true,
						mode: 'list',
						probeCount: entries.length,
						probes: lossless(
							entries.map((e) => ({
								name: e.name,
								about: e.about,
								timeoutSec: e.timeoutSec,
								heavy: e.heavy === true,
								auto: e.auto === true,
								needs: e.needs,
								argsHint: e.argsHint ?? '',
								needsArgs: e.needsArgs === true,
								script: e.script,
							}))
						),
						text: lines.join('\n'),
					}
				}

				// ② 全跑聚合。
				if (mode === 'all') {
					const agg = await runProbes({
						probes: 'all',
						includeHeavy: raw.includeHeavy === true,
						includeAuto: raw.includeAuto === true,
						stopOnFail: raw.stopOnFail === true,
						timeoutSec: Number(raw.timeoutSec),
						entries,
						runner: probeRunner,
					})
					return {
						ok: agg.ok === true,
						mode: 'all',
						passed: agg.passed,
						failed: agg.failed,
						totalMs: agg.totalMs,
						probeCount: Array.isArray(agg.probes) ? agg.probes.length : 0,
						checks: lossless((agg.probes ?? []).filter((p) => p.ok !== true).map((p) => ({ probe: p.probe, reason: p.reason, failures: p.failures }))),
						probes: lossless((agg.probes ?? []).map((p) => ({ probe: p.probe, ok: p.ok, passed: p.passed, failed: p.failed, reason: p.reason, seconds: p.seconds, heavy: p.heavy, auto: p.auto, tail: p.ok === true ? [] : (p.tail ?? []).slice(-8) }))),
						error: String(agg.error ?? ''),
						text: agg.text,
					}
				}

				// ③ 单跑（保持 R34 的输出形状，只多一个 reason）。
				const direct = probeRunner === undefined ? null : probeRunner
				const res =
					direct === null
						? await runProbe({ probe: mode, args: raw.args, timeoutSec: Number(raw.timeoutSec) })
						: await direct({ probe: mode, args: Array.isArray(raw.args) ? raw.args.map(String) : [], timeoutSec: Number(raw.timeoutSec) })
				return {
					ok: res.ok === true,
					passed: res.passed,
					failed: res.failed,
					reason: String(res.reason ?? ''),
					checks: lossless(res.failures),
					error: res.ok ? '' : res.reason === 'env' ? 'env（环境挡住，不是产品回归）' : res.reason === 'zero-checks' ? 'zero-checks' : `${res.failed} FAIL (exit ${res.exitCode})`,
					text: res.text,
				}
			},
		},
	]
}
