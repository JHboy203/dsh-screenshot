// dev/postwheel-probe.mjs — 判定"直接给窗口发滚轮消息"到底行不行（R27，backlog ②）。
//
// 用法（**必须在宿主进程里跑**，低完整性 shell 会被 UIPI 丢掉）：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/postwheel-probe.mjs',
//                   args:['-Hwnd','123456','-Delta','-360']})
//
// -Hwnd 必须是**顶层窗口**（`win_windows` / `hitTest` 给的那种），不是子控件：
// R29 起 postwheel.ps1 用 `WindowFromPoint(X,Y)` 自己解析出点位下的叶子控件再投，
// 并核对它的根是不是 -Hwnd ——给一个子控件句柄会被判"点位不在目标窗口上"而拒绝。
// 要复现 R27 的老行为（直接投给 -Hwnd 本身）加 `-Root`。
//
// 它不做任何"验证 UI"的动作：只把一条 WM_MOUSEWHEEL 发给指定窗口，回一行 JSON。
// 真正的对照实验在外面做：client_eval 读 scrollTop → 跑这个 → 再读 scrollTop。
// 要验"某个真实应用认不认"，用 dev/wheel-target-probe.mjs（带地面真值与对照臂）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const shot = await import('file:///' + path.join(PLUGIN, 'lib', 'shot.mjs').replace(/\\/g, '/'))

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
	const i = argv.indexOf(name)
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

let hwnd = Number(arg('-Hwnd', '0')) || 0
const delta = Number(arg('-Delta', '-360')) || -360
const times = Number(arg('-Times', '1')) || 1
const xIn = Number(arg('-X', '0')) || 0
const yIn = Number(arg('-Y', '0')) || 0

let title = ''
if (hwnd <= 0) {
	// 没给句柄就自己找 DSH：exclude:'' 的语义是"连 DSH 自己一起列"。
	const list = await shot.listWindows({ exclude: '', limit: 80 })
	const wins = (list && list.windows) || []
	const hit = wins.find((w) => /DeepSeek Harness/i.test(String(w.title))) || wins.find((w) => /DeepSeek/i.test(String(w.title)))
	if (hit === undefined) {
		console.log(JSON.stringify({ ok: false, error: 'no DSH window', seen: wins.slice(0, 8).map((w) => w.title) }))
		process.exit(1)
	}
	hwnd = hit.hwnd
	title = hit.title
}

const resolve = argv.includes('-Root') ? 'root' : 'leaf'

const res = await shot.run(
	shot.findPwsh(),
	[
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'postwheel.ps1'),
		'-Hwnd', String(hwnd), '-Delta', String(delta), '-Times', String(times), '-X', String(xIn), '-Y', String(yIn),
		'-Resolve', resolve,
	],
	{ timeoutMs: 20_000 }
)
const info = shot.lastJsonLine(res.stdout)
console.log(
	JSON.stringify({
		posted: info,
		title,
		stderr: String(res.stderr || '').slice(0, 300),
		exit: res.code,
	})
)
// 显式退出：不退出的话宿主会一直等到超时（实测 180s），而这件事早就做完了。
process.exit(0)
