// dev/auto-wheel-probe.mjs — 验 auto 的滚轮策略判定（R27）。
// args: 靶子矩形 "x,y,w,h"（例如 560,140,660,500；**必填**，无参跑没有意义）
//
// 用法（宿主进程里跑）：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/auto-wheel-probe.mjs',
//                   args:['560,140,660,500']})
//
// 靶子必须是**只会因为滚轮而滚动**的窗口（testbed_refwin：selfScroll=0），否则"画面变了"
// 可能来自别的原因，策略判定就没意义。
//
// 它只做一件事：开一个 auto 会话、跑到 done/cancel，把 wheelMode 与帧数报出来。
//   wheelMode='post'   → 这个窗口认投递滚轮（用户鼠标全程没动）
//   wheelMode='cursor' → 不认，已降级成移光标（R25 的行为）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const LAB = 'D:\\信息库\\AI工作区\\.tmp-shot-lab\\host'
process.env.DSH_SHOT_CACHE = path.join(LAB, 'cache')
process.env.DSH_SHOT_DIR = path.join(LAB, 'shots')
process.env.DSH_OVERLAY_DIR = path.join(LAB, 'overlay')

const scroll = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'scrollsession.mjs')).href)
const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)

fs.mkdirSync(shot.CACHE_DIR, { recursive: true })
fs.mkdirSync(shot.SHOTS_DIR, { recursive: true })

const rect = process.argv[2] || '560,140,660,500'
const mode = process.argv[3] === 'manual' ? 'manual' : 'auto'

const cursorBefore = await shot.run(shot.findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'wheel.ps1'), '-GetPos'], { timeoutMs: 10_000 }).then((r) => shot.lastJsonLine(r.stdout))

const begin = await scroll.scrollBegin(rect, { mode, maxFrames: 4, settleMs: 500 })
const started = Date.now()
let st = begin
const plan = []
while (Date.now() - started < 40_000) {
	await new Promise((r) => setTimeout(r, 700))
	st = await scroll.scrollStatus()
	plan.push(`t=${Math.round((Date.now() - started) / 1000)}s frames=${st.frames} wheelMode=${st.wheelMode} rejects=${st.wheelPostRejects} paused="${st.paused}" done=${st.done}`)
	if (st.done === true) break
}
const end = await scroll.scrollEnd()
const cursorAfter = await shot.run(shot.findPwsh(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLUGIN, 'ps', 'wheel.ps1'), '-GetPos'], { timeoutMs: 10_000 }).then((r) => shot.lastJsonLine(r.stdout))

console.log(JSON.stringify({
	begin: { ok: begin.ok, target: begin.target, targetTitle: begin.targetTitle },
	wheelMode: st.wheelMode,
	postRejects: st.wheelPostRejects,
	frames: st.frames,
	stopReason: st.stopReason,
	cursorMoved: cursorBefore && cursorAfter ? (Math.abs(cursorAfter.x - cursorBefore.x) + Math.abs(cursorAfter.y - cursorBefore.y)) : null,
	cursor: { before: cursorBefore, after: cursorAfter },
	end: { ok: end.ok, frames: end.frames, w: end.width, h: end.height, path: end.path, error: end.error },
	plan,
}))
// 显式退出：会话结束后还可能挂着子进程句柄 / 定时器，不退出的话宿主要等 3 分钟超时才知道跑完了。
process.exit(0)
