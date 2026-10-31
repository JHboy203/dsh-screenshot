/**
 * dev/pin-e2e.mjs — 贴图「送进输入框」的**宿主段**验收（R67）。
 *
 * 为什么需要它：贴图窗把图送到界面要过三段 ——
 *   ① 助手写 PNG + pinout.json（由 ovl-selftest 的 pinProbe 验）
 *   ② 宿主心跳 `poll()` → `takePinHandoff()` 取走（**这条只有真宿主能验**）
 *   ③ 客户端 `receivePin()` → `attachToComposer()`（真机验过，见交接文件 R67 §七）
 * ② 的判据不需要界面：往**真实信箱**写一条交接，看它会不会被取走。取走即删是
 * takePinHandoff 的不变量，所以"标记消失"就是"宿主收下了"。
 *
 * ⚠️ 两条副作用，跑之前先知道：
 *   * 必须由**宿主进程**跑（`host_selfcheck({plugin:'dsh-screenshot', script:'dev/pin-e2e.mjs'})`）：
 *     低完整性 shell 写不进 `.cache/overlay`。
 *   * 宿主是新代码时，这张 1x1 探针图会**真的贴进 DSH 的输入框**（心跳取到就 attach）。
 *     脚本结束会打印清理用的选择器；跑之前确认输入框里没有你正在写的草稿，
 *     或者跑完把那张 `pin-e2e-*.png` 删掉。
 *
 * 老宿主（没重启过）跑它 = 20 秒后 FAIL，并明确说"重启 DSH"—— 这不是产品回归。
 */
import fs from 'node:fs'
import path from 'node:path'

import { OVERLAY_DIR, PIN_HANDOFF_FILE, PIN_MAIL_DIR } from '../lib/overlay.mjs'

/** 1x1 PNG（红点）。探针图只需要是**合法**的 PNG：客户端会 fetch→blob→attach。 */
const PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, cond, extra) {
	const ok = cond === true
	if (!ok) failures += 1
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`)
	return ok
}

async function main() {
	console.log('OVERLAY_DIR   = ' + OVERLAY_DIR)
	console.log('PIN_HANDOFF   = ' + PIN_HANDOFF_FILE)
	console.log('PIN_MAIL_DIR  = ' + PIN_MAIL_DIR)

	// 信箱里已经有待处理的交接（用户刚点了「送进输入框」）→ 不动它，也不覆盖。
	if (fs.existsSync(PIN_HANDOFF_FILE)) {
		console.log('SKIP  信箱里已经有一条待处理的交接（用户刚点过「送进输入框」）—— 等界面取走再跑。')
		process.exit(0)
	}

	fs.mkdirSync(PIN_MAIL_DIR, { recursive: true })
	const stamp = Date.now()
	const png = path.join(PIN_MAIL_DIR, `pin-e2e-${stamp}.png`)
	fs.writeFileSync(png, Buffer.from(PNG_B64, 'base64'))
	// 先图后标记（与助手那边的顺序一致），标记走 .tmp + 改名。
	const marker = {
		ok: true,
		action: 'attach',
		png,
		name: path.basename(png),
		w: 1,
		h: 1,
		at: new Date().toISOString(),
		probe: 'pin-e2e',
	}
	const tmp = PIN_HANDOFF_FILE + '.tmp'
	fs.writeFileSync(tmp, JSON.stringify(marker), 'utf8')
	fs.renameSync(tmp, PIN_HANDOFF_FILE)
	check('probe handoff written', fs.existsSync(PIN_HANDOFF_FILE) && fs.existsSync(png), { png })

	// 心跳每秒一次；给 20 秒（贴图盖满窗口时心跳可能被节流，那时这里也会跟着变慢）。
	const deadline = Date.now() + 20_000
	let tookMs = -1
	while (Date.now() < deadline) {
		if (!fs.existsSync(PIN_HANDOFF_FILE)) {
			tookMs = 20_000 - (deadline - Date.now())
			break
		}
		await sleep(150)
	}
	check('host poll took the handoff (marker gone)', tookMs >= 0, { tookMs })
	check('host deleted the mailbox png (take-and-delete)', !fs.existsSync(png), { png })

	if (failures > 0) {
		// 别把垃圾留在信箱里：万一宿主一会儿才醒，它会消费一条谁都不认识的交接。
		try { fs.unlinkSync(PIN_HANDOFF_FILE) } catch {}
		try { fs.unlinkSync(png) } catch {}
		console.log('清理：标记与探针图已删除（宿主没取走，不会留下垃圾）。')
		console.log('')
		console.log('结论：宿主那半还是旧的 —— 重启一次 DSH 再跑这条命令。')
		console.log('      （客户端的最后一跳已经验过：__dshotDebug.receivePin() 能贴成附件）')
	} else {
		console.log('')
		console.log('结论：宿主取件这一跳是通的（≤' + tookMs + 'ms）。')
		console.log('      清理：界面里会多一张 1x1 的 pin-e2e 附件，点它的「移除图片」即可，或执行')
		console.log('      document.querySelector(\'button[title^="移除图片 pin-e2e"]\')?.click()')
	}

	console.log('----')
	console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('CRASH ' + (error?.stack ?? error))
	process.exit(2)
})
