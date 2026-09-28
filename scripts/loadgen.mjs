#!/usr/bin/env node
// 可控背景负载生成器：给 bench.mjs 制造"满负载"工况
//
// 用法：
//   node scripts/loadgen.mjs 12 &     # 12 个忙循环（8 核机器上会明显排队）
//   kill %1                          # 停掉
//
// 刻意写成"纯 CPU 忙循环"而不是 stress-ng 之类的外部工具：机器上不一定装了，
// 而 bench 要的是**可复现的固定负载点**（n 个核 = 明确的 load 目标），
// 这样 README 里的数字别人也能照着重跑。
//
// 注意：这是给基准测试用的短时负载。它**必须自带 TTL**——首版没有，
// 结果在 `nohup ... &` 下父进程先死、12 个忙循环变成孤儿，把 8 核机器
// 顶到 load 192 且无法靠 kill 父进程止损。所以：
//   1. 忙循环**自带截止时间**，到期自己退出（最硬的兜底，不依赖任何父进程）
//   2. 默认只跑 120 秒
//   3. 父进程仍做信号转发，但不再把它当唯一保险

import { spawn } from 'node:child_process';

const n = Number(process.argv[2] || 4);
const ttlSec = Number(process.argv[3] || 120);
if (!Number.isFinite(n) || n < 1 || !Number.isFinite(ttlSec) || ttlSec < 1) {
  console.error('用法: node scripts/loadgen.mjs <核数 1..64> [存活秒数，默认 120]');
  process.exit(1);
}
console.error(`loadgen: ${n} 个忙循环 (pid ${process.pid})，${ttlSec}s 后自动熄火`);

// 截止时间写进子进程自己的循环条件：即使父进程被 SIGKILL、即使 nohup 脱离
// 会话，它们也只会跑满 ttlSec 就自己结束。
const BODY = `const end=Date.now()+${ttlSec * 1000};`
  + `let x=0;for(;;){x=(x*1103515245+12345)&0x7fffffff;if(Date.now()>end)break}`;

const kids = [];
for (let i = 0; i < n; i++) {
  kids.push(spawn(process.execPath, ['-e', BODY], { stdio: 'ignore' }));
}

function shutdown() {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch {} } });
