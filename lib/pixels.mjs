// lib/pixels.mjs — PNG 解码 + "一块图像事实"（像素探针，R34）
//
// 为什么把它做成库/工具，而不是留在 dev/ 的探针里：
//   这一轮（R32/R33）反复被同一类问题绊住 —— **几何断言看不见的那一半**。
//     * 录屏框"画了没有"：窗口几何、`Visible=true`、`-Info` 全对，屏幕上却一个像素都没有；
//     * "内部有没有被盖住"：只有逐像素比对能回答；
//     * "抽帧成功却 0 字节"：`imgtool.ps1 stats` 的 meanLuma/blackPct 一读就定案。
//   以前每次都现写一段 PNG 解码（dev/png.mjs 就是这么来的），换个会话就重写一遍。
//   现在收进库里，`shot_pixels` 工具直接用它。
//
// 依赖：Node 自带 zlib，零第三方。
// 只支持 8 位、非隔行的 truecolour（含/不含 alpha）—— 这正是 System.Drawing 存屏的格式。

import fs from 'node:fs'
import zlib from 'node:zlib'

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * 读一张 PNG。
 * @param {string} file
 * @returns {{width:number,height:number,data:Uint8Array,at:(x:number,y:number)=>[number,number,number,number]}}
 */
export function readPng(file) {
	const buf = fs.readFileSync(file)
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG：${file}`)
	let pos = 8
	let width = 0
	let height = 0
	let depth = 0
	let colorType = 0
	let interlace = 0
	const idat = []
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos)
		const type = buf.toString('ascii', pos + 4, pos + 8)
		const data = buf.subarray(pos + 8, pos + 8 + len)
		if (type === 'IHDR') {
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			depth = data[8]
			colorType = data[9]
			interlace = data[12]
		} else if (type === 'IDAT') {
			idat.push(data)
		} else if (type === 'IEND') {
			break
		}
		pos += 12 + len
	}
	if (depth !== 8) throw new Error(`不支持的位深 ${depth}（只支持 8）`)
	if (interlace !== 0) throw new Error('不支持隔行扫描 PNG')
	const ch = CHANNELS[colorType]
	if (ch === undefined) throw new Error(`不支持的颜色类型 ${colorType}`)

	const raw = zlib.inflateSync(Buffer.concat(idat))
	const stride = width * ch
	const out = new Uint8Array(width * height * 4)
	let prev = new Uint8Array(stride)
	let off = 0
	for (let y = 0; y < height; y++) {
		const filter = raw[off++]
		const line = raw.subarray(off, off + stride)
		off += stride
		const cur = new Uint8Array(stride)
		for (let i = 0; i < stride; i++) {
			const a = i >= ch ? cur[i - ch] : 0
			const b = prev[i]
			const c = i >= ch ? prev[i - ch] : 0
			let v = line[i]
			if (filter === 1) v += a
			else if (filter === 2) v += b
			else if (filter === 3) v += (a + b) >> 1
			else if (filter === 4) {
				const p = a + b - c
				const pa = Math.abs(p - a)
				const pb = Math.abs(p - b)
				const pc = Math.abs(p - c)
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
			} else if (filter !== 0) throw new Error(`坏的扫描行过滤器 ${filter}`)
			cur[i] = v & 0xff
		}
		for (let x = 0; x < width; x++) {
			const s = x * ch
			const d = (y * width + x) * 4
			if (ch >= 3) {
				out[d] = cur[s]
				out[d + 1] = cur[s + 1]
				out[d + 2] = cur[s + 2]
				out[d + 3] = ch === 4 ? cur[s + 3] : 255
			} else {
				out[d] = out[d + 1] = out[d + 2] = cur[s]
				out[d + 3] = ch === 2 ? cur[s + 1] : 255
			}
		}
		prev = cur
	}
	const at = (x, y) => {
		const d = (y * width + x) * 4
		return [out[d], out[d + 1], out[d + 2], out[d + 3]]
	}
	return { width, height, data: out, at }
}

/**
 * 解析颜色："#eb4034" / "eb4034" / "235,64,52" / "rgb(235,64,52)"。
 * @returns {[number,number,number]|null}
 */
export function parseColor(text) {
	const s = String(text ?? '').trim()
	if (s === '') return null
	const hex = /^#?([0-9a-f]{6})$/i.exec(s)
	if (hex !== null) {
		const v = parseInt(hex[1], 16)
		return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
	}
	const nums = /(-?\d{1,3})\D+(-?\d{1,3})\D+(-?\d{1,3})/.exec(s)
	if (nums !== null) {
		const rgb = [Number(nums[1]), Number(nums[2]), Number(nums[3])]
		if (rgb.every((n) => n >= 0 && n <= 255)) return rgb
	}
	return null
}

const inRect = (x, y, r) => r === null || (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h)

/**
 * 一块区域内的颜色统计 + 外接框。
 * @param {object} img readPng 的返回值
 * @param {[number,number,number]} rgb
 * @param {{tol?:number, region?:{x:number,y:number,w:number,h:number}}} [opts]
 */
export function colorFacts(img, rgb, opts = {}) {
	const tol = Number.isFinite(opts.tol) ? Math.max(0, opts.tol) : 24
	const region = opts.region ?? null
	let count = 0
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -1
	let y1 = -1
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (!inRect(x, y, region)) continue
			const c = img.at(x, y)
			if (Math.abs(c[0] - rgb[0]) > tol || Math.abs(c[1] - rgb[1]) > tol || Math.abs(c[2] - rgb[2]) > tol) continue
			count++
			if (x < x0) x0 = x
			if (y < y0) y0 = y
			if (x > x1) x1 = x
			if (y > y1) y1 = y
		}
	}
	return {
		count,
		bbox: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
	}
}

/** 两张同尺寸图在给定区域内的**不一致像素占比**（0..1）。 */
export function diffRatio(a, b, opts = {}) {
	const tol = Number.isFinite(opts.tol) ? Math.max(0, opts.tol) : 10
	const region = opts.region ?? { x: 0, y: 0, w: Math.min(a.width, b.width), h: Math.min(a.height, b.height) }
	if (a.width !== b.width || a.height !== b.height) return 1
	let diff = 0
	let total = 0
	for (let y = region.y; y < region.y + region.h; y++) {
		for (let x = region.x; x < region.x + region.w; x++) {
			total++
			const p = a.at(x, y)
			const q = b.at(x, y)
			if (Math.abs(p[0] - q[0]) > tol || Math.abs(p[1] - q[1]) > tol || Math.abs(p[2] - q[2]) > tol) diff++
		}
	}
	return total === 0 ? 0 : diff / total
}

/** 平均亮度（0..255）。 */
export function meanLuma(img, region = null) {
	let sum = 0
	let n = 0
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (!inRect(x, y, region)) continue
			const c = img.at(x, y)
			sum += 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
			n++
		}
	}
	return n === 0 ? 0 : sum / n
}
