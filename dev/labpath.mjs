// dev/labpath.mjs -- where a probe keeps its scratch files (R66).
//
// WHY THIS FILE EXISTS (public-repo reason, not a style preference)
//   Every probe used to hard-code the author's absolute path:
//       const LAB = path.join('D:\\<author workspace>', '.tmp-shot-lab', 'recframe')
//   Two problems with that once the repository is public:
//     1. it leaks the author's directory layout into every dev file;
//     2. it is simply broken on any machine without that drive -- `mkdirSync(recursive)`
//        throws, and a fresh clone cannot run a single probe.
//
// WHERE IT POINTS
//   Default = <workspace>/.tmp-shot-lab, using the SAME formula as lib/devtools.mjs
//   (workspace = two levels above the plugin), so on the author's machine the paths are
//   exactly what they always were and existing lab folders keep working.
//   Override with DSH_SHOT_LAB=/some/dir when the workspace is read-only.
//
//   This file is deliberately NOT named *-probe.mjs: lib/probes.mjs auto-discovers that
//   naming and would list it as a probe. It also avoids the `dev/_*` scratch prefix,
//   which .gitignore drops.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.dirname(HERE)
/** Workspace root = two levels above the plugin (DSH-Plugin/<x> -> DSH-Plugin -> workspace). */
export const WORKSPACE_ROOT = path.dirname(path.dirname(PLUGIN_ROOT))

export const LAB_ROOT = process.env.DSH_SHOT_LAB
	? path.resolve(process.env.DSH_SHOT_LAB)
	: path.join(WORKSPACE_ROOT, '.tmp-shot-lab')

/** `<lab root>/<name>` — the directory one probe owns. */
export function lab(...parts) {
	return path.join(LAB_ROOT, ...parts)
}
