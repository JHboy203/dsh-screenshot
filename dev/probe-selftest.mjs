// dev/probe-selftest.mjs -- 验证 R34 新增的两块"固定下来的能力"：lib/pixels.mjs 与 lib/probes.mjs。
//
// 为什么要自检工具本身：这两个库是**换会话时的交接面**（下一个会话靠它们判绿），
// 而它们的失败方式很安静 —— 解码器读错一行 → 颜色统计全 0，探针超时 → 报"0 PASS / 0 FAIL"
// 看起来像"什么都没跑"。所以：
//   * 用一个**已知答案**的 PNG（我们把一张图写死成 4x4 色块）验像素统计与差异比对；
//   * 用一次 1 秒超时的真 spawn 验"超时必须算失败"；
//   * 用不存在的探针名验明确报错。
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
const { PROBES, countChecks, runProbe } = await import('../lib/probes.mjs')

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
check('探针表里有 6 个（hosttest / recframe / wheel-target / hide-self / wheel-app-qt / wheel-app-java）', Object.keys(PROBES).length === 6, Object.keys(PROBES).join(','))
const parsed = countChecks('PASS  甲\nFAIL  乙\n  PASS  丙\n随便一行\n')
check('countChecks 只认行首 PASS/FAIL', parsed.passed === 2 && parsed.failed === 1 && parsed.failures[0] === '乙', JSON.stringify(parsed))

const unknown = await runProbe({ probe: '不是探针' })
check('未知探针明确报错（不静默成功）', unknown.ok === false && /未知探针/.test(unknown.text), unknown.text.slice(0, 60))

// 超时语义：拿真探针 + 1 秒上限。**超时必须算失败**，否则"什么都没跑"会被读成绿的。
const short = await runProbe({ probe: 'hide-self', timeoutSec: 1 })
check('超时被如实判成失败（不算通过）', short.ok === false && short.timedOut === true, `ok=${short.ok} timedOut=${short.timedOut} exit=${short.exitCode} text=${short.text.split('\n')[1]}`)

const fails = results.filter((r) => !r.ok).length
console.log(`\n${results.length - fails} PASS / ${fails} FAIL  (lab: ${LAB})`)
process.exit(fails > 0 ? 1 : 0)
