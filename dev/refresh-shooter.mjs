// dev/refresh-shooter.mjs -- ⚠️ NAME IS HISTORICAL. Read this before using it.
//
// WHAT IT TRIED TO BE: a way to swap the app's resident capture helper for one running the
// current shotcore.ps1, so that changing ps/*.ps1 would not require a DSH restart.
//
// WHY THAT WAS WRONG (R29, measured): host_selfcheck runs the script in a node process that is
// NOT the plugin host. The evidence is the helper's own tag: shooter.mjs names it
// `<process.pid>-<rand>`, and the helpers living under .cache/shooter/ready-*.json carry the
// plugin host's pid (the DSH process) -- not the pid of the self-check process running this.
// So `startShooter()` here spawns a helper owned by THIS process, and it dies with the process:
// the app's helper is untouched. Do not use it to "avoid a restart".
//   ⇒ changing ps/shotcore.ps1 or ps/shooter.ps1 still needs a DSH restart (the helper executes
//     the script once, at start, and never re-reads it).
//
// WHAT IT DOES NOW: answers "which helper is whose", which is the question that trap created.
//   * this process's helper (if it started one) -- tag, pid, ready;
//   * every ready-*.json under the shared shooter dir -- tag, mtime, and whether the owning
//     node process is still alive.
// The tag's pid prefix is the answer: the long-lived one that predates this run is the app's.
//
//   host_selfcheck({plugin:'dsh-screenshot', script:'dev/refresh-shooter.mjs'})
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.dirname(HERE)
const shooter = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'shooter.mjs')).href)

const st = shooter.shooterStatus()
console.log(
	JSON.stringify({
		thisProcess: { pid: process.pid },
		myHelper: { alive: st.alive, ready: st.ready, pid: st.pid, tag: st.tag, dir: st.dir },
	})
)

let tags = []
try {
	tags = fs
		.readdirSync(st.dir)
		.filter((n) => /^ready-.*\.json$/.test(n))
		.sort()
} catch {}

const rows = tags.map((name) => {
	const tag = name.replace(/^ready-/, '').replace(/\.json$/, '')
	const owner = Number(tag.split('-')[0]) || 0
	let alive = false
	try {
		process.kill(owner, 0)
		alive = true
	} catch {}
	let mtimeMs = 0
	try {
		mtimeMs = fs.statSync(path.join(st.dir, name)).mtimeMs
	} catch {}
	return { tag, ownerPid: owner, ownerAlive: alive, readyAt: new Date(mtimeMs).toISOString(), mine: owner === process.pid }
})
rows.sort((a, b) => a.readyAt.localeCompare(b.readyAt))
for (const r of rows) console.log(JSON.stringify(r))

const appOwned = rows.filter((r) => r.ownerAlive && !r.mine)
console.log(
	appOwned.length > 0
		? `the app's helper is tagged ${appOwned[appOwned.length - 1].tag} (owner pid alive) -- this script CANNOT replace it`
		: 'no other live helper found (the app may not have started one yet)'
)
process.exit(0)
