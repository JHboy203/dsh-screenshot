// dev/preflight-selftest.mjs — `shot_preflight` / `shot_land` 的确定性自检（R40）。
//
// 为什么单独一个：这两个工具**重启前就得能验**（它们存在的意义就是"重启前的验证与收尾"），
// 而工具表是宿主启动期读的 —— 所以自检必须在宿主进程里、用磁盘上的代码直接调库函数。
//
// 覆盖的都是"骗人"的那类判据：
//   ① 结论行解析（脚本输出长什么样 → 算不算过），包括**零检查**、没有结论行；
//   ② `land` 的默认 dryRun **绝不**提交；空标题必须拒绝；
//   ③ `gitState` 能读到分支/HEAD/脏文件（收尾计划靠它）。
//
// 用法：
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/preflight-selftest.mjs'})
const path = await import('node:path')
const { fileURLToPath } = await import('node:url')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'lib')
const { verdictOf, preflightRun, PREFLIGHTS } = await import(new URL('../lib/preflight.mjs', import.meta.url).href)
const { land, gitState, gitRun } = await import(new URL('../lib/land.mjs', import.meta.url).href)

let pass = 0
let fail = 0
function check(name, ok, detail) {
	if (ok) {
		pass++
		console.log('PASS ' + name + (detail === undefined ? '' : '  ' + String(detail).slice(0, 160)))
	} else {
		fail++
		console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + String(detail).slice(0, 160)))
	}
}

/* ── ① verdictOf：每个预检项的结论行长什么样 ── */
const GP = verdictOf('gate-full', 'plan: {}\n闸门：4/4 通过\n  PASS  静态契约\n  PASS  探针聚合\n', 0)
check('gate-full：4/4 → 过', GP.ok === true && GP.detail.indexOf('4/4') !== -1, GP.detail)
const GPF = verdictOf('gate-full', '闸门：3/4 通过\nFAIL  探针聚合 shot_probe all  132s  5 个探针 · 38 PASS / 1 FAIL\n', 1)
check('gate-full：3/4 → 不过，且把 FAIL 行带进 detail', GPF.ok === false && /探针聚合/.test(GPF.detail), GPF.detail)
check('gate-full：没有结论行 → 不过（不能"没输出就算过"）', verdictOf('gate-full', 'hello', 0).ok === false)
const PS = verdictOf('probe-selftest', 'PASS a\nPASS b\n36 PASS / 0 FAIL\n', 0)
check('probe-selftest：0 FAIL → 过', PS.ok === true && PS.detail === '36 PASS / 0 FAIL', PS.detail)
check('probe-selftest：**零检查**（0 PASS / 0 FAIL）→ 不过', verdictOf('probe-selftest', '0 PASS / 0 FAIL', 0).ok === false)
const AP = verdictOf('all-probes', 'ok=true probes=5 passed=39 failed=0\n', 0)
check('all-probes：ok=true 且 probes>0 → 过', AP.ok === true && AP.detail === '5 个探针 · 39 PASS / 0 FAIL', AP.detail)
check('all-probes：ok=false → 不过', verdictOf('all-probes', 'ok=false probes=5 passed=38 failed=1', 1).ok === false)
check('hosttest：全部 N 项通过 → 过', verdictOf('hosttest', '全部 77 项通过', 0).ok === true)
check('hosttest：有"项失败" → 不过', verdictOf('hosttest', '3 项失败', 1).ok === false)

/* ── ② 预检项都在磁盘上（别等到真跑才发现脚本改名了） ── */
for (const [name, def] of Object.entries(PREFLIGHTS)) {
	const fs = await import('node:fs')
	const p = path.join(HERE, '..', def.script)
	check('预检项 ' + name + ' 指向的脚本存在：' + def.script, fs.existsSync(p), p)
}

/* ── ③ land：默认 dryRun 绝不提交；空标题必须拒绝 ── */
const before = gitRun(['rev-parse', '--short', 'HEAD']).stdout.trim()
const empty = await land({ message: '   ', dryRun: true })
check('land：空标题 → 拒绝（并说清为什么）', empty.ok === false && /标题/.test(empty.error), empty.error)
const plan = await land({ message: '（自检用，不会真的提交）', dryRun: true, runChecks: true })
check('land：dryRun 出计划且自检全绿', plan.ok === true && plan.dryRun === true && plan.checks.length === 2 && plan.checks.every((c) => c.ok === true), plan.text.split('\n').slice(0, 4).join(' | '))
check('land：dryRun **没有**改变 HEAD（绝不偷偷提交）', gitRun(['rev-parse', '--short', 'HEAD']).stdout.trim() === before, before + ' → ' + gitRun(['rev-parse', '--short', 'HEAD']).stdout.trim())
check('land：dryRun 报 committed/pushed 都是 false', plan.committed === false && plan.pushed === false)

/* ── ④ gitState：收尾计划靠它 ── */
const st = gitState()
check('gitState：读到分支 / HEAD / 脏文件列表', st.ok === true && st.branch !== '' && /^[0-9a-f]{7,}$/.test(st.head) && Array.isArray(st.dirty), st.branch + '@' + st.head + ' dirty=' + (st.dirty || []).length)
check('gitState：inSync 是布尔（与远端是否一致）', typeof st.inSync === 'boolean', String(st.inSync))

/* ── ⑤ preflightRun：跑一条最快的，验证"子进程 + 结论解析"这条路真的通 ── */
const fast = await preflightRun({ what: 'probe-selftest' })
check('preflightRun(probe-selftest)：真跑一遍并给出结论', fast.ok === true && fast.items.length === 1 && fast.items[0].name === 'probe-selftest', fast.text.split('\n')[0] + ' · ' + (fast.items[0] || {}).detail)
const bogus = await preflightRun({ what: '没有这个' })
check('preflightRun：点名不存在的预检项时明确报错（不静默跳过）', bogus.ok === false && /未知预检项/.test(bogus.text), bogus.text.slice(0, 80))

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
