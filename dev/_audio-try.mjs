// SCRATCH (R41 exploration): can ffmpeg capture the microphone by Chinese name and by ASCII alt name?
// Sandbox note: no pipes (EPERM), so child stdio goes to files.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, statSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const FF = 'C:\\Users\\26592\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
const PROBE = 'C:\\Users\\26592\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe'
const dir = mkdtempSync(path.join(tmpdir(), 'dshot-audio-'))
console.log('tmp:', dir, 'ffprobe exists:', existsSync(PROBE))

function run(exe, args, tag) {
	const outF = path.join(dir, tag + '.out.txt')
	const errF = path.join(dir, tag + '.err.txt')
	const ofd = openSync(outF, 'w')
	const efd = openSync(errF, 'w')
	const r = spawnSync(exe, args, { stdio: ['ignore', ofd, efd], windowsHide: true })
	closeSync(ofd)
	closeSync(efd)
	return { code: r.status, out: readFileSync(outF, 'utf8'), err: readFileSync(errF, 'utf8') }
}

const list = run(FF, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 'list')
const devs = []
for (const line of list.err.split(/\r?\n/)) {
	const k = /\]\s+"(.+?)"\s+\((audio|video|none)\)/.exec(line)
	if (k) {
		devs.push({ name: k[1], kind: k[2] === 'none' ? 'video' : k[2] })
		continue
	}
	const alt = /Alternative name "(.+?)"/.exec(line)
	if (alt && devs.length > 0) devs[devs.length - 1].alt = alt[1]
}
console.log('devices:', JSON.stringify(devs, null, 1))

const mic = devs.find((d) => d.kind === 'audio' && /麦克风|microphone|stereo mix|立体声/i.test(d.name)) ?? devs.find((d) => d.kind === 'audio')

const cases = []
if (mic) {
	cases.push(['cn', mic.name])
	if (mic.alt) cases.push(['alt', mic.alt])
}
for (const [tag, name] of cases) {
	const out = path.join(dir, 'a-' + tag + '.m4a')
	const r = run(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=' + name, '-t', '2', '-c:a', 'aac', '-b:a', '128k', '-y', out], 'rec-' + tag)
	const bytes = existsSync(out) ? statSync(out).size : 0
	let probe = ''
	if (bytes > 0) {
		const p = run(PROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', out], 'probe-' + tag)
		probe = p.out.slice(0, 240).replace(/\s+/g, ' ')
	}
	console.log(`AUDIO-ONLY [${tag}] code=${r.code} bytes=${bytes} err=${r.err.trim().slice(0, 200)}`)
	console.log(`           probe=${probe}`)
}

if (mic) {
	const out = path.join(dir, 'av.mp4')
	const r = run(
		FF,
		[
			'-hide_banner', '-loglevel', 'error',
			'-f', 'gdigrab', '-framerate', '15',
			'-offset_x', '0', '-offset_y', '0', '-video_size', '320x240', '-i', 'desktop',
			'-f', 'dshow', '-i', 'audio=' + mic.name,
			'-map', '0:v:0', '-map', '1:a:0',
			'-t', '2',
			'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
			'-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out,
		],
		'av'
	)
	const bytes = existsSync(out) ? statSync(out).size : 0
	const p = bytes > 0 ? run(PROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', out], 'probe-av') : { out: '' }
	let streams = []
	try {
		streams = JSON.parse(p.out).streams.map((s) => s.codec_type + ':' + (s.codec_name || ''))
	} catch {}
	console.log(`A+V code=${r.code} bytes=${bytes} streams=${JSON.stringify(streams)} err=${r.err.trim().slice(0, 300)}`)
}

const bad = run(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=No Such Mic', '-t', '1', '-y', path.join(dir, 'bad.m4a')], 'bad')
console.log('BOGUS code=' + bad.code + ' err=' + bad.err.trim().slice(0, 200))
console.log('DIR=' + dir)
