// dev/probe-concurrency.mjs — 量"哪些探针能不能并行跑"（R36，backlog 第 2 条）。
//
// 为什么先量再改：`all` 现在串行 5 个探针约 3–5 分钟，看起来"并行就能省一半"。但这几个探针
// 全都在动**真实界面**：有的抢前台（AttachThreadInput）、有的移动真实光标发滚轮、有的在屏幕上
// 建夹具窗口。并行时它们会互相成为对方的"环境"，结果可能是**两边都红**，甚至比串行更慢。
// 所以这里不猜：**同一批次里串行跑一遍、并行跑一遍**，逐条比较 `ok / passed / failed / reason`。
//
// 判据（缺一不可）：
//   ① 每条探针的 ok 与 passed 在两种模式下**一致**；
//   ② 两条都没落到 env / timeout / zero-checks（那说明它被干扰了，而不是"它也通过了"）；
//   ③ 并行确实更快（否则没有理由承担并行的风险）。
//
// 用法（必须在宿主进程里跑）：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-concurrency.mjs'})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-concurrency.mjs', args:['recframe,hide-self']})
//
// 文件名特意不带 `-probe.mjs` 后缀 —— 它不是一条断言式探针，不能被 `all` 自动收进去。
const { runProbe } = await import('../lib/probes.mjs')

const names = String(process.argv[2] ?? 'wheel-app-qt,wheel-app-java')
	.split(',')
	.map((s) => s.trim())
	.filter((s) => s !== '')
if (names.length < 2) {
	console.log('至少给两个探针名，例如 args:["wheel-app-qt,wheel-app-java"]')
	process.exit(1)
}
const show = (r) => `${r.ok ? 'PASS' : 'FAIL'} ${String(r.passed).padStart(3)}P/${String(r.failed).padStart(2)}F ${String(r.seconds).padStart(3)}s reason=${r.reason}`

console.log(`对比 ${names.length} 条：${names.join(' + ')}`)

// ① 并行
const tPar = Date.now()
const par = await Promise.all(names.map((n) => runProbe({ probe: n })))
const parMs = Date.now() - tPar

// ② 串行（同一进程、同一时段，排除"机器忙不忙"这个变量）
const tSer = Date.now()
const ser = []
for (const n of names) ser.push(await runProbe({ probe: n }))
const serMs = Date.now() - tSer

console.log('')
console.log('  探针              串行                                             并行')
let same = true
for (let i = 0; i < names.length; i++) {
	const a = ser[i]
	const b = par[i]
	const ok = a.ok === b.ok && a.passed === b.passed && a.failed === b.failed
	if (!ok) same = false
	console.log(`  ${names[i].padEnd(16)} ${show(a).padEnd(48)} ${show(b)}${ok ? '' : '   ← 不一致'}`)
}
const dirty = par.filter((r) => r.reason === 'env' || r.reason === 'timeout' || r.reason === 'zero-checks')
const faster = parMs < serMs * 0.9
console.log('')
console.log(`耗时：串行 ${Math.round(serMs / 1000)}s · 并行 ${Math.round(parMs / 1000)}s（比值 ${(parMs / serMs).toFixed(2)}）`)
console.log(`判据：结论一致=${same} · 并行里有 env/timeout/zero=${dirty.length} · 并行更快=${faster}`)
const verdict = same && dirty.length === 0 && faster
console.log(verdict ? 'VERDICT: 可以并行（这条组合）' : 'VERDICT: 不能并行（这条组合）—— 保持串行')
process.exit(verdict ? 0 : 1)
