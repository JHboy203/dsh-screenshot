/**
 * lib/wire.mjs — dsh-screenshot 的 Typert wire 契约（宿主清单与客户端 Remote 贡献共用）。
 *
 * 刻意**不依赖 zod**（照抄 dsh-session-org / dsh-checkpoint-rewind 的惯例）：
 *   typert-loader 的 requireStrictCodec 只检查形状 ——
 *   `mode === 'strict'`、`typeSymbol` 是字符串、`create` 是函数、decode/encode 若在必须是函数。
 * 于是这里自带最小 codec，两端由同一份常量提供，永不漂移。
 *
 * 参数一律用**标量**（字符串/数字），复杂载荷走 JSON 字符串 ——
 * 与 session-org 的 overview(query, tag, limit, offset, refresh, hide) 同一形态，
 * 网关的 exact-args 检查按名字逐个对，少给一个就整次调用打回，所以：
 * **任何一个参数用不上时，客户端也必须显式传 undefined 以外的占位**（见 acceptsUndefined）。
 */

/** 本插件包名（typert typeSymbol 前缀 + Remote 挂载包名）。 */
export const PACKAGE = 'dsh-screenshot'

/** Remote 命名空间（= 宿主服务名 = ctx.remote.shot）。 */
export const SHOT_SERVICE = 'shot'

/** 调用描述符在源码里的位置（loader 只要求正整数）。 */
const SOURCE_LOCATION = Object.freeze({ file: 'lib/wire.mjs', line: 1, column: 1 })

const T = (name) => `${PACKAGE}/types#${name}`

/**
 * 最小 strict codec。parse 刻意宽松直通，只拦 null/undefined ——
 * 截图链路宁可拿到残缺参数后自己归一化，也不要因为多一个字段整次调用失败。
 * @param {string} typeSymbol
 * @param {(value: unknown) => unknown} [normalize]
 */
function codec(typeSymbol, normalize) {
	const parse = (value) => {
		if (value === null || value === undefined) {
			throw new TypeError(`${typeSymbol}: payload must not be null/undefined`)
		}
		return normalize === undefined ? value : normalize(value)
	}
	const schema = { parse }
	return {
		mode: 'strict',
		typeSymbol,
		schema,
		create: () => schema,
	}
}

/** 对象载荷直通。 */
const anyObject = (typeSymbol) => codec(typeSymbol, (v) => (typeof v === 'object' && v !== null ? v : {}))

/** 可选字符串。 */
const optionalString = (typeSymbol) => codec(typeSymbol, (v) => (typeof v === 'string' ? v : undefined))

/** 可选数字（字符串数字也收）。 */
const optionalNumber = (typeSymbol) =>
	codec(typeSymbol, (v) => {
		const n = Number(v)
		return Number.isFinite(n) ? n : undefined
	})

/**
 * 组装一个调用描述符。
 * @param {string} method
 * @param {Array<{name: string, codec: object, acceptsUndefined?: boolean}>} parameters
 * @param {object} resultCodec
 */
function descriptor(method, parameters, resultCodec) {
	return Object.freeze({
		id: `${PACKAGE}#${SHOT_SERVICE}/${method}`,
		service: SHOT_SERVICE,
		namespace: SHOT_SERVICE,
		method,
		invocation: Object.freeze({ kind: 'direct' }),
		parameters: Object.freeze(
			parameters.map((p) =>
				Object.freeze({
					name: p.name,
					wire: p.name,
					source: 'json',
					...(p.acceptsUndefined === true ? { acceptsUndefined: true } : {}),
					codec: p.codec,
				})
			)
		),
		result: resultCodec,
		sourceLocation: SOURCE_LOCATION,
	})
}

/**
 * 抓一张屏。
 * @returns {Promise<{ok: boolean, id: string, dataUrl: string, mime: string,
 *   width: number, height: number, path: string, left: number, top: number,
 *   hidden: boolean, scaled: boolean, bytes: number, ms: number, error?: string}>}
 */
export const CAP_DESCRIPTOR = descriptor(
	'cap',
	[
		// 'desktop' 整个虚拟桌面（含别的软件） / 'window' 只截一个窗口
		{ name: 'mode', codec: optionalString(T('Mode')), acceptsUndefined: true },
		// 截之前把 DSH 窗口藏起来（QQ 的「截图时隐藏当前窗口」）
		{ name: 'hide', codec: optionalString(T('Hide')), acceptsUndefined: true },
		// window 模式：'screen' 抓屏幕对应区域（快，被别的窗口挡住就拍到别人）
		//            'print'  让窗口自己渲染（挡住/移出屏幕也能拍到）
		{ name: 'method', codec: optionalString(T('Method')), acceptsUndefined: true },
		// window 模式点名要哪个窗口（选择器给的句柄）。0/空 = 按标题找 DSH 自己
		{ name: 'hwnd', codec: optionalNumber(T('Hwnd')), acceptsUndefined: true },
		// 明确的屏幕矩形 "x,y,w,h"（**物理像素**）。覆盖层和 AI 都走它 —— 不需要前台窗口
		{ name: 'rect', codec: optionalString(T('Rect')), acceptsUndefined: true },
	],
	anyObject(T('Cap'))
)

/**
 * 对某张已抓的图做**离线 OCR**（Windows 自带引擎，不出本机）。
 * @returns {Promise<{ok: boolean, text: string, lines: Array<{text: string, x: number, y: number, w: number, h: number}>, error?: string}>}
 */
export const OCR_DESCRIPTOR = descriptor(
	'ocr',
	[
		{ name: 'id', codec: optionalString(T('ShotId')), acceptsUndefined: true },
		// 只认这块区域，格式 "x,y,w,h"（原图像素坐标）；空 = 整张
		{ name: 'rect', codec: optionalString(T('Rect')), acceptsUndefined: true },
		// 小字识别前放大倍数（默认 3，11px UI 文本靠它救）
		{ name: 'upscale', codec: optionalNumber(T('Upscale')), acceptsUndefined: true },
		// 识别语言：'auto'（默认，优先中文）或已安装的 WinRT tag（'zh-Hans-CN' / 'ja' / 'en-US'）
		{ name: 'lang', codec: optionalString(T('Lang')), acceptsUndefined: true },
		// 预处理：'none' | 'gray' | 'contrast'，暗底/低对比截图才需要
		{ name: 'preprocess', codec: optionalString(T('Preprocess')), acceptsUndefined: true },
	],
	anyObject(T('Ocr'))
)

/**
 * 录屏（ffmpeg gdigrab）。action='start' 开始，'stop' 结束并返回文件路径。
 * @returns {Promise<{ok: boolean, recording: boolean, path?: string, seconds?: number, error?: string}>}
 */
export const RECORD_DESCRIPTOR = descriptor(
	'record',
	[
		{ name: 'action', codec: optionalString(T('Action')), acceptsUndefined: true },
		// JSON：{fps, region:"x,y,w,h", audio:boolean}
		{ name: 'opts', codec: optionalString(T('Opts')), acceptsUndefined: true },
	],
	anyObject(T('Record'))
)

/**
 * 长截图：对一块区域反复「滚一屏 → 抓一张 → 首尾重叠拼接」。
 * @returns {Promise<{ok: boolean, id: string, dataUrl: string, frames: number,
 *   width: number, height: number, path: string, error?: string}>}
 */
export const SCROLL_DESCRIPTOR = descriptor(
	'scroll',
	[
		{ name: 'rect', codec: optionalString(T('Rect')), acceptsUndefined: true },
		// JSON：{maxFrames, delta, settleMs, hideSelf}
		{ name: 'opts', codec: optionalString(T('Opts')), acceptsUndefined: true },
	],
	anyObject(T('Scroll'))
)

/**
 * 把浏览器半边合成好的图存到磁盘（默认 图片\DSH截图）。
 * ⚠️ 这个是唯一一次**大载荷上行**（base64 PNG）。客户端优先走 <a download>，
 *    只有下载失败时才回落到这里。
 * @returns {Promise<{ok: boolean, path: string, bytes: number, error?: string}>}
 */
export const SAVE_DESCRIPTOR = descriptor(
	'save',
	[
		{ name: 'dataUrl', codec: optionalString(T('DataUrl')), acceptsUndefined: true },
		{ name: 'name', codec: optionalString(T('Name')), acceptsUndefined: true },
	],
	anyObject(T('Save'))
)

/** 最近抓过的图（客户端可以用来重新框选 / 贴图）。 */
export const LIST_DESCRIPTOR = descriptor('list', [], anyObject(T('List')))

/**
 * 自检：pwsh / ffmpeg 在哪、临时目录、当前进程完整性、最近一次错误。
 * 客户端在服务不可用或抓屏失败时显示它，宿主开机也写一份到 .cache/boot-report.json。
 */
export const STATUS_DESCRIPTOR = descriptor('status', [], anyObject(T('Status')))

/**
 * 枚举可以截的窗口（窗口选择器的数据源）。
 * @returns {Promise<{ok: boolean, windows: Array<{hwnd: number, title: string, class: string,
 *   pid: number, x: number, y: number, w: number, h: number, min: boolean, z: number}>}>}
 */
export const WINLIST_DESCRIPTOR = descriptor(
	'winlist',
	[
		// 默认**不**排除 DSH 自己 —— 用户点名要能截 DSH 窗口；排除是选择器里的一颗开关
		{ name: 'exclude', codec: optionalString(T('Exclude')), acceptsUndefined: true },
		{ name: 'limit', codec: optionalNumber(T('Limit')), acceptsUndefined: true },
	],
	anyObject(T('WinList'))
)

/**
 * 「在真实桌面上点一个窗口」：宿主起 pickwindow.ps1（一块全屏 GUI 覆盖层），
 * 用户把鼠标移到目标窗口上点一下，脚本回一个 hwnd + 标题 + 矩形。
 *
 * ⚠️ 这是个**阻塞**调用，秒级到分钟级（默认最多 120s 让用户挑）。网关那头的等待超时
 *    必须比 timeout 大 —— 它不是卡住了，它就是在等人。
 * @returns {Promise<{ok: boolean, cancelled: boolean, hwnd: number, title: string,
 *   class: string, pid: number, x: number, y: number, w: number, h: number,
 *   child: number, ms: number, reason: string, error: string}>}
 */
export const PICKWIN_DESCRIPTOR = descriptor(
	'pickwin',
	[
		// 用户最多有多少秒可以挑（默认 120，宿主会夹到 5..600）
		{ name: 'timeout', codec: optionalNumber(T('Timeout')), acceptsUndefined: true },
	],
	anyObject(T('PickWin'))
)

/**
 * 客户端心跳：一次调用同时取回「有没有热键/工具要我干活」和热键注册状态。
 *
 * 为什么用轮询而不是事件推送：Remote 是 client→host 的单向调用，宿主没有反向推的通道。
 * 1 秒一次 IPC 换掉一整套事件总线，是这里明显划算的交易。
 * @returns {Promise<{ok: boolean, invoke: string, deliver: string, hotkeys: object, seq: number}>}
 */
export const POLL_DESCRIPTOR = descriptor(
	'poll',
	[{ name: 'since', codec: optionalNumber(T('Since')), acceptsUndefined: true }],
	anyObject(T('Poll'))
)

/**
 * 全局热键守护进程的开关与状态。action='status' | 'start' | 'stop' | 'probe'。
 * @returns {Promise<{ok: boolean, alive: boolean, bindings: object, error: string}>}
 */
export const HOTKEYS_DESCRIPTOR = descriptor(
	'hotkeys',
	[
		{ name: 'action', codec: optionalString(T('Action')), acceptsUndefined: true },
		// JSON：{shot:[...],ocr:[...]} 覆盖候选键位；空 = 用默认表
		{ name: 'opts', codec: optionalString(T('Opts')), acceptsUndefined: true },
	],
	anyObject(T('Hotkeys'))
)

/**
 * 让用户在**真实桌面**上框一块 —— 独立进程的全屏覆盖层，盖在所有应用之上。
 *
 * 为什么它必须是独立进程：DSH 渲染进程只能在自己窗口里画（DOM 平面），
 * 那里的选区永远压不住别的应用。这条调用换成了带真 HWND 的窗口，
 * 而且跑在**常驻**助手进程里（冷启 ~4.2s，不能每次截图都付）。
 *
 * ⚠️ 和 pickwin 一样是**阻塞**调用：它就是停下来等人，网关那头的等待超时要比 timeout 大。
 * @returns {Promise<{ok: boolean, cancelled: boolean, x: number, y: number, w: number, h: number,
 *   clip: boolean, png: string, ms: number, reason: string, error: string}>}
 */
export const OVERLAY_DESCRIPTOR = descriptor(
	'overlay',
	[
		// 用户最多有多少秒可以框（默认 120，宿主会夹到 3..600）
		{ name: 'timeout', codec: optionalNumber(T('Timeout')), acceptsUndefined: true },
		// JSON：{dim: 0..95 压暗百分比, png: 输出路径}
		{ name: 'opts', codec: optionalString(T('Opts')), acceptsUndefined: true },
	],
	anyObject(T('Overlay'))
)

/** 全部 wire 调用（./typert 清单与客户端 Remote 贡献共用）。 */
export const SHOT_INVOCATIONS = Object.freeze([
	CAP_DESCRIPTOR,
	OCR_DESCRIPTOR,
	RECORD_DESCRIPTOR,
	SCROLL_DESCRIPTOR,
	SAVE_DESCRIPTOR,
	LIST_DESCRIPTOR,
	STATUS_DESCRIPTOR,
	WINLIST_DESCRIPTOR,
	PICKWIN_DESCRIPTOR,
	OVERLAY_DESCRIPTOR,
	POLL_DESCRIPTOR,
	HOTKEYS_DESCRIPTOR,
])

/** 一次 cap 最多把多大的图当 data URL 发出去（超了就降采样，防止网关被噎住）。 */
export const MAX_DATAURL_BYTES = 2_600_000
/**
 * `record('attach')` 的上限：超过这个大小**直接拒绝**，不把巨型 base64 塞进网关。
 * 8 MB 是"一段十几秒的 1080p 录屏"的量级；再大就该走剪贴板（record('clip')）或存盘。
 */
export const MAX_ATTACH_BYTES = 8 * 1024 * 1024
/** 胶片条（record('strip')）里**单张**缩略图的上限，超了就把抽帧宽度压小重来。 */
export const MAX_STRIP_BYTES = 150_000
/** 一共留多少张历史截图在 .cache/shots 下（超了删最老的）。 */
export const MAX_KEEP_SHOTS = 40
