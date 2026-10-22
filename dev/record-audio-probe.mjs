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
// R44: the host must say which device the AUTO tier picks -- the client used to report devices[0],
// which is list order, not the choice (R42 made the choice "mic > system audio > first").
const expectAuto = shot.resolveAudioDevice(svcDevs.devices ?? [], '')
check(
	'service.record(devices): auto names the SAME device resolveAudioDevice picks (not devices[0])',
	svcDevs.auto === (expectAuto.device === null ? '' : expectAuto.device.name) && svcDevs.autoReason === expectAuto.reason,
	ascii({ auto: svcDevs.auto !== '' ? '<device>' : '', reason: svcDevs.autoReason, expect: expectAuto.reason })
)
const svcStopShape = await svc.record('status', '')
check(
	'service shape: audio/mic/audioWarning/hasAudio/audioDropped all present on every reply',
	['audio', 'mic', 'audioWarning', 'hasAudio', 'audioDropped'].every((k) => Object.prototype.hasOwnProperty.call(svcStopShape, k)) &&
		Object.values(svcStopShape).every((v) => v !== undefined),
	ascii(Object.keys(svcStopShape).filter((k) => k === 'audio' || k === 'hasAudio' || k === 'audioDropped'))
)

/* 8. region type guard (R43): a wrong-typed region must FAIL, never fall back to full screen
 * Live evidence (R43): record('start', {region:{x,y,w,h}}) used to come back ok:true / region:''
 * and produce a 1920x1080 desktop clip -- "ask for a 64x64 corner, record everything".
 */
const badRegion = await svc.record('start', JSON.stringify({ fps: 15, region: { x: 0, y: 0, w: 64, h: 64 } }))
check(
	'service.record(start): object region -> ok:false with a "字符串" error',
	badRegion.ok === false && /字符串/.test(String(badRegion.error)) && badRegion.recording !== true,
	ascii({ ok: badRegion.ok, err: badRegion.error })
)
const leaked = shot.isRecording()
if (leaked === true) {
	try {
		await shot.recordStop({})
	} catch {}
}
check('service.record(start): and it did NOT start recording (no silent full-screen)', leaked === false, ascii({ recording: leaked }))
// Second gate: shot.recordStart must reject it too, or "[object Object]" reaches ffmpeg as "region too small".
const directBad = await shot.recordStart({ region: [0, 0, 64, 64] })
check(
	'shot.recordStart: array region -> ok:false (second gate, not a misleading "too small")',
	directBad.ok === false && /字符串/.test(String(directBad.error)) && shot.isRecording() === false,
	ascii({ ok: directBad.ok, err: directBad.error })
)
// The same judge guards `rect` (cap / ocr). Recording was the loud one; these two were quieter
// (a silent "" means "the whole screen", so an OCR read or a capture silently widens).
const badCap = await svc.cap('desktop', false, 'screen', 0, { x: 0, y: 0, w: 64, h: 64 })
check('service.cap: object rect -> ok:false with a "字符串" error (no silent full-screen shot)', badCap.ok === false && /字符串/.test(String(badCap.error)), ascii({ ok: badCap.ok, err: badCap.error }))
const badOcr = await svc.ocr('no-such-shot', [0, 0, 64, 64], 3, 'auto', 'none')
check('service.ocr: array rect -> ok:false with a "字符串" error (before "shot not found")', badOcr.ok === false && /字符串/.test(String(badOcr.error)), ascii({ ok: badOcr.ok, err: badOcr.error }))

/* 9. concurrent start must SERIALIZE (R47) --------------------------------------
 * Why this arm exists: `recordStart` used to check "already recording" FIRST, then await
 * device enumeration and a 600 ms liveness sleep before assigning `recording`. Two starts
 * inside that window both passed the check and each spawned ffmpeg; the loser's child was
 * never recorded anywhere, so `recordStop` could not stop it -- it kept gdigrab-ing forever
 * (measured before the fix: two mp4 files, 2823 B stopped, 48 B still growing).
 *
 * The contract after the fix: the second call WAITS for the first, then answers
 * `already:true` with the same path -- and exactly ONE new file appears in the scratch dir.
 * (Merging both calls into one would silently swallow the second caller's fps/region/audio,
 * which is the other thing this project forbids.)
 */
const countMp4 = () => {
	try {
		return fs.readdirSync(path.join(LAB, 'rec')).filter((n) => n.endsWith('.mp4')).length
	} catch {
		return 0
	}
}
const beforeRace = countMp4()
const [raceA, raceB] = await Promise.all([
	shot.recordStart({ fps: 10, region: REGION, audio: false }),
	shot.recordStart({ fps: 10, region: REGION, audio: false }),
])
if (raceA.path) files.push(raceA.path)
if (raceB.path && raceB.path !== raceA.path) files.push(raceB.path)
check(
	'concurrent start: second call gets already:true and the SAME path',
	raceA.ok === true && raceB.ok === true && raceB.already === true && raceB.path === raceA.path && raceA.path !== '',
	ascii({ a: { ok: raceA.ok, already: raceA.already === true }, b: { ok: raceB.ok, already: raceB.already === true, same: raceB.path === raceA.path } })
)
await sleep(1200)
const raceStop = await shot.recordStop()
await sleep(400)
const afterRace = countMp4()
check(
	'concurrent start: exactly ONE new mp4 (no orphan recorder left writing)',
	afterRace - beforeRace === 1 && raceStop.ok === true && raceStop.bytes > 0 && shot.isRecording() === false,
	ascii({ added: afterRace - beforeRace, stopOk: raceStop.ok, bytes: raceStop.bytes })
)

/* 10. the SERVICE must expose "this was already recording" (R48) ------------------
 * R47 serializes concurrent starts inside shot.mjs, but service.mjs is a **whitelist**:
 * a field it does not copy is invisible to every caller above it. Live evidence from the
 * running host (R47 re-check): two concurrent record('start') replies both had
 * `already: undefined`, i.e. "two ok + one path" -- indistinguishable from two starts.
 * The second start here is sequential (the first is still recording) = the same branch.
 */
const svcStart1 = await svc.record('start', JSON.stringify({ fps: 10, region: REGION, audio: false }))
const svcStart2 = await svc.record('start', JSON.stringify({ fps: 10, region: REGION, audio: false }))
if (svcStart1.path) files.push(svcStart1.path)
check(
	'service.record(start): second call -> already:true + SAME path (not a second clip)',
	svcStart1.ok === true && svcStart2.ok === true && svcStart2.already === true && svcStart2.path === svcStart1.path && svcStart2.path !== '',
	ascii({ a: { ok: svcStart1.ok, already: svcStart1.already === true }, b: { ok: svcStart2.ok, already: svcStart2.already === true, same: svcStart2.path === svcStart1.path } })
)
const svcStop2 = await svc.record('stop', '')
check('service.record(stop): that one clip is real (bytes > 0)', svcStop2.ok === true && svcStop2.bytes > 0, ascii({ ok: svcStop2.ok, bytes: svcStop2.bytes }))

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
