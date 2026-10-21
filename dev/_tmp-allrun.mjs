// dev/_tmp-allrun.mjs — 路径转发。真正的内容在 dev/all-probes-hostrun.mjs。
//
// 为什么这个文件还在：本轮它本来是**临时脚本**，做完想删，但 DSH 的文件沙箱**不允许命令行删除**
// （`rm` / `Remove-Item` / [IO.File]::Delete 全是 Access denied），而当时除了它没有别的删除通道。
// 所以把内容搬到正式名字下，这里只留一行转发 —— 既不会跑两遍不同的逻辑，也不会让"临时"文件消失得无影无踪。
await import('./all-probes-hostrun.mjs')
