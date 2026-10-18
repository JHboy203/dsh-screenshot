// typert.host.mjs — 手写 Typert HOST 清单（package.json 的 exports './typert'，
// typert-loader 在插件挂载时自动注册；形态对齐 dsh-session-org / dsh-checkpoint-rewind）。
//
// 服务名 = Remote 命名空间 'shot'，实现在 lib/service.mjs 的 ShotService。

import { SHOT_INVOCATIONS } from './lib/wire.mjs'

/** Host Typert manifest（typert-loader 校验）。 */
export const TYPERT = Object.freeze({
	package: 'dsh-screenshot',
	face: 'host',
	schemas: Object.freeze([]),
	invocations: SHOT_INVOCATIONS,
	model: Object.freeze({
		services: Object.freeze([]),
		events: Object.freeze([]),
		objects: Object.freeze([]),
	}),
})
