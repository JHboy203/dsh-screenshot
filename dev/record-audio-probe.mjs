// dev/record-audio-probe.mjs -- R41: does recording audio actually work, and does it degrade loudly?
// args: (none)
//
// R41 found that "record with sound" was dead code in BOTH halves: client.js hardcoded `audio:false`
// and lib/shot.mjs hardcoded `-i audio=virtual-audio-capturer` -- a virtual sound card that does not
// exist on this machine. Neither half was ever exercised, so nothing looked broken.
//
// The fix has three promises that only a real recording can check:
//   1. the device table is enumerated for real (dshow), and parsed without losing the Chinese,
//      spaces and parentheses in a device name ("麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)");
//   2. with a mic the file really carries an AAC stream (ffprobe on the output, not our own word);
//   3. WITHOUT a usable mic the recording must STILL succeed, silently, with a warning --
//      "no sound" must never turn into "no video". The bogus-device arm is that contract.
//
// It records three short clips of a 320x240 corner (cheap, and the red frame stays out of view).
// RUN IT FROM THE HOST:
//   shot_probe({probe:'record-audio-probe'})
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/record-audio-probe.mjs'})
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)

// Recording artefacts go to a scratch dir; CACHE_DIR is read at import time, so this must be set first.
const LAB = path.join(os.tmpdir(), 'dshot-audio-probe-' + process.pid)
fs.mkdirSync(LAB, { recursive: true })
process.env.DSH_SHOT_CACHE = LAB

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Console here is GBK: keep every byte ASCII (a stray Chinese char used to mangle whole runs). */
const ascii = (s) => {
	// Objects/arrays go through JSON first -- String({}) would print "[object Object]" and hide
	// exactly the fields this probe exists to show.
	const t = typeof s === 'string' ? s : s instanceof Error ? s.message : JSON.stringify(s)
	return String(t).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

const shot = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shot.mjs')).href)
const { createShotService } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'service.mjs')).href)

class FakeRemote {
	constructor(ctx, name) {
		this.ctx = ctx
		this.name = name
	}
}
const svc = new (createShotService(FakeRemote))(null, {})

const results = []
function check(name, ok, extra) {
	results.push({ name, ok: ok === true })
	console.log(`   ${ok === true ? 'PASS' : 'FAIL'}  ${name}${extra === undefined ? '' : '  ' + extra}`)
}
function skip(name, why) {
	console.log(`   SKIP  ${name}${why === undefined ? '' : '  ' + why}`)
}
const files = []
async function rec(opts) {
	const r = await shot.recordStart(opts)
	if (r.path) files.push(r.path)
	return r
}

/* 1. parse: a real ffmpeg device listing, replayed as text ------------------------
 * The parser must keep the name EXACTLY as ffmpeg prints it: a name that says
 * `麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)` may not come back as `麦克风阵列`
 * (splitting on whitespace) or without the parenthesised suffix -- that string is what
 * `-i audio=<name>` has to be given back verbatim.
 */
const FIXTURE = [
	'[dshow @ 000001e1] "ov9734_techfront_camera" (none)',
	'[dshow @ 000001e1]   Alternative name "@device_pnp_\\\\?\\usb#vid_0408&pid_636a&mi_00#6&2a1f2b3&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
	'[dshow @ 000001e1] "麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)" (audio)',
	'[dshow @ 000001e1]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{4710613D-B15E-4F58-9FCB-99E6EB7577AD}"',
	'[dshow @ 000001e1] "Stereo Mix (Realtek(R) Audio)" (audio)',
	'[dshow @ 000001e1]   Alternative name "@device_cm_{00000000-0000-0000-0000-000000000000}\\wave_{11111111-2222-3333-4444-555555555555}"',
].join('\r\n')
const parsed = shot.parseDshowDevices(FIXTURE)
check('parse: 3 devices (one "(none)" video + two audio)', parsed.length === 3, ascii(parsed.map((d) => d.kind)))
check(
	'parse: parenthesised/Chinese name kept verbatim',
	parsed[1] !== undefined && parsed[1].name === '麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)' && parsed[1].kind === 'audio',
	parsed[1] === undefined ? 'missing' : ascii(parsed[1].name)
)
check('parse: "(none)" is a video device, not "no device"', parsed[0] !== undefined && parsed[0].kind === 'video', parsed[0] === undefined ? 'missing' : parsed[0].kind)
check(
	'parse: Alternative name attaches to the device above it',
	parsed[2] !== undefined && parsed[2].alt.startsWith('@device_cm_'),
	parsed[2] === undefined ? 'missing' : ascii(parsed[2].alt.slice(0, 24))
)

/* 2. resolve: which device do we open? ------------------------------------------- */
const auto = shot.resolveAudioDevice(parsed, '')
check('resolve(auto): prefers a microphone over Stereo Mix', auto.device !== null && auto.device.name.startsWith('麦克风阵列'), auto.device === null ? 'null' : ascii(auto.device.name))

// R42：自动挑必须**与系统列出的顺序无关**。旧写法只看"第一块命中大正则的"，于是把两块设备的
// 先后换一下结论就变。这三条把档位钉死：麦克风 > 系统音（中/英名都算）> 第一块。
const reversed = shot.resolveAudioDevice(
	[
		{ name: 'Stereo Mix (Realtek(R) Audio)', alt: '', kind: 'audio' },
		{ name: '麦克风阵列 (适用于数字麦克风的英特尔® 智音技术)', alt: '', kind: 'audio' },
	],
	''
)
check('resolve(auto): order-independent (Stereo Mix listed first, mic still wins)', reversed.device !== null && reversed.device.name.startsWith('麦克风阵列'), reversed.device === null ? 'null' : ascii(reversed.device.name))

const onlySystem = shot.resolveAudioDevice(
	[
		{ name: '线路输入 (Line In)', alt: '', kind: 'audio' },
		{ name: '立体声混音 (Realtek(R) Audio)', alt: '', kind: 'audio' },
	],
	''
)
check('resolve(auto): with no mic, system audio (Chinese "立体声混音") is preferred over line-in', onlySystem.device !== null && onlySystem.device.name.startsWith('立体声混音'), onlySystem.device === null ? 'null' : ascii(onlySystem.device.name))

const onlyLineIn = shot.resolveAudioDevice([{ name: '线路输入 (Line In)', alt: '', kind: 'audio' }], '')
check('resolve(auto): neither tier matches -> first audio device (never fails)', onlyLineIn.device !== null && onlyLineIn.device.name.startsWith('线路输入'), onlyLineIn.device === null ? 'null' : ascii(onlyLineIn.device.name))

const exact = shot.resolveAudioDevice(parsed, 'Stereo Mix (Realtek(R) Audio)')
check('resolve(exact name): picks that device', exact.device !== null && exact.device.name === 'Stereo Mix (Realtek(R) Audio)', exact.device === null ? 'null' : ascii(exact.device.name))

const byAlt = shot.resolveAudioDevice(parsed, parsed[2].alt)
check('resolve(ascii alternative name): still resolves', byAlt.device !== null && byAlt.device.name === 'Stereo Mix (Realtek(R) Audio)', byAlt.device === null ? 'null' : ascii(byAlt.device.name))

const bogus = shot.resolveAudioDevice(parsed, 'No Such Mic 0000')
check(
	'resolve(unknown name): no device + a warning that names it (never a silent fallback)',
	bogus.device === null && bogus.warning.includes('No Such Mic 0000'),
	ascii(bogus.warning)
)

const empty = shot.resolveAudioDevice([], '')
check('resolve(no devices): null + "no recording device" warning', empty.device === null && empty.warning.length > 0, ascii(empty.warning))

/* 3. real enumeration (ffmpeg dshow) --------------------------------------------- */
const devs = await shot.listCaptureDevices({ refresh: true })
const mics = devs.devices.filter((d) => d.kind === 'audio')
console.log(`   INFO  devices: ${devs.devices.length} (audio: ${mics.length})` + (mics.length > 0 ? ' first=' + ascii(mics[0].name) : ''))
check('enum: dshow listing parsed into >= 1 device', devs.devices.length > 0, ascii(devs.error))
const hasMic = mics.length > 0
if (!hasMic) skip('real microphone arms', 'this machine reports no audio device')

/* 4. silent recording (control arm) ----------------------------------------------
 * Without this arm, "hasAudio === true" below could just mean our reporter always says true.
 */
const REGION = '0,0,320,240'
const silentStart = await rec({ fps: 10, region: REGION, audio: false })
check('start(silent): ok, audio:false, no warning', silentStart.ok === true && silentStart.audio === false && silentStart.audioWarning === '', ascii({ ok: silentStart.ok, audio: silentStart.audio, w: silentStart.audioWarning }))
await sleep(1400)
const silentStop = await shot.recordStop()
check('stop(silent): file has video, and hasAudio:false (probe says true only if a stream exists)', silentStop.ok === true && silentStop.bytes > 0 && silentStop.hasAudio === false, ascii({ ok: silentStop.ok, bytes: silentStop.bytes, hasAudio: silentStop.hasAudio, err: silentStop.error }))
if (silentStop.ok !== true) console.log('   INFO  ffmpeg stderr: ' + ascii(String(silentStop.error).slice(0, 200)))

/* 5. recording WITH sound: the file must really carry an audio stream ------------- */
if (hasMic) {
	const withStart = await rec({ fps: 10, region: REGION, audio: true })
	check('start(audio): ok, audio:true, names the device, no warning', withStart.ok === true && withStart.audio === true && withStart.mic !== '' && withStart.audioWarning === '', ascii({ ok: withStart.ok, audio: withStart.audio, mic: withStart.mic !== '' ? '<device>' : '', w: withStart.audioWarning, err: withStart.error }))
	await sleep(1800)
	const withStop = await shot.recordStop()
	check('stop(audio): ffprobe finds an audio stream (hasAudio:true, audioDropped:false)', withStop.ok === true && withStop.hasAudio === true && withStop.audioDropped === false && withStop.bytes > 0, ascii({ ok: withStop.ok, hasAudio: withStop.hasAudio, dropped: withStop.audioDropped, bytes: withStop.bytes, err: withStop.error }))
	const info = await shot.recAction('info', { file: String(withStop.path || '') }, 30_000)
	check('info(audio): reports acodec "aac"', info.ok === true && info.audio === true && info.acodec === 'aac', ascii({ ok: info.ok, audio: info.audio, acodec: info.acodec }))
}

/* 6. THE contract: a bad mic must not kill the recording -------------------------
 * This is the arm that would have caught the original bug in the opposite direction:
 * it is not enough to open the device -- an unavailable device must degrade to silent
 * video, with a warning, instead of failing the capture outright.
 */
const bogusStart = await rec({ fps: 10, region: REGION, audio: true, mic: 'No Such Mic 0000' })
check(
	'start(bad mic): recording still starts, audio:false, warning explains it',
	bogusStart.ok === true && bogusStart.audio === false && String(bogusStart.audioWarning).includes('No Such Mic 0000'),
	ascii({ ok: bogusStart.ok, audio: bogusStart.audio, w: bogusStart.audioWarning, err: bogusStart.error })
)
if (bogusStart.ok === true) {
	await sleep(1200)
	const bogusStop = await shot.recordStop()
	check('stop(bad mic): silent file is still valid video', bogusStop.ok === true && bogusStop.bytes > 0 && bogusStop.hasAudio === false, ascii({ ok: bogusStop.ok, bytes: bogusStop.bytes, hasAudio: bogusStop.hasAudio }))
} else {
	check('stop(bad mic): not reached (start failed)', false)
}

/* 7. the service half forwards every audio field (schema completeness) -----------
 * A field that shot.mjs returns but service.mjs forgets is invisible to the client:
 * that is exactly how `audio` was lost in R32's region echo.
 */
const svcDevs = await svc.record('devices', '')
check(
	'service.record(devices): ok + devices[] + no undefined fields',
	svcDevs.ok === true && Array.isArray(svcDevs.devices) && svcDevs.devices.every((d) => typeof d.name === 'string' && d.name !== ''),
	ascii({ ok: svcDevs.ok, n: Array.isArray(svcDevs.devices) ? svcDevs.devices.length : 'not-array' })
)
const svcStopShape = await svc.record('status', '')
check(
	'service shape: audio/mic/audioWarning/hasAudio/audioDropped all present on every reply',
	['audio', 'mic', 'audioWarning', 'hasAudio', 'audioDropped'].every((k) => Object.prototype.hasOwnProperty.call(svcStopShape, k)) &&
		Object.values(svcStopShape).every((v) => v !== undefined),
	ascii(Object.keys(svcStopShape).filter((k) => k === 'audio' || k === 'hasAudio' || k === 'audioDropped'))
)

/* cleanup: three temp clips, and the red frame must be gone ---------------------- */
for (const f of files) {
	try {
		fs.rmSync(f, { force: true })
	} catch {}
}
check('cleanup: no recording left running', shot.isRecording() === false)
try {
	fs.rmSync(LAB, { recursive: true, force: true })
} catch {}

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`record-audio: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
