/**
 * ⚠️ 这个文件已经**不是**真源了，别再改它。
 *
 * 覆盖层代码的唯一定义在 `../client.js` 里（段标记 `const DSHOT_CSS = ` 到
 * `/* ══════════════ 偏好 ══════════════ *\/` 之前）。
 *
 * 为什么搬进去了：官方客户端模块只服务**声明过的 chunk**
 * （dsh-client-modules/lib/index.js 的 chunkRequest：`CLIENT_CHUNK.test(fileName)`
 * 且 URL 必须带当前 rev），`/plugins/<id>/ui/overlay.js` 这种任意路径取不到；
 * 官方插件（dsh-voice-local）同样是 build 期内联。本机 DSH 的文件沙箱还禁止子进程
 * 写插件目录（node 覆写 = EPERM），所以连"构建脚本内联"这条路也没有，只能一次写进 client.js。
 *
 * 怎么继续在浏览器里真点真画地验：dev/harness.html 会 fetch ../client.js，
 * 把那段抠出来 `new Function(...)` —— 验的就是真正装进 DSH 的那份代码。
 */

export const OVERLAY_SOURCE_OF_TRUTH = 'DSH-Plugin/dsh-screenshot/client.js'
