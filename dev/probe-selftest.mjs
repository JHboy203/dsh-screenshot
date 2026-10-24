// dev/probe-selftest.mjs -- 验证 R34/R35 新增的"固定下来的能力"：lib/pixels.mjs 与 lib/probes.mjs。
//
// 为什么要自检工具本身：这两个库是**换会话时的交接面**（下一个会话靠它们判绿），
// 而它们的失败方式很安静 —— 解码器读错一行 → 颜色统计全 0，探针超时 → 报"0 PASS / 0 FAIL"
// 看起来像"什么都没跑"。所以：
//   * 用一个**已知答案**的 PNG（我们把一张图写死成 4x4 色块）验像素统计与差异比对；
//   * 用一次 1 秒超时的真 spawn 验"超时必须算失败"；
//   * 用不存在的探针名验明确报错；
//   * R35 补的两条（自动发现 / 全跑聚合）**一律用临时目录 + 注入的 runner 验**，
//     不动 dev/、不 spawn、不碰屏幕 —— 否则自检本身就成了"要跑 10 分钟还会开窗"的东西。
//
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/probe-selftest.mjs'})
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const results = []
function check(item, ok, detail) {
	results.push({ item, ok: ok === true })
	console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${item}  ${detail}`)
}

const { colorFacts, diffRatio, meanLuma, parseColor, readPng } = await import('../lib/pixels.mjs')
const { discoverProbes, formatProbeFailures, listProbes, PLUGIN_ROOT, PROBES, countChecks, reasonOf, runProbe, runProbes } = await import('../lib/probes.mjs')

/* ─────────────────── 造一张已知答案的 PNG ─────────────────── */
// 4x4，左两列纯红 (235,64,52)，右两列纯蓝 (0,0,255)。手写 PNG：IHDR + IDAT(filter 0) + IEND。
function makePng(file) {
	const w = 4
	const h = 4
	const rows = []
	for (let y = 0; y < h; y++) {
		const row = [0]
		for (let x = 0; x < w; x++) {
			if (x < 2) row.push(235, 64, 52, 255)
			else row.push(0, 0, 255, 255)
		}
		rows.push(Buffer.from(row))
	}
	const raw = Buffer.concat(rows)
	const idat = zlib.deflateSync(raw)
	const chunk = (type, data) => {
		const len = Buffer.alloc(4)
		len.writeUInt32BE(data.length, 0)
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(crc32(body) >>> 0, 0)
		return Buffer.concat([len, body, crc])
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8
	ihdr[9] = 6
	fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]))
}
let crcTable = null
function crc32(buf) {
	if (crcTable === null) {
		crcTable = []
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			crcTable[n] = c >>> 0
		}
	}
	let c = 0xffffffff
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

const LAB = path.join(os.tmpdir(), 'dsh-shot-probe-selftest')
fs.mkdirSync(LAB, { recursive: true })
const pngA = path.join(LAB, 'a.png')
const pngB = path.join(LAB, 'b.png')
makePng(pngA)
makePng(pngB)

/* ─────────────────── lib/pixels.mjs ─────────────────── */
const img = readPng(pngA)
check('readPng 解出 4x4', img.width === 4 && img.height === 4, `${img.width}x${img.height}`)
const red = colorFacts(img, [235, 64, 52], { tol: 8 })
check('颜色统计：红色 8 个像素、外接框 2x4', red.count === 8 && red.bbox.w === 2 && red.bbox.h === 4, `${red.count} px ${JSON.stringify(red.bbox)}`)
const blueRegion = colorFacts(img, [0, 0, 255], { tol: 8, region: { x: 0, y: 0, w: 2, h: 4 } })
check('region 生效：左半区找不到蓝色', blueRegion.count === 0, `${blueRegion.count} px`)
const missing = colorFacts(img, [1, 2, 3], { tol: 4 })
check('找不到的颜色给 0 个像素 + 空 bbox', missing.count === 0 && missing.bbox === null, JSON.stringify(missing))
check('自比差异为 0', diffRatio(img, readPng(pngB)) === 0, String(diffRatio(img, readPng(pngB))))
check('parseColor 认 #hex / r,g,b / rgb()', JSON.stringify(parseColor('#eb4034')) === '[235,64,52]' && JSON.stringify(parseColor('235,64,52')) === '[235,64,52]' && JSON.stringify(parseColor('rgb(0, 0, 255)')) === '[0,0,255]', '')
const luma = meanLuma(img)
const want = (0.299 * 235 + 0.587 * 64 + 0.114 * 52 + 0.114 * 255) / 2
check('meanLuma 与手算一致（±0.5）', Math.abs(luma - want) < 0.5, `${luma.toFixed(2)} vs ${want.toFixed(2)}`)

/* ─────────────────── lib/probes.mjs ─────────────────── */
// 显式探针表是**契约**：增删条目都要在这里改一行，别让"少了一个探针"静默通过。
// R41 加 record-audio（录屏录音）。断言比"数量相等"更强一点：名字集合逐项对上。
const wantProbes = ['hosttest', 'recframe', 'record-audio', 'wheel-target', 'hide-self', 'wheel-app-qt', 'wheel-app-java']
const gotProbes = Object.keys(PROBES)
const missingProbes = wantProbes.filter((n) => !gotProbes.includes(n))
const extraProbes = gotProbes.filter((n) => !wantProbes.includes(n))
check(
	'探针表里有 7 个（hosttest / recframe / record-audio / wheel-target / hide-self / wheel-app-qt / wheel-app-java）',
	missingProbes.length === 0 && extraProbes.length === 0,
	gotProbes.join(','),
)
const parsed = countChecks('PASS  甲\nFAIL  乙\n  PASS  丙\n随便一行\n')
check('countChecks 只认行首 PASS/FAIL', parsed.passed === 2 && parsed.failed === 1 && parsed.failures[0] === '乙', JSON.stringify(parsed))

const unknown = await runProbe({ probe: '不是探针' })
check('未知探针明确报错（不静默成功）', unknown.ok === false && /未知探针/.test(unknown.text), unknown.text.slice(0, 60))

// 超时语义：拿真探针 + 1 秒上限。**超时必须算失败**，否则"什么都没跑"会被读成绿的。
// ⚠️ 这一条**必须在宿主进程里跑**（host_selfcheck / shot_probe）。在工具沙箱里 spawn 会 EPERM，
//    那时这条会红 —— 红的是环境，不是产品。所以下面单独把 EPERM 翻译成人话。
const short = await runProbe({ probe: 'hide-self', timeoutSec: 1 })
const envBlocked = short.reason === 'error' && /EPERM/.test(String(short.text))
if (envBlocked) console.log('   ENVIRONMENT: 现在这个进程**不许 spawn 子进程**（spawn EPERM）——是工具沙箱，不是探针坏了。请用 host_selfcheck({plugin:"dsh-screenshot",script:"dev/probe-selftest.mjs"}) 或 shot_probe 在宿主里跑这一项。')
check('超时被如实判成失败（不算通过）', short.ok === false && short.timedOut === true, `ok=${short.ok} timedOut=${short.timedOut} exit=${short.exitCode} reason=${short.reason} ${String(short.text).split('\n')[1] ?? ''}`)

/* ─────────────────── R35：清单自动发现 ─────────────────── */
// 用临时目录造"新探针"，验「写文件即出现」这条约定 —— 不动 dev/（否则自检会污染真实清单）。
const AUTODIR = path.join(LAB, 'dev')
fs.rmSync(AUTODIR, { recursive: true, force: true })
fs.mkdirSync(AUTODIR, { recursive: true })
fs.writeFileSync(path.join(AUTODIR, 'alpha-probe.mjs'), '// alpha-probe.mjs -- 验证甲：自动发现的说明来自首行注释\nconsole.log("PASS x")\n')
fs.writeFileSync(
	path.join(AUTODIR, 'beta-probe.mjs'),
	'// beta-probe.mjs -- 验证乙\n// args: -Hwnd <句柄>（必填）\nconsole.log("PASS y")\n'
)
fs.writeFileSync(path.join(AUTODIR, 'helper.mjs'), '// 不是探针，文件名不匹配约定\n')
// 模拟"同一个脚本被显式表占着"（wheel-app-probe.mjs 服务 qt/java 两条探针）。
fs.writeFileSync(path.join(AUTODIR, 'wheel-app-probe.mjs'), '// 已被显式表覆盖的脚本\n')

const disc = discoverProbes({ dir: AUTODIR })
check(
	'自动发现：只收 *-probe.mjs，按名排序（alpha / beta）',
	disc.found.length === 2 && disc.found[0].id === 'alpha' && disc.found[1].id === 'beta',
	disc.found.map((f) => f.id).join(',')
)
check('自动发现的说明取自首行注释（并剥掉文件名前缀）', disc.found[0].about === '验证甲：自动发现的说明来自首行注释', disc.found[0].about)
check(
	'**同一个脚本已被显式表覆盖时不再自动登记**（否则 all 会把它跑两遍）',
	disc.found.every((f) => !/wheel-app/.test(f.script)) && disc.skipped.some((s) => s.file === 'wheel-app-probe.mjs'),
	JSON.stringify(disc.skipped)
)
const alpha = disc.found.find((f) => f.id === 'alpha')
check(
	'自动发现的条目带 auto 标记，且 script **解析得到真实文件**',
	disc.found.every((f) => f.auto === true) && alpha !== undefined && path.resolve(PLUGIN_ROOT, alpha.script) === path.resolve(AUTODIR, 'alpha-probe.mjs'),
	alpha?.script
)
// R36：`// args:` 头 → 清单里能说清"这条要什么参数"（R35 的自动发现只是让它出现，说不出怎么跑）。
const beta = disc.found.find((f) => f.id === 'beta')
check(
	'头部 `// args:` 被解析成 needsArgs + 人话提示（没说的一律 needsArgs:false）',
	beta !== undefined && beta.needsArgs === true && /-Hwnd/.test(beta.argsHint) && alpha?.needsArgs === false,
	`beta=${JSON.stringify(beta?.argsHint)} alpha.needsArgs=${alpha?.needsArgs}`
)
check(
	'显式表里带固定参数的探针也带 needsArgs（从 args 或 argsHint 推出来）',
	listProbes()
		.filter((e) => e.name === 'wheel-app-qt' || e.name === 'wheel-app-java')
		.every((e) => e.needsArgs === true && e.argsHint !== ''),
	''
)

const merged = listProbes({ dir: AUTODIR })
const mergedNames = merged.map((e) => e.name)
check(
	'合并清单：6 条显式 + 2 条自动，且**没有重名**',
	merged.filter((e) => e.auto === false).length === Object.keys(PROBES).length && merged.filter((e) => e.auto === true).length === 2 && new Set(mergedNames).size === mergedNames.length,
	`${merged.filter((e) => !e.auto).length} 显式 + ${merged.filter((e) => e.auto).length} 自动 = ${mergedNames.length}`
)
check('合并清单：显式在前、自动在后', merged[merged.length - 1].auto === true && merged[0].auto === false, mergedNames.join(','))

/* ─────────────────── R35：全跑聚合（注入 runner，不 spawn） ─────────────────── */
const FAKE = [
	{ name: 'good', script: 'dev/good-probe.mjs', args: [], timeoutSec: 10, about: '甲', heavy: false, auto: false, needs: '' },
	{ name: 'slow', script: 'dev/slow-probe.mjs', args: [], timeoutSec: 10, about: '乙', heavy: false, auto: false, needs: '' },
	{ name: 'late', script: 'dev/late-probe.mjs', args: [], timeoutSec: 10, about: '丁', heavy: false, auto: false, needs: '' },
	{ name: 'heavy', script: 'dev/heavy-probe.mjs', args: [], timeoutSec: 10, about: '丙', heavy: true, auto: false, needs: '' },
]
const seen = []
const fakeRunner = async (req) => {
	seen.push(req.probe)
	if (req.probe === 'slow') return { ok: false, passed: 2, failed: 0, exitCode: null, timedOut: true, failures: [], reason: 'timeout', seconds: 10, text: 'slow 超时' }
	if (req.probe === 'heavy') return { ok: false, passed: 0, failed: 3, exitCode: 1, timedOut: false, failures: ['丁'], reason: 'failed', seconds: 3, text: 'heavy 失败' }
	return { ok: true, passed: 5, failed: 0, exitCode: 0, timedOut: false, failures: [], reason: 'ok', seconds: 1, text: 'good 全绿' }
}

const agg = await runProbes({ probes: 'all', entries: FAKE, runner: fakeRunner })
check(
	'聚合：默认**不含重活**（重活进 skipped 并写明原因）',
	agg.probes.length === 3 && agg.skipped.some((s) => s.name === 'heavy' && /重活/.test(s.why)),
	`跑了 ${agg.probes.map((p) => p.probe).join(',')} · skipped=${agg.skipped.map((s) => s.name).join(',')}`
)
check('聚合：有探针失败时整体 ok=false，且如实报出是哪个、为什么', agg.ok === false && /slow\(timeout\)/.test(String(agg.error)), String(agg.error))
check('聚合：PASS/FAIL 是各探针**断言数**的合计（失败的探针记在 probes[].ok）', agg.passed === 12 && agg.failed === 0, `${agg.passed} PASS / ${agg.failed} FAIL`)
check('聚合：文本里每个探针一行，失败那行带原因', /PASS\s+good/.test(agg.text) && /FAIL\s+slow/.test(agg.text) && /timeout/.test(agg.text), agg.text.split('\n')[1]?.trim())

const withHeavy = await runProbes({ probes: 'all', entries: FAKE, runner: fakeRunner, includeHeavy: true })
check(
	'聚合：includeHeavy 时重活被跑，而且**排在最后**（不会先卡 10 分钟）',
	seen[seen.length - 1] === 'heavy' && withHeavy.probes.length === 4,
	seen.join(' → ')
)
check('聚合：includeHeavy 下整体仍然 ok=false（重活那条真失败）', withHeavy.ok === false, `ok=${withHeavy.ok} err=${String(withHeavy.error).slice(0, 60)}`)

// R35 实测出来的边界：`dev/` 里被自动发现的两个探针（auto-wheel / postwheel）**都要命令行参数**，
// 无参跑只会有无意义结果 —— 所以"被发现"不等于"能进 all"。
const FAKE2 = [...FAKE, { name: 'auto1', script: 'dev/auto1-probe.mjs', args: [], timeoutSec: 10, about: '自动', heavy: false, auto: true, needs: '', argsHint: '-Hwnd <句柄>（必填）', needsArgs: true }]
const noAuto = await runProbes({ probes: 'all', entries: FAKE2, runner: fakeRunner })
check(
	'聚合：自动发现的**默认不进 all**（不知道要什么参数），但在 skipped 里说明原因',
	noAuto.probes.length === 3 && noAuto.skipped.some((s) => s.name === 'auto1' && /参数/.test(s.why)),
	`跑了 ${noAuto.probes.map((p) => p.probe).join(',')} · skipped=${noAuto.skipped.map((s) => s.name).join(',')}`
)
check(
	'skipped 的原因里带**具体要什么参数**（不是一句"见头注释"）',
	noAuto.skipped.some((s) => s.name === 'auto1' && /-Hwnd/.test(s.why)),
	noAuto.skipped.find((s) => s.name === 'auto1')?.why ?? ''
)
const yesAuto = await runProbes({ probes: 'all', entries: FAKE2, runner: fakeRunner, includeAuto: true })
check('聚合：includeAuto:true 时自动发现的才进 all', yesAuto.probes.length === 4 && yesAuto.probes.some((p) => p.probe === 'auto1'), `跑了 ${yesAuto.probes.map((p) => p.probe).join(',')}`)
const namedAuto = await runProbes({ probes: ['auto1'], entries: FAKE2, runner: fakeRunner })
check('聚合：**点名**跑自动发现的探针不受默认限制', namedAuto.probes.length === 1 && namedAuto.probes[0].probe === 'auto1', namedAuto.probes.map((p) => p.probe).join(','))

const failedTail = await runProbes({ probes: ['slow'], entries: FAKE, runner: async () => ({ ok: false, passed: 1, failed: 1, exitCode: 1, timedOut: false, failures: ['x'], reason: 'failed', seconds: 2, tail: ['target: hwnd=1', 'leaf at centre: nope'], stderr: ['boom'], text: 'x' }) })
check(
	'聚合：失败那条带**诊断尾巴**（判"环境还是产品"靠它），通过的不带',
	failedTail.probes[0].tail.includes('target: hwnd=1') && /诊断尾巴/.test(failedTail.text) && /boom/.test(failedTail.text),
	failedTail.text.split('\n').slice(-3).join(' | ')
)

seen.length = 0
const firstFail = await runProbes({ probes: 'all', entries: FAKE, runner: fakeRunner, stopOnFail: true })
check(
	'聚合：stopOnFail 时第一条失败就停，后面没跑的进 skipped（省时间但不静默）',
	firstFail.probes.length === 2 && seen.length === 2 && firstFail.skipped.some((s) => /stopOnFail/.test(s.why)),
	`跑了 ${seen.join(',')} · skipped=${firstFail.skipped.map((s) => s.name).join(',')}`
)
check('零检查算失败（退出码 0 但一行 PASS/FAIL 都没打印）', reasonOf({ ok: false, passed: 0, failed: 0, exitCode: 0, timedOut: false }) === 'zero-checks', reasonOf({ ok: false, passed: 0, failed: 0, exitCode: 0 }))
check(
	'退出码 2 归成 env（环境挡住）—— 与产品回归 failed 分开',
	reasonOf({ ok: false, passed: 1, failed: 4, exitCode: 2, timedOut: false }) === 'env' && reasonOf({ ok: false, passed: 1, failed: 4, exitCode: 1 }) === 'failed',
	`exit2=${reasonOf({ ok: false, passed: 1, failed: 4, exitCode: 2 })} exit1=${reasonOf({ ok: false, passed: 1, failed: 4, exitCode: 1 })}`
)
const envAgg = await runProbes({
	probes: ['envprobe'],
	entries: [{ name: 'envprobe', script: 'dev/env-probe.mjs', args: [], timeoutSec: 10, about: '环境', heavy: false, auto: false, needs: '' }],
	runner: async () => ({ ok: false, passed: 1, failed: 4, exitCode: 2, timedOut: false, failures: [], reason: 'env', seconds: 5, tail: ['ENVIRONMENT: covered'], text: 'env' }),
})
check(
	'聚合：env 那行**单独标 ENV**，并给出"挪开窗口再跑"的处置（别照着它改代码）',
	envAgg.ok === false && /ENV\s+envprobe/.test(envAgg.text) && /因环境没判成/.test(envAgg.text),
	envAgg.text.split('\n').slice(1, 3).join(' | ')
)
check('reasonOf 对通过的结果给 ok（否则聚合会把绿读成红）', reasonOf({ ok: true, passed: 3, failed: 0, exitCode: 0 }) === 'ok', reasonOf({ ok: true, passed: 3, failed: 0, exitCode: 0 }))
/* ── R45：env 只重试一次，真红永不重试 ── */
{
	const one = [{ name: 'flaky', script: 'dev/flaky-probe.mjs', args: [], timeoutSec: 10, about: '环境抖动', heavy: false, auto: false, needs: '' }]
	let calls = 0
	const retried = await runProbes({
		probes: 'all',
		entries: one,
		runner: async () => {
			calls++
			if (calls === 1) return { ok: false, passed: 1, failed: 1, exitCode: 2, timedOut: false, failures: ['covered'], reason: 'env', seconds: 5, tail: ['ENVIRONMENT: covered'], text: 'env' }
			return { ok: true, passed: 6, failed: 0, exitCode: 0, timedOut: false, failures: [], reason: 'ok', seconds: 6, text: 'fine' }
		},
	})
	check(
		'聚合：env 自动重试一次，第二次通过就记 PASS（并如实标"重试后通过"）',
		retried.ok === true && calls === 2 && retried.probes[0].attempts === 2 && /env 重试后通过/.test(retried.text),
		`calls=${calls} · ok=${retried.ok} · ${String(retried.text).split('\n')[1] ?? ''}`
	)
	let calls2 = 0
	const stillEnv = await runProbes({
		probes: 'all',
		entries: one,
		runner: async () => {
			calls2++
			return { ok: false, passed: 1, failed: 1, exitCode: 2, timedOut: false, failures: ['covered'], reason: 'env', seconds: 5, tail: [], text: 'env' }
		},
	})
	check(
		'聚合：两次都 env 就**保持 env**（不骗成红，也不骗成绿），并说明重试过',
		stillEnv.ok === false && calls2 === 2 && stillEnv.probes[0].reason === 'env' && /env 重试后仍 env/.test(stillEnv.text),
		`calls=${calls2} · reason=${stillEnv.probes[0].reason}`
	)
	let calls3 = 0
	const realRed = await runProbes({
		probes: 'all',
		entries: one,
		runner: async () => {
			calls3++
			return { ok: false, passed: 1, failed: 4, exitCode: 1, timedOut: false, failures: ['真回归'], reason: 'failed', seconds: 5, tail: [], text: 'red' }
		},
	})
	check('聚合：真红（exit 1）**不许重试** —— 重试会把回归藏起来', realRed.ok === false && calls3 === 1 && realRed.probes[0].reason === 'failed', `calls=${calls3} · reason=${realRed.probes[0].reason}`)
	let calls4 = 0
	await runProbes({
		probes: ['flaky'],
		entries: one,
		runner: async () => {
			calls4++
			return { ok: false, passed: 1, failed: 1, exitCode: 2, timedOut: false, failures: [], reason: 'env', seconds: 5, tail: [], text: 'env' }
		},
	})
	check('单跑（点名）不重试 —— operator 要看的是这一次的真实结果', calls4 === 1, `calls=${calls4}`)
}
const badName = await runProbes({ probes: ['good', '没有这个'], entries: FAKE, runner: fakeRunner })
check('聚合：点名的探针不存在时明确报错（不静默跳过）', badName.ok === false && /未知探针/.test(String(badName.text)) && /没有这个/.test(String(badName.text)), String(badName.text).slice(0, 60))

/* ── R55：聚合红的时候必须说清"红在哪一条" ──
 * 2026-10-24 一天里两次"聚合红、单跑绿"：`shot_gate` 只报 `15P/1F`，想知道红的是哪一条，
 * 只能去 lab 目录把图逐像素复算。runProbe 其实早就算好了 failures，只是聚合侧没人用。
 */
{
	const allGreen = formatProbeFailures([{ probe: 'a', ok: true }, { probe: 'b', ok: true }])
	check('formatProbeFailures：全绿时返回空串（不往 detail 里塞噪音）', allGreen === '', JSON.stringify(allGreen))
	const red = formatProbeFailures([
		{ probe: 'recframe', ok: false, reason: 'failed', failures: ['border is drawn OUTSIDE the captured rect  {"top":0}'], tail: ['PASS x', 'FAIL border'] },
	])
	check(
		'formatProbeFailures：贴出失败那条的**断言名与细节**（不是只给计数）',
		/✗ recframe/.test(red) && /border is drawn OUTSIDE/.test(red) && /\{"top":0\}/.test(red),
		String(red.split('\n')[1] ?? '').trim()
	)
	const envOnly = formatProbeFailures([{ probe: 'wheel-target', ok: false, reason: 'env', failures: [], tail: ['ENVIRONMENT: covered', 'PASS a'] }])
	check(
		'formatProbeFailures：env 单独标出来（它不是产品回归，处置方式不同）',
		/✗ wheel-target（env/.test(envOnly) && /ENVIRONMENT: covered/.test(envOnly),
		String(envOnly.split('\n')[1] ?? '').trim()
	)
}

const fails = results.filter((r) => !r.ok).length
console.log(`\n${results.length - fails} PASS / ${fails} FAIL  (lab: ${LAB})`)
process.exit(fails > 0 ? 1 : 0)
