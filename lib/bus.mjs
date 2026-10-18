/**
 * lib/bus.mjs — 宿主 ↔ 客户端之间的**唯一一块共享状态**。
 *
 * 存在的理由：Remote 服务只有 client→host 这一个方向。宿主这边无论是全局热键响了、
 * 还是 AI 通过工具要了一张截图，都没法主动推给界面。所以宿主把"待办"放在这里，
 * 客户端的心跳（`shot.poll()`）每次来取一件走。
 *
 * 两条队列刻意分开：
 *   invoke  —— 「请打开截图覆盖层」。人按了热键才会产生，**只由用户动作触发**。
 *             绝不因为 AI 调用而产生：AI 拿图不能把用户的屏幕糊上一层遮罩。
 *   deliver —— 「把这张图安静地贴进输入框并复制」。AI 调用产生，界面在后台做完，
 *             不抢焦点、不弹窗。
 *
 * 时间戳不是装饰：一条 20 秒前的 deliver 如果还没被取走，说明客户端那半边当时不在，
 * 再送过去只会变成一张莫名其妙的附件。所以取件时按 TTL 丢弃。
 */

/** deliver 的最长存活时间。超过就当那条心跳链路当时是断的。 */
const DELIVER_TTL_MS = 20_000
/** invoke 的最长存活时间（热键按下后界面最多隔这么久才来取）。 */
const INVOKE_TTL_MS = 15_000

const state = {
	invoke: '',
	invokeAt: 0,
	invokeSeq: 0,
	deliver: null,
	deliverAt: 0,
	deliverSeq: 0,
	/** 诊断：最近一次热键动作与最近一次 AI 投递，给 status()/界面看。 */
	lastInvoke: '',
	lastDeliver: '',
}

/**
 * 热键（或界面上的按钮）要求打开覆盖层。
 * @param {string} action 'shot' | 'ocr' | 'translate' | 'scroll' | 'record' | 'stop'
 */
export function fireInvoke(action) {
	const act = typeof action === 'string' && action.length > 0 ? action : 'shot'
	state.invoke = act
	state.invokeAt = Date.now()
	state.invokeSeq += 1
	state.lastInvoke = act + '@' + new Date().toISOString()
	return state.invokeSeq
}

/**
 * 排一张图给界面，让它安静地贴进输入框。
 * @param {{id: string, name: string, dataUrl: string, note?: string}} item
 */
export function queueDeliver(item) {
	if (item === null || typeof item !== 'object') return 0
	state.deliver = {
		id: String(item.id ?? ''),
		name: String(item.name ?? 'screenshot.png'),
		dataUrl: String(item.dataUrl ?? ''),
		note: String(item.note ?? ''),
	}
	state.deliverAt = Date.now()
	state.deliverSeq += 1
	state.lastDeliver = state.deliver.id + '@' + new Date().toISOString()
	return state.deliverSeq
}

/**
 * 客户端心跳取件。**取走即清空** —— 同一张图贴两次比不贴更糟。
 * @param {number} since 客户端上次看到的 seq（诊断用，不参与取件判定）
 */
export function takePending(since) {
	const now = Date.now()
	let invoke = ''
	if (state.invoke !== '' && now - state.invokeAt <= INVOKE_TTL_MS) invoke = state.invoke
	state.invoke = ''

	let deliver = null
	if (state.deliver !== null && now - state.deliverAt <= DELIVER_TTL_MS) deliver = state.deliver
	state.deliver = null

	return {
		invoke: invoke,
		deliver: deliver,
		seq: Math.max(state.invokeSeq, state.deliverSeq),
		since: Number.isFinite(since) ? since : 0,
	}
}

/** 只读快照（status() 与界面诊断用）。 */
export function busStatus() {
	return {
		invokeSeq: state.invokeSeq,
		deliverSeq: state.deliverSeq,
		lastInvoke: state.lastInvoke,
		lastDeliver: state.lastDeliver,
		pendingInvoke: state.invoke,
		pendingDeliver: state.deliver === null ? '' : state.deliver.id,
	}
}

/** 测试用：清空两条队列。 */
export function resetBus() {
	state.invoke = ''
	state.invokeAt = 0
	state.deliver = null
	state.deliverAt = 0
}
