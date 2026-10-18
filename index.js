/**
 * dsh-screenshot — 宿主半边（node half）。
 *
 * 这半边干的全是浏览器干不了的事：抓屏（System.Drawing）、离线 OCR（Windows.Media.Ocr）、
 * 录屏（ffmpeg gdigrab）、合成滚轮 + 拼接（长截图）、存盘。
 * 为什么不能在浏览器里做：官方主会话**没有** setDisplayMediaRequestHandler，权限处理器
 * 只放行麦克风 —— 渲染进程的 getDisplayMedia 拿不到任何源（asar 逐文件取证见交接文件 R14）。
 *
 * ⚠️ 失败关闭：profile 的 bundle patch 按**包名**挂插件行，这一个包起来的失败会连带整棵插件树。
 *    所以任何一步都不上抛，全部记进 .cache/boot-report.json（Electron 起的 GUI 没有 stdout 可看）。
 *
 * ⚠️ 解析 @deepseek-ai/dsh-typert-protocol 必须三级兜底：本插件是 junction 挂进 profile 的，
 *    真实路径在 <工作区>/DSH-Plugin 下，从那儿向上找不到 profile 的 node_modules。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeReport } from './lib/shot.mjs'

export const name = 'dsh-screenshot'

/**
 * 依赖全走 ctx.get()：缺哪个都不让整棵插件树挂掉。
 *
 * ⚠️ `tools` 必须显式声明 —— 见坑 33：apply 里用到哪个 ctx 服务就要在 inject 里列出来，
 *    否则宿主抛 "cannot get property without inject"，整棵插件树跟着挂。
 *    （这里只用它注册两个工具；注册失败会被下面的 try/catch 兜住，不影响 Remote 服务。）
 */
export const inject = ['tools']

const PKG = '@deepseek-ai/dsh-typert-protocol'
const ENTRY = 'lib/index.js'
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 向上找 profile 目录（<工作区>/.dsh/profiles/desktop）。找不到返回 null。 */
function findProfile() {
	let dir = PLUGIN_ROOT
	for (let i = 0; i < 6; i += 1) {
		const candidate = path.join(dir, '.dsh', 'profiles', 'desktop')
		if (existsSync(candidate)) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

/** 三级候选：裸说明符 → profile → 应用 asar。 */
function buildCandidates() {
	const out = [{ label: 'bare', spec: PKG, file: null }]
	const profile = findProfile()
	if (profile !== null) {
		const file = path.join(profile, 'node_modules', PKG, ENTRY)
		out.push({ label: 'profile', spec: pathToFileURL(file).href, file })
	}
	const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
	if (resources.length > 0) {
		const packed = path.join(resources, 'app.asar', 'dsh', 'node_modules', PKG, ENTRY)
		out.push({ label: 'asar', spec: pathToFileURL(packed).href, file: packed })
		const loose = path.join(resources, 'app', 'node_modules', PKG, ENTRY)
		out.push({ label: 'app', spec: pathToFileURL(loose).href, file: loose })
	}
	return out
}

/** 依次试所有候选，返回第一个能拿到 TypertRemoteService 的。任何一级失败都只记录。 */
async function resolveTypertBase() {
	const tried = []
	for (const candidate of buildCandidates()) {
		const exists = candidate.file === null ? null : existsSync(candidate.file)
		if (exists === false) {
			tried.push({ label: candidate.label, spec: candidate.spec, exists: false, error: 'entry file not found' })
			continue
		}
		try {
			const mod = await import(candidate.spec)
			const base = mod?.TypertRemoteService
			if (typeof base !== 'function') {
				tried.push({ label: candidate.label, spec: candidate.spec, exists, error: 'loaded, but TypertRemoteService is ' + typeof base })
				continue
			}
			tried.push({ label: candidate.label, spec: candidate.spec, exists, ok: true })
			return { base, tried, used: candidate.label }
		} catch (error) {
			tried.push({ label: candidate.label, spec: candidate.spec, exists, error: String(error?.message ?? error), code: error?.code ?? null })
		}
	}
	return { base: null, tried, used: null }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx) {
	const report = {
		at: new Date().toISOString(),
		plugin: name,
		pluginRoot: PLUGIN_ROOT,
		profile: findProfile(),
		node: process.versions.node,
		electron: process.versions.electron ?? null,
		resourcesPath: process.resourcesPath ?? null,
		steps: [],
	}

	// 常驻抓屏助手：**最先**异步拉起，这样用户第一次点 📷 时它已经热好了。
	// ⚠️ 只 spawn、绝不同步等它就绪 —— 初始化这条链路不能因为它慢半拍，更不能因为它失败而挂。
	//    起不来 / 半路死掉都不影响功能：capture() 会静默回落到"每次新起一个 pwsh"的老路径。
	let shooterMod = null
	try {
		shooterMod = await import('./lib/shooter.mjs')
		report.shooter = shooterMod.startShooter()
		report.steps.push(
			'render shooter: ' +
				(report.shooter.ok
					? `spawned pid ${report.shooter.pid} (tag ${report.shooter.tag})`
					: 'NOT started - ' + String(report.shooter.error ?? 'unknown'))
		)
		// 插件卸载时收掉它（先落 stop-flag 让它体面退出，~800ms 没走再 kill）。
		// ⚠️ 必须在下面的早退**之前**注册：service 解析失败时 apply 会 return，
		//    而那时助手已经在跑了，收尾钩子不能没挂上。
		ctx.on('dispose', () => {
			try {
				shooterMod.stopShooter()
			} catch {}
		})
	} catch (error) {
		report.shooter = { ok: false, error: String(error?.message ?? error) }
		report.steps.push('shooter FAILED: ' + report.shooter.error)
	}

	// 常驻「原生覆盖层」助手（M1）：独立进程 + 带真 HWND 的全屏窗口。
	// 这就是把选区从「DSH 窗口里的 DOM 平面」搬到「能盖住整个桌面的真窗口」的那一步。
	// 同样**只 spawn、绝不同步等**：它实测 ~4.9s 才写完 ready（Add-Type + DPI + 预热），
	// 初始化链路不能为它卡住；起不来也不影响任何既有功能（客户端会回落到 DOM 覆盖层）。
	let overlayMod = null
	try {
		overlayMod = await import('./lib/overlay.mjs')
		report.overlayHost = overlayMod.startOverlayHost()
		report.steps.push(
			'render overlay host: ' +
				(report.overlayHost.ok
					? `spawned pid ${report.overlayHost.pid} (tag ${report.overlayHost.tag})`
					: 'NOT started - ' + String(report.overlayHost.error ?? 'unknown'))
		)
		ctx.on('dispose', () => {
			try {
				overlayMod.stopOverlayHost()
			} catch {}
		})
	} catch (error) {
		report.overlayHost = { ok: false, error: String(error?.message ?? error) }
		report.steps.push('overlay host FAILED: ' + report.overlayHost.error)
	}

	/**
	 * 收尾：把助手的**就绪**状态刷进报告再落盘。
	 * ready / 已服务次数 / 退出原因只有到这会儿才看得准 —— 上面 status() 取样时它多半还在
	 * Add-Type。两条出口（正常 / 没有 typert 基类）都要走它，否则坏安装那一次就没有线索。
	 */
	const finishReport = async () => {
		if (shooterMod !== null && report.shooter?.ok === true) {
			try {
				report.shooter = { ...report.shooter, ...shooterMod.shooterStatus() }
				report.steps.push('shooter: ' + (report.shooter.ready ? 'ready' : 'not ready yet'))
			} catch {}
		}
		if (overlayMod !== null && report.overlayHost?.ok === true) {
			try {
				report.overlayHost = { ...report.overlayHost, ...overlayMod.overlayStatus() }
				report.steps.push('overlay host: ' + (report.overlayHost.ready ? 'ready' : 'not ready yet'))
			} catch {}
		}
		await writeReport(report)
	}

	// 自检资料先落一份（不依赖 typert 是否解析成功）。
	try {
		const { status } = await import('./lib/shot.mjs')
		report.status = await status()
		report.steps.push('status collected')
	} catch (error) {
		report.statusError = String(error?.message ?? error)
		report.steps.push('status FAILED')
	}

	const resolved = await resolveTypertBase()
	report.typert = { used: resolved.used, tried: resolved.tried }
	report.steps.push('typert resolve: ' + (resolved.used ?? 'FAILED (all candidates)'))

	if (resolved.base === null) {
		report.service = 'skipped'
		report.steps.push('service skipped - no base class')
		await finishReport()
		console.log('[screenshot/host] Typert Remote 不可用：三级解析全失败，详见 .cache/boot-report.json')
		return
	}

	try {
		const { createShotService } = await import('./lib/service.mjs')
		const ServiceClass = createShotService(resolved.base)
		await ctx.plugin(ServiceClass, {})
		report.service = 'registered'
		report.steps.push('service registered')
		console.log(`[screenshot/host] applied - remote shot via "${resolved.used}"`)
	} catch (error) {
		report.service = 'failed'
		report.serviceError = { message: String(error?.message ?? error), stack: String(error?.stack ?? '') }
		report.steps.push('service FAILED: ' + report.serviceError.message)
		console.log('[screenshot/host] 服务注册失败：', report.serviceError.message)
	}

	// AI 用的无感抓屏工具。**失败不影响 Remote 服务** —— 两条链路互相独立，
	// 工具注册不上（比如宿主没开 tools 服务）时，按钮和热键照样能用。
	try {
		const { buildShotTools } = await import('./tools.js')
		const disposers = []
		for (const definition of buildShotTools()) {
			disposers.push(ctx.tools.register(definition))
		}
		report.tools = { registered: disposers.length, names: buildShotTools().map((t) => t.name) }
		report.steps.push('tools registered: ' + report.tools.names.join(', '))
		console.log('[screenshot/host] tools registered - screenshot, screenshot_windows')
	} catch (error) {
		report.tools = { registered: 0, error: String(error?.message ?? error) }
		report.steps.push('tools FAILED: ' + String(error?.message ?? error))
	}

	// 助手的就绪状态由 finishReport() 统一刷进去（这里不再重复）。
	await finishReport()
}
