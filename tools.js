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

import { capture, listWindows, toDataUrl } from './lib/shot.mjs'
import { queueDeliver } from './lib/bus.mjs'
import { gateRun, bridgeStatus, bridgeSend, bridgeResults, WORKSPACE } from './lib/devtools.mjs'

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

	return [
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
				'dsh-screenshot 的验证闸门：一次跑完（静态契约 / 覆盖层端到端 / 一拍成本 / 长截图内容级 / 宿主全量）并给结论表。' +
				'默认跑前两项（秒级）；host=true 会跑完整宿主自检（约 3 分钟，会起测试窗口）。' +
				'覆盖层那一项自动把 DSH_OVERLAY_DIR 改道到 .tmp-shot-lab/gate-overlay，不会和正在运行的 DSH 抢请求目录。',
			parameters: {
				type: 'object',
				properties: {
					smoke: { type: 'boolean', description: '跑静态契约（.tools/dsh-shot-smoke.mjs）。默认 true。' },
					overlay: { type: 'boolean', description: '跑覆盖层+服务层端到端（dev/ovl-selftest.mjs，约 30s）。默认 true。' },
					tick: { type: 'boolean', description: '量一拍成本（.tools/dsh-shot-tick-bench.mjs）。默认 false。' },
					host: { type: 'boolean', description: '跑完整宿主自检（dev/hosttest.mjs，约 3 分钟，会起测试窗口）。默认 false。' },
					content: { type: 'string', description: '长截图内容级验收的矩形 "x,y,w,h"（需要桌面上一块可滚动的参照窗，如 testbed_refwin）。' },
				},
			},
			output: { schema: { type: 'object', properties: RESULT_PROPERTIES }, render: TOOL_OUTPUT.render },
			async execute(args) {
				const raw = args !== null && typeof args === 'object' ? args : {}
				const res = await gateRun({
					smoke: raw.smoke !== false,
					overlay: raw.overlay !== false,
					tick: raw.tick === true,
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
	]
}
