/**
 * dsh-screenshot — 浏览器半边。
 *
 * 挂载点：`conversation.input.left`（官方 list/session 槽，**零官方占用**，
 * 渲染在输入框左侧工具组里、`+` 按钮与权限/计划选择器之后），order:-90
 * —— 比语音键（-100）靠后一位，于是按钮正好落在「语音」键旁边。
 *
 * 三条不能想当然的结论（都来自 asar 逐文件取证，见交接文件 R14）：
 *   ① 渲染进程**拿不到屏幕**：官方主会话没有 setDisplayMediaRequestHandler，
 *      权限处理器只放行麦克风 → 抓屏必须走宿主半边 `ctx.remote.shot.cap(...)`。
 *   ② **没有公开的「File → 附件」API**：inputActions.addAttachments(ids) 只吃已分配的
 *      attachment id。可行路径是合成事件 —— 官方 ui-attachment 的 drop 监听在
 *      **document** 级，唯一门槛是 `dataTransfer.types.includes("Files")`，且不检查 isTrusted。
 *   ③ 贴进输入框与复制到剪贴板**都要做**（用户明确要求），任何一条失败不影响另一条。
 *
 * ⚠️ 本文件里的 CSS 是模板字符串：注释里不要出现反引号与 ${。
 * ⚠️ 覆盖层源码由 .tools/dsh-shot-build.mjs 内联进来（保留 ui/overlay.js 为唯一真源，
 *    这样同一份代码能在普通浏览器里被 dev/harness.html 真点真画地验证）。
 */

window.__ModuleLoader__.load({
	id: 'dsh-screenshot',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement

		const PKG = 'dsh-screenshot'
		const SERVICE = 'shot'
		const LS_KEY = 'dsh.screenshot.prefs'
		/**
		 * 客户端版本标记（**唯一真源**，R41）。
		 *
		 * 以前这个号在文件里出现两次（桥注册的 `build:` 与 `__dshotDebug.build`），而
		 * `shot_health` 与回执都只看第一处 —— 只改一处时两边**一起自洽地错**，
		 * "客户端是不是旧的"就永远判不出来（R38 实测：代码已是新的，回执还报 R33）。
		 * 现在只有这一行，两处都引用它；`lib/health.mjs` 优先按 `CLIENT_BUILD = 'Rxx'` 读。
		 */
		const CLIENT_BUILD = 'R67'

		/* ══════════════ 代次标记 + 跨热重载的 DOM 清理（R38）══════════════
		 *
		 * 问题：客户端半边被热重载时，**旧模块已经不在**了 —— 谁也回收不了它 `appendChild`
		 * 到 body 上的东西（覆盖层根、调色板、录屏胶囊、面板…）。于是每重载一次就多一份，
		 * 攒到几次之后页面上出现"点不动/盖住/残留半个工具栏"，以前的结论是"只能刷新页面"。
		 *
		 * 做法：每次加载生成一个**代次**（DSHOT_GEN），本代次创建的节点都打上
		 * `data-dshot-gen`；加载时先扫一遍，把**别的代次**留下的节点删掉。
		 * 只碰带这个属性的节点 —— 官方 DOM 一律不碰，也不靠 class 猜。
		 * 判据：`__dshotDebug.gen` 是当前代次；`__dshotDebug.sweep()` 返回清掉几个，
		 * 可以用 `shot_bridge` 的 eval 现场验（造一个"上一代"的节点 → sweep → 看它没了）。 */
		// >>> R38-DOMGEN（.tools/dsh-shot-smoke.mjs 按这对标记把这段抠出来，用假 DOM 真跑一遍）
		const DSHOT_GEN = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
		const GEN_ATTR = 'data-dshot-gen'

		/** 把节点挂到 body 并打上本代次标记（**所有**长期存在的节点都走这里）。 */
		function mountBody(node) {
			if (node !== null && typeof node === 'object' && node.nodeType === 1) node.setAttribute(GEN_ATTR, DSHOT_GEN)
			// 这里**故意**不走 mountBody（那就是它自己）；下面全局替换时靠 `host` 这个名字避开。
			const host = document.body
			host.appendChild(node)
			return node
		}

		/** 清掉别的代次留下的节点，返回清掉的个数。只认 GEN_ATTR，不认 class。 */
		function sweepStaleDom() {
			const all = document.querySelectorAll('[' + GEN_ATTR + ']')
			let n = 0
			for (let i = 0; i < all.length; i++) {
				const node = all[i]
				if (node.getAttribute(GEN_ATTR) === DSHOT_GEN) continue
				try {
					node.remove()
					n++
				} catch {}
			}
			return n
		}
		// <<< R38-DOMGEN

		// 加载即清理：上一次热重载的模块已经不在了，页面里只有我们这些人能回收它挂的节点。
		const DSHOT_SWEPT = sweepStaleDom()


		/* ══════════════ 诊断通道（AI 看不到 GUI，只能自己外送 DOM 事实）══════════════
		 *
		 * 背景：本机 AI 既读不到渲染进程控制台，也不能点应用里的按钮（沙箱是低完整性）。
		 * 但**宿主服务是我自己的**，`shot.save()` 能把任意 base64 落盘到
		 * `图片\DSH截图\` —— 于是把 DOM 快照塞进一个假装的 data URL 就能把事实运出来
		 * （文件名后缀是 .png，内容是 JSON 文本，用 Get-Content 直接读）。
		 *
		 * 为什么需要它：侧栏那类"插件没挂上"的问题，从截图上看和"用户切到了官方模式"
		 * 一模一样 —— 必须看 DOM（.dso-mode-head 在不在、html[data-dso-own] 有没有、
		 * 官方标签有没有被藏）才能区分。 */

		if (window.__dshotErrors === undefined) {
			window.__dshotErrors = []
			window.addEventListener('error', (e) => {
				try {
					window.__dshotErrors.push(String((e && e.message) || e) + ' @' + String((e && e.filename) || ''))
				} catch {}
			})
			window.addEventListener('unhandledrejection', (e) => {
				try {
					window.__dshotErrors.push('rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || e))
				} catch {}
			})
		}

		/** 收集 AI 从外面看不到的事实。 */
		function collectDiagnostics() {
			const has = (sel) => {
				try {
					return document.querySelector(sel) !== null
				} catch {
					return false
				}
			}
			const count = (sel) => {
				try {
					return document.querySelectorAll(sel).length
				} catch {
					return -1
				}
			}
			// 挂载点里到底有没有内容 —— "建好了但是空的"和"根本没建"是两种完全不同的病，
			// 只报一个 true/false 分不出来。
			const mountText = (name) => {
				try {
					const el = document.querySelector('[data-dso-mount="' + name + '"]')
					if (el === null) return null
					return {
						kids: el.childElementCount,
						text: String(el.textContent || '').slice(0, 60),
						cls: String(el.className || '').slice(0, 60)
					}
				} catch {
					return null
				}
			}
			const ls = {}
			for (const k of ['dsh.sessionOrg.mode', 'dsh.sessionOrg.density', 'dsh.sessionOrg.v3', LS_KEY]) {
				try {
					const v = window.localStorage.getItem(k)
					ls[k] = v === null ? null : String(v).slice(0, 200)
				} catch (error) {
					ls[k] = 'ERR ' + String(error && error.message)
				}
			}
			const html = document.documentElement
			return {
				at: new Date().toISOString(),
				href: String(window.location.href).slice(0, 120),
				screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
				htmlAttrs: {
					'data-dso-own': html.getAttribute('data-dso-own'),
					'data-dso-graph': html.getAttribute('data-dso-graph')
				},
				// 侧栏那一套（判断 dsh-session-org 到底挂上没有）
				sessionOrg: {
					modeHead: has('.dso-mode-head'),
					headerMount: has('[data-dso-mount="header"]'),
					barMount: has('[data-dso-mount="bar"]'),
					ownList: has('.dso-own-list'),
					officialListTagged: has('[data-dso-official-list]'),
					hiddenLabel: count('[data-dso-hide]'),
					switchText: (document.querySelector('.dso-switch') || {}).textContent || null,
					cards: count('.dso-card'),
					cardLines: count('.dso-card-line'),
					// ── 自挂载自检（R14.2）──────────────────────────────
					// 老形态：mounter（纯 DOM、在 inject 里跑）把挂载点建好了，
					// 但靠槽渲染的 React 界面一个像素都没出现 —— 从截图上看和
					// "用户切到官方模式"完全一样。所以这几条是判案的关键：
					uiRootHost: has('[data-dso-mount="root"]'), // 我自己开的宿主节点在不在
					uiNoClient: (document.querySelector('[data-dso-mount="root"]') || {}).getAttribute
						? document.querySelector('[data-dso-mount="root"]').getAttribute('data-dso-noclient')
						: null,
					mountHeaderText: mountText('header'),
					mountBarText: mountText('bar'),
					// 槽到底渲染了我的组件没有（渲染了才会 > 0）
					footerSlotChildren: count('[data-slot="sidebar.footer.action"] > *'),
					dsoMountTotal: count('[data-dso-mount]'),
					tabOn: Array.from(document.querySelectorAll('.dso-switch .dso-tab')).map((el) =>
						(el.getAttribute('data-on') === '1' ? 'ON:' : 'off:') + String(el.textContent || '').slice(0, 8)
					)
				},
				// 截图插件自己
				self: {
					trigger: count('.dshot-trigger'),
					overlay: count('.dshot-root'),
					composerSlots: count('[data-slot="conversation.input.left"] > *'),
					composerInput: has('[data-composer-input]'),
					composerCard: has('[data-composer-card]')
				},
				// 其它插件是否在场（横向对照：它们活着而 session-org 不在 = session-org 的问题）
				others: {
					voice: count('.dsv-local-wrap'),
					slotsTotal: count('[data-slot]')
				},
				localStorage: ls,
				errors: (window.__dshotErrors || []).slice(-12)
			}
		}

		/**
		 * 把 DOM 快照送出去（经宿主 save() 落盘）。
		 * **返回结果，不再静默吞异常** —— 之前失败时 only console.warn，而 AI 看不到控制台，
		 * 于是表现为"点了诊断一点反应都没有"，白白耗掉一轮。现在调用方能把原因说出来。
		 * @returns {Promise<{ok:boolean, path?:string, dir?:string, error?:string}>}
		 */
		async function dumpDiagnostics(tag) {
			try {
				if (shot.api === null) return { ok: false, error: 'remote 还没接上（宿主半边未就绪）' }
				const text = JSON.stringify(collectDiagnostics(), null, 1)
				// btoa 只吃 latin1 → 先编成 UTF-8 字节再转字符串
				const bytes = new TextEncoder().encode(text)
				let bin = ''
				for (const b of bytes) bin += String.fromCharCode(b)
				const dataUrl = 'data:image/png;base64,' + window.btoa(bin)
				const res = await shot.api.save(dataUrl, 'domdump-' + (tag || 'x'))
				if (res === undefined || res === null) return { ok: false, error: 'save 没有返回结果' }
				if (res.ok !== true) return { ok: false, error: String(res.error || 'save 失败') }
				return { ok: true, path: String(res.path || ''), dir: String(res.dir || '') }
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error) }
			}
		}

		/* ══════════════ Remote 契约（与宿主 lib/wire.mjs 一一对应，手抄）══════════════ */

		function codec(typeSymbol) {
			const schema = { parse: (value) => value }
			return { mode: 'strict', typeSymbol: typeSymbol, schema: schema, create: () => schema }
		}

		function desc(method, parameters, resultType) {
			return {
				id: PKG + '#' + SERVICE + '/' + method,
				service: SERVICE,
				namespace: SERVICE,
				method: method,
				invocation: { kind: 'direct' },
				parameters: parameters.map((p) => {
					const d = {
						name: p.name,
						wire: p.name,
						source: 'json',
						codec: codec(PKG + '/types#' + p.type),
					}
					if (p.opt === true) d.acceptsUndefined = true
					return d
				}),
				result: codec(PKG + '/types#' + resultType),
				sourceLocation: { file: 'lib/wire.mjs', line: 1, column: 1 },
			}
		}

		/** ⚠️ 必须与宿主 lib/wire.mjs 的 SHOT_INVOCATIONS 逐字段一致（手抄）。 */
		const INVOCATIONS = [
			desc('cap', [
				{ name: 'mode', type: 'Mode', opt: true },
				{ name: 'hide', type: 'Hide', opt: true },
				{ name: 'method', type: 'Method', opt: true },
				{ name: 'hwnd', type: 'Hwnd', opt: true },
				{ name: 'rect', type: 'Rect', opt: true },
			], 'Cap'),
			desc('ocr', [
				{ name: 'id', type: 'ShotId', opt: true },
				{ name: 'rect', type: 'Rect', opt: true },
				{ name: 'upscale', type: 'Upscale', opt: true },
				{ name: 'lang', type: 'Lang', opt: true },
				{ name: 'preprocess', type: 'Preprocess', opt: true },
			], 'Ocr'),
			desc('record', [
				{ name: 'action', type: 'Action', opt: true },
				{ name: 'opts', type: 'Opts', opt: true },
			], 'Record'),
			desc('scroll', [
				{ name: 'rect', type: 'Rect', opt: true },
				{ name: 'opts', type: 'Opts', opt: true },
			], 'Scroll'),
			desc('save', [
				{ name: 'dataUrl', type: 'DataUrl', opt: true },
				{ name: 'name', type: 'Name', opt: true },
			], 'Save'),
			desc('list', [], 'List'),
			desc('status', [], 'Status'),
			desc('winlist', [
				{ name: 'exclude', type: 'Exclude', opt: true },
				{ name: 'limit', type: 'Limit', opt: true },
			], 'WinList'),
			desc('poll', [{ name: 'since', type: 'Since', opt: true }], 'Poll'),
			desc('hotkeys', [
				{ name: 'action', type: 'Action', opt: true },
				{ name: 'opts', type: 'Opts', opt: true },
			], 'Hotkeys'),
			// 贴图（R67c）：**任何**图都钉成同一个原生贴图窗。以前长截图 / 录屏抽帧走的是
			// 页面里那套 DOM 贴图（另一套缩放 + 另一套动作条），同一个"贴图"两种手感。
			desc('pin', [
				{ name: 'dataUrl', type: 'DataUrl', opt: true },
				{ name: 'opts', type: 'Opts', opt: true },
			], 'Pin'),
			// 真实桌面上的**框选**（宿主常驻助手出全屏真窗口，盖在别的应用之上）。
			// 老宿主没有这个方法 —— 客户端先 `typeof shot.api.overlay === 'function'`，
			// 没有就自动回落到应用内 DOM 覆盖层。
			desc('overlay', [
				{ name: 'timeout', type: 'Timeout', opt: true },
				{ name: 'opts', type: 'Opts', opt: true },
			], 'Overlay'),
		]

		/** 解包 RemoteResult：ok → value；否则抛错。 */
		function unwrap(result) {
			if (result !== null && typeof result === 'object' && result.ok === true) return result.value
			const message = result && result.error ? result.error.code + ': ' + result.error.message : 'remote call failed'
			throw new Error(message)
		}

		/* ══════════════ 覆盖层（唯一真源就在这里；ui/overlay.js 只是指针）══════════════
		   为什么内联而不是 import：官方客户端模块只服务**声明过的 chunk**
		   （dsh-client-modules/lib/index.js 的 chunkRequest 里 `CLIENT_CHUNK.test(fileName)` +
		   URL 必须带 rev），任意路径取不到；官方插件（dsh-voice-local）也是 build 内联。
		   dev/harness.html 会**从本文件里把这一段抠出来** eval，所以两端永不漂移。 */

		const DSHOT_CSS = `
.dshot-root{position:fixed;inset:0;z-index:2147483000;background:rgba(12,12,14,.86);cursor:crosshair;
  font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;-webkit-user-select:none;user-select:none}
.dshot-stage{position:absolute;inset:0;display:block}
.dshot-canvas{position:absolute;left:0;top:0;display:block;image-rendering:auto}
.dshot-hint{position:fixed;left:50%;top:18px;transform:translateX(-50%);color:#fff;font-size:13px;
  background:rgba(0,0,0,.55);padding:6px 14px;border-radius:999px;pointer-events:none;letter-spacing:.3px}
.dshot-badge{position:fixed;display:none;color:#fff;font-size:12px;background:rgba(0,0,0,.72);
  padding:2px 8px;border-radius:6px;pointer-events:none;font-variant-numeric:tabular-nums}
.dshot-bar{position:fixed;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 16px);
  background:#26262b;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:6px 8px;
  box-shadow:0 10px 40px rgba(0,0,0,.5);z-index:2147483001;pointer-events:auto}
/* 马赛克：拖动时只画选框，松手才落块 —— 边拖边糊会让人以为"跟着鼠标涂抹" */
.dshot-dash{position:fixed;border:1.5px dashed #4aa3ff;background:rgba(74,163,255,.10);
  pointer-events:none;z-index:2147483000;border-radius:2px}
/* 调色板：常用色 + 最近自定义 + 原生取色器（要能自己调色） */
.dshot-palette{position:fixed;z-index:2147483005;background:#26262b;border:1px solid rgba(255,255,255,.18);
  border-radius:10px;padding:8px;display:flex;flex-wrap:wrap;gap:6px;width:196px;box-shadow:0 10px 40px rgba(0,0,0,.55)}
.dshot-palette .dshot-color{width:22px;height:22px}
.dshot-palette-row{display:flex;align-items:center;gap:8px;width:100%;margin-top:2px;
  padding-top:7px;border-top:1px solid rgba(255,255,255,.14);color:#dcdce0;font-size:12px}
.dshot-palette input[type=color]{width:38px;height:24px;padding:0;border:1px solid rgba(255,255,255,.3);
  border-radius:6px;background:#1c1c20;cursor:pointer}
.dshot-hex{flex:1;min-width:0;background:#1c1c20;color:#e8e8ea;border:1px solid rgba(255,255,255,.18);
  border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;outline:none}
/* 窗口选择器 */
.dshot-winlist{position:fixed;inset:0;z-index:2147483006;background:rgba(10,10,12,.72);
  display:flex;align-items:center;justify-content:center;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.dshot-winbox{width:min(760px,86vw);max-height:82vh;display:flex;flex-direction:column;gap:8px;
  background:#1e1e22;border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:12px;box-shadow:0 24px 70px rgba(0,0,0,.6)}
.dshot-winhead{color:#f2f2f4;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.dshot-winhead small{font-weight:400;opacity:.6}
.dshot-wingrid{overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:7px;padding:2px}
.dshot-win{display:flex;flex-direction:column;gap:3px;text-align:left;cursor:pointer;color:#e8e8ea;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 9px;font:inherit}
.dshot-win:hover{background:rgba(74,163,255,.22);border-color:#4aa3ff}
.dshot-win b{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshot-win span{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}
/* 手动长截图：覆盖层必须**不挡鼠标**，否则用户自己的滚轮到不了页面 */
.dshot-longroot{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
.dshot-longframe{position:fixed;border:2px solid #0a84ff;box-shadow:0 0 0 9999px rgba(10,10,14,.34);pointer-events:none}
.dshot-longbar{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483004;
  display:flex;align-items:center;gap:8px;pointer-events:auto;background:#26262b;
  border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:8px 12px;color:#f2f2f4;font-size:12.5px;
  box-shadow:0 10px 40px rgba(0,0,0,.6);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.dshot-longbar b{font-variant-numeric:tabular-nums;color:#7cc0ff}
.dshot-longbar .dshot-btn{height:26px;min-width:26px;font-size:12px}
.dshot-hk{font-size:11px;opacity:.55;font-family:inherit}
.dshot-group{display:flex;align-items:center;gap:3px}
.dshot-group+.dshot-group{padding-left:6px;margin-left:2px;border-left:1px solid rgba(255,255,255,.14)}
.dshot-btn{appearance:none;border:1px solid transparent;background:rgba(255,255,255,.08);color:#f2f2f4;
  cursor:pointer;font:inherit;font-size:13px;line-height:1;min-width:28px;height:28px;padding:0 7px;
  border-radius:8px;display:inline-flex;align-items:center;justify-content:center}
.dshot-btn:hover{background:rgba(255,255,255,.2)}
.dshot-btn.is-on{background:#0a84ff;border-color:#4aa3ff;color:#fff;font-weight:600}
.dshot-primary{background:#0a84ff;border-color:#4aa3ff;color:#fff;font-weight:600;padding:0 12px}
.dshot-primary:hover{background:#3a9bff}
.dshot-color{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.5);cursor:pointer;padding:0}
.dshot-color.is-on{box-shadow:0 0 0 2px #0a84ff;border-color:#fff}
.dshot-range{width:74px;accent-color:#0a84ff}
.dshot-textinput{position:fixed;z-index:2147483002;background:#1c1c20;color:#fff;border:1px solid #0a84ff;
  border-radius:6px;padding:3px 6px;font-family:inherit;outline:none;min-width:90px}
.dshot-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%) translateY(8px);opacity:0;
  transition:opacity .16s,transform .16s;background:rgba(0,0,0,.82);color:#fff;font-size:12.5px;
  padding:7px 14px;border-radius:8px;pointer-events:none;z-index:2147483003;max-width:70vw}
.dshot-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}
.dshot-textpanel{position:fixed;right:20px;bottom:20px;width:min(520px,46vw);z-index:2147483003;
  background:#26262b;border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:10px;
  display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.dshot-textpanel-head{color:#f2f2f4;font-size:12.5px;font-weight:600}
.dshot-textpanel-body{height:190px;resize:vertical;background:#1c1c20;color:#e8e8ea;border:1px solid rgba(255,255,255,.16);
  border-radius:8px;padding:8px;font-family:inherit;font-size:12.5px;line-height:1.5;outline:none}
.dshot-textpanel-foot{display:flex;gap:6px;justify-content:flex-end}
.dshot-menu{position:fixed;z-index:2147483004;background:#26262b;border:1px solid rgba(255,255,255,.16);
  border-radius:10px;padding:5px;min-width:210px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.dshot-mi{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;color:#f2f2f4;
  font-size:12.5px;cursor:pointer;white-space:nowrap}
.dshot-mi:hover{background:rgba(255,255,255,.12)}
.dshot-mi kbd{margin-left:auto;font:inherit;font-size:11px;opacity:.55;font-family:inherit}
.dshot-mi.is-on{color:#4aa3ff}
.dshot-mi.is-bad{color:#ffb4b4;background:rgba(255,90,90,.14);white-space:normal;max-width:280px;line-height:1.4}
.dshot-mi-sep{height:1px;background:rgba(255,255,255,.14);margin:4px 2px}
/* 关掉按钮：贴图窗（原生）与录屏结果面板共用同一个红点样式（R67c 起不再有 DOM 贴图容器） */
.dshot-pin-x{position:absolute;right:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:#ff3b30;
  color:#fff;font-size:11px;line-height:18px;text-align:center;cursor:pointer;border:none;padding:0}
.dshot-rec{position:fixed;right:18px;top:18px;z-index:2147482900;display:flex;align-items:center;gap:8px;
  background:rgba(20,20,24,.92);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:999px;
  padding:6px 10px 6px 12px;font-size:12.5px}
.dshot-rec i{width:9px;height:9px;border-radius:50%;background:#ff3b30;animation:dshot-blink 1.1s infinite}
@keyframes dshot-blink{0%,100%{opacity:1}50%{opacity:.25}}
/* 撤销/重做：不可用时**看得见地灰掉**（比"点了没反应"诚实） */
.dshot-btn.is-off{opacity:.3;cursor:default}
.dshot-btn.is-off:hover{background:rgba(255,255,255,.08)}
/* 录屏结果面板：不落盘，先让人看清楚再决定留不留 */
.dshot-recpanel{position:fixed;right:18px;bottom:18px;width:min(580px,54vw);z-index:2147483007;
  background:#26262b;border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:11px;
  display:flex;flex-direction:column;gap:9px;box-shadow:0 24px 70px rgba(0,0,0,.6);
  font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#f2f2f4}
.dshot-recpanel-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.dshot-recpanel-head small{font-weight:400;opacity:.62;font-size:11.5px}
.dshot-recpanel-stage{display:flex;gap:9px;align-items:flex-start}
.dshot-recpanel-stage img{width:230px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:#111}
.dshot-film{display:flex;gap:3px;overflow-x:auto;padding:3px;background:#1c1c20;border-radius:8px;flex:1;min-width:0}
.dshot-film img{height:44px;border-radius:3px;cursor:pointer;opacity:.7;border:1px solid transparent}
.dshot-film img.is-on{opacity:1;border-color:#4aa3ff}
.dshot-trim{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#d6d6db}
.dshot-trim input[type=range]{flex:1;min-width:0;accent-color:#0a84ff}
.dshot-trim b{font-variant-numeric:tabular-nums;color:#7cc0ff;min-width:44px;text-align:right}
.dshot-recpanel-foot{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.dshot-recpanel-foot .dshot-btn{height:30px;padding:0 10px}
.dshot-recpanel-note{font-size:11px;opacity:.55;line-height:1.45}
/* 长截图：会话里的实时缩略图 + 暂停态 */
.dshot-longbar img{height:30px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:#111}
.dshot-longbar .is-warn{color:#ffcf7a}
`

		/**
		 * 装上截图插件的**主**样式表（`.dshot-menu` / `.dshot-root` / `.dshot-toast` 全在这一张里）。
		 *
		 * ⚠️「元素在」不等于「样式对」—— 必须比内容，丢了就重装。实测（2026-10-16）：
		 *   一次客户端重载之后 `dshot-styles` 整张消失，只剩 372 字节的 `dshot-trigger-styles`；
		 *   此时点 📷 弹出的菜单**没有任何样式**：`.dshot-menu{position:fixed}` 不成立，
		 *   菜单就掉进 `<body>` 的正常流 —— 落在 body 末尾（窗口左下角、还在视口下方），
		 *   白底、全宽、鼠标点不到，而且一条诊断都不上报。
		 *   用户原话：「菜单能弹，但位置跑到屏幕/窗口角落，不在按钮旁边」。
		 */
		function ensureShotStyles() {
			const cur = document.getElementById('dshot-styles')
			if (cur !== null && cur.textContent === DSHOT_CSS) return
			if (cur !== null) cur.remove()
			const el = document.createElement('style')
			el.id = 'dshot-styles'
			el.textContent = DSHOT_CSS
			document.head.appendChild(el)
		}

		/**
		 * 截图标注覆盖层（纯 DOM/Canvas）。
		 * 坐标约定：**一切以原图像素为准**（image px）。canvas 的 width/height = 原图分辨率，
		 * 显示尺寸 = 原图 / dpr（和系统在 125% 缩放下显示的效果一致，导出的图是全分辨率的）。
		 * 渲染模型：单 canvas + op 列表，每次变更整体重绘 → 撤销/重做只是移动游标；
		 * 马赛克也能自然地盖在「当时画布上已有的内容」上。
		 */
		/**
		 * 视口顶部**不能被点击**的高度。
		 *
		 * 为什么需要这个：Electron 的标题栏/无边框窗口会在顶上放一条
		 * `-webkit-app-region: drag` 的区域。那条区域里的鼠标事件被操作系统拿去做
		 * "拖动窗口"，**根本不会进 DOM** —— 于是工具栏一旦被摆到顶上，它上半截就点不动了。
		 * 用户报的「工具栏到顶上时点击的判定范围突然变得很小」就是这个。
		 *
		 * ⚠️ `document.elementFromPoint()` **看不见** 这件事：它照样返回那个按钮，
		 *    所以只靠 elementFromPoint 的自检会得出"一切正常"的错误结论（实测过：
		 *    23/23 按钮命中，坏 0 个，而用户点不动）。
		 *
		 * 结果按 dpr 无关的 CSS px 计算，并且缓存 —— `body *` 在这个应用里有几千个节点，
		 * 每次重排都扫一遍是不可接受的。
		 */
		let safeTopCache = -1
		function topSafeInset() {
			if (safeTopCache >= 0) return safeTopCache
			// 兜底：无边框窗口的拖动条一般 30~40px。宁可多留一点，也别把按钮塞进拖动区。
			let inset = 44
			try {
				const all = document.querySelectorAll('body *')
				const limit = Math.min(all.length, 4000)
				for (let i = 0; i < limit; i += 1) {
					const el = all[i]
					if (el.className && typeof el.className === 'string' && el.className.indexOf('dshot-') === 0) continue
					const r = el.getBoundingClientRect()
					if (r.height === 0 || r.width < 80 || r.top > 140 || r.bottom <= 0) continue
					const cs = window.getComputedStyle(el)
					const region = cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || ''
					if (region === 'drag') inset = Math.max(inset, Math.ceil(r.bottom) + 4)
				}
			} catch {}
			safeTopCache = inset
			return inset
		}

		function createShotOverlay(opts) {
			ensureShotStyles()
			const regionOnly = opts.regionOnly === true
			const image = opts.image
			const natural = { w: image.naturalWidth || image.width, h: image.naturalHeight || image.height }
			const dpr = opts.dpr && opts.dpr > 0 ? opts.dpr : window.devicePixelRatio || 1
			const doc = document

			const state = {
				tool: 'rect',
				color: '#ff3b30',
				size: 3,
				fontSize: 20,
				/** 点一下落下的马赛克块边长（原图像素）。和画笔粗细解耦。 */
				mosaicBlock: Number(opts.mosaicBlock) > 3 ? Number(opts.mosaicBlock) : 18,
				/** 调色板最近用过的自定义颜色（跟着 prefs 走）。 */
				customColors: Array.isArray(opts.customColors) ? opts.customColors.slice(0, 10) : [],
				sel: null,
				ops: [],
				undone: [],
				draft: null,
				dragging: null,
				dragFrom: null,
				textEditing: null,
				zoom: 1,
				hidden: false,
				cursor: undefined,
			}

			const root = doc.createElement('div')
			root.className = 'dshot-root'
			const stage = doc.createElement('div')
			stage.className = 'dshot-stage'
			const canvas = doc.createElement('canvas')
			canvas.className = 'dshot-canvas'
			canvas.width = natural.w
			canvas.height = natural.h
			canvas.style.width = natural.w / dpr + 'px'
			canvas.style.height = natural.h / dpr + 'px'
			const ctx = canvas.getContext('2d', { willReadFrequently: true })

			const hint = doc.createElement('div')
			hint.className = 'dshot-hint'
			hint.textContent = regionOnly
				? '框选要滚动截取的区域（默认你自己滚，它自动接帧；工具条上可切"程序自己滚"）· Esc 取消'
				: '拖动鼠标框选 · 选完可标注 · Esc 取消 · Enter 完成（贴进输入框 + 复制）'

			const badge = doc.createElement('div')
			badge.className = 'dshot-badge'

			const bar = doc.createElement('div')
			bar.className = 'dshot-bar'

			stage.append(canvas, badge, bar)
			root.append(stage, hint)
			mountBody(root)

			const textInput = doc.createElement('input')
			textInput.className = 'dshot-textinput'
			textInput.style.display = 'none'
			mountBody(textInput)

			function toImage(ev) {
				const r = canvas.getBoundingClientRect()
				return {
					x: ((ev.clientX - r.left) / r.width) * natural.w,
					y: ((ev.clientY - r.top) / r.height) * natural.h,
				}
			}

			function clampRect(r) {
				const x = Math.max(0, Math.min(natural.w, r.x))
				const y = Math.max(0, Math.min(natural.h, r.y))
				const w = Math.max(1, Math.min(natural.w - x, r.w))
				const h = Math.max(1, Math.min(natural.h - y, r.h))
				return { x: x, y: y, w: w, h: h }
			}

			function normRect(a, b) {
				return clampRect({
					x: Math.min(a.x, b.x),
					y: Math.min(a.y, b.y),
					w: Math.abs(a.x - b.x),
					h: Math.abs(a.y - b.y),
				})
			}

			function selScreenRect() {
				if (state.sel === null) return null
				const r = canvas.getBoundingClientRect()
				const sx = r.width / natural.w
				const sy = r.height / natural.h
				return {
					left: r.left + state.sel.x * sx,
					top: r.top + state.sel.y * sy,
					width: state.sel.w * sx,
					height: state.sel.h * sy,
					scaleX: sx,
					scaleY: sy,
				}
			}

			function drawArrow(c, from, to, width, color) {
				const head = Math.max(10, width * 4)
				const angle = Math.atan2(to.y - from.y, to.x - from.x)
				c.strokeStyle = color
				c.fillStyle = color
				c.lineWidth = width
				c.lineCap = 'round'
				c.beginPath()
				c.moveTo(from.x, from.y)
				c.lineTo(to.x - Math.cos(angle) * head * 0.6, to.y - Math.sin(angle) * head * 0.6)
				c.stroke()
				c.beginPath()
				c.moveTo(to.x, to.y)
				c.lineTo(to.x - Math.cos(angle - 0.42) * head, to.y - Math.sin(angle - 0.42) * head)
				c.lineTo(to.x - Math.cos(angle + 0.42) * head, to.y - Math.sin(angle + 0.42) * head)
				c.closePath()
				c.fill()
			}

			function drawOp(c, op) {
				c.save()
				c.lineJoin = 'round'
				if (op.kind === 'rect') {
					c.strokeStyle = op.color
					c.lineWidth = op.width
					c.strokeRect(op.x, op.y, op.w, op.h)
				} else if (op.kind === 'ellipse') {
					c.strokeStyle = op.color
					c.lineWidth = op.width
					c.beginPath()
					c.ellipse(op.x + op.w / 2, op.y + op.h / 2, Math.abs(op.w / 2), Math.abs(op.h / 2), 0, 0, Math.PI * 2)
					c.stroke()
				} else if (op.kind === 'arrow') {
					drawArrow(c, { x: op.x, y: op.y }, { x: op.x + op.w, y: op.y + op.h }, op.width, op.color)
				} else if (op.kind === 'pen') {
					c.strokeStyle = op.color
					c.lineWidth = op.width
					c.lineCap = 'round'
					c.beginPath()
					op.points.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)))
					c.stroke()
				} else if (op.kind === 'text') {
					c.fillStyle = op.color
					c.font = '600 ' + op.size + 'px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
					c.textBaseline = 'top'
					String(op.text)
						.split('\n')
						.forEach((line, i) => c.fillText(line, op.x, op.y + i * op.size * 1.25))
				} else if (op.kind === 'mosaic') {
					const w = Math.max(1, Math.round(op.w))
					const h = Math.max(1, Math.round(op.h))
					const x = Math.max(0, Math.round(op.x))
					const y = Math.max(0, Math.round(op.y))
					// 块边长是**用户定的**（state.mosaicBlock），不再跟着画笔粗细走 ——
					// 那样"打码"和"画线"共用一个滑块，两边都不好用。
					const block = Math.max(4, Math.round(op.block || state.mosaicBlock || 18))
					const sw = Math.max(1, Math.round(w / block))
					const sh = Math.max(1, Math.round(h / block))
					const tmp = doc.createElement('canvas')
					tmp.width = sw
					tmp.height = sh
					const tc = tmp.getContext('2d')
					// 从 image 取像素，不是从 canvas —— 否则叠两块马赛克时，第二块会把
					// 第一块已经糊掉的像素再糊一次，越糊越大。
					tc.drawImage(image, x, y, w, h, 0, 0, sw, sh)
					c.imageSmoothingEnabled = false
					c.drawImage(tmp, 0, 0, sw, sh, x, y, w, h)
					c.imageSmoothingEnabled = true
				}
				c.restore()
			}

			function render() {
				ctx.setTransform(1, 0, 0, 1, 0, 0)
				ctx.clearRect(0, 0, natural.w, natural.h)
				ctx.drawImage(image, 0, 0, natural.w, natural.h)
				const all = state.cursor === undefined ? state.ops : state.ops.slice(0, state.cursor)
				for (const op of all) drawOp(ctx, op)
				if (state.draft !== null) {
					// 马赛克拖动时**只画选框**，松手才真的糊。
					// 每帧重糊一遍会让人以为它是"跟着鼠标涂抹"，而且中途的糊块会被后一帧
					// 当成源像素再糊一次 —— 观感和结果都是错的。
					if (state.draft.kind === 'mosaic') drawDraftOutline(state.draft)
					else drawOp(ctx, state.draft)
				}
				if (state.sel !== null && !state.hidden) {
					ctx.save()
					ctx.fillStyle = 'rgba(0,0,0,.18)'
					ctx.beginPath()
					ctx.rect(0, 0, natural.w, natural.h)
					ctx.rect(state.sel.x, state.sel.y, state.sel.w, state.sel.h)
					ctx.fill('evenodd')
					ctx.restore()
				}
				drawHandles()
				layoutBar()
				syncHistory()
			}

			/** 马赛克拖动中的虚线提示框（画在画布上，跟着图像缩放走）。 */
			function drawDraftOutline(d) {
				const r = canvas.getBoundingClientRect()
				const scale = r.width / natural.w || 1
				const x = Math.min(d.x, d.x + d.w)
				const y = Math.min(d.y, d.y + d.h)
				const w = Math.abs(d.w)
				const h = Math.abs(d.h)
				ctx.save()
				ctx.fillStyle = 'rgba(74,163,255,.14)'
				ctx.fillRect(x, y, w, h)
				ctx.setLineDash([6 / scale, 4 / scale])
				ctx.strokeStyle = '#4aa3ff'
				ctx.lineWidth = 1.5 / scale
				ctx.strokeRect(x, y, w, h)
				ctx.restore()
			}

			function handlePoints() {
				const s = state.sel
				return [
					[s.x, s.y],
					[s.x + s.w / 2, s.y],
					[s.x + s.w, s.y],
					[s.x + s.w, s.y + s.h / 2],
					[s.x + s.w, s.y + s.h],
					[s.x + s.w / 2, s.y + s.h],
					[s.x, s.y + s.h],
					[s.x, s.y + s.h / 2],
				]
			}

			const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

			function drawHandles() {
				if (state.sel === null || state.hidden) return
				const r = canvas.getBoundingClientRect()
				const sx = r.width / natural.w || 1
				const s = 8 / sx
				ctx.save()
				ctx.strokeStyle = '#ffffff'
				ctx.lineWidth = 1.5 / sx
				ctx.fillStyle = '#1f6feb'
				for (const pt of handlePoints()) {
					ctx.beginPath()
					ctx.rect(pt[0] - s / 2, pt[1] - s / 2, s, s)
					ctx.fill()
					ctx.stroke()
				}
				ctx.restore()
			}

			function hitHandle(p) {
				if (state.sel === null) return null
				const r = canvas.getBoundingClientRect()
				const tol = 10 / (r.width / natural.w || 1)
				const pts = handlePoints()
				for (let i = 0; i < pts.length; i += 1) {
					if (Math.abs(p.x - pts[i][0]) <= tol && Math.abs(p.y - pts[i][1]) <= tol) return HANDLES[i]
				}
				return null
			}

			function insideSel(p) {
				const s = state.sel
				return s !== null && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h
			}

			const TOOLS = [
				['rect', '▭', '矩形'],
				['ellipse', '◯', '椭圆'],
				['arrow', '↗', '箭头'],
				['pen', '✎', '画笔'],
				['text', 'T', '文字'],
				['mosaic', '▦', '马赛克'],
			]
			const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#111111']

			/**
			 * 调色板：常用色 + 最近自定义 + 原生取色器 + 手输 hex。
			 *
			 * 用户原话是「颜色选择不够丰富，要能够自己调色」，所以这里的关键不是多加几个
			 * 预设色块（那还是有限集），而是把**任意颜色**这条路打通：`<input type=color>`
			 * 给出系统取色器，hex 框给键盘党，用过的颜色回到第一排变成快捷键。
			 */
			function openPalette(anchorBtn) {
				const existing = doc.querySelector('.dshot-palette')
				if (existing !== null) {
					existing.remove()
					return
				}
				const pal = doc.createElement('div')
				pal.className = 'dshot-palette'
				const quick = COLORS.concat(state.customColors.filter((c) => COLORS.indexOf(c) < 0))
				for (const c of quick) {
					const b = doc.createElement('button')
					b.type = 'button'
					b.className = 'dshot-color' + (c === state.color ? ' is-on' : '')
					b.style.background = c
					b.title = c
					b.addEventListener('click', (ev) => {
						ev.stopPropagation()
						applyColor(c)
						openPaletteRefresh(pal)
					})
					pal.appendChild(b)
				}
				const row = doc.createElement('div')
				row.className = 'dshot-palette-row'
				const picker = doc.createElement('input')
				picker.type = 'color'
				picker.value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#ff3b30'
				picker.title = '任意颜色（系统取色器）'
				const hex = doc.createElement('input')
				hex.type = 'text'
				hex.className = 'dshot-hex'
				hex.value = state.color
				hex.spellcheck = false
				const sync = (v, commit) => {
					hex.value = v
					picker.value = /^#[0-9a-f]{6}$/i.test(v) ? v : picker.value
					if (commit) applyColor(v)
				}
				picker.addEventListener('input', () => sync(picker.value, true))
				picker.addEventListener('change', () => sync(picker.value, true))
				hex.addEventListener('input', () => {
					const v = hex.value.trim()
					if (/^#[0-9a-f]{6}$/i.test(v)) sync(v, true)
				})
				hex.addEventListener('keydown', (ev) => {
					ev.stopPropagation()
					if (ev.key === 'Enter') {
						ev.preventDefault()
						sync(hex.value.trim(), true)
					}
				})
				row.append(picker, hex)
				pal.appendChild(row)
				mountBody(pal)
				const r = anchorBtn.getBoundingClientRect()
				const pw = pal.offsetWidth || 196
				const ph = pal.offsetHeight || 120
				pal.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - pw - 8, r.left - pw / 2 + 10))) + 'px'
				pal.style.top = Math.round(Math.max(topSafeInset(), r.top - ph - 8)) + 'px'
			}

			function openPaletteRefresh(pal) {
				pal.querySelectorAll('.dshot-color').forEach((b) => {
					b.classList.toggle('is-on', b.title === state.color)
				})
			}

			/** 换色：把颜色记进「最近用过」，并立刻同步工具栏上的色块。 */
			function applyColor(c) {
				if (typeof c !== 'string' || c.length === 0) return
				state.color = c
				const custom = state.customColors.filter((x) => x !== c)
				custom.unshift(c)
				state.customColors = custom.slice(0, 10)
				if (typeof opts.onColors === 'function') opts.onColors(state.customColors)
				const dot = bar.querySelector('[data-color-dot]')
				if (dot !== null) dot.style.background = c
				syncBar()
			}

			function mkBtn(label, title, onClick, cls) {
				const b = doc.createElement('button')
				b.type = 'button'
				b.className = 'dshot-btn' + (cls ? ' ' + cls : '')
				b.title = title || label
				b.textContent = label
				b.addEventListener('click', (ev) => {
					ev.stopPropagation()
					onClick(b)
				})
				return b
			}

			function buildBar() {
				bar.textContent = ''
				// 长截图的第一步只要「框一块区域出来」，画标注没意义 —— 只留 ✕ / ✓
				if (regionOnly) {
					const gOnly = doc.createElement('div')
					gOnly.className = 'dshot-group'
					gOnly.append(
						mkBtn('✕', '取消 (Esc)', () => close(null)),
						mkBtn('✓', '就截这块（回车）', () => void finish(), 'dshot-primary')
					)
					bar.append(gOnly)
					return
				}
				const g1 = doc.createElement('div')
				g1.className = 'dshot-group'
				for (const t of TOOLS) {
					const b = mkBtn(t[1], t[2], () => {
						state.tool = t[0]
						state.hidden = false
						syncBar()
						render()
					})
					b.dataset.tool = t[0]
					g1.appendChild(b)
				}

				const g2 = doc.createElement('div')
				g2.className = 'dshot-group'
				// 当前色 + 最近用过的 4 个 + 「更多颜色」入口。
				// 原来这里平铺 8 个固定色块 —— 再多也是有限集，用户要的是"能自己调"。
				const dot = doc.createElement('button')
				dot.type = 'button'
				dot.className = 'dshot-color is-on'
				dot.dataset.colorDot = '1'
				dot.style.background = state.color
				dot.title = '颜色：' + state.color + '（点开调色板）'
				dot.addEventListener('click', (ev) => {
					ev.stopPropagation()
					openPalette(dot)
				})
				g2.appendChild(dot)
				for (const c of COLORS.slice(0, 4)) {
					const b = doc.createElement('button')
					b.type = 'button'
					b.className = 'dshot-color'
					b.title = c
					b.style.background = c
					b.dataset.color = c
					b.addEventListener('click', (ev) => {
						ev.stopPropagation()
						applyColor(c)
					})
					g2.appendChild(b)
				}
				const more = mkBtn('🎨', '更多颜色 / 自定义调色', () => openPalette(more))
				more.className += ' dshot-more-color'
				g2.appendChild(more)

				const g3 = doc.createElement('div')
				g3.className = 'dshot-group'
				const range = doc.createElement('input')
				range.type = 'range'
				range.min = '1'
				range.max = '12'
				range.step = '1'
				range.value = String(state.size)
				range.className = 'dshot-range'
				range.title = '粗细'
				range.addEventListener('input', () => {
					// 滑块的含义跟着当前工具走：画笔/线宽调 size，马赛克调块边长。
					if (state.tool === 'mosaic') state.mosaicBlock = 6 + Number(range.value) * 4
					else {
						state.size = Number(range.value)
						state.fontSize = 12 + Number(range.value) * 2
					}
					range.title = state.tool === 'mosaic' ? '马赛克块大小' : '粗细'
				})
				state.rangeEl = range
				g3.appendChild(range)

				const g4 = doc.createElement('div')
				g4.className = 'dshot-group'
				const undoBtn = mkBtn('↶', '撤销 (Ctrl+Z)', () => undo())
				undoBtn.dataset.hist = 'undo'
				const redoBtn = mkBtn('↷', '重做 (Ctrl+Y)', () => redo())
				redoBtn.dataset.hist = 'redo'
				g4.append(
					undoBtn,
					redoBtn,
					mkBtn('Aa', '提取文字', () => void runOcr()),
					mkBtn('📌', '贴图（钉在界面上）', () => void pin()),
					mkBtn('💾', '保存到文件', () => void saveFile()),
					mkBtn('⧉', '只复制到剪贴板', () => void copyOnly()),
					mkBtn('✕', '取消 (Esc)', () => close(null)),
					mkBtn('✓', '完成：贴进输入框 + 复制', () => void finish(), 'dshot-primary')
				)

				bar.append(g1, g2, g3, g4)
			}

			function syncBar() {
				bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === state.tool))
				bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('is-on', b.dataset.color === state.color))
				const dot = bar.querySelector('[data-color-dot]')
				if (dot !== null) {
					dot.style.background = state.color
					dot.title = '颜色：' + state.color + '（点开调色板）'
				}
				// 滑块跟着工具换含义；换工具时把值也拨到该工具当前的设置上。
				const range = state.rangeEl
				if (range !== undefined && range !== null) {
					if (state.tool === 'mosaic') {
						range.title = '马赛克块大小'
						range.value = String(Math.max(1, Math.min(12, Math.round((state.mosaicBlock - 6) / 4))))
					} else {
						range.title = '粗细'
						range.value = String(state.size)
					}
				}
			}

			function layoutBar() {
				const sel = state.sel
				const vw = window.innerWidth
				const vh = window.innerHeight
				const bw = bar.offsetWidth || 560
				const bh = bar.offsetHeight || 44
				// 顶上的拖动条是**死区**：摆进去的那部分按钮点不动（见 topSafeInset）。
				const safeTop = topSafeInset()
				const M = 8
				const clampTop = (v) => Math.max(safeTop, Math.min(v, vh - bh - M))
				const clampLeft = (v) => Math.max(M, Math.min(v, vw - bw - M))

				let left
				let top
				if (sel === null) {
					left = clampLeft((vw - bw) / 2)
					top = clampTop(vh - bh - 24)
				} else {
					const r = selScreenRect()
					left = clampLeft(Math.min(Math.max(M, r.left), vw - bw - M))
					const below = r.top + r.height + 10
					const above = r.top - bh - 10
					// 优先级（QQ/微信的截图工具就是这个次序）：
					//   1) 选区够高 → 贴在选区**底边内侧**。工具栏跟着内容走，永远不会跑到
					//      屏幕顶上，也永远不会压住选区的上边缘把手。
					//   2) 放得下 → 贴选区下沿外侧
					//   3) 放得下 → 贴选区上沿外侧（但不能进 safeTop 那条死区）
					//   4) 都不行 → 屏幕底部
					//
					// 旧代码只有 2) 和 3)，3) 还写成 Math.max(8, above) —— 选区几乎占满屏幕时
					// 工具栏被顶到 y=8。用户报的「工具栏到顶上时点击判定范围突然变得很小」
					// 就出在那条分支上。实测 elementFromPoint 在那个位置 23/23 按钮都命中
					// （见 R17 记录），所以那更像是窗口顶部热区/把手的干扰，而不是 DOM 命中 ——
					// 那就干脆别把它放到那儿。
					if (r.height > bh + 26) top = r.top + r.height - bh - 8
					else if (below + bh <= vh - M) top = below
					else if (above >= safeTop) top = above
					else top = vh - bh - 12
					top = clampTop(top)
				}
				bar.style.left = Math.round(left) + 'px'
				bar.style.top = Math.round(top) + 'px'
				if (sel === null) {
					badge.style.display = 'none'
				} else {
					const r2 = selScreenRect()
					badge.style.display = 'block'
					badge.textContent = Math.round(sel.w) + ' × ' + Math.round(sel.h)
					badge.style.left = Math.round(Math.max(M, r2.left)) + 'px'
					badge.style.top = Math.round(Math.max(safeTop, r2.top - 24)) + 'px'
				}
			}

			/** 现在"看得见"的 op 有几个（cursor 未定义 = 全都看得见）。 */
			function visibleCount() {
				return state.cursor === undefined ? state.ops.length : state.cursor
			}

			function canUndo() {
				return visibleCount() > 0
			}

			function canRedo() {
				return state.undone.length > 0
			}

			function push(op) {
				// 撤销之后再画新东西 = 丢掉"未来"（所有编辑器都是这个语义）。
				if (state.cursor !== undefined) {
					state.ops = state.ops.slice(0, state.cursor)
					state.cursor = undefined
				}
				state.ops.push(op)
				state.undone.length = 0
			}

			function undo() {
				if (!canUndo()) {
					// **不许静默**：点了没反应，用户只会认为"这个按钮坏了"。
					// 2026-10-16 用户报的「重做按钮点了没有效果」，一半的原因就在这里 ——
					// 没东西可做的时候它一个字都不说。另一半（真的坏掉）在真机上用
					// AI 直连桥复现过：撤销→重做是好的（cursor 0 → undef，红色像素 6332 → 8723）。
					toast('没有可撤销的操作')
					return
				}
				if (state.cursor === undefined) state.cursor = state.ops.length
				state.cursor -= 1
				state.undone.push(state.ops[state.cursor])
				render()
			}

			function redo() {
				if (!canRedo()) {
					toast('没有可重做的操作（撤销之后又画了新东西，就不能再重做）')
					return
				}
				const op = state.undone.pop()
				if (state.cursor === undefined) state.cursor = state.ops.length
				state.ops[state.cursor] = op
				state.cursor += 1
				if (state.cursor >= state.ops.length) state.cursor = undefined
				render()
			}

			/** 撤销/重做按钮的可用状态必须**看得见**：灰掉，比"点了没反应"诚实。 */
			function syncHistory() {
				const u = bar.querySelector('[data-hist="undo"]')
				const r = bar.querySelector('[data-hist="redo"]')
				if (u !== null) {
					u.classList.toggle('is-off', !canUndo())
					u.title = canUndo() ? '撤销 (Ctrl+Z)' : '没有可撤销的操作'
				}
				if (r !== null) {
					r.classList.toggle('is-off', !canRedo())
					r.title = canRedo() ? '重做 (Ctrl+Y)' : '没有可重做的操作'
				}
			}

			function onDown(ev) {
				if (ev.button !== 0) return
				hideTextInput(true)
				const p = toImage(ev)
				const handle = hitHandle(p)
				if (handle !== null) {
					state.dragging = 'resize'
					state.activeHandle = handle
					state.dragFrom = p
					state.selFrom = Object.assign({}, state.sel)
					ev.preventDefault()
					return
				}
				if (state.tool === 'text' && (state.sel === null || insideSel(p))) {
					// preventDefault 是必需的：不拦的话浏览器会在本次事件派发收尾时把焦点
					// 移回被点中的 canvas，刚 focus 的输入框立刻失焦（见 showTextInput）。
					ev.preventDefault()
					ev.stopPropagation()
					showTextInput(p)
					return
				}
				const painting = state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'arrow' || state.tool === 'pen' || state.tool === 'mosaic'
				if (state.sel !== null && insideSel(p) && painting) {
					state.dragging = 'draw'
					state.draftFrom = p
					if (state.tool === 'pen') {
						state.draft = { kind: 'pen', color: state.color, width: state.size, points: [p] }
					} else if (state.tool === 'mosaic') {
						state.draft = { kind: 'mosaic', color: state.color, width: state.size, block: state.mosaicBlock, x: p.x, y: p.y, w: 0, h: 0 }
					} else {
						state.draft = { kind: state.tool, color: state.color, width: state.size, x: p.x, y: p.y, w: 0, h: 0 }
					}
					ev.preventDefault()
					return
				}
				if (state.sel !== null && insideSel(p)) {
					state.dragging = 'move'
					state.dragFrom = p
					state.selFrom = Object.assign({}, state.sel)
					ev.preventDefault()
					return
				}
				state.hidden = false
				state.dragging = 'new'
				state.dragFrom = p
				state.sel = { x: p.x, y: p.y, w: 1, h: 1 }
				ev.preventDefault()
			}

			function onMove(ev) {
				const p = toImage(ev)
				if (state.dragging === null) {
					const hh = hitHandle(p)
					canvas.style.cursor = hh === null ? (insideSel(p) ? 'move' : 'crosshair') : hh + '-resize'
					return
				}
				if (state.dragging === 'new') {
					state.sel = normRect(state.dragFrom, p)
				} else if (state.dragging === 'move') {
					const dx = p.x - state.dragFrom.x
					const dy = p.y - state.dragFrom.y
					state.sel = clampRect({ x: state.selFrom.x + dx, y: state.selFrom.y + dy, w: state.selFrom.w, h: state.selFrom.h })
				} else if (state.dragging === 'resize') {
					const s = state.selFrom
					const hd = state.activeHandle
					let x1 = s.x
					let y1 = s.y
					let x2 = s.x + s.w
					let y2 = s.y + s.h
					if (hd.indexOf('w') >= 0) x1 = p.x
					if (hd.indexOf('e') >= 0) x2 = p.x
					if (hd.indexOf('n') >= 0) y1 = p.y
					if (hd.indexOf('s') >= 0) y2 = p.y
					state.sel = clampRect({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })
				} else if (state.dragging === 'draw' && state.draft !== null) {
					if (state.draft.kind === 'pen') state.draft.points.push({ x: p.x, y: p.y })
					else {
						state.draft.w = p.x - state.draftFrom.x
						state.draft.h = p.y - state.draftFrom.y
					}
				}
				render()
			}

			function onUp() {
				if (state.dragging === 'draw' && state.draft !== null) {
					const d = state.draft
					const tiny = d.kind === 'pen' ? d.points.length < 2 : Math.abs(d.w) < 3 && Math.abs(d.h) < 3
					if (!tiny) {
						if (d.kind === 'rect' || d.kind === 'ellipse' || d.kind === 'mosaic') {
							d.x = Math.min(d.x, d.x + d.w)
							d.y = Math.min(d.y, d.y + d.h)
							d.w = Math.abs(d.w)
							d.h = Math.abs(d.h)
						}
						if (d.kind === 'mosaic') {
							d.w = Math.max(4, d.w)
							d.h = Math.max(4, d.h)
						}
						push(d)
					} else if (d.kind === 'mosaic') {
						// 点一下不拖 = 在原地**落一块**固定大小的马赛克。
						// 这是用户要的那种手感："唤出一个马赛克块"，而不是跟着鼠标涂抹。
						const side = Math.max(6, Math.round(state.mosaicBlock || 18))
						const from = state.draftFrom || { x: d.x, y: d.y }
						push({
							kind: 'mosaic',
							color: d.color,
							width: d.width,
							block: side,
							x: Math.round(from.x - side / 2),
							y: Math.round(from.y - side / 2),
							w: side,
							h: side,
						})
					}
				}
				state.draft = null
				state.dragging = null
				state.activeHandle = null
				if (state.sel !== null) state.sel = clampRect(state.sel)
				render()
			}

			function showTextInput(p) {
				state.textEditing = { x: p.x, y: p.y }
				const r = canvas.getBoundingClientRect()
				textInput.style.display = 'block'
				textInput.style.left = Math.round(r.left + p.x * (r.width / natural.w)) + 'px'
				textInput.style.top = Math.round(r.top + p.y * (r.height / natural.h)) + 'px'
				textInput.style.fontSize = Math.max(12, state.fontSize * (r.width / natural.w)) + 'px'
				textInput.value = ''
				// 焦点必须在**这一次 mousedown 处理完之后**再给：浏览器的默认行为会在
				// 事件派发结束后把焦点移到被点中的元素上（这里是 canvas/root），
				// 于是刚 focus 的输入框立刻 blur → blur 处理函数把它关掉。
				// 这就是"文字功能点了没反应"的真身：输入框确实建了，活了几毫秒。
				window.setTimeout(() => {
					if (state.textEditing === null) return
					try {
						textInput.focus({ preventScroll: true })
					} catch {
						textInput.focus()
					}
				}, 0)
			}

			function hideTextInput(cancel) {
				if (state.textEditing === null) return
				const value = textInput.value.trim()
				const at = state.textEditing
				state.textEditing = null
				textInput.style.display = 'none'
				textInput.value = ''
				if (!cancel && value.length > 0) {
					push({ kind: 'text', x: at.x, y: at.y, text: value, color: state.color, size: state.fontSize })
					render()
				}
			}

			textInput.addEventListener('keydown', (ev) => {
				ev.stopPropagation()
				if (ev.key === 'Enter' && !ev.shiftKey) {
					ev.preventDefault()
					hideTextInput(false)
				}
				if (ev.key === 'Escape') {
					ev.preventDefault()
					hideTextInput(true)
				}
			})
			// blur 只在"焦点真的离开了输入框、而且没有正在编辑"时才收尾。
			// 直接绑定会在 mousedown 的默认行为里被触发一次，见 showTextInput。
			textInput.addEventListener('blur', () => {
				window.setTimeout(() => {
					if (state.textEditing === null) return
					if (doc.activeElement === textInput) return
					hideTextInput(false)
				}, 120)
			})

			function renderForExport() {
				const keepSel = state.sel
				const keepHidden = state.hidden
				state.sel = null
				state.hidden = true
				render()
				const full = doc.createElement('canvas')
				full.width = natural.w
				full.height = natural.h
				full.getContext('2d').drawImage(canvas, 0, 0)
				state.sel = keepSel
				state.hidden = keepHidden
				render()
				return full
			}

			function toBlob(canvasEl) {
				return new Promise((resolve) => canvasEl.toBlob((b) => resolve(b), 'image/png'))
			}

			async function compose() {
				const full = renderForExport()
				const r = state.sel === null ? { x: 0, y: 0, w: natural.w, h: natural.h } : state.sel
				const x = Math.max(0, Math.round(r.x))
				const y = Math.max(0, Math.round(r.y))
				const w = Math.max(1, Math.min(natural.w - x, Math.round(r.w)))
				const h = Math.max(1, Math.min(natural.h - y, Math.round(r.h)))
				const out = doc.createElement('canvas')
				out.width = w
				out.height = h
				out.getContext('2d').drawImage(full, x, y, w, h, 0, 0, w, h)
				const blob = await toBlob(out)
				return { blob: blob, rect: { x: x, y: y, w: w, h: h }, dataUrl: out.toDataURL('image/png') }
			}

			function toast(msg) {
				let el = doc.querySelector('.dshot-toast')
				if (el === null) {
					el = doc.createElement('div')
					el.className = 'dshot-toast'
					mountBody(el)
				}
				el.textContent = msg
				el.classList.add('is-on')
				clearTimeout(el._t)
				el._t = setTimeout(() => el.classList.remove('is-on'), 2400)
			}

			async function runOcr() {
				if (typeof opts.ocr !== 'function') return
				const region = state.sel
				toast('正在识别文字…')
				try {
					const res = await opts.ocr(region === null ? null : { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) })
					if (!res || res.ok !== true) {
						toast('识别失败：' + ((res && res.error) || '未知错误'))
						return
					}
					showTextPanel(res)
				} catch (error) {
					toast('识别失败：' + String((error && error.message) || error))
				}
			}

			function showTextPanel(res) {
				let panel = doc.querySelector('.dshot-textpanel')
				if (panel === null) {
					panel = doc.createElement('div')
					panel.className = 'dshot-textpanel'
					mountBody(panel)
				}
				panel.textContent = ''
				const head = doc.createElement('div')
				head.className = 'dshot-textpanel-head'
				head.textContent = '提取文字（离线识别 ' + ((res.lines || []).length) + ' 行 · 引擎 ' + (res.lang || '未知') + '）'
				// 识别语言可以现场换再识别一次：这台机器装了 ja 与 zh-Hans-CN，
				// 而实测两者在同一张 DSH 截图上给出的中文**实质不同**（auto 202 个 CJK 字
				// vs ja 173 个），所以"换一个引擎重试"是真实有用的补救手段，不是摆设。
				const langRow = doc.createElement('div')
				langRow.className = 'dshot-textpanel-foot'
				langRow.style.justifyContent = 'flex-start'
				const langs = Array.isArray(res.langs) && res.langs.length > 0 ? res.langs : ['auto']
				const sel = doc.createElement('select')
				sel.className = 'dshot-hex'
				sel.style.flex = '0 0 auto'
				for (const tag of ['auto'].concat(langs.filter((t) => t !== 'auto'))) {
					const o = doc.createElement('option')
					o.value = tag
					o.textContent = tag === 'auto' ? '自动（优先中文）' : tag
					sel.appendChild(o)
				}
				sel.value = prefs().ocrLang || 'auto'
				sel.addEventListener('change', () => setPref('ocrLang', sel.value))
				const again = doc.createElement('button')
				again.type = 'button'
				again.className = 'dshot-btn'
				again.textContent = '用这个语言重识别'
				again.addEventListener('click', async () => {
					setPref('ocrLang', sel.value)
					if (typeof opts.ocr !== 'function') return
					again.disabled = true
					again.textContent = '识别中…'
					const region = state.sel
					try {
						const next = await opts.ocr(
							region === null ? null : { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) },
							sel.value
						)
						if (next && next.ok === true) showTextPanel(next)
						else toast('识别失败：' + ((next && next.error) || '未知错误'))
					} catch (error) {
						toast('识别失败：' + String((error && error.message) || error))
					}
				})
				langRow.append(sel, again)
				const body = doc.createElement('textarea')
				body.className = 'dshot-textpanel-body'
				body.value = res.text || ''
				body.spellcheck = false
				const foot = doc.createElement('div')
				foot.className = 'dshot-textpanel-foot'
				const copy = doc.createElement('button')
				copy.type = 'button'
				copy.className = 'dshot-btn dshot-primary'
				copy.textContent = '复制文本'
				copy.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(body.value)
						toast('已复制文本')
					} catch {
						body.select()
						doc.execCommand('copy')
						toast('已复制文本')
					}
				})
				const insert = doc.createElement('button')
				insert.type = 'button'
				insert.className = 'dshot-btn'
				insert.textContent = '贴进输入框'
				insert.addEventListener('click', () => {
					if (typeof opts.insertText === 'function') opts.insertText(body.value)
				})
				const closeBtn = doc.createElement('button')
				closeBtn.type = 'button'
				closeBtn.className = 'dshot-btn'
				closeBtn.textContent = '关闭'
				closeBtn.addEventListener('click', () => panel.remove())
				foot.append(copy, insert, closeBtn)
				panel.append(head, langRow, body, foot)
			}

			async function copyBlob(blob) {
				try {
					if (navigator.clipboard && window.ClipboardItem) {
						await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
						return true
					}
				} catch (error) {
					console.warn('[screenshot] clipboard write failed', error)
				}
				return false
			}

			async function copyOnly() {
				const out = await compose()
				const ok = await copyBlob(out.blob)
				toast(ok ? '已复制到剪贴板' : '复制失败（浏览器拒绝写剪贴板）')
			}

			async function saveFile() {
				const out = await compose()
				if (typeof opts.save === 'function') {
					const res = await opts.save(out.dataUrl)
					if (res && res.ok) {
						toast('已保存：' + res.path)
						return
					}
					toast('保存失败：' + ((res && res.error) || '未知错误'))
					return
				}
				const a = doc.createElement('a')
				a.href = URL.createObjectURL(out.blob)
				a.download = 'shot.png'
				a.click()
				setTimeout(() => URL.revokeObjectURL(a.href), 4000)
			}

			function pin() {
				if (typeof opts.pin !== 'function') return
				void compose().then((out) => opts.pin(out))
			}

			async function finish() {
				const out = await compose()
				close(out)
			}

			function onKey(ev) {
				if (ev.key === 'Escape') {
					ev.preventDefault()
					ev.stopPropagation()
					close(null)
					return
				}
				if (ev.key === 'Enter' && state.textEditing === null) {
					ev.preventDefault()
					ev.stopPropagation()
					void finish()
					return
				}
				const mod = ev.ctrlKey || ev.metaKey
				if (!mod) return
				const k = String(ev.key || '').toLowerCase()
				if (k === 'z' && !ev.shiftKey) {
					ev.preventDefault()
					undo()
				} else if (k === 'y' || (k === 'z' && ev.shiftKey)) {
					ev.preventDefault()
					redo()
				} else if (k === 'c') {
					ev.preventDefault()
					void copyOnly()
				} else if (k === 's') {
					ev.preventDefault()
					void saveFile()
				} else if (k === 'a') {
					ev.preventDefault()
					state.sel = { x: 0, y: 0, w: natural.w, h: natural.h }
					render()
				}
			}

			function close(result) {
				doc.removeEventListener('mousemove', onMove, true)
				doc.removeEventListener('mouseup', onUp, true)
				doc.removeEventListener('keydown', onKey, true)
				textInput.remove()
				root.remove()
				// 浮层是挂在 body 上的，不跟着 root 走 —— 不显式清理就会留一片孤儿在屏幕上。
				for (const sel of ['.dshot-textpanel', '.dshot-toast', '.dshot-palette', '.dshot-winlist', '.dshot-longroot', '.dshot-dash']) {
					doc.querySelectorAll(sel).forEach((el) => el.remove())
				}
				// toast 元素被删了，模块级的 shot.toast 还指着它 —— 不置空的话之后所有
				// toast() 都写进一个**已经脱离文档**的节点，界面上永远不再出现任何提示。
				shot.toast = null
				if (typeof opts.onClose === 'function') opts.onClose(result)
			}

			canvas.addEventListener('mousedown', onDown)
			canvas.addEventListener('dblclick', () => {
				state.sel = { x: 0, y: 0, w: natural.w, h: natural.h }
				render()
			})
			doc.addEventListener('mousemove', onMove, true)
			doc.addEventListener('mouseup', onUp, true)
			doc.addEventListener('keydown', onKey, true)

			buildBar()
			syncBar()
			render()

			return {
				root: root,
				canvas: canvas,
				state: state,
				compose: compose,
				close: close,
				render: render,
				setSelection: function (rect) {
					state.sel = rect === null ? null : clampRect(rect)
					render()
				},
				destroy: function () {
					close(null)
				},
			}
		}

		/* ══════════════ 偏好 ══════════════ */

		function loadPrefs() {
			const base = {
				/**
				 * 截图时把 DSH 自己的窗口藏起来（用户 2026-10-20 要的「可选是否隐藏 DSH 界面」）。
				 *
				 * ⚠️ 默认 **false**（R30 改的，以前是 true）：原生覆盖层现在真的会隐藏 DSH 了，
				 * 而"老是看不到 DSH"是更糟的默认值 —— 想截 DSH 自己的内容（对话、图表）时
				 * 会以为截图坏了（屏幕上只剩桌面）。要截别的应用时在菜单里勾一下，之后就记住。
				 */
				hideSelf: false,
				autoCopy: true,
				autoAttach: true,
				/** 全局热键守护进程（能在 DSH 外面按快捷键呼出）。 */
				hotkeys: false,
				// ⚠️ R33：`range` / `method` / `pickHwnd` / `pickTitle` / `nativeOverlay` / `mode`
				// 已经删除 —— 它们只服务于**已取消的**"在 DSH 里渲染桌面截图"那条路径
				// （按窗口句柄抓、PrintWindow 自绘、DOM 覆盖层）。截图现在一律在原生覆盖层里框，
				// 老 localStorage 里的这些键在 loadPrefs 里被一次性清掉（见 prefsVer 迁移）。
				/** 「最近用过的自定义颜色」，取色器旁边的快捷位。 */
				customColors: [],
				/** 点一下（不拖）时落下的马赛克块边长，原图像素。 */
				mosaicBlock: 18,
				/** 提取文字用的识别语言：'auto' 或已安装的 WinRT tag。 */
				ocrLang: 'auto',
				/**
				 * 长截图怎么滚。用户 2026-10-16 选的是"两种都留着，默认我自己滚"：
				 *   'manual' 用户自己滚目标窗口，宿主侧盯着那块区域、画面稳定了就接一帧
				 *   'auto'   宿主对目标窗口连发滚轮消息，一屏屏接，到底自动停
				 * ⚠️ 两种都由**宿主**驱动。客户端侧的滚轮监听在真机上等于没工作：
				 *    用户滚的是别的窗口，那时 DSH 失焦，渲染进程定时器被节流到 1 次/分钟。
				 */
				scrollMode: 'manual',
				/** 录屏结束后是否先把文件放进剪贴板（用户可以粘到任何地方）。 */
				recClip: true,
				/**
				 * 录屏要不要录音（R41）。默认 **false** —— 录屏带麦是"有隐私含义"的开关：
				 * 默认开就会在用户不知情的时候把周围的声音录进去。要用的人自己点开，
				 * 点开时宿主枚举一次真实设备、把用的是哪块麦告诉他（菜单里也一直显示）。
				 */
				recAudio: false,
				/** 指定的录音设备名（'' = 自动挑）。空着时宿主优先"麦克风/立体声混音"这类名字。 */
				recMic: '',
				/**
				 * 录屏范围：
				 *   'screen' 整个桌面（老行为）
				 *   'pick'   每次开始录之前先用**原生覆盖层**框一块（只要矩形）
				 * 宿主侧一直支持 `region`（`-offset_x/-offset_y/-video_size`），缺的只是这一头的取区域。
				 *
				 * ⚠️ 2026-10-20 R32 把默认值改成 **'pick'**（用户原话："我需要录像可以框定
				 * 一部分区域录制"）。以前默认整屏，于是这个能力藏在右键菜单的第十几行、
				 * 几乎没人发现；而整屏录到不该录的东西代价更高。整屏仍是一键之遥（菜单里切回来，
				 * 选择会被记住）。
				 */
				recRegion: 'pick',
			}
			try {
				const raw = window.localStorage.getItem(LS_KEY)
				if (raw === null) return base
				const parsed = JSON.parse(raw)
				const merged = Object.assign(base, parsed && typeof parsed === 'object' ? parsed : {})
				if (!Array.isArray(merged.customColors)) merged.customColors = []
				/**
				 * 设置迁移（一次，靠 `prefsVer` 记进度）。三条都踩过现场：
				 *
				 * ① **改默认值对老用户无效**（R32）：`savePrefs` 每次都整份写回，老版本早就把当时的
				 *    默认值 `recRegion:'screen'` 固化进了 localStorage。实测：默认值改成 'pick'
				 *    之后热重载，读回来仍是 'screen' —— 那不是用户的选择，是上一版的默认值。
				 * ② ⚠️ **必须显式判 NaN**：`Number(undefined) < 32` 是 **false**（NaN 参与比较恒假），
				 *    第一版写成那样，恰好漏掉"没有 prefsVer 的老用户" —— 而这正是要迁移的那批人。
				 * ③ **删掉已取消功能留下的设置**（R33）：`range / method / pickHwnd / pickTitle /
				 *    nativeOverlay / mode` 只服务于"在 DSH 里渲染桌面截图"那条路径。留着它们会
				 *    让菜单摘要和调试面板看起来"还有第二种截图方式"，也会让 pickTitle 之类的旧值
				 *    永远漂在存储里。删掉比忽略干净。
				 */
				const ver = Number(merged.prefsVer)
				if (!Number.isFinite(ver) || ver < 33) {
					if (!Number.isFinite(ver) || ver < 32) merged.recRegion = 'pick'
					for (const stale of ['range', 'method', 'pickHwnd', 'pickTitle', 'nativeOverlay', 'mode']) {
						delete merged[stale]
					}
					merged.prefsVer = 33
					try {
						window.localStorage.setItem(LS_KEY, JSON.stringify(merged))
					} catch {}
				}
				return merged
			} catch {
				return base
			}
		}

		function savePrefs(prefs) {
			try {
				window.localStorage.setItem(LS_KEY, JSON.stringify(prefs))
			} catch {}
		}

		/* ══════════════ 共享状态（按钮与覆盖层之间）══════════════ */

		const shot = {
			api: null, // remote 通道，挂不上就是 null
			inputActions: null, // 官方公开动作面（session 槽 kit prop 里给的）
			cover: null, // 当前覆盖层实例
			lastShotId: '', // 最近一张截图 id（OCR 要拿它回宿主取文件）
			pinId: 0,
			recording: false,
			recTimer: null,
			recStart: 0,
			/** 这一轮录的是什么范围（"整屏" / "800×600"）。DSH 在别的窗口背后时，
			 *  用户唯一能确认"我到底录了哪块"的地方就是这颗悬浮药丸 —— 必须写清楚。 */
			recLabel: '',
			/** 这一轮**真的**带上麦了吗（宿主回执为准，不是偏好值：可能因没设备降级成静音）。 */
			recAudio: false,
			/** 实际用到的录音设备名（空 = 没录声）。药丸与结果面板都靠它说清"录的是谁"。 */
			recMic: '',
			/** 长截图会话的"收尾"入口：会话开着时热键再按一次 = 完成（见 runInvoke）。 */
			longFinish: null,
			prefs: null,
			toast: null,
			/** 心跳状态：pollTimer 非空 = 心跳在跑。 */
			pollTimer: null,
			pollSeq: 0,
			polling: false,
			/** 宿主那边热键守护进程的实际注册结果（菜单要显示"真抢到的键"）。 */
			hotkeys: null,
			/**
			 * 自诊断账本：AI 读不到渲染进程控制台，"截图点了没反应"这种事
			 * 只能靠把每一步的成败记下来再运出去（见 postDiag）。
			 */
			diag: { mountOk: null, mountError: '', injected: null, apiSet: false, capCalls: 0, lastCap: '', lastCapError: '', posts: 0, postErrors: [] },
		}

		/**
		 * **独立上报通道**：直接把 JSON POST 到本机的一个收集口（默认 8935），
		 * 完全不经过宿主 RPC —— 插件自己的 save() 会被 DSH 文件策略静默拒掉，
		 * 而渲染进程的控制台 AI 看不到，于是没有这条路就只能靠猜。
		 * no-cors + text/plain 是为了不触发预检（自定义 scheme 跨源 POST 的坑）；
		 * no-cors 下拿不到响应内容，所以只当"寄信"，成不成看收集口有没有落文件。
		 */
		function postDiag(tag, extra) {
			try {
				const payload = {
					at: new Date().toISOString(),
					tag: tag,
					href: String(window.location.href).slice(0, 120),
					diag: shot.diag,
					prefs: shot.prefs,
					extra: extra === undefined ? null : extra,
					dom: collectDiagnostics()
				}
				const url = 'http://127.0.0.1:8935/_dump?tag=' + encodeURIComponent(tag)
				const body = JSON.stringify(payload)
				shot.diag.posts += 1
				void fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: body })
					.then(() => undefined)
					.catch((error) => { shot.diag.postErrors.push(String((error && error.message) || error)) })
			} catch (error) {
				shot.diag.postErrors.push(String((error && error.message) || error))
			}
		}

		function toast(message, ms) {
			try {
				if (shot.toast === null) {
					const el = document.createElement('div')
					el.className = 'dshot-toast'
					mountBody(el)
					shot.toast = el
				}
				// 闭包里抓住**这一个**元素再挂定时器。写成 `() => shot.toast.…` 的话，
				// 定时器触发时 shot.toast 可能已经被 close() 置空了 —— 于是在定时器里抛
				// TypeError（catch 抓不到，它只包着同步那段），而 is-on 永远不会被摘掉，
				// 那个提示就**永远挂在屏幕上**（实测：用户屏幕上一直留着「正在抓屏…」）。
				const el = shot.toast
				el.textContent = message
				el.classList.add('is-on')
				clearTimeout(el._t)
				el._t = setTimeout(() => el.classList.remove('is-on'), ms || 2600)
			} catch {}
		}

		function prefs() {
			if (shot.prefs === null) shot.prefs = loadPrefs()
			return shot.prefs
		}

		function setPref(key, value) {
			const p = prefs()
			p[key] = value
			savePrefs(p)
		}

		/* ══════════════ 把图贴进输入框（合成 drop，必要时再试 paste）══════════════ */

		function countComposerImages() {
			// 附件缩略图是 blob: URL 的 <img>（自己贴的 pin 用的是 data:，不会误计）。
			// 为什么不用 [data-composer-card] img：万一官方换了容器结构，计数会恒为 0，
			// 于是「贴上了」被误判成「没贴上」，接着走 paste 兜底 → **重复贴两张**。
			try {
				return document.querySelectorAll('img[src^="blob:"]').length
			} catch (error) {
				return 0
			}
		}

		/**
		 * 输入框里现在挂了几件附件。
		 *
		 * 图片官方渲染成 `img[src^="blob:"]`；**视频/其它类型**渲染的是卡片（不是 img），
		 * 所以还要数附件槽里的行数 —— 只数图片的话，"视频已经贴进去了"会被误判成"没贴上"，
		 * 接着走 paste 兜底 → 贴成两份。
		 */
		function countComposerAttachments() {
			try {
				const rows = document.querySelectorAll('[data-slot="conversation.input.attachments"] > *').length
				return Math.max(rows, countComposerImages())
			} catch (error) {
				return countComposerImages()
			}
		}

		/**
		 * 官方 ui-attachment 的 drop 监听挂在 document 上，唯一的门是
		 * `dataTransfer.types.includes("Files")`；官方不检查 isTrusted，所以合成事件可用。
		 * @param {Blob} blob 要贴进去的内容
		 * @param {string} name 文件名
		 * @param {string} [type] MIME；不传按图片处理（老调用点不用改）
		 * @returns {Promise<boolean>} 是否真的贴进去了（用输入框里的附件数变化来判断）
		 */
		async function attachToComposer(blob, name, type) {
			const before = countComposerAttachments()
			const file = new File([blob], name, { type: type || 'image/png' })

			// 路径 1：合成 drop（document 级）
			try {
				const dt = new DataTransfer()
				dt.items.add(file)
				document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
			} catch (error) {
				console.warn('[screenshot] synthetic drop failed', error)
			}
			await new Promise((r) => setTimeout(r, 260))
			if (countComposerAttachments() > before) return true

			// 路径 2：合成 paste（编辑器根元素级）
			try {
				const editor = document.querySelector('[data-composer-input]')
				if (editor !== null) {
					const dt = new DataTransfer()
					dt.items.add(file)
					editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
				}
			} catch (error) {
				console.warn('[screenshot] synthetic paste failed', error)
			}
			await new Promise((r) => setTimeout(r, 320))
			return countComposerAttachments() > before
		}

		async function copyToClipboard(blob) {
			try {
				if (navigator.clipboard && window.ClipboardItem) {
					await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
					return true
				}
			} catch (error) {
				console.warn('[screenshot] clipboard write failed', error)
			}
			return false
		}

		/* ══════════════ 贴图（R67c：一律走原生贴图窗）══════════════ */

		/**
		 * 贴图窗的右键菜单 / 药丸文案。**中文只能从这里进助手** —— `ps/overlay_host.ps1`
		 * 必须零非 ASCII 字节（PS 5.1 把无 BOM 的 UTF-8 当 GBK 解码，一句中文注释就会吞掉
		 * 后面的代码行）。索引是两边约定死的：
		 *   menu  0送进输入框 1复制 2保存 3放大 4缩小 5原始大小 6关闭
		 *   toast 0已送出 1送出失败 2已保存 3保存失败 4已复制 5复制失败 6没人来取
		 */
		const PIN_MENU = ['送进输入框', '复制图像', '保存为文件', '放大', '缩小', '原始大小', '关闭']
		const PIN_TOAST = ['已送出，正在贴进输入框', '送出失败', '已保存', '保存失败', '已复制到剪贴板', '复制失败', '界面没来取（重启 DSH 后可用）']

		/**
		 * 把一张图钉在屏幕上。
		 *
		 * R67c 之前这里有**第二套**实现：自己造一个 `.dshot-pin` div（Ctrl+滚轮缩放 + 自己的
		 * 动作条），而主截图路径钉的是原生置顶窗 —— 同一个"贴图"两种手感。用户报的
		 * 「做不到缩放、也不能落到对话框内」正是另一套的毛病。现在统一交给宿主：图落成 PNG，
		 * 常驻助手开**同一个** DshPinForm（滚轮/手柄缩放 + 右键菜单 + 送进输入框）。
		 *
		 * 老宿主没有 `pin` 方法时**如实说**，不再退回那套 DOM 贴图（退回去等于让用户
		 * 又拿到一个不能缩放、不能进对话框的东西，还以为是新版本）。
		 */
		async function pinImage(out) {
			if (shot.api === null || typeof shot.api.pin !== 'function') {
				postDiag('pin-host-too-old')
				toast('贴图要重启 DSH 之后才生效（宿主半边还是旧的）', 4600)
				return
			}
			let res
			try {
				res = await shot.api.pin(out.dataUrl, JSON.stringify({ pinMenu: PIN_MENU, pinToast: PIN_TOAST }))
			} catch (error) {
				postDiag('pin-failed', { error: String((error && error.message) || error) })
				toast('贴图失败：' + String((error && error.message) || error), 4400)
				return
			}
			if (res && res.ok === true && res.pinned === true) {
				toast('已贴到屏幕 · 滚轮缩放 · Ctrl+拖动可拖进对话框 · 右键更多', 4600)
				postDiag('pin-ok', { w: Number(res.w) || 0, h: Number(res.h) || 0, percent: Number(res.pinPercent) || 100 })
				return
			}
			toast('贴图失败：' + ((res && (res.error || res.reason)) || '未知错误'), 4600)
		}

		/* ══════════════ 录屏 ══════════════ */

		function showRecPill() {
			let pill = document.querySelector('.dshot-rec')
			if (pill === null) {
				pill = document.createElement('div')
				pill.className = 'dshot-rec'
				const dot = document.createElement('i')
				const label = document.createElement('span')
				const stop = document.createElement('button')
				stop.type = 'button'
				stop.className = 'dshot-btn dshot-primary'
				stop.textContent = '停止'
				stop.addEventListener('click', () => void stopRecording())
				pill.append(dot, label, stop)
				pill._label = label
				mountBody(pill)
			}
			const tick = () => {
				const s = Math.round((Date.now() - shot.recStart) / 1000)
				const mm = String(Math.floor(s / 60)).padStart(2, '0')
				const ss = String(s % 60).padStart(2, '0')
				pill._label.textContent = '录屏中 ' + mm + ':' + ss + (shot.recLabel ? ' · ' + shot.recLabel : '') + (shot.recAudio ? ' · 🎙 有声' : ' · 静音')
			}
			tick()
			clearInterval(shot.recTimer)
			shot.recTimer = setInterval(tick, 500)
		}

		async function startRecording(opts) {
			if (shot.api === null) return toast('截图服务未就绪（宿主半边没起来）')
			// 仅测试：AI 直连桥驱动时带 selfTest，让助手自己框一块（沙箱里没人能拖鼠标）。
			const selfTest = opts !== undefined && opts !== null && opts.selfTest === true
			let region = ''
			let regionText = '整屏'
			/** 用户拖出来的原始宽高（用来对比"宿主实际录的"是不是被取偶了）。 */
			let pickedW = 0
			let pickedH = 0
			if (prefs().recRegion === 'pick') {
				toast('框住要录的区域 · Esc 取消', 60000)
				const pick = await pickNativeRectOnly(selfTest)
				if (pick.ok !== true) {
					if (pick.cancelled === true) return toast('已取消录屏', 1200)
					if (pick.reason === 'no-overlay') {
						// 不能把"框选"静默换成"整屏"—— 那会录到用户根本不想公开的桌面。
						// 说清楚，然后按整屏录（他点的是录屏，不是取消）。
						toast('原生覆盖层不可用，这次先整屏录制', 3200)
					} else {
						return toast('没框到要录的区域（' + pick.reason + '）', 2400)
					}
				} else {
					const r = pick.rect
					region = [r.x, r.y, r.w, r.h].join(',')
					regionText = r.w + '×' + r.h
					pickedW = r.w
					pickedH = r.h
				}
			}
			/**
			 * 录音（R41）：`audio` 由偏好决定，`mic` 空着 = 让宿主自动挑一块麦。
			 * 以前这里写死 `audio: false`，而宿主那头写死一块本机没装的虚拟声卡 ——
			 * 两头各写一半，合起来是一段永远不会被执行的死代码。
			 */
			const wantAudio = prefs().recAudio === true
			const res = await shot.api.record('start', JSON.stringify({ fps: 15, audio: wantAudio, mic: prefs().recMic || '', region }))
			if (res.ok !== true) return toast('录屏启动失败：' + (res.error || '未知错误'), 5000)
			/**
			 * **回执里的矩形才是真在录的那块**（R32）：宿主会把宽高向下取偶
			 * （yuv420p 要求偶数，奇数会让 ffmpeg 当场死掉、留下 0 字节文件），
			 * 所以用户拖的 801×601 实际录的是 800×600。显示用户拖的那个数就是在骗他。
			 */
			const rw = Number(res.width) || 0
			const rh = Number(res.height) || 0
			if (rw > 0 && rh > 0) {
				regionText = rw + '×' + rh + (rw !== pickedW || rh !== pickedH ? '（取偶后）' : '')
			}
			shot.recLabel = regionText
			shot.recording = true
			shot.recStart = Date.now()
			// 回执说"带了麦"才是真带了（宿主可能因为没设备/设备打不开降级成静音）。
			shot.recAudio = res.audio === true
			shot.recMic = String(res.mic || '')
			showRecPill()
			// 降级必须说话：想录音却没录上时，把宿主给的那句原话念出来。
			// （静默降级最坏的情况是用户录完一整套才发现全程无声。）
			if (wantAudio && !shot.recAudio && res.audioWarning) toast(String(res.audioWarning), 6000)
			else if (shot.recAudio) toast('开始录屏（' + regionText + ' · 录音：' + (shot.recMic || '默认设备') + '），点右上角「停止」结束', 4600)
			else toast('开始录屏（' + regionText + '），点右上角「停止」结束')
		}

		/**
		 * 只要一块矩形（录屏用）：返回 `{ok, rect}` / `{ok:false, cancelled, reason}`。
		 * 与 doNativeRegion 的区别是**它不自己消费这块矩形** —— 调用方要拿它去 `record start`。
		 * 失败一律**如实返回原因**，绝不返回一个"默认整屏"的假成功。
		 */
		async function pickNativeRectOnly(selfTest) {
			if (shot.api === null || typeof shot.api.overlay !== 'function') return { ok: false, reason: 'no-overlay' }
			let res
			try {
				res = await shot.api.overlay(180, JSON.stringify(selfTest === true ? { regionOnly: true, selfTest: true } : { regionOnly: true }))
			} catch (error) {
				return { ok: false, reason: String((error && error.message) || error) }
			}
			const picked = res && res.ok === true && Number(res.w) > 3 && Number(res.h) > 3
			if (!picked) return { ok: false, cancelled: res && res.cancelled === true, reason: String((res && (res.reason || res.error)) || 'unknown') }
			return { ok: true, rect: { x: Math.round(res.x), y: Math.round(res.y), w: Math.round(res.w), h: Math.round(res.h) } }
		}

		async function stopRecording() {
			if (shot.api === null) return
			const res = await shot.api.record('stop', '')
			shot.recording = false
			shot.recLabel = ''
			clearInterval(shot.recTimer)
			const pill = document.querySelector('.dshot-rec')
			if (pill !== null) pill.remove()
			if (res.ok !== true) return toast('录屏结束但出错：' + (res.error || '未知错误'))
			/**
			 * R50：**没有在录时按停止**（连点两下 / 上一段已经结束）—— `record('stop')` 是幂等的，
			 * 回 `ok:true` 但 `path:''`。以前这里不判空，于是：
			 *   ① 拿空 path 去调 `clip`，弹一句"录屏已结束，但没能放进剪贴板：path required"；
			 *   ② 再打开一个 **path 为空的结果面板**，里面每一条抽帧/剪辑都注定失败。
			 * 两句误导的提示 + 一个坏面板，全是因为"停止"把"本来就没在录"当成了成功。
			 * 这里如实说一句就返回，不碰剪贴板、不开面板。
			 */
			if (String(res.path || '') === '') {
				toast('当前没有在录屏（可能已经结束了）', 3600)
				return
			}
			// 说好要录音、文件里却没有音轨：必须在收尾时就说，别等用户事后听。
			if (res.audioDropped === true) toast('这段录屏没有音轨：' + (res.mic ? '「' + res.mic + '」没录上' : '录音设备没起效'), 5200)
			// **不再直接落盘**（用户第 3 条：录屏结束后要我自己确定存不存）。
			// 默认先把**文件**放进剪贴板 —— 粘到资源管理器/微信/输入框都是一个真文件。
			if (prefs().recClip !== false) {
				try {
					const c = await shot.api.record('clip', JSON.stringify({ path: res.path }))
					if (!c || c.ok !== true) toast('录屏已结束，但没能放进剪贴板：' + ((c && c.error) || '未知错误'), 4200)
				} catch (error) {
					toast('录屏已结束，但放进剪贴板失败：' + String((error && error.message) || error), 4200)
				}
			}
			showRecPanel(res)
		}

		/**
		 * 录屏结果面板：**预览 + 择帧 + 裁头尾 + 去留**（用户第 3、6 条）。
		 *
		 * 为什么预览走"宿主抽帧"而不是 `<video src=blob:>`：一段十几秒的 1080p 录屏是几 MB，
		 * 转 base64 塞过网关既慢又险；抽帧一次只回几十 KB 的小图，还能顺手当时间轴缩略图。
		 * 同理"去标注"也是把某一帧变成一张正式截图（写进 shots 目录），OCR/保存全都照常。
		 */
		function showRecPanel(info) {
			document.querySelectorAll('.dshot-recpanel').forEach((n) => n.remove())
			const path = String(info.path || '')
			/**
			 * 时长优先用**文件自己的**（record('stop') 的 `duration`，ffprobe 给的），墙钟只作退路。
			 * R33 现场：面板拿墙钟做 `dur`，于是第一张预览帧落在文件真正的结尾之后 ——
			 * `-ss <末尾之后>` 在 ffmpeg 里是**退出码 0 且不产出文件**，界面就显示
			 * "抽帧失败：frame produced no file"，看着像录屏坏了。
			 */
			let dur = Math.max(0.2, Number(info.duration) || Number(info.seconds) || 0)
			let trimmed = path
			let trimStart = 0
			let trimEnd = dur
			// 末尾留 0.2s：最后一帧附近的 seek 本来就脆（关键帧+解码边界），不必卡在最边上。
			let nowAt = Math.max(0, dur - 0.2)
			let lastFrame = null

			const fmt = (s) => {
				const v = Math.max(0, Number(s) || 0)
				const mm = String(Math.floor(v / 60)).padStart(2, '0')
				const ss = (v % 60).toFixed(1).padStart(4, '0')
				return mm + ':' + ss
			}
			const bytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB')

			const panel = document.createElement('div')
			panel.className = 'dshot-recpanel'
			const head = document.createElement('div')
			head.className = 'dshot-recpanel-head'
			const title = document.createElement('span')
			title.textContent = '录屏结束'
			const meta = document.createElement('small')
			/**
			 * 音轨状态（R41）分三种，不能只写"有声/无声"：
			 *   有音轨       → 「有声」（ffprobe 在文件里真看到 audio stream）
			 *   想录没录上   → 「⚠ 无声（没录上）」—— 这才是需要用户注意的那种
			 *   本来就没要   → 什么都不加（"静音录制"是用户的选择，不是待办）
			 */
			const audioNote = info.hasAudio === true ? ' · 有声' : info.audio === true ? ' · ⚠ 无声（没录上）' : ''
			meta.textContent =
				(info.width ? info.width + '×' + info.height + ' · ' : '') + fmt(dur) + ' · ' + bytes(Number(info.bytes) || 0) + audioNote + ' · 还没保存'
			head.append(title, meta)

			const stage = document.createElement('div')
			stage.className = 'dshot-recpanel-stage'
			const preview = document.createElement('img')
			preview.alt = '当前帧'
			const film = document.createElement('div')
			film.className = 'dshot-film'
			stage.append(preview, film)

			const timeLabel = document.createElement('b')
			const trimRow = document.createElement('div')
			trimRow.className = 'dshot-trim'
			const sLabel = document.createElement('span')
			sLabel.textContent = '起点'
			const sRange = document.createElement('input')
			sRange.type = 'range'
			sRange.min = '0'
			sRange.max = String(dur)
			sRange.step = '0.1'
			sRange.value = '0'
			const eLabel = document.createElement('span')
			eLabel.textContent = '终点'
			const eRange = document.createElement('input')
			eRange.type = 'range'
			eRange.min = '0'
			eRange.max = String(dur)
			eRange.step = '0.1'
			eRange.value = String(dur)
			trimRow.append(sLabel, sRange, timeLabel, eLabel, eRange)

			const foot = document.createElement('div')
			foot.className = 'dshot-recpanel-foot'
			const note = document.createElement('div')
			note.className = 'dshot-recpanel-note'
			note.textContent = '已经放进剪贴板了：粘到资源管理器 / 微信 / 输入框都是一个真文件。' +
				'关掉这个面板 = 什么都不做（文件留在缓存里，不会被收进图片目录）。'

			const mk = (label, title2, fn, primary) => {
				const b = document.createElement('button')
				b.type = 'button'
				b.className = 'dshot-btn' + (primary ? ' dshot-primary' : '')
				b.textContent = label
				b.title = title2 || label
				b.addEventListener('click', (ev) => {
					ev.stopPropagation()
					void fn(b)
				})
				return b
			}

			let frameTimer = 0
			let frameSeq = 0
			const loadFrame = (at) => {
				clearTimeout(frameTimer)
				frameTimer = setTimeout(async () => {
					if (shot.api === null || !panel.isConnected) return
					const mine = ++frameSeq
					try {
						const res = await shot.api.record('frame', JSON.stringify({ path: trimmed, time: at, width: 520 }))
						if (mine !== frameSeq) return // 拖滑块时"后发先至"的旧帧不许覆盖新帧
						if (res && res.ok === true) {
							preview.src = res.dataUrl
							lastFrame = res
							timeLabel.textContent = fmt(at)
						} else {
							timeLabel.textContent = fmt(at)
							note.textContent = '抽帧失败：' + ((res && res.error) || '未知错误')
						}
					} catch (error) {
						note.textContent = '抽帧失败：' + String((error && error.message) || error)
					}
				}, 180)
			}

			const syncFilm = () => {
				film.querySelectorAll('img[data-t]').forEach((el) => {
					const t = Number(el.dataset.t)
					el.classList.toggle('is-on', t >= trimStart - 0.05 && t <= trimEnd + 0.05)
				})
			}

			// 胶片条：一次拿 12 张均匀小图。拿不到就只留大图预览（面板照样能用）。
			void (async () => {
				if (shot.api === null) return
				try {
					const res = await shot.api.record('strip', JSON.stringify({ path: trimmed, count: 12, width: 240 }))
					if (!res || res.ok !== true) return
					for (const f of res.frames || []) {
						const im = document.createElement('img')
						im.src = f.dataUrl
						im.dataset.t = String(f.t)
						im.title = fmt(f.t)
						im.addEventListener('click', () => {
							nowAt = Number(f.t)
							loadFrame(nowAt)
							syncFilm()
						})
						film.appendChild(im)
					}
					syncFilm()
				} catch {}
			})()

			sRange.addEventListener('input', () => {
				trimStart = Math.min(Number(sRange.value), trimEnd - 0.1)
				sRange.value = String(trimStart)
				loadFrame(trimStart)
				syncFilm()
			})
			eRange.addEventListener('input', () => {
				trimEnd = Math.max(Number(eRange.value), trimStart + 0.1)
				eRange.value = String(trimEnd)
				loadFrame(trimEnd)
				syncFilm()
			})

			foot.append(
				mk('▶ 播放', '用系统播放器看一遍（当前裁切后的版本）', async () => {
					if (shot.api === null) return toast('宿主服务未就绪')
					const res = await shot.api.record('open', JSON.stringify({ path: trimmed }))
					toast(res && res.ok === true ? '已用系统播放器打开' : '打开失败：' + ((res && res.error) || '未知错误'), 3200)
				}),
				mk('🖼 就这一帧去标注', '把当前这一帧变成一张截图，进标注界面', async () => {
					if (lastFrame === null) return toast('帧还没取到，稍等一下再点')
					panel.remove()
					await showOverlay({ id: lastFrame.id, dataUrl: lastFrame.dataUrl, hidden: false }, 'shot', false)
				}),
				mk('✂ 应用裁切', '只保留起点到终点这一段（尽量无损）', async (b) => {
					if (shot.api === null) return toast('宿主服务未就绪')
					b.disabled = true
					const res = await shot.api.record('trim', JSON.stringify({ path: trimmed, start: trimStart, end: trimEnd }))
					b.disabled = false
					if (!res || res.ok !== true) return toast('裁切失败：' + ((res && res.error) || '未知错误'), 5000)
					trimmed = String(res.path || trimmed)
					dur = Math.max(0.2, Number(res.duration) || trimEnd - trimStart)
					trimStart = 0
					trimEnd = dur
					sRange.max = String(dur)
					eRange.max = String(dur)
					sRange.value = '0'
					eRange.value = String(dur)
					meta.textContent = (info.width ? info.width + '×' + info.height + ' · ' : '') + fmt(dur) + ' · ' +
						bytes(Number(res.bytes) || 0) + ' · 已裁切（' + (res.method || '?') + '）'
					film.textContent = ''
					lastFrame = null
					note.textContent = '裁切完成（' + (res.method === 'copy' ? '无损快切' : '重编码') + '）。注意：无损快切是对齐关键帧的，起止可能差零点几秒。'
					toast('已裁切：' + fmt(dur), 3200)
					// 裁完重新拉一遍胶片条
					try {
						const strip2 = await shot.api.record('strip', JSON.stringify({ path: trimmed, count: 12, width: 240 }))
						if (strip2 && strip2.ok === true) {
							for (const f of strip2.frames || []) {
								const im = document.createElement('img')
								im.src = f.dataUrl
								im.dataset.t = String(f.t)
								im.title = fmt(f.t)
								im.addEventListener('click', () => { nowAt = Number(f.t); loadFrame(nowAt); syncFilm() })
								film.appendChild(im)
							}
							syncFilm()
						}
					} catch {}
					loadFrame(Math.min(dur - 0.05, 0.2))
				}),
				mk('📎 放进对话框', '把它作为附件放进输入框（太大就复制到剪贴板让你 Ctrl+V）', async () => {
					if (shot.api === null) return toast('宿主服务未就绪')
					const got = await shot.api.record('attach', JSON.stringify({ path: trimmed }))
					if (got && got.ok === true) {
						try {
							const blob = await (await fetch(got.dataUrl)).blob()
							const okAttach = await attachToComposer(blob, got.name || 'record.mp4', got.mime || 'video/mp4')
							if (okAttach) return toast('已放进对话框', 3200)
						} catch (error) {
							note.textContent = '自动贴入失败：' + String((error && error.message) || error)
						}
					}
					// 退回"复制文件 + 你自己 Ctrl+V"：视频大起来 base64 过网关不合适
					const clip = await shot.api.record('clip', JSON.stringify({ path: trimmed }))
					const input = document.querySelector('[data-composer-input]')
					if (input !== null) {
						try { input.focus() } catch {}
					}
					note.textContent = '视频较大，没法自动塞进输入框 —— 已经复制到剪贴板：在输入框里按 Ctrl+V 就贴进来了。'
					toast(clip && clip.ok === true ? '已复制到剪贴板：在输入框按 Ctrl+V' : '复制失败：' + ((clip && clip.error) || '未知错误'), 5200)
				}),
				mk('💾 保存', '存到「图片\\DSH截图」', async () => {
					if (shot.api === null) return toast('宿主服务未就绪')
					const res = await shot.api.record('keep', JSON.stringify({ path: trimmed }))
					if (!res || res.ok !== true) return toast('保存失败：' + ((res && res.error) || '未知错误'), 5000)
					panel.remove()
					toast('已保存：' + res.path, 5200)
				}),
				mk('🗑 丢弃', '删掉这段录屏', async () => {
					if (shot.api === null) return
					const res = await shot.api.record('discard', JSON.stringify({ path: trimmed }))
					panel.remove()
					if (res && res.ok === true) {
						toast('已丢弃这段录屏', 2600)
						return
					}
					// 裁切过的话，原片还在：**如实说**，别让用户以为删干净了
					toast('没能删除：' + ((res && res.error) || '未知错误'), 5200)
				}),
				mk('✕ 关掉', '什么都不做（文件留在缓存里）', () => panel.remove())
			)

			const close = document.createElement('button')
			close.className = 'dshot-pin-x'
			close.type = 'button'
			close.textContent = '✕'
			close.title = '关掉这个面板（不会删文件）'
			close.addEventListener('click', () => panel.remove())
			head.appendChild(close)

			panel.append(head, stage, trimRow, foot, note)
			mountBody(panel)
			panel.addEventListener('mousedown', (ev) => ev.stopPropagation())
			panel.addEventListener('keydown', (ev) => ev.stopPropagation())
			loadFrame(nowAt)
		}

		/* ══════════════ 主流程：抓屏 → 覆盖层 ══════════════ */

		function loadImage(src) {
			return new Promise((resolve, reject) => {
				const img = new Image()
				img.onload = () => resolve(img)
				img.onerror = () => reject(new Error('image decode failed'))
				img.src = src
			})
		}

		/** rect {x,y,w,h} 或 null → 交给宿主 OCR */
		async function ocrRegion(shotId, rect, lang) {
			if (shot.api === null) return { ok: false, error: 'service unavailable' }
			const rectText = rect === null ? '' : [rect.x, rect.y, rect.w, rect.h].join(',')
			const want = typeof lang === 'string' && lang.length > 0 ? lang : prefs().ocrLang || 'auto'
			const res = await shot.api.ocr(shotId, rectText, 3, want, 'none')
			if (res.ok !== true) return { ok: false, error: res.error || 'OCR failed' }
			return {
				ok: true,
				text: compactCjk(res.text || ''),
				lines: res.lines || [],
				lang: res.lang || '',
				langs: Array.isArray(res.langs) ? res.langs : [],
			}
		}

		/** OCR 会在 CJK 每字之间插空格；把「汉字 汉字」之间的空格去掉，英文与数字之间的保留。 */
		function compactCjk(text) {
			const cjk = '[\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]'
			return String(text).replace(new RegExp('(' + cjk + ') +(?=' + cjk + ')', 'g'), '$1')
		}

		/**
		 * ⚠️⚠️ **LEGACY / 已取消（R33），文件里没有任何调用点** ⚠️⚠️
		 *
		 * 这是"在 DSH 窗口里渲染桌面截图"那一套：抓一张整屏位图 → 画进 canvas → 盖一层 DOM
		 * 覆盖层（`position:fixed;inset:0`）让用户在**DSH 自己的窗口里**框选与标注。
		 *
		 * 为什么取消（用户 2026-10-20 明确要求）：
		 *   ① 它只盖得住 DSH 的窗口 —— DSH 不在前台时根本看不见，框不到别的应用；
		 *   ② canvas 是整屏**原始像素**，而窗口在 125% 缩放下只有 ~1268 CSS px ⇒ 能框到的
		 *      只有屏幕左上角那一块；
		 *   ③ 与原生覆盖层并存 = 两套标注 UI、两套坐标、两套回执，用户根本分不清自己在哪一套里。
		 *
		 * 现在截图 / 长截图 / OCR / 翻译**一律**走原生覆盖层（`doNativePick` / `doNativeRegion`），
		 * 入口 `doShotEntry` 在原生不可用时**明说**而不是偷偷换成这一套。
		 * 代码先留着只是为了它包含的标注/取色/贴图逻辑有考古价值；**不要重新接线**，
		 * 要复用就把局部函数挑出去，别把整块挂回调用链。
		 */
		async function doCapture(kind) {
			if (shot.api === null) {
				// 用户实测的那句「截图没有效果」最可能就是走到这里：按钮在（槽注册不依赖
				// $mount），但 remote 没接上 → 点下去只弹一句提示。把账本寄出去，
				// 这样哪怕只重启一次，AI 也能知道到底卡在哪一步。
				shot.diag.lastCapError = 'shot.api === null'
				postDiag('cap-refused', { kind: kind })
				toast('截图服务未就绪：宿主半边没起来（点我看诊断）', 4200)
				return
			}
			if (shot.cover !== null) {
				// 已经有一层覆盖层。**绝不能静默 return** —— 这正是用户报的"截图点不开了"：
				// 一次热重载、一次异常关闭，都可能让 shot.cover 指向一个**已经不在文档里**的
				// 旧实例，于是之后每一次点击都在这一行无声无息地结束：界面没反应、诊断里
				// 也没有任何记录。两个出口：
				//   旧的已经不在了 -> 丢掉它，正常继续；
				//   旧的还在（真的叠着）-> 明说，别让用户对着按钮反复点。
				const stale = !shot.cover.root || shot.cover.root.isConnected !== true
				if (stale) {
					postDiag('cap-stale-cover', { kind: kind })
					try {
						shot.cover.destroy()
					} catch {}
					shot.cover = null
				} else {
					postDiag('cap-already-open', { kind: kind })
					toast('已经有一层截图开着呢（按 Esc 关掉它，或直接在那层上操作）', 3200)
					return
				}
			}
			const p = prefs()
			// range 取代了老的 mode：'desktop' 整屏 / 'window' 指定窗口（含 DSH 自己）
			const range = p.range === 'window' ? 'window' : 'desktop'
			const hwnd = range === 'window' && Number(p.pickHwnd) > 0 ? Number(p.pickHwnd) : 0
			/**
			 * 整屏抓取一律走 GDI 屏幕拷贝（'screen'）。
			 * PrintWindow 只对"某个具体的窗口"才有意义；对着整个桌面要它，宿主会先试一次
			 * print、失败后再回落成 screen —— 那一次白试是要花时间的，用户感觉就是"卡一下"。
			 * 老用户的持久化偏好里还是 'print'，这里就地纠正，**不改他的设置**。
			 */
			const method = range === 'desktop' ? 'screen' : p.method
			/**
			 * 上一次还没回来。**不能静默 return**（R17.8 的教训：「凡是『因为已经有 X
			 * 所以不做』的分支，都必须有出口」）—— 明说一句 + 留一封诊断信。
			 *
			 * ⚠️ 但 busy 必须**会过期**：宿主侧的 cap 没有超时保证，万一那次调用永远不
			 * resolve，busy 就永久为 true —— 按钮从此只会弹「上一次还在路上」，
			 * 与 R17.8 那个"点不开"的死法一模一样。超过 60 秒就当它没发生过。
			 */
			if (shot.busy === true && Date.now() - (shot.busySince || 0) < 60000) {
				postDiag('cap-busy', { kind: kind })
				toast('上一次抓屏还在路上，稍等一下…', 1800)
				return
			}
			if (shot.busy === true) postDiag('cap-busy-expired', { kind: kind, since: shot.busySince })
			shot.busy = true
			shot.busySince = Date.now()
			shot.diag.capCalls += 1
			shot.diag.lastCap = JSON.stringify({ kind: kind, range: range, hwnd: hwnd, hideSelf: p.hideSelf, method: method })
			// ⚠️ 提示必须**挂到抓完为止**。实测一次整屏抓取要 3 秒上下（宿主每次都新起一个
			//    powershell.exe，冷启动 ~3.3s），而旧代码只挂 1200ms —— 中间那几秒屏幕上
			//    什么都没有，用户的第一反应就是"点了没反应 / 坏了"。这里给一个足够长的值，
			//    结果回来时再用结果文案把它顶掉。
			const t0 = Date.now()
			toast('正在抓屏…', 60000)
			let res
			try {
				res = await shot.api.cap(range, p.hideSelf ? '1' : '0', method, hwnd, '')
			} catch (error) {
				shot.busy = false
				const msg = String((error && error.message) || error)
				shot.diag.lastCapError = 'call failed: ' + msg
				postDiag('cap-call-failed', { kind: kind, error: msg })
				toast('抓屏调用失败：' + msg)
				return
			}
			shot.busy = false
			if (res.ok !== true) {
				shot.diag.lastCapError = 'host failed: ' + String(res.error || '未知错误')
				postDiag('cap-host-failed', { kind: kind, res: res })
				toast('抓屏失败：' + (res.error || '未知错误'))
				return
			}
			/**
			 * 近空白检测。PrintWindow 对最小化 / 被完全遮挡的窗口会**"成功返回"一张纯色图**：
			 * 实测 1268×897 只吐 6191 字节（≈6KB），而且花了 13.4 秒 —— 用户看到一片空白，
			 * 屏幕上却没有任何提示。这里按 字节数 / 像素数 粗判，命中就自动用屏幕区域重抓一次
			 * （screen 走 GDI 拷贝，快，而且不可能是空白）。
			 */
			const px = Math.max(1, Number(res.width) * Number(res.height))
			if (res.method === 'print' && Number(res.bytes) > 0 && Number(res.bytes) < px / 100) {
				postDiag('cap-near-blank', { kind: kind, bytes: res.bytes, width: res.width, height: res.height, hwnd: hwnd })
				toast('这张几乎是空白（窗口可能最小化或被挡），改用屏幕区域重抓…', 2600)
				try {
					const retry = await shot.api.cap(range, p.hideSelf ? '1' : '0', 'screen', hwnd, '')
					if (retry && retry.ok === true) {
						res = retry
						postDiag('cap-blank-retry-ok', { kind: kind, method: retry.method, bytes: retry.bytes })
					} else {
						postDiag('cap-blank-retry-failed', { res: retry })
					}
				} catch (error) {
					postDiag('cap-blank-retry-failed', { error: String((error && error.message) || error) })
				}
			}
			const spent = ((Date.now() - t0) / 1000).toFixed(1)
			shot.diag.lastCapError = ''
			postDiag('cap-ok', { kind: kind, width: res.width, height: res.height, method: res.method, bytes: res.bytes, hwnd: res.hwnd, ms: Date.now() - t0 })
			if (res.method === 'screen' && range === 'window' && method === 'print') {
				toast('窗口自绘没成功（回落成屏幕区域，可能拍到别的窗口）', 2600)
			} else {
				// 抓完给一句"确实抓到了"的回执，带上尺寸与耗时 ——
				// 用户能立刻分辨"慢"和"卡死"，AI 也能从诊断里看到真实的抓屏成本。
				toast(res.width + '×' + res.height + ' 已抓到 · ' + spent + 's', 1500)
			}
			showOverlay(res, kind, kind === 'scrollRegion')
		}

		/**
		 * 原生覆盖层（M1）：**在真实桌面上**框一块。
		 *
		 * 和上面那条 doCapture 的本质区别：覆盖层不是 DSH 窗口里的 DOM 平面，
		 * 而是一个**独立进程**的全屏真窗口（`shot.api.overlay` → `ps/overlay_host.ps1`）。
		 * 于是它可以盖在别的应用之上、不要求 DSH 在前台 —— 这才是「像 QQ 那样截任意地方」。
		 * 框完之后由宿主直接写进**系统剪贴板**，客户端不需要回传图像。
		 *
		 * ⚠️ 这是一次**阻塞**调用：它在等人拖框，最长 180 秒。所以提示要挂住
		 *    （和抓屏那次同样的教训：1.2 秒的提示配 3 秒的等待 = 用户以为坏了）。
		 * ⚠️ R33 起**不再回落**到 DOM 那套（那条路径已被取消）：不可用时如实说明并返回，
		 *    让用户知道"是宿主没重启"，而不是给他一个框不到目标应用的降级界面。
		 */
		async function doNativePick() {
			if (shot.api === null || typeof shot.api.overlay !== 'function') {
				postDiag('overlay-unavailable', { apiKeys: shot.api === null ? 0 : Object.keys(shot.api).length })
				toast('截图需要宿主覆盖层：宿主半边还没重启（重启 DSH 一次即可）', 4600)
				return
			}
			shot.diag.capCalls += 1
			toast('拖一个矩形 → 可以标注 · Enter 复制 · Esc 取消', 60000)
			const t0 = Date.now()
			let res
			try {
				// 工具条文案由这里带过去：overlay_host.ps1 必须零非 ASCII 字节，
				// 中文字面量只能走请求参数。顺序固定 = Rect/Arrow/Pen/Mosaic/Number/Text/Undo。
				//
				// hideSelf：**在冻结桌面之前**把 DSH 自己的窗口藏起来（QQ 同款）。冻结帧就是
				// 用户接下来框的那张图，所以这个开关只能由助手在 CopyFromScreen 之前执行；
				// 覆盖层上再放一个勾已经晚了（R30）。关掉时行为与以前完全一样。
				res = await shot.api.overlay(180, JSON.stringify({
					labels: ['矩形', '箭头', '画笔', '马赛克', '序号', '文字', '椭圆', '颜色', '撤销'],
					// 隐藏着的时候在提示行最前面说一句：否则用户只会看到"DSH 不见了"。
					hint: (prefs().hideSelf === true ? '已隐藏 DSH 界面    ' : '') + 'Enter 复制    P 贴图    Esc 后退    Ctrl+Z 撤销    X 线宽    C 颜色',
					hideSelf: prefs().hideSelf === true,
					hideTitle: DSH_WINDOW_TITLE,
					// 贴图窗的右键菜单（R67）。中文只能由这里带进助手：overlay_host.ps1 必须
					// 零非 ASCII 字节。两边的索引约定见 PIN_MENU / PIN_TOAST 上面的注释。
					pinMenu: PIN_MENU,
					pinToast: PIN_TOAST,
				}))
			} catch (error) {
				const msg = String((error && error.message) || error)
				postDiag('overlay-call-failed', { error: msg })
				toast('框选失败：' + msg, 4200)
				return
			}
			const spent = ((Date.now() - t0) / 1000).toFixed(1)
			const picked = res !== null && res !== undefined && res.ok === true
			postDiag('overlay-result', { ok: picked, reason: String((res && res.reason) || ''), w: Number(res && res.w) || 0, h: Number(res && res.h) || 0, ms: Date.now() - t0 })
			if (picked && res.reason === 'pinned') {
				// R67：贴图窗现在能缩放、也有动作菜单了 —— 这两件事用户不会自己发现，
				// 所以在贴上去的那一刻就说清楚（右键菜单是"送进输入框"的入口）。
				toast(res.w + '×' + res.h + ' 已贴到屏幕 · 滚轮缩放 · 拖动移动 · Ctrl+拖动可拖进对话框 · 右键更多', 5200)
				return
			}
			if (picked) {
				// 落盘文件名来自宿主（默认 图片\DSH截图\shot-<时间>.png），只报文件名不报全路径
				const saved = res.png ? String(res.png).split(/[\\/]/).pop() : ''
				// 隐藏成功与否**如实说**：res.hidden 是助手真的藏了一个窗口才为 true，
				// 标题没匹配上（比如 DSH 标题被换了）不能假装藏过。
				const hid = res.hidden === true ? ' · 已隐藏 DSH 界面' : ''
				/**
				 * 剪贴板也要**如实说**（R30）：助手写剪贴板可能失败（别的程序正占着剪贴板，
				 * 实测报「所请求的剪贴板操作失败」）。以前这里不管 res.clip 真假都写
				 * "已复制到剪贴板" —— 用户粘出来是旧内容，却没有任何线索。
				 * 助手现在会重试 4 次；仍然失败就明说，并留一条诊断。
				 */
				const copied = res.clip === true
				if (!copied) postDiag('clip-failed', { w: Number(res.w) || 0, h: Number(res.h) || 0, png: saved })
				const clipText = copied ? ' 已复制到剪贴板' : ' 剪贴板被别的程序占用，这次没复制成功' + (saved ? '（图已存盘）' : '')
				toast(res.w + '×' + res.h + clipText + (saved ? ' · 已存 ' + saved : '') + hid + ' · ' + spent + 's', copied ? 3600 : 4800)
				return
			}
			if (res && res.cancelled === true) {
				toast('已取消', 900)
				return
			}
			const reason = String((res && (res.reason || res.error)) || 'unknown')
			// 助手不在 / 没就绪 / 半路死了：如实说，**不回落**（R33：DOM 那条已取消）
			if (reason === 'no-helper' || reason === 'not-ready' || reason.indexOf('helper') >= 0) {
				postDiag('overlay-no-helper', { reason: reason })
				toast('原生覆盖层起不来（' + reason + '）—— 重启 DSH 一次再试', 4200)
				return
			}
			toast('没有框选到内容（' + reason + '）', 2200)
		}

		/**
		 * DSH 自己那个**原生窗口**的标题（用来让助手在冻结桌面之前把它藏起来）。
		 *
		 * 为什么是标题而不是句柄：渲染进程根本拿不到自己那个 HWND。整套插件找 DSH 也用标题
		 * （`capture.ps1 -Target 'DeepSeek Harness'`、`hitwin.ps1`），这里保持同一个口径。
		 * 助手做的是**子串**匹配，所以标题后面挂了会话名也照样命中。
		 */
		const DSH_WINDOW_TITLE = 'DeepSeek Harness'

		/**
		 * 「截图」这一档的**唯一入口**：一律走原生覆盖层（独立进程的全屏真窗口）。
		 *
		 * R33（用户要求）：**取消在 DSH 窗口里渲染桌面截图的那套**。以前这里会回落到
		 * `doCapture('shot')`（canvas 冻结帧 + DOM 标注层），它有两条硬伤 —— 只能盖住 DSH
		 * 自己的窗口（DSH 不在前台就看不见）、canvas 是整屏原始像素（125% 缩放下只能框到
		 * 屏幕左上角一块）。保留回落等于"看起来能用、框不到你要的东西"。
		 *
		 * 于是现在的契约是：原生覆盖层不可用 → **说清楚**，不再偷偷换一套降级的界面。
		 * （`doCapture` 的实现还在文件里，但已无任何调用点；标成 legacy 见 R33 交接。）
		 */
		function doShotEntry() {
			if (shot.api !== null && typeof shot.api.overlay === 'function') return doNativePick()
			postDiag('shot-no-overlay', { apiKeys: shot.api === null ? 0 : Object.keys(shot.api).length })
			toast('截图需要宿主覆盖层：宿主半边还没重启（或没起来），重启 DSH 一次即可', 4600)
		}

		/**
		 * 原生取矩形：**只要一块屏幕区域**，不标注、不复制、不落盘。
		 *
		 * 长截图 / 提取文字 / 屏幕翻译的第一步都是「框一块屏幕区域」。这一步以前走 DOM
		 * 覆盖层，而 DOM 覆盖层有两条硬伤（不是 bug，是坐标系决定的）：
		 *   ① canvas 是整屏冻结帧的**原始像素**（`style.width = natural.w / dpr`），
		 *      1920 屏在 125% 缩放下就是 1536 CSS px，而 DSH 窗口只有 ~1268 px
		 *      ⇒ **能框到的只有屏幕左上角那一块**，目标应用在旁边就框不到；
		 *   ② `position:fixed;inset:0` 只盖住 DSH 自己的窗口，DSH 不在前台就看不见。
		 * 原生覆盖层是独立进程的全屏真窗口，坐标 = 虚拟屏幕物理像素，框哪都行 ——
		 * 和「截图」那条路用的是同一个助手，只是请求里多一个 `regionOnly`。
		 *
		 * @param {'scrollRegion'|'ocr'|'translate'} kind
		 */
		async function doNativeRegion(kind, opts) {
			// 仅测试：请求里带 selfTest，助手会程序化框一块再返回 —— 沙箱里没有人能拖鼠标。
			// 产品调用点**一律不传** opts，所以这条只在 AI 直连桥里出现。
			const selfTest = opts !== undefined && opts !== null && opts.selfTest === true
			if (shot.api === null || typeof shot.api.overlay !== 'function') {
				postDiag('region-unavailable', { kind: kind, apiKeys: shot.api === null ? 0 : Object.keys(shot.api).length })
				toast('这条功能要在原生覆盖层里框区域：宿主半边没起来（重启 DSH 一次）', 4200)
				return
			}
			shot.diag.capCalls += 1
			toast(
				kind === 'scrollRegion'
					? '框住要滚动的区域 · Esc 取消（框完先去点一下那个窗口，它得在最前面）'
					: '框住要识别的区域 · Esc 取消',
				60000
			)
			const t0 = Date.now()
			let res
			try {
				const extra = { regionOnly: true }
				if (selfTest) extra.selfTest = true
				/**
				 * 隐藏 DSH（R30）：只对「框完立刻抓这块图」的两条路（OCR / 翻译）生效 ——
				 * 冻结和随后的抓取用同一个 setting，框到的就是抓到的，不会出现"框的时候
				 * 有 DSH、抓出来却是它背后的东西"。
				 * 长截图（scrollRegion）**不隐藏**：它的帧由宿主会话逐拍抓，藏/显会在每拍
				 * 制造闪烁，而且遮挡守卫本来就是按"屏幕上真实可见"判定的。
				 */
				if ((kind === 'ocr' || kind === 'translate') && prefs().hideSelf === true) {
					extra.hideSelf = true
					extra.hideTitle = DSH_WINDOW_TITLE
					// 提示行必须跟着说：DSH 被藏起来之后屏幕上会"少一块"，
					// 不说清楚，用户会以为覆盖层出错了。
					extra.hint = '已隐藏 DSH 界面    框住要识别的区域 · Esc 取消'
				}
				res = await shot.api.overlay(180, JSON.stringify(extra))
			} catch (error) {
				const msg = String((error && error.message) || error)
				postDiag('region-call-failed', { kind: kind, error: msg })
				toast('框选失败：' + msg, 4200)
				return
			}
			// 老宿主（没重启）不认识 regionOnly，会照常进标注阶段并回 reason:'picked'
			// + 剪贴板 + 落盘。矩形照样是对的，所以**接受它** —— 总比让用户白框一次好，
			// 只是多写了一次剪贴板。
			const picked = res && res.ok === true && Number(res.w) > 3 && Number(res.h) > 3
			postDiag('region-result', {
				kind: kind,
				ok: picked,
				reason: String((res && res.reason) || ''),
				regionOnly: res ? res.regionOnly === true : false,
				x: Number(res && res.x) || 0,
				y: Number(res && res.y) || 0,
				w: Number(res && res.w) || 0,
				h: Number(res && res.h) || 0,
				ms: Date.now() - t0,
			})
			if (picked) {
				const rect = { x: Math.round(res.x), y: Math.round(res.y), w: Math.round(res.w), h: Math.round(res.h) }
				if (kind === 'scrollRegion') {
					void runLongSession(rect, { native: true })
					return
				}
				void nativeRegionText(rect, kind)
				return
			}
			if (res && res.cancelled === true) {
				toast('已取消', 900)
				return
			}
			const reason = String((res && (res.reason || res.error)) || 'unknown')
			if (reason === 'no-helper' || reason === 'not-ready' || reason.indexOf('helper') >= 0) {
				postDiag('region-no-helper', { kind: kind, reason: reason })
				toast('原生覆盖层起不来（' + reason + '）—— 重启 DSH 一次再试', 4200)
				return
			}
			toast('没有框到区域（' + reason + '）', 2200)
		}

		/**
		 * 原生取到矩形之后「提取文字 / 屏幕翻译」：先按这块矩形抓一张，再走既有的
		 * OCR 面板。抓出来的那张**就是这块区域本身**，所以交给 OCR 时 rect 从 (0,0) 起 ——
		 * 别把屏幕坐标当成图片坐标传下去（那是 R19 那类"截到隔壁"的经典错法）。
		 */
		async function nativeRegionText(rect, kind) {
			const rectText = [rect.x, rect.y, rect.w, rect.h].join(',')
			toast('正在抓这块区域…', 60000)
			let cap
			try {
				/**
				 * hideSelf 跟**框选那一步**用同一个值（R30）：覆盖层的冻结帧就是用户看到的
				 * 那张图，抓取必须和它一致 —— 冻结时藏了 DSH，抓取时也得藏，否则截出来的是
				 * 用户没见过的画面（而 OCR 会把 DSH 背后的字识别出来）。
				 * 以前这里写死 '1'，等于无论用户怎么选都藏 DSH。
				 */
				cap = await shot.api.cap('desktop', prefs().hideSelf === true ? '1' : '0', 'screen', 0, rectText)
			} catch (error) {
				toast('抓取区域失败：' + String((error && error.message) || error))
				return
			}
			if (!cap || cap.ok !== true) {
				toast('抓取区域失败：' + ((cap && cap.error) || '未知错误'))
				return
			}
			shot.lastShotId = cap.id
			postDiag('region-cap', { kind: kind, id: cap.id, width: cap.width, height: cap.height })
			void runTextKind({ rect: { x: 0, y: 0, w: Number(cap.width) || rect.w, h: Number(cap.height) || rect.h } }, kind)
		}

		/**
		 * 把一张图交给覆盖层。
		 * @param {{id:string, dataUrl:string, hidden?:boolean}} shotRes
		 * @param {string} kind 'shot' | 'ocr' | 'translate' | 'scroll'
		 * @param {boolean} regionOnly 只要框选不要标注（长截图的取区域那一步）
		 */
		async function showOverlay(shotRes, kind, regionOnly) {
			shot.lastShotId = shotRes.id
			let image
			try {
				image = await loadImage(shotRes.dataUrl)
			} catch (error) {
				toast('截图解码失败')
				return
			}
			if (shotRes.hidden === true) toast('已按「截图时隐藏当前窗口」抓屏', 1400)

			const overlay = createShotOverlay({
				image: image,
				dpr: window.devicePixelRatio || 1,
				regionOnly: regionOnly === true,
				mosaicBlock: prefs().mosaicBlock,
				customColors: prefs().customColors,
				onColors: (list) => setPref('customColors', list),
				ocr: (rect, lang) => ocrRegion(shotRes.id, rect, lang),
				save: async (dataUrl) => {
					if (shot.api === null) return { ok: false, error: 'service unavailable' }
					return shot.api.save(dataUrl, 'shot')
				},
				pin: (out) => pinImage(out),
				insertText: (text) => insertPlainText(text),
				onClose: (result) => {
					shot.cover = null
					if (result === null) return
					if (regionOnly === true) {
						// ⚠️ 坐标要换算。覆盖层给出的 rect 是**图片像素**，而 `-Rect` 要的是
						// **屏幕物理像素**。整屏抓取时两者原点都是 (0,0) 所以碰巧相等，
						// 但 window 模式下图片是从窗口左上角起算的，直接拿图片坐标当屏幕坐标
						// 会截到隔壁 —— 所以老老实实加上这次抓屏的 left/top。
						const rect = {
							x: Math.round(result.rect.x) + (Number(shotRes.left) || 0),
							y: Math.round(result.rect.y) + (Number(shotRes.top) || 0),
							w: Math.round(result.rect.w),
							h: Math.round(result.rect.h),
						}
						// 长截图改成**手动**模式：用户自己滚轮决定截多长，滚完再按「完成」。
						// 老的自动模式（宿主合成滚轮连滚 8 屏）会接管真实鼠标，用户反馈不好用。
						void runLongSession(rect)
						return
					}
					void deliver(result, kind)
				},
			})
			shot.cover = overlay
		}

		/* ══════════════ 长截图（两种滚法，都由宿主驱动）══════════════ */

		/**
		 * 长截图会话。用户 2026-10-16：「两种模式都留着，菜单/工具条上一键切换，默认我自己滚」。
		 *
		 *   manual（默认） 用户自己滚目标窗口，宿主每 260ms 看一眼那块区域，画面稳定了就接一帧
		 *   auto          宿主对目标窗口连发滚轮消息，一屏屏接，到底自动停
		 *
		 * 两条都**必须由宿主驱动**。上一版是客户端监听 `wheel`：用户滚的是**别的窗口**，
		 * 那时 DSH 是失焦的 —— 渲染进程的定时器被节流到约 1 次/分钟，于是那一版在真机上
		 * 等于完全没工作。这正是用户报的「滚动截屏没效果，既不会自己滚，也不能我鼠标滚轮
		 * 控制着滚」的根因。所以：客户端只负责**显示状态和收尾**，抓帧/比对/拼接全在宿主。
		 */
		async function runLongSession(rect, opts) {
			if (shot.api === null) return { ok: false, error: '服务未就绪：宿主半边没起来' }
			// native = 这块矩形是原生覆盖层给的（虚拟屏幕物理像素，可能在任何显示器上）。
			const native = opts !== undefined && opts !== null && opts.native === true
			const rectText = [Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h)].join(',')
			/**
			 * 滚动方式：默认跟随偏好，但允许**本次会话**覆盖（`opts.mode`）。
			 *
			 * 为什么要这个覆盖：验证工具（桥的 `longshot` op）需要能指定 manual / auto，
			 * 而"改偏好"是**用户的东西** —— 自检不许为了验证去改用户的设置（skill 的硬纪律）。
			 * 会话级的 mode 只活在这一个会话里，跑完就没了。
			 */
			const mode = opts !== undefined && opts !== null && (opts.mode === 'auto' || opts.mode === 'manual')
				? opts.mode
				: (prefs().scrollMode === 'auto' ? 'auto' : 'manual')
			let begin
			try {
				begin = await shot.api.scroll(rectText, JSON.stringify({ session: 'begin', mode: mode }))
			} catch (error) {
				toast('长截图启动失败：' + String((error && error.message) || error))
				// 带上现场：这一版实例的 api 面到底长什么样（热重载后实例之间的差异只能这样看出来）。
				const api = shot.api || {}
				return {
					ok: false,
					error: 'scroll begin threw: ' + String((error && error.message) || error),
					apiKeys: Object.keys(api).join(','),
					scrollType: typeof api.scroll,
				}
			}
			if (!begin || begin.ok !== true) {
				toast('长截图启动失败：' + ((begin && begin.error) || '未知错误'))
				return { ok: false, error: String((begin && begin.error) || 'unknown') }
			}
			// 旧宿主（没重启）会把 {session:'begin'} 当成老的一次性抓取：能返回 ok，但结果里
			// **没有会话字段**。这时绝不能假装是一张"刚开了个会话"的图 —— 否则工具条会一直
			// 停在 0 帧，用户以为又坏了。如实说明 + 给一条路（老路径其实已经抓完了）。
			// 判据用 `active`：新宿主的 begin/status/end **每个响应都带全 statusFields()**
			// （active 必为布尔），老宿主的一次性结果里根本没有这个字段。
			if (typeof begin.active !== 'boolean') {
				toast('长截图要重启 DSH 之后才生效（宿主半边还是旧的）', 6000)
				if (begin.id) await showOverlay({ id: begin.id, dataUrl: begin.dataUrl }, 'shot', false)
				return { ok: false, error: 'host too old (no session fields)' }
			}

			const rootEl = document.createElement('div')
			rootEl.className = 'dshot-longroot'
			const frameEl = document.createElement('div')
			frameEl.className = 'dshot-longframe'
			const barEl = document.createElement('div')
			barEl.className = 'dshot-longbar'
			rootEl.append(frameEl, barEl)
			mountBody(rootEl)

			/**
			 * 框线只是**指示**「将要截哪块」。rect 是**屏幕物理像素**，而 DOM 用的是视口
			 * CSS 像素 ⇒ 必须换算，否则 125% 缩放下框线会大 25% 且整体偏移
			 * （老代码直接把物理像素当 CSS 用；以前那条路框出来的区域必然在窗口内，
			 *   所以这个错没人注意到，但它是错的）。
			 * 区域整个落在 DSH 窗口之外时**不画**：画不出来就别画一条骗人的线，
			 * 状态条里会给出真实坐标。原生取区域时这是常见情况（目标应用在别的窗口）。
			 */
			const place = () => {
				const dpr = window.devicePixelRatio || 1
				const left = rect.x / dpr - (window.screenX || 0)
				const top = rect.y / dpr - (window.screenY || 0)
				const vw = rect.w / dpr
				const vh = rect.h / dpr
				const inView = left >= -6 && top >= -6 && left + vw <= window.innerWidth + 6 && top + vh <= window.innerHeight + 6
				if (!inView) {
					frameEl.style.display = 'none'
					return
				}
				frameEl.style.display = ''
				frameEl.style.left = Math.round(left) + 'px'
				frameEl.style.top = Math.round(top) + 'px'
				frameEl.style.width = Math.round(vw) + 'px'
				frameEl.style.height = Math.round(vh) + 'px'
			}
			place()

			let frames = begin.frames || 1
			let busy = false
			let closed = false
			let pollTimer = 0
			shot.longFinish = () => void done()

			const label = document.createElement('span')
			label.textContent = mode === 'auto' ? '长截图（程序滚）' : '长截图（你自己滚）'
			const count = document.createElement('b')
			count.textContent = frames + ' 帧'
			const thumb = document.createElement('img')
			thumb.alt = ''
			thumb.style.display = 'none'
			const hint = document.createElement('span')
			hint.className = 'dshot-hk'
			hint.textContent = mode === 'auto' ? '正在自己滚…到底会自动停' : '滚动你要截的那个窗口 · 停手就接一帧'

			const mk = (text, title, onClick, primary) => {
				const b = document.createElement('button')
				b.type = 'button'
				b.className = 'dshot-btn' + (primary ? ' dshot-primary' : '')
				b.textContent = text
				b.title = title || text
				b.addEventListener('click', (ev) => {
					ev.stopPropagation()
					void onClick(b)
				})
				return b
			}

			async function addFrame() {
				if (busy || closed) return
				busy = true
				hint.textContent = '抓帧中…'
				try {
					const res = await shot.api.scroll('', JSON.stringify({ session: 'add' }))
					if (res && res.ok === true) {
						frames = res.frames
						count.textContent = frames + ' 帧'
						if (res.stalled > 0) hint.textContent = '页面没动（到底了？）· 已 ' + frames + ' 帧'
						else hint.textContent = '已接 ' + frames + ' 帧 · 继续'
					} else {
						hint.textContent = '接帧失败：' + ((res && res.error) || '未知错误')
					}
				} catch (error) {
					hint.textContent = '接帧失败：' + String((error && error.message) || error)
				}
				busy = false
			}

			/**
			 * @param {string} [why] 收尾失败时给用户看的**原因**（比 end() 的 "not enough frames" 可读）。
			 */
			async function done(why) {
				if (closed) return { ok: false, error: 'session already closed' }
				closed = true
				cleanup()
				const res = await shot.api.scroll('', JSON.stringify({ session: 'end' }))
				if (!res || res.ok !== true) {
					const reason = typeof why === 'string' && why !== '' ? why : String((res && res.error) || '未知错误')
					toast('长截图收尾失败：' + reason, 5200)
					return { ok: false, error: String((res && res.error) || 'end failed'), hint: reason }
				}
				const capped = res.stopReason === 'max-height' || res.stopReason === 'max-frames'
				toast(
					(res.stopReason === 'max-height'
						? '长图到上限了：'
						: res.stopReason === 'max-frames'
							? '长图到帧数上限了（后面可能没截完）：'
							: '长图完成：') +
						res.frames + ' 帧 → ' + res.width + '×' + res.height,
					capped ? 5200 : 2800
				)
				// 交回覆盖层，可以继续标注 / 贴图 / 复制 / 贴进输入框
				showOverlay({ id: res.id, dataUrl: res.dataUrl, hidden: false }, 'shot', false)
				const out = {
					ok: true,
					id: res.id,
					// path = 拼好的长图落在哪（探针直接拿它去 testbed_verify 做内容级验收）
					path: res.path === undefined ? '' : String(res.path),
					frames: res.frames,
					width: res.width,
					height: res.height,
					stopReason: res.stopReason === undefined ? '' : String(res.stopReason),
				}
				/**
				 * 记下"最近一张长图"。
				 * ⚠️ auto 模式**自己会到底**，而 status 轮询一看到 `done` 就替你调 done() ——
				 * 于是调用方（验证工具）赶到时会话已经收尾、`finish` 反而报"没有会话"。
				 * 不留这个记录，产物路径就只能靠去 shots 目录里按时间猜。
				 */
				shot.longLast = out
				return out
			}

			async function cancel() {
				if (closed) return { ok: false, error: 'session already closed' }
				closed = true
				cleanup()
				try {
					await shot.api.scroll('', JSON.stringify({ session: 'cancel' }))
				} catch {}
				return { ok: true }
			}

			function cleanup() {
				clearInterval(pollTimer)
				window.removeEventListener('resize', place)
				rootEl.remove()
				shot.longFinish = null
				// 句柄跟着会话一起死：「完成之后还能 add」会打到一个已经结束的宿主会话上。
				shot.longApi = null
			}

			/** 状态每 700ms 拉一次。DSH 失焦时这个定时器会被节流 —— 没关系，**
			 *  真正干活的循环在宿主里，这里只是把它的进度画出来。 */
			async function poll() {
				if (closed || shot.api === null) return
				try {
					const st = await shot.api.scroll('', JSON.stringify({ session: 'status' }))
					if (closed || !st || st.ok !== true) return
					frames = st.frames || frames
					count.textContent = frames + ' 帧'
					if (typeof st.preview === 'string' && st.preview.length > 40) {
						thumb.src = st.preview
						thumb.style.display = ''
					}
					if (st.done === true) {
						// 宿主可能因为"已经到底"而收官，也可能因为"再拼就超过最大高度"而主动停 ——
						// 后者对用户是重要信息（长图被截断在 30000px），不能和"到底了"混为一谈。
						// R25 多一种：自动滚发不出去（权限 / 用户握着鼠标）放弃，也要说清楚。
						const why = st.stopReason === 'max-height'
							? '已到长图上限（30000px），先拼这些'
							: st.stopReason === 'max-frames'
								// R60：撞到帧数上限不是"到底了"。以前这里显示"已经到底了"，
								// 用户看到的是一张正常的长图，根本不知道下半页没进来。
								? '已到帧数上限（' + (st.maxFrames || 40) + ' 帧），后面可能没截进来'
								: st.stopReason === 'wheel-refused'
									? '自动滚发不出去（权限/鼠标被占用）· 改用「换我自己滚」'
									: '已经到底了'
						hint.textContent = why
						// 一帧都没接到时 end() 会报 "not enough frames" —— 那句话对用户没有意义，
						// 这里先把它换成能读的道理，收尾照走。
						await done(
							st.stopReason === 'wheel-refused'
								? '自动滚发不出去，没接到帧'
								: st.stopReason === 'max-frames'
									? '已到帧数上限，长图可能没截完'
									: ''
						)
						return
					}
					if (st.paused && st.paused !== '') {
						hint.className = 'dshot-hk is-warn'
						hint.textContent = st.paused === 'self'
							? '暂停：这块现在被 DSH 自己挡着'
							: st.paused === 'wheel-refused'
								? '暂停：滚轮发不出去（权限/完整性），自动滚不动了'
								: '暂停：目标窗口不在最前面'
					} else if (st.stalled > 0) {
						hint.className = 'dshot-hk is-warn'
						hint.textContent = '页面没动了（到底了？）· 已 ' + frames + ' 帧'
					} else {
						hint.className = 'dshot-hk'
						// wheelMode 只有 auto 才有意义：'post' = 滚轮直接投给窗口，**没动用户的鼠标**。
						hint.textContent = mode === 'auto'
							? '正在自己滚…' + (st.wheelMode === 'post' ? '（不动你的鼠标）' : '') + (st.lastError ? '（' + st.lastError + '）' : '')
							: (native ? '先点一下你要截的那个窗口（它得在最前面），再用滚轮滚 · 停手就接一帧'
								: '切到你要截的那个窗口，用你自己的滚轮滚 · 停手就接一帧（DSH 挡着会暂停）')
					}
					if (st.lastError) postDiag('long-error', { error: String(st.lastError).slice(0, 120) })
				} catch {}
			}
			pollTimer = setInterval(() => void poll(), 700)
			window.addEventListener('resize', place)

			barEl.append(
				label,
				count,
				thumb,
				hint,
				mk('⇄ ' + (mode === 'auto' ? '换我自己滚' : '换程序自己滚'), '切换滚动方式（立刻重开这一块）', async () => {
					setPref('scrollMode', mode === 'auto' ? 'manual' : 'auto')
					if (closed) return
					closed = true
					cleanup()
					try {
						await shot.api.scroll('', JSON.stringify({ session: 'cancel' }))
					} catch {}
					void runLongSession(rect, native ? { native: true } : undefined)
				}),
				mk('＋', '手动再接一帧（不确定接没接上时用）', () => addFrame()),
				mk('⤒', '重新从当前画面开始（丢掉已接的帧）', async () => {
					if (closed) return
					closed = true
					cleanup()
					try {
						await shot.api.scroll('', JSON.stringify({ session: 'cancel' }))
					} catch {}
					void runLongSession(rect, native ? { native: true } : undefined)
				}),
				mk('✕', '取消长截图', () => cancel()),
				mk('✓ 完成', '拼好并进入标注（热键再按一次也行）', () => done(), true)
			)

			/**
			 * 给**程序**用的句柄（桥的 `longshot` op 用它）。
			 *
			 * 为什么需要：以前"验长截图 UI"只能靠 eval 把 `d.shot.api.scroll('','{"session":"add"}')`
			 * 手拼出来 —— 那绕过了真实的 UI 路径（不建状态条、不动 line indicator），
			 * 于是"UI 有没有画对"这件事永远验不到。这里把**用户那条路上的同一批函数**
			 * （addFrame / done / cancel）交出去，验证走的就是用户走的那条路。
			 */
			shot.longApi = {
				rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
				rectText: rectText,
				mode: mode,
				add: () => addFrame(),
				finish: () => done(),
				cancel: () => cancel(),
				state: () => ({
					active: closed !== true,
					frames: frames,
					mode: mode,
					rectText: rectText,
					// drawn=false = 这块区域落在 DSH 窗口之外，框线故意没画（不是 bug）
					drawn: frameEl.style.display !== 'none',
					label: label.textContent,
					hint: hint.textContent,
					bar: barEl.isConnected === true,
				}),
			}
			return { ok: true, frames: frames, mode: mode, rectText: rectText, drawn: frameEl.style.display !== 'none', label: label.textContent, hint: hint.textContent }
		}

		/* R67c：这里原本有「在真实桌面上点选窗口」（`showWindowPicker`，走 `ps/pickwindow.ps1`）
		   和它的列表式备用（`showWindowList`）。R33 取消「点选窗口截图」之后两者**都没有调用点**
		   —— `grep showWindowPicker` 只有定义本身。留着的唯一效果是让静态契约、宿主服务
		   （`service.pickwin`）、wire 描述符、`ps/pickwindow.ps1` 全都以为它们还活着。
		   这一轮连同那四层一起删掉（见交接文件 R67c 一节）。 */

		/* ══════════════ AI 直连桥：让 AI 驱动这个真实客户端 ══════════════ */

		/**
		 * 为什么要有它：AI 看不到这个界面的控制台，也点不了按钮 —— 于是"按钮点了没效果"
		 * 这类问题只能靠用户口述。dsh-diag 的 `/ctl/*` 反向通道要宿主半边（改宿主就得重启
		 * DSH），而这个桥**只改 client.js**：热重载即生效，一轮之内就能自证。
		 *
		 * 通道：开发用静态服务把**工作区**当根目录挂着（带 `access-control-allow-origin: *`，
		 * 跨源可读），AI 把命令写进 `<工作区>/.tmp-vision/_ai/cmd.json`：
		 *
		 *   { "seq": 12, "ops": [ {"op":"state"}, {"op":"click","text":"↷"}, {"op":"eval","js":"..."} ] }
		 *
		 * 这里读到就按序执行，结果 POST 回 8935 的 `_dump`（tag=ai-result），
		 * AI 用 `curl -s http://127.0.0.1:8935/latest` 就能读到 → 形成闭环。
		 *
		 * 安全性：能写这个文件的进程，本来就能改 client.js（应用会加载它），所以这个桥
		 * 不引入新的权限面。seq 只增不回退，避免重复执行；文件不在时**一个字节都不发**。
		 */
		const AI_BRIDGE = {
			url: 'http://127.0.0.1:8934/.tmp-vision/_ai/cmd.json',
			post: 'http://127.0.0.1:8935/_dump?tag=ai-result',
			timer: null,
			busy: false,
			seq: 0,
			runs: 0,
			lastError: '',
			/**
			 * 本实例的随机标识。
			 * ⚠️ 为什么需要它：客户端插件热重载之后，**同一个页面里会同时活着好几个模块实例**
			 * （实测有 5 个在应答），它们共享同一个 document。于是"所有实例都执行同一条命令"
			 * 会互相踩：一个实例的 reset 会把另一个刚打开的菜单删掉。命令里带 `target` 就能
			 * 只让一个实例动手。
			 */
			id: Math.random().toString(36).slice(2, 8),
			/**
			 * 本实例**被 materialize 的时刻**（毫秒）。
			 *
			 * 为什么 build 不够：热重载会为**同一份代码**再生出好几个实例（实测改一次 client.js
			 * 之后 R25 有 4 个），它们的 `build` 字符串一模一样 —— 于是"哪个才是刚改的那份"
			 * 从回执里读不出来，按 build 点名会把一条开窗命令发给 4 个实例。
			 * 有了 born，验证工具就能只挑**最新**的那个（见 lib/devtools.mjs 的 build 过滤）。
			 */
			born: Date.now(),
			/** 被更新的实例顶替之后置 true（见 aiBridgeTick 顶部那段）。 */
			retired: false,
		}

		function aiBridgeStart() {
			if (AI_BRIDGE.timer !== null) return
			// born 在这里补一次时间戳：模块顶层那一次发生在 `apply()` 之前（那时 Remote 还没挂上），
			// 用"能干活了"的时刻做新旧判据才可靠 —— 半挂载的实例不该被当成"最新代码"。
			AI_BRIDGE.born = Date.now()
			// 广播自己（带 at = 心跳时刻）：比本实例更晚出生、**并且还活着**的那个会胜出。
			window.__dshotLatest = { id: AI_BRIDGE.id, born: AI_BRIDGE.born, at: Date.now() }
			AI_BRIDGE.timer = setInterval(() => void aiBridgeTick(), 1200)
			void aiBridgeTick()
		}

		async function aiBridgeTick() {
			if (AI_BRIDGE.busy) return
			/**
			 * ⚠️ **旧实例必须自己退场**（R25 的实测发现）。
			 *
			 * 热重载不是"替换"，是"再 materialize 一份"：旧模块实例还活着、定时器还在、
			 * 还照常拉命令、还照常回执 —— 但它的 Remote 作用域已经跟着上一次 apply 一起废了。
			 * 症状极具欺骗性：`eval` 拿 `window.__dshotDebug.shot`（**全局，已经被新实例覆盖**）
			 * 一切正常，而这个实例自己的 `shot.api.scroll()` 抛
			 * `remote.scroll is not a function`。于是回执里"有一个成功、几个莫名报错"，
			 * 而 `target:'all'` 会把开窗动作在屏幕上执行 N 次。
			 *
			 * 判据：谁 born 更新谁赢；本实例一旦发现更晚的实例已经广播过，就停掉自己的定时器。
			 */
			const latest = window.__dshotLatest
			const nowMs = Date.now()
			const newerBorn = latest !== undefined && latest !== null ? Number(latest.born) || 0 : 0
			const newerFresh = latest !== undefined && latest !== null && nowMs - (Number(latest.at) || 0) < 15000
			if (latest !== undefined && latest !== null && latest.id !== AI_BRIDGE.id && newerBorn > AI_BRIDGE.born && newerFresh) {
				AI_BRIDGE.retired = true
				if (AI_BRIDGE.timer !== null) {
					clearInterval(AI_BRIDGE.timer)
					AI_BRIDGE.timer = null
				}
				return
			}
			// 我是当前最新（或那个"最新"已经 15 秒没心跳 = 它不存在了）：接过广播。
			// ⚠️ 心跳是必须的：只有启动时广播一次的话，那个实例一旦不再 tick（模块被卸载 /
			//    标签页被回收），活着的最新实例会读到一条**永不过期的**更晚 born 然后把自己也退掉
			//    —— 表现成"桥突然谁都不回执"，而屏幕上一切正常（本轮实测踩到）。
			if (latest === undefined || latest === null || latest.id === AI_BRIDGE.id || newerBorn <= AI_BRIDGE.born || !newerFresh) {
				window.__dshotLatest = { id: AI_BRIDGE.id, born: AI_BRIDGE.born, at: nowMs }
			}
			AI_BRIDGE.busy = true
			try {
				const res = await fetch(AI_BRIDGE.url + '?t=' + Date.now(), { cache: 'no-store' })
				if (res.ok === true) {
					const cmd = await res.json()
					const seq = Number(cmd && cmd.seq) || 0
					if (seq > AI_BRIDGE.seq) {
						// 认领规则：`target` 缺省 = 只有**有焦点**的那个实例动手（人正在看的那个）；
						// 'all' = 所有实例都做（比如清理）；写具体 id = 只给它。
						const target = cmd && cmd.target !== undefined ? String(cmd.target) : 'focused'
						const mine = target === 'all' || target === AI_BRIDGE.id || (target === 'focused' && document.hasFocus() === true)
						AI_BRIDGE.seq = seq
						if (!mine) {
							// 不是给我的：记账但不动手，也**不上报**（否则每一条命令都会多出好几封信）
							AI_BRIDGE.busy = false
							return
						}
						const results = await aiBridgeRun(cmd && cmd.ops)
						aiBridgeReport(seq, results, target)
					}
				}
				AI_BRIDGE.lastError = ''
			} catch (error) {
				// 桥没挂（静态服务没起 / 文件不在）是常态，静默
				AI_BRIDGE.lastError = String((error && error.message) || error)
			}
			AI_BRIDGE.busy = false
		}

		function aiBridgeReport(seq, results, target) {
			AI_BRIDGE.runs += 1
			try {
				const payload = {
					at: new Date().toISOString(),
					tag: 'ai-result',
					href: String(window.location.href).slice(0, 120),
					seq: seq,
					target: target === undefined ? 'focused' : String(target),
					instance: {
						id: AI_BRIDGE.id,
						build: CLIENT_BUILD,
						born: AI_BRIDGE.born,
						vw: window.innerWidth,
						vh: window.innerHeight,
						dpr: window.devicePixelRatio,
						focused: document.hasFocus() === true,
					},
					results: results,
					diag: shot.diag,
					prefs: shot.prefs,
				}
				void fetch(AI_BRIDGE.post, {
					method: 'POST',
					mode: 'no-cors',
					headers: { 'Content-Type': 'text/plain' },
					body: JSON.stringify(payload),
				}).catch(() => undefined)
			} catch {}
		}

		async function aiBridgeRun(ops) {
			const out = []
			const list = Array.isArray(ops) ? ops.slice(0, 60) : []
			for (const op of list) {
				try {
					out.push(await aiBridgeOp(op || {}))
				} catch (error) {
					out.push({ op: String((op && op.op) || '?'), error: String((error && error.message) || error) })
				}
			}
			return out
		}

		/** 结果必须有界：网关和落盘都受不了无界 JSON。 */
		function bound(value, max) {
			let text = ''
			try {
				text = typeof value === 'string' ? value : JSON.stringify(value)
			} catch (error) {
				text = '"<unserializable: ' + String((error && error.message) || error) + '>"'
			}
			if (typeof text !== 'string') text = String(text)
			return text.length > (max || 4000) ? text.slice(0, max || 4000) + '…[截断]' : text
		}

		/** 覆盖层当前状态（AI 判断"点了到底有没有效果"要看的就是这个）。 */
		function overlaySnapshot() {
			const cover = shot.cover
			if (cover === null || cover === undefined) return null
			const st = cover.state || {}
			return {
				connected: !!(cover.root && cover.root.isConnected === true),
				ops: Array.isArray(st.ops) ? st.ops.map((o) => o.kind) : null,
				cursor: st.cursor === undefined ? 'undef' : st.cursor,
				undone: Array.isArray(st.undone) ? st.undone.length : null,
				sel: st.sel || null,
				tool: st.tool || '',
				color: st.color || '',
				barButtons: [...document.querySelectorAll('.dshot-bar button')].map((b) => b.textContent),
				barText: bound([...document.querySelectorAll('.dshot-bar button')].map((b) => (b.className || '') + '|' + b.textContent).join(' '), 1500),
			}
		}

		async function aiBridgeOp(op) {
			const kind = String(op.op || '')
			if (kind === 'wait') {
				const ms = Math.max(0, Math.min(10000, Number(op.ms) || 0))
				await new Promise((r) => setTimeout(r, ms))
				return { op: 'wait', ok: true, ms: ms }
			}
			if (kind === 'state') {
				return {
					op: 'state',
					ok: true,
					href: String(window.location.href).slice(0, 120),
					apiReady: shot.api !== null,
					diag: shot.diag,
					prefs: prefs(),
					overlay: overlaySnapshot(),
					recording: shot.recording === true,
					// R67c：贴图不再是页面里的节点（原生贴图窗在助手进程里），所以这里恒为 0。
					pins: 0,
					recPanel: document.querySelector('.dshot-recpanel') !== null,
					longBar: document.querySelector('.dshot-longbar') !== null,
					menuRows: [...document.querySelectorAll('.dshot-mi')].map((r) => r.textContent),
					toast: (() => { const t = document.querySelector('.dshot-toast'); return t === null ? '' : t.textContent })(),
					bridge: { runs: AI_BRIDGE.runs, seq: AI_BRIDGE.seq, lastError: AI_BRIDGE.lastError, born: AI_BRIDGE.born, retired: AI_BRIDGE.retired === true },
				}
			}
			if (kind === 'click') {
				let el = null
				if (op.sel) el = document.querySelector(String(op.sel))
				else if (op.text !== undefined) {
					const want = String(op.text)
					const pool = [...document.querySelectorAll('.dshot-bar button, .dshot-mi, .dshot-btn, .dshot-recpanel button, .dshot-longbar button, button')]
					el = pool.find((b) => (b.textContent || '').trim() === want) || pool.find((b) => (b.textContent || '').includes(want)) || null
				}
				if (el === null) return { op: 'click', ok: false, error: 'not found', text: op.text || '', sel: op.sel || '' }
				const label = (el.textContent || '').trim()
				const cls = el.className
				el.click()
				return { op: 'click', ok: true, label: label, cls: cls }
			}
			if (kind === 'menu') {
				if (!window.__dshScreenshot || typeof window.__dshScreenshot.menu !== 'function') {
					return { op: 'menu', ok: false, error: 'no trigger button (window.__dshScreenshot missing)' }
				}
				// 先关掉已经开着的那些。探针会反复调这个 op，不关的话菜单会一层层堆在屏幕上
				// （实测堆到 17 个，用户屏幕上就是一片叠着的面板）。
				document.querySelectorAll('.dshot-menu').forEach((n) => n.remove())
				window.__dshScreenshot.menu()
				// 立刻读一次（菜单是**同步**建好的），再等一下读第二次 —— 两次都要，
				// 这样"开了又自己关了"能被看出来，而不是显示成一个空数组让人以为没开。
				const read = () => [...document.querySelectorAll('.dshot-mi')].map((r) => (r.textContent || '').trim())
				const now = read()
				await new Promise((r) => setTimeout(r, 150))
				const later = read()
				return { op: 'menu', ok: true, rows: later.length > 0 ? later : now, rowsNow: now.length, rowsLater: later.length }
			}
			if (kind === 'capture') {
				// R33：这条桥的 op 以前直接驱动**已取消的** DOM 截图路径（`doCapture`），
				// 于是它会"成功"、界面上却弹出那套旧的窗口内覆盖层。现在只走唯一入口，
				// 并且如实说明"这次是原生覆盖层"——覆盖层在**独立进程**里，拿不到 DOM 快照。
				const k = String(op.kind || 'shot')
				if (k === 'shot') doShotEntry()
				else void doNativeRegion(k === 'scroll' ? 'scrollRegion' : k)
				await new Promise((r) => setTimeout(r, Number(op.settle) || 800))
				return { op: 'capture', ok: true, kind: k, native: true }
			}
			if (kind === 'dom') {
				const sels = Array.isArray(op.sels) ? op.sels.slice(0, 12) : []
				const out = {}
				for (const s of sels) {
					let nodes = []
					try { nodes = [...document.querySelectorAll(String(s))] } catch (error) { out[String(s)] = 'bad selector'; continue }
					out[String(s)] = { count: nodes.length, first: nodes.slice(0, 3).map((n) => bound(n.outerHTML, 400)) }
				}
				return { op: 'dom', ok: true, nodes: out }
			}
			if (kind === 'longshot') {
				/**
				 * 长截图的**程序入口**（R25，backlog ④）。
				 *
				 * 以前验这块只能 eval 拼 `d.shot.api.scroll('','{"session":"add"}')` ——
				 * 那绕过整条 UI 路径：状态条不建、框线不画、`frames` 也不进状态条，
				 * 于是"UI 有没有画对"永远验不到。这个 op 走的是 `runLongSession` 本人。
				 *
				 *   {op:'longshot', action:'begin', rect:'x,y,w,h'|{x,y,w,h}, mode:'manual'|'auto'}
				 *   {op:'longshot', action:'add'|'status'|'finish'|'cancel', keep?:boolean}
				 *
				 * ⚠️ `begin` 会**真的**在桌面上开一个长截图会话（屏幕上出现状态条），
				 *    探针必须用 finish / cancel 收尾 —— 否则用户屏幕上会留一条状态条。
				 */
				const action = String(op.action || 'begin')
				// 两种"没有"都要认：从没设过是 undefined，会话结束是 null。
				const readState = () => {
					const api = shot.longApi
					if (api === null || api === undefined) return null
					try { return api.state() } catch (error) { return { error: String((error && error.message) || error) } }
				}
				if (action === 'begin') {
					let rect = op.rect
					if (typeof rect === 'string') {
						const p = rect.split(',').map((v) => Number(String(v).trim()))
						if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) {
							return { op: 'longshot', ok: false, error: 'rect 字符串要 "x,y,w,h"' }
						}
						rect = { x: p[0], y: p[1], w: p[2], h: p[3] }
					} else if (Array.isArray(rect) && rect.length === 4) {
						rect = { x: Number(rect[0]), y: Number(rect[1]), w: Number(rect[2]), h: Number(rect[3]) }
					}
					if (rect === null || typeof rect !== 'object' || !(Number(rect.w) > 0) || !(Number(rect.h) > 0)) {
						return { op: 'longshot', ok: false, error: 'rect 需要 {x,y,w,h}、[x,y,w,h] 或 "x,y,w,h"（w/h 必须 > 0）' }
					}
					const wantMode = op.mode === 'auto' || op.mode === 'manual' ? op.mode : undefined
					const res = await runLongSession({ x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Number(rect.w), h: Number(rect.h) }, { native: true, mode: wantMode })
					await new Promise((r) => setTimeout(r, Number(op.settle) || 600))
					return Object.assign({ op: 'longshot', action: 'begin', state: readState() }, res)
				}
				if (shot.longApi === null || shot.longApi === undefined) {
					// auto 模式自己到底就收尾了：这时"没有会话"≠"什么也没发生"，把上一张长图交回去。
					if (action === 'finish' || action === 'status') {
						const last = shot.longLast || null
						return {
							op: 'longshot',
							action: action,
							ok: last !== null && last.ok === true,
							alreadyDone: last !== null,
							state: null,
							last: last,
							path: last === null ? '' : last.path,
							frames: last === null ? 0 : last.frames,
							width: last === null ? 0 : last.width,
							height: last === null ? 0 : last.height,
							stopReason: last === null ? '' : last.stopReason,
							error: last === null ? '没有正在进行的长截图会话，也没有上一张长图（先 action:begin）' : '',
						}
					}
					return { op: 'longshot', action: action, ok: false, error: '没有正在进行的长截图会话（先 action:begin）', longApi: String(shot.longApi) }
				}
				if (action === 'add') {
					await shot.longApi.add()
					const st = readState()
					return { op: 'longshot', action: 'add', ok: st !== null, frames: st === null ? 0 : st.frames, hint: st === null ? '' : st.hint, state: st }
				}
				if (action === 'status') {
					return { op: 'longshot', action: 'status', ok: true, state: readState() }
				}
				if (action === 'cancel') {
					const res = await shot.longApi.cancel()
					await new Promise((r) => setTimeout(r, 250))
					return { op: 'longshot', action: 'cancel', ok: res.ok === true, state: readState() }
				}
				if (action === 'finish') {
					const res = await shot.longApi.finish()
					// 默认**不留东西在用户屏幕上**：finish 会进标注覆盖层，验证完立刻收掉。
					await new Promise((r) => setTimeout(r, Number(op.settle) || 400))
					const overlay = overlaySnapshot()
					if (op.keep !== true && shot.cover !== null && shot.cover !== undefined) {
						try { shot.cover.destroy() } catch {}
						shot.cover = null
					}
					return Object.assign({ op: 'longshot', action: 'finish', overlayKept: op.keep === true, overlay: overlay, state: readState() }, res)
				}
				return { op: 'longshot', action: action, ok: false, error: '未知 action（begin/add/status/finish/cancel）' }
			}
			if (kind === 'reset') {				if (shot.cover !== null && shot.cover !== undefined) { try { shot.cover.destroy() } catch {} shot.cover = null }
				document.querySelectorAll('.dshot-menu,.dshot-winlist,.dshot-longroot,.dshot-recpanel,.dshot-palette').forEach((n) => n.remove())
				return { op: 'reset', ok: true }
			}
			if (kind === 'eval') {
				// 走 window.__dshotDebug（apply 里挂的钩子）：间接 eval 只能碰到 window 级的东西，
				// 而 prefs/shot/doCapture 都在模块闭包里 —— 不给钩子，这个 op 就是个废的。
				// `file` 形态更实用：长脚本写进 <工作区>/.tmp-vision/_ai/<file>.js，
				// 免得把 JS 塞进 JSON 字符串里跟转义打架（AI 侧就是靠这个驱动真实界面的）。
				let js = String(op.js || '')
				if (op.file) {
					const rel = String(op.file).replace(/[^A-Za-z0-9._-]/g, '')
					const r = await fetch('http://127.0.0.1:8934/.tmp-vision/_ai/' + rel + '?t=' + Date.now(), { cache: 'no-store' })
					if (r.ok !== true) return { op: 'eval', ok: false, error: 'script fetch ' + r.status + ' for ' + rel }
					js = await r.text()
				}
				const dbg = window.__dshotDebug || null
				const fn = new Function('d', '"use strict";return (' + js + ')')
				// await：探针经常需要"等一下再读"（二级菜单要 140ms 才开），
				// 让脚本写成 async IIFE 就能自己等，而不必在 AI 侧拆成好几条命令。
				const value = await fn(dbg)
				return { op: 'eval', ok: true, value: bound(value, Number(op.max) || 4000) }
			}
			return { op: kind || '?', ok: false, error: 'unknown op' }
		}

		/* ══════════════ 全局热键 / AI 投递：客户端心跳 ══════════════ */

		/**
		 * 心跳。一次 `shot.poll()` 同时回答两件事：
		 *   invoke  —— 用户在外面按了热键，界面该把覆盖层拉起来（**只有人按键才会产生**）
		 *   deliver —— AI 用工具抓了一张图，界面要安静地贴进输入框并复制
		 *
		 * 为什么是轮询：Remote 只有 client→host 一个方向，宿主推不过来。1 秒一次 IPC
		 * 换掉一整套事件总线，在这个量级上明显划算。
		 */
		function startPolling() {
			if (shot.pollTimer !== null) return
			shot.pollTimer = setInterval(() => void pollOnce(), 1000)
		}

		async function pollOnce() {
			if (shot.api === null || shot.polling) return
			shot.polling = true
			try {
				const res = await shot.api.poll(shot.pollSeq)
				if (res && res.ok === true) {
					shot.pollSeq = Number(res.seq) || shot.pollSeq
					if (res.hotkeys && typeof res.hotkeys === 'object') shot.hotkeys = res.hotkeys
					if (typeof res.invoke === 'string' && res.invoke.length > 0) void runInvoke(res.invoke)
					if (res.deliver && typeof res.deliver === 'object' && res.deliver.dataUrl) void deliverQuiet(res.deliver)
					// R67：用户在原生贴图窗里点了「送进输入框」。图由助手落到信箱，宿主取走
					// 再放到这里 —— 贴图窗比产生它的那次请求活得久，只能这么绕一圈。
					if (res.pin && typeof res.pin === 'object' && res.pin.dataUrl) void receivePin(res.pin)
				}
			} catch {
				/* 宿主没起来时每一拍都会失败 —— 静默，别刷屏 */
			}
			shot.polling = false
		}

		/** 热键要的动作：shot/ocr/translate/scroll 都是"抓屏后进覆盖层"。 */
		async function runInvoke(action) {
			const act = String(action || 'shot')
			postDiag('hotkey-invoke', { action: act })
			if (act === 'record') {
				if (shot.recording) void stopRecording()
				else void startRecording()
				return
			}
			if (act === 'stopRecord') {
				if (shot.recording) void stopRecording()
				return
			}
			// 长截图正开着：热键再按一次 = **完成**（用户滚完目标窗口，不一定要回到 DSH
			// 去点那颗 ✓ —— 手动模式下他本来就在别的窗口里，热键是最顺手的收尾方式）。
			if (act === 'scroll' && typeof shot.longFinish === 'function') {
				postDiag('long-finish-by-hotkey')
				shot.longFinish()
				return
			}
			// 已经有一层覆盖层开着，别叠第二层。但**先确认它真的还在文档里** ——
			// 指向已卸载实例的 shot.cover 会让热键永久失效（见 doCapture 里的同一段说明）。
			if (shot.cover !== null) {
				if (shot.cover.root && shot.cover.root.isConnected === true) return
				try {
					shot.cover.destroy()
				} catch {}
				shot.cover = null
			}
			// 取区域那三步（提取文字 / 屏幕翻译 / 长截图）**也走原生覆盖层**：
			// 它们的共同第一步是「框一块屏幕区域」，用 DOM 覆盖层就只能框 DSH 窗口内那块
			// （canvas 是整屏原始像素、受窗口裁剪）。doNativeRegion 里带回落。
			if (act === 'ocr') void doNativeRegion('ocr')
			else if (act === 'translate') void doNativeRegion('translate')
			else if (act === 'scroll') void doNativeRegion('scrollRegion')
			// 截图这一档走**原生覆盖层**，和相机按钮、应用内热键**同一个入口**。
			else void doShotEntry()
		}

		/**
		 * AI 投递的图：**不弹覆盖层、不抢焦点**，直接进输入框 + 剪贴板。
		 * 这正是用户要的"AI 能自己调用但不影响我做别的事情"。
		 */
		async function deliverQuiet(item) {
			try {
				const blob = await (await fetch(item.dataUrl)).blob()
				const p = prefs()
				let attached = false
				if (p.autoAttach) attached = await attachToComposer(blob, item.name || 'screenshot.png')
				if (p.autoCopy) await copyToClipboard(blob)
				const how = (attached ? '已贴进输入框' : '未能贴进输入框') + (p.autoCopy ? ' + 已复制' : '')
				toast('AI 截图：' + how, 2600)
				postDiag('ai-deliver', { id: item.id, attached: attached, note: item.note || '' })
			} catch (error) {
				postDiag('ai-deliver-failed', { id: item.id, error: String((error && error.message) || error) })
			}
		}

		/**
		 * 原生贴图窗送来的图（R67）：用户在贴图上右键 →「送进输入框」。
		 *
		 * 与 deliverQuiet 刻意不同：**只贴进输入框，不复制、不写 AI 的口径**。
		 * 用户要的是"把这张刚贴上的图弄进对话框"，多复制一份只会顶掉他剪贴板里原本的东西。
		 */
		async function receivePin(item) {
			try {
				const blob = await (await fetch(item.dataUrl)).blob()
				const attached = await attachToComposer(blob, item.name || 'pin.png')
				toast(
					attached ? '贴图已送进输入框' : '没能贴进输入框（贴图上右键 → 复制图像，再在输入框里 Ctrl+V）',
					attached ? 2600 : 5200
				)
				postDiag('pin-handoff', { attached: attached, w: Number(item.w) || 0, h: Number(item.h) || 0 })
			} catch (error) {
				postDiag('pin-handoff-failed', { error: String((error && error.message) || error) })
				toast('贴图送进输入框失败：' + String((error && error.message) || error), 4200)
			}
		}

		/**
		 * 贴图验收（R67c）——桥里一条命令跑完"这台机器现在能不能贴图"。
		 *
		 * 为什么要它：验收贴图原本要三步（宿主有没有 `pin` 方法 / 最后一跳能不能贴成附件 /
		 * 清干净），这三步里任何一步靠人手点都会漏。这里把**判定**和**贴一张探针图**分开：
		 *   * 默认 `attach:false`：只判定，**不改任何东西**（不 poll —— poll 是取件式的，
		 *     会把用户真正的热键/AI 投递吃掉）；
		 *   * `attach:true`：真的往输入框贴一张 1×1 探针图，返回贴前/贴后的附件数。
		 * 返回值固定带 `cleanup`（那张探针图的移除按钮选择器），验收完顺手清掉。
		 */
		async function pinAccept(opts) {
			const o = opts && typeof opts === 'object' ? opts : {}
			/**
			 * ⚠️ `typeof shot.api.pin === 'function'` **不能**用来判断宿主有没有这个能力：
			 * 描述符是**客户端自己** `desc('pin', …)` 声明并 mount 上去的，主机那边没有它
			 * 也一样是函数（R67c 实测：老宿主上这个判据返回 true）。真判据只能是**空调用一次**：
			 * 新宿主回 `reason:'bad-image'`（不写任何文件），老宿主直接在 Remote 层抛错。
			 */
			let hostHasPin = false
			let probe = ''
			try {
				const res = await shot.api.pin('')
				hostHasPin = !!(res && typeof res === 'object' && res.reason === 'bad-image')
				probe = hostHasPin ? 'bad-image' : 'unexpected: ' + String((res && res.reason) || '')
			} catch (error) {
				probe = 'threw: ' + String((error && error.message) || error)
			}
			const before = countComposerAttachments()
			if (o.attach !== true) {
				return { ok: hostHasPin, hostHasPin: hostHasPin, probe: probe, attach: false, before: before, after: before, cleanup: '' }
			}
			const png =
				typeof o.dataUrl === 'string' && o.dataUrl.length > 0
					? o.dataUrl
					: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
			const name = typeof o.name === 'string' && o.name.length > 0 ? o.name : 'pin-accept.png'
			await receivePin({ dataUrl: png, name: name, w: 1, h: 1 })
			const after = countComposerAttachments()
			return {
				ok: hostHasPin && after > before,
				hostHasPin: hostHasPin,
				probe: probe,
				attach: true,
				before: before,
				after: after,
				cleanup: 'button[aria-label^="移除图片 ' + name + '"]',
			}
		}

		/**
		 * 把全局热键守护进程按偏好拉起来/停掉。
		 * 用户可以在菜单里开关 —— 常驻一个 PowerShell 进程是有代价的，
		 * 不该在用户没要的时候偷偷跑。
		 */
		async function applyHotkeys() {
			if (shot.api === null) return { ok: false, error: 'service unavailable' }
			const want = prefs().hotkeys === true
			try {
				const res = want
					? await shot.api.hotkeys('start', JSON.stringify({ focusTitle: 'DeepSeek Harness' }))
					: await shot.api.hotkeys('stop', '{}')
				if (res && res.bindings) shot.hotkeys = { alive: res.alive === true, bindings: res.bindings, error: res.error || '' }
				postDiag('hotkeys', { want: want, alive: res && res.alive, bindings: res && res.bindings, error: res && res.error })
				return res || { ok: false, error: 'no reply' }
			} catch (error) {
				const msg = String((error && error.message) || error)
				postDiag('hotkeys-failed', { want: want, error: msg })
				return { ok: false, error: msg }
			}
		}

		/* 旧的 runScrollCapture（一次性把整段自动滚完、期间接管真实鼠标）已下线：
		   用户 2026-10-16 明确要"两种模式都留着"，而这两种都由 runLongSession 走
		   宿主侧会话完成（manual = 他自己滚，auto = 宿主发滚轮消息）。留着一份没人调的
		   旧实现只会让人以为它还在被使用 —— 这个工程栽过"改了 false 分支"那一次。 */

		/** 提取文字 / 屏幕翻译的收尾：OCR 之后弹一个可复制、可贴进输入框的面板。 */
		async function runTextKind(out, kind) {
			if (shot.api === null) return
			const region = out.rect
			toast('正在离线识别文字…', 1400)
			const res = await ocrRegion(shot.lastShotId || '', region)
			if (res.ok !== true) {
				toast('识别失败：' + (res.error || '未知错误'))
				return
			}
			const text = res.text || ''
			if (text.trim().length === 0) {
				toast('这块区域没识别出文字')
				return
			}
			const prefix =
				kind === 'translate'
					? '把下面这段屏幕文字翻译成中文（保留术语与专有名词，只输出译文）：\n\n'
					: ''
			showTextPanel(text, prefix, res.lines.length)
		}

		function showTextPanel(text, prefix, lineCount) {
			let panel = document.querySelector('.dshot-textpanel')
			if (panel === null) {
				panel = document.createElement('div')
				panel.className = 'dshot-textpanel'
				mountBody(panel)
			}
			panel.textContent = ''
			const head = document.createElement('div')
			head.className = 'dshot-textpanel-head'
			head.textContent = (prefix.length > 0 ? '屏幕翻译' : '提取文字') + '（离线识别 ' + lineCount + ' 行）'
			const body = document.createElement('textarea')
			body.className = 'dshot-textpanel-body'
			body.value = text
			body.spellcheck = false
			const foot = document.createElement('div')
			foot.className = 'dshot-textpanel-foot'
			const copy = document.createElement('button')
			copy.type = 'button'
			copy.className = 'dshot-btn'
			copy.textContent = '复制文本'
			copy.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(body.value)
					toast('已复制文本')
				} catch {
					body.select()
					document.execCommand('copy')
					toast('已复制文本')
				}
			})
			const insert = document.createElement('button')
			insert.type = 'button'
			insert.className = 'dshot-btn dshot-primary'
			insert.textContent = prefix.length > 0 ? '贴进输入框让 DSH 翻译' : '贴进输入框'
			insert.addEventListener('click', () => {
				insertPlainText(prefix + body.value)
				toast('已贴进输入框')
				panel.remove()
			})
			const closeBtn = document.createElement('button')
			closeBtn.type = 'button'
			closeBtn.className = 'dshot-btn'
			closeBtn.textContent = '关闭'
			closeBtn.addEventListener('click', () => panel.remove())
			foot.append(copy, insert, closeBtn)
			panel.append(head, body, foot)
		}

		function insertPlainText(text) {
			// 优先走官方公开动作面（session 槽的 kit prop 里就有 inputActions）：
			// execCommand 是备胎，Lexical 不认它的时候会静默什么都不发生。
			const acts = shot.inputActions
			if (acts !== null && typeof acts.insertText === 'function') {
				try {
					acts.insertText(text);
					return true
				} catch (error) {
					console.warn('[screenshot] inputActions.insertText failed', error)
				}
			}
			try {
				const editor = document.querySelector('[data-composer-input]')
				if (editor !== null) {
					editor.focus()
					document.execCommand('insertText', false, text)
					return true
				}
			} catch (error) {
				console.warn('[screenshot] execCommand insertText failed', error)
			}
			return false
		}

		/** 完成：剪贴板 + 贴进输入框（两条都要，谁也別挡谁）。 */
		async function deliver(out, kind) {
			const p = prefs()
			let attached = false
			let copied = false
			if (p.autoCopy !== false) copied = await copyToClipboard(out.blob)
			if (p.autoAttach !== false) attached = await attachToComposer(out.blob, 'screenshot.png')
			const bits = []
			if (attached) bits.push('已贴进输入框')
			if (copied) bits.push('已复制到剪贴板')
			if (attached && copied) {
				toast(bits.join(' · '))
			} else if (copied && !attached) {
				// 官方 drop 的门槛是 canAcceptDrop = subagent===null && !locked && !machineBusy
				// —— 这一轮还在跑的时候输入框**不收附件**，属于正常拒绝，不是坏了。
				toast('已复制到剪贴板（输入框这会儿正忙/不收附件，直接 Ctrl+V 也能贴）', 3600)
			} else if (attached && !copied) {
				toast('已贴进输入框（剪贴板被浏览器拒了）')
			} else {
				toast('已生成截图，但贴图与复制都没成功（可点 💾 保存到文件）', 3600)
			}
			// 「提取文字 / 屏幕翻译」是**截完直接出字**，不用再点工具栏那一下
			if (kind === 'ocr' || kind === 'translate') void runTextKind(out, kind)
		}

		/* ══════════════ QQ 式菜单 ══════════════ */

		/** 上一次量到的、**可用**的锚点矩形。当前锚点退化时拿它顶上。 */
		let lastAnchorRect = null

		/**
		 * 取锚点矩形，**永远返回一个能用来定位的矩形，且绝不抛**。
		 *
		 * 为什么不能直接写 anchorEl.getBoundingClientRect()：
		 *   ① anchorEl 可能是 null —— 组件已卸载，或从「没有锚点」的入口进来
		 *      （window.__dshotScreenshot.menu()、window.__dshotDebug.openMenu()）；
		 *   ② anchorEl 还在文档里（isConnected === true）但**某个祖先是 display:none** ——
		 *      实测：DSH 弹出「等待审批」卡片时会把整条输入框隐藏，此时 📷 按钮的
		 *      getBoundingClientRect() 返回 0×0（offsetParent 也为 null）。
		 *   老代码在这两种情况下会把菜单 clamp 到窗口角落，用户看到的就是
		 *   「菜单能弹，但跑到屏幕角落、不在按钮旁边」（2026-10-16 用户实测）。
		 *
		 * 出口顺序：当前 rect 可用 -> 上一次的好位置 -> 视口右下角（永远点得到）。
		 */
		function anchorRect(el) {
			try {
				if (el && el.isConnected === true) {
					const r = el.getBoundingClientRect()
					if (r.width > 0 || r.height > 0) {
						lastAnchorRect = r
						return r
					}
				}
			} catch {}
			// 退化也要留痕：下一个 AI 才能从诊断里看出「菜单为什么长在角落」。
			postDiag('menu-anchor-degenerate', {
				connected: !!(el && el.isConnected === true),
				held: lastAnchorRect !== null,
			})
			if (lastAnchorRect !== null) return lastAnchorRect
			const w = window.innerWidth
			const h = window.innerHeight
			return { left: w - 56, top: h - 72, right: w - 42, bottom: h - 58, width: 14, height: 14 }
		}

		function openMenu(anchorEl, onClose) {
			// 菜单的外观**全部**来自主样式表；不在这里确保一次，重载之后的第一下点开
			// 就是一个没有样式的菜单（掉进 body 正常流 -> 跑到窗口角落 -> 还点不到）。
			ensureShotStyles()
			const p = prefs()
			const menu = document.createElement('div')
			menu.className = 'dshot-menu'
			// 关键布局**内联兜底**：哪怕样式表因为任何原因没装上，菜单也必须是浮层。
			// 一旦掉进正常流，它就会跑到 body 末尾 —— 窗口左下角、视口之外，
			// 用户既看不到正确位置、也点不到（2026-10-16 用户实测的那次）。
			menu.style.position = 'fixed'
			menu.style.zIndex = '2147483004'
			menu.style.visibility = 'hidden'

			const item = (glyph, label, hint, onClick, active) => {
				const row = document.createElement('div')
				row.className = 'dshot-mi' + (active ? ' is-on' : '')
				const g = document.createElement('span')
				g.textContent = glyph
				g.style.width = '18px'
				const t = document.createElement('span')
				t.textContent = label
				row.append(g, t)
				if (hint) {
					const k = document.createElement('kbd')
					k.textContent = hint
					row.append(k)
				}
				row.addEventListener('click', (ev) => {
					ev.stopPropagation()
					onClick(row)
				})
				return row
			}

			const isWindow = p.mode === 'window'
			/**
			 * 热键提示文字。**必须是宿主真正抢到的那个键**，不是我们打算用的那个：
			 * 这台机器上 QQ 已经占了 Ctrl+Alt+A（RegisterHotKey 返回 win32 1409），
			 * 显示一个按下去没反应的键，比不显示更糟。
			 */
			const hk = (action) => {
				const b = shot.hotkeys && shot.hotkeys.bindings ? shot.hotkeys.bindings[action] : ''
				return b ? b : ''
			}
			const hkOff = prefs().hotkeys !== true
			// 服务没接上时，**把话写在菜单最上面**：用户一眼能看到"哪一步没成"，
			// AI 也能从截图里读出来（不用再猜"点了没反应"是哪种没反应）。
			if (shot.api === null) {
				const bad = document.createElement('div')
				bad.className = 'dshot-mi is-bad'
				bad.textContent = '⚠ 宿主服务未接上：' +
					(shot.diag.mountOk === false ? 'mount 失败 ' + shot.diag.mountError : shot.diag.injected === null ? 'inject 没触发' : 'remote.shot 拿不到')
				bad.addEventListener('click', (ev) => {
					ev.stopPropagation()
					postDiag('menu-bad-click')
				})
				menu.append(bad)
			}
			// 主操作只留四行。用户 2026-10-16 的原话是「这个界面太繁杂了，简化一下」——
			// 13 行菜单里天天用的就是这四行，其余全部收进「更多设置 ▸」这个二级浮层。
			menu.append(
				item('✂', '截图', hkOff ? '' : hk('shot'), () => {
					close()
					// 走唯一入口：这行以前直接 doCapture('shot')，于是「菜单里点截图」
					// 和「按热键/点按钮」走了两条不同的路（前者永远 DOM）。
					void doShotEntry()
				}),
				item('⏺', shot.recording ? '停止录屏' : '录屏', hkOff ? '' : hk('record'), () => {
					close()
					if (shot.recording) void stopRecording()
					else void startRecording()
				}),
				item('Aa', '提取文字（离线 OCR）', hkOff ? '' : hk('ocr'), () => {
					close()
					void doNativeRegion('ocr')
				}),
				item('⇕', '长截图（滚动拼接）', hkOff ? '' : hk('scroll'), () => {
					close()
					void doNativeRegion('scrollRegion')
				})
			)
			const sep = document.createElement('div')
			sep.className = 'dshot-mi-sep'
			menu.append(sep)
			/** 收起时也要看得出当前状态，否则"更多设置"等于把状态藏起来了。 */
			const settingsSummary = () => {
				const q = prefs()
				const parts = []
				if (q.hideSelf) parts.push('隐藏 DSH 界面')
				if (q.hotkeys) parts.push('热键开')
				if (q.scrollMode === 'auto') parts.push('长截图自动滚')
				if (q.recRegion === 'pick') parts.push('录屏先框一块')
				if (q.recAudio) parts.push('录屏有声')
				return parts.join(' · ')
			}

			/** 二级菜单的行。做成"一次性构建的数组"，塞进独立浮层，主菜单不再变长。 */
			const settingsRows = () => {
				const sepEl = () => {
					const s = document.createElement('div')
					s.className = 'dshot-mi-sep'
					return s
				}
				return [
					// R33：删掉了「范围 / 选窗口来截 / 自己框范围 / 抓窗方式」四项 ——
					// 它们只对**已取消的**"在 DSH 里渲染桌面截图"那套有意义（旧路径按窗口句柄
					// 抓屏、用 PrintWindow 自绘）。现在截图一律在原生覆盖层里框，范围和抓法由
					// "框哪块"直接决定，留着这些开关只会让人以为还有第二种截图方式。
					item(p.hideSelf ? '☑' : '☐', '截图时隐藏 DSH 界面', '', (row) => {
						setPref('hideSelf', !prefs().hideSelf)
						row.querySelector('span:first-child').textContent = prefs().hideSelf ? '☑' : '☐'
					}, p.hideSelf),
					item('⇕', '长截图方式：' + (prefs().scrollMode === 'auto' ? '程序自己滚' : '我自己滚'), '', (row) => {
						setPref('scrollMode', prefs().scrollMode === 'auto' ? 'manual' : 'auto')
						row.querySelector('span:nth-child(2)').textContent =
							'长截图方式：' + (prefs().scrollMode === 'auto' ? '程序自己滚' : '我自己滚')
					}),
					item('▭', '录制范围：' + (prefs().recRegion === 'pick' ? '每次框一块' : '整个桌面'), '', (row) => {
						setPref('recRegion', prefs().recRegion === 'pick' ? 'screen' : 'pick')
						row.querySelector('span:nth-child(2)').textContent =
							'录制范围：' + (prefs().recRegion === 'pick' ? '每次框一块' : '整个桌面')
					}),
					/**
					 * 录屏录音（R41）。为什么"打开"这个动作要先问一次设备：
					 * 这台机器可能压根没有麦（或者被别的程序独占）。开关打开了却永远录不到声音，
					 * 比开关根本打不开更糟 —— 用户会以为录到了，事后才发现半小时素材全哑。
					 * 所以：没有设备就**拒绝打开并说明**；有设备就告诉他用的是哪一块。
					 */
					item(prefs().recAudio ? '☑' : '☐', '录屏录音：' + (prefs().recAudio ? '开（自动选设备）' : '关（静音）'), '', (row) => {
						const mark = () => {
							row.querySelector('span:first-child').textContent = prefs().recAudio ? '☑' : '☐'
							row.querySelector('span:nth-child(2)').textContent =
								'录屏录音：' + (prefs().recAudio ? '开（自动选设备）' : '关（静音）')
						}
						if (prefs().recAudio) {
							setPref('recAudio', false)
							mark()
							return toast('录屏不再录音')
						}
						if (shot.api === null || typeof shot.api.record !== 'function') return toast('截图服务未就绪（宿主半边没起来）')
						void (async () => {
							let res = null
							try {
								res = await shot.api.record('devices', '')
							} catch (error) {
								res = null
							}
							const mics =
								res !== null && res.ok === true && Array.isArray(res.devices) ? res.devices.filter((d) => d !== null && d.kind === 'audio') : []
							if (mics.length === 0) {
								return toast('这台机器上没有可用的录音设备，录屏保持静音', 5200)
							}
							setPref('recAudio', true)
							// 不把设备名钉进偏好：自动挑更耐用（换耳机、拔插都不会让旧名字失效）。
							// 自动的档位是确定的（R42，宿主侧 resolveAudioDevice）：麦克风 > 系统音 > 第一块。
							// R44：**报出来的名字必须来自宿主的挑选结果**（res.auto），不能拿 devices[0] 猜 ——
							// 列表第一块和宿主真正挑的那块可以不是同一个（旧宿主没有 auto 时才退回猜）。
							setPref('recMic', '')
							mark()
							const autoName = typeof res.auto === 'string' && res.auto !== '' ? res.auto : mics[0].name
							toast('录屏会录音，使用：' + autoName + (mics.length > 1 ? '（共 ' + mics.length + ' 个设备，自动挑的这一个）' : ''), 5600)
						})()
					}, prefs().recAudio),
					item('译', '屏幕翻译（OCR → 交给 DSH）', hkOff ? '' : hk('translate'), () => {
						close()
						void doNativeRegion('translate')
					}),
					sepEl(),
					item('⌨', '全局热键：' + (prefs().hotkeys ? '已开启（DSH 外也能按）' : '关闭'), '', () => {
						close()
						const want = !prefs().hotkeys
						setPref('hotkeys', want)
						void applyHotkeys().then((res) => {
							if (!want) {
								toast('全局热键已关闭')
								return
							}
							if (res && res.ok) {
								const b = (res.bindings && res.bindings.shot) || '?'
								toast('全局热键已开启：截图 ' + b, 4200)
							} else {
								toast('热键开启失败：' + ((res && res.error) || '未知错误'), 5000)
							}
						})
					}, prefs().hotkeys),
					item('▦', '马赛克块大小：' + prefs().mosaicBlock + ' px', '', (row) => {
						// 点一下在 12 / 18 / 26 / 36 之间循环 —— 够用，而且不用再开一个面板
						const seq = [12, 18, 26, 36]
						const cur = seq.indexOf(prefs().mosaicBlock)
						const next = seq[(cur + 1) % seq.length]
						setPref('mosaicBlock', next)
						row.querySelector('span:nth-child(2)').textContent = '马赛克块大小：' + next + ' px'
					}),
					// 诊断出口：AI 看不到这个 GUI 的控制台，把 DOM 事实写进
					// 图片\DSH截图\domdump-*.png（内容是 JSON），它就能读懂现场。
					item('🩺', '诊断：导出 DOM 快照给 AI', '', () => {
						close()
						void dumpDiagnostics('manual').then((res) => {
							// 成败都要说出来：以前失败是静默的，用户只会看到"点了没反应"
							if (res.ok) toast('已写一份 DOM 快照：' + res.path, 4200)
							else toast('写快照失败：' + res.error, 5000)
						})
					}),
				]
			}

			/**
			 * 二级浮层。为什么是"悬停/点击都开"而不是子菜单嵌套：主菜单是**向上弹**的，
			 * 往右贴一层比再往上叠一层稳（往上叠会顶到窗口顶上的拖动死区，那里点不动）。
			 */
			let more = null
			let moreTimer = 0
			const closeMore = () => {
				clearTimeout(moreTimer)
				if (more !== null) {
					more.remove()
					more = null
				}
			}
			const openMore = () => {
				clearTimeout(moreTimer)
				if (more !== null) return
				const box = document.createElement('div')
				box.className = 'dshot-menu dshot-more'
				box.append(...settingsRows())
				mountBody(box)
				const r = moreRow.getBoundingClientRect()
				const bw = box.offsetWidth || 220
				const bh = box.offsetHeight || 240
				let left = r.right + 4
				if (left + bw > window.innerWidth - 8) left = Math.max(8, r.left - bw - 4)
				box.style.left = Math.round(left) + 'px'
				box.style.top = Math.round(Math.max(8, Math.min(window.innerHeight - bh - 8, r.top - 6))) + 'px'
				box.addEventListener('mouseenter', () => clearTimeout(moreTimer))
				box.addEventListener('mouseleave', () => {
					moreTimer = setTimeout(closeMore, 320)
				})
				more = box
			}
			const moreRow = item('⚙', '更多设置', settingsSummary(), () => {
				if (more === null) openMore()
				else closeMore()
			})
			moreRow.title = '隐藏 DSH 界面 / 热键 / 马赛克 / 长截图方式 / 录屏范围 / 诊断'
			moreRow.addEventListener('mouseenter', () => {
				moreTimer = setTimeout(openMore, 140)
			})
			moreRow.addEventListener('mouseleave', () => {
				moreTimer = setTimeout(closeMore, 320)
			})
			menu.append(moreRow)

			// ⚠️ 顺序与容错都是**故意的**，别改回去（2026-10-16 用户报「截图点不开」的根因）：
			//   ① 锚点矩形必须在 append **之前**量好 —— 老代码 append 之后再量，
			//      锚点为空时会在 append 与量取之间抛异常，留下一个 visibility:hidden 的
			//      死菜单，而且调用方已经先 setMenuOpen(true) —— 按钮从此永久点不动；
			//   ② 定位整段包 try —— 任何意外都不该让菜单停在 hidden；
			//   ③ 锚点退化时走 anchorRect 的回落，别再让菜单被 clamp 到窗口角落。
			const r = anchorRect(anchorEl)
			mountBody(menu)
			try {
				const mw = menu.offsetWidth
				const mh = menu.offsetHeight
				menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left - 4)) + 'px'
				menu.style.top = Math.max(8, Math.min(window.innerHeight - mh - 8, r.top - mh - 10)) + 'px'
			} catch (error) {
				menu.style.left = '8px'
				menu.style.top = Math.max(8, window.innerHeight - 260) + 'px'
				postDiag('menu-place-failed', { error: String((error && error.message) || error) })
			}
			menu.style.visibility = 'visible'

			function close() {
				document.removeEventListener('mousedown', onDoc, true)
				document.removeEventListener('keydown', onKey, true)
				closeMore()
				menu.remove()
				if (typeof onClose === 'function') onClose()
			}
			function onDoc(ev) {
				// 二级浮层是 menu 的**兄弟节点**（不在 menu 里），点它不算"点外面"，
				// 否则鼠标还没移到浮层上，主菜单就先把自己关了。
				if (menu.contains(ev.target)) return
				if (more !== null && more.contains(ev.target)) return
				close()
			}
			function onKey(ev) {
				if (ev.key === 'Escape') close()
			}
			document.addEventListener('mousedown', onDoc, true)
			document.addEventListener('keydown', onKey, true)
			return close
		}

		/* ══════════════ 按钮 ══════════════ */

		function ShotButton(props) {
			const [menuOpen, setMenuOpen] = React.useState(false)
			const [ready, setReady] = React.useState(shot.api !== null)
			const ref = React.useRef(null)

			React.useEffect(() => {
				const t = setInterval(() => setReady(shot.api !== null), 1200)
				return () => clearInterval(t)
			}, [])

			// 把「备用入口」挂到 window 上：会话没输入框 / 槽没渲染时也能用热键
			React.useEffect(() => {
				// 官方公开动作面就藏在 kit props 里（renderer 会把 kit spread 进条目 props）
				shot.inputActions = props && props.inputActions ? props.inputActions : null
				const handle = { capture: () => doShotEntry(), menu: () => openMenu(ref.current) }
				window.__dshScreenshot = handle
				return () => {
					shot.inputActions = null
					/**
					 * ⚠️ 只能删**自己那一个**（R33 实测）：热重载后新实例的 effect 先跑、旧实例的
					 * cleanup 后跑，无条件 `delete window.__dshScreenshot` 会把新实例刚挂上的入口
					 * 一起删掉 —— 症状是热重载之后 `__dshScreenshot` 凭空消失，AI 直连桥的
					 * `menu` op 报 "no trigger button"，而按钮明明还在屏幕上。
					 */
					if (window.__dshScreenshot === handle) delete window.__dshScreenshot
				}
			}, [])

			const title = ready ? '左键直接截图 · 右键更多（录屏 / 提取文字 / 长截图 / 设置：隐藏 DSH 界面）' : '截图服务未就绪（宿主半边没起来）'

			return h(
				'span',
				{ className: 'dshot-wrap', ref: ref, style: { display: 'inline-flex', alignItems: 'center' } },
				h(
					'button',
					{
						type: 'button',
						className: 'dshot-trigger' + (menuOpen ? ' is-on' : ''),
						title: title,
						'aria-label': '截图',
						/**
						 * ⚡ 左键**直接进截图**，不再"点按钮 → 选菜单 → 再等"。
						 * 用户 2026-10-16 的原话：「操作有些繁琐，不如 QQ 截图方便」——
						 * QQ 的截图键是一下到位，这里对齐它：一下就是覆盖层。
						 * 其余四个功能（录屏 / 提取文字 / 长截图 / 设置）收进**右键**菜单。
						 */
						onClick: (ev) => {
							ev.preventDefault()
							ev.stopPropagation()
							if (menuOpen) {
								// 菜单开着时再点按钮 = 收起菜单。这里**必须有出口**：
								// R17.8 的教训就是「因为已经有 X 所以不做」的分支静默 return，
								// 会让按钮从此再也点不动、且一条诊断都没有。
								const closer = shot.menuCloser
								shot.menuCloser = null
								if (typeof closer === 'function') closer()
								return
							}
							// 能出原生覆盖层就走原生（那是一块能盖住整个桌面的真窗口），否则走应用内那套。
							// 判据在 doShotEntry 里，三条入口共用一份，别再各抄一遍。
							void doShotEntry()
						},
						onContextMenu: (ev) => {
							ev.preventDefault()
							ev.stopPropagation()
							if (menuOpen) return
							// ⚠️ 先开、开成了才置位。老代码是 setMenuOpen(true) 在前、openMenu() 在后，
							//    一旦 openMenu 抛异常，menuOpen 就永远停在 true —— 此后每次点击都在
							//    上面那行静默 return：按钮看着正常、点着没反应、连一条诊断都没有。
							//    「凡是『因为已经有 X 所以不做』的分支，都必须有出口。」
							const closer = openMenu(ref.current, () => setMenuOpen(false))
							if (typeof closer === 'function') {
								shot.menuCloser = closer
								setMenuOpen(true)
							}
						},
					},
					h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
						h('path', {
							d: 'M2 5.2A1.7 1.7 0 0 1 3.7 3.5h1.1l.7-1.1h4.9l.7 1.1h1.2A1.7 1.7 0 0 1 14 5.2v6.1a1.7 1.7 0 0 1-1.7 1.7H3.7A1.7 1.7 0 0 1 2 11.3z',
							stroke: 'currentColor',
							'stroke-width': '1.3',
							'stroke-linejoin': 'round',
						}),
						h('circle', { cx: 8, cy: 8.2, r: 2.5, stroke: 'currentColor', 'stroke-width': '1.3' })
					)
				)
			)
		}

		/* ══════════════ 样式 ══════════════ */

		const CSS = `
.dshot-trigger{appearance:none;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;padding:0;opacity:.72}
.dshot-trigger:hover{background:rgba(127,127,127,.18);opacity:1}
.dshot-trigger.is-on{background:rgba(127,127,127,.24);opacity:1}
`

		function ensureStyles() {
			if (document.getElementById('dshot-trigger-styles') !== null) return
			const el = document.createElement('style')
			el.id = 'dshot-trigger-styles'
			el.textContent = CSS
			document.head.appendChild(el)
		}

		/* ══════════════ apply ══════════════ */

		async function apply(ctx) {
			ensureStyles()
			// 主表也在这里先装一次：只靠覆盖层那条路径懒加载的话，每次重载之后
			// 「第一个点 📷 的人」拿到的永远是一个没样式的菜单（见 ensureShotStyles 注释）。
			ensureShotStyles()

			// ⓪ AI 直连桥 + 调试钩子。**放在最前面，且不依赖 Remote** —— 宿主半边没起来时，
			//    这里恰恰是唯一能把"到底卡在哪一步"运出去的通道。
			//    eval op 只能碰到 window 级的东西，而 shot/prefs/doCapture 都在模块闭包里，
			//    所以给一个明确命名的钩子，而不是把内部状态散到 window 上。
			window.__dshotDebug = {
				/** 版本标记：AI 直连桥靠它判断"我改的这版到底加载了没有"（热重载有延迟）。 */
				build: CLIENT_BUILD,
				/** 本代次标记 + 加载时清掉了几个上一代次的节点（R38：跨热重载的 DOM 清理）。 */
				gen: DSHOT_GEN,
				swept: DSHOT_SWEPT,
				sweep: sweepStaleDom,
				shot: shot,
				prefs: prefs,
				setPref: setPref,
				doCapture: doCapture,
				// 原生那条路也要能从桥里驱动 —— 否则"改了客户端"只能靠静态断言。
				// doNativeRegion(kind, {selfTest:true}) 会真的走 overlay(regionOnly) ，
				// 因为它绕开的只是"人手拖框"那一步，不是任何一段代码。
				doNativeRegion: doNativeRegion,
				doShotEntry: doShotEntry,
				// 录屏也放出来：区域录制这条链要能被真机验证（框 → record start → ffprobe 尺寸）
				startRecording: startRecording,
				stopRecording: stopRecording,
				openMenu: openMenu,
				pinImage: pinImage,
				// R67：贴图窗「送进输入框」的**最后一跳**（poll 取到 pin → 贴成附件）。
				// 放出来是为了验收：宿主还没换的时候，这一跳也能单独喂一张图进去看结果
				// （`await __dshotDebug.receivePin({dataUrl, name})`），否则只能等人点鼠标。
				receivePin: receivePin,
				countAttachments: countComposerAttachments,
				// R67c：一条命令验收"这台机器现在能不能贴图"（默认只判定不贴图）。
				pinAccept: pinAccept,
				toast: toast,
			}
			aiBridgeStart()

			// ① 先把 Remote 通道挂上（失败也不挡按钮：按钮会显示「服务未就绪」）
			try {
				await ctx.remote.$mount({ package: PKG, descriptors: INVOCATIONS })
				shot.diag.mountOk = true
			} catch (error) {
				shot.diag.mountOk = false
				shot.diag.mountError = String((error && error.message) || error)
				console.warn('[screenshot] remote mount failed', error)
			}
			ctx.inject(['remote.' + SERVICE], (scope) => {
				shot.diag.injected = true
				const remote = scope.remote[SERVICE]
				shot.diag.apiSet = !!remote
				// 能干活了（不参与新旧排序：排序只看 apply 结束的 born，见 AI_BRIDGE.born）。
				AI_BRIDGE.readyAt = Date.now()
				shot.api = {
					cap: (mode, hide, method, hwnd, rect) =>
						Promise.resolve(
							remote.cap(mode || undefined, hide || undefined, method || undefined, Number.isFinite(hwnd) && hwnd > 0 ? hwnd : undefined, rect || undefined)
						).then(unwrap),
					ocr: (id, rect, upscale, lang, preprocess) =>
						Promise.resolve(remote.ocr(id || undefined, rect || undefined, upscale, lang || undefined, preprocess || undefined)).then(unwrap),
					record: (action, opts) =>
						Promise.resolve(remote.record(action || undefined, opts || undefined)).then(unwrap),
					scroll: (rect, opts) => Promise.resolve(remote.scroll(rect || undefined, opts || undefined)).then(unwrap),
					save: (dataUrl, name) => Promise.resolve(remote.save(dataUrl || undefined, name || undefined)).then(unwrap),
					// R67c：贴图统一走原生贴图窗。老宿主没有这个方法 → typeof 判断即"重启 DSH"。
					...(typeof remote.pin === 'function'
						? { pin: (dataUrl, opts) => Promise.resolve(remote.pin(dataUrl || undefined, opts || undefined)).then(unwrap) }
						: {}),
					list: () => Promise.resolve(remote.list()).then(unwrap),
					status: () => Promise.resolve(remote.status()).then(unwrap),
					winlist: (exclude, limit) => Promise.resolve(remote.winlist(exclude === undefined ? undefined : exclude, limit)).then(unwrap),
					poll: (since) => Promise.resolve(remote.poll(since)).then(unwrap),
					hotkeys: (action, opts) => Promise.resolve(remote.hotkeys(action || undefined, opts || undefined)).then(unwrap),
					/**
					 * 原生覆盖层（M1）。**只在宿主真的提供它时才挂上去** ——
					 * 这样老宿主（没重启）连 api.overlay 都不存在，feature-detect 自然回落到 DOM。
					 */
					...(typeof remote.overlay === 'function'
						? {
								overlay: (timeout, opts) =>
									Promise.resolve(remote.overlay(Number.isFinite(timeout) ? timeout : undefined, opts === undefined || opts === null ? undefined : opts)).then(unwrap),
							}
						: {}),
				}
				// ③ 心跳：热键按下 / AI 投递都从这条通道回来。
				//    宿主半边接上之后才开始轮询 —— 服务没起来时轮询只会每秒失败一次。
				startPolling()
				if (prefs().hotkeys === true) void applyHotkeys()
			})

			// ② 热键：Ctrl+Alt+A 截图（QQ 同款），Ctrl+Alt+O 提取文字
			document.addEventListener('keydown', (ev) => {
				if (!ev.ctrlKey || !ev.altKey) return
				const k = String(ev.key || '').toLowerCase()
				if (k === 'a') {
					ev.preventDefault()
					void doShotEntry()
				} else if (k === 'o') {
					ev.preventDefault()
					void doNativeRegion('ocr')
				}
			}, true)

			// ③ 按钮进槽：order -90 → 排在语音键（-100）之后，正好在它旁边
			ctx.inject(['slots', 'conversation', 'sessions'], (scope) => {
				scope.slots.inject('conversation.input.left', () =>
					scope.slots.register({
						name: 'conversation.input.left',
						id: 'dsh-screenshot-button',
						order: -90,
						inject: () => ({}),
					}, ShotButton)
				)
			})

			// ④ 开机自报一次 DOM 快照（AI 看不到控制台，只能靠这个外送事实）。
			//    延时是为了等其它插件（session-org 等）先挂完，否则快照里全是 null。
			//    ⚠️ 但**一次机会不够**：实测 12:05 那次重启时，2.6s 处 shot.api 还没接上
			//    （Remote $mount 是异步的），于是静默放弃 —— AI 那边一个字节都没拿到，
			//    只能改用截图去猜。改成最多试 12 次（每 1.5s，约 18s），成功即停。
			//    ★ 再加一条**不依赖宿主 RPC** 的上报：postDiag 直接 POST 到本机收集口。
			//    宿主那条通道（save()）会被 DSH 文件策略静默拒掉，只剩这条路能把
			//    "到底卡在哪一步"运出来。开机先寄一封，不管后面成不成。
			let bootTries = 0
			let bootPosted = false
			const bootDumpTick = () => {
				bootTries += 1
				if (shot.api === null) {
					if (!bootPosted && bootTries >= 2) {
						bootPosted = true
						postDiag('boot-no-api', { bootTries: bootTries })
					}
					if (bootTries < 12) window.setTimeout(bootDumpTick, 1500)
					return
				}
				if (bootTries === 1) postDiag('boot-api-ready', { bootTries: bootTries })
				void dumpDiagnostics('boot')
			}
			window.setTimeout(bootDumpTick, 2600)
			// 暴露给"用户点一下"的入口 & 我后续的触发手段
			window.__dshotDump = (tag) => {
				postDiag('manual-' + (tag || 'x'))
				return dumpDiagnostics(tag || 'manual')
			}
		}

		// ⚠️ **`remote` 必须在 inject 里**。cordis 的规矩：没声明的服务连读都不许读 ——
		// 漏了它的表现是 `ctx.remote.$mount(...)` 抛
		// `cannot get property "remote" without inject`，而 $mount 失败**不会**让按钮消失
		// （按钮注册在 slots 槽上，跟 remote 无关），于是症状是「按钮在、一点效果都没有」。
		// 这一条是 2026-10-16 用户实测「截图没有效果」的真凶，靠独立上报通道抓到的。
		return { name: 'dsh-screenshot', apply, inject: ['slots', 'conversation', 'sessions', 'remote'] }
	},
})
