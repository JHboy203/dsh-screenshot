// dev/gate-full-hostrun.mjs — 在**宿主进程里**跑一遍交付闸门 `shot_gate({full:true})`（R37）。
//
// 为什么需要它（和 `all-probes-hostrun.mjs` 同一个理由）：`shot_gate` 是**宿主半边**，
// 工具表是宿主启动期读的。改完 `lib/devtools.mjs` / `tools.js` 之后、重启 DSH 之前，
// 运行中的宿主跑的还是旧实现 —— 这时想验"新的 full 语义对不对"，只有两条路：
//   ① 重启再验（把"未验证的代码"直接推上线，不给退路）；
//   ② 用这个脚本在宿主里直接调 `gateRun`（**当前磁盘上的代码**）。
//
// 它会把 full 的**实际计划**先打出来，再跑，最后给结论表 —— 判据与工具调用完全一致。
//
// 用法：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/gate-full-hostrun.mjs'})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/gate-full-hostrun.mjs', args:['tick']})   # 只跑一拍
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/gate-full-hostrun.mjs', args:['full','host']})
//
// 文件名不带 `-probe.mjs` —— 它不是断言式探针，不该被 `all` 自动收进去。
const { gatePlan, gateRun } = await import('../lib/devtools.mjs')

// 参数：逗号/空格分隔的开关名（full / tick / probes / host / smoke / overlay）。
// 不给参数 = full（这个脚本存在的意义就是那条最常用的命令）。
const argv = process.argv.slice(2).join(',').split(/[,\s]+/).map((s) => s.trim()).filter((s) => s !== '')
const opts = argv.length === 0 ? { full: true } : {}
for (const a of argv) {
	// 支持 `smoke=off` 这种写法（其余开关一律视为 true）。
	const [k, v] = a.split('=')
	if (k === undefined || k === '') continue
	opts[k] = v === undefined ? true : !/^(0|false|no|off)$/i.test(v)
}
const plan = gatePlan(opts)
console.log('plan: ' + JSON.stringify(plan))
const res = await gateRun(opts)
console.log(res.text)
console.log('')
console.log(`结论：${res.ok ? '全绿' : `${res.failed}/${res.passed + res.failed} 项没过（先看上面的 detail）`}`)
process.exit(res.ok === true ? 0 : 1)
