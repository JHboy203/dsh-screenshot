// dev/png.mjs -- minimal PNG decoder for PROBES (no dependencies, Node's zlib only).
//
// Why this exists: several of this plugin's acceptance criteria are PIXELS ("the frame must be
// outside the captured rect", "the interior must not be blacked out", "the capture is not a black
// frame"). Geometry assertions cannot see any of that. .tools/png-columns.cjs decodes PNGs too,
// but it is a CLI with no exports, so probes cannot reuse it.
//
// Scope on purpose: 8-bit truecolour with or without alpha, non-interlaced. That is exactly what
// System.Drawing writes for a screen capture, which is the only producer we need.
import fs from 'node:fs'
import zlib from 'node:zlib'

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * @param {string} file
 * @returns {{width:number,height:number,data:Uint8Array,at:(x:number,y:number)=>[number,number,number,number]}}
 */
export function readPng(file) {
	const buf = fs.readFileSync(file)
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${file}`)
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
	if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`)
	if (interlace !== 0) throw new Error('interlaced PNG is not supported')
	const ch = CHANNELS[colorType]
	if (ch === undefined) throw new Error(`unsupported colour type ${colorType}`)

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
				// Paeth
				const p = a + b - c
				const pa = Math.abs(p - a)
				const pb = Math.abs(p - b)
				const pc = Math.abs(p - c)
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
			} else if (filter !== 0) throw new Error(`bad filter ${filter}`)
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
