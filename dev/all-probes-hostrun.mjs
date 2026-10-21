// dev/all-probes-hostrun.mjs — 在**宿主进程里**用真 runner 跑一遍探针聚合（R35）。
//
// 为什么需要它（工具已经能跑 `shot_probe({probe:'all'})` 了）：
//   工具表是**宿主启动期**读的。改完 `lib/probes.mjs` 之后、重启 DSH 之前，运行中的宿主跑的还是
//   旧实现 —— 这时 `shot_probe({probe:'all'})` 要么不存在、要么还是"一次一个"的老行为。
//   这个脚本用**当前磁盘上的代码**起一个宿主侧 node 进程跑聚合，所以能在重启前就验到新逻辑。
//
// 用法：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/all-probes-hostrun.mjs'})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/all-probes-hostrun.mjs', args:['recframe,wheel-target']})
//
// 判据**不是"必须全绿"**，而是"聚合本身形状正确"：跑到了应跑的条数、每条都有 reason、
// 失败必带诊断尾巴、文本可读。夹具有没有被挡住属于环境，脚本会把 env 照样报出来但不判失败
// （`ok` 仍然是 false —— 不算通过，只是不把它读成产品回归）。
const { listProbes, runProbes } = await import('../lib/probes.mjs')

const wanted = String(process.argv[2] ?? '').trim()
const entries = listProbes()
console.log('清单 ' + entries.length + ' 条：' + entries.map((e) => e.name + (e.heavy ? '[重活]' : '') + (e.auto ? '[自动]' : '')).join(' '))

const agg = await runProbes({
	probes: wanted === '' ? 'all' : wanted.split(',').map((s) => s.trim()),
	includeHeavy: /hosttest/.test(wanted),
})
console.log('--- 聚合（真 runner）---\n' + agg.text)
console.log(`ok=${agg.ok} probes=${agg.probes.length} passed=${agg.passed} failed=${agg.failed} total=${agg.totalMs}ms`)

const expected = wanted === '' ? entries.filter((e) => e.heavy !== true && e.auto !== true).length : wanted.split(',').length
const shapeOk =
	agg.probes.length === expected &&
	agg.probes.every((p) => typeof p.reason === 'string' && p.reason !== '') &&
	agg.probes.every((p) => (p.ok === true ? p.tail.length === 0 : p.tail.length > 0 || p.reason === 'timeout')) &&
	/^\s+(PASS|FAIL|ENV)/m.test(agg.text)
console.log(shapeOk ? 'SHAPE OK' : 'SHAPE MISMATCH')
if (!shapeOk) process.exit(1)
// env 不算产品失败：shape 对就退 0，让调用方去读每一行的 reason。
