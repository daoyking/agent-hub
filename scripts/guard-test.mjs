#!/usr/bin/env node
// 资源守卫测试。
// 分工：**阈值判定用合成数据做确定性断言**（不必真把机器压满，也就不会 flaky）；
// 采样器只测「解析契约」—— memory_pressure / sysctl 的输出格式一旦漂移，
// 解析失败会静默退回兜底口径，那比不守卫更糟（读数看着正常但是假的）。
import { assess, sampleMemBreakdown, sampleResources, sampleTopMemory, THRESHOLDS } from '../src/resources.ts';

const fails = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) fails.push(msg);
};

const T = THRESHOLDS;

// —— 确定性阈值判定 ——
let a = assess({ cpuPct: 10, memFreePct: 80, swapUsedPct: 0 });
check(a.level === 'ok' && a.reasons.length === 0, `宽松读数 → ok（实得 ${a.level}）`);

a = assess({ cpuPct: T.cpu.warn, memFreePct: 80, swapUsedPct: 0 });
check(a.level === 'warn', `CPU 正好卡在 warn 线 ${T.cpu.warn} → warn（边界含等号）`);

a = assess({ cpuPct: T.cpu.critical, memFreePct: 80, swapUsedPct: 0 });
check(a.level === 'critical', `CPU 到 crit 线 ${T.cpu.critical} → critical`);

a = assess({ cpuPct: 10, memFreePct: T.memFree.critical, swapUsedPct: 0 });
check(a.level === 'critical', `内存空闲跌到 ${T.memFree.critical} → critical（方向不能反：空闲越低越糟）`);

a = assess({ cpuPct: 10, memFreePct: T.memFree.warn - 1, swapUsedPct: 0 });
check(a.level === 'warn', `内存空闲 ${T.memFree.warn - 1} → warn`);

a = assess({ cpuPct: 10, memFreePct: 80, swapUsedPct: T.swapUsed.critical });
check(a.level === 'critical', `swap 用满 ${T.swapUsed.critical} → critical（内存空闲高也不能放行）`);

// 取最糟：CPU 只是 warn、内存已 critical → 必须 critical
a = assess({ cpuPct: T.cpu.warn, memFreePct: 1, swapUsedPct: 0 });
check(a.level === 'critical' && a.reasons.length === 2, `多指标取最糟 → critical，两条理由都列出（实得 ${a.reasons.length} 条）`);

a = assess({ cpuPct: 0, memFreePct: 100, swapUsedPct: 100 });
check(a.level === 'critical', 'swap 100 → critical');

// —— 采样器解析契约 ——
const r = await sampleResources(200);
const clamp = (v) => v >= 0 && v <= 100;
check(clamp(r.cpuPct), `CPU 读数在 0..100（实得 ${r.cpuPct.toFixed(1)}）`);
check(clamp(r.memFreePct), `内存空闲读数在 0..100（实得 ${r.memFreePct.toFixed(0)}）`);
check(clamp(r.swapUsedPct), `swap 读数在 0..100（实得 ${r.swapUsedPct.toFixed(0)}）`);
check(r.cores > 0, `核心数 > 0（实得 ${r.cores}）`);
// 关键契约：内存必须走 memory_pressure，而不是静默退回 os.freemem 兜底
check(r.via.mem === 'memory_pressure -Q', `内存走 memory_pressure 口径（实得「${r.via.mem}」）— 若变成兜底说明它的输出格式变了`);
check(/vm\.swapusage/.test(r.via.swap), `swap 解析自 vm.swapusage（实得「${r.via.swap}」）`);
check(!Number.isNaN(r.cpuPct), 'CPU 读数非 NaN');

// —— 内存拆解 / 排行的解析契约 ——
const bd = await sampleMemBreakdown();
check(bd.pageSize > 0 && Number.isFinite(bd.pageSize), `vm_stat 页大小解析出来（实得 ${bd.pageSize}B）`);
check(bd.totalGb > 0, `物理内存解析出来（实得 ${bd.totalGb.toFixed(1)} GB）`);
check(bd.activeGb > 0, `active 解析出来（实得 ${bd.activeGb.toFixed(1)} GB）— 为 0 说明 vm_stat 标签变了`);
check(bd.compressorGb >= 0 && bd.compressedLogicalGb >= 0, '压缩器两项可读');
check(bd.swapouts > 0, `swapouts 计数解析出来（实得 ${bd.swapouts}）`);

const top = await sampleTopMemory(20);
check(top.length > 5, `排行非空（实得 ${top.length} 项）`);
check(top.every((c) => c.rssMb > 0 && c.procs > 0), '每项都有 RSS 与进程数');
check(top.every((c, i) => i === 0 || top[i - 1].rssMb >= c.rssMb), '按 RSS 降序');
// 回归：路径含空格（~/Library/Application Support/…）时，按空白切 argv[0] 会得到
// 假的 "Application" 桶，把三个不相干的常驻件并成一个。命名必须走 comm。
check(!top.some((c) => c.name === 'Application'), '没有假的 "Application" 桶（路径含空格的进程按 comm 命名）');
check(top.every((c) => !c.name.includes('/')), '桶名是单一名字，不含路径');
const lumped = top.filter((c) => c.name === 'node' || c.name === 'python');
check(lumped.length === 0, `解释器按脚本细分，不并成笼统的 node/python（实得 ${lumped.map((c) => c.name).join(',') || '无'}）`);

console.log(fails.length ? `\n✗ ${fails.length} 项失败` : '\n✓ 全部通过');
process.exit(fails.length ? 1 : 0);
