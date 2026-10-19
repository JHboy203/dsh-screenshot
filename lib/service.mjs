/**
 * lib/service.mjs — `shot` Remote 服务（宿主侧 wire 实现）。
 *
 * 只有一件事需要牢记：**返回值必须是 lossless JSON**（undefined 会让宿主拒收整次调用，
 * 见交接文件 R13.4 的坑②）。所以这里每个字段都显式给值，绝不留 undefined。
 *
 * ⚠️ 依赖不放 #private 字段：Remote 调用经 cordis traceable proxy，`this` 是 Proxy 不是实例本身，
 *    私有品牌检查会抛 "Cannot read private member"（session-org 踩过）。
 */

import path from 'node:path'

import { MAX_ATTACH_BYTES, MAX_STRIP_BYTES, SHOT_SERVICE } from './wire.mjs'
import {
	capture,
	isRecording,
	listShots,
	listWindows,
	ocr,
	pickWindow,
	recAction,
	recStrip,
	recordStart,
	recordStop,
	save,
	scrollCapture,
	shotPath,
	status,
	toDataUrl,
} from './shot.mjs'
import { DEFAULT_KEYS, hotkeyStatus, probeHotkeys, prettyKey, startHotkeys, stopHotkeys } from './hotkey.mjs'
import { busStatus, fireInvoke, takePending } from './bus.mjs'
import { overlayPick } from './overlay.mjs'
import { scrollAdd, scrollBegin, scrollCancel, scrollEnd, scrollStatus, isScrollActive } from './scrollsession.mjs'

/** 按扩展名推 mime（record('attach') 用；认不出就给 octet-stream，别猜成图片）。 */
const MIME_BY_EXT = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
	'.gif': 'image/gif',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
}

/** record 的合法 action（start/stop 是录制本身，其余都是录完之后的动作）。 */
const RECORD_ACTIONS = new Set(['start', 'stop', 'status', 'info', 'frame', 'strip', 'trim', 'clip', 'open', 'keep', 'discard', 'attach'])

/**
 * 录屏相关方法的**公共返回形状**：每个字段都显式给值。
 * 客户端读的是同一组键，缺一个就是 UI 上一格空白（lossless JSON 还不允许 undefined）。
 */function recFields(extra) {
	return {
		ok: false,
		recording: false,
		path: '',
		seconds: 0,
		bytes: 0,
		width: 0,
		height: 0,
		duration: 0,
		wallSeconds: 0,
		temp: true,
		name: '',
		mime: '',
		deleted: false,
		method: '',
		/** 'node' = ffmpeg 由 node 直接起；'recspawn' = 受限环境退到 ps/recspawn.ps1 代起。 */
		via: '',
		dataUrl: '',
		frames: [],
		count: 0,
		error: '',
		...extra,
	}
}

/** 把可能是字符串/数字/布尔的开关归一化成 true/false。 */
function truthy(v) {
	return v === true || v === 1 || v === '1' || v === 'true' || v === 'on'
}

/** 去掉 undefined（lossless JSON 要求）。 */
function clean(obj) {
	const out = {}
	for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? '' : v
	return out
}

/**
 * 用解析出来的基类造出服务类。
 * @param {new (ctx: any, name: string) => any} TypertRemoteService
 */
export function createShotService(TypertRemoteService) {
	return class ShotService extends TypertRemoteService {
		/** @param {import('@deepseek-ai/cordis').Context} ctx */
		constructor(ctx, deps) {
			super(ctx, SHOT_SERVICE)
			this._deps = deps ?? {}
		}

		/**
		 * 抓一张屏。
		 * @param {string} [mode] 'desktop' | 'window'
		 * @param {string} [hide] '1' 时先把 DSH 窗口藏起来
		 * @param {string} [method] window 模式：'screen' | 'print'
		 * @param {number} [hwnd] 点名截哪个窗口（选择器给的句柄）
		 * @param {string} [rect] 明确的屏幕矩形 "x,y,w,h"（物理像素）
		 */
		async cap(mode, hide, method, hwnd, rect) {
			const res = await capture({
				mode: mode === 'window' ? 'window' : 'desktop',
				hideSelf: truthy(hide),
				method: method === 'print' ? 'print' : 'screen',
				hwnd: Number.isFinite(Number(hwnd)) ? Number(hwnd) : 0,
				rect: typeof rect === 'string' ? rect : '',
			})
			if (!res.ok) {
				return clean({ ok: false, error: res.error, stderr: res.stderr ?? '', code: res.code ?? -1 })
			}
			const data = await toDataUrl(res.path)
			return clean({
				ok: true,
				id: res.id,
				path: res.path,
				mime: data.mime,
				bytes: data.bytes,
				scaled: data.scaled,
				width: res.width,
				height: res.height,
				left: res.left,
				top: res.top,
				hidden: res.hidden,
				hwnd: res.hwnd,
				method: res.method,
				mode: res.mode,
				ms: res.ms,
				dataUrl: data.dataUrl,
			})
		}

		/**
		 * 枚举可以截的窗口（选择器的数据源）。
		 * @param {string} [exclude] 标题里含它就跳过；传空字符串 = 连 DSH 自己一起列
		 * @param {number} [limit]
		 */
		async winlist(exclude, limit) {
			const res = await listWindows({
				exclude: typeof exclude === 'string' ? exclude : 'DeepSeek Harness',
				limit: Number.isFinite(Number(limit)) ? Number(limit) : 60,
			})
			return clean({ ok: res.ok, windows: res.windows, error: res.error })
		}

		/**
		 * 客户端心跳。一次往返同时取回「热键让我干什么」和「AI 要我贴哪张图」。
		 * 取走即清空（见 lib/bus.mjs）。
		 * @param {number} [since]
		 */
		async poll(since) {
			const got = takePending(Number(since) || 0)
			const hk = hotkeyStatus()
			return clean({
				ok: true,
				invoke: got.invoke,
				deliver: got.deliver,
				seq: got.seq,
				hotkeys: hk,
				bus: busStatus(),
			})
		}

		/**
		 * 全局热键守护进程。
		 * @param {string} [action] 'status' | 'start' | 'stop' | 'probe'
		 * @param {string} [opts] JSON，可含 {keys:{shot:[...],ocr:[...]}} 覆盖候选键位
		 */
		async hotkeys(action, opts) {
			const act = typeof action === 'string' && action.length > 0 ? action : 'status'
			let parsed = {}
			try {
				parsed = JSON.parse(opts ?? '{}')
			} catch {
				parsed = {}
			}
			const keys = parsed && typeof parsed.keys === 'object' && parsed.keys !== null ? parsed.keys : DEFAULT_KEYS

			if (act === 'stop') {
				stopHotkeys()
				return clean({ ok: true, alive: false, bindings: {}, error: '', note: 'stopped' })
			}
			if (act === 'probe') {
				const res = await probeHotkeys(keys)
				const bindings = {}
				for (const [a, k] of Object.entries(res.bindings)) bindings[a] = prettyKey(k)
				return clean({
					ok: res.ok,
					alive: hotkeyStatus().alive,
					bindings,
					taken: res.taken,
					error: res.ok ? '' : res.stderr,
				})
			}
			if (act === 'start') {
				const res = startHotkeys({
					keys,
					focusTitle: typeof parsed.focusTitle === 'string' ? parsed.focusTitle : 'DeepSeek Harness',
					// 热键按下的瞬间：守护进程已经把 DSH 提到前台了，这里只要留一张待办，
					// 界面的下一次心跳就会来取走并打开覆盖层。
					onFire: (fired) => fireInvoke(fired),
				})
				const bindings = {}
				for (const [a, k] of Object.entries(res.bindings ?? {})) bindings[a] = prettyKey(k)
				return clean({ ok: res.ok, alive: res.ok, bindings, error: res.error ?? '' })
			}
			const st = hotkeyStatus()
			return clean({ ok: true, alive: st.alive, bindings: st.bindings, error: st.error, events: st.events, exited: st.exited })
		}

		/**
		 * 对已抓的图做离线 OCR。
		 * @param {string} [id] 截图 id（文件名去扩展名）；给 path 也行
		 * @param {string} [rect] "x,y,w,h"（原图像素）
		 * @param {number} [upscale] 放大倍数，默认 3
		 * @param {string} [lang] 'auto'（默认，优先中文）或已安装的 WinRT tag
		 * @param {string} [preprocess] 'none' | 'gray' | 'contrast'
		 */
		async ocr(id, rect, upscale, lang, preprocess) {
			const file = await this._fileOf(id)
			if (file === '') return clean({ ok: false, error: 'shot not found: ' + String(id ?? ''), text: '', lines: [], langs: [] })
			const res = await ocr({
				file,
				rect: typeof rect === 'string' ? rect : '',
				upscale: Number.isFinite(Number(upscale)) ? Number(upscale) : 3,
				lang: typeof lang === 'string' ? lang : 'auto',
				preprocess: typeof preprocess === 'string' ? preprocess : 'none',
			})
			if (!res.ok) return clean({ ok: false, error: res.error, stderr: res.stderr ?? '', text: '', lines: [], langs: [] })
			return clean({
				ok: true,
				text: res.text,
				lines: res.lines,
				lang: res.lang,
				// 装了哪些识别语言 —— 界面的语言下拉框靠它，别在客户端硬编码
				langs: res.langs,
				width: res.width,
				height: res.height,
			})
		}

		/**
		 * 录屏：录制 + 录完之后的全部后处理。
		 *
		 *   start   {fps,audio,region}          开始录（ffmpeg gdigrab）
		 *   stop    —                           停录，**落临时文件**（CACHE_DIR/rec），
		 *                                       返回 path/seconds/bytes/width/height/temp
		 *   status  —                           只问在不在录
		 *   info    {path}                      时长/尺寸/帧率/大小
		 *   frame   {path,time,width}           抽一帧 → **当成一张正式截图**落进 SHOTS_DIR，
		 *                                       返回可被 OCR / 保存继续使用的 id
		 *   strip   {path,count,width}          胶片条（每张 dataUrl ≤ ~150KB，超了压小重抽）
		 *   trim    {path,start,end}            剪一段
		 *   clip    {path}                      把文件放进剪贴板（CF_HDROP，可直接 Ctrl+V 粘贴）
		 *   open    {path}                      系统播放器预览
		 *   keep    {path}                      搬进 图片\DSH截图（用户决定留下）
		 *   discard {path}                      删掉临时文件
		 *   attach  {path}                      宿主读成 data URL（≤8MB，超了拒绝）
		 *
		 * 未知 action **明确报错**，不静默回落到 status —— 静默 return 是这块最贵的 bug 形态。
		 * @param {string} [action]
		 * @param {string} [opts] JSON，见上
		 */
		async record(action, opts) {
			const act = typeof action === 'string' && action.length > 0 ? action : 'status'
			let parsed = {}
			try {
				parsed = JSON.parse(opts ?? '{}')
			} catch {
				parsed = {}
			}
			if (parsed === null || typeof parsed !== 'object') parsed = {}
			const file = typeof parsed.path === 'string' ? parsed.path : ''

			// 白名单先行：未知 action **必须在宿主这一层就明确报错**，不能靠 rec.ps1 兜。
			// （本轮实测：漏了这一层时 'nonsense' 会一路走到 rec.ps1，回来的错误是它的话术
			//   "unknown action"，而契约要求 `unknown action: <action>` —— 调用方分不清是谁拒的。）
			if (!RECORD_ACTIONS.has(act)) {
				return clean(recFields({ ok: false, error: 'unknown action: ' + act }))
			}

			if (act === 'start') {
				const res = await recordStart({
					fps: Number(parsed.fps) || 15,
					region: typeof parsed.region === 'string' ? parsed.region : '',
					audio: parsed.audio === true,
				})
				return clean(recFields({ ok: res.ok, recording: res.recording === true, path: res.path ?? '', via: res.via ?? '', error: res.error ?? '' }))
			}

			if (act === 'stop') {
				const res = await recordStop()
				return clean(
					recFields({
						ok: res.ok,
						recording: false,
						path: res.path ?? '',
						seconds: res.seconds ?? 0,
						bytes: res.bytes ?? 0,
						width: res.width ?? 0,
						height: res.height ?? 0,
						duration: res.duration ?? 0,
						wallSeconds: res.wallSeconds ?? 0,
						// temp:true = 这段录屏还在缓存里，等用户选 keep 还是 discard。
						temp: true,
						error: res.error ?? '',
					})
				)
			}

			if (act === 'status') {
				return clean(recFields({ ok: true, recording: isRecording() }))
			}

			if (act === 'attach') {
				if (file === '') return clean(recFields({ ok: false, error: 'path required' }))
				try {
					const fs = await import('node:fs')
					if (!fs.existsSync(file)) return clean(recFields({ ok: false, error: 'file not found: ' + file }))
					const st = fs.statSync(file)
					if (st.size > MAX_ATTACH_BYTES) {
						// 明确拒绝而不是截断：半段 MP4 贴进输入框比"太大"更难解释。
						return clean(recFields({ ok: false, bytes: st.size, error: 'too-large' }))
					}
					const buf = fs.readFileSync(file)
					const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
					return clean(
						recFields({
							ok: true,
							name: path.basename(file),
							mime,
							bytes: buf.length,
							path: file,
							dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
						})
					)
				} catch (error) {
					return clean(recFields({ ok: false, error: String(error?.message ?? error) }))
				}
			}

			// 以下都要一个真实的 mp4。
			if (file === '') return clean(recFields({ ok: false, error: 'path required' }))

			if (act === 'info') {
				const res = await recAction('info', { file }, 40_000)
				return clean(
					recFields({
						ok: res.ok,
						path: file,
						duration: Number(res.duration) || 0,
						width: Number(res.width) || 0,
						height: Number(res.height) || 0,
						bytes: Number(res.bytes) || 0,
						error: res.ok ? '' : String(res.error ?? 'info failed'),
					})
				)
			}

			if (act === 'frame') {
				// 抽出来的帧按**正式截图**落地（shotPath() 的命名），这样它的 id 能被 _fileOf
				// 解析，客户端后续对它 OCR / 保存 / 贴进输入框全都成立。
				const out = shotPath()
				const res = await recAction('frame', { file, time: Number(parsed.time) || 0, width: Number(parsed.width) || 0, out }, 90_000)
				if (!res.ok || !res.path) {
					return clean(recFields({ ok: false, error: String(res.error ?? 'frame failed') }))
				}
				const data = await toDataUrl(String(res.path))
				return clean(
					recFields({
						ok: true,
						id: path.basename(String(res.path), path.extname(String(res.path))),
						path: String(res.path),
						width: Number(res.width) || 0,
						height: Number(res.height) || 0,
						bytes: Number(res.bytes) || data.bytes,
						mime: data.mime,
						dataUrl: data.dataUrl,
					})
				)
			}

			if (act === 'strip') {
				const res = await recStrip(
					{ file, count: Number(parsed.count) || 12, width: Number(parsed.width) || 240 },
					MAX_STRIP_BYTES
				)
				return clean(
					recFields({
						ok: res.ok,
						count: res.count ?? 0,
						// 契约：frames:[{t,dataUrl}]。path/bytes 是给排错用的附加信息。
						frames: (res.frames ?? []).map((f) => ({ t: f.t, dataUrl: f.dataUrl, path: f.path, bytes: f.bytes })),
						path: file,
						error: res.ok ? '' : String(res.error ?? 'strip failed'),
					})
				)
			}

			// trim / clip / open / keep / discard：原样透传 rec.ps1 的结果。
			const timeout = act === 'trim' ? 180_000 : act === 'discard' ? 20_000 : 40_000
			const res = await recAction(
				act,
				{
					file,
					start: Number(parsed.start),
					end: Number(parsed.end),
				},
				timeout
			)
			return clean(
				recFields({
					ok: res.ok,
					path: String(res.path ?? (act === 'discard' ? '' : file)),
					bytes: Number(res.bytes) || 0,
					duration: Number(res.duration) || 0,
					method: String(res.method ?? ''),
					deleted: res.deleted === true,
					error: res.ok ? '' : String(res.error ?? act + ' failed'),
				})
			)
		}

		/**
		 * 在**真实桌面上点一个窗口**（宿主起一块全屏 GUI，用户点一下）。
		 * ⚠️ 阻塞调用：默认最多等用户 120s，Remote 那头的等待上限必须比它大。
		 * @param {number} [timeout] 用户最多有多少秒可以挑
		 */
		/**
		 * 让用户在**真实桌面**上框一块（独立进程的全屏覆盖层，盖在所有应用之上）。
		 *
		 * 和 pickwin 同一形态：**阻塞**调用 —— 它就是在等人，网关那头的等待超时要比 timeout 大。
		 * 框完图会自动进**系统剪贴板**（M1 的交付物），同时落一张 PNG 到 .cache（宿主可读）。
		 *
		 * `opts.regionOnly` = 只要那块矩形，不要图（长截图 / 提取文字 / 屏幕翻译的第一步）。
		 * 那条路上**不写剪贴板、不落盘**，因为调用方马上要自己去抓这块区域。
		 *
		 * ⚠️ 返回值必须是 lossless JSON（不许 undefined，见文件头注释）。
		 */
		async overlay(timeout, opts) {
			let extra = {}
			if (typeof opts === 'string' && opts.length > 0) {
				try {
					const parsed = JSON.parse(opts)
					if (parsed !== null && typeof parsed === 'object') extra = parsed
				} catch {}
			}
			const regionOnly = extra.regionOnly === true
			const res = await overlayPick({
				timeoutSec: Number(timeout) || 120,
				dim: extra.dim,
				png: extra.png,
				labels: Array.isArray(extra.labels) ? extra.labels : undefined,
				hint: typeof extra.hint === 'string' ? extra.hint : undefined,
				// selfTest 是**测试开关**（助手自己框一块再返回，因为沙箱里没有人能拖鼠标）。
				// 产品路径从不传它 —— 但必须从这个门透过去：不传的话，regionOnly 这条新路
				// 在自动化里就只能验"助手单独跑得动"，验不到"服务类有没有把它传下去"。
				selfTest: extra.selfTest === true,
				regionOnly,
			})
			return {
				ok: res.ok === true,
				cancelled: res.cancelled === true,
				x: Number(res.x) || 0,
				y: Number(res.y) || 0,
				w: Number(res.w) || 0,
				h: Number(res.h) || 0,
				clip: res.clip === true,
				png: typeof res.png === 'string' ? res.png : '',
				ms: Number(res.ms) || 0,
				// regionOnly：助手确认走的是「只取矩形」那条路（没标注 / 没剪贴板 / 没落盘）。
				// 老宿主根本没有这个字段 -> false -> 客户端据此知道对方还在标注模式。
				regionOnly: res.regionOnly === true && regionOnly,
				reason: typeof res.reason === 'string' ? res.reason : '',
				error: typeof res.error === 'string' ? res.error : '',
			}
		}

		async pickwin(timeout) {
			const res = await pickWindow(Number(timeout) || 120)
			return clean({
				ok: res.ok,
				cancelled: res.cancelled === true,
				hwnd: res.hwnd,
				title: res.title,
				class: res.class,
				pid: res.pid,
				x: res.x,
				y: res.y,
				w: res.w,
				h: res.h,
				child: res.child,
				ms: res.ms,
				reason: res.reason,
				error: res.error,
			})
		}

		/**
		 * 长截图。会话**跑在宿主进程里**（见 scrollsession.mjs 顶部那段"为什么"）。
		 *
		 *   {session:'begin', mode:'manual'|'auto', maxFrames?, settleMs?}  起会话（默认 manual）
		 *   {session:'status'}                                              读进度（含 preview 缩略图）
		 *   {session:'add'}                                                 立刻强制接一帧
		 *   {session:'end'}                                                 拼接 → 落成一张正式截图
		 *   {session:'cancel'}                                              停掉、清干净
		 *   没有 session 字段（opts 为空的老调用点）                        → 走老的自动 scrollCapture
		 *
		 * ⚠️ 兼容口径：**只有完全没给 session 时才回落老路径**；给了 session:'begin' 而没给
		 *    mode 的按"默认 manual"处理（这是新契约里的默认值）。老客户端那种
		 *    `scroll(rect,'')` / `scroll(rect,'{"maxFrames":8}')` 因此行为不变。
		 */
		async scroll(rect, opts) {
			let parsed = {}
			try {
				parsed = JSON.parse(opts ?? '{}')
			} catch {
				parsed = {}
			}
			if (parsed === null || typeof parsed !== 'object') parsed = {}
			const sess = typeof parsed.session === 'string' ? parsed.session : ''
			const rectText = typeof rect === 'string' ? rect : ''

			if (sess === 'begin') {
				const r = await scrollBegin(rectText, {
					mode: parsed.mode === 'auto' ? 'auto' : 'manual',
					maxFrames: Number(parsed.maxFrames) || undefined,
					settleMs: Number(parsed.settleMs) || undefined,
				})
				return clean({ id: '', dataUrl: '', ...r })
			}
			if (sess === 'status') {
				const s = await scrollStatus()
				return clean({ id: '', dataUrl: '', path: '', error: '', ...s })
			}
			if (sess === 'add') {
				const r = await scrollAdd()
				return clean({ id: '', dataUrl: '', ...r })
			}
			if (sess === 'end') {
				const r = await scrollEnd()
				if (!r.ok) return clean({ ok: false, dataUrl: '', ...r })
				const data = await toDataUrl(r.path)
				return clean({ ...r, dataUrl: data.dataUrl, scaled: data.scaled === true })
			}
			if (sess === 'cancel') {
				const r = await scrollCancel()
				return clean({ ok: true, id: '', dataUrl: '', path: '', error: '', ...r })
			}

			// 老路径：没有任何 session 字段 → 自动滚 + 自动拼（老客户端、老工具都还在这条上）。
			const res = await scrollCapture({
				rect: rectText,
				maxFrames: Number(parsed.maxFrames) || 8,
				delta: Number(parsed.delta) || 0,
				settleMs: Number(parsed.settleMs) || 320,
				hideSelf: parsed.hideSelf === true,
			})
			if (!res.ok) return clean({ ok: false, error: res.error, frames: res.frames ?? 0, dataUrl: '', id: '', width: 0, height: 0, path: '' })
			return clean({
				ok: true,
				error: '',
				id: res.id,
				dataUrl: res.dataUrl,
				frames: res.frames,
				width: res.width,
				height: res.height,
				path: res.path,
				scaled: res.scaled === true,
			})
		}

		/** 存盘（默认 图片\DSH截图）。 */
		async save(dataUrl, name) {
			try {
				const res = await save(dataUrl, name)
				return clean({ ok: res.ok, path: res.path ?? '', bytes: res.bytes ?? 0, dir: res.dir ?? '', error: res.error ?? '' })
			} catch (error) {
				return clean({ ok: false, path: '', bytes: 0, dir: '', error: String(error?.message ?? error) })
			}
		}

		/** 最近抓过的图（只有元信息，不带 dataUrl）。 */
		async list() {
			const shots = await listShots(8)
			return clean({ ok: true, shots })
		}

		/** 自检。 */
		async status() {
			const s = await status()
			// scrollActive：现在有没有长截图会话在跑。status 是"一屏看全"的那个方法，而它
			// 已经报 recording 了 —— 会话这条线同样该在这里露面（热键/工具要靠它判断
			// "要不要先取消"，客户端也能据此把按钮切成"完成/取消"）。
			return clean({ ...s, scrollActive: isScrollActive() })
		}

		/** 把 id 或路径解析成真实文件路径。 */
		async _fileOf(idOrPath) {
			const raw = String(idOrPath ?? '')
			if (raw === '') return ''
			const { existsSync } = await import('node:fs')
			if (existsSync(raw)) return raw
			const { SHOTS_DIR } = await import('./shot.mjs')
			const path = await import('node:path')
			for (const ext of ['.png', '.jpg', '.long.png']) {
				const candidate = path.join(SHOTS_DIR, raw.endsWith(ext) ? raw : raw + ext)
				if (existsSync(candidate)) return candidate
			}
			return ''
		}
	}
}
